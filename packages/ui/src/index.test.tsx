import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  JavisWorkbench,
  filterWorkbenchHistoryEntries,
  zhCNWorkbenchLocale,
} from "./index";
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
      status: "completed",
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

  it("renders token usage totals and empty model-call state", () => {
    const usedHtml = renderWorkbench({
      title: "Code Agent patch applied",
      userGoal: "Review code changes",
      status: "completed",
      commanderMessage: "Approved patch was applied.",
      plan: [],
      agents: [],
      logs: [],
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

    expect(usedHtml).toContain("Token usage");
    expect(usedHtml).toContain("1,540");
    expect(usedHtml).toContain("Input: 1,200");
    expect(usedHtml).toContain("Output: 340");
    expect(usedHtml).toContain("Calls: 1");
    expect(unusedHtml).toContain("No model calls");
  });

  it("renders Code Agent patch proposals and apply results", () => {
    const html = renderWorkbench({
      title: "Code Agent patch applied",
      userGoal: "Review code changes",
      status: "completed",
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

  it("filters task history by title, goal, status, and update time", () => {
    const entries = [
      {
        id: "history-1",
        title: "Project environment inspected",
        status: "completed",
        userGoal: "Inspect project",
        updatedAt: "2026-05-23T00:00:00.000Z",
      },
      {
        id: "history-2",
        title: "Research sources collected",
        status: "failed",
        userGoal: "Research Javis search integration",
        updatedAt: "2026-05-24T00:00:00.000Z",
      },
    ];

    expect(filterWorkbenchHistoryEntries(entries, "research")).toEqual([entries[1]]);
    expect(filterWorkbenchHistoryEntries(entries, "COMPLETED")).toEqual([entries[0]]);
    expect(filterWorkbenchHistoryEntries(entries, "05-24")).toEqual([entries[1]]);
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

function renderWorkbench(task: WorkbenchTask): string {
  return renderToStaticMarkup(
    <JavisWorkbench
      draftGoal="Organize PDFs in Downloads"
      onDraftGoalChange={vi.fn()}
      onPermissionDecision={vi.fn()}
      onSubmitGoal={vi.fn()}
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
