import type { WorkbenchLocale, WorkbenchTask } from "../types";
import { formatModifiedTime, formatSize, translateWorkbenchText } from "../utils";

interface AgentDetailSectionsProps {
  labels: WorkbenchLocale["labels"];
  locale: WorkbenchLocale;
  task: WorkbenchTask;
}

export function AgentDetailSections({ labels, locale, task }: AgentDetailSectionsProps) {
  return (
    <div className="javis-agent-detail-sections">
      {task.plan.length > 0 ? (
        <section className="javis-plan" aria-label={labels.plan}>
          <p className="javis-message-title">{labels.plan}</p>
          {task.plan.map((step) => (
            <div className="javis-plan-step" key={step.id}>
              <span className="javis-status">{translateWorkbenchText(step.status, locale)}</span>
              <div>
                <strong>{translateWorkbenchText(step.title, locale)}</strong>
                {step.successCriteria ? (
                  <p>{translateWorkbenchText(step.successCriteria, locale)}</p>
                ) : null}
              </div>
            </div>
          ))}
        </section>
      ) : null}

      {task.documents && task.documents.length > 0 ? (
        <section className="javis-documents" aria-label={labels.markdownDocuments}>
          <p className="javis-message-title">{labels.markdownDocuments}</p>
          {task.documents.map((document) => (
            <article className="javis-document" key={document.path}>
              <div className="javis-document-row">
                <strong>{document.path}</strong>
                <span>{formatSize(document.sizeBytes)}</span>
              </div>
              <p>{translateWorkbenchText(document.purpose, locale)}</p>
              {document.excerpt ? <p>{translateWorkbenchText(document.excerpt, locale)}</p> : null}
              <span>
                {labels.modified}: {formatModifiedTime(document.modifiedAt)}
              </span>
            </article>
          ))}
        </section>
      ) : null}

      {task.commands && task.commands.length > 0 ? (
        <section className="javis-documents" aria-label={labels.commandResults}>
          <p className="javis-message-title">{labels.commandResults}</p>
          {task.commands.map((command) => (
            <article className="javis-document" key={command.command}>
              <div className="javis-document-row">
                <strong>{command.command}</strong>
                <span>exit: {command.exitCode ?? labels.unknown}</span>
              </div>
              <p>{command.stdout || command.stderr || labels.emptyOutput}</p>
              <span>cwd: {command.cwd}</span>
            </article>
          ))}
        </section>
      ) : null}

      {task.codeReviewPreview ? (
        <section className="javis-documents" aria-label={labels.codeReview}>
          <p className="javis-message-title">{labels.codeReview}</p>
          <article className="javis-document">
            <div className="javis-document-row">
              <strong>{task.codeReviewPreview.workspacePath}</strong>
              <span>
                {labels.changedFiles}: {task.codeReviewPreview.changedFiles.length}
              </span>
            </div>
            {task.codeReviewPreview.diffStat ? (
              <p>{task.codeReviewPreview.diffStat}</p>
            ) : (
              <p>{labels.emptyOutput}</p>
            )}
          </article>
          {task.codeReviewPreview.changedFiles.map((file) => (
            <article className="javis-document" key={file}>
              <div className="javis-document-row">
                <strong>{file}</strong>
                <span>{labels.changedFiles}</span>
              </div>
            </article>
          ))}
          <article className="javis-document">
            <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {task.codeReviewPreview.diff || labels.emptyOutput}
            </pre>
          </article>
        </section>
      ) : null}

      {task.codeProposedEdit ? (
        <section className="javis-documents" aria-label={translateWorkbenchText("Code Agent patch proposal", locale)}>
          <p className="javis-message-title">
            {translateWorkbenchText("Code Agent patch proposal", locale)}
          </p>
          <article className="javis-document">
            <div className="javis-document-row">
              <strong>{task.codeProposedEdit.workspacePath}</strong>
              <span>
                {labels.changedFiles}: {task.codeProposedEdit.changedFiles.length}
              </span>
            </div>
            <p>{translateWorkbenchText(task.codeProposedEdit.summary, locale)}</p>
          </article>
          {task.codeProposedEdit.changedFiles.map((file) => (
            <article className="javis-document" key={file}>
              <div className="javis-document-row">
                <strong>{file}</strong>
                <span>{translateWorkbenchText("proposed", locale)}</span>
              </div>
            </article>
          ))}
          <article className="javis-document">
            <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {task.codeProposedEdit.patch || labels.emptyOutput}
            </pre>
          </article>
        </section>
      ) : null}

      {task.codeApplyResult ? (
        <section className="javis-documents" aria-label={translateWorkbenchText("Code Agent apply result", locale)}>
          <p className="javis-message-title">
            {translateWorkbenchText("Code Agent apply result", locale)}
          </p>
          <article className="javis-document">
            <div className="javis-document-row">
              <strong>
                {translateWorkbenchText(task.codeApplyResult.applied ? "applied" : "not applied", locale)}
              </strong>
              <span>
                {labels.changedFiles}: {task.codeApplyResult.changedFiles.length}
              </span>
            </div>
            <p>{translateWorkbenchText(task.codeApplyResult.message, locale)}</p>
          </article>
        </section>
      ) : null}

      {task.project ? (
        <section className="javis-documents" aria-label={labels.projectInspection}>
          <p className="javis-message-title">{labels.projectInspection}</p>
          <article className="javis-document">
            <div className="javis-document-row">
              <strong>{task.project.workspacePath}</strong>
              <span>{task.project.packageManager ?? labels.unknownManager}</span>
            </div>
            <p>Start: {task.project.recommendedStartCommand ?? translateWorkbenchText("not found", locale)}</p>
            <p>
              {labels.testCheck}:{" "}
              {task.project.recommendedTestCommand ?? translateWorkbenchText("not found", locale)}
            </p>
          </article>
          {task.project.scripts.map((script) => (
            <article className="javis-document" key={script.name}>
              <div className="javis-document-row">
                <strong>{script.name}</strong>
                <span>{labels.packageScript}</span>
              </div>
              <p>{script.command}</p>
            </article>
          ))}
        </section>
      ) : null}

      {task.fileOrganizationExecution ? (
        <section className="javis-documents" aria-label={labels.fileOrganizationResult}>
          <p className="javis-message-title">{labels.fileOrganizationResult}</p>
          <article className="javis-document">
            <div className="javis-document-row">
              <strong>
                {translateWorkbenchText(
                  `${task.fileOrganizationExecution.attemptedCount} planned operation(s)`,
                  locale,
                )}
              </strong>
              <span>
                {translateWorkbenchText(`${task.fileOrganizationExecution.movedCount} moved`, locale)} /
                {translateWorkbenchText(` ${task.fileOrganizationExecution.skippedCount} skipped`, locale)} /
                {translateWorkbenchText(` ${task.fileOrganizationExecution.failedCount} failed`, locale)}
              </span>
            </div>
          </article>
          {task.fileOrganizationExecution.results.map((result) => (
            <article className="javis-document" key={`${result.source}-${result.target}`}>
              <div className="javis-document-row">
                <strong>{translateWorkbenchText(result.status, locale)}</strong>
                <span>{translateWorkbenchText(result.message, locale)}</span>
              </div>
              <p>{result.source}</p>
              <p>{result.target}</p>
            </article>
          ))}
        </section>
      ) : null}

      {task.sources && task.sources.length > 0 ? (
        <section className="javis-documents" aria-label={labels.researchSources}>
          <p className="javis-message-title">{labels.researchSources}</p>
          {task.sources.map((source) => (
            <article className="javis-document" key={source.url}>
              <div className="javis-document-row">
                <strong>{translateWorkbenchText(source.title || source.url, locale)}</strong>
                <span>{formatModifiedTime(source.fetchedAt)}</span>
              </div>
              <p>{translateWorkbenchText(source.excerpt, locale)}</p>
              <span>{source.url}</span>
              {source.provider ? <span>{source.provider}</span> : null}
            </article>
          ))}
        </section>
      ) : null}

      {task.researchReport ? (
        <section className="javis-documents" aria-label={labels.researchReport}>
          <p className="javis-message-title">
            {translateWorkbenchText(task.researchReport.title, locale)}
          </p>
          <article className="javis-document">
            <p>{translateWorkbenchText(task.researchReport.summary, locale)}</p>
          </article>
          {task.researchReport.rows.map((row) => (
            <article className="javis-document" key={row.sourceUrl}>
              <div className="javis-document-row">
                <strong>{translateWorkbenchText(row.claim, locale)}</strong>
                <span>{labels.source}</span>
              </div>
              <p>{translateWorkbenchText(row.evidence, locale)}</p>
              <span>{row.sourceUrl}</span>
            </article>
          ))}
          {task.researchReport.unknowns.map((unknown) => (
            <article className="javis-document" key={unknown}>
              <div className="javis-document-row">
                <strong>{labels.unknown}</strong>
                <span>{labels.unverified}</span>
              </div>
              <p>{translateWorkbenchText(unknown, locale)}</p>
            </article>
          ))}
        </section>
      ) : null}

      {task.verificationSummary ? (
        <article className="javis-message">
          <p className="javis-message-title">{labels.verifier}</p>
          <p className="javis-message-body">
            {translateWorkbenchText(task.verificationSummary, locale)}
          </p>
        </article>
      ) : null}

      {(() => {
        const desktopLogs = task.logs.filter((l) =>
          l.kind === "tool" && (
            // Match by tool name prefix — covers all computer.* tools
            // including new UIA ones (invokeUi, setUiValue, inspectUi)
            l.title.startsWith("computer.") ||
            l.title.includes("desktop_") ||
            l.title.includes("computer-use")
          )
        );
        if (desktopLogs.length === 0) return null;
        return (
          <section className="javis-documents" aria-label={translateWorkbenchText("Desktop automation steps", locale)}>
            <p className="javis-message-title">
              {translateWorkbenchText("Desktop automation steps", locale)}
            </p>
            {desktopLogs.map((log) => (
              <article className="javis-document" key={log.id}>
                <div className="javis-document-row">
                  <strong>{log.title}</strong>
                  <span>{log.kind}</span>
                </div>
                <p>{translateWorkbenchText(log.detail, locale)}</p>
              </article>
            ))}
          </section>
        );
      })()}
    </div>
  );
}
