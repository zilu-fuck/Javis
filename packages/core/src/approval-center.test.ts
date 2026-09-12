import { describe, expect, it } from "vitest";
import {
  DEFAULT_SESSION_GRANT_TTL_MS,
  RISKY_PATH_COUNT_THRESHOLD,
  classifyApprovalRisk,
  createApprovalCenter,
  normalizeApprovalPath,
  type ApprovalCenterRequest,
} from "./approval-center";

function request(overrides: Partial<ApprovalCenterRequest> = {}): ApprovalCenterRequest {
  return {
    id: "approval-1",
    toolName: "file.writeText",
    permissionLevel: "confirmed_write",
    title: "Write notes.md",
    reason: "Writing changes the filesystem.",
    source: "file",
    affectedPaths: [{ target: "notes.md", action: "create" }],
    reversible: true,
    ...overrides,
  };
}

describe("normalizeApprovalPath", () => {
  it("unifies separators and resolves segments", () => {
    expect(normalizeApprovalPath("src\\a.ts")).toBe("src/a.ts");
    expect(normalizeApprovalPath("./src//a.ts")).toBe("src/a.ts");
    expect(normalizeApprovalPath("src/../a.ts")).toBe("a.ts");
    expect(normalizeApprovalPath("../outside.md")).toBe("../outside.md");
  });
});

describe("classifyApprovalRisk", () => {
  it("treats a plain in-workspace write as risky", () => {
    const result = classifyApprovalRisk(request());
    expect(result.risk).toBe("risky");
    expect(result.reasons.join(" ")).toContain("permission level is confirmed_write");
  });

  it("treats a read-only request as safe", () => {
    const result = classifyApprovalRisk({ permissionLevel: "read", source: "file" });
    expect(result.risk).toBe("safe");
    expect(result.reasons[0]).toContain("read-only");
  });

  it("escalates anything irreversible or already dangerous to dangerous", () => {
    expect(classifyApprovalRisk({ permissionLevel: "confirmed_write", reversible: false }).risk)
      .toBe("dangerous");
    expect(classifyApprovalRisk({ permissionLevel: "dangerous" }).risk).toBe("dangerous");
    expect(classifyApprovalRisk({ permissionLevel: "confirmed_write", writeRiskLevel: "dangerous" }).risk)
      .toBe("dangerous");
  });

  it("escalates a path that escapes the workspace, and names it", () => {
    const result = classifyApprovalRisk(
      request({ affectedPaths: [{ target: "notes.md" }, { target: "../../secrets.env" }] }),
    );
    expect(result.risk).toBe("dangerous");
    expect(result.reasons.join(" ")).toContain("outside the workspace");
    expect(result.reasons.join(" ")).toContain("../../secrets.env");
  });

  it("escalates on volume alone", () => {
    const many = Array.from({ length: RISKY_PATH_COUNT_THRESHOLD + 1 }, (_, index) => ({
      target: `file-${index}.md`,
    }));
    const result = classifyApprovalRisk(request({ affectedPaths: many }));
    expect(result.risk).toBe("risky");
    expect(result.reasons.join(" ")).toContain("paths at once");
  });

  it("marks remote-mutating and script surfaces risky", () => {
    for (const source of ["git", "terminal", "browser"] as const) {
      expect(classifyApprovalRisk({ permissionLevel: "read", source }).risk).toBe("risky");
    }
  });
});

