import { describe, expect, it } from "vitest";
import {
  createCodeApplyDryRun,
  createDryRunBindingHash,
} from "@javis/core";
import type { DryRunSummary, PermissionRequest } from "@javis/tools";
import {
  APPROVAL_RECORDS_LIMIT,
  APPROVAL_RECORDS_STORAGE_KEY,
  APPROVAL_RECORDS_STORAGE_VERSION,
  expireApprovalRecord,
  createApprovalRecordFromPermissionRequest,
  findPendingApprovalRecord,
  isApprovalRecordExpired,
  loadApprovalRecords,
  resolveApprovalRecord,
  saveApprovalRecords,
  sanitizeApprovalRecord,
  upsertApprovalRecord,
  type DurableApprovalRecord,
} from "./approval-records";

describe("durable approval records", () => {
  it("persists pending confirmed-write approval records", () => {
    const storage = createMemoryStorage();
    const record = createApprovalRecord();

    saveApprovalRecords(storage, [record]);
    const loaded = loadApprovalRecords(storage);

    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(record);
    expect(storage.getItem(APPROVAL_RECORDS_STORAGE_KEY)).toContain("approval-1");
  });

  it("persists approval risk without storing screenshot previews", () => {
    const storage = createMemoryStorage();
    const record = {
      ...createApprovalRecord("approval-risk"),
      permissionRequest: {
        ...createApprovalRecord("approval-risk").permissionRequest,
        writeRiskLevel: "dangerous",
        screenshotDataUrl: "data:image/png;base64,PREVIEW_SHOULD_NOT_SURVIVE==",
      },
    } satisfies DurableApprovalRecord;

    saveApprovalRecords(storage, [record]);
    const loaded = loadApprovalRecords(storage);

    expect(loaded[0]?.permissionRequest.writeRiskLevel).toBe("dangerous");
    expect(loaded[0]?.permissionRequest.screenshotDataUrl).toBeUndefined();
    expect(storage.getItem(APPROVAL_RECORDS_STORAGE_KEY)).not.toContain("data:image");
  });

  it("rejects malformed or mismatched approval records", () => {
    expect(sanitizeApprovalRecord({ ...createApprovalRecord(), previewHash: "changed" })).toBeNull();
    expect(sanitizeApprovalRecord({
      ...createApprovalRecord(),
      permissionRequest: {
        ...createApprovalRecord().permissionRequest,
        id: "other-approval",
      },
    })).toBeNull();
    expect(sanitizeApprovalRecord({
      ...createApprovalRecord(),
      permissionRequest: {
        ...createApprovalRecord().permissionRequest,
        dryRun: {
          ...createApprovalRecord().permissionRequest.dryRun,
          affectedPaths: [{ action: "archive" }],
        },
      },
    })).toBeNull();
    const tamperedDryRun: DryRunSummary = {
      ...createApprovalRecord().permissionRequest.dryRun,
      affectedPaths: [
        {
          source: "C:/Users/example/Downloads/a.pdf",
          target: "C:/Users/example/Downloads/Other/a.pdf",
          action: "move",
        },
      ],
    };
    expect(sanitizeApprovalRecord({
      ...createApprovalRecord(),
      previewHash: createDryRunBindingHash(tamperedDryRun),
      permissionRequest: {
        ...createApprovalRecord().permissionRequest,
        bindingHash: createDryRunBindingHash(tamperedDryRun),
        dryRun: createApprovalRecord().permissionRequest.dryRun,
      },
    })).toBeNull();
  });

  it("loads versioned envelopes only", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      APPROVAL_RECORDS_STORAGE_KEY,
      JSON.stringify({
        version: APPROVAL_RECORDS_STORAGE_VERSION,
        records: [createApprovalRecord()],
      }),
    );
    expect(loadApprovalRecords(storage)).toHaveLength(1);

    storage.setItem(
      APPROVAL_RECORDS_STORAGE_KEY,
      JSON.stringify({
        version: APPROVAL_RECORDS_STORAGE_VERSION + 1,
        records: [createApprovalRecord()],
      }),
    );
    expect(loadApprovalRecords(storage)).toEqual([]);
  });

  it("upserts newest records and enforces the storage limit", () => {
    const records = Array.from({ length: APPROVAL_RECORDS_LIMIT + 2 }, (_, index) =>
      createApprovalRecord(`approval-${index}`),
    );
    const updated = {
      ...records[5],
      workspacePath: "E:/Updated",
    };

    const result = upsertApprovalRecord(records, updated);

    expect(result).toHaveLength(APPROVAL_RECORDS_LIMIT);
    expect(result[0]?.approvalId).toBe("approval-5");
    expect(result[0]?.workspacePath).toBe("E:/Updated");
  });

  it("creates records from pending permission requests", () => {
    const record = createApprovalRecord();
    const created = createApprovalRecordFromPermissionRequest({
      taskId: "task-1",
      toolName: "file.executePdfOrganization",
      workspacePath: "C:/Users/example/Downloads",
      permissionRequest: record.permissionRequest,
      now: "2026-05-24T00:00:00.000Z",
    });

    expect(created).toEqual(record);
    expect(createApprovalRecordFromPermissionRequest({
      taskId: "task-1",
      toolName: "file.executePdfOrganization",
      workspacePath: "C:/Users/example/Downloads",
      permissionRequest: {
        ...record.permissionRequest,
        status: "approved",
      },
    })).toBeNull();
  });

  it("creates durable records for Code Agent patch approvals", () => {
    const codeProposedEdit = createCodeProposedEdit();
    const dryRun = createCodeApplyDryRun(codeProposedEdit);
    const created = createApprovalRecordFromPermissionRequest({
      taskId: "task-code",
      toolName: "code.applyProposedEdit",
      workspacePath: "E:/Javis",
      permissionRequest: {
        id: "task-code-apply-permission",
        level: "confirmed_write",
        title: "Approve Code Agent patch application",
        reason: "Applying the proposed patch changes local project files.",
        bindingHash: createDryRunBindingHash(dryRun),
        status: "pending",
        createdAt: "2026-05-24T00:00:00.000Z",
        dryRun,
      },
      codeProposedEdit,
      now: "2026-05-24T00:00:00.000Z",
    });

    expect(created?.toolName).toBe("code.applyProposedEdit");
    expect(created?.workspacePath).toBe("E:/Javis");
    expect(created?.permissionRequest.title).toBe("Approve Code Agent patch application");
    expect(created?.permissionRequest.dryRun.affectedPaths[0]?.action).toBe("modify");
    expect(created?.codeProposedEdit?.proposalId).toBe("proposal-1");
    expect(created?.codeProposedEdit?.patch).toContain("diff --git");
  });

  it("creates durable records for Git push approvals", () => {
    const record = createGitPushApprovalRecord();
    const created = createApprovalRecordFromPermissionRequest({
      taskId: "task-git",
      toolName: "git.pushBranch",
      workspacePath: "E:/Javis",
      permissionRequest: record.permissionRequest,
      gitPushPlan: record.gitPushPlan,
      now: "2026-06-09T10:00:00.000Z",
    });

    expect(created).toEqual(record);
    expect(created?.permissionRequest.dryRun.affectedPaths[0]?.action).toBe("push");
    expect(created?.gitPushPlan?.preview.branch).toBe("feature/git-push");
  });

  it("rejects Git push approval records without the matching push plan", () => {
    const record = createGitPushApprovalRecord();
    const misleadingDryRun: DryRunSummary = {
      ...record.permissionRequest.dryRun,
      affectedPaths: [{
        source: "feature/other",
        target: "origin/feature/other",
        action: "push",
      }],
    };

    expect(sanitizeApprovalRecord({
      ...record,
      gitPushPlan: undefined,
    })).toBeNull();
    expect(sanitizeApprovalRecord({
      ...record,
      gitPushPlan: {
        ...record.gitPushPlan,
        preview: {
          ...record.gitPushPlan!.preview,
          dryRun: misleadingDryRun,
        },
      },
    })).toBeNull();
  });

  it("creates durable records for Git commit approvals", () => {
    const record = createGitCommitApprovalRecord();
    const created = createApprovalRecordFromPermissionRequest({
      taskId: "task-git-commit",
      toolName: "git.createCommit",
      workspacePath: "E:/Javis",
      permissionRequest: record.permissionRequest,
      gitCommitPlan: record.gitCommitPlan,
      now: "2026-06-10T10:00:00.000Z",
    });

    expect(created).toEqual(record);
    expect(created?.permissionRequest.dryRun.affectedPaths[0]?.action).toBe("modify");
    expect(created?.gitCommitPlan?.preview.files[0]?.contentHash).toBe("hash-readme");
  });

  it("rejects Git commit approval records without the matching commit plan", () => {
    const record = createGitCommitApprovalRecord();
    const misleadingDryRun: DryRunSummary = {
      ...record.permissionRequest.dryRun,
      affectedPaths: [{
        source: "other.md",
        target: "other.md",
        action: "modify",
      }],
    };

    expect(sanitizeApprovalRecord({
      ...record,
      gitCommitPlan: undefined,
    })).toBeNull();
    expect(sanitizeApprovalRecord({
      ...record,
      gitCommitPlan: {
        ...record.gitCommitPlan,
        preview: {
          ...record.gitCommitPlan!.preview,
          dryRun: misleadingDryRun,
        },
      },
    })).toBeNull();
    expect(sanitizeApprovalRecord({
      ...record,
      gitCommitPlan: {
        ...record.gitCommitPlan,
        preview: {
          ...record.gitCommitPlan!.preview,
          workspaceRoot: "E:/Other",
        },
      },
    })).toBeNull();
  });

  it("creates durable records for Git stage approvals", () => {
    const record = createGitStageApprovalRecord();
    const created = createApprovalRecordFromPermissionRequest({
      taskId: "task-git-stage",
      toolName: "git.stageFiles",
      workspacePath: "E:/Javis",
      permissionRequest: record.permissionRequest,
      gitStagePlan: record.gitStagePlan,
      now: "2026-06-10T11:00:00.000Z",
    });

    expect(created).toEqual(record);
    expect(created?.permissionRequest.dryRun.affectedPaths[0]?.action).toBe("stage");
    expect(created?.gitStagePlan?.preview.files[0]?.contentHash).toBe("hash-readme");
  });

  it("rejects Git stage approval records without the matching stage plan", () => {
    const record = createGitStageApprovalRecord();
    const misleadingDryRun: DryRunSummary = {
      ...record.permissionRequest.dryRun,
      affectedPaths: [{
        source: "other.md",
        target: "other.md",
        action: "stage",
      }],
    };

    expect(sanitizeApprovalRecord({
      ...record,
      gitStagePlan: undefined,
    })).toBeNull();
    expect(sanitizeApprovalRecord({
      ...record,
      gitStagePlan: {
        ...record.gitStagePlan,
        preview: {
          ...record.gitStagePlan!.preview,
          dryRun: misleadingDryRun,
        },
      },
    })).toBeNull();
    expect(sanitizeApprovalRecord({
      ...record,
      gitStagePlan: {
        ...record.gitStagePlan,
        preview: {
          ...record.gitStagePlan!.preview,
          workspaceRoot: "E:/Other",
        },
      },
    })).toBeNull();
  });

  it("creates durable records for Git pull request approvals", () => {
    const record = createGitCreatePullRequestApprovalRecord();
    const created = createApprovalRecordFromPermissionRequest({
      taskId: "task-git-create-pr",
      toolName: "git.createPullRequest",
      workspacePath: "E:/Javis",
      permissionRequest: record.permissionRequest,
      gitCreatePullRequestPlan: record.gitCreatePullRequestPlan,
      now: "2026-06-10T12:00:00.000Z",
    });

    expect(created).toEqual(record);
    expect(created?.permissionRequest.dryRun.affectedPaths[0]?.action).toBe("create_pr");
    expect(created?.gitCreatePullRequestPlan?.preview.headBranch).toBe("feature/git-pr");
  });

  it("rejects Git pull request approval records without the matching PR plan", () => {
    const record = createGitCreatePullRequestApprovalRecord();
    const misleadingDryRun: DryRunSummary = {
      ...record.permissionRequest.dryRun,
      affectedPaths: [{
        source: "feature/other",
        target: "main",
        action: "create_pr",
      }],
    };

    expect(sanitizeApprovalRecord({
      ...record,
      gitCreatePullRequestPlan: undefined,
    })).toBeNull();
    expect(sanitizeApprovalRecord({
      ...record,
      gitCreatePullRequestPlan: {
        ...record.gitCreatePullRequestPlan,
        preview: {
          ...record.gitCreatePullRequestPlan!.preview,
          dryRun: misleadingDryRun,
        },
      },
    })).toBeNull();
    expect(sanitizeApprovalRecord({
      ...record,
      gitCreatePullRequestPlan: {
        ...record.gitCreatePullRequestPlan,
        preview: {
          ...record.gitCreatePullRequestPlan!.preview,
          workspaceRoot: "E:/Other",
        },
      },
    })).toBeNull();
  });

  it("creates durable records for Git pull request comment approvals", () => {
    const record = createGitCommentPullRequestApprovalRecord();
    const created = createApprovalRecordFromPermissionRequest({
      taskId: "task-git-comment-pr",
      toolName: "git.commentPullRequest",
      workspacePath: "E:/Javis",
      permissionRequest: record.permissionRequest,
      gitCommentPullRequestPlan: record.gitCommentPullRequestPlan,
      now: "2026-06-10T12:00:00.000Z",
    });

    expect(created).toEqual(record);
    expect(created?.permissionRequest.dryRun.affectedPaths[0]?.action).toBe("comment_pr");
    expect(created?.gitCommentPullRequestPlan?.preview.pullRequest).toBe("12");
  });

  it("rejects Git pull request comment approval records without the matching comment plan", () => {
    const record = createGitCommentPullRequestApprovalRecord();
    const misleadingDryRun: DryRunSummary = {
      ...record.permissionRequest.dryRun,
      affectedPaths: [{
        source: "13",
        target: "https://github.com/acme/repo.git",
        action: "comment_pr",
      }],
    };

    expect(sanitizeApprovalRecord({
      ...record,
      gitCommentPullRequestPlan: undefined,
    })).toBeNull();
    expect(sanitizeApprovalRecord({
      ...record,
      gitCommentPullRequestPlan: {
        ...record.gitCommentPullRequestPlan,
        preview: {
          ...record.gitCommentPullRequestPlan!.preview,
          dryRun: misleadingDryRun,
        },
      },
    })).toBeNull();
    expect(sanitizeApprovalRecord({
      ...record,
      gitCommentPullRequestPlan: {
        ...record.gitCommentPullRequestPlan,
        preview: {
          ...record.gitCommentPullRequestPlan!.preview,
          workspaceRoot: "E:/Other",
        },
      },
    })).toBeNull();
  });

  it("rejects Code Agent approval records whose dry-run files do not match the proposed edit", () => {
    const record = createCodeApprovalRecord();

    expect(sanitizeApprovalRecord({
      ...record,
      codeProposedEdit: {
        ...record.codeProposedEdit,
        changedFiles: ["packages/core/src/other.ts"],
      },
    })).toBeNull();
    expect(sanitizeApprovalRecord({
      ...record,
      workspacePath: "E:/Other",
    })).toBeNull();
    expect(sanitizeApprovalRecord({
      ...record,
      codeProposedEdit: undefined,
    })).toBeNull();
    expect(sanitizeApprovalRecord({
      ...record,
      codeProposedEdit: {
        ...record.codeProposedEdit,
        patch: "diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts\n+changed\n",
        patchHash: "fnv1a-other",
      },
    })).toBeNull();
    const misleadingDryRun: DryRunSummary = {
      ...record.permissionRequest.dryRun,
      affectedPaths: [
        {
          source: "packages/core/src/index.ts",
          target: "packages/core/src/index.ts",
          action: "delete",
        },
      ],
    };
    expect(sanitizeApprovalRecord({
      ...record,
      previewHash: createDryRunBindingHash(misleadingDryRun),
      permissionRequest: {
        ...record.permissionRequest,
        bindingHash: createDryRunBindingHash(misleadingDryRun),
        dryRun: misleadingDryRun,
      },
    })).toBeNull();
  });

  it("resolves and expires pending records without changing terminal records", () => {
    const pending = createApprovalRecord();
    const approved = resolveApprovalRecord(pending, "approved", "2026-05-24T00:05:00.000Z");
    const denied = resolveApprovalRecord(pending, "denied", "2026-05-24T00:06:00.000Z");
    const expired = expireApprovalRecord(pending, "2026-05-24T00:10:00.000Z");

    expect(approved.status).toBe("approved");
    expect(approved.permissionRequest.status).toBe("approved");
    expect(denied.status).toBe("denied");
    expect(expired.status).toBe("expired");
    expect(resolveApprovalRecord(approved, "denied", "2026-05-24T00:07:00.000Z")).toBe(approved);
  });

  it("detects expired pending records", () => {
    expect(isApprovalRecordExpired(
      createApprovalRecord(),
      "2026-05-24T00:09:59.999Z",
    )).toBe(false);
    expect(isApprovalRecordExpired(
      createApprovalRecord(),
      "2026-05-24T00:10:00.000Z",
    )).toBe(true);
    expect(isApprovalRecordExpired(
      resolveApprovalRecord(createApprovalRecord(), "approved", "2026-05-24T00:05:00.000Z"),
      "2026-05-24T00:10:00.000Z",
    )).toBe(false);
  });

  it("finds pending records by tool name", () => {
    const pending = createApprovalRecord("approval-pending");
    const approved = resolveApprovalRecord(
      createApprovalRecord("approval-approved"),
      "approved",
      "2026-05-24T00:05:00.000Z",
    );

    expect(findPendingApprovalRecord([approved, pending], "file.executePdfOrganization")).toBe(pending);
    expect(findPendingApprovalRecord([approved], "file.executePdfOrganization")).toBeUndefined();
  });
});

