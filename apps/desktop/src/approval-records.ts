import {
  createCodeApplyDryRun,
  createDryRunBindingHash,
} from "@javis/core";
import type { CodeProposedEdit, PermissionRequest } from "@javis/tools";

export const APPROVAL_RECORDS_STORAGE_KEY = "javis.approvalRecords.v1";
export const APPROVAL_RECORDS_STORAGE_VERSION = 1;
export const APPROVAL_RECORDS_LIMIT = 20;

type ApprovalRecordReadStorage = Pick<Storage, "getItem">;
type ApprovalRecordWriteStorage = Pick<Storage, "setItem">;

export type DurableApprovalStatus = "pending" | "approved" | "denied" | "expired";
type PlannedPath = PermissionRequest["dryRun"]["affectedPaths"][number];
type DryRunSummary = PermissionRequest["dryRun"];

export interface DurableApprovalRecord {
  approvalId: string;
  taskId: string;
  toolName: string;
  workspacePath: string;
  permissionLevel: "preview" | "confirmed_write";
  previewHash: string;
  expiresAt: string;
  status: DurableApprovalStatus;
  createdAt: string;
  resolvedAt?: string;
  decision?: "approved" | "denied";
  permissionRequest: PermissionRequest;
  codeProposedEdit?: CodeProposedEdit;
  gitPushPlan?: DurableGitPushPlan;
  gitCommitPlan?: DurableGitCommitPlan;
  gitStagePlan?: DurableGitStagePlan;
  gitCreatePullRequestPlan?: DurableGitCreatePullRequestPlan;
  gitCommentPullRequestPlan?: DurableGitCommentPullRequestPlan;
}

export interface DurableGitPushPlan {
  approvalId: string;
  preview: {
    branch: string;
    upstream: string;
    remoteName: string;
    remoteBranch: string;
    remoteUrl?: string;
    ahead: number;
    behind: number;
    commits: Array<{
      hash: string;
      subject: string;
    }>;
    dryRun: DryRunSummary;
  };
}

export interface DurableGitCommitPlan {
  approvalId: string;
  preview: {
    workspaceRoot: string;
    branch?: string;
    message: string;
    files: Array<{
      path: string;
      indexStatus: string;
      worktreeStatus: string;
      action: PlannedPath["action"];
      contentHash: string;
    }>;
    diffStat: string;
    diff: string;
    dryRun: DryRunSummary;
  };
}

export interface DurableGitStagePlan {
  approvalId: string;
  preview: {
    workspaceRoot: string;
    files: Array<{
      path: string;
      indexStatus: string;
      worktreeStatus: string;
      action: PlannedPath["action"];
      contentHash: string;
    }>;
    diffStat: string;
    diff: string;
    dryRun: DryRunSummary;
  };
}

export interface DurableGitCreatePullRequestPlan {
  approvalId: string;
  preview: {
    workspaceRoot: string;
    provider: string;
    title: string;
    body: string;
    baseBranch: string;
    headBranch: string;
    headCommit: string;
    remoteName?: string;
    remoteUrl?: string;
    draft: boolean;
    dryRun: DryRunSummary;
  };
}

export interface DurableGitCommentPullRequestPlan {
  approvalId: string;
  preview: {
    workspaceRoot: string;
    provider: string;
    pullRequest: string;
    body: string;
    remoteUrl?: string;
    dryRun: DryRunSummary;
  };
}

export interface ApprovalRecordInput {
  taskId: string;
  toolName: string;
  workspacePath: string;
  permissionRequest: PermissionRequest;
  codeProposedEdit?: CodeProposedEdit;
  gitPushPlan?: DurableGitPushPlan;
  gitCommitPlan?: DurableGitCommitPlan;
  gitStagePlan?: DurableGitStagePlan;
  gitCreatePullRequestPlan?: DurableGitCreatePullRequestPlan;
  gitCommentPullRequestPlan?: DurableGitCommentPullRequestPlan;
  ttlMs?: number;
  now?: string;
}

interface ApprovalRecordsEnvelope {
  version: typeof APPROVAL_RECORDS_STORAGE_VERSION;
  records: DurableApprovalRecord[];
}

