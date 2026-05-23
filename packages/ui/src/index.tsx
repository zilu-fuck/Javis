import type { FormEvent } from "react";

export interface WorkbenchAgent {
  id: string;
  name: string;
  role: string;
  status: string;
  task: string;
}

export interface WorkbenchStep {
  id: string;
  title: string;
  status: string;
  successCriteria?: string;
}

export interface WorkbenchLogEntry {
  id: string;
  kind: string;
  title: string;
  detail: string;
}

export interface WorkbenchDocument {
  path: string;
  modifiedAt: string;
  sizeBytes: number;
  heading?: string;
  excerpt?: string;
  purpose: string;
}

export interface WorkbenchCommand {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface WorkbenchSource {
  url: string;
  title?: string;
  excerpt: string;
  fetchedAt: string;
}

export interface WorkbenchTask {
  title: string;
  userGoal: string;
  status: string;
  commanderMessage: string;
  plan: WorkbenchStep[];
  agents: WorkbenchAgent[];
  logs: WorkbenchLogEntry[];
  documents?: WorkbenchDocument[];
  commands?: WorkbenchCommand[];
  sources?: WorkbenchSource[];
  verificationSummary?: string;
}

export interface JavisWorkbenchProps {
  task: WorkbenchTask;
  draftGoal: string;
  onDraftGoalChange: (nextGoal: string) => void;
  onSubmitGoal: () => void;
}

export function JavisWorkbench({
  task,
  draftGoal,
  onDraftGoalChange,
  onSubmitGoal,
}: JavisWorkbenchProps) {
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmitGoal();
  }

  return (
    <div className="javis-shell">
      <aside className="javis-sidebar">
        <div className="javis-brand">
          <span className="javis-brand-mark">J</span>
          <span>Javis</span>
        </div>
        <nav className="javis-nav" aria-label="Workspace navigation">
          <div className="javis-nav-item active">Current task</div>
          <div className="javis-nav-item">Projects</div>
          <div className="javis-nav-item">History</div>
          <div className="javis-nav-item">Models</div>
          <div className="javis-nav-item">Settings</div>
        </nav>
      </aside>

      <main className="javis-main">
        <header className="javis-thread-header">
          <div>
            <p className="javis-eyebrow">Main Thread</p>
            <h1 className="javis-title">{task.title}</h1>
          </div>
          <span className="javis-task-status">{task.status}</span>
        </header>

        <section className="javis-thread" aria-label="Task thread">
          <article className="javis-message user">
            <p className="javis-message-title">User</p>
            <p className="javis-message-body">{task.userGoal}</p>
          </article>
          <article className="javis-message">
            <p className="javis-message-title">Commander</p>
            <p className="javis-message-body">{task.commanderMessage}</p>
          </article>

          {task.plan.length > 0 ? (
            <section className="javis-plan" aria-label="Task plan">
              <p className="javis-message-title">Plan</p>
              {task.plan.map((step) => (
                <div className="javis-plan-step" key={step.id}>
                  <span className="javis-status">{step.status}</span>
                  <div>
                    <strong>{step.title}</strong>
                    {step.successCriteria ? <p>{step.successCriteria}</p> : null}
                  </div>
                </div>
              ))}
            </section>
          ) : null}

          {task.documents && task.documents.length > 0 ? (
            <section className="javis-documents" aria-label="Scanned documents">
              <p className="javis-message-title">Markdown Documents</p>
              {task.documents.map((document) => (
                <article className="javis-document" key={document.path}>
                  <div className="javis-document-row">
                    <strong>{document.path}</strong>
                    <span>{formatSize(document.sizeBytes)}</span>
                  </div>
                  <p>{document.purpose}</p>
                  {document.excerpt ? <p>{document.excerpt}</p> : null}
                  <span>modified: {formatModifiedTime(document.modifiedAt)}</span>
                </article>
              ))}
            </section>
          ) : null}

          {task.commands && task.commands.length > 0 ? (
            <section className="javis-documents" aria-label="Command results">
              <p className="javis-message-title">Read-only Commands</p>
              {task.commands.map((command) => (
                <article className="javis-document" key={command.command}>
                  <div className="javis-document-row">
                    <strong>{command.command}</strong>
                    <span>exit: {command.exitCode ?? "unknown"}</span>
                  </div>
                  <p>{command.stdout || command.stderr || "(empty output)"}</p>
                  <span>cwd: {command.cwd}</span>
                </article>
              ))}
            </section>
          ) : null}

          {task.sources && task.sources.length > 0 ? (
            <section className="javis-documents" aria-label="Research sources">
              <p className="javis-message-title">Research Sources</p>
              {task.sources.map((source) => (
                <article className="javis-document" key={source.url}>
                  <div className="javis-document-row">
                    <strong>{source.title || source.url}</strong>
                    <span>{formatModifiedTime(source.fetchedAt)}</span>
                  </div>
                  <p>{source.excerpt}</p>
                  <span>{source.url}</span>
                </article>
              ))}
            </section>
          ) : null}

          {task.verificationSummary ? (
            <article className="javis-message">
              <p className="javis-message-title">Verifier</p>
              <p className="javis-message-body">{task.verificationSummary}</p>
            </article>
          ) : null}
        </section>

        <form className="javis-composer" onSubmit={handleSubmit}>
          <textarea
            aria-label="Task input"
            onChange={(event) => onDraftGoalChange(event.currentTarget.value)}
            placeholder="Ask Javis to do something..."
            value={draftGoal}
          />
          <button type="submit">Send</button>
        </form>
      </main>

      <aside className="javis-inspector">
        <header className="javis-inspector-header">
          <p className="javis-eyebrow">Agent / Context Inspector</p>
          <h2 className="javis-title">Agent graph</h2>
        </header>
        <section className="javis-agent-list" aria-label="Agent states">
          {task.agents.map((agent) => (
            <article className="javis-agent" key={agent.id}>
              <div className="javis-agent-row">
                <span className="javis-agent-name">{agent.name}</span>
                <span className="javis-status">{agent.status}</span>
              </div>
              <p className="javis-agent-task">{agent.role}</p>
              <p className="javis-agent-task">{agent.task}</p>
            </article>
          ))}
        </section>
      </aside>

      <section className="javis-activity" aria-label="Activity log">
        <header className="javis-activity-header">
          <p className="javis-eyebrow">Activity / Logs / Confirmations</p>
          <h2 className="javis-title">Execution timeline</h2>
        </header>
        <div className="javis-activity-list">
          {task.logs.map((log) => (
            <article className="javis-log" key={log.id}>
              <div className="javis-log-row">
                <strong>{log.title}</strong>
                <span className="javis-log-kind">{log.kind}</span>
              </div>
              <p className="javis-log-detail">{log.detail}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function formatSize(sizeBytes: number) {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatModifiedTime(modifiedAt: string) {
  const date = new Date(modifiedAt);
  if (!Number.isNaN(date.getTime())) {
    return date.toLocaleString();
  }

  const seconds = Number(modifiedAt);
  if (!Number.isFinite(seconds)) {
    return modifiedAt;
  }
  return new Date(seconds * 1000).toLocaleString();
}