function createApprovalRecord(approvalId = "approval-1"): DurableApprovalRecord {
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
  const bindingHash = createDryRunBindingHash(dryRun);
  const permissionRequest: PermissionRequest = {
    id: approvalId,
    level: "confirmed_write",
    title: "Approve PDF move plan",
    reason: "Moving files changes the local filesystem, so Javis needs explicit approval.",
    bindingHash,
    status: "pending",
    createdAt: "2026-05-24T00:00:00.000Z",
    dryRun,
  };
  return {
    approvalId,
    taskId: "task-1",
    toolName: "file.executePdfOrganization",
    workspacePath: "C:/Users/example/Downloads",
    permissionLevel: "confirmed_write",
    previewHash: bindingHash,
    expiresAt: "2026-05-24T00:10:00.000Z",
    status: "pending",
    createdAt: "2026-05-24T00:00:00.000Z",
    permissionRequest,
  };
}

function createCodeApprovalRecord(): DurableApprovalRecord {
  const codeProposedEdit = createCodeProposedEdit();
  const dryRun = createCodeApplyDryRun(codeProposedEdit);
  const bindingHash = createDryRunBindingHash(dryRun);
  return {
    approvalId: "task-code-apply-permission",
    taskId: "task-code",
    toolName: "code.applyProposedEdit",
    workspacePath: "E:/Javis",
    permissionLevel: "confirmed_write",
    previewHash: bindingHash,
    expiresAt: "2026-05-24T00:10:00.000Z",
    status: "pending",
    createdAt: "2026-05-24T00:00:00.000Z",
    permissionRequest: {
      id: "task-code-apply-permission",
      level: "confirmed_write",
      title: "Approve Code Agent patch application",
      reason: "Applying the proposed patch changes local project files.",
      bindingHash,
      status: "pending",
      createdAt: "2026-05-24T00:00:00.000Z",
      dryRun,
    },
    codeProposedEdit,
  };
}

