export interface RepositorySearchPlanRequest {
  goal: string;
  knownTerms?: ReadonlyArray<string>;
  entryFile?: string;
  maxAttempts?: number;
}

export interface RepositorySearchAttempt {
  id: string;
  query: string;
  reason: string;
  resultCount?: number;
  status?: "completed" | "failed";
  durationMs?: number;
  error?: string;
  errorKind?: RepositorySearchAttemptErrorKind;
  provider?: string;
  retryCount?: number;
}

export type RepositorySearchAttemptErrorKind = "timeout" | "unavailable" | "permission" | "cancelled" | "unknown";

export interface RepositorySearchPlan {
  normalizedGoal: string;
  attempts: RepositorySearchAttempt[];
  fallbackTerms: string[];
  conceptTerms: string[];
}

export interface RepositorySearchResult {
  path: string;
  line?: number;
  column?: number;
  excerpt: string;
  matchedTerms: string[];
  score?: number;
}

export interface RepositorySearchCluster {
  id: string;
  label: string;
  paths: string[];
  resultCount: number;
  score: number;
  topTerms: string[];
}

export interface RepositorySearchEvidenceReport {
  actualFound: RepositorySearchResult[];
  inferred: string[];
  needsConfirmation: string[];
  keyFiles: string[];
  relatedTestFiles: string[];
  testFileCandidates: string[];
  clusters: RepositorySearchCluster[];
  semanticDiagnostics?: RepositorySearchSemanticDiagnostic[];
}

export interface RepositorySearchSemanticDiagnostic {
  provider: string;
  status: "completed" | "failed" | "skipped";
  candidateCount: number;
  rerankedCount: number;
  durationMs?: number;
  error?: string;
}

export type RepositoryTraceDirection = "forward" | "backward" | "bidirectional";

export interface RepositoryTraceRequest {
  goal: string;
  target: string;
  entrypoints?: ReadonlyArray<string>;
  workspaceModulePrefixes?: ReadonlyArray<string>;
  direction?: RepositoryTraceDirection;
  maxDepth?: number;
  maxEdges?: number;
}

export interface RepositoryTraceEvidence {
  path: string;
  line?: number;
  column?: number;
  excerpt: string;
  matchedTerms: string[];
  symbol?: string;
  score?: number;
}

export interface RepositoryTraceNode {
  id: string;
  label: string;
  kind: "target" | "entrypoint" | "candidate";
  path?: string;
  symbol?: string;
  score: number;
}

export interface RepositoryTraceEdge {
  from: string;
  to: string;
  relation: RepositoryTraceRelation;
  evidencePath: string;
  line?: number;
  excerpt: string;
  confidence: number;
  moduleSpecifier?: string;
  moduleKind?: RepositoryTraceModuleKind;
}

export type RepositoryTraceRelation = "references" | "may_call" | "imports" | "exports" | "entrypoint_to_candidate";
export type RepositoryTraceModuleKind = "relative" | "workspace" | "external";

export interface RepositoryTraceModuleLink {
  specifier: string;
  kind: RepositoryTraceModuleKind;
  evidencePaths: string[];
  importCount: number;
  exportCount: number;
  dynamicImportCount: number;
  confidence: number;
  resolutionStatus?: "resolved" | "unresolved" | "failed";
  resolvedPaths?: string[];
  resolverProvider?: string;
  resolutionError?: string;
  packageHints?: RepositoryTracePackageHint[];
}

export interface RepositorySymbolGraphNode {
  id: string;
  kind: "file" | "symbol";
  label: string;
  path?: string;
  symbol?: string;
  confidence: number;
}

export interface RepositorySymbolGraphEdge {
  from: string;
  to: string;
  relation: "declares" | "references" | "imports" | "exports" | "calls";
  evidencePath: string;
  line?: number;
  confidence: number;
}

export interface RepositorySymbolGraph {
  nodes: RepositorySymbolGraphNode[];
  edges: RepositorySymbolGraphEdge[];
}

