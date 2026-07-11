import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DisposableCopyWorkspace,
  LocalReadOnlyWorkspace,
  WindowsSandboxWorkspace,
  assertDesktopWorkspaceRuntimeWriteBoundary,
  createDesktopWorkspaceRuntime,
} from "./workspace-runtime-adapter";
import {
  createTempWorkspace,
  diffTempWorkspace,
  finalizeTempWorkspace,
} from "./temp-workspace-sandbox";

vi.mock("./temp-workspace-sandbox", () => ({
  createTempWorkspace: vi.fn(),
  diffTempWorkspace: vi.fn(),
  finalizeTempWorkspace: vi.fn(),
}));

const mockedCreateTempWorkspace = vi.mocked(createTempWorkspace);
const mockedDiffTempWorkspace = vi.mocked(diffTempWorkspace);
const mockedFinalizeTempWorkspace = vi.mocked(finalizeTempWorkspace);

describe("workspace-runtime-adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("wraps temporary workspace sandbox create, diff, and cleanup", async () => {
    mockedCreateTempWorkspace.mockResolvedValue({
      taskId: "task-1",
      realWorkspaceRoot: "E:/Javis",
      sandboxRoot: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
      copiedFiles: 2,
      copiedDirectories: 1,
      skippedEntries: 0,
    });
    mockedDiffTempWorkspace.mockResolvedValue({
      realWorkspaceRoot: "E:/Javis",
      sandboxRoot: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
      changedFiles: [
        {
          path: "src/index.ts",
          change: "modified",
          textDiff: "--- a/src/index.ts\n+++ b/src/index.ts\n",
        },
      ],
      unifiedDiff: "--- a/src/index.ts\n+++ b/src/index.ts\n",
    });
    mockedFinalizeTempWorkspace.mockResolvedValue({
      mode: "delete",
      sandboxRoot: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
      archivedTo: null,
    });

    const runtime = await WindowsSandboxWorkspace.create({
      realWorkspaceRoot: "E:/Javis",
      taskId: "task-1",
    });
    const snapshot = await runtime.createSnapshot();
    const diff = await runtime.diff(snapshot);
    await runtime.dispose();
    await runtime.dispose();

    expect(mockedCreateTempWorkspace).toHaveBeenCalledWith("E:/Javis", "task-1");
    expect(mockedDiffTempWorkspace).toHaveBeenCalledWith(
      "E:/Javis",
      "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
    );
    expect(mockedFinalizeTempWorkspace).toHaveBeenCalledTimes(1);
    expect(mockedFinalizeTempWorkspace).toHaveBeenCalledWith(
      "E:/Javis",
      "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
      "delete",
    );
    expect(diff.changedFiles).toEqual([
      {
        path: "src/index.ts",
        change: "modified",
        textDiff: "--- a/src/index.ts\n+++ b/src/index.ts\n",
      },
    ]);
  });

  it("routes local read-only runtime through the desktop adapter without allowing writes", async () => {
    const readTextFile = vi.fn(async () => "hello");
    const listDirectory = vi.fn(async () => [
      { path: "src", name: "src", isDir: true },
    ]);
    const executeReadOnly = vi.fn(async () => ({
      command: "git status",
      cwd: "E:/Javis",
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    }));
    const runtime = new LocalReadOnlyWorkspace({
      root: "E:/Javis",
      readTextFile,
      listDirectory,
      executeReadOnly,
    });

    expect(await runtime.readFile("README.md")).toEqual(new TextEncoder().encode("hello"));
    expect(await runtime.listFiles()).toEqual([{ path: "src", name: "src", isDir: true }]);
    expect(await runtime.execute({ program: "git", args: ["status"], permissionLevel: "read" })).toEqual({
      command: "git status",
      cwd: "E:/Javis",
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    });
    expect(readTextFile).toHaveBeenCalledWith("README.md", "E:/Javis");
    expect(listDirectory).toHaveBeenCalledWith("E:/Javis");
    expect(executeReadOnly).toHaveBeenCalledWith(
      expect.objectContaining({ permissionLevel: "read", workspacePath: "E:/Javis" }),
    );
    await expect(runtime.execute({ program: "git", args: ["push"], permissionLevel: "confirmed_write" })).rejects.toThrow(
      "LocalReadOnlyWorkspace cannot execute write-capable operations.",
    );
  });

  it("resolves local read-only root lazily for changing workspaces", async () => {
    let root = "E:/Javis";
    const readTextFile = vi.fn(async () => "hello");
    const listDirectory = vi.fn(async () => []);
    const executeReadOnly = vi.fn(async () => ({
      command: "git status",
      cwd: root,
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));
    const runtime = new LocalReadOnlyWorkspace({
      root: () => root,
      readTextFile,
      listDirectory,
      executeReadOnly,
    });

    expect(runtime.root).toBe("E:/Javis");
    root = "E:/Other";
    await runtime.readFile("README.md");
    await runtime.listFiles();
    await runtime.execute({ program: "git", args: ["status"], permissionLevel: "read" });

    expect(runtime.root).toBe("E:/Other");
    expect(readTextFile).toHaveBeenCalledWith("README.md", "E:/Other");
    expect(listDirectory).toHaveBeenCalledWith("E:/Other");
    expect(executeReadOnly).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: "E:/Other" }),
    );
  });

  it("routes sandbox workspace reads, lists, and execution through the sandbox root", async () => {
    mockedCreateTempWorkspace.mockResolvedValue({
      taskId: "task-1",
      realWorkspaceRoot: "E:/Javis",
      sandboxRoot: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
      copiedFiles: 1,
      copiedDirectories: 0,
      skippedEntries: 0,
    });
    const readTextFile = vi.fn(async () => "sandbox text");
    const listDirectory = vi.fn(async () => [
      { path: "E:/Javis/.codex-tmp/javis-sandboxes/task-1/src", name: "src", isDir: true },
    ]);
    const execute = vi.fn(async () => ({
      command: "pnpm test",
      cwd: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    }));
    const runtime = await WindowsSandboxWorkspace.create({
      realWorkspaceRoot: "E:/Javis",
      taskId: "task-1",
      readTextFile,
      listDirectory,
      execute,
    });

    expect(await runtime.readFile("src/index.ts")).toEqual(new TextEncoder().encode("sandbox text"));
    expect(await runtime.listFiles()).toEqual([
      { path: "E:/Javis/.codex-tmp/javis-sandboxes/task-1/src", name: "src", isDir: true },
    ]);
    expect(await runtime.execute({ program: "pnpm", args: ["test"], permissionLevel: "confirmed_write" })).toEqual({
      command: "pnpm test",
      cwd: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    });

    expect(readTextFile).toHaveBeenCalledWith(
      "src/index.ts",
      "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
    );
    expect(listDirectory).toHaveBeenCalledWith("E:/Javis/.codex-tmp/javis-sandboxes/task-1");
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
        permissionLevel: "confirmed_write",
        workspacePath: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
      }),
    );
  });

  it("creates the right runtime implementation for local and sandbox workspaces", async () => {
    const localRuntime = await createDesktopWorkspaceRuntime({ kind: "local", root: "E:/Javis" });
    expect(localRuntime).toBeInstanceOf(LocalReadOnlyWorkspace);
    mockedCreateTempWorkspace.mockResolvedValue({
      taskId: "task-1",
      realWorkspaceRoot: "E:/Javis",
      sandboxRoot: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
      copiedFiles: 0,
      copiedDirectories: 0,
      skippedEntries: 0,
    });
    const sandboxRuntime = await createDesktopWorkspaceRuntime({ kind: "sandbox", root: "E:/Javis", taskId: "task-1" });
    expect(sandboxRuntime).toBeInstanceOf(WindowsSandboxWorkspace);
    expect(DisposableCopyWorkspace).toBe(WindowsSandboxWorkspace);
    expect(mockedCreateTempWorkspace).toHaveBeenCalledWith("E:/Javis", "task-1");
  });

  it("keeps local runtime write attempts fail-closed in desktop adapter", () => {
    expect(() => assertDesktopWorkspaceRuntimeWriteBoundary({ kind: "local" })).toThrow(
      "LocalReadOnlyWorkspace cannot execute write-capable operations.",
    );
  });
});
