import type { ResearchReport, TrendHotListResult, WebSource } from "@javis/tools";

/**
 * Evidence shorter than this is usually a title, status string, or placeholder
 * rather than a retrievable excerpt.  Keep this deliberately small so normal
 * search snippets still pass while one-token responses fail closed.
 */
export const MIN_SOURCE_EXCERPT_LENGTH = 20;
export const MAX_SOURCE_EXCERPT_LENGTH = 220;

export interface SourceBackedReportOptions {
  failedFetchCount?: number;
  providerSummary?: string;
  sourceMode?: "manual" | "search";
}

export type SourceEvidenceFailureReason =
  | "missing_url"
  | "invalid_url"
  | "missing_excerpt"
  | "excerpt_too_short"
  | "excerpt_unstructured"
  | "claim_not_supported";

export interface SourceEvidenceValidation {
  valid: boolean;
  reason?: SourceEvidenceFailureReason;
  url: string;
  excerpt: string;
}

export interface ResearchVerificationResult {
  valid: boolean;
  validSourceCount: number;
  validReportEvidenceCount: number;
  sourceCount: number;
  reportRowCount: number;
  failures: string[];
}

export interface SourceCollectionVerificationResult {
  valid: boolean;
  validSourceCount: number;
  sourceCount: number;
  failures: string[];
}

const PLACEHOLDER_EXCERPT_PATTERN = /^(?:n\/?a|none|null|unknown|unavailable|error|failed|no\s+(?:content|text|data))(?:[.!:?])+$/iu;
const WORD_NEGATION_PATTERN = /(?:^|\s)(?:cannot|can t|didn t|doesn t|don t|isn t|neither|never|no|nor|not|wasn t|weren t|without|won t|wouldn t)(?=\s|$)/u;
const CJK_NEGATION_PATTERN = /(?:不|未|无|無|没|沒有|没有|非|否|禁止|无法|無法|不能)/u;
// A claim that drops an attribution or uncertainty marker changes the
// epistemic status of the source text. Keep these markers conservative: if
// the excerpt contains one and the claim does not, fail closed rather than
// presenting a rumor, dispute, or possibility as an established fact.
const EVIDENCE_ATTRIBUTION_CUE_PATTERNS = [
  /\b(?:alleg(?:e|es|ed|edly|ing)|rumou?r(?:ed)?|claim(?:s|ed|ing)?|said|says|report(?:s|ed|edly|ing)?|disput(?:e|es|ed|ing)|den(?:y|ied|ies|ying)|question(?:s|ed|ing)?|suggest(?:s|ed|ing)?|appear(?:s|ed)?|apparently|seem(?:s|ed)?|unverified|unconfirmed|unsubstantiated|uncertain(?:ly)?|unclear|doubtful|unlikely|possible|possibly|perhaps|maybe|may|might|could|purported(?:ly)?|according|speculat(?:e|es|ed|ing|ion)|false|refuted|debunked)\b/iu,
  /(?:据称|据说|据报道|有报道称|报道称|传闻|传言|谣言|声称|宣称|可能|或许|疑似|未经证实|尚未证实|未获证实|争议|存疑|否认|不确定)/u,
];
const EVIDENCE_ATTRIBUTION_CUE_GROUPS = [
  /\b(?:alleged(?:ly)?|rumou?r(?:ed)?|unverified|purported(?:ly)?|speculat(?:e|es|ed|ion))\b|(?:\u4f20\u95fb|\u50b3\u805e|\u8c23\u8a00|\u8b20\u8a00|\u7591\u4f3c|\u672a\u7ecf\u8bc1\u5b9e|\u672a\u7d93\u8b49\u5be6)/iu,
  /\b(?:claim(?:s|ed)?|said|says|reported(?:ly)?|according|declared?)\b|(?:\u636e\u79f0|\u64da\u7a31|\u636e\u8bf4|\u64da\u8aaa|\u636e\u62a5\u9053|\u64da\u5831\u5c0e|\u58f0\u79f0|\u8072\u7a31|\u5ba3\u79f0)/iu,
  /\b(?:disput(?:e|es|ed|ing)|den(?:y|ied|ies|ying)|question(?:s|ed|ing)?)\b|(?:\u4e89\u8bae|\u722d\u8b70|\u5426\u8ba4|\u5426\u8a8d|\u8d28\u7591|\u8cea\u7591)/iu,
  /\b(?:uncertain(?:ly)?|possibly|perhaps|may|might|could)\b|(?:\u53ef\u80fd|\u6216\u8bb8|\u6216\u8a31|\u4e0d\u786e\u5b9a|\u4e0d\u78ba\u5b9a)/iu,
  /\b(?:hypothetical(?:ly)?|scenario|assum(?:e|es|ed|ing|ption)|suppos(?:e|es|ed|ing)|if|conditional(?:ly)?)\b|(?:\u5047\u8bbe|\u5047\u8a2d|\u5982\u679c|\u5834\u666f|\u524d\u63d0)/iu,
  /\b(?:belie(?:f|ve|ves|ved)|think|thinks|thought|opinion|expects?|expected)\b|(?:\u8ba4\u4e3a|\u8a8d\u70ba|\u76f8\u4fe1|\u89c2\u70b9|\u89c0\u9ede|\u9884\u8ba1|\u9810\u8a08)/iu,
];
const EVIDENCE_UNIT_SEPARATOR_PATTERN = /(?:[\u3002\uFF01\uFF1F\uFF1B\n]+|[.!?;](?=\s|$)|\s*(?:[,\uFF0C]|[\u2014\u2013])\s*|\s+-\s+|(?:但是|然而|并且|而且|同时|可是|不过|而|但|且))/iu;
const COORDINATED_EVIDENCE_UNIT_SEPARATOR_PATTERN = /(?:[\u3002\uFF01\uFF1F\uFF1B\n]+|[.!?;](?=\s|$)|\s*(?:[,\uFF0C]|[\u2014\u2013])\s*|\s+-\s+|\s+(?:and|but|while|whereas|yet)\s+|(?:但是|然而|并且|而且|同时|可是|不过|而|但|且))/iu;
const COORDINATION_TOKENS = new Set(["and", "but", "while", "whereas", "yet"]);

