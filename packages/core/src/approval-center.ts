/**
 * Unified approval center (D5).
 *
 * Approvals arrive from unrelated surfaces — file writes, browser scripts, terminal
 * input, git remote operations, computer use, PDF moves — each with its own payload
 * shape. The user sees them scattered across panels, and every one of them asks the
 * same question from scratch.
 *
 * This module normalizes them into one queue and adds the two things a queue makes
 * possible:
 *
 *  * **risk classification** (`safe` / `risky` / `dangerous`) with the reasons that
 *    produced it, so the card can say *why* it is risky rather than just showing a
 *    permission level;
 *  * **session grants** ("don't ask again"), which never cover a `dangerous` item —
 *    a blanket grant on a destructive operation is exactly the mistake this guards
 *    against.
 *
 * It records decisions; it never authorizes anything itself. The native approval
 * binding remains the enforcement boundary.
 */

import type { PermissionLevel, WriteRiskLevel } from "@javis/tools";

export type ApprovalSource =
  | "file"
  | "browser"
  | "terminal"
  | "git"
  | "computer"
  | "pdf"
  | "workspace"
  | "other";

export type ApprovalRisk = "safe" | "risky" | "dangerous";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface ApprovalCenterRequest {
  id: string;
  toolName: string;
  permissionLevel: PermissionLevel;
  title: string;
  reason: string;
  source: ApprovalSource;
  taskId?: string;
  taskTitle?: string;
  requestedAt?: string;
  expiresAt?: string;
  affectedPaths?: Array<{ target: string; action?: string }>;
  riskSummary?: string;
  reversible?: boolean;
  writeRiskLevel?: WriteRiskLevel;
}

export interface ApprovalCenterEntry extends ApprovalCenterRequest {
  risk: ApprovalRisk;
  /** Why the risk was assigned, most severe first. */
  riskReasons: string[];
  status: ApprovalStatus;
  decidedAt?: string;
  decidedBy?: "user" | "session_grant";
}

export interface SessionApprovalGrant {
  id: string;
  toolName: string;
  /** Empty means "any path for this tool". Otherwise a normalized path prefix. */
  pathScope: string;
  grantedAt: number;
  expiresAt: number;
}

export interface ApprovalCenterSummary {
  pending: number;
  byRisk: Record<ApprovalRisk, number>;
  bySource: Record<string, number>;
  oldestPendingAgeMs?: number;
}

export const DEFAULT_SESSION_GRANT_TTL_MS = 60 * 60 * 1_000;
/** Paths above this count make an operation risky on volume alone. */
export const RISKY_PATH_COUNT_THRESHOLD = 3;

