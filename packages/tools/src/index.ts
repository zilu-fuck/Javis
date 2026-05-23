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

export interface FileTool {
  scanMarkdownDocuments(): Promise<MarkdownDocument[]>;
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
