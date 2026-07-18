import {
  computeContentHash,
  createArtifactEnvelope,
  createCodeApplyDryRun,
  createDryRunBindingHash,
  sanitizeArtifactForPersistence,
  type RuntimeEventEnvelope,
  type WorkflowCheckpoint,
} from "@javis/core";
import type { CodeProposedEdit, PermissionRequest } from "@javis/tools";
import {
  sanitizeCheckpointForPersistence,
  sanitizeWorkflowCheckpoint,
} from "./workflow-checkpoint-store";

export const APPROVAL_RECORDS_STORAGE_KEY = "javis.approvalRecords.v1";
export const APPROVAL_RECORDS_STORAGE_VERSION = 1;
export const APPROVAL_RECORDS_LIMIT = 20;

type ApprovalRecordReadStorage = Pick<Storage, "getItem">;
type ApprovalRecordWriteStorage = Pick<Storage, "setItem">;

export type DurableApprovalStatus = "pending" | "approved" | "denied" | "expired";
export type DurableApprovalExecutionStatus =
  | "started"
  | "succeeded"
  | "continuation_pending"
  | "completed"
  | "failed"
  | "blocked";
type PlannedPath = PermissionRequest["dryRun"]["affectedPaths"][number];
type DryRunSummary = PermissionRequest["dryRun"];

export interface DurableApprovalRecord {
  approvalId: string;
  taskId: string;
  runId?: string;
  workflowBound?: boolean;
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
  execution?: DurableApprovalExecution;
}

export interface DurableApprovalResumeSeedSnapshot {
  checkpoint: WorkflowCheckpoint;
  events: RuntimeEventEnvelope[];
}

export interface DurableApprovalExecution {
  approvalId: string;
  taskId: string;
  runId?: string;
  workflowBound?: boolean;
  workflowId?: string;
  planHash?: string;
  stepId?: string;
  toolName: string;
  previewHash: string;
  status: DurableApprovalExecutionStatus;
  startedAt: string;
  completedAt?: string;
  resumeSeed?: DurableApprovalResumeSeedSnapshot;
  output?: unknown;
  outputHash?: string;
  error?: string;
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
  runId?: string;
  workflowBound?: boolean;
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
    return retainApprovalRecordHistory(parsed
      .map(sanitizeApprovalRecord)
      .filter((record): record is DurableApprovalRecord => Boolean(record)));
  } catch {
    return [];
  }
}

export function saveApprovalRecords(
  storage: ApprovalRecordWriteStorage,
  records: DurableApprovalRecord[],
): DurableApprovalRecord[] {
  const sanitized = retainApprovalRecordHistory(records
    .map(sanitizeApprovalRecord)
    .filter((record): record is DurableApprovalRecord => Boolean(record)));
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
  return retainApprovalRecordHistory([
    sanitized,
    ...current.filter((item) => item.approvalId !== sanitized.approvalId),
  ]);
}

export function retainApprovalRecordHistory(
  records: DurableApprovalRecord[],
  terminalLimit = APPROVAL_RECORDS_LIMIT,
): DurableApprovalRecord[] {
  const retainedTerminalIds = new Set(
    records
      .filter(isTerminalApprovalRecord)
      .sort((left, right) => {
        const createdAtOrder = right.createdAt.localeCompare(left.createdAt);
        return createdAtOrder !== 0
          ? createdAtOrder
          : right.approvalId.localeCompare(left.approvalId);
      })
      .slice(0, terminalLimit)
      .map((record) => record.approvalId),
  );
  return records.filter((record) => {
    return !isTerminalApprovalRecord(record) || retainedTerminalIds.has(record.approvalId);
  });
}

export function isTerminalApprovalRecord(record: DurableApprovalRecord): boolean {
  if (record.status === "expired") return true;
  if (record.status === "denied" && !record.workflowBound) return true;
  return record.execution?.status === "completed" ||
    record.execution?.status === "failed" ||
    record.execution?.status === "blocked";
}

