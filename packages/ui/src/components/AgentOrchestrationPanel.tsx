import { useEffect, useState } from "react";
import type { WorkbenchLocale, WorkbenchTask } from "../types";
import { formatDurationMs, getTaskStatusLabel, getTaskStatusProgress, translateWorkbenchText } from "../utils";

interface AgentOrchestrationPanelProps {
  locale: WorkbenchLocale;
  onSelectAgent?: (agentId: string) => void;
  selectedAgentId?: string;
  task: WorkbenchTask;
}

export function AgentOrchestrationPanel({
  locale,
  onSelectAgent,
  selectedAgentId,
  task,
}: AgentOrchestrationPanelProps) {
  const steps = task.plan ?? [];
  const shouldShow = steps.length > 0 && task.status !== "created";
  const visibleAgents = getVisibleAgentsForSteps(task);
  const [isCollapsed, setIsCollapsed] = useState(task.status === "completed");
  const completedCount = steps.filter((step) => step.status === "completed").length;
  const stepProgress = steps.length > 0 ? Math.round((completedCount / steps.length) * 100) : 0;
  const progress = steps.length > 0
    ? task.status === "failed"
      ? stepProgress
      : Math.max(getTaskStatusProgress(task.status), stepProgress)
    : getTaskStatusProgress(task.status);
  const progressLabel = task.status === "failed"
    ? getTaskStatusLabel(task.status, locale)
    : `${progress}%`;

  useEffect(() => {
    if (task.status !== "completed") {
      setIsCollapsed(false);
    }
  }, [task.status]);

  if (!shouldShow) {
    return null;
  }

  return (
    <section className="javis-task-progress-card" aria-label={translateWorkbenchText("Task progress", locale)}>
      <button
        aria-expanded={!isCollapsed}
        className="javis-task-progress-card-header"
        onClick={() => setIsCollapsed((value) => !value)}
        type="button"
      >
        <span>{translateWorkbenchText("Execution progress", locale)}</span>
        <span>{completedCount}/{steps.length}</span>
        <span>{progressLabel}</span>
      </button>
      <div className="javis-task-progress-track" aria-hidden="true">
        <span style={{ width: `${progress}%` }} />
      </div>
      {!isCollapsed ? (
        <>
          <ol className="javis-task-stepper">
            {steps.map((step, index) => (
              <li className={`javis-task-stepper-item status-${step.status}`} key={step.id}>
                <span className="javis-task-stepper-node" aria-hidden="true">
                  {getStepStatusIcon(step.status)}
                </span>
                <span>{translateWorkbenchText(step.title, locale)}</span>
                {index < steps.length - 1 ? <span className="javis-task-stepper-line" /> : null}
              </li>
            ))}
          </ol>
          {visibleAgents.length > 0 ? (
            <div className="javis-agent-run-stage">
              <DispatchConnectorSvg agentCount={visibleAgents.length} />
              <div className="javis-agent-run-grid">
                {visibleAgents.map((agent) => {
                  const agentProgress = getAgentProgress(agent.status, progress);
                  const selected = selectedAgentId === agent.id;
                  return (
                    <button
                      aria-pressed={selected}
                      className={`javis-agent-run-card status-${agent.status}${selected ? " active" : ""}`}
                      key={agent.id}
                      onClick={() => onSelectAgent?.(agent.id)}
                      type="button"
                    >
                      <header>
                        <span className="javis-agent-run-title">
                          <span className="javis-agent-run-icon" aria-hidden="true">
                            {getAgentIcon(agent.id)}
                          </span>
                          <strong>{translateWorkbenchText(agent.name, locale)}</strong>
                        </span>
                        <span className={`javis-agent-run-badge status-${agent.status}`}>
                          {getTaskStatusLabel(agent.status, locale)}
                        </span>
                      </header>
                      <p>{translateWorkbenchText(agent.task || agent.role, locale)}</p>
                      <div className="javis-agent-run-progress">
                        <span className="javis-agent-run-track">
                          <span style={{ width: `${agentProgress}%` }} />
                        </span>
                        <small>{agentProgress}%</small>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
          <ol className="javis-task-step-list">
            {steps.map((step) => (
              <li className={`javis-task-step status-${step.status}`} key={step.id}>
                <span className="javis-task-step-icon" aria-hidden="true">
                  {getStepStatusIcon(step.status)}
                </span>
                <span className="javis-task-step-main">
                  <strong>{translateWorkbenchText(step.title, locale)}</strong>
                  {step.successCriteria ? (
                    <small>{translateWorkbenchText(step.successCriteria, locale)}</small>
                  ) : null}
                  {step.errorSummary ? (
                    <small className="javis-task-step-error">{translateWorkbenchText(step.errorSummary, locale)}</small>
                  ) : null}
                  {getStepDuration(step) ? (
                    <small>{getStepDuration(step)}</small>
                  ) : null}
                </span>
                <span className="javis-task-step-status">
                  {getTaskStatusLabel(step.status, locale)}
                </span>
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </section>
  );
}

function getVisibleAgentsForSteps(task: WorkbenchTask) {
  const steps = task.plan ?? [];
  if (steps.length === 0) {
    return [];
  }
  const stepAgentKinds = new Set(
    steps
      .map((step) => step.agentKind?.trim())
      .filter((kind): kind is string => Boolean(kind)),
  );
  const stepAgentIds = new Set(
    steps
      .map((step) => step.agentId?.trim())
      .filter((id): id is string => Boolean(id)),
  );
  if (stepAgentKinds.size === 0 && stepAgentIds.size === 0) {
    return task.agents;
  }
  return task.agents.filter((agent) => {
    if (stepAgentIds.has(agent.id)) {
      return true;
    }
    const normalizedAgentId = agent.id.replace(/^agent-/, "");
    if (stepAgentKinds.has(normalizedAgentId)) {
      return true;
    }
    return agent.status !== "queued";
  });
}

function DispatchConnectorSvg({ agentCount }: { agentCount: number }) {
  if (agentCount <= 0) {
    return null;
  }

  const paths = Array.from({ length: agentCount }, (_, index) => {
    const targetX = agentCount === 1 ? 450 : 90 + (720 / Math.max(1, agentCount - 1)) * index;
    const controlX = 450 + (targetX - 450) * 0.44;
    return `M450 8 C${controlX.toFixed(0)} 28 ${targetX.toFixed(0)} 34 ${targetX.toFixed(0)} 54`;
  });

  return (
    <svg
      aria-hidden="true"
      className="javis-dispatch-lines"
      data-testid="dispatch-connector-svg"
      preserveAspectRatio="none"
      viewBox="0 0 900 60"
    >
      {paths.map((path, index) => (
        <path d={path} key={`${path}-${index}`} />
      ))}
    </svg>
  );
}

function getAgentProgress(status: string, fallback: number): number {
  switch (status) {
    case "completed":
      return 100;
    case "running":
    case "planning":
    case "verifying":
      return Math.max(15, Math.min(95, fallback));
    case "failed":
    case "cancelled":
      return Math.max(10, fallback);
    default:
      return 0;
  }
}

function getAgentIcon(id: string): string {
  if (id.includes("file")) return "F";
  if (id.includes("code")) return "C";
  if (id.includes("research")) return "R";
  if (id.includes("computer")) return "D";
  if (id.includes("verifier")) return "V";
  if (id.includes("vision")) return "I";
  return "J";
}

function getStepStatusIcon(status: string): string {
  switch (status) {
    case "completed":
      return "OK";
    case "running":
      return "...";
    case "failed":
      return "!";
    case "skipped":
      return "-";
    default:
      return "o";
  }
}

function getStepDuration(step: { durationMs?: number; startedAt?: string; completedAt?: string }): string | undefined {
  if (typeof step.durationMs === "number") {
    return formatDurationMs(step.durationMs);
  }
  if (!step.startedAt || !step.completedAt) {
    return undefined;
  }
  const startedAt = new Date(step.startedAt).getTime();
  const completedAt = new Date(step.completedAt).getTime();
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
    return undefined;
  }
  return formatDurationMs(completedAt - startedAt);
}
