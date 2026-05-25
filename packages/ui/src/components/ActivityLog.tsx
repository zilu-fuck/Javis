import type { WorkbenchLocale, WorkbenchTask } from "../types";
import { translateWorkbenchText } from "../utils";

interface ActivityLogProps {
  activityCount: number;
  isActivityOpen: boolean;
  labels: WorkbenchLocale["labels"];
  locale: WorkbenchLocale;
  task: WorkbenchTask;
  onPermissionDecision?: (decision: "approved" | "denied") => void;
  onToggle: () => void;
}

export function ActivityLog({
  activityCount,
  isActivityOpen,
  labels,
  locale,
  task,
  onPermissionDecision,
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
                  {translateWorkbenchText(
                    `${task.permissionRequest.dryRun.affectedPaths.length} planned path operation(s) require ${task.permissionRequest.level}.`,
                    locale,
                  )}
                </p>
                <div className="javis-confirmation-actions compact">
                  <button
                    disabled={task.permissionRequest.status !== "pending"}
                    onClick={() => onPermissionDecision?.("approved")}
                    type="button"
                  >
                    {labels.approve}
                  </button>
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
