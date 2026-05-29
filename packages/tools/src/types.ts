export type PermissionLevel = "read" | "preview" | "confirmed_write" | "dangerous";

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
  title: string;
  reason: string;
  dryRun: DryRunSummary;
  bindingHash?: string;
  status: "pending" | "approved" | "denied" | "expired" | "cancelled";
  createdAt: string;
  resolvedAt?: string;
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

export interface FileTool {
  scanMarkdownDocuments(): Promise<MarkdownDocument[]>;
  planPdfOrganization?(taskId?: string): Promise<FileOrganizationPlan>;
  executePdfOrganization?(
    operations: PlannedPathOperation[],
    approvalId: string,
    taskId?: string,
  ): Promise<FileOrganizationExecution>;
  scanUserDocuments?(request?: {
    query?: string;
    extensions?: string[];
    maxResults?: number;
  }): Promise<MarkdownDocument[]>;
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
  workflowId?: string;
}

export interface CommanderPlanResult {
  title: string;
  reasoning: string;
  steps: Array<{
    id: string;
    title: string;
    assignedAgentKind: string;
    requiredCapabilities?: string[];
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
}

export interface CodeTool {
  inspectRepository(): Promise<CodeReviewPreview>;
  proposeEdit?(request: { userGoal: string; preview: CodeReviewPreview }): Promise<CodeProposedEdit>;
  applyProposedEdit?(edit: CodeProposedEdit, approval: CodeApplyApproval): Promise<CodeApplyResult>;
}

export interface WebTool {
  fetchWebSource(request: WebSourceRequest): Promise<WebSource>;
  searchWeb?(request: WebSearchRequest): Promise<WebSearchResult[]>;
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

export interface ComputerTool {
  searchLocalDocuments(request: {
    query: string;
    maxResults?: number;
  }): Promise<ComputerFileCandidate[]>;
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

export interface ToolDescriptor {
  name: string;
  permissionLevel: PermissionLevel;
  summary: string;
}
