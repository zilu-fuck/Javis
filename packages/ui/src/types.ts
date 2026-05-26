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
  apiKeyReference: string;
  baseUrl: string;
}

export interface WorkbenchHistoryEntry {
  id: string;
  title: string;
  status: string;
  userGoal: string;
  updatedAt: string;
  scheduledTaskId?: string;
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
  streamingText?: string;
  isStreaming?: boolean;
}

export type ActiveView =
  | "chat"
  | "automated"
  | "skills"
  | "apps"
  | "documents"
  | "gallery"
  | "computer";

export interface WorkbenchScheduledTask {
  id: string;
  name: string;
  goal: string;
  scheduleType: string;
  scheduleValue: string;
  enabled: boolean;
  nextRunAt: string;
  lastRunStatus: "running" | "success" | "failed" | "never";
  createdAt: string;
}

export interface WorkbenchSkillEntry {
  id: string;
  name: string;
  description: string;
  category: "tool" | "agent" | "mcp";
  permissionLevel?: string;
  agentOwners: string[];
  enabled: boolean;
}

export interface WorkbenchFileEntry {
  name: string;
  path: string;
  isDir: boolean;
  sizeBytes?: number;
  modifiedAt?: string;
  extension?: string;
}

export interface WorkbenchAppEntry {
  name: string;
  path: string;
  iconPath?: string;
  publisher?: string;
  installLocation?: string;
}

export interface JavisWorkbenchProps {
  task: WorkbenchTask;
  draftGoal: string;
  currentWorkspacePath?: string;
  historyEntries?: WorkbenchHistoryEntry[];
  locale?: WorkbenchLocale;
  modelSettings?: WorkbenchModelSettings;
  recentWorkspacePaths?: string[];
  activeView?: ActiveView;
  scheduledTasks?: WorkbenchScheduledTask[];
  skillEntries?: WorkbenchSkillEntry[];
  installedApps?: WorkbenchAppEntry[];
  userDocuments?: WorkbenchFileEntry[];
  userImages?: WorkbenchFileEntry[];
  computerEntries?: WorkbenchFileEntry[];
  computerPath?: string;
  isTaskActive?: boolean;
  appsLoading?: boolean;
  docsLoading?: boolean;
  imagesLoading?: boolean;
  computerLoading?: boolean;
  appsError?: string;
  docsError?: string;
  imagesError?: string;
  computerError?: string;
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
  onSubmitGoal: (goal?: string, workspacePath?: string, scheduledTaskId?: string) => void;
  onChangeActiveView?: (view: ActiveView) => void;
  onToggleScheduledTask?: (id: string) => void;
  onDeleteScheduledTask?: (id: string) => void;
  onRefreshApps?: () => void;
  onRefreshDocuments?: () => void;
  onRefreshImages?: () => void;
  onNavigateDirectory?: (path: string) => void;
  onOpenFile?: (path: string) => void;
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
    modelBackendUnavailable?: string;
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
    automatedTasksTitle: string;
    scheduledTaskEnabled: string;
    scheduledTaskDisabled: string;
    scheduledTaskNextRun: string;
    scheduledTaskLastRun: string;
    skillMarketTitle: string;
    skillCategoryTool: string;
    skillCategoryAgent: string;
    skillCategoryMcp: string;
    noMcpConfig: string;
    skillUiFeatureLabel: string;
    appsTitle: string;
    documentsTitle: string;
    galleryTitle: string;
    computerTitle: string;
    fileExplorerBreadcrumb: string;
    fileExplorerEmpty: string;
    scanInProgress: string;
    scanComplete: string;
    noAppsFound: string;
    noDocumentsFound: string;
    noImagesFound: string;
    noScheduledTasks: string;
    scanFailed: string;
    retry: string;
  };
  phrases?: Record<string, string>;
}
