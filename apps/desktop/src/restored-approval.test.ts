import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
import { invoke } from "@tauri-apps/api/core";
import { createDryRunBindingHash, createInitialTaskSnapshot } from "@javis/core";
import type { RuntimeEventEnvelope, WorkflowCheckpoint } from "@javis/core";
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
  createRestoredGitCommitApprovedTask,
  createRestoredGitCommentPullRequestApprovalTask,
  createRestoredGitCreatePullRequestApprovalTask,
  createRestoredGitCommitApprovalTask,
  createRestoredGitPushFailedTask,
  createRestoredGitPushApprovalTask,
  createRestoredGitStageApprovalTask,
  createRestoredGitStageDeniedTask,
  findRestorableApprovalRecord,
  getDurableApprovalToolName,
  getDurableApprovalWorkspacePath,
  isDurableApprovalRequestTitle,
  linkRestoredApprovalTaskToCheckpoint,
  reconcileRestoredApprovalTaskToCheckpoint,
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

  it("binds a generic Commander Git approval to its persisted plan workspace", () => {
    const gitCommitPlan = createGitCommitRecord().gitCommitPlan;
    const task = {
      ...createInitialTaskSnapshot(),
      durableApprovalPlan: {
        toolName: GIT_COMMIT_APPROVAL_TOOL_NAME,
        payload: gitCommitPlan,
      },
    };

    expect(getDurableApprovalWorkspacePath(task, GIT_COMMIT_APPROVAL_TITLE)).toBe("E:/Javis");
  });

  it("restores Git stage records with persisted stage plans", () => {
    const textRecord = createTextWriteRecord();
    const gitStageRecord = createGitStageRecord();

    expect(findRestorableApprovalRecord([textRecord, gitStageRecord])).toBe(gitStageRecord);
    const restoredTask = createRestoredGitStageApprovalTask(gitStageRecord);
    expect(restoredTask.permissionRequest?.title).toBe(GIT_STAGE_APPROVAL_TITLE);
    expect(restoredTask.verificationSummary).toContain("1 selected file(s) ready to stage");
  });

  it("records approval outcomes on restored approval final tasks", () => {
    const deniedTask = createRestoredGitStageDeniedTask(createGitStageRecord());
    const approvedTask = createRestoredGitCommitApprovedTask(createGitCommitRecord(), {
      workspacePath: "E:/Javis",
      branch: "main",
      commitHash: "0123456789abcdef",
      subject: "Add review UI",
      fileCount: 1,
      committed: true,
      output: "Committed.",
    });

    expect(deniedTask.approvalOutcome).toMatchObject({
      approvalId: "git-stage-approval",
      status: "denied",
    });
    expect(approvedTask.approvalOutcome).toMatchObject({
      approvalId: "git-commit-approval",
      status: "approved",
    });
  });

  it("records verifier results on restored approval failure tasks", () => {
    const failedTask = createRestoredGitPushFailedTask(
      createGitPushRecord(),
      new Error("remote rejected"),
    );

    expect(failedTask.verificationSummary).toContain("failed: restored Git push failed");
    expect(failedTask.verificationResult).toMatchObject({
      status: "fail",
      summary: expect.stringContaining("remote rejected"),
    });
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

describe("restored approval checkpoint linking", () => {
  it("links a restored approval to a checkpoint that names its approval request", () => {
    const record = createGitCommitRecord();
    const task = createRestoredGitCommitApprovalTask(record);
    const checkpoint = createCheckpoint(record, {
      approvalRequestIds: [record.approvalId],
      completedStepIds: ["inspect", "plan"],
      pendingStepIds: ["execute"],
      eventSequence: 7,
    });

    const linked = linkRestoredApprovalTaskToCheckpoint(task, checkpoint, [
      ...createRuntimeEventPrefix(record, checkpoint.runId, 4),
      createRuntimeEvent(record, checkpoint.runId, 5, {
        kind: "step.completed",
        stepId: "inspect",
      }),
      createRuntimeEvent(record, checkpoint.runId, 6, {
        kind: "step.completed",
        stepId: "plan",
      }),
      createRuntimeEvent(record, checkpoint.runId, 7, {
        kind: "permission.requested",
        request: record.permissionRequest,
      }),
    ]);

    expect(linked.logs[linked.logs.length - 1]?.title).toBe("workflow.checkpoint.linked");
    expect(linked.verificationSummary).toContain("durable run run-git-commit-approval");
    expect(linked.verificationSummary).toContain("2 step(s) completed");
  });

  it("links a restored approval when the event log contains the permission request", () => {
    const record = createGitStageRecord();
    const task = createRestoredGitStageApprovalTask(record);
    const checkpoint = createCheckpoint(record, {
      approvalRequestIds: [],
      eventSequence: 5,
    });
    const events = [
      ...createRuntimeEventPrefix(record, checkpoint.runId, 4),
      createRuntimeEvent(record, checkpoint.runId, 5, {
        kind: "permission.requested",
        request: record.permissionRequest,
      }),
    ];

    const linked = linkRestoredApprovalTaskToCheckpoint(task, checkpoint, events);

    expect(linked.logs[linked.logs.length - 1]?.title).toBe("workflow.checkpoint.linked");
  });

  it("links a restored approval when permission evidence uses a flat approvalId", () => {
    const record = createGitStageRecord();
    const task = createRestoredGitStageApprovalTask(record);
    const checkpoint = createCheckpoint(record, {
      approvalRequestIds: [],
      eventSequence: 5,
    });
    const events = [
      ...createRuntimeEventPrefix(record, checkpoint.runId, 4),
      createRuntimeEvent(record, checkpoint.runId, 5, {
        kind: "permission.requested",
        approvalId: record.approvalId,
      }),
    ];

    const linked = linkRestoredApprovalTaskToCheckpoint(task, checkpoint, events);

    expect(linked.logs[linked.logs.length - 1]?.title).toBe("workflow.checkpoint.linked");
  });

  it("does not link when event evidence conflicts with the checkpoint run", () => {
    const record = createGitPushRecord();
    const task = createRestoredGitPushApprovalTask(record);
    const checkpoint = createCheckpoint(record, {
      approvalRequestIds: [record.approvalId],
      eventSequence: 5,
    });
    const events = [
      createRuntimeEvent(record, "run-other", 5, {
        kind: "permission.requested",
        request: record.permissionRequest,
      }),
    ];

    const result = reconcileRestoredApprovalTaskToCheckpoint(task, checkpoint, events);
    const linked = linkRestoredApprovalTaskToCheckpoint(task, checkpoint, events);

    expect(result.status).toBe("blocked");
    expect(linked.logs[linked.logs.length - 1]?.title).toBe("workflow.checkpoint.reconciliation_blocked");
  });

  it("does not link when event replay does not cover the checkpoint sequence", () => {
    const record = createGitCreatePullRequestRecord();
    const task = createRestoredGitCreatePullRequestApprovalTask(record);
    const checkpoint = createCheckpoint(record, {
      approvalRequestIds: [record.approvalId],
      eventSequence: 9,
    });
    const events = [
      createRuntimeEvent(record, checkpoint.runId, 8, {
        kind: "permission.requested",
        request: record.permissionRequest,
      }),
    ];

    const result = reconcileRestoredApprovalTaskToCheckpoint(task, checkpoint, events);
    const linked = linkRestoredApprovalTaskToCheckpoint(task, checkpoint, events);

    expect(result.status).toBe("blocked");
    expect(linked.logs[linked.logs.length - 1]?.title).toBe("workflow.checkpoint.reconciliation_blocked");
  });

  it("links a running write step only when the log proves it is waiting on this approval", () => {
    const record = createGitStageRecord();
    const task = createRestoredGitStageApprovalTask(record);
    const checkpoint = createCheckpoint(record, {
      approvalRequestIds: [record.approvalId],
      completedStepIds: ["inspect", "plan"],
      pendingStepIds: [],
      runningStepIds: ["execute"],
      eventSequence: 5,
    });
    const events = [
      createRuntimeEvent(record, checkpoint.runId, 1, { kind: "step.started", stepId: "inspect" }),
      createRuntimeEvent(record, checkpoint.runId, 2, { kind: "step.completed", stepId: "inspect" }),
      createRuntimeEvent(record, checkpoint.runId, 3, { kind: "step.completed", stepId: "plan" }),
      createRuntimeEvent(record, checkpoint.runId, 4, { kind: "step.started", stepId: "execute" }),
      createRuntimeEvent(record, checkpoint.runId, 5, {
        kind: "permission.requested",
        request: record.permissionRequest,
      }),
    ];

    const result = reconcileRestoredApprovalTaskToCheckpoint(task, checkpoint, events);

    expect(result.status).toBe("linked");
    expect(result.linkedTask.logs[result.linkedTask.logs.length - 1]?.title)
      .toBe("workflow.checkpoint.linked");
    expect(result.linkedTask.verificationSummary).toContain("1 step(s) resumable after approval");
  });

  it("does not relink when durable events show that the approval was already resolved", () => {
    const record = createGitStageRecord();
    const task = createRestoredGitStageApprovalTask(record);
    const checkpoint = createCheckpoint(record, {
      approvalRequestIds: [record.approvalId],
      completedStepIds: ["inspect", "plan"],
      pendingStepIds: [],
      runningStepIds: ["execute"],
      eventSequence: 5,
    });
    const events = [
      createRuntimeEvent(record, checkpoint.runId, 1, { kind: "step.started", stepId: "inspect" }),
      createRuntimeEvent(record, checkpoint.runId, 2, { kind: "step.completed", stepId: "inspect" }),
      createRuntimeEvent(record, checkpoint.runId, 3, { kind: "step.completed", stepId: "plan" }),
      createRuntimeEvent(record, checkpoint.runId, 4, { kind: "step.started", stepId: "execute" }),
      createRuntimeEvent(record, checkpoint.runId, 5, {
        kind: "permission.requested",
        request: record.permissionRequest,
      }),
      createRuntimeEvent(record, checkpoint.runId, 6, {
        kind: "permission.resolved",
        requestId: record.approvalId,
        decision: "approved",
      }),
    ];

    const result = reconcileRestoredApprovalTaskToCheckpoint(task, checkpoint, events);

    expect(result.status).toBe("blocked");
    expect(result.linkedTask.logs[result.linkedTask.logs.length - 1]?.title)
      .toBe("workflow.approval.already_resolved");
  });

  it("surfaces blocked reconciliation for crash-after-confirmed-write checkpoints", () => {
    const record = createGitStageRecord();
    const task = createRestoredGitStageApprovalTask(record);
    const checkpoint = createCheckpoint(record, {
      approvalRequestIds: [record.approvalId],
      completedStepIds: ["inspect", "plan"],
      pendingStepIds: [],
      runningStepIds: ["execute"],
      eventSequence: 4,
    });
    const events = [
      createRuntimeEvent(record, checkpoint.runId, 1, { kind: "step.started", stepId: "inspect" }),
      createRuntimeEvent(record, checkpoint.runId, 2, { kind: "step.completed", stepId: "inspect" }),
      createRuntimeEvent(record, checkpoint.runId, 3, { kind: "step.completed", stepId: "plan" }),
      createRuntimeEvent(record, checkpoint.runId, 4, { kind: "step.started", stepId: "execute" }),
    ];

    const result = reconcileRestoredApprovalTaskToCheckpoint(task, checkpoint, events);

    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("step, tool, and preview bindings");
    expect(result.linkedTask.logs[result.linkedTask.logs.length - 1]?.title)
      .toBe("workflow.approval.binding_mismatch");
    expect(result.linkedTask.verificationSummary).toContain("blocked: Approval git-stage-approval does not have matching step, tool, and preview bindings");
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

function createCheckpoint(
  record: DurableApprovalRecord,
  overrides: Partial<WorkflowCheckpoint> = {},
): WorkflowCheckpoint {
  return {
    taskId: record.taskId,
    runId: `run-${record.approvalId}`,
    workflowId: "commander-dag",
    workflowVersion: 1,
    planHash: "plan-test",
    workflowSnapshot: {
      id: "read-current-project",
      title: "Commander DAG",
      triggerExamples: [],
      goal: "test workflow",
      coordinatorAgentKind: "commander",
      participatingAgentKinds: ["commander", "file", "code"],
      currentSupport: "partial",
      safetyNotes: [],
      steps: [
        {
          id: "inspect",
          title: "Inspect",
          agentKind: "file",
          input: "workspace",
          output: "files",
          permissionLevel: "read",
          dependsOn: [],
          canRunInParallel: false,
        },
        {
          id: "plan",
          title: "Plan",
          agentKind: "commander",
          input: "files",
          output: "plan",
          permissionLevel: "read",
          dependsOn: ["inspect"],
          canRunInParallel: false,
        },
        ({
          id: "execute",
          title: "Execute",
          agentKind: "code",
          input: "plan",
          output: "result",
          permissionLevel: "confirmed_write",
          dependsOn: ["plan"],
          canRunInParallel: false,
          toolName: record.toolName,
        } as WorkflowCheckpoint["workflowSnapshot"]["steps"][number] & { toolName: string }),
      ],
    },
    completedStepIds: [],
    abandonedStepIds: [],
    pendingStepIds: ["inspect", "plan", "execute"],
    runningStepIds: [],
    contextSnapshot: {},
    approvalRequestIds: [],
    waitingReason: "human_approval",
    eventSequence: 1,
    createdAt: "2026-05-24T00:05:00.000Z",
    ...overrides,
  };
}

function createRuntimeEvent(
  record: DurableApprovalRecord,
  runId: string,
  sequence: number,
  payload: unknown,
): RuntimeEventEnvelope {
  const payloadRecord = typeof payload === "object" && payload !== null
    ? payload as Record<string, unknown>
    : undefined;
  const isPermissionEvent = payloadRecord?.kind === "permission.requested" ||
    payloadRecord?.kind === "permission.resolved";
  const permissionStepId = isPermissionEvent
    ? typeof payloadRecord.stepId === "string" ? payloadRecord.stepId : "execute"
    : undefined;
  return {
    eventId: `evt-${runId}-${sequence}`,
    eventVersion: 1,
    sequence,
    taskId: record.taskId,
    runId,
    workflowId: "commander-dag",
    ...(permissionStepId ? { stepId: permissionStepId } : {}),
    correlationId: `corr-${runId}`,
    occurredAt: "2026-05-24T00:05:00.000Z",
    recordedAt: "2026-05-24T00:05:00.001Z",
    payload: isPermissionEvent
      ? {
          stepId: permissionStepId,
          toolName: record.toolName,
          previewHash: record.previewHash,
          ...payloadRecord,
        }
      : payload,
  };
}

function createRuntimeEventPrefix(
  record: DurableApprovalRecord,
  runId: string,
  count: number,
): RuntimeEventEnvelope[] {
  return Array.from({ length: count }, (_, index) => createRuntimeEvent(
    record,
    runId,
    index + 1,
    { kind: "agent.status", agentKind: "commander", status: "queued" },
  ));
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
