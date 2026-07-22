import type {
  AgentRuntimeMetricsSnapshot,
  AgentRuntimeRoutingMetricsSnapshot,
  AgentRuntimeRoutingObservationInput,
  AgentRuntimeRunMetrics,
  AgentTokenUsage,
} from "./contracts";

export interface AgentRuntimeMetricsCollector {
  record(metrics: AgentRuntimeRunMetrics): void;
  snapshot(): AgentRuntimeMetricsSnapshot;
}

export interface AgentRuntimeRoutingMetricsCollector {
  record(observation: AgentRuntimeRoutingObservationInput): boolean;
  snapshot(): AgentRuntimeRoutingMetricsSnapshot[];
}

export function createAgentRuntimeRoutingMetricsCollector(
  initial: readonly AgentRuntimeRoutingMetricsSnapshot[] = [],
): AgentRuntimeRoutingMetricsCollector {
  const aggregates = new Map<string, AgentRuntimeRoutingMetricsSnapshot>();
  for (const metrics of initial) {
    aggregates.set(routingMetricsKey(metrics), normalizeRoutingMetrics(metrics));
  }
  return {
    record(observation) {
      const providerId = normalizeProviderDimension(observation.providerId);
      const taskType = normalizeDimension(observation.taskType, "unknown-task");
      const key = routingMetricsKey({ ...observation, providerId, taskType });
      const current = aggregates.get(key);
      const observationId = normalizeObservationId(observation.observationId);
      if (current?.observationIds.includes(observationId)) return false;
      const rolloutEligible = observation.backend !== "direct" &&
        observation.backend !== "javis_specialized";
      const routeCount = (current?.routeCount ?? 0) + 1;
      const rolloutTargetCount = (current?.rolloutTargetCount ?? 0) +
        (observation.rolloutTargeted && rolloutEligible ? 1 : 0);
      const directRouteCount = (current?.directRouteCount ?? 0) +
        (observation.backend === "direct" ? 1 : 0);
      const langchainRouteCount = (current?.langchainRouteCount ?? 0) +
        (observation.backend === "langchain" ? 1 : 0);
      const opencodeRouteCount = (current?.opencodeRouteCount ?? 0) +
        (observation.backend === "opencode" ? 1 : 0);
      const legacyRouteCount = (current?.legacyRouteCount ?? 0) +
        (observation.backend === "legacy" ? 1 : 0);
      const javisSpecializedRouteCount = (current?.javisSpecializedRouteCount ?? 0) +
        (observation.backend === "javis_specialized" ? 1 : 0);
      const unavailableRouteCount = (current?.unavailableRouteCount ?? 0) +
        (observation.backend === "unavailable" ? 1 : 0);
      const selectedModernBackend = observation.backend === "langchain" ||
        observation.backend === "opencode";
      const fallbackCount = (current?.fallbackCount ?? 0) +
        (observation.rolloutTargeted && rolloutEligible && !selectedModernBackend ? 1 : 0);
      const fallbackReasons = new Map(
        (current?.fallbackReasons ?? []).map((entry) => [entry.reason, entry.count]),
      );
      if (observation.rolloutTargeted && rolloutEligible && !selectedModernBackend) {
        const reason = observation.fallbackReason ?? "legacy_backend_selected";
        fallbackReasons.set(reason, (fallbackReasons.get(reason) ?? 0) + 1);
      }
      aggregates.set(key, {
        providerId,
        agentKind: observation.agentKind,
        taskType,
        routeCount,
        rolloutTargetCount,
        ...(directRouteCount > 0 ? { directRouteCount } : {}),
        langchainRouteCount,
        ...(opencodeRouteCount > 0 ? { opencodeRouteCount } : {}),
        legacyRouteCount,
        ...(javisSpecializedRouteCount > 0 ? { javisSpecializedRouteCount } : {}),
        unavailableRouteCount,
        fallbackCount,
        fallbackRate: rolloutTargetCount === 0 ? 0 : fallbackCount / rolloutTargetCount,
        fallbackReasons: [...fallbackReasons.entries()]
          .map(([reason, count]) => ({ reason, count }))
          .sort((left, right) => left.reason.localeCompare(right.reason)),
        observationIds: [...(current?.observationIds ?? []), observationId],
      });
      return true;
    },
    snapshot() {
      return [...aggregates.values()]
        .map((metrics) => ({
          ...metrics,
          fallbackReasons: metrics.fallbackReasons.map((entry) => ({ ...entry })),
          observationIds: [...metrics.observationIds],
        }))
        .sort((left, right) => routingMetricsKey(left).localeCompare(routingMetricsKey(right)));
    },
  };
}

