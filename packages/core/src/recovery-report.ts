import type { WorkbenchWorkflowStep } from "./workflows";
import {
  buildProgressLedger,
  detectStuckSignals,
  extractMissingContextKeys,
  type MissingContextFailureInput,
  type ProgressLedger,
  type ReplanShapeInput,
  type StuckSignal,
  type ToolFailureInput,
  type VerifierAttemptInput,
} from "./progress-ledger";

export type RecoveryFailureKind =
  | "timeout"
  | "permission_denied"
  | "handoff"
  | "unavailable"
  | "network"
  | "validation"
  | "unknown";

export type RecoveryReplanStatus = "not_attempted" | "planned" | "failed";

export interface RecoveryAttemptRecord {
  failedStepId: string;
  failedStepTitle?: string;
  agentKind?: string;
  errorSummary: string;
  failureKind: RecoveryFailureKind;
  completedBefore: string[];
  replanAttempted: boolean;
  replanStatus: RecoveryReplanStatus;
  abandonedFailedStep: boolean;
  recoveryStepIds: string[];
  suggestedAlternatives: string[];
  detail?: string;
}

export interface RecoveryReport {
  generatedAt: string;
  status: "not_needed" | "recovered" | "needs_attention";
  failureCount: number;
  recoveredCount: number;
  unrecoveredCount: number;
  abandonedStepIds: string[];
  replannedStepIds: string[];
  progressLedger?: ProgressLedger;
  stuckSignals: StuckSignal[];
  commanderGuidance: string[];
  attempts: RecoveryAttemptRecord[];
}

export function createRecoveryAttempt(input: {
  step: Pick<WorkbenchWorkflowStep, "id" | "title" | "agentKind">;
  error: string;
  completedStepIds?: readonly string[];
  replanAttempted?: boolean;
  replanStatus?: RecoveryReplanStatus;
  abandonedFailedStep?: boolean;
  recoveryStepIds?: readonly string[];
  detail?: string;
}): RecoveryAttemptRecord {
  const failureKind = classifyRecoveryFailure(input.error);
  return {
    failedStepId: input.step.id,
    failedStepTitle: input.step.title,
    agentKind: input.step.agentKind,
    errorSummary: summarizeRecoveryError(input.error),
    failureKind,
    completedBefore: [...(input.completedStepIds ?? [])],
    replanAttempted: input.replanAttempted ?? false,
    replanStatus: input.replanStatus ?? "not_attempted",
    abandonedFailedStep: input.abandonedFailedStep ?? false,
    recoveryStepIds: [...(input.recoveryStepIds ?? [])],
    suggestedAlternatives: suggestedRecoveryAlternatives(failureKind),
    ...(input.detail ? { detail: summarizeRecoveryError(input.detail, 240) } : {}),
  };
}

export function buildRecoveryReport(
  attempts: readonly RecoveryAttemptRecord[],
  options: {
    generatedAt?: string;
    abandonedStepIds?: readonly string[];
    replannedStepIds?: readonly string[];
    workflowSteps?: readonly WorkbenchWorkflowStep[];
    completedStepIds?: readonly string[];
    replanShapes?: readonly ReplanShapeInput[];
    verifierAttempts?: readonly VerifierAttemptInput[];
    stuckThreshold?: number;
  } = {},
): RecoveryReport {
  const recoveredCount = attempts.filter((attempt) =>
    attempt.replanStatus === "planned" &&
    attempt.abandonedFailedStep &&
    attempt.recoveryStepIds.length > 0
  ).length;
  const unrecoveredCount = attempts.length - recoveredCount;
  const stuckSignals = buildRecoveryStuckSignals(attempts, {
    replanShapes: options.replanShapes,
    verifierAttempts: options.verifierAttempts,
    threshold: options.stuckThreshold,
  });
  const progressLedger = options.workflowSteps
    ? buildProgressLedger({
        goal: "",
        workflowSteps: options.workflowSteps,
        completedStepIds: options.completedStepIds,
        failed: attempts.map((attempt) => ({
          stepId: attempt.failedStepId,
          title: attempt.failedStepTitle,
          agentKind: attempt.agentKind,
          errorSummary: attempt.errorSummary,
          missingContextKeys: attempt.failureKind === "handoff"
            ? extractMissingContextKeys(attempt.errorSummary)
            : undefined,
        })),
        blocked: attempts
          .filter((attempt) => attempt.failureKind === "handoff" || attempt.replanStatus === "failed")
          .map((attempt) => ({
            reason: attempt.errorSummary,
            stepId: attempt.failedStepId,
            missingContextKeys: extractMissingContextKeys(attempt.errorSummary),
          })),
      })
    : undefined;
  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    status: attempts.length === 0
      ? "not_needed"
      : unrecoveredCount === 0
        ? "recovered"
        : "needs_attention",
    failureCount: attempts.length,
    recoveredCount,
    unrecoveredCount,
    abandonedStepIds: [...(options.abandonedStepIds ?? [])],
    replannedStepIds: [...(options.replannedStepIds ?? [])],
    ...(progressLedger ? { progressLedger } : {}),
    stuckSignals,
    commanderGuidance: buildCommanderGuidance(stuckSignals),
    attempts: attempts.map((attempt) => ({ ...attempt })),
  };
}

