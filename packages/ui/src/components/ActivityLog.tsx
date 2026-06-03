import { useState } from "react";
import type { WorkbenchLocale, WorkbenchPermissionDecision, WorkbenchTask } from "../types";
import { translateWorkbenchText } from "../utils";

interface ActivityLogProps {
  activityCount: number;
  isActivityOpen: boolean;
  labels: WorkbenchLocale["labels"];
  locale: WorkbenchLocale;
  task: WorkbenchTask;
  onPermissionDecision?: (decision: WorkbenchPermissionDecision) => void;
  onAskUserAnswer?: (answer: string) => void;
  onToggle: () => void;
}

export function ActivityLog({
  activityCount,
  isActivityOpen,
  labels,
  locale,
  task,
  onPermissionDecision,
  onAskUserAnswer,
  onToggle,
}: ActivityLogProps) {
  return (
    <section className="javis-activity" aria-label={labels.activityLog}>
      <button
        aria-controls="javis-activity-panel"
        aria-expanded={isActivityOpen}
        className="javis-activity-toggle"
        onClick={() => onToggle()}
        type="button"
      >
        <span>{labels.activityLog}</span>
        <span className="javis-activity-count">{activityCount}</span>
        <span>{isActivityOpen ? labels.collapseActivityLog : labels.expandActivityLog}</span>
      </button>
      {isActivityOpen ? (
        <div className="javis-activity-panel" id="javis-activity-panel">
          <header className="javis-activity-header">
            <p className="javis-eyebrow">{labels.activityLog}</p>
            <h2 className="javis-title">{labels.executionTimeline}</h2>
          </header>
          <div className="javis-activity-list">
            {task.permissionRequest ? (
              <article className="javis-log javis-log-confirmation">
                <div className="javis-log-row">
                  <strong>{translateWorkbenchText(task.permissionRequest.title, locale)}</strong>
                  <span className="javis-log-kind">
                    {translateWorkbenchText(task.permissionRequest.status, locale)}
                  </span>
                </div>
                <p className="javis-log-detail">
                  {translateWorkbenchText(permissionLogDetail(task), locale)}
                </p>
                <div className="javis-confirmation-actions compact">
                  <button
                    disabled={task.permissionRequest.status !== "pending"}
                    onClick={() => onPermissionDecision?.("approved")}
                    type="button"
                  >
                    {labels.approve}
                  </button>
                  {isComputerPermission(task) ? (
                    <button
                      disabled={task.permissionRequest.status !== "pending"}
                      onClick={() => onPermissionDecision?.("approved_always")}
                      type="button"
                    >
                      {labels.alwaysAllow}
                    </button>
                  ) : null}
                  <button
                    disabled={task.permissionRequest.status !== "pending"}
                    onClick={() => onPermissionDecision?.("denied")}
                    type="button"
                  >
                    {labels.deny}
                  </button>
                </div>
              </article>
            ) : null}
            {task.askUserQuestion ? (
              <article className="javis-log javis-log-ask-user">
                <div className="javis-log-row">
                  <strong>{translateWorkbenchText(task.askUserQuestion.question, locale)}</strong>
                  <span className="javis-log-kind">
                    {translateWorkbenchText(task.askUserQuestion.status, locale)}
                  </span>
                </div>
                {task.askUserQuestion.choices && task.askUserQuestion.choices.length > 0 ? (
                  <div className="javis-confirmation-actions compact">
                    {task.askUserQuestion.choices.map((choice) => (
                      <button
                        key={choice}
                        disabled={task.askUserQuestion!.status !== "pending"}
                        onClick={() => onAskUserAnswer?.(choice)}
                        type="button"
                      >
                        {translateWorkbenchText(choice, locale)}
                      </button>
                    ))}
                  </div>
                ) : null}
                {task.askUserQuestion.status === "pending" && (!task.askUserQuestion.choices || task.askUserQuestion.choices.length === 0) ? (
                  <AskUserCompactInput onSubmit={(answer) => onAskUserAnswer?.(answer)} labels={labels} />
                ) : null}
              </article>
            ) : null}
            {task.logs.map((log) => (
              <article className="javis-log" key={log.id}>
                <div className="javis-log-row">
                  <strong>{translateWorkbenchText(log.title, locale)}</strong>
                  <span className="javis-log-kind">
                    {translateWorkbenchText(log.kind, locale)}
                  </span>
                </div>
                <p className="javis-log-detail">
                  {translateWorkbenchText(log.detail, locale)}
                </p>
              </article>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function AskUserCompactInput({
  onSubmit,
  labels,
}: {
  onSubmit: (answer: string) => void;
  labels: WorkbenchLocale["labels"];
}) {
  const [value, setValue] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed) {
      onSubmit(trimmed);
      setValue("");
    }
  }

  return (
    <form className="javis-ask-user-input compact" onSubmit={handleSubmit}>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={labels.submitAnswer}
      />
      <button type="submit" disabled={!value.trim()}>
        {labels.submitAnswer}
      </button>
    </form>
  );
}

function permissionLogDetail(task: WorkbenchTask): string {
  const request = task.permissionRequest;
  if (!request) return "";
  if (request.dryRun.operation.startsWith("computer.")) {
    return `${request.dryRun.operation} requires ${request.level}: ${request.dryRun.riskSummary}`;
  }
  return `${request.dryRun.affectedPaths.length} planned path operation(s) require ${request.level}.`;
}

function isComputerPermission(task: WorkbenchTask): boolean {
  return Boolean(task.permissionRequest?.dryRun.operation.startsWith("computer."));
}