export interface RepositoryTracePackageHint {
  manifestPath: string;
  name?: string;
  main?: string;
  module?: string;
  types?: string;
  exports?: string[];
}

export interface RepositoryTraceEvidenceReport {
  target: string;
  direction: RepositoryTraceDirection;
  actualFound: RepositoryTraceEvidence[];
  nodes: RepositoryTraceNode[];
  edges: RepositoryTraceEdge[];
  moduleLinks: RepositoryTraceModuleLink[];
  symbolGraph: RepositorySymbolGraph;
  inferred: string[];
  needsConfirmation: string[];
  keyFiles: string[];
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "how",
  "what",
  "when",
  "where",
  "why",
  "may",
  "might",
  "could",
  "can",
  "should",
  "bug",
  "issue",
  "fix",
  "help",
  "please",
]);

export function createRepositorySearchPlan(request: RepositorySearchPlanRequest): RepositorySearchPlan {
  const normalizedGoal = normalizeSearchText(request.goal);
  const terms = unique([
    ...extractSearchTerms(request.goal),
    ...(request.knownTerms ?? []).flatMap(extractSearchTerms),
    ...(request.entryFile ? extractPathTerms(request.entryFile) : []),
  ]);
  const conceptTerms = unique([
    ...extractConceptTerms(request.goal),
    ...(request.knownTerms ?? []).flatMap(extractConceptTerms),
  ]).filter((term) => !terms.includes(term));
  const fallbackTerms = expandFallbackTerms(terms);
  const maxAttempts = Math.max(1, request.maxAttempts ?? 8);
  const queries = unique([
    ...terms.slice(0, 6),
    ...conceptTerms.slice(0, 8),
    ...fallbackTerms,
    ...terms.slice(6),
    request.entryFile ?? "",
  ].filter(Boolean));

  return {
    normalizedGoal,
    attempts: queries.slice(0, maxAttempts).map((query, index) => ({
      id: `search-${index + 1}`,
      query,
      reason: conceptTerms.includes(query)
        ? "concept phrase from goal or known context"
        : fallbackTerms.includes(query)
          ? "fallback term for a no-result search"
          : "direct term from goal or known context",
    })),
    fallbackTerms,
    conceptTerms,
  };
}

export function clusterRepositorySearchResults(
  results: ReadonlyArray<RepositorySearchResult>,
): RepositorySearchCluster[] {
  const clusters = new Map<string, RepositorySearchResult[]>();
  for (const result of results) {
    const id = getClusterId(result.path);
    const group = clusters.get(id) ?? [];
    group.push(result);
    clusters.set(id, group);
  }

  return [...clusters.entries()]
    .map(([id, group]) => {
      const paths = unique(group.map((result) => result.path)).sort();
      const termCounts = countTerms(group.flatMap((result) => result.matchedTerms));
      return {
        id,
        label: id,
        paths,
        resultCount: group.length,
        score: group.reduce((total, result) => total + scoreSearchResult(result), 0),
        topTerms: [...termCounts.entries()]
          .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
          .slice(0, 5)
          .map(([term]) => term),
      };
    })
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label));
}

