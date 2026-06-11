import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
import { invoke } from "@tauri-apps/api/core";
import { createDryRunBindingHash } from "@javis/core";
import type { DryRunSummary, PermissionRequest } from "@javis/tools";
import type { DurableApprovalRecord } from "./approval-records";
import {
  CODE_PATCH_APPROVAL_TOOL_NAME,
  CODE_PATCH_APPROVAL_TITLE,
  GIT_COMMENT_PR_APPROVAL_TITLE,
  GIT_COMMENT_PR_APPROVAL_TOOL_NAME,
  GIT_CREATE_PR_APPROVAL_TITLE,
  GIT_CREATE_PR_APPROVAL_TOOL_NAME,
  GIT_COMMIT_APPROVAL_TITLE,
  GIT_COMMIT_APPROVAL_TOOL_NAME,
  GIT_PUSH_APPROVAL_TITLE,
  GIT_PUSH_APPROVAL_TOOL_NAME,
  GIT_STAGE_APPROVAL_TITLE,
  GIT_STAGE_APPROVAL_TOOL_NAME,
  PDF_APPROVAL_TOOL_NAME,
  PDF_APPROVAL_TITLE,
  createRestoredGitCommentPullRequestApprovalTask,
  createRestoredGitCreatePullRequestApprovalTask,
  createRestoredGitCommitApprovalTask,
  createRestoredGitPushApprovalTask,
  createRestoredGitStageApprovalTask,
  findRestorableApprovalRecord,
  getDurableApprovalToolName,
  isDurableApprovalRequestTitle,
  runRestoredGitCommentPullRequest,
  runRestoredGitCreatePullRequest,
} from "./restored-approval";

