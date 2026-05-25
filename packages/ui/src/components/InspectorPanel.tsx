import type { WorkbenchLocale, WorkbenchTask } from "../types";
import { translateWorkbenchText } from "../utils";

interface InspectorPanelProps {
  isInspectorOpen: boolean;
  labels: WorkbenchLocale["labels"];
  locale: WorkbenchLocale;
  task: WorkbenchTask;
  onToggle: () => void;
}

export function InspectorPanel({ isInspectorOpen, labels, locale, task, onToggle }: InspectorPanelProps) {
  return (
    <aside className="javis-inspector" aria-label={labels.agentContextInspector}>
      <button
        aria-controls="javis-inspector-panel"
        aria-expanded={isInspectorOpen}
        className="javis-inspector-toggle"
        onClick={() => onToggle()}
        type="button"
      >
        <span>{labels.agentGraph}</span>
        <span className="javis-activity-count">{task.agents.length}</span>
        <span>{isInspectorOpen ? labels.collapseInspector : labels.expandInspector}</span>
      </button>
      {isInspectorOpen ? (
        <div className="javis-inspector-panel" id="javis-inspector-panel">
          <header className="javis-inspector-header">
            <p className="javis-eyebrow">{labels.agentContextInspector}</p>
            <h2 className="javis-title">{labels.agentGraph}</h2>
          </header>
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
        </div>
      ) : null}
    </aside>
  );
}