export function classifyRecoveryFailure(error: string): RecoveryFailureKind {
  const normalized = error.toLowerCase();
  if (/timeout|timed out|deadline/.test(normalized)) return "timeout";
  if (/denied|permission|approval|forbidden|unauthorized|not allowed/.test(normalized)) return "permission_denied";
  if (/request_input|requestedcontextkeys|handoff|input context key|missing upstream artifact|missing context key|invalid context key/.test(normalized)) return "handoff";
  if (/invalid|schema|parse|validation|malformed|bad request/.test(normalized)) return "validation";
  if (/unavailable|not available|not found|missing|enoent|disabled/.test(normalized)) return "unavailable";
  if (/network|fetch|http|socket|dns|econn|connection/.test(normalized)) return "network";
  return "unknown";
}

function summarizeRecoveryError(error: string, maxLength = 180): string {
  const compact = error
    .replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=_-]+/g, "[redacted:image data URL]")
    .replace(/\s+/g, " ")
    .trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength)}...`;
}

function suggestedRecoveryAlternatives(kind: RecoveryFailureKind): string[] {
  switch (kind) {
    case "timeout":
      return [
        "retry with a narrower request",
        "split the step into smaller read-only checks",
      ];
    case "permission_denied":
      return [
        "ask for explicit user confirmation",
        "fall back to a read-only preview",
      ];
    case "handoff":
      return [
        "produce the missing upstream artifact before replanning",
        "request user input for the missing context keys",
      ];
    case "unavailable":
      return [
        "try another available tool with the same capability",
        "collect partial evidence and mark confirmation gaps",
      ];
    case "network":
      return [
        "retry with a fallback provider",
        "use cached or user-provided sources when available",
      ];
    case "validation":
      return [
        "repair the structured input and retry",
        "ask a clarifying question if required fields are missing",
      ];
    case "unknown":
      return [
        "inspect the failed observation",
        "try a simpler alternate path before reporting failure",
      ];
  }
}

function buildRecoveryStuckSignals(
  attempts: readonly RecoveryAttemptRecord[],
  options: {
    replanShapes?: readonly ReplanShapeInput[];
    verifierAttempts?: readonly VerifierAttemptInput[];
    threshold?: number;
  },
): StuckSignal[] {
  const toolFailures: ToolFailureInput[] = attempts.map((attempt) => ({
    stepId: attempt.failedStepId,
    toolName: attempt.agentKind ?? attempt.failedStepId,
    input: attempt.errorSummary,
    error: attempt.errorSummary,
  }));
  const missingContextFailures: MissingContextFailureInput[] = attempts
    .map((attempt) => ({
      stepId: attempt.failedStepId,
      missingContextKeys: extractMissingContextKeys(attempt.errorSummary),
    }))
    .filter((failure) => failure.missingContextKeys.length > 0);
  return detectStuckSignals({
    toolFailures,
    missingContextFailures,
    replanShapes: options.replanShapes,
    verifierAttempts: options.verifierAttempts,
    threshold: options.threshold,
  });
}

function buildCommanderGuidance(signals: readonly StuckSignal[]): string[] {
  const guidance = new Set<string>();
  for (const signal of signals) {
    guidance.add(signal.hint);
    switch (signal.kind) {
      case "repeated_tool_failure":
        guidance.add("switch tool or switch agent kind before retrying");
        break;
      case "duplicate_replan_shape":
        guidance.add("return a materially different recovery plan");
        break;
      case "repeated_missing_context":
        guidance.add("produce the missing context key or ask the user for it");
        break;
      case "verifier_not_improving":
        guidance.add("narrow the goal or stop with a clear blocked reason");
        break;
      case "repeated_action_without_artifact":
        guidance.add("require a new artifact before repeating the action");
        break;
    }
  }
  return [...guidance];
}
