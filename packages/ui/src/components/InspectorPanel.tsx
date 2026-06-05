import { useEffect, useState } from "react";
import type {
  BrowserQuickResult,
  ReviewQuickResult,
  TerminalQuickResult,
  WorkbenchAgentSessionContext,
  WorkbenchAgent,
  WorkbenchDetailItem,
  WorkbenchFileService,
  WorkbenchFileEntry,
  WorkbenchLocale,
  WorkbenchSystemResources,
  WorkbenchTask,
  WorkbenchTerminalService,
  WorkbenchWorkspaceToolTab,
  WorkbenchWorkspaceToolAction,
} from "../types";
import { isChineseLocale, translateWorkbenchText } from "../utils";
import { AgentDetailSections } from "./AgentDetailSections";
import { WorkspaceToolPanels } from "./WorkspaceToolPanels";

interface InspectorPanelProps {
  detailItem?: WorkbenchDetailItem | null;
  isInspectorOpen: boolean;
  labels: WorkbenchLocale["labels"];
  locale: WorkbenchLocale;
  selectedAgentId?: string;
  systemResources?: WorkbenchSystemResources;
  openTabs?: WorkbenchWorkspaceToolTab[];
  activeToolTabId?: string;
  task: WorkbenchTask;
  onToggle: () => void;
  onQuickAction?: (action: WorkbenchWorkspaceToolAction) => void;
  onSelectAgent?: (agentId: string) => void;
  onCloseToolTab?: (tabId: string) => void;
  onSelectToolTab?: (tabId: string) => void;
  onNewToolTab?: (tool: WorkbenchWorkspaceToolAction) => void;
  onQuickActionBrowser?: (url: string) => Promise<BrowserQuickResult>;
  onQuickActionReview?: () => Promise<ReviewQuickResult>;
  onQuickActionTerminal?: (command: string) => Promise<TerminalQuickResult>;
  session: WorkbenchAgentSessionContext;
  terminalService?: WorkbenchTerminalService;
  fileService?: WorkbenchFileService;
  computerEntries?: WorkbenchFileEntry[];
  computerPath?: string;
  onNavigateDirectory?: (path: string) => void;
  onOpenFile?: (path: string) => void;
  onSideChatSend?: (message: string) => Promise<string>;
}

const TOOL_LABELS: Record<string, { zh: string; en: string }> = {
  files:    { zh: "文件", en: "Files" },
  sideChat: { zh: "侧边聊天", en: "Side Chat" },
  browser:  { zh: "浏览器", en: "Browser" },
  review:   { zh: "审查", en: "Review" },
  terminal: { zh: "终端", en: "Terminal" },
};

