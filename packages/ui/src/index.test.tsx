import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  JavisWorkbench,
  filterWorkbenchHistoryEntries,
  zhCNWorkbenchLocale,
} from "./index";
import { HELP_ME_DECIDE_ANSWER } from "./components/TaskSections";
import { normalizeWorkspacePath } from "./utils";
import type { WorkbenchTask } from "./index";

describe("JavisWorkbench permission cards", () => {
  it("renders multiple workspace tool tabs for multi-open tools", () => {
    const html = renderWorkbench(
      {
        id: "task-idle",
        title: "Ready",
        userGoal: "Waiting for a task",
        status: "created",
        commanderMessage: "Ready",
        plan: [],
        agents: [],
        logs: [],
      },
      undefined,
      {
        currentWorkspacePath: "E:/Javis",
        initialIsInspectorOpen: true,
        workspaceToolTabs: [
          { id: "browser-1", tool: "browser", title: "Browser" },
          { id: "browser-2", tool: "browser", title: "Browser 2" },
        ],
      },
    );

    expect(html).toContain("Browser");
    expect(html).toContain("Browser 2");
    expect(html).toContain("javis-tool-tab-add");
  });

  it("renders the zh-CN locale pack for static workbench labels", () => {
    const html = renderToStaticMarkup(
      <JavisWorkbench
        draftGoal="检查当前项目"
        activeComposeMode="chat"
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
    expect(html).toContain("今天想跟 Javis 聊点什么？");
    expect(html).toContain("javis-main new-chat");
    expect(html).not.toContain("主线程");
    expect(html).not.toContain("等待任务");
    expect(html).toContain("想聊点什么...");
    expect(html).toContain("发送");
  });

  it("keeps the agent inspector and activity log collapsed by default and renders workspace controls", () => {
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
    expect(html).toContain("activity-collapsed");
    expect(html).toContain("Workspace controls");
    expect(html).toContain("Collapse sidebar");
    expect(html).toContain("Expand activity log");
    expect(html).toContain("Expand inspector");
    expect(html).not.toContain("Task planning and orchestration");
  });

  it("renders profile-backed new chat recommendations when provided", () => {
    const html = renderToStaticMarkup(
      <JavisWorkbench
        draftGoal=""
        newChatRecommendations={{
          primary: [
            {
              id: "profile-memory",
              label: "Refine memory profile",
              prompt: "Refine profile memory from history.",
              reason: "The user often asks for memory recommendations.",
              source: "profile",
              evidence: [{ title: "History", snippet: "Asked for profile memory." }],
            },
          ],
          secondary: [
            {
              id: "audit-recommendations",
              label: "Audit recommendation quality",
              prompt: "Audit the recommendations.",
              source: "profile",
            },
          ],
        }}
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={{
          id: "task-idle",
          title: "Ready",
          userGoal: "Waiting for a task",
          status: "created",
          commanderMessage: "Ready",
          plan: [],
          agents: [],
          logs: [],
        }}
      />,
    );

    expect(html).toContain("Refine memory profile");
    expect(html).toContain("Audit recommendation quality");
    expect(html).toContain("aria-label=\"Refine memory profile。The user often asks for memory recommendations.\"");
    expect(html).toContain(">Profile<");
    expect(html).toContain(">1 refs<");
    expect(html).not.toContain("Create task");
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

  it("registers local knowledge subitems from classified resources only", () => {
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

    expect(html).not.toContain("Doc Recognition");
    expect(html).not.toContain("javis-nav-subitem");

    const classifiedHtml = renderToStaticMarkup(
      <JavisWorkbench
        activeView="documents"
        draftGoal="Inspect project"
        onChangeActiveView={vi.fn()}
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={createIdleTask()}
        userDocuments={[
          { name: "Contract.pdf", path: "E:/Docs/Contract.pdf", isDir: false, category: "Contracts" },
        ]}
      />,
    );

    expect(classifiedHtml).toContain("javis-nav-subitem");
    expect(classifiedHtml).toContain("Contracts(1)");
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
      status: "failed",
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

    // Streaming text still appears inline
    expect(html).toContain("Shell Agent is checking package metadata");
    // Failed status triggers inline recovery prompt
    expect(html).toContain("Recovery");
    // Phase 2 keeps active DAG steps visible in the main thread progress card.
    expect(html).toContain("Inspect package scripts");
  });

  it("renders the confirmed-write dry-run when the activity log is expanded", () => {
    const html = renderWorkbench(createTaskWithPermission("pending"), undefined, {
      initialIsActivityOpen: true,
    });

    expect(html).toContain("Approve PDF move plan");
    expect(html).toContain("Moving files changes the local filesystem");
    expect(html).toContain("Organize PDF files by filename topic");
    expect(html).toContain("C:/Users/example/Downloads/paper.pdf");
    expect(html).toContain("C:/Users/example/Downloads/Research/paper.pdf");
    expect(html).toContain("aria-expanded=\"true\"");
    expect(html).toContain("Collapse activity log");
    expect(html).toContain("1 planned path operation(s) require confirmed_write");
  });

  it("renders structured ask-user choices and submits choice values", () => {
    Element.prototype.scrollIntoView = vi.fn();
    const onAskUserAnswer = vi.fn();
    const { getByText, container } = render(
      <JavisWorkbench
        draftGoal="Continue"
        onAskUserAnswer={onAskUserAnswer}
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={{
          title: "Need more information",
          userGoal: "Organize files",
          status: "waiting_info",
          commanderMessage: "Which scope should I use?",
          plan: [],
          agents: [],
          logs: [],
          askUserQuestion: {
            id: "ask-1",
            question: "Which scope should I use?",
            choices: [
              { label: "Current project", value: "current-project", isRecommended: true },
              "Downloads",
            ],
            status: "pending",
          },
        }}
      />,
    );

    fireEvent.click(getByText("Current project"));

    expect(onAskUserAnswer).toHaveBeenCalledWith("current-project");
    expect(container.querySelector(".javis-ask-user-choices button.recommended")).not.toBeNull();
    expect(getByText("Help me decide")).toBeTruthy();
    expect(container.querySelector(".javis-ask-user-input input")).not.toBeNull();
    fireEvent.click(getByText("Help me decide"));
    expect(onAskUserAnswer).toHaveBeenCalledWith(HELP_ME_DECIDE_ANSWER);
    expect(container.querySelector(".javis-composer-status-hint")).not.toBeNull();
  });

  it("keeps waiting-info plan mode focused on the question card", () => {
    const { container } = render(
      <JavisWorkbench
        draftGoal="Continue"
        onAskUserAnswer={vi.fn()}
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={{
          title: "Local video wallpaper player plan",
          userGoal: "Build a local wallpaper video browser",
          status: "waiting_info",
          commanderMessage: JSON.stringify({
            plan: [{ id: "req-clarify", title: "Clarify requirements" }],
            needsClarification: true,
          }),
          plan: [
            { id: "req-clarify", title: "Clarify requirements", status: "pending" },
          ],
          agents: [
            { id: "agent-file", name: "File Agent", role: "Reads files", status: "queued", task: "Waiting" },
          ],
          logs: [],
          conversationMessages: [
            { role: "user", content: "Build a local wallpaper video browser" },
            {
              id: "ask-1-message",
              kind: "ask_user_question",
              role: "assistant",
              content: "Which folder should I scan?",
              askUserQuestion: {
                id: "ask-1",
                question: "Which folder should I scan?",
                choices: ["Downloads"],
                status: "pending",
              },
            },
          ],
          askUserQuestion: {
            id: "ask-1",
            question: "Which folder should I scan?",
            choices: ["Downloads"],
            status: "pending",
          },
        }}
      />,
    );

    expect(container.querySelector(".javis-ask-user")).not.toBeNull();
    expect(container.querySelector(".javis-task-progress-card")).toBeNull();
    expect(container.querySelector(".javis-agent-run-grid")).toBeNull();
    expect(container.querySelectorAll(".javis-message-inline-card")).toHaveLength(0);
    expect(container.textContent).not.toContain("needsClarification");
    expect(container.textContent).not.toContain("\"plan\"");
    expect(container.querySelector<HTMLTextAreaElement>(".javis-composer textarea")?.disabled).toBe(true);
  });

  it("renders demo-inspired orchestration progress with agent cards", () => {
    const html = renderWorkbench({
      id: "task-progress-rich",
      title: "Inspecting project",
      userGoal: "Inspect project",
      status: "running",
      commanderMessage: "Commander is coordinating a project inspection.",
      plan: [
        { id: "scan", title: "Scan files", status: "completed", durationMs: 1240 },
        { id: "inspect", title: "Inspect package scripts", status: "running" },
      ],
      agents: [
        { id: "agent-file", name: "File Agent", role: "Reads files", status: "completed", task: "Scanned files" },
        { id: "agent-shell", name: "Shell Agent", role: "Checks commands", status: "running", task: "Checking scripts" },
      ],
      logs: [],
    });

    expect(html).toContain("javis-task-stepper");
    expect(html).toContain("javis-dispatch-lines");
    expect(html).toContain("data-testid=\"dispatch-connector-svg\"");
    expect(html).toContain("javis-agent-run-grid");
    expect(html).toContain("File Agent");
    expect(html).toContain("Shell Agent");
    expect(html).toContain("Checking scripts");
    expect(html).toContain("1.2s");
  });

  it("opens inspector details when a central orchestration agent card is selected", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const view = render(
      <JavisWorkbench
        draftGoal="Inspect project"
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={createOrchestrationTask()}
      />,
    );

    expect(view.container.querySelector(".javis-shell")?.className).toContain("inspector-collapsed");

    fireEvent.click(view.container.querySelector(".javis-agent-run-card.status-running")!);

    await waitFor(() => {
      expect(view.container.querySelector(".javis-shell")?.className).toContain("inspector-open");
    });

    expect(view.container.querySelector(".javis-agent-run-card.active")?.textContent).toContain("Shell Agent");
    expect(view.container.querySelector(".javis-selected-agent-detail")?.textContent).toContain("Shell Agent");
    expect(view.container.querySelector(".javis-tool-tab.active")?.textContent).toContain("Shell Agent");
    expect(view.container.querySelector(".javis-inspector-quick-actions")).toBeNull();

    fireEvent.click(view.container.querySelectorAll(".javis-inspector-toggle")[0]);

    expect(view.container.querySelector(".javis-agent-graph-root")?.textContent).toContain("Commander");
    expect(view.container.querySelector("[data-testid='inspector-agent-graph-lines']")).not.toBeNull();
    expect(view.container.querySelector(".javis-agent.active")?.textContent).toContain("Shell Agent");
  });

  it("shows full related event messages in the selected agent details", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const longMessage = "正在检查项目脚本、依赖和启动命令，并保留完整事件说明供用户回看。";
    const task: WorkbenchTask = {
      ...createOrchestrationTask(),
      plan: [
        { id: "scan", title: "Scan files", status: "completed", durationMs: 1240, agentId: "agent-file" },
        { id: "inspect", title: "Inspect package scripts", status: "running", agentId: "agent-shell" },
      ],
      logs: [
        {
          id: "log-shell-1",
          kind: "event",
          title: "step.started",
          detail: "Shell Agent started inspecting package scripts and launch commands.",
          userMessage: longMessage,
          agentId: "agent-shell",
        },
        {
          id: "log-shell-json",
          kind: "tool",
          title: "tool.plan",
          detail: "使用 Shell Agent 检查 package scripts。",
          userMessage: "{\"plan\":[{\"title\":\"internal\"}]}",
          agentId: "agent-shell",
        },
      ],
    };
    const view = render(
      <JavisWorkbench
        draftGoal="Inspect project"
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={task}
      />,
    );

    fireEvent.click(view.container.querySelector(".javis-agent-run-card.status-running")!);

    await waitFor(() => {
      const details = view.container.querySelector(".javis-selected-agent-detail");
      expect(details?.textContent).toContain("Shell Agent");
    });

    const eventList = view.container.querySelector(".javis-agent-event-list");
    expect(view.container.querySelector(".javis-agent-detail-step-list")?.textContent)
      .toContain("Inspect package scripts");
    expect(eventList?.textContent).toContain(longMessage);
    expect(eventList?.textContent).toContain("使用 Shell Agent 检查 package scripts。");
    expect(eventList?.textContent).not.toContain("\"plan\"");
  });

  it("closes the selected agent detail tab back to inspector quick actions", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const view = render(
      <JavisWorkbench
        draftGoal="Inspect project"
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={createOrchestrationTask()}
      />,
    );

    fireEvent.click(view.container.querySelector(".javis-agent-run-card.status-running")!);

    await waitFor(() => {
      expect(view.container.querySelector(".javis-tool-tab.active")?.textContent).toContain("Shell Agent");
    });

    fireEvent.click(view.container.querySelector(".javis-tool-tab.active .javis-tool-tab-close")!);

    await waitFor(() => {
      expect(view.container.querySelector(".javis-selected-agent-detail")).toBeNull();
      expect(view.container.querySelector(".javis-inspector-quick-actions")).not.toBeNull();
    });
  });

  it("uses the selected agent detail tab as the active inspector content over open tool tabs", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const view = render(
      <JavisWorkbench
        draftGoal="Inspect project"
        initialIsInspectorOpen={true}
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={createOrchestrationTask()}
        workspaceToolTabs={[{ id: "terminal-1", tool: "terminal" }]}
      />,
    );

    expect(view.container.querySelector(".javis-tool-tab.active")?.textContent).toContain("Terminal");

    fireEvent.click(view.container.querySelector(".javis-agent-run-card.status-running")!);

    await waitFor(() => {
      expect(view.container.querySelector(".javis-tool-tab.active")?.textContent).toContain("Shell Agent");
      expect(view.container.querySelector(".javis-selected-agent-detail")?.textContent).toContain("Shell Agent");
    });
    const inactiveTabs = Array.from(view.container.querySelectorAll(".javis-tool-tab:not(.active)"));
    expect(inactiveTabs.some((tab) => tab.textContent?.includes("Terminal"))).toBe(true);
  });

  it("keeps separate agent detail tabs when different agents are selected", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const task: WorkbenchTask = {
      ...createOrchestrationTask(),
      agents: [
        { id: "agent-file", name: "File Agent", role: "Reads files", status: "completed", task: "Scanned files" },
        { id: "agent-shell", name: "Shell Agent", role: "Checks commands", status: "running", task: "Checking scripts" },
        { id: "agent-research", name: "Research Agent", role: "Checks references", status: "queued", task: "Waiting for sources" },
      ],
    };
    const view = render(
      <JavisWorkbench
        draftGoal="Inspect project"
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={task}
      />,
    );

    const agentCards = view.container.querySelectorAll(".javis-agent-run-card");
    fireEvent.click(agentCards[0]);
    fireEvent.click(agentCards[1]);
    fireEvent.click(agentCards[2]);

    await waitFor(() => {
      expect(view.container.querySelectorAll(".javis-tool-tab.active")).toHaveLength(1);
      expect(view.container.querySelectorAll(".javis-tool-tab")).toHaveLength(3);
      expect(Array.from(view.container.querySelectorAll(".javis-tool-tab")).map((tab) => tab.textContent)).toEqual([
        "File Agent×",
        "Shell Agent×",
        "Research Agent×",
      ]);
      expect(view.container.querySelector(".javis-tool-tab.active")?.textContent).toContain("Research Agent");
      expect(view.container.querySelector(".javis-selected-agent-detail")?.textContent).toContain("Research Agent");
    });
    expect(view.container.querySelector(".javis-selected-agent-detail")?.textContent).not.toContain("File Agent");
    expect(view.container.querySelector(".javis-selected-agent-detail")?.textContent).not.toContain("Shell Agent");

    fireEvent.click(view.container.querySelector(".javis-tool-tab.active .javis-tool-tab-close")!);

    await waitFor(() => {
      expect(view.container.querySelectorAll(".javis-tool-tab")).toHaveLength(2);
      expect(view.container.querySelector(".javis-tool-tab.active")?.textContent).toContain("Shell Agent");
      expect(view.container.querySelector(".javis-selected-agent-detail")?.textContent).toContain("Shell Agent");
    });
  });

  it("drops stale selected agent details when the task no longer contains that agent", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const view = render(
      <JavisWorkbench
        draftGoal="Inspect project"
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={createOrchestrationTask()}
      />,
    );

    fireEvent.click(view.container.querySelector(".javis-agent-run-card.status-running")!);

    await waitFor(() => {
      expect(view.container.querySelector(".javis-selected-agent-detail")?.textContent).toContain("Shell Agent");
    });

    view.rerender(
      <JavisWorkbench
        draftGoal="Inspect project"
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={{
          id: "task-no-shell-agent",
          title: "Different task",
          userGoal: "Inspect another project",
          status: "running",
          commanderMessage: "Running another task.",
          plan: [{ id: "scan", title: "Scan files", status: "running" }],
          agents: [],
          logs: [],
        }}
      />,
    );

    expect(view.container.querySelector(".javis-selected-agent-detail")).toBeNull();
    expect(view.container.querySelector(".javis-inspector-details")?.textContent).not.toContain("Shell Agent");
  });

  it("opens the inspector resource status section from the rail", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const task = {
      ...createOrchestrationTask(),
      logs: [
        { id: "log-1", kind: "agent", title: "shell.started", detail: "Shell Agent started." },
        { id: "log-2", kind: "agent", title: "file.completed", detail: "File Agent completed." },
      ],
      tokenUsage: {
        inputTokens: 1200,
        outputTokens: 450,
        totalTokens: 1650,
        modelCalls: 2,
        byAgentKind: [],
      },
      executionTrace: {
        taskId: "task-progress-rich",
        startedAt: "2026-06-07T10:00:00.000Z",
        totalWallTimeMs: 4250,
        steps: [],
      },
    };
    const view = render(
      <JavisWorkbench
        draftGoal="Inspect project"
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        systemResources={{ cpuPercent: 37, memoryPercent: 58 }}
        task={task}
      />,
    );

    fireEvent.click(view.container.querySelectorAll(".javis-inspector-toggle")[2]);

    await waitFor(() => {
      expect(view.container.querySelector(".javis-inspector-panel")?.textContent).toContain("Resources");
    });

    const resourcePanel = view.container.querySelector(".javis-inspector-panel");
    expect(resourcePanel?.textContent).toContain("CPU");
    expect(resourcePanel?.textContent).toContain("37%");
    expect(resourcePanel?.textContent).toContain("Memory");
    expect(resourcePanel?.textContent).toContain("58%");
    expect(resourcePanel?.textContent).toContain("Log entries");
    expect(resourcePanel?.textContent).toContain("1650");
  });

  it("filters inspector run details to the selected agent", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const task: WorkbenchTask = {
      ...createOrchestrationTask(),
      plan: [
        { id: "scan", title: "Shell-looking file scan", status: "completed", agentId: "agent-file", agentKind: "file" },
        { id: "inspect", title: "Shell Agent checks scripts", status: "running", agentId: "agent-shell", agentKind: "command" },
      ],
      logs: [
        { id: "log-file", kind: "agent", title: "Shell Agent mention from File", detail: "File Agent scanned files.", agentId: "agent-file" },
        { id: "log-shell", kind: "agent", title: "Shell Agent running", detail: "Shell Agent checks package scripts.", stepId: "inspect" },
      ],
      commands: [{
        command: "pnpm test",
        cwd: "E:/Javis",
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      }],
    };
    const view = render(
      <JavisWorkbench
        draftGoal="Inspect project"
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={task}
      />,
    );

    fireEvent.click(view.container.querySelector(".javis-agent-run-card.status-running")!);

    await waitFor(() => {
      expect(view.container.querySelector(".javis-selected-agent-detail")?.textContent).toContain("Shell Agent");
    });

    const details = view.container.querySelector(".javis-inspector-details");
    expect(details?.textContent).toContain("Shell Agent checks scripts");
    expect(details?.textContent).toContain("Shell Agent running");
    expect(details?.textContent).toContain("pnpm test");
    expect(view.container.querySelector(".javis-inspector-quick-actions")).toBeNull();
    expect(view.container.querySelector(".javis-tool-tab.active")?.textContent).toContain("Shell Agent");
    fireEvent.click(Array.from(view.container.querySelectorAll<HTMLButtonElement>(".javis-agent-tool-shortcut"))
      .find((button) => button.textContent?.includes("Terminal"))!);
    expect(view.container.querySelector(".javis-tool-tab.active")?.textContent).toContain("Terminal");
    expect(details?.textContent).not.toContain("Shell-looking file scan");
    expect(details?.textContent).not.toContain("Shell Agent mention from File");
  });

  it("renders Commander plan JSON as a compact user-facing step list", () => {
    const html = renderWorkbench({
      id: "task-plan-json",
      title: "Plan",
      userGoal: "Inspect project",
      status: "planning",
      commanderMessage: JSON.stringify({ title: "Inspect project", steps: [{ id: "scan" }] }),
      plan: [
        { id: "scan", title: "Scan files", status: "pending" },
        { id: "summarize", title: "Summarize findings", status: "pending" },
      ],
      agents: [],
      logs: [],
    });

    expect(html).toContain("I will handle this in 2 step(s):");
    expect(html).toContain("Scan files");
    expect(html).not.toContain("&quot;steps&quot;");
  });

  it("renders Commander plan-field JSON as a compact user-facing step list", () => {
    const html = renderWorkbench({
      id: "task-plan-json-plan-field",
      title: "Plan",
      userGoal: "Build wallpaper browser",
      status: "planning",
      commanderMessage: JSON.stringify({
        plan: [{ id: "req-clarify", title: "Clarify requirements" }],
        riskSummary: "Need a local folder before scanning files.",
        needsClarification: true,
      }),
      plan: [
        { id: "req-clarify", title: "Clarify requirements", status: "pending" },
        { id: "file-scan", title: "Scan local video files", status: "pending" },
      ],
      agents: [],
      logs: [],
    });

    expect(html).toContain("I will handle this in 2 step(s):");
    expect(html).toContain("Clarify requirements");
    expect(html).not.toContain("&quot;plan&quot;");
    expect(html).not.toContain("needsClarification");
  });

  it("renders the activity log as a virtualized dense table", () => {
    const html = renderWorkbench({
      id: "task-many-logs",
      title: "Lots of logs",
      userGoal: "Inspect project",
      status: "running",
      commanderMessage: "Running",
      plan: [],
      agents: [],
      logs: Array.from({ length: 20 }, (_, index) => ({
        id: `log-${index}`,
        kind: "event",
        title: `step.${index}`,
        detail: `technical detail ${index}`,
        userMessage: `Step ${index} is visible`,
        devDetail: `developer detail ${index}`,
      })),
    }, undefined, { initialIsActivityOpen: true });

    expect(html).toContain("javis-activity-list virtual");
    expect(html).toContain("Step 0 is visible");
    expect(html).not.toContain("developer detail 0");
  });

  it("shows developer details in the activity log only after process details are enabled", () => {
    const { container } = render(
      <JavisWorkbench
        draftGoal="Inspect project"
        initialIsActivityOpen={true}
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={{
          id: "task-dev-log",
          title: "Inspect project",
          userGoal: "Inspect project",
          status: "running",
          commanderMessage: "Running",
          plan: [],
          agents: [],
          logs: [{
            id: "log-1",
            kind: "event",
            title: "step.started",
            detail: "raw technical detail",
            userMessage: "Visible user message",
            devDetail: "Hidden developer detail",
          }],
        }}
      />,
    );

    expect(container.textContent).toContain("Visible user message");
    expect(container.textContent).not.toContain("Hidden developer detail");
    fireEvent.click(container.querySelector(".javis-activity-tools button[aria-pressed]")!);
    expect(container.textContent).toContain("Hidden developer detail");
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

  it("renders Computer Use action approvals as desktop actions", () => {
    const html = renderWorkbench({
      ...createTaskWithPermission("pending"),
      title: "需要确认桌面操作",
      commanderMessage: "需要你确认：点击屏幕坐标 (640, 420)。",
      permissionRequest: {
        id: "computer-permission-1",
        level: "confirmed_write",
        title: "需要确认桌面操作",
        reason: "Javis 准备点击屏幕坐标 (640, 420)。",
        status: "pending",
        dryRun: {
          operation: "computer.click",
          affectedPaths: [
            {
              source: "本机桌面",
              target: "点击屏幕坐标 (640, 420)",
              action: "modify",
            },
          ],
          riskSummary: "该操作会影响当前桌面或目标应用，请确认后再执行。",
          reversible: false,
        },
      },
    });

    expect(html).toContain("需要确认桌面操作");
    expect(html).toContain("Javis 准备点击屏幕坐标 (640, 420)。");
    expect(html).toContain("点击屏幕坐标 (640, 420)");
    expect(html).toContain("<button type=\"button\">Approve</button>");
    expect(html).toContain("<button type=\"button\">Allow this task</button>");
    expect(html).toContain("<button type=\"button\">Deny</button>");
  });

  it("does not show task-level approval for sensitive Computer Use actions", () => {
    const html = renderWorkbench({
      ...createTaskWithPermission("pending"),
      permissionRequest: {
        id: "computer-sensitive-permission-1",
        level: "confirmed_write",
        title: "Confirm desktop input",
        reason: "Javis is about to type text.",
        status: "pending",
        dryRun: {
          operation: "computer.type",
          affectedPaths: [
            {
              source: "local desktop",
              target: "Type 5 characters",
              action: "modify",
            },
          ],
          riskSummary: "This action requires separate confirmation.",
          reversible: false,
        },
      },
    });

    expect(html).toContain("<button type=\"button\">Approve</button>");
    expect(html).not.toContain("Allow this task");
    expect(html).not.toContain("Always Allow");
    expect(html).toContain("<button type=\"button\">Deny</button>");
  });

  it("renders research source provider metadata in inspector panel", () => {
    const html = renderWorkbench({
      title: "Research sources collected",
      userGoal: "Research Javis search integration",
      status: "failed",
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

    // Commander message is still rendered inline in the main thread
    expect(html).toContain("Research Agent produced a source-backed report.");
    // Source metadata now lives in AgentDetailSections (InspectorPanel right sidebar).
    // Opened via clicking an agent card; tested separately in InspectorPanel tests.
    // The inline failed recovery prompt should appear
    expect(html).toContain("Recovery");
  });

  it("shows commander conclusion and agent summary cards instead of inline process toggle", () => {
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

    // Commander conclusion is visible in the chat
    expect(html).toContain("Final conclusion: the project can be started with pnpm dev.");
    // Inline process toggle has been removed — details now live in right sidebar
    expect(html).toContain("Show process");
    // Detailed steps are only in the right sidebar, not inline
    expect(html).toContain("1/1");
  });

  it("renders code review diff preview in inspector panel", () => {
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

    // Permission request stays inline in the main chat
    expect(html).toContain("Approve code review continuation");
    expect(html).toContain("git diff --check");
    // Commander message still inline
    expect(html).toContain("Diff preview is ready.");
    // Code review diff moved to AgentDetailSections in right sidebar inspector
    expect(html).not.toContain("Code Review");
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
    expect(usedHtml).toContain("javis-send-button");
    expect(usedHtml.indexOf("javis-context-window-trigger")).toBeLessThan(
      usedHtml.indexOf("javis-send-button"),
    );
    expect(usedHtml).not.toContain("javis-context-window-copy");
    expect(usedHtml).not.toContain("javis-context-window-panel");
    expect(unusedHtml).toContain("aria-label=\"Context window: 0 / 128k (0%)\"");
  });

  it("infers MiMo primary model context as 1M instead of the default 128k", () => {
    const html = renderWorkbench({
      title: "MiMo context",
      userGoal: "Check context",
      status: "completed",
      commanderMessage: "Done.",
      plan: [],
      agents: [],
      logs: [],
      tokenUsage: {
        inputTokens: 200000,
        outputTokens: 200000,
        totalTokens: 400000,
        modelCalls: 1,
        byAgentKind: [],
      },
    }, {
      profiles: [
        {
          id: "primary-model",
          slot: "primary",
          displayName: "Primary",
          provider: "mimo",
          model: "mimo-v2.5-pro",
          apiKeyReference: "model.mimo",
          baseUrl: "https://api.xiaomimimo.com/v1",
          apiKey: "",
          capabilities: {
            vision: true,
            code: true,
            longContext: true,
          },
        },
      ],
      agentOverrides: {},
    });

    expect(html).toContain("aria-label=\"Context window: 400k / 1.0M (38%)\"");
  });

  it("renders Code Agent patch proposals and apply results", () => {
    const html = renderWorkbench({
      title: "Code Agent patch applied",
      userGoal: "Review code changes",
      status: "failed",
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

    // Code review details moved to AgentDetailSections (right sidebar InspectorPanel).
    // Commander message and failed recovery prompt stay inline in the main thread.
    expect(html).toContain("Approved patch was applied.");
    expect(html).toContain("Recovery");
    // Patch content is in the sidebar, not inline
    expect(html).not.toContain("diff --git");
  });

  it("opens thread artifact cards through the existing detail and tool actions", () => {
    Element.prototype.scrollIntoView = vi.fn();
    const onOpenFile = vi.fn();
    const onOpenDetail = vi.fn();
    const onOpenWorkspaceTool = vi.fn();
    const baseProps = {
      draftGoal: "Inspect task outputs",
      onDraftGoalChange: vi.fn(),
      onSubmitGoal: vi.fn(),
      onOpenDetail,
      onOpenFile,
      onOpenWorkspaceTool,
    };

    const { container, unmount } = render(
      <JavisWorkbench
        {...baseProps}
        task={{
          title: "Research report ready",
          userGoal: "Research Javis",
          status: "completed",
          commanderMessage: "Outputs are ready.",
          plan: [],
          agents: [],
          logs: [],
          documents: [{
            path: "E:/Javis/docs/brief.md",
            modifiedAt: "2026-06-06T00:00:00.000Z",
            sizeBytes: 1200,
            heading: "Brief",
            purpose: "Summarize requested context.",
          }],
          researchReport: {
            title: "Javis architecture notes",
            summary: "Research summary",
            rows: [{ claim: "Uses a workbench UI", evidence: "Source evidence", sourceUrl: "https://example.com" }],
            unknowns: [],
          },
        }}
      />,
    );

    const artifactCards = container.querySelectorAll(".javis-artifact-card");
    fireEvent.click(artifactCards[0]);
    expect(onOpenFile).toHaveBeenCalledWith("E:/Javis/docs/brief.md");
    fireEvent.click(artifactCards[1]);
    expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({ title: "Javis architecture notes" }));
    expect(onOpenWorkspaceTool).toHaveBeenCalledWith("sideChat");

    unmount();
    onOpenDetail.mockClear();
    onOpenWorkspaceTool.mockClear();

    const codeView = render(
      <JavisWorkbench
        {...baseProps}
        task={{
          title: "Patch proposal ready",
          userGoal: "Patch UI",
          status: "completed",
          commanderMessage: "Patch proposal is ready.",
          plan: [],
          agents: [],
          logs: [],
          codeProposedEdit: {
            proposalId: "proposal-1",
            workspacePath: "E:/Javis",
            summary: "Wire artifact card actions.",
            changedFiles: ["packages/ui/src/components/ThreadView.tsx"],
            patch: "diff --git",
            patchHash: "hash-1",
          },
        }}
      />,
    );
    fireEvent.click(codeView.container.querySelector(".javis-artifact-card")!);
    expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({ title: "Code patch proposal" }));
    expect(onOpenWorkspaceTool).toHaveBeenCalledWith("review");

    codeView.unmount();
    onOpenDetail.mockClear();
    onOpenWorkspaceTool.mockClear();

    const commandView = render(
      <JavisWorkbench
        {...baseProps}
        task={{
          title: "Command completed",
          userGoal: "Run checks",
          status: "completed",
          commanderMessage: "Command result is ready.",
          plan: [],
          agents: [],
          logs: [],
          commands: [{
            command: "pnpm --filter @javis/ui typecheck",
            cwd: "E:/Javis",
            exitCode: 0,
            stdout: "ok",
            stderr: "",
          }],
        }}
      />,
    );
    fireEvent.click(commandView.container.querySelector(".javis-artifact-card")!);
    expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({
      title: "pnpm --filter @javis/ui typecheck",
    }));
    expect(onOpenWorkspaceTool).toHaveBeenCalledWith("terminal");
  });

  it("passes the active agent session into right-rail tool actions", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const task: WorkbenchTask = {
      id: "task-session",
      title: "Workbench session",
      userGoal: "Use right rail tools",
      status: "completed",
      commanderMessage: "Tools are ready.",
      plan: [],
      agents: [],
      logs: [],
    };
    const baseProps = {
      activeHistoryEntryId: "thread-1",
      currentWorkspacePath: "E:/Javis",
      draftGoal: "Use tools",
      initialIsInspectorOpen: true,
      onDraftGoalChange: vi.fn(),
      onSubmitGoal: vi.fn(),
      task,
    };

    const onReview = vi.fn().mockResolvedValue({
      changedFiles: [],
      diffStat: "",
      diff: "",
      workspacePath: "E:/Javis",
    });
    let view = render(
      <JavisWorkbench
        {...baseProps}
        workspaceToolTabs={[{ id: "review-1", tool: "review" }]}
        onQuickActionReview={onReview}
      />,
    );
    fireEvent.click(getEnabledButton(view.container, ".javis-tool-action-btn"));
    await waitFor(() => expect(onReview).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "thread-1:task-session",
      workspaceRoot: "E:/Javis",
      activeTool: "review",
    })));
    view.unmount();

    const onTerminal = vi.fn().mockResolvedValue({
      command: "git status --short",
      cwd: "E:/Javis",
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    view = render(
      <JavisWorkbench
        {...baseProps}
        workspaceToolTabs={[{ id: "terminal-1", tool: "terminal" }]}
        onQuickActionTerminal={onTerminal}
      />,
    );
    fireEvent.change(view.container.querySelector(".javis-tool-terminal-bar input")!, {
      target: { value: "git status --short" },
    });
    fireEvent.submit(view.container.querySelector(".javis-tool-terminal-bar")!);
    await waitFor(() => expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "thread-1:task-session",
      workspaceRoot: "E:/Javis",
      activeTool: "terminal",
    }), "git status --short"));
    view.unmount();

    const onBrowser = vi.fn().mockResolvedValue({
      url: "http://localhost:5173",
      title: "Local app",
      loadState: "snapshot",
    });
    view = render(
      <JavisWorkbench
        {...baseProps}
        workspaceToolTabs={[{ id: "browser-1", tool: "browser" }]}
        onQuickActionBrowser={onBrowser}
      />,
    );
    fireEvent.change(view.container.querySelector(".javis-tool-url-input")!, {
      target: { value: "localhost:5173" },
    });
    fireEvent.submit(view.container.querySelector(".javis-tool-browser-nav")!);
    await waitFor(() => expect(onBrowser).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "thread-1:task-session",
      workspaceRoot: "E:/Javis",
      activeTool: "browser",
    }), { action: "navigate", url: "http://localhost:5173" }));
    view.unmount();

    const onBrowserRefresh = vi.fn(async (_session: unknown, request: string | { action?: string }) => ({
      url: "http://localhost:5173",
      title: "Local app",
      loadState: typeof request !== "string" && request.action === "refresh" ? "snapshot" : "ready",
      sidecarRunning: true,
      canGoBack: true,
      canGoForward: false,
    }));
    view = render(
      <JavisWorkbench
        {...baseProps}
        workspaceToolTabs={[{ id: "browser-1", tool: "browser" }]}
        onQuickActionBrowser={onBrowserRefresh}
      />,
    );
    await waitFor(() => expect(view.container.textContent).toContain("Local app"));
    expect(view.container.querySelector(".javis-tool-browser-frame")).toBeNull();
    fireEvent.click(view.getByLabelText("Refresh"));
    await waitFor(() => expect(onBrowserRefresh).toHaveBeenCalledWith(expect.anything(), {
      action: "refresh",
      url: "http://localhost:5173",
    }));
    const details = view.container.querySelector<HTMLDetailsElement>(".javis-tool-browser-fallback")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(view.container.querySelector(".javis-tool-browser-frame")).not.toBeNull();
    view.unmount();

    const onSideChat = vi.fn().mockResolvedValue("Done");
    view = render(
      <JavisWorkbench
        {...baseProps}
        workspaceToolTabs={[{ id: "side-chat-1", tool: "sideChat" }]}
        onQuickActionSideChat={onSideChat}
      />,
    );
    fireEvent.change(view.container.querySelector(".javis-tool-sidechat-composer textarea")!, {
      target: { value: "Summarize this workspace" },
    });
    fireEvent.submit(view.container.querySelector(".javis-tool-sidechat-composer")!);
    await waitFor(() => expect(onSideChat).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "thread-1:task-session",
      workspaceRoot: "E:/Javis",
      activeTool: "sideChat",
    }), "Summarize this workspace"));
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

  it("renders sidebar nav metadata, status dots, and child items", () => {
    const html = renderToStaticMarkup(
      <JavisWorkbench
        draftGoal="Inspect project"
        historyEntries={[
          {
            id: "history-failed",
            title: "Failed import recovery",
            status: "failed",
            userGoal: "Recover import",
            updatedAt: "2026-05-23T00:00:00.000Z",
            workspacePath: "E:/Javis",
          },
        ]}
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        sidebarNavItems={[
          {
            viewId: "documents",
            icon: "D",
            label: "Local knowledge",
            groupLabel: "Workspace tools",
            order: 1,
            meta: "2 roots",
            status: "running",
            children: [
              {
                label: "Design docs",
                path: "E:/Javis/docs",
                meta: "Updated today",
                status: "completed",
              },
            ],
          },
        ]}
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

    expect(html).toContain("Local knowledge");
    expect(html).toContain("Workspace tools");
    expect(html).toContain("2 roots");
    expect(html).toContain("Design docs");
    expect(html).toContain("Updated today");
    expect(html).toContain("javis-sidebar-status-dot status-running");
    expect(html).toContain("javis-sidebar-status-dot status-completed");
    expect(html).toContain("javis-history-entry status-failed");
    expect(html).toContain("title=");
  });

  it("does not mark new chat active while a history entry is selected", () => {
    const html = renderToStaticMarkup(
      <JavisWorkbench
        activeHistoryEntryId="history-1"
        activeView="chat"
        draftGoal=""
        historyEntries={[
          {
            id: "history-1",
            title: "Answered",
            status: "completed",
            userGoal: "Hello",
            updatedAt: "2026-05-23T00:00:00.000Z",
            workspacePath: "E:/Javis",
          },
        ]}
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={{
          id: "history-1",
          title: "Answered",
          userGoal: "Hello",
          status: "completed",
          commanderMessage: "Hi",
          plan: [],
          agents: [],
          logs: [],
        }}
      />,
    );

    expect(html).toContain("javis-history-entry status-completed active");
    expect(html).not.toContain("javis-nav-item active\"><span class=\"javis-nav-icon icon-chat\">+</span>");
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
    expect(html).toContain("聊天");
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
        activeComposeMode="project"
        onBrowseWorkspacePath={vi.fn()}
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        onUseWorkspacePath={vi.fn()}
        onWorkspacePathChange={vi.fn()}
        recentWorkspacePaths={["E:/Javis", "F:/Other"]}
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

    expect(html).toContain("Current workspace");
    expect(html).toContain("Browse");
    expect(html).toContain("value=\"E:/Javis\"");
    expect(html).toContain("Recent workspaces");
    expect(html).toContain("F:/Other");
    expect(html).toContain("aria-label=\"Remove: E:/Javis\"");
    expect(html).toContain("What should Javis work on?");
    expect(html).toContain("Ask Javis to do something...");
  });

  it("hides workspace controls in new chat mode", () => {
    const html = renderToStaticMarkup(
      <JavisWorkbench
        currentWorkspacePath="E:/Javis"
        draftGoal="Inspect project"
        onDraftGoalChange={vi.fn()}
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
        recentWorkspacePaths={["E:/Javis", "F:/Other"]}
      />,
    );

    expect(html).not.toContain("Current workspace");
    expect(html).not.toContain("Recent workspaces");
    expect(html).toContain("javis-main new-chat");
    expect(html).toContain("What do you want to chat about today?");
    expect(html).toContain("What do you want to talk about?");
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
  });

  it("renders localized workspace controls", () => {
    const html = renderToStaticMarkup(
      <JavisWorkbench
        currentWorkspacePath="E:/Javis"
        draftGoal="Inspect project"
        activeComposeMode="project"
        locale={zhCNWorkbenchLocale}
        onBrowseWorkspacePath={vi.fn()}
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        onUseWorkspacePath={vi.fn()}
        onWorkspacePathChange={vi.fn()}
        recentWorkspacePaths={["E:/Javis"]}
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

    expect(html).toContain("选择文件夹");
    expect(html).toContain("aria-label=\"移除: E:/Javis\"");
    expect(html).not.toContain(">Browse<");
    expect(html).not.toContain("Remove: E:/Javis");
    expect(html).toContain("今天想让 Javis 做什么？");
    expect(html).toContain("让 Javis 做点什么...");
  });
  it("quotes and withdraws a conversation message from its action buttons", () => {
    const onDraftGoalChange = vi.fn();
    const onConversationMessagesChange = vi.fn();
    const view = render(
      <JavisWorkbench
        draftGoal=""
        onConversationMessagesChange={onConversationMessagesChange}
        onDraftGoalChange={onDraftGoalChange}
        onSubmitGoal={vi.fn()}
        task={{
          id: "chat-actions",
          title: "Chat actions",
          userGoal: "Hello Javis",
          status: "completed",
          commanderMessage: "Hello back",
          plan: [],
          agents: [],
          logs: [],
          conversationMessages: [
            { id: "message-user", role: "user", content: "Hello Javis" },
            { id: "message-assistant", role: "assistant", content: "Hello back" },
          ],
        }}
      />,
    );

    fireEvent.click(getMessageActionButton(view.container, "Quote", 0));
    expect(onDraftGoalChange).toHaveBeenCalledWith("> Quote User: Hello Javis\n");

    fireEvent.click(getMessageActionButton(view.container, "Withdraw", 0));
    expect(onConversationMessagesChange).toHaveBeenCalledWith("chat-actions", [
      { id: "message-assistant", role: "assistant", content: "Hello back" },
    ]);
  });

  it("edits a conversation message from its action button", () => {
    const onConversationMessagesChange = vi.fn();
    const view = render(
      <JavisWorkbench
        draftGoal=""
        onConversationMessagesChange={onConversationMessagesChange}
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={{
          id: "chat-edit",
          title: "Chat edit",
          userGoal: "Original question",
          status: "completed",
          commanderMessage: "Original answer",
          plan: [],
          agents: [],
          logs: [],
          conversationMessages: [
            { id: "message-user", role: "user", content: "Original question" },
            { id: "message-assistant", role: "assistant", content: "Original answer" },
          ],
        }}
      />,
    );

    fireEvent.click(getMessageActionButton(view.container, "Edit", 1));
    fireEvent.change(view.getByLabelText("Edit message content"), {
      target: { value: "Updated answer" },
    });
    fireEvent.click(view.getByText("Save"));

    expect(onConversationMessagesChange).toHaveBeenCalledWith("chat-edit", [
      { id: "message-user", role: "user", content: "Original question" },
      { id: "message-assistant", role: "assistant", content: "Updated answer" },
    ]);
  });

  it("filters classified apps and opens them on click", () => {
    const onOpenFile = vi.fn();
    const view = render(
      <JavisWorkbench
        activeView="apps"
        appCategoryStats={[{ category: "Productivity", count: 1 }, { category: "Games", count: 1 }]}
        draftGoal=""
        installedApps={[
          { name: "Calendar", path: "C:/Apps/calendar.exe", category: "Productivity", tags: ["schedule"] },
          { name: "Game Box", path: "C:/Apps/game.exe", category: "Games", tags: ["play"] },
        ]}
        onDraftGoalChange={vi.fn()}
        onOpenFile={onOpenFile}
        onSubmitGoal={vi.fn()}
        task={createIdleTask()}
      />,
    );

    clickResourceTab(view.container, "Productivity(1)");
    expect(within(view.container).getByText("Calendar")).toBeTruthy();
    expect(within(view.container).queryByText("Game Box")).toBeNull();

    const appButton = within(view.container).getByText("Calendar").closest("button");
    expect(appButton).toBeTruthy();
    fireEvent.click(appButton!);
    expect(onOpenFile).toHaveBeenCalledWith("C:/Apps/calendar.exe");
  });

  it("lets users set a custom app category from the context menu", () => {
    const onUpdateAppCategory = vi.fn();
    const view = render(
      <JavisWorkbench
        activeView="apps"
        appCategoryStats={[{ category: "Productivity", count: 1 }]}
        draftGoal=""
        installedApps={[
          { name: "Calendar", path: "C:/Apps/calendar.exe", category: "Productivity", tags: ["schedule"] },
          { name: "Game Box", path: "C:/Apps/game.exe", category: "Games", tags: ["play"] },
        ]}
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        onUpdateAppCategory={onUpdateAppCategory}
        task={createIdleTask()}
      />,
    );

    const appButton = within(view.container).getByText("Calendar").closest("button");
    expect(appButton).toBeTruthy();
    fireEvent.contextMenu(appButton!, { clientX: 120, clientY: 90 });
    fireEvent.change(view.getByLabelText("自定义分类"), {
      target: { value: "Work Tools" },
    });
    fireEvent.click(view.getByText("保存"));

    expect(onUpdateAppCategory).toHaveBeenCalledWith("C:/Apps/calendar.exe", "Work Tools");
  });

  it("registers sidebar resource filters from AI classification results", () => {
    const view = render(
      <JavisWorkbench
        activeView="documents"
        draftGoal=""
        installedApps={[
          { name: "Calendar", path: "C:/Apps/calendar.exe", category: "Productivity" },
        ]}
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={createIdleTask()}
        userDocuments={[
          { name: "Contract.pdf", path: "E:/Docs/Contract.pdf", isDir: false, category: "Contracts" },
          { name: "Budget.xlsx", path: "E:/Docs/Budget.xlsx", isDir: false, category: "Finance" },
        ]}
        userImages={[
          { name: "Trip.png", path: "E:/Photos/Trip.png", isDir: false, category: "Travel" },
        ]}
      />,
    );

    expect(view.queryByText("文档识别")).toBeNull();
    expect(view.getAllByText("Contracts(1)").length).toBeGreaterThan(0);
    expect(view.getAllByText("Finance(1)").length).toBeGreaterThan(0);

    const financeSidebarItem = view.getAllByText("Finance(1)")
      .map((node) => node.closest(".javis-nav-subitem"))
      .find((node): node is HTMLElement => node instanceof HTMLElement);
    expect(financeSidebarItem).toBeTruthy();
    fireEvent.click(financeSidebarItem!);
    expect(within(view.container).getByText("Budget.xlsx")).toBeTruthy();
    expect(within(view.container).queryByText("Contract.pdf")).toBeNull();

    const appsNavItem = view.container.querySelector(".icon-apps")?.closest(".javis-nav-item");
    expect(appsNavItem).toBeTruthy();
    fireEvent.click(appsNavItem!);
    expect(view.getAllByText("Productivity(1)").length).toBeGreaterThan(0);

    const galleryNavItem = view.container.querySelector(".icon-gallery")?.closest(".javis-nav-item");
    expect(galleryNavItem).toBeTruthy();
    fireEvent.click(galleryNavItem!);
    expect(within(view.container).getByText("Travel(1)")).toBeTruthy();
  });

  it("filters classified documents and opens them only on double click", async () => {
    const onOpenFile = vi.fn();
    const view = render(
      <JavisWorkbench
        activeView="documents"
        draftGoal=""
        onDraftGoalChange={vi.fn()}
        onOpenFile={onOpenFile}
        onSubmitGoal={vi.fn()}
        task={createIdleTask()}
        userDocuments={[
          { name: "Contract.pdf", path: "E:/Docs/Contract.pdf", isDir: false, category: "Contracts", tags: ["signed"] },
          { name: "Budget.xlsx", path: "E:/Docs/Budget.xlsx", isDir: false, category: "Finance", tags: ["money"] },
        ]}
      />,
    );

    clickResourceTab(view.container, "Contracts(1)");
    await waitFor(() => {
      expect(within(view.container).getByText("Contract.pdf")).toBeTruthy();
      expect(within(view.container).queryByText("Budget.xlsx")).toBeNull();
    });

    const docButton = within(view.container).getByText("Contract.pdf").closest("button");
    expect(docButton).toBeTruthy();
    fireEvent.click(docButton!);
    expect(onOpenFile).not.toHaveBeenCalled();
    fireEvent.doubleClick(docButton!);
    expect(onOpenFile).toHaveBeenCalledWith("E:/Docs/Contract.pdf");
  });

  it("filters classified gallery images and opens them only on double click", () => {
    const onOpenFile = vi.fn();
    const view = render(
      <JavisWorkbench
        activeView="gallery"
        draftGoal=""
        onDraftGoalChange={vi.fn()}
        onOpenFile={onOpenFile}
        onSubmitGoal={vi.fn()}
        task={createIdleTask()}
        userImages={[
          { name: "Trip.png", path: "E:/Photos/Trip.png", isDir: false, category: "Travel", tags: ["beach"], thumbnailUrl: "asset://localhost/trip.png" },
          { name: "Receipt.jpg", path: "E:/Photos/Receipt.jpg", isDir: false, category: "Finance", tags: ["tax"] },
        ]}
      />,
    );

    clickResourceTab(view.container, "Travel(1)");
    expect(within(view.container).getByText("Trip.png")).toBeTruthy();
    expect(within(view.container).queryByText("Receipt.jpg")).toBeNull();
    expect(view.container.querySelector<HTMLImageElement>(".javis-gallery-image")?.src).toContain("asset://localhost/trip.png");

    const imageButton = within(view.container).getByText("Trip.png").closest("button");
    expect(imageButton).toBeTruthy();
    fireEvent.click(imageButton!);
    expect(onOpenFile).not.toHaveBeenCalled();
    fireEvent.doubleClick(imageButton!);
    expect(onOpenFile).toHaveBeenCalledWith("E:/Photos/Trip.png");
  });
});

