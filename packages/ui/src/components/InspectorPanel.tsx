import { useEffect, useState } from "react";
import type {
  BrowserQuickResult,
  BrowserQuickRequest,
  GitCommitExecutionQuickResult,
  GitCommitPlanQuickResult,
  GitCommentPullRequestExecutionQuickResult,
  GitCommentPullRequestPlanQuickResult,
  GitCreatePullRequestExecutionQuickResult,
  GitCreatePullRequestPlanQuickResult,
  GitPushExecutionQuickResult,
  GitPushPlanQuickResult,
  GitStageExecutionQuickResult,
  GitStagePlanQuickResult,
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
  WorkbenchBrowserWriteApprovalPreview,
  WorkbenchWorkspaceToolTab,
  WorkbenchWorkspaceToolAction,
} from "../types";
import { isChineseLocale, translateWorkbenchText } from "../utils";
import { AgentDetailPanel } from "./inspector/AgentDetailPanel";
import { AgentGraphPanel } from "./inspector/AgentGraphPanel";
import { ResourceStatusPanel } from "./inspector/ResourceStatusPanel";
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
  onClearSelectedAgent?: () => void;
  onCloseToolTab?: (tabId: string) => void;
  onSelectToolTab?: (tabId: string) => void;
  onNewToolTab?: (tool: WorkbenchWorkspaceToolAction) => void;
  onQuickActionBrowser?: (session: WorkbenchAgentSessionContext, request: string | BrowserQuickRequest) => Promise<BrowserQuickResult>;
  pendingBrowserWriteApproval?: WorkbenchBrowserWriteApprovalPreview | null;
  onApproveBrowserWrite?: (session: WorkbenchAgentSessionContext, approvalId: string) => Promise<void>;
  onDenyBrowserWrite?: (session: WorkbenchAgentSessionContext, approvalId: string) => Promise<void>;
  onQuickActionReview?: (session: WorkbenchAgentSessionContext) => Promise<ReviewQuickResult>;
  onQuickActionGitPushPlan?: (session: WorkbenchAgentSessionContext) => Promise<GitPushPlanQuickResult>;
  onQuickActionGitPushExecute?: (session: WorkbenchAgentSessionContext, approvalId: string) => Promise<GitPushExecutionQuickResult>;
  onQuickActionGitPushCancel?: (session: WorkbenchAgentSessionContext, approvalId: string) => Promise<void>;
  onQuickActionGitStagePlan?: (session: WorkbenchAgentSessionContext, paths: string[]) => Promise<GitStagePlanQuickResult>;
  onQuickActionGitStageExecute?: (session: WorkbenchAgentSessionContext, approvalId: string, paths: string[]) => Promise<GitStageExecutionQuickResult>;
  onQuickActionGitStageCancel?: (session: WorkbenchAgentSessionContext, approvalId: string) => Promise<void>;
  onQuickActionGitCommitPlan?: (session: WorkbenchAgentSessionContext, message: string) => Promise<GitCommitPlanQuickResult>;
  onQuickActionGitCommitExecute?: (session: WorkbenchAgentSessionContext, approvalId: string, message: string) => Promise<GitCommitExecutionQuickResult>;
  onQuickActionGitCommitCancel?: (session: WorkbenchAgentSessionContext, approvalId: string) => Promise<void>;
  onQuickActionGitCreatePullRequestPlan?: (
    session: WorkbenchAgentSessionContext,
    request: { title: string; body?: string; baseBranch: string; draft?: boolean },
  ) => Promise<GitCreatePullRequestPlanQuickResult>;
  onQuickActionGitCreatePullRequestExecute?: (
    session: WorkbenchAgentSessionContext,
    approvalId: string,
    request: { title: string; body?: string; baseBranch: string; draft?: boolean },
  ) => Promise<GitCreatePullRequestExecutionQuickResult>;
  onQuickActionGitCreatePullRequestCancel?: (session: WorkbenchAgentSessionContext, approvalId: string) => Promise<void>;
  onQuickActionGitCommentPullRequestPlan?: (
    session: WorkbenchAgentSessionContext,
    request: { pullRequest: string; body: string },
  ) => Promise<GitCommentPullRequestPlanQuickResult>;
  onQuickActionGitCommentPullRequestExecute?: (
    session: WorkbenchAgentSessionContext,
    approvalId: string,
    request: { pullRequest: string; body: string },
  ) => Promise<GitCommentPullRequestExecutionQuickResult>;
  onQuickActionGitCommentPullRequestCancel?: (session: WorkbenchAgentSessionContext, approvalId: string) => Promise<void>;
  onQuickActionTerminal?: (session: WorkbenchAgentSessionContext, command: string) => Promise<TerminalQuickResult>;
  session: WorkbenchAgentSessionContext;
  terminalService?: WorkbenchTerminalService;
  fileService?: WorkbenchFileService;
  computerEntries?: WorkbenchFileEntry[];
  computerPath?: string;
  onNavigateDirectory?: (path: string) => void;
  onOpenFile?: (path: string) => void;
  onOpenDetail?: (detail: WorkbenchDetailItem) => void;
  onOpenUrl?: (url: string) => void;
  onSideChatSend?: (session: WorkbenchAgentSessionContext, message: string) => Promise<string>;
}

