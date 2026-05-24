import { useState, type FormEvent } from "react";

export interface WorkbenchAgent {
  id: string;
  name: string;
  role: string;
  status: string;
  task: string;
}

export interface WorkbenchStep {
  id: string;
  title: string;
  status: string;
  successCriteria?: string;
}

export interface WorkbenchLogEntry {
  id: string;
  kind: string;
  title: string;
  detail: string;
}

export interface WorkbenchDocument {
  path: string;
  modifiedAt: string;
  sizeBytes: number;
  heading?: string;
  excerpt?: string;
  purpose: string;
}

export interface WorkbenchCommand {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface WorkbenchPermissionRequest {
  id: string;
  level: string;
  title: string;
  reason: string;
  status: string;
  dryRun: {
    operation: string;
    affectedPaths: Array<{
      source: string;
      target: string;
      action: string;
      conflict?: string;
    }>;
    riskSummary: string;
    reversible: boolean;
  };
}

export interface WorkbenchFileOrganizationExecution {
  attemptedCount: number;
  movedCount: number;
  skippedCount: number;
  failedCount: number;
  results: Array<{
    source: string;
    target: string;
    status: string;
    message: string;
  }>;
}

export interface WorkbenchProject {
  workspacePath: string;
  packageManager?: string;
  scripts: Array<{
    name: string;
    command: string;
  }>;
  recommendedStartCommand?: string;
  recommendedTestCommand?: string;
}

export interface WorkbenchSource {
  url: string;
  title?: string;
  excerpt: string;
  fetchedAt: string;
  provider?: string;
}

export interface WorkbenchResearchReport {
  title: string;
  summary: string;
  rows: Array<{
    claim: string;
    sourceUrl: string;
    evidence: string;
  }>;
  unknowns: string[];
}

export interface WorkbenchCodeReviewPreview {
  workspacePath: string;
  changedFiles: string[];
  diffStat: string;
  diff: string;
}

export interface WorkbenchCodeProposedEdit {
  proposalId: string;
  workspacePath: string;
  summary: string;
  changedFiles: string[];
  patch: string;
  patchHash: string;
}

export interface WorkbenchCodeApplyResult {
  applied: boolean;
  workspacePath: string;
  changedFiles: string[];
  message: string;
}

export interface WorkbenchTokenUsageSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  modelCalls: number;
  byAgentKind: Array<{
    agentKind: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    modelCalls: number;
  }>;
}

export interface WorkbenchModelSettings {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
}

export interface WorkbenchHistoryEntry {
  id: string;
  title: string;
  status: string;
  userGoal: string;
  updatedAt: string;
}

export interface WorkbenchTask {
  id?: string;
  title: string;
  userGoal: string;
  status: string;
  commanderMessage: string;
  plan: WorkbenchStep[];
  agents: WorkbenchAgent[];
  logs: WorkbenchLogEntry[];
  documents?: WorkbenchDocument[];
  commands?: WorkbenchCommand[];
  fileOrganizationExecution?: WorkbenchFileOrganizationExecution;
  permissionRequest?: WorkbenchPermissionRequest;
  project?: WorkbenchProject;
  codeReviewPreview?: WorkbenchCodeReviewPreview;
  codeProposedEdit?: WorkbenchCodeProposedEdit;
  codeApplyResult?: WorkbenchCodeApplyResult;
  researchReport?: WorkbenchResearchReport;
  sources?: WorkbenchSource[];
  tokenUsage?: WorkbenchTokenUsageSummary;
  verificationSummary?: string;
}

export interface JavisWorkbenchProps {
  task: WorkbenchTask;
  draftGoal: string;
  currentWorkspacePath?: string;
  historyEntries?: WorkbenchHistoryEntry[];
  locale?: WorkbenchLocale;
  modelSettings?: WorkbenchModelSettings;
  recentWorkspacePaths?: string[];
  onDraftGoalChange: (nextGoal: string) => void;
  onDeleteHistoryEntry?: (id: string) => void;
  onDeleteRecentWorkspacePath?: (path: string) => void;
  onBrowseWorkspacePath?: () => void;
  onModelSettingsChange?: (settings: WorkbenchModelSettings) => void;
  onSelectHistoryEntry?: (id: string) => void;
  onUseWorkspacePath?: (path: string) => void;
  onWorkspacePathChange?: (path: string) => void;
  onPermissionDecision?: (decision: "approved" | "denied") => void;
  onRetryTask?: () => void;
  onSubmitGoal: () => void;
}

export interface WorkbenchLocale {
  labels: {
    activeTask: string;
    activityLog: string;
    apps: string;
    automatedTasks: string;
    collapseActivityLog: string;
    agentContextInspector: string;
    agentGraph: string;
    agentStates: string;
    collapseInspector: string;
    approve: string;
    commandResults: string;
    commander: string;
    codeReview: string;
    changedFiles: string;
    currentTask: string;
    deny: string;
    deleteHistoryEntry: string;
    documents: string;
    emptyOutput: string;
    executionTimeline: string;
    expandActivityLog: string;
    expandInspector: string;
    fileOrganizationResult: string;
    failedRecoveryTitle: string;
    failedRecoveryMessage: string;
    gallery: string;
    history: string;
    historyEmpty: string;
    historyNoMatches: string;
    localKnowledgeBase: string;
    mainThread: string;
    manualSourceFallbackTitle: string;
    manualSourceFallbackMessage: string;
    markdownDocuments: string;
    models: string;
    modelProvider?: string;
    modelName?: string;
    modelApiKey?: string;
    modelBaseUrl?: string;
    modelSettingsDescription?: string;
    modified: string;
    newChat: string;
    newChatTitle: string;
    office: string;
    packageScript: string;
    plan: string;
    projectInspection: string;
    projects: string;
    profileName: string;
    researchReport: string;
    researchSources: string;
    retryTask: string;
    send: string;
    searchPlaceholder: string;
    settings: string;
    skillMarket: string;
    source: string;
    status: string;
    taskInput: string;
    taskInputPlaceholder: string;
    testCheck: string;
    thisComputer: string;
    tokenUsage: string;
    tokenInput: string;
    tokenOutput: string;
    tokenCalls: string;
    noModelCalls: string;
    unknown: string;
    unknownManager: string;
    unverified: string;
    user: string;
    verifier: string;
    workspaceNavigation: string;
    browseWorkspace: string;
    currentWorkspace: string;
    recentWorkspaces: string;
    removeWorkspace: string;
    useWorkspace: string;
    workspaceBrowseError: string;
    workspacePathPlaceholder: string;
  };
  phrases?: Record<string, string>;
}

