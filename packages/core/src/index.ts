import type {
  CodeReviewPreview,
  CodeTool,
  FileOrganizationExecution,
  FileOrganizationPlan,
  FileTool,
  MarkdownDocumentSummary,
  PermissionRequest as ToolPermissionRequest,
  ProjectInspection,
  ProjectTool,
  ResearchReport,
  ShellCommandOutput,
  ShellTool,
  WebSource,
  WebTool,
} from "@javis/tools";
import {
  codeSnapshot,
  commanderSnapshot,
  demoAgents,
  fileSnapshot,
  researchSnapshot,
  shellSnapshot,
  verifierSnapshot,
} from "./agents";
import { runFileScanTask } from "./file-scan-flow";
import {
  createCodeReviewPlan,
  createPdfOrganizationPlan,
  createProjectInspectionPlan,
  createResearchSearchPlan,
  createResearchSourcePlan,
  markStep,
} from "./plans";
import { createSourceBackedReport } from "./research";
import {
  createRecommendedCommandRequest,
  extractUrls,
  isCodeReviewGoal,
  isPdfOrganizationGoal,
  isProjectInspectionGoal,
  isResearchGoal,
} from "./routing";
import { createRuntimeState } from "./runtime-state";
import { appendLog } from "./snapshot-utils";

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
  commanderMessage: string;
  plan: TaskStep[];
  agents: AgentSnapshot[];
  logs: TaskLogEntry[];
  documents?: MarkdownDocumentSummary[];
  commands?: ShellCommandOutput[];
  fileOrganizationExecution?: FileOrganizationExecution;
  fileOrganizationPlan?: FileOrganizationPlan;
  codeReviewPreview?: CodeReviewPreview;
  permissionRequest?: ToolPermissionRequest;
  project?: ProjectInspection;
  researchReport?: ResearchReport;
  sources?: WebSource[];
  verificationSummary?: string;
}

export interface TaskRuntime {
  getSnapshot(): TaskSnapshot;
  subscribe(listener: (snapshot: TaskSnapshot) => void): () => void;
  start(userGoal: string): void;
  resolvePermission(decision: "approved" | "denied"): void;
  dispose(): void;
}

export interface FileScanRuntimeOptions {
  fileTool: FileTool;
  codeTool?: CodeTool;
  projectTool?: ProjectTool;
  shellTool?: ShellTool;
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
  };
}