export function loadApprovalRecords(storage: ApprovalRecordReadStorage): DurableApprovalRecord[] {
  try {
    const raw = storage.getItem(APPROVAL_RECORDS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = parseApprovalRecordsEnvelope(JSON.parse(raw));
    if (!parsed) {
      return [];
    }
    return parsed
      .map(sanitizeApprovalRecord)
      .filter((record): record is DurableApprovalRecord => Boolean(record))
      .slice(0, APPROVAL_RECORDS_LIMIT);
  } catch {
    return [];
  }
}

export function saveApprovalRecords(
  storage: ApprovalRecordWriteStorage,
  records: DurableApprovalRecord[],
): DurableApprovalRecord[] {
  const sanitized = records
    .map(sanitizeApprovalRecord)
    .filter((record): record is DurableApprovalRecord => Boolean(record))
    .slice(0, APPROVAL_RECORDS_LIMIT);
  const envelope: ApprovalRecordsEnvelope = {
    version: APPROVAL_RECORDS_STORAGE_VERSION,
    records: sanitized,
  };
  storage.setItem(APPROVAL_RECORDS_STORAGE_KEY, JSON.stringify(envelope));
  return sanitized;
}

export function upsertApprovalRecord(
  current: DurableApprovalRecord[],
  record: DurableApprovalRecord,
): DurableApprovalRecord[] {
  const sanitized = sanitizeApprovalRecord(record);
  if (!sanitized) {
    return current;
  }
  return [
    sanitized,
    ...current.filter((item) => item.approvalId !== sanitized.approvalId),
  ].slice(0, APPROVAL_RECORDS_LIMIT);
}

export function createApprovalRecordFromPermissionRequest({
  taskId,
  toolName,
  workspacePath,
  permissionRequest,
  codeProposedEdit,
  gitPushPlan,
  gitCommitPlan,
  gitStagePlan,
  gitCreatePullRequestPlan,
  gitCommentPullRequestPlan,
  ttlMs = 10 * 60 * 1000,
  now = permissionRequest.createdAt,
}: ApprovalRecordInput): DurableApprovalRecord | null {
  if (permissionRequest.status !== "pending" || !permissionRequest.bindingHash) {
    return null;
  }
  const createdAtMs = Date.parse(now);
  if (!Number.isFinite(createdAtMs)) {
    return null;
  }
  return sanitizeApprovalRecord({
    approvalId: permissionRequest.id,
    taskId,
    toolName,
    workspacePath,
    permissionLevel: permissionRequest.level,
    previewHash: permissionRequest.bindingHash,
    expiresAt: new Date(createdAtMs + ttlMs).toISOString(),
    status: "pending",
    createdAt: permissionRequest.createdAt,
    permissionRequest,
    codeProposedEdit,
    gitPushPlan,
    gitCommitPlan,
    gitStagePlan,
    gitCreatePullRequestPlan,
    gitCommentPullRequestPlan,
  });
}

export function findPendingApprovalRecord(
  records: DurableApprovalRecord[],
  toolName: string,
): DurableApprovalRecord | undefined {
  return records.find((record) => record.toolName === toolName && record.status === "pending");
}

export function resolveApprovalRecord(
  record: DurableApprovalRecord,
  decision: "approved" | "denied",
  resolvedAt: string,
): DurableApprovalRecord {
  if (record.status !== "pending") {
    return record;
  }
  return {
    ...record,
    status: decision,
    decision,
    resolvedAt,
    permissionRequest: {
      ...record.permissionRequest,
      status: decision,
      resolvedAt,
    },
  };
}

export function expireApprovalRecord(
  record: DurableApprovalRecord,
  resolvedAt: string,
): DurableApprovalRecord {
  if (record.status !== "pending") {
    return record;
  }
  return {
    ...record,
    status: "expired",
    resolvedAt,
    permissionRequest: {
      ...record.permissionRequest,
      status: "expired",
      resolvedAt,
    },
  };
}

export function isApprovalRecordExpired(
  record: DurableApprovalRecord,
  now: string = new Date().toISOString(),
): boolean {
  if (record.status !== "pending") {
    return false;
  }
  const expiresAt = Date.parse(record.expiresAt);
  const current = Date.parse(now);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(current)) {
    return false;
  }
  return current >= expiresAt;
}

