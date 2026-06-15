import type { WorkbenchLocale, WorkbenchTask } from "../types";
import { getTaskStatusLabel, getTaskStatusProgress } from "../utils";

interface TaskProgressRingProps {
  task: WorkbenchTask;
  locale: WorkbenchLocale;
}

const R = 14;
const C = 2 * Math.PI * R;

export function TaskProgressRing({ task, locale }: TaskProgressRingProps) {
  const progress = getTaskStatusProgress(task.status);
  const ratio = Math.max(0, Math.min(progress / 100, 1));
  const dashOffset = C * (1 - ratio);
  const label = `${progress}%`;
  const statusLabel = getTaskStatusLabel(task.status, locale);

  return (
    <div className="javis-task-progress-ring" aria-label={`${statusLabel}: ${label}`} role="status">
      <span className="javis-task-progress-ring-track" aria-hidden="true">
        <svg width="40" height="40" viewBox="0 0 40 40">
          <circle
            cx="20"
            cy="20"
            r={R}
            fill="none"
            stroke="var(--color-line, #dce2dc)"
            strokeWidth="4"
          />
          <circle
            cx="20"
            cy="20"
            r={R}
            fill="none"
            stroke="var(--color-accent, #2d6f67)"
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={dashOffset}
            transform="rotate(-90 20 20)"
            style={{ transition: "stroke-dashoffset 0.5s ease" }}
          />
          <text
            x="20"
            y="22"
            textAnchor="middle"
            dominantBaseline="middle"
            fill="var(--color-ink, #161817)"
            fontSize="11"
            fontWeight="650"
          >
            {label}
          </text>
        </svg>
      </span>
    </div>
  );
}
