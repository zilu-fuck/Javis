export type PermissionLevel = "read" | "preview" | "confirmed_write" | "dangerous";

/** Risk classification for confirmed_write operations. */
export type WriteRiskLevel = "safe" | "risky" | "dangerous";

/** Human-readable risk labels (bilingual). */
export const WRITE_RISK_LABELS: Record<WriteRiskLevel, { en: string; zhCN: string }> = {
  safe:       { en: "Safe",       zhCN: "安全" },
  risky:      { en: "Risky",      zhCN: "需注意" },
  dangerous:  { en: "Dangerous",  zhCN: "危险" },
};

export interface MarkdownDocument {
  path: string;
  modifiedAt: string;
  sizeBytes: number;
  heading?: string;
  excerpt?: string;
}

export interface MarkdownDocumentSummary extends MarkdownDocument {
  purpose: string;
}

export interface LocalFileEntry {
  name: string;
  path: string;
  isDir: boolean;
  sizeBytes?: number;
  modifiedAt?: string;
  extension?: string;
}

export interface InstalledAppEntry {
  name: string;
  path: string;
  iconPath?: string;
  publisher?: string;
  installLocation?: string;
}

export interface PlannedPathOperation {
  source: string;
  target: string;
  action: "move" | "copy" | "create" | "modify" | "delete" | "overwrite";
  conflict?: string;
}

export interface DryRunSummary {
  operation: string;
  affectedPaths: PlannedPathOperation[];
  riskSummary: string;
  reversible: boolean;
}

export interface PermissionRequest {
  id: string;
  level: Exclude<PermissionLevel, "read">;
  /** Risk classification for confirmed_write operations. */
  writeRiskLevel?: WriteRiskLevel;
  title: string;
  reason: string;
  dryRun: DryRunSummary;
  bindingHash?: string;
  status: "pending" | "approved" | "denied" | "expired" | "cancelled";
  createdAt: string;
  resolvedAt?: string;
}

export interface AskUserQuestionRequest {
  id: string;
  question: string;
  /** Optional predefined choices. If absent, user types free-form text. */
  choices?: Array<string | AskUserChoice>;
  status: "pending" | "answered" | "expired" | "cancelled";
  createdAt: string;
  resolvedAt?: string;
  answer?: string;
}

export interface AskUserChoice {
  label: string;
  value: string;
  isRecommended?: boolean;
}

export interface FileOrganizationPlan {
  approvalId: string;
  directoryPath: string;
  fileCount: number;
  dryRun: DryRunSummary;
}

export interface FileOperationResult {
  source: string;
  target: string;
  status: "moved" | "skipped" | "failed";
  message: string;
}

export interface FileOrganizationExecution {
  attemptedCount: number;
  movedCount: number;
  skippedCount: number;
  failedCount: number;
  results: FileOperationResult[];
}

export interface WriteTextFileRequest {
  targetPath: string;
  content: string;
}

export interface TextFileWritePlan {
  approvalId: string;
  targetPath: string;
  action: "create" | "overwrite";
  byteCount: number;
  contentHash: string;
  dryRun: DryRunSummary;
}

export interface TextFileWriteResult {
  targetPath: string;
  action: "create" | "overwrite";
  byteCount: number;
  status: "written";
  message: string;
}

export interface FileTool {
  scanMarkdownDocuments(): Promise<MarkdownDocument[]>;
  planPdfOrganization?(taskId?: string): Promise<FileOrganizationPlan>;
  executePdfOrganization?(
    operations: PlannedPathOperation[],
    approvalId: string,
    taskId?: string,
  ): Promise<FileOrganizationExecution>;
  planWriteText?(
    request: WriteTextFileRequest,
    taskId?: string,
  ): Promise<TextFileWritePlan>;
  writeText?(
    request: WriteTextFileRequest,
    approvalId: string,
    taskId?: string,
  ): Promise<TextFileWriteResult>;
  scanUserDocuments?(request?: {
    query?: string;
    extensions?: string[];
    maxResults?: number;
  }): Promise<MarkdownDocument[]>;
  scanUserImages?(request?: {
    maxResults?: number;
  }): Promise<LocalFileEntry[]>;
  scanInstalledApps?(): Promise<InstalledAppEntry[]>;
  classifyDocuments?(files: { name: string; path: string; extension?: string }[]): Promise<Array<{ name: string; path: string; extension?: string; tags: string[]; category: string; confidence: number }>>;
}

