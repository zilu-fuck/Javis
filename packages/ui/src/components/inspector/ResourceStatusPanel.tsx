import type { WorkbenchLocale, WorkbenchSystemResources, WorkbenchTask } from "../../types";
import { isChineseLocale } from "../../utils";
import { formatMemoryMetric, formatMetricPercent, normalizeMetricPercent } from "./inspector-utils";

interface ResourceStatusPanelProps {
  locale: WorkbenchLocale;
  systemResources?: WorkbenchSystemResources;
  task: WorkbenchTask;
}

export function ResourceStatusPanel({ locale, systemResources, task }: ResourceStatusPanelProps) {
  const isChinese = isChineseLocale(locale);
  const completedCount = task.agents.filter((agent) => agent.status.toLowerCase().includes("complete")).length;
  const cpu = normalizeMetricPercent(systemResources?.cpuPercent);
  const memory = normalizeMetricPercent(systemResources?.memoryPercent);
  const wallTimeMs = task.executionTrace?.totalWallTimeMs;

  return (
    <section className="javis-agent-list" aria-label={isChinese ? "资源状态" : "Resource status"}>
      <article className="javis-agent-resource-card" aria-label={isChinese ? "资源使用" : "Resource usage"}>
        <div className="javis-agent-resource-header">
          <strong>{isChinese ? "资源使用" : "Resource usage"}</strong>
          <span>{completedCount}/{task.agents.length}</span>
        </div>
        <div className="javis-agent-resource-grid">
          <Metric label="CPU" value={formatMetricPercent(systemResources?.cpuPercent)} percent={cpu} />
          <Metric label={isChinese ? "内存" : "Memory"} value={formatMemoryMetric(systemResources)} percent={memory} />
        </div>
      </article>
      {task.tokenUsage ? (
        <TokenUsageCard isChinese={isChinese} tokenUsage={task.tokenUsage} />
      ) : null}
      <article className="javis-overview-card">
        <div className="javis-overview-card-header">
          <strong>{isChinese ? "运行摘要" : "Runtime summary"}</strong>
          <span>{task.status}</span>
        </div>
        <div className="javis-overview-stats">
          <StatRow label={isChinese ? "Agent 完成数" : "Agents done"} value={`${completedCount}/${task.agents.length}`} />
          <StatRow label={isChinese ? "日志条数" : "Log entries"} value={String(task.logs.length)} />
          {typeof wallTimeMs === "number" ? (
            <StatRow label={isChinese ? "总耗时" : "Wall time"} value={`${(wallTimeMs / 1000).toFixed(1)}s`} />
          ) : null}
        </div>
      </article>
    </section>
  );
}

function TokenUsageCard({
  isChinese,
  tokenUsage,
}: {
  isChinese: boolean;
  tokenUsage: NonNullable<WorkbenchTask["tokenUsage"]>;
}) {
  const byKind = tokenUsage.byAgentKind ?? [];

  return (
    <article className="javis-overview-card javis-token-usage-card">
      <div className="javis-overview-card-header">
        <strong>{isChinese ? "Token 用量" : "Token Usage"}</strong>
        <span>{tokenUsage.totalTokens}</span>
      </div>
      {byKind.length > 0 ? (
        <div className="javis-token-bars">
          {byKind.map((entry) => {
            const pct = tokenUsage.totalTokens > 0
              ? Math.round((entry.totalTokens / tokenUsage.totalTokens) * 100)
              : 0;
            return (
              <div className="javis-token-kind" key={entry.agentKind}>
                <span className="javis-token-label">{entry.agentKind}</span>
                <span className="javis-token-bar-bg">
                  <span className="javis-token-bar" style={{ width: `${Math.max(pct, 2)}%` }} />
                </span>
                <span className="javis-token-value">{entry.totalTokens}</span>
              </div>
            );
          })}
        </div>
      ) : null}
      <div className="javis-token-summary">
        <span>{isChinese ? "输入" : "In"}: {tokenUsage.inputTokens}</span>
        <span>{isChinese ? "输出" : "Out"}: {tokenUsage.outputTokens}</span>
        <span>{isChinese ? "调用" : "Calls"}: {tokenUsage.modelCalls}</span>
      </div>
    </article>
  );
}

function Metric({ label, value, percent }: { label: string; value: string; percent: number }) {
  return (
    <div className="javis-agent-resource-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <i aria-hidden="true"><span style={{ width: `${percent > 0 ? Math.max(4, percent) : 0}%` }} /></i>
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="javis-stat-row">
      <span className="javis-stat-label">{label}</span>
      <span className="javis-stat-value">{value}</span>
    </div>
  );
}
