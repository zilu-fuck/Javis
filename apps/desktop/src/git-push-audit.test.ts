import { describe, expect, it } from "vitest";
import {
  GIT_PUSH_AUDIT_TOOL_NAME,
  GIT_PUSH_APPROVAL_TITLE,
  createGitPushExecutionAuditRecord,
  createGitPushFailedAuditRecord,
  createGitPushPermissionRequest,
  createGitPushPlanAuditRecord,
} from "./git-push-audit";
import type {
  GitPushExecutionQuickResult,
  GitPushPlanQuickResult,
  WorkbenchAgentSessionContext,
} from "@javis/ui";

describe("git push audit records", () => {
  it("creates a waiting-permission audit record from a push plan", () => {
    const record = createGitPushPlanAuditRecord(
      createSession(),
      createPlan(),
      "2026-06-09T10:00:00.000Z",
    );

    expect(record).toEqual(expect.objectContaining({
      id: "task-1:git.pushBranch:approval-1:plan",
      taskId: "task-1",
      toolName: GIT_PUSH_AUDIT_TOOL_NAME,
      permissionLevel: "confirmed_write",
      status: "waiting_permission",
      permissionRequestId: "approval-1",
      startedAt: "2026-06-09T10:00:00.000Z",
    }));
    expect(record.inputSummary).toContain("feature/git-push -> origin/feature/git-push");
    expect(JSON.parse(record.dryRunJson ?? "{}")).toEqual(createPlan().preview.dryRun);
  });

  it("creates succeeded and failed execution audit records", () => {
    const succeeded = createGitPushExecutionAuditRecord(
      createSession(),
      "approval-1",
      createExecution(),
      "2026-06-09T10:01:00.000Z",
      "2026-06-09T10:01:02.000Z",
    );
    const failed = createGitPushFailedAuditRecord(
      createSession(),
      "approval-1",
      new Error("remote rejected push"),
      "2026-06-09T10:02:00.000Z",
      "2026-06-09T10:02:01.000Z",
    );

    expect(succeeded).toEqual(expect.objectContaining({
      id: "task-1:git.pushBranch:approval-1:execute",
      status: "succeeded",
      outputSummary: "Pushed 1 commit(s) to origin/feature/git-push",
    }));
    expect(failed).toEqual(expect.objectContaining({
      id: "task-1:git.pushBranch:approval-1:execute",
      status: "failed",
      errorJson: JSON.stringify({ message: "remote rejected push" }),
    }));
  });

  it("creates a durable permission request bound to the push dry-run", () => {
    const request = createGitPushPermissionRequest(
      createPlan(),
      "2026-06-09T10:00:00.000Z",
    );

    expect(request).toEqual(expect.objectContaining({
      id: "approval-1",
      level: "confirmed_write",
      writeRiskLevel: "risky",
      title: GIT_PUSH_APPROVAL_TITLE,
      status: "pending",
      allowAlways: false,
      createdAt: "2026-06-09T10:00:00.000Z",
    }));
    expect(request.bindingHash).toMatch(/^dryrun-fnv1a-/);
    expect(request.dryRun.affectedPaths[0]?.action).toBe("push");
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

function createPlan(): GitPushPlanQuickResult {
  return {
    approvalId: "approval-1",
    preview: {
      branch: "feature/git-push",
      upstream: "origin/feature/git-push",
      remoteName: "origin",
      remoteBranch: "feature/git-push",
      remoteUrl: "file:///tmp/remote.git",
      ahead: 1,
      behind: 0,
      commits: [{ hash: "abc123", subject: "Local change" }],
      dryRun: {
        operation: "Preview Git push",
        riskSummary: "Preview only. No Git write was executed.",
        reversible: false,
        affectedPaths: [{
          source: "feature/git-push",
          target: "origin/feature/git-push",
          action: "push",
        }],
      },
    },
  };
}

function createExecution(): GitPushExecutionQuickResult {
  return {
    workspacePath: "E:/Javis",
    branch: "feature/git-push",
    upstream: "origin/feature/git-push",
    remoteName: "origin",
    remoteBranch: "feature/git-push",
    commitCount: 1,
    pushed: true,
    output: "Done",
  };
}
