import type { WorkbenchWorkflowStep } from "./workflows";

export interface TaskLedger {
  goal: string;
  facts: string[];
  unknowns: string[];
  assumptions: string[];
  constraints: string[];
  acceptanceCriteria: string[];
}

export interface StepSummary {
  stepId: string;
  title?: string;
  agentKind?: string;
  outputContextKey?: string;
}

export interface FailureSummary {
  stepId: string;
  title?: string;
  agentKind?: string;
  toolName?: string;
  inputFingerprint?: string;
  errorSummary: string;
  missingContextKeys?: string[];
}

export interface BlockedSummary {
  reason: string;
  stepId?: string;
  missingContextKeys?: string[];
}

export interface ActionFingerprint {
  kind: "tool" | "replan" | "verifier" | "handoff";
  fingerprint: string;
  count: number;
  lastStepId?: string;
}

export interface ProgressLedger {
  completed: StepSummary[];
  failed: FailureSummary[];
  blocked: BlockedSummary[];
  currentHypothesis?: string;
  repeatedActions: ActionFingerprint[];
  remainingWork: string[];
}

export type StuckSignalKind =
  | "repeated_tool_failure"
  | "repeated_action_without_artifact"
  | "duplicate_replan_shape"
  | "verifier_not_improving"
  | "repeated_missing_context";

export interface StuckSignal {
  kind: StuckSignalKind;
  fingerprint: string;
  count: number;
  severity: "warn" | "blocked";
  hint: string;
  evidence: string[];
}

export interface ToolFailureInput {
  stepId: string;
  toolName: string;
  input: unknown;
  error: string;
  producedArtifact?: boolean;
}

export interface ReplanShapeInput {
  steps: Pick<WorkbenchWorkflowStep, "agentKind" | "inputContextKeys" | "outputContextKey" | "permissionLevel">[];
}

export interface MissingContextFailureInput {
  stepId: string;
  missingContextKeys: readonly string[];
}

export interface VerifierAttemptInput {
  status: string;
  summary?: string;
}

export interface ProgressLedgerBuilderInput {
  goal: string;
  workflowSteps: readonly WorkbenchWorkflowStep[];
  completedStepIds?: readonly string[];
  failed?: readonly FailureSummary[];
  blocked?: readonly BlockedSummary[];
  currentHypothesis?: string;
}

export function buildTaskLedger(input: {
  goal: string;
  facts?: readonly string[];
  unknowns?: readonly string[];
  assumptions?: readonly string[];
  constraints?: readonly string[];
  acceptanceCriteria?: readonly string[];
}): TaskLedger {
  return {
    goal: input.goal,
    facts: compactStrings(input.facts),
    unknowns: compactStrings(input.unknowns),
    assumptions: compactStrings(input.assumptions),
    constraints: compactStrings(input.constraints),
    acceptanceCriteria: compactStrings(input.acceptanceCriteria),
  };
}

export function buildProgressLedger(input: ProgressLedgerBuilderInput): ProgressLedger {
  const completedIds = new Set(input.completedStepIds ?? []);
  const completed = input.workflowSteps
    .filter((step) => completedIds.has(step.id))
    .map(stepSummaryFromWorkflowStep);
  const remainingWork = input.workflowSteps
    .filter((step) => !completedIds.has(step.id))
    .map((step) => step.id);
  const repeatedActions = collectRepeatedActionFingerprints([
    ...(input.failed ?? []).map((failure) => ({
      kind: "tool" as const,
      fingerprint: createToolFailureFingerprint({
        toolName: failure.toolName ?? failure.agentKind ?? failure.stepId,
        input: failure.inputFingerprint ?? "",
      }),
      stepId: failure.stepId,
    })),
    ...(input.blocked ?? []).flatMap((blocked) =>
      (blocked.missingContextKeys ?? []).map((key) => ({
        kind: "handoff" as const,
        fingerprint: `missing-context:${key}`,
        stepId: blocked.stepId,
      })),
    ),
  ]);
  return {
    completed,
    failed: [...(input.failed ?? [])],
    blocked: [...(input.blocked ?? [])],
    ...(input.currentHypothesis ? { currentHypothesis: input.currentHypothesis } : {}),
    repeatedActions,
    remainingWork,
  };
}

export function detectStuckSignals(input: {
  toolFailures?: readonly ToolFailureInput[];
  actionFingerprints?: readonly ActionFingerprint[];
  replanShapes?: readonly ReplanShapeInput[];
  verifierAttempts?: readonly VerifierAttemptInput[];
  missingContextFailures?: readonly MissingContextFailureInput[];
  threshold?: number;
}): StuckSignal[] {
  const threshold = Math.max(2, Math.trunc(input.threshold ?? 2));
  return [
    ...detectRepeatedToolFailures(input.toolFailures ?? [], threshold),
    ...detectRepeatedActions(input.actionFingerprints ?? [], threshold),
    ...detectDuplicateReplanShapes(input.replanShapes ?? [], threshold),
    ...detectVerifierNotImproving(input.verifierAttempts ?? [], threshold),
    ...detectRepeatedMissingContext(input.missingContextFailures ?? [], threshold),
  ];
}

export function createToolFailureFingerprint(input: {
  toolName: string;
  input: unknown;
}): string {
  return `tool:${input.toolName}:${stableFingerprint(input.input)}`;
}

export function createReplanShapeFingerprint(input: ReplanShapeInput): string {
  const shape = input.steps.map((step) => ({
    agentKind: step.agentKind,
    inputContextKeys: [...(step.inputContextKeys ?? [])].sort(),
    outputContextKey: step.outputContextKey ?? "",
    permissionLevel: step.permissionLevel,
  }));
  return `replan:${stableFingerprint(shape)}`;
}