describe("restored approval filters", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("restores only durable flows that persist executable payloads", () => {
    expect(isDurableApprovalRequestTitle(PDF_APPROVAL_TITLE)).toBe(true);
    expect(isDurableApprovalRequestTitle(CODE_PATCH_APPROVAL_TITLE)).toBe(true);
    expect(isDurableApprovalRequestTitle(GIT_PUSH_APPROVAL_TITLE)).toBe(true);
    expect(isDurableApprovalRequestTitle(GIT_COMMIT_APPROVAL_TITLE)).toBe(true);
    expect(isDurableApprovalRequestTitle(GIT_STAGE_APPROVAL_TITLE)).toBe(true);
    expect(isDurableApprovalRequestTitle(GIT_CREATE_PR_APPROVAL_TITLE)).toBe(true);
    expect(getDurableApprovalToolName(PDF_APPROVAL_TITLE)).toBe(PDF_APPROVAL_TOOL_NAME);
    expect(getDurableApprovalToolName(CODE_PATCH_APPROVAL_TITLE)).toBe(CODE_PATCH_APPROVAL_TOOL_NAME);
    expect(getDurableApprovalToolName(GIT_PUSH_APPROVAL_TITLE)).toBe(GIT_PUSH_APPROVAL_TOOL_NAME);
    expect(getDurableApprovalToolName(GIT_COMMIT_APPROVAL_TITLE)).toBe(GIT_COMMIT_APPROVAL_TOOL_NAME);
    expect(getDurableApprovalToolName(GIT_STAGE_APPROVAL_TITLE)).toBe(GIT_STAGE_APPROVAL_TOOL_NAME);
    expect(getDurableApprovalToolName(GIT_CREATE_PR_APPROVAL_TITLE)).toBe(GIT_CREATE_PR_APPROVAL_TOOL_NAME);

    expect(isDurableApprovalRequestTitle("Approve text file write")).toBe(false);
    expect(getDurableApprovalToolName("Approve text file write")).toBeUndefined();
  });

  it("does not restore text write records without persisted content", () => {
    const textRecord = createTextWriteRecord();
    const pdfRecord = createPdfRecord();

    expect(findRestorableApprovalRecord([textRecord])).toBeUndefined();
    expect(findRestorableApprovalRecord([textRecord, pdfRecord])).toBe(pdfRecord);
  });

  it("restores Git push records with persisted push plans", () => {
    const textRecord = createTextWriteRecord();
    const gitPushRecord = createGitPushRecord();

    expect(findRestorableApprovalRecord([textRecord, gitPushRecord])).toBe(gitPushRecord);
    expect(createRestoredGitPushApprovalTask(gitPushRecord).permissionRequest?.title).toBe(
      GIT_PUSH_APPROVAL_TITLE,
    );
  });

  it("restores Git commit records with persisted commit plans", () => {
    const textRecord = createTextWriteRecord();
    const gitCommitRecord = createGitCommitRecord();

    expect(findRestorableApprovalRecord([textRecord, gitCommitRecord])).toBe(gitCommitRecord);
    const restoredTask = createRestoredGitCommitApprovalTask(gitCommitRecord);
    expect(restoredTask.permissionRequest?.title).toBe(GIT_COMMIT_APPROVAL_TITLE);
    expect(restoredTask.verificationSummary).toContain("1 file(s) ready to commit");
  });

  it("restores Git stage records with persisted stage plans", () => {
    const textRecord = createTextWriteRecord();
    const gitStageRecord = createGitStageRecord();

    expect(findRestorableApprovalRecord([textRecord, gitStageRecord])).toBe(gitStageRecord);
    const restoredTask = createRestoredGitStageApprovalTask(gitStageRecord);
    expect(restoredTask.permissionRequest?.title).toBe(GIT_STAGE_APPROVAL_TITLE);
    expect(restoredTask.verificationSummary).toContain("1 selected file(s) ready to stage");
  });

  it("restores Git pull request records with persisted PR plans", () => {
    const textRecord = createTextWriteRecord();
    const gitCreatePrRecord = createGitCreatePullRequestRecord();

    expect(findRestorableApprovalRecord([textRecord, gitCreatePrRecord])).toBe(gitCreatePrRecord);
    const restoredTask = createRestoredGitCreatePullRequestApprovalTask(gitCreatePrRecord);
    expect(restoredTask.permissionRequest?.title).toBe(GIT_CREATE_PR_APPROVAL_TITLE);
    expect(restoredTask.verificationSummary).toContain("pull request \"Add review UI\"");
  });

  it("restores Git pull request comment records with persisted comment plans", () => {
    const textRecord = createTextWriteRecord();
    const gitCommentPrRecord = createGitCommentPullRequestRecord();

    expect(findRestorableApprovalRecord([textRecord, gitCommentPrRecord])).toBe(gitCommentPrRecord);
    const restoredTask = createRestoredGitCommentPullRequestApprovalTask(gitCommentPrRecord);
    expect(restoredTask.permissionRequest?.title).toBe(GIT_COMMENT_PR_APPROVAL_TITLE);
    expect(restoredTask.verificationSummary).toContain("pull request comment ready for 12");
  });

  it("restores, approves, and executes a persisted Git pull request approval", async () => {
    const gitCreatePrRecord = createGitCreatePullRequestRecord();
    vi.mocked(invoke)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        workspaceRoot: "E:/Javis",
        provider: "github-cli",
        url: "https://github.com/acme/repo/pull/1",
        title: "Add review UI",
        baseBranch: "main",
        headBranch: "feature/git-pr",
        draft: true,
        created: true,
        output: "https://github.com/acme/repo/pull/1",
      });

    const result = await runRestoredGitCreatePullRequest(gitCreatePrRecord);

    expect(result.url).toBe("https://github.com/acme/repo/pull/1");
    expect(vi.mocked(invoke).mock.calls.map((call) => call[0])).toEqual([
      "git_restore_create_pull_request_approval",
      "git_approve_create_pull_request",
      "git_execute_create_pull_request",
    ]);
    expect(vi.mocked(invoke).mock.calls[2]?.[1]).toEqual({
      request: expect.objectContaining({
        approvalId: "git-create-pr-approval",
        title: "Add review UI",
        baseBranch: "main",
        draft: true,
      }),
    });
  });

  it("restores, approves, and executes a persisted Git pull request comment approval", async () => {
    const gitCommentPrRecord = createGitCommentPullRequestRecord();
    vi.mocked(invoke)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        workspaceRoot: "E:/Javis",
        provider: "github-cli",
        pullRequest: "12",
        commented: true,
        output: "https://github.com/acme/repo/pull/12#issuecomment-1",
      });

    const result = await runRestoredGitCommentPullRequest(gitCommentPrRecord);

    expect(result.pullRequest).toBe("12");
    expect(vi.mocked(invoke).mock.calls.map((call) => call[0])).toEqual([
      "git_restore_comment_pull_request_approval",
      "git_approve_comment_pull_request",
      "git_execute_comment_pull_request",
    ]);
    expect(vi.mocked(invoke).mock.calls[2]?.[1]).toEqual({
      request: expect.objectContaining({
        approvalId: "git-comment-pr-approval",
        pullRequest: "12",
        body: "Looks good.",
      }),
    });
  });
});

