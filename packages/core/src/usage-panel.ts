import type { TokenUsageSummary } from "@javis/tools";

/**
 * Usage panel (E5).
 *
 * The raw summary answers "how many tokens" but not the two questions a user
 * actually asks: *is my cache working?* and *how close am I to the context limit?*
 * Both are ratios, and a ratio is only useful next to the numbers that produced it.
 *
 * Cost is deliberately optional. The repository ships no per-model price table, and
 * inventing one would produce confidently wrong money figures — the worst kind of
 * wrong. When a caller supplies prices the panel adds a cost line; otherwise it
 * reports tokens only and says why.
 */

export type UsagePanelLocale = "en" | "zhCN";

/** Prices per million tokens, in the caller's currency. */
export interface UsagePricing {
  inputPerMillion: number;
  outputPerMillion: number;
  /** Cache reads are usually discounted; defaults to the input price. */
  cacheReadPerMillion?: number;
  /** Cache writes are usually surcharged; defaults to the input price. */
  cacheWritePerMillion?: number;
  currency?: string;
}

export interface UsagePanelLine {
  id: "tokens" | "cache" | "context" | "agents" | "cost";
  label: string;
  value: string;
  /** Set when the line carries a caveat the user should notice. */
  note?: string;
}

export interface UsagePanel {
  lines: UsagePanelLine[];
  /** Cache read / total input, or `undefined` when the provider reported nothing. */
  cacheHitRate?: number;
  /** Context used / window, or `undefined` when the window is unknown. */
  contextUtilization?: number;
  /** Estimated cost when pricing was supplied. */
  estimatedCost?: number;
  /** Non-empty when the panel cannot show something the user would expect. */
  caveats: string[];
}

/** A hit rate below this is worth flagging: the prefix is moving too much. */
export const LOW_CACHE_HIT_RATE_THRESHOLD = 0.3;
/** Utilization above this is worth flagging before the provider rejects a call. */
export const HIGH_CONTEXT_UTILIZATION_THRESHOLD = 0.85;

export function computeCacheHitRate(summary: TokenUsageSummary): number | undefined {
  const cached = summary.cacheReadTokens ?? 0;
  if (summary.inputTokens <= 0) {
    return undefined;
  }
  if (cached <= 0 && (summary.cacheWriteTokens ?? 0) <= 0) {
    // No provider cache activity at all: a 0% rate would be misleading.
    return undefined;
  }
  return Math.min(1, cached / summary.inputTokens);
}

export function computeContextUtilization(summary: TokenUsageSummary): number | undefined {
  const used = summary.contextUsedTokens;
  const window = summary.contextWindowTokens;
  if (used === undefined || window === undefined || window <= 0) {
    return undefined;
  }
  return Math.min(1, used / window);
}

export function estimateUsageCost(
  summary: TokenUsageSummary,
  pricing: UsagePricing,
): number {
  const cacheRead = summary.cacheReadTokens ?? 0;
  const cacheWrite = summary.cacheWriteTokens ?? 0;
  // `inputTokens` is the TOTAL input across dialects, so the cached portions must be
  // subtracted before applying the uncached price.
  const uncachedInput = Math.max(0, summary.inputTokens - cacheRead - cacheWrite);
  const perMillion = (tokens: number, price: number) => (tokens / 1_000_000) * price;
  return perMillion(uncachedInput, pricing.inputPerMillion)
    + perMillion(cacheRead, pricing.cacheReadPerMillion ?? pricing.inputPerMillion)
    + perMillion(cacheWrite, pricing.cacheWritePerMillion ?? pricing.inputPerMillion)
    + perMillion(summary.outputTokens, pricing.outputPerMillion);
}

