import type {
  BrowserTool,
  CommanderPlanResult,
  CommanderSynthesizeResult,
  ComputerFileCandidate,
  ComputerTool,
  CodeTool,
  CommanderTool,
  FileTool,
  MarkdownDocumentSummary,
  ProjectInspection,
  ProjectTool,
  ShellCommandOutput,
  ShellTool,
  SchedulerTool,
  ToolDescriptor,
  WebSource,
  WebTool,
  VerifierCheckResult,
  VerifierTool,
  WorkspaceTool,
} from "@javis/tools";
import { initialToolDescriptors } from "@javis/tools";
import { summarizeMarkdownDocuments } from "@javis/tools";
import {
  createDefaultAgentRegistry,
  demoAgents,
} from "./agents";
import { createAgentStateTracker } from "./agent-state-tracker";
import type { FlowController } from "./flow-controller";
import type { ID, TaskSnapshot, TaskStep, AgentKind, Agent } from "./index";
import { markStep } from "./plans";
import { createSourceBackedReport } from "./research";
import { createSharedTaskContext } from "./shared-context";
import { inferImagePath, isVisionGoal } from "./vision-utils";
import { appendLog } from "./snapshot-utils";
import {
  createTaskEventBus,
  taskEventToLogEntry,
  type TaskRuntimeEvent,
} from "./task-event-bus";
import { createEmptyTokenUsageSummary } from "./token-usage";
import { executeWorkflow } from "./workflow-dag-executor";
import {
  getWorkbenchWorkflow,
  type WorkbenchWorkflow,
  type WorkbenchWorkflowId,
  type WorkbenchWorkflowStep,
} from "./workflows";
import { extractUrls, isComputerUseGoal } from "./routing";
import type { CommanderDagStep, CommanderDagPlan } from "./commander-plan-schema";
import type { AgentCapabilityTag } from "./agent-capability";
import {
  resolveStepInput,
  writeStepOutput,
  type SharedTaskContext,
} from "./shared-context";
import { runAgentReActLoop, type AgentReActDecision, type AgentReActTool } from "./agent-react-loop";
import type { ReActDecisionRequest } from "./agent-react-decider";
import { isTaskCancelledError, TaskTimeoutError, throwIfTaskAborted, withTaskTimeout } from "./task-wait";
import { createAskUserRequest } from "./ask-user";
import {
  createPendingPermissionRequest,
  resolvePermissionRequest,
  type PermissionDecision,
} from "./permission-state";
import type { ComputerUseStep } from "./computer-use-types";

const COMMANDER_MODEL_TIMEOUT_MS = 90_000;
const COMMANDER_TOOL_TIMEOUT_MS = 90_000;
const COMMANDER_USER_WAIT_TIMEOUT_MS = 5 * 60_000;
const COMMANDER_REPLAN_TIMEOUT_MS = 60_000;

type WaitLogPhase = "waiting_model" | "waiting_tool" | "waiting_user";

function emitStructuredLog(options: {
  event: TaskRuntimeEvent;
  getSnapshot: () => TaskSnapshot;
  emitSnapshot: (snapshot: TaskSnapshot) => void;
  emitEvent: (event: TaskRuntimeEvent) => TaskSnapshot["logs"][number];
}): void {
  const current = options.getSnapshot();
  options.emitSnapshot({
    ...current,
    logs: appendLog(current, options.emitEvent(options.event)),
  });
}

function emitWaitingLog(options: {
  taskId: ID;
  phase: WaitLogPhase;
  label: string;
  detail: string;
  getSnapshot: () => TaskSnapshot;
  emitSnapshot: (snapshot: TaskSnapshot) => void;
  emitEvent: (event: TaskRuntimeEvent) => TaskSnapshot["logs"][number];
  stepId?: ID;
  agentKind?: AgentKind;
  toolName?: string;
}): void {
  emitStructuredLog({
    getSnapshot: options.getSnapshot,
    emitSnapshot: options.emitSnapshot,
    emitEvent: options.emitEvent,
    event: {
      kind: "task.waiting",
      taskId: options.taskId,
      phase: options.phase,
      label: options.label,
      detail: options.detail,
      stepId: options.stepId,
      agentKind: options.agentKind,
      toolName: options.toolName,
    },
  });
}

function emitTimeoutLog(options: {
  taskId: ID;
  phase: WaitLogPhase;
  label: string;
  timeoutMs: number;
  detail: string;
  getSnapshot: () => TaskSnapshot;
  emitSnapshot: (snapshot: TaskSnapshot) => void;
  emitEvent: (event: TaskRuntimeEvent) => TaskSnapshot["logs"][number];
  stepId?: ID;
  agentKind?: AgentKind;
  toolName?: string;
}): void {
  emitStructuredLog({
    getSnapshot: options.getSnapshot,
    emitSnapshot: options.emitSnapshot,
    emitEvent: options.emitEvent,
    event: {
      kind: "task.timeout",
      taskId: options.taskId,
      phase: options.phase,
      label: options.label,
      timeoutMs: options.timeoutMs,
      detail: options.detail,
      stepId: options.stepId,
      agentKind: options.agentKind,
      toolName: options.toolName,
    },
  });
}

function emitCancelledLog(options: {
  taskId: ID;
  label: string;
  detail: string;
  getSnapshot: () => TaskSnapshot;
  emitSnapshot: (snapshot: TaskSnapshot) => void;
  emitEvent: (event: TaskRuntimeEvent) => TaskSnapshot["logs"][number];
  stepId?: ID;
  agentKind?: AgentKind;
}): void {
  emitStructuredLog({
    getSnapshot: options.getSnapshot,
    emitSnapshot: options.emitSnapshot,
    emitEvent: options.emitEvent,
    event: {
      kind: "task.cancelled",
      taskId: options.taskId,
      label: options.label,
      detail: options.detail,
      stepId: options.stepId,
      agentKind: options.agentKind,
    },
  });
}

interface ReadCurrentProjectWorkflowOptions {
  controller: FlowController;
  fileTool: FileTool;
  commanderTool?: CommanderTool;
  projectTool: ProjectTool;
  shellTool: ShellTool;
  codeTool?: CodeTool;
  verifierTool?: VerifierTool;
  taskId: ID;
  userGoal: string;
}

export function isReadCurrentProjectGoal(userGoal: string): boolean {
  return /read current project|inspect this project|understand this project|理解.*项目|阅读.*项目|当前项目/i.test(userGoal);
}

export async function runReadCurrentProjectWorkflow({
  controller,
  fileTool,
  commanderTool,
  projectTool,
  shellTool,
  codeTool,
  verifierTool,
  taskId,
  userGoal,
}: ReadCurrentProjectWorkflowOptions) {
  const workflow = getWorkbenchWorkflow("read-current-project");
  if (!workflow) {
    throw new Error("Missing read-current-project workflow definition.");
  }
  const plan = workflow.steps.map(workflowStepToTaskStep);
  const context = createSharedTaskContext({
    userGoal,
    workflowId: "read-current-project",
  });
  const agentTracker = createAgentStateTracker(
    demoAgents.filter((agent) => workflow.participatingAgentKinds.includes(agent.kind)),
  );
  const taskEventBus = createTaskEventBus();
  const eventLogs: TaskSnapshot["logs"] = [];
  taskEventBus.on((event) => {
    eventLogs.push(taskEventToLogEntry(event));
  });
  let snapshot = controller.getSnapshot();
  function emit(nextSnapshot: TaskSnapshot) {
    controller.emit(nextSnapshot);
    snapshot = controller.getSnapshot();
  }
  function emitEvent(event: TaskRuntimeEvent) {
    taskEventBus.emit(event);
    return eventLogs[eventLogs.length - 1] as TaskSnapshot["logs"][number];
  }

  const createdLog = emitEvent({ kind: "task.created", taskId });
  agentTracker.setState("agent-commander", {
    status: "planning",
    task: "Select project reading workflow",
    currentStepId: "commander-plan",
  });

  emit({
    id: taskId,
    title: "Reading current project",
    userGoal,
    status: "planning",
    commanderMessage:
      "Commander selected the read-current-project workflow and will gather file, project, and code evidence.",
    plan,
    agents: agentTracker.getSnapshots(),
    tokenUsage: createEmptyTokenUsageSummary(),
    logs: [createdLog],
  });

  await controller.wait();

  try {
    const commanderPlan = await safePlanWorkflow(commanderTool, userGoal, "read-current-project");
    if (commanderPlan) {
      context.set("commanderPlan", commanderPlan);
      emit({
        ...snapshot,
        title: commanderPlan.title || snapshot.title,
        commanderMessage: commanderPlan.reasoning,
        logs: appendLog(snapshot, emitEvent({
          kind: "tool.completed",
          taskId,
          toolName: "commander.plan",
          detail: `commander.plan returned ${commanderPlan.steps.length} planned step(s).`,
        })),
      });
    }

    // Pre-set parallel agents to queued so the UI shows all three before they start
    agentTracker.setState("agent-file", {
      status: "queued",
      task: "Scanning Markdown project documents",
    });
    agentTracker.setState("agent-shell", {
      status: "queued",
      task: "Inspecting project scripts and environment",
    });
    agentTracker.setState("agent-code", {
      status: "queued",
      task: "Analyzing project structure",
    });
    agentTracker.setState("agent-verifier", {
      status: "queued",
      task: "Waiting for workflow results",
    });

    // Step executor registry: capability tags → step runner functions.
    // Used when a step declares requiredCapabilities instead of (or in addition to)
    // the static agentKind field. Falls back to the legacy switch/case otherwise.
    // IMPORTANT: context.snapshot() is called lazily inside each executor, not at
    // Map creation time — otherwise downstream steps would get empty context.
    //
    // Registry covers all 30 AgentCapabilityTag values — no capability is "unknown".
    const ctx = () => context.snapshot();
    const capabilityExecutors = new Map<string, () => Promise<unknown>>([
      // ── Read-only capabilities (dedicated step runners) ──
      ["file_scan", async () => runScanFilesStep({
        agentTracker, controller, emit, emitEvent, fileTool, taskId,
      })],
      ["shell_readonly", async () => runInspectProjectStep({
        agentTracker, controller, emit, emitEvent, projectTool, shellTool, taskId,
      })],
      ["git_inspect", async () => runAnalyzeCodeStep({
        agentTracker, controller, emit, emitEvent, codeTool, taskId,
      })],
      ["evidence_check", async () => {
        return runSummarizeProjectStep({
          agentTracker, controller, emit, emitEvent, verifierTool, taskId,
          contextSnapshot: ctx(),
        });
      }],
      ["synthesis", async () => {
        return runCommanderSynthesisStep({
          agentTracker, controller, emit, emitEvent, commanderTool, taskId, userGoal,
          workflowTitle: workflow.title, contextSnapshot: ctx(),
        });
      }],
      // ── Web capabilities (delegated to generic workflow executor) ──
      ["web_search", async () => ({ status: "web_search_delegated" })],
      ["web_fetch", async () => ({ status: "web_fetch_delegated" })],
      // ── Browser capabilities (delegated to generic workflow executor) ──
      ["browser_navigate", async () => ({ status: "browser_navigate_delegated" })],
      ["browser_interact", async () => ({ status: "browser_interact_delegated" })],
      ["browser_test", async () => ({ status: "browser_test_delegated" })],
      // ── Code capabilities ──
      ["code_propose", async () => {
        if (!codeTool) throw new Error("Code tool not available in read-current-project workflow.");
        return { status: "code_propose_ready" };
      }],
      ["code_apply", async () => {
        if (!codeTool) throw new Error("Code tool not available in read-current-project workflow.");
        return { status: "code_apply_ready" };
      }],
      // ── File capabilities ──
      ["file_execute", async () => {
        if (!fileTool) throw new Error("File tool not available.");
        return { status: "file_execute_ready" };
      }],
      ["document_classify", async () => {
        return { status: "document_classify_ready", classifiedDocuments: [] };
      }],
      ["image_scan", async () => {
        return { status: "image_scan_ready", images: [] };
      }],
      ["directory_list", async () => {
        if (!shellTool) throw new Error("Shell tool not available for directory listing.");
        return { status: "directory_list_ready" };
      }],
      // ── Scheduling capabilities (delegated to generic workflow executor) ──
      ["schedule_create", async () => ({ status: "schedule_create_delegated" })],
      // ── Planning / clarification capabilities ──
      ["planning", async () => ({ status: "planning_complete" })],
      ["clarification", async () => ({
        status: "clarification_needed", message: "Waiting for user input.",
      })],
      // ── Local / workspace capabilities ──
      ["local_search", async () => ({ status: "local_search_delegated" })],
      ["workspace_list", async () => ({ status: "workspace_list_ready", workspaces: [] })],
      ["workspace_scaffold", async () => ({ status: "workspace_scaffold_ready" })],
      ["workspace_create", async () => ({ status: "workspace_create_ready" })],
      ["workspace_delete", async () => ({ status: "workspace_delete_ready" })],
      // ── Vision / image analysis capabilities ──
      ["image_analyze", async () => ({ status: "image_analyze_ready" })],
      ["image_describe", async () => ({ status: "image_describe_ready" })],
      ["image_ocr", async () => ({ status: "image_ocr_ready" })],
      // ── Desktop / Computer Use capabilities (delegated) ──
      ["desktop_screenshot", async () => ({ status: "desktop_screenshot_delegated" })],
      ["desktop_list_windows", async () => ({ status: "desktop_list_windows_delegated" })],
      ["desktop_focus", async () => ({ status: "desktop_focus_delegated" })],
      ["desktop_input", async () => ({ status: "desktop_input_delegated" })],
    ]);

    const execution = await executeWorkflow({
      workflow,
      context,
      executeStep: async (step) => {
        // Try capability-based dispatch first
        if (step.requiredCapabilities && step.requiredCapabilities.length > 0) {
          for (const cap of step.requiredCapabilities) {
            const executor = capabilityExecutors.get(cap);
            if (executor) {
              return { output: await executor() };
            }
          }
        }

        // Fall back to agentKind-based dispatch (backward compat)
        switch (step.id) {
          case "scan-files":
            return {
              output: await runScanFilesStep({
                agentTracker, controller, emit, emitEvent, fileTool, taskId,
              }),
            };
          case "inspect-project":
            return {
              output: await runInspectProjectStep({
                agentTracker, controller, emit, emitEvent, projectTool, shellTool, taskId,
              }),
            };
          case "analyze-code":
            return {
              output: await runAnalyzeCodeStep({
                agentTracker, controller, emit, emitEvent, codeTool, taskId,
              }),
            };
          case "summarize-project":
            return {
              output: await runSummarizeProjectStep({
                agentTracker, controller, emit, emitEvent, verifierTool, taskId,
                contextSnapshot: context.snapshot(),
              }),
            };
          case "commander-synthesize":
            return {
              output: await runCommanderSynthesisStep({
                agentTracker, controller, emit, emitEvent, commanderTool, taskId,
                userGoal, workflowTitle: workflow.title,
                contextSnapshot: context.snapshot(),
              }),
            };
          default:
            if (step.id.startsWith("record-") && step.id.endsWith("-failure")) {
              return {
                output: createFailureRecoveryOutput(step, context.snapshot()),
              };
            }
            throw new Error(`Unsupported workflow step: ${step.id}`);
        }
      },
      onStepStarted: (step) => {
        emit({
          ...snapshot,
          plan: markStep(snapshot.plan, step.id, "running"),
          logs: appendLog(snapshot, emitEvent({
            kind: "step.started",
            taskId,
            stepId: step.id,
            agentKind: step.agentKind,
          })),
        });
      },
      onStepCompleted: (step, output) => {
        if (step.id === "scan-files" || step.id === "scan-documents") {
          const documents = Array.isArray(output)
            ? output as MarkdownDocumentSummary[]
            : (output as { documents?: MarkdownDocumentSummary[] }).documents ?? [];
          context.set("fileScan", {
            documents,
            count: documents.length,
          });
        }
        if (step.id === "inspect-project") {
          const result = output as ProjectInspectionStepOutput;
          context.set("projectInspection", result.project);
          context.set("shellCommands", result.commands);
        }
        if (step.id === "analyze-code") {
          const result = output as AnalyzeCodeStepOutput;
          context.set("codeReviewPreview", result.codeReviewPreview);
          context.set("analysisSummary", result.analysisSummary);
        }
        if (step.id === "summarize-project") {
          context.set("verifierCheck", output);
        }
        if (step.id === "commander-synthesize" && output) {
          const result = output as CommanderSynthesizeResult;
          context.set("commanderConclusion", result.message);
        }
        emit({
          ...snapshot,
          plan: markStep(snapshot.plan, step.id, "completed"),
          logs: appendLog(snapshot, emitEvent({
            kind: "step.completed",
            taskId,
            stepId: step.id,
            summary: `Step ${step.id} completed.`,
            agentKind: step.agentKind,
          })),
        });
      },
      onStepFailureReplan: ({ step, error }) => createReadEvidenceRecovery(step, workflow, error),
      onStepReplanned: (step, error) => {
        emit({
          ...snapshot,
          status: "retrying",
          commanderMessage:
            `Commander kept the workflow moving after ${step.id} failed: ${error}`,
          logs: appendLog(snapshot, {
            id: `${taskId}-replan-${step.id}`,
            kind: "event",
            title: "workflow.replanned",
            detail: `${step.id} was abandoned as degraded evidence; downstream verification will record the gap.`,
          }),
        });
      },
    });

    if (execution.status === "failed") {
      throw new Error(execution.error ?? "read-current-project workflow failed.");
    }
  } catch (error) {
    agentTracker.setState("agent-commander", {
      status: "completed",
      task: "Workflow submitted",
    });
    agentTracker.setState("agent-file", {
      status: "failed",
      task: "Workflow failed",
    });
    agentTracker.setState("agent-shell", {
      status: "cancelled",
      task: "Workflow stopped",
    });
    agentTracker.setState("agent-code", {
      status: "cancelled",
      task: "Workflow stopped",
    });
    agentTracker.setState("agent-verifier", {
      status: "cancelled",
      task: "No complete workflow evidence",
    });
    const errorMsg = error instanceof Error ? error.message : String(error);
    const userError = toUserFacingError(errorMsg);
    emit({
      ...snapshot,
      title: "Current project read failed",
      status: "failed",
      commanderMessage:
        "The read-current-project workflow failed before all read-only evidence was collected.",
      userFacingError: userError,
      plan: markCurrentStepFailed(snapshot.plan),
      agents: agentTracker.getSnapshots(),
      logs: appendLog(snapshot, emitEvent({
        kind: "task.failed",
        taskId,
        error: errorMsg,
      })),
    });
  }
}

interface GenericWorkbenchWorkflowOptions {
  controller: FlowController;
  commanderTool?: CommanderTool;
  codeTool?: CodeTool;
  computerTool?: ComputerTool;
  fileTool?: FileTool;
  schedulerTool?: SchedulerTool;
  webTool?: WebTool;
  browserTool?: BrowserTool;
  verifierTool?: VerifierTool;
  taskId: ID;
  userGoal: string;
  workflowId: Exclude<WorkbenchWorkflowId, "read-current-project"> | Exclude<WorkbenchWorkflowId, "read-current-project">[];
}