export function buildRepositorySearchEvidenceReport(
  results: ReadonlyArray<RepositorySearchResult>,
  options: { maxKeyFiles?: number; priorityPaths?: ReadonlyArray<string> } = {},
): RepositorySearchEvidenceReport {
  const priorityPathSet = createPriorityPathSet(options.priorityPaths);
  const actualFound = [...results]
    .sort((left, right) =>
      scoreSearchResult(right, priorityPathSet) - scoreSearchResult(left, priorityPathSet) ||
      left.path.localeCompare(right.path));
  const clusters = clusterRepositorySearchResults(actualFound);
  const keyFiles = rankKeyFiles(actualFound, priorityPathSet).slice(0, Math.max(1, options.maxKeyFiles ?? 3));
  const relatedTestFiles = rankKeyFiles(actualFound.filter((result) => isTestFilePath(result.path)), priorityPathSet);
  const testFileCandidates = inferTestFileCandidates(keyFiles, relatedTestFiles).slice(0, 8);
  const inferred = clusters.slice(0, 3).map((cluster) =>
    `${cluster.label}: ${cluster.resultCount} result(s), ${cluster.paths.length} file(s)`,
  );
  const needsConfirmation: string[] = [];

  if (actualFound.length === 0) {
    needsConfirmation.push("No repository search results were found; try fallback terms or inspect the architecture manually.");
  }
  if (keyFiles.length === 0) {
    needsConfirmation.push("No key files could be ranked from the current evidence.");
  }
  if (relatedTestFiles.length === 0) {
    needsConfirmation.push("No related test file was found in the current search results.");
  }

  return {
    actualFound,
    inferred,
    needsConfirmation,
    keyFiles,
    relatedTestFiles,
    testFileCandidates,
    clusters,
  };
}

export function buildRepositoryTraceEvidenceReport(
  evidence: ReadonlyArray<RepositoryTraceEvidence>,
  request: RepositoryTraceRequest,
): RepositoryTraceEvidenceReport {
  const direction = request.direction ?? "bidirectional";
  const actualFound = [...evidence]
    .sort((left, right) => scoreTraceEvidence(right, request.target) - scoreTraceEvidence(left, request.target) ||
      left.path.localeCompare(right.path));
  const maxEdges = Math.max(1, request.maxEdges ?? 8);
  const targetId = `target:${normalizeSearchText(request.target)}`;
  const nodes = new Map<string, RepositoryTraceNode>();
  nodes.set(targetId, {
    id: targetId,
    label: request.target,
    kind: "target",
    symbol: request.target,
    score: 100,
  });

  for (const entrypoint of request.entrypoints ?? []) {
    const id = `entrypoint:${normalizeSearchText(entrypoint)}`;
    nodes.set(id, {
      id,
      label: entrypoint,
      kind: "entrypoint",
      path: looksLikePath(entrypoint) ? entrypoint : undefined,
      symbol: looksLikePath(entrypoint) ? undefined : entrypoint,
      score: 50,
    });
  }

  const edges: RepositoryTraceEdge[] = [];
  for (const item of actualFound.slice(0, maxEdges)) {
    const node = traceNodeFromEvidence(item, request.target);
    nodes.set(node.id, mergeTraceNode(nodes.get(node.id), node));
    edges.push(createTraceEdge({
      direction,
      targetId,
      candidateId: node.id,
      evidence: item,
      target: request.target,
      workspaceModulePrefixes: request.workspaceModulePrefixes,
    }));
  }

  for (const entrypoint of request.entrypoints ?? []) {
    const entryId = `entrypoint:${normalizeSearchText(entrypoint)}`;
    const matchingCandidate = [...nodes.values()].find((node) =>
      node.kind === "candidate" &&
      (node.path === entrypoint ||
        normalizeSearchText(node.path ?? "").includes(normalizeSearchText(entrypoint)) ||
        normalizeSearchText(node.label).includes(normalizeSearchText(entrypoint))),
    );
    if (matchingCandidate) {
      edges.unshift({
        from: entryId,
        to: matchingCandidate.id,
        relation: "entrypoint_to_candidate",
        evidencePath: matchingCandidate.path ?? entrypoint,
        excerpt: `Entrypoint ${entrypoint} matched candidate ${matchingCandidate.label}.`,
        confidence: 0.55,
      });
    }
  }

  const keyFiles = rankTraceKeyFiles(actualFound).slice(0, 5);
  const inferred = edges.slice(0, 5).map((edge) =>
    `${labelTraceNode(nodes.get(edge.from), edge.from)} ${edge.relation} ${labelTraceNode(nodes.get(edge.to), edge.to)} via ${edge.evidencePath}`,
  );
  const moduleLinks = buildRepositoryTraceModuleLinks(edges);
  const symbolGraph = buildRepositorySymbolGraph(actualFound, edges, request.target);
  const needsConfirmation: string[] = [];
  if (actualFound.length === 0) {
    needsConfirmation.push("No trace evidence was found; try alternate symbol names, routes, UI labels, or file paths.");
  }
  if (edges.length === 0) {
    needsConfirmation.push("No candidate call-chain edges could be inferred from the current evidence.");
  }
  if (edges.some((edge) => edge.confidence < 0.7)) {
    needsConfirmation.push("Some edges are text-search candidates and need AST, runtime trace, or manual confirmation.");
  }
  if ((request.entrypoints?.length ?? 0) > 0 && !edges.some((edge) => edge.relation === "entrypoint_to_candidate")) {
    needsConfirmation.push("Entrypoints were provided, but none could be connected to a candidate node from the current evidence.");
  }
  if (moduleLinks.length > 0) {
    needsConfirmation.push("Module links are inferred from text import/export evidence and need package graph or resolver confirmation.");
  }

  return {
    target: request.target,
    direction,
    actualFound,
    nodes: [...nodes.values()].sort((left, right) => right.score - left.score || left.label.localeCompare(right.label)),
    edges,
    moduleLinks,
    symbolGraph,
    inferred,
    needsConfirmation,
    keyFiles,
  };
}

