/**
 * Conclusion-first result view (E3).
 *
 * The Inspector presents everything it has: every evidence item, every step, every
 * log line, all at once. The measured complaint is information density — the answer is
 * somewhere in the pile, and the user has to find it.
 *
 * This module builds the two-layer view instead: a **conclusion layer** (headline, the
 * answer, a few key points, and *counts* of what backs it) and an **evidence layer**
 * that the UI reveals on demand.
 *
 * Two ordering decisions carry the design:
 *
 *  * **gaps rank above evidence** — "the diff was never produced" is more important
 *    than the twelve files that were read, and burying it under evidence is how a
 *    partial result looks complete;
 *  * **the answer is truncated at a sentence boundary**, never mid-word, because a
 *    half-sentence in a collapsed card reads as a truncated answer.
 */

export type ConclusionStatus = "completed" | "failed" | "partial" | "cancelled" | "running";

export type ConclusionLocale = "en" | "zhCN";

export interface ConclusionEvidenceItem {
  kind: string;
  label: string;
  reference?: string;
}

export interface ConclusionStepSummary {
  id: string;
  agentKind: string;
  status: "completed" | "failed" | "skipped" | "partial";
}

export interface ConclusionViewInput {
  goal: string;
  status: ConclusionStatus;
  /** The model's final answer, if one was produced. */
  conclusion?: string;
  evidence?: readonly ConclusionEvidenceItem[];
  steps?: readonly ConclusionStepSummary[];
  /** Handoff/report gaps: what is missing or unverified. */
  gaps?: readonly string[];
  usage?: { totalTokens: number; modelCalls: number };
}

export interface ConclusionView {
  headline: string;
  /** The answer trimmed for a collapsed card. */
  conclusion: string;
  /** True when `conclusion` is shorter than the full text. */
  truncated: boolean;
  /** At most `maxBullets` key points, most important first. */
  bullets: string[];
  /** Evidence counts, for a "show evidence" affordance. */
  evidenceSummary: string;
  evidenceTotal: number;
  /** The full evidence list, grouped by kind, for the expanded view. */
  evidenceByKind: Array<{ kind: string; count: number; items: ConclusionEvidenceItem[] }>;
  /** Gaps are always shown, never collapsed. */
  gaps: string[];
}

export const DEFAULT_CONCLUSION_MAX_CHARS = 480;
export const DEFAULT_MAX_BULLETS = 5;

const STATUS_HEADLINE: Record<ConclusionStatus, Record<ConclusionLocale, string>> = {
  completed: { en: "Completed", zhCN: "已完成" },
  failed: { en: "Failed", zhCN: "失败" },
  partial: { en: "Partially completed", zhCN: "部分完成" },
  cancelled: { en: "Cancelled", zhCN: "已取消" },
  running: { en: "Running", zhCN: "进行中" },
};