export function createAgentRuntimeMetricsCollector(
  backend: AgentRuntimeRunMetrics["backend"],
  initial?: AgentRuntimeMetricsSnapshot,
): AgentRuntimeMetricsCollector {
  if (initial && initial.backend !== backend) {
    throw new Error(`Cannot seed ${backend} collector with ${initial.backend} metrics.`);
  }
  let runCount = Math.trunc(nonNegative(initial?.runCount ?? 0));
  let completedRunCount = Math.min(
    runCount,
    Math.trunc(nonNegative(initial?.completedRunCount ?? 0)),
  );
  let totalDurationMs = nonNegative(initial?.totalDurationMs ?? 0);
  let modelCalls = Math.trunc(nonNegative(initial?.modelCalls ?? 0));
  let toolCalls = Math.trunc(nonNegative(initial?.toolCalls ?? 0));
  let usage = initial?.usage ? normalizeUsage(initial.usage) : undefined;
  return {
    record(metrics) {
      if (metrics.backend !== backend) {
        throw new Error(`Cannot record ${metrics.backend} metrics in ${backend} collector.`);
      }
      const run = normalizeRunMetrics(metrics);
      runCount += 1;
      if (run.status === "completed") completedRunCount += 1;
      totalDurationMs += run.durationMs;
      modelCalls += run.modelCalls;
      toolCalls += run.toolCalls;
      usage = addAgentTokenUsage(usage, run.usage);
    },
    snapshot() {
      return {
        backend,
        runCount,
        completedRunCount,
        successRate: runCount === 0 ? 0 : completedRunCount / runCount,
        totalDurationMs,
        averageDurationMs: runCount === 0 ? 0 : totalDurationMs / runCount,
        modelCalls,
        toolCalls,
        ...(usage ? { usage } : {}),
      };
    },
  };
}

export function addAgentTokenUsage(
  current: AgentTokenUsage | undefined,
  next: AgentTokenUsage | undefined,
): AgentTokenUsage | undefined {
  if (!current && !next) return undefined;
  const inputTokens = (current?.inputTokens ?? 0) + (next?.inputTokens ?? 0);
  const outputTokens = (current?.outputTokens ?? 0) + (next?.outputTokens ?? 0);
  return {
    inputTokens,
    outputTokens,
    totalTokens: (current?.totalTokens ?? current?.inputTokens ?? 0) +
      (current?.totalTokens === undefined ? current?.outputTokens ?? 0 : 0) +
      (next?.totalTokens ?? next?.inputTokens ?? 0) +
      (next?.totalTokens === undefined ? next?.outputTokens ?? 0 : 0),
    ...(next?.provider ?? current?.provider
      ? { provider: next?.provider ?? current?.provider }
      : {}),
    ...(next?.model ?? current?.model
      ? { model: next?.model ?? current?.model }
      : {}),
    ...(next?.contextWindowTokens ?? current?.contextWindowTokens
      ? { contextWindowTokens: next?.contextWindowTokens ?? current?.contextWindowTokens }
      : {}),
  };
}

function normalizeRunMetrics(metrics: AgentRuntimeRunMetrics): AgentRuntimeRunMetrics {
  return {
    ...metrics,
    durationMs: nonNegative(metrics.durationMs),
    modelCalls: Math.trunc(nonNegative(metrics.modelCalls)),
    toolCalls: Math.trunc(nonNegative(metrics.toolCalls)),
    ...(metrics.usage
      ? {
          usage: normalizeUsage(metrics.usage),
        }
      : {}),
  };
}

