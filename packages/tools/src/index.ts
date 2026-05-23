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
  planPdfOrganization?(): Promise<FileOrganizationPlan>;
  executePdfOrganization?(
    operations: PlannedPathOperation[],
    approvalId: string,
  ): Promise<FileOrganizationExecution>;
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

export interface CodeTool {
  inspectRepository(): Promise<CodeReviewPreview>;
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

export interface ToolDescriptor {
  name: string;
  permissionLevel: PermissionLevel;
  summary: string;
}

export const initialToolDescriptors: ToolDescriptor[] = [
  {
    name: "file.scanMarkdownDocuments",
    permissionLevel: "read",
    summary: "Scan Markdown documents inside the active workspace.",
  },
  {
    name: "shell.run",
    permissionLevel: "preview",
    summary: "Preview shell commands before execution.",
  },
  {
    name: "web.fetchSource",
    permissionLevel: "read",
    summary: "Fetch a user-provided public web source URL.",
  },
  {
    name: "web.search",
    permissionLevel: "read",
    summary: "Search public web sources through a configured provider.",
  },
  {
    name: "project.inspect",
    permissionLevel: "read",
    summary: "Inspect package scripts and recommend start/test commands.",
  },
  {
    name: "file.planPdfOrganization",
    permissionLevel: "preview",
    summary: "Create a dry-run plan for organizing PDF files without moving them.",
  },
  {
    name: "file.executePdfOrganization",
    permissionLevel: "confirmed_write",
    summary: "Move PDF files exactly as listed in an approved dry-run plan.",
  },
];

export function summarizeMarkdownDocuments(
  documents: MarkdownDocument[],
): MarkdownDocumentSummary[] {
  return documents.map((document) => ({
    ...document,
    purpose: inferMarkdownPurpose(document),
  }));
}

function inferMarkdownPurpose(document: MarkdownDocument): string {
  const normalizedPath = document.path.replace(/\\/g, "/").toLowerCase();

  if (normalizedPath.endsWith("readme.md")) {
    return "Project or module entry document.";
  }

  if (normalizedPath.includes("/docs/")) {
    return `Project design document: ${document.heading ?? "untitled topic"}.`;
  }

  if (document.heading) {
    return `Markdown document about "${document.heading}".`;
  }

  if (document.excerpt) {
    return `Content note: ${document.excerpt}`;
  }

  return "Markdown document without enough visible content to infer a precise purpose.";
}