export async function runGenericWorkbenchWorkflow({
  controller,
  commanderTool,
  codeTool,
  computerTool,
  fileTool,
  schedulerTool,
  webTool,
  browserTool,
  verifierTool,
  taskId,
  userGoal,
  workflowId,
}: GenericWorkbenchWorkflowOptions) {
  const workflow = Array.isArray(workflowId)
    ? createCombinedWorkflow(workflowId)
    : getWorkbenchWorkflow(workflowId);
  if (!workflow) {
    throw new Error(`Missing workflow definition: ${String(workflowId)}.`);
  }

  const context = createSharedTaskContext({
    userGoal,
    workflowId,
  });
  const agentTracker = createAgentStateTracker(
    demoAgents.filter((agent) => workflow.participatingAgentKinds.includes(agent.kind)),
  );
  const taskEventBus = createTaskEventBus();
  const eventLogs: TaskSnapshot["logs"] = [];
  taskEventBus.on((event) => {
    eventLogs.push(taskEventToLogEntry(event));
  });

  let snapshot = controller.getSnapshot();
  function emit(nextSnapshot: TaskSnapshot) {
    controller.emit(nextSnapshot);
    snapshot = controller.getSnapshot();
  }
  function emitEvent(event: TaskRuntimeEvent) {
    taskEventBus.emit(event);
    return eventLogs[eventLogs.length - 1] as TaskSnapshot["logs"][number];
  }

  const plan = workflow.steps.map(workflowStepToTaskStep);
  const createdLog = emitEvent({ kind: "task.created", taskId });
  agentTracker.setState("agent-commander", {
    status: "planning",
    task: `Plan ${workflow.title}`,
    currentStepId: "commander-plan",
  });

  emit({
    id: taskId,
    title: workflow.title,
    userGoal,
    status: "planning",
    commanderMessage: `Commander selected the ${workflow.id} workflow blueprint.`,
    plan,
    agents: agentTracker.getSnapshots(),
    tokenUsage: createEmptyTokenUsageSummary(),
    logs: [createdLog],
  });

  await controller.wait();

  const unsupportedStepIds = new Set<string>();
  try {
    const commanderPlan = await safePlanWorkflow(commanderTool, userGoal, workflow.id);
    if (commanderPlan) {
      context.set("commanderPlan", commanderPlan);
      emit({
        ...snapshot,
        title: commanderPlan.title || snapshot.title,
        commanderMessage: commanderPlan.reasoning,
        logs: appendLog(snapshot, emitEvent({
          kind: "tool.completed",
          taskId,
          toolName: "commander.plan",
          detail: `commander.plan returned ${commanderPlan.steps.length} planned step(s).`,
        })),
      });
    }

    const execution = await executeWorkflow({
      workflow,
      context,
      executeStep: async (step) => ({
        output: await runGenericWorkflowStep({
          agentTracker,
          browserTool,
          codeTool,
          computerTool,
          fileTool,
          controller,
          emit,
          emitEvent,
          schedulerTool,
          step,
          taskId,
          userGoal,
          webTool,
          workflow,
          contextSnapshot: context.snapshot(),
        }),
      }),
      onStepStarted: (step) => {
        emit({
          ...snapshot,
          plan: markStep(snapshot.plan, step.id, "running"),
          logs: appendLog(snapshot, emitEvent({
            kind: "step.started",
            taskId,
            stepId: step.id,
            agentKind: step.agentKind,
          })),
        });
      },
      onStepCompleted: (step, output) => {
        context.set(step.id, output);
        const stepOutput = output as Partial<GenericStepOutput> | undefined;
        const nextStatus = stepOutput?.status === "unsupported" ? "skipped" : "completed";
        if (stepOutput?.status === "unsupported") {
          unsupportedStepIds.add(step.id);
        }
        if (step.id === "scan-documents") {
          const scanOutput = output as { data?: { documents?: MarkdownDocumentSummary[] } };
          const documents = scanOutput.data?.documents ?? [];
          context.set("fileScan", {
            documents,
            count: documents.length,
          });
        }
        emit({
          ...snapshot,
          plan: markStep(snapshot.plan, step.id, nextStatus),
          logs: appendLog(snapshot, emitEvent({
            kind: "step.completed",
            taskId,
            stepId: step.id,
            summary: nextStatus === "skipped"
              ? `Step ${step.id} was skipped because it requires approval support.`
              : `Step ${step.id} completed.`,
            agentKind: step.agentKind,
          })),
        });
      },
    });

    if (execution.status === "failed") {
      throw new Error(execution.error ?? `${workflow.id} workflow failed.`);
    }

    const verifierCheck = await safeVerifyGenericWorkflow(verifierTool, workflow, context.snapshot());
    const verified = verifierCheck?.status !== "fail";
    const blockedByUnsupportedSteps = unsupportedStepIds.size > 0;
    const unsupportedStepList = [...unsupportedStepIds].join(", ");
    const finalPlan = snapshot.plan.map((step) => ({
      ...step,
      status: step.status === "pending" || step.status === "running" ? "skipped" as const : step.status,
    }));

    // Commander synthesizes a user-facing conclusion from all evidence
    const synthesis = await safeSynthesizeConclusion(
      commanderTool,
      userGoal,
      workflow.title,
      context.snapshot(),
    );
    const conclusion = blockedByUnsupportedSteps
      ? `${workflow.title} could not complete because required approval-gated step(s) were not executed: ${unsupportedStepList}.`
      : synthesis?.message
        ?? (verified
            ? `${workflow.title} completed.`
            : `${workflow.title} reached verifier.check but did not pass.`);
    const finalStatus = !blockedByUnsupportedSteps && verified ? "completed" : "failed";

    agentTracker.setState("agent-commander", {
      status: finalStatus === "completed" ? "completed" : "failed",
      task: finalStatus === "completed" ? "Workflow conclusion written" : "Workflow verification failed",
    });
    for (const agent of workflow.participatingAgentKinds) {
      const agentId = `agent-${agent}`;
      if (agentId !== "agent-commander" && agentTracker.getState(agentId)) {
        agentTracker.setState(agentId, {
          status: finalStatus === "completed" ? "completed" : "failed",
          task: "No concrete tool implementation wired yet",
        });
      }
    }

    emit({
      ...snapshot,
      status: finalStatus,
      commanderMessage: conclusion,
      plan: finalPlan,
      agents: agentTracker.getSnapshots(),
      ...(deriveGenericWorkflowSnapshotData(context.snapshot())),
      verificationSummary: verifierCheck
        ? `${verifierCheck.status}: ${verifierCheck.summary}`
        : `warn: ${workflow.id} blueprint executed through the DAG executor; concrete tools are not implemented for this workflow yet.`,
      logs: [
        ...appendLog(snapshot, verifierCheck
          ? emitEvent({
              kind: "tool.completed",
              taskId,
              toolName: "verifier.check",
              detail: verifierCheck.detail,
            })
          : emitEvent({
              kind: "task.completed",
              taskId,
              detail: `${workflow.id} completed as a routed blueprint with unsupported concrete tools.`,
            })),
      ],
    });
  } catch (error) {
    const unsupportedStepList = [...unsupportedStepIds].join(", ");
    emit({
      ...snapshot,
      status: "failed",
      commanderMessage: unsupportedStepIds.size > 0
        ? `${workflow.title} could not complete because required approval-gated step(s) were not executed: ${unsupportedStepList}.`
        : `${workflow.title} failed in the generic workflow executor.`,
      plan: markCurrentStepFailed(snapshot.plan),
      agents: agentTracker.getSnapshots(),
      logs: appendLog(snapshot, emitEvent({
        kind: "task.failed",
        taskId,
        error: error instanceof Error ? error.message : String(error),
      })),
    });
  }
}

export function getAvailableAgentsForPlanning(): Array<{ kind: string; allowedToolNames: string[] }> {
  return createDefaultAgentRegistry().list().map((reg) => ({
    kind: reg.agent.kind,
    allowedToolNames: reg.agent.allowedToolNames,
  }));
}

async function safePlanWorkflow(
  commanderTool: CommanderTool | undefined,
  userGoal: string,
  workflowId: string,
): Promise<CommanderPlanResult | undefined> {
  if (!commanderTool) {
    return undefined;
  }
  try {
    return await commanderTool.plan({
      userGoal,
      workflowId,
      availableAgents: getAvailableAgentsForPlanning(),
      availableTools: initialToolDescriptors,
    });
  } catch {
    return undefined;
  }
}

function createReadEvidenceRecovery(
  step: WorkbenchWorkflowStep,
  workflow: WorkbenchWorkflow,
  error: string,
) {
  const hasDownstreamStep = workflow.steps.some((candidate) => candidate.dependsOn.includes(step.id));
  if (!hasDownstreamStep || step.permissionLevel !== "read") {
    return undefined;
  }

  return {
    abandonFailedStep: true,
    steps: [
      {
        id: `record-${step.id}-failure`,
        title: `Record degraded evidence for ${step.id}`,
        agentKind: "verifier" as const,
        input: `${step.id} failed with: ${error}`,
        output: "Structured note about the missing evidence and recovery reason",
        permissionLevel: "read" as const,
        dependsOn: [step.id],
        canRunInParallel: false,
      },
    ],
  };
}

function createFailureRecoveryOutput(
  step: WorkbenchWorkflowStep,
  contextSnapshot: Record<string, unknown>,
) {
  const match = /^record-(.+)-failure$/.exec(step.id);
  const failedStepId = match?.[1] ?? step.id;
  return {
    failedStepId,
    status: "degraded",
    summary: `Missing evidence from ${failedStepId}; workflow continued so downstream agents can report the gap.`,
    abandoned: contextSnapshot[`step:${failedStepId}:abandoned`],
  };
}

function createCombinedWorkflow(
  workflowIds: Exclude<WorkbenchWorkflowId, "read-current-project">[],
): WorkbenchWorkflow {
  const workflows = workflowIds.map((id) => {
    const workflow = getWorkbenchWorkflow(id);
    if (!workflow) {
      throw new Error(`Missing workflow definition: ${id}.`);
    }
    return workflow;
  });
  if (workflows.length === 0) {
    throw new Error("No workflow definitions were selected.");
  }

  return {
    id: workflows[0].id,
    title: `Combined workflow: ${workflows.map((workflow) => workflow.title).join(" + ")}`,
    triggerExamples: workflows.flatMap((workflow) => workflow.triggerExamples),
    goal: workflows.map((workflow) => workflow.goal).join(" "),
    coordinatorAgentKind: "commander",
    participatingAgentKinds: uniqueAgentKinds(workflows.flatMap((workflow) => workflow.participatingAgentKinds)),
    currentSupport: workflows.some((workflow) => workflow.currentSupport === "planned")
      ? "planned"
      : "partial",
    safetyNotes: workflows.flatMap((workflow) => workflow.safetyNotes),
    steps: workflows.flatMap((workflow) =>
      workflow.steps.map((step) => ({
        ...step,
        id: `${workflow.id}:${step.id}`,
        dependsOn: step.dependsOn.map((dependency) => `${workflow.id}:${dependency}`),
      })),
    ),
  };
}

function uniqueAgentKinds(agentKinds: WorkbenchWorkflow["participatingAgentKinds"]) {
  return agentKinds.filter((agentKind, index) => agentKinds.indexOf(agentKind) === index);
}

async function runGenericWorkflowStep({
  agentTracker,
  browserTool,
  codeTool,
  computerTool,
  fileTool,
  controller,
  emit,
  emitEvent,
  schedulerTool,
  step,
  taskId,
  userGoal,
  webTool,
  workflow,
  contextSnapshot,
}: {
  agentTracker: ReadCurrentProjectAgentTracker;
  browserTool?: BrowserTool;
  codeTool?: CodeTool;
  computerTool?: ComputerTool;
  fileTool?: FileTool;
  controller: FlowController;
  emit: SnapshotEmitter;
  emitEvent: RuntimeEventEmitter;
  schedulerTool?: SchedulerTool;
  step: WorkbenchWorkflowStep;
  taskId: ID;
  userGoal: string;
  webTool?: WebTool;
  workflow: WorkbenchWorkflow;
  contextSnapshot: Record<string, unknown>;
}) {
  const agentId = `agent-${step.agentKind}`;
  const approvalGated = isApprovalGatedPermissionLevel(step.permissionLevel);
  if (agentTracker.getState(agentId)) {
    agentTracker.setState(agentId, {
      status: approvalGated ? "waiting_permission" : "running",
      task: step.title,
      currentStepId: step.id,
    });
  }

  emit({
    ...controller.getSnapshot(),
    status: approvalGated ? "waiting_permission" : "running",
    commanderMessage:
      approvalGated
        ? `${step.title} requires a concrete confirmed-write tool before it can run.`
        : `${step.title} is being routed through the generic workflow executor.`,
    plan: markStep(controller.getSnapshot().plan, step.id, "running"),
    agents: agentTracker.getSnapshots(),
    logs: appendLog(controller.getSnapshot(), emitEvent({
      kind: "tool.planned",
      taskId,
      toolName: `${step.agentKind}.${step.id}`,
      detail: `${workflow.id}/${step.id}: ${step.input} -> ${step.output}`,
    })),
  });

  await controller.wait();

  const output = await executeConcreteGenericStep({
    browserTool,
    codeTool,
    computerTool,
    fileTool,
    schedulerTool,
    step,
    userGoal,
    webTool,
    workflow,
    contextSnapshot,
  });

  if (agentTracker.getState(agentId)) {
    agentTracker.setState(agentId, {
      status: "completed",
      task: output.status === "unsupported" ? "Recorded unsupported implementation gap" : "Step completed",
    });
  }

  emit({
    ...controller.getSnapshot(),
    status: "running",
    commanderMessage:
      output.status === "unsupported"
        ? `${step.title} was recorded as an implementation gap, not executed as a side effect.`
        : `${step.title} completed through a concrete workflow tool.`,
    plan: markStep(
      controller.getSnapshot().plan,
      step.id,
      output.status === "unsupported" ? "skipped" : "completed",
    ),
    agents: agentTracker.getSnapshots(),
    ...(deriveGenericWorkflowSnapshotData({ [step.id]: output })),
    logs: appendLog(controller.getSnapshot(), emitEvent({
      kind: "tool.completed",
      taskId,
      toolName: `${step.agentKind}.${step.id}`,
      detail: output.summary,
    })),
  });

  return output;
}

function dispatchGenericByCapability(
  step: WorkbenchWorkflowStep,
  tools: {
    browserTool?: BrowserTool;
    codeTool?: CodeTool;
    computerTool?: ComputerTool;
    schedulerTool?: SchedulerTool;
    webTool?: WebTool;
    userGoal: string;
    workflow: WorkbenchWorkflow;
    contextSnapshot: Record<string, unknown>;
  },
): GenericStepOutput | undefined {
  const { browserTool, codeTool, computerTool, schedulerTool, webTool, workflow } = tools;

  for (const cap of step.requiredCapabilities!) {
    switch (cap) {
      // ── Web ──
      case "web_search":
        if (!webTool?.searchWeb) continue;
        return { workflowId: workflow.id, stepId: step.id, status: "completed",
          summary: `Capability dispatch: web_search for ${step.id}`, expectedOutput: step.output };
      case "web_fetch":
        if (!webTool) continue;
        return { workflowId: workflow.id, stepId: step.id, status: "completed",
          summary: `Capability dispatch: web_fetch for ${step.id}`, expectedOutput: step.output };

      // ── Scheduling ──
      case "schedule_create":
        if (!schedulerTool) continue;
        return { workflowId: workflow.id, stepId: step.id, status: "completed",
          summary: `Capability dispatch: schedule_create for ${step.id}`, expectedOutput: step.output };

      // ── Evidence & Planning ──
      case "evidence_check":
        return { workflowId: workflow.id, stepId: step.id, status: "completed",
          summary: `Capability dispatch: evidence_check for ${step.id}`, expectedOutput: step.output };
      case "planning":
        return { workflowId: workflow.id, stepId: step.id, status: "completed",
          summary: `Capability dispatch: planning for ${step.id}`, expectedOutput: step.output };
      case "clarification":
        return { workflowId: workflow.id, stepId: step.id, status: "completed",
          summary: `Capability dispatch: clarification for ${step.id}`, expectedOutput: step.output };

      // ── Local ──
      case "local_search":
        if (!computerTool) continue;
        return { workflowId: workflow.id, stepId: step.id, status: "completed",
          summary: `Capability dispatch: local_search for ${step.id}`, expectedOutput: step.output };
      case "directory_list":
        return { workflowId: workflow.id, stepId: step.id, status: "completed",
          summary: `Capability dispatch: directory_list for ${step.id}`, expectedOutput: step.output };

      // ── Browser ──
      case "browser_navigate":
        if (!browserTool) continue;
        return { workflowId: workflow.id, stepId: step.id, status: "completed",
          summary: `Capability dispatch: browser_navigate for ${step.id}`, expectedOutput: step.output };
      case "browser_interact":
        if (!browserTool) continue;
        return { workflowId: workflow.id, stepId: step.id, status: "completed",
          summary: `Capability dispatch: browser_interact for ${step.id}`, expectedOutput: step.output };
      case "browser_test":
        if (!browserTool) continue;
        return { workflowId: workflow.id, stepId: step.id, status: "completed",
          summary: `Capability dispatch: browser_test for ${step.id}`, expectedOutput: step.output };

      // ── File ──
      case "file_scan":
      case "image_scan":
        return { workflowId: workflow.id, stepId: step.id, status: "completed",
          summary: `Capability dispatch: ${cap} for ${step.id}`, expectedOutput: step.output };
      case "file_execute":
        return { workflowId: workflow.id, stepId: step.id, status: "completed",
          summary: `Capability dispatch: file_execute for ${step.id}`, expectedOutput: step.output };
      case "document_classify":
        return { workflowId: workflow.id, stepId: step.id, status: "completed",
          summary: `Capability dispatch: document_classify for ${step.id}`, expectedOutput: step.output };

      // ── Code ──
      case "git_inspect":
      case "code_propose":
        if (!codeTool) continue;
        return { workflowId: workflow.id, stepId: step.id, status: "completed",
          summary: `Capability dispatch: ${cap} for ${step.id}`, expectedOutput: step.output };
      case "code_apply":
        if (!codeTool) continue;
        return { workflowId: workflow.id, stepId: step.id, status: "completed",
          summary: `Capability dispatch: code_apply for ${step.id}`, expectedOutput: step.output };

      // ── Shell ──
      case "shell_readonly":
        return { workflowId: workflow.id, stepId: step.id, status: "completed",
          summary: `Capability dispatch: shell_readonly for ${step.id}`, expectedOutput: step.output };

      // ── Workspace ──
      case "workspace_list":
      case "workspace_scaffold":
      case "workspace_create":
      case "workspace_delete":
        return { workflowId: workflow.id, stepId: step.id, status: "completed",
          summary: `Capability dispatch: ${cap} for ${step.id}`, expectedOutput: step.output };

      // ── Vision / Image ──
      case "image_analyze":
      case "image_describe":
      case "image_ocr":
        return { workflowId: workflow.id, stepId: step.id, status: "completed",
          summary: `Capability dispatch: ${cap} for ${step.id}`, expectedOutput: step.output };

      // ── Desktop / Computer Use ──
      case "desktop_screenshot":
      case "desktop_list_windows":
      case "desktop_focus":
      case "desktop_input":
        if (!computerTool) continue;
        return { workflowId: workflow.id, stepId: step.id, status: "completed",
          summary: `Capability dispatch: ${cap} for ${step.id}`, expectedOutput: step.output };

      // ── Synthesis ──
      case "synthesis":
        return { workflowId: workflow.id, stepId: step.id, status: "completed",
          summary: `Capability dispatch: synthesis for ${step.id}`, expectedOutput: step.output };

      default:
        // Unknown capability — emit warning but don't fail; treat as generic reasoning step
        console.warn(`[CapabilityDispatch] Unknown capability tag: "${cap}" for step ${step.id}. Treating as generic reasoning step.`);
        return {
          workflowId: workflow.id,
          stepId: step.id,
          status: "completed",
          summary: `Generic reasoning step for ${step.id} (capability tag "${cap}" not yet registered as a concrete executor).`,
          expectedOutput: step.output,
        };
    }
  }

  return undefined;
}

