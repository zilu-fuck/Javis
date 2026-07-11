import type { CodeTool, GitTool, ShellTool } from "@javis/tools";

export type WorkspaceRuntimeKind = "local" | "sandbox" | "remote";

export interface WorkspaceFileEntry {
  path: string;
  name: string;
  isDir: boolean;
  sizeBytes?: number;
  modifiedAt?: string;
}

export interface WorkspaceExecutionRequest {
  program: string;
  args: string[];
  cwd?: string;
  permissionLevel?: "read" | "preview" | "confirmed_write" | "dangerous";
}

export interface WorkspaceExecutionResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface WorkspaceSnapshot {
  runtimeKind: WorkspaceRuntimeKind;
  root: string;
  snapshotId: string;
  createdAt: string;
}

export interface WorkspaceDiffFile {
  path: string;
  change: "added" | "modified" | "deleted" | "binaryChanged";
  textDiff?: string | null;
}

export interface WorkspaceDiff {
  root: string;
  changedFiles: WorkspaceDiffFile[];
  unifiedDiff: string;
}

export interface WorkspaceRuntime {
  readonly kind: WorkspaceRuntimeKind;
  readonly root: string;
  readFile(path: string): Promise<Uint8Array>;
  listFiles(path?: string): Promise<WorkspaceFileEntry[]>;
  execute(request: WorkspaceExecutionRequest): Promise<WorkspaceExecutionResult>;
  createSnapshot(): Promise<WorkspaceSnapshot>;
  diff(snapshot: WorkspaceSnapshot): Promise<WorkspaceDiff>;
  dispose(): Promise<void>;
}

export type WorkspaceRuntimeToolKind = "code" | "shell" | "git";

export interface WorkspaceRuntimeRoute {
  toolKind: WorkspaceRuntimeToolKind;
  runtimeKind: WorkspaceRuntimeKind;
  workspaceRoot: string;
  permissionLevel: WorkspaceExecutionRequest["permissionLevel"];
}

export function routeToolThroughWorkspaceRuntime(input: {
  toolKind: WorkspaceRuntimeToolKind;
  runtime: Pick<WorkspaceRuntime, "kind" | "root">;
  permissionLevel?: WorkspaceExecutionRequest["permissionLevel"];
}): WorkspaceRuntimeRoute {
  return {
    toolKind: input.toolKind,
    runtimeKind: input.runtime.kind,
    workspaceRoot: input.runtime.root,
    permissionLevel: input.permissionLevel ?? "read",
  };
}

export function routeCodeToolThroughWorkspaceRuntime(
  _tool: Pick<CodeTool, "inspectRepository">,
  runtime: Pick<WorkspaceRuntime, "kind" | "root">,
): WorkspaceRuntimeRoute {
  return routeToolThroughWorkspaceRuntime({
    toolKind: "code",
    runtime,
    permissionLevel: "read",
  });
}

export function routeShellToolThroughWorkspaceRuntime(
  _tool: Pick<ShellTool, "runReadOnlyCommand">,
  runtime: Pick<WorkspaceRuntime, "kind" | "root">,
): WorkspaceRuntimeRoute {
  return routeToolThroughWorkspaceRuntime({
    toolKind: "shell",
    runtime,
    permissionLevel: "read",
  });
}

export function routeGitToolThroughWorkspaceRuntime(
  _tool: GitTool,
  runtime: Pick<WorkspaceRuntime, "kind" | "root">,
): WorkspaceRuntimeRoute {
  return routeToolThroughWorkspaceRuntime({
    toolKind: "git",
    runtime,
    permissionLevel: "preview",
  });
}

export function assertWorkspaceRuntimeCanWrite(runtime: Pick<WorkspaceRuntime, "kind">): void {
  if (runtime.kind === "local") {
    throw new Error("LocalReadOnlyWorkspace cannot execute write-capable operations.");
  }
}

export function createWorkspaceSnapshot(input: {
  runtimeKind: WorkspaceRuntimeKind;
  root: string;
  snapshotId?: string;
  createdAt?: string;
}): WorkspaceSnapshot {
  return {
    runtimeKind: input.runtimeKind,
    root: input.root,
    snapshotId: input.snapshotId ?? `snapshot-${simpleHash(`${input.runtimeKind}:${input.root}:${input.createdAt ?? ""}`)}`,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

function simpleHash(value: string): string {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