describe("approval center queue", () => {
  it("normalizes submissions and lists them newest-state first", () => {
    const center = createApprovalCenter();
    const entry = center.submit(request());
    expect(entry.status).toBe("pending");
    expect(entry.risk).toBe("risky");
    expect(entry.riskReasons.length).toBeGreaterThan(0);
    expect(center.listPending()).toHaveLength(1);
  });

  it("records a decision and stops listing the entry as pending", () => {
    const center = createApprovalCenter();
    center.submit(request());
    const decided = center.decide("approval-1", "denied");
    expect(decided?.status).toBe("denied");
    expect(decided?.decidedBy).toBe("user");
    expect(center.listPending()).toHaveLength(0);
    expect(center.listAll()).toHaveLength(1);
    expect(center.decide("missing", "approved")).toBeUndefined();
  });

  it("expires a stale pending entry and reports the count", () => {
    const center = createApprovalCenter();
    center.submit(request({ id: "old", expiresAt: "2026-01-01T00:00:00.000Z" }));
    center.submit(request({ id: "fresh", expiresAt: "2099-01-01T00:00:00.000Z" }));
    expect(center.listPending(Date.parse("2026-06-01T00:00:00.000Z"))).toHaveLength(1);
    expect(center.expireStale(Date.parse("2026-06-01T00:00:00.000Z"))).toBe(1);
    expect(center.find("old")?.status).toBe("expired");
  });

  it("summarizes the queue for a badge", () => {
    const center = createApprovalCenter();
    const now = Date.parse("2026-06-01T12:00:00.000Z");
    center.submit(request({ id: "a", requestedAt: "2026-06-01T11:00:00.000Z" }));
    center.submit(request({ id: "b", source: "git", affectedPaths: [{ target: "a.ts" }], requestedAt: "2026-06-01T11:59:00.000Z" }));
    center.submit(request({ id: "c", reversible: false, requestedAt: "2026-06-01T11:58:00.000Z" }));
    const summary = center.summary(now);
    expect(summary.pending).toBe(3);
    expect(summary.byRisk).toEqual({ safe: 0, risky: 2, dangerous: 1 });
    expect(summary.bySource).toEqual({ file: 2, git: 1 });
    // The oldest pending entry drives an SLA-style warning.
    expect(summary.oldestPendingAgeMs).toBe(60 * 60 * 1_000);
  });
});

describe("session grants (don't ask again)", () => {
  it("covers a matching tool and path, and refuses a different tool", () => {
    const center = createApprovalCenter();
    const granted = center.grantSessionApproval({ toolName: "file.writeText", pathScope: "notes" });
    expect(granted.granted).toBe(true);
    expect(center.isCoveredBySessionGrant({ toolName: "file.writeText", affectedPaths: [{ target: "notes/a.md" }] }))
      .toBe(true);
    expect(center.isCoveredBySessionGrant({ toolName: "file.writeText", affectedPaths: [{ target: "other/a.md" }] }))
      .toBe(false);
    expect(center.isCoveredBySessionGrant({ toolName: "git.createCommit", affectedPaths: [{ target: "notes/a.md" }] }))
      .toBe(false);
  });

  it("covers every path when the grant has no scope", () => {
    const center = createApprovalCenter();
    center.grantSessionApproval({ toolName: "file.writeText" });
    expect(center.isCoveredBySessionGrant({
      toolName: "file.writeText",
      affectedPaths: [{ target: "anywhere/at/all.md" }],
    })).toBe(true);
  });

  it("requires an explicit path when the grant is scoped and the request names none", () => {
    const center = createApprovalCenter();
    center.grantSessionApproval({ toolName: "file.writeText", pathScope: "notes" });
    expect(center.isCoveredBySessionGrant({ toolName: "file.writeText" })).toBe(false);
  });

  it("never grants blanket approval for a dangerous operation", () => {
    const center = createApprovalCenter();
    center.submit(request({ id: "danger", reversible: false }));
    const granted = center.grantSessionApproval({ toolName: "file.writeText" });
    expect(granted.granted).toBe(false);
    expect(granted.reason).toContain("must be approved every time");
    expect(center.listSessionGrants()).toEqual([]);
  });

  it("expires grants and supports explicit revocation", () => {
    const center = createApprovalCenter();
    const start = 1_000_000;
    const granted = center.grantSessionApproval({
      toolName: "file.writeText",
      now: start,
      ttlMs: 1_000,
    });
    expect(granted.granted).toBe(true);
    expect(center.listSessionGrants(start + 500)).toHaveLength(1);
    expect(center.listSessionGrants(start + 1_001)).toHaveLength(0);
    expect(DEFAULT_SESSION_GRANT_TTL_MS).toBe(60 * 60 * 1_000);

    const again = center.grantSessionApproval({ toolName: "file.writeText", now: start });
    expect(again.grant).toBeDefined();
    if (!again.grant) return;
    expect(center.revokeSessionGrant(again.grant.id)).toBe(true);
    expect(center.revokeSessionGrant(again.grant.id)).toBe(false);
    expect(center.listSessionGrants(start)).toHaveLength(0);
  });

  it("does not let a stale dangerous entry block a fresh grant forever", () => {
    const center = createApprovalCenter();
    center.submit(request({ id: "danger", reversible: false, expiresAt: "2026-01-01T00:00:00.000Z" }));
    const granted = center.grantSessionApproval({ toolName: "file.writeText" });
    expect(granted.granted).toBe(true);
  });
});