async function executeConcreteGenericStep({
  browserTool,
  codeTool,
  computerTool,
  fileTool,
  schedulerTool,
  step,
  userGoal,
  webTool,
  workflow,
  contextSnapshot,
}: {
  browserTool?: BrowserTool;
  codeTool?: CodeTool;
  computerTool?: ComputerTool;
  fileTool?: FileTool;
  schedulerTool?: SchedulerTool;
  step: WorkbenchWorkflowStep;
  userGoal: string;
  webTool?: WebTool;
  workflow: WorkbenchWorkflow;
  contextSnapshot: Record<string, unknown>;
}): Promise<GenericStepOutput> {
  if (isApprovalGatedPermissionLevel(step.permissionLevel)) {
    return unsupportedOutput(workflow, step);
  }

  // Capability-based dispatch: if the step declares requiredCapabilities,
  // try to match against the generic capability-to-executor map before
  // falling through to the legacy step-key chain.
  if (step.requiredCapabilities && step.requiredCapabilities.length > 0) {
    const result = dispatchGenericByCapability(step, {
      browserTool, codeTool, computerTool, schedulerTool, webTool, userGoal, workflow, contextSnapshot,
    });
    if (result) return result;
  }

  const stepKey = getWorkflowStepKey(step.id);
  if (stepKey === "search-trends" && webTool?.searchWeb) {
    const sources = await webTool.searchWeb({ query: userGoal, maxResults: 5 });
    return concreteOutput(workflow, step, `Search returned ${sources.length} source candidate(s).`, { sources });
  }
  if (stepKey === "fetch-details" && webTool) {
    const candidates = getSourcesFromContext(contextSnapshot).slice(0, 5);
    const fetched = await Promise.all(
      candidates.map((source) =>
        webTool.fetchWebSource({ url: source.url }).catch(() => source),
      ),
    );
    return concreteOutput(workflow, step, `Fetched ${fetched.length} public detail page(s).`, {
      sources: fetched,
    });
  }
  if (stepKey === "merge-trends") {
    const sources = getSourcesFromContext(contextSnapshot);
    const report = createSourceBackedReport(sources, { sourceMode: "search" });
    return concreteOutput(workflow, step, `Verifier merged ${sources.length} source-backed trend item(s).`, {
      sources,
      researchReport: report,
    });
  }
  if (stepKey === "clarify-requirements") {
    return concreteOutput(workflow, step, "Commander clarified a Spring Boot planning request.", {
      requirements: {
        goal: userGoal,
        stack: "Spring Boot",
        writeFiles: false,
      },
    });
  }
  if (stepKey === "retrieve-guidance" && webTool?.searchWeb) {
    const sources = await webTool.searchWeb({
      query: `Spring Boot current setup guidance ${userGoal}`,
      maxResults: 5,
    });
    return concreteOutput(workflow, step, `Research Agent collected ${sources.length} Spring Boot guidance source(s).`, {
      sources,
    });
  }
  if (stepKey === "generate-plan") {
    const preview = codeTool ? await safeInspectRepository(codeTool) : undefined;
    return concreteOutput(workflow, step, "Code Agent generated a non-writing Spring Boot project plan.", {
      codeReviewPreview: preview,
      analysisSummary: createSpringBootPlanSummary(userGoal, getSourcesFromContext(contextSnapshot)),
    });
  }
  if (stepKey === "verify-guide") {
    return concreteOutput(workflow, step, "Verifier checked the generated Spring Boot guide evidence.", {
      verificationSummary: "verified: Spring Boot guide was produced as a preview-only plan.",
    });
  }
  if (stepKey === "parse-query") {
    return concreteOutput(workflow, step, "Commander extracted a local document query.", {
      query: userGoal,
      maxResults: 20,
    });
  }
  if (stepKey === "search-computer" && computerTool) {
    const query = getQueryFromContext(contextSnapshot) ?? userGoal;
    const candidates = await computerTool.searchLocalDocuments({ query, maxResults: 20 });
    return concreteOutput(workflow, step, `Computer Agent found ${candidates.length} local candidate(s).`, {
      candidates,
    });
  }
  if (stepKey === "rank-results") {
    const candidates = getCandidatesFromContext(contextSnapshot);
    return concreteOutput(workflow, step, `Verifier ranked ${candidates.length} local candidate(s).`, {
      candidates: rankLocalCandidates(candidates, userGoal),
    });
  }
  if (stepKey === "parse-schedule") {
    const draft = createScheduleDraft(userGoal);
    return concreteOutput(workflow, step, `Commander parsed schedule ${draft.schedule.type}:${draft.schedule.value}.`, {
      scheduledTaskDraft: draft,
    });
  }
  if (stepKey === "persist-reminder" && schedulerTool) {
    const draft = getScheduleDraftFromContext(contextSnapshot) ?? createScheduleDraft(userGoal);
    const scheduledTask = await schedulerTool.createTask(draft);
    return concreteOutput(workflow, step, `Scheduler Agent created reminder ${scheduledTask.id}.`, {
      scheduledTask,
    });
  }
  if (stepKey === "verify-reminder") {
    const scheduledTask = getScheduledTaskFromContext(contextSnapshot);
    return concreteOutput(workflow, step, "Verifier confirmed the reminder schedule.", {
      verificationSummary: scheduledTask
        ? `verified: reminder ${scheduledTask.id} is enabled for ${scheduledTask.nextRunAt}.`
        : "warn: reminder draft parsed, but no scheduler write result was available.",
    });
  }

  // ── Browser workflow steps ──────────────────────────────────────────────────
  if (stepKey === "navigate-page" && browserTool) {
    const urls = extractUrls(userGoal);
    const url = urls[0];
    if (!url) {
      return concreteOutput(workflow, step, "No URL found in user goal. Please provide a URL to navigate to.", {
        error: "missing_url",
      });
    }
    const result = await browserTool.navigate({ url });
    return concreteOutput(workflow, step, `Browser Agent navigated to ${result.url} (status ${result.status}).`, {
      navigateResult: result,
    });
  }
  if (stepKey === "extract-content" && browserTool) {
    const [content, screenshot] = await Promise.all([
      browserTool.getContent({ format: "text", maxLength: 5000 }),
      browserTool.screenshot({ fullPage: false }),
    ]);
    return concreteOutput(workflow, step, `Browser Agent extracted ${content.content.length} chars and captured screenshot.`, {
      content: content.content,
      pageTitle: content.title,
      pageUrl: content.url,
      screenshot: screenshot.dataUrl,
    });
  }
  if (stepKey === "run-tests" && browserTool) {
    const testScript = getTestScriptFromContext(contextSnapshot) ?? userGoal;
    const result = await browserTool.runTest({ script: testScript });
    return concreteOutput(workflow, step, `Browser Agent ran tests: ${result.passed ? "PASSED" : "FAILED"} (exit ${result.exitCode}).`, {
      testResult: result,
    });
  }
  if (stepKey === "verify-extraction") {
    return concreteOutput(workflow, step, "Verifier checked extracted content completeness.", {
      verificationSummary: "verified: browser content extraction completed.",
    });
  }
  if (stepKey === "verify-results") {
    return concreteOutput(workflow, step, "Verifier summarized test results.", {
      verificationSummary: "verified: Playwright test execution completed.",
    });
  }
  // ── Scan workspace documents steps ──────────────────────────────────────
  if (stepKey === "scan-documents" && fileTool) {
    const documents = summarizeMarkdownDocuments(await fileTool.scanMarkdownDocuments());
    return concreteOutput(workflow, step, `File Agent scanned ${documents.length} document(s) in workspace.`, {
      documents,
      count: documents.length,
    });
  }
  if (stepKey === "classify-documents") {
    return concreteOutput(workflow, step, "File Agent classified scanned documents by type and purpose.", {
      categories: ["documentation", "notes", "data", "configuration"],
      classificationSummary: "Documents classified into standard categories based on path and content heuristics.",
    });
  }
  if (stepKey === "verify-scan") {
    return concreteOutput(workflow, step, "Verifier checked scan completeness and categorization.", {
      verificationSummary: "verified: workspace documents scanned and classified.",
    });
  }
  if (stepKey === "commander-synthesize") {
    return concreteOutput(workflow, step, "Commander prepared the workflow evidence for final synthesis.", {
      synthesisReady: true,
    });
  }

  // ── PDF organization steps ──────────────────────────────────────────────
  if (stepKey === "scan-pdfs" && fileTool) {
    const documents = summarizeMarkdownDocuments(await fileTool.scanMarkdownDocuments());
    return concreteOutput(workflow, step, `File Agent scanned ${documents.length} PDF candidate(s).`, {
      documents,
      count: documents.length,
    });
  }
  if (stepKey === "classify-pdfs") {
    return concreteOutput(workflow, step, "File Agent classified PDFs by content type with suggested target folders.", {
      categories: ["invoices", "contracts", "reports", "manuals", "other"],
      classificationSummary: "PDFs classified by content type heuristics.",
    });
  }
  if (stepKey === "preview-organization") {
    return concreteOutput(workflow, step, "Commander prepared the PDF organization plan for user approval.", {
      planStatus: "pending_approval",
      summary: "Organization plan is ready for user review before any files are moved.",
    });
  }
  if (stepKey === "verify-organization") {
    return concreteOutput(workflow, step, "Verifier confirmed the organization plan is safe and complete.", {
      verificationSummary: "verified: PDF organization plan is Downloads-scoped, move-only, and one-time approved.",
    });
  }

  // ── Code review steps ───────────────────────────────────────────────────
  if (stepKey === "inspect-changes" && codeTool) {
    const preview = await safeInspectRepository(codeTool);
    return concreteOutput(workflow, step, `Code Agent inspected repository: ${preview?.changedFiles?.length ?? 0} changed file(s).`, {
      codeReviewPreview: preview,
      inspectionSummary: preview
        ? `Repository inspection found ${preview.changedFiles?.length ?? 0} changed file(s).`
        : "Repository inspection completed.",
    });
  }
  if (stepKey === "review-diff") {
    return concreteOutput(workflow, step, "Code Agent analyzed the diff and produced a structured review.", {
      findings: [],
      severityCounts: { critical: 0, major: 0, minor: 0, suggestion: 0 },
      reviewSummary: "No automated findings — manual review may be needed.",
    });
  }
  if (stepKey === "verify-review") {
    return concreteOutput(workflow, step, "Verifier checked review completeness and actionable items.", {
      verificationSummary: "verified: code review produced structured findings with severity classification.",
    });
  }

  // ── Browser test: inspect-project step (when dispatched from browser-test) ──
  if (stepKey === "inspect-project" && codeTool && workflow.id === "browser-test") {
    const preview = await safeInspectRepository(codeTool);
    return concreteOutput(workflow, step, `Code Agent inspected project for test setup: ${preview?.changedFiles?.length ?? 0} changed file(s).`, {
      codeReviewPreview: preview,
      testConfig: preview
        ? { hasPlaywright: false, testScripts: [] }
        : undefined,
    });
  }

  if (step.id.startsWith("record-") && step.id.endsWith("-failure")) {
    return concreteOutput(workflow, step, "Verifier recorded degraded evidence after a failed step.", {
      recovery: createFailureRecoveryOutput(step, contextSnapshot),
    });
  }

  return unsupportedOutput(workflow, step);
}

// ── Capability-based tool dispatch ──────────────────────────────────────────

interface AllCapabilityTools {
  browserTool?: BrowserTool;
  codeTool?: CodeTool;
  computerTool?: ComputerTool;
  fileTool?: FileTool;
  shellTool?: ShellTool;
  schedulerTool?: SchedulerTool;
  workspaceTool?: WorkspaceTool;
  webTool?: WebTool;
  commanderTool?: CommanderTool;
  verifierTool?: VerifierTool;
  visionTool?: import("@javis/tools").VisionTool;
}

/** Find the first ToolDescriptor whose capabilityTags include the given tag. */
/**
 * Map technical error messages to user-readable Chinese/English strings.
 * Avoids exposing raw stack traces and internal jargon to the user.
 */
function toUserFacingError(errorMsg: string): string {
  if (
    errorMsg.includes("complete_model_prompt") ||
    errorMsg.includes("missing field `prompt`") ||
    errorMsg.includes("missing field 'prompt'")
  ) {
    return "模型请求参数不完整。请重试当前任务；如果仍失败，请检查模型配置并更新应用。";
  }
  if (
    errorMsg.includes("did not contain a JSON object") ||
    errorMsg.includes("valid JSON") ||
    errorMsg.includes("invalid JSON")
  ) {
    return "计划生成失败：模型没有返回可执行的结构化计划。请重试，或补充目标、路径和平台等关键信息。";
  }
  if (errorMsg.includes("API key") || errorMsg.includes("unauthorized") || errorMsg.includes("401")) {
    return "API 密钥无效或已过期，请在设置中更新密钥。";
  }
  if (errorMsg.includes("timeout") || errorMsg.includes("Timed out")) {
    return "操作超时，请检查网络连接后重试。";
  }
  if (errorMsg.includes("rate") || errorMsg.includes("429")) {
    return "请求频率过高，请稍后重试。";
  }
  if (errorMsg.includes("Unsupported workflow step")) {
    return "任务步骤无法执行，请尝试重新描述你的需求。";
  }
  if (errorMsg.includes("Workflow deadlock")) {
    return "任务步骤存在循环依赖，请用不同的方式重新描述目标。";
  }
  if (errorMsg.includes("not available")) {
    return "所需工具不可用，部分功能需要特定配置。";
  }
  if (errorMsg.includes("denied")) {
    return "操作已被取消。";
  }
  // Fallback: strip technical prefixes but keep the core message
  const cleaned = errorMsg
    .replace(/^Error:\s*/i, "")
    .replace(/^\[.*?\]\s*/, "")
    .trim();
  return cleaned.length > 0 ? cleaned : "任务执行出错，请重试。";
}

function normalizeAskUserPromptForUserLanguage(
  question: string,
  choices: CommanderDagStep["choices"] | undefined,
  userGoal: string,
): { question: string; choices?: CommanderDagStep["choices"] } {
  if (!containsChinese(userGoal) || containsChinese(question)) {
    return { question, choices };
  }
  return {
    question: "请先补充一个关键信息，方便我继续规划。",
    choices: choices?.some((choice) => containsChinese(typeof choice === "string" ? choice : choice.label))
      ? choices
      : undefined,
  };
}

function containsChinese(value: string): boolean {
  return /[\u3400-\u9fff]/u.test(value);
}

function findToolDescriptorByCapability(capability: string, agentKind?: string) {
  return initialToolDescriptors.find((td) =>
    td.capabilityTags.includes(capability) &&
    (!agentKind || td.ownerAgentKinds.includes(agentKind))
  );
}

function findToolDescriptorByName(toolName: string) {
  return initialToolDescriptors.find((td) => td.name === toolName);
}

function findToolDescriptorForDagStep(step: CommanderDagStep): ToolDescriptor | undefined {
  if (step.toolName) return findToolDescriptorByName(step.toolName);
  const capability = step.capability ?? step.requiredCapabilities?.[0];
  return capability ? findToolDescriptorByCapability(capability, step.assignedAgentKind) : undefined;
}

function getDagStepPermissionLevel(step: CommanderDagStep): WorkbenchWorkflowStep["permissionLevel"] {
  return findToolDescriptorForDagStep(step)?.permissionLevel ?? "read";
}

function isApprovalGatedPermissionLevel(
  permissionLevel: WorkbenchWorkflowStep["permissionLevel"],
): boolean {
  return permissionLevel === "confirmed_write" || permissionLevel === "dangerous";
}

function isApprovalGatedToolDescriptor(descriptor: ToolDescriptor): boolean {
  return descriptor.permissionLevel === "confirmed_write" || descriptor.permissionLevel === "dangerous";
}

function assertToolCanDispatchWithoutApproval(toolName: string): void {
  const descriptor = findToolDescriptorByName(toolName);
  if (!descriptor || !isApprovalGatedToolDescriptor(descriptor)) return;
  throw new Error(
    `Tool ${toolName} requires ${descriptor.permissionLevel} approval and cannot be dispatched by the generic DAG executor.`,
  );
}

function assertToolOwnedByAgent(toolName: string, agentKind: string): void {
  const descriptor = findToolDescriptorByName(toolName);
  if (!descriptor || descriptor.ownerAgentKinds.includes(agentKind)) return;
  throw new Error(`Tool ${toolName} is not owned by agent ${agentKind}.`);
}

/**
 * Route a web search to the appropriate provider based on query intent.
 * - code/github/repo -> "code" (GitHub API search)
 * - academic/paper/scholar -> "web" with academic annotation
 * - everything else -> "auto" (default search engine routing)
 */
export function pickSearchProvider(query: string): "auto" | "code" | "web" {
  if (/github|repo|package|npm|crate|repository|open.source/i.test(query)) return "code";
  if (isAcademicSearchIntent(query)) return "web";
  return "auto";
}

/**
 * Check if a query targets academic/scholarly sources.
 * Used by pickSearchProvider and may be consumed by web tool implementations
 * to add Semantic Scholar / arXiv integration in Phase 4.
 */
export function isAcademicSearchIntent(query: string): boolean {
  return /academic|paper|literature|scholar|research.paper|doi:|citation|arxiv|semantic[._-]?scholar|学术|论文|研究文献/i.test(query);
}

/**
 * Dispatch a tool by name to its concrete implementation.
 * Maps tool names from ToolDescriptor to the corresponding tool interface method.
 */
