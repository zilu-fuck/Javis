import type { WorkbenchModelConfiguration, WorkbenchTask } from "../types";

interface ContextRingProps {
  task: WorkbenchTask;
  modelConfiguration?: WorkbenchModelConfiguration;
}

const MODEL_MAX_TOKENS: Record<string, number> = {
  "deepseek-v4-pro": 1_000_000,
  "deepseek-v4-flash": 128_000,
  deepseek: 1_000_000,
  "deepseek-chat": 1_000_000,
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4.1": 1_000_000,
  "gpt-4.1-mini": 1_000_000,
  "gpt-4.1-nano": 1_000_000,
  "claude-opus-4-7": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5": 200_000,
};

const DEFAULT_MAX_TOKENS = 128_000;

function resolveMaxTokens(modelConfiguration?: WorkbenchModelConfiguration): number {
  const primary = modelConfiguration?.profiles.find((p) => p.slot === "primary");
  if (!primary?.model) return DEFAULT_MAX_TOKENS;
  const modelLower = primary.model.toLowerCase();
  for (const [key, limit] of Object.entries(MODEL_MAX_TOKENS)) {
    if (modelLower.includes(key)) return limit;
  }
  return DEFAULT_MAX_TOKENS;
}

const R = 28;
const C = 2 * Math.PI * R;

export function ContextRing({ task, modelConfiguration }: ContextRingProps) {
  const maxTokens = resolveMaxTokens(modelConfiguration);
  const usedTokens = task.tokenUsage?.totalTokens ?? 0;
  const ratio = maxTokens > 0 ? Math.min(usedTokens / maxTokens, 1) : 0;
  const pct = Math.round(ratio * 100);
  const dashOffset = C * (1 - ratio);

  const color =
    ratio > 0.6 ? "var(--color-danger, #c8463b)"
    : ratio > 0.3 ? "var(--color-amber, #b77a19)"
    : "var(--color-accent, #2d6f67)";

  const trackColor = "var(--color-line, #dce2dc)";
  const label = usedTokens > 0 ? `${pct}%` : "—";

  return (
    <div className="javis-context-ring" aria-label={`Context: ${pct}%`}>
      <svg width="64" height="64" viewBox="0 0 64 64">
        <circle
          cx="32" cy="32" r={R}
          fill="none"
          stroke={trackColor}
          strokeWidth="4"
        />
        <circle
          cx="32" cy="32" r={R}
          fill="none"
          stroke={color}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={dashOffset}
          transform="rotate(-90 32 32)"
          style={{ transition: "stroke-dashoffset 0.5s ease, stroke 0.5s ease" }}
        />
        <text
          x="32" y="34"
          textAnchor="middle"
          dominantBaseline="middle"
          fill="var(--color-ink, #161817)"
          fontSize="13"
          fontWeight="650"
        >
          {label}
        </text>
      </svg>
      <div className="javis-context-ring-detail">
        <span className="javis-context-ring-tokens">
          {(usedTokens / 1000).toFixed(0)}K / {(maxTokens / 1000).toFixed(0)}K
        </span>
        {task.tokenUsage && task.tokenUsage.modelCalls > 0 ? (
          <span className="javis-context-ring-calls">
            {task.tokenUsage.modelCalls} call{task.tokenUsage.modelCalls !== 1 ? "s" : ""}
          </span>
        ) : null}
      </div>
    </div>
  );
}
