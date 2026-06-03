interface ProgressBarProps {
  label: string;
  current?: number;
  total?: number;
  startedAt?: number;
  indeterminate?: boolean;
}

export function ProgressBar({
  label,
  current,
  total,
  startedAt,
  indeterminate = false,
}: ProgressBarProps) {
  const hasValue = !indeterminate && total != null && total > 0 && current != null;
  const safeCurrent = current ?? 0;
  const safeTotal = total ?? 0;
  const percent = hasValue
    ? Math.max(0, Math.min(100, (safeCurrent / safeTotal) * 100))
    : undefined;
  const etaText = hasValue && startedAt
    ? formatEta(startedAt, safeCurrent, safeTotal)
    : "";
  const percentText = hasValue ? `${Math.round(percent ?? 0)}%` : "";

  return (
    <div className="javis-progress" role="status" aria-label={label}>
      <div className="javis-progress-row">
        <span>{label}</span>
        {hasValue ? (
          <span className="javis-progress-count">
            {safeCurrent.toLocaleString()} / {safeTotal.toLocaleString()}
            {percentText ? ` | ${percentText}` : ""}
            {etaText ? ` | ${etaText}` : ""}
          </span>
        ) : null}
      </div>
      <div
        aria-valuemax={hasValue ? safeTotal : undefined}
        aria-valuemin={hasValue ? 0 : undefined}
        aria-valuenow={hasValue ? safeCurrent : undefined}
        className={`javis-progress-track ${indeterminate ? "indeterminate" : ""}`}
        role="progressbar"
      >
        <span
          className="javis-progress-fill"
          style={hasValue ? { width: `${percent}%` } : undefined}
        />
      </div>
    </div>
  );
}

function formatEta(startedAt: number, current: number, total: number): string {
  if (current <= 0 || total <= 0 || current >= total) {
    return current >= total ? "\u5b8c\u6210" : "\u4f30\u7b97\u4e2d";
  }
  const elapsedSeconds = Math.max(0, (Date.now() - startedAt) / 1000);
  if (elapsedSeconds < 0.5) {
    return "\u4f30\u7b97\u4e2d";
  }
  const secondsPerItem = elapsedSeconds / current;
  const remainingSeconds = Math.ceil(secondsPerItem * (total - current));
  if (!Number.isFinite(remainingSeconds) || remainingSeconds < 0) {
    return "\u4f30\u7b97\u4e2d";
  }
  if (remainingSeconds < 60) {
    return `\u7ea6 ${remainingSeconds} \u79d2`;
  }
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return seconds > 0 ? `\u7ea6 ${minutes} \u5206 ${seconds} \u79d2` : `\u7ea6 ${minutes} \u5206`;
}
