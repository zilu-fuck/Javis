import { useState, type FormEvent } from "react";
import type {
  WorkbenchLocale,
  WorkbenchScheduledTask,
  WorkbenchScheduledTaskDraft,
} from "../types";

interface ScheduledTasksViewProps {
  tasks: WorkbenchScheduledTask[];
  locale: WorkbenchLocale;
  isTaskActive?: boolean;
  currentWorkspacePath?: string;
  onCreate?: (draft: WorkbenchScheduledTaskDraft) => void;
  onToggle?: (id: string) => void;
  onDelete?: (id: string) => void;
}

export function ScheduledTasksView({
  tasks,
  locale,
  currentWorkspacePath = "",
  onCreate,
  onToggle,
  onDelete,
}: ScheduledTasksViewProps) {
  const labels = locale.labels;
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [workspacePath, setWorkspacePath] = useState(currentWorkspacePath);
  const [scheduleType, setScheduleType] = useState<WorkbenchScheduledTaskDraft["scheduleType"]>("daily");
  const [scheduleValue, setScheduleValue] = useState("09:00");

  function handleScheduleTypeChange(nextType: WorkbenchScheduledTaskDraft["scheduleType"]) {
    setScheduleType(nextType);
    setScheduleValue(defaultScheduleValue(nextType));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedGoal = goal.trim();
    if (!trimmedGoal || !onCreate) return;
    onCreate({
      name: name.trim() || trimmedGoal.slice(0, 48),
      goal: trimmedGoal,
      workspacePath: workspacePath.trim(),
      scheduleType,
      scheduleValue: scheduleValue.trim(),
    });
    setName("");
    setGoal("");
  }

  return (
    <div className="javis-view-panel">
      <h2 className="javis-view-title">{labels.automatedTasksTitle}</h2>
      <ScheduledTaskCreateForm
        goal={goal}
        labels={labels}
        name={name}
        onGoalChange={setGoal}
        onNameChange={setName}
        onScheduleTypeChange={handleScheduleTypeChange}
        onScheduleValueChange={setScheduleValue}
        onSubmit={handleSubmit}
        onWorkspacePathChange={setWorkspacePath}
        scheduleType={scheduleType}
        scheduleValue={scheduleValue}
        workspacePath={workspacePath}
      />
      {tasks.length === 0 ? (
        <div className="javis-view-empty">
          <span className="javis-view-empty-icon">+</span>
          <p>{labels.noScheduledTasks}</p>
        </div>
      ) : (
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
                  x
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface ScheduledTaskCreateFormProps {
  goal: string;
  labels: WorkbenchLocale["labels"];
  name: string;
  scheduleType: WorkbenchScheduledTaskDraft["scheduleType"];
  scheduleValue: string;
  workspacePath: string;
  onGoalChange(value: string): void;
  onNameChange(value: string): void;
  onScheduleTypeChange(value: WorkbenchScheduledTaskDraft["scheduleType"]): void;
  onScheduleValueChange(value: string): void;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
  onWorkspacePathChange(value: string): void;
}

function ScheduledTaskCreateForm({
  goal,
  labels,
  name,
  scheduleType,
  scheduleValue,
  workspacePath,
  onGoalChange,
  onNameChange,
  onScheduleTypeChange,
  onScheduleValueChange,
  onSubmit,
  onWorkspacePathChange,
}: ScheduledTaskCreateFormProps) {
  return (
    <form className="javis-scheduled-create" onSubmit={onSubmit}>
      <input
        aria-label={labels.scheduledTaskName}
        onChange={(event) => onNameChange(event.currentTarget.value)}
        placeholder={labels.scheduledTaskName}
        value={name}
      />
      <input
        aria-label={labels.scheduledTaskGoal}
        onChange={(event) => onGoalChange(event.currentTarget.value)}
        placeholder={labels.scheduledTaskGoal}
        required
        value={goal}
      />
      <input
        aria-label={labels.currentWorkspace}
        onChange={(event) => onWorkspacePathChange(event.currentTarget.value)}
        placeholder={labels.workspacePathPlaceholder}
        value={workspacePath}
      />
      <select
        aria-label={labels.scheduledTaskScheduleType}
        onChange={(event) =>
          onScheduleTypeChange(event.currentTarget.value as WorkbenchScheduledTaskDraft["scheduleType"])
        }
        value={scheduleType}
      >
        <option value="daily">{labels.scheduledTaskDaily}</option>
        <option value="weekly">{labels.scheduledTaskWeekly}</option>
        <option value="interval">{labels.scheduledTaskInterval}</option>
        <option value="once">{labels.scheduledTaskOnce}</option>
      </select>
      <input
        aria-label={labels.scheduledTaskScheduleValue}
        onChange={(event) => onScheduleValueChange(event.currentTarget.value)}
        placeholder={scheduleValuePlaceholder(scheduleType)}
        required
        value={scheduleValue}
      />
      <button type="submit">{labels.createScheduledTask}</button>
    </form>
  );
}

function defaultScheduleValue(type: WorkbenchScheduledTaskDraft["scheduleType"]): string {
  switch (type) {
    case "interval":
      return "3600000";
    case "weekly":
      return "Mon 09:00";
    case "once":
      return new Date(Date.now() + 60 * 60 * 1000).toISOString();
    case "daily":
      return "09:00";
  }
}

function scheduleValuePlaceholder(type: WorkbenchScheduledTaskDraft["scheduleType"]): string {
  return defaultScheduleValue(type);
}
