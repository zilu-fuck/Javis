import type {
  WorkbenchLocale,
  WorkbenchTaskProgress,
  WorkbenchTaskProgressItemStatus,
  WorkbenchTaskProgressStatus,
} from "../types";
import { isChineseLocale, translateWorkbenchText } from "../utils";
import "./TaskProgressCard.css";

interface TaskProgressCardProps {
  locale: WorkbenchLocale;
  progress: WorkbenchTaskProgress;
}

export function TaskProgressCard({ locale, progress }: TaskProgressCardProps) {
  const isChinese = isChineseLocale(locale);
  const completedItems = clamp(progress.completedItems, 0, Math.max(0, progress.totalItems));
  const progressPercent = progress.totalItems > 0
    ? Math.round((completedItems / progress.totalItems) * 100)
    : 0;
  const statusLabel = getProgressStatusLabel(progress.status, isChinese);
  const title = translateWorkbenchText(progress.title, locale);

  return (
    <section
      aria-label={`${title}: ${statusLabel}`}
      aria-live="polite"
      className={`javis-user-task-progress status-${progress.status}`}
    >
      <header className="javis-user-task-progress-header">
        <div>
          <strong>{title}</strong>
          <span className={`javis-user-task-progress-status status-${progress.status}`}>
            {statusLabel}
          </span>
        </div>
        <span className="javis-user-task-progress-count">
          {completedItems}/{Math.max(0, progress.totalItems)} {isChinese ? "完成" : "complete"}
        </span>
      </header>

      <div
        aria-label={isChinese ? "任务完成度" : "Task completion"}
        aria-valuemax={Math.max(0, progress.totalItems)}
        aria-valuemin={0}
        aria-valuenow={completedItems}
        className="javis-user-task-progress-track"
        role="progressbar"
      >
        <span style={{ width: `${progressPercent}%` }} />
      </div>

      <ul className="javis-user-task-progress-items">
        {progress.items.map((item) => (
          <li className={`status-${item.status}`} key={item.id}>
            <span className="javis-user-task-progress-item-icon" aria-hidden="true" />
            <div className="javis-user-task-progress-item-content">
              <div className="javis-user-task-progress-item-line">
                <strong>{translateWorkbenchText(item.label, locale)}</strong>
                {formatItemCount(item.completedCount, item.expectedCount) ? (
                  <span className="javis-user-task-progress-item-count">
                    {formatItemCount(item.completedCount, item.expectedCount)}
                  </span>
                ) : null}
              </div>
              {item.detail ? (
                <p>{translateWorkbenchText(item.detail, locale)}</p>
              ) : null}
            </div>
            <div className="javis-user-task-progress-item-meta">
              <span>{getItemStatusLabel(item.status, isChinese)}</span>
              {isSafeSourceUrl(item.sourceUrl) ? (
                <a href={item.sourceUrl} rel="noreferrer" target="_blank">
                  {isChinese ? "查看来源" : "View source"}
                </a>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      {progress.currentAction ? (
        <footer className="javis-user-task-progress-current">
          <span>{isChinese ? "当前" : "Now"}</span>
          <p>{translateWorkbenchText(progress.currentAction, locale)}</p>
        </footer>
      ) : null}
    </section>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatItemCount(completedCount?: number, expectedCount?: number): string | undefined {
  if (typeof completedCount !== "number" || typeof expectedCount !== "number") {
    return undefined;
  }
  return `${Math.max(0, completedCount)}/${Math.max(0, expectedCount)}`;
}

function getProgressStatusLabel(status: WorkbenchTaskProgressStatus, isChinese: boolean): string {
  const labels: Record<WorkbenchTaskProgressStatus, readonly [string, string]> = {
    running: ["进行中", "In progress"],
    completed: ["已完成", "Completed"],
    completed_with_warnings: ["部分完成", "Completed with warnings"],
    failed: ["失败", "Failed"],
  };
  return labels[status][isChinese ? 0 : 1];
}

function getItemStatusLabel(status: WorkbenchTaskProgressItemStatus, isChinese: boolean): string {
  const labels: Record<WorkbenchTaskProgressItemStatus, readonly [string, string]> = {
    queued: ["等待中", "Queued"],
    running: ["采集中", "Collecting"],
    verifying: ["验证中", "Verifying"],
    completed: ["已验证", "Verified"],
    blocked: ["来源受限", "Source blocked"],
    failed: ["获取失败", "Failed"],
  };
  return labels[status][isChinese ? 0 : 1];
}

function isSafeSourceUrl(url?: string): url is string {
  if (!url) {
    return false;
  }
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