function buildRepositorySymbolGraph(
  evidence: ReadonlyArray<RepositoryTraceEvidence>,
  traceEdges: ReadonlyArray<RepositoryTraceEdge>,
  target: string,
): RepositorySymbolGraph {
  const nodes = new Map<string, RepositorySymbolGraphNode>();
  const edges = new Map<string, RepositorySymbolGraphEdge>();
  const addFileNode = (path: string) => {
    const id = symbolGraphFileId(path);
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        kind: "file",
        label: path,
        path,
        confidence: 1,
      });
    }
    return id;
  };
  const addSymbolNode = (symbol: string, path?: string, confidence = 0.7) => {
    const id = symbolGraphSymbolId(symbol);
    const existing = nodes.get(id);
    nodes.set(id, {
      id,
      kind: "symbol",
      label: symbol,
      ...(path ? { path } : existing?.path ? { path: existing.path } : {}),
      symbol,
      confidence: Math.max(existing?.confidence ?? 0, confidence),
    });
    return id;
  };
  const addEdge = (edge: RepositorySymbolGraphEdge) => {
    const key = `${edge.from}:${edge.relation}:${edge.to}:${edge.evidencePath}:${edge.line ?? ""}`;
    const existing = edges.get(key);
    edges.set(key, existing
      ? { ...existing, confidence: Math.max(existing.confidence, edge.confidence) }
      : edge);
  };

  for (const item of evidence) {
    const fileId = addFileNode(item.path);
    const symbol = item.symbol ?? inferSymbolFromExcerpt(item.excerpt, target) ?? target;
    const symbolId = addSymbolNode(symbol, item.path, item.matchedTerms.includes("typescript-ast") ? 0.85 : 0.6);
    addEdge({
      from: fileId,
      to: symbolId,
      relation: inferSymbolGraphEvidenceRelation(item.excerpt, symbol, target),
      evidencePath: item.path,
      line: item.line,
      confidence: item.matchedTerms.includes("typescript-ast") ? 0.85 : 0.6,
    });
  }

  for (const edge of traceEdges) {
    const fileId = addFileNode(edge.evidencePath);
    const symbol = inferSymbolFromExcerpt(edge.excerpt, target) ?? target;
    const symbolId = addSymbolNode(symbol, edge.evidencePath, edge.confidence);
    addEdge({
      from: fileId,
      to: symbolId,
      relation: symbolGraphRelationFromTraceRelation(edge.relation),
      evidencePath: edge.evidencePath,
      line: edge.line,
      confidence: edge.confidence,
    });
  }

  return {
    nodes: [...nodes.values()].sort((left, right) =>
      left.kind.localeCompare(right.kind) ||
      right.confidence - left.confidence ||
      left.label.localeCompare(right.label)),
    edges: [...edges.values()].sort((left, right) =>
      right.confidence - left.confidence ||
      left.evidencePath.localeCompare(right.evidencePath) ||
      left.relation.localeCompare(right.relation)),
  };
}