function parseApprovalRecordsEnvelope(value: unknown): unknown[] | null {
  if (
    isRecord(value) &&
    value.version === APPROVAL_RECORDS_STORAGE_VERSION &&
    Array.isArray(value.records)
  ) {
    return value.records;
  }
  return null;
}

export function sanitizeApprovalRecord(value: unknown): DurableApprovalRecord | null {
  if (
    !isRecord(value) ||
    !isString(value.approvalId) ||
    !isString(value.taskId) ||
    !isString(value.toolName) ||
    !isString(value.workspacePath) ||
    !isPermissionLevel(value.permissionLevel) ||
    !isString(value.previewHash) ||
    !isString(value.expiresAt) ||
    !isApprovalStatus(value.status) ||
    !isString(value.createdAt) ||
    ("resolvedAt" in value && !isString(value.resolvedAt)) ||
    ("decision" in value && !isDecision(value.decision))
  ) {
    return null;
  }

  const permissionRequest = sanitizePermissionRequest(value.permissionRequest);
  if (!permissionRequest || permissionRequest.id !== value.approvalId) {
    return null;
  }
  if (permissionRequest.level !== value.permissionLevel) {
    return null;
  }
  if (permissionRequest.bindingHash !== value.previewHash) {
    return null;
  }
  if (createDryRunBindingHash(permissionRequest.dryRun) !== value.previewHash) {
    return null;
  }
  if (permissionRequest.status !== value.status) {
    return null;
  }

  const codeProposedEdit = sanitizeCodeProposedEdit(value.codeProposedEdit);
  const gitPushPlan = sanitizeGitPushPlan(value.gitPushPlan);
  const gitCommitPlan = sanitizeGitCommitPlan(value.gitCommitPlan);
  const gitStagePlan = sanitizeGitStagePlan(value.gitStagePlan);
  const gitCreatePullRequestPlan = sanitizeGitCreatePullRequestPlan(value.gitCreatePullRequestPlan);
  const gitCommentPullRequestPlan = sanitizeGitCommentPullRequestPlan(value.gitCommentPullRequestPlan);
  if (
    (codeProposedEdit && !isCodeProposedEditBoundToRequest(codeProposedEdit, value.toolName, value.workspacePath, permissionRequest)) ||
    (!codeProposedEdit && value.toolName === "code.applyProposedEdit")
  ) {
    return null;
  }
  if (
    (gitPushPlan && !isGitPushPlanBoundToRequest(gitPushPlan, value.toolName, permissionRequest)) ||
    (!gitPushPlan && value.toolName === "git.pushBranch")
  ) {
    return null;
  }
  if (
    (gitCommitPlan && !isGitCommitPlanBoundToRequest(gitCommitPlan, value.toolName, value.workspacePath, permissionRequest)) ||
    (!gitCommitPlan && value.toolName === "git.createCommit")
  ) {
    return null;
  }
  if (
    (gitStagePlan && !isGitStagePlanBoundToRequest(gitStagePlan, value.toolName, value.workspacePath, permissionRequest)) ||
    (!gitStagePlan && value.toolName === "git.stageFiles")
  ) {
    return null;
  }
  if (
    (gitCreatePullRequestPlan && !isGitCreatePullRequestPlanBoundToRequest(gitCreatePullRequestPlan, value.toolName, value.workspacePath, permissionRequest)) ||
    (!gitCreatePullRequestPlan && value.toolName === "git.createPullRequest")
  ) {
    return null;
  }
  if (
    (gitCommentPullRequestPlan && !isGitCommentPullRequestPlanBoundToRequest(gitCommentPullRequestPlan, value.toolName, value.workspacePath, permissionRequest)) ||
    (!gitCommentPullRequestPlan && value.toolName === "git.commentPullRequest")
  ) {
    return null;
  }

  const record: DurableApprovalRecord = {
    approvalId: value.approvalId,
    taskId: value.taskId,
    toolName: value.toolName,
    workspacePath: value.workspacePath,
    permissionLevel: value.permissionLevel,
    previewHash: value.previewHash,
    expiresAt: value.expiresAt,
    status: value.status,
    createdAt: value.createdAt,
    permissionRequest,
  };
  if (codeProposedEdit) {
    record.codeProposedEdit = codeProposedEdit;
  }
  if (gitPushPlan) {
    record.gitPushPlan = gitPushPlan;
  }
  if (gitCommitPlan) {
    record.gitCommitPlan = gitCommitPlan;
  }
  if (gitStagePlan) {
    record.gitStagePlan = gitStagePlan;
  }
  if (gitCreatePullRequestPlan) {
    record.gitCreatePullRequestPlan = gitCreatePullRequestPlan;
  }
  if (gitCommentPullRequestPlan) {
    record.gitCommentPullRequestPlan = gitCommentPullRequestPlan;
  }
  if (isString(value.resolvedAt)) {
    record.resolvedAt = value.resolvedAt;
  }
  if (isDecision(value.decision)) {
    record.decision = value.decision;
  }
  return record;
}