export interface ShellCommandRequest {
  program: string;
  args: string[];
  workspacePath?: string | null;
}

export interface ShellCommandOutput {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface ShellTool {
  runReadOnlyCommand(request: ShellCommandRequest): Promise<ShellCommandOutput>;
}

export interface WebSourceRequest {
  url: string;
}

export interface WebSource {
  url: string;
  title?: string;
  excerpt: string;
  fetchedAt: string;
  provider?: string;
}

export interface WebSearchRequest {
  query: string;
  maxResults?: number;
  /** "auto" (default): detect intent and route accordingly. "code": prefer GitHub. "web": skip GitHub. */
  searchType?: "auto" | "code" | "web";
}

export interface WebSearchResult extends WebSource {}

export interface ResearchReport {
  title: string;
  summary: string;
  rows: Array<{
    claim: string;
    sourceUrl: string;
    evidence: string;
  }>;
  unknowns: string[];
}

export interface CodeReviewPreview {
  workspacePath: string;
  changedFiles: string[];
  diffStat: string;
  diff: string;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  model?: string;
  provider?: string;
}

export interface TokenUsageByAgent {
  agentKind: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  modelCalls: number;
}

export interface TokenUsageSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  modelCalls: number;
  byAgentKind: TokenUsageByAgent[];
}

export interface CommanderPlanRequest {
  userGoal: string;
  availableAgents: Array<{
    kind: string;
    allowedToolNames: string[];
  }>;
  availableTools?: ToolDescriptor[];
  workflowId?: string;
}

export interface CommanderPlanResult {
  title: string;
  reasoning: string;
  steps: Array<{
    id: string;
    title: string;
    assignedAgentKind: string;
    toolName?: string;
    /** Primary capability tag for capability-based dispatch. Must be a valid AgentCapabilityTag. */
    capability?: string;
    requiredCapabilities?: string[];
    /** Step IDs that must complete before this step starts. Empty = can run immediately. */
    dependsOn?: string[];
    /** Suggested answers for clarification steps. */
    choices?: Array<string | AskUserChoice>;
    executionMode?: "direct_response" | "direct_tool_call" | "react";
    successCriteria: string;
  }>;
}

export interface CommanderSynthesizeRequest {
  userGoal: string;
  workflowTitle: string;
  evidence: Record<string, unknown>;
}

export interface CommanderSynthesizeResult {
  message: string;
}

export interface CommanderTool {
  plan(request: CommanderPlanRequest): Promise<CommanderPlanResult>;
  synthesize?(request: CommanderSynthesizeRequest): Promise<CommanderSynthesizeResult>;
  askUser?(question: string, choices?: Array<string | AskUserChoice>): Promise<string>;
}

export interface VerifierCheckRequest {
  stepId: string;
  successCriteria: string;
  evidence: Array<{
    kind: "file" | "command" | "source" | "log" | "permission";
    label: string;
    data: unknown;
  }>;
}

export interface VerifierCheckResult {
  status: "pass" | "warn" | "fail";
  summary: string;
  detail: string;
}

export interface VerifierTool {
  check(request: VerifierCheckRequest): Promise<VerifierCheckResult>;
}

export interface CodeProposedEdit {
  approvalId?: string;
  proposalId: string;
  workspacePath: string;
  summary: string;
  changedFiles: string[];
  patch: string;
  patchHash: string;
  baseGitHead?: string;
  hunks?: CodeProposalHunk[];
  tokenUsage?: ModelUsage;
}

export interface CodeProposalHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  diff: string;
}

export interface CodeApplyResult {
  applied: boolean;
  workspacePath: string;
  changedFiles: string[];
  message: string;
}

export interface CodeApplyApproval {
  approvalId: string;
  taskId?: string;
}

export interface CodeTool {
  inspectRepository(): Promise<CodeReviewPreview>;
  proposeEdit?(request: { userGoal: string; preview: CodeReviewPreview; taskId?: string }): Promise<CodeProposedEdit>;
  applyProposedEdit?(edit: CodeProposedEdit, approval: CodeApplyApproval): Promise<CodeApplyResult>;
}

