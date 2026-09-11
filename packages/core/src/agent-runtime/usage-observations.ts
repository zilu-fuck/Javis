import type { TokenUsageSummary } from "@javis/tools";
import type { AgentKind } from "../index";
import type { AgentTokenUsage, WorkflowExecutionBackend } from "./contracts";

/**
 * Idempotent per-call usage observation ledger (dual-kernel plan §12).
 *
 * Every model call owns exactly one canonical record addressed by `callId`.
 * Streaming usage, pre-failure usage and the final usage upsert the same
 * record with monotonically increasing revisions; the task total always sums
 * the latest record of each call, so a final (sealing) revision never double
 * counts. `availability: "unavailable"` is an unknown value and must not be
 * converted into zero tokens.
 */
export type UsageAvailability = "reported" | "unavailable";

export type UsageSemantics = "cumulative_for_call";

export interface UsageObservation {
  callId: string;
  revision: number;
  final: boolean;
  taskId: string;
  workflowRunId?: string;
  stepId?: string;
  attempt?: number;
  agentKind: AgentKind;
  backend: WorkflowExecutionBackend;
  provider?: string;
  model?: string;
  contextWindowTokens?: number;
  availability: UsageAvailability;
  semantics: UsageSemantics;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type UsageObservationCollection = ReadonlyMap<string, UsageObservation>;

export function upsertUsageObservation(
  collection: UsageObservationCollection,
  observation: UsageObservation,
): UsageObservationCollection {
  const next = new Map(collection);
  const existing = next.get(observation.callId);
  if (existing) {
    // Late-arriving or stale events (lower/equal revision after a seal or a
    // newer revision) must never overwrite newer data.
    if (existing.final && observation.revision <= existing.revision) return collection;
    if (observation.revision < existing.revision) return collection;
  }
  next.set(observation.callId, observation);
  return next;
}

export function usageObservationFromEvent(input: {
  callId: string;
  taskId: string;
  workflowRunId?: string;
  stepId?: string;
  attempt?: number;
  agentKind: AgentKind;
  backend: WorkflowExecutionBackend;
  usage: AgentTokenUsage;
  revision?: number;
  final?: boolean;
}): UsageObservation {
  const hasReportedTokens = usageHasReportedTokens(input.usage);
  return {
    callId: input.callId,
    revision: normalizeRevision(input.revision),
    final: input.final === true,
    taskId: input.taskId,
    ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
    ...(input.stepId ? { stepId: input.stepId } : {}),
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    agentKind: input.agentKind,
    backend: input.backend,
    ...(input.usage.provider ? { provider: input.usage.provider } : {}),
    ...(input.usage.model ? { model: input.usage.model } : {}),
    ...(normalizeOptionalPositive(input.usage.contextWindowTokens)
      ? { contextWindowTokens: normalizeOptionalPositive(input.usage.contextWindowTokens) }
      : {}),
    availability: hasReportedTokens ? "reported" : "unavailable",
    semantics: "cumulative_for_call",
    ...(normalizeOptionalNonNegative(input.usage.inputTokens)
      ? { inputTokens: normalizeOptionalNonNegative(input.usage.inputTokens) }
      : {}),
    ...(normalizeOptionalNonNegative(input.usage.outputTokens)
      ? { outputTokens: normalizeOptionalNonNegative(input.usage.outputTokens) }
      : {}),
    ...(normalizeOptionalNonNegative(input.usage.totalTokens)
      ? { totalTokens: normalizeOptionalNonNegative(input.usage.totalTokens) }
      : {}),
  };
}

/** Latest record per callId, summed into a TokenUsageSummary. */
export function summarizeUsageObservations(
  collection: UsageObservationCollection,
): TokenUsageSummary {
  const byCall = new Map<string, UsageObservation>();
  for (const observation of collection.values()) {
    const existing = byCall.get(observation.callId);
    if (existing && observation.revision < existing.revision) continue;
    if (existing?.final && observation.revision <= existing.revision) continue;
    byCall.set(observation.callId, observation);
  }
  const reported = [...byCall.values()].filter(
    (observation) => observation.availability === "reported",
  );
  const inputTokens = sumTokens(reported, (o) => o.inputTokens);
  const outputTokens = sumTokens(reported, (o) => o.outputTokens);
  const totalTokens = sumTokens(reported, (o) => o.totalTokens ?? (o.inputTokens ?? 0) + (o.outputTokens ?? 0));
  const perAgent = new Map<string, { inputTokens: number; outputTokens: number; totalTokens: number; modelCalls: number }>();
  for (const observation of reported) {
    const bucket = perAgent.get(observation.agentKind) ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0, modelCalls: 0 };
    bucket.inputTokens += normalizeTokenCount(observation.inputTokens);
    bucket.outputTokens += normalizeTokenCount(observation.outputTokens);
    bucket.totalTokens += normalizeTokenCount(observation.totalTokens ?? (observation.inputTokens ?? 0) + (observation.outputTokens ?? 0));
    bucket.modelCalls += 1;
    perAgent.set(observation.agentKind, bucket);
  }
  const contextPair = selectMostUtilizedContextPair(reported);
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    peakContextTokens: Math.max(...reported.map((o) => normalizeTokenCount(o.totalTokens ?? (o.inputTokens ?? 0) + (o.outputTokens ?? 0))), 0),
    ...contextPair,
    modelCalls: reported.length,
    byAgentKind: [...perAgent.entries()].map(([agentKind, usage]) => ({ agentKind, ...usage })),
  };
}

function usageHasReportedTokens(usage: AgentTokenUsage): boolean {
  return normalizeOptionalNonNegative(usage.inputTokens) !== undefined ||
    normalizeOptionalNonNegative(usage.outputTokens) !== undefined ||
    normalizeOptionalNonNegative(usage.totalTokens) !== undefined;
}

function selectMostUtilizedContextPair(
  observations: readonly UsageObservation[],
): Pick<TokenUsageSummary, "contextUsedTokens" | "contextWindowTokens"> {
  let bestUsed: number | undefined;
  let bestWindow: number | undefined;
  for (const observation of observations) {
    const used = normalizeOptionalNonNegative(
      observation.totalTokens ?? (observation.inputTokens ?? 0) + (observation.outputTokens ?? 0),
    );
    const window = normalizeOptionalPositive(observation.contextWindowTokens);
    if (window === undefined) continue;
    const nextRatio = (used ?? 0) / window;
    const currentRatio = bestUsed !== undefined && bestWindow !== undefined
      ? bestUsed / bestWindow
      : -1;
    if (nextRatio > currentRatio) {
      bestUsed = used;
      bestWindow = window;
    }
  }
  return bestUsed !== undefined && bestWindow !== undefined
    ? { contextUsedTokens: bestUsed, contextWindowTokens: bestWindow }
    : {};
}

function sumTokens(
  observations: readonly UsageObservation[],
  pick: (observation: UsageObservation) => number | undefined,
): number {
  return observations.reduce((total, observation) => total + normalizeTokenCount(pick(observation)), 0);
}

function normalizeTokenCount(value: number | undefined): number {
  return normalizeOptionalNonNegative(value) ?? 0;
}

function normalizeOptionalNonNegative(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

function normalizeOptionalPositive(value: number | undefined): number | undefined {
  const normalized = normalizeOptionalNonNegative(value);
  return normalized !== undefined && normalized > 0 ? normalized : undefined;
}

function normalizeRevision(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return 1;
  return Math.floor(value);
}