function isCodeProposedEditBoundToRequest(
  codeProposedEdit: CodeProposedEdit,
  toolName: string,
  workspacePath: string,
  permissionRequest: PermissionRequest,
): boolean {
  if (toolName !== "code.applyProposedEdit" || codeProposedEdit.workspacePath !== workspacePath) {
    return false;
  }
  return areDryRunsEqual(permissionRequest.dryRun, createCodeApplyDryRun(codeProposedEdit));
}

function isGitPushPlanBoundToRequest(
  gitPushPlan: DurableGitPushPlan,
  toolName: string,
  permissionRequest: PermissionRequest,
): boolean {
  if (toolName !== "git.pushBranch" || gitPushPlan.approvalId !== permissionRequest.id) {
    return false;
  }
  return areDryRunsEqual(permissionRequest.dryRun, gitPushPlan.preview.dryRun);
}

function isGitCommitPlanBoundToRequest(
  gitCommitPlan: DurableGitCommitPlan,
  toolName: string,
  workspacePath: string,
  permissionRequest: PermissionRequest,
): boolean {
  if (
    toolName !== "git.createCommit" ||
    gitCommitPlan.approvalId !== permissionRequest.id ||
    gitCommitPlan.preview.workspaceRoot !== workspacePath
  ) {
    return false;
  }
  return areDryRunsEqual(permissionRequest.dryRun, gitCommitPlan.preview.dryRun);
}

function isGitStagePlanBoundToRequest(
  gitStagePlan: DurableGitStagePlan,
  toolName: string,
  workspacePath: string,
  permissionRequest: PermissionRequest,
): boolean {
  if (
    toolName !== "git.stageFiles" ||
    gitStagePlan.approvalId !== permissionRequest.id ||
    gitStagePlan.preview.workspaceRoot !== workspacePath
  ) {
    return false;
  }
  return areDryRunsEqual(permissionRequest.dryRun, gitStagePlan.preview.dryRun);
}

function isGitCreatePullRequestPlanBoundToRequest(
  gitCreatePullRequestPlan: DurableGitCreatePullRequestPlan,
  toolName: string,
  workspacePath: string,
  permissionRequest: PermissionRequest,
): boolean {
  if (
    toolName !== "git.createPullRequest" ||
    gitCreatePullRequestPlan.approvalId !== permissionRequest.id ||
    gitCreatePullRequestPlan.preview.workspaceRoot !== workspacePath
  ) {
    return false;
  }
  return areDryRunsEqual(permissionRequest.dryRun, gitCreatePullRequestPlan.preview.dryRun);
}

function isGitCommentPullRequestPlanBoundToRequest(
  gitCommentPullRequestPlan: DurableGitCommentPullRequestPlan,
  toolName: string,
  workspacePath: string,
  permissionRequest: PermissionRequest,
): boolean {
  if (
    toolName !== "git.commentPullRequest" ||
    gitCommentPullRequestPlan.approvalId !== permissionRequest.id ||
    gitCommentPullRequestPlan.preview.workspaceRoot !== workspacePath
  ) {
    return false;
  }
  return areDryRunsEqual(permissionRequest.dryRun, gitCommentPullRequestPlan.preview.dryRun);
}

