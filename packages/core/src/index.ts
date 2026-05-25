import type {
  CodeReviewPreview,
  CodeProposedEdit,
  CodeApplyResult,
  CodeTool,
  ComputerTool,
  CommanderTool,
  FileOrganizationExecution,
  FileOrganizationPlan,
  FileTool,
  MarkdownDocumentSummary,
  ModelUsage,
  PermissionRequest as ToolPermissionRequest,
  ProjectInspection,
  ProjectTool,
  ResearchReport,
  ShellCommandOutput,
  ShellTool,
  SchedulerTool,
  VerifierTool,
  WebSource,
  WebTool,
  TokenUsageSummary,
} from "@javis/tools";
import {
  createCodeApplyDryRun,
  validateCodeApplyResult,
  validateCodeProposal,
} from "./code-proposal-safety";
import type { PendingPermissionHandler } from "./confirmed-write";
import {
  demoAgents,
} from "./agents";
import { createAgentStateTracker, type AgentStateTracker } from "./agent-state-tracker";
import { runFileScanTask } from "./file-scan-flow";
import { runPdfOrganizationPreviewTask } from "./pdf-organization-flow";
import { runProjectInspectionTask } from "./project-inspection-flow";
import {
  isReadCurrentProjectGoal,
  runGenericWorkbenchWorkflow,
  runReadCurrentProjectWorkflow,
} from "./workflow-executor";
import {
  createCodeReviewPlan,
  createResearchSearchPlan,
  createResearchSourcePlan,
  markStep,
} from "./plans";
import type { WorkbenchWorkflowId } from "./workflows";
import {
  createPendingPermissionRequest,
  resolvePermissionRequest,
} from "./permission-state";
import { createSourceBackedReport } from "./research";
import {
  extractUrls,
  isCodeReviewGoal,
  isPdfOrganizationGoal,
  isProjectInspectionGoal,
  isResearchGoal,
  getRecommendedWorkflowIds,
} from "./routing";
import { createRuntimeState } from "./runtime-state";
import { appendLog } from "./snapshot-utils";
import { addModelUsage, createEmptyTokenUsageSummary } from "./token-usage";

export {
  createCodeApplyDryRun,
  parsePatchHunks,
  validateCodeApplyResult,
  validateCodeProposal,
} from "./code-proposal-safety";
export { createDryRunBindingHash } from "./permission-state";
export {
  DOCUMENTED_TASK_TRANSITIONS,
  TASK_STATUSES,
  isTerminalTaskStatus,
  transitionTask,
} from "./state/task-state";
export { demoAgents, getAgentSystemPrompt } from "./agents";
export {
  WORKBENCH_WORKFLOWS,
  getWorkbenchWorkflow,
  listWorkbenchWorkflows,
} from "./workflows";
export {
  createTaskEventBus,
  taskEventToLogEntry,
} from "./task-event-bus";
export { createSharedTaskContext, CONTEXT_KEYS, contextKeyForLocale } from "./shared-context";
export type { ContextKey, SharedTaskContext } from "./shared-context";
export { localizeError, localizeOpenCodeError } from "./error-localizer";
export { executeWorkflow } from "./workflow-dag-executor";
export type {
  WorkflowExecutionResult,
  WorkflowExecutorOptions,
  WorkflowStepExecutionResult,
} from "./workflow-dag-executor";
export { createAgentStateTracker } from "./agent-state-tracker";
export type {
  AgentState,
  AgentStateTracker,
} from "./agent-state-tracker";
export type {
  TaskEventBus,
  TaskEventHandler,
  TaskEventMiddleware,
  TaskRuntimeEvent,
} from "./task-event-bus";
export type {
  WorkbenchWorkflow,
  WorkbenchWorkflowId,
  WorkbenchWorkflowStep,
} from "./workflows";

export type ID = string;
export type ISODateTime = string;

export type TaskStatus =
  | "created"
  | "planning"
  | "running"
  | "waiting_permission"
  | "verifying"
  | "retrying"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentKind =
  | "commander"
  | "file"
  | "shell"
  | "browser"
  | "computer"
  | "scheduler"
  | "research"
  | "code"
  | "verifier";

export type AgentRunStatus =
  | "queued"
  | "planning"
  | "running"
  | "waiting_permission"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";

export type PermissionLevel = "read" | "preview" | "confirmed_write" | "dangerous";
export type VerificationStatus = "verified" | "unverified" | "failed";

export interface Task {
  id: ID;
  title: string;
  userGoal: string;
  status: TaskStatus;
  workspacePath?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  plan?: TaskStep[];
  agentRuns: AgentRun[];
  pendingPermissionRequestId?: ID;
  verification?: VerificationResult;
  tokenUsage?: TokenUsageSummary;
  finalMessage?: string;
}

export interface TaskStep {
  id: ID;
  title: string;
  assignedAgentKind: AgentKind;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  successCriteria?: string;
}

export interface Agent {
  id: ID;
  kind: AgentKind;
  displayName: string;
  description: string;
  allowedToolNames: string[];
  preferredModelTags?: string[];
  systemPrompt: AgentPromptSet;
}

export interface AgentPromptSet {
  en: string;
  zhCN: string;
}

export interface AgentRun {
  id: ID;
  taskId: ID;
  agentId: ID;
  agentKind: AgentKind;
  status: AgentRunStatus;
  modelProfileId?: ID;
  inputSummary: string;
  outputSummary?: string;
  tokenUsage?: TokenUsageSummary;
  toolCallIds: ID[];
  error?: TaskError;
  startedAt?: ISODateTime;
  endedAt?: ISODateTime;
}

export interface ModelProfile {
  id: ID;
  provider: string;
  model: string;
  displayName: string;
  tags: string[];
  capabilities: {
    text: boolean;
    vision: boolean;
    code: boolean;
    longContext: boolean;
    local: boolean;
    toolCalling: boolean;
  };
  limits?: {
    contextTokens?: number;
    outputTokens?: number;
  };
}

export interface ToolCall {
  id: ID;
  taskId: ID;
  agentRunId: ID;
  toolName: string;
  permissionLevel: PermissionLevel;
  status:
    | "planned"
    | "waiting_permission"
    | "running"
    | "succeeded"
    | "failed"
    | "denied"
    | "cancelled";
  inputSummary: string;
  outputSummary?: string;
  dryRun?: DryRunSummary;
  permissionRequestId?: ID;
  startedAt?: ISODateTime;
  endedAt?: ISODateTime;
  error?: TaskError;
}

export interface DryRunSummary {
  operation: string;
  affectedPaths?: Array<{
    source?: string;
    target?: string;
    action: "create" | "modify" | "move" | "copy" | "delete" | "overwrite";
    conflict?: string;
  }>;
  command?: {
    cwd: string;
    text: string;
    expectedWrites?: string[];
  };
  riskSummary: string;
  reversible: boolean;
}

export interface PermissionRequest {
  id: ID;
  taskId: ID;
  agentRunId: ID;
  toolCallId: ID;
  level: Exclude<PermissionLevel, "read">;
  title: string;
  reason: string;
  dryRun: DryRunSummary;
  status: "pending" | "approved" | "denied" | "expired" | "cancelled";
  createdAt: ISODateTime;
  resolvedAt?: ISODateTime;
}

export interface VerificationResult {
  id: ID;
  taskId: ID;
  status: VerificationStatus;
  checkedAt: ISODateTime;
  summary: string;
  evidence: Array<{
    kind: "file" | "command" | "source" | "log" | "permission" | "manual";
    label: string;
    reference?: string;
    result: "pass" | "warn" | "fail";
  }>;
  retryRecommendation?: {
    shouldRetry: boolean;
    reason: string;
    suggestedAgentKind?: AgentKind;
  };
}