/** Normalize fetched text before it is persisted or compared. */
export function normalizeSourceExcerpt(value: unknown): string {
  return typeof value === "string"
    ? value.trim().replace(/\s+/gu, " ")
    : "";
}

/** Normalize URL identity before comparing requested and returned sources. */
export function normalizeSourceUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return trimmed;
    }
    // Fragments are client-side navigation and are not sent in an HTTP fetch.
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

function hasUsableSourceUrl(value: string): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Bind fetched evidence to the URL that was actually requested. A provider is
 * not allowed to silently substitute a redirect or unrelated source URL.
 */
export function bindFetchedSourceToRequest(
  requestedUrl: string,
  source: WebSource,
): WebSource {
  const requested = normalizeSourceUrl(requestedUrl);
  const returned = normalizeSourceUrl(source.url);
  if (
    !hasUsableSourceUrl(requested) ||
    !hasUsableSourceUrl(returned) ||
    requested !== returned
  ) {
    throw new Error("Fetched source URL does not match the requested URL.");
  }
  return { ...source, url: requested };
}

function evidenceTokens(value: string): string[] {
  return value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function comparisonText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

/**
 * Deterministically checks that a generated claim is grounded in its excerpt.
 * Exact token matching handles quoted and lightly paraphrased claims without
 * accepting substrings inside unrelated words. Claims also fail closed when
 * their negation polarity conflicts with the excerpt.
 */
export function isClaimSupportedByExcerpt(claim: unknown, excerpt: unknown): boolean {
  const claimText = typeof claim === "string" ? claim : "";
  const normalizedClaim = comparisonText(claimText);
  const sourceExcerpt = normalizeSourceExcerpt(excerpt);
  const normalizedExcerpt = comparisonText(sourceExcerpt);
  if (!normalizedClaim || !normalizedExcerpt) return false;
  if (hasDroppedEvidenceAttributionCue(normalizedClaim, normalizedExcerpt)) return false;
  const claimUnits = evidenceUnits(claimText);
  // A multi-clause claim can explicitly preserve the source's coordinated
  // relations, so split the excerpt's English connectors only in that case.
  // A single-clause claim stays intact and is checked for skipped relation
  // tokens, which preserves object coordination such as "Linux and Windows".
  const excerptUnits = evidenceUnits(sourceExcerpt, claimUnits.length > 1);
  if (claimUnits.length === 0 || excerptUnits.length === 0) return false;

  // Match claim clauses to distinct excerpt clauses in order. This preserves
  // complete multi-clause claims while preventing a subject in one relation
  // from being combined with an object in a later coordinated relation.
  let excerptIndex = 0;
  for (const [claimUnitIndex, claimUnit] of claimUnits.entries()) {
    let matched = false;
    while (excerptIndex < excerptUnits.length) {
      const excerptUnit = excerptUnits[excerptIndex];
      const candidateExcerptIndex = excerptIndex;
      excerptIndex += 1;
      if (
        excerptUnit &&
        isEvidenceUnitSupported(claimUnit, excerptUnit, {
          claimUnitIndex,
          requireUnitStart: claimUnits.length > 1 && candidateExcerptIndex > 0,
        })
      ) {
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }
  return true;
}

function evidenceUnits(value: string, splitEnglishCoordination = false): string[] {
  return value
    .toLocaleLowerCase()
    .split(
      splitEnglishCoordination
        ? COORDINATED_EVIDENCE_UNIT_SEPARATOR_PATTERN
        : EVIDENCE_UNIT_SEPARATOR_PATTERN,
    )
    .map(comparisonText)
    .filter(Boolean);
}

function isEvidenceUnitSupported(
  claimUnit: string,
  excerptUnit: string,
  options: {
    claimUnitIndex: number;
    requireUnitStart: boolean;
  },
): boolean {
  if (hasNegationSignal(claimUnit) !== hasNegationSignal(excerptUnit)) return false;
  if (hasDroppedEvidenceAttributionCue(claimUnit, excerptUnit)) return false;
  const requiresCjkRelationStart =
    options.claimUnitIndex > 0 && /[\u3400-\u9fff\uf900-\ufaff]/u.test(excerptUnit);
  const claimUnitTokens = evidenceTokens(claimUnit).filter(isSubstantiveEvidenceToken);
  const excerptUnitTokens = evidenceTokens(excerptUnit).filter(isSubstantiveEvidenceToken);
  if (
    (requiresCjkRelationStart || options.requireUnitStart) &&
    (claimUnitTokens[0] === undefined || excerptUnitTokens[0] === undefined ||
      claimUnitTokens[0] !== excerptUnitTokens[0])
  ) {
    return false;
  }
  if (
    /[\u3400-\u9fff\uf900-\ufaff]/u.test(claimUnit) &&
    excerptUnit.replace(/\s+/gu, "").includes(claimUnit.replace(/\s+/gu, ""))
  ) {
    return true;
  }

  const claimTokens = claimUnitTokens;
  if (claimTokens.length === 0) return false;
  const excerptTokens = excerptUnitTokens;
  let excerptIndex = 0;
  const matchedExcerptIndexes: number[] = [];
  for (const claimToken of claimTokens) {
    const matchIndex = excerptTokens.indexOf(claimToken, excerptIndex);
    if (matchIndex < 0) return false;
    matchedExcerptIndexes.push(matchIndex);
    excerptIndex = matchIndex + 1;
  }
  return !crossesCoordinatedRelation(excerptTokens, matchedExcerptIndexes) &&
    !crossesUnmatchedRelation(excerptTokens, matchedExcerptIndexes);
}

function hasDroppedEvidenceAttributionCue(claimUnit: string, excerptUnit: string): boolean {
  const excerptHasCue = EVIDENCE_ATTRIBUTION_CUE_PATTERNS.some((pattern) => pattern.test(excerptUnit));
  const excerptHasGroupedCue = EVIDENCE_ATTRIBUTION_CUE_GROUPS.some((pattern) => pattern.test(excerptUnit));
  if (!excerptHasCue && !excerptHasGroupedCue) return false;
  return EVIDENCE_ATTRIBUTION_CUE_GROUPS.some((pattern) =>
    pattern.test(excerptUnit) && !pattern.test(claimUnit)
  );
}

function crossesUnmatchedRelation(
  excerptTokens: string[],
  matchedIndexes: number[],
): boolean {
  // Two-token topic claims (for example "AI systems") are intentionally
  // allowed to skip descriptive modifiers.  Relation-like claims need a
  // stricter boundary so a second subject cannot be spliced into the claim.
  if (matchedIndexes.length < 3) return false;
  for (let index = 1; index < matchedIndexes.length; index += 1) {
    const previous = matchedIndexes[index - 1];
    const current = matchedIndexes[index];
    const skipped = excerptTokens
      .slice(previous + 1, current)
      .filter(isSubstantiveEvidenceToken);
    // A multi-token insertion between the first subject and the relation
    // usually indicates a second subject/relation ("Alice said Bob won ...").
    // Later gaps allow up to two descriptive/object tokens (for example
    // "read-only source" or "Linux and Windows"). Longer gaps are treated as
    // a likely relation splice and fail closed.
    if ((index === 1 && skipped.length >= 2) || skipped.length >= 3) return true;
  }
  return false;
}

function crossesCoordinatedRelation(
  excerptTokens: string[],
  matchedIndexes: number[],
): boolean {
  for (let connectorIndex = 0; connectorIndex < excerptTokens.length; connectorIndex += 1) {
    if (!COORDINATION_TOKENS.has(excerptTokens[connectorIndex] ?? "")) continue;
    const matchedBefore = matchedIndexes.some((index) => index < connectorIndex);
    const firstMatchedAfter = matchedIndexes.find((index) => index > connectorIndex);
    if (!matchedBefore || firstMatchedAfter === undefined) continue;
    const skippedAfterConnector = excerptTokens
      .slice(connectorIndex + 1, firstMatchedAfter)
      .some((token) => !COORDINATION_TOKENS.has(token));
    if (skippedAfterConnector) return true;
  }
  return false;
}

function isSubstantiveEvidenceToken(token: string): boolean {
  if (token.length > 1 || /[\u3400-\u9fff\uf900-\ufaff]/u.test(token)) {
    return true;
  }
  // Keep single-character variables and numeric identifiers because their
  // order can carry the entire relationship (for example X/Y or version 1/2).
  return token !== "a" && token !== "i";
}

function hasNegationSignal(value: string): boolean {
  return WORD_NEGATION_PATTERN.test(value) || CJK_NEGATION_PATTERN.test(value);
}

/** Validate one source (and, when supplied, its claim) before synthesis. */
export function validateSourceEvidence(
  source: Pick<WebSource, "url" | "excerpt">,
  claim?: unknown,
): SourceEvidenceValidation {
  const url = normalizeSourceUrl(source.url);
  if (!url) return { valid: false, reason: "missing_url", url, excerpt: "" };
  if (!hasUsableSourceUrl(url)) {
    return { valid: false, reason: "invalid_url", url, excerpt: normalizeSourceExcerpt(source.excerpt) };
  }

  const excerpt = normalizeSourceExcerpt(source.excerpt).slice(0, MAX_SOURCE_EXCERPT_LENGTH);
  if (!excerpt) return { valid: false, reason: "missing_excerpt", url, excerpt };
  if (excerpt.length < MIN_SOURCE_EXCERPT_LENGTH) {
    return { valid: false, reason: "excerpt_too_short", url, excerpt };
  }
  const tokens = evidenceTokens(excerpt);
  const cjkCharacters = excerpt.match(/[\u3400-\u9fff\uf900-\ufaff]/gu)?.length ?? 0;
  if (
    PLACEHOLDER_EXCERPT_PATTERN.test(excerpt) ||
    (tokens.length < 2 && cjkCharacters < 6)
  ) {
    return { valid: false, reason: "excerpt_unstructured", url, excerpt };
  }
  if (claim !== undefined && !isClaimSupportedByExcerpt(claim, excerpt)) {
    return { valid: false, reason: "claim_not_supported", url, excerpt };
  }
  return { valid: true, url, excerpt };
}

/**
 * Re-check both raw sources and persisted report rows.  This is intentionally
 * independent from report construction so a later mutation or model-produced
 * claim cannot bypass the evidence gate.
 */
export function verifySourceBackedReport(
  sources: WebSource[],
  report: ResearchReport,
): ResearchVerificationResult {
  const sourceChecks = sources.map((source) => validateSourceEvidence(source));
  const rowChecks = report.rows.map((row) =>
    validateSourceEvidence({ url: row.sourceUrl, excerpt: row.excerpt ?? "" }, row.claim),
  );
  const rowEvidenceMatchesExcerpt = report.rows.map((row, index) =>
    normalizeSourceExcerpt(row.evidence).slice(0, MAX_SOURCE_EXCERPT_LENGTH) ===
      rowChecks[index]?.excerpt,
  );
  const remainingSourceProviders = new Map<string, number>();
  for (const [index, check] of sourceChecks.entries()) {
    if (!check.valid) continue;
    const source = sources[index];
    const provider = normalizeSourceProvider(source?.provider);
    const key = sourceEvidenceProviderKey(check.url, check.excerpt, provider);
    remainingSourceProviders.set(key, (remainingSourceProviders.get(key) ?? 0) + 1);
  }
  const rowProviderMatchesSource = report.rows.map((row, index) => {
    const check = rowChecks[index];
    if (!check?.valid || !rowEvidenceMatchesExcerpt[index]) return false;
    const provider = normalizeSourceProvider(row.sourceProvider);
    const key = sourceEvidenceProviderKey(check.url, check.excerpt, provider);
    const remaining = remainingSourceProviders.get(key) ?? 0;
    if (remaining === 0) return false;
    if (remaining === 1) remainingSourceProviders.delete(key);
    else remainingSourceProviders.set(key, remaining - 1);
    return true;
  });
  const remainingSourceEvidence = new Map<string, number>();
  for (const check of sourceChecks) {
    if (!check.valid) continue;
    const key = sourceEvidenceKey(check.url, check.excerpt);
    remainingSourceEvidence.set(key, (remainingSourceEvidence.get(key) ?? 0) + 1);
  }
  const rowMatchesSource = rowChecks.map((check, index) => {
    if (!check.valid || !rowEvidenceMatchesExcerpt[index]) return false;
    const key = sourceEvidenceKey(check.url, check.excerpt);
    const remaining = remainingSourceEvidence.get(key) ?? 0;
    if (remaining === 0) return false;
    if (remaining === 1) remainingSourceEvidence.delete(key);
    else remainingSourceEvidence.set(key, remaining - 1);
    return true;
  });
  const failures = [
    ...sourceChecks.flatMap((check, index) =>
      check.valid ? [] : [`source-${index + 1}:${check.reason ?? "invalid"}`],
    ),
    ...rowChecks.flatMap((check, index) =>
      check.valid ? [] : [`report-row-${index + 1}:${check.reason ?? "invalid"}`],
    ),
    ...rowEvidenceMatchesExcerpt.flatMap((matches, index) =>
      rowChecks[index]?.valid && !matches ? [`report-row-${index + 1}:evidence_mismatch`] : [],
    ),
    ...rowProviderMatchesSource.flatMap((matches, index) =>
      rowChecks[index]?.valid && !matches ? [`report-row-${index + 1}:provider_mismatch`] : [],
    ),
    ...rowMatchesSource.flatMap((matches, index) =>
      rowChecks[index]?.valid && rowEvidenceMatchesExcerpt[index] && !matches
        ? [`report-row-${index + 1}:source_mismatch`]
        : [],
    ),
    ...(sources.length === report.rows.length ? [] : ["report:row_count_mismatch"]),
  ];
  return {
    valid:
      sources.length > 0 &&
      sources.length === report.rows.length &&
      sourceChecks.every((check) => check.valid) &&
      rowChecks.every((check) => check.valid) &&
      rowEvidenceMatchesExcerpt.every(Boolean) &&
      rowProviderMatchesSource.every(Boolean) &&
      rowMatchesSource.every(Boolean),
    validSourceCount: sourceChecks.filter((check) => check.valid).length,
    validReportEvidenceCount: rowChecks.filter(
      (check, index) =>
        check.valid && rowEvidenceMatchesExcerpt[index] && rowProviderMatchesSource[index] && rowMatchesSource[index],
    ).length,
    sourceCount: sources.length,
    reportRowCount: report.rows.length,
    failures,
  };
}

/** Validate a source-only handoff before a downstream planning synthesis. */
export function verifySourceCollection(
  sources: WebSource[],
): SourceCollectionVerificationResult {
  const checks = sources.map((source) => validateSourceEvidence(source));
  const failures = checks.flatMap((check, index) =>
    check.valid ? [] : [`source-${index + 1}:${check.reason ?? "invalid"}`],
  );
  if (sources.length === 0) failures.push("source_collection:empty");
  return {
    valid: sources.length > 0 && checks.every((check) => check.valid),
    validSourceCount: checks.filter((check) => check.valid).length,
    sourceCount: sources.length,
    failures,
  };
}

/** Validate a structured trend report against the exact hot-list payload. */
export function verifyTrendHotListResearchReport(
  hotList: TrendHotListResult,
  report: ResearchReport,
): ResearchVerificationResult {
  const failures: string[] = [];
  const provider = typeof hotList.provider === "string" ? hotList.provider.trim() : "";
  const fetchedAt = typeof hotList.fetchedAt === "string" ? hotList.fetchedAt.trim() : "";
  const sourceUrl = normalizeSourceUrl(hotList.sourceUrl);
  const expectedCountValid = Number.isInteger(hotList.expectedCount) && hotList.expectedCount > 0;
  const itemCountValid = hotList.items.length <= hotList.expectedCount;
  const warningsValid = Array.isArray(hotList.warnings) &&
    hotList.warnings.every((warning) => typeof warning === "string");
  const hasIncompleteWarning = warningsValid &&
    hotList.warnings.some((warning) => warning.trim().length > 0);

  if (!provider) failures.push("trend:missing_provider");
  if (!fetchedAt || !Number.isFinite(Date.parse(fetchedAt))) {
    failures.push("trend:invalid_fetched_at");
  }
  if (!hasUsableSourceUrl(sourceUrl)) failures.push("trend:invalid_source_url");
  if (!expectedCountValid) failures.push("trend:invalid_expected_count");
  if (!itemCountValid) failures.push("trend:item_count_exceeds_expected");
  if (typeof hotList.complete !== "boolean") failures.push("trend:invalid_complete_flag");
  if (!warningsValid) {
    failures.push("trend:invalid_warnings");
  }
  if (
    hotList.complete === true &&
    expectedCountValid &&
    hotList.items.length !== hotList.expectedCount
  ) {
    failures.push("trend:complete_count_mismatch");
  }
  if (hotList.complete === false && !hasIncompleteWarning) {
    failures.push("trend:incomplete_without_warning");
  }
  // A partial hot list may be displayed with its warning, but it is not
  // sufficient evidence for a completed research answer.  Keep this gate
  // independent from the warning text so a provider cannot turn incomplete
  // data into a pass merely by adding a disclaimer.
  if (hotList.complete === false) {
    failures.push("trend:incomplete_payload");
  }
  if (!Array.isArray(hotList.diagnostics) || hotList.diagnostics.some((diagnostic) => {
    if (!diagnostic || typeof diagnostic !== "object") return true;
    const value = diagnostic as unknown as Record<string, unknown>;
    return typeof value.provider !== "string" || value.provider.trim().length === 0 ||
      typeof value.requestedLimit !== "number" || !Number.isInteger(value.requestedLimit) || value.requestedLimit <= 0 ||
      typeof value.startedAt !== "string" || value.startedAt.trim().length === 0 ||
      typeof value.finishedAt !== "string" || value.finishedAt.trim().length === 0 ||
      typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs) || value.durationMs < 0 ||
      (value.status !== "completed" && value.status !== "failed");
  })) {
    failures.push("trend:invalid_diagnostics");
  }
  if (hotList.items.length === 0) failures.push("trend:no_items");
  if (report.rows.length !== hotList.items.length) failures.push("report:row_count_mismatch");

  const seenRanks = new Set<number>();
  let validSourceCount = 0;
  let validReportEvidenceCount = 0;
  for (let index = 0; index < hotList.items.length; index += 1) {
    const item = hotList.items[index];
    const row = report.rows[index];
    if (!item) continue;

    const title = typeof item.title === "string" ? normalizeSourceExcerpt(item.title) : "";
    const rankValid = Number.isInteger(item.rank) && item.rank > 0 && !seenRanks.has(item.rank);
    if (rankValid) seenRanks.add(item.rank);
    const itemSourceUrl = normalizeSourceUrl(item.url ?? sourceUrl);
    const sourceValid = rankValid && Boolean(title) && hasUsableSourceUrl(itemSourceUrl);
    if (sourceValid) validSourceCount += 1;
    if (!rankValid) failures.push(`trend-item-${index + 1}:invalid_rank`);
    if (!title) failures.push(`trend-item-${index + 1}:missing_title`);
    if (item.url !== undefined && typeof item.url !== "string") {
      failures.push(`trend-item-${index + 1}:invalid_url_shape`);
    }
    if (item.label !== undefined && typeof item.label !== "string") {
      failures.push(`trend-item-${index + 1}:invalid_label_shape`);
    }
    if (item.category !== undefined && typeof item.category !== "string") {
      failures.push(`trend-item-${index + 1}:invalid_category_shape`);
    }
    if (!hasUsableSourceUrl(itemSourceUrl)) {
      failures.push(`trend-item-${index + 1}:invalid_source_url`);
    }
    if (typeof item.hotScore === "number" && !Number.isFinite(item.hotScore)) {
      failures.push(`trend-item-${index + 1}:invalid_hot_score`);
    }

    if (!row) continue;
    const expectedClaim = `${item.rank}. ${title}`;
    const expectedExcerpt = typeof item.hotScore === "number"
      ? `hotScore=${item.hotScore}`
      : `rank=${item.rank}`;
    const expectedEvidence = [
      `provider=${provider}`,
      `fetchedAt=${fetchedAt}`,
      typeof item.label === "string" && item.label.trim()
        ? `label=${item.label.trim()}`
        : undefined,
    ].filter((value): value is string => Boolean(value)).join("; ");
    const rowValid =
      sourceValid &&
      normalizeSourceExcerpt(row.claim) === expectedClaim &&
      normalizeSourceUrl(row.sourceUrl) === itemSourceUrl &&
      normalizeSourceExcerpt(row.excerpt) === expectedExcerpt &&
      normalizeSourceExcerpt(row.evidence) === expectedEvidence &&
      row.status === "verified" &&
      row.verificationStatus === "verified" &&
      row.sourceProvider === provider;
    if (rowValid) {
      validReportEvidenceCount += 1;
      continue;
    }
    if (normalizeSourceExcerpt(row.claim) !== expectedClaim) {
      failures.push(`trend-row-${index + 1}:claim_mismatch`);
    }
    if (normalizeSourceUrl(row.sourceUrl) !== itemSourceUrl) {
      failures.push(`trend-row-${index + 1}:source_url_mismatch`);
    }
    if (normalizeSourceExcerpt(row.excerpt) !== expectedExcerpt) {
      failures.push(`trend-row-${index + 1}:excerpt_mismatch`);
    }
    if (normalizeSourceExcerpt(row.evidence) !== expectedEvidence) {
      failures.push(`trend-row-${index + 1}:evidence_mismatch`);
    }
    if (row.status !== "verified" || row.verificationStatus !== "verified") {
      failures.push(`trend-row-${index + 1}:status_mismatch`);
    }
    if (row.sourceProvider !== provider) {
      failures.push(`trend-row-${index + 1}:provider_mismatch`);
    }
  }

  return {
    valid:
      failures.length === 0 &&
      validSourceCount === hotList.items.length &&
      validReportEvidenceCount === report.rows.length,
    validSourceCount,
    validReportEvidenceCount,
    sourceCount: hotList.items.length,
    reportRowCount: report.rows.length,
    failures,
  };
}

function sourceEvidenceKey(url: string, excerpt: string): string {
  return `${url}\u0000${excerpt}`;
}

function sourceEvidenceProviderKey(url: string, excerpt: string, provider: string): string {
  return `${sourceEvidenceKey(url, excerpt)}\u0000${provider}`;
}

function normalizeSourceProvider(value: unknown): string {
  return typeof value === "string" ? value.trim().toLocaleLowerCase() : "";
}

export function createSourceBackedReport(
  sources: WebSource[],
  options: SourceBackedReportOptions = {},
): ResearchReport {
  const rows = sources.map((source) => {
    const url = normalizeSourceUrl(source.url);
    const excerpt = normalizeSourceExcerpt(source.excerpt).slice(0, MAX_SOURCE_EXCERPT_LENGTH);
    const title = typeof source.title === "string" ? source.title.trim() : "";
    const candidateClaim = excerpt
      ? excerpt
      : `${title || url} could not be verified from fetched text.`;
    const validation = validateSourceEvidence({ url, excerpt }, candidateClaim);
    const status = validation.valid ? "verified" as const : "unknown" as const;
    return {
      claim: validation.valid
        ? candidateClaim
        : `${title || url} could not be verified from fetched text.`,
      status,
      sourceUrl: url,
      excerpt,
      evidence: excerpt,
      verificationStatus: status,
      ...(typeof source.provider === "string" && source.provider.trim()
        ? { sourceProvider: source.provider.trim() }
        : {}),
    };
  });

  const missingEvidenceCount = rows.filter((row) => row.verificationStatus !== "verified").length;
  const verifiedCount = rows.filter((row) => row.verificationStatus === "verified").length;
  const comparisonNote =
    rows.length >= 3
      ? " The report compares the available sources for overlap and differences."
      : "";

  return {
    title: "Source-backed research report",
    summary:
      rows.length > 0
        ? `Collected ${rows.length} public source(s), with ${verifiedCount} claim(s) tied to URL-backed excerpts${
            options.providerSummary ? ` via ${options.providerSummary}` : ""
          }. Claims below are limited to fetched source excerpts.${comparisonNote}`
        : "No public source was collected, so no claims are verified.",
    rows,
    unknowns:
      [
        ...(missingEvidenceCount > 0
          ? [`${missingEvidenceCount} source(s) did not return enough text evidence.`]
          : []),
        ...(rows.length < 3
          ? [
              options.sourceMode === "search"
                ? `Only ${rows.length} source(s) were fetched from search results; product research expects at least 3 for a full comparison report.`
                : `Only ${rows.length} source(s) were provided; the MVP scenario expects at least 3 for a full comparison report.`,
            ]
          : []),
        ...(options.failedFetchCount && options.failedFetchCount > 0
          ? [`${options.failedFetchCount} searched source candidate(s) could not be fetched.`]
          : []),
        ...(options.sourceMode === "manual"
          ? ["No search provider was used because source URLs were provided directly."]
          : []),
      ],
  };
}