export interface WebTool {
  fetchWebSource(request: WebSourceRequest): Promise<WebSource>;
  searchWeb?(request: WebSearchRequest): Promise<WebSearchResult[]>;
}

// ── Browser Tool ──────────────────────────────────────────────────────────────

export interface BrowserNavigateRequest {
  url: string;
  waitForSelector?: string;
  timeoutMs?: number;
}

export interface BrowserScreenshotRequest {
  selector?: string;
  fullPage?: boolean;
  format?: "png" | "jpeg";
  quality?: number;
}

export interface BrowserGetContentRequest {
  selector?: string;
  format?: "text" | "html" | "markdown";
  maxLength?: number;
}

export interface BrowserClickRequest {
  selector: string;
  button?: "left" | "right" | "middle";
  clickCount?: number;
  timeoutMs?: number;
}

export interface BrowserTypeRequest {
  selector: string;
  text: string;
  delay?: number;
  clearBefore?: boolean;
  pressEnter?: boolean;
}

export interface BrowserEvaluateRequest {
  expression: string;
  timeoutMs?: number;
}

export interface BrowserRunTestRequest {
  script: string;
  testFile?: string;
  timeoutMs?: number;
}

export interface BrowserNavigateResult {
  url: string;
  title: string;
  status: number;
  loadState: string;
}

export interface BrowserScreenshotResult {
  dataUrl: string;
  width: number;
  height: number;
}

export interface BrowserGetContentResult {
  content: string;
  url: string;
  title: string;
}

export interface BrowserClickResult {
  selector: string;
  clicked: boolean;
  newUrl?: string;
}

export interface BrowserTypeResult {
  selector: string;
  typed: boolean;
  value: string;
}

export interface BrowserEvaluateResult {
  result: string;
  type: string;
}

export interface BrowserRunTestResult {
  passed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
}

export interface BrowserExtractedLink {
  href: string;
  text: string;
  tag?: string;
  rel?: string;
}

export interface BrowserExtractLinksRequest {
  /** CSS selector to scope link extraction. Defaults to all <a> tags. */
  selector?: string;
  /** Max links to return. Defaults to 50. */
  maxResults?: number;
}

export interface BrowserExtractLinksResult {
  links: BrowserExtractedLink[];
  count: number;
}

export interface BrowserUploadRequest {
  /** CSS selector of the file input element. */
  selector: string;
  /** Local file path(s) to upload. */
  filePaths: string[];
}

export interface BrowserUploadResult {
  success: boolean;
  uploadedCount: number;
  message: string;
}

export interface BrowserFollowCandidateLinksRequest {
  /** Candidate URLs extracted from the current page. */
  candidateLinks: BrowserExtractedLink[];
  /** Optional URL pattern filter regex. */
  urlPattern?: string;
  /** Max links to follow. Defaults to 3. */
  maxFollow?: number;
}

export interface BrowserFollowCandidateLinksResult {
  followed: Array<{
    url: string;
    title: string;
    excerpt: string;
    status: number;
  }>;
  skipped: number;
}

export interface BrowserTool {
  navigate(request: BrowserNavigateRequest): Promise<BrowserNavigateResult>;
  screenshot(request: BrowserScreenshotRequest): Promise<BrowserScreenshotResult>;
  getContent(request: BrowserGetContentRequest): Promise<BrowserGetContentResult>;
  click(request: BrowserClickRequest): Promise<BrowserClickResult>;
  type(request: BrowserTypeRequest): Promise<BrowserTypeResult>;
  evaluate(request: BrowserEvaluateRequest): Promise<BrowserEvaluateResult>;
  runTest(request: BrowserRunTestRequest): Promise<BrowserRunTestResult>;
  extractLinks?(request: BrowserExtractLinksRequest): Promise<BrowserExtractLinksResult>;
  upload?(request: BrowserUploadRequest): Promise<BrowserUploadResult>;
  followCandidateLinks?(request: BrowserFollowCandidateLinksRequest): Promise<BrowserFollowCandidateLinksResult>;
}

