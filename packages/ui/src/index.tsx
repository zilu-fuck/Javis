export interface WorkbenchAgent {
  id: string;
  name: string;
  role: string;
  status: string;
  task: string;
}

export interface WorkbenchLogEntry {
  id: string;
  kind: string;
  title: string;
  detail: string;
}

export interface WorkbenchTask {
  title: string;
  userGoal: string;
  commanderMessage: string;
  agents: WorkbenchAgent[];
  logs: WorkbenchLogEntry[];
}

export interface JavisWorkbenchProps {
  task: WorkbenchTask;
}

export function JavisWorkbench({ task }: JavisWorkbenchProps) {
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
          <p className="javis-eyebrow">Main Thread</p>
          <h1 className="javis-title">{task.title}</h1>
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
        </section>

        <form className="javis-composer">
          <textarea aria-label="Task input" placeholder="Ask Javis to do something..." />
          <button type="button">Send</button>
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

