import { describe, expect, it } from "vitest";
import {
  DEFAULT_WRITE_LEASE_TTL_MS,
  createWriteLeaseRegistry,
  extractDeclaredWritePaths,
  normalizeLeasePath,
  pathsConflict,
} from "./write-lease";

describe("normalizeLeasePath", () => {
  it("unifies separators and drops redundant segments", () => {
    expect(normalizeLeasePath("src\\a.ts")).toBe("src/a.ts");
    expect(normalizeLeasePath("./src//a.ts")).toBe("src/a.ts");
    expect(normalizeLeasePath("src/nested/../a.ts")).toBe("src/a.ts");
    expect(normalizeLeasePath("src/")).toBe("src");
    expect(normalizeLeasePath("  src/a.ts  ")).toBe("src/a.ts");
  });

  it("keeps an absolute root and leading parent segments", () => {
    expect(normalizeLeasePath("/src/../a.ts")).toBe("/a.ts");
    expect(normalizeLeasePath("../outside.md")).toBe("../outside.md");
  });
});

describe("pathsConflict", () => {
  it("conflicts on the same path after normalization", () => {
    expect(pathsConflict("src/a.ts", "src\\a.ts")).toBe(true);
    expect(pathsConflict("./notes.md", "notes.md")).toBe(true);
  });

  it("conflicts between a directory and a file inside it, in both directions", () => {
    expect(pathsConflict("src", "src/a.ts")).toBe(true);
    expect(pathsConflict("src/a.ts", "src")).toBe(true);
    expect(pathsConflict("src/a.ts", "src/b.ts")).toBe(false);
  });

  it("does not conflict on a shared prefix that is not a directory boundary", () => {
    expect(pathsConflict("src/a", "src/ab")).toBe(false);
    expect(pathsConflict("notes.md", "notes.md.bak")).toBe(false);
  });
});

