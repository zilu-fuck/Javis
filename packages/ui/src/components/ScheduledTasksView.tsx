import type { WorkbenchLocale, WorkbenchScheduledTask } from "../types";

interface ScheduledTasksViewProps {
  tasks: WorkbenchScheduledTask[];
  locale: WorkbenchLocale;
  isTaskActive?: boolean;
  onToggle?: (id: string) => void;
  onDelete?: (id: string) => void;
}

export function ScheduledTasksView({
  tasks,
  locale,
  onToggle,
  onDelete,
}: ScheduledTasksViewProps) {
  const labels = locale.labels;

  if (tasks.length === 0) {
    return (
      <div className="javis-view-panel">
        <h2 className="javis-view-title">{labels.automatedTasksTitle}</h2>
        <div className="javis-view-empty">
          <span className="javis-view-empty-icon">●</span>
          <p>{labels.noScheduledTasks}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="javis-view-panel">
      <h2 className="javis-view-title">{labels.automatedTasksTitle}</h2>
      <div className="javis-task-list">
        {tasks.map((task) => (
          <div
            className={`javis-task-card ${task.enabled ? "" : "disabled"}`}
            key={task.id}
          >
            <div className="javis-task-card-header">
              <span className="javis-task-name">{task.name}</span>
              <label className="javis-task-toggle">
                <input
                  checked={task.enabled}
                  onChange={() => onToggle?.(task.id)}
                  type="checkbox"
                />
                <span>
                  {task.enabled
                    ? labels.scheduledTaskEnabled
                    : labels.scheduledTaskDisabled}
                </span>
              </label>
            </div>
            <div className="javis-task-card-meta">
              <span className="javis-task-schedule">
                {task.scheduleType}: {task.scheduleValue}
              </span>
              <span className="javis-task-next-run">
                {labels.scheduledTaskNextRun}:{" "}
                {new Date(task.nextRunAt).toLocaleString()}
              </span>
            </div>
            <div className="javis-task-card-footer">
              <span
                className={`javis-task-last-run status-${task.lastRunStatus}`}
              >
                {labels.scheduledTaskLastRun}: {task.lastRunStatus}
              </span>
              <button
                className="javis-task-delete"
                onClick={() => onDelete?.(task.id)}
                title={labels.deleteHistoryEntry}
                type="button"
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
