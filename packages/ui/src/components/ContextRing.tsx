import { useId, useState } from "react";
import type {
  WorkbenchLocale,
  WorkbenchModelConfiguration,
  WorkbenchTask,
} from "../types";
import {
  formatCompactTokenCount,
  translateWorkbenchText,
} from "../utils";

interface ContextRingProps {
  task: WorkbenchTask;
  labels: WorkbenchLocale["labels"];
  locale: WorkbenchLocale;
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

const R = 14;
const C = 2 * Math.PI * R;
type ContextPanelMode = "closed" | "basic" | "details";

export function ContextRing({
  task,
  labels,
  locale,
  modelConfiguration,
}: ContextRingProps) {
  const panelId = useId();
  const [panelMode, setPanelMode] = useState<ContextPanelMode>("closed");
  const maxTokens = resolveMaxTokens(modelConfiguration);
  const usedTokens = task.tokenUsage?.totalTokens ?? 0;
  const inputTokens = task.tokenUsage?.inputTokens ?? 0;
  const outputTokens = task.tokenUsage?.outputTokens ?? 0;
  const modelCalls = task.tokenUsage?.modelCalls ?? 0;
  const remainingTokens = Math.max(maxTokens - usedTokens, 0);
  const ratio = maxTokens > 0 ? Math.min(usedTokens / maxTokens, 1) : 0;
  const pct = Math.round(ratio * 100);
  const dashOffset = C * (1 - ratio);
  const summary = `${formatCompactTokenCount(usedTokens)} / ${formatCompactTokenCount(maxTokens)} (${pct}%)`;
  const meta = modelCalls > 0
    ? `${labels.contextRemaining} ${formatCompactTokenCount(remainingTokens)}`
    : labels.noModelCalls;
  const breakdown = task.tokenUsage?.byAgentKind ?? [];

  const color =
    ratio > 0.6 ? "var(--color-danger, #c8463b)"
    : ratio > 0.3 ? "var(--color-amber, #b77a19)"
    : "var(--color-accent, #2d6f67)";

  const trackColor = "var(--color-line, #dce2dc)";
  const label = usedTokens > 0 ? `${pct}%` : "0%";
  const isOpen = panelMode !== "closed";

  function handleToggle() {
    setPanelMode((current) => {
      if (current === "closed") return "basic";
      if (current === "basic") return "details";
      return "closed";
    });
  }

  return (
    <div className="javis-context-window">
      <button
        aria-controls={panelId}
        aria-expanded={isOpen}
        aria-label={`${labels.contextWindow}: ${summary}`}
        className="javis-context-window-trigger"
        onClick={handleToggle}
        title={`${labels.contextWindow}: ${summary}`}
        type="button"
      >
        <span className="javis-context-window-ring" aria-hidden="true">
          <svg width="40" height="40" viewBox="0 0 40 40">
            <circle
              cx="20"
              cy="20"
              r={R}
              fill="none"
              stroke={trackColor}
              strokeWidth="4"
            />
            <circle
              cx="20"
              cy="20"
              r={R}
              fill="none"
              stroke={color}
              strokeWidth="4"
              strokeLinecap="round"
              strokeDasharray={C}
              strokeDashoffset={dashOffset}
              transform="rotate(-90 20 20)"
              style={{ transition: "stroke-dashoffset 0.5s ease, stroke 0.5s ease" }}
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
      </button>

      {panelMode !== "closed" ? (
        <div
          aria-label={labels.contextBreakdown}
          className={`javis-context-window-panel ${panelMode}`}
          id={panelId}
        >
          {panelMode === "basic" ? (
            <>
              <div className="javis-context-window-basic-head">
                <span className="javis-context-window-title">{labels.contextWindow}</span>
                <strong className="javis-context-window-summary">{summary}</strong>
                <span className="javis-context-window-meta">{meta}</span>
              </div>
              <div className="javis-context-window-meter">
                <div className="javis-context-window-meter-row">
                  <span>{labels.contextUsed}</span>
                  <strong>{formatCompactTokenCount(usedTokens)}</strong>
                  <span>{labels.contextRemaining}</span>
                  <strong>{formatCompactTokenCount(remainingTokens)}</strong>
                </div>
                <div
                  className="javis-context-window-progress"
                  aria-hidden="true"
                >
                  <span
                    style={{
                      width: `${pct}%`,
                      background: color,
                    }}
                  />
                </div>
              </div>

              <div className="javis-context-window-grid">
                <div className="javis-context-window-stat">
                  <span>{labels.tokenInput}</span>
                  <strong>{formatCompactTokenCount(inputTokens)}</strong>
                </div>
                <div className="javis-context-window-stat">
                  <span>{labels.tokenOutput}</span>
                  <strong>{formatCompactTokenCount(outputTokens)}</strong>
                </div>
                <div className="javis-context-window-stat">
                  <span>{labels.tokenCalls}</span>
                  <strong>{modelCalls.toLocaleString()}</strong>
                </div>
              </div>
            </>
          ) : (
            <div className="javis-context-window-breakdown">
              <p className="javis-context-window-section-title">
                {labels.contextBreakdown}
              </p>
              {breakdown.length > 0 ? (
                breakdown.map((entry) => {
                  const share = totalShare(entry.totalTokens, usedTokens);
                  const agentLabel = formatAgentKindLabel(entry.agentKind, locale);
                  return (
                    <div
                      className="javis-context-window-agent"
                      key={entry.agentKind}
                    >
                      <div className="javis-context-window-agent-head">
                        <span>{agentLabel}</span>
                        <strong>{formatCompactTokenCount(entry.totalTokens)}</strong>
                      </div>
                      <div
                        className="javis-context-window-agent-bar"
                        aria-hidden="true"
                      >
                        <span
                          style={{
                            width: `${share}%`,
                            background: agentBarColor(entry.agentKind, color),
                          }}
                        />
                      </div>
                      <div className="javis-context-window-agent-meta">
                        {entry.modelCalls > 0 ? (
                          <span>
                            {entry.modelCalls.toLocaleString()} {labels.tokenCalls}
                          </span>
                        ) : null}
                        <span>{totalShareLabel(entry.totalTokens, usedTokens)}</span>
                      </div>
                    </div>
                  );
                })
              ) : (
                <p className="javis-context-window-empty">{labels.noModelCalls}</p>
              )}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function formatAgentKindLabel(agentKind: string, locale: WorkbenchLocale): string {
  switch (agentKind) {
    case "commander":
      return translateWorkbenchText("Commander", locale);
    case "file":
      return translateWorkbenchText("File Agent", locale);
    case "shell":
      return translateWorkbenchText("Shell Agent", locale);
    case "browser":
      return translateWorkbenchText("Browser Agent", locale);
    case "computer":
      return translateWorkbenchText("Computer Agent", locale);
    case "scheduler":
      return translateWorkbenchText("Scheduler Agent", locale);
    case "research":
      return translateWorkbenchText("Research Agent", locale);
    case "code":
      return translateWorkbenchText("Code Agent", locale);
    case "verifier":
      return translateWorkbenchText("Verifier", locale);
    case "chinese-reviewer":
      return translateWorkbenchText("Chinese Reviewer", locale);
    default:
      return translateWorkbenchText(
        agentKind
          .split("-")
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(" "),
        locale,
      );
  }
}

function totalShare(value: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return Math.max((value / total) * 100, value > 0 ? 4 : 0);
}

function totalShareLabel(value: number, total: number): string {
  if (total <= 0) {
    return "0%";
  }
  return `${Math.round((value / total) * 100)}%`;
}

function agentBarColor(agentKind: string, fallback: string): string {
  switch (agentKind) {
    case "commander":
      return "var(--color-accent-strong, #174f49)";
    case "verifier":
      return "var(--color-danger, #c8463b)";
    case "research":
      return "var(--color-blue, #3f6ea8)";
    case "code":
      return "var(--color-amber, #b77a19)";
    default:
      return fallback;
  }
}