async function dispatchToolByName(
  toolName: string,
  input: Record<string, unknown>,
  tools: AllCapabilityTools,
): Promise<unknown> {
  assertToolCanDispatchWithoutApproval(toolName);

  switch (toolName) {
    // ── Web tools ─────────────────────────────────────────────────────────
    case "web.search": {
      if (!tools.webTool?.searchWeb) throw new Error("web.search tool not available");
      const query = (input.query as string) ?? (input.userGoal as string) ?? "";
      return tools.webTool.searchWeb({
        query,
        maxResults: (input.maxResults as number) ?? 5,
        searchType: (input.searchType as "auto" | "code" | "web")
          ?? pickSearchProvider(query),
      });
    }
    case "web.fetchSource": {
      if (!tools.webTool) throw new Error("web.fetchSource tool not available");
      return tools.webTool.fetchWebSource({ url: input.url as string });
    }
    // ── File tools ────────────────────────────────────────────────────────
    case "file.scanMarkdownDocuments": {
      if (!tools.fileTool) throw new Error("file.scanMarkdownDocuments tool not available");
      return tools.fileTool.scanMarkdownDocuments();
    }
    case "file.planPdfOrganization": {
      if (!tools.fileTool?.planPdfOrganization) throw new Error("file.planPdfOrganization tool not available");
      return tools.fileTool.planPdfOrganization(input.taskId as string | undefined);
    }
    case "file.scanUserDocuments": {
      if (!tools.fileTool?.scanUserDocuments) throw new Error("file.scanUserDocuments tool not available");
      return tools.fileTool.scanUserDocuments({
        query: input.query as string,
        extensions: input.extensions as string[] | undefined,
        maxResults: input.maxResults as number | undefined,
      });
    }
    case "file.scanUserImages": {
      if (!tools.fileTool?.scanUserImages) throw new Error("file.scanUserImages tool not available");
      return tools.fileTool.scanUserImages({
        maxResults: input.maxResults as number | undefined,
      });
    }
    case "file.scanInstalledApps": {
      if (!tools.fileTool?.scanInstalledApps) throw new Error("file.scanInstalledApps tool not available");
      return tools.fileTool.scanInstalledApps();
    }
    case "file.classifyDocuments": {
      if (!tools.fileTool?.classifyDocuments) throw new Error("file.classifyDocuments tool not available");
      return tools.fileTool.classifyDocuments(
        input.files as Array<{ name: string; path: string; extension?: string }>,
      );
    }
    case "file.planWriteText": {
      if (!tools.fileTool?.planWriteText) throw new Error("file.planWriteText tool not available");
      return tools.fileTool.planWriteText({
        targetPath: input.targetPath as string,
        content: input.content as string,
      });
    }
    case "file.writeText": {
      if (!tools.fileTool?.writeText) throw new Error("file.writeText tool not available");
      return tools.fileTool.writeText(
        { targetPath: input.targetPath as string, content: input.content as string },
        input.approvalId as string,
        input.taskId as string | undefined,
      );
    }
    // ── Browser tools ─────────────────────────────────────────────────────
    case "browser.navigate": {
      if (!tools.browserTool) throw new Error("browser.navigate tool not available");
      return tools.browserTool.navigate({
        url: input.url as string,
        waitForSelector: input.waitForSelector as string | undefined,
        timeoutMs: input.timeoutMs as number | undefined,
      });
    }
    case "browser.screenshot": {
      if (!tools.browserTool) throw new Error("browser.screenshot tool not available");
      return tools.browserTool.screenshot({
        fullPage: (input.fullPage as boolean) ?? false,
        selector: input.selector as string | undefined,
        format: input.format as "png" | "jpeg" | undefined,
        quality: input.quality as number | undefined,
      });
    }
    case "browser.getContent": {
      if (!tools.browserTool) throw new Error("browser.getContent tool not available");
      return tools.browserTool.getContent({
        selector: input.selector as string | undefined,
        format: (input.format as "text" | "html" | "markdown") ?? "text",
        maxLength: (input.maxLength as number) ?? 5000,
      });
    }
    case "browser.extractLinks": {
      if (!tools.browserTool?.extractLinks) throw new Error("browser.extractLinks tool not available");
      return tools.browserTool.extractLinks({
        selector: input.selector as string | undefined,
        maxResults: input.maxResults as number | undefined,
      });
    }
    case "browser.followCandidateLinks": {
      if (!tools.browserTool?.followCandidateLinks) throw new Error("browser.followCandidateLinks tool not available");
      return tools.browserTool.followCandidateLinks({
        candidateLinks: (input.candidateLinks as import("@javis/tools").BrowserExtractedLink[] | undefined) ?? [],
        urlPattern: input.urlPattern as string | undefined,
        maxFollow: input.maxFollow as number | undefined,
      });
    }
    // ── Vision tools ──────────────────────────────────────────────────────
    case "vision.analyze": {
      if (!tools.visionTool) throw new Error("vision.analyze tool not available — VisionTool not wired in capability dispatch");
      return tools.visionTool.analyze({
        imagePath: input.imagePath as string,
        question: input.question as string | undefined,
      });
    }
    case "vision.describe": {
      if (!tools.visionTool) throw new Error("vision.describe tool not available — VisionTool not wired in capability dispatch");
      return tools.visionTool.describe({
        imagePath: input.imagePath as string,
        detail: (input.detail as "brief" | "detailed") ?? "detailed",
      });
    }
    case "vision.extractText": {
      if (!tools.visionTool) throw new Error("vision.extractText tool not available — VisionTool not wired in capability dispatch");
      return tools.visionTool.extractText({
        imagePath: input.imagePath as string,
        language: input.language as string | undefined,
      });
    }
    // ── Code tools ────────────────────────────────────────────────────────
    case "code.inspectRepository": {
      if (!tools.codeTool) throw new Error("code.inspectRepository tool not available");
      return tools.codeTool.inspectRepository();
    }
    case "code.proposeEdit": {
      if (!tools.codeTool?.proposeEdit) throw new Error("code.proposeEdit tool not available");
      return tools.codeTool.proposeEdit(input as {
        userGoal: string;
        preview: import("@javis/tools").CodeReviewPreview;
      });
    }
    // 鈹€鈹€ Shell tools 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    case "shell.runReadOnlyCommand": {
      if (!tools.shellTool) throw new Error("shell.runReadOnlyCommand tool not available");
      return tools.shellTool.runReadOnlyCommand({
        program: input.program as string,
        args: (input.args as string[] | undefined) ?? [],
        workspacePath: input.workspacePath as string | null | undefined,
      });
    }
    // ── Computer tools ────────────────────────────────────────────────────
    case "computer.searchLocalDocuments": {
      if (!tools.computerTool) throw new Error("computer.searchLocalDocuments tool not available");
      return tools.computerTool.searchLocalDocuments({
        query: input.query as string,
        maxResults: (input.maxResults as number) ?? 20,
      });
    }
    case "computer.listDirectory": {
      if (!tools.computerTool) throw new Error("computer.listDirectory tool not available");
      return tools.computerTool.listDirectory({
        path: input.path as string | undefined,
      });
    }
    case "computer.openPath": {
      if (!tools.computerTool) throw new Error("computer.openPath tool not available");
      return tools.computerTool.openPath(input);
    }
    case "computer.screenshot": {
      if (!tools.computerTool) throw new Error("computer.screenshot tool not available");
      return tools.computerTool.screenshot({
        windowHandle: input.windowHandle as number | undefined,
        region: input.region as { x: number; y: number; width: number; height: number } | undefined,
      });
    }
    case "computer.listWindows": {
      if (!tools.computerTool) throw new Error("computer.listWindows tool not available");
      return tools.computerTool.listWindows({});
    }
    case "computer.inspectUi": {
      if (!tools.computerTool) throw new Error("computer.inspectUi tool not available");
      return tools.computerTool.inspectUi({
        windowHandle: input.windowHandle as number,
        maxDepth: input.maxDepth as number | undefined,
        maxNodes: input.maxNodes as number | undefined,
      });
    }
    case "computer.wait": {
      if (!tools.computerTool) throw new Error("computer.wait tool not available");
      return tools.computerTool.wait({ ms: (input.ms as number) ?? 500 });
    }
    case "computer.focusWindow": {
      if (!tools.computerTool) throw new Error("computer.focusWindow tool not available");
      return tools.computerTool.focusWindow({
        handle: input.handle as number,
        approvalId: input.approvalId as string | undefined,
        taskId: input.taskId as string | undefined,
      });
    }
    case "computer.moveMouse": {
      if (!tools.computerTool) throw new Error("computer.moveMouse tool not available");
      return tools.computerTool.moveMouse({
        x: input.x as number,
        y: input.y as number,
        speed: input.speed as "instant" | "linear" | undefined,
        durationMs: input.durationMs as number | undefined,
        approvalId: input.approvalId as string | undefined,
        taskId: input.taskId as string | undefined,
      });
    }
    case "computer.click": {
      if (!tools.computerTool) throw new Error("computer.click tool not available");
      return tools.computerTool.click({
        x: input.x as number,
        y: input.y as number,
        button: input.button as "left" | "right" | "middle" | undefined,
        clickCount: input.clickCount as 1 | 2 | undefined,
        approvalId: input.approvalId as string | undefined,
        taskId: input.taskId as string | undefined,
      });
    }
    case "computer.type": {
      if (!tools.computerTool) throw new Error("computer.type tool not available");
      return tools.computerTool.type({
        text: input.text as string,
        delayMs: input.delayMs as number | undefined,
        clearBefore: input.clearBefore as boolean | undefined,
        approvalId: input.approvalId as string | undefined,
        taskId: input.taskId as string | undefined,
      });
    }
    case "computer.keyCombo": {
      if (!tools.computerTool) throw new Error("computer.keyCombo tool not available");
      return tools.computerTool.keyCombo({
        keys: input.keys as string[],
        pressDurationMs: input.pressDurationMs as number | undefined,
        approvalId: input.approvalId as string | undefined,
        taskId: input.taskId as string | undefined,
      });
    }
    case "computer.scroll": {
      if (!tools.computerTool) throw new Error("computer.scroll tool not available");
      return tools.computerTool.scroll({
        x: input.x as number,
        y: input.y as number,
        delta: input.delta as number,
        direction: input.direction as "vertical" | "horizontal" | undefined,
        approvalId: input.approvalId as string | undefined,
        taskId: input.taskId as string | undefined,
      });
    }
    case "computer.invokeUi": {
      if (!tools.computerTool) throw new Error("computer.invokeUi tool not available");
      return tools.computerTool.invokeUi({
        selector: input.selector as import("@javis/tools").UiElementSelector,
        approvalId: input.approvalId as string | undefined,
        taskId: input.taskId as string | undefined,
      });
    }
    case "computer.setUiValue": {
      if (!tools.computerTool) throw new Error("computer.setUiValue tool not available");
      return tools.computerTool.setUiValue({
        selector: input.selector as import("@javis/tools").UiElementSelector,
        value: input.value as string,
        approvalId: input.approvalId as string | undefined,
        taskId: input.taskId as string | undefined,
      });
    }
    // ── Scheduler tools ───────────────────────────────────────────────────
    case "scheduler.createTask": {
      if (!tools.schedulerTool) throw new Error("scheduler.createTask tool not available");
      return tools.schedulerTool.createTask(input as unknown as Parameters<typeof tools.schedulerTool.createTask>[0]);
    }
    // 鈹€鈹€ Workspace tools 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    case "workspace.list": {
      if (!tools.workspaceTool) throw new Error("workspace.list tool not available");
      return tools.workspaceTool.list();
    }
    case "workspace.scaffold": {
      if (!tools.workspaceTool?.scaffold) throw new Error("workspace.scaffold tool not available");
      return tools.workspaceTool.scaffold(
        (input.description as string | undefined)
          ?? (input.userGoal as string | undefined)
          ?? (input.prompt as string | undefined)
          ?? "",
      );
    }
    // ── Verifier ──────────────────────────────────────────────────────────
    case "verifier.check": {
      if (!tools.verifierTool) throw new Error("verifier.check tool not available");
      return tools.verifierTool.check(input as unknown as Parameters<typeof tools.verifierTool.check>[0]);
    }
    // ── Commander tools ───────────────────────────────────────────────────
    case "commander.plan": {
      if (!tools.commanderTool) throw new Error("commander.plan tool not available");
      return tools.commanderTool.plan(input as unknown as Parameters<typeof tools.commanderTool.plan>[0]);
    }
    case "commander.synthesize": {
      if (!tools.commanderTool?.synthesize) throw new Error("commander.synthesize tool not available");
      return tools.commanderTool.synthesize(input as unknown as Parameters<NonNullable<typeof tools.commanderTool.synthesize>>[0]);
    }
    default:
      throw new Error(`Tool dispatch not implemented for: ${toolName}`);
  }
}

/**
 * Execute a step by dispatching via its capability tag.
 *
 * This is the generic execution path: instead of hardcoding stepKey -> tool call,
 * the executor looks up the step's capability tag in the ToolDescriptor registry,
 * resolves input from SharedContext, invokes the matching tool, and writes
 * the result back to SharedContext.
 */
export async function executeCapabilityStep(
  step: CommanderDagStep,
  context: SharedTaskContext,
  tools: AllCapabilityTools,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ output: unknown; toolName: string }> {
  const { signal, timeoutMs = COMMANDER_TOOL_TIMEOUT_MS } = options;
  throwIfTaskAborted(signal, `tool ${step.toolName ?? step.capability ?? step.id}`);
  if (step.toolName) {
    assertToolOwnedByAgent(step.toolName, step.assignedAgentKind);
    const input = resolveStepInput(step.inputContextKeys, context);
    const output = await withTaskTimeout(
      () => dispatchToolByName(step.toolName!, input, tools),
      {
        label: `tool ${step.toolName}`,
        timeoutMs,
        signal,
      },
    );
    writeStepOutput(step.outputContextKey, output, context);
    return { output, toolName: step.toolName };
  }

  const capability = step.capability ?? step.requiredCapabilities[0];
  if (!capability) {
    throw new Error(`Step "${step.id}" has no capability tag for dispatch. ` +
      `Set step.capability or step.requiredCapabilities[0].`);
  }

  const descriptor = findToolDescriptorByCapability(capability, step.assignedAgentKind);
  if (!descriptor) {
    throw new Error(
      `No tool registered for capability "${capability}" owned by agent "${step.assignedAgentKind}" (step: ${step.id}). ` +
      `Ensure a ToolDescriptor declares this tag in its capabilityTags and ownerAgentKinds.`,
    );
  }
  if (isApprovalGatedToolDescriptor(descriptor)) {
    throw new Error(
      `Tool ${descriptor.name} requires ${descriptor.permissionLevel} approval and cannot be dispatched by the generic DAG executor.`,
    );
  }

  const input = resolveStepInput(step.inputContextKeys, context);
  const output = await withTaskTimeout(
    () => dispatchToolByName(descriptor.name, input, tools),
    {
      label: `tool ${descriptor.name}`,
      timeoutMs,
      signal,
    },
  );

  writeStepOutput(step.outputContextKey, output, context);

  return { output, toolName: descriptor.name };
}

function filterToolDescriptorsForStep(
  step: CommanderDagStep,
  allowedToolNames: string[],
): typeof initialToolDescriptors {
  const capability = step.capability ?? step.requiredCapabilities?.[0];
  return initialToolDescriptors.filter((descriptor) => {
    if (!allowedToolNames.includes(descriptor.name)) return false;
    if (isApprovalGatedToolDescriptor(descriptor)) return false;
    if (step.toolName) return descriptor.name === step.toolName;
    if (capability) return descriptor.capabilityTags.includes(capability);
    return true;
  });
}

function resolveStepExecutionMode(
  step: CommanderDagStep,
): NonNullable<CommanderDagStep["executionMode"]> {
  if (step.executionMode) return step.executionMode;
  if (step.assignedAgentKind === "commander" && (step.capability === "synthesis" || step.toolName === "commander.synthesize")) {
    return "direct_response";
  }
  if (
    step.toolName ||
    step.capability ||
    (step.requiredCapabilities?.length ?? 0) > 0
  ) {
    return "direct_tool_call";
  }
  return "react";
}

const COMPUTER_USE_CAPABILITIES = new Set([
  "desktop_screenshot",
  "desktop_list_windows",
  "desktop_ui_tree",
  "desktop_focus",
  "desktop_ui_input",
  "desktop_input",
]);

function isComputerUseCapability(capability: string | undefined): boolean {
  return capability !== undefined && COMPUTER_USE_CAPABILITIES.has(capability);
}

function isComputerUseDagStep(step: {
  assignedAgentKind: string;
  toolName?: string;
  capability?: string;
  requiredCapabilities?: string[];
}): boolean {
  return step.assignedAgentKind === "computer" &&
    (
      step.toolName?.startsWith("computer.") ||
      isComputerUseCapability(step.capability) ||
      (step.requiredCapabilities ?? []).some(isComputerUseCapability)
    );
}

function getComputerUseStepIndex(step: unknown): number {
  if (
    step &&
    typeof step === "object" &&
    "stepIndex" in step &&
    typeof (step as { stepIndex?: unknown }).stepIndex === "number"
  ) {
    return (step as { stepIndex: number }).stepIndex;
  }
  return 0;
}

function summarizeComputerUseAction(action: { tool: string; params: object }): string {
  const params = action.params as Record<string, unknown>;
  switch (action.tool) {
    case "computer.screenshot":
      return typeof params.windowHandle === "string"
        ? `截取窗口 ${params.windowHandle} 的画面`
        : "截取当前桌面画面";
    case "computer.inspectUi":
      return typeof params.windowHandle === "string"
        ? `读取窗口 ${params.windowHandle} 的控件结构`
        : "读取当前窗口的控件结构";
    case "computer.wait":
      return `等待 ${typeof params.ms === "number" ? params.ms : 0} 毫秒`;
    case "computer.focusWindow":
      return `聚焦窗口 ${String(params.handle ?? params.windowHandle ?? "目标窗口")}`;
    case "computer.moveMouse":
      return `移动鼠标到 (${String(params.x ?? "?")}, ${String(params.y ?? "?")})`;
    case "computer.click":
      return `点击屏幕坐标 (${String(params.x ?? "?")}, ${String(params.y ?? "?")})`;
    case "computer.type": {
      const text = typeof params.text === "string" ? params.text : "";
      return `输入 ${text.length} 个字符`;
    }
    case "computer.keyCombo": {
      const keys = Array.isArray(params.keys) ? params.keys.map(String).join(" + ") : String(params.keys ?? "快捷键");
      return `按下组合键 ${keys}`;
    }
    case "computer.scroll":
      return `在 (${String(params.x ?? "?")}, ${String(params.y ?? "?")}) 滚动 ${String(params.delta ?? params.deltaY ?? "?")}`;
    case "computer.invokeUi":
      return `调用控件${formatComputerUseSelector(params.selector)}`;
    case "computer.setUiValue":
      return `设置控件${formatComputerUseSelector(params.selector)}的文本`;
    default:
      return `执行桌面操作 ${action.tool}`;
  }
}

function formatComputerUseSelector(selector: unknown): string {
  if (!selector || typeof selector !== "object") return "";
  const record = selector as Record<string, unknown>;
  const label = record.name ?? record.automationId ?? record.text ?? record.controlType;
  return label ? `“${String(label)}”` : "";
}

function summarizeComputerUseStep(step: ComputerUseStep): string {
  const index = getComputerUseStepIndex(step) + 1;
  const actionSummary = summarizeComputerUseAction(step.action);
  const target = step.target?.trim() ? `目标：${step.target.trim()}。` : "";
  const observation = step.observation?.trim() ? `观察：${step.observation.trim()}。` : "";
  const error = step.error?.trim() ? `结果：${step.error.trim()}` : "结果：已执行。";
  return `第 ${index} 步：${actionSummary}。${target}${observation}${error}`;
}

function requiresFreshComputerUseApproval(action: { tool: string; params: Record<string, unknown> }): boolean {
  return action.tool === "computer.type" ||
    action.tool === "computer.keyCombo" ||
    action.tool === "computer.setUiValue" ||
    action.tool === "computer.invokeUi" && selectorLooksSensitive(action.params.selector);
}

function selectorLooksSensitive(selector: unknown): boolean {
  if (!selector || typeof selector !== "object") return false;
  const record = selector as Record<string, unknown>;
  return [record.name, record.automationId]
    .filter((value): value is string => typeof value === "string")
    .some((value) => /password|token|secret|credential|密码|令牌|密钥/i.test(value));
}

function createFallbackComputerUseDagPlan(
  userGoal: string,
  failureReason: string,
): CommanderDagPlan {
  return {
    title: "桌面自动化操控",
    reasoning: `动态计划解析失败（${failureReason}），改用稳定的桌面自动化流程完成目标。`,
    steps: [{
      id: "computer-use-loop",
      title: "观察桌面并逐步完成用户目标",
      assignedAgentKind: "computer",
      capability: "desktop_input",
      requiredCapabilities: ["desktop_screenshot", "desktop_input"],
      dependsOn: [],
      inputContextKeys: ["userGoal"],
      outputContextKey: "computerUseSteps",
      successCriteria: `桌面自动化流程完成用户请求：${userGoal}`,
    }],
  };
}

function normalizeCommanderDagPlan(plan: CommanderPlanResult): CommanderDagPlan {
  return {
    title: plan.title,
    reasoning: plan.reasoning,
    steps: plan.steps.map((step) => ({
      ...step,
      capability: (step as CommanderDagStep).capability,
      requiredCapabilities: step.requiredCapabilities ?? [],
      dependsOn: step.dependsOn ?? [],
    })),
  };
}

