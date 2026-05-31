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

export interface WorkbenchAskUserQuestion {
  id: string;
  question: string;
  choices?: string[];
  status: string;
  answer?: string;
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

export type WorkbenchStreamingAgentKind =
  | "commander"
  | "file"
  | "shell"
  | "browser"
  | "computer"
  | "scheduler"
  | "research"
  | "code"
  | "verifier"
  | "workspace"
  | "vision"
  | "chinese-reviewer";

export interface WorkbenchModelSettings {
  provider: string;
  model: string;
  apiKey: string;
  apiKeyReference: string;
  baseUrl: string;
}

/** The three built-in model slots. */
export type WorkbenchModelSlot = "primary" | "secondary" | "multimodal";

/** A named model configuration for the UI. */
export interface WorkbenchModelProfile {
  id: string;
  slot: WorkbenchModelSlot | null;
  displayName: string;
  provider: string;
  model: string;
  apiKeyReference: string;
  baseUrl: string;
  apiKey: string;  // only used in UI, never persisted
  /** Whether an API key is already stored in the OS credential store for this profile. */
  hasStoredApiKey?: boolean;
  capabilities: {
    vision: boolean;
    code: boolean;
    longContext: boolean;
  };
}

/** Full model configuration for the UI. */
export interface WorkbenchModelConfiguration {
  profiles: WorkbenchModelProfile[];
  agentOverrides: Record<string, string>;
}

export interface WorkbenchHistoryEntry {
  id: string;
  title: string;
  status: string;
  userGoal: string;
  updatedAt: string;
  originMode?: "chat" | "project";
  workspacePath?: string;
  scheduledTaskId?: string;
}

export interface WorkbenchChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface WorkbenchTask {
  id?: string;
  title: string;
  userGoal: string;
  status: string;
  originMode?: "chat" | "project";
  workspacePath?: string;
  commanderMessage: string;
  plan: WorkbenchStep[];
  agents: WorkbenchAgent[];
  logs: WorkbenchLogEntry[];
  documents?: WorkbenchDocument[];
  commands?: WorkbenchCommand[];
  fileOrganizationExecution?: WorkbenchFileOrganizationExecution;
  permissionRequest?: WorkbenchPermissionRequest;
  askUserQuestion?: WorkbenchAskUserQuestion;
  project?: WorkbenchProject;
  codeReviewPreview?: WorkbenchCodeReviewPreview;
  codeProposedEdit?: WorkbenchCodeProposedEdit;
  codeApplyResult?: WorkbenchCodeApplyResult;
  researchReport?: WorkbenchResearchReport;
  sources?: WorkbenchSource[];
  tokenUsage?: WorkbenchTokenUsageSummary;
  verificationSummary?: string;
  conversationMessages?: WorkbenchChatMessage[];
  streamingText?: string;
  streamingAgentKind?: WorkbenchStreamingAgentKind;
  isStreaming?: boolean;
}

/** View identifier. Built-in values: "chat" | "automated" | "skills" | "apps" | "documents" | "gallery" | "computer". Workspace definitions may register additional view IDs. */
export type ActiveView = string;
export type WorkbenchSkillPage = "mine" | "market";

export interface SidebarNavSubItem {
  label: string;
  path?: string;
  viewId?: ActiveView;
  mode?: "chat" | "project";
  skillPage?: WorkbenchSkillPage;
  badge?: number;
}

export interface SidebarNavItem {
  viewId: string;
  icon: string;
  label: string;
  group: "primary" | "knowledge" | "custom";
  groupLabel?: string;
  order: number;
  badge?: number;
  /** If true, renders as a collapsible nav item with subitems. */
  collapsible?: boolean;
  subitems?: SidebarNavSubItem[];
}

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

export type WorkbenchSkillSearchKind = "skill" | "mcp";
export type WorkbenchSkillSearchSource = "github";

export interface WorkbenchSkillSearchResult {
  id: string;
  title: string;
  description: string;
  url: string;
  source: WorkbenchSkillSearchSource | string;
  kind: WorkbenchSkillSearchKind;
}

export interface WorkbenchDetailItem {
  title: string;
  description?: string;
  kind?: string;
  source?: string;
  url?: string;
  metadata?: Array<{ label: string; value: string }>;
}

export interface WorkbenchFileEntry {
  name: string;
  path: string;
  isDir: boolean;
  sizeBytes?: number;
  modifiedAt?: string;
  extension?: string;
  category?: string;
  tags?: string[];
  confidence?: number;
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
  modelConfiguration?: WorkbenchModelConfiguration;
  recentWorkspacePaths?: string[];
  activeView?: ActiveView;
  activeHistoryEntryId?: string;
  scheduledTasks?: WorkbenchScheduledTask[];
  skillEntries?: WorkbenchSkillEntry[];
  skillTranslationStatus?: "idle" | "translating" | "error";
  skillTranslationError?: string | null;
  skillSearchResults?: WorkbenchSkillSearchResult[];
  skillSearchStatus?: "idle" | "searching" | "error";
  mcpConfigError?: string | null;
  /** Custom sidebar navigation items. Merged with built-in defaults. */
  sidebarNavItems?: SidebarNavItem[];
  installedApps?: WorkbenchAppEntry[];
  userDocuments?: WorkbenchFileEntry[];
  userImages?: WorkbenchFileEntry[];
  computerEntries?: WorkbenchFileEntry[];
  computerPath?: string;
  mountRoots?: { name: string; path: string }[];
  isTaskActive?: boolean;
  appsLoading?: boolean;
  docsLoading?: boolean;
  imagesLoading?: boolean;
  computerLoading?: boolean;
  appsError?: string;
  docsError?: string;
  imagesError?: string;
  computerError?: string;
  // ── File classification ─────────────────────────────────────────
  scanning?: boolean;
  scanProgress?: { current: number; total: number };
  classifying?: boolean;
  classifyProgress?: { completed: number; total: number };
  categoryStats?: { category: string; count: number }[];
  onRefreshScan?: () => void;
  onClassifyDocuments?: () => void;
  onCancelClassify?: () => void;
  onDraftGoalChange: (nextGoal: string) => void;
  onDeleteHistoryEntry?: (id: string) => void;
  onDeleteRecentWorkspacePath?: (path: string) => void;
  onBrowseWorkspacePath?: () => void;
  onModelSettingsChange?: (settings: WorkbenchModelSettings) => void;
  onTestModelConnection?: (settings: WorkbenchModelSettings) => Promise<string | void>;
  onModelConfigurationChange?: (config: WorkbenchModelConfiguration) => void;
  onSaveProviderApiKey?: (keyReference: string, apiKey: string) => void;
  onSelectHistoryEntry?: (id: string) => void;
  onUseWorkspacePath?: (path: string) => void;
  onWorkspacePathChange?: (path: string) => void;
  onPermissionDecision?: (decision: "approved" | "denied") => void;
  onAskUserAnswer?: (answer: string) => void;
  onRetryTask?: () => void;
  onStopTask?: () => void;
  onSubmitGoal: (goal?: string, workspacePath?: string, scheduledTaskId?: string) => void;
  onTranslateSkillsToChinese?: () => void;
  onSearchSkillMarket?: (
    query: string,
    source: WorkbenchSkillSearchSource,
    kind: WorkbenchSkillSearchKind,
  ) => void;
  onOpenDetail?: (detail: WorkbenchDetailItem) => void;
  onChangeActiveView?: (view: ActiveView) => void;
  onSelectComposeMode?: (mode: "chat" | "project") => void;
  activeComposeMode?: "chat" | "project";
  onToggleScheduledTask?: (id: string) => void;
  onDeleteScheduledTask?: (id: string) => void;
  onRefreshApps?: () => void;
  onRefreshDocuments?: () => void;
  onRefreshImages?: () => void;
  onNavigateDirectory?: (path: string) => void;
  onListDirectory?: (path: string) => Promise<WorkbenchFileEntry[]>;
  onOpenFile?: (path: string) => void;
  onSidebarWidthChange?: (width: number) => void;
  onActiveViewChange?: (view: ActiveView) => void;
  onActivityOpenChange?: (open: boolean) => void;
  onInspectorOpenChange?: (open: boolean) => void;
  initialSidebarWidth?: number;
  initialIsActivityOpen?: boolean;
  initialIsInspectorOpen?: boolean;
}

export interface WorkbenchLocale {
  categoryLabels?: Record<string, string>;
  labels: {
    activeTask: string;
    activityLog: string;
    addPhotosAndFiles: string;
    addedAttachments: string;
    accountSettings: string;
    aiModeSettings: string;
    apps: string;
    askUserQuestion: string;
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
    closeSettings: string;
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
    generalSettings: string;
    history: string;
    historyEmpty: string;
    historyEmptyGroup: string;
    historyNoMatches: string;
    expandHistoryGroup: string;
    hideProcessDetails: string;
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
    moreInputOptions: string;
    newChat: string;
    newChatTitle: string;
    chatNewChatTitle: string;
    chat: string;
    office: string;
    packageScript: string;
    plan: string;
    planMode: string;
    plugins: string;
    projectInspection: string;
    project: string;
    processDetails: string;
    projects: string;
    profileName: string;
    researchReport: string;
    researchSources: string;
    retryTask: string;
    send: string;
    stopTask: string;
    submitAnswer: string;
    searchPlaceholder: string;
    settings: string;
    settingsPlaceholder: string;
    showProcessDetails: string;
    skillMarket: string;
    source: string;
    status: string;
    taskInput: string;
    taskInputPlaceholder: string;
    chatTaskInputPlaceholder: string;
    testCheck: string;
    thisComputer: string;
    tokenUsage: string;
    tokenInput: string;
    tokenOutput: string;
    tokenCalls: string;
    contextWindow: string;
    contextUsed: string;
    contextRemaining: string;
    contextBreakdown: string;
    noModelCalls: string;
    unknown: string;
    unknownManager: string;
    unverified: string;
    user: string;
    verifier: string;
    workspaceNavigation: string;
    sidebarResize: string;
    browseWorkspace: string;
    currentWorkspace: string;
    recentWorkspaces: string;
    removeAttachment: string;
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
    mcpLoadError?: string;
    skillUiFeatureLabel: string;
    privacySecuritySettings: string;
    aboutFeedbackSettings: string;
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
    unknownView: string;
    kbDocRecognition: string;
    kbCourseware: string;
    kbBooks: string;
    kbPapers: string;
    kbImageRecognition: string;
    kbPeopleImpressions: string;
    kbFootprintLocations: string;
    kbTimelineGallery: string;
    kbSystemDrive: string;
    kbDriveE: string;
    kbDriveF: string;
    kbDriveG: string;
    classifyButton: string;
    cancelClassify: string;
    classifyProgress: string;
    classifyFailed: string;
    allCategories: string;
    categoryBadge: string;
    confidenceLabel: string;
  };
  phrases?: Record<string, string>;
}