export function InspectorPanel({
  detailItem,
  isInspectorOpen,
  labels,
  locale,
  selectedAgentId,
  systemResources,
  openTabs = [],
  activeToolTabId,
  task,
  onToggle,
  onQuickAction,
  onSelectAgent,
  onCloseToolTab,
  onSelectToolTab,
  onNewToolTab,
  onQuickActionBrowser,
  onQuickActionReview,
  onQuickActionTerminal,
  session,
  terminalService,
  fileService,
  computerEntries = [],
  computerPath = "",
  onNavigateDirectory,
  onOpenFile,
  onSideChatSend,
}: InspectorPanelProps) {
  const [activeSection, setActiveSection] = useState<"agents" | "details">(
    openTabs.length > 0 || detailItem || selectedAgentId ? "details" : "agents",
  );
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const changedFiles = getReviewChangedFiles(task);
  const detailCount = detailItem ? 1 : changedFiles.length;
  const detailsLabel = isChineseLocale(locale) ? "详情" : "Details";

  // Reset tab index when tabs change
  useEffect(() => {
    if (openTabs.length === 0) {
      setActiveTabIndex(0);
    } else if (activeTabIndex >= openTabs.length) {
      setActiveTabIndex(openTabs.length - 1);
    }
  }, [openTabs.length, activeTabIndex]);

  useEffect(() => {
    if (detailItem) setActiveSection("details");
  }, [detailItem]);

  useEffect(() => {
    if (selectedAgentId) setActiveSection("details");
  }, [selectedAgentId]);

  // When new tabs open, switch to details
  useEffect(() => {
    if (openTabs.length > 0) setActiveSection("details");
  }, [openTabs.length]);

  function handleSectionToggle(section: "agents" | "details") {
    if (isInspectorOpen && activeSection === section) {
      onToggle();
      return;
    }
    setActiveSection(section);
    if (!isInspectorOpen) onToggle();
  }

  const activeTab = openTabs.find((tab) => tab.id === activeToolTabId) ?? openTabs[activeTabIndex] ?? openTabs[openTabs.length - 1] ?? null;
  const activeTool = activeTab?.tool ?? null;

  return (
    <aside className="javis-inspector" aria-label={labels.agentContextInspector}>
      <div className="javis-inspector-rail">
        <button
          aria-controls="javis-inspector-panel"
          aria-expanded={isInspectorOpen && activeSection === "agents"}
          className={`javis-inspector-toggle ${activeSection === "agents" ? "active" : ""}`}
          onClick={() => handleSectionToggle("agents")}
          type="button"
        >
          <span>{labels.agentGraph}</span>
          <span className="javis-activity-count">{task.agents.length}</span>
          <span>{isInspectorOpen && activeSection === "agents" ? labels.collapseInspector : labels.expandInspector}</span>
        </button>
        <button
          aria-controls="javis-inspector-panel"
          aria-expanded={isInspectorOpen && activeSection === "details"}
          className={`javis-inspector-toggle ${activeSection === "details" ? "active" : ""}`}
          onClick={() => handleSectionToggle("details")}
          type="button"
        >
          <span>{detailsLabel}</span>
          {detailCount > 0 ? <span className="javis-activity-count">{detailCount}</span> : null}
          <span>{isInspectorOpen && activeSection === "details" ? labels.collapseInspector : labels.expandInspector}</span>
        </button>
      </div>
      {isInspectorOpen ? (
        <div className="javis-inspector-panel" id="javis-inspector-panel">
          <header className="javis-inspector-header">
            <p className="javis-eyebrow">{labels.agentContextInspector}</p>
            <h2 className="javis-title">{activeSection === "details" ? detailsLabel : labels.agentGraph}</h2>
          </header>
          {activeSection === "details" ? (
            <section className="javis-inspector-details">
              {activeTool ? null : <InspectorQuickActions locale={locale} onQuickAction={onQuickAction} />}
              {/* Tab bar */}
              {openTabs.length > 0 ? (
                <div className="javis-tool-tab-bar" role="tablist">
                  {openTabs.map((tab, i) => {
                    const label = TOOL_LABELS[tab.tool] ?? { zh: tab.tool, en: tab.tool };
                    const isActive = tab.id === activeTab?.id;
                    return (
                      <button
                        key={tab.id}
                        className={`javis-tool-tab${isActive ? " active" : ""}`}
                        onClick={() => {
                          setActiveTabIndex(i);
                          onSelectToolTab?.(tab.id);
                        }}
                        role="tab"
                        aria-selected={isActive}
                        type="button"
                      >
                        <span>{tab.title ?? (isChineseLocale(locale) ? label.zh : label.en)}</span>
                        <span
                          className="javis-tool-tab-close"
                          onClick={(e) => {
                            e.stopPropagation();
                            onCloseToolTab?.(tab.id);
                          }}
                          aria-label={isChineseLocale(locale) ? "关闭" : "Close"}
                        >×</span>
                      </button>
                    );
                  })}
                  {activeTool ? (
                    <button
                      aria-label={isChineseLocale(locale) ? "新建标签页" : "New tab"}
                      className="javis-tool-tab-add"
                      onClick={() => onNewToolTab?.(activeTool)}
                      title={isChineseLocale(locale) ? "新建同类标签页" : "Open another tab"}
                      type="button"
                    >
                      +
                    </button>
                  ) : null}
                </div>
              ) : null}
              {/* Tool panel or default view */}
              {activeTool ? (
                <WorkspaceToolPanels
                  tool={activeTool}
                  session={{ ...session, activeTool }}
                  locale={locale}
                  labels={labels}
                  onClose={() => activeTab ? onCloseToolTab?.(activeTab.id) : undefined}
                  onQuickActionBrowser={onQuickActionBrowser}
                  onQuickActionReview={onQuickActionReview}
                  onQuickActionTerminal={onQuickActionTerminal}
                  terminalService={terminalService}
                  fileService={fileService}
                  computerEntries={computerEntries}
                  computerPath={computerPath}
                  onNavigateDirectory={onNavigateDirectory}
                  onOpenFile={onOpenFile}
                  onSideChatSend={onSideChatSend}
                />
              ) : selectedAgentId ? (
                <>
                  <SelectedAgentDetail
                    agent={task.agents.find((agent) => agent.id === selectedAgentId)}
                    locale={locale}
                  />
                  <AgentDetailSections labels={labels} locale={locale} task={task} />
                </>
              ) : (
                <TaskOverview task={task} locale={locale} labels={labels} />
              )}
              <DetailInspector
                detailItem={detailItem}
                labels={labels}
                locale={locale}
                task={task}
                changedFiles={changedFiles}
                detailsLabel={detailsLabel}
              />
            </section>
          ) : (
            <section className="javis-agent-list" aria-label={labels.agentStates}>
              <AgentResourceCard locale={locale} systemResources={systemResources} task={task} />
              {task.agents.map((agent) => (
                <button
                  className={`javis-agent status-${normalizeStatus(agent.status)}${selectedAgentId === agent.id ? " active" : ""}`}
                  key={agent.id}
                  onClick={() => {
                    onSelectAgent?.(agent.id);
                    setActiveSection("details");
                  }}
                  type="button"
                >
                  <div className="javis-agent-card-main">
                    <span className={`javis-agent-icon agent-${agentKind(agent)}`}>{agentIcon(agent)}</span>
                    <span className="javis-agent-name">
                      {translateWorkbenchText(agent.name, locale)}
                    </span>
                    <span className={`javis-agent-status status-${normalizeStatus(agent.status)}`}>
                      {agentStatusLabel(agent.status, locale)}
                    </span>
                  </div>
                  <p className="javis-agent-task">{translateWorkbenchText(agent.role, locale)}</p>
                  <p className="javis-agent-task">{translateWorkbenchText(agent.task, locale)}</p>
                  <div className="javis-agent-progress" aria-hidden="true">
                    <span style={{ width: `${agentProgress(agent.status)}%` }} />
                  </div>
                </button>
              ))}
            </section>
          )}
        </div>
      ) : null}
    </aside>
  );
}