export interface ProjectScript {
  name: string;
  command: string;
}

export interface ProjectInspection {
  workspacePath: string;
  packageManager?: string;
  scripts: ProjectScript[];
  recommendedStartCommand?: string;
  recommendedTestCommand?: string;
}

export interface ProjectTool {
  inspectProject(): Promise<ProjectInspection>;
}

export interface ComputerFileCandidate {
  name: string;
  path: string;
  isDir: boolean;
  sizeBytes?: number;
  modifiedAt?: string;
  extension?: string;
}

export interface TrustedComputerApp {
  title: string;
  trustedAt: string;
}

export interface ComputerScreenshotRequest {
  windowHandle?: number;
  region?: { x: number; y: number; width: number; height: number };
  method?: "auto" | "bitblt" | "printWindow";
}

export interface ComputerScreenshotResult {
  dataUrl: string;
  width: number;
  height: number;
  sourceWidth?: number;
  sourceHeight?: number;
  sourceOriginX?: number;
  sourceOriginY?: number;
  scaleX?: number;
  scaleY?: number;
  capturedAt: string;
  methodUsed?: "bitblt" | "printWindow";
}

export interface ComputerListWindowsRequest {}

export interface ComputerListWindowsResult {
  windows: Array<{
    handle: number;
    title: string;
    className: string;
    rect: { x: number; y: number; width: number; height: number };
    isVisible: boolean;
    isForeground: boolean;
  }>;
}

export interface ComputerFocusWindowRequest {
  handle: number;
  approvalId?: string;
  taskId?: string;
}

export interface ComputerFocusWindowResult {
  focused: boolean;
  title: string;
}

export interface ComputerMoveMouseRequest {
  x: number;
  y: number;
  speed?: "instant" | "linear";
  durationMs?: number;
  approvalId?: string;
  taskId?: string;
}

export interface ComputerMoveMouseResult {
  x: number;
  y: number;
}

export interface ComputerClickRequest {
  x: number;
  y: number;
  button?: "left" | "right" | "middle";
  clickCount?: 1 | 2;
  approvalId?: string;
  taskId?: string;
}

export interface ComputerClickResult {
  x: number;
  y: number;
  clicked: boolean;
}

export interface ComputerTypeRequest {
  text: string;
  delayMs?: number;
  clearBefore?: boolean;
  approvalId?: string;
  taskId?: string;
}

export interface ComputerTypeResult {
  typed: boolean;
  length: number;
}

export interface ComputerKeyComboRequest {
  keys: string[];
  pressDurationMs?: number;
  approvalId?: string;
  taskId?: string;
}

export interface ComputerKeyComboResult {
  combo: string;
  executed: boolean;
}

export interface ComputerScrollRequest {
  x: number;
  y: number;
  delta: number;
  direction?: "vertical" | "horizontal";
  approvalId?: string;
  taskId?: string;
}

export interface ComputerScrollResult {
  x: number;
  y: number;
  delta: number;
}

export interface ComputerWaitRequest {
  ms: number;
}

export interface ComputerWaitResult {
  waited: number;
}

export interface UiElementSelector {
  windowHandle: number;
  automationId?: string;
  name?: string;
  controlType?: string;
}

export interface ComputerInspectUiRequest {
  windowHandle: number;
  maxDepth?: number;
  maxNodes?: number;
  includeValues?: boolean;
}

export interface ComputerInspectUiResult {
  tree: string;
  nodeCount: number;
}

export interface ComputerInvokeUiRequest {
  selector: UiElementSelector;
  approvalId?: string;
  taskId?: string;
}

export interface ComputerInvokeUiResult {
  invoked: boolean;
  matchedName: string;
  matchedAutomationId: string;
}

export interface ComputerSetUiValueRequest {
  selector: UiElementSelector;
  value: string;
  approvalId?: string;
  taskId?: string;
}

export interface ComputerSetUiValueResult {
  set: boolean;
  matchedName: string;
  matchedAutomationId: string;
}

export interface ComputerUseApprovalRequest {
  tool: string;
  params: Record<string, unknown>;
}

export interface ComputerUseApprovalResult {
  approvalId: string;
  taskId?: string;
  sessionWide?: boolean;
}