function normalizeUsage(usage: AgentTokenUsage): AgentTokenUsage {
  return {
    inputTokens: Math.trunc(nonNegative(usage.inputTokens)),
    outputTokens: Math.trunc(nonNegative(usage.outputTokens)),
    totalTokens: Math.trunc(nonNegative(
      usage.totalTokens ?? usage.inputTokens + usage.outputTokens,
    )),
  };
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function normalizeRoutingMetrics(
  metrics: AgentRuntimeRoutingMetricsSnapshot,
): AgentRuntimeRoutingMetricsSnapshot {
  const routeCount = Math.trunc(nonNegative(metrics.routeCount));
  const directRouteCount = Math.min(
    routeCount,
    Math.trunc(nonNegative(metrics.directRouteCount ?? 0)),
  );
  const langchainRouteCount = Math.min(
    routeCount - directRouteCount,
    Math.trunc(nonNegative(metrics.langchainRouteCount)),
  );
  const opencodeRouteCount = Math.min(
    routeCount - directRouteCount - langchainRouteCount,
    Math.trunc(nonNegative(metrics.opencodeRouteCount ?? 0)),
  );
  const legacyRouteCount = Math.min(
    routeCount - directRouteCount - langchainRouteCount - opencodeRouteCount,
    Math.trunc(nonNegative(metrics.legacyRouteCount)),
  );
  const javisSpecializedRouteCount = Math.min(
    routeCount - directRouteCount - langchainRouteCount - opencodeRouteCount -
      legacyRouteCount,
    Math.trunc(nonNegative(metrics.javisSpecializedRouteCount ?? 0)),
  );
  const unavailableRouteCount = routeCount - directRouteCount - langchainRouteCount -
    opencodeRouteCount - legacyRouteCount - javisSpecializedRouteCount;
  const modernRouteCount = langchainRouteCount + opencodeRouteCount;
  const runtimeRouteCount = routeCount - directRouteCount - javisSpecializedRouteCount;
  const rolloutTargetCount = Math.min(
    runtimeRouteCount,
    Math.max(
      modernRouteCount,
      Math.trunc(nonNegative(metrics.rolloutTargetCount)),
    ),
  );
  const fallbackCount = rolloutTargetCount - modernRouteCount;
  const reasonCounts = new Map<
    AgentRuntimeRoutingMetricsSnapshot["fallbackReasons"][number]["reason"],
    number
  >();
  for (const entry of metrics.fallbackReasons) {
    reasonCounts.set(
      entry.reason,
      (reasonCounts.get(entry.reason) ?? 0) + Math.trunc(nonNegative(entry.count)),
    );
  }
  let remainingFallbacks = fallbackCount;
  const fallbackReasons = [...reasonCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([reason, count]) => {
      const normalizedCount = Math.min(remainingFallbacks, count);
      remainingFallbacks -= normalizedCount;
      return normalizedCount > 0 ? [{ reason, count: normalizedCount }] : [];
    });
  if (remainingFallbacks > 0) {
    const legacyEntry = fallbackReasons.find((entry) =>
      entry.reason === "legacy_backend_selected"
    );
    if (legacyEntry) {
      legacyEntry.count += remainingFallbacks;
    } else {
      fallbackReasons.push({ reason: "legacy_backend_selected", count: remainingFallbacks });
      fallbackReasons.sort((left, right) => left.reason.localeCompare(right.reason));
    }
  }
  const uniqueObservationIds = [...new Set(metrics.observationIds.map((id) =>
    normalizeObservationId(id)
  ))].slice(0, routeCount);
  let restoredObservationIndex = 0;
  while (uniqueObservationIds.length < routeCount) {
    const candidate = `${normalizeProviderDimension(
      metrics.providerId,
    )}:restored:${restoredObservationIndex}`;
    restoredObservationIndex += 1;
    if (!uniqueObservationIds.includes(candidate)) uniqueObservationIds.push(candidate);
  }
  return {
    providerId: normalizeProviderDimension(metrics.providerId),
    agentKind: metrics.agentKind,
    taskType: normalizeDimension(metrics.taskType, "unknown-task"),
    routeCount,
    rolloutTargetCount,
    ...(directRouteCount > 0 ? { directRouteCount } : {}),
    langchainRouteCount,
    ...(opencodeRouteCount > 0 ? { opencodeRouteCount } : {}),
    legacyRouteCount,
    ...(javisSpecializedRouteCount > 0 ? { javisSpecializedRouteCount } : {}),
    unavailableRouteCount,
    fallbackCount,
    fallbackRate: rolloutTargetCount === 0 ? 0 : fallbackCount / rolloutTargetCount,
    fallbackReasons,
    observationIds: uniqueObservationIds,
  };
}

function routingMetricsKey(input: {
  providerId: string;
  agentKind: string;
  taskType: string;
}): string {
  return `${input.providerId}\u0000${input.agentKind}\u0000${input.taskType}`;
}

function normalizeDimension(value: string, fallback: string): string {
  const normalized = value.trim().slice(0, 160);
  return normalized || fallback;
}

function normalizeProviderDimension(value: string): string {
  return normalizeDimension(value, "unknown-provider").toLowerCase();
}

function normalizeObservationId(value: string): string {
  const normalized = value.trim().slice(0, 320);
  return normalized || "unknown-observation";
}
