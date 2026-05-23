import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { JavisWorkbench, zhCNWorkbenchLocale } from "./index";
import type { WorkbenchTask } from "./index";

describe("JavisWorkbench permission cards", () => {
  it("renders the zh-CN locale pack for static workbench labels", () => {
    const html = renderToStaticMarkup(
      <JavisWorkbench
        draftGoal="检查当前项目"
        locale={zhCNWorkbenchLocale}
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