export type TaskEvent =
  | { type: "task.created"; task: Task }
  | { type: "task.status_changed"; taskId: ID; status: TaskStatus }
  | { type: "task.plan_updated"; taskId: ID; plan: TaskStep[] }
  | { type: "agent_run.started"; taskId: ID; agentRun: AgentRun }
  | { type: "agent_run.updated"; taskId: ID; agentRun: AgentRun }
  | { type: "tool_call.planned"; taskId: ID; toolCall: ToolCall }
  | { type: "tool_call.updated"; taskId: ID; toolCall: ToolCall }
  | { type: "permission.requested"; taskId: ID; request: PermissionRequest }
  | { type: "permission.resolved"; taskId: ID; request: PermissionRequest }
  | { type: "verification.completed"; taskId: ID; result: VerificationResult }
  | { type: "task.message"; taskId: ID; role: "system" | "agent" | "user"; content: string }
  | { type: "task.failed"; taskId: ID; error: TaskError }
  | { type: "task.completed"; taskId: ID; finalMessage: string };

export interface TaskError {
  code: string;
  message: string;
  recoverable: boolean;
  detail?: unknown;
}

export interface AgentSnapshot {
  id: ID;
  name: string;
  role: string;
  status: AgentRunStatus;
  task: string;
  tokenUsage?: TokenUsageSummary;
}

export interface TaskLogEntry {
  id: ID;
  kind: "plan" | "tool" | "permission" | "verification" | "event";
  title: string;
  detail: string;
}

export interface TaskSnapshot {
  id: ID;
  title: string;
  userGoal: string;
  status: TaskStatus;
  updatedAt?: ISODateTime;
  commanderMessage: string;
  plan: TaskStep[];
  agents: AgentSnapshot[];
  logs: TaskLogEntry[];
  documents?: MarkdownDocumentSummary[];
  commands?: ShellCommandOutput[];
  fileOrganizationExecution?: FileOrganizationExecution;
  fileOrganizationPlan?: FileOrganizationPlan;
  codeReviewPreview?: CodeReviewPreview;
  codeProposedEdit?: CodeProposedEdit;
  codeApplyResult?: CodeApplyResult;
  permissionRequest?: ToolPermissionRequest;
  project?: ProjectInspection;
  researchReport?: ResearchReport;
  sources?: WebSource[];
  tokenUsage?: TokenUsageSummary;
  verificationSummary?: string;
}

export type { ModelUsage, TokenUsageSummary };
export { addModelUsage, createEmptyTokenUsageSummary };

function createScopedAgentTracker(agentKinds: AgentKind[]): AgentStateTracker {
  return createAgentStateTracker(
    demoAgents.filter((agent) => agentKinds.includes(agent.kind)),
  );
}

function setTrackedAgentStates(
  agentTracker: AgentStateTracker,
  states: Array<{ agentId: ID; status: AgentRunStatus; task: string }>,
): AgentSnapshot[] {
  for (const state of states) {
    agentTracker.setState(state.agentId, {
      status: state.status,
      task: state.task,
    });
  }
  return agentTracker.getSnapshots();
}

export interface TaskRuntime {
  getSnapshot(): TaskSnapshot;
  subscribe(listener: (snapshot: TaskSnapshot) => void): () => void;
  start(userGoal: string): void;
  resolvePermission(decision: "approved" | "denied", requestId?: string): void;
  dispose(): void;
}

export interface FileScanRuntimeOptions {
  fileTool: FileTool;
  commanderTool?: CommanderTool;
  computerTool?: ComputerTool;
  codeTool?: CodeTool;
  projectTool?: ProjectTool;
  shellTool?: ShellTool;
  schedulerTool?: SchedulerTool;
  verifierTool?: VerifierTool;
  webTool?: WebTool;
  delayMs?: number;
}

export function createInitialTaskSnapshot(): TaskSnapshot {
  return {
    id: "task-idle",
    title: "Ready",
    userGoal: "Waiting for a task",
    status: "created",
    commanderMessage:
      "Javis desktop is ready. Enter a goal to start the Core event stream.",
    plan: [],
    agents: demoAgents.map((agent) => ({
      id: agent.id,
      name: agent.displayName,
      role: agent.description,
      status: "queued",
      task: "Waiting",
    })),
    logs: [
      {
        id: "log-ready",
        kind: "event",
        title: "Runtime ready",
        detail: "Core runtime is ready for startTask.",
      },
    ],
    tokenUsage: createEmptyTokenUsageSummary(),
  };
}