export interface ComputerTool {
  searchLocalDocuments(request: {
    query: string;
    maxResults?: number;
  }): Promise<ComputerFileCandidate[]>;
  listDirectory(request: { path?: string }): Promise<ComputerFileCandidate[]>;
  screenshot(request: ComputerScreenshotRequest): Promise<ComputerScreenshotResult>;
  listWindows(request: ComputerListWindowsRequest): Promise<ComputerListWindowsResult>;
  inspectUi(request: ComputerInspectUiRequest): Promise<ComputerInspectUiResult>;
  focusWindow(request: ComputerFocusWindowRequest): Promise<ComputerFocusWindowResult>;
  moveMouse(request: ComputerMoveMouseRequest): Promise<ComputerMoveMouseResult>;
  click(request: ComputerClickRequest): Promise<ComputerClickResult>;
  type(request: ComputerTypeRequest): Promise<ComputerTypeResult>;
  keyCombo(request: ComputerKeyComboRequest): Promise<ComputerKeyComboResult>;
  scroll(request: ComputerScrollRequest): Promise<ComputerScrollResult>;
  invokeUi(request: ComputerInvokeUiRequest): Promise<ComputerInvokeUiResult>;
  setUiValue(request: ComputerSetUiValueRequest): Promise<ComputerSetUiValueResult>;
  wait(request: ComputerWaitRequest): Promise<ComputerWaitResult>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  openPath(...args: any[]): Promise<any>;
  approveAction?(
    action: ComputerUseApprovalRequest,
    approvalId: string,
    taskId: string,
    sessionWide?: boolean,
  ): Promise<ComputerUseApprovalResult>;
}

export interface ScheduledTaskDraft {
  name: string;
  goal: string;
  schedule: {
    type: "interval" | "daily" | "weekly" | "once";
    value: string;
  };
  nextRunAt: string;
}

export interface SchedulerTool {
  createTask(request: ScheduledTaskDraft): Promise<ScheduledTaskDraft & { id: string; enabled: boolean }>;
  updateTask?(id: string, request: Partial<ScheduledTaskDraft>): Promise<ScheduledTaskDraft & { id: string; enabled: boolean }>;
  deleteTask?(id: string): Promise<void>;
}

export interface WorkspaceDefinitionSummary {
  id: string;
  title: string;
  icon: string;
  description: string;
  enabled: boolean;
  version: string;
}

export interface WorkspaceTool {
  /** List all installed workspace definitions. */
  list(): Promise<WorkspaceDefinitionSummary[]>;
  /** Generate a workspace definition JSON from a natural language description (dry run). */
  scaffold?(description: string): Promise<Record<string, unknown>>;
  /** Save a workspace definition to disk. */
  create(definition: Record<string, unknown>): Promise<void>;
  /** Remove a workspace definition by id. */
  delete(workspaceId: string): Promise<void>;
}

// ── Vision Tool ──────────────────────────────────────────────────────────────

export interface VisionAnalyzeRequest {
  /** Local image path or base64 data URL. */
  imagePath: string;
  /** Optional question about the image content. */
  question?: string;
}

export interface VisionAnalyzeResult {
  description: string;
  objects: string[];
  text?: string;
  answer?: string;
}

export interface VisionDescribeRequest {
  imagePath: string;
  detail?: "brief" | "detailed";
}

export interface VisionOcrRequest {
  imagePath: string;
  language?: string;
}

export interface VisionOcrResult {
  text: string;
  confidence: number;
}

export interface VisionTool {
  analyze(request: VisionAnalyzeRequest): Promise<VisionAnalyzeResult>;
  describe(request: VisionDescribeRequest): Promise<{ description: string }>;
  extractText(request: VisionOcrRequest): Promise<VisionOcrResult>;
}

export interface ToolDescriptor {
  name: string;
  permissionLevel: PermissionLevel;
  /** Risk classification for confirmed_write tools. */
  writeRiskLevel?: WriteRiskLevel;
  summary: string;
  /** Capability tags this tool fulfills. Used for agent dispatch. */
  capabilityTags: string[];
  /** Agent kinds that are allowed to use this tool. */
  ownerAgentKinds: string[];
}
