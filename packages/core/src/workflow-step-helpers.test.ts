import { describe, expect, it, vi } from "vitest";
import type { ShellTool } from "@javis/tools";
import type { WorkspaceRuntime } from "./workspace-runtime";
import {
  canExecuteWorkspaceWrite,
  runProjectReadOnlyCommands,
  runWorkspaceCodeApplyOperation,
  runWorkspaceGitCommitCommand,
  runWorkspaceGitStageCommand,
  runWorkspaceReadOnlyCommand,
} from "./workflow-step-helpers";

describe("workflow-step-helpers", () => {
  it("routes read-only shell commands through WorkspaceRuntime when provided", async () => {
    const shellTool = {
      runReadOnlyCommand: vi.fn(async () => {
        throw new Error("shellTool should not be called when runtime is present");
      }),
    } satisfies ShellTool;
    const runtime = {
      kind: "sandbox",
      root: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
      execute: vi.fn(async () => ({
        command: "git status --short",
        cwd: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
        exitCode: 0,
        stdout: "",
        stderr: "",
      })),
      readFile: vi.fn(),
      listFiles: vi.fn(),
      createSnapshot: vi.fn(),
      diff: vi.fn(),
      dispose: vi.fn(),
    } satisfies WorkspaceRuntime;

    const result = await runWorkspaceReadOnlyCommand({
      program: "git",
      args: ["status", "--short"],
      workspacePath: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
    }, shellTool, runtime);

    expect(result.command).toBe("git status --short");
    expect(shellTool.runReadOnlyCommand).not.toHaveBeenCalled();
    expect(runtime.execute).toHaveBeenCalledWith({
      program: "git",
      args: ["status", "--short"],
      cwd: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
      permissionLevel: "read",
    });
  });

  it("routes project read-only command batches through WorkspaceRuntime", async () => {
    const shellTool = {
      runReadOnlyCommand: vi.fn(async () => ({
        command: "fallback",
        cwd: "E:/Javis",
        exitCode: 0,
        stdout: "",
        stderr: "",
      })),
    } satisfies ShellTool;
    const runtime = {
      kind: "sandbox",
      root: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
      execute: vi.fn(async (request) => ({
        command: [request.program, ...request.args].join(" "),
        cwd: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
        exitCode: 0,
        stdout: "",
        stderr: "",
      })),
      readFile: vi.fn(),
      listFiles: vi.fn(),
      createSnapshot: vi.fn(),
      diff: vi.fn(),
      dispose: vi.fn(),
    } satisfies WorkspaceRuntime;

    const commands = await runProjectReadOnlyCommands(shellTool, runtime);

    expect(commands.map((command) => command.command)).toEqual([
      "node --version",
      "pnpm --version",
      "git status --short",
    ]);
    expect(shellTool.runReadOnlyCommand).not.toHaveBeenCalled();
    expect(runtime.execute).toHaveBeenCalledTimes(3);
    expect(runtime.execute).toHaveBeenCalledWith(
      expect.objectContaining({ permissionLevel: "read" }),
    );
  });

  it("routes Git stage execution through write-capable WorkspaceRuntime", async () => {
    const runtime = {
      kind: "sandbox",
      root: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
      execute: vi.fn(async () => ({
        command: "git add -- README.md",
        cwd: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
        exitCode: 0,
        stdout: "staged",
        stderr: "",
      })),
      readFile: vi.fn(),
      listFiles: vi.fn(),
      createSnapshot: vi.fn(),
      diff: vi.fn(),
      dispose: vi.fn(),
    } satisfies WorkspaceRuntime;

    const result = await runWorkspaceGitStageCommand({
      runtime,
      paths: ["README.md"],
      plan: {
        approvalId: "approval-stage-1",
        preview: {
          workspaceRoot: runtime.root,
          files: [],
          diffStat: "",
          diff: "",
          dryRun: {
            operation: "git.stageFiles",
            affectedPaths: [],
            riskSummary: "stage",
            reversible: true,
          },
        },
      },
    });

    expect(result).toEqual({
      workspacePath: runtime.root,
      stagedPaths: ["README.md"],
      fileCount: 1,
      staged: true,
      output: "staged",
    });
    expect(runtime.execute).toHaveBeenCalledWith({
      program: "git",
      args: ["add", "--", "README.md"],
      cwd: runtime.root,
      permissionLevel: "confirmed_write",
    });
  });

  it("routes Git commit execution through write-capable WorkspaceRuntime", async () => {
    const runtime = {
      kind: "sandbox",
      root: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
      execute: vi.fn(async (request) => ({
        command: [request.program, ...request.args].join(" "),
        cwd: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
        exitCode: 0,
        stdout: request.args[0] === "commit" ? "[main abc1234] Commit README update" : "",
        stderr: "",
      })),
      readFile: vi.fn(),
      listFiles: vi.fn(),
      createSnapshot: vi.fn(),
      diff: vi.fn(),
      dispose: vi.fn(),
    } satisfies WorkspaceRuntime;

    const result = await runWorkspaceGitCommitCommand({
      runtime,
      message: "Commit README update",
      paths: ["README.md"],
      plan: {
        approvalId: "approval-commit-1",
        preview: {
          workspaceRoot: runtime.root,
          branch: "main",
          message: "Commit README update",
          files: [{ path: "README.md", indexStatus: " ", worktreeStatus: "M", action: "modify", contentHash: "hash-1" }],
          diffStat: "",
          diff: "",
          dryRun: {
            operation: "git.createCommit",
            affectedPaths: [],
            riskSummary: "commit",
            reversible: false,
          },
        },
      },
    });

    expect(result).toEqual({
      workspacePath: runtime.root,
      branch: "main",
      commitHash: "abc1234",
      subject: "Commit README update",
      fileCount: 1,
      committed: true,
      output: "[main abc1234] Commit README update",
    });
    expect(runtime.execute).toHaveBeenNthCalledWith(1, {
      program: "git",
      args: ["add", "--", "README.md"],
      cwd: runtime.root,
      permissionLevel: "confirmed_write",
    });
    expect(runtime.execute).toHaveBeenNthCalledWith(2, {
      program: "git",
      args: ["commit", "-m", "Commit README update"],
      cwd: runtime.root,
      permissionLevel: "confirmed_write",
    });
  });

  it("stages all workspace changes for WorkspaceRuntime commits without explicit paths", async () => {
    const runtime = {
      kind: "sandbox",
      root: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
      execute: vi.fn(async (request) => ({
        command: [request.program, ...request.args].join(" "),
        cwd: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
        exitCode: 0,
        stdout: request.args[0] === "commit" ? "[main abc1234] Commit all changes" : "",
        stderr: "",
      })),
      readFile: vi.fn(),
      listFiles: vi.fn(),
      createSnapshot: vi.fn(),
      diff: vi.fn(),
      dispose: vi.fn(),
    } satisfies WorkspaceRuntime;

    await runWorkspaceGitCommitCommand({
      runtime,
      message: "Commit all changes",
      plan: {
        approvalId: "approval-commit-1",
        preview: {
          workspaceRoot: runtime.root,
          message: "Commit all changes",
          files: [{ path: "README.md", indexStatus: " ", worktreeStatus: "M", action: "modify", contentHash: "hash-1" }],
          diffStat: "",
          diff: "",
          dryRun: {
            operation: "git.createCommit",
            affectedPaths: [],
            riskSummary: "commit",
            reversible: false,
          },
        },
      },
    });

    expect(runtime.execute).toHaveBeenNthCalledWith(1, {
      program: "git",
      args: ["add", "-A"],
      cwd: runtime.root,
      permissionLevel: "confirmed_write",
    });
  });

  it("fails WorkspaceRuntime Git execution when the command exits non-zero", async () => {
    const runtime = {
      kind: "sandbox",
      root: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
      execute: vi.fn(async () => ({
        command: "git add -- README.md",
        cwd: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
        exitCode: 1,
        stdout: "",
        stderr: "fatal: pathspec did not match",
      })),
      readFile: vi.fn(),
      listFiles: vi.fn(),
      createSnapshot: vi.fn(),
      diff: vi.fn(),
      dispose: vi.fn(),
    } satisfies WorkspaceRuntime;

    await expect(runWorkspaceGitStageCommand({
      runtime,
      paths: ["README.md"],
      plan: {
        approvalId: "approval-stage-1",
        preview: {
          workspaceRoot: runtime.root,
          files: [],
          diffStat: "",
          diff: "",
          dryRun: {
            operation: "git.stageFiles",
            affectedPaths: [],
            riskSummary: "stage",
            reversible: true,
          },
        },
      },
    })).rejects.toThrow("git add failed with exit code 1");
  });

  it("keeps local WorkspaceRuntime out of write execution routing", () => {
    expect(canExecuteWorkspaceWrite(undefined)).toBe(false);
    expect(canExecuteWorkspaceWrite({ kind: "local", root: "E:/Javis" } as WorkspaceRuntime)).toBe(false);
    expect(canExecuteWorkspaceWrite({ kind: "sandbox", root: "E:/Javis/.tmp" } as WorkspaceRuntime)).toBe(true);
  });

  it("audits Code patch apply effects through write-capable WorkspaceRuntime diff", async () => {
    const runtime = {
      kind: "sandbox",
      root: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
      createSnapshot: vi.fn(async () => ({
        runtimeKind: "sandbox" as const,
        root: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
        snapshotId: "snapshot-1",
        createdAt: "2026-06-17T00:00:00.000Z",
      })),
      diff: vi.fn(async () => ({
        root: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
        unifiedDiff: "",
        changedFiles: [{ path: "src/index.ts", change: "modified" as const }],
      })),
      execute: vi.fn(),
      readFile: vi.fn(),
      listFiles: vi.fn(),
      dispose: vi.fn(),
    } satisfies WorkspaceRuntime;
    const applyProposedEdit = vi.fn(async () => ({
      applied: true,
      workspacePath: runtime.root,
      changedFiles: ["src/index.ts"],
      message: "Applied patch.",
    }));

    const result = await runWorkspaceCodeApplyOperation({
      workspaceRuntime: runtime,
      edit: {
        proposalId: "proposal-1",
        workspacePath: runtime.root,
        summary: "Update index.",
        changedFiles: ["src/index.ts"],
        patch: "diff --git a/src/index.ts b/src/index.ts",
        patchHash: "fnv1a-test",
      },
      approval: { approvalId: "approval-1", taskId: "task-1" },
      applyProposedEdit,
    });

    expect(result.applied).toBe(true);
    expect(runtime.createSnapshot).toHaveBeenCalledOnce();
    expect(runtime.diff).toHaveBeenCalledWith(expect.objectContaining({ snapshotId: "snapshot-1" }));
    expect(applyProposedEdit).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: "proposal-1" }),
      { approvalId: "approval-1", taskId: "task-1" },
    );
  });

  it("normalizes absolute WorkspaceRuntime diff paths during Code patch audit", async () => {
    const runtime = {
      kind: "sandbox",
      root: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
      createSnapshot: vi.fn(async () => ({
        runtimeKind: "sandbox" as const,
        root: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
        snapshotId: "snapshot-1",
        createdAt: "2026-06-17T00:00:00.000Z",
      })),
      diff: vi.fn(async () => ({
        root: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
        unifiedDiff: "",
        changedFiles: [{
          path: "E:\\Javis\\.codex-tmp\\javis-sandboxes\\task-1\\src\\index.ts",
          change: "modified" as const,
        }],
      })),
      execute: vi.fn(),
      readFile: vi.fn(),
      listFiles: vi.fn(),
      dispose: vi.fn(),
    } satisfies WorkspaceRuntime;

    await expect(runWorkspaceCodeApplyOperation({
      workspaceRuntime: runtime,
      edit: {
        proposalId: "proposal-1",
        workspacePath: runtime.root,
        summary: "Update index.",
        changedFiles: ["src/index.ts"],
        patch: "diff --git a/src/index.ts b/src/index.ts",
        patchHash: "fnv1a-test",
      },
      approval: { approvalId: "approval-1", taskId: "task-1" },
      applyProposedEdit: vi.fn(async () => ({
        applied: true,
        workspacePath: runtime.root,
        changedFiles: ["src/index.ts"],
        message: "Applied patch.",
      })),
    })).resolves.toEqual(expect.objectContaining({ applied: true }));
  });

  it("fails Code patch runtime audit when diff includes an unapproved file", async () => {
    const runtime = {
      kind: "sandbox",
      root: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
      createSnapshot: vi.fn(async () => ({
        runtimeKind: "sandbox" as const,
        root: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
        snapshotId: "snapshot-1",
        createdAt: "2026-06-17T00:00:00.000Z",
      })),
      diff: vi.fn(async () => ({
        root: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
        unifiedDiff: "",
        changedFiles: [{ path: "src/other.ts", change: "modified" as const }],
      })),
      execute: vi.fn(),
      readFile: vi.fn(),
      listFiles: vi.fn(),
      dispose: vi.fn(),
    } satisfies WorkspaceRuntime;

    await expect(runWorkspaceCodeApplyOperation({
      workspaceRuntime: runtime,
      edit: {
        proposalId: "proposal-1",
        workspacePath: runtime.root,
        summary: "Update index.",
        changedFiles: ["src/index.ts"],
        patch: "diff --git a/src/index.ts b/src/index.ts",
        patchHash: "fnv1a-test",
      },
      approval: { approvalId: "approval-1", taskId: "task-1" },
      applyProposedEdit: vi.fn(async () => ({
        applied: true,
        workspacePath: runtime.root,
        changedFiles: ["src/index.ts"],
        message: "Applied patch.",
      })),
    })).rejects.toThrow("WorkspaceRuntime diff included an unapproved Code patch file: src/other.ts");
  });
});