function createGitPushApprovalRecord(): DurableApprovalRecord {
  const dryRun: DryRunSummary = {
    operation: "Preview Git push",
    affectedPaths: [{
      source: "feature/git-push",
      target: "origin/feature/git-push",
      action: "push",
    }],
    riskSummary: "Preview only. No Git write was executed.",
    reversible: false,
  };
  const bindingHash = createDryRunBindingHash(dryRun);
  return {
    approvalId: "approval-git-push",
    taskId: "task-git",
    toolName: "git.pushBranch",
    workspacePath: "E:/Javis",
    permissionLevel: "confirmed_write",
    previewHash: bindingHash,
    expiresAt: "2026-06-09T10:10:00.000Z",
    status: "pending",
    createdAt: "2026-06-09T10:00:00.000Z",
    permissionRequest: {
      id: "approval-git-push",
      level: "confirmed_write",
      title: "Approve Git push",
      reason: "Pushing sends local commits to the configured remote.",
      bindingHash,
      status: "pending",
      createdAt: "2026-06-09T10:00:00.000Z",
      dryRun,
    },
    gitPushPlan: {
      approvalId: "approval-git-push",
      preview: {
        branch: "feature/git-push",
        upstream: "origin/feature/git-push",
        remoteName: "origin",
        remoteBranch: "feature/git-push",
        remoteUrl: "file:///tmp/remote.git",
        ahead: 1,
        behind: 0,
        commits: [{ hash: "abc123", subject: "Local change" }],
        dryRun,
      },
    },
  };
}

