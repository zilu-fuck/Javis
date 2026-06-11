import {
  useEffect,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { FixedSizeList, type ListChildComponentProps } from "react-window";
import type { WorkbenchLocale, WorkbenchPermissionDecision, WorkbenchTask } from "../types";
import { getTaskStatusLabel, translateWorkbenchText } from "../utils";

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

type LogFilter = "all" | "running" | "completed" | "waiting" | "failed";

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
  const [levelFilter, setLevelFilter] = useState<LogFilter>("all");
  const [showDevDetails, setShowDevDetails] = useState(false);
  const [isCleared, setIsCleared] = useState(false);
  void onPermissionDecision;
  void onAskUserAnswer;
  useEffect(() => {
    setIsCleared(false);
  }, [task.id]);
  const rows = isCleared ? [] : buildLogRows(task, locale, labels, showDevDetails);
  const visibleRows = rows.filter((row) => levelFilter === "all" || row.status === levelFilter);
  const isChinese = locale.labels.newChat !== "New chat";

  return (
    <section className="javis-activity" aria-label={labels.activityLog}>
      {isActivityOpen ? (
        <div
          aria-label={isChinese ? "调整底部日志高度" : "Resize bottom activity log"}
          aria-orientation="horizontal"
          aria-valuemax={resizeMax}
          aria-valuemin={resizeMin}
          aria-valuenow={resizeValue}
          className="javis-activity-resize-handle"
          onKeyDown={onResizeKeyDown}
          onPointerDown={onResizeStart}
          role="separator"
          tabIndex={0}
          title={isChinese ? "拖动调整底部日志高度" : "Drag to resize the bottom activity log"}
        />
      ) : null}
      <div className="javis-activity-bar">
        <button
          aria-controls="javis-activity-panel"
          aria-expanded={isActivityOpen}
          className="javis-activity-toggle"
          onClick={() => {
            if (!isActivityOpen) onToggle();
          }}
          type="button"
        >
          <span>{labels.activityLog}</span>
          <span className="javis-activity-count">{activityCount}</span>
          <span>{isActivityOpen ? labels.collapseActivityLog : labels.expandActivityLog}</span>
        </button>
        <div className="javis-activity-tools">
          <select
            aria-label={labels.logLevelFilter}
            onChange={(event) => setLevelFilter(event.currentTarget.value as LogFilter)}
            value={levelFilter}
          >
            <option value="all">{labels.allLevels}</option>
            <option value="running">{labels.running}</option>
            <option value="completed">{labels.completed}</option>
            <option value="waiting">{labels.waiting}</option>
            <option value="failed">{labels.failed}</option>
          </select>
          <button aria-label={labels.filterLogs} title={labels.filterLogs} type="button">
            <span className="javis-log-tool-icon filter" aria-hidden="true" />
          </button>
          <button
            aria-pressed={showDevDetails}
            aria-label={showDevDetails ? labels.hideProcessDetails : labels.showProcessDetails}
            onClick={() => setShowDevDetails((value) => !value)}
            title={showDevDetails ? labels.hideProcessDetails : labels.showProcessDetails}
            type="button"
          >
            <span className="javis-log-tool-icon process" aria-hidden="true" />
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
            <h2 className="javis-title">{labels.activityLog}</h2>
          </header>
          <VirtualActivityRows resizeValue={resizeValue} rows={visibleRows} />
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
  fullTime: string;
  writeRiskLevel?: "safe" | "risky" | "dangerous";
}

function VirtualActivityRows({ resizeValue, rows }: { resizeValue?: number; rows: ActivityRow[] }) {
  if (rows.length === 0) {
    return <div className="javis-activity-list empty" />;
  }

  if (rows.length <= 100) {
    return (
      <div className="javis-activity-list">
        {rows.map((row) => (
          <ActivityRowItem key={row.id} row={row} />
        ))}
      </div>
    );
  }

  const listHeight = Math.max(56, (resizeValue ?? 188) - 46);

  return (
    <div className="javis-activity-list virtual">
      <FixedSizeList
        height={Math.min(listHeight, Math.max(56, rows.length * 46))}
        itemCount={rows.length}
        itemData={rows}
        itemKey={(index, data) => data[index].id}
        itemSize={46}
        width="100%"
      >
        {ActivityRowRenderer}
      </FixedSizeList>
    </div>
  );
}

function ActivityRowRenderer({ index, style, data }: ListChildComponentProps<ActivityRow[]>) {
  const row = data[index];
  return <ActivityRowItem row={row} style={style} />;
}

function ActivityRowItem({ row, style }: { row: ActivityRow; style?: CSSProperties }) {
  return (
    <article
      className={`javis-log status-${row.status}${row.writeRiskLevel ? ` risk-${row.writeRiskLevel}` : ""}`}
      style={style}
    >
      <span className="javis-log-time" title={row.fullTime}>{row.time}</span>
      <span className="javis-log-agent">{row.agent}</span>
      <span className="javis-log-kind">{row.statusLabel}</span>
      <p className="javis-log-detail">{row.message}</p>
    </article>
  );
}

function buildLogRows(
  task: WorkbenchTask,
  locale: WorkbenchLocale,
  labels: WorkbenchLocale["labels"],
  showDevDetails: boolean,
): ActivityRow[] {
  const rows: ActivityRow[] = [];

  if (task.permissionRequest) {
    const risk = task.permissionRequest.writeRiskLevel;
    rows.push({
      id: `permission-${task.permissionRequest.id}`,
      ...formatLogTime(task.updatedAt),
      agent: labels.commander,
      status: normalizeLogStatus(task.permissionRequest.status),
      statusLabel: risk
        ? `${getTaskStatusLabel(task.permissionRequest.status, locale)} · ${riskLabel(risk)}`
        : getTaskStatusLabel(task.permissionRequest.status, locale),
      message: permissionLogDetail(task, locale),
      writeRiskLevel: risk,
    });
  }

  if (task.askUserQuestion) {
    rows.push({
      id: `ask-${task.askUserQuestion.id}`,
      ...formatLogTime(task.updatedAt),
      agent: labels.commander,
      status: normalizeLogStatus(task.askUserQuestion.status),
      statusLabel: getTaskStatusLabel(task.askUserQuestion.status, locale),
      message: translateWorkbenchText(task.askUserQuestion.question, locale),
    });
  }

  task.logs.forEach((log, index) => {
    const message = showDevDetails
      ? log.devDetail ?? log.detail
      : log.userMessage ?? log.detail;
    if (!showDevDetails && !message.trim()) {
      return;
    }
    rows.push({
      id: log.id,
      ...formatLogTime(log.createdAt ?? task.updatedAt, index),
      agent: inferAgentName(log.agentId ?? log.title, labels.commander),
      status: normalizeLogStatus(`${log.kind} ${log.title} ${log.detail}`),
      statusLabel: translateWorkbenchText(log.kind, locale),
      message: translateWorkbenchText(message, locale),
    });
  });

  return rows;
}

function riskLabel(level: "safe" | "risky" | "dangerous"): string {
  switch (level) {
    case "safe": return "safe";
    case "risky": return "risky";
    case "dangerous": return "dangerous";
  }
}

function formatLogTime(timestamp?: string, fallbackIndex = 0): { time: string; fullTime: string } {
  const parsed = timestamp ? new Date(timestamp) : undefined;
  const date = parsed && !Number.isNaN(parsed.getTime())
    ? parsed
    : new Date(Date.now() - fallbackIndex * 1000);
  return {
    time: date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    fullTime: date.toLocaleString(),
  };
}

function inferAgentName(text: string, fallback: string): string {
  const lower = text.toLowerCase();
  if (lower.includes("commander")) return fallback;
  if (lower.includes("file")) return "File Agent";
  if (lower.includes("code")) return "Code Agent";
  if (lower.includes("research") || lower.includes("search")) return "Research Agent";
  if (lower.includes("computer") || lower.includes("desktop")) return "Computer Agent";
  if (lower.includes("command") || lower.includes("shell")) return "Shell Agent";
  if (lower.includes("browser")) return "Browser Agent";
  if (lower.includes("scheduler")) return "Scheduler Agent";
  if (lower.includes("verifier")) return "Verifier Agent";
  if (lower.includes("vision")) return "Vision Agent";
  if (lower.includes("workspace")) return "Workspace Agent";
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

function permissionLogDetail(task: WorkbenchTask, locale: WorkbenchLocale): string {
  const request = task.permissionRequest;
  if (!request) return "";
  const isChinese = locale.labels.newChat !== "New chat";
  if (request.dryRun.operation.startsWith("computer.")) {
    return isChinese
      ? `桌面操作「${request.dryRun.operation}」需要确认：${request.dryRun.riskSummary}`
      : `${request.dryRun.operation} requires ${request.level}: ${request.dryRun.riskSummary}`;
  }
  return isChinese
    ? `有 ${request.dryRun.affectedPaths.length} 个计划路径操作需要 ${request.level} 确认。`
    : `${request.dryRun.affectedPaths.length} planned path operation(s) require ${request.level}.`;
}