export function createFileScanTaskRuntime({
  fileTool,
  codeTool,
  projectTool,
  shellTool,
  webTool,
  delayMs = 250,
}: FileScanRuntimeOptions): TaskRuntime {
  const runtimeState = createRuntimeState(createInitialTaskSnapshot(), delayMs);
  let pendingPermissionHandler: ((decision: "approved" | "denied") => void | Promise<void>) | undefined;
  let snapshot = runtimeState.getSnapshot();
  function emit(nextSnapshot: TaskSnapshot) {
    runtimeState.emit(nextSnapshot);
    snapshot = runtimeState.getSnapshot();
  }
  const wait = runtimeState.wait;

  return {
    getSnapshot: () => runtimeState.getSnapshot(),
    subscribe(listener) {
      return runtimeState.subscribe(listener);
    },
    start(userGoal) {
      runtimeState.clearTimers();
      pendingPermissionHandler = undefined;
      const taskId = `task-${Date.now()}`;
      if (webTool && extractUrls(userGoal).length > 0) {
        void runResearchSourceTask(taskId, userGoal, webTool);
        return;
      }
      if (webTool?.searchWeb && isResearchGoal(userGoal)) {
        void runResearchSearchTask(taskId, userGoal, webTool);
        return;
      }
      if (shellTool && projectTool && isProjectInspectionGoal(userGoal)) {
        void runProjectInspectionTask(taskId, userGoal, shellTool, projectTool);
        return;
      }
      if (codeTool && shellTool && isCodeReviewGoal(userGoal)) {
        void runCodeReviewTask(taskId, userGoal, codeTool, shellTool);
        return;
      }
      if (fileTool.planPdfOrganization && isPdfOrganizationGoal(userGoal)) {
        void runPdfOrganizationPreviewTask(taskId, userGoal);
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
    resolvePermission(decision) {
      void pendingPermissionHandler?.(decision);
    },
    dispose() {
      runtimeState.dispose();
    },
  };

  async function runPdfOrganizationPreviewTask(taskId: ID, userGoal: string) {
    const plan = createPdfOrganizationPlan();

    emit({
      id: taskId,
      title: "Planning PDF organization",
      userGoal,
      status: "planning",
      commanderMessage:
        "Commander identified a high-risk file organization request and will create a dry-run before any write action.",
      plan,
      agents: [
        commanderSnapshot("planning", "Create dry-run plan"),
        fileSnapshot("queued", "Waiting for file.planPdfOrganization"),
        verifierSnapshot("queued", "Waiting for dry-run evidence"),
      ],
      logs: [
        {
          id: `${taskId}-created`,
          kind: "event",
          title: "task.created",
          detail: "Desktop UI passed the PDF organization goal to Core.",
        },
      ],
    });

    await wait();

    emit({
      ...snapshot,
      status: "running",
      commanderMessage: "File Agent is creating a preview plan. No files are being moved.",
      plan: markStep(snapshot.plan, "step-plan-pdf", "running"),
      agents: [
        commanderSnapshot("completed", "Plan submitted"),
        fileSnapshot("running", "Creating PDF organization dry-run"),
        verifierSnapshot("queued", "Waiting for dry-run evidence"),
      ],
      logs: appendLog(snapshot, {
        id: `${taskId}-preview-started`,
        kind: "tool",
        title: "tool_call.planned",
        detail: "file.planPdfOrganization uses preview permission and does not modify local files.",
      }),
    });

    try {
      const organizationPlan = await fileTool.planPdfOrganization?.();
      if (!organizationPlan) {
        throw new Error("PDF organization preview tool is not available.");
      }
      if (organizationPlan.fileCount === 0) {
        emit({
          ...snapshot,
          title: "No PDFs found to organize",
          status: "completed",
          commanderMessage:
            "File Agent did not find PDF files in Downloads, so no permission request or write step is needed.",
          plan: snapshot.plan.map((step) => ({
            ...step,
            status: step.id === "step-plan-pdf" ? "completed" : "skipped",
          })),
          agents: [
            commanderSnapshot("completed", "Task finished"),
            fileSnapshot("completed", "No PDF files found"),
            verifierSnapshot("completed", "Verified no-op result"),
          ],
          fileOrganizationPlan: organizationPlan,
          logs: appendLog(snapshot, {
            id: `${taskId}-no-pdfs`,
            kind: "verification",
            title: "task.completed",
            detail: "Dry-run found 0 PDF files, so no confirmed_write request was created.",
          }),
          verificationSummary: "verified: no PDF files were found in Downloads, and no files were moved.",
        });
        return;
      }
      const permissionRequest: ToolPermissionRequest = {
        id: `${taskId}-permission`,
        level: "confirmed_write",
        title: "Approve PDF move plan",
        reason: "Moving files changes the local filesystem, so Javis needs explicit approval.",
        dryRun: organizationPlan.dryRun,
        status: "pending",
        createdAt: new Date().toISOString(),
      };

      emit({
        ...snapshot,
        title: "PDF organization approval needed",
        status: "waiting_permission",
        commanderMessage:
          "Dry-run is ready. Review the affected paths before approving or denying the write step.",
        plan: markStep(snapshot.plan, "step-plan-pdf", "completed", "step-confirm-pdf", "running"),
        agents: [
          commanderSnapshot("waiting_permission", "Waiting for user approval"),
          fileSnapshot("waiting_permission", `${organizationPlan.fileCount} PDF move(s) planned`),
          verifierSnapshot("queued", "Waiting for permission decision"),
        ],
        fileOrganizationPlan: organizationPlan,
        permissionRequest,
        logs: appendLog(snapshot, {
          id: `${taskId}-permission-requested`,
          kind: "permission",
          title: "permission.requested",
          detail: `${organizationPlan.fileCount} planned move(s) require confirmed_write approval.`,
        }),
      });

      pendingPermissionHandler = async (decision) => {
        const resolvedRequest: ToolPermissionRequest = {
          ...permissionRequest,
          status: decision,
          resolvedAt: new Date().toISOString(),
        };
        pendingPermissionHandler = undefined;

        if (decision === "denied") {
          emit({
            ...snapshot,
            title: "PDF organization denied",
            status: "completed",
            commanderMessage: "Permission was denied. Javis did not move or modify any files.",
            plan: snapshot.plan.map((step) => ({
              ...step,
              status: step.id === "step-execute-pdf" ? "skipped" : "completed",
            })),
            agents: [
              commanderSnapshot("completed", "Permission decision recorded"),
              fileSnapshot("completed", "No write operation executed"),
              verifierSnapshot("completed", "Verified denial record"),
            ],
            permissionRequest: resolvedRequest,
            logs: appendLog(snapshot, {
              id: `${taskId}-permission-denied`,
              kind: "permission",
              title: "permission.resolved",
              detail: `User denied ${permissionRequest.id}; no files were moved.`,
            }),
            verificationSummary: `verified: permission denied; dry-run listed ${organizationPlan.fileCount} affected PDF file(s), and no write operation was executed.`,
          });
          return;
        }

        if (!fileTool.executePdfOrganization) {
          emit({
            ...snapshot,
            title: "PDF organization execution unavailable",
            status: "failed",
            commanderMessage:
              "Permission was approved, but the confirmed-write File Tool is not available.",
            plan: markStep(snapshot.plan, "step-execute-pdf", "failed"),
            agents: [
              commanderSnapshot("completed", "Permission decision recorded"),
              fileSnapshot("failed", "Execution tool unavailable"),
              verifierSnapshot("cancelled", "No write result to verify"),
            ],
            permissionRequest: resolvedRequest,
            logs: appendLog(snapshot, {
              id: `${taskId}-execute-missing`,
              kind: "tool",
              title: "task.failed",
              detail: "file.executePdfOrganization is not configured.",
            }),
          });
          return;
        }

        emit({
          ...snapshot,
          title: "Executing approved PDF organization",
          status: "running",
          commanderMessage:
            "Permission was approved. File Agent is moving only the paths from the current dry-run plan.",
          plan: markStep(snapshot.plan, "step-confirm-pdf", "completed", "step-execute-pdf", "running"),
          agents: [
            commanderSnapshot("completed", "Permission decision recorded"),
            fileSnapshot("running", "Executing approved PDF moves"),
            verifierSnapshot("queued", "Waiting for move results"),
          ],
          permissionRequest: resolvedRequest,
          logs: appendLog(snapshot, {
            id: `${taskId}-execute-started`,
            kind: "permission",
            title: "permission.resolved",
            detail: `User approved ${permissionRequest.id}; executing exactly ${organizationPlan.fileCount} planned move(s).`,
          }),
        });

        try {
          const execution = await fileTool.executePdfOrganization(
            organizationPlan.dryRun.affectedPaths,
            organizationPlan.approvalId,
          );
          const verificationStatus = execution.failedCount === 0 ? "completed" : "failed";

          emit({
            ...snapshot,
            title:
              verificationStatus === "completed"
                ? "PDF organization completed"
                : "PDF organization completed with failures",
            status: verificationStatus,
            commanderMessage:
              verificationStatus === "completed"
                ? "Approved PDF moves finished and Verifier checked the execution summary."
                : "Approved PDF moves finished, but at least one operation failed.",
            plan:
              verificationStatus === "completed"
                ? snapshot.plan.map((step) => ({ ...step, status: "completed" }))
                : markStep(snapshot.plan, "step-verify-pdf", "failed"),
            agents: [
              commanderSnapshot("completed", "Task finished"),
              fileSnapshot("completed", `${execution.movedCount} moved, ${execution.skippedCount} skipped`),
              verifierSnapshot(
                verificationStatus === "completed" ? "completed" : "failed",
                `${execution.failedCount} failed`,
              ),
            ],
            fileOrganizationExecution: execution,
            permissionRequest: resolvedRequest,
            logs: [
              ...appendLog(snapshot, {
                id: `${taskId}-execute-done`,
                kind: "tool",
                title: "tool_call.updated",
                detail: `file.executePdfOrganization moved=${execution.movedCount}, skipped=${execution.skippedCount}, failed=${execution.failedCount}.`,
              }),
              ...execution.results.map((result, index) => ({
                id: `${taskId}-move-${index}`,
                kind: "tool" as const,
                title: `${result.status}: ${result.source}`,
                detail: `${result.target} - ${result.message}`,
              })),
            ],
            verificationSummary: `${verificationStatus === "completed" ? "verified" : "failed"}: ${execution.movedCount}/${execution.attemptedCount} PDF move(s) completed, ${execution.skippedCount} skipped, ${execution.failedCount} failed.`,
          });
        } catch (error) {
          emit({
            ...snapshot,
            title: "PDF organization execution failed",
            status: "failed",
            commanderMessage:
              "The approved write step failed. Verifier has no completed move result to validate.",
            plan: markStep(snapshot.plan, "step-execute-pdf", "failed"),
            agents: [
              commanderSnapshot("completed", "Permission decision recorded"),
              fileSnapshot("failed", "Approved move failed"),
              verifierSnapshot("cancelled", "No complete result to verify"),
            ],
            permissionRequest: resolvedRequest,
            logs: appendLog(snapshot, {
              id: `${taskId}-execute-failed`,
              kind: "tool",
              title: "task.failed",
              detail: error instanceof Error ? error.message : String(error),
            }),
          });
        }
      };
    } catch (error) {
      emit({
        ...snapshot,
        title: "PDF organization preview failed",
        status: "failed",
        commanderMessage:
          "File Agent could not create the dry-run. The task stopped without moving files.",
        plan: markStep(snapshot.plan, "step-plan-pdf", "failed"),
        agents: [
          commanderSnapshot("completed", "Plan submitted"),
          fileSnapshot("failed", "Dry-run failed"),
          verifierSnapshot("cancelled", "No dry-run to verify"),
        ],
        logs: appendLog(snapshot, {
          id: `${taskId}-failed`,
          kind: "tool",
          title: "task.failed",
          detail: error instanceof Error ? error.message : String(error),
        }),
      });
    }
  }

  async function runProjectInspectionTask(
    taskId: ID,
    userGoal: string,
    activeShellTool: ShellTool,
    activeProjectTool: ProjectTool,
  ) {
    const plan = createProjectInspectionPlan();

    emit({
      id: taskId,
      title: "Inspecting project environment",
      userGoal,
      status: "planning",
      commanderMessage:
        "Commander identified a project inspection task and prepared read-only Shell Tool calls.",
      plan,
      agents: [
        commanderSnapshot("planning", "Create project inspection plan"),
        fileSnapshot("queued", "No file scan needed"),
        shellSnapshot("queued", "Waiting for project inspection"),
        verifierSnapshot("queued", "Waiting for command results"),
      ],
      logs: [
        {
          id: `${taskId}-created`,
          kind: "event",
          title: "task.created",
          detail: "Desktop UI passed the project inspection goal to Core.",
        },
      ],
    });

    await wait();

    emit({
      ...snapshot,
      status: "running",
      commanderMessage: "Project Tool is reading package scripts before Shell Agent checks versions.",
      plan: markStep(snapshot.plan, "step-inspect-project", "running"),
      agents: [
        commanderSnapshot("completed", "Plan submitted"),
        fileSnapshot("queued", "No file scan needed"),
        shellSnapshot("running", "Inspecting package scripts"),
        verifierSnapshot("queued", "Waiting for command results"),
      ],
      logs: appendLog(snapshot, {
        id: `${taskId}-project-started`,
        kind: "tool",
        title: "tool_call.planned",
        detail: "project.inspect reads package.json scripts with read permission.",
      }),
    });

    try {
      const project = await activeProjectTool.inspectProject();
      const recommendedTestCommand = createRecommendedCommandRequest(project.recommendedTestCommand);
      const commandRequests = [
        {
          program: "node",
          args: ["--version"],
          workspacePath: null,
        },
        {
          program: "pnpm",
          args: ["--version"],
          workspacePath: null,
        },
        {
          program: "git",
          args: ["status", "--short"],
          workspacePath: null,
        },
        ...(recommendedTestCommand ? [recommendedTestCommand] : []),
      ];

      emit({
        ...snapshot,
        commanderMessage:
          "Project Tool found scripts and recommended commands. Shell Agent is running allowlisted checks.",
        plan: markStep(snapshot.plan, "step-inspect-project", "completed", "step-read-env", "running"),
        agents: [
          commanderSnapshot("completed", "Plan submitted"),
          fileSnapshot("queued", "No file scan needed"),
          shellSnapshot("running", "Running node/pnpm/git read-only checks"),
          verifierSnapshot("queued", "Waiting for command results"),
        ],
        project,
        logs: appendLog(snapshot, {
          id: `${taskId}-project-done`,
          kind: "tool",
          title: "tool_call.updated",
          detail: `project.inspect found ${project.scripts.length} package script(s).`,
        }),
      });

      const commands = await Promise.all(
        commandRequests.map((request) => activeShellTool.runReadOnlyCommand(request)),
      );

      emit({
        ...snapshot,
        title: "Verifying project environment",
        status: "verifying",
        commanderMessage: "Verifier is checking command exit codes and output summaries.",
        plan: markStep(snapshot.plan, "step-read-env", "completed", "step-verify-env", "running"),
        agents: [
          commanderSnapshot("completed", "Waiting for verification"),
          fileSnapshot("queued", "No file scan needed"),
          shellSnapshot("completed", "Read-only commands completed"),
          verifierSnapshot("verifying", "Checking exit codes"),
        ],
        commands,
        project: snapshot.project,
        logs: [
          ...appendLog(snapshot, {
            id: `${taskId}-commands-done`,
            kind: "tool",
            title: "tool_call.updated",
            detail: `Shell Tool completed ${commands.length} read-only commands.`,
          }),
          ...commands.map((command, index) => ({
            id: `${taskId}-command-${index}`,
            kind: "tool" as const,
            title: command.command,
            detail: `exit=${command.exitCode ?? "unknown"} stdout=${command.stdout || "(empty)"}`,
          })),
        ],
      });

      await wait();

      const passingCount = commands.filter((command) => command.exitCode === 0).length;
      const verificationStatus = passingCount === commands.length ? "completed" : "failed";
      emit({
        ...snapshot,
        title:
          verificationStatus === "completed"
            ? "Project environment inspected"
            : "Project environment check failed",
        status: verificationStatus,
        commanderMessage:
          verificationStatus === "completed"
            ? "Project inspection completed through the Tauri desktop process and a read-only command allowlist."
            : "Project inspection finished, but Verifier found a failing command.",
        plan:
          verificationStatus === "completed"
            ? snapshot.plan.map((step) => ({ ...step, status: "completed" }))
            : markStep(snapshot.plan, "step-verify-env", "failed"),
        agents: [
          commanderSnapshot("completed", "Task finished"),
          fileSnapshot("queued", "No file scan needed"),
          shellSnapshot("completed", "Read-only command checks completed"),
          verifierSnapshot(
            verificationStatus === "completed" ? "completed" : "failed",
            `${passingCount}/${commands.length} commands passed`,
          ),
        ],
        project: snapshot.project,
        logs: appendLog(snapshot, {
          id: `${taskId}-done`,
          kind: "verification",
          title:
            verificationStatus === "completed" ? "task.completed" : "verification.failed",
          detail: `Verifier checked ${passingCount}/${commands.length} command results.`,
        }),
        verificationSummary: `${verificationStatus === "completed" ? "verified" : "failed"}: ${passingCount}/${commands.length} read-only commands exited successfully. Start: ${project.recommendedStartCommand ?? "not found"}. Test/check: ${project.recommendedTestCommand ?? "not found"}.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({
        ...snapshot,
        title: "Project inspection failed",
        status: "failed",
        commanderMessage:
          "Shell Agent inspection failed. The task stopped without running any write operation.",
        plan: markStep(snapshot.plan, "step-read-env", "failed"),
        agents: [
          commanderSnapshot("completed", "Plan submitted"),
          fileSnapshot("queued", "No file scan needed"),
          shellSnapshot("failed", "Read-only command failed"),
          verifierSnapshot("cancelled", "No result to verify"),
        ],
        logs: appendLog(snapshot, {
          id: `${taskId}-failed`,
          kind: "tool",
          title: "task.failed",
          detail: message,
        }),
      });
    }
  }

  async function runCodeReviewTask(taskId: ID, userGoal: string, activeCodeTool: CodeTool, activeShellTool: ShellTool) {
    const plan = createCodeReviewPlan();

    emit({
      id: taskId,
      title: "Reviewing code changes",
      userGoal,
      status: "planning",
      commanderMessage:
        "Commander identified a code review goal and will collect a diff preview before read-only verification.",
      plan,
      agents: [
        commanderSnapshot("planning", "Create code review plan"),
        codeSnapshot("queued", "Waiting for repository diff preview"),
        verifierSnapshot("queued", "Waiting for diff evidence"),
      ],
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
      agents: [
        commanderSnapshot("completed", "Plan submitted"),
        codeSnapshot("running", "Collecting repository diff preview"),
        verifierSnapshot("queued", "Waiting for diff evidence"),
      ],
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
          agents: [
            commanderSnapshot("completed", "Task finished"),
            codeSnapshot("completed", "No local diff"),
            verifierSnapshot("completed", "Verified no-op result"),
          ],
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

      const permissionRequest: ToolPermissionRequest = {
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
        status: "pending",
        createdAt: new Date().toISOString(),
      };

      emit({
        ...snapshot,
        title: "Code review preview ready",
        status: "waiting_permission",
        commanderMessage:
          "Diff preview is ready. Review the changed files before approving the read-only verification check.",
        plan: markStep(snapshot.plan, "step-inspect-code", "completed", "step-review-code", "running"),
        agents: [
          commanderSnapshot("waiting_permission", "Waiting for code review approval"),
          codeSnapshot("completed", "Repository diff preview collected"),
          verifierSnapshot("queued", "Waiting for approval"),
        ],
        codeReviewPreview,
        permissionRequest,
        logs: appendLog(snapshot, {
          id: `${taskId}-permission-requested`,
          kind: "permission",
          title: "permission.requested",
          detail: `${changedFileCount} changed file(s) require review before verification continues.`,
        }),
      });

      pendingPermissionHandler = async (decision) => {
        const resolvedRequest: ToolPermissionRequest = {
          ...permissionRequest,
          status: decision,
          resolvedAt: new Date().toISOString(),
        };
        pendingPermissionHandler = undefined;

        if (decision === "denied") {
          emit({
            ...snapshot,
            title: "Code review denied",
            status: "completed",
            commanderMessage:
              "Permission was denied. Javis kept the diff preview read-only and did not run verification.",
            plan: snapshot.plan.map((step) => ({
              ...step,
              status: step.id === "step-verify-code" ? "skipped" : "completed",
            })),
            agents: [
              commanderSnapshot("completed", "Permission decision recorded"),
              codeSnapshot("completed", "Diff preview kept read-only"),
              verifierSnapshot("completed", "Verified denial record"),
            ],
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
          agents: [
            commanderSnapshot("completed", "Permission decision recorded"),
            codeSnapshot("running", "Running read-only diff verification"),
            verifierSnapshot("queued", "Waiting for diff check result"),
          ],
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

          emit({
            ...snapshot,
            title:
              verificationStatus === "completed"
                ? "Code review completed"
                : "Code review verification failed",
            status: verificationStatus,
            commanderMessage:
              verificationStatus === "completed"
                ? "Code Agent reviewed the current diff and the read-only verification check passed."
                : "Code Agent reviewed the current diff, but the read-only verification check failed.",
            plan:
              verificationStatus === "completed"
                ? snapshot.plan.map((step) => ({ ...step, status: "completed" }))
                : markStep(snapshot.plan, "step-verify-code", "failed"),
            agents: [
              commanderSnapshot(
                verificationStatus === "completed" ? "completed" : "failed",
                verificationStatus === "completed" ? "Task finished" : "Verification failed",
              ),
              codeSnapshot("completed", "Diff preview reviewed"),
              verifierSnapshot(
                verificationStatus === "completed" ? "completed" : "failed",
                `${verification.exitCode ?? "unknown"} diff check exit code`,
              ),
            ],
            codeReviewPreview,
            commands: [verification],
            permissionRequest: resolvedRequest,
            logs: appendLog(snapshot, {
              id: `${taskId}-done`,
              kind: "verification",
              title:
                verificationStatus === "completed" ? "task.completed" : "verification.failed",
              detail: `Verifier checked the repository diff with exit code ${verification.exitCode ?? "unknown"}.`,
            }),
            verificationSummary:
              verificationStatus === "completed"
                ? `verified: ${changedFileCount} changed file(s) reviewed and git diff --check passed.`
                : `failed: ${changedFileCount} changed file(s) reviewed and git diff --check returned exit code ${verification.exitCode ?? "unknown"}.`,
          });
        } catch (error) {
          emit({
            ...snapshot,
            title: "Code review verification failed",
            status: "failed",
            commanderMessage:
              "Code Agent reviewed the diff preview, but the read-only verification command failed to run.",
            plan: markStep(snapshot.plan, "step-verify-code", "failed"),
            agents: [
              commanderSnapshot("completed", "Permission decision recorded"),
              codeSnapshot("completed", "Diff preview reviewed"),
              verifierSnapshot("failed", "Verification command failed"),
            ],
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
      };
    } catch (error) {
      emit({
        ...snapshot,
        title: "Code review preview failed",
        status: "failed",
        commanderMessage:
          "Code Agent could not collect a diff preview. Check repository access or try a narrower code review goal.",
        plan: markStep(snapshot.plan, "step-inspect-code", "failed"),
        agents: [
          commanderSnapshot("completed", "Plan submitted"),
          codeSnapshot("failed", "Diff preview unavailable"),
          verifierSnapshot("cancelled", "No diff to verify"),
        ],
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

    emit({
      id: taskId,
      title: "Searching research sources",
      userGoal,
      status: "planning",
      commanderMessage:
        "Commander identified a research goal and prepared read-only public source search.",
      plan,
      agents: [
        commanderSnapshot("planning", "Create research source plan"),
        researchSnapshot("queued", "Waiting for public source search"),
        verifierSnapshot("queued", "Waiting for source evidence"),
      ],
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
      agents: [
        commanderSnapshot("completed", "Plan submitted"),
        researchSnapshot("running", "Searching public sources"),
        verifierSnapshot("queued", "Waiting for sources"),
      ],
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
          agents: [
            commanderSnapshot("completed", "Plan submitted"),
            researchSnapshot("failed", "No search results"),
            verifierSnapshot("cancelled", "No source to verify"),
          ],
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
        agents: [
          commanderSnapshot("completed", "Plan submitted"),
          researchSnapshot("running", `Fetching ${urls.length} selected source(s)`),
          verifierSnapshot("queued", "Waiting for sources"),
        ],
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
        agents: [
          commanderSnapshot("completed", "Waiting for verification"),
          researchSnapshot("completed", `Fetched ${sources.length} source(s)`),
          verifierSnapshot("verifying", "Checking source evidence"),
        ],
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
        agents: [
          commanderSnapshot(
            verificationStatus === "completed" ? "completed" : "failed",
            verificationStatus === "completed" ? "Task finished" : "Verification failed",
          ),
          researchSnapshot("completed", "Source collection completed"),
          verifierSnapshot(
            verificationStatus === "completed" ? "completed" : "failed",
            `${reportEvidenceCount}/${researchReport.rows.length} claims verified`,
          ),
        ],
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
        agents: [
          commanderSnapshot("completed", "Plan submitted"),
          researchSnapshot("failed", "Source search failed"),
          verifierSnapshot("cancelled", "No source to verify"),
        ],
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

    emit({
      id: taskId,
      title: "Collecting research sources",
      userGoal,
      status: "planning",
      commanderMessage:
        "Commander found user-provided URLs and prepared read-only source collection.",
      plan,
      agents: [
        commanderSnapshot("planning", "Create research source plan"),
        researchSnapshot("queued", `Waiting to fetch ${urls.length} source(s)`),
        verifierSnapshot("queued", "Waiting for source evidence"),
      ],
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
      agents: [
        commanderSnapshot("completed", "Plan submitted"),
        researchSnapshot("running", "Fetching public URL sources"),
        verifierSnapshot("queued", "Waiting for sources"),
      ],
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
        agents: [
          commanderSnapshot("completed", "Waiting for verification"),
          researchSnapshot("completed", `Fetched ${sources.length} source(s)`),
          verifierSnapshot("verifying", "Checking source evidence"),
        ],
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
        agents: [
          commanderSnapshot(
            verificationStatus === "completed" ? "completed" : "failed",
            verificationStatus === "completed" ? "Task finished" : "Verification failed",
          ),
          researchSnapshot("completed", "Source collection completed"),
          verifierSnapshot(
            verificationStatus === "completed" ? "completed" : "failed",
            `${reportEvidenceCount}/${researchReport.rows.length} claims verified`,
          ),
        ],
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
        agents: [
          commanderSnapshot("completed", "Plan submitted"),
          researchSnapshot("failed", "Source fetch failed"),
          verifierSnapshot("cancelled", "No source to verify"),
        ],
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