function createGitCommitApprovalRecord(): DurableApprovalRecord {
  const dryRun: DryRunSummary = {
    operation: "Preview Git commit",
    affectedPaths: [{
      source: "README.md",
      target: "README.md",
      action: "modify",
    }],
    riskSummary: "Preview only. No Git write was executed.",
    reversible: false,
  };
  const bindingHash = createDryRunBindingHash(dryRun);
  return {
    approvalId: "approval-git-commit",
    taskId: "task-git-commit",
    toolName: "git.createCommit",
    workspacePath: "E:/Javis",
    permissionLevel: "confirmed_write",
    previewHash: bindingHash,
    expiresAt: "2026-06-10T10:10:00.000Z",
    status: "pending",
    createdAt: "2026-06-10T10:00:00.000Z",
    permissionRequest: {
      id: "approval-git-commit",
      level: "confirmed_write",
      title: "Approve Git commit",
      reason: "Committing stages current workspace changes and writes a local Git commit.",
      bindingHash,
      status: "pending",
      createdAt: "2026-06-10T10:00:00.000Z",
      dryRun,
    },
    gitCommitPlan: {
      approvalId: "approval-git-commit",
      preview: {
        workspaceRoot: "E:/Javis",
        branch: "feature/git-commit",
        message: "Commit changes",
        files: [{
          path: "README.md",
          indexStatus: "",
          worktreeStatus: "M",
          action: "modify",
          contentHash: "hash-readme",
        }],
        diffStat: " README.md | 1 +",
        diff: "diff --git a/README.md b/README.md",
        dryRun,
      },
    },
  };
}

