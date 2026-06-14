import { describe, expect, it } from "vitest";
import {
  TASK_HISTORY_LIMIT,
  TASK_HISTORY_SCHEMA_MIGRATIONS,
  TASK_HISTORY_SCHEMA_MIGRATION,
  TASK_HISTORY_SCHEMA_SQL,
  TASK_HISTORY_STORAGE_KEY,
  TASK_HISTORY_STORAGE_VERSION,
  TASK_HISTORY_UPDATED_AT_INDEX_MIGRATION,
  TASK_HISTORY_UPDATED_AT_INDEX_SQL,
  createTaskHistoryRepository,
  getTaskWorkspacePath,
  getTaskUpdatedAt,
  loadTaskHistory,
  loadTaskHistoryWithStorageFallback,
  saveTaskHistory,
  sanitizeTaskSnapshot,
  upsertTaskHistory,
} from "./task-history";
import type { TaskSnapshot } from "@javis/core";
import type { DatabaseValue, DesktopDatabase } from "./desktop-database";

describe("task history persistence", () => {
  it("keeps resolved permission decisions in completed task history", () => {
    const storage = createMemoryStorage();
    const task = {
      ...createTask("task-1000"),
      permissionRequest: {
        id: "permission-1",
        level: "confirmed_write",
        writeRiskLevel: "dangerous",
        title: "Approve write",
        reason: "Write requires approval.",
        screenshotDataUrl: "data:image/png;base64,PREVIEW_SHOULD_NOT_SURVIVE==",
        status: "approved",
        createdAt: "2026-05-23T00:00:00.000Z",
        resolvedAt: "2026-05-23T00:00:01.000Z",
        bindingHash: "dryrun-fnv1a-test",
        dryRun: {
          operation: "Move files",
          affectedPaths: [],
          riskSummary: "Risk",
          reversible: true,
        },
      },
    } satisfies TaskSnapshot;

    const saved = saveTaskHistory(storage, [task]);
    const loaded = loadTaskHistory(storage);

    expect(saved).toHaveLength(1);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.permissionRequest?.id).toBe("permission-1");
    expect(loaded[0]?.permissionRequest?.status).toBe("approved");
    expect(loaded[0]?.permissionRequest?.writeRiskLevel).toBe("dangerous");
    expect(loaded[0]?.permissionRequest?.screenshotDataUrl).toBeUndefined();
    expect(loaded[0]?.permissionRequest?.bindingHash).toBe("dryrun-fnv1a-test");
    expect(storage.getItem(TASK_HISTORY_STORAGE_KEY)).toContain("permission-1");
    expect(storage.getItem(TASK_HISTORY_STORAGE_KEY)).not.toContain("data:image");
  });

  it("keeps resolved Git and PR dry-run actions in completed task history", () => {
    const storage = createMemoryStorage();
    const task = {
      ...createTask("task-git-actions"),
      permissionRequest: {
        id: "permission-git",
        level: "confirmed_write",
        title: "Approve Git write",
        reason: "Git write requires approval.",
        status: "approved",
        createdAt: "2026-06-11T00:00:00.000Z",
        bindingHash: "dryrun-fnv1a-git",
        dryRun: {
          operation: "Git remote workflow",
          affectedPaths: [
            { source: "README.md", target: "index", action: "stage" },
            { source: "refs/heads/main", target: "origin/main", action: "push" },
            { source: "origin/main", target: "pull-request", action: "create_pr" },
            { source: "pull-request", target: "comment", action: "comment_pr" },
          ],
          riskSummary: "Remote Git writes.",
          reversible: false,
        },
      },
    } satisfies TaskSnapshot;

    saveTaskHistory(storage, [task]);
    const actions = loadTaskHistory(storage)[0]?.permissionRequest?.dryRun.affectedPaths.map(
      (path) => path.action,
    );

    expect(actions).toEqual(["stage", "push", "create_pr", "comment_pr"]);
  });

  it("strips pending permission requests from task history", () => {
    const storage = createMemoryStorage();
    const task = {
      ...createTask("task-1000"),
      permissionRequest: {
        id: "permission-pending",
        level: "confirmed_write",
        title: "Approve write",
        reason: "Write requires approval.",
        status: "pending",
        createdAt: "2026-05-23T00:00:00.000Z",
        dryRun: {
          operation: "Move files",
          affectedPaths: [],
          riskSummary: "Risk",
          reversible: true,
        },
      },
    } satisfies TaskSnapshot;

    saveTaskHistory(storage, [task]);
    const loaded = loadTaskHistory(storage);

    expect(loaded[0]?.permissionRequest).toBeUndefined();
    expect(storage.getItem(TASK_HISTORY_STORAGE_KEY)).not.toContain("permission-pending");
  });

  it("keeps optional resolved permission fields absent after repeated sanitization", () => {
    const task = {
      ...createTask("task-1000"),
      permissionRequest: {
        id: "permission-optional",
        level: "confirmed_write",
        title: "Approve write",
        reason: "Write requires approval.",
        status: "approved",
        createdAt: "2026-05-23T00:00:00.000Z",
        dryRun: {
          operation: "Move files",
          affectedPaths: [],
          riskSummary: "Risk",
          reversible: true,
        },
      },
    } satisfies TaskSnapshot;

    const sanitized = sanitizeTaskSnapshot(task);
    expect(sanitized?.permissionRequest?.id).toBe("permission-optional");
    expect(Object.prototype.hasOwnProperty.call(sanitized?.permissionRequest ?? {}, "bindingHash")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(sanitized?.permissionRequest ?? {}, "allowAlways")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(sanitized?.permissionRequest ?? {}, "resolvedAt")).toBe(false);

    const sanitizedAgain = sanitizeTaskSnapshot(sanitized);
    expect(sanitizedAgain?.permissionRequest?.id).toBe("permission-optional");
  });

  it("rejects malformed localStorage snapshots", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      TASK_HISTORY_STORAGE_KEY,
      JSON.stringify([
        createTask("task-1000"),
        {
          ...createTask("task-2000"),
          permissionRequest: { dryRun: null },
          sources: [{ url: "https://example.test", excerpt: 42 }],
        },
        { id: "task-bad", title: "Bad" },
      ]),
    );

    const loaded = loadTaskHistory(storage);

    expect(loaded).toHaveLength(2);
    expect(loaded[0]?.permissionRequest).toBeUndefined();
    expect(loaded[1]?.sources).toBeUndefined();
  });

  it("loads versioned task history storage envelopes", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      TASK_HISTORY_STORAGE_KEY,
      JSON.stringify({
        version: TASK_HISTORY_STORAGE_VERSION,
        tasks: [createTask("task-1000")],
      }),
    );

    const loaded = loadTaskHistory(storage);

    expect(loaded.map((task) => task.id)).toEqual(["task-1000"]);
  });

  it("derives readable titles from Chinese answered chat history on load", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      TASK_HISTORY_STORAGE_KEY,
      JSON.stringify([
        {
          ...createTask("task-1000"),
          title: "已回答",
          userGoal: "帮我解释这个使用按钮是不是没用",
          conversationMessages: [
            { role: "user", content: "帮我解释这个使用按钮是不是没用" },
            { role: "assistant", content: "它会应用当前工作区路径。" },
          ],
        },
      ]),
    );

    const loaded = loadTaskHistory(storage);

    expect(loaded[0]?.title).toBe("帮我解释这个使用按钮是不是没用");
  });

  it("ignores task history storage envelopes from unknown versions", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      TASK_HISTORY_STORAGE_KEY,
      JSON.stringify({
        version: TASK_HISTORY_STORAGE_VERSION + 1,
        tasks: [createTask("task-1000")],
      }),
    );

    expect(loadTaskHistory(storage)).toEqual([]);
  });

  it("rejects snapshots with unknown persisted state values", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      TASK_HISTORY_STORAGE_KEY,
      JSON.stringify([
        createTask("task-1000"),
        {
          ...createTask("task-2000"),
          plan: [
            {
              id: "step-1",
              title: "Inspect project",
              assignedAgentKind: "shell",
              status: "mystery",
            },
          ],
        },
        {
          ...createTask("task-3000"),
          agents: [
            {
              id: "agent-shell",
              name: "Shell Agent",
              role: "Read-only command execution",
              status: "paused",
              task: "Task finished",
            },
          ],
        },
        {
          ...createTask("task-4000"),
          logs: [
            {
              id: "task-4000-done",
              kind: "debug",
              title: "task.completed",
              detail: "Verified.",
            },
          ],
        },
        {
          ...createTask("task-5000"),
          permissionRequest: {
            id: "permission-1",
            level: "confirmed_write",
            title: "Approve write",
            reason: "Write requires approval.",
            status: "approved",
            createdAt: "2026-05-23T00:00:00.000Z",
            dryRun: {
              operation: "Move files",
              affectedPaths: [
                {
                  source: "a.pdf",
                  target: "b.pdf",
                  action: "archive",
                },
              ],
              riskSummary: "Risk",
              reversible: true,
            },
          },
        },
      ]),
    );

    const loaded = loadTaskHistory(storage);

    expect(loaded.map((task) => task.id)).toEqual(["task-1000", "task-5000"]);
    expect(loaded[1]?.permissionRequest).toBeUndefined();
  });

  it("keeps only archivable tasks and enforces the history limit", () => {
    const manyTasks = Array.from({ length: TASK_HISTORY_LIMIT + 3 }, (_, index) =>
      createTask(`task-${1000 + index}`),
    );
    const storage = createMemoryStorage();

    const saved = saveTaskHistory(storage, [
      createTask("task-running", "running"),
      ...manyTasks,
    ]);

    expect(saved).toHaveLength(TASK_HISTORY_LIMIT);
    expect(saved.every((task) => task.status === "completed")).toBe(true);
    expect(saved[0]?.id).toBe("task-1000");
  });

  it("upserts newest task snapshots at the front", () => {
    const first = createTask("task-1000");
    const updated = { ...first, title: "Updated task" };
    const second = createTask("task-2000");

    const history = upsertTaskHistory(upsertTaskHistory([first], second), updated);

    expect(history.map((task) => task.id)).toEqual(["task-1000", "task-2000"]);
    expect(history[0]?.title).toBe("Updated task");
  });

  it("keeps code review previews in completed task history", () => {
    const storage = createMemoryStorage();
    const task = {
      ...createTask("task-1000"),
      codeReviewPreview: {
        workspacePath: "E:/Javis",
        changedFiles: ["packages/core/src/index.ts"],
        diffStat: "1 file changed",
        diff: "diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts",
      },
    } satisfies TaskSnapshot;

    saveTaskHistory(storage, [task]);
    const loaded = loadTaskHistory(storage);

    expect(loaded[0]?.codeReviewPreview?.changedFiles).toEqual(["packages/core/src/index.ts"]);
    expect(loaded[0]?.codeReviewPreview?.diff).toContain("diff --git");
  });

  it("keeps scheduled task ids in completed task history", () => {
    const storage = createMemoryStorage();
    const task = {
      ...createTask("task-1000"),
      scheduledTaskId: "st-1000",
    } satisfies TaskSnapshot;

    saveTaskHistory(storage, [task]);
    const loaded = loadTaskHistory(storage);

    expect(loaded[0]?.scheduledTaskId).toBe("st-1000");
    expect(storage.getItem(TASK_HISTORY_STORAGE_KEY)).toContain("st-1000");
  });

  it("keeps structured ask-user choices in completed task history", () => {
    const storage = createMemoryStorage();
    const task = {
      ...createTask("task-1000"),
      askUserQuestion: {
        id: "ask-1",
        question: "Which scope?",
        choices: [
          { label: "Current project", value: "current", isRecommended: true },
          "All workspaces",
        ],
        status: "answered",
        createdAt: "2026-06-07T00:00:00.000Z",
        resolvedAt: "2026-06-07T00:00:01.000Z",
        answer: "current",
      },
    } satisfies TaskSnapshot;

    saveTaskHistory(storage, [task]);
    const loaded = loadTaskHistory(storage);

    expect(loaded[0]?.askUserQuestion?.choices).toEqual([
      { label: "Current project", value: "current", isRecommended: true },
      "All workspaces",
    ]);
  });

  it("keeps structured conversation timeline messages in task history", () => {
    const storage = createMemoryStorage();
    const task = {
      ...createTask("task-1000"),
      conversationMessages: [
        { id: "m1", kind: "user_text", role: "user", content: "Start", createdAt: "2026-06-07T00:00:00.000Z" },
        {
          id: "ask-1",
          kind: "ask_user_question",
          role: "assistant",
          content: "Which scope?",
          createdAt: "2026-06-07T00:00:01.000Z",
          askUserQuestion: {
            id: "ask-1",
            question: "Which scope?",
            status: "pending",
            createdAt: "2026-06-07T00:00:01.000Z",
            choices: [{ label: "Current project", value: "current", isRecommended: true }],
          },
        },
      ],
    } satisfies TaskSnapshot;

    saveTaskHistory(storage, [task]);
    const loaded = loadTaskHistory(storage);

    expect(loaded[0]?.conversationMessages?.[1]).toMatchObject({
      id: "ask-1",
      kind: "ask_user_question",
      askUserQuestion: {
        question: "Which scope?",
        choices: [{ label: "Current project", value: "current", isRecommended: true }],
      },
    });
  });

  it("keeps handoff reports and step context keys in completed task history", () => {
    const storage = createMemoryStorage();
    const task = {
      ...createTask("task-handoff-report"),
      plan: [{
        id: "review-evidence",
        title: "Review evidence",
        assignedAgentKind: "verifier",
        agentId: "agent-verifier",
        status: "completed",
        inputContextKeys: ["repoEvidence"],
        outputContextKey: "reviewFindings",
        successCriteria: "Review findings name the handoff artifact.",
      }],
      handoffReport: {
        generatedAt: "2026-06-11T00:00:00.000Z",
        status: "needs_attention",
        missingInputContextKeys: [],
        invalidInputContextKeys: [],
        unconsumedOutputContextKeys: ["reviewFindings"],
        steps: [{
          stepId: "review-evidence",
          title: "Review evidence",
          assignedAgentKind: "verifier",
          dependsOn: ["collect-evidence"],
          inputContextKeys: ["repoEvidence"],
          outputContextKey: "reviewFindings",
          missingInputContextKeys: [],
          invalidInputContextKeys: [],
          successCriteria: "Review findings name the handoff artifact.",
        }],
        handoffs: [{
          contextKey: "reviewFindings",
          producedByStepId: "review-evidence",
          consumedByStepIds: [],
          status: "unconsumed",
          valueSummary: { type: "array", present: true, itemCount: 2 },
        }],
      },
    } satisfies TaskSnapshot;

    saveTaskHistory(storage, [task]);
    const loaded = loadTaskHistory(storage);

    expect(loaded[0]?.plan[0]?.inputContextKeys).toEqual(["repoEvidence"]);
    expect(loaded[0]?.plan[0]?.outputContextKey).toBe("reviewFindings");
    expect(loaded[0]?.handoffReport).toMatchObject({
      status: "needs_attention",
      unconsumedOutputContextKeys: ["reviewFindings"],
    });
    expect(loaded[0]?.handoffReport?.handoffs[0]).toMatchObject({
      contextKey: "reviewFindings",
      producedByStepId: "review-evidence",
      status: "unconsumed",
      valueSummary: { type: "array", itemCount: 2 },
    });
  });

  it("drops malformed handoff reports during task history sanitization", () => {
    const sanitized = sanitizeTaskSnapshot({
      ...createTask("task-bad-handoff"),
      handoffReport: {
        generatedAt: "2026-06-11T00:00:00.000Z",
        status: "done",
        steps: [],
        handoffs: [],
        missingInputContextKeys: [],
        invalidInputContextKeys: [],
        unconsumedOutputContextKeys: [],
      },
    });

    expect(sanitized?.handoffReport).toBeUndefined();
  });

  it("keeps recovery reports in completed task history", () => {
    const storage = createMemoryStorage();
    const task = {
      ...createTask("task-recovery-report"),
      recoveryReport: {
        generatedAt: "2026-06-11T00:00:00.000Z",
        status: "recovered",
        failureCount: 1,
        recoveredCount: 1,
        unrecoveredCount: 0,
        abandonedStepIds: ["collect-evidence"],
        replannedStepIds: ["recover-with-partial-evidence"],
        attempts: [{
          failedStepId: "collect-evidence",
          failedStepTitle: "Collect evidence",
          agentKind: "code",
          errorSummary: "HTTP 503 from repository search provider",
          failureKind: "network",
          completedBefore: ["parse-request"],
          replanAttempted: true,
          replanStatus: "planned",
          abandonedFailedStep: true,
          recoveryStepIds: ["recover-with-partial-evidence"],
          suggestedAlternatives: ["retry with a fallback provider"],
          detail: "Commander produced 1 recovery step.",
        }],
      },
    } satisfies TaskSnapshot;

    saveTaskHistory(storage, [task]);
    const loaded = loadTaskHistory(storage);

    expect(loaded[0]?.recoveryReport).toMatchObject({
      status: "recovered",
      abandonedStepIds: ["collect-evidence"],
      replannedStepIds: ["recover-with-partial-evidence"],
    });
    expect(loaded[0]?.recoveryReport?.attempts[0]).toMatchObject({
      failedStepId: "collect-evidence",
      failureKind: "network",
      replanStatus: "planned",
      recoveryStepIds: ["recover-with-partial-evidence"],
    });
  });

  it("drops malformed recovery reports during task history sanitization", () => {
    const sanitized = sanitizeTaskSnapshot({
      ...createTask("task-bad-recovery"),
      recoveryReport: {
        generatedAt: "2026-06-11T00:00:00.000Z",
        status: "done",
        failureCount: 1,
        recoveredCount: 1,
        unrecoveredCount: 0,
        abandonedStepIds: [],
        replannedStepIds: [],
        attempts: [],
      },
    });

    expect(sanitized?.recoveryReport).toBeUndefined();
  });

  it("restores structured conversation messages after repository restart", async () => {
    const database = createMemoryTaskHistoryDatabase();
    const firstRepository = createTaskHistoryRepository(database);
    const task = {
      ...createTask("task-1000"),
      title: "Task completed",
      conversationMessages: [
        { id: "m1", kind: "user_text", role: "user", content: "Inspect the current project", createdAt: "2026-06-07T00:00:00.000Z" },
        { id: "m2", kind: "assistant_text", role: "assistant", content: "Done.", createdAt: "2026-06-07T00:00:01.000Z" },
      ],
    } satisfies TaskSnapshot;

    await firstRepository.upsert(task);
    const restartedRepository = createTaskHistoryRepository(database);
    const restored = await restartedRepository.list();

    expect(restored[0]?.title).toBe("Inspect the current project");
    expect(restored[0]?.conversationMessages).toEqual(task.conversationMessages);
  });

  it("derives generic history titles from the first user message", () => {
    const task = {
      ...createTask("task-1000"),
      title: "Task completed",
      conversationMessages: [
        { role: "user", content: "Summarize the release plan and risks for the current workspace." },
        { role: "assistant", content: "Done." },
      ],
    } satisfies TaskSnapshot;

    const [saved] = upsertTaskHistory([], task);

    expect(saved?.title).toBe("Summarize the release plan and...");
  });

  it("refreshes low-information chat titles from the latest substantive user message", () => {
    const task = {
      ...createTask("task-1000"),
      title: "你好",
      userGoal: "你好",
      conversationMessages: [
        { role: "user", content: "你好" },
        { role: "assistant", content: "你好，有什么可以帮你？" },
        { role: "user", content: "我想做一个读取本地 wallpaper 下载的视频壁纸播放器" },
        { role: "assistant", content: "我来帮你规划。" },
      ],
    } satisfies TaskSnapshot;

    const [saved] = upsertTaskHistory([], task);

    expect(saved?.title).toBe("我想做一个读取本地 wallpaper 下载的视频壁纸播放器");
  });

  it("keeps Code Agent proposal and apply results in completed task history", () => {
    const storage = createMemoryStorage();
    const task = {
      ...createTask("task-1000"),
      codeProposedEdit: {
        proposalId: "proposal-1",
        workspacePath: "E:/Javis",
        summary: "Tighten the code review completion message.",
        changedFiles: ["packages/core/src/index.ts"],
        patch: "diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts",
        patchHash: "fnv1a-19fcfa54",
      },
      codeApplyResult: {
        applied: true,
        workspacePath: "E:/Javis",
        changedFiles: ["packages/core/src/index.ts"],
        message: "Applied patch in test.",
      },
    } satisfies TaskSnapshot;

    saveTaskHistory(storage, [task]);
    const loaded = loadTaskHistory(storage);

    expect(loaded[0]?.codeProposedEdit?.summary).toContain("Tighten");
    expect(loaded[0]?.codeProposedEdit?.patch).toBe("");
    expect(storage.getItem(TASK_HISTORY_STORAGE_KEY)).not.toContain("diff --git");
    expect(loaded[0]?.codeApplyResult?.applied).toBe(true);
  });

  it("keeps token usage summaries in completed task history", () => {
    const storage = createMemoryStorage();
    const task = {
      ...createTask("task-1000"),
      tokenUsage: {
        inputTokens: 1200,
        outputTokens: 340,
        totalTokens: 1540,
        modelCalls: 1,
        byAgentKind: [
          {
            agentKind: "code",
            inputTokens: 1200,
            outputTokens: 340,
            totalTokens: 1540,
            modelCalls: 1,
          },
        ],
      },
    } satisfies TaskSnapshot;

    saveTaskHistory(storage, [task]);
    const loaded = loadTaskHistory(storage);

    expect(loaded[0]?.tokenUsage?.totalTokens).toBe(1540);
    expect(loaded[0]?.tokenUsage?.byAgentKind[0]?.agentKind).toBe("code");
  });

  it("returns stable timestamps from task ids when available", () => {
    expect(getTaskUpdatedAt(createTask("task-1000"))).toBe("1970-01-01T00:00:01.000Z");
  });

  it("keeps project entry metadata in completed task history", () => {
    const storage = createMemoryStorage();
    const task = {
      ...createTask("task-1000"),
      originMode: "project",
      workspacePath: "E:/Javis",
    } satisfies TaskSnapshot;

    saveTaskHistory(storage, [task]);
    const loaded = loadTaskHistory(storage);

    expect(loaded[0]?.originMode).toBe("project");
    expect(loaded[0]?.workspacePath).toBe("E:/Javis");
  });

  it("derives workspace paths from older project history entries", () => {
    const task = {
      ...createTask("task-1000"),
      project: {
        workspacePath: "E:/Javis",
        packageManager: "pnpm",
        scripts: [],
      },
    } satisfies TaskSnapshot;

    expect(getTaskWorkspacePath(task)).toBe("E:/Javis");
  });

  it("ignores empty task workspace metadata when deriving workspace paths", () => {
    const task = {
      ...createTask("task-1000"),
      workspacePath: "",
      codeReviewPreview: {
        workspacePath: "E:/Javis",
        changedFiles: [],
        diffStat: "0 files changed",
        diff: "",
      },
    } satisfies TaskSnapshot;

    expect(getTaskWorkspacePath(task)).toBe("E:/Javis");
  });

  it("drops optional sections with invalid shapes during sanitization", () => {
    const sanitized = sanitizeTaskSnapshot({
      ...createTask("task-1000"),
      project: { workspacePath: "E:/Javis", scripts: [{ name: "test" }] },
      tokenUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    });

    expect(sanitized).not.toBeNull();
    expect(sanitized?.project).toBeUndefined();
    expect(sanitized?.tokenUsage).toBeUndefined();
  });

  it("exposes SQLite-ready task history schema migration SQL", () => {
    expect(TASK_HISTORY_SCHEMA_MIGRATION).toEqual({
      id: "001_task_history",
      sql: TASK_HISTORY_SCHEMA_SQL,
    });
    expect(TASK_HISTORY_UPDATED_AT_INDEX_MIGRATION).toEqual({
      id: "002_task_history_updated_at_index",
      sql: TASK_HISTORY_UPDATED_AT_INDEX_SQL,
    });
    expect(TASK_HISTORY_SCHEMA_MIGRATIONS).toEqual([
      TASK_HISTORY_SCHEMA_MIGRATION,
      TASK_HISTORY_UPDATED_AT_INDEX_MIGRATION,
    ]);
    expect(TASK_HISTORY_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS task_history");
    expect(TASK_HISTORY_SCHEMA_SQL).toContain("snapshot_json TEXT NOT NULL");
    expect(TASK_HISTORY_UPDATED_AT_INDEX_SQL).toContain(
      "CREATE INDEX IF NOT EXISTS idx_task_history_updated_at",
    );
  });

  it("persists sanitized task history through the async repository", async () => {
    const database = createMemoryTaskHistoryDatabase();
    const repository = createTaskHistoryRepository(database);
    const task = {
      ...createTask("task-1000"),
      permissionRequest: {
        id: "permission-pending",
        level: "confirmed_write",
        title: "Approve write",
        reason: "Write requires approval.",
        status: "pending",
        createdAt: "2026-05-23T00:00:00.000Z",
        dryRun: {
          operation: "Move files",
          affectedPaths: [],
          riskSummary: "Risk",
          reversible: true,
        },
      },
      codeProposedEdit: {
        proposalId: "proposal-1",
        workspacePath: "E:/Javis",
        summary: "Tighten the code review completion message.",
        changedFiles: ["packages/core/src/index.ts"],
        patch: "diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts",
        patchHash: "fnv1a-19fcfa54",
      },
    } satisfies TaskSnapshot;

    const saved = await repository.save([task, createTask("task-running", "running")]);
    const loaded = await repository.list();

    expect(saved.map((entry) => entry.id)).toEqual(["task-1000"]);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.permissionRequest).toBeUndefined();
    expect(loaded[0]?.codeProposedEdit?.patch).toBe("");
    expect(database.rows[0]?.snapshot_json).not.toContain("permission-pending");
    expect(database.rows[0]?.snapshot_json).not.toContain("diff --git");
  });

  it("redacts image data URLs and strips attachments before repository persistence", async () => {
    const database = createMemoryTaskHistoryDatabase();
    const repository = createTaskHistoryRepository(database);
    const task = {
      ...createTask("task-1000"),
      userGoal: "Describe [image: data:image\\/png;base64,AA==]",
      commanderMessage: "Saw data:image/png;base64,BB==",
      logs: [
        {
          id: "log-1",
          kind: "event",
          title: "image.received",
          detail: "detail data:image/png;base64,CC==",
          userMessage: "user data:image/png;base64,DD==",
          devDetail: "dev data:image/png;base64,EE==",
        },
      ],
      conversationMessages: [
        {
          role: "user",
          content: "content data:image/png;base64,FF==",
          attachments: ["data:image/png;base64,GG=="],
        },
        {
          role: "assistant",
          content: "Done.",
        },
      ],
      commands: [{
        command: "echo image",
        cwd: "E:/Javis",
        stdout: "stdout data:image/png;base64,HH==",
        stderr: "",
        exitCode: 0,
      }],
      verificationSummary: "verified data:image/png;base64,II==",
      researchReport: {
        title: "Report data:image/png;base64,JJ==",
        summary: "summary data:image/png;base64,KK==",
        rows: [{
          claim: "claim data:image/png;base64,LL==",
          sourceUrl: "https://example.test",
          evidence: "evidence data:image/png;base64,MM==",
        }],
        unknowns: ["unknown data:image/png;base64,NN=="],
      },
    } satisfies TaskSnapshot;

    const taskWithImageKey = {
      ...task,
      extra: {
        "data:image\\/png;base64,KEY_SHOULD_NOT_SURVIVE==": "safe value",
      },
    } as unknown as TaskSnapshot;

    await repository.save([taskWithImageKey]);
    const loaded = await repository.list();

    expect(database.rows[0]?.user_goal).not.toContain("data:image");
    expect(database.rows[0]?.user_goal).not.toContain("data:image\\/");
    expect(database.rows[0]?.snapshot_json).not.toContain("data:image");
    expect(database.rows[0]?.snapshot_json).not.toContain("data:image\\/");
    expect(database.rows[0]?.snapshot_json).not.toContain("KEY_SHOULD_NOT_SURVIVE");
    expect(database.rows[0]?.snapshot_json).not.toContain("attachments");
    expect(loaded[0]?.userGoal).toContain("[redacted image data URL]");
    expect(loaded[0]?.conversationMessages?.[0]?.attachments).toBeUndefined();
    expect(loaded[0]?.logs[0]?.detail).toContain("[redacted image data URL]");
    expect(loaded[0]?.logs[0]?.userMessage).toContain("[redacted image data URL]");
    expect(loaded[0]?.logs[0]?.devDetail).toContain("[redacted image data URL]");
    expect(loaded[0]?.commands?.[0]?.stdout).toContain("[redacted image data URL]");
    expect(loaded[0]?.verificationSummary).toContain("[redacted image data URL]");
    expect(loaded[0]?.researchReport?.summary).toContain("[redacted image data URL]");
    expect(loaded[0]?.researchReport?.rows[0]?.evidence).toContain("[redacted image data URL]");
  });

  it("redacts local vision model and adapter paths before repository persistence", async () => {
    const database = createMemoryTaskHistoryDatabase();
    const repository = createTaskHistoryRepository(database);
    const task = {
      ...createTask("task-local-vision-paths"),
      logs: [
        {
          id: "log-local-vision",
          kind: "tool",
          title: "computer.detectUiObjects",
          detail: String.raw`modelPath=C:\Users\alice\Models\yolo26n-ui.onnx runtimeAdapterPath=models\adapters\yolo26-ui.mjs`,
          devDetail: "adapter /home/alice/.cache/javis/runtime-adapter.mjs failed; source packages/core/src/index.js stayed visible",
        },
      ],
      commands: [{
        command: String.raw`node scripts\local-vision-smoke.mjs --model C:\Users\alice\Models\yolo26n-ui.onnx`,
        cwd: "E:/Javis",
        stdout: "loaded models/yolo26n-ui.onnx",
        stderr: "adapter /home/alice/.cache/javis/runtime-adapter.mjs failed",
        exitCode: 2,
      }],
      conversationMessages: [
        {
          role: "assistant",
          content: "Checked models/adapters/yolo26-ui.mjs",
        },
      ],
    } satisfies TaskSnapshot;

    await repository.save([task]);
    const loaded = await repository.list();
    const persisted = database.rows[0]?.snapshot_json ?? "";

    expect(persisted).toContain("[redacted local path:yolo26n-ui.onnx]");
    expect(persisted).toContain("[redacted local path:yolo26-ui.mjs]");
    expect(persisted).toContain("[redacted local path:runtime-adapter.mjs]");
    expect(persisted).toContain("packages/core/src/index.js");
    expect(persisted).not.toContain("alice");
    expect(persisted).not.toContain("C:\\Users");
    expect(persisted).not.toContain("/home/alice");
    expect(persisted).not.toContain("models\\adapters");
    expect(loaded[0]?.logs[0]?.detail).toContain("[redacted local path:yolo26n-ui.onnx]");
    expect(loaded[0]?.logs[0]?.devDetail).toContain("[redacted local path:runtime-adapter.mjs]");
    expect(loaded[0]?.conversationMessages?.[0]?.content).toContain("[redacted local path:yolo26-ui.mjs]");
  });

  it("bounds oversized text before repository persistence", async () => {
    const database = createMemoryTaskHistoryDatabase();
    const repository = createTaskHistoryRepository(database);
    const hugeText = "x".repeat(60_000);
    const task = {
      ...createTask("task-oversized"),
      userGoal: `Inspect desktop ${hugeText}`,
      commanderMessage: hugeText,
      logs: [
        {
          id: "log-large",
          kind: "event",
          title: "computer.detectUiObjects",
          detail: hugeText,
          devDetail: `diagnostics ${hugeText}`,
        },
      ],
      commands: [{
        command: "pnpm test",
        cwd: "E:/Javis",
        stdout: hugeText,
        stderr: "",
        exitCode: 0,
      }],
      conversationMessages: [
        {
          role: "assistant",
          content: hugeText,
        },
      ],
    } satisfies TaskSnapshot;

    await repository.save([task]);
    const loaded = await repository.list();
    const persisted = database.rows[0]?.snapshot_json ?? "";

    expect(persisted).toContain("[truncated:");
    expect(persisted.length).toBeLessThan(140_000);
    expect(loaded[0]?.userGoal).toContain("[truncated:");
    expect(loaded[0]?.commanderMessage).toContain("[truncated:");
    expect(loaded[0]?.logs[0]?.detail).toContain("[truncated:");
    expect(loaded[0]?.commands?.[0]?.stdout).toContain("[truncated:");
    expect(loaded[0]?.conversationMessages?.[0]?.content).toContain("[truncated:");
  });

  it("upserts repository entries with newest snapshots first", async () => {
    const repository = createTaskHistoryRepository(createMemoryTaskHistoryDatabase());
    const first = createTask("task-1000");
    const second = createTask("task-2000");

    await repository.save([first]);
    const history = await repository.upsert(second);

    expect(history.map((task) => task.id)).toEqual(["task-2000", "task-1000"]);
  });

  it("imports sanitized legacy localStorage history into the repository", async () => {
    const storage = createMemoryStorage();
    const database = createMemoryTaskHistoryDatabase();
    const repository = createTaskHistoryRepository(database);
    storage.setItem(
      TASK_HISTORY_STORAGE_KEY,
      JSON.stringify({
        version: TASK_HISTORY_STORAGE_VERSION,
        tasks: [createTask("task-1000"), createTask("task-running", "running")],
      }),
    );

    const imported = await repository.importFromLocalStorage(storage);
    const loaded = await repository.list();

    expect(imported.map((task) => task.id)).toEqual(["task-1000"]);
    expect(loaded.map((task) => task.id)).toEqual(["task-1000"]);
    expect(storage.getItem(TASK_HISTORY_STORAGE_KEY)).toBeNull();
  });

  it("keeps existing repository history when localStorage import is empty", async () => {
    const repository = createTaskHistoryRepository(createMemoryTaskHistoryDatabase());
    await repository.save([createTask("task-1000")]);

    const imported = await repository.importFromLocalStorage(createMemoryStorage());

    expect(imported.map((task) => task.id)).toEqual(["task-1000"]);
  });

  it("falls back to localStorage when task history repository loading fails", async () => {
    const storage = createMemoryStorage();
    storage.setItem(TASK_HISTORY_STORAGE_KEY, JSON.stringify([createTask("task-1000")]));
    const failingRepository = {
      async list() {
        throw new Error("unavailable");
      },
    };
    const expectedTask = sanitizeTaskSnapshot(createTask("task-1000"));

    await expect(
      loadTaskHistoryWithStorageFallback(failingRepository, storage),
    ).resolves.toEqual(expectedTask ? [expectedTask] : []);
    await expect(
      loadTaskHistoryWithStorageFallback(null, storage),
    ).resolves.toEqual(expectedTask ? [expectedTask] : []);
  });
});