function createPdfRecord(): DurableApprovalRecord {
  const dryRun: DryRunSummary = {
    operation: "Organize PDF files by filename topic",
    affectedPaths: [
      {
        source: "C:/Users/example/Downloads/a.pdf",
        target: "C:/Users/example/Downloads/Documents/a.pdf",
        action: "move",
      },
    ],
    riskSummary: "Preview only.",
    reversible: true,
  };
  return createRecord("pdf-approval", PDF_APPROVAL_TOOL_NAME, PDF_APPROVAL_TITLE, dryRun);
}

function createTextWriteRecord(): DurableApprovalRecord {
  const dryRun: DryRunSummary = {
    operation: "Write text file",
    affectedPaths: [
      {
        source: "",
        target: "E:/Javis/notes.md",
        action: "create",
      },
    ],
    riskSummary: "Preview only.",
    reversible: true,
  };
  return createRecord("text-approval", "file.writeText", "Approve text file write", dryRun);
}

function createGitPushRecord(): DurableApprovalRecord {
  const dryRun: DryRunSummary = {
    operation: "Preview Git push",
    affectedPaths: [
      {
        source: "feature/git-push",
        target: "origin/feature/git-push",
        action: "push",
      },
    ],
    riskSummary: "Pushes 1 local commit to the remote.",
    reversible: false,
  };
  const record = createRecord(
    "git-push-approval",
    GIT_PUSH_APPROVAL_TOOL_NAME,
    GIT_PUSH_APPROVAL_TITLE,
    dryRun,
  );
  return {
    ...record,
    gitPushPlan: {
      approvalId: "git-push-approval",
      preview: {
        branch: "feature/git-push",
        upstream: "origin/feature/git-push",
        remoteName: "origin",
        remoteBranch: "feature/git-push",
        remoteUrl: "https://example.com/repo.git",
        ahead: 1,
        behind: 0,
        commits: [
          {
            hash: "abc123",
            subject: "Local change",
          },
        ],
        dryRun,
      },
    },
  };
}

function createGitCommitRecord(): DurableApprovalRecord {
  const dryRun: DryRunSummary = {
    operation: "Preview Git commit",
    affectedPaths: [
      {
        source: "README.md",
        target: "README.md",
        action: "modify",
      },
    ],
    riskSummary: "Preview only.",
    reversible: false,
  };
  const record = createRecord(
    "git-commit-approval",
    GIT_COMMIT_APPROVAL_TOOL_NAME,
    GIT_COMMIT_APPROVAL_TITLE,
    dryRun,
  );
  return {
    ...record,
    gitCommitPlan: {
      approvalId: "git-commit-approval",
      preview: {
        workspaceRoot: "E:/Javis",
        branch: "feature/git-commit",
        message: "Update readme",
        files: [
          {
            path: "README.md",
            indexStatus: " ",
            worktreeStatus: "M",
            action: "modify",
            contentHash: "hash-readme",
          },
        ],
        diffStat: " README.md | 1 +",
        diff: "diff --git a/README.md b/README.md\n+hello\n",
        dryRun,
      },
    },
  };
}