function createGitStageApprovalRecord(): DurableApprovalRecord {
  const dryRun: DryRunSummary = {
    operation: "Preview Git stage selected files",
    affectedPaths: [{
      source: "README.md",
      target: "README.md",
      action: "stage",
    }],
    riskSummary: "Preview only. No Git write was executed.",
    reversible: true,
  };
  const bindingHash = createDryRunBindingHash(dryRun);
  return {
    approvalId: "approval-git-stage",
    taskId: "task-git-stage",
    toolName: "git.stageFiles",
    workspacePath: "E:/Javis",
    permissionLevel: "confirmed_write",
    previewHash: bindingHash,
    expiresAt: "2026-06-10T11:10:00.000Z",
    status: "pending",
    createdAt: "2026-06-10T11:00:00.000Z",
    permissionRequest: {
      id: "approval-git-stage",
      level: "confirmed_write",
      title: "Approve Git stage",
      reason: "Staging updates the Git index for selected workspace files.",
      bindingHash,
      status: "pending",
      createdAt: "2026-06-10T11:00:00.000Z",
      dryRun,
    },
    gitStagePlan: {
      approvalId: "approval-git-stage",
      preview: {
        workspaceRoot: "E:/Javis",
        files: [{
          path: "README.md",
          indexStatus: "",
          worktreeStatus: "M",
          action: "stage",
          contentHash: "hash-readme",
        }],
        diffStat: " README.md | 1 +",
        diff: "diff --git a/README.md b/README.md",
        dryRun,
      },
    },
  };
}