function renderWorkbench(
  task: WorkbenchTask,
  modelConfiguration?: Parameters<typeof JavisWorkbench>[0]["modelConfiguration"],
  props: Partial<Parameters<typeof JavisWorkbench>[0]> = {},
): string {
  return renderToStaticMarkup(
    <JavisWorkbench
      draftGoal="Organize PDFs in Downloads"
      onDraftGoalChange={vi.fn()}
      onPermissionDecision={vi.fn()}
      onSubmitGoal={vi.fn()}
      modelConfiguration={modelConfiguration}
      task={task}
      {...props}
    />,
  );
}

function createIdleTask(): WorkbenchTask {
  return {
    id: "task-idle",
    title: "Ready",
    userGoal: "Waiting",
    status: "created",
    commanderMessage: "Ready",
    plan: [],
    agents: [],
    logs: [],
  };
}

function createOrchestrationTask(): WorkbenchTask {
  return {
    id: "task-progress-rich",
    title: "Inspecting project",
    userGoal: "Inspect project",
    status: "running",
    commanderMessage: "Commander is coordinating a project inspection.",
    plan: [
      { id: "scan", title: "Scan files", status: "completed", durationMs: 1240 },
      { id: "inspect", title: "Inspect package scripts", status: "running" },
    ],
    agents: [
      { id: "agent-file", name: "File Agent", role: "Reads files", status: "completed", task: "Scanned files" },
      { id: "agent-shell", name: "Shell Agent", role: "Checks commands", status: "running", task: "Checking scripts" },
    ],
    logs: [],
  };
}

function getEnabledButton(container: HTMLElement, selector: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>(selector))
    .find((candidate) => !candidate.disabled);
  if (!button) {
    throw new Error(`No enabled button found for ${selector}`);
  }
  return button;
}

function clickResourceTab(container: HTMLElement, label: string): void {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>(".javis-resource-tabs button"))
    .find((candidate) => candidate.textContent === label);
  if (!button) {
    throw new Error(`No resource tab found for ${label}`);
  }
  fireEvent.click(button);
}

function getMessageActionButton(
  container: HTMLElement,
  label: string,
  index: number,
): HTMLButtonElement {
  const buttons = Array.from(
    container.querySelectorAll<HTMLButtonElement>(".javis-message-actions button"),
  ).filter((button) => button.textContent === label);
  const button = buttons[index];
  if (!button) {
    throw new Error(`No message action button found for ${label} at ${index}`);
  }
  return button;
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
