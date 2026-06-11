import { describe, expect, it } from "vitest";
import type {
  GitCommentPullRequestExecutionQuickResult,
  GitCommentPullRequestPlanQuickResult,
  WorkbenchAgentSessionContext,
} from "@javis/ui";
import {
  GIT_COMMENT_PR_AUDIT_TOOL_NAME,
  createGitCommentPullRequestExecutionAuditRecord,
  createGitCommentPullRequestFailedAuditRecord,
  createGitCommentPullRequestPermissionRequest,
  createGitCommentPullRequestPlanAuditRecord,
} from "./git-comment-pr-audit";

describe("git pull request comment audit records", () => {
  it("creates a waiting-permission audit record from a PR comment plan", () => {
    const record = createGitCommentPullRequestPlanAuditRecord(
      createSession(),
      createPlan(),
      "2026-06-10T10:00:00.000Z",
    );

    expect(record).toEqual(expect.objectContaining({
      id: "task-1:git.commentPullRequest:approval-1:plan",
      taskId: "task-1",
      toolName: GIT_COMMENT_PR_AUDIT_TOOL_NAME,
      permissionLevel: "confirmed_write",
      status: "waiting_permission",
      permissionRequestId: "approval-1",
      startedAt: "2026-06-10T10:00:00.000Z",
    }));
    expect(record.inputSummary).toContain("12");
    expect(JSON.parse(record.dryRunJson ?? "{}")).toEqual(createPlan().preview.dryRun);
  });

  it("creates succeeded and failed execution audit records", () => {
    const succeeded = createGitCommentPullRequestExecutionAuditRecord(
      createSession(),
      "approval-1",
      createExecution(),
      "2026-06-10T10:01:00.000Z",
      "2026-06-10T10:01:02.000Z",
    );
    const failed = createGitCommentPullRequestFailedAuditRecord(
      createSession(),
      "approval-1",
      new Error("comment rejected"),
      "2026-06-10T10:02:00.000Z",
      "2026-06-10T10:02:01.000Z",
    );

    expect(succeeded).toEqual(expect.objectContaining({
      id: "task-1:git.commentPullRequest:approval-1:execute",
      status: "succeeded",
      outputSummary: "Posted pull request comment on 12",
    }));
    expect(failed).toEqual(expect.objectContaining({
      id: "task-1:git.commentPullRequest:approval-1:execute",
      status: "failed",
      errorJson: JSON.stringify({ message: "comment rejected" }),
    }));
  });

  it("creates a durable permission request bound to the PR comment dry-run", () => {
    const request = createGitCommentPullRequestPermissionRequest(
      createPlan(),
      "2026-06-10T10:00:00.000Z",
    );

    expect(request).toEqual(expect.objectContaining({
      id: "approval-1",
      level: "confirmed_write",
      writeRiskLevel: "risky",
      title: "Approve Git pull request comment",
      status: "pending",
      allowAlways: false,
      createdAt: "2026-06-10T10:00:00.000Z",
    }));
    expect(request.bindingHash).toMatch(/^dryrun-fnv1a-/);
    expect(request.dryRun.affectedPaths[0]?.action).toBe("comment_pr");
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

function createPlan(): GitCommentPullRequestPlanQuickResult {
  return {
    approvalId: "approval-1",
    preview: {
      workspaceRoot: "E:/Javis",
      provider: "github-cli",
      pullRequest: "12",
      body: "Looks good.",
      remoteUrl: "https://github.com/example/javis.git",
      dryRun: {
        operation: "Preview GitHub pull request comment",
        riskSummary: "Preview only. No remote write was executed.",
        reversible: false,
        affectedPaths: [{
          source: "12",
          target: "https://github.com/example/javis.git",
          action: "comment_pr",
        }],
      },
    },
  };
}

function createExecution(): GitCommentPullRequestExecutionQuickResult {
  return {
    workspacePath: "E:/Javis",
    provider: "github-cli",
    pullRequest: "12",
    commented: true,
    output: "https://github.com/example/javis/pull/12#issuecomment-1",
  };
}
