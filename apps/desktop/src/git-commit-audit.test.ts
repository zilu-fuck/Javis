import { describe, expect, it } from "vitest";
import {
  GIT_COMMIT_APPROVAL_TITLE,
  GIT_COMMIT_AUDIT_TOOL_NAME,
  createGitCommitExecutionAuditRecord,
  createGitCommitFailedAuditRecord,
  createGitCommitPermissionRequest,
  createGitCommitPlanAuditRecord,
} from "./git-commit-audit";
import type {
  GitCommitExecutionQuickResult,
  GitCommitPlanQuickResult,
  WorkbenchAgentSessionContext,
} from "@javis/ui";

describe("git commit audit records", () => {
  it("creates a waiting-permission audit record from a commit plan", () => {
    const record = createGitCommitPlanAuditRecord(
      createSession(),
      createPlan(),
      "2026-06-09T10:00:00.000Z",
    );

    expect(record).toEqual(expect.objectContaining({
      id: "task-1:git.createCommit:approval-1:plan",
      taskId: "task-1",
      toolName: GIT_COMMIT_AUDIT_TOOL_NAME,
      permissionLevel: "confirmed_write",
      status: "waiting_permission",
      permissionRequestId: "approval-1",
      startedAt: "2026-06-09T10:00:00.000Z",
    }));
    expect(record.inputSummary).toContain("Commit changes");
    expect(JSON.parse(record.dryRunJson ?? "{}")).toEqual(createPlan().preview.dryRun);
  });

  it("creates succeeded and failed execution audit records", () => {
    const succeeded = createGitCommitExecutionAuditRecord(
      createSession(),
      "approval-1",
      createExecution(),
      "2026-06-09T10:01:00.000Z",
      "2026-06-09T10:01:02.000Z",
    );
    const failed = createGitCommitFailedAuditRecord(
      createSession(),
      "approval-1",
      new Error("nothing to commit"),
      "2026-06-09T10:02:00.000Z",
      "2026-06-09T10:02:01.000Z",
    );

    expect(succeeded).toEqual(expect.objectContaining({
      id: "task-1:git.createCommit:approval-1:execute",
      status: "succeeded",
      outputSummary: "Created commit abc123def456 for 2 file(s)",
    }));
    expect(failed).toEqual(expect.objectContaining({
      id: "task-1:git.createCommit:approval-1:execute",
      status: "failed",
      errorJson: JSON.stringify({ message: "nothing to commit" }),
    }));
  });

  it("creates a durable permission request bound to the commit dry-run", () => {
    const request = createGitCommitPermissionRequest(
      createPlan(),
      "2026-06-09T10:00:00.000Z",
    );

    expect(request).toEqual(expect.objectContaining({
      id: "approval-1",
      level: "confirmed_write",
      writeRiskLevel: "risky",
      title: GIT_COMMIT_APPROVAL_TITLE,
      status: "pending",
      allowAlways: false,
      createdAt: "2026-06-09T10:00:00.000Z",
    }));
    expect(request.bindingHash).toMatch(/^dryrun-fnv1a-/);
    expect(request.dryRun.affectedPaths[0]?.action).toBe("modify");
  });
});

function createSession(): WorkbenchAgentSessionContext {
  return {
    sessionId: "thread-1:task-1",
    threadId: "thread-1",
    taskId: "task-1",
    workspaceRoot: "E:/Javis",
    permissionMode: "read_only",
    activeModel: "test-model",
    activeTool: "review",
  };
}

function createPlan(): GitCommitPlanQuickResult {
  return {
    approvalId: "approval-1",
    preview: {
      workspaceRoot: "E:/Javis",
      branch: "feature/git-commit",
      message: "Commit changes",
      files: [
        {
          path: "README.md",
          indexStatus: "",
          worktreeStatus: "M",
          action: "modify",
          contentHash: "hash-readme",
        },
        {
          path: "notes.md",
          indexStatus: "?",
          worktreeStatus: "?",
          action: "create",
          contentHash: "hash-notes",
        },
      ],
      diffStat: "README.md | 1 +",
      diff: "diff --git a/README.md b/README.md",
      dryRun: {
        operation: "Preview Git commit",
        riskSummary: "Preview only. No Git write was executed.",
        reversible: false,
        affectedPaths: [{
          source: "README.md",
          target: "README.md",
          action: "modify",
        }],
      },
    },
  };
}

function createExecution(): GitCommitExecutionQuickResult {
  return {
    workspacePath: "E:/Javis",
    branch: "feature/git-commit",
    commitHash: "abc123def4567890",
    subject: "Commit changes",
    fileCount: 2,
    committed: true,
    output: "[feature/git-commit abc123d] Commit changes",
  };
}
