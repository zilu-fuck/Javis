import { useState } from "react";
import type { WorkbenchLocale, WorkbenchPermissionDecision, WorkbenchTask } from "../types";
import { isResearchFallbackTask, translateWorkbenchText } from "../utils";

interface TaskSectionsProps {
  labels: WorkbenchLocale["labels"];
  locale: WorkbenchLocale;
  task: WorkbenchTask;
  onPermissionDecision?: (decision: WorkbenchPermissionDecision) => void;
  onAskUserAnswer?: (answer: string) => void;
}

/**
 * Inline interactive prompts that stay in the main chat thread.
 * All detail sections (plan, documents, commands, code review, research, etc.)
 * have moved to AgentDetailSections in the right sidebar (InspectorPanel).
 */
export function TaskSections({ labels, locale, task, onPermissionDecision, onAskUserAnswer }: TaskSectionsProps) {
  return (
    <>
      {task.status === "failed" ? (
        <section className="javis-recovery" aria-label={labels.failedRecoveryTitle}>
          <p className="javis-message-title">{labels.failedRecoveryTitle}</p>
          <p>{labels.failedRecoveryMessage}</p>
        </section>
      ) : null}

      {isResearchFallbackTask(task) ? (
        <section className="javis-recovery" aria-label={labels.manualSourceFallbackTitle}>
          <p className="javis-message-title">{labels.manualSourceFallbackTitle}</p>
          <p>{labels.manualSourceFallbackMessage}</p>
        </section>
      ) : null}

      {task.permissionRequest ? (
        <section className="javis-confirmation" aria-label={translateWorkbenchText("Permission request", locale)}>
          <div className="javis-confirmation-header">
            <div>
              <p className="javis-message-title">
                {translateWorkbenchText(task.permissionRequest.title, locale)}
              </p>
              <p className="javis-message-body">
                {translateWorkbenchText(task.permissionRequest.reason, locale)}
              </p>
            </div>
            <span className="javis-status">
              {translateWorkbenchText(task.permissionRequest.level, locale)}
            </span>
          </div>
          <p className="javis-message-body">
            {translateWorkbenchText(task.permissionRequest.dryRun.operation, locale)}
          </p>
          <p className="javis-agent-task">
            {translateWorkbenchText(task.permissionRequest.dryRun.riskSummary, locale)}
          </p>
          <div className="javis-dry-run-list">
            {task.permissionRequest.dryRun.affectedPaths.map((path) => (
              <article className="javis-dry-run-item" key={`${path.source}-${path.target}`}>
                <strong>{translateWorkbenchText(path.action, locale)}</strong>
                <p>{path.source}</p>
                <p>{path.target}</p>
                {path.conflict ? (
                  <span>{translateWorkbenchText(path.conflict, locale)}</span>
                ) : null}
              </article>
            ))}
          </div>
          <div className="javis-confirmation-actions">
            <button
              disabled={task.permissionRequest.status !== "pending"}
              onClick={() => onPermissionDecision?.("approved")}
              type="button"
            >
              {labels.approve}
            </button>
            {task.permissionRequest.dryRun.operation.startsWith("computer.") ? (
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
            <span>
              {labels.status}: {translateWorkbenchText(task.permissionRequest.status, locale)}
            </span>
          </div>
          {task.permissionRequest.status === "denied" ? (
            <p className="javis-agent-task">
              {translateWorkbenchText("No write operation executed", locale)}
            </p>
          ) : null}
        </section>
      ) : null}

      {task.askUserQuestion ? (
        <section className="javis-ask-user" aria-label={translateWorkbenchText(labels.askUserQuestion, locale)}>
          <div className="javis-ask-user-header">
            <p className="javis-message-title">
              {translateWorkbenchText(labels.askUserQuestion, locale)}
            </p>
            <span className="javis-status">
              {translateWorkbenchText(task.askUserQuestion.status, locale)}
            </span>
          </div>
          <p className="javis-message-body">
            {translateWorkbenchText(task.askUserQuestion.question, locale)}
          </p>
          {task.askUserQuestion.choices && task.askUserQuestion.choices.length > 0 ? (
            <div className="javis-ask-user-choices">
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
            <AskUserFreeFormInput onSubmit={(answer) => onAskUserAnswer?.(answer)} labels={labels} />
          ) : null}
          {task.askUserQuestion.answer ? (
            <p className="javis-agent-task">
              {translateWorkbenchText(task.askUserQuestion.answer, locale)}
            </p>
          ) : null}
        </section>
      ) : null}
    </>
  );
}

function AskUserFreeFormInput({
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
    <form className="javis-ask-user-input" onSubmit={handleSubmit}>
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