describe("write lease registry", () => {
  it("lets unrelated paths be written in parallel", () => {
    const registry = createWriteLeaseRegistry();
    const first = registry.acquire({ taskId: "t", stepId: "s1", paths: ["src/a.ts"] });
    const second = registry.acquire({ taskId: "t", stepId: "s2", paths: ["src/b.ts"] });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(registry.listHeld()).toHaveLength(2);
  });

  it("reports who holds a conflicting path", () => {
    const registry = createWriteLeaseRegistry();
    registry.acquire({ taskId: "t1", stepId: "writer-a", paths: ["notes.md"] });
    const result = registry.acquire({ taskId: "t1", stepId: "writer-b", paths: ["notes.md"] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      path: "notes.md",
      heldBy: { taskId: "t1", stepId: "writer-a" },
    });
  });

  it("blocks a child path when a directory is claimed, and vice versa", () => {
    const registry = createWriteLeaseRegistry();
    registry.acquire({ taskId: "t", stepId: "tree-writer", paths: ["src"] });
    expect(registry.acquire({ taskId: "t", stepId: "file-writer", paths: ["src/a.ts"] }).ok).toBe(false);
    expect(registry.isHeld("src/deep/b.ts")).toBe(true);

    const other = createWriteLeaseRegistry();
    other.acquire({ taskId: "t", stepId: "file-writer", paths: ["src/a.ts"] });
    expect(other.acquire({ taskId: "t", stepId: "tree-writer", paths: ["src"] }).ok).toBe(false);
  });

  it("is reentrant for the same step", () => {
    const registry = createWriteLeaseRegistry();
    registry.acquire({ taskId: "t", stepId: "s1", paths: ["src/a.ts"] });
    expect(registry.acquire({ taskId: "t", stepId: "s1", paths: ["src/a.ts"] }).ok).toBe(true);
    // Overlapping but not identical is still the same writer.
    expect(registry.acquire({ taskId: "t", stepId: "s1", paths: ["src"] }).ok).toBe(true);
  });

  it("frees the path on release", () => {
    const registry = createWriteLeaseRegistry();
    const first = registry.acquire({ taskId: "t", stepId: "s1", paths: ["notes.md"] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(registry.acquire({ taskId: "t", stepId: "s2", paths: ["notes.md"] }).ok).toBe(false);
    expect(registry.release(first.lease.leaseId)).toBe(true);
    expect(registry.acquire({ taskId: "t", stepId: "s2", paths: ["notes.md"] }).ok).toBe(true);
    // Releasing twice is a no-op, not an error.
    expect(registry.release(first.lease.leaseId)).toBe(false);
  });

  it("releases every lease a step holds", () => {
    const registry = createWriteLeaseRegistry();
    registry.acquire({ taskId: "t", stepId: "s1", paths: ["a.md"] });
    registry.acquire({ taskId: "t", stepId: "s1", paths: ["b.md"] });
    registry.acquire({ taskId: "t", stepId: "s2", paths: ["c.md"] });
    expect(registry.releaseStep("t", "s1")).toBe(2);
    expect(registry.listHeld().map((lease) => lease.paths[0])).toEqual(["c.md"]);
  });

  it("never deadlocks a crashed step: an expired lease is available again", () => {
    const registry = createWriteLeaseRegistry({ ttlMs: 1_000 });
    const start = 1_000_000;
    const first = registry.acquire({ taskId: "t", stepId: "crashed", paths: ["notes.md"], now: start });
    expect(first.ok).toBe(true);

    // Still held just before its TTL passes.
    expect(registry.acquire({
      taskId: "t",
      stepId: "next",
      paths: ["notes.md"],
      now: start + 999,
    }).ok).toBe(false);

    // Available once the TTL passes, without any explicit cleanup.
    const after = registry.acquire({ taskId: "t", stepId: "next", paths: ["notes.md"], now: start + 1_001 });
    expect(after.ok).toBe(true);
    expect(registry.listHeld(start + 1_001)).toHaveLength(1);
  });

  it("defaults to a five minute TTL so a live step is not pre-empted", () => {
    expect(DEFAULT_WRITE_LEASE_TTL_MS).toBe(5 * 60 * 1_000);
    const registry = createWriteLeaseRegistry();
    const start = 5_000;
    const result = registry.acquire({ taskId: "t", stepId: "s1", paths: ["a.md"], now: start });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lease.expiresAt).toBe(start + DEFAULT_WRITE_LEASE_TTL_MS);
  });

  it("expires stale leases on demand and reports the count", () => {
    const registry = createWriteLeaseRegistry({ ttlMs: 10 });
    registry.acquire({ taskId: "t", stepId: "s1", paths: ["a.md"], now: 0 });
    registry.acquire({ taskId: "t", stepId: "s2", paths: ["b.md"], now: 0 });
    expect(registry.expireStale(5)).toBe(0);
    expect(registry.expireStale(11)).toBe(2);
    expect(registry.listHeld(11)).toEqual([]);
  });

  it("treats a claim of no paths as vacuously granted", () => {
    const registry = createWriteLeaseRegistry();
    const result = registry.acquire({ taskId: "t", stepId: "read-only", paths: [] });
    expect(result.ok).toBe(true);
    expect(registry.isHeld("anything.md")).toBe(false);
  });

  it("de-duplicates paths within one claim", () => {
    const registry = createWriteLeaseRegistry();
    const result = registry.acquire({
      taskId: "t",
      stepId: "s1",
      paths: ["src/a.ts", "./src/a.ts", "src\\a.ts"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lease.paths).toEqual(["src/a.ts"]);
  });
});

describe("extractDeclaredWritePaths", () => {
  it("collects the explicit path-bearing inputs", () => {
    expect(extractDeclaredWritePaths({
      targetPath: "notes.md",
      paths: ["a.md", "b.md"],
      goal: "find the thing called path.md",
    })).toEqual(["notes.md", "a.md", "b.md"]);
  });

  it("ignores free-text inputs so it does not invent conflicts", () => {
    expect(extractDeclaredWritePaths({ goal: "write to /etc/passwd" })).toEqual([]);
    expect(extractDeclaredWritePaths(undefined)).toEqual([]);
    expect(extractDeclaredWritePaths({ targetPath: "   " })).toEqual([]);
  });

  it("de-duplicates across keys", () => {
    expect(extractDeclaredWritePaths({ targetPath: "a.md", path: "a.md" })).toEqual(["a.md"]);
  });
});