export function createApprovalRecordFromPermissionRequest({
  taskId,
  runId,
  workflowBound,
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
    ...(runId ? { runId } : {}),
    ...(workflowBound ? { workflowBound: true } : {}),
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

export function findRecoverableApprovalExecutionRecord(
  records: DurableApprovalRecord[],
): DurableApprovalRecord | undefined {
  return records.find((record) =>
    (record.status === "approved" || record.status === "denied") &&
    (record.workflowBound && !record.execution ||
      record.execution?.status === "started" ||
      record.execution?.status === "succeeded" ||
      record.execution?.status === "continuation_pending")
  );
}

export function markApprovalExecutionStarted(
  record: DurableApprovalRecord,
  resumeSeed: DurableApprovalResumeSeedSnapshot | undefined,
  startedAt = new Date().toISOString(),
): DurableApprovalRecord {
  if (record.status !== "approved" && record.status !== "denied") {
    throw new Error("Only a resolved approval record can start durable execution state.");
  }
  if (record.workflowBound && !resumeSeed) {
    throw new Error("A workflow-bound approval requires a durable resume seed before execution.");
  }
  const checkpoint = resumeSeed?.checkpoint;
  if (checkpoint && (
    checkpoint.taskId !== record.taskId ||
    checkpoint.runId !== record.runId ||
    checkpoint.runningStepIds.length !== 1
  )) {
    throw new Error("Approval resume seed does not match the approved task/run/step.");
  }
  const persistedCheckpoint = checkpoint
    ? sanitizeCheckpointForPersistence(checkpoint)
    : undefined;
  const stepId = persistedCheckpoint?.runningStepIds[0];
  const step = persistedCheckpoint?.workflowSnapshot.steps.find((candidate) => candidate.id === stepId);
  const stepToolName = (step as (typeof step & { toolName?: string }) | undefined)?.toolName;
  if (persistedCheckpoint && (!step ||
      (step.permissionLevel !== "confirmed_write" && step.permissionLevel !== "dangerous") ||
      (stepToolName && stepToolName !== record.toolName) ||
      !hasApprovalResumeEvidence(resumeSeed?.events ?? [], persistedCheckpoint, record.approvalId, stepId)
  )) {
    throw new Error("Approval tool does not match the running workflow step.");
  }

  return {
    ...record,
    execution: {
      approvalId: record.approvalId,
      taskId: record.taskId,
      ...(record.runId ? { runId: record.runId } : {}),
      ...(record.workflowBound ? { workflowBound: true } : {}),
      ...(persistedCheckpoint ? {
        workflowId: persistedCheckpoint.workflowId,
        planHash: persistedCheckpoint.planHash,
        stepId,
        resumeSeed: {
          checkpoint: persistedCheckpoint,
          events: selectApprovalResumeEvents(resumeSeed?.events ?? [], record, stepId),
        },
      } : {}),
      toolName: record.toolName,
      previewHash: record.previewHash,
      status: "started",
      startedAt,
    },
  };
}

export function markApprovalExecutionSucceeded(
  record: DurableApprovalRecord,
  output: unknown,
  completedAt = new Date().toISOString(),
): DurableApprovalRecord {
  const execution = requireApprovalExecution(record, ["started", "succeeded"]);
  const sanitizedOutput = sanitizeApprovalExecutionValue(record, output);
  return {
    ...record,
    execution: {
      ...execution,
      status: "succeeded",
      completedAt,
      output: sanitizedOutput,
      outputHash: computeContentHash(sanitizedOutput),
    },
  };
}

export function markApprovalContinuationPending(
  record: DurableApprovalRecord,
  resumeSeed: DurableApprovalResumeSeedSnapshot,
  updatedAt = new Date().toISOString(),
): DurableApprovalRecord {
  const execution = requireApprovalExecution(record, ["succeeded", "continuation_pending"]);
  if (!execution.stepId || !execution.runId ||
    resumeSeed.checkpoint.taskId !== execution.taskId ||
    resumeSeed.checkpoint.runId !== execution.runId ||
    resumeSeed.checkpoint.workflowId !== execution.workflowId ||
    resumeSeed.checkpoint.planHash !== execution.planHash) {
    throw new Error("Advanced approval resume seed does not match the executed workflow step.");
  }
  return {
    ...record,
    execution: {
      ...execution,
      status: "continuation_pending",
      completedAt: execution.completedAt ?? updatedAt,
      resumeSeed: {
        checkpoint: sanitizeCheckpointForPersistence(resumeSeed.checkpoint),
        events: selectApprovalResumeEvents(resumeSeed.events, record, execution.stepId),
      },
    },
  };
}

export function markApprovalExecutionTerminal(
  record: DurableApprovalRecord,
  status: "completed" | "failed" | "blocked",
  detail?: unknown,
  completedAt = new Date().toISOString(),
): DurableApprovalRecord {
  const execution = record.execution;
  const error = detail === undefined
    ? undefined
    : String(sanitizeApprovalExecutionValue(record, detail));
  if (!execution) {
    if (status !== "blocked") throw new Error("Approval execution state is missing.");
    return {
      ...record,
      execution: {
        approvalId: record.approvalId,
        taskId: record.taskId,
        ...(record.runId ? { runId: record.runId } : {}),
        ...(record.workflowBound ? { workflowBound: true } : {}),
        toolName: record.toolName,
        previewHash: record.previewHash,
        status,
        startedAt: record.resolvedAt ?? completedAt,
        completedAt,
        ...(error ? { error } : {}),
      },
    };
  }
  return {
    ...record,
    execution: {
      ...execution,
      status,
      completedAt,
      ...(error ? { error } : {}),
    },
  };
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
    ("runId" in value && !isString(value.runId)) ||
    ("workflowBound" in value && typeof value.workflowBound !== "boolean") ||
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
  const execution = sanitizeApprovalExecution(value.execution, {
    approvalId: value.approvalId,
    taskId: value.taskId,
    runId: isString(value.runId) ? value.runId : undefined,
    workflowBound: value.workflowBound === true,
    toolName: value.toolName,
    previewHash: value.previewHash,
  });
  if (value.execution !== undefined && !execution) {
    return null;
  }
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
    ...(isString(value.runId) ? { runId: value.runId } : {}),
    ...(value.workflowBound === true ? { workflowBound: true } : {}),
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
  if (execution) {
    record.execution = execution;
  }
  if (isString(value.resolvedAt)) {
    record.resolvedAt = value.resolvedAt;
  }
  if (isDecision(value.decision)) {
    record.decision = value.decision;
  }
  return record;
}

function sanitizeApprovalExecution(
  value: unknown,
  binding: {
    approvalId: string;
    taskId: string;
    runId?: string;
    workflowBound?: boolean;
    toolName: string;
    previewHash: string;
  },
): DurableApprovalExecution | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) ||
    value.approvalId !== binding.approvalId ||
    value.taskId !== binding.taskId ||
    value.toolName !== binding.toolName ||
    value.previewHash !== binding.previewHash ||
    (binding.runId ? value.runId !== binding.runId : value.runId !== undefined) ||
    !isApprovalExecutionStatus(value.status) ||
    !isString(value.startedAt)) {
    return undefined;
  }
  const status = value.status;
  const hasOutput = Object.prototype.hasOwnProperty.call(value, "output");
  const outputHash = isString(value.outputHash) ? value.outputHash : undefined;
  if (hasOutput && (!outputHash || computeContentHash(value.output) !== outputHash)) {
    return undefined;
  }
  if ((status === "succeeded" || status === "continuation_pending" || status === "completed") && !hasOutput) {
    return undefined;
  }
  if (status === "started" && (hasOutput || value.outputHash !== undefined)) {
    return undefined;
  }
  if (!hasOutput && value.outputHash !== undefined) {
    return undefined;
  }
  if (status !== "started" && !isString(value.completedAt)) return undefined;
  if (status === "started" && value.completedAt !== undefined) return undefined;
  if (value.error !== undefined && !isString(value.error)) return undefined;

  let resumeSeed: DurableApprovalResumeSeedSnapshot | undefined;
  if (value.resumeSeed !== undefined) {
    if (!isRecord(value.resumeSeed)) return undefined;
    const checkpoint = sanitizeWorkflowCheckpoint(value.resumeSeed.checkpoint);
    const events = sanitizeApprovalResumeEvents(value.resumeSeed.events, binding, value);
    if (!checkpoint || !events ||
      checkpoint.taskId !== binding.taskId ||
      checkpoint.runId !== binding.runId ||
      checkpoint.workflowId !== value.workflowId ||
      checkpoint.planHash !== value.planHash) {
      return undefined;
    }
    resumeSeed = { checkpoint, events };
  }
  if (binding.workflowBound === true && status !== "blocked" && status !== "failed" && (
    !isString(value.workflowId) ||
    !isString(value.planHash) ||
    !isString(value.stepId) ||
    !resumeSeed
  )) {
    return undefined;
  }

  return {
    approvalId: binding.approvalId,
    taskId: binding.taskId,
    ...(binding.runId ? { runId: binding.runId } : {}),
    ...(binding.workflowBound ? { workflowBound: true } : {}),
    ...(isString(value.workflowId) ? { workflowId: value.workflowId } : {}),
    ...(isString(value.planHash) ? { planHash: value.planHash } : {}),
    ...(isString(value.stepId) ? { stepId: value.stepId } : {}),
    toolName: binding.toolName,
    previewHash: binding.previewHash,
    status,
    startedAt: value.startedAt,
    ...(isString(value.completedAt) ? { completedAt: value.completedAt } : {}),
    ...(resumeSeed ? { resumeSeed } : {}),
    ...(hasOutput ? { output: value.output, outputHash } : {}),
    ...(isString(value.error) ? { error: value.error } : {}),
  };
}