function areDryRunsEqual(left: DryRunSummary, right: DryRunSummary): boolean {
  return JSON.stringify(normalizeDryRun(left)) === JSON.stringify(normalizeDryRun(right));
}

function normalizeDryRun(dryRun: DryRunSummary) {
  return {
    operation: dryRun.operation,
    affectedPaths: dryRun.affectedPaths.map((path) => ({
      source: path.source,
      target: path.target,
      action: path.action,
      conflict: path.conflict,
    })),
    riskSummary: dryRun.riskSummary,
    reversible: dryRun.reversible,
  };
}

function sanitizeCodeProposedEdit(value: unknown): CodeProposedEdit | null {
  if (
    !isRecord(value) ||
    !isString(value.proposalId) ||
    !isString(value.workspacePath) ||
    !isString(value.summary) ||
    !Array.isArray(value.changedFiles) ||
    !value.changedFiles.every(isString) ||
    !isString(value.patch) ||
    !isString(value.patchHash)
  ) {
    return null;
  }
  return {
    ...(isString(value.approvalId) ? { approvalId: value.approvalId } : {}),
    proposalId: value.proposalId,
    workspacePath: value.workspacePath,
    summary: value.summary,
    changedFiles: value.changedFiles,
    patch: value.patch,
    patchHash: value.patchHash,
  };
}

function sanitizeGitPushPlan(value: unknown): DurableGitPushPlan | null {
  if (!isRecord(value) || !isString(value.approvalId) || !isRecord(value.preview)) {
    return null;
  }
  const preview = value.preview;
  const dryRun = sanitizeDryRun(preview.dryRun);
  if (
    !dryRun ||
    !isString(preview.branch) ||
    !isString(preview.upstream) ||
    !isString(preview.remoteName) ||
    !isString(preview.remoteBranch) ||
    ("remoteUrl" in preview && !isString(preview.remoteUrl)) ||
    typeof preview.ahead !== "number" ||
    typeof preview.behind !== "number" ||
    !Array.isArray(preview.commits)
  ) {
    return null;
  }
  const commits = preview.commits
    .map(sanitizeGitPushCommit)
    .filter((commit): commit is DurableGitPushPlan["preview"]["commits"][number] => Boolean(commit));
  if (commits.length !== preview.commits.length) {
    return null;
  }
  return {
    approvalId: value.approvalId,
    preview: {
      branch: preview.branch,
      upstream: preview.upstream,
      remoteName: preview.remoteName,
      remoteBranch: preview.remoteBranch,
      ...(isString(preview.remoteUrl) ? { remoteUrl: preview.remoteUrl } : {}),
      ahead: preview.ahead,
      behind: preview.behind,
      commits,
      dryRun,
    },
  };
}

function sanitizeGitPushCommit(value: unknown): DurableGitPushPlan["preview"]["commits"][number] | null {
  if (!isRecord(value) || !isString(value.hash) || !isString(value.subject)) {
    return null;
  }
  return {
    hash: value.hash,
    subject: value.subject,
  };
}

function sanitizeGitCommitPlan(value: unknown): DurableGitCommitPlan | null {
  if (!isRecord(value) || !isString(value.approvalId) || !isRecord(value.preview)) {
    return null;
  }
  const preview = value.preview;
  const dryRun = sanitizeDryRun(preview.dryRun);
  if (
    !dryRun ||
    !isString(preview.workspaceRoot) ||
    ("branch" in preview && !isString(preview.branch)) ||
    !isString(preview.message) ||
    !Array.isArray(preview.files) ||
    !isString(preview.diffStat) ||
    !isString(preview.diff)
  ) {
    return null;
  }
  const files = preview.files
    .map(sanitizeGitCommitFile)
    .filter((file): file is DurableGitCommitPlan["preview"]["files"][number] => Boolean(file));
  if (files.length !== preview.files.length) {
    return null;
  }
  return {
    approvalId: value.approvalId,
    preview: {
      workspaceRoot: preview.workspaceRoot,
      ...(isString(preview.branch) ? { branch: preview.branch } : {}),
      message: preview.message,
      files,
      diffStat: preview.diffStat,
      diff: preview.diff,
      dryRun,
    },
  };
}

