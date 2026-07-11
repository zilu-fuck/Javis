import { describe, expect, it } from "vitest";
import {
  assertWorkspaceRuntimeCanWrite,
  createWorkspaceSnapshot,
  routeCodeToolThroughWorkspaceRuntime,
  routeGitToolThroughWorkspaceRuntime,
  routeShellToolThroughWorkspaceRuntime,
} from "./workspace-runtime";
import type { CodeTool, GitTool, ShellTool } from "@javis/tools";

describe("workspace-runtime", () => {
  const runtime = { kind: "sandbox" as const, root: "E:/Javis/.codex-tmp/javis-sandboxes/task-1" };

  it("routes Code, Shell, and Git paths through one runtime contract", () => {
    const codeTool = { inspectRepository: async () => ({ workspacePath: "E:/Javis", changedFiles: [], diff: "", diffStat: "" }) } satisfies CodeTool;
    const shellTool = { runReadOnlyCommand: async () => ({ command: "git status", cwd: "E:/Javis", exitCode: 0, stdout: "", stderr: "" }) } satisfies ShellTool;
    const gitTool = {} satisfies GitTool;

    expect(routeCodeToolThroughWorkspaceRuntime(codeTool, runtime)).toEqual({
      toolKind: "code",
      runtimeKind: "sandbox",
      workspaceRoot: runtime.root,
      permissionLevel: "read",
    });
    expect(routeShellToolThroughWorkspaceRuntime(shellTool, runtime)).toEqual({
      toolKind: "shell",
      runtimeKind: "sandbox",
      workspaceRoot: runtime.root,
      permissionLevel: "read",
    });
    expect(routeGitToolThroughWorkspaceRuntime(gitTool, runtime)).toEqual({
      toolKind: "git",
      runtimeKind: "sandbox",
      workspaceRoot: runtime.root,
      permissionLevel: "preview",
    });
  });

  it("keeps local runtime write attempts fail-closed", () => {
    expect(() => assertWorkspaceRuntimeCanWrite({ kind: "local" })).toThrow(
      "LocalReadOnlyWorkspace cannot execute write-capable operations.",
    );
    expect(() => assertWorkspaceRuntimeCanWrite({ kind: "sandbox" })).not.toThrow();
  });

  it("creates stable snapshot records for runtime adapters", () => {
    expect(createWorkspaceSnapshot({
      runtimeKind: "sandbox",
      root: runtime.root,
      snapshotId: "snapshot-1",
      createdAt: "2026-06-16T00:00:00.000Z",
    })).toEqual({
      runtimeKind: "sandbox",
      root: runtime.root,
      snapshotId: "snapshot-1",
      createdAt: "2026-06-16T00:00:00.000Z",
    });
  });
});