function sanitizeApprovalResumeEvents(
  value: unknown,
  binding: { taskId: string; runId?: string },
  execution: Record<string, unknown>,
): RuntimeEventEnvelope[] | undefined {
  if (!Array.isArray(value) || value.length > 32) return undefined;
  const workflowId = execution.workflowId;
  const events: RuntimeEventEnvelope[] = [];
  for (const item of value) {
    if (!isRecord(item) || !isString(item.eventId) || item.eventVersion !== 1 ||
      !Number.isInteger(item.sequence) || (item.sequence as number) < 1 ||
      item.taskId !== binding.taskId || item.runId !== binding.runId ||
      (workflowId !== undefined && item.workflowId !== undefined && item.workflowId !== workflowId) ||
      !isString(item.occurredAt) || !isString(item.recordedAt) || !isRecord(item.payload)) {
      return undefined;
    }
    events.push(item as unknown as RuntimeEventEnvelope);
  }
  return events;
}

function selectApprovalResumeEvents(
  events: RuntimeEventEnvelope[],
  record: DurableApprovalRecord,
  stepId: string | undefined,
): RuntimeEventEnvelope[] {
  return events.filter((event) => {
    if (event.taskId !== record.taskId || event.runId !== record.runId) return false;
    const payload = isRecord(event.payload) ? event.payload : {};
    const eventStepId = isString(event.stepId)
      ? event.stepId
      : isString(payload.stepId) ? payload.stepId : undefined;
    const request = isRecord(payload.request) ? payload.request : undefined;
    const approvalId = isString(payload.approvalId)
      ? payload.approvalId
      : isString(payload.requestId) ? payload.requestId
        : request && isString(request.id) ? request.id : undefined;
    return eventStepId === stepId || approvalId === record.approvalId;
  }).slice(-32).map((event) => ({
    ...event,
    payload: sanitizeApprovalExecutionValue(record, event.payload),
  }));
}