// ── Quick Actions ────────────────────────────────────────────────────────

function InspectorQuickActions({
  locale,
  onQuickAction,
}: {
  locale: WorkbenchLocale;
  onQuickAction?: (action: WorkbenchWorkspaceToolAction) => void;
}) {
  const isChinese = isChineseLocale(locale);
  const items: Array<{
    id: WorkbenchWorkspaceToolAction;
    title: string;
    description: string;
    shortcut?: string;
  }> = isChinese
    ? [
        { id: "files", title: "文件", description: "浏览项目文件", shortcut: "Ctrl+P" },
        { id: "sideChat", title: "侧边聊天", description: "发起侧边对话" },
        { id: "browser", title: "浏览器", description: "打开网站", shortcut: "Ctrl+T" },
        { id: "review", title: "审查", description: "查看代码更改", shortcut: "Ctrl+Shift+G" },
        { id: "terminal", title: "终端", description: "启动交互式 shell", shortcut: "Ctrl+`" },
      ]
    : [
        { id: "files", title: "Files", description: "Browse project files", shortcut: "Ctrl+P" },
        { id: "sideChat", title: "Side chat", description: "Start a side conversation" },
        { id: "browser", title: "Browser", description: "Open a website", shortcut: "Ctrl+T" },
        { id: "review", title: "Review", description: "Inspect code changes", shortcut: "Ctrl+Shift+G" },
        { id: "terminal", title: "Terminal", description: "Start an interactive shell", shortcut: "Ctrl+`" },
      ];

  return (
    <section className="javis-inspector-quick-actions" aria-label={isChinese ? "工作区工具" : "Workspace tools"}>
      {items.map((item) => (
        <button
          className={`javis-inspector-quick-card action-${item.id}`}
          key={item.id}
          onClick={() => onQuickAction?.(item.id)}
          type="button"
        >
          <span className="javis-inspector-quick-icon" aria-hidden="true" />
          <strong>{item.title}</strong>
          <span>{item.description}</span>
          {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
        </button>
      ))}
    </section>
  );
}

// ── Selected Agent Detail ────────────────────────────────────────────────

function SelectedAgentDetail({ agent, locale }: { agent?: WorkbenchAgent; locale: WorkbenchLocale }) {
  if (!agent) return null;
  return (
    <section className="javis-selected-agent-detail" aria-label={translateWorkbenchText(agent.name, locale)}>
      <div className="javis-agent-card-main">
        <span className={`javis-agent-icon agent-${agentKind(agent)}`}>{agentIcon(agent)}</span>
        <span className="javis-agent-name">{translateWorkbenchText(agent.name, locale)}</span>
        <span className={`javis-agent-status status-${normalizeStatus(agent.status)}`}>
          {agentStatusLabel(agent.status, locale)}
        </span>
      </div>
      <p>{translateWorkbenchText(agent.role, locale)}</p>
      <p>{translateWorkbenchText(agent.task, locale)}</p>
      <div className="javis-agent-progress" aria-hidden="true">
        <span style={{ width: `${agentProgress(agent.status)}%` }} />
      </div>
    </section>
  );
}

// ── Agent Resource Card ──────────────────────────────────────────────────

function AgentResourceCard({
  locale,
  systemResources,
  task,
}: {
  locale: WorkbenchLocale;
  systemResources?: WorkbenchSystemResources;
  task: WorkbenchTask;
}) {
  const completedCount = task.agents.filter((agent) => normalizeStatus(agent.status) === "completed").length;
  const cpu = normalizeMetricPercent(systemResources?.cpuPercent);
  const memory = normalizeMetricPercent(systemResources?.memoryPercent);
  return (
    <article className="javis-agent-resource-card" aria-label="Resource usage">
      <div className="javis-agent-resource-header">
        <strong>资源使用</strong>
        <span>{completedCount}/{task.agents.length}</span>
      </div>
      <div className="javis-agent-resource-grid">
        <Metric label="CPU" value={formatMetricPercent(systemResources?.cpuPercent)} percent={cpu} />
        <Metric label={isChineseLocale(locale) ? "内存" : "Memory"} value={formatMemoryMetric(systemResources)} percent={memory} />
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

// ── Task Overview ────────────────────────────────────────────────────────

function TaskOverview({
  task,
  locale,
  labels,
}: {
  task: WorkbenchTask;
  locale: WorkbenchLocale;
  labels: WorkbenchLocale["labels"];
}) {
  const isChinese = isChineseLocale(locale);
  const completedSteps = task.plan.filter((s) => s.status === "completed").length;
  const totalSteps = task.plan.length;
  const failedSteps = task.plan.filter((s) => s.status === "failed").length;
  const progressPct = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;
  const trace = task.executionTrace;

  return (
    <div className="javis-task-overview">
      {totalSteps > 0 ? (
        <section className="javis-overview-card" aria-label={labels.plan}>
          <div className="javis-overview-card-header">
            <strong>{isChinese ? "任务进度" : "Task Progress"}</strong>
            <span>{completedSteps}/{totalSteps}</span>
          </div>
          <div className="javis-overview-progress-bar" aria-label={`${progressPct}%`}>
            <span style={{ width: `${progressPct}%` }} />
          </div>
          {failedSteps > 0 ? (
            <p className="javis-overview-warning">
              {isChinese ? `${failedSteps} 步失败` : `${failedSteps} step(s) failed`}
            </p>
          ) : null}
        </section>
      ) : null}
      {task.tokenUsage?.byAgentKind?.length ? (
        <TokenUsageCard tokenUsage={task.tokenUsage} locale={locale} />
      ) : null}
      {trace?.totalWallTimeMs ? (
        <ExecutionTraceCard trace={trace} locale={locale} />
      ) : null}
      <section className="javis-overview-card">
        <div className="javis-overview-card-header">
          <strong>{isChinese ? "任务状态" : "Task Status"}</strong>
          <span className={`javis-badge status-${task.status}`}>{task.status}</span>
        </div>
        <div className="javis-overview-stats">
          <StatRow label={isChinese ? "Agent 数" : "Agents"} value={String(task.agents.length)} />
          <StatRow label={isChinese ? "日志条数" : "Log entries"} value={String(task.logs.length)} />
          {task.workspacePath ? (
            <StatRow label={isChinese ? "工作区" : "Workspace"} value={task.workspacePath} mono />
          ) : null}
        </div>
      </section>
    </div>
  );
}

function TokenUsageCard({
  tokenUsage,
  locale,
}: {
  tokenUsage: NonNullable<WorkbenchTask["tokenUsage"]>;
  locale: WorkbenchLocale;
}) {
  const isChinese = isChineseLocale(locale);
  const byKind = tokenUsage.byAgentKind ?? [];
  return (
    <section className="javis-overview-card">
      <div className="javis-overview-card-header">
        <strong>{isChinese ? "Token 用量" : "Token Usage"}</strong>
        <span>{tokenUsage.totalTokens}</span>
      </div>
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
      <div className="javis-token-summary">
        <span>{isChinese ? "输入" : "In"}: {tokenUsage.inputTokens}</span>
        <span>{isChinese ? "输出" : "Out"}: {tokenUsage.outputTokens}</span>
        <span>{isChinese ? "调用" : "Calls"}: {tokenUsage.modelCalls}</span>
      </div>
    </section>
  );
}

function ExecutionTraceCard({
  trace,
  locale,
}: {
  trace: NonNullable<WorkbenchTask["executionTrace"]>;
  locale: WorkbenchLocale;
}) {
  const isChinese = isChineseLocale(locale);
  const seconds = (trace.totalWallTimeMs / 1000).toFixed(1);
  const completedCount = trace.steps.filter((s) => s.status === "completed").length;
  return (
    <section className="javis-overview-card">
      <div className="javis-overview-card-header">
        <strong>{isChinese ? "执行耗时" : "Wall Time"}</strong>
        <span>{seconds}s</span>
      </div>
      <div className="javis-overview-stats">
        <StatRow label={isChinese ? "步骤完成" : "Steps done"} value={`${completedCount}/${trace.steps.length}`} />
        <StatRow label={isChinese ? "开始于" : "Started"} value={formatTraceTime(trace.startedAt)} />
        {trace.completedAt ? (
          <StatRow label={isChinese ? "完成于" : "Finished"} value={formatTraceTime(trace.completedAt)} />
        ) : null}
      </div>
    </section>
  );
}

function StatRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="javis-stat-row">
      <span className="javis-stat-label">{label}</span>
      <span className={`javis-stat-value${mono ? " mono" : ""}`}>{value}</span>
    </div>
  );
}

// ── Detail Inspector ─────────────────────────────────────────────────────

function DetailInspector({
  detailItem,
  labels,
  locale,
  task,
  changedFiles,
  detailsLabel,
}: {
  detailItem?: WorkbenchDetailItem | null;
  labels: WorkbenchLocale["labels"];
  locale: WorkbenchLocale;
  task: WorkbenchTask;
  changedFiles: string[];
  detailsLabel: string;
}) {
  const hasCodeReviewDetails = changedFiles.length > 0 || Boolean(task.codeReviewPreview || task.codeProposedEdit || task.codeApplyResult);
  const hasResearchDetails = Boolean(task.sources?.length || task.researchReport);
  const hasFileDetails = Boolean(task.fileOrganizationExecution);
  const hasProjectDetails = Boolean(task.project);
  const hasAnyDetail = Boolean(detailItem) || hasCodeReviewDetails || hasResearchDetails || hasFileDetails || hasProjectDetails;
  if (!hasAnyDetail) return null;

  return (
    <section className="javis-review-inspector" aria-label={detailItem ? detailsLabel : labels.codeReview}>
      {detailItem ? (
        <article className="javis-review-card">
          <div className="javis-review-card-title">
            <strong>{detailItem.title}</strong>
            {detailItem.kind ? <span>{detailItem.kind}</span> : null}
          </div>
          {detailItem.description ? <p>{detailItem.description}</p> : null}
          {detailItem.metadata?.length ? (
            <dl className="javis-detail-metadata">
              {detailItem.metadata.map((item) => (
                <div key={`${item.label}-${item.value}`}>
                  <dt>{item.label}</dt>
                  <dd>{item.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </article>
      ) : null}
      {hasProjectDetails ? (
        <article className="javis-review-card">
          <div className="javis-review-card-title">
            <strong>{labels.projectInspection}</strong>
            <span>{task.project!.packageManager ?? labels.unknownManager}</span>
          </div>
          <div className="javis-overview-stats">
            <StatRow label={labels.currentWorkspace} value={task.project!.workspacePath} mono />
            <StatRow label={labels.testCheck} value={task.project!.recommendedTestCommand ?? translateWorkbenchText("not found", locale)} />
          </div>
        </article>
      ) : null}
      {hasResearchDetails ? (
        <article className="javis-review-card">
          <div className="javis-review-card-title">
            <strong>{labels.researchReport}</strong>
            <span>{task.sources!.length}</span>
          </div>
          {task.researchReport ? <p>{translateWorkbenchText(task.researchReport.summary, locale)}</p> : null}
        </article>
      ) : null}
      {hasCodeReviewDetails ? (
        <>
          <article className="javis-review-card">
            <div className="javis-review-card-title">
              <strong>{labels.changedFiles}</strong>
              <span>{changedFiles.length}</span>
            </div>
            {changedFiles.length > 0 ? (
              <ul className="javis-review-file-list">{changedFiles.map((f) => <li key={f}>{f}</li>)}</ul>
            ) : <p>{labels.emptyOutput}</p>}
          </article>
          {task.codeReviewPreview ? (
            <article className="javis-review-card">
              <div className="javis-review-card-title"><strong>{labels.codeReview}</strong></div>
              <pre>{task.codeReviewPreview.diff || labels.emptyOutput}</pre>
            </article>
          ) : null}
          {task.codeApplyResult ? (
            <article className="javis-review-card">
              <div className="javis-review-card-title">
                <strong>{translateWorkbenchText("Code Agent apply result", locale)}</strong>
              </div>
              <p>{translateWorkbenchText(task.codeApplyResult.message, locale)}</p>
            </article>
          ) : null}
        </>
      ) : null}
      {hasFileDetails && task.fileOrganizationExecution ? (
        <article className="javis-review-card">
          <div className="javis-review-card-title">
            <strong>{labels.fileOrganizationResult}</strong>
            <span>{task.fileOrganizationExecution.movedCount}/{task.fileOrganizationExecution.attemptedCount}</span>
          </div>
          <div className="javis-overview-stats">
            <StatRow label={translateWorkbenchText("moved", locale)} value={String(task.fileOrganizationExecution.movedCount)} />
            <StatRow label={translateWorkbenchText("skipped", locale)} value={String(task.fileOrganizationExecution.skippedCount)} />
            <StatRow label={translateWorkbenchText("failed", locale)} value={String(task.fileOrganizationExecution.failedCount)} />
          </div>
        </article>
      ) : null}
    </section>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function normalizeMetricPercent(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.round(Math.min(100, Math.max(0, value)));
}
function formatMetricPercent(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  return `${normalizeMetricPercent(value)}%`;
}
function formatMemoryMetric(resources: WorkbenchSystemResources | undefined): string {
  if (!resources || typeof resources.memoryPercent !== "number" || !Number.isFinite(resources.memoryPercent)) return "--";
  if (resources.memoryTotalBytes && resources.memoryUsedBytes) {
    return `${formatBytes(resources.memoryUsedBytes)} / ${formatBytes(resources.memoryTotalBytes)}`;
  }
  return `${normalizeMetricPercent(resources.memoryPercent)}%`;
}
function formatBytes(value: number): string {
  const gib = value / 1024 / 1024 / 1024;
  return `${gib.toFixed(gib >= 10 ? 0 : 1)}GB`;
}
function formatTraceTime(iso: string): string {
  try { return new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
  catch { return iso; }
}
function agentKind(agent: WorkbenchAgent): string {
  const text = `${agent.name} ${agent.role}`.toLowerCase();
  if (text.includes("research") || text.includes("search")) return "research";
  if (text.includes("file") || text.includes("document") || text.includes("write")) return "file";
  if (text.includes("command") || text.includes("shell")) return "command";
  if (text.includes("code") || text.includes("program")) return "code";
  if (text.includes("computer") || text.includes("desktop")) return "computer";
  if (text.includes("commander") || text.includes("plan")) return "commander";
  return "agent";
}
function agentIcon(agent: WorkbenchAgent): string {
  switch (agentKind(agent)) {
    case "research": return "R"; case "file": return "F"; case "command": return ">";
    case "code": return "</>"; case "computer": return "PC"; case "commander": return "C";
    default: return "A";
  }
}
function normalizeStatus(status: string): "completed" | "running" | "failed" | "waiting" | "idle" {
  const text = status.toLowerCase();
  if (text.includes("complete") || text.includes("done") || text.includes("success")) return "completed";
  if (text.includes("run") || text.includes("stream")) return "running";
  if (text.includes("fail") || text.includes("error")) return "failed";
  if (text.includes("wait") || text.includes("pending") || text.includes("queued")) return "waiting";
  return "idle";
}
function agentStatusLabel(status: string, locale: WorkbenchLocale): string {
  const isChinese = isChineseLocale(locale);
  switch (normalizeStatus(status)) {
    case "completed": return isChinese ? "已完成" : "Completed";
    case "running": return isChinese ? "运行中" : "Running";
    case "failed": return isChinese ? "失败" : "Failed";
    case "waiting": return isChinese ? "等待中" : "Waiting";
    default: return isChinese ? "空闲中" : "Idle";
  }
}
function agentProgress(status: string): number {
  switch (normalizeStatus(status)) {
    case "completed": return 100; case "running": return 68;
    case "failed": return 100; case "waiting": return 18;
    default: return 8;
  }
}
function getReviewChangedFiles(task: WorkbenchTask): string[] {
  return Array.from(new Set([
    ...(task.codeReviewPreview?.changedFiles ?? []),
    ...(task.codeProposedEdit?.changedFiles ?? []),
    ...(task.codeApplyResult?.changedFiles ?? []),
  ]));
}