export const zhCNWorkbenchLocale: WorkbenchLocale = {
  labels: {
    activeTask: "当前任务",
    activityLog: "活动日志",
    apps: "应用",
    automatedTasks: "自动任务",
    collapseActivityLog: "收起日志",
    agentContextInspector: "代理 / 上下文检查器",
    agentGraph: "代理图谱",
    agentStates: "代理状态",
    collapseInspector: "收起检查器",
    approve: "批准",
    commandResults: "只读命令",
    commander: "指挥官",
    codeReview: "代码审查",
    changedFiles: "已变更文件",
    currentTask: "当前任务",
    deny: "拒绝",
    deleteHistoryEntry: "删除历史",
    documents: "文档",
    emptyOutput: "（无输出）",
    executionTimeline: "执行时间线",
    expandActivityLog: "展开日志",
    expandInspector: "展开检查器",
    fileOrganizationResult: "文件整理结果",
    failedRecoveryTitle: "恢复",
    failedRecoveryMessage: "检查失败阶段和活动日志，然后重试当前任务或改写目标后再运行。",
    gallery: "图库",
    history: "历史",
    historyEmpty: "暂无历史",
    historyNoMatches: "没有匹配的历史",
    localKnowledgeBase: "本地知识库",
    mainThread: "主线程",
    manualSourceFallbackTitle: "手动来源备用路径",
    manualSourceFallbackMessage: "当搜索找不到或无法获取足够证据时，把一个或多个来源 URL 粘贴到输入框，再重新运行研究任务。",
    markdownDocuments: "Markdown 文档",
    models: "模型",
    modified: "修改时间",
    newChat: "新建对话",
    newChatTitle: "今天想让 Javis 做什么？",
    office: "办公室",
    packageScript: "包脚本",
    plan: "计划",
    projectInspection: "项目检查",
    projects: "项目",
    profileName: "子路",
    researchReport: "研究报告",
    researchSources: "研究来源",
    retryTask: "重试",
    send: "发送",
    searchPlaceholder: "搜索",
    settings: "设置",
    skillMarket: "技能广场",
    source: "来源",
    status: "状态",
    taskInput: "任务输入",
    taskInputPlaceholder: "让 Javis 做点什么...",
    testCheck: "测试/检查",
    thisComputer: "此电脑",
    tokenUsage: "Token usage",
    tokenInput: "Input",
    tokenOutput: "Output",
    tokenCalls: "Calls",
    noModelCalls: "No model calls",
    unknown: "未知",
    unknownManager: "未知包管理器",
    unverified: "未验证",
    user: "用户",
    verifier: "验证器",
    workspaceNavigation: "工作区导航",
    currentWorkspace: "当前工作区",
    recentWorkspaces: "最近工作区",
    useWorkspace: "使用",
    browseWorkspace: "选择文件夹",
    removeWorkspace: "移除",
    workspaceBrowseError: "无法打开文件夹选择器。请手动输入工作区路径。",
    workspacePathPlaceholder: "E:\\Javis",
  },
  phrases: {
    "Ready": "就绪",
    "Waiting for a task": "等待任务",
    "created": "已创建",
    "planning": "规划中",
    "running": "运行中",
    "waiting_permission": "等待授权",
    "verifying": "验证中",
    "retrying": "重试中",
    "completed": "已完成",
    "failed": "失败",
    "cancelled": "已取消",
    "queued": "排队中",
    "pending": "待处理",
    "skipped": "已跳过",
    "approved": "已批准",
    "denied": "已拒绝",
    "expired": "已过期",
    "confirmed_write": "确认写入",
    "read": "读取",
    "preview": "预览",
    "dangerous": "高风险",
    "move": "移动",
    "copy": "复制",
    "create": "创建",
    "modify": "修改",
    "delete": "删除",
    "overwrite": "覆盖",
    "unknown": "未知",
    "event": "事件",
    "plan": "计划",
    "tool": "工具",
    "permission": "授权",
    "verification": "验证",
    "Commander": "指挥官",
    "File Agent": "文件代理",
    "Shell Agent": "命令代理",
    "Research Agent": "研究代理",
    "Verifier": "验证器",
    "Task planning and orchestration": "任务规划与调度",
    "Read-only local document scanning": "只读本地文档扫描",
    "Read-only command execution": "只读命令执行",
    "Public source collection": "公开来源收集",
    "Evidence and completion checks": "证据与完成状态检查",
    "Waiting": "等待中",
    "Runtime ready": "运行时就绪",
    "Core runtime is ready for startTask.": "核心运行时已就绪，可以开始任务。",
    "Javis desktop is ready. Enter a goal to start the Core event stream.":
      "Javis 桌面端已就绪。输入目标即可启动核心事件流。",
    "File Agent scans workspace Markdown documents": "文件代理扫描工作区 Markdown 文档",
    "Return real file paths, modified times, and file sizes.":
      "返回真实文件路径、修改时间和文件大小。",
    "Commander summarizes document purpose": "指挥官总结文档用途",
    "Each document has a one-line purpose summary.": "每个文档都有一行用途摘要。",
    "Verifier checks scan evidence": "验证器检查扫描证据",
    "Final result includes verifiable evidence from the file scan.":
      "最终结果包含来自文件扫描的可验证证据。",
    "Project Tool inspects package scripts": "项目工具检查包脚本",
    "Return package manager, scripts, and recommended start/test commands.":
      "返回包管理器、脚本以及推荐的启动/测试命令。",
    "Shell Agent runs read-only environment and test checks":
      "命令代理运行只读环境与测试检查",
    "Return command, cwd, exit code, stdout, and stderr.":
      "返回命令、工作目录、退出码、标准输出和标准错误。",
    "Verifier checks command outputs": "验证器检查命令输出",
    "Final result explains whether the environment checks succeeded.":
      "最终结果说明环境检查是否成功。",
    "File Agent creates a PDF organization dry-run": "文件代理创建 PDF 整理预演",
    "List source paths, target paths, conflicts, and risk summary without moving files.":
      "列出源路径、目标路径、冲突和风险摘要，但不移动文件。",
    "User reviews the confirmed-write permission card": "用户审查确认写入授权卡片",
    "Approve or deny only the current dry-run plan.": "仅批准或拒绝当前预演计划。",
    "File Agent executes approved moves": "文件代理执行已批准的移动",
    "Only execute the move operations listed in the approved dry-run.":
      "只执行已批准预演中列出的移动操作。",
    "Verifier checks permission evidence": "验证器检查授权证据",
    "Final result states whether approval was recorded and whether files changed.":
      "最终结果说明是否记录了批准，以及文件是否发生变化。",
    "Research Agent fetches user-provided source URLs":
      "研究代理获取用户提供的来源 URL",
    "Each source returns URL, title or excerpt, and fetched timestamp.":
      "每个来源返回 URL、标题或摘录，以及获取时间。",
    "Verifier checks source evidence": "验证器检查来源证据",
    "Final report only verifies claims with retrievable source excerpts.":
      "最终报告只验证有可获取来源摘录支撑的主张。",
  },
};