function createTask(
  id: string,
  status: TaskSnapshot["status"] = "completed",
): TaskSnapshot {
  return {
    id,
    title: "Project environment inspected",
    userGoal: "Inspect project",
    status,
    commanderMessage: "Task finished.",
    plan: [
      {
        id: "step-1",
        title: "Inspect project",
        assignedAgentKind: "shell",
        status: "completed",
      },
    ],
    agents: [
      {
        id: "agent-shell",
        name: "Shell Agent",
        role: "Read-only command execution",
        status: "completed",
        task: "Task finished",
      },
    ],
    logs: [
      {
        id: `${id}-done`,
        kind: "verification",
        title: "task.completed",
        detail: "Verified.",
      },
    ],
  };
}

function createMemoryStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

function createMemoryTaskHistoryDatabase(initialRows: TaskHistoryRow[] = []) {
  const rows = [...initialRows];
  const database: DesktopDatabase & {
    executedSql: string[];
    bindValues: DatabaseValue[][];
    rows: TaskHistoryRow[];
  } = {
    executedSql: [],
    bindValues: [],
    rows,
    async execute(sql, values = []) {
      this.executedSql.push(sql);
      if (values.length > 0) {
        this.bindValues.push(values);
      }
      if (sql.startsWith("DELETE FROM task_history")) {
        rows.splice(0, rows.length);
        return;
      }
      if (!sql.startsWith("INSERT INTO task_history")) {
        return;
      }

      const row = bindValuesToTaskHistoryRow(values);
      const existingIndex = rows.findIndex((entry) => entry.id === row.id);
      if (existingIndex >= 0) {
        rows[existingIndex] = row;
      } else {
        rows.push(row);
      }
    },
    async select<T extends Record<string, unknown>>(_sql: string, values = []) {
      const limit = typeof values[0] === "number" ? values[0] : TASK_HISTORY_LIMIT;
      return [...rows]
        .sort(
          (left, right) =>
            right.updated_at.localeCompare(left.updated_at) ||
            right.id.localeCompare(left.id),
        )
        .slice(0, limit)
        .map((row) => ({ snapshot_json: row.snapshot_json }) as unknown as T);
    },
  };
  return database;
}

interface TaskHistoryRow {
  id: string;
  title: string;
  user_goal: string;
  status: string;
  updated_at: string;
  snapshot_json: string;
}

function bindValuesToTaskHistoryRow(values: DatabaseValue[]): TaskHistoryRow {
  const [id, title, userGoal, status, updatedAt, snapshotJson] = values;
  return {
    id: String(id),
    title: String(title),
    user_goal: String(userGoal),
    status: String(status),
    updated_at: String(updatedAt),
    snapshot_json: String(snapshotJson),
  };
}