function createGitCreatePullRequestApprovalRecord(): DurableApprovalRecord {
  const dryRun: DryRunSummary = {
    operation: "Preview GitHub pull request creation",
    affectedPaths: [{
      source: "feature/git-pr",
      target: "main (https://github.com/acme/repo.git)",
      action: "create_pr",
    }],
    riskSummary: "Preview only. No remote write was executed.",
    reversible: false,
  };
  const bindingHash = createDryRunBindingHash(dryRun);
  return {
    approvalId: "approval-git-create-pr",
    taskId: "task-git-create-pr",
    toolName: "git.createPullRequest",
    workspacePath: "E:/Javis",
    permissionLevel: "confirmed_write",
    previewHash: bindingHash,
    expiresAt: "2026-06-10T12:10:00.000Z",
    status: "pending",
    createdAt: "2026-06-10T12:00:00.000Z",
    permissionRequest: {
      id: "approval-git-create-pr",
      level: "confirmed_write",
      title: "Approve Git pull request",
      reason: "Creating a pull request sends branch metadata to the configured GitHub remote.",
      bindingHash,
      status: "pending",
      createdAt: "2026-06-10T12:00:00.000Z",
      dryRun,
    },
    gitCreatePullRequestPlan: {
      approvalId: "approval-git-create-pr",
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

function createGitCommentPullRequestApprovalRecord(): DurableApprovalRecord {
  const dryRun: DryRunSummary = {
    operation: "Preview GitHub pull request comment",
    affectedPaths: [{
      source: "12",
      target: "https://github.com/acme/repo.git",
      action: "comment_pr",
    }],
    riskSummary: "Preview only. No remote write was executed.",
    reversible: false,
  };
  const bindingHash = createDryRunBindingHash(dryRun);
  return {
    approvalId: "approval-git-comment-pr",
    taskId: "task-git-comment-pr",
    toolName: "git.commentPullRequest",
    workspacePath: "E:/Javis",
    permissionLevel: "confirmed_write",
    previewHash: bindingHash,
    expiresAt: "2026-06-10T12:10:00.000Z",
    status: "pending",
    createdAt: "2026-06-10T12:00:00.000Z",
    permissionRequest: {
      id: "approval-git-comment-pr",
      level: "confirmed_write",
      title: "Approve Git pull request comment",
      reason: "Posting a pull request comment sends text to the configured GitHub remote.",
      bindingHash,
      status: "pending",
      createdAt: "2026-06-10T12:00:00.000Z",
      dryRun,
    },
    gitCommentPullRequestPlan: {
      approvalId: "approval-git-comment-pr",
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

function createCodeProposedEdit() {
  return {
    proposalId: "proposal-1",
    workspacePath: "E:/Javis",
    summary: "Tighten completion message.",
    changedFiles: ["packages/core/src/index.ts"],
    patch: "diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts\n",
    patchHash: "fnv1a-test",
  };
}

function createMemoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