function symbolGraphFileId(path: string): string {
  return `file:${path}`;
}

function symbolGraphSymbolId(symbol: string): string {
  return `symbol:${normalizeSearchText(symbol)}`;
}

function inferSymbolGraphEvidenceRelation(
  excerpt: string,
  symbol: string,
  target: string,
): RepositorySymbolGraphEdge["relation"] {
  const normalizedExcerpt = normalizeSearchText(excerpt);
  const normalizedSymbol = normalizeSearchText(symbol);
  const normalizedTarget = normalizeSearchText(target);
  if (isExportReference(normalizedExcerpt, normalizedSymbol) || isExportReference(normalizedExcerpt, normalizedTarget)) {
    return "exports";
  }
  if (isImportReference(normalizedExcerpt, normalizedSymbol) || isImportReference(normalizedExcerpt, normalizedTarget)) {
    return "imports";
  }
  if (normalizedExcerpt.includes("function ") || normalizedExcerpt.includes("class ") || normalizedExcerpt.includes("const ")) {
    return "declares";
  }
  if (normalizedExcerpt.includes(`${normalizedTarget}(`) || normalizedExcerpt.includes(`${normalizedSymbol}(`)) {
    return "calls";
  }
  return "references";
}

function symbolGraphRelationFromTraceRelation(
  relation: RepositoryTraceRelation,
): RepositorySymbolGraphEdge["relation"] {
  if (relation === "imports") return "imports";
  if (relation === "exports") return "exports";
  if (relation === "may_call") return "calls";
  return "references";
}

function extractSearchTerms(value: string): string[] {
  const normalized = normalizeSearchText(value);
  const words = normalized.match(/[a-z0-9][a-z0-9._-]{2,}/g) ?? [];
  const cjkTerms = extractCjkSegments(normalized);
  return unique([
    ...words.flatMap((word) => [
    word,
    ...word.split(/[._-]+/).filter((part) => part.length >= 3),
    ]),
    ...cjkTerms,
  ]).filter((word) => !STOPWORDS.has(word));
}

function extractPathTerms(path: string): string[] {
  return path
    .split(/[\\/._-]+/)
    .flatMap(extractSearchTerms);
}

function extractConceptTerms(value: string): string[] {
  const normalized = normalizeSearchText(value);
  const asciiWords = (normalized.match(/[a-z0-9][a-z0-9._-]{2,}/g) ?? [])
    .map((word) => word.split(/[._-]+/))
    .flat()
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
  const asciiPhrases: string[] = [];
  for (let index = 0; index < asciiWords.length - 1; index += 1) {
    asciiPhrases.push(`${asciiWords[index]} ${asciiWords[index + 1]}`);
  }

  const cjkPhrases = extractCjkSegments(normalized)
    .flatMap((segment) => [
      ...(segment.length <= 8 ? [segment] : []),
      ...cjkWindows(segment, 4),
      ...cjkWindows(segment, 3),
      ...cjkWindows(segment, 2),
    ]);

  return unique([...asciiPhrases, ...cjkPhrases])
    .filter((term) => term.length >= 2);
}

function extractCjkSegments(value: string): string[] {
  return value.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]{2,}/g) ?? [];
}

function cjkWindows(value: string, size: number): string[] {
  const chars = [...value];
  if (chars.length <= size) return chars.length === size ? [value] : [];
  const windows: string[] = [];
  for (let index = 0; index <= chars.length - size; index += 1) {
    windows.push(chars.slice(index, index + size).join(""));
  }
  return windows;
}