export function createFileScanTaskRuntime({
  fileTool,
  commanderTool,
  computerTool,
  codeTool,
  projectTool,
  shellTool,
  schedulerTool,
  verifierTool,
  webTool,
  delayMs = 250,
}: FileScanRuntimeOptions): TaskRuntime {
  const runtimeState = createRuntimeState(createInitialTaskSnapshot(), delayMs);
  const permissionHandlers = new Map<string, PendingPermissionHandler>();
  const queuedPermissionDecisions = new Map<string, "approved" | "denied">();
  let queuedLegacyPermissionDecision: "approved" | "denied" | undefined;
  let snapshot = runtimeState.getSnapshot();
  function emit(nextSnapshot: TaskSnapshot) {
    runtimeState.emit(nextSnapshot);
    snapshot = runtimeState.getSnapshot();
  }
  function setPendingPermissionHandler(
    requestId: string,
    handler: PendingPermissionHandler | undefined,
  ) {
    if (handler) {
      const queuedDecision = queuedPermissionDecisions.get(requestId) ?? queuedLegacyPermissionDecision;
      if (queuedDecision) {
        queuedPermissionDecisions.delete(requestId);
        queuedLegacyPermissionDecision = undefined;
        void handler(queuedDecision);
        return;
      }
      permissionHandlers.set(requestId, handler);
      return;
    }
    permissionHandlers.delete(requestId);
  }
  const wait = runtimeState.wait;

  return {
    getSnapshot: () => runtimeState.getSnapshot(),
    subscribe(listener) {
      return runtimeState.subscribe(listener);
    },
    start(userGoal) {
      runtimeState.clearTimers();
      permissionHandlers.clear();
      queuedPermissionDecisions.clear();
      queuedLegacyPermissionDecision = undefined;
      const taskId = `task-${Date.now()}`;
      if (webTool && extractUrls(userGoal).length > 0) {
        void runResearchSourceTask(taskId, userGoal, webTool);
        return;
      }
      const recommendedWorkflowIds = getRecommendedWorkflowIds(userGoal);
      const [recommendedWorkflowId] = recommendedWorkflowIds;
      if (shellTool && projectTool && isReadCurrentProjectGoal(userGoal)) {
        void runReadCurrentProjectWorkflow({
          controller: {
            emit,
            getSnapshot: runtimeState.getSnapshot,
            wait,
          },
          fileTool,
          commanderTool,
          projectTool,
          shellTool,
          codeTool,
          verifierTool,
          taskId,
          userGoal,
        });
        return;
      }
      if (webTool?.searchWeb && isResearchGoal(userGoal)) {
        void runResearchSearchTask(taskId, userGoal, webTool);
        return;
      }
      if (recommendedWorkflowId && recommendedWorkflowId !== "read-current-project") {
        const executableWorkflowIds = recommendedWorkflowIds.filter(
          (workflowId): workflowId is Exclude<WorkbenchWorkflowId, "read-current-project"> =>
            workflowId !== "read-current-project",
        );
        void runGenericWorkbenchWorkflow({
          controller: {
            emit,
            getSnapshot: runtimeState.getSnapshot,
            wait,
          },
          commanderTool,
          codeTool,
          computerTool,
          schedulerTool,
          webTool,
          verifierTool,
          taskId,
          userGoal,
          workflowId:
            executableWorkflowIds.length === 1 ? executableWorkflowIds[0] : executableWorkflowIds,
        });
        return;
      }
      if (shellTool && projectTool && isProjectInspectionGoal(userGoal)) {
        void runProjectInspectionTask(
          {
            emit,
            getSnapshot: runtimeState.getSnapshot,
            wait,
          },
          taskId,
          userGoal,
          shellTool,
          projectTool,
        );
        return;
      }
      if (codeTool && shellTool && isCodeReviewGoal(userGoal)) {
        void runCodeReviewTask(taskId, userGoal, codeTool, shellTool);
        return;
      }
      if (fileTool.planPdfOrganization && isPdfOrganizationGoal(userGoal)) {
        void runPdfOrganizationPreviewTask({
          controller: {
            emit,
            getSnapshot: runtimeState.getSnapshot,
            wait,
          },
          fileTool,
          taskId,
          userGoal,
          setPendingPermissionHandler,
        });
        return;
      }
      void runFileScanTask(
        {
          emit,
          getSnapshot: runtimeState.getSnapshot,
          wait,
        },
        fileTool,
        taskId,
        userGoal,
      );
    },
    resolvePermission(decision, requestId) {
      if (requestId) {
        const handler = permissionHandlers.get(requestId);
        permissionHandlers.delete(requestId);
        if (handler) {
          void handler(decision);
        } else {
          queuedPermissionDecisions.set(requestId, decision);
        }
        return;
      }
      if (permissionHandlers.size < 1) {
        queuedLegacyPermissionDecision = decision;
        return;
      }
      const [onlyRequestId, handler] = [...permissionHandlers.entries()][
        permissionHandlers.size - 1
      ];
      permissionHandlers.delete(onlyRequestId);
      void handler(decision);
    },
    dispose() {
      runtimeState.dispose();
    },
  };

  async function runCodeReviewTask(taskId: ID, userGoal: string, activeCodeTool: CodeTool, activeShellTool: ShellTool) {
    const plan = createCodeReviewPlan();
    const agentTracker = createScopedAgentTracker(["commander", "code", "verifier"]);

    emit({
      id: taskId,
      title: "Reviewing code changes",
      userGoal,
      status: "planning",
      commanderMessage:
        "Commander identified a code review goal and will collect a diff preview before read-only verification and any optional edit proposal.",
      plan,
      agents: setTrackedAgentStates(agentTracker, [
        { agentId: "agent-commander", status: "planning", task: "Create code review plan" },
        { agentId: "agent-code", status: "queued", task: "Waiting for repository diff preview" },
        { agentId: "agent-verifier", status: "queued", task: "Waiting for diff evidence" },
      ]),
      tokenUsage: createEmptyTokenUsageSummary(),
      logs: [
        {
          id: `${taskId}-created`,
          kind: "event",
          title: "task.created",
          detail: "Desktop UI passed the code review goal to Core.",
        },
      ],
    });

    await wait();

    emit({
      ...snapshot,
      status: "running",
      commanderMessage: "Code Agent is gathering changed files and a diff preview from the current workspace.",
      plan: markStep(snapshot.plan, "step-inspect-code", "running"),
      agents: setTrackedAgentStates(agentTracker, [
        { agentId: "agent-commander", status: "completed", task: "Plan submitted" },
        { agentId: "agent-code", status: "running", task: "Collecting repository diff preview" },
        { agentId: "agent-verifier", status: "queued", task: "Waiting for diff evidence" },
      ]),
      logs: appendLog(snapshot, {
        id: `${taskId}-preview-started`,
        kind: "tool",
        title: "tool_call.planned",
        detail: "code.inspectRepository and read-only git checks collect the current diff preview.",
      }),
    });

    try {
      const codeReviewPreview = await activeCodeTool.inspectRepository();
      const changedFileCount = codeReviewPreview.changedFiles.length;
      if (changedFileCount === 0 && !codeReviewPreview.diff.trim()) {
        emit({
          ...snapshot,
          title: "No code changes found",
          status: "completed",
          commanderMessage:
            "Code Agent did not find local code changes, so no review or verification step was needed.",
          plan: snapshot.plan.map((step) => ({
            ...step,
              status: step.id === "step-inspect-code" ? "completed" : "skipped",
          })),
          agents: setTrackedAgentStates(agentTracker, [
            { agentId: "agent-commander", status: "completed", task: "Task finished" },
            { agentId: "agent-code", status: "completed", task: "No local diff" },
            { agentId: "agent-verifier", status: "completed", task: "Verified no-op result" },
          ]),
          codeReviewPreview,
          logs: appendLog(snapshot, {
            id: `${taskId}-no-diff`,
            kind: "verification",
            title: "task.completed",
            detail: "Repository diff preview was empty, so no confirmation was needed.",
          }),
          verificationSummary: "verified: no local code changes were found.",
        });
        return;
      }

      const permissionRequest: ToolPermissionRequest = createPendingPermissionRequest({
        id: `${taskId}-permission`,
        level: "preview",
        title: "Approve code review continuation",
        reason: "Review the current diff preview before running a read-only verification check.",
        dryRun: {
          operation: "Run git diff --check after diff review",
          affectedPaths: codeReviewPreview.changedFiles.map((file) => ({
            source: file,
            target: file,
            action: "modify",
          })),
          riskSummary: "Read-only review of changed files before verification.",
          reversible: true,
        },
      });

      emit({
        ...snapshot,
        title: "Code review preview ready",
        status: "waiting_permission",
        commanderMessage:
          "Diff preview is ready. Review the changed files before approving the read-only verification check.",
        plan: markStep(snapshot.plan, "step-inspect-code", "completed", "step-review-code", "running"),
        agents: setTrackedAgentStates(agentTracker, [
          { agentId: "agent-commander", status: "waiting_permission", task: "Waiting for code review approval" },
          { agentId: "agent-code", status: "completed", task: "Repository diff preview collected" },
          { agentId: "agent-verifier", status: "queued", task: "Waiting for approval" },
        ]),
        codeReviewPreview,
        permissionRequest,
        logs: appendLog(snapshot, {
          id: `${taskId}-permission-requested`,
          kind: "permission",
          title: "permission.requested",
          detail: `${changedFileCount} changed file(s) require review before verification continues.`,
        }),
      });

      setPendingPermissionHandler(permissionRequest.id, async (decision) => {
        const resolvedRequest: ToolPermissionRequest = resolvePermissionRequest(
          permissionRequest,
          decision,
        );
        setPendingPermissionHandler(permissionRequest.id, undefined);

        if (decision === "denied") {
          emit({
            ...snapshot,
            title: "Code review denied",
            status: "completed",
            commanderMessage:
              "Permission was denied. Javis kept the diff preview read-only and did not run verification.",
            plan: snapshot.plan.map((step) => ({
              ...step,
            status:
              step.id === "step-verify-code" ||
              step.id === "step-propose-code-edit" ||
              step.id === "step-apply-code-edit"
                ? "skipped"
                : "completed",
            })),
            agents: setTrackedAgentStates(agentTracker, [
              { agentId: "agent-commander", status: "completed", task: "Permission decision recorded" },
              { agentId: "agent-code", status: "completed", task: "Diff preview kept read-only" },
              { agentId: "agent-verifier", status: "completed", task: "Verified denial record" },
            ]),
            codeReviewPreview,
            permissionRequest: resolvedRequest,
            logs: appendLog(snapshot, {
              id: `${taskId}-permission-denied`,
              kind: "permission",
              title: "permission.resolved",
              detail: `User denied ${permissionRequest.id}; no verification command was run.`,
            }),
            verificationSummary: "verified: code review was denied and no read-only verification command was executed.",
          });
          return;
        }

        emit({
          ...snapshot,
          title: "Running code review verification",
          status: "running",
          commanderMessage:
            "Code Agent will run a read-only diff check against the current repository state.",
          plan: markStep(snapshot.plan, "step-review-code", "completed", "step-verify-code", "running"),
          agents: setTrackedAgentStates(agentTracker, [
            { agentId: "agent-commander", status: "completed", task: "Permission decision recorded" },
            { agentId: "agent-code", status: "running", task: "Running read-only diff verification" },
            { agentId: "agent-verifier", status: "queued", task: "Waiting for diff check result" },
          ]),
          codeReviewPreview,
          permissionRequest: resolvedRequest,
          logs: appendLog(snapshot, {
            id: `${taskId}-verify-started`,
            kind: "permission",
            title: "permission.resolved",
            detail: `User approved ${permissionRequest.id}; running git diff --check.`,
          }),
        });

        try {
          const verification = await activeShellTool.runReadOnlyCommand({
            program: "git",
            args: ["diff", "--check"],
            workspacePath: null,
          });
          const verificationStatus = verification.exitCode === 0 ? "completed" : "failed";
          const logs = appendLog(snapshot, {
            id: `${taskId}-done`,
            kind: "verification",
            title:
              verificationStatus === "completed" ? "verification.completed" : "verification.failed",
            detail: `Verifier checked the repository diff with exit code ${verification.exitCode ?? "unknown"}.`,
          });

          if (verificationStatus === "failed") {
            emit({
              ...snapshot,
              title: "Code review verification failed",
              status: "failed",
              commanderMessage:
                "Code Agent reviewed the current diff, but the read-only verification check failed.",
              plan: markCodeReviewFailedAfterVerification(snapshot.plan),
              agents: setTrackedAgentStates(agentTracker, [
                { agentId: "agent-commander", status: "failed", task: "Verification failed" },
                { agentId: "agent-code", status: "completed", task: "Diff preview reviewed" },
                { agentId: "agent-verifier", status: "failed", task: `${verification.exitCode ?? "unknown"} diff check exit code` },
              ]),
              codeReviewPreview,
              commands: [verification],
              permissionRequest: resolvedRequest,
              logs,
              verificationSummary: `failed: ${changedFileCount} changed file(s) reviewed and git diff --check returned exit code ${verification.exitCode ?? "unknown"}.`,
            });
            return;
          }

          if (!activeCodeTool.proposeEdit) {
            emit({
              ...snapshot,
              title: "Code review completed",
              status: "completed",
              commanderMessage:
                "Code Agent reviewed the current diff and the read-only verification check passed. No edit proposal backend is configured yet.",
              plan: snapshot.plan.map((step) => ({
                ...step,
                status:
                  step.id === "step-propose-code-edit" || step.id === "step-apply-code-edit"
                    ? "skipped"
                    : "completed",
              })),
              agents: setTrackedAgentStates(agentTracker, [
                { agentId: "agent-commander", status: "completed", task: "Task finished" },
                { agentId: "agent-code", status: "completed", task: "Diff preview reviewed" },
                { agentId: "agent-verifier", status: "completed", task: `${verification.exitCode ?? "unknown"} diff check exit code` },
              ]),
              codeReviewPreview,
              commands: [verification],
              permissionRequest: resolvedRequest,
              logs,
              verificationSummary: `verified: ${changedFileCount} changed file(s) reviewed and git diff --check passed; no Code Agent edit backend is configured.`,
            });
            return;
          }

          emit({
            ...snapshot,
            title: "Preparing Code Agent patch proposal",
            status: "running",
            commanderMessage:
              "Diff verification passed. Code Agent is preparing an optional patch proposal without applying it.",
            plan: markStep(snapshot.plan, "step-verify-code", "completed", "step-propose-code-edit", "running"),
            agents: setTrackedAgentStates(agentTracker, [
              { agentId: "agent-commander", status: "completed", task: "Permission decision recorded" },
              { agentId: "agent-code", status: "running", task: "Preparing patch proposal" },
              { agentId: "agent-verifier", status: "completed", task: "Diff check passed" },
            ]),
            codeReviewPreview,
            commands: [verification],
            permissionRequest: resolvedRequest,
            logs,
          });

          let proposedEdit: CodeProposedEdit;
          try {
            proposedEdit = await activeCodeTool.proposeEdit({
              userGoal,
              preview: codeReviewPreview,
            });
          } catch (error) {
            emit({
              ...snapshot,
              title: "Code Agent patch proposal failed",
              status: "failed",
              commanderMessage:
                "Code Agent could not produce a patch proposal. Check the opencode model settings or provider response, then retry.",
              plan: markStep(snapshot.plan, "step-propose-code-edit", "failed", "step-apply-code-edit", "skipped"),
              agents: setTrackedAgentStates(agentTracker, [
                { agentId: "agent-commander", status: "failed", task: "Patch proposal unavailable" },
                { agentId: "agent-code", status: "failed", task: "Patch proposal failed" },
                { agentId: "agent-verifier", status: "cancelled", task: "No patch proposal to verify" },
              ]),
              codeReviewPreview,
              commands: [verification],
              permissionRequest: resolvedRequest,
              logs: appendLog(snapshot, {
                id: `${taskId}-proposal-failed`,
                kind: "tool",
                title: "task.failed",
                detail: error instanceof Error ? error.message : String(error),
              }),
              verificationSummary: "failed: Code Agent patch proposal failed before any write approval was requested.",
            });
            return;
          }
          const tokenUsage = proposedEdit.tokenUsage
            ? addModelUsage(snapshot.tokenUsage, "code", proposedEdit.tokenUsage)
            : snapshot.tokenUsage;
          const proposalSafetyError = validateCodeProposal(proposedEdit);
          if (proposalSafetyError) {
            emit({
              ...snapshot,
              title: "Code Agent patch proposal failed safety check",
              status: "failed",
              commanderMessage:
                "Code Agent produced a patch proposal whose hash does not match its content, so Javis refused to request write approval.",
              plan: markStep(snapshot.plan, "step-propose-code-edit", "failed", "step-apply-code-edit", "skipped"),
              agents: setTrackedAgentStates(agentTracker, [
                { agentId: "agent-commander", status: "failed", task: "Proposal safety check failed" },
                { agentId: "agent-code", status: "failed", task: "Patch hash mismatch" },
                { agentId: "agent-verifier", status: "cancelled", task: "No write approval requested" },
              ]),
              codeReviewPreview,
              codeProposedEdit: proposedEdit,
              commands: [verification],
              permissionRequest: resolvedRequest,
              tokenUsage,
              logs: appendLog(snapshot, {
                id: `${taskId}-proposal-hash-mismatch`,
                kind: "tool",
                title: "task.failed",
                detail: proposalSafetyError,
              }),
            });
            return;
          }

          if (!proposedEdit.patch.trim()) {
            emit({
              ...snapshot,
              title: "Code review completed",
              status: "completed",
              commanderMessage:
                "Code Agent did not produce a patch proposal, so no confirmed-write approval is needed.",
              plan: snapshot.plan.map((step) => ({
                ...step,
                status: step.id === "step-apply-code-edit" ? "skipped" : "completed",
              })),
              agents: setTrackedAgentStates(agentTracker, [
                { agentId: "agent-commander", status: "completed", task: "Task finished" },
                { agentId: "agent-code", status: "completed", task: "No patch proposed" },
                { agentId: "agent-verifier", status: "completed", task: "Diff check passed" },
              ]),
              codeReviewPreview,
              codeProposedEdit: proposedEdit,
              commands: [verification],
              permissionRequest: resolvedRequest,
              tokenUsage,
              logs: appendLog(snapshot, {
                id: `${taskId}-proposal-empty`,
                kind: "tool",
                title: "tool_call.updated",
                detail: "code.proposeEdit returned no patch to apply.",
              }),
              verificationSummary: `verified: ${changedFileCount} changed file(s) reviewed and git diff --check passed; no patch was proposed.`,
            });
            return;
          }

          const applyPermissionRequest: ToolPermissionRequest = createPendingPermissionRequest({
            id: `${taskId}-apply-permission`,
            level: "confirmed_write",
            title: "Approve Code Agent patch application",
            reason: "Applying the proposed patch changes local project files, so Javis needs explicit approval.",
            dryRun: createCodeApplyDryRun(proposedEdit),
          });

          emit({
            ...snapshot,
            title: "Code Agent patch approval needed",
            status: "waiting_permission",
            commanderMessage:
              "Patch proposal is ready. Review the proposed changes before approving or denying the write step.",
            plan: markStep(snapshot.plan, "step-propose-code-edit", "completed", "step-apply-code-edit", "running"),
            agents: setTrackedAgentStates(agentTracker, [
              { agentId: "agent-commander", status: "waiting_permission", task: "Waiting for patch approval" },
              { agentId: "agent-code", status: "waiting_permission", task: `${proposedEdit.changedFiles.length} proposed file change(s)` },
              { agentId: "agent-verifier", status: "queued", task: "Waiting for permission decision" },
            ]),
            codeReviewPreview,
            codeProposedEdit: proposedEdit,
            commands: [verification],
            permissionRequest: applyPermissionRequest,
            tokenUsage,
            logs: appendLog(snapshot, {
              id: `${taskId}-apply-permission-requested`,
              kind: "permission",
              title: "permission.requested",
              detail: `${proposedEdit.changedFiles.length} proposed file change(s) require confirmed_write approval.`,
            }),
          });

          setPendingPermissionHandler(applyPermissionRequest.id, async (applyDecision) => {
            const resolvedApplyRequest: ToolPermissionRequest = resolvePermissionRequest(
              applyPermissionRequest,
              applyDecision,
            );
            setPendingPermissionHandler(applyPermissionRequest.id, undefined);

            if (applyDecision === "denied") {
              emit({
                ...snapshot,
                title: "Code Agent patch denied",
                status: "completed",
                commanderMessage:
                  "Permission was denied. Javis kept the patch proposal as a preview and did not modify files.",
                plan: snapshot.plan.map((step) => ({
                  ...step,
                  status: step.id === "step-apply-code-edit" ? "skipped" : "completed",
                })),
                agents: setTrackedAgentStates(agentTracker, [
                  { agentId: "agent-commander", status: "completed", task: "Permission decision recorded" },
                  { agentId: "agent-code", status: "completed", task: "Patch proposal kept read-only" },
                  { agentId: "agent-verifier", status: "completed", task: "Verified denial record" },
                ]),
                codeReviewPreview,
                codeProposedEdit: proposedEdit,
                commands: [verification],
                permissionRequest: resolvedApplyRequest,
                logs: appendLog(snapshot, {
                  id: `${taskId}-apply-denied`,
                  kind: "permission",
                  title: "permission.resolved",
                  detail: `User denied ${applyPermissionRequest.id}; no patch was applied.`,
                }),
                verificationSummary: "verified: Code Agent patch was denied and no write operation was executed.",
              });
              return;
            }

            const approvedProposalSafetyError = validateCodeProposal(proposedEdit);
            if (approvedProposalSafetyError) {
              emit({
                ...snapshot,
                title: "Code Agent patch approval is stale",
                status: "failed",
                commanderMessage:
                  "The approved patch proposal no longer matches its recorded hash, so Javis refused to apply it.",
                plan: markStep(snapshot.plan, "step-apply-code-edit", "failed"),
                agents: setTrackedAgentStates(agentTracker, [
                  { agentId: "agent-commander", status: "completed", task: "Permission decision recorded" },
                  { agentId: "agent-code", status: "failed", task: "Approved patch hash mismatch" },
                  { agentId: "agent-verifier", status: "cancelled", task: "No write result to verify" },
                ]),
                codeReviewPreview,
                codeProposedEdit: proposedEdit,
                commands: [verification],
                permissionRequest: resolvedApplyRequest,
                logs: appendLog(snapshot, {
                  id: `${taskId}-approved-patch-mismatch`,
                  kind: "permission",
                  title: "task.failed",
                  detail: approvedProposalSafetyError,
                }),
              });
              return;
            }

            if (!activeCodeTool.applyProposedEdit) {
              emit({
                ...snapshot,
                title: "Code Agent apply backend unavailable",
                status: "failed",
                commanderMessage:
                  "Permission was approved, but the confirmed-write Code Agent apply backend is not configured.",
                plan: markStep(snapshot.plan, "step-apply-code-edit", "failed"),
                agents: setTrackedAgentStates(agentTracker, [
                  { agentId: "agent-commander", status: "completed", task: "Permission decision recorded" },
                  { agentId: "agent-code", status: "failed", task: "Apply backend unavailable" },
                  { agentId: "agent-verifier", status: "cancelled", task: "No write result to verify" },
                ]),
                codeReviewPreview,
                codeProposedEdit: proposedEdit,
                commands: [verification],
                permissionRequest: resolvedApplyRequest,
                logs: appendLog(snapshot, {
                  id: `${taskId}-apply-missing`,
                  kind: "tool",
                  title: "task.failed",
                  detail: "code.applyProposedEdit is not configured.",
                }),
              });
              return;
            }

            emit({
              ...snapshot,
              title: "Applying approved Code Agent patch",
              status: "running",
              commanderMessage:
                "Permission was approved. Code Agent is applying only the current patch proposal.",
              plan: markStep(snapshot.plan, "step-apply-code-edit", "running"),
              agents: setTrackedAgentStates(agentTracker, [
                { agentId: "agent-commander", status: "completed", task: "Permission decision recorded" },
                { agentId: "agent-code", status: "running", task: "Applying approved patch" },
                { agentId: "agent-verifier", status: "queued", task: "Waiting for post-apply check" },
              ]),
              codeReviewPreview,
              codeProposedEdit: proposedEdit,
              commands: [verification],
              permissionRequest: resolvedApplyRequest,
              logs: appendLog(snapshot, {
                id: `${taskId}-apply-started`,
                kind: "permission",
                title: "permission.resolved",
                detail: `User approved ${applyPermissionRequest.id}; applying proposed patch.`,
              }),
            });

            try {
              const applyResult = await activeCodeTool.applyProposedEdit(proposedEdit, {
                approvalId: resolvedApplyRequest.id,
              });
              const applySafetyError = validateCodeApplyResult(proposedEdit, applyResult);
              if (applySafetyError) {
                emit({
                  ...snapshot,
                  title: "Code Agent patch result failed safety check",
                  status: "failed",
                  commanderMessage:
                    "Code Agent reported an apply result that did not match the approved proposal.",
                  plan: markStep(snapshot.plan, "step-apply-code-edit", "failed"),
                  agents: setTrackedAgentStates(agentTracker, [
                    { agentId: "agent-commander", status: "failed", task: "Apply safety check failed" },
                    { agentId: "agent-code", status: "failed", task: applySafetyError },
                    { agentId: "agent-verifier", status: "cancelled", task: "Post-apply check skipped" },
                  ]),
                  codeReviewPreview,
                  codeProposedEdit: proposedEdit,
                  codeApplyResult: applyResult,
                  commands: [verification],
                  permissionRequest: resolvedApplyRequest,
                  logs: appendLog(snapshot, {
                    id: `${taskId}-apply-safety-failed`,
                    kind: "tool",
                    title: "task.failed",
                    detail: applySafetyError,
                  }),
                  verificationSummary: `failed: ${applySafetyError}`,
                });
                return;
              }
              const postApplyVerification = await activeShellTool.runReadOnlyCommand({
                program: "git",
                args: ["diff", "--check"],
                workspacePath: null,
              });
              const applyStatus =
                applyResult.applied && postApplyVerification.exitCode === 0 ? "completed" : "failed";

              emit({
                ...snapshot,
                title:
                  applyStatus === "completed"
                    ? "Code Agent patch applied"
                    : "Code Agent patch verification failed",
                status: applyStatus,
                commanderMessage:
                  applyStatus === "completed"
                    ? "Approved patch was applied and the post-apply diff check passed."
                    : "The patch apply step finished, but post-apply verification did not pass.",
                plan:
                  applyStatus === "completed"
                    ? snapshot.plan.map((step) => ({ ...step, status: "completed" }))
                    : markCodeReviewApplyFailed(snapshot.plan),
                agents: setTrackedAgentStates(agentTracker, [
                  {
                    agentId: "agent-commander",
                    status: applyStatus === "completed" ? "completed" : "failed",
                    task: applyStatus === "completed" ? "Task finished" : "Verification failed",
                  },
                  {
                    agentId: "agent-code",
                    status: applyStatus === "completed" ? "completed" : "failed",
                    task: applyResult.message,
                  },
                  {
                    agentId: "agent-verifier",
                    status: applyStatus === "completed" ? "completed" : "failed",
                    task: `${postApplyVerification.exitCode ?? "unknown"} post-apply diff check exit code`,
                  },
                ]),
                codeReviewPreview,
                codeProposedEdit: proposedEdit,
                codeApplyResult: applyResult,
                commands: [verification, postApplyVerification],
                permissionRequest: resolvedApplyRequest,
                logs: appendLog(snapshot, {
                  id: `${taskId}-apply-done`,
                  kind: "verification",
                  title: applyStatus === "completed" ? "task.completed" : "verification.failed",
                  detail: `code.applyProposedEdit applied=${applyResult.applied}; post-apply git diff --check exit code ${postApplyVerification.exitCode ?? "unknown"}.`,
                }),
                verificationSummary:
                  applyStatus === "completed"
                    ? `verified: approved Code Agent patch applied to ${applyResult.changedFiles.length} file(s), and post-apply git diff --check passed.`
                    : `failed: Code Agent apply result was ${applyResult.applied ? "applied" : "not applied"} and post-apply git diff --check returned exit code ${postApplyVerification.exitCode ?? "unknown"}.`,
              });
            } catch (error) {
              emit({
                ...snapshot,
                title: "Code Agent patch application failed",
                status: "failed",
                commanderMessage:
                  "Code Agent could not apply the approved patch or run post-apply verification.",
                plan: markCodeReviewApplyFailed(snapshot.plan),
                agents: setTrackedAgentStates(agentTracker, [
                  { agentId: "agent-commander", status: "completed", task: "Permission decision recorded" },
                  { agentId: "agent-code", status: "failed", task: "Patch application failed" },
                  { agentId: "agent-verifier", status: "failed", task: "Post-apply verification unavailable" },
                ]),
                codeReviewPreview,
                codeProposedEdit: proposedEdit,
                commands: [verification],
                permissionRequest: resolvedApplyRequest,
                logs: appendLog(snapshot, {
                  id: `${taskId}-apply-failed`,
                  kind: "tool",
                  title: "task.failed",
                  detail: error instanceof Error ? error.message : String(error),
                }),
              });
            }
          });

        } catch (error) {
          emit({
            ...snapshot,
            title: "Code review verification failed",
            status: "failed",
            commanderMessage:
              "Code Agent reviewed the diff preview, but the read-only verification command failed to run.",
            plan: markCodeReviewFailedAfterVerification(snapshot.plan),
            agents: setTrackedAgentStates(agentTracker, [
              { agentId: "agent-commander", status: "completed", task: "Permission decision recorded" },
              { agentId: "agent-code", status: "completed", task: "Diff preview reviewed" },
              { agentId: "agent-verifier", status: "failed", task: "Verification command failed" },
            ]),
            codeReviewPreview,
            permissionRequest: resolvedRequest,
            logs: appendLog(snapshot, {
              id: `${taskId}-failed`,
              kind: "tool",
              title: "task.failed",
              detail: error instanceof Error ? error.message : String(error),
            }),
          });
        }
      });
    } catch (error) {
      emit({
        ...snapshot,
        title: "Code review preview failed",
        status: "failed",
        commanderMessage:
          "Code Agent could not collect a diff preview. Check repository access or try a narrower code review goal.",
        plan: markCodeReviewPreviewFailed(snapshot.plan),
        agents: setTrackedAgentStates(agentTracker, [
          { agentId: "agent-commander", status: "completed", task: "Plan submitted" },
          { agentId: "agent-code", status: "failed", task: "Diff preview unavailable" },
          { agentId: "agent-verifier", status: "cancelled", task: "No diff to verify" },
        ]),
        logs: appendLog(snapshot, {
          id: `${taskId}-failed`,
          kind: "tool",
          title: "task.failed",
          detail: error instanceof Error ? error.message : String(error),
        }),
      });
    }
  }

  async function runResearchSearchTask(taskId: ID, userGoal: string, activeWebTool: WebTool) {
    const plan = createResearchSearchPlan();
    const agentTracker = createScopedAgentTracker(["commander", "research", "verifier"]);

    emit({
      id: taskId,
      title: "Searching research sources",
      userGoal,
      status: "planning",
      commanderMessage:
        "Commander identified a research goal and prepared read-only public source search.",
      plan,
      agents: setTrackedAgentStates(agentTracker, [
        { agentId: "agent-commander", status: "planning", task: "Create research source plan" },
        { agentId: "agent-research", status: "queued", task: "Waiting for public source search" },
        { agentId: "agent-verifier", status: "queued", task: "Waiting for source evidence" },
      ]),
      tokenUsage: createEmptyTokenUsageSummary(),
      logs: [
        {
          id: `${taskId}-created`,
          kind: "event",
          title: "task.created",
          detail: "Desktop UI passed the search-backed research goal to Core.",
        },
      ],
    });

    await wait();

    emit({
      ...snapshot,
      status: "running",
      commanderMessage:
        "Research Agent is asking the configured search provider for public source candidates.",
      plan: markStep(snapshot.plan, "step-search-sources", "running"),
      agents: setTrackedAgentStates(agentTracker, [
        { agentId: "agent-commander", status: "completed", task: "Plan submitted" },
        { agentId: "agent-research", status: "running", task: "Searching public sources" },
        { agentId: "agent-verifier", status: "queued", task: "Waiting for sources" },
      ]),
      logs: appendLog(snapshot, {
        id: `${taskId}-search-started`,
        kind: "tool",
        title: "tool_call.planned",
        detail: "web.search uses read permission and returns public source candidates.",
      }),
    });

    try {
      const searchResults = await activeWebTool.searchWeb?.({
        query: userGoal,
        maxResults: 3,
      });
      if (!searchResults || searchResults.length === 0) {
        emit({
          ...snapshot,
          title: "Research search returned no sources",
          status: "failed",
          commanderMessage:
            "The configured search provider did not return source candidates. Add source URLs manually or try a narrower query.",
          plan: markStep(snapshot.plan, "step-search-sources", "failed"),
          agents: setTrackedAgentStates(agentTracker, [
            { agentId: "agent-commander", status: "completed", task: "Plan submitted" },
            { agentId: "agent-research", status: "failed", task: "No search results" },
            { agentId: "agent-verifier", status: "cancelled", task: "No source to verify" },
          ]),
          logs: appendLog(snapshot, {
            id: `${taskId}-search-empty`,
            kind: "tool",
            title: "task.failed",
            detail: "web.search returned 0 source candidate(s).",
          }),
        });
        return;
      }

      const selectedResults = Array.from(
        new Map(searchResults.map((result) => [result.url, result])).values(),
      ).slice(0, 3);
      const urls = selectedResults.map((result) => result.url);
      const providerByUrl = new Map(
        selectedResults.map((result) => [result.url, result.provider]),
      );

      emit({
        ...snapshot,
        title: "Fetching search result sources",
        commanderMessage:
          "Research Agent found source candidates and is fetching the selected URLs for evidence.",
        plan: markStep(snapshot.plan, "step-search-sources", "completed", "step-fetch-sources", "running"),
        agents: setTrackedAgentStates(agentTracker, [
          { agentId: "agent-commander", status: "completed", task: "Plan submitted" },
          { agentId: "agent-research", status: "running", task: `Fetching ${urls.length} selected source(s)` },
          { agentId: "agent-verifier", status: "queued", task: "Waiting for sources" },
        ]),
        sources: searchResults,
        logs: appendLog(snapshot, {
          id: `${taskId}-search-done`,
          kind: "tool",
          title: "tool_call.updated",
          detail: `web.search returned ${searchResults.length} source candidate(s) from ${summarizeSearchProviders(searchResults)}.`,
        }),
      });

      const fetchResults = await Promise.allSettled<WebSource>(
        urls.map(async (url) => {
          const source = await activeWebTool.fetchWebSource({ url });
          return {
            ...source,
            provider: providerByUrl.get(url) ?? source.provider,
          };
        }),
      );
      const sources = fetchResults
        .flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
      const failedFetches = fetchResults
        .map((result, index) => ({ result, url: urls[index] }))
        .filter((entry): entry is { result: PromiseRejectedResult; url: string } => entry.result.status === "rejected");
      if (sources.length === 0) {
        throw new Error(
          `Search found ${urls.length} candidate source(s), but none could be fetched.`,
        );
      }
      const providerSummary = summarizeSearchProviders(selectedResults);
      const researchReport = createSourceBackedReport(sources, {
        failedFetchCount: failedFetches.length,
        providerSummary,
        sourceMode: "search",
      });

      emit({
        ...snapshot,
        title: "Drafting source-backed report",
        status: "verifying",
        commanderMessage:
          "Research Agent collected searched sources. Verifier is checking that every source has a URL and excerpt.",
        plan: markStep(snapshot.plan, "step-fetch-sources", "completed", "step-verify-sources", "running"),
        agents: setTrackedAgentStates(agentTracker, [
          { agentId: "agent-commander", status: "completed", task: "Waiting for verification" },
          { agentId: "agent-research", status: "completed", task: `Fetched ${sources.length} source(s)` },
          { agentId: "agent-verifier", status: "verifying", task: "Checking source evidence" },
        ]),
        sources,
        researchReport,
        logs: [
          ...appendLog(snapshot, {
            id: `${taskId}-sources-done`,
            kind: "tool",
            title: "tool_call.updated",
            detail: `web.fetchSource completed for ${sources.length}/${urls.length} searched source(s).`,
          }),
          ...failedFetches.map((entry, index) => ({
            id: `${taskId}-source-fetch-failed-${index}`,
            kind: "tool" as const,
            title: `web.fetchSource failed: ${entry.url}`,
            detail: entry.result.reason instanceof Error
              ? entry.result.reason.message
              : String(entry.result.reason),
          })),
        ],
      });

      await wait();

      const validCount = sources.filter((source) => source.url && source.excerpt).length;
      const reportEvidenceCount = researchReport.rows.filter(
        (row) => row.sourceUrl && row.evidence,
      ).length;
      const verificationStatus =
        validCount === sources.length && reportEvidenceCount === researchReport.rows.length
          ? "completed"
          : "failed";
      emit({
        ...snapshot,
        title:
          verificationStatus === "completed"
            ? "Research sources collected"
            : "Research source verification failed",
        status: verificationStatus,
        commanderMessage:
          verificationStatus === "completed"
            ? "Research Agent produced a source-backed report from searched public sources."
            : "Research Agent fetched searched sources, but Verifier found missing source evidence.",
        plan:
          verificationStatus === "completed"
            ? snapshot.plan.map((step) => ({ ...step, status: "completed" }))
            : markStep(snapshot.plan, "step-verify-sources", "failed"),
        agents: setTrackedAgentStates(agentTracker, [
          {
            agentId: "agent-commander",
            status: verificationStatus === "completed" ? "completed" : "failed",
            task: verificationStatus === "completed" ? "Task finished" : "Verification failed",
          },
          { agentId: "agent-research", status: "completed", task: "Source collection completed" },
          {
            agentId: "agent-verifier",
            status: verificationStatus === "completed" ? "completed" : "failed",
            task: `${reportEvidenceCount}/${researchReport.rows.length} claims verified`,
          },
        ]),
        logs: appendLog(snapshot, {
          id: `${taskId}-done`,
          kind: "verification",
          title:
            verificationStatus === "completed" ? "task.completed" : "verification.failed",
          detail: `Verifier checked ${validCount}/${sources.length} source records and ${reportEvidenceCount}/${researchReport.rows.length} report claims.`,
        }),
        researchReport: snapshot.researchReport,
        verificationSummary: `${verificationStatus === "completed" ? "verified" : "failed"}: ${validCount}/${sources.length} searched sources include URL and excerpt; ${reportEvidenceCount}/${researchReport.rows.length} report claims include source evidence; ${failedFetches.length} searched source fetch(es) failed.`,
      });
    } catch (error) {
      emit({
        ...snapshot,
        title: "Research search failed",
        status: "failed",
        commanderMessage:
          "Research Agent could not complete search-backed source collection. Add source URLs manually as a fallback.",
        plan: markStep(snapshot.plan, "step-search-sources", "failed"),
        agents: setTrackedAgentStates(agentTracker, [
          { agentId: "agent-commander", status: "completed", task: "Plan submitted" },
          { agentId: "agent-research", status: "failed", task: "Source search failed" },
          { agentId: "agent-verifier", status: "cancelled", task: "No source to verify" },
        ]),
        logs: appendLog(snapshot, {
          id: `${taskId}-failed`,
          kind: "tool",
          title: "task.failed",
          detail: error instanceof Error ? error.message : String(error),
        }),
      });
    }
  }

  async function runResearchSourceTask(taskId: ID, userGoal: string, activeWebTool: WebTool) {
    const urls = extractUrls(userGoal);
    const plan = createResearchSourcePlan();
    const agentTracker = createScopedAgentTracker(["commander", "research", "verifier"]);

    emit({
      id: taskId,
      title: "Collecting research sources",
      userGoal,
      status: "planning",
      commanderMessage:
        "Commander found user-provided URLs and prepared read-only source collection.",
      plan,
      agents: setTrackedAgentStates(agentTracker, [
        { agentId: "agent-commander", status: "planning", task: "Create research source plan" },
        { agentId: "agent-research", status: "queued", task: `Waiting to fetch ${urls.length} source(s)` },
        { agentId: "agent-verifier", status: "queued", task: "Waiting for source evidence" },
      ]),
      tokenUsage: createEmptyTokenUsageSummary(),
      logs: [
        {
          id: `${taskId}-created`,
          kind: "event",
          title: "task.created",
          detail: "Desktop UI passed the research goal to Core.",
        },
      ],
    });

    await wait();

    emit({
      ...snapshot,
      status: "running",
      commanderMessage: "Research Agent is fetching public sources provided by the user.",
      plan: markStep(snapshot.plan, "step-fetch-sources", "running"),
      agents: setTrackedAgentStates(agentTracker, [
        { agentId: "agent-commander", status: "completed", task: "Plan submitted" },
        { agentId: "agent-research", status: "running", task: "Fetching public URL sources" },
        { agentId: "agent-verifier", status: "queued", task: "Waiting for sources" },
      ]),
      logs: appendLog(snapshot, {
        id: `${taskId}-sources-started`,
        kind: "tool",
        title: "tool_call.planned",
        detail: `Fetching ${urls.length} URL(s) with read permission.`,
      }),
    });

    try {
      const sources = await Promise.all(
        urls.map((url) => activeWebTool.fetchWebSource({ url })),
      );
      const researchReport = createSourceBackedReport(sources, {
        sourceMode: "manual",
      });

      emit({
        ...snapshot,
        title: "Drafting source-backed report",
        status: "verifying",
        commanderMessage:
          "Research Agent collected sources. Verifier is checking that every source has a URL and excerpt.",
        plan: markStep(snapshot.plan, "step-fetch-sources", "completed", "step-verify-sources", "running"),
        agents: setTrackedAgentStates(agentTracker, [
          { agentId: "agent-commander", status: "completed", task: "Waiting for verification" },
          { agentId: "agent-research", status: "completed", task: `Fetched ${sources.length} source(s)` },
          { agentId: "agent-verifier", status: "verifying", task: "Checking source evidence" },
        ]),
        sources,
        researchReport,
        logs: appendLog(snapshot, {
          id: `${taskId}-sources-done`,
          kind: "tool",
          title: "tool_call.updated",
          detail: `web.fetchSource completed for ${sources.length} source(s).`,
        }),
      });

      await wait();

      const validCount = sources.filter((source) => source.url && source.excerpt).length;
      const reportEvidenceCount = researchReport.rows.filter(
        (row) => row.sourceUrl && row.evidence,
      ).length;
      const verificationStatus =
        validCount === sources.length && reportEvidenceCount === researchReport.rows.length
          ? "completed"
          : "failed";
      emit({
        ...snapshot,
        title:
          verificationStatus === "completed"
            ? "Research sources collected"
            : "Research source verification failed",
        status: verificationStatus,
        commanderMessage:
          verificationStatus === "completed"
            ? "Research Agent produced a source-backed report from user-provided URLs. Search-backed source discovery is available for research goals without URLs."
            : "Research Agent fetched the provided URLs, but Verifier found missing source evidence.",
        plan:
          verificationStatus === "completed"
            ? snapshot.plan.map((step) => ({ ...step, status: "completed" }))
            : markStep(snapshot.plan, "step-verify-sources", "failed"),
        agents: setTrackedAgentStates(agentTracker, [
          {
            agentId: "agent-commander",
            status: verificationStatus === "completed" ? "completed" : "failed",
            task: verificationStatus === "completed" ? "Task finished" : "Verification failed",
          },
          { agentId: "agent-research", status: "completed", task: "Source collection completed" },
          {
            agentId: "agent-verifier",
            status: verificationStatus === "completed" ? "completed" : "failed",
            task: `${reportEvidenceCount}/${researchReport.rows.length} claims verified`,
          },
        ]),
        logs: appendLog(snapshot, {
          id: `${taskId}-done`,
          kind: "verification",
          title:
            verificationStatus === "completed" ? "task.completed" : "verification.failed",
          detail: `Verifier checked ${validCount}/${sources.length} source records and ${reportEvidenceCount}/${researchReport.rows.length} report claims.`,
        }),
        researchReport: snapshot.researchReport,
        verificationSummary: `${verificationStatus === "completed" ? "verified" : "failed"}: ${validCount}/${sources.length} sources include URL and excerpt; ${reportEvidenceCount}/${researchReport.rows.length} report claims include source evidence.`,
      });
    } catch (error) {
      emit({
        ...snapshot,
        title: "Research source collection failed",
        status: "failed",
        commanderMessage:
          "Research Agent could not fetch the provided source. Add alternate URLs manually or try a search-backed research goal.",
        plan: markStep(snapshot.plan, "step-fetch-sources", "failed"),
        agents: setTrackedAgentStates(agentTracker, [
          { agentId: "agent-commander", status: "completed", task: "Plan submitted" },
          { agentId: "agent-research", status: "failed", task: "Source fetch failed" },
          { agentId: "agent-verifier", status: "cancelled", task: "No source to verify" },
        ]),
        logs: appendLog(snapshot, {
          id: `${taskId}-failed`,
          kind: "tool",
          title: "task.failed",
          detail: error instanceof Error ? error.message : String(error),
        }),
      });
    }
  }
}

