import type { WorkbenchAgent, WorkbenchLogEntry, WorkbenchStep, WorkbenchTask } from "../../types";
import { agentKind } from "./inspector-utils";

export interface AgentArtifactSummary {
  id: string;
  title: string;
  detail: string;
  kind: "command" | "code" | "document" | "file" | "research" | "source" | "trace";
}

export interface AgentDetailViewModel {
  agent: WorkbenchAgent;
  artifacts: AgentArtifactSummary[];
  currentStep?: WorkbenchStep;
  logs: WorkbenchLogEntry[];
  steps: WorkbenchStep[];
}

type StepWithLinks = WorkbenchStep & {
  agentId?: string;
};

type LogWithLinks = WorkbenchLogEntry & {
  agentId?: string;
  stepId?: string;
};

export function buildAgentDetailViewModel(task: WorkbenchTask, agent: WorkbenchAgent): AgentDetailViewModel {
  const kind = agentKind(agent);
  const steps = task.plan.filter((step) => isStepRelatedToAgent(step, agent, kind));
  const stepIds = new Set(steps.map((step) => step.id));
  const logs = task.logs.filter((log) => isLogRelatedToAgent(log, agent, kind, stepIds));
  const currentStep = steps.find((step) => step.status === "running")
    ?? steps.find((step) => step.status !== "completed" && step.status !== "skipped")
    ?? steps[steps.length - 1];

  return {
    agent,
    artifacts: buildArtifactsForAgent(task, agent, kind),
    currentStep,
    logs,
    steps,
  };
}

function isStepRelatedToAgent(step: WorkbenchStep, agent: WorkbenchAgent, kind: string): boolean {
  const linkedStep = step as StepWithLinks;
  if (linkedStep.agentId) return linkedStep.agentId === agent.id;
  if (step.agentKind) return normalize(step.agentKind) === normalize(kind);

  const haystack = normalize([
    step.title,
    step.successCriteria,
    step.errorSummary,
  ].filter(Boolean).join(" "));
  return matchesAgentText(haystack, agent, kind);
}

function isLogRelatedToAgent(
  log: WorkbenchLogEntry,
  agent: WorkbenchAgent,
  kind: string,
  stepIds: Set<string>,
): boolean {
  const linkedLog = log as LogWithLinks;
  if (linkedLog.agentId) return linkedLog.agentId === agent.id;
  if (linkedLog.stepId && stepIds.has(linkedLog.stepId)) return true;

  const haystack = normalize([
    log.kind,
    log.title,
    log.detail,
    log.userMessage,
    log.devDetail,
  ].filter(Boolean).join(" "));
  return matchesAgentText(haystack, agent, kind);
}

function buildArtifactsForAgent(task: WorkbenchTask, agent: WorkbenchAgent, kind: string): AgentArtifactSummary[] {
  const artifacts: AgentArtifactSummary[] = [];
  const normalizedKind = normalize(kind);
  const agentText = normalize(`${agent.id} ${agent.name} ${agent.role} ${agent.task}`);

  if (normalizedKind === "research" || agentText.includes("research")) {
    if (task.researchReport) {
      artifacts.push({
        id: "research-report",
        title: task.researchReport.title,
        detail: task.researchReport.summary,
        kind: "research",
      });
    }
    task.sources?.forEach((source, index) => {
      artifacts.push({
        id: `source-${index}`,
        title: source.title ?? source.url,
        detail: source.excerpt,
        kind: "source",
      });
    });
  }

  if (normalizedKind === "code" || agentText.includes("code")) {
    if (task.codeReviewPreview) {
      artifacts.push({
        id: "code-review-preview",
        title: "Code review preview",
        detail: task.codeReviewPreview.diffStat || task.codeReviewPreview.changedFiles.join(", "),
        kind: "code",
      });
    }
    if (task.codeProposedEdit) {
      artifacts.push({
        id: "code-proposed-edit",
        title: task.codeProposedEdit.summary,
        detail: task.codeProposedEdit.changedFiles.join(", "),
        kind: "code",
      });
    }
    if (task.codeApplyResult) {
      artifacts.push({
        id: "code-apply-result",
        title: "Code apply result",
        detail: task.codeApplyResult.message,
        kind: "code",
      });
    }
  }

  if (normalizedKind === "file" || agentText.includes("file") || agentText.includes("document")) {
    task.documents?.forEach((document) => {
      artifacts.push({
        id: `document-${document.path}`,
        title: document.heading ?? document.path,
        detail: document.purpose ?? document.path,
        kind: "document",
      });
    });
    if (task.fileOrganizationExecution) {
      artifacts.push({
        id: "file-organization",
        title: "File organization result",
        detail: `${task.fileOrganizationExecution.movedCount}/${task.fileOrganizationExecution.attemptedCount}`,
        kind: "file",
      });
    }
  }

  if (normalizedKind === "command" || normalizedKind === "computer" || agentText.includes("shell") || agentText.includes("terminal")) {
    task.commands?.forEach((command, index) => {
      artifacts.push({
        id: `command-${index}`,
        title: command.command,
        detail: command.exitCode === 0 ? "exit 0" : `exit ${command.exitCode}`,
        kind: "command",
      });
    });
  }

  if (normalizedKind === "computer" && task.executionTrace) {
    artifacts.push({
      id: "execution-trace",
      title: "Execution trace",
      detail: `${task.executionTrace.steps.length} step(s), ${(task.executionTrace.totalWallTimeMs / 1000).toFixed(1)}s`,
      kind: "trace",
    });
  }

  return artifacts;
}

function matchesAgentText(haystack: string, agent: WorkbenchAgent, kind: string): boolean {
  const tokens = new Set([
    normalize(agent.id),
    normalize(agent.name),
    normalize(agent.role),
    normalize(kind),
  ]);

  for (const token of tokens) {
    if (token && haystack.includes(token)) return true;
  }
  return false;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