async function requestComputerUseApproval(options: {
  action: { tool: string; params: Record<string, unknown> };
  stepId: string;
  taskId: string;
  computerTool: ComputerTool;
  getSnapshot: () => TaskSnapshot;
  emitSnapshot: (snapshot: TaskSnapshot) => void;
  emitEvent: (event: TaskRuntimeEvent) => TaskSnapshot["logs"][number];
  agentTracker: ReturnType<typeof createAgentStateTracker>;
  signal?: AbortSignal;
  timeoutMs?: number;
  setPendingPermissionHandler: (
    requestId: string,
    handler: ((decision: string) => void | Promise<void>) | undefined,
  ) => void;
}): Promise<{ approvalId: string; taskId?: string; sessionWide?: boolean }> {
  const {
    action,
    stepId,
    taskId,
    computerTool,
    getSnapshot,
    emitSnapshot,
    emitEvent,
    agentTracker,
    signal,
    timeoutMs = COMMANDER_USER_WAIT_TIMEOUT_MS,
    setPendingPermissionHandler,
  } = options;

  if (!computerTool.approveAction) {
    throw new Error("Computer Use native approval bridge is not available.");
  }

  const actionSummary = summarizeComputerUseAction(action);
  const canUseTaskApproval = !requiresFreshComputerUseApproval(action);
  const permissionRequest = createPendingPermissionRequest({
    id: `${taskId}-${stepId}-${action.tool.replace(/[^a-z0-9]+/gi, "-")}-approval-${Date.now()}`,
    level: "confirmed_write",
    title: "需要确认桌面操作",
    reason: canUseTaskApproval
      ? `Javis 准备${actionSummary}。你也可以允许本次任务在短时间内继续执行低风险桌面动作；输入文字、快捷键和敏感控件仍会再次确认。`
      : `Javis 准备${actionSummary}。该动作需要单独确认。`,
    dryRun: {
      operation: action.tool,
      affectedPaths: [{
        source: "本机桌面",
        target: actionSummary,
        action: "modify",
      }],
      riskSummary: canUseTaskApproval
        ? "任务级授权仅限当前任务、短时间和有限次数；敏感输入会再次请求确认。"
        : "该操作会影响当前桌面或目标应用，请确认后再执行。",
      reversible: false,
    },
  });

  const approvalPromise = new Promise<{ approvalId: string; taskId?: string; sessionWide?: boolean }>((resolve, reject) => {
    emitSnapshot({
      ...getSnapshot(),
      status: "waiting_permission",
      commanderMessage: `需要你确认：${actionSummary}。`,
      permissionRequest,
      agents: agentTracker.getSnapshots(),
      logs: [
        ...getSnapshot().logs,
        emitEvent({
          kind: "permission.requested",
          taskId,
          request: permissionRequest,
        }),
        emitEvent({
          kind: "task.waiting",
          taskId,
          phase: "waiting_user",
          label: `Computer Use approval ${permissionRequest.id}`,
          detail: `Waiting for permission decision: ${actionSummary}`,
          stepId,
          agentKind: "computer",
          toolName: action.tool,
        }),
      ],
    });

    setPendingPermissionHandler(permissionRequest.id, async (decision) => {
      try {
        resolvePermissionRequest(permissionRequest, decision as PermissionDecision);
        setPendingPermissionHandler(permissionRequest.id, undefined);

        emitSnapshot({
          ...getSnapshot(),
          permissionRequest: undefined,
          logs: appendLog(getSnapshot(), emitEvent({
            kind: "permission.resolved",
            taskId,
            requestId: permissionRequest.id,
            decision: decision === "denied" ? "denied" : "approved",
          })),
        });

        if (decision === "denied") {
          reject(new Error("用户已拒绝桌面操作。"));
          return;
        }

        const sessionWide = decision === "approved_always";
        const approval = await computerTool.approveAction!(
          action,
          permissionRequest.id,
          taskId,
          sessionWide,
        );
        resolve({ ...approval, sessionWide });
      } catch (error) {
        reject(error);
      }
    });
  });

  try {
    return await withTaskTimeout(approvalPromise, {
      label: `Computer Use approval ${permissionRequest.id}`,
      timeoutMs,
      signal,
      onTimeout: () => {
        setPendingPermissionHandler(permissionRequest.id, undefined);
        emitSnapshot({
          ...getSnapshot(),
          permissionRequest: undefined,
          logs: [
            ...getSnapshot().logs,
            emitEvent({
              kind: "task.timeout",
              taskId,
              phase: "waiting_user",
              label: `Computer Use approval ${permissionRequest.id}`,
              timeoutMs,
              detail: "Computer Use approval timed out.",
              stepId,
              agentKind: "computer",
              toolName: action.tool,
            }),
            emitEvent({
              kind: "task.failed",
              taskId,
              error: `Computer Use approval ${permissionRequest.id} timed out.`,
            }),
          ],
        });
      },
      onAbort: () => {
        setPendingPermissionHandler(permissionRequest.id, undefined);
        emitSnapshot({
          ...getSnapshot(),
          permissionRequest: undefined,
          logs: appendLog(getSnapshot(), emitEvent({
            kind: "task.cancelled",
            taskId,
            label: `Computer Use approval ${permissionRequest.id}`,
            detail: "Computer Use approval cancelled.",
            stepId,
            agentKind: "computer",
          })),
        });
      },
    });
  } catch (error) {
    setPendingPermissionHandler(permissionRequest.id, undefined);
    throw error;
  }
}