function createGitStageRecord(): DurableApprovalRecord {
  const dryRun: DryRunSummary = {
    operation: "Preview Git stage selected files",
    affectedPaths: [
      {
        source: "README.md",
        target: "README.md",
        action: "stage",
      },
    ],
    riskSummary: "Preview only.",
    reversible: true,
  };
  const record = createRecord(
    "git-stage-approval",
    GIT_STAGE_APPROVAL_TOOL_NAME,
    GIT_STAGE_APPROVAL_TITLE,
    dryRun,
  );
  return {
    ...record,
    gitStagePlan: {
      approvalId: "git-stage-approval",
      preview: {
        workspaceRoot: "E:/Javis",
        files: [
          {
            path: "README.md",
            indexStatus: "",
            worktreeStatus: "M",
            action: "stage",
            contentHash: "hash-readme",
          },
        ],
        diffStat: " README.md | 1 +",
        diff: "diff --git a/README.md b/README.md\n+hello\n",
        dryRun,
      },
    },
  };
}

function createGitCreatePullRequestRecord(): DurableApprovalRecord {
  const dryRun: DryRunSummary = {
    operation: "Preview GitHub pull request creation",
    affectedPaths: [
      {
        source: "feature/git-pr",
        target: "main (https://github.com/acme/repo.git)",
        action: "create_pr",
      },
    ],
    riskSummary: "Preview only.",
    reversible: false,
  };
  const record = createRecord(
    "git-create-pr-approval",
    GIT_CREATE_PR_APPROVAL_TOOL_NAME,
    GIT_CREATE_PR_APPROVAL_TITLE,
    dryRun,
  );
  return {
    ...record,
    gitCreatePullRequestPlan: {
      approvalId: "git-create-pr-approval",
      preview: {
        workspaceRoot: "E:/Javis",
        provider: "github-cli",
        title: "Add review UI",
        body: "This is a draft PR.",
        baseBranch: "main",
        headBranch: "feature/git-pr",
        headCommit: "abc123",
        remoteName: "origin",
        remoteUrl: "https://github.com/acme/repo.git",
        draft: true,
        dryRun,
      },
    },
  };
}

function createGitCommentPullRequestRecord(): DurableApprovalRecord {
  const dryRun: DryRunSummary = {
    operation: "Preview GitHub pull request comment",
    affectedPaths: [
      {
        source: "12",
        target: "https://github.com/acme/repo.git",
        action: "comment_pr",
      },
    ],
    riskSummary: "Preview only.",
    reversible: false,
  };
  const record = createRecord(
    "git-comment-pr-approval",
    GIT_COMMENT_PR_APPROVAL_TOOL_NAME,
    GIT_COMMENT_PR_APPROVAL_TITLE,
    dryRun,
  );
  return {
    ...record,
    gitCommentPullRequestPlan: {
      approvalId: "git-comment-pr-approval",
      preview: {
        workspaceRoot: "E:/Javis",
        provider: "github-cli",
        pullRequest: "12",
        body: "Looks good.",
        remoteUrl: "https://github.com/acme/repo.git",
        dryRun,
      },
    },
  };
}

function createRecord(
  approvalId: string,
  toolName: string,
  title: string,
  dryRun: DryRunSummary,
): DurableApprovalRecord {
  const bindingHash = createDryRunBindingHash(dryRun);
  const permissionRequest: PermissionRequest = {
    id: approvalId,
    level: "confirmed_write",
    title,
    reason: "Write operation requires approval.",
    bindingHash,
    status: "pending",
    createdAt: "2026-05-24T00:00:00.000Z",
    dryRun,
  };
  return {
    approvalId,
    taskId: `task-${approvalId}`,
    toolName,
    workspacePath: "E:/Javis",
    permissionLevel: "confirmed_write",
    previewHash: bindingHash,
    expiresAt: "2026-05-24T00:10:00.000Z",
    status: "pending",
    createdAt: "2026-05-24T00:00:00.000Z",
    permissionRequest,
  };
}