export function normalizeApprovalPath(path: string): string {
  const slashes = path.trim().replace(/\\/gu, "/");
  const segments: string[] = [];
  for (const segment of slashes.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") {
        segments.pop();
      } else {
        segments.push("..");
      }
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function escapesWorkspace(path: string): boolean {
  return normalizeApprovalPath(path).startsWith("..");
}

export interface ApprovalRiskInput {
  permissionLevel: PermissionLevel;
  writeRiskLevel?: WriteRiskLevel;
  affectedPaths?: Array<{ target: string; action?: string }>;
  reversible?: boolean;
  source?: ApprovalSource;
  toolName?: string;
}

/**
 * Classifies an approval request and explains the classification.
 *
 * Deliberately conservative: anything irreversible, anything that escapes the
 * workspace, and anything already marked `dangerous` is `dangerous`; volume and
 * remote-mutating tools are `risky`.
 */
export function classifyApprovalRisk(
  request: ApprovalRiskInput,
): { risk: ApprovalRisk; reasons: string[] } {
  const reasons: string[] = [];
  let rank = 0;
  const escalate = (to: ApprovalRisk, reason: string) => {
    const next = to === "dangerous" ? 2 : to === "risky" ? 1 : 0;
    if (next > rank) {
      rank = next;
    }
    reasons.push(reason);
  };

  if (request.permissionLevel === "dangerous" || request.writeRiskLevel === "dangerous") {
    escalate("dangerous", "the tool itself is classified dangerous.");
  }
  if (request.reversible === false) {
    escalate("dangerous", "the operation is not reversible.");
  }

  const paths = request.affectedPaths ?? [];
  const escaping = paths.filter((entry) => escapesWorkspace(entry.target));
  if (escaping.length > 0) {
    escalate(
      "dangerous",
      `affects ${escaping.length} path(s) outside the workspace (${escaping[0].target}).`,
    );
  }

  if (request.permissionLevel === "confirmed_write" || request.permissionLevel === "preview") {
    escalate("risky", `permission level is ${request.permissionLevel}.`);
  }
  if (request.writeRiskLevel === "risky") {
    escalate("risky", "the tool is classified risky.");
  }
  if (paths.length > RISKY_PATH_COUNT_THRESHOLD) {
    escalate("risky", `affects ${paths.length} paths at once.`);
  }
  if (request.source === "git" || request.source === "terminal" || request.source === "browser") {
    escalate("risky", `${request.source} operations are not fully reversible locally.`);
  }

  if (reasons.length === 0) {
    reasons.push("read-only or preview-only scope.");
  }
  return { risk: rank === 2 ? "dangerous" : rank === 1 ? "risky" : "safe", reasons };
}

export interface ApprovalCenter {
  /** Adds a request (or refreshes an existing pending one). */
  submit(request: ApprovalCenterRequest): ApprovalCenterEntry;
  listPending(now?: number): ApprovalCenterEntry[];
  listAll(): ApprovalCenterEntry[];
  find(id: string): ApprovalCenterEntry | undefined;
  /** Records a user decision. */
  decide(id: string, decision: "approved" | "denied", now?: number): ApprovalCenterEntry | undefined;
  /** Counts entries whose TTL has passed as `expired`. */
  expireStale(now?: number): number;
  summary(now?: number): ApprovalCenterSummary;
  /** "Don't ask again" within this session. Refuses dangerous requests. */
  grantSessionApproval(input: {
    toolName: string;
    pathScope?: string;
    now?: number;
    ttlMs?: number;
  }): { granted: boolean; reason?: string; grant?: SessionApprovalGrant };
  /** True when an existing grant covers this request. */
  isCoveredBySessionGrant(request: Pick<ApprovalCenterRequest, "toolName" | "affectedPaths">, now?: number): boolean;
  listSessionGrants(now?: number): SessionApprovalGrant[];
  revokeSessionGrant(grantId: string): boolean;
}

export function createApprovalCenter(): ApprovalCenter {
  const entries = new Map<string, ApprovalCenterEntry>();
  const grants = new Map<string, SessionApprovalGrant>();
  let grantSequence = 0;

  function expireGrants(now: number): void {
    for (const [id, grant] of grants) {
      if (grant.expiresAt <= now) {
        grants.delete(id);
      }
    }
  }

  function covers(grant: SessionApprovalGrant, request: Pick<ApprovalCenterRequest, "toolName" | "affectedPaths">): boolean {
    if (grant.toolName !== request.toolName) {
      return false;
    }
    if (grant.pathScope.length === 0) {
      return true;
    }
    const paths = request.affectedPaths ?? [];
    if (paths.length === 0) {
      return false;
    }
    return paths.every((entry) => {
      const path = normalizeApprovalPath(entry.target);
      return path === grant.pathScope || path.startsWith(`${grant.pathScope}/`);
    });
  }

  const center: ApprovalCenter = {
    submit(request) {
      const now = Date.now();
      const classified = classifyApprovalRisk(request);
      const entry: ApprovalCenterEntry = {
        ...request,
        risk: classified.risk,
        riskReasons: classified.reasons,
        status: "pending",
        requestedAt: request.requestedAt ?? new Date(now).toISOString(),
      };
      entries.set(entry.id, entry);
      return entry;
    },

    listPending(now = Date.now()) {
      return [...entries.values()].filter(
        (entry) => entry.status === "pending" && !isExpired(entry, now),
      );
    },

    listAll() {
      return [...entries.values()];
    },

    find(id) {
      return entries.get(id);
    },

    decide(id, decision, now = Date.now()) {
      const entry = entries.get(id);
      if (!entry) {
        return undefined;
      }
      const next: ApprovalCenterEntry = {
        ...entry,
        status: decision,
        decidedAt: new Date(now).toISOString(),
        decidedBy: "user",
      };
      entries.set(id, next);
      return next;
    },

    expireStale(now = Date.now()) {
      expireGrants(now);
      let expired = 0;
      for (const [id, entry] of entries) {
        if (entry.status === "pending" && isExpired(entry, now)) {
          entries.set(id, { ...entry, status: "expired" });
          expired += 1;
        }
      }
      return expired;
    },

    summary(now = Date.now()) {
      const pending = center.listPending(now);
      const byRisk: Record<ApprovalRisk, number> = { safe: 0, risky: 0, dangerous: 0 };
      const bySource: Record<string, number> = {};
      let oldest: number | undefined;
      for (const entry of pending) {
        byRisk[entry.risk] += 1;
        bySource[entry.source] = (bySource[entry.source] ?? 0) + 1;
        const age = now - Date.parse(entry.requestedAt ?? new Date(now).toISOString());
        if (Number.isFinite(age) && (oldest === undefined || age > oldest)) {
          oldest = age;
        }
      }
      return {
        pending: pending.length,
        byRisk,
        bySource,
        ...(oldest !== undefined ? { oldestPendingAgeMs: oldest } : {}),
      };
    },

    grantSessionApproval({ toolName, pathScope = "", now = Date.now(), ttlMs = DEFAULT_SESSION_GRANT_TTL_MS }) {
      expireGrants(now);
      // A blanket grant on a destructive operation is the mistake this prevents.
      // Only an outstanding dangerous request blocks it: an expired or already
      // decided one must not veto every future grant for the same tool.
      const dangerousPending = [...entries.values()].find(
        (entry) => entry.toolName === toolName
          && entry.risk === "dangerous"
          && entry.status === "pending"
          && !isExpired(entry, now),
      );
      if (dangerousPending) {
        return {
          granted: false,
          reason: `"${toolName}" includes a dangerous operation; it must be approved every time.`,
        };
      }
      grantSequence += 1;
      const grant: SessionApprovalGrant = {
        id: `grant-${grantSequence}`,
        toolName,
        pathScope: normalizeApprovalPath(pathScope),
        grantedAt: now,
        expiresAt: now + ttlMs,
      };
      grants.set(grant.id, grant);
      return { granted: true, grant };
    },

    isCoveredBySessionGrant(request, now = Date.now()) {
      expireGrants(now);
      return [...grants.values()].some((grant) => covers(grant, request));
    },

    listSessionGrants(now = Date.now()) {
      expireGrants(now);
      return [...grants.values()];
    },

    revokeSessionGrant(grantId) {
      return grants.delete(grantId);
    },
  };

  return center;
}

function isExpired(entry: ApprovalCenterEntry, now: number): boolean {
  if (!entry.expiresAt) {
    return false;
  }
  const expiresAt = Date.parse(entry.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now;
}
