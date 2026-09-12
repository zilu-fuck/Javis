import type { HandoffReport } from "./shared-context";

/**
 * Handoff narrative (D2).
 *
 * The handoff report is a precise engineering artifact — producer/consumer keys,
 * statuses, value summaries — and it is unreadable as a story. A user watching five
 * agents work wants to know *who gave what to whom, and what is still missing*.
 *
 * This formatter renders exactly that, in both supported languages, and keeps the
 * two ideas the report already encodes:
 *
 *  * a handoff is only real when a producer wrote a key **and** a consumer read it;
 *  * the interesting lines are the gaps — an input nobody produced, a key nobody
 *    consumed, or a value whose shape does not match its schema.
 */

export type HandoffNarrativeLocale = "en" | "zhCN";

export interface HandoffNarrativeLine {
  kind: "handoff" | "gap";
  /** Agent that produced the value, when there is one. */
  from?: string;
  /** Agents that read the value; empty for a gap with no consumer. */
  to: string[];
  contextKey: string;
  text: string;
}

export interface HandoffNarrative {
  title: string;
  status: HandoffReport["status"];
  lines: HandoffNarrativeLine[];
  /** One-line summary suitable for a collapsed card. */
  summary: string;
}

const MAX_LINES = 24;

export function formatHandoffNarrative(
  report: HandoffReport,
  options: { locale?: HandoffNarrativeLocale; maxLines?: number } = {},
): HandoffNarrative {
  const locale = options.locale ?? "en";
  const isChinese = locale === "zhCN";
  const maxLines = Math.max(1, options.maxLines ?? MAX_LINES);
  const agentByStepId = new Map(report.steps.map((step) => [step.stepId, step.assignedAgentKind]));
  const lines: HandoffNarrativeLine[] = [];

  for (const handoff of report.handoffs) {
    const from = handoff.producedByStepId
      ? agentByStepId.get(handoff.producedByStepId)
      : undefined;
    const to = handoff.consumedByStepIds
      .map((stepId) => agentByStepId.get(stepId))
      .filter((kind): kind is string => Boolean(kind));

    if (from && to.length > 0) {
      const consumers = [...new Set(to)].join(", ");
      lines.push({
        kind: "handoff",
        from,
        to: [...new Set(to)],
        contextKey: handoff.contextKey,
        text: isChinese
          ? `${from} → ${consumers}：交出「${handoff.contextKey}」`
          : `${from} → ${consumers}: handed over "${handoff.contextKey}"`,
      });
      continue;
    }

    if (!from) {
      lines.push({
        kind: "gap",
        to: [...new Set(to)],
        contextKey: handoff.contextKey,
        text: isChinese
          ? `「${handoff.contextKey}」被消费但没有生产者声明`
          : `"${handoff.contextKey}" was consumed but has no declared producer`,
      });
    }
  }

  for (const key of report.missingInputContextKeys) {
    lines.push({
      kind: "gap",
      to: [],
      contextKey: key,
      text: isChinese
        ? `缺少上游产物：「${key}」没有任何步骤产出`
        : `missing upstream artifact: no step produces "${key}"`,
    });
  }

  for (const key of report.unconsumedOutputContextKeys) {
    lines.push({
      kind: "gap",
      to: [],
      contextKey: key,
      text: isChinese
        ? `「${key}」已产出但没有任何步骤读取`
        : `"${key}" was produced but no step read it`,
    });
  }

  for (const key of report.invalidInputContextKeys) {
    lines.push({
      kind: "gap",
      to: [],
      contextKey: key,
      text: isChinese
        ? `「${key}」的形状与声明的 schema 不符`
        : `"${key}" does not match its declared schema`,
    });
  }

  const handoffCount = lines.filter((line) => line.kind === "handoff").length;
  const gapCount = lines.length - handoffCount;
  const truncated = lines.length > maxLines;

  return {
    title: isChinese ? "Agent 协作交接" : "Agent handoffs",
    status: report.status,
    lines: lines.slice(0, maxLines),
    summary: isChinese
      ? `${handoffCount} 次交接，${gapCount} 处缺口${truncated ? `（仅显示前 ${maxLines} 条）` : ""}`
      : `${handoffCount} handoff${handoffCount === 1 ? "" : "s"}, ${gapCount} gap${gapCount === 1 ? "" : "s"}`
        + (truncated ? ` (showing first ${maxLines})` : ""),
  };
}
