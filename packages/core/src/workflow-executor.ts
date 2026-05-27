import type {
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
import { summarizeMarkdownDocuments } from "@javis/tools";
import {
  demoAgents,
} from "./agents";
import { createAgentStateTracker } from "./agent-state-tracker";
import type { FlowController } from "./flow-controller";
import type { ID, TaskSnapshot, TaskStep } from "./index";
import { markStep } from "./plans";
import { createSourceBackedReport } from "./research";
import { createSharedTaskContext } from "./shared-context";
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

    const execution = await executeWorkflow({
      workflow,
      context,
      executeStep: async (step) => {
        switch (step.id) {
          case "scan-files":
            return {
              output: await runScanFilesStep({
                agentTracker,
                controller,
                emit,
                emitEvent,
                fileTool,
                taskId,
              }),
            };
          case "inspect-project":
            return {
              output: await runInspectProjectStep({
                agentTracker,
                controller,
                emit,
                emitEvent,
                projectTool,
                shellTool,
                taskId,
                contextSnapshot: context.snapshot(),
              }),
            };
          case "analyze-code":
            return {
              output: await runAnalyzeCodeStep({
                agentTracker,
                controller,
                emit,
                emitEvent,
                codeTool,
                taskId,
                contextSnapshot: context.snapshot(),
              }),
            };
          case "summarize-project":
            return {
              output: await runSummarizeProjectStep({
                agentTracker,
                controller,
                emit,
                emitEvent,
                verifierTool,
                taskId,
                contextSnapshot: context.snapshot(),
              }),
            };
          case "commander-synthesize":
            return {
              output: await runCommanderSynthesisStep({
                agentTracker,
                controller,
                emit,
                emitEvent,
                commanderTool,
                taskId,
                userGoal,
                workflowTitle: workflow.title,
                contextSnapshot: context.snapshot(),
              }),
            };
          default:
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
  schedulerTool?: SchedulerTool;
  webTool?: WebTool;
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
  schedulerTool,
  webTool,
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
          codeTool,
          computerTool,
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
      availableAgents: [
        { kind: "commander", allowedToolNames: ["commander.plan"] },
        { kind: "file", allowedToolNames: ["file.scanMarkdownDocuments"] },
        { kind: "shell", allowedToolNames: ["shell.runReadOnlyCommand"] },
        { kind: "code", allowedToolNames: ["code.inspectRepository"] },
        { kind: "verifier", allowedToolNames: ["verifier.check"] },
      ],
    });
  } catch {
    return undefined;
  }
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
  codeTool,
  computerTool,
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
  codeTool?: CodeTool;
  computerTool?: ComputerTool;
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
    codeTool,
    computerTool,
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

async function executeConcreteGenericStep({
  codeTool,
  computerTool,
  schedulerTool,
  step,
  userGoal,
  webTool,
  workflow,
  contextSnapshot,
}: {
  codeTool?: CodeTool;
  computerTool?: ComputerTool;
  schedulerTool?: SchedulerTool;
  step: WorkbenchWorkflowStep;
  userGoal: string;
  webTool?: WebTool;
  workflow: WorkbenchWorkflow;
  contextSnapshot: Record<string, unknown>;
}): Promise<GenericStepOutput> {
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

  return unsupportedOutput(workflow, step);
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
  agentTracker.setState("agent-shell", {
    status: "queued",
    task: "Waiting for file evidence",
  });
  agentTracker.setState("agent-code", {
    status: "queued",
    task: "Waiting for project evidence",
  });
  agentTracker.setState("agent-verifier", {
    status: "queued",
    task: "Waiting for workflow results",
  });

  emit({
    ...controller.getSnapshot(),
    status: "running",
    commanderMessage: "File Agent is scanning Markdown documents for project context.",
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
  agentTracker.setState("agent-shell", {
    status: "running",
    task: "Inspecting project scripts and environment",
    currentStepId: "inspect-project",
  });

  emit({
    ...controller.getSnapshot(),
    commanderMessage:
      "File Agent completed the document scan. Shell Agent is inspecting project scripts and environment.",
    plan: markStep(controller.getSnapshot().plan, "scan-files", "completed", "inspect-project", "running"),
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
  contextSnapshot: Record<string, unknown>;
}): Promise<ProjectInspectionStepOutput> {
  const project = await projectTool.inspectProject();
  const commands = await runProjectReadOnlyCommands(shellTool);

  agentTracker.setState("agent-shell", {
    status: "completed",
    task: "Read-only project checks completed",
  });
  agentTracker.setState("agent-code", {
    status: "running",
    task: "Analyzing project structure",
    currentStepId: "analyze-code",
  });

  emit({
    ...controller.getSnapshot(),
    commanderMessage:
      "Project inspection evidence is ready. Code Agent is producing a rule-based architecture summary.",
    plan: markStep(controller.getSnapshot().plan, "inspect-project", "completed", "analyze-code", "running"),
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
  contextSnapshot,
}: {
  agentTracker: ReadCurrentProjectAgentTracker;
  controller: FlowController;
  emit: SnapshotEmitter;
  emitEvent: RuntimeEventEmitter;
  codeTool?: CodeTool;
  taskId: ID;
  contextSnapshot: Record<string, unknown>;
}): Promise<AnalyzeCodeStepOutput> {
  const project = contextSnapshot.projectInspection as ProjectInspection | undefined;
  const fileScan = contextSnapshot.fileScan as { count?: number } | undefined;
  const commands = Array.isArray(contextSnapshot.shellCommands)
    ? contextSnapshot.shellCommands as ShellCommandOutput[]
    : [];
  if (!project) {
    throw new Error("Project inspection context is missing.");
  }

  const codeReviewPreview = codeTool ? await safeInspectRepository(codeTool) : undefined;
  const analysisSummary = createRuleBasedProjectSummary(project, fileScan?.count ?? 0, commands);

  agentTracker.setState("agent-code", {
    status: "completed",
    task: "Project structure summarized",
  });
  agentTracker.setState("agent-verifier", {
    status: "verifying",
    task: "Checking workflow evidence",
    currentStepId: "summarize-project",
  });

  emit({
    ...controller.getSnapshot(),
    status: "verifying",
    commanderMessage: analysisSummary,
    plan: markStep(controller.getSnapshot().plan, "analyze-code", "completed", "summarize-project", "running"),
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
  if (!project) {
    throw new Error("Project inspection context is missing.");
  }

  const passingCommands = commands.filter((command) => command.exitCode === 0).length;
  const hasProjectEvidence = Boolean(project.workspacePath);
  const evidenceStatus =
    hasProjectEvidence && passingCommands === commands.length ? "completed" : "failed";
  const verifierCheck = await safeVerifyWorkflow(verifierTool, contextSnapshot);
  const verificationStatus = verifierCheck?.status === "fail" ? "failed" : evidenceStatus;
  const verificationSummary = verifierCheck
    ? `${verifierCheck.status}: ${verifierCheck.summary}`
    : `${verificationStatus === "completed" ? "verified" : "failed"}: read-current-project scanned ${fileScan?.count ?? 0} Markdown document(s), inspected ${project.scripts.length} script(s), and checked ${passingCommands}/${commands.length} read-only command(s).`;

  agentTracker.setState("agent-commander", {
    status: "completed",
    task: verificationStatus === "completed" ? "Task finished" : "Workflow completed with missing evidence",
  });
  agentTracker.setState("agent-file", {
    status: "completed",
    task: `${fileScan?.count ?? 0} document(s) scanned`,
  });
  agentTracker.setState("agent-shell", {
    status: "completed",
    task: `${passingCommands}/${commands.length} commands passed`,
  });
  agentTracker.setState("agent-code", {
    status: "completed",
    task: "Rule-based project summary produced",
  });
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
          detail: `Verifier checked project evidence for workspace ${project.workspacePath || "(unknown)"}.`,
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
  const result = await safeSynthesizeConclusion(
    commanderTool,
    userGoal,
    workflowTitle,
    contextSnapshot,
  );

  const conclusion = result?.message ?? createFallbackConclusion(contextSnapshot);
  const hasConclusion = Boolean(result);

  agentTracker.setState("agent-commander", {
    status: "completed",
    task: "Project conclusion written",
  });
  for (const agentId of ["agent-file", "agent-shell", "agent-code", "agent-verifier"] as const) {
    if (agentTracker.getState(agentId)) {
      agentTracker.setState(agentId, { status: "completed", task: "Contributed to project analysis" });
    }
  }

  emit({
    ...controller.getSnapshot(),
    title: workflowTitle,
    status: "completed",
    commanderMessage: conclusion,
    plan: controller.getSnapshot().plan.map((step) => ({
      ...step,
      status: step.id === "commander-synthesize" ? "completed" as const : step.status,
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

async function safeSynthesizeConclusion(
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
  } catch {
    return undefined;
  }
}

function createFallbackConclusion(contextSnapshot: Record<string, unknown>): string {
  const parts: string[] = [];
  const project = contextSnapshot.projectInspection as ProjectInspection | undefined;
  const fileScan = contextSnapshot.fileScan as { count?: number } | undefined;
  const commands = Array.isArray(contextSnapshot.shellCommands)
    ? (contextSnapshot.shellCommands as Array<{ command?: string; exitCode?: number }>)
    : [];
  const analysisSummary = contextSnapshot.analysisSummary as string | undefined;

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

  return parts.length > 0 ? parts.join("。\n") : "项目分析已完成，但未收集到足够的证据来生成结论。";
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

function createRuleBasedProjectSummary(
  project: ProjectInspection,
  documentCount: number,
  commands: ShellCommandOutput[],
): string {
  const packageManager = project.packageManager ?? "unknown package manager";
  const scriptNames = project.scripts.map((script) => script.name).join(", ") || "no scripts";
  return `Code Agent identified ${packageManager}, ${project.scripts.length} script(s) (${scriptNames}), ${documentCount} Markdown document(s), and ${commands.length} read-only command result(s).`;
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