function sanitizeGitCommitFile(value: unknown): DurableGitCommitPlan["preview"]["files"][number] | null {
  if (
    !isRecord(value) ||
    !isString(value.path) ||
    !isString(value.indexStatus) ||
    !isString(value.worktreeStatus) ||
    !isAction(value.action) ||
    !isString(value.contentHash)
  ) {
    return null;
  }
  return {
    path: value.path,
    indexStatus: value.indexStatus,
    worktreeStatus: value.worktreeStatus,
    action: value.action,
    contentHash: value.contentHash,
  };
}

function sanitizeGitStagePlan(value: unknown): DurableGitStagePlan | null {
  if (!isRecord(value) || !isString(value.approvalId) || !isRecord(value.preview)) {
    return null;
  }
  const preview = value.preview;
  const dryRun = sanitizeDryRun(preview.dryRun);
  if (
    !dryRun ||
    !isString(preview.workspaceRoot) ||
    !Array.isArray(preview.files) ||
    !isString(preview.diffStat) ||
    !isString(preview.diff)
  ) {
    return null;
  }
  const files = preview.files
    .map(sanitizeGitStageFile)
    .filter((file): file is DurableGitStagePlan["preview"]["files"][number] => Boolean(file));
  if (files.length !== preview.files.length) {
    return null;
  }
  return {
    approvalId: value.approvalId,
    preview: {
      workspaceRoot: preview.workspaceRoot,
      files,
      diffStat: preview.diffStat,
      diff: preview.diff,
      dryRun,
    },
  };
}

function sanitizeGitStageFile(value: unknown): DurableGitStagePlan["preview"]["files"][number] | null {
  if (
    !isRecord(value) ||
    !isString(value.path) ||
    !isString(value.indexStatus) ||
    !isString(value.worktreeStatus) ||
    !isAction(value.action) ||
    !isString(value.contentHash)
  ) {
    return null;
  }
  return {
    path: value.path,
    indexStatus: value.indexStatus,
    worktreeStatus: value.worktreeStatus,
    action: value.action,
    contentHash: value.contentHash,
  };
}

function sanitizeGitCreatePullRequestPlan(value: unknown): DurableGitCreatePullRequestPlan | null {
  if (!isRecord(value) || !isString(value.approvalId) || !isRecord(value.preview)) {
    return null;
  }
  const preview = value.preview;
  const dryRun = sanitizeDryRun(preview.dryRun);
  if (
    !dryRun ||
    !isString(preview.workspaceRoot) ||
    !isString(preview.provider) ||
    !isString(preview.title) ||
    !isString(preview.body) ||
    !isString(preview.baseBranch) ||
    !isString(preview.headBranch) ||
    !isString(preview.headCommit) ||
    ("remoteName" in preview && !isString(preview.remoteName)) ||
    ("remoteUrl" in preview && !isString(preview.remoteUrl)) ||
    typeof preview.draft !== "boolean"
  ) {
    return null;
  }
  return {
    approvalId: value.approvalId,
    preview: {
      workspaceRoot: preview.workspaceRoot,
      provider: preview.provider,
      title: preview.title,
      body: preview.body,
      baseBranch: preview.baseBranch,
      headBranch: preview.headBranch,
      headCommit: preview.headCommit,
      ...(isString(preview.remoteName) ? { remoteName: preview.remoteName } : {}),
      ...(isString(preview.remoteUrl) ? { remoteUrl: preview.remoteUrl } : {}),
      draft: preview.draft,
      dryRun,
    },
  };
}