export function buildConclusionView(
  input: ConclusionViewInput,
  options: { locale?: ConclusionLocale; maxChars?: number; maxBullets?: number } = {},
): ConclusionView {
  const locale = options.locale ?? "en";
  const isChinese = locale === "zhCN";
  const maxChars = Math.max(40, options.maxChars ?? DEFAULT_CONCLUSION_MAX_CHARS);
  const maxBullets = Math.max(1, options.maxBullets ?? DEFAULT_MAX_BULLETS);

  const evidence = [...(input.evidence ?? [])];
  const rawConclusion = (input.conclusion ?? "").trim();
  const { text: conclusion, truncated } = truncateAtSentence(rawConclusion, maxChars);

  const statusLabel = STATUS_HEADLINE[input.status][locale];
  const goal = truncateAtSentence(input.goal.trim(), 120).text;
  const headline = goal.length > 0 ? `${statusLabel}: ${goal}` : statusLabel;

  const bullets: string[] = [];
  const steps = [...(input.steps ?? [])];
  const failedSteps = steps.filter((step) => step.status === "failed");
  const partialSteps = steps.filter((step) => step.status === "partial");

  if (input.status === "failed" && failedSteps.length > 0) {
    bullets.push(isChinese
      ? `${failedSteps.length} 个步骤失败：${failedSteps.map((step) => step.id).slice(0, 3).join("、")}`
      : `${failedSteps.length} step(s) failed: ${failedSteps.map((step) => step.id).slice(0, 3).join(", ")}`);
  }
  if (input.status === "partial" || partialSteps.length > 0) {
    bullets.push(isChinese
      ? `有 ${partialSteps.length} 个步骤只部分完成，结论可能不完整。`
      : `${partialSteps.length} step(s) completed only partially, so the conclusion may be incomplete.`);
  }
  if (failedSteps.length === 0 && partialSteps.length === 0 && steps.length > 0) {
    const agents = [...new Set(steps.map((step) => step.agentKind))];
    bullets.push(isChinese
      ? `${steps.length} 个步骤全部完成，涉及 ${agents.length} 个 agent。`
      : `All ${steps.length} step(s) completed across ${agents.length} agent kind(s).`);
  }
  if (input.usage && input.usage.modelCalls > 0) {
    bullets.push(isChinese
      ? `${input.usage.modelCalls} 次模型调用，共 ${input.usage.totalTokens.toLocaleString()} tokens。`
      : `${input.usage.modelCalls} model call(s), ${input.usage.totalTokens.toLocaleString()} tokens.`);
  }
  if (evidence.length > 0) {
    bullets.push(isChinese
      ? `依据 ${evidence.length} 项证据（展开可见）。`
      : `Backed by ${evidence.length} evidence item(s) (expand to inspect).`);
  }
  if (conclusion.length === 0) {
    bullets.unshift(isChinese
      ? "没有产出最终结论——请查看证据与缺口。"
      : "No final conclusion was produced — check the evidence and gaps.");
  }

  const grouped = new Map<string, ConclusionEvidenceItem[]>();
  for (const item of evidence) {
    const bucket = grouped.get(item.kind) ?? [];
    bucket.push(item);
    grouped.set(item.kind, bucket);
  }
  const evidenceByKind = [...grouped.entries()]
    .map(([kind, items]) => ({ kind, count: items.length, items }))
    .sort((left, right) => (right.count - left.count) || left.kind.localeCompare(right.kind));

  const evidenceSummary = evidence.length === 0
    ? (isChinese ? "没有证据项" : "No evidence items")
    : evidenceByKind
        .map((group) => `${group.count} ${group.kind}`)
        .join(isChinese ? "、" : ", ");

  return {
    headline,
    conclusion,
    truncated,
    bullets: bullets.slice(0, maxBullets),
    evidenceSummary,
    evidenceTotal: evidence.length,
    evidenceByKind,
    gaps: [...(input.gaps ?? [])],
  };
}

/**
 * Trims to `maxChars` at the last sentence boundary that fits.
 *
 * Falls back to the last word boundary, and only then to a hard cut — so the result
 * never ends in the middle of a word.
 */
export function truncateAtSentence(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  const window = value.slice(0, maxChars);
  const sentenceEnd = Math.max(
    window.lastIndexOf("。"),
    window.lastIndexOf("！"),
    window.lastIndexOf("？"),
    window.lastIndexOf(". "),
    window.lastIndexOf("! "),
    window.lastIndexOf("? "),
  );
  if (sentenceEnd > maxChars * 0.4) {
    return { text: window.slice(0, sentenceEnd + 1).trim(), truncated: true };
  }
  const wordEnd = Math.max(window.lastIndexOf(" "), window.lastIndexOf("，"), window.lastIndexOf(","));
  if (wordEnd > maxChars * 0.4) {
    return { text: window.slice(0, wordEnd).trim(), truncated: true };
  }
  return { text: window.trim(), truncated: true };
}