function summarizeSearchProviders(sources: WebSource[]): string {
  const providers = Array.from(
    new Set(sources.map((source) => source.provider).filter(Boolean)),
  );
  return providers.length > 0 ? providers.join(", ") : "unknown provider";
}

function markCodeReviewFailedAfterVerification(steps: TaskStep[]): TaskStep[] {
  return steps.map((step) => {
    if (step.id === "step-verify-code") {
      return { ...step, status: "failed" };
    }
    if (step.id === "step-propose-code-edit" || step.id === "step-apply-code-edit") {
      return { ...step, status: "skipped" };
    }
    return step;
  });
}

function markCodeReviewPreviewFailed(steps: TaskStep[]): TaskStep[] {
  return steps.map((step) => {
    if (step.id === "step-inspect-code") {
      return { ...step, status: "failed" };
    }
    if (
      step.id === "step-review-code" ||
      step.id === "step-verify-code" ||
      step.id === "step-propose-code-edit" ||
      step.id === "step-apply-code-edit"
    ) {
      return { ...step, status: "skipped" };
    }
    return step;
  });
}

function markCodeReviewApplyFailed(steps: TaskStep[]): TaskStep[] {
  return steps.map((step) => {
    if (step.id === "step-apply-code-edit") {
      return { ...step, status: "failed" };
    }
    return step;
  });
}