function expandFallbackTerms(terms: ReadonlyArray<string>): string[] {
  const expanded: string[] = [];
  for (const term of terms) {
    expanded.push(term);
    if (term.includes("-")) expanded.push(term.replace(/-/g, " "));
    if (term.includes("_")) expanded.push(term.replace(/_/g, " "));
    const camel = term.replace(/[-_ ]+([a-z0-9])/g, (_, char: string) => char.toUpperCase());
    if (camel !== term) expanded.push(camel);
  }
  return unique(expanded).filter((term) => !terms.includes(term));
}

function rankKeyFiles(
  results: ReadonlyArray<RepositorySearchResult>,
  priorityPathSet: ReadonlySet<string> = new Set(),
): string[] {
  const scores = new Map<string, number>();
  for (const result of results) {
    scores.set(result.path, (scores.get(result.path) ?? 0) + scoreSearchResult(result, priorityPathSet));
  }
  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([path]) => path);
}

function scoreSearchResult(
  result: RepositorySearchResult,
  priorityPathSet: ReadonlySet<string> = new Set(),
): number {
  return (result.score ?? 1) +
    result.matchedTerms.length * 2 +
    (typeof result.line === "number" ? 1 : 0) +
    (isTestFilePath(result.path) ? 1 : 0) +
    (isPriorityPath(result.path, priorityPathSet) ? 8 : 0);
}

function scoreTraceEvidence(result: RepositoryTraceEvidence, target: string): number {
  const targetTerms = extractSearchTerms(target);
  const matchedTargetTermCount = result.matchedTerms
    .filter((term) => targetTerms.includes(normalizeSearchText(term)))
    .length;
  return (result.score ?? 1) +
    result.matchedTerms.length * 2 +
    matchedTargetTermCount * 4 +
    (typeof result.line === "number" ? 1 : 0);
}

function traceNodeFromEvidence(evidence: RepositoryTraceEvidence, target: string): RepositoryTraceNode {
  const symbol = evidence.symbol ?? inferSymbolFromExcerpt(evidence.excerpt, target);
  const label = symbol ? `${symbol} (${evidence.path})` : evidence.path;
  return {
    id: `candidate:${normalizeSearchText(symbol ?? evidence.path)}`,
    label,
    kind: "candidate",
    path: evidence.path,
    symbol,
    score: scoreTraceEvidence(evidence, target),
  };
}

function mergeTraceNode(
  existing: RepositoryTraceNode | undefined,
  next: RepositoryTraceNode,
): RepositoryTraceNode {
  if (!existing) return next;
  return {
    ...existing,
    path: existing.path ?? next.path,
    symbol: existing.symbol ?? next.symbol,
    score: Math.max(existing.score, next.score),
  };
}

function createTraceEdge(options: {
  direction: RepositoryTraceDirection;
  targetId: string;
  candidateId: string;
  evidence: RepositoryTraceEvidence;
  target: string;
  workspaceModulePrefixes?: ReadonlyArray<string>;
}): RepositoryTraceEdge {
  const confidence = calculateTraceConfidence(options.evidence, options.target);
  const relation = inferTraceRelation(options.evidence, options.target, confidence);
  const moduleSpecifier = extractModuleSpecifier(options.evidence.excerpt);
  const moduleKind = moduleSpecifier
    ? classifyModuleSpecifier(moduleSpecifier, options.workspaceModulePrefixes)
    : undefined;
  if (options.direction === "backward") {
    return {
      from: options.candidateId,
      to: options.targetId,
      relation,
      evidencePath: options.evidence.path,
      line: options.evidence.line,
      excerpt: options.evidence.excerpt,
      confidence,
      ...(moduleSpecifier ? { moduleSpecifier } : {}),
      ...(moduleKind ? { moduleKind } : {}),
    };
  }
  return {
    from: options.targetId,
    to: options.candidateId,
    relation,
    evidencePath: options.evidence.path,
    line: options.evidence.line,
    excerpt: options.evidence.excerpt,
    confidence,
    ...(moduleSpecifier ? { moduleSpecifier } : {}),
    ...(moduleKind ? { moduleKind } : {}),
  };
}