export function extractMissingContextKeys(error: string): string[] {
  const keys = new Set<string>();
  for (const match of error.matchAll(/(?:missing|invalid)(?: input)? context key[s]?\s*[:=]\s*([A-Za-z0-9_.:-]+)/gi)) {
    keys.add(match[1]);
  }
  for (const match of error.matchAll(/input context key\s+([A-Za-z0-9_.:-]+)/gi)) {
    keys.add(match[1]);
  }
  for (const match of error.matchAll(/requestedContextKeys?\s*[:=]\s*\[([^\]]+)\]/gi)) {
    for (const key of match[1].split(",")) {
      const normalized = key.replace(/["'\s]/g, "");
      if (normalized) keys.add(normalized);
    }
  }
  return [...keys];
}

function detectRepeatedToolFailures(
  failures: readonly ToolFailureInput[],
  threshold: number,
): StuckSignal[] {
  const grouped = groupByFingerprint(failures.map((failure) => ({
    fingerprint: createToolFailureFingerprint(failure),
    evidence: `${failure.stepId}: ${compactText(failure.error)}`,
  })));
  return [...grouped.entries()]
    .filter(([, items]) => items.length >= threshold)
    .map(([fingerprint, items]) => ({
      kind: "repeated_tool_failure",
      fingerprint,
      count: items.length,
      severity: "blocked" as const,
      hint: "switch tool or narrow the tool input before retrying",
      evidence: items.map((item) => item.evidence),
    }));
}

function detectRepeatedActions(
  actions: readonly ActionFingerprint[],
  threshold: number,
): StuckSignal[] {
  return actions
    .filter((action) => action.count >= threshold)
    .map((action) => ({
      kind: "repeated_action_without_artifact",
      fingerprint: action.fingerprint,
      count: action.count,
      severity: "warn" as const,
      hint: "switch agent kind or require a new artifact before repeating the action",
      evidence: action.lastStepId ? [`last step: ${action.lastStepId}`] : [],
    }));
}

function detectDuplicateReplanShapes(
  replans: readonly ReplanShapeInput[],
  threshold: number,
): StuckSignal[] {
  const grouped = groupByFingerprint(replans.map((replan, index) => ({
    fingerprint: createReplanShapeFingerprint(replan),
    evidence: `replan ${index + 1}`,
  })));
  return [...grouped.entries()]
    .filter(([, items]) => items.length >= threshold)
    .map(([fingerprint, items]) => ({
      kind: "duplicate_replan_shape",
      fingerprint,
      count: items.length,
      severity: "blocked" as const,
      hint: "change recovery strategy instead of returning the same step shape",
      evidence: items.map((item) => item.evidence),
    }));
}

function detectVerifierNotImproving(
  attempts: readonly VerifierAttemptInput[],
  threshold: number,
): StuckSignal[] {
  const failedAttempts = attempts.filter((attempt) => attempt.status !== "pass");
  if (failedAttempts.length < threshold) {
    return [];
  }
  const summaries = new Set(failedAttempts.map((attempt) => compactText(attempt.summary ?? attempt.status)));
  if (summaries.size > 1) {
    return [];
  }
  return [{
    kind: "verifier_not_improving",
    fingerprint: `verifier:${[...summaries][0] ?? "not-improving"}`,
    count: failedAttempts.length,
    severity: "warn",
    hint: "request user input or narrow the acceptance criteria before another recovery attempt",
    evidence: failedAttempts.map((attempt, index) => `${index + 1}: ${compactText(attempt.summary ?? attempt.status)}`),
  }];
}

function detectRepeatedMissingContext(
  failures: readonly MissingContextFailureInput[],
  threshold: number,
): StuckSignal[] {
  const records = failures.flatMap((failure) =>
    failure.missingContextKeys.map((key) => ({
      fingerprint: `missing-context:${key}`,
      evidence: `${failure.stepId}: ${key}`,
    })),
  );
  const grouped = groupByFingerprint(records);
  return [...grouped.entries()]
    .filter(([, items]) => items.length >= threshold)
    .map(([fingerprint, items]) => ({
      kind: "repeated_missing_context",
      fingerprint,
      count: items.length,
      severity: "blocked" as const,
      hint: "produce the missing upstream artifact or request user input",
      evidence: items.map((item) => item.evidence),
    }));
}

function collectRepeatedActionFingerprints(
  records: readonly { kind: ActionFingerprint["kind"]; fingerprint: string; stepId?: string }[],
): ActionFingerprint[] {
  const counts = new Map<string, ActionFingerprint>();
  for (const record of records) {
    const key = `${record.kind}:${record.fingerprint}`;
    const current = counts.get(key);
    if (current) {
      current.count += 1;
      current.lastStepId = record.stepId ?? current.lastStepId;
    } else {
      counts.set(key, {
        kind: record.kind,
        fingerprint: record.fingerprint,
        count: 1,
        ...(record.stepId ? { lastStepId: record.stepId } : {}),
      });
    }
  }
  return [...counts.values()].filter((record) => record.count > 1);
}

function stepSummaryFromWorkflowStep(step: WorkbenchWorkflowStep): StepSummary {
  return {
    stepId: step.id,
    title: step.title,
    agentKind: step.agentKind,
    ...(step.outputContextKey ? { outputContextKey: step.outputContextKey } : {}),
  };
}

function groupByFingerprint<T extends { fingerprint: string }>(items: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    grouped.set(item.fingerprint, [...(grouped.get(item.fingerprint) ?? []), item]);
  }
  return grouped;
}

function compactStrings(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map(compactText).filter(Boolean))];
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stableFingerprint(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}
