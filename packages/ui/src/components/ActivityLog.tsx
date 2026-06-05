import {
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { WorkbenchLocale, WorkbenchPermissionDecision, WorkbenchTask } from "../types";
import { translateWorkbenchText } from "../utils";

interface ActivityLogProps {
  activityCount: number;
  isActivityOpen: boolean;
  labels: WorkbenchLocale["labels"];
  locale: WorkbenchLocale;
  task: WorkbenchTask;
  onPermissionDecision?: (decision: WorkbenchPermissionDecision) => void;
  onAskUserAnswer?: (answer: string) => void;
  onResizeKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onResizeStart?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onToggle: () => void;
  resizeMax?: number;
  resizeMin?: number;
  resizeValue?: number;
}

export function ActivityLog({
  activityCount,
  isActivityOpen,
  labels,
  locale,
  task,
  onPermissionDecision,
  onAskUserAnswer,
  onResizeKeyDown,
  onResizeStart,
  onToggle,
  resizeMax,
  resizeMin,
  resizeValue,
}: ActivityLogProps) {
  const [activeTab, setActiveTab] = useState<"activity" | "timeline">("activity");
  const [levelFilter, setLevelFilter] = useState<"all" | "running" | "completed" | "waiting" | "failed">("all");
  const [isCleared, setIsCleared] = useState(false);
  const rows = isCleared ? [] : buildLogRows(task, locale, labels, onPermissionDecision, onAskUserAnswer);
  const visibleRows = rows.filter((row) => levelFilter === "all" || row.status === levelFilter);

  return (
    <section className="javis-activity" aria-label={labels.activityLog}>
      {isActivityOpen ? (
        <div
          aria-label="调整底部日志高度"
          aria-orientation="horizontal"
          aria-valuemax={resizeMax}
          aria-valuemin={resizeMin}
          aria-valuenow={resizeValue}
          className="javis-activity-resize-handle"
          onKeyDown={onResizeKeyDown}
          onPointerDown={onResizeStart}
          role="separator"
          tabIndex={0}
          title="拖拽调整底部日志高度"
        />
      ) : null}
      <div className="javis-activity-bar">
        <button
          aria-controls="javis-activity-panel"
          aria-expanded={isActivityOpen}
          className={`javis-activity-toggle ${activeTab === "activity" ? "active" : ""}`}
          onClick={() => {
            setActiveTab("activity");
            if (!isActivityOpen) onToggle();
          }}
          type="button"
        >
          <span>{labels.activityLog}</span>
          <span className="javis-activity-count">{activityCount}</span>
          <span>{isActivityOpen ? labels.collapseActivityLog : labels.expandActivityLog}</span>
        </button>
        <button
          className={`javis-activity-tab ${activeTab === "timeline" ? "active" : ""}`}
          onClick={() => {
            setActiveTab("timeline");
            if (!isActivityOpen) onToggle();
          }}
          type="button"
        >
          {labels.executionTimeline}
        </button>
        <div className="javis-activity-tools">
          <select
            aria-label={labels.logLevelFilter}
            onChange={(event) => setLevelFilter(event.currentTarget.value as typeof levelFilter)}
            value={levelFilter}
          >
            <option value="all">{labels.allLevels}</option>
            <option value="running">{labels.running}</option>
            <option value="completed">{labels.completed}</option>
            <option value="waiting">{labels.waiting}</option>
            <option value="failed">{labels.failed}</option>
          </select>
          <button title={labels.filterLogs} type="button">
            <span className="javis-log-tool-icon filter" aria-hidden="true" />
          </button>
          <button onClick={() => setIsCleared(true)} title={labels.clearLogs} type="button">
            <span className="javis-log-tool-icon clear" aria-hidden="true" />
          </button>
        </div>
      </div>
      {isActivityOpen ? (
        <div className="javis-activity-panel" id="javis-activity-panel">
          <header className="javis-activity-header">
            <p className="javis-eyebrow">{labels.activityLog}</p>
            <h2 className="javis-title">{labels.executionTimeline}</h2>
          </header>
          <div className="javis-activity-list">
            {visibleRows.map((row) => (
              <article className={`javis-log status-${row.status}${row.writeRiskLevel ? ` risk-${row.writeRiskLevel}` : ""}`} key={row.id}>
                <span className="javis-log-time">{row.time}</span>
                <span className="javis-log-agent">{row.agent}</span>
                <span className="javis-log-kind">{row.statusLabel}</span>
                <p className="javis-log-detail">{row.message}</p>
                {row.actions}
              </article>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

interface ActivityRow {
  id: string;
  time: string;
  agent: string;
  status: "running" | "completed" | "waiting" | "failed" | "idle";
  statusLabel: string;
  message: string;
  actions?: ReactNode;
  /** Risk classification for confirmed_write permission cards. */
  writeRiskLevel?: "safe" | "risky" | "dangerous";
}

function buildLogRows(
  task: WorkbenchTask,
  locale: WorkbenchLocale,
  labels: WorkbenchLocale["labels"],
  onPermissionDecision?: (decision: WorkbenchPermissionDecision) => void,
  onAskUserAnswer?: (answer: string) => void,
): ActivityRow[] {
  const rows: ActivityRow[] = [];

  if (task.permissionRequest) {
    const risk = task.permissionRequest.writeRiskLevel;
    rows.push({
      id: `permission-${task.permissionRequest.id}`,
      time: formatTime(),
      agent: labels.commander,
      status: normalizeLogStatus(task.permissionRequest.status),
      statusLabel: risk
        ? `${translateWorkbenchText(task.permissionRequest.status, locale)} · ${riskLabel(risk)}`
        : translateWorkbenchText(task.permissionRequest.status, locale),
      message: permissionLogDetail(task, locale),
      writeRiskLevel: risk,
      actions: (
        <div className="javis-confirmation-actions compact">
          <button
            disabled={task.permissionRequest.status !== "pending"}
            onClick={() => onPermissionDecision?.("approved")}
            type="button"
          >
            {labels.approve}
          </button>
          {isComputerPermission(task) ? (
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
        </div>
      ),
    });
  }

  if (task.askUserQuestion) {
    rows.push({
      id: `ask-${task.askUserQuestion.id}`,
      time: formatTime(),
      agent: labels.commander,
      status: normalizeLogStatus(task.askUserQuestion.status),
      statusLabel: translateWorkbenchText(task.askUserQuestion.status, locale),
      message: translateWorkbenchText(task.askUserQuestion.question, locale),
      actions: task.askUserQuestion.choices && task.askUserQuestion.choices.length > 0 ? (
        <div className="javis-confirmation-actions compact">
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
      ) : task.askUserQuestion.status === "pending" ? (
        <AskUserCompactInput onSubmit={(answer) => onAskUserAnswer?.(answer)} labels={labels} />
      ) : undefined,
    });
  }

  task.logs.forEach((log, index) => {
    rows.push({
      id: log.id,
      time: formatSyntheticTime(index),
      agent: inferAgentName(log.title, labels.commander),
      status: normalizeLogStatus(`${log.kind} ${log.title} ${log.detail}`),
      statusLabel: translateWorkbenchText(log.kind, locale),
      message: translateWorkbenchText(log.detail, locale),
    });
  });

  return rows;
}

function riskLabel(level: "safe" | "risky" | "dangerous"): string {
  switch (level) {
    case "safe": return "🟢";
    case "risky": return "🟡";
    case "dangerous": return "🔴";
  }
}

function formatTime(): string {
  return new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatSyntheticTime(index: number): string {
  const seconds = Math.max(0, 20 - index);
  return `10:42:${String(seconds).padStart(2, "0")}`;
}

function inferAgentName(text: string, fallback: string): string {
  const lower = text.toLowerCase();
  if (lower.includes("file")) return "文件代理";
  if (lower.includes("code")) return "代码代理";
  if (lower.includes("research") || lower.includes("search")) return "研究代理";
  if (lower.includes("computer") || lower.includes("desktop")) return "电脑代理";
  if (lower.includes("command") || lower.includes("shell")) return "命令代理";
  return fallback;
}

function normalizeLogStatus(text: string): ActivityRow["status"] {
  const lower = text.toLowerCase();
  if (lower.includes("fail") || lower.includes("error") || lower.includes("denied")) return "failed";
  if (lower.includes("running") || lower.includes("stream")) return "running";
  if (lower.includes("pending") || lower.includes("waiting") || lower.includes("queued")) return "waiting";
  if (lower.includes("complete") || lower.includes("approved") || lower.includes("success")) return "completed";
  return "idle";
}

function AskUserCompactInput({
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
    <form className="javis-ask-user-input compact" onSubmit={handleSubmit}>
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

function permissionLogDetail(task: WorkbenchTask, locale: WorkbenchLocale): string {
  const request = task.permissionRequest;
  if (!request) return "";
  const isChinese = locale?.labels?.aiModeSettings === "AI 模式";
  if (request.dryRun.operation.startsWith("computer.")) {
    return isChinese
      ? `桌面操作「${request.dryRun.operation}」需要确认：${request.dryRun.riskSummary}`
      : `${request.dryRun.operation} requires ${request.level}: ${request.dryRun.riskSummary}`;
  }
  return isChinese
    ? `有 ${request.dryRun.affectedPaths.length} 个计划路径操作需要 ${request.level} 确认。`
    : `${request.dryRun.affectedPaths.length} planned path operation(s) require ${request.level}.`;
}

function isComputerPermission(task: WorkbenchTask): boolean {
  return Boolean(task.permissionRequest?.dryRun.operation.startsWith("computer."));
}
