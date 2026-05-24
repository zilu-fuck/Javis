import { describe, expect, it } from "vitest";
import {
  RECENT_WORKSPACES_LIMIT,
  RECENT_WORKSPACES_STORAGE_KEY,
  RECENT_WORKSPACES_STORAGE_VERSION,
  loadRecentWorkspacePaths,
  removeRecentWorkspacePath,
  saveRecentWorkspacePaths,
  upsertRecentWorkspacePath,
} from "./recent-workspaces";

describe("recent workspace persistence", () => {
  it("loads sanitized recent workspace paths", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      RECENT_WORKSPACES_STORAGE_KEY,
      JSON.stringify([" E:/Javis ", "", 42, "E:/Javis", "F:/Other"]),
    );

    expect(loadRecentWorkspacePaths(storage)).toEqual(["E:/Javis", "F:/Other"]);
  });

  it("loads versioned recent workspace storage envelopes", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      RECENT_WORKSPACES_STORAGE_KEY,
      JSON.stringify({
        version: RECENT_WORKSPACES_STORAGE_VERSION,
        paths: [" E:/Javis ", "", 42, "F:/Other"],
      }),
    );

    expect(loadRecentWorkspacePaths(storage)).toEqual(["E:/Javis", "F:/Other"]);
  });

  it("ignores recent workspace storage envelopes from unknown versions", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      RECENT_WORKSPACES_STORAGE_KEY,
      JSON.stringify({
        version: RECENT_WORKSPACES_STORAGE_VERSION + 1,
        paths: ["E:/Javis"],
      }),
    );

    expect(loadRecentWorkspacePaths(storage)).toEqual([]);
  });

  it("upserts paths at the front without case-insensitive duplicates", () => {
    const paths = upsertRecentWorkspacePath(["E:/Javis", "F:/Other"], "e:/javis");

    expect(paths).toEqual(["e:/javis", "F:/Other"]);
  });

  it("saves only the configured limit", () => {
    const storage = createMemoryStorage();
    const paths = Array.from({ length: RECENT_WORKSPACES_LIMIT + 2 }, (_, index) =>
      `E:/Project-${index}`,
    );

    const saved = saveRecentWorkspacePaths(storage, paths);

    expect(saved).toHaveLength(RECENT_WORKSPACES_LIMIT);
    expect(loadRecentWorkspacePaths(storage)).toHaveLength(RECENT_WORKSPACES_LIMIT);
  });

  it("removes recent workspace paths case-insensitively", () => {
    const paths = removeRecentWorkspacePath(["E:/Javis", "F:/Other"], "e:/javis");

    expect(paths).toEqual(["F:/Other"]);
  });
});

function createMemoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