function sanitizeGitCommentPullRequestPlan(value: unknown): DurableGitCommentPullRequestPlan | null {
  if (!isRecord(value) || !isString(value.approvalId) || !isRecord(value.preview)) {
    return null;
  }
  const preview = value.preview;
  const dryRun = sanitizeDryRun(preview.dryRun);
  if (
    !dryRun ||
    !isString(preview.workspaceRoot) ||
    !isString(preview.provider) ||
    !isString(preview.pullRequest) ||
    !isString(preview.body) ||
    ("remoteUrl" in preview && !isString(preview.remoteUrl))
  ) {
    return null;
  }
  return {
    approvalId: value.approvalId,
    preview: {
      workspaceRoot: preview.workspaceRoot,
      provider: preview.provider,
      pullRequest: preview.pullRequest,
      body: preview.body,
      ...(isString(preview.remoteUrl) ? { remoteUrl: preview.remoteUrl } : {}),
      dryRun,
    },
  };
}

function sanitizePermissionRequest(value: unknown): PermissionRequest | null {
  if (
    !isRecord(value) ||
    !isString(value.id) ||
    !isPermissionLevel(value.level) ||
    !isString(value.title) ||
    !isString(value.reason) ||
    !isApprovalStatus(value.status) ||
    !isString(value.createdAt) ||
    !isString(value.bindingHash) ||
    ("writeRiskLevel" in value && !isWriteRiskLevel(value.writeRiskLevel)) ||
    ("resolvedAt" in value && !isString(value.resolvedAt)) ||
    !isRecord(value.dryRun)
  ) {
    return null;
  }
  const dryRun = sanitizeDryRun(value.dryRun);
  if (!dryRun) {
    return null;
  }
  const request: PermissionRequest = {
    id: value.id,
    level: value.level,
    ...(isWriteRiskLevel(value.writeRiskLevel) ? { writeRiskLevel: value.writeRiskLevel } : {}),
    title: value.title,
    reason: value.reason,
    dryRun,
    bindingHash: value.bindingHash,
    status: value.status,
    createdAt: value.createdAt,
  };
  if (value.allowAlways === false) {
    request.allowAlways = false;
  }
  if (isString(value.resolvedAt)) {
    request.resolvedAt = value.resolvedAt;
  }
  return request;
}

function sanitizeDryRun(value: unknown): DryRunSummary | null {
  if (
    !isRecord(value) ||
    !isString(value.operation) ||
    !Array.isArray(value.affectedPaths) ||
    !isString(value.riskSummary) ||
    typeof value.reversible !== "boolean"
  ) {
    return null;
  }
  const affectedPaths = value.affectedPaths
    .map(sanitizePlannedPath)
    .filter((path): path is PlannedPath => Boolean(path));
  if (affectedPaths.length !== value.affectedPaths.length) {
    return null;
  }
  return {
    operation: value.operation,
    affectedPaths,
    riskSummary: value.riskSummary,
    reversible: value.reversible,
  };
}

function sanitizePlannedPath(value: unknown): PlannedPath | null {
  if (
    !isRecord(value) ||
    !isAction(value.action) ||
    !isString(value.source) ||
    !isString(value.target) ||
    ("conflict" in value && !isString(value.conflict))
  ) {
    return null;
  }
  const path: PlannedPath = {
    source: value.source,
    target: value.target,
    action: value.action,
  };
  if (isString(value.conflict)) {
    path.conflict = value.conflict;
  }
  return path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isPermissionLevel(value: unknown): value is DurableApprovalRecord["permissionLevel"] {
  return value === "preview" || value === "confirmed_write";
}

function isWriteRiskLevel(value: unknown): value is PermissionRequest["writeRiskLevel"] {
  return value === "safe" || value === "risky" || value === "dangerous";
}

function isApprovalStatus(value: unknown): value is DurableApprovalStatus {
  return (
    value === "pending" ||
    value === "approved" ||
    value === "denied" ||
    value === "expired"
  );
}

function isDecision(value: unknown): value is DurableApprovalRecord["decision"] {
  return value === "approved" || value === "denied";
}

function isAction(value: unknown): value is PlannedPath["action"] {
  return (
    value === "create" ||
    value === "modify" ||
    value === "move" ||
    value === "copy" ||
    value === "delete" ||
    value === "overwrite" ||
    value === "push" ||
    value === "stage" ||
    value === "create_pr" ||
    value === "comment_pr"
  );
}
