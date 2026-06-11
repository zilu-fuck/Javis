import type { WorkbenchWorkflowStep } from "./workflows";

export type RecoveryFailureKind =
  | "timeout"
  | "permission_denied"
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
  } = {},
): RecoveryReport {
  const recoveredCount = attempts.filter((attempt) =>
    attempt.replanStatus === "planned" &&
    attempt.abandonedFailedStep &&
    attempt.recoveryStepIds.length > 0
  ).length;
  const unrecoveredCount = attempts.length - recoveredCount;
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
    attempts: attempts.map((attempt) => ({ ...attempt })),
  };
}

export function classifyRecoveryFailure(error: string): RecoveryFailureKind {
  const normalized = error.toLowerCase();
  if (/timeout|timed out|deadline/.test(normalized)) return "timeout";
  if (/denied|permission|approval|forbidden|unauthorized|not allowed/.test(normalized)) return "permission_denied";
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
