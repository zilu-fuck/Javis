import type {
  BrowserClickResult,
  BrowserEvaluateResult,
  BrowserRunTestResult,
  BrowserTypeResult,
} from "@javis/tools";
import type { ToolCallAuditRecord } from "./tool-call-audit";

export interface BrowserWritePlanResult {
  approvalId: string;
  toolName: string;
  sessionId: string;
  action: BrowserWriteAction;
  previewHash: string;
  binding: {
    taskId: string;
  };
}

export type BrowserWriteAction = "click" | "type" | "evaluate" | "runTest";

export type BrowserWriteExecutionResult =
  | BrowserClickResult
  | BrowserTypeResult
  | BrowserEvaluateResult
  | BrowserRunTestResult;

export function createBrowserWritePlanAuditRecord(
  plan: BrowserWritePlanResult,
  recordedAt = new Date().toISOString(),
): ToolCallAuditRecord {
  return {
    id: createBrowserWriteAuditId(plan, "plan"),
    taskId: auditTaskId(plan),
    toolName: plan.toolName,
    permissionLevel: "confirmed_write",
    status: "waiting_permission",
    inputSummary: `Prepare ${plan.toolName} for browser session ${plan.sessionId}`,
    dryRunJson: JSON.stringify({
      action: plan.action,
      sessionId: plan.sessionId,
      previewHash: plan.previewHash,
    }),
    permissionRequestId: plan.approvalId,
    startedAt: recordedAt,
  };
}

export function createBrowserWriteExecutionAuditRecord(
  plan: BrowserWritePlanResult,
  result: BrowserWriteExecutionResult,
  startedAt: string,
  endedAt = new Date().toISOString(),
): ToolCallAuditRecord {
  return {
    id: createBrowserWriteAuditId(plan, "execute"),
    taskId: auditTaskId(plan),
    toolName: plan.toolName,
    permissionLevel: "confirmed_write",
    status: "succeeded",
    inputSummary: `Execute approved ${plan.toolName} for browser session ${plan.sessionId}`,
    outputSummary: browserWriteOutputSummary(plan.action, result),
    permissionRequestId: plan.approvalId,
    startedAt,
    endedAt,
  };
}

export function createBrowserWriteFailedAuditRecord(
  plan: BrowserWritePlanResult,
  error: unknown,
  startedAt: string,
  endedAt = new Date().toISOString(),
): ToolCallAuditRecord {
  return {
    id: createBrowserWriteAuditId(plan, "execute"),
    taskId: auditTaskId(plan),
    toolName: plan.toolName,
    permissionLevel: "confirmed_write",
    status: "failed",
    inputSummary: `Execute approved ${plan.toolName} ${plan.approvalId}`,
    permissionRequestId: plan.approvalId,
    startedAt,
    endedAt,
    errorJson: JSON.stringify({ message: errorMessage(error) }),
  };
}

function browserWriteOutputSummary(
  action: BrowserWriteAction,
  result: BrowserWriteExecutionResult,
): string {
  if (action === "click" && "clicked" in result) {
    return `Clicked ${result.selector}; new URL ${result.newUrl ?? "(unchanged)"}`;
  }
  if (action === "type" && "typed" in result) {
    return `Typed into ${result.selector}; value length ${result.value.length}`;
  }
  if (action === "evaluate" && "type" in result) {
    return `Evaluated expression; result type ${result.type}`;
  }
  if (action === "runTest" && "passed" in result) {
    return `Browser test ${result.passed ? "passed" : "failed"} with exit code ${result.exitCode}`;
  }
  return `Executed browser write action ${action}`;
}

function createBrowserWriteAuditId(
  plan: BrowserWritePlanResult,
  phase: "plan" | "execute",
): string {
  return `${auditTaskId(plan)}:${plan.toolName}:${plan.approvalId}:${phase}`;
}

function auditTaskId(plan: BrowserWritePlanResult): string {
  return plan.binding.taskId || plan.sessionId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
