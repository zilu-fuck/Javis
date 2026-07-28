import { describe, expect, it, vi } from "vitest";
import type { FileEntry } from "./local-knowledge";
import { inspectWorkspaceTree } from "./workspace-inspection-service";

describe("inspectWorkspaceTree", () => {
  it("returns bounded non-Git workspace evidence with modules, manifests, and risks", async () => {
    const listings = new Map<string, FileEntry[]>([
      ["E:/workspace", [
        { name: "apps", path: "E:/workspace/apps", isDir: true },
        { name: "packages", path: "E:/workspace/packages", isDir: true },
        { name: "node_modules", path: "E:/workspace/node_modules", isDir: true },
        { name: "package.json", path: "E:/workspace/package.json", isDir: false, sizeBytes: 1200, extension: "json" },
        { name: ".env", path: "E:/workspace/.env", isDir: false, sizeBytes: 100 },
      ]],
      ["E:/workspace/apps", [
        { name: "desktop", path: "E:/workspace/apps/desktop", isDir: true },
      ]],
      ["E:/workspace/packages", [
        { name: "core", path: "E:/workspace/packages/core", isDir: true },
      ]],
      ["E:/workspace/apps/desktop", [
        { name: "src", path: "E:/workspace/apps/desktop/src", isDir: true },
      ]],
      ["E:/workspace/packages/core", []],
    ]);
    const listDirectory = vi.fn(async (path: string) => listings.get(path) ?? []);

    const result = await inspectWorkspaceTree("E:/workspace", {}, { listDirectory });

    expect(result.topLevelDirectories).toEqual(["apps", "node_modules", "packages"]);
    expect(result.moduleCandidates).toEqual(["apps", "packages"]);
    expect(result.manifests).toEqual(["package.json"]);
    expect(result.ignoredDirectories).toEqual(["node_modules"]);
    expect(result.entries).toContainEqual(expect.objectContaining({
      relativePath: "apps/desktop/src",
      depth: 3,
      isDir: true,
    }));
    expect(result.riskIndicators).toContainEqual(expect.objectContaining({
      code: "sensitive_name",
      path: ".env",
    }));
    expect(listDirectory).not.toHaveBeenCalledWith("E:/workspace/node_modules");
    expect(result.truncated).toBe(false);
  });

  it("marks evidence as truncated when the entry bound is reached", async () => {
    const listDirectory = vi.fn(async () => Array.from({ length: 25 }, (_, index) => ({
      name: `file-${index}.txt`,
      path: `E:/workspace/file-${index}.txt`,
      isDir: false,
      sizeBytes: 1,
      extension: "txt",
    })));

    const result = await inspectWorkspaceTree("E:/workspace", { maxEntries: 20 }, { listDirectory });

    expect(result.entries).toHaveLength(20);
    expect(result.truncated).toBe(true);
    expect(result.riskIndicators.map((risk) => risk.code)).toEqual(expect.arrayContaining([
      "manifest_missing",
      "inspection_truncated",
    ]));
  });

  it("omits non-numeric native size values from the strict tool output", async () => {
    const listDirectory = vi.fn(async (): Promise<FileEntry[]> => [
      {
        name: "src",
        path: "E:/workspace/src",
        isDir: true,
        sizeBytes: null as unknown as number,
      },
      {
        name: "README.md",
        path: "E:/workspace/README.md",
        isDir: false,
        sizeBytes: Number.NaN,
        extension: "md",
      },
    ]);

    const result = await inspectWorkspaceTree("E:/workspace", { maxDepth: 1 }, { listDirectory });

    expect(result.entries).toEqual([
      { name: "src", relativePath: "src", isDir: true, depth: 1 },
      { name: "README.md", relativePath: "README.md", isDir: false, depth: 1, extension: "md" },
    ]);
  });
});