function hasApprovalResumeEvidence(
  events: RuntimeEventEnvelope[],
  checkpoint: WorkflowCheckpoint,
  approvalId: string,
  stepId: string | undefined,
): boolean {
  if (checkpoint.approvalRequestIds.includes(approvalId)) return true;
  return events.some((event) => {
    const payload = isRecord(event.payload) ? event.payload : {};
    if (payload.kind !== "permission.requested") return false;
    const request = isRecord(payload.request) ? payload.request : undefined;
    const id = isString(payload.approvalId)
      ? payload.approvalId
      : request && isString(request.id) ? request.id : undefined;
    if (id !== approvalId) return false;
    const explicitStep = isString(event.stepId)
      ? event.stepId
      : isString(payload.stepId) ? payload.stepId : undefined;
    return !explicitStep || explicitStep === stepId;
  });
}

function sanitizeApprovalExecutionValue(record: DurableApprovalRecord, value: unknown): unknown {
  const sanitized = sanitizeArtifactForPersistence(createArtifactEnvelope(value, {
    taskId: record.taskId,
    runId: record.runId ?? `approval-${record.approvalId}`,
    type: `approval-execution:${record.toolName}`,
    producer: { stepId: record.execution?.stepId ?? "restored-approval", toolName: record.toolName },
    sensitivity: "workspace",
  })).payload;
  const serialized = JSON.stringify(sanitized);
  return serialized === undefined ? null : JSON.parse(serialized) as unknown;
}

function requireApprovalExecution(
  record: DurableApprovalRecord,
  expectedStatus: DurableApprovalExecutionStatus | DurableApprovalExecutionStatus[],
): DurableApprovalExecution {
  const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  if (!record.execution || !expected.includes(record.execution.status)) {
    throw new Error(`Approval execution must be in state ${expected.join(" or ")}.`);
  }
  return record.execution;
}

function isApprovalExecutionStatus(value: unknown): value is DurableApprovalExecutionStatus {
  return value === "started" || value === "succeeded" || value === "continuation_pending" ||
    value === "completed" || value === "failed" || value === "blocked";
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
  const edit: CodeProposedEdit = {
    ...(isString(value.approvalId) ? { approvalId: value.approvalId } : {}),
    proposalId: value.proposalId,
    workspacePath: value.workspacePath,
    summary: value.summary,
    changedFiles: value.changedFiles,
    patch: value.patch,
    patchHash: value.patchHash,
  };
  if (isString(value.baseGitHead)) {
    edit.baseGitHead = value.baseGitHead;
  }
  if (Array.isArray(value.hunks)) {
    edit.hunks = value.hunks;
  }
  return edit;
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
