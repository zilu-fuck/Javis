/**
 * Write leases (D4).
 *
 * The DAG runs independent steps in parallel, and nothing stopped two of them from
 * writing the same file: the last writer won and the other step's verification ran
 * against a file it no longer owned. Approvals make that worse rather than better —
 * both steps can hold a valid approval for the same path.
 *
 * A lease is a short-lived, path-scoped claim:
 *
 *  * **path-level mutual exclusion** with containment, so a claim on `src` blocks
 *    `src/a.ts` and vice versa (a directory write and a file write do collide);
 *  * **reentrancy for the same step**, because a step re-declaring an overlapping
 *    path is not a conflict with itself;
 *  * **a TTL**, because a crashed or killed step must not deadlock the rest of the
 *    DAG — an expired lease is available again without any cleanup call;
 *  * **explicit release**, so the common case frees the path immediately.
 *
 * Leases are deliberately not persisted: they coordinate the running process, and a
 * restart has no concurrent writers to coordinate with.
 */

export interface WriteLeaseRequest {
  taskId: string;
  stepId: string;
  paths: readonly string[];
  /** Overrides the registry default for this claim. */
  ttlMs?: number;
  /** Injected clock, for deterministic tests. */
  now?: number;
}

export interface WriteLease {
  leaseId: string;
  taskId: string;
  stepId: string;
  paths: string[];
  acquiredAt: number;
  expiresAt: number;
}

export interface WriteLeaseConflict {
  /** The path that could not be claimed. */
  path: string;
  heldBy: { taskId: string; stepId: string; leaseId: string };
}

export type AcquireWriteLeaseResult =
  | { ok: true; lease: WriteLease }
  | { ok: false; conflicts: WriteLeaseConflict[] };

export interface WriteLeaseRegistry {
  acquire(request: WriteLeaseRequest): AcquireWriteLeaseResult;
  release(leaseId: string): boolean;
  /** Releases every lease a step holds; returns how many were released. */
  releaseStep(taskId: string, stepId: string): number;
  listHeld(now?: number): WriteLease[];
  /** Drops expired leases; returns how many were removed. */
  expireStale(now?: number): number;
  isHeld(path: string, now?: number): boolean;
}

export const DEFAULT_WRITE_LEASE_TTL_MS = 5 * 60 * 1_000;

let leaseSequence = 0;

/**
 * Normalizes a path for comparison: forward slashes, no trailing slash, resolved
 * `.` / `..` segments, collapsed duplicates. Case is preserved — the platform that
 * cares about case does its own check at the native boundary.
 */
export function normalizeLeasePath(path: string): string {
  const withSlashes = path.trim().replace(/\\/gu, "/");
  const absolute = withSlashes.startsWith("/");
  const segments: string[] = [];
  for (const segment of withSlashes.split("/")) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") {
        segments.pop();
      } else if (!absolute) {
        segments.push("..");
      }
      continue;
    }
    segments.push(segment);
  }
  return `${absolute ? "/" : ""}${segments.join("/")}`;
}

/** True when two paths are the same file, or one contains the other. */
export function pathsConflict(left: string, right: string): boolean {
  const a = normalizeLeasePath(left);
  const b = normalizeLeasePath(right);
  if (a === b) {
    return true;
  }
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function createWriteLeaseRegistry(
  options: { ttlMs?: number } = {},
): WriteLeaseRegistry {
  const defaultTtlMs = options.ttlMs ?? DEFAULT_WRITE_LEASE_TTL_MS;
  const leases = new Map<string, WriteLease>();

  function expireStale(now = Date.now()): number {
    let removed = 0;
    for (const [leaseId, lease] of leases) {
      if (lease.expiresAt <= now) {
        leases.delete(leaseId);
        removed += 1;
      }
    }
    return removed;
  }

  function heldByOther(
    candidate: { taskId: string; stepId: string },
    path: string,
    now: number,
  ): WriteLeaseConflict | undefined {
    for (const lease of leases.values()) {
      if (lease.expiresAt <= now) {
        continue;
      }
      // The same step re-claiming an overlapping path is not a conflict with itself.
      if (lease.taskId === candidate.taskId && lease.stepId === candidate.stepId) {
        continue;
      }
      if (lease.paths.some((held) => pathsConflict(held, path))) {
        return {
          path,
          heldBy: { taskId: lease.taskId, stepId: lease.stepId, leaseId: lease.leaseId },
        };
      }
    }
    return undefined;
  }

  return {
    acquire(request) {
      const now = request.now ?? Date.now();
      expireStale(now);

      const paths = [...new Set(request.paths.map(normalizeLeasePath).filter(Boolean))];
      if (paths.length === 0) {
        // Claiming nothing cannot conflict with anything.
        leaseSequence += 1;
        return {
          ok: true,
          lease: {
            leaseId: `lease-${leaseSequence}`,
            taskId: request.taskId,
            stepId: request.stepId,
            paths: [],
            acquiredAt: now,
            expiresAt: now,
          },
        };
      }

      const conflicts: WriteLeaseConflict[] = [];
      for (const path of paths) {
        const conflict = heldByOther(request, path, now);
        if (conflict) {
          conflicts.push(conflict);
        }
      }
      if (conflicts.length > 0) {
        return { ok: false, conflicts };
      }

      const ttlMs = request.ttlMs ?? defaultTtlMs;
      leaseSequence += 1;
      const lease: WriteLease = {
        leaseId: `lease-${leaseSequence}`,
        taskId: request.taskId,
        stepId: request.stepId,
        paths,
        acquiredAt: now,
        expiresAt: now + ttlMs,
      };
      leases.set(lease.leaseId, lease);
      return { ok: true, lease };
    },

    release(leaseId) {
      return leases.delete(leaseId);
    },

    releaseStep(taskId, stepId) {
      let released = 0;
      for (const [leaseId, lease] of leases) {
        if (lease.taskId === taskId && lease.stepId === stepId) {
          leases.delete(leaseId);
          released += 1;
        }
      }
      return released;
    },

    listHeld(now = Date.now()) {
      return [...leases.values()].filter((lease) => lease.expiresAt > now);
    },

    expireStale,

    isHeld(path, now = Date.now()) {
      return this.listHeld(now).some((lease) => lease.paths.some((held) => pathsConflict(held, path)));
    },
  };
}

/**
 * Candidate write paths a step declares, used to lease before dispatch.
 *
 * Only explicit path-bearing inputs are considered: guessing a path from free text
 * would produce false conflicts that block legitimate parallel work.
 */
export const WRITE_PATH_INPUT_KEYS: readonly string[] = [
  "targetPath",
  "destinationPath",
  "destination",
  "paths",
  "path",
  "targetPaths",
];

export function extractDeclaredWritePaths(toolInput: Record<string, unknown> | undefined): string[] {
  if (!toolInput) {
    return [];
  }
  const paths: string[] = [];
  for (const key of WRITE_PATH_INPUT_KEYS) {
    const value = toolInput[key];
    if (typeof value === "string" && value.trim().length > 0) {
      paths.push(value);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim().length > 0) {
          paths.push(item);
        }
      }
    }
  }
  return [...new Set(paths)];
}
