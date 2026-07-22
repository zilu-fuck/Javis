import { useEffect, useState } from "react";
import type { WorkbenchLocale, WorkbenchTask } from "../types";
import { formatDurationMs, getTaskStatusLabel, getTaskStatusProgress, translateWorkbenchText } from "../utils";
import { getParticipatingAgents } from "./agent-visibility";

interface AgentOrchestrationPanelProps {
  initiallyExpanded?: boolean;
  locale: WorkbenchLocale;
  onSelectAgent?: (agentId: string) => void;
  selectedAgentId?: string;
  task: WorkbenchTask;
}

export function AgentOrchestrationPanel({
  initiallyExpanded,
  locale,
  onSelectAgent,
  selectedAgentId,
  task,
}: AgentOrchestrationPanelProps) {
  const steps = task.plan ?? [];
  const shouldShow = steps.length > 0 && task.status !== "created";
  const visibleAgents = getParticipatingAgents(task);
  const [isCollapsed, setIsCollapsed] = useState(() =>
    initiallyExpanded === undefined
      ? isTerminalStatus(task.status)
      : !initiallyExpanded,
  );
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
    if (initiallyExpanded !== undefined) {
      return;
    }
    setIsCollapsed(isTerminalStatus(task.status));
  }, [initiallyExpanded, task.status]);

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
          {visibleAgents.length > 0 ? (
            <div className="javis-agent-run-stage">
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

function isTerminalStatus(status: WorkbenchTask["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
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