export function formatUsagePanel(
  summary: TokenUsageSummary,
  options: { locale?: UsagePanelLocale; pricing?: UsagePricing } = {},
): UsagePanel {
  const isChinese = (options.locale ?? "en") === "zhCN";
  const lines: UsagePanelLine[] = [];
  const caveats: string[] = [];

  lines.push({
    id: "tokens",
    label: isChinese ? "Token 用量" : "Token usage",
    value: isChinese
      ? `输入 ${summary.inputTokens.toLocaleString()} · 输出 ${summary.outputTokens.toLocaleString()} · 共 ${summary.totalTokens.toLocaleString()}`
      : `in ${summary.inputTokens.toLocaleString()} · out ${summary.outputTokens.toLocaleString()} · total ${summary.totalTokens.toLocaleString()}`,
    note: isChinese
      ? `${summary.modelCalls} 次模型调用`
      : `${summary.modelCalls} model call${summary.modelCalls === 1 ? "" : "s"}`,
  });

  const cacheHitRate = computeCacheHitRate(summary);
  if (cacheHitRate === undefined) {
    caveats.push(isChinese
      ? "服务商未回报前缀缓存用量，无法计算命中率。"
      : "The provider reported no prefix-cache usage, so no hit rate can be shown.");
    lines.push({
      id: "cache",
      label: isChinese ? "前缀缓存" : "Prefix cache",
      value: isChinese ? "无数据" : "no data",
      note: isChinese ? "该服务商不报告缓存字段" : "this provider does not report cache fields",
    });
  } else {
    const percent = Math.round(cacheHitRate * 100);
    lines.push({
      id: "cache",
      label: isChinese ? "前缀缓存命中率" : "Prefix cache hit rate",
      value: `${percent}%`,
      note: isChinese
        ? `命中 ${(summary.cacheReadTokens ?? 0).toLocaleString()} · 写入 ${(summary.cacheWriteTokens ?? 0).toLocaleString()}`
        : `read ${(summary.cacheReadTokens ?? 0).toLocaleString()} · written ${(summary.cacheWriteTokens ?? 0).toLocaleString()}`,
    });
    if (cacheHitRate < LOW_CACHE_HIT_RATE_THRESHOLD) {
      caveats.push(isChinese
        ? `命中率偏低（${percent}%）：前缀可能每轮都在变化，成本会明显上升。`
        : `Low hit rate (${percent}%): the cached prefix is probably changing between turns, which costs real money.`);
    }
  }

  const contextUtilization = computeContextUtilization(summary);
  if (contextUtilization === undefined) {
    lines.push({
      id: "context",
      label: isChinese ? "上下文占用" : "Context utilization",
      value: isChinese ? "未知" : "unknown",
      note: isChinese ? "尚未获知模型上下文窗口" : "the model's context window is not known yet",
    });
  } else {
    const percent = Math.round(contextUtilization * 100);
    lines.push({
      id: "context",
      label: isChinese ? "上下文占用" : "Context utilization",
      value: `${percent}%`,
      note: isChinese
        ? `${(summary.contextUsedTokens ?? 0).toLocaleString()} / ${(summary.contextWindowTokens ?? 0).toLocaleString()}`
        : `${(summary.contextUsedTokens ?? 0).toLocaleString()} / ${(summary.contextWindowTokens ?? 0).toLocaleString()}`,
    });
    if (contextUtilization > HIGH_CONTEXT_UTILIZATION_THRESHOLD) {
      caveats.push(isChinese
        ? `上下文占用已达 ${percent}%，下一次调用可能因超限被拒。`
        : `Context is at ${percent}%; the next call may be rejected for length.`);
    }
  }

  if (summary.byAgentKind.length > 0) {
    const ranked = [...summary.byAgentKind].sort((left, right) => right.totalTokens - left.totalTokens);
    const top = ranked[0];
    lines.push({
      id: "agents",
      label: isChinese ? "按 Agent 用量" : "Usage by agent",
      value: isChinese
        ? `${top.agentKind} 最高（${top.totalTokens.toLocaleString()}）`
        : `top: ${top.agentKind} (${top.totalTokens.toLocaleString()})`,
      note: isChinese
        ? `共 ${ranked.length} 个 agent`
        : `${ranked.length} agent${ranked.length === 1 ? "" : "s"}`,
    });
  }

  let estimatedCost: number | undefined;
  if (options.pricing) {
    estimatedCost = estimateUsageCost(summary, options.pricing);
    const currency = options.pricing.currency ?? "USD";
    lines.push({
      id: "cost",
      label: isChinese ? "估算成本" : "Estimated cost",
      value: `${estimatedCost.toFixed(estimatedCost < 1 ? 4 : 2)} ${currency}`,
      note: isChinese ? "按你提供的单价估算" : "estimated from the prices you supplied",
    });
  } else {
    caveats.push(isChinese
      ? "未提供单价，因此不显示成本估算（本仓库不含各模型价目表）。"
      : "No prices supplied, so no cost estimate is shown (this build ships no price table).");
  }

  return {
    lines,
    ...(cacheHitRate !== undefined ? { cacheHitRate } : {}),
    ...(contextUtilization !== undefined ? { contextUtilization } : {}),
    ...(estimatedCost !== undefined ? { estimatedCost } : {}),
    caveats,
  };
}