function calculateTraceConfidence(evidence: RepositoryTraceEvidence, target: string): number {
  const normalizedExcerpt = normalizeSearchText(evidence.excerpt);
  const normalizedTarget = normalizeSearchText(target);
  if (isImportReference(normalizedExcerpt, normalizedTarget) || isExportReference(normalizedExcerpt, normalizedTarget)) {
    return 0.8;
  }
  if (normalizedExcerpt.includes(`${normalizedTarget}(`) || normalizedExcerpt.includes(`<${normalizedTarget}`)) {
    return 0.85;
  }
  if (evidence.matchedTerms.some((term) => normalizeSearchText(term) === normalizedTarget)) {
    return 0.7;
  }
  return 0.55;
}

function inferTraceRelation(
  evidence: RepositoryTraceEvidence,
  target: string,
  confidence: number,
): RepositoryTraceRelation {
  const normalizedExcerpt = normalizeSearchText(evidence.excerpt);
  const normalizedTarget = normalizeSearchText(target);
  if (isImportReference(normalizedExcerpt, normalizedTarget)) return "imports";
  if (isExportReference(normalizedExcerpt, normalizedTarget)) return "exports";
  return confidence >= 0.75 ? "may_call" : "references";
}

function isImportReference(normalizedExcerpt: string, normalizedTarget: string): boolean {
  return (
    normalizedExcerpt.includes("import ") ||
    normalizedExcerpt.includes(" from ") ||
    normalizedExcerpt.includes("require(")
  ) && normalizedExcerpt.includes(normalizedTarget);
}

function isExportReference(normalizedExcerpt: string, normalizedTarget: string): boolean {
  return (
    normalizedExcerpt.includes("export ") ||
    normalizedExcerpt.includes("module.exports") ||
    normalizedExcerpt.includes("exports.")
  ) && normalizedExcerpt.includes(normalizedTarget);
}

function extractModuleSpecifier(excerpt: string): string | undefined {
  return excerpt.match(/\bfrom\s+["']([^"']+)["']/)?.[1] ??
    excerpt.match(/\brequire\(\s*["']([^"']+)["']\s*\)/)?.[1] ??
    excerpt.match(/\bimport\(\s*["']([^"']+)["']\s*\)/)?.[1];
}

function classifyModuleSpecifier(
  specifier: string,
  workspaceModulePrefixes: ReadonlyArray<string> | undefined,
): RepositoryTraceModuleKind {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("\\")) {
    return "relative";
  }
  if (workspaceModulePrefixes?.some((prefix) => prefix && specifier.startsWith(prefix))) {
    return "workspace";
  }
  return "external";
}

function buildRepositoryTraceModuleLinks(
  edges: ReadonlyArray<RepositoryTraceEdge>,
): RepositoryTraceModuleLink[] {
  const links = new Map<string, RepositoryTraceModuleLink>();
  for (const edge of edges) {
    if (!edge.moduleSpecifier || !edge.moduleKind) continue;
    const existing = links.get(edge.moduleSpecifier) ?? {
      specifier: edge.moduleSpecifier,
      kind: edge.moduleKind,
      evidencePaths: [],
      importCount: 0,
      exportCount: 0,
      dynamicImportCount: 0,
      confidence: 0,
    };
    existing.evidencePaths = unique([...existing.evidencePaths, edge.evidencePath]).sort();
    existing.importCount += edge.relation === "imports" ? 1 : 0;
    existing.exportCount += edge.relation === "exports" ? 1 : 0;
    existing.dynamicImportCount += /\bimport\(\s*["'][^"']+["']\s*\)/.test(edge.excerpt) ? 1 : 0;
    existing.confidence = Math.max(existing.confidence, edge.confidence);
    links.set(edge.moduleSpecifier, existing);
  }
  return [...links.values()]
    .sort((left, right) =>
      right.confidence - left.confidence ||
      right.evidencePaths.length - left.evidencePaths.length ||
      left.specifier.localeCompare(right.specifier),
    );
}

