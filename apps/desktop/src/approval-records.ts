import type { CodeProposedEdit, PermissionRequest } from "@javis/tools";

export const APPROVAL_RECORDS_STORAGE_KEY = "javis.approvalRecords.v1";
export const APPROVAL_RECORDS_STORAGE_VERSION = 1;
export const APPROVAL_RECORDS_LIMIT = 20;

type ApprovalRecordStorage = Pick<Storage, "getItem" | "setItem">;

export type DurableApprovalStatus = "pending" | "approved" | "denied" | "expired";
type PlannedPath = PermissionRequest["dryRun"]["affectedPaths"][number];

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
}

export interface ApprovalRecordInput {
  taskId: string;
  toolName: string;
  workspacePath: string;
  permissionRequest: PermissionRequest;
  codeProposedEdit?: CodeProposedEdit;
  ttlMs?: number;
  now?: string;
}

interface ApprovalRecordsEnvelope {
  version: typeof APPROVAL_RECORDS_STORAGE_VERSION;
  records: DurableApprovalRecord[];
}

export function loadApprovalRecords(storage: ApprovalRecordStorage): DurableApprovalRecord[] {
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
  storage: ApprovalRecordStorage,
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
  if (permissionRequest.status !== value.status) {
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
  const codeProposedEdit = sanitizeCodeProposedEdit(value.codeProposedEdit);
  if (codeProposedEdit) {
    record.codeProposedEdit = codeProposedEdit;
  }
  if (isString(value.resolvedAt)) {
    record.resolvedAt = value.resolvedAt;
  }
  if (isDecision(value.decision)) {
    record.decision = value.decision;
  }
  return record;
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
    proposalId: value.proposalId,
    workspacePath: value.workspacePath,
    summary: value.summary,
    changedFiles: value.changedFiles,
    patch: value.patch,
    patchHash: value.patchHash,
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
    ("resolvedAt" in value && !isString(value.resolvedAt)) ||
    !isRecord(value.dryRun)
  ) {
    return null;
  }
  const dryRun = value.dryRun;
  if (
    !isString(dryRun.operation) ||
    !Array.isArray(dryRun.affectedPaths) ||
    !isString(dryRun.riskSummary) ||
    typeof dryRun.reversible !== "boolean"
  ) {
    return null;
  }
  const affectedPaths = dryRun.affectedPaths
    .map(sanitizePlannedPath)
    .filter((path): path is PlannedPath => Boolean(path));
  if (affectedPaths.length !== dryRun.affectedPaths.length) {
    return null;
  }
  const request: PermissionRequest = {
    id: value.id,
    level: value.level,
    title: value.title,
    reason: value.reason,
    dryRun: {
      operation: dryRun.operation,
      affectedPaths,
      riskSummary: dryRun.riskSummary,
      reversible: dryRun.reversible,
    },
    bindingHash: value.bindingHash,
    status: value.status,
    createdAt: value.createdAt,
  };
  if (isString(value.resolvedAt)) {
    request.resolvedAt = value.resolvedAt;
  }
  return request;
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
    value === "overwrite"
  );
}
