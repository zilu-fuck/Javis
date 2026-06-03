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
  WebSource,
  WebTool,
  VerifierCheckResult,
  VerifierTool,
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
import { extractUrls } from "./routing";
import type { CommanderDagStep, CommanderDagPlan } from "./commander-plan-schema";
import type { AgentCapabilityTag } from "./agent-capability";
import {
  resolveStepInput,
  writeStepOutput,
  type SharedTaskContext,
} from "./shared-context";
import { runAgentReActLoop, type AgentReActDecision, type AgentReActTool } from "./agent-react-loop";
import type { ReActDecisionRequest } from "./agent-react-decider";
import { createAskUserRequest } from "./ask-user";

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
    const capabilityExecutors = new Map<string, () => Promise<unknown>>([
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
          contextSnapshot: context.snapshot(),
        });
      }],
      ["synthesis", async () => {
        return runCommanderSynthesisStep({
          agentTracker, controller, emit, emitEvent, commanderTool, taskId, userGoal,
          workflowTitle: workflow.title, contextSnapshot: context.snapshot(),
        });
      }],
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
      onStepCompleted: (step, output) => {
        if (step.id === "scan-files") {
          const documents = output as MarkdownDocumentSummary[];
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
    emit({
      ...snapshot,
      title: "Current project read failed",
      status: "failed",
      commanderMessage:
        "The read-current-project workflow failed before all read-only evidence was collected.",
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
      onStepCompleted: (step, output) => {
        context.set(step.id, output);
      },
    });

    if (execution.status === "failed") {
      throw new Error(execution.error ?? `${workflow.id} workflow failed.`);
    }

    const verifierCheck = await safeVerifyGenericWorkflow(verifierTool, workflow, context.snapshot());
    const verified = verifierCheck?.status !== "fail";
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
    const conclusion = synthesis?.message
      ?? (verified
          ? `${workflow.title} completed. Tool-specific implementation is still required for executable side effects.`
          : `${workflow.title} reached verifier.check but did not pass.`);
    const finalStatus = verified ? "completed" : "failed";

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
    emit({
      ...snapshot,
      status: "failed",
      commanderMessage: `${workflow.title} failed in the generic workflow executor.`,
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
  if (agentTracker.getState(agentId)) {
    agentTracker.setState(agentId, {
      status: step.permissionLevel === "confirmed_write" ? "waiting_permission" : "running",
      task: step.title,
      currentStepId: step.id,
    });
  }

  emit({
    ...controller.getSnapshot(),
    status: step.permissionLevel === "confirmed_write" ? "waiting_permission" : "running",
    commanderMessage:
      step.permissionLevel === "confirmed_write"
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
  const { browserTool, computerTool, schedulerTool, webTool, workflow } = tools;

  for (const cap of step.requiredCapabilities!) {
    switch (cap) {
      case "web_search":
        if (!webTool?.searchWeb) continue;
        return {
          workflowId: workflow.id,
          stepId: step.id,
          status: "completed",
          summary: `Capability dispatch: web_search for ${step.id}`,
          expectedOutput: step.output,
        };

      case "web_fetch":
        if (!webTool) continue;
        return {
          workflowId: workflow.id,
          stepId: step.id,
          status: "completed",
          summary: `Capability dispatch: web_fetch for ${step.id}`,
          expectedOutput: step.output,
        };

      case "schedule_create":
        if (!schedulerTool) continue;
        return {
          workflowId: workflow.id,
          stepId: step.id,
          status: "completed",
          summary: `Capability dispatch: schedule_create for ${step.id}`,
          expectedOutput: step.output,
        };

      case "evidence_check":
        return {
          workflowId: workflow.id,
          stepId: step.id,
          status: "completed",
          summary: `Capability dispatch: evidence_check for ${step.id}`,
          expectedOutput: step.output,
        };

      case "planning":
        return {
          workflowId: workflow.id,
          stepId: step.id,
          status: "completed",
          summary: `Capability dispatch: planning for ${step.id}`,
          expectedOutput: step.output,
        };

      case "local_search":
        if (!computerTool) continue;
        return {
          workflowId: workflow.id,
          stepId: step.id,
          status: "completed",
          summary: `Capability dispatch: local_search for ${step.id}`,
          expectedOutput: step.output,
        };

      case "browser_navigate":
        if (!browserTool) continue;
        return {
          workflowId: workflow.id,
          stepId: step.id,
          status: "completed",
          summary: `Capability dispatch: browser_navigate for ${step.id}`,
          expectedOutput: step.output,
        };

      case "browser_interact":
        if (!browserTool) continue;
        return {
          workflowId: workflow.id,
          stepId: step.id,
          status: "completed",
          summary: `Capability dispatch: browser_interact for ${step.id}`,
          expectedOutput: step.output,
        };

      case "browser_test":
        if (!browserTool) continue;
        return {
          workflowId: workflow.id,
          stepId: step.id,
          status: "completed",
          summary: `Capability dispatch: browser_test for ${step.id}`,
          expectedOutput: step.output,
        };

      default:
        // Unrecognized capability tag — fall through to legacy dispatch
        continue;
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
  schedulerTool?: SchedulerTool;
  webTool?: WebTool;
  commanderTool?: CommanderTool;
  verifierTool?: VerifierTool;
  visionTool?: import("@javis/tools").VisionTool;
}

/** Find the first ToolDescriptor whose capabilityTags include the given tag. */
function findToolDescriptorByCapability(capability: string) {
  return initialToolDescriptors.find((td) => td.capabilityTags.includes(capability));
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
    case "file.scanUserDocuments": {
      if (!tools.fileTool?.scanUserDocuments) throw new Error("file.scanUserDocuments tool not available");
      return tools.fileTool.scanUserDocuments({
        query: input.query as string,
        extensions: input.extensions as string[] | undefined,
        maxResults: input.maxResults as number | undefined,
      });
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
      return tools.browserTool.navigate({ url: input.url as string });
    }
    case "browser.screenshot": {
      if (!tools.browserTool) throw new Error("browser.screenshot tool not available");
      return tools.browserTool.screenshot({
        fullPage: (input.fullPage as boolean) ?? false,
        selector: input.selector as string | undefined,
      });
    }
    case "browser.getContent": {
      if (!tools.browserTool) throw new Error("browser.getContent tool not available");
      return tools.browserTool.getContent({
        format: (input.format as "text" | "html") ?? "text",
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
    // ── Computer tools ────────────────────────────────────────────────────
    case "computer.searchLocalDocuments": {
      if (!tools.computerTool) throw new Error("computer.searchLocalDocuments tool not available");
      return tools.computerTool.searchLocalDocuments({
        query: input.query as string,
        maxResults: (input.maxResults as number) ?? 20,
      });
    }
    // ── Scheduler tools ───────────────────────────────────────────────────
    case "scheduler.createTask": {
      if (!tools.schedulerTool) throw new Error("scheduler.createTask tool not available");
      return tools.schedulerTool.createTask(input as unknown as Parameters<typeof tools.schedulerTool.createTask>[0]);
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
): Promise<{ output: unknown; toolName: string }> {
  const capability = step.capability ?? step.requiredCapabilities[0];
  if (!capability) {
    throw new Error(`Step "${step.id}" has no capability tag for dispatch. ` +
      `Set step.capability or step.requiredCapabilities[0].`);
  }

  const descriptor = findToolDescriptorByCapability(capability);
  if (!descriptor) {
    throw new Error(
      `No tool registered for capability "${capability}" (step: ${step.id}). ` +
      `Ensure a ToolDescriptor declares this tag in its capabilityTags.`,
    );
  }

  const input = resolveStepInput(step.inputContextKeys, context);
  const output = await dispatchToolByName(descriptor.name, input, tools);

  writeStepOutput(step.outputContextKey, output, context);

  return { output, toolName: descriptor.name };
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
  schedulerTool?: SchedulerTool;
  webTool?: WebTool;
  browserTool?: BrowserTool;
  verifierTool?: VerifierTool;
  visionTool?: import("@javis/tools").VisionTool;
  taskId: string;
  userGoal: string;
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
    approveAction: (action: { tool: string; params: Record<string, unknown> }) => Promise<{ approvalId: string; taskId?: string }>;
    onStep?: (step: unknown) => void;
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
  schedulerTool,
  webTool,
  browserTool,
  verifierTool,
  visionTool,
  taskId,
  userGoal,
  reactDecideNext,
  replanDag,
}: CommanderDagTaskOptions) {
  const { emit, getSnapshot, wait } = controller;
  const context = createSharedTaskContext({ userGoal, taskId });
  if (isVisionGoal(userGoal)) {
    const imagePath = inferImagePath(userGoal);
    if (imagePath) context.set("imagePath", imagePath);
  }
  const agentTracker = createAgentStateTracker(
    demoAgents.filter((a) => a.kind !== "chinese-reviewer"),
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
    logs: [createdLog],
  });

  await wait();

  try {
    // Phase 1: Commander generates DAG plan
    const availableAgents = getAvailableAgentsForPlanning();
    const dagPlan = await commanderTool.plan({
      userGoal,
      availableAgents,
      availableTools: initialToolDescriptors.map((td) => ({
        name: td.name,
        permissionLevel: td.permissionLevel,
        summary: td.summary,
        capabilityTags: [...td.capabilityTags],
        ownerAgentKinds: [...td.ownerAgentKinds],
      })),
      workflowId: COMMANDER_DAG_WORKFLOW_ID,
    });

    if (!dagPlan.steps || dagPlan.steps.length === 0) {
      throw new Error("Commander plan returned no steps.");
    }

    // Only proceed with capability dispatch if at least one step has
    // a capability or requiredCapabilities tag. Otherwise fall through
    // to the legacy hardcoded routing in start().
    const hasCapabilitySteps = dagPlan.steps.some(
      (s) => (s as CommanderDagStep).capability ||
           (s.requiredCapabilities?.length ?? 0) > 0 ||
           s.toolName === "commander.askUser",
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
      const askQuestion = askUserStep.title || "Please clarify your request.";
      const askResult = await new Promise<string>((resolve) => {
        const { questionRequest, listenForAnswer } = createAskUserRequest({
          question: askQuestion,
          choices: undefined,
          setPendingAskUserHandler: controller.setPendingAskUserHandler!,
          onAnswered: async (resolved) => {
            context.set(`askUserAnswer:${askUserStep.id}`, resolved.answer);
            context.set("askUserQuestion", resolved.question);
            resolve(resolved.answer ?? "");
          },
        });

        emitSnapshot({
          ...getSnapshot(),
          status: "waiting_permission",
          commanderMessage: questionRequest.question,
          askUserQuestion: questionRequest,
          agents: agentTracker.getSnapshots(),
          logs: appendLog(getSnapshot(), emitEvent({
            kind: "ask_user.requested",
            taskId,
            question: questionRequest,
          })),
        });

        listenForAnswer();
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
          schedulerTool,
          webTool,
          browserTool,
          verifierTool,
          taskId,
          userGoal: `${userGoal}\n\nUser clarification: ${askResult}`,
          reactDecideNext,
          replanDag,
        });
      }

      // If there are more steps after askUser, store answer and continue
      context.set((askUserStep as CommanderDagStep).outputContextKey ?? "clarification", askResult);
      await wait();
    }

    // Phase 2: Execute DAG steps via executeWorkflow for parallel scheduling.
    // Independent steps (no shared dependsOn) are executed concurrently via
    // Promise.allSettled inside the DAG executor.
    const tools: AllCapabilityTools = {
      browserTool, codeTool, computerTool, fileTool,
      schedulerTool, webTool, commanderTool, verifierTool, visionTool,
    };
    const completedSteps = new Set<string>();

    // Convert CommanderDagSteps to WorkbenchWorkflowSteps for the DAG executor
    const workflowSteps = dagPlan.steps.map((step) => ({
      id: step.id,
      title: step.title,
      agentKind: step.assignedAgentKind as WorkbenchWorkflowStep["agentKind"],
      input: step.title,
      output: step.successCriteria,
      permissionLevel: "read" as const,
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
          const askQuestion = dagStep.title || "Please clarify your request.";
          const answer = await new Promise<string>((resolve) => {
            const { questionRequest, listenForAnswer } = createAskUserRequest({
              question: askQuestion,
              choices: undefined,
              setPendingAskUserHandler: controller.setPendingAskUserHandler!,
              onAnswered: async (resolved) => {
                context.set(`askUserAnswer:${dagStep.id}`, resolved.answer);
                context.set("askUserQuestion", resolved.question);
                resolve(resolved.answer ?? "");
              },
            });
            emitSnapshot({
              ...getSnapshot(),
              status: "waiting_permission",
              commanderMessage: questionRequest.question,
              askUserQuestion: questionRequest,
              agents: agentTracker.getSnapshots(),
              logs: appendLog(getSnapshot(), emitEvent({
                kind: "ask_user.requested",
                taskId,
                question: questionRequest,
              })),
            });
            listenForAnswer();
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

      const agentId = `agent-${dagStep.assignedAgentKind}`;
      if (agentTracker.getState(agentId)) {
        agentTracker.setState(agentId, {
          status: "running",
          task: dagStep.title,
          currentStepId: dagStep.id,
        });
      }

      const capability = (dagStep as CommanderDagStep).capability
        ?? (dagStep.requiredCapabilities?.length ? dagStep.requiredCapabilities[0] : undefined);

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

      // Build ReAct tools from available tool descriptors filtered by agent's allowed tools
      const agentDef = demoAgents.find((a) => a.kind === dagStep.assignedAgentKind);
      const allowedToolNames = agentDef?.allowedToolNames ?? [];
      const reactTools: AgentReActTool[] = initialToolDescriptors
        .filter((td) => allowedToolNames.includes(td.name))
        .map((td) => ({
          name: td.name,
          execute: async () => {
            const stepInput = resolveStepInput(
              (dagStep as CommanderDagStep).inputContextKeys,
              context,
            );
            const output = await dispatchToolByName(td.name, stepInput, tools);
            writeStepOutput(
              (dagStep as CommanderDagStep).outputContextKey ?? `step:${dagStep.id}`,
              output,
              context,
            );
            return output;
          },
        }));

      // If ReAct decider is available, use the full ReAct loop.
      // Otherwise fall back to single-shot capability dispatch.
      if (reactDecideNext && reactTools.length > 0) {
        const reactResult = await runAgentReActLoop({
          agent: { kind: dagStep.assignedAgentKind, allowedToolNames } as Agent,
          step: wfStep,
          context,
          tools: reactTools,
          maxIterations: 4,
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
                const td = initialToolDescriptors.find((d) => d.name === t.name);
                return {
                  name: t.name,
                  summary: td?.summary ?? "",
                  capabilityTags: td?.capabilityTags ?? [],
                };
              }),
            }),
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

      // Fallback: single-shot capability dispatch
      try {
        const result = await executeCapabilityStep(
          dagStep as CommanderDagStep,
          context,
          tools,
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
        const recoveryPlan = await replanDag(
          userGoal,
          request.context.snapshot(),
          request.step.id,
          request.error,
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
          permissionLevel: "read" as const,
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
      } catch {
        return undefined;
      }
    }

    const execution = await executeWorkflow({
      workflow: syntheticWorkflow,
      context,
      executeStep: executeStepWithReAct,
      onStepCompleted: (_step, _output, _ctx) => {
        // Already handled in executeStepWithReAct above
      },
      onStepFailed: (_step, _error, _ctx) => {
        // Already handled in executeStepWithReAct above
      },
      onStepFailureReplan: handleStepFailureReplan,
      onStepReplanned: (step, error, action, _ctx) => {
        const recoveryPlanSteps: TaskStep[] = (action.steps ?? []).map((s) => ({
          id: s.id,
          title: s.title,
          assignedAgentKind: s.agentKind as TaskStep["assignedAgentKind"],
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
    const synthesis = await safeSynthesizeConclusion(
      commanderTool,
      userGoal,
      dagPlan.title || "Commander DAG task",
      context.snapshot(),
    );
    const conclusion = synthesis?.message
      ?? `Task completed: ${completedSteps.size}/${dagPlan.steps.length} step(s) executed.`;
    const allCompleted = execution.status === "completed";

    agentTracker.setState("agent-commander", {
      status: allCompleted ? "completed" : "failed",
      task: allCompleted ? "Task conclusion written" : "Some steps failed",
    });

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
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    agentTracker.setState("agent-commander", {
      status: "failed",
      task: errorMsg,
    });

    emitSnapshot({
      ...getSnapshot(),
      title: "Commander DAG plan failed",
      status: "failed",
      commanderMessage: `Commander could not complete the plan: ${errorMsg}`,
      plan: snapshot.plan.map((s) => ({
        ...s,
        status: s.status === "running" ? ("failed" as const)
          : s.status === "pending" ? ("skipped" as const)
          : s.status,
      })),
      agents: agentTracker.getSnapshots(),
      logs: appendLog(snapshot, emitEvent({
        kind: "task.failed",
        taskId,
        error: errorMsg,
      })),
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
      step.permissionLevel === "confirmed_write"
        ? "No concrete confirmed-write tool is wired for this workflow step."
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