const TOOL_LABELS: Record<string, { zh: string; en: string }> = {
  files:    { zh: "文件", en: "Files" },
  sideChat: { zh: "侧边聊天", en: "Side Chat" },
  browser:  { zh: "浏览器", en: "Browser" },
  review:   { zh: "审查", en: "Review" },
  terminal: { zh: "终端", en: "Terminal" },
};

type InspectorSection = "agents" | "details" | "resources";

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
  onClearSelectedAgent,
  onCloseToolTab,
  onSelectToolTab,
  onNewToolTab,
  onQuickActionBrowser,
  pendingBrowserWriteApproval,
  onApproveBrowserWrite,
  onDenyBrowserWrite,
  onQuickActionReview,
  onQuickActionGitPushPlan,
  onQuickActionGitPushExecute,
  onQuickActionGitPushCancel,
  onQuickActionGitStagePlan,
  onQuickActionGitStageExecute,
  onQuickActionGitStageCancel,
  onQuickActionGitCommitPlan,
  onQuickActionGitCommitExecute,
  onQuickActionGitCommitCancel,
  onQuickActionGitCreatePullRequestPlan,
  onQuickActionGitCreatePullRequestExecute,
  onQuickActionGitCreatePullRequestCancel,
  onQuickActionGitCommentPullRequestPlan,
  onQuickActionGitCommentPullRequestExecute,
  onQuickActionGitCommentPullRequestCancel,
  onQuickActionTerminal,
  session,
  terminalService,
  fileService,
  computerEntries = [],
  computerPath = "",
  onNavigateDirectory,
  onOpenFile,
  onOpenDetail,
  onOpenUrl,
  onSideChatSend,
}: InspectorPanelProps) {
  const [activeSection, setActiveSection] = useState<InspectorSection>(
    openTabs.length > 0 || detailItem || selectedAgentId ? "details" : "agents",
  );
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const [agentTabIds, setAgentTabIds] = useState<string[]>([]);
  const changedFiles = getReviewChangedFiles(task);
  const detailCount = detailItem ? 1 : changedFiles.length;
  const detailsLabel = isChineseLocale(locale) ? "详情" : "Details";
  const resourcesLabel = isChineseLocale(locale) ? "资源" : "Resources";

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
    const validAgentIds = new Set(task.agents.map((agent) => agent.id));
    setAgentTabIds((prev) => prev.filter((agentId) => validAgentIds.has(agentId)));
  }, [task.agents]);

  useEffect(() => {
    if (!selectedAgentId || !task.agents.some((agent) => agent.id === selectedAgentId)) return;
    setAgentTabIds((prev) => prev.includes(selectedAgentId) ? prev : [...prev, selectedAgentId]);
    setActiveSection("details");
  }, [selectedAgentId, task.agents]);

  // When new tabs open, switch to details
  useEffect(() => {
    if (openTabs.length > 0) setActiveSection("details");
  }, [openTabs.length]);

  function handleSectionToggle(section: InspectorSection) {
    if (isInspectorOpen && activeSection === section) {
      onToggle();
      return;
    }
    setActiveSection(section);
    if (!isInspectorOpen) onToggle();
  }

  function handleCloseAgentTab(agentId: string) {
    const nextAgentTabIds = agentTabIds.filter((tabAgentId) => tabAgentId !== agentId);
    setAgentTabIds(nextAgentTabIds);
    if (selectedAgentId !== agentId) return;

    const nextAgentId = nextAgentTabIds[nextAgentTabIds.length - 1];
    if (nextAgentId) {
      onSelectAgent?.(nextAgentId);
    } else {
      onClearSelectedAgent?.();
    }
  }

  const selectedAgent = selectedAgentId
    ? task.agents.find((agent) => agent.id === selectedAgentId)
    : undefined;
  const agentTabs = agentTabIds
    .map((agentId) => task.agents.find((agent) => agent.id === agentId))
    .filter((agent): agent is WorkbenchAgent => Boolean(agent));
  const rawActiveTab = openTabs.find((tab) => tab.id === activeToolTabId) ?? openTabs[activeTabIndex] ?? openTabs[openTabs.length - 1] ?? null;
  const activeTab = selectedAgent ? null : rawActiveTab;
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
        <button
          aria-controls="javis-inspector-panel"
          aria-expanded={isInspectorOpen && activeSection === "resources"}
          className={`javis-inspector-toggle ${activeSection === "resources" ? "active" : ""}`}
          onClick={() => handleSectionToggle("resources")}
          type="button"
        >
          <span>{resourcesLabel}</span>
          <span className="javis-activity-count">{task.logs.length}</span>
          <span>{isInspectorOpen && activeSection === "resources" ? labels.collapseInspector : labels.expandInspector}</span>
        </button>
      </div>
      {isInspectorOpen ? (
        <div className="javis-inspector-panel" id="javis-inspector-panel">
          <header className="javis-inspector-header">
            <p className="javis-eyebrow">{labels.agentContextInspector}</p>
            <h2 className="javis-title">
              {activeSection === "details"
                ? detailsLabel
                : activeSection === "resources"
                  ? resourcesLabel
                  : labels.agentGraph}
            </h2>
          </header>
          {activeSection === "details" ? (
            <section className="javis-inspector-details">
              {activeTool || selectedAgent ? null : <InspectorQuickActions locale={locale} onQuickAction={onQuickAction} />}
              {/* Tab bar */}
              {openTabs.length > 0 || agentTabs.length > 0 ? (
                <div className="javis-tool-tab-bar" role="tablist">
                  {agentTabs.map((agent) => {
                    const isActive = selectedAgentId === agent.id;
                    return (
                      <button
                        key={`agent-${agent.id}`}
                        className={`javis-tool-tab${isActive ? " active" : ""}`}
                        onClick={() => onSelectAgent?.(agent.id)}
                        role="tab"
                        aria-selected={isActive}
                        type="button"
                      >
                        <span>{translateWorkbenchText(agent.name, locale)}</span>
                        <span
                          className="javis-tool-tab-close"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCloseAgentTab(agent.id);
                          }}
                          aria-label={isChineseLocale(locale) ? "关闭" : "Close"}
                        >×</span>
                      </button>
                    );
                  })}
                  {openTabs.map((tab, i) => {
                    const label = TOOL_LABELS[tab.tool] ?? { zh: tab.tool, en: tab.tool };
                    const isActive = !selectedAgent && tab.id === activeTab?.id;
                    return (
                      <button
                        key={tab.id}
                        className={`javis-tool-tab${isActive ? " active" : ""}`}
                        onClick={() => {
                          onClearSelectedAgent?.();
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
              {detailItem ? (
                <DetailInspector
                  detailItem={detailItem}
                  labels={labels}
                  locale={locale}
                  task={task}
                  changedFiles={changedFiles}
                  detailsLabel={detailsLabel}
                  onOpenUrl={onOpenUrl}
                />
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
                  pendingBrowserWriteApproval={pendingBrowserWriteApproval}
                  onApproveBrowserWrite={onApproveBrowserWrite}
                  onDenyBrowserWrite={onDenyBrowserWrite}
                  onQuickActionReview={onQuickActionReview}
                  onQuickActionGitPushPlan={onQuickActionGitPushPlan}
                  onQuickActionGitPushExecute={onQuickActionGitPushExecute}
                  onQuickActionGitPushCancel={onQuickActionGitPushCancel}
                  onQuickActionGitStagePlan={onQuickActionGitStagePlan}
                  onQuickActionGitStageExecute={onQuickActionGitStageExecute}
                  onQuickActionGitStageCancel={onQuickActionGitStageCancel}
                  onQuickActionGitCommitPlan={onQuickActionGitCommitPlan}
                  onQuickActionGitCommitExecute={onQuickActionGitCommitExecute}
                  onQuickActionGitCommitCancel={onQuickActionGitCommitCancel}
                  onQuickActionGitCreatePullRequestPlan={onQuickActionGitCreatePullRequestPlan}
                  onQuickActionGitCreatePullRequestExecute={onQuickActionGitCreatePullRequestExecute}
                  onQuickActionGitCreatePullRequestCancel={onQuickActionGitCreatePullRequestCancel}
                  onQuickActionGitCommentPullRequestPlan={onQuickActionGitCommentPullRequestPlan}
                  onQuickActionGitCommentPullRequestExecute={onQuickActionGitCommentPullRequestExecute}
                  onQuickActionGitCommentPullRequestCancel={onQuickActionGitCommentPullRequestCancel}
                  onQuickActionTerminal={onQuickActionTerminal}
                  terminalService={terminalService}
                  fileService={fileService}
                  computerEntries={computerEntries}
                  computerPath={computerPath}
                  onNavigateDirectory={onNavigateDirectory}
                  onOpenFile={onOpenFile}
                  onOpenDetail={onOpenDetail}
                  onSideChatSend={onSideChatSend}
                />
              ) : selectedAgent ? (
                <AgentDetailPanel
                  agent={selectedAgent}
                  labels={labels}
                  locale={locale}
                  onQuickAction={(action) => {
                    onClearSelectedAgent?.();
                    onQuickAction?.(action);
                  }}
                  task={task}
                />
              ) : null}
              {!detailItem ? (
                <DetailInspector
                  detailItem={detailItem}
                  labels={labels}
                  locale={locale}
                  task={task}
                  changedFiles={changedFiles}
                  detailsLabel={detailsLabel}
                  onOpenUrl={onOpenUrl}
                />
              ) : null}
            </section>
          ) : activeSection === "resources" ? (
            <ResourceStatusPanel locale={locale} systemResources={systemResources} task={task} />
          ) : (
            <AgentGraphPanel
              locale={locale}
              selectedAgentId={selectedAgentId}
              task={task}
              onSelectAgent={(agentId) => {
                onSelectAgent?.(agentId);
                setActiveSection("details");
              }}
            />
          )}
        </div>
      ) : null}
    </aside>
  );
}

// Quick actions

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

  }> = isChinese
    ? [
        { id: "files", title: "文件", description: "浏览项目文件" },
        { id: "sideChat", title: "侧边聊天", description: "发起侧边对话" },
        { id: "browser", title: "浏览器", description: "打开网站" },
        { id: "review", title: "审查", description: "查看代码更改" },
        { id: "terminal", title: "终端", description: "启动交互式 shell" },
      ]
    : [
        { id: "files", title: "Files", description: "Browse project files" },
        { id: "sideChat", title: "Side chat", description: "Start a side conversation" },
        { id: "browser", title: "Browser", description: "Open a website" },
        { id: "review", title: "Review", description: "Inspect code changes" },
        { id: "terminal", title: "Terminal", description: "Start an interactive shell" },
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
        </button>
      ))}
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

// Detail inspector

function DetailInspector({
  detailItem,
  labels,
  locale,
  task,
  changedFiles,
  detailsLabel,
  onOpenUrl,
}: {
  detailItem?: WorkbenchDetailItem | null;
  labels: WorkbenchLocale["labels"];
  locale: WorkbenchLocale;
  task: WorkbenchTask;
  changedFiles: string[];
  detailsLabel: string;
  onOpenUrl?: (url: string) => void;
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
          {detailItem.url ? (
            <a
              className="javis-detail-link"
              href={detailItem.url}
              onClick={(event) => {
                if (!onOpenUrl) return;
                event.preventDefault();
                onOpenUrl(detailItem.url!);
              }}
              rel="noreferrer"
              target="_blank"
              title={detailItem.url}
            >
              {detailItem.url}
            </a>
          ) : null}
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
            <span>{task.sources?.length ?? task.researchReport?.rows.length ?? 0}</span>
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

// Helpers

function getReviewChangedFiles(task: WorkbenchTask): string[] {
  return Array.from(new Set([
    ...(task.codeReviewPreview?.changedFiles ?? []),
    ...(task.codeProposedEdit?.changedFiles ?? []),
    ...(task.codeApplyResult?.changedFiles ?? []),
  ]));
}
