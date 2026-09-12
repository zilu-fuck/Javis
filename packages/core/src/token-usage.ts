import type { AgentKind } from "./index";
import type { ModelUsage, TokenUsageSummary } from "@javis/tools";

export function createEmptyTokenUsageSummary(): TokenUsageSummary {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    peakContextTokens: 0,
    modelCalls: 0,
    byAgentKind: [],
  };
}

export function cloneTokenUsageSummary(
  summary: TokenUsageSummary | undefined,
): TokenUsageSummary {
  if (!summary) return createEmptyTokenUsageSummary();
  return {
    ...summary,
    byAgentKind: summary.byAgentKind.map((usage) => ({ ...usage })),
  };
}

export function addModelUsage(
  summary: TokenUsageSummary | undefined,
  agentKind: AgentKind,
  usage: ModelUsage,
): TokenUsageSummary {
  const inputTokens = normalizeTokenCount(usage.inputTokens);
  const outputTokens = normalizeTokenCount(usage.outputTokens);
  const totalTokens = normalizeTokenCount(usage.totalTokens ?? inputTokens + outputTokens);
  const cacheReadTokens = normalizeOptionalTokenCount(usage.cacheReadTokens);
  const cacheWriteTokens = normalizeOptionalTokenCount(usage.cacheWriteTokens);
  const contextWindowTokens = normalizeOptionalPositiveTokenCount(usage.contextWindowTokens);
  const current = summary ?? createEmptyTokenUsageSummary();
  const existingAgent = current.byAgentKind.find((entry) => entry.agentKind === agentKind);
  const nextAgent = {
    agentKind,
    inputTokens: (existingAgent?.inputTokens ?? 0) + inputTokens,
    outputTokens: (existingAgent?.outputTokens ?? 0) + outputTokens,
    totalTokens: (existingAgent?.totalTokens ?? 0) + totalTokens,
    modelCalls: (existingAgent?.modelCalls ?? 0) + 1,
  };

  const nextContextPair = selectMostUtilizedContextPair(current, totalTokens, contextWindowTokens);
  // Keep the sums undefined while no provider has reported cache fields so
  // persisted summaries don't fill with zero-noise.
  const nextCacheRead = cacheReadTokens !== undefined || current.cacheReadTokens !== undefined
    ? (current.cacheReadTokens ?? 0) + (cacheReadTokens ?? 0)
    : undefined;
  const nextCacheWrite = cacheWriteTokens !== undefined || current.cacheWriteTokens !== undefined
    ? (current.cacheWriteTokens ?? 0) + (cacheWriteTokens ?? 0)
    : undefined;
  return {
    inputTokens: current.inputTokens + inputTokens,
    outputTokens: current.outputTokens + outputTokens,
    totalTokens: current.totalTokens + totalTokens,
    peakContextTokens: Math.max(current.peakContextTokens ?? 0, totalTokens),
    ...nextContextPair,
    ...(nextCacheRead !== undefined ? { cacheReadTokens: nextCacheRead } : {}),
    ...(nextCacheWrite !== undefined ? { cacheWriteTokens: nextCacheWrite } : {}),
    modelCalls: current.modelCalls + 1,
    byAgentKind: [
      ...current.byAgentKind.filter((entry) => entry.agentKind !== agentKind),
      nextAgent,
    ],
  };
}

function selectMostUtilizedContextPair(
  current: TokenUsageSummary,
  usedTokens: number,
  contextWindowTokens: number | undefined,
): Pick<TokenUsageSummary, "contextUsedTokens" | "contextWindowTokens"> {
  const currentUsed = normalizeOptionalTokenCount(current.contextUsedTokens);
  const currentWindow = normalizeOptionalPositiveTokenCount(current.contextWindowTokens);
  if (contextWindowTokens === undefined) {
    return currentUsed !== undefined && currentWindow !== undefined
      ? { contextUsedTokens: currentUsed, contextWindowTokens: currentWindow }
      : {};
  }
  const nextRatio = usedTokens / contextWindowTokens;
  const currentRatio = currentUsed !== undefined && currentWindow !== undefined
    ? currentUsed / currentWindow
    : -1;
  if (nextRatio > currentRatio || (nextRatio === currentRatio && usedTokens > (currentUsed ?? -1))) {
    return { contextUsedTokens: usedTokens, contextWindowTokens };
  }
  return { contextUsedTokens: currentUsed!, contextWindowTokens: currentWindow! };
}

function normalizeTokenCount(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

function normalizeOptionalTokenCount(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

function normalizeOptionalPositiveTokenCount(value: number | undefined): number | undefined {
  const normalized = normalizeOptionalTokenCount(value);
  return normalized !== undefined && normalized > 0 ? normalized : undefined;
}