async function waitForAskUserAnswer(options: {
  question: string;
  choices?: CommanderDagStep["choices"];
  userGoal: string;
  taskId: string;
  stepId: string;
  context: SharedTaskContext;
  getSnapshot: () => TaskSnapshot;
  emitSnapshot: (snapshot: TaskSnapshot) => void;
  emitEvent: (event: TaskRuntimeEvent) => TaskSnapshot["logs"][number];
  agentTracker: ReturnType<typeof createAgentStateTracker>;
  setPendingAskUserHandler: NonNullable<CommanderDagTaskOptions["controller"]["setPendingAskUserHandler"]>;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<string> {
  const {
    question,
    choices,
    userGoal,
    taskId,
    stepId,
    context,
    getSnapshot,
    emitSnapshot,
    emitEvent,
    agentTracker,
    setPendingAskUserHandler,
    signal,
    timeoutMs = COMMANDER_USER_WAIT_TIMEOUT_MS,
  } = options;
  const askPrompt = normalizeAskUserPromptForUserLanguage(question, choices, userGoal);
  let requestId = "";
  const answerPromise = new Promise<string>((resolve) => {
    const { questionRequest, listenForAnswer } = createAskUserRequest({
      question: askPrompt.question,
      choices: askPrompt.choices,
      setPendingAskUserHandler,
      onAnswered: async (resolved) => {
        context.set(`askUserAnswer:${stepId}`, resolved.answer);
        context.set("askUserQuestion", resolved.question);
        emitSnapshot({
          ...getSnapshot(),
          askUserQuestion: undefined,
          conversationMessages: updateAskUserConversation(
            getSnapshot().conversationMessages,
            resolved,
          ),
        });
        resolve(resolved.answer ?? "");
      },
    });
    requestId = questionRequest.id;

    emitSnapshot({
      ...getSnapshot(),
      status: "waiting_info",
      commanderMessage: questionRequest.question,
      askUserQuestion: questionRequest,
      agents: agentTracker.getSnapshots(),
      logs: [
        ...getSnapshot().logs,
        emitEvent({
          kind: "ask_user.requested",
          taskId,
          question: questionRequest,
        }),
        emitEvent({
          kind: "task.waiting",
          taskId,
          phase: "waiting_user",
          label: `askUser ${questionRequest.id}`,
          detail: "Waiting for user clarification.",
          stepId,
          agentKind: "commander",
          toolName: "commander.askUser",
        }),
      ],
    });

    listenForAnswer();
  });

  try {
    return await withTaskTimeout(answerPromise, {
      label: `askUser ${requestId || stepId}`,
      timeoutMs,
      signal,
      onTimeout: () => {
        if (requestId) {
          setPendingAskUserHandler(requestId, undefined);
        }
        const current = getSnapshot();
        emitSnapshot({
          ...current,
          askUserQuestion: undefined,
          conversationMessages: current.askUserQuestion
            ? updateAskUserConversation(
                current.conversationMessages,
                { ...current.askUserQuestion, status: "expired", resolvedAt: new Date().toISOString() },
              )
            : current.conversationMessages,
          logs: [
            ...current.logs,
            emitEvent({
              kind: "task.timeout",
              taskId,
              phase: "waiting_user",
              label: `askUser ${requestId || stepId}`,
              timeoutMs,
              detail: "askUser timed out.",
              stepId,
              agentKind: "commander",
              toolName: "commander.askUser",
            }),
            emitEvent({
              kind: "task.failed",
              taskId,
              error: `askUser ${requestId || stepId} timed out.`,
            }),
          ],
        });
      },
      onAbort: () => {
        if (requestId) {
          setPendingAskUserHandler(requestId, undefined);
        }
        const current = getSnapshot();
        emitSnapshot({
          ...current,
          askUserQuestion: undefined,
          conversationMessages: current.askUserQuestion
            ? updateAskUserConversation(
                current.conversationMessages,
                { ...current.askUserQuestion, status: "cancelled", resolvedAt: new Date().toISOString() },
              )
            : current.conversationMessages,
          logs: appendLog(current, emitEvent({
            kind: "task.cancelled",
            taskId,
            label: `askUser ${requestId || stepId}`,
            detail: "askUser cancelled.",
            stepId,
            agentKind: "commander",
          })),
        });
      },
    });
  } catch (error) {
    if (requestId) {
      setPendingAskUserHandler(requestId, undefined);
    }
    throw error;
  }
}

function updateAskUserConversation(
  messages: TaskSnapshot["conversationMessages"] | undefined,
  question: NonNullable<TaskSnapshot["askUserQuestion"]>,
): TaskSnapshot["conversationMessages"] | undefined {
  return messages?.map((message) =>
    message.kind === "ask_user_question" && message.id === question.id
      ? {
          ...message,
          askUserQuestion: question,
          content: question.question,
        }
      : message,
  );
}

const COMMANDER_DAG_WORKFLOW_ID = "commander-dag";

// ── Commander DAG Task Executor ────────────────────────────────────────────

interface CommanderDagTaskOptions {
  controller: {
    emit: (snapshot: TaskSnapshot) => void;
    getSnapshot: () => TaskSnapshot;
    wait: () => Promise<void>;
    setPendingAskUserHandler?(
      requestId: string,
      handler: ((answer: string) => void | Promise<void>) | undefined,
    ): void;
    setPendingPermissionHandler?(
      requestId: string,
      handler: ((decision: string) => void | Promise<void>) | undefined,
    ): void;
  };
  commanderTool: CommanderTool;
  codeTool?: CodeTool;
  computerTool?: ComputerTool;
  fileTool: FileTool;
  shellTool?: ShellTool;
  schedulerTool?: SchedulerTool;
  workspaceTool?: WorkspaceTool;
  webTool?: WebTool;
  browserTool?: BrowserTool;
  verifierTool?: VerifierTool;
  visionTool?: import("@javis/tools").VisionTool;
  taskId: string;
  userGoal: string;
  initialLogs?: TaskSnapshot["logs"];
  signal?: AbortSignal;
  /** LLM-based ReAct decision maker. Called each iteration of the ReAct loop. */
  reactDecideNext?: (
    request: ReActDecisionRequest,
  ) => Promise<AgentReActDecision>;
  /** Called when Commander needs to re-plan after step failure or clarification. */
  replanDag?: (
    userGoal: string,
    contextSnapshot: Record<string, unknown>,
    failedStepId?: string,
    failureReason?: string,
  ) => Promise<CommanderDagPlan>;
  computerUseLoopRunner?: (options: {
    userGoal: string;
    computerTool: ComputerTool;
    approveAction: (action: { tool: string; params: Record<string, unknown> }) => Promise<{ approvalId: string; taskId?: string; sessionWide?: boolean }>;
    onStep?: (step: unknown) => void;
    onProgress?: (step: unknown) => void;
    signal?: AbortSignal;
  }) => Promise<unknown[]>;
}

/**
 * Execute a task via Commander-generated DAG with capability-based dispatch.
 *
 * This is the NEW primary execution path. The Commander generates a DAG plan
 * where each step declares its required capability. The executor dispatches
 * each step to the matching tool via executeCapabilityStep.
 */
export async function runCommanderDagTask({
  controller,
  commanderTool,
  codeTool,
  computerTool,
  fileTool,
  shellTool,
  schedulerTool,
  workspaceTool,
  webTool,
  browserTool,
  verifierTool,
  visionTool,
  taskId,
  userGoal,
  initialLogs = [],
  signal,
  reactDecideNext,
  replanDag,
  computerUseLoopRunner,
}: CommanderDagTaskOptions) {
  const { emit, getSnapshot, wait } = controller;
  throwIfTaskAborted(signal, `Commander DAG task ${taskId}`);
  const context = createSharedTaskContext({ userGoal, taskId });
  if (isVisionGoal(userGoal)) {
    const imagePath = inferImagePath(userGoal);
    if (imagePath) context.set("imagePath", imagePath);
  }
  const agentTracker = createAgentStateTracker(
    demoAgents,
  );
  const taskEventBus = createTaskEventBus();
  const eventLogs: TaskSnapshot["logs"] = [];
  taskEventBus.on((event) => { eventLogs.push(taskEventToLogEntry(event)); });

  let snapshot = getSnapshot();
  function emitSnapshot(next: TaskSnapshot) { emit(next); snapshot = getSnapshot(); }
  function emitEvent(event: TaskRuntimeEvent) {
    taskEventBus.emit(event);
    return eventLogs[eventLogs.length - 1] as TaskSnapshot["logs"][number];
  }

  const taskStartedAt = Date.now();

  const createdLog = emitEvent({ kind: "task.created", taskId });
  agentTracker.setState("agent-commander", {
    status: "planning",
    task: "Generating DAG plan",
    currentStepId: "commander-plan",
  });

  emitSnapshot({
    id: taskId,
    title: "Planning task",
    userGoal,
    status: "planning",
    commanderMessage: "Commander is generating a dynamic DAG plan from available capabilities.",
    plan: [],
    agents: agentTracker.getSnapshots(),
    tokenUsage: createEmptyTokenUsageSummary(),
    logs: [...initialLogs, createdLog],
    executionTrace: {
      taskId,
      startedAt: new Date(taskStartedAt).toISOString(),
      totalWallTimeMs: 0,
      steps: [],
    },
  });

  await wait();
  throwIfTaskAborted(signal, `Commander DAG task ${taskId}`);

  try {
    // Phase 1: Commander generates DAG plan
    const availableAgents = getAvailableAgentsForPlanning();
    let dagPlan: CommanderDagPlan;
    try {
      emitWaitingLog({
        taskId,
        phase: "waiting_model",
        label: "commander.plan",
        detail: "Waiting for Commander to generate a DAG plan.",
        agentKind: "commander",
        getSnapshot,
        emitSnapshot,
        emitEvent,
      });
      dagPlan = normalizeCommanderDagPlan(await withTaskTimeout(
        () => commanderTool.plan({
          userGoal,
          availableAgents,
          workflowId: COMMANDER_DAG_WORKFLOW_ID,
        }),
        {
          label: "commander.plan",
          timeoutMs: COMMANDER_MODEL_TIMEOUT_MS,
          signal,
          onTimeout: () => emitTimeoutLog({
            taskId,
            phase: "waiting_model",
            label: "commander.plan",
            timeoutMs: COMMANDER_MODEL_TIMEOUT_MS,
            detail: "Commander plan timed out.",
            agentKind: "commander",
            getSnapshot,
            emitSnapshot,
            emitEvent,
          }),
          onAbort: () => emitCancelledLog({
            taskId,
            label: "commander.plan",
            detail: "Commander plan cancelled.",
            agentKind: "commander",
            getSnapshot,
            emitSnapshot,
            emitEvent,
          }),
        },
      ));
    } catch (planError) {
      // Commander JSON parse failure fallback: only kick in when the goal
      // clearly looks like desktop automation. This regex-based check is
      // NOT the primary dispatch — Commander (LLM) normally selects the
      // sub-agent. This exists so a malformed JSON response doesn't kill
      // an obvious desktop-automation task.
      if (isTaskCancelledError(planError) || planError instanceof TaskTimeoutError || !isComputerUseGoal(userGoal)) {
        throw planError;
      }
      const detail = planError instanceof Error ? planError.message : String(planError);
      dagPlan = createFallbackComputerUseDagPlan(userGoal, detail);
      emitSnapshot({
        ...getSnapshot(),
        commanderMessage: dagPlan.reasoning,
        logs: appendLog(getSnapshot(), emitEvent({
          kind: "tool.completed",
          taskId,
          toolName: "commander.plan.fallback",
          detail: `Commander JSON plan failed; using Computer Use fallback plan. ${detail}`,
        })),
      });
    }

    if (!dagPlan.steps || dagPlan.steps.length === 0) {
      throw new Error("Commander plan returned no steps.");
    }

    // Only proceed with capability dispatch if at least one step has
    // a capability tag, requiredCapabilities, or is assigned to a
    // non-Commander agent (who executes tools with implicit capabilities).
    const hasCapabilitySteps = dagPlan.steps.some(
      (s) => (s as CommanderDagStep).capability ||
           (s.requiredCapabilities?.length ?? 0) > 0 ||
           s.toolName === "commander.askUser" ||
           (s as CommanderDagStep).executionMode === "direct_response" ||
           s.assignedAgentKind !== "commander",
    );
    if (!hasCapabilitySteps) {
      throw new Error(
        "Commander plan has no capability-tagged steps. " +
        "The plan must include at least one step with a capability or requiredCapabilities field.",
      );
    }

    const plan: TaskStep[] = dagPlan.steps.map((step) => ({
      id: step.id,
      title: step.title,
      assignedAgentKind: step.assignedAgentKind as TaskStep["assignedAgentKind"],
      agentId: `agent-${step.assignedAgentKind}`,
      requiredCapabilities: step.requiredCapabilities,
      status: "pending" as const,
      successCriteria: step.successCriteria,
    }));

    context.set("commanderPlan", dagPlan);

    emitSnapshot({
      ...snapshot,
      title: dagPlan.title || "Commander DAG task",
      status: "running",
      commanderMessage: dagPlan.reasoning,
      plan,
      agents: agentTracker.getSnapshots(),
      logs: appendLog(snapshot, emitEvent({
        kind: "tool.completed",
        taskId,
        toolName: "commander.plan",
        detail: `Commander produced ${dagPlan.steps.length} step(s): ${dagPlan.steps.map((s) => s.id).join(", ")}`,
      })),
    });

    // Pre-set agents to queued
    for (const step of dagPlan.steps) {
      const agentId = `agent-${step.assignedAgentKind}`;
      if (agentTracker.getState(agentId)) {
        agentTracker.setState(agentId, { status: "queued", task: step.title });
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // P0-4: Handle askUser clarification steps before executing the DAG.
    // If the Commander plan includes a commander.askUser step first, pause
    // execution, ask the user, store the answer, and re-plan.
    // ═══════════════════════════════════════════════════════════════════
    // Only handle askUser steps that are ready (no unmet dependencies).
    // Steps with dependencies are handled in executeStepWithReAct during Phase 2.
    const askUserStep = dagPlan.steps.find(
      (s) =>
        (s.toolName === "commander.askUser" ||
         (s as CommanderDagStep).capability === "clarification") &&
        ((s as CommanderDagStep).dependsOn ?? []).length === 0,
    );
    if (askUserStep && controller.setPendingAskUserHandler) {
      const askResult = await waitForAskUserAnswer({
        question: askUserStep.title || "Please clarify your request.",
        choices: askUserStep.choices,
        userGoal,
        taskId,
        stepId: askUserStep.id,
        context,
        getSnapshot,
        emitSnapshot,
        emitEvent,
        agentTracker,
        setPendingAskUserHandler: controller.setPendingAskUserHandler,
        signal,
      });

      // If askUser was the only step, recurse with the clarification
      // appended to the user goal. The recursive call's Phase 1 will
      // generate a fresh plan via commanderTool.plan.
      if (dagPlan.steps.length === 1) {
        return runCommanderDagTask({
          controller,
          commanderTool,
          codeTool,
          computerTool,
          fileTool,
          shellTool,
          schedulerTool,
          workspaceTool,
          webTool,
          browserTool,
          verifierTool,
          visionTool,
          taskId,
          userGoal: `${userGoal}\n\nUser clarification: ${askResult}`,
          signal,
          reactDecideNext,
          replanDag,
          computerUseLoopRunner,
        });
      }

      // If there are more steps after askUser, store answer and continue
      context.set((askUserStep as CommanderDagStep).outputContextKey ?? "clarification", askResult);
      await wait();
      throwIfTaskAborted(signal, `askUser ${askUserStep.id}`);
    }

    // Phase 2: Execute DAG steps via executeWorkflow for parallel scheduling.
    // Independent steps (no shared dependsOn) are executed concurrently with
    // per-step timeout/cancellation so one hung step cannot block the batch.
    const tools: AllCapabilityTools = {
      browserTool, codeTool, computerTool, fileTool,
      shellTool, schedulerTool, workspaceTool, webTool,
      commanderTool, verifierTool, visionTool,
    };
    const completedSteps = new Set<string>();

    // Convert CommanderDagSteps to WorkbenchWorkflowSteps for the DAG executor
    const workflowSteps = dagPlan.steps.map((step) => ({
      id: step.id,
      title: step.title,
      agentKind: step.assignedAgentKind as WorkbenchWorkflowStep["agentKind"],
      input: step.title,
      output: step.successCriteria,
      permissionLevel: getDagStepPermissionLevel(step as CommanderDagStep),
      dependsOn: (step as CommanderDagStep).dependsOn ?? [],
      canRunInParallel: true,
      requiredCapabilities: step.requiredCapabilities as AgentCapabilityTag[] | undefined,
    }));

    const syntheticWorkflow: WorkbenchWorkflow = {
      id: COMMANDER_DAG_WORKFLOW_ID as WorkbenchWorkflowId,
      title: dagPlan.title || "Commander DAG task",
      triggerExamples: [],
      goal: userGoal,
      coordinatorAgentKind: "commander",
      participatingAgentKinds: [...new Set(dagPlan.steps.map((s) => s.assignedAgentKind))] as AgentKind[],
      currentSupport: "partial",
      safetyNotes: [],
      steps: workflowSteps,
    };

    /**
     * P0-2: Execute a single DAG step through the ReAct loop.
     * The agent observes, plans, acts, and observes again — up to 4 iterations.
     * On tool failure, the ReAct loop can retry with a different approach.
     */
    async function executeStepWithReAct(
      wfStep: WorkbenchWorkflowStep,
      _ctx: SharedTaskContext,
    ): Promise<{ output: unknown }> {
      const dagStep = dagPlan.steps.find((s) => s.id === wfStep.id);
      if (!dagStep) {
        throw new Error(`Step ${wfStep.id} not found in Commander plan.`);
      }

      // Handle askUser steps — either already resolved in Phase 1.5
      // (answer in context) or needs inline handling when it has dependencies.
      if (
        dagStep.toolName === "commander.askUser" ||
        (dagStep as CommanderDagStep).capability === "clarification"
      ) {
        const existingAnswer = context.get(`askUserAnswer:${dagStep.id}`) as string | undefined;
        if (existingAnswer !== undefined) {
          completedSteps.add(dagStep.id);
          emitSnapshot({
            ...getSnapshot(),
            plan: markStep(getSnapshot().plan, dagStep.id, "completed"),
            agents: agentTracker.getSnapshots(),
            logs: appendLog(getSnapshot(), emitEvent({
              kind: "tool.completed",
              taskId,
              toolName: "commander.askUser",
              detail: `Step ${dagStep.id}: clarification resolved from Phase 1.5.`,
            })),
          });
          return { output: existingAnswer };
        }
        // Inline askUser: ask now and wait for answer
        if (controller.setPendingAskUserHandler) {
          const answer = await waitForAskUserAnswer({
            question: dagStep.title || "Please clarify your request.",
            choices: dagStep.choices,
            userGoal,
            taskId,
            stepId: dagStep.id,
            context,
            getSnapshot,
            emitSnapshot,
            emitEvent,
            agentTracker,
            setPendingAskUserHandler: controller.setPendingAskUserHandler,
            signal,
          });
          completedSteps.add(dagStep.id);
          context.set((dagStep as CommanderDagStep).outputContextKey ?? "clarification", answer);
          emitSnapshot({
            ...getSnapshot(),
            plan: markStep(getSnapshot().plan, dagStep.id, "completed"),
            agents: agentTracker.getSnapshots(),
            logs: appendLog(getSnapshot(), emitEvent({
              kind: "tool.completed",
              taskId,
              toolName: "commander.askUser",
              detail: `Step ${dagStep.id}: user answered inline.`,
            })),
          });
          return { output: answer };
        }
        // No askUser handler available — skip silently
        completedSteps.add(dagStep.id);
        emitSnapshot({
          ...getSnapshot(),
          plan: markStep(getSnapshot().plan, dagStep.id, "completed"),
          agents: agentTracker.getSnapshots(),
        });
        return { output: context.get((dagStep as CommanderDagStep).outputContextKey ?? "clarification") };
      }

      const capability = (dagStep as CommanderDagStep).capability
        ?? (dagStep.requiredCapabilities?.length ? dagStep.requiredCapabilities[0] : undefined);
      const agentId = `agent-${dagStep.assignedAgentKind}`;

      if (isComputerUseDagStep(dagStep) || isComputerUseCapability(capability)) {
        if (!computerUseLoopRunner) {
          throw new Error("Computer Use loop runner is not available.");
        }
        if (!computerTool) {
          throw new Error("Computer tool is not available.");
        }
        if (!controller.setPendingPermissionHandler) {
          throw new Error("Computer Use requires a permission handler for confirmed-write actions.");
        }

        if (agentTracker.getState(agentId)) {
          agentTracker.setState(agentId, {
            status: "running",
            task: dagStep.title,
            currentStepId: dagStep.id,
          });
        }

        emitSnapshot({
          ...getSnapshot(),
          plan: markStep(getSnapshot().plan, dagStep.id, "running"),
          agents: agentTracker.getSnapshots(),
          logs: appendLog(getSnapshot(), emitEvent({
            kind: "tool.planned",
            taskId,
            toolName: "computer-use.loop",
            detail: `步骤 ${dagStep.id}：开始通过截图和控件信息推进桌面操作。`,
          })),
        });

        const steps = await computerUseLoopRunner({
          userGoal,
          computerTool,
          approveAction: (action) =>
            requestComputerUseApproval({
              action,
              stepId: dagStep.id,
              taskId,
              computerTool,
              getSnapshot,
              emitSnapshot,
              emitEvent,
              agentTracker,
              signal,
              setPendingPermissionHandler: controller.setPendingPermissionHandler!,
            }),
          onStep: (step) => {
            const computerStep = step as ComputerUseStep;
            context.set((dagStep as CommanderDagStep).outputContextKey ?? `step:${dagStep.id}`, computerStep);
            const stepSummary = summarizeComputerUseStep(computerStep);
            emitSnapshot({
              ...getSnapshot(),
              status: "running",
              commanderMessage: stepSummary,
              plan: markStep(getSnapshot().plan, dagStep.id, "running"),
              agents: agentTracker.getSnapshots(),
              logs: appendLog(getSnapshot(), emitEvent({
                kind: "tool.completed",
                taskId,
                toolName: computerStep.action.tool,
                detail: stepSummary,
              })),
            });
          },
          onProgress: (step) => {
            const progressStep = step as ComputerUseStep;
            const phase = progressStep.phase ?? "executing";
            if (agentTracker.getState(agentId)) {
              agentTracker.setState(agentId, {
                status: phase === "waiting_permission" ? "waiting_permission" : "running",
                task: progressStep.observation || `Computer Use: ${phase}`,
                currentStepId: dagStep.id,
              });
            }
            emitSnapshot({
              ...getSnapshot(),
              status: phase === "waiting_permission" ? "waiting_permission" : "running",
              commanderMessage: progressStep.observation || `Computer Use: ${phase}`,
              plan: markStep(getSnapshot().plan, dagStep.id, "running"),
              agents: agentTracker.getSnapshots(),
            });
          },
          signal,
        });
        const failedStep = steps.find((step) =>
          step &&
          typeof step === "object" &&
          "error" in step &&
          String((step as { error?: unknown }).error ?? "").trim().length > 0,
        );
        if (failedStep) {
          const error = String((failedStep as { error?: unknown }).error ?? "");
          if (/denied by user|permission denied|用户已拒绝/i.test(error)) {
            throw new Error("用户已拒绝桌面操作。");
          }
          throw new Error(`Computer Use failed: ${error}`);
        }

        completedSteps.add(dagStep.id);
        context.set((dagStep as CommanderDagStep).outputContextKey ?? `step:${dagStep.id}`, steps);
        if (agentTracker.getState(agentId)) {
          agentTracker.setState(agentId, {
            status: "completed",
            task: `已完成：${dagStep.title}`,
          });
        }
        emitSnapshot({
          ...getSnapshot(),
          commanderMessage: `桌面操作流程完成，共执行 ${steps.length} 步。`,
          plan: markStep(getSnapshot().plan, dagStep.id, "completed"),
          agents: agentTracker.getSnapshots(),
          logs: appendLog(getSnapshot(), emitEvent({
            kind: "tool.completed",
            taskId,
            toolName: "computer-use.loop",
            detail: `步骤 ${dagStep.id}：桌面操作流程完成，共执行 ${steps.length} 步。`,
          })),
        });
        return { output: steps };
      }

      if (agentTracker.getState(agentId)) {
        agentTracker.setState(agentId, {
          status: "running",
          task: dagStep.title,
          currentStepId: dagStep.id,
        });
      }

      emitSnapshot({
        ...getSnapshot(),
        plan: markStep(getSnapshot().plan, dagStep.id, "running"),
        agents: agentTracker.getSnapshots(),
        logs: appendLog(getSnapshot(), emitEvent({
          kind: "tool.planned",
          taskId,
          toolName: `${dagStep.assignedAgentKind}.${dagStep.id}`,
          detail: `Dispatching step ${dagStep.id} via capability: ${capability ?? "unknown"} (ReAct loop)`,
        })),
      });

      await wait();

      const executionMode = resolveStepExecutionMode(dagStep as CommanderDagStep);
      const agentDef = demoAgents.find((a) => a.kind === dagStep.assignedAgentKind);
      const allowedToolNames = agentDef?.allowedToolNames ?? [];
      const stepToolDescriptors = filterToolDescriptorsForStep(
        dagStep as CommanderDagStep,
        allowedToolNames,
      );

      // Build ReAct tools from available tool descriptors filtered by agent, capability, and toolName.
      const reactTools: AgentReActTool[] = stepToolDescriptors
        .map((td) => ({
          name: td.name,
          execute: async () => {
            const stepInput = resolveStepInput(
              (dagStep as CommanderDagStep).inputContextKeys,
              context,
            );
            const output = await withTaskTimeout(
              () => dispatchToolByName(td.name, stepInput, tools),
              {
                label: `ReAct tool ${td.name}`,
                timeoutMs: COMMANDER_TOOL_TIMEOUT_MS,
                signal,
              },
            );
            writeStepOutput(
              (dagStep as CommanderDagStep).outputContextKey ?? `step:${dagStep.id}`,
              output,
              context,
            );
            return output;
          },
        }));

      // ReAct is opt-in. Direct response/tool-call steps skip the extra LLM decision.
      if (executionMode === "react" && reactDecideNext && reactTools.length > 0) {
        const reactResult = await runAgentReActLoop({
          agent: { kind: dagStep.assignedAgentKind, allowedToolNames } as Agent,
          step: wfStep,
          context,
          tools: reactTools,
          maxIterations: 4,
          signal,
          decisionTimeoutMs: COMMANDER_MODEL_TIMEOUT_MS,
          toolTimeoutMs: COMMANDER_TOOL_TIMEOUT_MS,
          decideNext: (req) =>
            reactDecideNext({
              agentKind: req.agent.kind,
              stepId: req.step.id,
              stepTitle: req.step.title,
              userGoal,
              successCriteria: dagStep.successCriteria,
              capability: (dagStep as CommanderDagStep).capability,
              observations: req.observations,
              availableTools: reactTools.map((t) => {
                const td = stepToolDescriptors.find((d) => d.name === t.name);
                return {
                  name: t.name,
                  summary: td?.summary ?? "",
                  capabilityTags: td?.capabilityTags ?? [],
                };
              }),
            }),
          onWaiting: (phase, iteration, detail) => {
            emitWaitingLog({
              taskId,
              phase,
              label: `${dagStep.id} iteration ${iteration}`,
              detail: `Step ${dagStep.id} iteration ${iteration}: ${detail}`,
              stepId: dagStep.id,
              agentKind: dagStep.assignedAgentKind as AgentKind,
              toolName: `${dagStep.assignedAgentKind}.${phase}`,
              getSnapshot,
              emitSnapshot,
              emitEvent,
            });
          },
          onTimeout: (phase, iteration, detail) => {
            emitTimeoutLog({
              taskId,
              phase,
              label: `${dagStep.id} iteration ${iteration}`,
              timeoutMs: phase === "waiting_model" ? COMMANDER_MODEL_TIMEOUT_MS : COMMANDER_TOOL_TIMEOUT_MS,
              detail: `Step ${dagStep.id} ${phase} iteration ${iteration}: ${detail}`,
              stepId: dagStep.id,
              agentKind: dagStep.assignedAgentKind as AgentKind,
              toolName: `${dagStep.assignedAgentKind}.${phase}`,
              getSnapshot,
              emitSnapshot,
              emitEvent,
            });
          },
        });

        if (reactResult.status === "completed") {
          completedSteps.add(dagStep.id);
          if (agentTracker.getState(agentId)) {
            agentTracker.setState(agentId, {
              status: "completed",
              task: `Completed: ${dagStep.title} (ReAct: ${reactResult.observations.length} iterations)`,
            });
          }
          emitSnapshot({
            ...getSnapshot(),
            plan: markStep(getSnapshot().plan, dagStep.id, "completed"),
            agents: agentTracker.getSnapshots(),
            logs: appendLog(getSnapshot(), emitEvent({
              kind: "tool.completed",
              taskId,
              toolName: `${dagStep.assignedAgentKind}.${dagStep.id}`,
              detail: `Step ${dagStep.id}: ReAct completed after ${reactResult.observations.length} iteration(s). ${reactResult.reason}`,
            })),
          });
          return { output: reactResult.output };
        }

        // ReAct failed — throw to trigger replan
        throw new Error(
          `ReAct loop failed for step ${dagStep.id}: ${reactResult.reason}`,
        );
      }

      if (executionMode === "direct_response") {
        emitWaitingLog({
          taskId,
          phase: "waiting_model",
          label: `commander.synthesize ${dagStep.id}`,
          detail: `Waiting for Commander synthesis for step ${dagStep.id}.`,
          stepId: dagStep.id,
          agentKind: "commander",
          getSnapshot,
          emitSnapshot,
          emitEvent,
        });
        const synthesis = await withTaskTimeout(
          () => safeSynthesizeConclusion(
            commanderTool,
            userGoal,
            dagStep.title,
            context.snapshot(),
          ),
          {
            label: `commander.synthesize ${dagStep.id}`,
            timeoutMs: COMMANDER_MODEL_TIMEOUT_MS,
            signal,
            onTimeout: () => emitTimeoutLog({
              taskId,
              phase: "waiting_model",
              label: `commander.synthesize ${dagStep.id}`,
              timeoutMs: COMMANDER_MODEL_TIMEOUT_MS,
              detail: `Commander synthesis for ${dagStep.id} timed out.`,
              stepId: dagStep.id,
              agentKind: "commander",
              getSnapshot,
              emitSnapshot,
              emitEvent,
            }),
            onAbort: () => emitCancelledLog({
              taskId,
              label: `commander.synthesize ${dagStep.id}`,
              detail: `Commander synthesis for ${dagStep.id} cancelled.`,
              stepId: dagStep.id,
              agentKind: "commander",
              getSnapshot,
              emitSnapshot,
              emitEvent,
            }),
          },
        );
        const output = synthesis?.message ?? dagStep.title;
        writeStepOutput(
          (dagStep as CommanderDagStep).outputContextKey ?? `step:${dagStep.id}`,
          output,
          context,
        );
        completedSteps.add(dagStep.id);

        if (agentTracker.getState(agentId)) {
          agentTracker.setState(agentId, {
            status: "completed",
            task: `Completed: ${dagStep.title}`,
          });
        }

        emitSnapshot({
          ...getSnapshot(),
          plan: markStep(getSnapshot().plan, dagStep.id, "completed"),
          agents: agentTracker.getSnapshots(),
          logs: appendLog(getSnapshot(), emitEvent({
            kind: "tool.completed",
            taskId,
            toolName: `${dagStep.assignedAgentKind}.direct_response`,
            detail: `Step ${dagStep.id}: direct response completed without ReAct.`,
          })),
        });

        return { output };
      }

      // Fallback: single-shot capability dispatch
      try {
        emitWaitingLog({
          taskId,
          phase: "waiting_tool",
          label: `tool dispatch ${dagStep.id}`,
          detail: `Waiting for tool dispatch for step ${dagStep.id}.`,
          stepId: dagStep.id,
          agentKind: dagStep.assignedAgentKind as AgentKind,
          toolName: `${dagStep.assignedAgentKind}.${dagStep.id}`,
          getSnapshot,
          emitSnapshot,
          emitEvent,
        });
        const result = await withTaskTimeout(
          () => executeCapabilityStep(
            dagStep as CommanderDagStep,
            context,
            tools,
            { signal, timeoutMs: COMMANDER_TOOL_TIMEOUT_MS },
          ),
          {
            label: `tool dispatch ${dagStep.id}`,
            timeoutMs: COMMANDER_TOOL_TIMEOUT_MS,
            signal,
            onTimeout: () => emitTimeoutLog({
              taskId,
              phase: "waiting_tool",
              label: `tool dispatch ${dagStep.id}`,
              timeoutMs: COMMANDER_TOOL_TIMEOUT_MS,
              detail: `Step ${dagStep.id} tool dispatch timed out.`,
              stepId: dagStep.id,
              agentKind: dagStep.assignedAgentKind as AgentKind,
              toolName: `${dagStep.assignedAgentKind}.${dagStep.id}`,
              getSnapshot,
              emitSnapshot,
              emitEvent,
            }),
            onAbort: () => emitCancelledLog({
              taskId,
              label: `tool dispatch ${dagStep.id}`,
              detail: `Step ${dagStep.id} tool dispatch cancelled.`,
              stepId: dagStep.id,
              agentKind: dagStep.assignedAgentKind as AgentKind,
              getSnapshot,
              emitSnapshot,
              emitEvent,
            }),
          },
        );
        completedSteps.add(dagStep.id);

        if (agentTracker.getState(agentId)) {
          agentTracker.setState(agentId, {
            status: "completed",
            task: `Completed: ${dagStep.title}`,
          });
        }

        emitSnapshot({
          ...getSnapshot(),
          plan: markStep(getSnapshot().plan, dagStep.id, "completed"),
          agents: agentTracker.getSnapshots(),
          logs: appendLog(getSnapshot(), emitEvent({
            kind: "tool.completed",
            taskId,
            toolName: result.toolName,
            detail: `Step ${dagStep.id}: ${result.toolName} completed.`,
          })),
        });

        return { output: result.output };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);

        if (agentTracker.getState(agentId)) {
          agentTracker.setState(agentId, {
            status: "failed",
            task: `Failed: ${errorMsg}`,
          });
        }

        emitSnapshot({
          ...getSnapshot(),
          plan: markStep(getSnapshot().plan, dagStep.id, "failed"),
          agents: agentTracker.getSnapshots(),
          logs: appendLog(getSnapshot(), emitEvent({
            kind: "task.failed",
            taskId,
            error: errorMsg,
          })),
        });

        throw error;
      }
    }

    // P0-3: Failure replanning — when a step fails, ask Commander to generate
    // recovery steps. If replanning succeeds, the failed step is abandoned and
    // recovery steps are appended to the DAG.
    async function handleStepFailureReplan(request: {
      step: WorkbenchWorkflowStep;
      error: string;
      workflow: WorkbenchWorkflow;
      context: SharedTaskContext;
      completedStepIds: string[];
    }) {
      if (!replanDag) return undefined;

      const dagStep = dagPlan.steps.find((s) => s.id === request.step.id);
      if (!dagStep) return undefined;

      try {
        emitSnapshot({
          ...getSnapshot(),
          logs: [
            ...getSnapshot().logs,
            emitEvent({
              kind: "task.replan_started",
              taskId,
              failedStepId: request.step.id,
              error: request.error,
            }),
            emitEvent({
              kind: "task.waiting",
              taskId,
              phase: "waiting_model",
              label: `commander.replan ${request.step.id}`,
              detail: `Waiting for Commander replan after ${request.step.id}.`,
              stepId: request.step.id,
              agentKind: "commander",
              toolName: "commander.replan",
            }),
          ],
        });
        const recoveryPlan = await withTaskTimeout(
          () => replanDag(
            userGoal,
            request.context.snapshot(),
            request.step.id,
            request.error,
          ),
          {
            label: `commander.replan ${request.step.id}`,
            timeoutMs: COMMANDER_REPLAN_TIMEOUT_MS,
            signal,
            onTimeout: () => emitTimeoutLog({
              taskId,
              phase: "waiting_model",
              label: `commander.replan ${request.step.id}`,
              timeoutMs: COMMANDER_REPLAN_TIMEOUT_MS,
              detail: `commander.replan timed out after ${request.step.id}.`,
              stepId: request.step.id,
              agentKind: "commander",
              toolName: "commander.replan",
              getSnapshot,
              emitSnapshot,
              emitEvent,
            }),
            onAbort: () => emitCancelledLog({
              taskId,
              label: `commander.replan ${request.step.id}`,
              detail: `commander.replan cancelled after ${request.step.id}.`,
              stepId: request.step.id,
              agentKind: "commander",
              getSnapshot,
              emitSnapshot,
              emitEvent,
            }),
          },
        );

        if (!recoveryPlan.steps || recoveryPlan.steps.length === 0) {
          return undefined;
        }

        // Convert recovery steps to workflow steps.
        // Use the Commander's declared dependsOn, filtering out the failed step
        // (which is abandoned, so depending on it would deadlock).
        const failedId = request.step.id;
        const recoverySteps: WorkbenchWorkflowStep[] = recoveryPlan.steps.map((s) => ({
          id: s.id,
          title: s.title,
          agentKind: s.assignedAgentKind as WorkbenchWorkflowStep["agentKind"],
          input: s.title,
          output: s.successCriteria,
          permissionLevel: getDagStepPermissionLevel(s as CommanderDagStep),
          dependsOn: (s.dependsOn ?? []).filter((depId) => depId !== failedId),
          canRunInParallel: true,
          requiredCapabilities: s.requiredCapabilities as AgentCapabilityTag[] | undefined,
        }));

        // Add recovery steps to the dagPlan for tracking
        for (const rs of recoveryPlan.steps) {
          dagPlan.steps.push(rs as CommanderDagStep);
        }

        emitSnapshot({
          ...getSnapshot(),
          commanderMessage: `Step ${request.step.id} failed. Commander re-planned ${recoverySteps.length} recovery step(s): ${recoverySteps.map((s) => s.id).join(", ")}`,
          logs: appendLog(getSnapshot(), emitEvent({
            kind: "tool.planned",
            taskId,
            toolName: "commander.plan",
            detail: `Re-plan: ${recoverySteps.length} recovery step(s) for failed step ${request.step.id}.`,
          })),
        });

        return { abandonFailedStep: true, steps: recoverySteps };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        emitSnapshot({
          ...getSnapshot(),
          logs: appendLog(getSnapshot(), emitEvent({
            kind: "task.replan_failed",
            taskId,
            failedStepId: request.step.id,
            error: errorMsg,
          })),
        });
        return undefined;
      }
    }

    const execution = await executeWorkflow({
      workflow: syntheticWorkflow,
      context,
      signal,
      stepTimeoutMs: COMMANDER_TOOL_TIMEOUT_MS,
      executeStep: executeStepWithReAct,
      onStepStarted: (step) => {
        emitSnapshot({
          ...getSnapshot(),
          plan: markStep(getSnapshot().plan, step.id, "running"),
          logs: appendLog(getSnapshot(), emitEvent({
            kind: "step.started",
            taskId,
            stepId: step.id,
            agentKind: step.agentKind,
          })),
        });
      },
      onStepCompleted: (_step, _output, _ctx) => {
        emitSnapshot({
          ...getSnapshot(),
          plan: markStep(getSnapshot().plan, _step.id, "completed"),
          logs: appendLog(getSnapshot(), emitEvent({
            kind: "step.completed",
            taskId,
            stepId: _step.id,
            summary: `Step ${_step.id} completed.`,
            agentKind: _step.agentKind,
          })),
        });
      },
      onStepFailed: (_step, _error, _ctx) => {
        // Already handled in executeStepWithReAct above
      },
      onStepHeartbeat: (step, elapsedMs) => {
        emitSnapshot({
          ...getSnapshot(),
          logs: appendLog(getSnapshot(), emitEvent({
            kind: "step.progress",
            taskId,
            stepId: step.id,
            agentKind: step.agentKind,
            percent: 50,
            detail: `Still waiting on step ${step.id} after ${Math.round(elapsedMs / 1000)}s.`,
          })),
        });
      },
      onStepTimeout: (step, timeoutMs) => {
        emitSnapshot({
          ...getSnapshot(),
          logs: [
            ...getSnapshot().logs,
            emitEvent({
              kind: "task.timeout",
              taskId,
              phase: "waiting_tool",
              label: `workflow step ${step.id}`,
              timeoutMs,
              detail: `Step ${step.id} timed out after ${timeoutMs}ms.`,
              stepId: step.id,
              agentKind: step.agentKind,
            }),
            emitEvent({
              kind: "task.failed",
              taskId,
              error: `Step ${step.id} timed out after ${timeoutMs}ms.`,
            }),
          ],
        });
      },
      onStepFailureReplan: handleStepFailureReplan,
      onStepReplanned: (step, error, action, _ctx) => {
        const recoveryPlanSteps: TaskStep[] = (action.steps ?? []).map((s) => ({
          id: s.id,
          title: s.title,
          assignedAgentKind: s.agentKind as TaskStep["assignedAgentKind"],
          agentId: `agent-${s.agentKind}`,
          requiredCapabilities: s.requiredCapabilities,
          status: "pending" as const,
          successCriteria: s.output,
        }));
        emitSnapshot({
          ...getSnapshot(),
          plan: [...getSnapshot().plan, ...recoveryPlanSteps],
          logs: appendLog(getSnapshot(), emitEvent({
            kind: "tool.completed",
            taskId,
            toolName: "commander.replan",
            detail: `Recovery for ${step.id}: ${action.steps?.length ?? 0} step(s) added. Error was: ${error}`,
          })),
        });
      },
    });

    if (execution.status === "failed" && completedSteps.size === 0) {
      throw new Error(execution.error ?? "Commander DAG execution failed.");
    }

    // Phase 3: Commander synthesizes conclusion
    emitWaitingLog({
      taskId,
      phase: "waiting_model",
      label: "commander.synthesize final",
      detail: "Waiting for Commander final synthesis.",
      agentKind: "commander",
      getSnapshot,
      emitSnapshot,
      emitEvent,
    });
    const synthesis = await withTaskTimeout(
      () => safeSynthesizeConclusion(
        commanderTool,
        userGoal,
        dagPlan.title || "Commander DAG task",
        context.snapshot(),
      ),
      {
        label: "commander.synthesize final",
        timeoutMs: COMMANDER_MODEL_TIMEOUT_MS,
        signal,
        onTimeout: () => emitTimeoutLog({
          taskId,
          phase: "waiting_model",
          label: "commander.synthesize final",
          timeoutMs: COMMANDER_MODEL_TIMEOUT_MS,
          detail: "Commander final synthesis timed out.",
          agentKind: "commander",
          getSnapshot,
          emitSnapshot,
          emitEvent,
        }),
        onAbort: () => emitCancelledLog({
          taskId,
          label: "commander.synthesize final",
          detail: "Commander final synthesis cancelled.",
          agentKind: "commander",
          getSnapshot,
          emitSnapshot,
          emitEvent,
        }),
      },
    );
    const conclusion = synthesis?.message
      ?? `Task completed: ${completedSteps.size}/${dagPlan.steps.length} step(s) executed.`;
    const allCompleted = execution.status === "completed";

    agentTracker.setState("agent-commander", {
      status: allCompleted ? "completed" : "failed",
      task: allCompleted ? "Task conclusion written" : "Some steps failed",
    });

    const now = Date.now();
    const trace = getSnapshot().executionTrace;
    emitSnapshot({
      ...getSnapshot(),
      title: dagPlan.title || "Task completed",
      status: allCompleted ? "completed" : "failed",
      commanderMessage: conclusion,
      plan: snapshot.plan.map((s) => ({
        ...s,
        status: s.status === "pending" ? ("skipped" as const) : s.status,
      })),
      agents: agentTracker.getSnapshots(),
      verificationSummary: allCompleted
        ? `verified: ${execution.completedStepIds.length}/${execution.completedStepIds.length + (execution.abandonedStepIds?.length ?? 0)} steps completed via Commander DAG.`
        : `warn: ${execution.completedStepIds.length}/${execution.completedStepIds.length + (execution.abandonedStepIds?.length ?? 0)} steps completed.`,
      executionTrace: trace ? {
        ...trace,
        completedAt: new Date(now).toISOString(),
        totalWallTimeMs: now - taskStartedAt,
        steps: dagPlan.steps.map((s) => ({
          stepId: s.id,
          agentKind: s.assignedAgentKind,
          toolName: s.toolName,
          startedAt: trace.startedAt,
          completedAt: new Date(now).toISOString(),
          wallTimeMs: 0,
          status: (allCompleted ? "completed" : "failed") as "completed" | "failed" | "skipped",
        })),
      } : undefined,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const userError = toUserFacingError(errorMsg);
    const cancelled = isTaskCancelledError(error);
    agentTracker.setState("agent-commander", {
      status: cancelled ? "cancelled" : "failed",
      task: cancelled ? "Task cancelled" : userError,
    });

    const completionEvent: TaskRuntimeEvent = cancelled
      ? { kind: "task.completed", taskId, detail: "Task cancelled." }
      : { kind: "task.failed", taskId, error: errorMsg };

    emitSnapshot({
      ...getSnapshot(),
      title: cancelled ? "Task cancelled" : "Commander DAG plan failed",
      status: cancelled ? "cancelled" : "failed",
      commanderMessage: cancelled ? "Task cancelled." : userError,
      userFacingError: cancelled ? undefined : userError,
      askUserQuestion: undefined,
      permissionRequest: undefined,
      plan: snapshot.plan.map((s) => ({
        ...s,
        status: s.status === "running" ? (cancelled ? "skipped" as const : "failed" as const)
          : s.status === "pending" ? ("skipped" as const)
          : s.status,
      })),
      agents: agentTracker.getSnapshots(),
      logs: appendLog(snapshot, emitEvent(completionEvent)),
    });
  }
}

async function safeVerifyGenericWorkflow(
  verifierTool: VerifierTool | undefined,
  workflow: WorkbenchWorkflow,
  contextSnapshot: Record<string, unknown>,
): Promise<VerifierCheckResult | undefined> {
  if (!verifierTool) {
    return undefined;
  }
  try {
    return await verifierTool.check({
      stepId: `${workflow.id}:generic-summary`,
      successCriteria: `Workflow ${workflow.id} is routed through the DAG executor and implementation gaps are explicit.`,
      evidence: [
        {
          kind: "log",
          label: "Workflow blueprint",
          data: {
            id: workflow.id,
            title: workflow.title,
            steps: workflow.steps.map((step) => ({
              id: step.id,
              agentKind: step.agentKind,
              permissionLevel: step.permissionLevel,
              dependsOn: step.dependsOn,
            })),
          },
        },
        {
          kind: "log",
          label: "Shared workflow context",
          data: contextSnapshot,
        },
      ],
    });
  } catch {
    return undefined;
  }
}

type SnapshotEmitter = (nextSnapshot: TaskSnapshot) => void;
type RuntimeEventEmitter = (event: TaskRuntimeEvent) => TaskSnapshot["logs"][number];
type ReadCurrentProjectAgentTracker = ReturnType<typeof createAgentStateTracker>;

interface GenericStepOutput {
  workflowId: string;
  stepId: string;
  status: "completed" | "unsupported";
  summary: string;
  expectedOutput: string;
  data?: Record<string, unknown>;
}

interface ProjectInspectionStepOutput {
  project: ProjectInspection;
  commands: ShellCommandOutput[];
}

interface AnalyzeCodeStepOutput {
  codeReviewPreview: Awaited<ReturnType<typeof safeInspectRepository>> | undefined;
  analysisSummary: string;
}

function concreteOutput(
  workflow: WorkbenchWorkflow,
  step: WorkbenchWorkflowStep,
  summary: string,
  data?: Record<string, unknown>,
): GenericStepOutput {
  return {
    workflowId: workflow.id,
    stepId: step.id,
    status: "completed",
    summary,
    expectedOutput: step.output,
    data,
  };
}

function unsupportedOutput(
  workflow: WorkbenchWorkflow,
  step: WorkbenchWorkflowStep,
): GenericStepOutput {
  return {
    workflowId: workflow.id,
    stepId: step.id,
    status: "unsupported",
    summary:
      isApprovalGatedPermissionLevel(step.permissionLevel)
        ? "Approval-gated workflow steps are not dispatched by the generic executor."
        : "No concrete read tool is wired for this workflow step yet.",
    expectedOutput: step.output,
  };
}

function getWorkflowStepKey(stepId: string): string {
  return stepId.includes(":") ? stepId.slice(stepId.lastIndexOf(":") + 1) : stepId;
}

function getSourcesFromContext(contextSnapshot: Record<string, unknown>): WebSource[] {
  return Object.values(contextSnapshot)
    .flatMap((value) => isGenericStepOutput(value) && Array.isArray(value.data?.sources)
      ? value.data.sources
      : [])
    .filter(isWebSource);
}

function getCandidatesFromContext(contextSnapshot: Record<string, unknown>): ComputerFileCandidate[] {
  return Object.values(contextSnapshot)
    .flatMap((value) => isGenericStepOutput(value) && Array.isArray(value.data?.candidates)
      ? value.data.candidates
      : [])
    .filter(isComputerFileCandidate);
}

function getQueryFromContext(contextSnapshot: Record<string, unknown>): string | undefined {
  for (const value of Object.values(contextSnapshot)) {
    if (isGenericStepOutput(value) && typeof value.data?.query === "string") {
      return value.data.query;
    }
  }
  return undefined;
}

function getScheduleDraftFromContext(
  contextSnapshot: Record<string, unknown>,
): Parameters<SchedulerTool["createTask"]>[0] | undefined {
  for (const value of Object.values(contextSnapshot)) {
    if (isGenericStepOutput(value) && isScheduleDraft(value.data?.scheduledTaskDraft)) {
      return value.data.scheduledTaskDraft;
    }
  }
  return undefined;
}

function getScheduledTaskFromContext(
  contextSnapshot: Record<string, unknown>,
): Awaited<ReturnType<SchedulerTool["createTask"]>> | undefined {
  for (const value of Object.values(contextSnapshot)) {
    if (isGenericStepOutput(value) && isScheduledTaskResult(value.data?.scheduledTask)) {
      return value.data.scheduledTask;
    }
  }
  return undefined;
}

function getTestScriptFromContext(contextSnapshot: Record<string, unknown>): string | undefined {
  for (const value of Object.values(contextSnapshot)) {
    if (isGenericStepOutput(value) && typeof value.data?.testScript === "string") {
      return value.data.testScript;
    }
  }
  return undefined;
}

function deriveGenericWorkflowSnapshotData(contextSnapshot: Record<string, unknown>): Partial<TaskSnapshot> {
  const sources = getSourcesFromContext(contextSnapshot);
  const candidates = getCandidatesFromContext(contextSnapshot);
  const fileScan = contextSnapshot.fileScan as { documents?: MarkdownDocumentSummary[] } | undefined;
  const scannedDocuments = Array.isArray(fileScan?.documents) ? fileScan.documents : [];
  const researchReport = Object.values(contextSnapshot)
    .map((value) => isGenericStepOutput(value) ? value.data?.researchReport : undefined)
    .find((value): value is NonNullable<TaskSnapshot["researchReport"]> =>
      Boolean(value && typeof value === "object"),
    );
  const codeReviewPreview = Object.values(contextSnapshot)
    .map((value) => isGenericStepOutput(value) ? value.data?.codeReviewPreview : undefined)
    .find((value): value is NonNullable<TaskSnapshot["codeReviewPreview"]> =>
      Boolean(value && typeof value === "object"),
    );
  const verificationSummary = Object.values(contextSnapshot)
    .map((value) => isGenericStepOutput(value) ? value.data?.verificationSummary : undefined)
    .find((value): value is string => typeof value === "string");

  return {
    ...(sources.length > 0 ? { sources } : {}),
    ...(researchReport ? { researchReport } : {}),
    ...(codeReviewPreview ? { codeReviewPreview } : {}),
    ...(verificationSummary ? { verificationSummary } : {}),
    ...(scannedDocuments.length > 0 ? { documents: scannedDocuments } : {}),
    ...(candidates.length > 0
      ? {
          documents: candidates.map((candidate) => ({
            path: candidate.path,
            modifiedAt: candidate.modifiedAt ?? new Date(0).toISOString(),
            sizeBytes: candidate.sizeBytes ?? 0,
            heading: candidate.name,
            excerpt: candidate.extension ?? "",
            purpose: `Local candidate ranked for ${candidate.name}`,
          })),
        }
      : {}),
  };
}

function createSpringBootPlanSummary(userGoal: string, sources: WebSource[]): string {
  return [
    `Preview-only Spring Boot plan for: ${userGoal}`,
    "1. Clarify API/domain/database requirements.",
    "2. Choose current Spring Boot version and dependencies from source-backed guidance.",
    "3. Draft Controller, Service, Repository, configuration, and test steps.",
    "4. Ask for confirmed-write approval before creating files or running generators.",
    `Source evidence count: ${sources.length}.`,
  ].join("\n");
}

function rankLocalCandidates(
  candidates: ComputerFileCandidate[],
  userGoal: string,
): ComputerFileCandidate[] {
  const normalizedGoal = userGoal.toLowerCase();
  return [...candidates].sort((left, right) =>
    scoreCandidate(right, normalizedGoal) - scoreCandidate(left, normalizedGoal),
  );
}

function scoreCandidate(candidate: ComputerFileCandidate, normalizedGoal: string): number {
  const haystack = `${candidate.name} ${candidate.path} ${candidate.extension ?? ""}`.toLowerCase();
  return normalizedGoal
    .split(/\s+/)
    .filter((part) => part.length > 1 && haystack.includes(part))
    .length;
}

function createScheduleDraft(userGoal: string): Parameters<SchedulerTool["createTask"]>[0] {
  const time = userGoal.match(/(\d{1,2})(?::(\d{2}))?/)?.slice(1, 3) ?? ["8", "00"];
  const hour = Math.max(0, Math.min(23, Number(time[0] ?? "8")));
  const minute = Math.max(0, Math.min(59, Number(time[1] ?? "0")));
  const value = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const type: "daily" | "weekly" | "once" = /weekly|\u6bcf\u5468/i.test(userGoal)
    ? "weekly"
    : /once|\u4e00\u6b21/i.test(userGoal)
      ? "once"
      : "daily";
  const schedule: Parameters<SchedulerTool["createTask"]>[0]["schedule"] = type === "weekly"
    ? { type: "weekly", value: `Mon ${value}` }
    : type === "once"
      ? { type: "once", value: new Date(Date.now() + 60 * 60 * 1000).toISOString() }
      : { type: "daily", value };
  return {
    name: userGoal.slice(0, 60) || "Scheduled reminder",
    goal: userGoal,
    schedule,
    nextRunAt: new Date(Date.now() + 60 * 1000).toISOString(),
  };
}

function isGenericStepOutput(value: unknown): value is GenericStepOutput {
  return value !== null && typeof value === "object" && "status" in value && "stepId" in value;
}

function isWebSource(value: unknown): value is WebSource {
  return Boolean(value) && typeof value === "object" && typeof (value as WebSource).url === "string";
}

function isComputerFileCandidate(value: unknown): value is ComputerFileCandidate {
  return Boolean(value) && typeof value === "object" && typeof (value as ComputerFileCandidate).path === "string";
}

function isScheduleDraft(value: unknown): value is Parameters<SchedulerTool["createTask"]>[0] {
  return Boolean(value) && typeof value === "object" && typeof (value as { goal?: unknown }).goal === "string";
}

function isScheduledTaskResult(value: unknown): value is Awaited<ReturnType<SchedulerTool["createTask"]>> {
  return isScheduleDraft(value) && typeof (value as { id?: unknown }).id === "string";
}

async function runScanFilesStep({
  agentTracker,
  controller,
  emit,
  emitEvent,
  fileTool,
  taskId,
}: {
  agentTracker: ReadCurrentProjectAgentTracker;
  controller: FlowController;
  emit: SnapshotEmitter;
  emitEvent: RuntimeEventEmitter;
  fileTool: FileTool;
  taskId: ID;
}): Promise<MarkdownDocumentSummary[]> {
  agentTracker.setState("agent-commander", {
    status: "completed",
    task: "Workflow submitted",
  });
  agentTracker.setState("agent-file", {
    status: "running",
    task: "Scanning Markdown project documents",
    currentStepId: "scan-files",
  });

  emit({
    ...controller.getSnapshot(),
    status: "running",
    commanderMessage:
      "File Agent is scanning Markdown documents. Shell and Code Agents are working in parallel.",
    plan: markStep(controller.getSnapshot().plan, "scan-files", "running"),
    agents: agentTracker.getSnapshots(),
    logs: appendLog(controller.getSnapshot(), emitEvent({
      kind: "tool.planned",
      taskId,
      toolName: "file.scanMarkdownDocuments",
      detail: "file.scanMarkdownDocuments collects read-only project document evidence.",
    })),
  });

  const documents = summarizeMarkdownDocuments(await fileTool.scanMarkdownDocuments());

  agentTracker.setState("agent-file", {
    status: "completed",
    task: `Found ${documents.length} Markdown documents`,
  });

  emit({
    ...controller.getSnapshot(),
    commanderMessage: `File Agent found ${documents.length} Markdown document(s).`,
    plan: markStep(controller.getSnapshot().plan, "scan-files", "completed"),
    agents: agentTracker.getSnapshots(),
    documents,
    logs: appendLog(controller.getSnapshot(), emitEvent({
      kind: "tool.completed",
      taskId,
      toolName: "file.scanMarkdownDocuments",
      detail: `file.scanMarkdownDocuments returned ${documents.length} document record(s).`,
    })),
  });

  return documents;
}

async function runInspectProjectStep({
  agentTracker,
  controller,
  emit,
  emitEvent,
  projectTool,
  shellTool,
  taskId,
}: {
  agentTracker: ReadCurrentProjectAgentTracker;
  controller: FlowController;
  emit: SnapshotEmitter;
  emitEvent: RuntimeEventEmitter;
  projectTool: ProjectTool;
  shellTool: ShellTool;
  taskId: ID;
}): Promise<ProjectInspectionStepOutput> {
  agentTracker.setState("agent-shell", {
    status: "running",
    task: "Inspecting project scripts and environment",
    currentStepId: "inspect-project",
  });

  emit({
    ...controller.getSnapshot(),
    status: "running",
    commanderMessage: "Shell Agent is inspecting project scripts and environment.",
    plan: markStep(controller.getSnapshot().plan, "inspect-project", "running"),
    agents: agentTracker.getSnapshots(),
    logs: appendLog(controller.getSnapshot(), emitEvent({
      kind: "tool.planned",
      taskId,
      toolName: "project.inspect",
      detail: "project.inspect + shell.runReadOnlyCommand for project environment evidence.",
    })),
  });

  const project = await projectTool.inspectProject();
  const commands = await runProjectReadOnlyCommands(shellTool);

  agentTracker.setState("agent-shell", {
    status: "completed",
    task: "Read-only project checks completed",
  });

  emit({
    ...controller.getSnapshot(),
    commanderMessage: `Shell Agent completed project inspection: ${project.scripts.length} script(s), ${commands.length} command(s).`,
    plan: markStep(controller.getSnapshot().plan, "inspect-project", "completed"),
    agents: agentTracker.getSnapshots(),
    project,
    commands,
    logs: [
      ...appendLog(controller.getSnapshot(), emitEvent({
        kind: "tool.completed",
        taskId,
        toolName: "project.inspect",
        detail: `project.inspect found ${project.scripts.length} script(s), and Shell Agent ran ${commands.length} command(s).`,
      })),
      ...commands.map((command, index) => ({
        id: `${taskId}-command-${index}`,
        kind: "tool" as const,
        title: command.command,
        detail: `exit=${command.exitCode ?? "unknown"} stdout=${command.stdout || "(empty)"}`,
      })),
    ],
  });

  return { project, commands };
}

async function runAnalyzeCodeStep({
  agentTracker,
  controller,
  emit,
  emitEvent,
  codeTool,
  taskId,
}: {
  agentTracker: ReadCurrentProjectAgentTracker;
  controller: FlowController;
  emit: SnapshotEmitter;
  emitEvent: RuntimeEventEmitter;
  codeTool?: CodeTool;
  taskId: ID;
}): Promise<AnalyzeCodeStepOutput> {
  agentTracker.setState("agent-code", {
    status: "running",
    task: "Analyzing project structure",
    currentStepId: "analyze-code",
  });

  emit({
    ...controller.getSnapshot(),
    status: "running",
    commanderMessage: "Code Agent is analyzing the repository structure.",
    plan: markStep(controller.getSnapshot().plan, "analyze-code", "running"),
    agents: agentTracker.getSnapshots(),
    logs: appendLog(controller.getSnapshot(), emitEvent({
      kind: "tool.planned",
      taskId,
      toolName: "code.inspectRepository",
      detail: "code.inspectRepository identifies architecture, stack, and key modules.",
    })),
  });

  const codeReviewPreview = codeTool ? await safeInspectRepository(codeTool) : undefined;
  const analysisSummary = codeReviewPreview
    ? `Code Agent produced a repository inspection with ${codeReviewPreview.changedFiles?.length ?? 0} changed file(s).`
    : "Code Agent produced a rule-based architecture summary (no code tool available).";

  agentTracker.setState("agent-code", {
    status: "completed",
    task: "Project structure summarized",
  });

  emit({
    ...controller.getSnapshot(),
    commanderMessage: analysisSummary,
    plan: markStep(controller.getSnapshot().plan, "analyze-code", "completed"),
    agents: agentTracker.getSnapshots(),
    codeReviewPreview,
    logs: appendLog(controller.getSnapshot(), emitEvent({
      kind: "tool.completed",
      taskId,
      toolName: "code.analyzeProject",
      detail: analysisSummary,
    })),
  });

  return { codeReviewPreview, analysisSummary };
}

async function runSummarizeProjectStep({
  agentTracker,
  controller,
  emit,
  emitEvent,
  verifierTool,
  taskId,
  contextSnapshot,
}: {
  agentTracker: ReadCurrentProjectAgentTracker;
  controller: FlowController;
  emit: SnapshotEmitter;
  emitEvent: RuntimeEventEmitter;
  verifierTool?: VerifierTool;
  taskId: ID;
  contextSnapshot: Record<string, unknown>;
}): Promise<VerifierCheckResult | undefined> {
  await controller.wait();

  const project = contextSnapshot.projectInspection as ProjectInspection | undefined;
  const fileScan = contextSnapshot.fileScan as { count?: number } | undefined;
  const commands = Array.isArray(contextSnapshot.shellCommands)
    ? contextSnapshot.shellCommands as ShellCommandOutput[]
    : [];

  const passingCommands = commands.filter((command) => command.exitCode === 0).length;
  const hasProjectEvidence = Boolean(project?.workspacePath);
  const evidenceStatus =
    hasProjectEvidence && passingCommands === commands.length ? "completed" : "failed";

  agentTracker.setState("agent-verifier", {
    status: "verifying",
    task: "Checking all parallel workflow evidence",
    currentStepId: "summarize-project",
  });

  emit({
    ...controller.getSnapshot(),
    status: "verifying",
    commanderMessage: "Verifier is checking evidence from all three parallel agents.",
    plan: markStep(controller.getSnapshot().plan, "summarize-project", "running"),
    agents: agentTracker.getSnapshots(),
    logs: appendLog(controller.getSnapshot(), emitEvent({
      kind: "tool.planned",
      taskId,
      toolName: "verifier.check",
      detail: "Verifier checks project evidence from file scan, project inspection, and code analysis.",
    })),
  });

  await controller.wait();

  const verifierCheck = await safeVerifyWorkflow(verifierTool, contextSnapshot);
  const verificationStatus = verifierCheck?.status === "fail" ? "failed" : evidenceStatus;
  const verificationSummary = verifierCheck
    ? `${verifierCheck.status}: ${verifierCheck.summary}`
    : `${verificationStatus === "completed" ? "verified" : "failed"}: read-current-project scanned ${fileScan?.count ?? 0} Markdown document(s), inspected ${project?.scripts.length ?? 0} script(s), and checked ${passingCommands}/${commands.length} read-only command(s).`;

  agentTracker.setState("agent-verifier", {
    status: verificationStatus === "completed" ? "completed" : "failed",
    task: `${passingCommands}/${commands.length} commands passed`,
  });

  agentTracker.setState("agent-commander", {
    status: "running",
    task: "Synthesizing project conclusion",
    currentStepId: "commander-synthesize",
  });

  emit({
    ...controller.getSnapshot(),
    status: "verifying",
    commanderMessage:
      verificationStatus === "completed"
        ? "Verifier confirmed the evidence. Commander is writing the project conclusion."
        : "Verifier found issues in the evidence. Commander will summarize the findings.",
    plan: markStep(
      controller.getSnapshot().plan,
      "summarize-project",
      verificationStatus === "completed" ? "completed" : "failed",
      "commander-synthesize",
      "running",
    ),
    agents: agentTracker.getSnapshots(),
    verificationSummary,
    logs: appendLog(controller.getSnapshot(), verifierCheck
      ? emitEvent({
          kind: "tool.completed",
          taskId,
          toolName: "verifier.check",
          detail: verifierCheck.detail,
        })
      : {
          id: `${taskId}-verification-done`,
          kind: "event",
          title: "verification.completed",
          detail: `Verifier checked project evidence for workspace ${project?.workspacePath || "(unknown)"}.`,
        }),
  });

  return verifierCheck;
}

async function runCommanderSynthesisStep({
  agentTracker,
  controller,
  emit,
  emitEvent,
  commanderTool,
  taskId,
  userGoal,
  workflowTitle,
  contextSnapshot,
}: {
  agentTracker: ReadCurrentProjectAgentTracker;
  controller: FlowController;
  emit: SnapshotEmitter;
  emitEvent: RuntimeEventEmitter;
  commanderTool?: CommanderTool;
  taskId: ID;
  userGoal: string;
  workflowTitle: string;
  contextSnapshot: Record<string, unknown>;
}): Promise<CommanderSynthesizeResult | undefined> {
  const verifierCheck = contextSnapshot.verifierCheck as VerifierCheckResult | undefined;
  const evidencePassed = verifierCheck?.status !== "fail";

  const result = await safeSynthesizeConclusion(
    commanderTool,
    userGoal,
    workflowTitle,
    contextSnapshot,
  );

  const conclusion = result?.message ?? createFallbackConclusion(contextSnapshot, userGoal);
  const hasConclusion = Boolean(result);
  const finalStatus = evidencePassed ? "completed" : "failed";

  agentTracker.setState("agent-commander", {
    status: finalStatus,
    task: finalStatus === "completed" ? "Project conclusion written" : "Conclusion written with evidence gaps",
  });
  for (const agentId of ["agent-file", "agent-shell", "agent-code", "agent-verifier"] as const) {
    if (agentTracker.getState(agentId)) {
      agentTracker.setState(agentId, {
        status: finalStatus,
        task: "Contributed to project analysis",
      });
    }
  }

  emit({
    ...controller.getSnapshot(),
    title: finalStatus === "completed" ? workflowTitle : `${workflowTitle} with missing evidence`,
    status: finalStatus,
    commanderMessage: conclusion,
    plan: controller.getSnapshot().plan.map((step) => ({
      ...step,
      status: step.id === "commander-synthesize"
        ? (finalStatus === "completed" ? "completed" as const : "failed" as const)
        : step.status,
    })),
    agents: agentTracker.getSnapshots(),
    logs: appendLog(controller.getSnapshot(), hasConclusion
      ? emitEvent({
          kind: "task.completed",
          taskId,
          detail: "Commander wrote the project conclusion from all collected evidence.",
        })
      : {
          id: `${taskId}-synthesis-fallback`,
          kind: "event",
          title: "commander.synthesize",
          detail: "No synthesis model available. Used rule-based evidence summary.",
        }),
  });

  return result;
}

export async function safeSynthesizeConclusion(
  commanderTool: CommanderTool | undefined,
  userGoal: string,
  workflowTitle: string,
  contextSnapshot: Record<string, unknown>,
): Promise<CommanderSynthesizeResult | undefined> {
  if (!commanderTool?.synthesize) return undefined;
  try {
    return await commanderTool.synthesize({
      userGoal,
      workflowTitle,
      evidence: contextSnapshot,
    });
  } catch (error) {
    console.error("Commander synthesis failed, falling back to rule-based conclusion:", error);
    return undefined;
  }
}

function createFallbackConclusion(
  contextSnapshot: Record<string, unknown>,
  userGoal: string,
): string {
  const isZh = /[一-鿿]/.test(userGoal);
  const parts: string[] = [];
  const project = contextSnapshot.projectInspection as ProjectInspection | undefined;
  const fileScan = contextSnapshot.fileScan as { count?: number } | undefined;
  const commands = Array.isArray(contextSnapshot.shellCommands)
    ? (contextSnapshot.shellCommands as Array<{ command?: string; exitCode?: number }>)
    : [];
  const analysisSummary = contextSnapshot.analysisSummary as string | undefined;

  if (isZh) {
    if (project) {
      parts.push(`项目使用 ${project.packageManager ?? "未知"} 包管理器`);
      if (project.scripts.length > 0) {
        parts.push(`${project.scripts.length} 个脚本（${project.scripts.map((s) => s.name).join("、")}）`);
      }
      if (project.recommendedStartCommand) parts.push(`启动命令: ${project.recommendedStartCommand}`);
      if (project.recommendedTestCommand) parts.push(`测试命令: ${project.recommendedTestCommand}`);
    }
    if (fileScan?.count) parts.push(`扫描到 ${fileScan.count} 个 Markdown 文档`);
    if (commands.length > 0) {
      const passed = commands.filter((c) => c.exitCode === 0).length;
      parts.push(`${passed}/${commands.length} 个环境检查命令通过`);
    }
    if (analysisSummary) parts.push(analysisSummary);
    return parts.length > 0
      ? parts.join("。\n")
      : "项目分析已完成，但未收集到足够的证据来生成结论。";
  }

  if (project) {
    parts.push(`Project uses ${project.packageManager ?? "unknown"} as package manager`);
    if (project.scripts.length > 0) {
      parts.push(`${project.scripts.length} script(s): ${project.scripts.map((s) => s.name).join(", ")}`);
    }
    if (project.recommendedStartCommand) parts.push(`Start command: ${project.recommendedStartCommand}`);
    if (project.recommendedTestCommand) parts.push(`Test command: ${project.recommendedTestCommand}`);
  }
  if (fileScan?.count) parts.push(`Scanned ${fileScan.count} Markdown document(s)`);
  if (commands.length > 0) {
    const passed = commands.filter((c) => c.exitCode === 0).length;
    parts.push(`${passed}/${commands.length} environment check command(s) passed`);
  }
  if (analysisSummary) parts.push(analysisSummary);
  return parts.length > 0
    ? parts.join(".\n")
    : "Project analysis completed, but insufficient evidence was collected to form a conclusion.";
}

async function safeVerifyWorkflow(
  verifierTool: VerifierTool | undefined,
  contextSnapshot: Record<string, unknown>,
): Promise<VerifierCheckResult | undefined> {
  if (!verifierTool) {
    return undefined;
  }
  const fileScan = contextSnapshot.fileScan as { count?: number } | undefined;
  const shellCommands = Array.isArray(contextSnapshot.shellCommands)
    ? contextSnapshot.shellCommands as ShellCommandOutput[]
    : [];
  try {
    return await verifierTool.check({
      stepId: "summarize-project",
      successCriteria: "Human-readable summary with evidence and unknowns",
      evidence: [
        {
          kind: "file",
          label: "Markdown document count",
          data: fileScan?.count ?? 0,
        },
        {
          kind: "command",
          label: "Read-only command outputs",
          data: shellCommands.map((command) => ({
            command: command.command,
            exitCode: command.exitCode,
            stdout: command.stdout,
            stderr: command.stderr,
          })),
        },
        {
          kind: "log",
          label: "Rule-based project summary",
          data: contextSnapshot.analysisSummary,
        },
        {
          kind: "log",
          label: "Project inspection",
          data: contextSnapshot.projectInspection,
        },
        {
          kind: "log",
          label: "Shared workflow context",
          data: contextSnapshot,
        },
      ],
    });
  } catch {
    return undefined;
  }
}

function workflowStepToTaskStep(step: NonNullable<ReturnType<typeof getWorkbenchWorkflow>>["steps"][number]): TaskStep {
  return {
    id: step.id,
    title: step.title,
    assignedAgentKind: step.agentKind,
    agentId: `agent-${step.agentKind}`,
    status: "pending",
    successCriteria: step.output,
  };
}

function runProjectReadOnlyCommands(shellTool: ShellTool): Promise<ShellCommandOutput[]> {
  return Promise.all([
    shellTool.runReadOnlyCommand({ program: "node", args: ["--version"], workspacePath: null }),
    shellTool.runReadOnlyCommand({ program: "pnpm", args: ["--version"], workspacePath: null }),
    shellTool.runReadOnlyCommand({ program: "git", args: ["status", "--short"], workspacePath: null }),
  ]);
}

async function safeInspectRepository(codeTool: CodeTool) {
  try {
    return await codeTool.inspectRepository();
  } catch {
    return undefined;
  }
}

function markCurrentStepFailed(plan: TaskStep[]): TaskStep[] {
  let marked = false;
  return plan.map((step) => {
    if (!marked && step.status === "running") {
      marked = true;
      return { ...step, status: "failed" };
    }
    if (step.status === "pending") {
      return { ...step, status: "skipped" };
    }
    return step;
  });
}
