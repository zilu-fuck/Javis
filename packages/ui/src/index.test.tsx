import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  JavisWorkbench,
  filterWorkbenchHistoryEntries,
  zhCNWorkbenchLocale,
} from "./index";
import { normalizeWorkspacePath } from "./utils";
import type { WorkbenchTask } from "./index";

describe("JavisWorkbench permission cards", () => {
  it("renders the zh-CN locale pack for static workbench labels", () => {
    const html = renderToStaticMarkup(
      <JavisWorkbench
        draftGoal="检查当前项目"
        locale={zhCNWorkbenchLocale}
        onDraftGoalChange={vi.fn()}
        onDeleteRecentWorkspacePath={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={{
          id: "task-idle",
          title: "Ready",
          userGoal: "Waiting for a task",
          status: "created",
          commanderMessage:
            "Javis desktop is ready. Enter a goal to start the Core event stream.",
          plan: [],
          agents: [],
          logs: [],
        }}
      />,
    );

    expect(html).toContain("新建对话");
    expect(html).toContain("今天想让 Javis 做什么？");
    expect(html).toContain("javis-main new-chat");
    expect(html).not.toContain("主线程");
    expect(html).not.toContain("等待任务");
    expect(html).toContain("发送");
  });

  it("keeps the agent inspector collapsed by default", () => {
    const html = renderToStaticMarkup(
      <JavisWorkbench
        draftGoal="Inspect project"
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={{
          title: "Ready",
          userGoal: "Waiting for a task",
          status: "created",
          commanderMessage:
            "Javis desktop is ready. Enter a goal to start the Core event stream.",
          plan: [],
          agents: [
            {
              id: "agent-commander",
              name: "Commander",
              role: "Task planning and orchestration",
              status: "queued",
              task: "Waiting",
            },
          ],
          logs: [],
        }}
      />,
    );

    expect(html).toContain("inspector-collapsed");
    expect(html).toContain("Expand inspector");
    expect(html).not.toContain("Task planning and orchestration");
  });

  it("renders a draggable sidebar resize separator", () => {
    const html = renderToStaticMarkup(
      <JavisWorkbench
        draftGoal="Inspect project"
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={{
          title: "Ready",
          userGoal: "Waiting for a task",
          status: "created",
          commanderMessage:
            "Javis desktop is ready. Enter a goal to start the Core event stream.",
          plan: [],
          agents: [],
          logs: [],
        }}
      />,
    );

    expect(html).toContain("javis-sidebar-resize-handle");
    expect(html).toContain("role=\"separator\"");
    expect(html).toContain("aria-orientation=\"vertical\"");
    expect(html).toContain("aria-valuemin=\"188\"");
    expect(html).toContain("aria-valuemax=\"360\"");
    expect(html).toContain("aria-valuenow=\"220\"");
  });

  it("renders local knowledge subitems as category buttons", () => {
    const html = renderToStaticMarkup(
      <JavisWorkbench
        activeView="documents"
        draftGoal="Inspect project"
        onChangeActiveView={vi.fn()}
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={{
          title: "Ready",
          userGoal: "Waiting for a task",
          status: "created",
          commanderMessage:
            "Javis desktop is ready. Enter a goal to start the Core event stream.",
          plan: [],
          agents: [],
          logs: [],
        }}
      />,
    );

    expect(html).toContain("<button class=\"javis-nav-subitem\" type=\"button\"");
    expect(html).toContain("文档识别");
  });

  it("normalizes Windows namespace prefixes in computer breadcrumbs", () => {
    const html = renderToStaticMarkup(
      <JavisWorkbench
        activeView="computer"
        computerPath="\\\\?\\C:\\迅雷下载"
        computerEntries={[]}
        draftGoal="Inspect project"
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={{
          title: "Ready",
          userGoal: "Waiting for a task",
          status: "created",
          commanderMessage:
            "Javis desktop is ready. Enter a goal to start the Core event stream.",
          plan: [],
          agents: [],
          logs: [],
        }}
      />,
    );

    expect(html).not.toContain("\\\\?");
    expect(html).toContain("C:");
    expect(html).toContain("迅雷下载");
  });

  it("labels active verifier streaming output as verifier", () => {
    const html = renderWorkbench({
      id: "task-streaming-verifier",
      title: "Checking evidence",
      userGoal: "Inspect project",
      status: "verifying",
      commanderMessage: "Commander prepared a workflow plan.",
      plan: [],
      agents: [],
      logs: [],
      streamingText: "checking streamed evidence",
      streamingAgentKind: "verifier",
      isStreaming: true,
    });

    expect(html).toContain("Verifier");
    expect(html).toContain("checking streamed evidence");
  });

  it("keeps task sections visible while a response is streaming", () => {
    const html = renderWorkbench({
      id: "task-streaming-with-plan",
      title: "Inspecting project",
      userGoal: "Inspect project",
      status: "running",
      commanderMessage: "Commander is coordinating a project inspection.",
      plan: [
        {
          id: "step-1",
          title: "Inspect package scripts",
          status: "running",
        },
      ],
      agents: [],
      logs: [],
      streamingText: "Shell Agent is checking package metadata",
      streamingAgentKind: "commander",
      isStreaming: true,
    });

    expect(html).toContain("Shell Agent is checking package metadata");
    expect(html).toContain("Plan");
    expect(html).toContain("Inspect package scripts");
  });

  it("renders the confirmed-write dry-run and keeps activity log collapsed by default", () => {
    const html = renderWorkbench(createTaskWithPermission("pending"));

    expect(html).toContain("Approve PDF move plan");
    expect(html).toContain("Moving files changes the local filesystem");
    expect(html).toContain("Organize PDF files by filename topic");
    expect(html).toContain("C:/Users/example/Downloads/paper.pdf");
    expect(html).toContain("C:/Users/example/Downloads/Research/paper.pdf");
    expect(html).toContain("aria-expanded=\"false\"");
    expect(html).toContain("Expand activity log");
    expect(html).not.toContain("1 planned path operation(s) require confirmed_write");
  });

  it("keeps confirmation actions enabled only while permission is pending", () => {
    const pendingHtml = renderWorkbench(createTaskWithPermission("pending"));
    const approvedHtml = renderWorkbench(createTaskWithPermission("approved"));

    expect(pendingHtml).toContain("<button type=\"button\">Approve</button>");
    expect(pendingHtml).toContain("<button type=\"button\">Deny</button>");
    expect(pendingHtml).not.toContain("No write operation executed");
    expect(approvedHtml).toContain("<button disabled=\"\" type=\"button\">Approve</button>");
    expect(approvedHtml).toContain("<button disabled=\"\" type=\"button\">Deny</button>");
    expect(approvedHtml).toContain("Status: approved");
  });

  it("shows a no-op result when confirmed-write permission is denied", () => {
    const deniedHtml = renderWorkbench(createTaskWithPermission("denied"));

    expect(deniedHtml).toContain("<button disabled=\"\" type=\"button\">Approve</button>");
    expect(deniedHtml).toContain("<button disabled=\"\" type=\"button\">Deny</button>");
    expect(deniedHtml).toContain("Status: denied");
    expect(deniedHtml).toContain("No write operation executed");
  });

  it("renders research source provider metadata", () => {
    const html = renderWorkbench({
      title: "Research sources collected",
      userGoal: "Research Javis search integration",
      status: "running",
      commanderMessage: "Research Agent produced a source-backed report.",
      plan: [],
      agents: [],
      logs: [],
      sources: [
        {
          url: "https://github.com/expert-vision-software/opencode-intellisearch",
          title: "opencode-intellisearch",
          excerpt: "Deep research plugin for OpenCode.",
          fetchedAt: "2026-05-23T00:00:00.000Z",
          provider: "github-cli",
        },
      ],
    });

    expect(html).toContain("opencode-intellisearch");
    expect(html).toContain("github-cli");
    expect(html).toContain("Deep research plugin for OpenCode.");
  });

  it("collapses completed process details behind a user-controlled toggle", () => {
    const html = renderWorkbench({
      id: "task-completed-process-collapse",
      title: "Project inspected",
      userGoal: "Inspect project",
      status: "completed",
      commanderMessage: "Final conclusion: the project can be started with pnpm dev.",
      plan: [
        {
          id: "hidden-step",
          title: "Hidden intermediate package inspection",
          status: "completed",
        },
      ],
      agents: [],
      logs: [],
      project: {
        workspacePath: "E:/Javis",
        packageManager: "pnpm",
        scripts: [{ name: "dev", command: "pnpm dev" }],
        recommendedStartCommand: "pnpm dev",
      },
    });

    expect(html).toContain("Final conclusion: the project can be started with pnpm dev.");
    expect(html).toContain("Show process");
    expect(html).not.toContain("Hidden intermediate package inspection");
    expect(html).not.toContain("Project Inspection");
  });

  it("renders code review diff preview", () => {
    const html = renderWorkbench({
      title: "Code review preview ready",
      userGoal: "Review code changes",
      status: "waiting_permission",
      commanderMessage: "Diff preview is ready.",
      plan: [],
      agents: [],
      logs: [],
      codeReviewPreview: {
        workspacePath: "E:/Javis",
        changedFiles: ["packages/core/src/index.ts", "packages/ui/src/index.tsx"],
        diffStat: "2 files changed, 10 insertions(+), 4 deletions(-)",
        diff: "diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts",
      },
      permissionRequest: {
        id: "permission-2",
        level: "preview",
        title: "Approve code review continuation",
        reason: "Review the current diff preview before running a read-only verification check.",
        status: "pending",
        dryRun: {
          operation: "Run git diff --check after diff review",
          affectedPaths: [],
          riskSummary: "Read-only review of changed files before verification.",
          reversible: true,
        },
      },
    });

    expect(html).toContain("Code Review");
    expect(html).toContain("Changed files");
    expect(html).toContain("packages/core/src/index.ts");
    expect(html).toContain("git diff --check");
  });

  it("renders a retry action only for failed tasks", () => {
    const failedHtml = renderWorkbench({
      title: "Research search failed",
      userGoal: "Research missing topic",
      status: "failed",
      commanderMessage: "Research Agent could not complete search-backed source collection.",
      plan: [],
      agents: [],
      logs: [],
    });
    const completedHtml = renderWorkbench({
      title: "Research sources collected",
      userGoal: "Research Javis",
      status: "completed",
      commanderMessage: "Research Agent produced a source-backed report.",
      plan: [],
      agents: [],
      logs: [],
    });
    const genericFailedHtml = renderWorkbench({
      title: "Project environment check failed",
      userGoal: "Inspect project",
      status: "failed",
      commanderMessage: "Shell Agent inspection failed before a check could finish.",
      plan: [],
      agents: [],
      logs: [],
    });

    expect(failedHtml).toContain(">Retry</button>");
    expect(failedHtml).toContain("Recovery");
    expect(failedHtml).toContain("Review the failed phase and activity log");
    expect(failedHtml).toContain("Manual source fallback");
    expect(failedHtml).toContain("paste one or more source URLs");
    expect(completedHtml).not.toContain(">Retry</button>");
    expect(completedHtml).not.toContain("Recovery");
    expect(completedHtml).not.toContain("Manual source fallback");
    expect(genericFailedHtml).toContain("Recovery");
    expect(genericFailedHtml).not.toContain("Manual source fallback");
  });

  it("renders a compact context window ring next to the composer submit action", () => {
    const usedHtml = renderWorkbench({
      title: "Code Agent patch applied",
      userGoal: "Review code changes",
      status: "completed",
      commanderMessage: "Approved patch was applied.",
      plan: [],
      agents: [],
      logs: [],
      tokenUsage: {
        inputTokens: 257000,
        outputTokens: 140100,
        totalTokens: 397100,
        modelCalls: 3,
        byAgentKind: [
          {
            agentKind: "commander",
            inputTokens: 128000,
            outputTokens: 64000,
            totalTokens: 192000,
            modelCalls: 1,
          },
          {
            agentKind: "code",
            inputTokens: 129000,
            outputTokens: 76100,
            totalTokens: 205100,
            modelCalls: 2,
          },
        ],
      },
    }, {
      profiles: [
        {
          id: "primary-model",
          slot: "primary",
          displayName: "Primary",
          provider: "openai",
          model: "gpt-4.1",
          apiKeyReference: "default",
          baseUrl: "",
          apiKey: "",
          capabilities: {
            vision: false,
            code: true,
            longContext: true,
          },
        },
      ],
      agentOverrides: {},
    });
    const unusedHtml = renderWorkbench({
      title: "Project environment inspected",
      userGoal: "Inspect project",
      status: "completed",
      commanderMessage: "Project checks completed.",
      plan: [],
      agents: [],
      logs: [],
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        modelCalls: 0,
        byAgentKind: [],
      },
    });

    expect(usedHtml).toContain("javis-context-window-trigger");
    expect(usedHtml).toContain("aria-label=\"Context window: 397.1k / 1.0M (40%)\"");
    expect(usedHtml).toContain("aria-expanded=\"false\"");
    expect(usedHtml.indexOf("javis-context-window-trigger")).toBeLessThan(
      usedHtml.indexOf(">Send</button>"),
    );
    expect(usedHtml).not.toContain("javis-context-window-copy");
    expect(usedHtml).not.toContain("javis-context-window-panel");
    expect(unusedHtml).toContain("aria-label=\"Context window: 0 / 128k (0%)\"");
  });

  it("renders Code Agent patch proposals and apply results", () => {
    const html = renderWorkbench({
      title: "Code Agent patch applied",
      userGoal: "Review code changes",
      status: "running",
      commanderMessage: "Approved patch was applied.",
      plan: [],
      agents: [],
      logs: [],
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
    });

    expect(html).toContain("Code Agent patch proposal");
    expect(html).toContain("Tighten the code review completion message.");
    expect(html).toContain("diff --git");
    expect(html).toContain("Code Agent apply result");
    expect(html).toContain("Applied patch in test.");
  });

  it("renders Code Agent patch approval dry-run details", () => {
    const html = renderWorkbench({
      title: "Code Agent patch approval needed",
      userGoal: "Review code changes",
      status: "waiting_permission",
      commanderMessage:
        "Patch proposal is ready. Review the proposed changes before approving or denying the write step.",
      plan: [],
      agents: [],
      logs: [],
      codeProposedEdit: {
        proposalId: "proposal-1",
        workspacePath: "E:/Javis",
        summary: "Tighten the code review completion message.",
        changedFiles: ["packages/core/src/index.ts"],
        patch: "diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts",
        patchHash: "fnv1a-19fcfa54",
      },
      permissionRequest: {
        id: "permission-code-apply",
        level: "confirmed_write",
        title: "Approve Code Agent patch application",
        reason: "Applying the proposed patch changes local project files, so Javis needs explicit approval.",
        status: "pending",
        dryRun: {
          operation: "Apply Code Agent patch proposal proposal-1",
          affectedPaths: [
            {
              source: "packages/core/src/index.ts",
              target: "packages/core/src/index.ts",
              action: "modify",
            },
          ],
          riskSummary: "Tighten the code review completion message. Patch hash: fnv1a-19fcfa54.",
          reversible: true,
        },
      },
    });

    expect(html).toContain("Approve Code Agent patch application");
    expect(html).toContain("Apply Code Agent patch proposal proposal-1");
    expect(html).toContain("packages/core/src/index.ts");
    expect(html).toContain("modify");
    expect(html).toContain("Patch hash: fnv1a-19fcfa54.");
    expect(html).toContain("<button type=\"button\">Approve</button>");
    expect(html).toContain("<button type=\"button\">Deny</button>");
  });

  it("renders task history entries with delete controls", () => {
    const html = renderToStaticMarkup(
      <JavisWorkbench
        draftGoal="Inspect project"
        historyEntries={[
          {
            id: "history-1",
            title: "Project environment inspected",
            status: "completed",
            userGoal: "Inspect project",
            updatedAt: "2026-05-23T00:00:00.000Z",
            workspacePath: "E:/Javis",
          },
        ]}
        onDeleteHistoryEntry={vi.fn()}
        onDraftGoalChange={vi.fn()}
        onSelectHistoryEntry={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={{
          title: "Ready",
          userGoal: "Waiting for a task",
          status: "created",
          commanderMessage:
            "Javis desktop is ready. Enter a goal to start the Core event stream.",
          plan: [],
          agents: [],
          logs: [],
        }}
      />,
    );

    expect(html).toContain("Project environment inspected");
    expect(html).toContain("completed");
    expect(html).toContain("aria-label=\"Delete history: Project environment inspected\"");
    expect(html).not.toContain("No history yet");
  });

  it("groups task history by workspace path", () => {
    const html = renderToStaticMarkup(
      <JavisWorkbench
        currentWorkspacePath="E:/Javis"
        draftGoal="Inspect project"
        locale={zhCNWorkbenchLocale}
        recentWorkspacePaths={["E:/Javis", "F:/Other", "G:/Empty"]}
        historyEntries={[
          {
            id: "history-1",
            title: "Project environment inspected",
            status: "completed",
            userGoal: "Inspect project",
            updatedAt: "2026-05-23T00:00:00.000Z",
            workspacePath: "E:/Javis",
          },
          {
            id: "history-3",
            title: "Add Windows signing note",
            status: "completed",
            userGoal: "Inspect project",
            updatedAt: "2026-05-22T00:00:00.000Z",
            workspacePath: "E:/Javis",
          },
          {
            id: "history-4",
            title: "Expand QA coverage",
            status: "completed",
            userGoal: "Inspect project",
            updatedAt: "2026-05-21T00:00:00.000Z",
            workspacePath: "E:/Javis",
          },
          {
            id: "history-5",
            title: "Migrate localStorage to SQLite",
            status: "completed",
            userGoal: "Inspect project",
            updatedAt: "2026-05-20T00:00:00.000Z",
            workspacePath: "E:/Javis",
          },
          {
            id: "history-6",
            title: "Clone Proma and study",
            status: "completed",
            userGoal: "Inspect project",
            updatedAt: "2026-05-19T00:00:00.000Z",
            workspacePath: "E:/Javis",
          },
          {
            id: "history-2",
            title: "Research sources collected",
            status: "completed",
            userGoal: "Research Javis search integration",
            updatedAt: "2026-05-24T00:00:00.000Z",
            workspacePath: "F:/Other",
          },
          {
            id: "history-7",
            title: "Fallback history entry",
            status: "completed",
            userGoal: "Inspect project",
            updatedAt: "2026-05-18T00:00:00.000Z",
          },
        ]}
        onDeleteHistoryEntry={vi.fn()}
        onDraftGoalChange={vi.fn()}
        onSelectHistoryEntry={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={{
          title: "Ready",
          userGoal: "Waiting for a task",
          status: "created",
          commanderMessage:
            "Javis desktop is ready. Enter a goal to start the Core event stream.",
          plan: [], 
          agents: [],
          logs: [],
        }}
      />,
    );

    expect(html).toContain("项目");
    expect(html).toContain("Javis");
    expect(html).toContain("aria-expanded=\"true\"");
    expect(html).toContain("F:/Other");
    expect(html).toContain("暂无对话");
    expect(html).toContain("未知");
    expect(html).toContain("展开显示");
    expect(html).toContain("Fallback history entry");
    expect(html).toContain("Research sources collected");
  });

  it("normalizes verbatim workspace paths in history grouping", () => {
    const html = renderToStaticMarkup(
      <JavisWorkbench
        currentWorkspacePath="E:/Javis"
        draftGoal="Inspect project"
        recentWorkspacePaths={["E:/Javis"]}
        historyEntries={[
          {
            id: "history-1",
            title: "Project environment inspected",
            status: "completed",
            userGoal: "Inspect project",
            updatedAt: "2026-05-23T00:00:00.000Z",
            workspacePath: "\\\\?\\E:\\Javis",
          },
        ]}
        onDeleteHistoryEntry={vi.fn()}
        onDraftGoalChange={vi.fn()}
        onSelectHistoryEntry={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={{
          title: "Ready",
          userGoal: "Waiting for a task",
          status: "created",
          commanderMessage:
            "Javis desktop is ready. Enter a goal to start the Core event stream.",
          plan: [],
          agents: [],
          logs: [],
        }}
      />,
    );

    expect(normalizeWorkspacePath("\\\\?\\E:\\Javis")).toBe("E:/Javis");
    expect(html).toContain("Project environment inspected");
    expect(html).toContain("E:/Javis");
    expect(html).not.toContain("\\\\?\\");
  });

  it("filters task history by title, goal, status, and update time", () => {
    const entries = [
      {
        id: "history-1",
        title: "Project environment inspected",
        status: "completed",
        userGoal: "Inspect project",
        updatedAt: "2026-05-23T00:00:00.000Z",
        workspacePath: "E:/Javis",
      },
      {
        id: "history-2",
        title: "Research sources collected",
        status: "failed",
        userGoal: "Research Javis search integration",
        updatedAt: "2026-05-24T00:00:00.000Z",
        workspacePath: "F:/Other",
      },
    ];

    expect(filterWorkbenchHistoryEntries(entries, "research")).toEqual([entries[1]]);
    expect(filterWorkbenchHistoryEntries(entries, "COMPLETED")).toEqual([entries[0]]);
    expect(filterWorkbenchHistoryEntries(entries, "05-24")).toEqual([entries[1]]);
    expect(filterWorkbenchHistoryEntries(entries, "F:/Other")).toEqual([entries[1]]);
    expect(filterWorkbenchHistoryEntries(entries, "  ")).toEqual(entries);
    expect(filterWorkbenchHistoryEntries(entries, "missing")).toEqual([]);
  });

  it("renders current and recent workspace controls", () => {
    const html = renderToStaticMarkup(
      <JavisWorkbench
        currentWorkspacePath="E:/Javis"
        draftGoal="Inspect project"
        onBrowseWorkspacePath={vi.fn()}
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        onUseWorkspacePath={vi.fn()}
        onWorkspacePathChange={vi.fn()}
        recentWorkspacePaths={["E:/Javis", "F:/Other"]}
        task={{
          title: "Ready",
          userGoal: "Waiting for a task",
          status: "created",
          commanderMessage:
            "Javis desktop is ready. Enter a goal to start the Core event stream.",
          plan: [],
          agents: [],
          logs: [],
        }}
      />,
    );

    expect(html).toContain("Current workspace");
    expect(html).toContain("Browse");
    expect(html).toContain("value=\"E:/Javis\"");
    expect(html).toContain("Recent workspaces");
    expect(html).toContain("F:/Other");
    expect(html).toContain("aria-label=\"Remove: E:/Javis\"");
  });

  it("renders settings entry instead of the profile footer", () => {
    const html = renderToStaticMarkup(
      <JavisWorkbench
        draftGoal="Review code changes"
        modelSettings={{
          provider: "openai",
          model: "openai/gpt-5.1-codex",
          apiKey: "",
          apiKeyReference: "default",
          baseUrl: "https://api.openai.com/v1",
        }}
        onDraftGoalChange={vi.fn()}
        onModelSettingsChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={{
          title: "Ready",
          userGoal: "Waiting for a task",
          status: "created",
          commanderMessage:
            "Javis desktop is ready. Enter a goal to start the Core event stream.",
          plan: [],
          agents: [],
          logs: [],
        }}
      />,
    );

    expect(html).toContain("Settings");
    expect(html).toContain("javis-settings-trigger");
    expect(html).not.toContain("javis-sidebar-footer");
    expect(html).not.toContain(">User</span>");
  });

  it("renders localized workspace controls", () => {
    const html = renderToStaticMarkup(
      <JavisWorkbench
        currentWorkspacePath="E:/Javis"
        draftGoal="Inspect project"
        locale={zhCNWorkbenchLocale}
        onBrowseWorkspacePath={vi.fn()}
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        onUseWorkspacePath={vi.fn()}
        onWorkspacePathChange={vi.fn()}
        recentWorkspacePaths={["E:/Javis"]}
        task={{
          title: "Ready",
          userGoal: "Waiting for a task",
          status: "created",
          commanderMessage:
            "Javis desktop is ready. Enter a goal to start the Core event stream.",
          plan: [],
          agents: [],
          logs: [],
        }}
      />,
    );

    expect(html).toContain("选择文件夹");
    expect(html).toContain("aria-label=\"移除: E:/Javis\"");
    expect(html).not.toContain(">Browse<");
    expect(html).not.toContain("Remove: E:/Javis");
  });
});

function renderWorkbench(
  task: WorkbenchTask,
  modelConfiguration?: Parameters<typeof JavisWorkbench>[0]["modelConfiguration"],
): string {
  return renderToStaticMarkup(
    <JavisWorkbench
      draftGoal="Organize PDFs in Downloads"
      onDraftGoalChange={vi.fn()}
      onPermissionDecision={vi.fn()}
      onSubmitGoal={vi.fn()}
      modelConfiguration={modelConfiguration}
      task={task}
    />,
  );
}

function createTaskWithPermission(status: "pending" | "approved" | "denied"): WorkbenchTask {
  return {
    title: "PDF organization approval needed",
    userGoal: "Organize PDFs in Downloads",
    status: "waiting_permission",
    commanderMessage:
      "Dry-run is ready. Review the affected paths before approving or denying the write step.",
    plan: [
      {
        id: "step-plan-pdf",
        title: "File Agent creates a PDF organization dry-run",
        status: "completed",
      },
      {
        id: "step-confirm-pdf",
        title: "User reviews the confirmed-write permission card",
        status: "running",
      },
    ],
    agents: [
      {
        id: "agent-commander",
        name: "Commander",
        role: "Task planning and orchestration",
        status: "waiting_permission",
        task: "Waiting for user approval",
      },
    ],
    logs: [
      {
        id: "log-permission",
        kind: "permission",
        title: "permission.requested",
        detail: "1 planned move requires confirmed_write approval.",
      },
    ],
    permissionRequest: {
      id: "permission-1",
      level: "confirmed_write",
      title: "Approve PDF move plan",
      reason: "Moving files changes the local filesystem, so Javis needs explicit approval.",
      status,
      dryRun: {
        operation: "Organize PDF files by filename topic",
        affectedPaths: [
          {
            source: "C:/Users/example/Downloads/paper.pdf",
            target: "C:/Users/example/Downloads/Research/paper.pdf",
            action: "move",
          },
        ],
        riskSummary: "Moves one PDF file inside Downloads.",
        reversible: true,
      },
    },
  };
}
