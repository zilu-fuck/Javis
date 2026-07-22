import { describe, expect, it } from "vitest";
import { normalizeWorkspaceRelativeTextTargetPath } from "./text-write-path";

describe("normalizeWorkspaceRelativeTextTargetPath", () => {
  it("converts an absolute target inside a Windows workspace", () => {
    expect(normalizeWorkspaceRelativeTextTargetPath(
      "E:\\测试\\微博热搜.md",
      "E:/测试",
    )).toBe("微博热搜.md");
  });

  it("keeps relative targets normalized without requiring a workspace", () => {
    expect(normalizeWorkspaceRelativeTextTargetPath("reports\\hot-list.md")).toBe(
      "reports/hot-list.md",
    );
  });

  it("normalizes Windows device prefixes and drive-letter casing", () => {
    expect(normalizeWorkspaceRelativeTextTargetPath(
      "\\\\?\\e:\\测试\\reports\\hot-list.md",
      "E:/测试",
    )).toBe("reports/hot-list.md");
  });

  it("rejects an absolute target when no workspace is selected", () => {
    expect(() => normalizeWorkspaceRelativeTextTargetPath(
      "E:/测试/hot-list.md",
    )).toThrow("require a selected workspace");
  });

  it("rejects absolute targets outside the selected workspace", () => {
    expect(() => normalizeWorkspaceRelativeTextTargetPath(
      "E:/other/hot-list.md",
      "E:/测试",
    )).toThrow("must stay inside the selected workspace");
  });

  it("rejects traversal even when the path starts inside the workspace", () => {
    expect(() => normalizeWorkspaceRelativeTextTargetPath(
      "E:/测试/../other/hot-list.md",
      "E:/测试",
    )).toThrow("parent directory traversal");
  });
});
