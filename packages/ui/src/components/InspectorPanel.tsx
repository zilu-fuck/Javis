import { useEffect, useState } from "react";
import type { WorkbenchDetailItem, WorkbenchLocale, WorkbenchTask } from "../types";
import { translateWorkbenchText } from "../utils";

interface InspectorPanelProps {
  detailItem?: WorkbenchDetailItem | null;
  isInspectorOpen: boolean;
  labels: WorkbenchLocale["labels"];
  locale: WorkbenchLocale;
  task: WorkbenchTask;
  onToggle: () => void;
}

export function InspectorPanel({ detailItem, isInspectorOpen, labels, locale, task, onToggle }: InspectorPanelProps) {
  const [activeSection, setActiveSection] = useState<"agents" | "details">("agents");
  const changedFiles = getReviewChangedFiles(task);
  const detailCount = detailItem ? 1 : changedFiles.length;
  const detailsLabel = labels.aiModeSettings === "AI 模式" ? "详情" : "Details";

  useEffect(() => {
    if (detailItem) {
      setActiveSection("details");
    }
  }, [detailItem]);

  function handleSectionToggle(section: "agents" | "details") {
    if (isInspectorOpen && activeSection === section) {
      onToggle();
      return;
    }
    setActiveSection(section);
    if (!isInspectorOpen) {
      onToggle();
    }
  }

  return (
    <aside className="javis-inspector" aria-label={labels.agentContextInspector}>
      <div className="javis-inspector-rail">
        <button
          aria-controls="javis-inspector-panel"
          aria-expanded={isInspectorOpen && activeSection === "agents"}
          className={`javis-inspector-toggle ${activeSection === "agents" ? "active" : ""}`}
          onClick={() => handleSectionToggle("agents")}
          type="button"
        >
          <span>{labels.agentGraph}</span>
          <span className="javis-activity-count">{task.agents.length}</span>
          <span>{isInspectorOpen && activeSection === "agents" ? labels.collapseInspector : labels.expandInspector}</span>
        </button>
        <button
          aria-controls="javis-inspector-panel"
          aria-expanded={isInspectorOpen && activeSection === "details"}
          className={`javis-inspector-toggle ${activeSection === "details" ? "active" : ""}`}
          onClick={() => handleSectionToggle("details")}
          type="button"
        >
          <span>{detailsLabel}</span>
          {detailCount > 0 ? <span className="javis-activity-count">{detailCount}</span> : null}
          <span>{isInspectorOpen && activeSection === "details" ? labels.collapseInspector : labels.expandInspector}</span>
        </button>
      </div>
      {isInspectorOpen ? (
        <div className="javis-inspector-panel" id="javis-inspector-panel">
          <header className="javis-inspector-header">
            <p className="javis-eyebrow">{labels.agentContextInspector}</p>
            <h2 className="javis-title">
              {activeSection === "details" ? detailsLabel : labels.agentGraph}
            </h2>
          </header>
          {activeSection === "details" ? (
            <DetailInspector
              detailItem={detailItem}
              labels={labels}
              locale={locale}
              task={task}
              changedFiles={changedFiles}
              detailsLabel={detailsLabel}
            />
          ) : (
            <section className="javis-agent-list" aria-label={labels.agentStates}>
              {task.agents.map((agent) => (
                <article className="javis-agent" key={agent.id}>
                  <div className="javis-agent-row">
                    <span className="javis-agent-name">
                      {translateWorkbenchText(agent.name, locale)}
                    </span>
                    <span className="javis-status">
                      {translateWorkbenchText(agent.status, locale)}
                    </span>
                  </div>
                  <p className="javis-agent-task">{translateWorkbenchText(agent.role, locale)}</p>
                  <p className="javis-agent-task">{translateWorkbenchText(agent.task, locale)}</p>
                </article>
              ))}
            </section>
          )}
        </div>
      ) : null}
    </aside>
  );
}

function DetailInspector({
  detailItem,
  labels,
  locale,
  task,
  changedFiles,
  detailsLabel,
}: {
  detailItem?: WorkbenchDetailItem | null;
  labels: WorkbenchLocale["labels"];
  locale: WorkbenchLocale;
  task: WorkbenchTask;
  changedFiles: string[];
  detailsLabel: string;
}) {
  const hasCodeReviewDetails =
    changedFiles.length > 0 ||
    Boolean(task.codeReviewPreview || task.codeProposedEdit || task.codeApplyResult);

  return (
    <section className="javis-review-inspector" aria-label={detailItem ? detailsLabel : labels.codeReview}>
      {detailItem ? (
        <article className="javis-review-card">
          <div className="javis-review-card-title">
            <strong>{detailItem.title}</strong>
            {detailItem.kind ? <span>{detailItem.kind}</span> : null}
          </div>
          {detailItem.description ? <p>{detailItem.description}</p> : null}
          {detailItem.source ? <p>{detailItem.source}</p> : null}
          {detailItem.metadata && detailItem.metadata.length > 0 ? (
            <dl className="javis-detail-metadata">
              {detailItem.metadata.map((item) => (
                <div key={`${item.label}-${item.value}`}>
                  <dt>{item.label}</dt>
                  <dd>{item.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {detailItem.url ? (
            <a className="javis-detail-link" href={detailItem.url}>
              {detailItem.url}
            </a>
          ) : null}
        </article>
      ) : null}

      {hasCodeReviewDetails ? (
        <article className="javis-review-card">
          <div className="javis-review-card-title">
            <strong>{labels.changedFiles}</strong>
            <span>{changedFiles.length}</span>
          </div>
          {changedFiles.length > 0 ? (
            <ul className="javis-review-file-list">
              {changedFiles.map((file) => (
                <li key={file}>{file}</li>
              ))}
            </ul>
          ) : (
            <p>{labels.emptyOutput}</p>
          )}
        </article>
      ) : null}

      {task.codeReviewPreview ? (
        <article className="javis-review-card">
          <div className="javis-review-card-title">
            <strong>{labels.codeReview}</strong>
            <span>{translateWorkbenchText("preview", locale)}</span>
          </div>
          <p>{task.codeReviewPreview.workspacePath}</p>
          <p>{task.codeReviewPreview.diffStat || labels.emptyOutput}</p>
          <pre>{task.codeReviewPreview.diff || labels.emptyOutput}</pre>
        </article>
      ) : null}

      {task.codeProposedEdit ? (
        <article className="javis-review-card">
          <div className="javis-review-card-title">
            <strong>{translateWorkbenchText("Code Agent patch proposal", locale)}</strong>
            <span>{task.codeProposedEdit.patchHash}</span>
          </div>
          <p>{translateWorkbenchText(task.codeProposedEdit.summary, locale)}</p>
          <pre>{task.codeProposedEdit.patch || labels.emptyOutput}</pre>
        </article>
      ) : null}

      {task.codeApplyResult ? (
        <article className="javis-review-card">
          <div className="javis-review-card-title">
            <strong>{translateWorkbenchText("Code Agent apply result", locale)}</strong>
            <span>{translateWorkbenchText(task.codeApplyResult.applied ? "applied" : "not applied", locale)}</span>
          </div>
          <p>{translateWorkbenchText(task.codeApplyResult.message, locale)}</p>
        </article>
      ) : null}
    </section>
  );
}

function getReviewChangedFiles(task: WorkbenchTask): string[] {
  return Array.from(new Set([
    ...(task.codeReviewPreview?.changedFiles ?? []),
    ...(task.codeProposedEdit?.changedFiles ?? []),
    ...(task.codeApplyResult?.changedFiles ?? []),
  ]));
}