const defaultWorkbenchLocale: WorkbenchLocale = {
  labels: {
    activeTask: "Current task",
    activityLog: "Activity log",
    apps: "Apps",
    automatedTasks: "Automated tasks",
    collapseActivityLog: "Collapse activity log",
    agentContextInspector: "Agent / Context Inspector",
    agentGraph: "Agent graph",
    agentStates: "Agent states",
    collapseInspector: "Collapse inspector",
    approve: "Approve",
    commandResults: "Read-only Commands",
    commander: "Commander",
    codeReview: "Code Review",
    changedFiles: "Changed files",
    currentTask: "Current task",
    deny: "Deny",
    deleteHistoryEntry: "Delete history",
    documents: "Documents",
    emptyOutput: "(empty output)",
    executionTimeline: "Execution timeline",
    expandActivityLog: "Expand activity log",
    expandInspector: "Expand inspector",
    fileOrganizationResult: "File Organization Result",
    failedRecoveryTitle: "Recovery",
    failedRecoveryMessage: "Review the failed phase and activity log, then retry this task or revise the goal before running it again.",
    gallery: "Gallery",
    history: "History",
    historyEmpty: "No history yet",
    historyNoMatches: "No matching history",
    localKnowledgeBase: "Local knowledge base",
    mainThread: "Main Thread",
    manualSourceFallbackTitle: "Manual source fallback",
    manualSourceFallbackMessage: "When search cannot find or fetch enough evidence, paste one or more source URLs into the composer and run the research task again.",
    markdownDocuments: "Markdown Documents",
    models: "Models",
    modelProvider: "Provider",
    modelName: "Model",
    modelApiKey: "API key",
    modelBaseUrl: "Base URL",
    modelSettingsDescription: "Desktop code tasks use this opencode model.",
    modified: "modified",
    newChat: "New chat",
    newChatTitle: "What should Javis work on?",
    office: "Office",
    packageScript: "package script",
    plan: "Plan",
    projectInspection: "Project Inspection",
    projects: "Projects",
    profileName: "User",
    researchReport: "Research report",
    researchSources: "Research Sources",
    retryTask: "Retry",
    send: "Send",
    searchPlaceholder: "Search",
    settings: "Settings",
    skillMarket: "Skill market",
    source: "source",
    status: "Status",
    taskInput: "Task input",
    taskInputPlaceholder: "Ask Javis to do something...",
    testCheck: "Test/check",
    thisComputer: "This computer",
    tokenUsage: "Token usage",
    tokenInput: "Input",
    tokenOutput: "Output",
    tokenCalls: "Calls",
    noModelCalls: "No model calls",
    unknown: "Unknown",
    unknownManager: "unknown manager",
    unverified: "unverified",
    user: "User",
    verifier: "Verifier",
    workspaceNavigation: "Workspace navigation",
    browseWorkspace: "Browse",
    currentWorkspace: "Current workspace",
    recentWorkspaces: "Recent workspaces",
    removeWorkspace: "Remove",
    useWorkspace: "Use",
    workspaceBrowseError: "Could not open the folder picker. Enter the workspace path manually.",
    workspacePathPlaceholder: "E:\\Javis",
  },
};

