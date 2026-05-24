import type { DryRunSummary, PermissionRequest } from "@javis/tools";

export type PermissionDecision = "approved" | "denied";
export type PermissionCloseStatus = "cancelled" | "expired";
export type ApprovablePermissionLevel = Exclude<PermissionRequest["level"], "dangerous">;
export const DEFAULT_PERMISSION_TTL_MS = 10 * 60 * 1000;

export interface PendingPermissionRequestInput {
  id: string;
  level: ApprovablePermissionLevel;
  title: string;
  reason: string;
  dryRun: DryRunSummary;
}

export function createPendingPermissionRequest(
  input: PendingPermissionRequestInput,
  now: () => string = createTimestamp,
): PermissionRequest {
  if ((input.level as PermissionRequest["level"]) === "dangerous") {
    throw new Error("Dangerous permission requests are rejected by default.");
  }

  return {
    id: input.id,
    level: input.level,
    title: input.title,
    reason: input.reason,
    dryRun: input.dryRun,
    bindingHash: createDryRunBindingHash(input.dryRun),
    status: "pending",
    createdAt: now(),
  };
}

export function resolvePermissionRequest(
  request: PermissionRequest,
  decision: PermissionDecision,
  now: () => string = createTimestamp,
): PermissionRequest {
  assertPendingPermissionRequest(request);
  assertPermissionBindingCurrent(request);

  return {
    ...request,
    status: decision,
    resolvedAt: now(),
  };
}

export function cancelPermissionRequest(
  request: PermissionRequest,
  now: () => string = createTimestamp,
): PermissionRequest {
  return closePermissionRequest(request, "cancelled", now);
}

export function expirePermissionRequest(
  request: PermissionRequest,
  now: () => string = createTimestamp,
): PermissionRequest {
  return closePermissionRequest(request, "expired", now);
}

export function expirePermissionRequestIfStale(
  request: PermissionRequest,
  options: {
    ttlMs?: number;
    now?: () => string;
  } = {},
): PermissionRequest {
  assertPendingPermissionRequest(request);
  assertPermissionBindingCurrent(request);

  const now = options.now ?? createTimestamp;
  const currentTimestamp = now();
  if (!isPermissionRequestStale(request, options.ttlMs ?? DEFAULT_PERMISSION_TTL_MS, currentTimestamp)) {
    return request;
  }

  return {
    ...request,
    status: "expired",
    resolvedAt: currentTimestamp,
  };
}

export function isPermissionRequestStale(
  request: PermissionRequest,
  ttlMs: number = DEFAULT_PERMISSION_TTL_MS,
  now: string = createTimestamp(),
): boolean {
  if (request.status !== "pending") {
    return false;
  }

  const createdAtMs = Date.parse(request.createdAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(nowMs)) {
    return false;
  }

  return nowMs - createdAtMs >= ttlMs;
}

function closePermissionRequest(
  request: PermissionRequest,
  status: PermissionCloseStatus,
  now: () => string,
): PermissionRequest {
  assertPendingPermissionRequest(request);
  assertPermissionBindingCurrent(request);

  return {
    ...request,
    status,
    resolvedAt: now(),
  };
}

function assertPendingPermissionRequest(request: PermissionRequest): void {
  if (request.status !== "pending") {
    throw new Error(`Permission request ${request.id} is already ${request.status}.`);
  }
}

function assertPermissionBindingCurrent(request: PermissionRequest): void {
  if (request.bindingHash && request.bindingHash !== createDryRunBindingHash(request.dryRun)) {
    throw new Error(`Permission request ${request.id} dry-run no longer matches its binding hash.`);
  }
}

function createTimestamp(): string {
  return new Date().toISOString();
}

export function createDryRunBindingHash(dryRun: DryRunSummary): string {
  // Internal consistency fingerprint; native execution boundaries still enforce permissions.
  const payload = JSON.stringify(normalizeDryRunSummary(dryRun));
  let hash = 2166136261;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `dryrun-fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function normalizeDryRunSummary(dryRun: DryRunSummary) {
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