function inferSymbolFromExcerpt(excerpt: string, target: string): string | undefined {
  const targetTerms = extractSearchTerms(target);
  const symbol = excerpt.match(/\bimport\s+\{?\s*([A-Za-z_$][\w$]*)/)?.[1] ??
    excerpt.match(/\b(?:function|class|const|let|var|export function|export class|export const)\s+([A-Za-z_$][\w$]*)/)?.[1] ??
    excerpt.match(/\b([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?\(?/)?.[1];
  if (!symbol || targetTerms.includes(normalizeSearchText(symbol))) return undefined;
  return symbol;
}

function rankTraceKeyFiles(results: ReadonlyArray<RepositoryTraceEvidence>): string[] {
  const scores = new Map<string, number>();
  for (const result of results) {
    scores.set(result.path, (scores.get(result.path) ?? 0) + scoreTraceEvidence(result, result.symbol ?? ""));
  }
  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([path]) => path);
}

function labelTraceNode(node: RepositoryTraceNode | undefined, fallback: string): string {
  return node?.label ?? fallback;
}

function looksLikePath(value: string): boolean {
  return /[\\/]/.test(value) || /\.[a-z0-9]+$/i.test(value);
}

function inferTestFileCandidates(
  keyFiles: ReadonlyArray<string>,
  relatedTestFiles: ReadonlyArray<string>,
): string[] {
  const knownTests = new Set(relatedTestFiles.map(normalizePathForComparison));
  return unique(keyFiles
    .filter((path) => !isTestFilePath(path))
    .flatMap(createTestFileCandidates)
    .filter((path) => !knownTests.has(normalizePathForComparison(path))));
}

function createTestFileCandidates(path: string): string[] {
  const normalized = path.replace(/\\/g, "/");
  const match = normalized.match(/^(.*\/)?([^/.]+)\.([cm]?[tj]sx?)$/i);
  if (!match) return [];
  const directory = match[1] ?? "";
  const basename = match[2];
  const extension = match[3];
  return [
    `${directory}${basename}.test.${extension}`,
    `${directory}${basename}.spec.${extension}`,
    `${directory}__tests__/${basename}.test.${extension}`,
    `${directory}__tests__/${basename}.spec.${extension}`,
  ];
}

function isTestFilePath(path: string): boolean {
  return /(^|[\\/])[^\\/]+\.(test|spec)\.[cm]?[tj]sx?$/i.test(path);
}

function normalizePathForComparison(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

function createPriorityPathSet(priorityPaths: ReadonlyArray<string> | undefined): ReadonlySet<string> {
  return new Set((priorityPaths ?? [])
    .map(normalizePathForComparison)
    .map((path) => path.replace(/^\.\//, ""))
    .filter(Boolean));
}

function isPriorityPath(path: string, priorityPathSet: ReadonlySet<string>): boolean {
  if (priorityPathSet.size === 0) return false;
  const normalized = normalizePathForComparison(path).replace(/^\.\//, "");
  for (const priorityPath of priorityPathSet) {
    if (normalized === priorityPath || normalized.endsWith(`/${priorityPath}`) || priorityPath.endsWith(`/${normalized}`)) {
      return true;
    }
  }
  return false;
}

function getClusterId(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.length >= 3 && parts[0] === "packages") return `${parts[0]}/${parts[1]}`;
  if (parts.length >= 3 && parts[0] === "apps") return `${parts[0]}/${parts[1]}`;
  if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return parts[0] ?? "root";
}

function countTerms(terms: ReadonlyArray<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const term of terms) {
    const normalized = normalizeSearchText(term);
    if (!normalized) continue;
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return counts;
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function unique(values: ReadonlyArray<string>): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