export function JavisWorkbench({
  task,
  draftGoal,
  currentWorkspacePath = "",
  historyEntries = [],
  locale = defaultWorkbenchLocale,
  modelSettings,
  recentWorkspacePaths = [],
  onDraftGoalChange,
  onDeleteHistoryEntry,
  onDeleteRecentWorkspacePath,
  onBrowseWorkspacePath,
  onModelSettingsChange,
  onSelectHistoryEntry,
  onUseWorkspacePath,
  onWorkspacePathChange,
  onPermissionDecision,
  onRetryTask,
  onSubmitGoal,
}: JavisWorkbenchProps) {
  const effectiveLocale = {
    ...locale,
    labels: {
      ...defaultWorkbenchLocale.labels,
      ...locale.labels,
    },
  };
  const labels = effectiveLocale.labels;
  const [isActivityOpen, setIsActivityOpen] = useState(false);
  const [isInspectorOpen, setIsInspectorOpen] = useState(false);
  const [sidebarSearchQuery, setSidebarSearchQuery] = useState("");
  const [workspaceBrowseError, setWorkspaceBrowseError] = useState(false);
  const effectiveModelSettings = modelSettings ?? {
    provider: "openai",
    model: "",
    apiKey: "",
    baseUrl: "",
  };
  const filteredHistoryEntries = filterWorkbenchHistoryEntries(
    historyEntries,
    sidebarSearchQuery,
  );
  const hasHistorySearch = sidebarSearchQuery.trim().length > 0;
  const activityCount = task.logs.length + (task.permissionRequest ? 1 : 0);
  const isNewChat =
    task.status === "created" &&
    task.plan.length === 0 &&
    !task.documents &&
    !task.commands &&
    !task.fileOrganizationExecution &&
    !task.permissionRequest &&
    !task.project &&
    !task.codeReviewPreview &&
    !task.codeProposedEdit &&
    !task.codeApplyResult &&
    !task.researchReport &&
    !task.sources &&
    !task.verificationSummary;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmitGoal();
  }

  async function handleBrowseWorkspace() {
    setWorkspaceBrowseError(false);
    try {
      await onBrowseWorkspacePath?.();
    } catch {
      setWorkspaceBrowseError(true);
    }
  }

  function renderWorkspaceContext() {
    return (
      <div className="javis-workspace-context" aria-label={labels.currentWorkspace}>
        <details className="javis-workspace-menu">
          <summary title={currentWorkspacePath || labels.workspacePathPlaceholder}>
            <span className="javis-workspace-glyph">▱</span>
            <span>{formatWorkspaceName(currentWorkspacePath) || labels.currentWorkspace}</span>
            <span className="javis-workspace-chevron">⌄</span>
          </summary>
          <div className="javis-workspace-popover">
            <label>
              <span>{labels.currentWorkspace}</span>
              <input
                aria-label={labels.currentWorkspace}
                onChange={(event) => onWorkspacePathChange?.(event.currentTarget.value)}
                placeholder={labels.workspacePathPlaceholder}
                value={currentWorkspacePath}
              />
            </label>
            <div className="javis-workspace-actions">
              <button
                disabled={!currentWorkspacePath.trim()}
                onClick={() => onUseWorkspacePath?.(currentWorkspacePath)}
                type="button"
              >
                {labels.useWorkspace}
              </button>
              <button onClick={handleBrowseWorkspace} type="button">
                {labels.browseWorkspace}
              </button>
            </div>
            {workspaceBrowseError ? (
              <p role="alert">{labels.workspaceBrowseError}</p>
            ) : null}
            {recentWorkspacePaths.length > 0 ? (
              <div className="javis-workspace-recent">
                <p>{labels.recentWorkspaces}</p>
                {recentWorkspacePaths.map((path) => (
                  <div className="javis-workspace-recent-entry" key={path}>
                    <button
                      onClick={() => onUseWorkspacePath?.(path)}
                      title={path}
                      type="button"
                    >
                      {path}
                    </button>
                    <button
                      aria-label={`${labels.removeWorkspace}: ${path}`}
                      onClick={() => onDeleteRecentWorkspacePath?.(path)}
                      title={labels.removeWorkspace}
                      type="button"
                    >
                      x
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </details>
      </div>
    );
  }

  function updateModelSetting(field: keyof WorkbenchModelSettings, value: string) {
    onModelSettingsChange?.({
      ...effectiveModelSettings,
      [field]: value,
    });
  }

  function renderModelSettings() {
    return (
      <details className="javis-model-settings">
        <summary>
          <span className="javis-nav-icon">M</span>
          <span>{labels.models}</span>
        </summary>
        <div className="javis-model-settings-panel">
          <p>{labels.modelSettingsDescription}</p>
          <label>
            <span>{labels.modelProvider}</span>
            <input
              aria-label={labels.modelProvider}
              onChange={(event) => updateModelSetting("provider", event.currentTarget.value)}
              value={effectiveModelSettings.provider}
            />
          </label>
          <label>
            <span>{labels.modelName}</span>
            <input
              aria-label={labels.modelName}
              onChange={(event) => updateModelSetting("model", event.currentTarget.value)}
              placeholder="openai/gpt-5.1-codex"
              value={effectiveModelSettings.model}
            />
          </label>
          <label>
            <span>{labels.modelApiKey}</span>
            <input
              aria-label={labels.modelApiKey}
              onChange={(event) => updateModelSetting("apiKey", event.currentTarget.value)}
              type="password"
              value={effectiveModelSettings.apiKey}
            />
          </label>
          <label>
            <span>{labels.modelBaseUrl}</span>
            <input
              aria-label={labels.modelBaseUrl}
              onChange={(event) => updateModelSetting("baseUrl", event.currentTarget.value)}
              placeholder="https://api.openai.com/v1"
              value={effectiveModelSettings.baseUrl}
            />
          </label>
        </div>
      </details>
    );
  }

  return (
    <div
      className={[
        "javis-shell",
        isActivityOpen ? "activity-open" : "activity-collapsed",
        isInspectorOpen ? "inspector-open" : "inspector-collapsed",
      ].join(" ")}
    >
      <aside className="javis-sidebar">
        <div className="javis-brand">
          <span>Javis</span>
        </div>
        <label className="javis-sidebar-search">
          <span aria-hidden="true">⌕</span>
          <input
            aria-label={labels.searchPlaceholder}
            onChange={(event) => setSidebarSearchQuery(event.currentTarget.value)}
            placeholder={labels.searchPlaceholder}
            value={sidebarSearchQuery}
          />
        </label>
        <nav className="javis-nav" aria-label={labels.workspaceNavigation}>
          <div className="javis-nav-group primary">
            <div className="javis-nav-item active">
              <span className="javis-nav-icon">+</span>
              <span>{labels.newChat}</span>
            </div>
            <div className="javis-nav-item">
              <span className="javis-nav-icon">●</span>
              <span>{labels.automatedTasks}</span>
            </div>
            <div className="javis-nav-item">
              <span className="javis-nav-icon">#</span>
              <span>{labels.skillMarket}</span>
            </div>
          </div>
          <div className="javis-nav-group">
            <p className="javis-nav-section">{labels.localKnowledgeBase}</p>
            <div className="javis-nav-item">
              <span className="javis-nav-icon">▦</span>
              <span>{labels.apps}</span>
            </div>
            <div className="javis-nav-item">
              <span className="javis-nav-icon">▣</span>
              <span>{labels.documents}</span>
              <span className="javis-nav-caret">⌄</span>
            </div>
            <div className="javis-nav-item">
              <span className="javis-nav-icon">□</span>
              <span>{labels.gallery}</span>
              <span className="javis-nav-caret">⌄</span>
            </div>
            <div className="javis-nav-item">
              <span className="javis-nav-icon">▰</span>
              <span>{labels.thisComputer}</span>
              <span className="javis-nav-caret">⌄</span>
            </div>
          </div>
          <div className="javis-nav-group">
            <p className="javis-nav-section">{labels.history}</p>
            {filteredHistoryEntries.length > 0 ? (
              filteredHistoryEntries.map((entry) => (
                <div className="javis-history-entry" key={entry.id}>
                  <button
                    className="javis-history-select"
                    onClick={() => onSelectHistoryEntry?.(entry.id)}
                    type="button"
                  >
                    <span className="javis-nav-icon">◒</span>
                    <span>
                      <strong>{translateWorkbenchText(entry.title, locale)}</strong>
                      <small>
                        {translateWorkbenchText(entry.status, locale)} · {formatModifiedTime(entry.updatedAt)}
                      </small>
                    </span>
                  </button>
                  <button
                    aria-label={`${labels.deleteHistoryEntry}: ${entry.title}`}
                    className="javis-history-delete"
                    onClick={() => onDeleteHistoryEntry?.(entry.id)}
                    title={labels.deleteHistoryEntry}
                    type="button"
                  >
                    ×
                  </button>
                </div>
              ))
            ) : (
              <div className="javis-nav-item muted">
                <span className="javis-nav-icon">○</span>
                <span>{hasHistorySearch ? labels.historyNoMatches : labels.historyEmpty}</span>
              </div>
            )}
          </div>
        </nav>
        {renderModelSettings()}
        <div className="javis-sidebar-footer">
          <span className="javis-avatar">J</span>
          <span>{labels.profileName}</span>
          <span className="javis-device-mark">▯</span>
        </div>
      </aside>

      <main className={`javis-main ${isNewChat ? "new-chat" : ""}`}>
        {isNewChat ? (
          <section className="javis-new-chat" aria-label={labels.newChat}>
            <h1>{labels.newChatTitle}</h1>
            <form className="javis-new-chat-composer" onSubmit={handleSubmit}>
              <textarea
                aria-label={labels.taskInput}
                onChange={(event) => onDraftGoalChange(event.currentTarget.value)}
                placeholder={labels.taskInputPlaceholder}
                value={draftGoal}
              />
              <div className="javis-new-chat-actions">
                <button className="javis-attach-button" type="button">+</button>
                {renderWorkspaceContext()}
                <button className="javis-send-button" type="submit">{labels.send}</button>
              </div>
            </form>
          </section>
        ) : (
          <>
            <header className="javis-thread-header">
              <div>
                <p className="javis-eyebrow">{labels.mainThread}</p>
                <h1 className="javis-title">{translateWorkbenchText(task.title, locale)}</h1>
              </div>
              <div className="javis-thread-header-actions">
                {task.status === "failed" ? (
                  <button
                    className="javis-retry-button"
                    onClick={onRetryTask}
                    type="button"
                  >
                    {labels.retryTask}
                  </button>
                ) : null}
                <span className="javis-task-status">{translateWorkbenchText(task.status, locale)}</span>
              </div>
            </header>

            <section className="javis-thread" aria-label={labels.activeTask}>
              <article className="javis-message user">
                <p className="javis-message-title">{labels.user}</p>
                <p className="javis-message-body">{translateWorkbenchText(task.userGoal, locale)}</p>
              </article>
              <article className="javis-message">
                <p className="javis-message-title">{labels.commander}</p>
                <p className="javis-message-body">
                  {translateWorkbenchText(task.commanderMessage, locale)}
                </p>
              </article>

              {task.status === "failed" ? (
                <section className="javis-recovery" aria-label={labels.failedRecoveryTitle}>
                  <p className="javis-message-title">{labels.failedRecoveryTitle}</p>
                  <p>{labels.failedRecoveryMessage}</p>
                </section>
              ) : null}

              {isResearchFallbackTask(task) ? (
                <section className="javis-recovery" aria-label={labels.manualSourceFallbackTitle}>
                  <p className="javis-message-title">{labels.manualSourceFallbackTitle}</p>
                  <p>{labels.manualSourceFallbackMessage}</p>
                </section>
              ) : null}

              {task.tokenUsage ? (
                <section className="javis-token-usage" aria-label={labels.tokenUsage}>
                  <div className="javis-token-usage-header">
                    <p className="javis-message-title">{labels.tokenUsage}</p>
                    <strong>{formatTokenCount(task.tokenUsage.totalTokens)}</strong>
                  </div>
                  <div className="javis-token-grid">
                    <span>
                      {labels.tokenInput}: {formatTokenCount(task.tokenUsage.inputTokens)}
                    </span>
                    <span>
                      {labels.tokenOutput}: {formatTokenCount(task.tokenUsage.outputTokens)}
                    </span>
                    <span>
                      {labels.tokenCalls}: {formatTokenCount(task.tokenUsage.modelCalls)}
                    </span>
                  </div>
                  {task.tokenUsage.modelCalls === 0 ? (
                    <p>{labels.noModelCalls}</p>
                  ) : null}
                </section>
              ) : null}

          {task.plan.length > 0 ? (
            <section className="javis-plan" aria-label={labels.plan}>
              <p className="javis-message-title">{labels.plan}</p>
              {task.plan.map((step) => (
                <div className="javis-plan-step" key={step.id}>
                  <span className="javis-status">{translateWorkbenchText(step.status, locale)}</span>
                  <div>
                    <strong>{translateWorkbenchText(step.title, locale)}</strong>
                    {step.successCriteria ? (
                      <p>{translateWorkbenchText(step.successCriteria, locale)}</p>
                    ) : null}
                  </div>
                </div>
              ))}
            </section>
          ) : null}

          {task.documents && task.documents.length > 0 ? (
            <section className="javis-documents" aria-label={labels.markdownDocuments}>
              <p className="javis-message-title">{labels.markdownDocuments}</p>
              {task.documents.map((document) => (
                <article className="javis-document" key={document.path}>
                  <div className="javis-document-row">
                    <strong>{document.path}</strong>
                    <span>{formatSize(document.sizeBytes)}</span>
                  </div>
                  <p>{translateWorkbenchText(document.purpose, locale)}</p>
                  {document.excerpt ? <p>{translateWorkbenchText(document.excerpt, locale)}</p> : null}
                  <span>
                    {labels.modified}: {formatModifiedTime(document.modifiedAt)}
                  </span>
                </article>
              ))}
            </section>
          ) : null}

          {task.commands && task.commands.length > 0 ? (
            <section className="javis-documents" aria-label={labels.commandResults}>
              <p className="javis-message-title">{labels.commandResults}</p>
              {task.commands.map((command) => (
                <article className="javis-document" key={command.command}>
                  <div className="javis-document-row">
                    <strong>{command.command}</strong>
                    <span>exit: {command.exitCode ?? labels.unknown}</span>
                  </div>
                  <p>{command.stdout || command.stderr || labels.emptyOutput}</p>
                  <span>cwd: {command.cwd}</span>
                </article>
              ))}
            </section>
          ) : null}

          {task.codeReviewPreview ? (
            <section className="javis-documents" aria-label={labels.codeReview}>
              <p className="javis-message-title">{labels.codeReview}</p>
              <article className="javis-document">
                <div className="javis-document-row">
                  <strong>{task.codeReviewPreview.workspacePath}</strong>
                  <span>
                    {labels.changedFiles}: {task.codeReviewPreview.changedFiles.length}
                  </span>
                </div>
                {task.codeReviewPreview.diffStat ? (
                  <p>{task.codeReviewPreview.diffStat}</p>
                ) : (
                  <p>{labels.emptyOutput}</p>
                )}
              </article>
              {task.codeReviewPreview.changedFiles.map((file) => (
                <article className="javis-document" key={file}>
                  <div className="javis-document-row">
                    <strong>{file}</strong>
                    <span>{labels.changedFiles}</span>
                  </div>
                </article>
              ))}
              <article className="javis-document">
                <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {task.codeReviewPreview.diff || labels.emptyOutput}
                </pre>
              </article>
            </section>
          ) : null}

          {task.codeProposedEdit ? (
            <section className="javis-documents" aria-label={translateWorkbenchText("Code Agent patch proposal", locale)}>
              <p className="javis-message-title">
                {translateWorkbenchText("Code Agent patch proposal", locale)}
              </p>
              <article className="javis-document">
                <div className="javis-document-row">
                  <strong>{task.codeProposedEdit.workspacePath}</strong>
                  <span>
                    {labels.changedFiles}: {task.codeProposedEdit.changedFiles.length}
                  </span>
                </div>
                <p>{translateWorkbenchText(task.codeProposedEdit.summary, locale)}</p>
              </article>
              {task.codeProposedEdit.changedFiles.map((file) => (
                <article className="javis-document" key={file}>
                  <div className="javis-document-row">
                    <strong>{file}</strong>
                    <span>{translateWorkbenchText("proposed", locale)}</span>
                  </div>
                </article>
              ))}
              <article className="javis-document">
                <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {task.codeProposedEdit.patch || labels.emptyOutput}
                </pre>
              </article>
            </section>
          ) : null}

          {task.codeApplyResult ? (
            <section className="javis-documents" aria-label={translateWorkbenchText("Code Agent apply result", locale)}>
              <p className="javis-message-title">
                {translateWorkbenchText("Code Agent apply result", locale)}
              </p>
              <article className="javis-document">
                <div className="javis-document-row">
                  <strong>
                    {translateWorkbenchText(task.codeApplyResult.applied ? "applied" : "not applied", locale)}
                  </strong>
                  <span>
                    {labels.changedFiles}: {task.codeApplyResult.changedFiles.length}
                  </span>
                </div>
                <p>{translateWorkbenchText(task.codeApplyResult.message, locale)}</p>
              </article>
            </section>
          ) : null}

          {task.project ? (
            <section className="javis-documents" aria-label={labels.projectInspection}>
              <p className="javis-message-title">{labels.projectInspection}</p>
              <article className="javis-document">
                <div className="javis-document-row">
                  <strong>{task.project.workspacePath}</strong>
                  <span>{task.project.packageManager ?? labels.unknownManager}</span>
                </div>
                <p>Start: {task.project.recommendedStartCommand ?? translateWorkbenchText("not found", locale)}</p>
                <p>
                  {labels.testCheck}:{" "}
                  {task.project.recommendedTestCommand ?? translateWorkbenchText("not found", locale)}
                </p>
              </article>
              {task.project.scripts.map((script) => (
                <article className="javis-document" key={script.name}>
                  <div className="javis-document-row">
                    <strong>{script.name}</strong>
                    <span>{labels.packageScript}</span>
                  </div>
                  <p>{script.command}</p>
                </article>
              ))}
            </section>
          ) : null}

          {task.permissionRequest ? (
            <section className="javis-confirmation" aria-label={translateWorkbenchText("Permission request", locale)}>
              <div className="javis-confirmation-header">
                <div>
                  <p className="javis-message-title">
                    {translateWorkbenchText(task.permissionRequest.title, locale)}
                  </p>
                  <p className="javis-message-body">
                    {translateWorkbenchText(task.permissionRequest.reason, locale)}
                  </p>
                </div>
                <span className="javis-status">
                  {translateWorkbenchText(task.permissionRequest.level, locale)}
                </span>
              </div>
              <p className="javis-message-body">
                {translateWorkbenchText(task.permissionRequest.dryRun.operation, locale)}
              </p>
              <p className="javis-agent-task">
                {translateWorkbenchText(task.permissionRequest.dryRun.riskSummary, locale)}
              </p>
              <div className="javis-dry-run-list">
                {task.permissionRequest.dryRun.affectedPaths.map((path) => (
                  <article className="javis-dry-run-item" key={`${path.source}-${path.target}`}>
                    <strong>{translateWorkbenchText(path.action, locale)}</strong>
                    <p>{path.source}</p>
                    <p>{path.target}</p>
                    {path.conflict ? (
                      <span>{translateWorkbenchText(path.conflict, locale)}</span>
                    ) : null}
                  </article>
                ))}
              </div>
              <div className="javis-confirmation-actions">
                <button
                  disabled={task.permissionRequest.status !== "pending"}
                  onClick={() => onPermissionDecision?.("approved")}
                  type="button"
                >
                  {labels.approve}
                </button>
                <button
                  disabled={task.permissionRequest.status !== "pending"}
                  onClick={() => onPermissionDecision?.("denied")}
                  type="button"
                >
                  {labels.deny}
                </button>
                <span>
                  {labels.status}: {translateWorkbenchText(task.permissionRequest.status, locale)}
                </span>
              </div>
              {task.permissionRequest.status === "denied" ? (
                <p className="javis-agent-task">
                  {translateWorkbenchText("No write operation executed", locale)}
                </p>
              ) : null}
            </section>
          ) : null}

          {task.fileOrganizationExecution ? (
            <section className="javis-documents" aria-label={labels.fileOrganizationResult}>
              <p className="javis-message-title">{labels.fileOrganizationResult}</p>
              <article className="javis-document">
                <div className="javis-document-row">
                  <strong>
                    {translateWorkbenchText(
                      `${task.fileOrganizationExecution.attemptedCount} planned operation(s)`,
                      locale,
                    )}
                  </strong>
                  <span>
                    {translateWorkbenchText(`${task.fileOrganizationExecution.movedCount} moved`, locale)} /
                    {translateWorkbenchText(` ${task.fileOrganizationExecution.skippedCount} skipped`, locale)} /
                    {translateWorkbenchText(` ${task.fileOrganizationExecution.failedCount} failed`, locale)}
                  </span>
                </div>
              </article>
              {task.fileOrganizationExecution.results.map((result) => (
                <article className="javis-document" key={`${result.source}-${result.target}`}>
                  <div className="javis-document-row">
                    <strong>{translateWorkbenchText(result.status, locale)}</strong>
                    <span>{translateWorkbenchText(result.message, locale)}</span>
                  </div>
                  <p>{result.source}</p>
                  <p>{result.target}</p>
                </article>
              ))}
            </section>
          ) : null}

          {task.sources && task.sources.length > 0 ? (
            <section className="javis-documents" aria-label={labels.researchSources}>
              <p className="javis-message-title">{labels.researchSources}</p>
              {task.sources.map((source) => (
                <article className="javis-document" key={source.url}>
                  <div className="javis-document-row">
                    <strong>{translateWorkbenchText(source.title || source.url, locale)}</strong>
                    <span>{formatModifiedTime(source.fetchedAt)}</span>
                  </div>
                  <p>{translateWorkbenchText(source.excerpt, locale)}</p>
                  <span>{source.url}</span>
                  {source.provider ? <span>{source.provider}</span> : null}
                </article>
              ))}
            </section>
          ) : null}

          {task.researchReport ? (
            <section className="javis-documents" aria-label={labels.researchReport}>
              <p className="javis-message-title">
                {translateWorkbenchText(task.researchReport.title, locale)}
              </p>
              <article className="javis-document">
                <p>{translateWorkbenchText(task.researchReport.summary, locale)}</p>
              </article>
              {task.researchReport.rows.map((row) => (
                <article className="javis-document" key={row.sourceUrl}>
                  <div className="javis-document-row">
                    <strong>{translateWorkbenchText(row.claim, locale)}</strong>
                    <span>{labels.source}</span>
                  </div>
                  <p>{translateWorkbenchText(row.evidence, locale)}</p>
                  <span>{row.sourceUrl}</span>
                </article>
              ))}
              {task.researchReport.unknowns.map((unknown) => (
                <article className="javis-document" key={unknown}>
                  <div className="javis-document-row">
                    <strong>{labels.unknown}</strong>
                    <span>{labels.unverified}</span>
                  </div>
                  <p>{translateWorkbenchText(unknown, locale)}</p>
                </article>
              ))}
            </section>
          ) : null}

          {task.verificationSummary ? (
            <article className="javis-message">
              <p className="javis-message-title">{labels.verifier}</p>
              <p className="javis-message-body">
                {translateWorkbenchText(task.verificationSummary, locale)}
              </p>
            </article>
          ) : null}
        </section>

        <form className="javis-composer" onSubmit={handleSubmit}>
          <textarea
            aria-label={labels.taskInput}
            onChange={(event) => onDraftGoalChange(event.currentTarget.value)}
            placeholder={labels.taskInputPlaceholder}
            value={draftGoal}
          />
          <div className="javis-composer-actions">
            {renderWorkspaceContext()}
            <button type="submit">{labels.send}</button>
          </div>
        </form>
          </>
        )}
      </main>

      <aside className="javis-inspector" aria-label={labels.agentContextInspector}>
        <button
          aria-controls="javis-inspector-panel"
          aria-expanded={isInspectorOpen}
          className="javis-inspector-toggle"
          onClick={() => setIsInspectorOpen((current) => !current)}
          type="button"
        >
          <span>{labels.agentGraph}</span>
          <span className="javis-activity-count">{task.agents.length}</span>
          <span>{isInspectorOpen ? labels.collapseInspector : labels.expandInspector}</span>
        </button>
        {isInspectorOpen ? (
          <div className="javis-inspector-panel" id="javis-inspector-panel">
            <header className="javis-inspector-header">
              <p className="javis-eyebrow">{labels.agentContextInspector}</p>
              <h2 className="javis-title">{labels.agentGraph}</h2>
            </header>
            <section className="javis-agent-list" aria-label={labels.agentStates}>
              {task.agents.map((agent) => (
                <article className="javis-agent" key={agent.id}>
                  <div className="javis-agent-row">
                    <span className="javis-agent-name">
                      {translateWorkbenchText(agent.name, locale)}
                    </span>
                    <span className="javis-status">
                      {translateWorkbenchText(agent.status, locale)}
                    </span>
                  </div>
                  <p className="javis-agent-task">{translateWorkbenchText(agent.role, locale)}</p>
                  <p className="javis-agent-task">{translateWorkbenchText(agent.task, locale)}</p>
                </article>
              ))}
            </section>
          </div>
        ) : null}
      </aside>

      <section className="javis-activity" aria-label={labels.activityLog}>
        <button
          aria-controls="javis-activity-panel"
          aria-expanded={isActivityOpen}
          className="javis-activity-toggle"
          onClick={() => setIsActivityOpen((current) => !current)}
          type="button"
        >
          <span>{labels.activityLog}</span>
          <span className="javis-activity-count">{activityCount}</span>
          <span>{isActivityOpen ? labels.collapseActivityLog : labels.expandActivityLog}</span>
        </button>
        {isActivityOpen ? (
          <div className="javis-activity-panel" id="javis-activity-panel">
            <header className="javis-activity-header">
              <p className="javis-eyebrow">{labels.activityLog}</p>
              <h2 className="javis-title">{labels.executionTimeline}</h2>
            </header>
            <div className="javis-activity-list">
              {task.permissionRequest ? (
                <article className="javis-log javis-log-confirmation">
                  <div className="javis-log-row">
                    <strong>{translateWorkbenchText(task.permissionRequest.title, locale)}</strong>
                    <span className="javis-log-kind">
                      {translateWorkbenchText(task.permissionRequest.status, locale)}
                    </span>
                  </div>
                  <p className="javis-log-detail">
                    {translateWorkbenchText(
                      `${task.permissionRequest.dryRun.affectedPaths.length} planned path operation(s) require ${task.permissionRequest.level}.`,
                      locale,
                    )}
                  </p>
                  <div className="javis-confirmation-actions compact">
                    <button
                      disabled={task.permissionRequest.status !== "pending"}
                      onClick={() => onPermissionDecision?.("approved")}
                      type="button"
                    >
                      {labels.approve}
                    </button>
                    <button
                      disabled={task.permissionRequest.status !== "pending"}
                      onClick={() => onPermissionDecision?.("denied")}
                      type="button"
                    >
                      {labels.deny}
                    </button>
                  </div>
                </article>
              ) : null}
              {task.logs.map((log) => (
                <article className="javis-log" key={log.id}>
                  <div className="javis-log-row">
                    <strong>{translateWorkbenchText(log.title, locale)}</strong>
                    <span className="javis-log-kind">
                      {translateWorkbenchText(log.kind, locale)}
                    </span>
                  </div>
                  <p className="javis-log-detail">
                    {translateWorkbenchText(log.detail, locale)}
                  </p>
                </article>
              ))}
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function formatSize(sizeBytes: number) {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatWorkspaceName(path: string) {
  const normalizedPath = path.trim().replace(/[\\/]+$/, "");
  if (!normalizedPath) {
    return "";
  }

  const parts = normalizedPath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? normalizedPath;
}

function formatTokenCount(value: number) {
  return new Intl.NumberFormat().format(value);
}

function isResearchFallbackTask(task: WorkbenchTask): boolean {
  if (task.status !== "failed") {
    return false;
  }

  const researchText = [
    task.title,
    task.commanderMessage,
    task.verificationSummary ?? "",
  ].join(" ");
  return /\bResearch\b/i.test(researchText);
}

export function filterWorkbenchHistoryEntries(
  entries: WorkbenchHistoryEntry[],
  query: string,
): WorkbenchHistoryEntry[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return entries;
  }

  return entries.filter((entry) => {
    const searchableText = [
      entry.title,
      entry.status,
      entry.userGoal,
      entry.updatedAt,
    ].join(" ");
    return searchableText.toLocaleLowerCase().includes(normalizedQuery);
  });
}

function formatModifiedTime(modifiedAt: string) {
  const date = new Date(modifiedAt);
  if (!Number.isNaN(date.getTime())) {
    return date.toLocaleString();
  }

  const seconds = Number(modifiedAt);
  if (!Number.isFinite(seconds)) {
    return modifiedAt;
  }
  return new Date(seconds * 1000).toLocaleString();
}

function translateWorkbenchText(value: string, locale: WorkbenchLocale): string {
  const phrases = locale.phrases;
  if (!phrases) {
    return value;
  }
  const trimmed = value.trim();
  const leadingSpace = value.startsWith(" ") ? " " : "";
  if (phrases[trimmed]) {
    return leadingSpace + phrases[trimmed];
  }

  return translateWorkbenchPattern(value);
}

function translateWorkbenchPattern(value: string): string {
  return value
    .replace(/\bnot found\b/g, "未找到")
    .replace(/\bverified\b/g, "已验证")
    .replace(/\bfailed\b/g, "失败")
    .replace(/\bskipped\b/g, "已跳过")
    .replace(/\bmoved\b/g, "已移动")
    .replace(/\bplanned operation\(s\)\b/g, "项计划操作")
    .replace(/\bplanned path operation\(s\) require\b/g, "项计划路径操作需要")
    .replace(/\brequire confirmed_write\b/g, "需要确认写入授权")
    .replace(/\bsource\(s\)\b/g, "个来源")
    .replace(/\bdocument records\b/g, "条文档记录")
    .replace(/\bdocuments\b/g, "个文档")
    .replace(/\brecords\b/g, "条记录")
    .replace(/\bcommands\b/g, "条命令")
    .replace(/\bclaims verified\b/g, "条主张已验证")
    .replace(/\bTask finished\b/g, "任务已完成")
    .replace(/\bPlan submitted\b/g, "计划已提交")
    .replace(/\bWaiting for verification\b/g, "等待验证")
    .replace(/\bNo file scan needed\b/g, "无需文件扫描")
    .replace(/\bRead-only scan completed\b/g, "只读扫描已完成")
    .replace(/\bSource collection completed\b/g, "来源收集已完成")
    .replace(/\bChecking exit codes\b/g, "检查退出码")
    .replace(/\bChecking source evidence\b/g, "检查来源证据")
    .replace(/\bChecking document result fields\b/g, "检查文档结果字段")
    .replace(/\bNo result to verify\b/g, "没有可验证结果")
    .replace(/\bNo source to verify\b/g, "没有可验证来源")
    .replace(/\bScan failed\b/g, "扫描失败")
    .replace(/\bVerification failed\b/g, "验证失败")
    .replace(/\bDry-run failed\b/g, "预演失败")
    .replace(/\bExecution tool unavailable\b/g, "执行工具不可用")
    .replace(/\bApproved move failed\b/g, "已批准移动失败")
    .replace(/\bPermission decision recorded\b/g, "授权决定已记录")
    .replace(/\bNo write operation executed\b/g, "未执行写入操作")
    .replace(/\bWaiting for user approval\b/g, "等待用户批准")
    .replace(/\bWaiting for permission decision\b/g, "等待授权决定")
    .replace(/\bWaiting for dry-run evidence\b/g, "等待预演证据")
    .replace(/\bWaiting for move results\b/g, "等待移动结果")
    .replace(/\bWaiting for command results\b/g, "等待命令结果")
    .replace(/\bWaiting for source evidence\b/g, "等待来源证据")
    .replace(/\bWaiting for file scan results\b/g, "等待文件扫描结果")
    .replace(/\bWaiting for project inspection\b/g, "等待项目检查")
    .replace(/\bWaiting for file\.scanMarkdownDocuments\b/g, "等待 file.scanMarkdownDocuments")
    .replace(/\bCreate document scan plan\b/g, "创建文档扫描计划")
    .replace(/\bCreate project inspection plan\b/g, "创建项目检查计划")
    .replace(/\bCreate research source plan\b/g, "创建研究来源计划")
    .replace(/\bCreate dry-run plan\b/g, "创建预演计划")
    .replace(/\bCreating PDF organization dry-run\b/g, "创建 PDF 整理预演")
    .replace(/\bExecuting approved PDF moves\b/g, "执行已批准的 PDF 移动")
    .replace(/\bRunning read-only Markdown scan\b/g, "运行只读 Markdown 扫描")
    .replace(/\bRunning node\/pnpm\/git read-only checks\b/g, "运行 node/pnpm/git 只读检查")
    .replace(/\bInspecting package scripts\b/g, "检查包脚本")
    .replace(/\bFetching public URL sources\b/g, "获取公开 URL 来源")
    .replace(/\bSource fetch failed\b/g, "来源获取失败")
    .replace(/\bDocument scan and summaries completed\b/g, "文档扫描与摘要已完成")
    .replace(/\bRead-only command checks completed\b/g, "只读命令检查已完成")
    .replace(/\bpermission\.requested\b/g, "permission.requested")
    .replace(/\bpermission\.resolved\b/g, "permission.resolved")
    .replace(/\btask\.created\b/g, "task.created")
    .replace(/\btask\.completed\b/g, "task.completed")
    .replace(/\btask\.failed\b/g, "task.failed")
    .replace(/\btask\.plan_updated\b/g, "task.plan_updated")
    .replace(/\btool_call\.planned\b/g, "tool_call.planned")
    .replace(/\btool_call\.updated\b/g, "tool_call.updated")
    .replace(/\bverification\.started\b/g, "verification.started")
    .replace(/\bverification\.completed\b/g, "verification.completed")
    .replace(/\bverification\.failed\b/g, "verification.failed")
    .replace(
      /\bJavis desktop is ready\. Enter a goal to start the Core event stream\./g,
      "Javis 桌面端已就绪。输入目标即可启动核心事件流。",
    )
    .replace(
      /\bCore runtime is ready for startTask\./g,
      "核心运行时已就绪，可以开始任务。",
    )
    .replace(/\bMoving files changes the local filesystem, so Javis needs explicit approval\./g, "移动文件会更改本地文件系统，因此 Javis 需要明确授权。")
    .replace(/\bApprove PDF move plan\b/g, "批准 PDF 移动计划")
    .replace(/\bOrganize PDF files by filename topic\b/g, "按文件名主题整理 PDF 文件")
    .replace(/\bTarget file already exists\./g, "目标文件已存在。")
    .replace(/\bOnly PDF files can be moved\./g, "只能移动 PDF 文件。")
    .replace(/\bParent directory traversal is not allowed\./g, "不允许父目录穿越。")
    .replace(/\bSource and target must both stay inside Downloads\./g, "源路径和目标路径都必须位于下载目录内。")
    .replace(/\bOnly move operations are supported\./g, "仅支持移动操作。")
    .replace(/\bSource cannot be read:/g, "无法读取源文件：");
}
