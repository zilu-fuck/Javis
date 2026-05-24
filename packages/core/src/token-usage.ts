import type { AgentKind } from "./index";
import type { ModelUsage, TokenUsageSummary } from "@javis/tools";

export function createEmptyTokenUsageSummary(): TokenUsageSummary {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    modelCalls: 0,
    byAgentKind: [],
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
  const current = summary ?? createEmptyTokenUsageSummary();
  const existingAgent = current.byAgentKind.find((entry) => entry.agentKind === agentKind);
  const nextAgent = {
    agentKind,
    inputTokens: (existingAgent?.inputTokens ?? 0) + inputTokens,
    outputTokens: (existingAgent?.outputTokens ?? 0) + outputTokens,
    totalTokens: (existingAgent?.totalTokens ?? 0) + totalTokens,
    modelCalls: (existingAgent?.modelCalls ?? 0) + 1,
  };

  return {
    inputTokens: current.inputTokens + inputTokens,
    outputTokens: current.outputTokens + outputTokens,
    totalTokens: current.totalTokens + totalTokens,
    modelCalls: current.modelCalls + 1,
    byAgentKind: [
      ...current.byAgentKind.filter((entry) => entry.agentKind !== agentKind),
      nextAgent,
    ],
  };
}

function normalizeTokenCount(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}
