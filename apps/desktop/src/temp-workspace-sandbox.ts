import { invoke } from "@tauri-apps/api/core";

// ---- Types (mirror Rust structs, camelCase serialization) ----

export interface TempWorkspaceSandbox {
  taskId: string;
  realWorkspaceRoot: string;
  sandboxRoot: string;
  copiedFiles: number;
  copiedDirectories: number;
  skippedEntries: number;
}

export interface TempWorkspaceDiffFile {
  path: string;
  change: "added" | "modified" | "deleted" | "binaryChanged";
  textDiff: string | null;
}

export interface TempWorkspaceDiff {
  realWorkspaceRoot: string;
  sandboxRoot: string;
  changedFiles: TempWorkspaceDiffFile[];
  unifiedDiff: string;
}

export interface TempWorkspaceApplyPlan {
  realWorkspaceRoot: string;
  sandboxRoot: string;
  changedFiles: string[];
  previewHash: string;
  unifiedDiff: string;
  approvalId?: string;
  taskId?: string;
}

export interface TempWorkspaceApplyResult {
  appliedFiles: number;
  deletedFiles: number;
}

export type TempWorkspaceFinalizeMode = "delete" | "archive";

export interface TempWorkspaceFinalizeResult {
  mode: TempWorkspaceFinalizeMode;
  sandboxRoot: string;
  archivedTo: string | null;
}

// ---- Tauri invoke wrappers ----

export async function createTempWorkspace(
  workspaceRoot: string,
  taskId: string,
): Promise<TempWorkspaceSandbox> {
  return invoke("temp_workspace_sandbox_create", {
    workspaceRoot,
    taskId,
  });
}

export async function diffTempWorkspace(
  realWorkspaceRoot: string,
  sandboxRoot: string,
): Promise<TempWorkspaceDiff> {
  return invoke("temp_workspace_sandbox_diff", {
    realWorkspaceRoot,
    sandboxRoot,
  });
}

export async function diffAndPlanTempWorkspace(
  realWorkspaceRoot: string,
  sandboxRoot: string,
  taskId?: string,
): Promise<TempWorkspaceApplyPlan> {
  return invoke("temp_workspace_sandbox_diff_and_plan", {
    realWorkspaceRoot,
    sandboxRoot,
    taskId,
  });
}

export async function approveTempWorkspacePlan(
  approvalId: string,
  taskId?: string,
): Promise<void> {
  return invoke("temp_workspace_sandbox_approve_apply", {
    approvalId,
    taskId,
  });
}

export async function applyApprovedTempWorkspacePlan(
  realWorkspaceRoot: string,
  sandboxRoot: string,
  approvalId: string,
  taskId?: string,
): Promise<TempWorkspaceApplyResult> {
  return invoke("temp_workspace_sandbox_apply", {
    realWorkspaceRoot,
    sandboxRoot,
    approvalId,
    taskId,
  });
}

export async function finalizeTempWorkspace(
  realWorkspaceRoot: string,
  sandboxRoot: string,
  mode: TempWorkspaceFinalizeMode,
): Promise<TempWorkspaceFinalizeResult> {
  return invoke("temp_workspace_sandbox_finalize", {
    realWorkspaceRoot,
    sandboxRoot,
    mode,
  });
}
