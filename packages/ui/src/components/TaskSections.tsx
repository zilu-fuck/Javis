import { useState } from "react";
import type {
  WorkbenchAskUserChoice,
  WorkbenchLocale,
  WorkbenchPermissionDecision,
  WorkbenchTask,
} from "../types";
import { isResearchFallbackTask, translateWorkbenchText } from "../utils";

export const HELP_ME_DECIDE_ANSWER = "__javis_help_me_decide__";

const COMPUTER_TASK_APPROVAL_OPERATIONS = new Set([
  "computer.moveMouse",
  "computer.click",
  "computer.scroll",
  "computer.focusWindow",
]);

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
  const permissionRequest = task.permissionRequest;
  const askUserQuestion = task.askUserQuestion;
  const shouldShowPermissionPrompt =
    task.status === "waiting_permission" && permissionRequest?.status === "pending";
  const shouldShowAskUserPrompt =
    task.status === "waiting_info" && askUserQuestion?.status === "pending";

  return (
    <>
      {task.status === "failed" ? (
        <section className="javis-recovery" aria-label={labels.failedRecoveryTitle}>
          <p className="javis-message-title">{labels.failedRecoveryTitle}</p>
          {task.userFacingError ? (
            <p className="javis-recovery-error">{task.userFacingError}</p>
          ) : null}
          <p>{labels.failedRecoveryMessage}</p>
        </section>
      ) : null}

      {isResearchFallbackTask(task) ? (
        <section className="javis-recovery" aria-label={labels.manualSourceFallbackTitle}>
          <p className="javis-message-title">{labels.manualSourceFallbackTitle}</p>
          <p>{labels.manualSourceFallbackMessage}</p>
        </section>
      ) : null}

      {shouldShowPermissionPrompt && permissionRequest ? (
        <section className="javis-confirmation" aria-label={translateWorkbenchText("Permission request", locale)}>
          <div className="javis-confirmation-header">
            <div>
              <p className="javis-message-title">
                {translateWorkbenchText(permissionRequest.title, locale)}
              </p>
              <p className="javis-message-body">
                {translateWorkbenchText(permissionRequest.reason, locale)}
              </p>
            </div>
            <div className="javis-confirmation-badges">
              <span className="javis-status">
                {translateWorkbenchText(permissionRequest.level, locale)}
              </span>
              {permissionRequest.writeRiskLevel ? (
                <span className={`javis-status javis-risk-status risk-${permissionRequest.writeRiskLevel}`}>
                  {translateWorkbenchText(permissionRequest.writeRiskLevel, locale)}
                </span>
              ) : null}
            </div>
          </div>
          <p className="javis-message-body">
            {translateWorkbenchText(permissionRequest.dryRun.operation, locale)}
          </p>
          <p className="javis-agent-task">
            {translateWorkbenchText(permissionRequest.dryRun.riskSummary, locale)}
          </p>
          {permissionRequest.screenshotDataUrl ? (
            <img
              alt={translateWorkbenchText("Desktop preview", locale)}
              className="javis-permission-screenshot"
              src={permissionRequest.screenshotDataUrl}
            />
          ) : null}
          <div className="javis-dry-run-list">
            {permissionRequest.dryRun.affectedPaths.map((path) => (
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
              disabled={permissionRequest.status !== "pending"}
              onClick={() => onPermissionDecision?.("approved")}
              type="button"
            >
              {labels.approve}
            </button>
            {canShowComputerTaskApproval(permissionRequest) ? (
              <button
                disabled={permissionRequest.status !== "pending"}
                onClick={() => onPermissionDecision?.("approved_always")}
                type="button"
              >
                {translateWorkbenchText("Allow this task", locale)}
              </button>
            ) : permissionRequest.dryRun.operation.startsWith("computer.") ||
              permissionRequest.allowAlways === false ? null : (
              <button
                disabled={permissionRequest.status !== "pending"}
                onClick={() => onPermissionDecision?.("approved_always")}
                type="button"
              >
                {labels.alwaysAllow}
              </button>
            )}
            <button
              disabled={permissionRequest.status !== "pending"}
              onClick={() => onPermissionDecision?.("denied")}
              type="button"
            >
              {labels.deny}
            </button>
            <span>
              {labels.status}: {translateWorkbenchText(permissionRequest.status, locale)}
            </span>
          </div>
        </section>
      ) : null}

      {shouldShowAskUserPrompt && askUserQuestion ? (
        <section className="javis-ask-user" aria-label={translateWorkbenchText(labels.askUserQuestion, locale)}>
          <div className="javis-ask-user-header">
            <p className="javis-message-title">
              {translateWorkbenchText(labels.askUserQuestion, locale)}
            </p>
            <span className="javis-status">
              {translateWorkbenchText(askUserQuestion.status, locale)}
            </span>
          </div>
          <p className="javis-message-body">
            {translateWorkbenchText(askUserQuestion.question, locale)}
          </p>
          {askUserQuestion.choices && askUserQuestion.choices.length > 0 ? (
            <div className="javis-ask-user-choices">
              {askUserQuestion.choices.map((rawChoice) => {
                const choice = normalizeAskUserChoice(rawChoice);
                return (
                  <button
                    className={choice.isRecommended ? "recommended" : undefined}
                    key={choice.value}
                    disabled={askUserQuestion.status !== "pending"}
                    onClick={() => onAskUserAnswer?.(choice.value)}
                    type="button"
                  >
                    {translateWorkbenchText(choice.label, locale)}
                  </button>
                );
              })}
              <button
                disabled={askUserQuestion.status !== "pending"}
                onClick={() => onAskUserAnswer?.(HELP_ME_DECIDE_ANSWER)}
                type="button"
              >
                {translateWorkbenchText("Help me decide", locale)}
              </button>
            </div>
          ) : null}
          {askUserQuestion.status === "pending" ? (
            <AskUserFreeFormInput onSubmit={(answer) => onAskUserAnswer?.(answer)} labels={labels} />
          ) : null}
          {askUserQuestion.answer ? (
            <p className="javis-agent-task">
              {translateWorkbenchText(askUserQuestion.answer, locale)}
            </p>
          ) : null}
        </section>
      ) : null}
    </>
  );
}

function canShowComputerTaskApproval(request: WorkbenchTask["permissionRequest"]): boolean {
  return Boolean(
    request &&
    request.allowAlways !== false &&
    COMPUTER_TASK_APPROVAL_OPERATIONS.has(request.dryRun.operation),
  );
}

function normalizeAskUserChoice(choice: string | WorkbenchAskUserChoice): WorkbenchAskUserChoice {
  return typeof choice === "string"
    ? { label: choice, value: choice }
    : choice;
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
