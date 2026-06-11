import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JavisWorkbench,
  createWorkbenchHandoffReportArtifacts,
  filterWorkbenchHistoryEntries,
  zhCNWorkbenchLocale,
} from "./index";
import { AgentDetailSections } from "./components/AgentDetailSections";
import { HELP_ME_DECIDE_ANSWER } from "./components/TaskSections";
import { defaultWorkbenchLocale } from "./locale";
import { normalizeWorkspacePath } from "./utils";
import type { WorkbenchTask } from "./index";

afterEach(() => {
  cleanup();
});

describe("JavisWorkbench permission cards", () => {
  it("renders the current Goal panel with lifecycle actions", () => {
    const html = renderWorkbench(createIdleTask(), undefined, {
      currentGoal: {
        id: "goal-1",
        objective: "Implement Goal MVP",
        acceptanceCriteria: ["Persist current goal", "Continue until verified"],
        status: "active",
        workspacePath: "E:/Javis",
        taskIds: ["task-1"],
        completedChecks: ["Core state added"],
        blockedStreak: 0,
        runCount: 1,
        maxRunCount: 8,
        createdAt: "2026-06-09T00:00:00.000Z",
        updatedAt: "2026-06-09T00:01:00.000Z",
      },
      currentGoalEvaluations: [{
        id: "eval-1",
        goalId: "goal-1",
        taskId: "task-1",
        decision: "continue",
        confidence: "medium",
        satisfiedCriteria: ["Core state added"],
        unsatisfiedCriteria: ["Timeline UI"],
        evidence: ["Verifier requested another run"],
        completedChecks: ["Core state added"],
        reason: "UI is incomplete.",
        createdAt: "2026-06-09T00:02:00.000Z",
      }],
      currentGoalEvents: [{
        id: "event-1",
        goalId: "goal-1",
        taskId: "task-1",
        type: "evaluated",
        message: "Verifier requested another run.",
        createdAt: "2026-06-09T00:03:00.000Z",
      }],
      onPauseGoal: vi.fn(),
      onCompleteGoal: vi.fn(),
      onClearGoal: vi.fn(),
    });

    expect(html).toContain("javis-goal-panel");
    expect(html).toContain("Implement Goal MVP");
    expect(html).toContain("Core state added");
    expect(html).toContain("Timeline UI");
    expect(html).toContain("Verifier requested another run");
    expect(html).toContain("1/8");
    expect(html).toContain("Pause");
    expect(html).toContain("Complete");
    expect(html).toContain("Clear");
  });

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

  it("renders a Computer Use guard and routes Escape to emergency stop", () => {
    const onEmergencyStopTask = vi.fn();
    const onStopTask = vi.fn();
    const view = render(
      <JavisWorkbench
        draftGoal=""
        isTaskActive
        onDraftGoalChange={vi.fn()}
        onEmergencyStopTask={onEmergencyStopTask}
        onStopTask={onStopTask}
        onSubmitGoal={vi.fn()}
        task={{
          id: "task-computer-use",
          title: "Computer Use task",
          userGoal: "Open calculator",
          status: "running",
          commanderMessage: "Computer Use: observing",
          plan: [{
            id: "computer-use-loop",
            title: "Computer Use action loop",
            status: "running",
            agentKind: "computer",
          }],
          agents: [{
            id: "agent-computer",
            name: "Computer Agent",
            role: "Desktop automation",
            status: "running",
            task: "Computer Use: observing",
          }],
          logs: [],
        }}
      />,
    );

    expect(view.container.querySelector(".javis-computer-use-guard")?.textContent).toContain("Computer Use");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onEmergencyStopTask).toHaveBeenCalledTimes(1);
    expect(onStopTask).not.toHaveBeenCalled();
  });

  it("does not render the Computer Use guard for read-only Computer Agent work", () => {
    const view = render(
      <JavisWorkbench
        draftGoal=""
        isTaskActive
        onDraftGoalChange={vi.fn()}
        onEmergencyStopTask={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={{
          id: "task-local-search",
          title: "Find a local document",
          userGoal: "Find report.pdf",
          status: "running",
          commanderMessage: "Searching local documents",
          plan: [{
            id: "search-computer",
            title: "Computer Agent searches indexed local locations",
            status: "running",
            agentKind: "computer",
          }],
          agents: [{
            id: "agent-computer",
            name: "Computer Agent",
            role: "Local file search",
            status: "running",
            task: "Searching local documents",
          }],
          logs: [],
        }}
      />,
    );

    expect(view.container.querySelector(".javis-computer-use-guard")).toBeNull();
  });

  it("does not render the Computer Use guard for generic desktop or screenshot text", () => {
    const view = render(
      <JavisWorkbench
        draftGoal=""
        isTaskActive
        onDraftGoalChange={vi.fn()}
        onEmergencyStopTask={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={{
          id: "task-image-review",
          title: "Review desktop screenshot",
          userGoal: "Summarize a screenshot",
          status: "running",
          commanderMessage: "Analyzing a desktop screenshot for documentation.",
          plan: [{
            id: "screenshot-analysis",
            title: "Inspect screenshot content",
            status: "running",
          }],
          agents: [],
          logs: [{
            id: "log-screenshot",
            kind: "info",
            title: "desktop screenshot",
            detail: "Mouse and keyboard labels are visible in the image.",
          }],
          executionTrace: {
            taskId: "task-image-review",
            startedAt: "2026-06-09T00:00:00.000Z",
            totalWallTimeMs: 1200,
            steps: [{
              stepId: "screenshot-analysis",
              agentKind: "computer",
              wallTimeMs: 1200,
              status: "completed",
            }],
          },
        }}
      />,
    );

    expect(view.container.querySelector(".javis-computer-use-guard")).toBeNull();
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

  it("renders user skills and MCP servers with enable and delete controls", () => {
    const onToggleSkillEnabled = vi.fn();
    const onDeleteSkill = vi.fn();
    const view = render(
      <JavisWorkbench
        activeView="skills"
        draftGoal="Inspect project"
        onDeleteSkill={onDeleteSkill}
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        onToggleSkillEnabled={onToggleSkillEnabled}
        skillEntries={[
          {
            id: "skill-codex:godot",
            name: "godot",
            description: "Godot development reference",
            category: "skill",
            agentOwners: ["codex skill"],
            enabled: true,
            source: "user",
            path: "C:/Users/example/.codex/skills/godot",
            toggleable: true,
            removable: true,
          },
          {
            id: "mcp-filesystem",
            name: "filesystem",
            description: "stdio · npx",
            category: "mcp",
            agentOwners: [],
            enabled: false,
            source: "mcp",
            toggleable: true,
            removable: true,
          },
          {
            id: "codex-mcp-manual",
            name: "manual",
            description: "stdio · npx",
            category: "mcp",
            agentOwners: ["codex MCP"],
            enabled: true,
            source: "mcp",
            toggleable: true,
            removable: false,
          },
          {
            id: "codex-mcp-installed",
            name: "installed",
            description: "stdio · npx",
            category: "mcp",
            agentOwners: ["codex MCP"],
            enabled: true,
            source: "mcp",
            toggleable: true,
            removable: true,
          },
        ]}
        task={createIdleTask()}
      />,
    );

    expect(view.getByText("Codex Skills")).toBeTruthy();
    expect(view.getByText("godot")).toBeTruthy();
    expect(view.getByText("filesystem")).toBeTruthy();
    const toggles = view.container.querySelectorAll<HTMLInputElement>(".javis-skill-toggle input");
    expect(toggles).toHaveLength(4);
    const deleteButtons = view.getAllByText("删除");
    expect(deleteButtons).toHaveLength(3);

    fireEvent.click(toggles[0]!);
    fireEvent.click(toggles[1]!);
    fireEvent.click(toggles[2]!);
    fireEvent.click(deleteButtons[0]!);
    fireEvent.click(deleteButtons[2]!);

    expect(onToggleSkillEnabled).toHaveBeenNthCalledWith(1, "skill-codex:godot", false);
    expect(onToggleSkillEnabled).toHaveBeenNthCalledWith(2, "mcp-filesystem", true);
    expect(onToggleSkillEnabled).toHaveBeenNthCalledWith(3, "codex-mcp-manual", false);
    expect(onDeleteSkill).toHaveBeenCalledWith("skill-codex:godot");
    expect(onDeleteSkill).toHaveBeenCalledWith("codex-mcp-installed");
  });

  it("runs bulk disable and delete actions from my skills", () => {
    const onDisableAllSkills = vi.fn();
    const onDeleteAllSkills = vi.fn();
    const view = render(
      <JavisWorkbench
        activeView="skills"
        draftGoal="Inspect project"
        onDeleteAllSkills={onDeleteAllSkills}
        onDisableAllSkills={onDisableAllSkills}
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        skillEntries={[
          {
            id: "skill-codex:godot",
            name: "godot",
            description: "Godot development reference",
            category: "skill",
            agentOwners: ["codex skill"],
            enabled: true,
            source: "user",
            toggleable: true,
            removable: true,
          },
          {
            id: "mcp-filesystem",
            name: "filesystem",
            description: "stdio via npx",
            category: "mcp",
            agentOwners: [],
            enabled: true,
            source: "mcp",
            toggleable: true,
            removable: true,
          },
        ]}
        task={createIdleTask()}
      />,
    );

    const bulkButtons = view.container.querySelectorAll<HTMLButtonElement>(".javis-skill-bulk-button");
    expect(bulkButtons).toHaveLength(2);
    expect(bulkButtons[0]!.disabled).toBe(false);
    expect(bulkButtons[1]!.disabled).toBe(false);

    fireEvent.click(bulkButtons[0]!);
    fireEvent.click(bulkButtons[1]!);

    expect(onDisableAllSkills).toHaveBeenCalledOnce();
    expect(onDeleteAllSkills).toHaveBeenCalledOnce();
  });

  it("opens skill market result source links from the detail panel", () => {
    const onOpenUrl = vi.fn();
    const view = render(
      <JavisWorkbench
        activeView="skills"
        draftGoal="Inspect project"
        initialIsInspectorOpen
        onDraftGoalChange={vi.fn()}
        onOpenUrl={onOpenUrl}
        onSubmitGoal={vi.fn()}
        skillSearchResults={[{
          id: "result-1",
          title: "godot-mcp",
          description: "Godot MCP server for editor automation.",
          url: "https://github.com/example/godot-mcp",
          source: "github",
          kind: "mcp",
        }]}
        task={createIdleTask()}
      />,
    );

    const skillSubitems = view.container.querySelectorAll<HTMLButtonElement>(".javis-nav-subitem");
    fireEvent.click(skillSubitems[1]!);
    fireEvent.click(view.getByText("godot-mcp"));

    const link = view.getByRole("link", { name: "https://github.com/example/godot-mcp" });
    expect(link).toBeTruthy();
    fireEvent.click(link);

    expect(onOpenUrl).toHaveBeenCalledWith("https://github.com/example/godot-mcp");
  });

  it("installs skill market results from the market card", () => {
    const onInstallSkillMarketResult = vi.fn();
    const result = {
      id: "result-1",
      title: "example/godot-skill",
      description: "Godot skill.",
      url: "https://github.com/example/godot-skill",
      source: "github",
      kind: "skill" as const,
    };
    const view = render(
      <JavisWorkbench
        activeView="skills"
        draftGoal="Inspect project"
        onDraftGoalChange={vi.fn()}
        onInstallSkillMarketResult={onInstallSkillMarketResult}
        onSubmitGoal={vi.fn()}
        skillSearchResults={[result]}
        task={createIdleTask()}
      />,
    );

    const skillSubitems = view.container.querySelectorAll<HTMLButtonElement>(".javis-nav-subitem");
    fireEvent.click(skillSubitems[1]!);
    fireEvent.click(view.container.querySelector<HTMLButtonElement>(".javis-skill-action-button")!);

    expect(onInstallSkillMarketResult).toHaveBeenCalledWith(result);
  });

  it("refreshes and opens personalized skill market suggestions", () => {
    const onRefreshSkillMarketSuggestions = vi.fn();
    const onSearchSkillMarket = vi.fn();
    const onOpenDetail = vi.fn();
    const view = render(
      <JavisWorkbench
        activeView="skills"
        draftGoal="Inspect project"
        onDraftGoalChange={vi.fn()}
        onOpenDetail={onOpenDetail}
        onRefreshSkillMarketSuggestions={onRefreshSkillMarketSuggestions}
        onSearchSkillMarket={onSearchSkillMarket}
        onSubmitGoal={vi.fn()}
        skillMarketSuggestions={[{
          title: "example/memory-fit-agent",
          description: "GitHub 热门项目 · 贴合：RAG",
          url: "https://github.com/example/memory-fit-agent",
          source: "github-cli",
        }]}
        task={createIdleTask()}
      />,
    );

    const skillSubitems = view.container.querySelectorAll<HTMLButtonElement>(".javis-nav-subitem");
    fireEvent.click(skillSubitems[1]!);

    expect(view.container.textContent).not.toContain("RAG 知识库");
    expect(view.container.querySelectorAll(".javis-hot-skill-card")).toHaveLength(1);
    const refreshButton = within(view.container).getByRole("button", { name: "基于 GitHub 热榜和记忆侧写刷新推荐" });
    fireEvent.click(refreshButton);
    expect(onRefreshSkillMarketSuggestions).toHaveBeenCalledWith("github", "skill");

    fireEvent.click(view.container.querySelector<HTMLButtonElement>(".javis-hot-skill-card")!);

    expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({
      title: "example/memory-fit-agent",
      url: "https://github.com/example/memory-fit-agent",
    }));
    expect(onSearchSkillMarket).toHaveBeenCalledWith("example/memory-fit-agent", "github", "skill");
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

  it("shows capability score signals in selected agent details", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const task = createOrchestrationTask();
    task.agents = task.agents.map((agent) => agent.id === "agent-shell"
      ? {
          ...agent,
          capabilityScore: {
            score: 65,
            status: "usable",
            implemented: true,
            permissionReady: true,
            qaPassed: false,
            liveVerified: false,
            recentFailureRate: 0.25,
            highestPermissionLevel: "read",
            capabilityTags: ["shell_readonly"],
            evidenceRefs: [
              "docs/qa/shell.json",
              "docs/qa/live-shell.json",
              "docs/qa/recent-failure.json",
              "docs/qa/extra.json",
            ],
            gaps: [
              "product QA evidence is not marked as passed",
              "live workflow verification is not marked as passed",
            ],
          },
        }
      : agent);
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
      expect(view.container.querySelector(".javis-selected-agent-detail")?.textContent)
        .toContain("Shell Agent");
    });

    const detailsText = view.container.querySelector(".javis-task-overview")?.textContent ?? "";
    expect(detailsText).toContain("Capability score");
    expect(detailsText).toContain("65/100 usable");
    expect(detailsText).toContain("Implementedpass");
    expect(detailsText).toContain("Permissionpassread");
    expect(detailsText).toContain("QApending");
    expect(detailsText).toContain("Livepending");
    expect(detailsText).toContain("Evidence4");
    expect(detailsText).toContain("docs/qa/shell.json");
    expect(detailsText).toContain("docs/qa/live-shell.json");
    expect(detailsText).toContain("docs/qa/recent-failure.json");
    expect(detailsText).toContain("+1 more");
    expect(detailsText).toContain("Repair priorityhigh");
    expect(detailsText).toContain("live evidence, QA evidence, recent failures");
    expect(detailsText).toContain("product QA evidence is not marked as passed");
  });

  it("replaces selected agent details when a workspace resource is clicked", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const baseProps = {
      draftGoal: "Inspect project",
      onDraftGoalChange: vi.fn(),
      onSubmitGoal: vi.fn(),
      task: createOrchestrationTask(),
      userDocuments: [
        { name: "Notes.md", path: "E:/Javis/Notes.md", isDir: false, extension: "md" },
      ],
    };
    const view = render(
      <JavisWorkbench {...baseProps} />,
    );

    fireEvent.click(view.container.querySelector(".javis-agent-run-card.status-running")!);
    await waitFor(() => {
      expect(view.container.querySelector(".javis-selected-agent-detail")?.textContent)
        .toContain("Shell Agent");
    });

    view.rerender(<JavisWorkbench {...baseProps} activeView="documents" />);
    const docButton = within(view.container).getByText("Notes.md").closest("button");
    expect(docButton).toBeTruthy();
    fireEvent.click(docButton!);

    await waitFor(() => {
      expect(view.container.querySelector(".javis-selected-agent-detail")).toBeNull();
      expect(view.container.querySelector(".javis-review-card")?.textContent).toContain("E:/Javis/Notes.md");
    });
  });

  it("replaces an open resource detail when a workspace tool is launched", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const view = render(
      <JavisWorkbench
        activeView="documents"
        draftGoal="Inspect project"
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={createOrchestrationTask()}
        userDocuments={[
          { name: "Notes.md", path: "E:/Javis/Notes.md", isDir: false, extension: "md" },
        ]}
      />,
    );

    const docButton = within(view.container).getByText("Notes.md").closest("button");
    expect(docButton).toBeTruthy();
    fireEvent.click(docButton!);
    await waitFor(() => {
      expect(view.container.querySelector(".javis-review-card")?.textContent).toContain("E:/Javis/Notes.md");
    });

    const browserTool = view.container.querySelector<HTMLButtonElement>(".javis-inspector-quick-card.action-browser");
    expect(browserTool).toBeTruthy();
    fireEvent.click(browserTool!);

    await waitFor(() => {
      expect(view.container.textContent).not.toContain("E:/Javis/Notes.md");
      expect(view.container.querySelector(".javis-tool-panel.browser-panel")).not.toBeNull();
      expect(view.container.querySelector(".javis-tool-tab.active")?.textContent).toContain("Browser");
    });
  });

  it("shows local vision status in computer agent execution trace details", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const task: WorkbenchTask = {
      ...createOrchestrationTask(),
      plan: [
        { id: "scan", title: "Scan files", status: "completed", durationMs: 1240, agentId: "agent-file" },
        {
          id: "use-computer",
          title: "Use desktop",
          status: "completed",
          agentId: "agent-computer",
          agentKind: "computer",
        },
      ],
      agents: [
        { id: "agent-file", name: "File Agent", role: "Reads files", status: "completed", task: "Scanned files" },
        {
          id: "agent-computer",
          name: "Computer Agent",
          role: "Controls desktop",
          status: "completed",
          task: "Clicked target",
        },
      ],
      executionTrace: {
        taskId: "task-progress-rich",
        startedAt: "2026-06-08T00:00:00.000Z",
        completedAt: "2026-06-08T00:00:04.250Z",
        totalWallTimeMs: 4250,
        steps: [{
          stepId: "use-computer:computer-1",
          agentKind: "computer",
          toolName: "computer.click",
          wallTimeMs: 80,
          status: "completed",
          localVision: {
            mode: "disabled",
            detectionCount: 0,
            promptCandidateCount: 0,
            cropVlmCalled: true,
            fullScreenshotVlmSkipped: true,
            consecutiveTimeouts: 2,
            disabledReason: "timeout",
            selectedCandidateSource: ["uia", "yolo"],
            actionRisk: "medium",
            actionSucceeded: false,
            fallbackReason: "coordinate_mismatch",
          },
        }],
      },
    };
    const view = render(
      <JavisWorkbench
        draftGoal="Inspect project"
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={task}
      />,
    );

    const computerCard = Array.from(
      view.container.querySelectorAll<HTMLButtonElement>(".javis-agent-run-card"),
    ).find((card) => card.textContent?.includes("Computer Agent"));
    expect(computerCard).toBeTruthy();
    fireEvent.click(computerCard!);

    await waitFor(() => {
      expect(view.container.querySelector(".javis-selected-agent-detail")?.textContent)
        .toContain("Computer Agent");
    });

    const detailsText = view.container.querySelector(".javis-task-overview")?.textContent ?? "";
    expect(detailsText).toContain("Execution trace");
    expect(detailsText).toContain("local vision disabled");
    expect(detailsText).toContain("0 detections");
    expect(detailsText).toContain("0 candidates");
    expect(detailsText).toContain("crop VLM");
    expect(detailsText).toContain("full screenshot skipped");
    expect(detailsText).toContain("disabled: timeout");
    expect(detailsText).toContain("2 timeouts");
    expect(detailsText).toContain("risk: medium");
    expect(detailsText).toContain("action failed");
    expect(detailsText).toContain("source: uia+yolo");
    expect(detailsText).toContain("fallback: coordinate_mismatch");
  });

  it("shows repository evidence in Code Agent details", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const task: WorkbenchTask = {
      ...createOrchestrationTask(),
      plan: [
        {
          id: "search-repo",
          title: "Search repository",
          status: "completed",
          agentId: "agent-code",
          agentKind: "code",
          successCriteria: "Repository evidence is collected.",
        },
      ],
      agents: [
        {
          id: "agent-code",
          name: "Code Agent",
          role: "Inspects implementation",
          status: "completed",
          task: "Repository search completed",
        },
      ],
      repoSearchReport: {
        actualFound: [{
          path: "packages/core/src/memory.ts",
          line: 8,
          excerpt: "export interface AgentMemory {}",
          matchedTerms: ["memory"],
        }],
        inferred: ["Memory code lives under packages/core."],
        needsConfirmation: ["No test file was found in the first search pass."],
        keyFiles: ["packages/core/src/memory.ts"],
        relatedTestFiles: [],
        testFileCandidates: ["packages/core/src/memory.test.ts"],
        clusters: [{
          id: "packages/core",
          label: "packages/core",
          paths: ["packages/core/src/memory.ts"],
          resultCount: 1,
          score: 2,
          topTerms: ["memory"],
        }],
        semanticDiagnostics: [{
          provider: "local-test-embedding",
          status: "completed",
          candidateCount: 1,
          rerankedCount: 1,
          durationMs: 7,
        }],
        attempts: [{
          id: "term-memory",
          query: "memory",
          reason: "Search known term.",
          resultCount: 1,
          provider: "rg",
        }, {
          id: "fallback-agent-memory",
          query: "agent memory",
          reason: "fallback term for a no-result search",
          resultCount: 0,
          status: "failed",
          durationMs: 12,
          error: "search backend unavailable",
          errorKind: "unavailable",
          provider: "ignore",
          retryCount: 1,
        }],
      },
    };
    const view = render(
      <JavisWorkbench
        draftGoal="Search repository"
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={task}
      />,
    );

    const codeCard = Array.from(
      view.container.querySelectorAll<HTMLButtonElement>(".javis-agent-run-card"),
    ).find((card) => card.textContent?.includes("Code Agent"));
    expect(codeCard).toBeTruthy();
    fireEvent.click(codeCard!);

    await waitFor(() => {
      expect(view.container.querySelector(".javis-selected-agent-detail")?.textContent)
        .toContain("Code Agent");
    });

    const detailsText = view.container.querySelector(".javis-task-overview")?.textContent ?? "";
    expect(detailsText).toContain("Repository evidence");
    expect(detailsText).toContain("packages/core/src/memory.ts");
    expect(detailsText).toContain("packages/core/src/memory.ts:8");
    expect(detailsText).toContain("packages/core/src/memory.test.ts");
    expect(detailsText).toContain("export interface AgentMemory");
    expect(detailsText).toContain("packages/core");
    expect(detailsText).toContain("Memory code lives under packages/core.");
    expect(detailsText).toContain("No test file was found in the first search pass.");
    expect(detailsText).toContain("local-test-embedding");
    expect(detailsText).toContain("completed - 1/1 candidate(s) - 7ms");
    expect(detailsText).toContain("memory");
    expect(detailsText).toContain("rg - 1 result(s) - Search known term.");
    expect(detailsText).toContain("agent memory");
    expect(detailsText).toContain("failed - ignore - 0 result(s) - 12ms - 1 retry - fallback term for a no-result search - kind: unavailable - error: search backend unavailable");
    expect(detailsText).toContain("Repository search report");
  });

  it("shows repository trace evidence in Code Agent details", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const task: WorkbenchTask = {
      ...createOrchestrationTask(),
      plan: [
        {
          id: "trace-repo",
          title: "Trace repository",
          status: "completed",
          agentId: "agent-code",
          agentKind: "code",
          successCriteria: "Repository trace evidence is collected.",
        },
      ],
      agents: [
        {
          id: "agent-code",
          name: "Code Agent",
          role: "Inspects implementation",
          status: "completed",
          task: "Repository trace completed",
        },
      ],
      repoTraceReport: {
        target: "runTask",
        direction: "forward",
        actualFound: [{
          path: "packages/ui/src/TaskPanel.tsx",
          line: 42,
          excerpt: "onClick={() => runTask(goal)}",
          matchedTerms: ["runTask"],
        }],
        nodes: [
          {
            id: "target:runtask",
            label: "runTask",
            kind: "target",
            symbol: "runTask",
            score: 100,
          },
          {
            id: "candidate:taskpanel",
            label: "TaskPanel (packages/ui/src/TaskPanel.tsx)",
            kind: "candidate",
            path: "packages/ui/src/TaskPanel.tsx",
            symbol: "TaskPanel",
            score: 12,
          },
        ],
        edges: [{
          from: "target:runtask",
          to: "candidate:taskpanel",
          relation: "may_call",
          evidencePath: "packages/ui/src/TaskPanel.tsx",
          line: 42,
          excerpt: "onClick={() => runTask(goal)}",
          confidence: 0.85,
          moduleSpecifier: "@javis/core",
          moduleKind: "workspace",
        }],
        moduleLinks: [{
          specifier: "@javis/core",
          kind: "workspace",
          evidencePaths: ["packages/ui/src/TaskPanel.tsx"],
          importCount: 1,
          exportCount: 0,
          dynamicImportCount: 0,
          confidence: 0.85,
          resolutionStatus: "resolved",
          resolvedPaths: ["packages/core/src/workflow-executor.ts"],
          resolverProvider: "fixture-resolver",
          packageHints: [{
            manifestPath: "packages/core/package.json",
            name: "@javis/core",
            main: "./dist/index.cjs",
            types: "./dist/index.d.ts",
            exports: ["./workflow: ./dist/workflow.js"],
          }],
        }],
        inferred: ["runTask may_call TaskPanel via packages/ui/src/TaskPanel.tsx"],
        needsConfirmation: ["Some edges are text-search candidates and need AST, runtime trace, or manual confirmation."],
        keyFiles: ["packages/ui/src/TaskPanel.tsx"],
        attempts: [{
          id: "trace-target",
          query: "runTask",
          reason: "exact target from trace request",
          resultCount: 1,
          provider: "rg",
        }],
      },
    };
    const view = render(
      <JavisWorkbench
        draftGoal="Trace repository"
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={task}
      />,
    );

    const codeCard = Array.from(
      view.container.querySelectorAll<HTMLButtonElement>(".javis-agent-run-card"),
    ).find((card) => card.textContent?.includes("Code Agent"));
    expect(codeCard).toBeTruthy();
    fireEvent.click(codeCard!);

    await waitFor(() => {
      expect(view.container.querySelector(".javis-selected-agent-detail")?.textContent)
        .toContain("Code Agent");
    });

    const detailsText = view.container.querySelector(".javis-task-overview")?.textContent ?? "";
    expect(detailsText).toContain("Repository trace");
    expect(detailsText).toContain("runTask");
    expect(detailsText).toContain("forward");
    expect(detailsText).toContain("TaskPanel (packages/ui/src/TaskPanel.tsx)");
    expect(detailsText).toContain("packages/ui/src/TaskPanel.tsx:42");
    expect(detailsText).toContain("confidence 0.85");
    expect(detailsText).toContain("module @javis/core (workspace)");
    expect(detailsText).toContain("workspace - imports 1, exports 0, dynamic 0");
    expect(detailsText).toContain("resolved by fixture-resolver - packages/core/src/workflow-executor.ts");
    expect(detailsText).toContain("package @javis/core main=./dist/index.cjs types=./dist/index.d.ts exports=./workflow: ./dist/workflow.js");
    expect(detailsText).toContain("onClick={() => runTask(goal)}");
    expect(detailsText).toContain("runTask may_call TaskPanel");
    expect(detailsText).toContain("Some edges are text-search candidates");
    expect(detailsText).toContain("rg - 1 result(s) - exact target from trace request");
    expect(detailsText).toContain("Repository trace report");
    expect(detailsText).toContain("1 key file(s), 1 edge(s)");
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

  it("links Browser Agent steps and browser tool logs into selected agent details", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const task: WorkbenchTask = {
      id: "task-browser-detail",
      title: "Browse docs",
      userGoal: "Check docs in browser",
      status: "running",
      commanderMessage: "Browser Agent checked the docs.",
      plan: [
        {
          id: "open-docs",
          title: "Open docs page",
          status: "completed",
          agentKind: "browser",
        },
      ],
      agents: [
        {
          id: "agent-browser",
          name: "Browser Agent",
          role: "Navigates web pages",
          status: "completed",
          task: "Opened the docs page",
        },
      ],
      logs: [
        {
          id: "browser-log-1",
          kind: "tool",
          title: "browser.navigate",
          detail: "Navigated to https://example.com/docs.",
        },
        {
          id: "research-url-log",
          kind: "tool",
          title: "web.fetch",
          detail: "Fetched unrelated URL evidence.",
          agentId: "agent-research",
        },
      ],
    };
    const view = render(
      <JavisWorkbench
        draftGoal="Inspect browser activity"
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={task}
      />,
    );

    const browserCard = Array.from(
      view.container.querySelectorAll<HTMLButtonElement>(".javis-agent-run-card"),
    ).find((card) => card.textContent?.includes("Browser Agent"));
    expect(browserCard).toBeTruthy();
    fireEvent.click(browserCard!);

    await waitFor(() => {
      expect(view.container.querySelector(".javis-selected-agent-detail")?.textContent)
        .toContain("Browser Agent");
    });

    const detailsText = view.container.querySelector(".javis-task-overview")?.textContent ?? "";
    expect(detailsText).toContain("Open docs page");
    expect(detailsText).toContain("browser.navigate");
    expect(detailsText).toContain("Navigated to https://example.com/docs.");
    expect(detailsText).not.toContain("Fetched unrelated URL evidence.");
    expect(detailsText).toContain("Browser");
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

  it("shows Commander handoff context keys in inspector plan details", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const task: WorkbenchTask = {
      ...createOrchestrationTask(),
      plan: [
        {
          id: "collect-evidence",
          title: "Collect repository evidence",
          status: "completed",
          agentId: "agent-file",
          agentKind: "file",
          outputContextKey: "repoEvidence",
          successCriteria: "Repository evidence is saved for the next agent.",
        },
        {
          id: "review-evidence",
          title: "Review evidence",
          status: "running",
          agentId: "agent-shell",
          agentKind: "command",
          inputContextKeys: ["repoEvidence"],
          outputContextKey: "reviewFindings",
          successCriteria: "Review findings name the handoff artifact.",
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
      expect(view.container.querySelector(".javis-selected-agent-detail")?.textContent).toContain("Shell Agent");
    });

    const details = view.container.querySelector(".javis-inspector-details");
    expect(details?.textContent).toContain("Review evidence");
    expect(details?.textContent).toContain("in: repoEvidence -> out: reviewFindings");
    expect(details?.textContent).not.toContain("out: repoEvidence");
  });

  it("shows the serializable handoff report in task details", () => {
    const task: WorkbenchTask = {
      ...createOrchestrationTask(),
      handoffReport: {
        generatedAt: "2026-06-11T00:00:00.000Z",
        status: "needs_attention",
        missingInputContextKeys: ["sourceEvidence"],
        unconsumedOutputContextKeys: ["draftText"],
        steps: [],
        handoffs: [{
          contextKey: "repoEvidence",
          producedByStepId: "collect-evidence",
          consumedByStepIds: ["review-evidence"],
          status: "available",
          valueSummary: { type: "object", present: true, keyCount: 2 },
        }, {
          contextKey: "draftText",
          producedByStepId: "draft",
          consumedByStepIds: [],
          status: "unconsumed",
          valueSummary: { type: "string", present: true, preview: "short draft" },
        }],
      },
    };
    const html = renderToStaticMarkup(
      <AgentDetailSections
        labels={defaultWorkbenchLocale.labels}
        locale={defaultWorkbenchLocale}
        task={task}
      />,
    );

    expect(html).toContain("Agent handoff report");
    expect(html).toContain("needs attention");
    expect(html).toContain("2 handoff(s)");
    expect(html).toContain("Missing input: sourceEvidence");
    expect(html).toContain("Unconsumed output: draftText");
    expect(html).toContain("collect-evidence -&gt; review-evidence");
    expect(html).toContain("draft -&gt; none");
    expect(html).toContain("object: 2 key(s)");
    expect(html).toContain("string: short draft");
    expect(html).toContain("JSON");
    expect(html).toContain("Markdown");
  });

  it("creates stable handoff report artifacts for UI export", () => {
    const artifacts = createWorkbenchHandoffReportArtifacts({
      generatedAt: "2026-06-11T00:00:00.000Z",
      status: "complete",
      missingInputContextKeys: [],
      unconsumedOutputContextKeys: [],
      steps: [{
        stepId: "collect",
        title: "Collect evidence",
        assignedAgentKind: "research",
        dependsOn: [],
        inputContextKeys: [],
        outputContextKey: "evidence",
        missingInputContextKeys: [],
        successCriteria: "Evidence is ready.",
      }],
      handoffs: [{
        contextKey: "evidence",
        producedByStepId: "collect",
        consumedByStepIds: ["review"],
        status: "available",
        valueSummary: { type: "array", present: true, itemCount: 2 },
      }],
    }, { baseName: "../Task Handoff.md" });

    expect(artifacts.map((artifact) => artifact.filename)).toEqual([
      "Task-Handoff.json",
      "Task-Handoff.md",
    ]);
    expect(artifacts[0].content).toContain('"contextKey": "evidence"');
    expect(artifacts[1].content).toContain("# Agent Handoff Report");
    expect(artifacts[1].content).toContain("| evidence | collect | review | available | array: 2 item(s) |");
  });

  it("downloads handoff report artifacts from task details", () => {
    const createObjectURL = vi.fn(() => "blob:javis-handoff");
    const revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;

    try {
      const task: WorkbenchTask = {
        ...createOrchestrationTask(),
        id: "task/export",
        handoffReport: {
          generatedAt: "2026-06-11T00:00:00.000Z",
          status: "complete",
          missingInputContextKeys: [],
          unconsumedOutputContextKeys: [],
          steps: [],
          handoffs: [{
            contextKey: "repoEvidence",
            producedByStepId: "collect-evidence",
            consumedByStepIds: ["review-evidence"],
            status: "available",
            valueSummary: { type: "object", present: true, keyCount: 2 },
          }],
        },
      };
      const view = render(
        <AgentDetailSections
          labels={defaultWorkbenchLocale.labels}
          locale={defaultWorkbenchLocale}
          task={task}
        />,
      );

      fireEvent.click(view.getByRole("button", { name: "JSON" }));

      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(click).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:javis-handoff");
      expect(view.container.querySelector("a[download='task-export-handoff-report.json']")).toBeNull();
    } finally {
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
      click.mockRestore();
    }
  });

  it("shows recovery reports in task details", () => {
    const task: WorkbenchTask = {
      ...createOrchestrationTask(),
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
    };
    const html = renderToStaticMarkup(
      <AgentDetailSections
        labels={defaultWorkbenchLocale.labels}
        locale={defaultWorkbenchLocale}
        task={task}
      />,
    );

    expect(html).toContain("Recovery report");
    expect(html).toContain("1/1 recovered");
    expect(html).toContain("Abandoned: collect-evidence");
    expect(html).toContain("Recovery steps: recover-with-partial-evidence");
    expect(html).toContain("Collect evidence");
    expect(html).toContain("network");
    expect(html).toContain("HTTP 503 from repository search provider");
    expect(html).toContain("Replan: planned -&gt; recover-with-partial-evidence");
    expect(html).toContain("retry with a fallback provider");
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
      logs: Array.from({ length: 120 }, (_, index) => ({
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

  it("restores activity log rows after switching tasks", () => {
    const firstTask: WorkbenchTask = {
      ...createIdleTask(),
      id: "task-clear-one",
      logs: [{ id: "log-one", kind: "event", title: "step.one", detail: "First task log" }],
    };
    const secondTask: WorkbenchTask = {
      ...createIdleTask(),
      id: "task-clear-two",
      logs: [{ id: "log-two", kind: "event", title: "step.two", detail: "Second task log" }],
    };
    const view = render(
      <JavisWorkbench
        draftGoal="Inspect project"
        initialIsActivityOpen={true}
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={firstTask}
      />,
    );

    expect(view.container.textContent).toContain("First task log");
    fireEvent.click(view.container.querySelector(".javis-activity-tools button[title=\"Clear logs\"]")!);
    expect(view.container.textContent).not.toContain("First task log");

    view.rerender(
      <JavisWorkbench
        draftGoal="Inspect project"
        initialIsActivityOpen={true}
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={secondTask}
      />,
    );

    expect(view.container.textContent).toContain("Second task log");
  });

  it("renders computer root entries from mount roots", () => {
    const view = render(
      <JavisWorkbench
        activeView="computer"
        computerPath=""
        draftGoal="Inspect files"
        mountRoots={[{ name: "Data (D:)", path: "D:\\" }]}
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={createIdleTask()}
      />,
    );
    const computerGrid = view.container.querySelector(".javis-computer-grid");

    expect(computerGrid?.textContent).toContain("Data (D:)");
    expect(computerGrid?.textContent).not.toContain("C:");
  });

  it("selects computer files into the inspector and opens them only on double click", () => {
    const onNavigateDirectory = vi.fn();
    const onOpenDetail = vi.fn();
    const onOpenFile = vi.fn();
    const view = render(
      <JavisWorkbench
        activeView="computer"
        computerEntries={[
          { name: "Project", path: "E:/Docs/Project", isDir: true },
          { name: "Notes.md", path: "E:/Docs/Notes.md", isDir: false, extension: "md", sizeBytes: 2048 },
        ]}
        computerPath="E:/Docs"
        draftGoal="Inspect files"
        onDraftGoalChange={vi.fn()}
        onNavigateDirectory={onNavigateDirectory}
        onOpenDetail={onOpenDetail}
        onOpenFile={onOpenFile}
        onSubmitGoal={vi.fn()}
        task={createIdleTask()}
      />,
    );

    const fileButton = within(view.container).getByText("Notes.md").closest("button");
    expect(fileButton).toBeTruthy();
    fireEvent.click(fileButton!);
    expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({
      title: "Notes.md",
      kind: "File",
    }));
    expect(view.container.querySelector(".javis-shell")?.className).toContain("inspector-open");
    expect(view.container.querySelector(".javis-review-card")?.textContent).toContain("E:/Docs/Notes.md");
    expect(onOpenFile).not.toHaveBeenCalled();

    fireEvent.doubleClick(fileButton!);
    expect(onOpenFile).toHaveBeenCalledWith("E:/Docs/Notes.md");

    const folderButton = within(view.container).getByText("Project").closest("button");
    expect(folderButton).toBeTruthy();
    fireEvent.click(folderButton!);
    expect(onNavigateDirectory).toHaveBeenCalledWith("E:\\Docs\\Project");
  });

  it("creates scheduled tasks from the automated view form", () => {
    const onCreateScheduledTask = vi.fn();
    const view = render(
      <JavisWorkbench
        activeView="automated"
        currentWorkspacePath="E:/Javis"
        draftGoal="Inspect files"
        onCreateScheduledTask={onCreateScheduledTask}
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={createIdleTask()}
      />,
    );

    fireEvent.change(view.getByLabelText("Task name"), {
      target: { value: "Morning review" },
    });
    fireEvent.change(view.getByLabelText("Task goal"), {
      target: { value: "Summarize the project status" },
    });
    fireEvent.change(view.getByLabelText("Schedule value"), {
      target: { value: "08:30" },
    });
    fireEvent.click(view.getByText("Create task"));

    expect(onCreateScheduledTask).toHaveBeenCalledWith({
      name: "Morning review",
      goal: "Summarize the project status",
      workspacePath: "E:/Javis",
      scheduleType: "daily",
      scheduleValue: "08:30",
    });
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

  it("does not show Always Allow when a generic permission request disallows it", () => {
    const html = renderWorkbench({
      ...createTaskWithPermission("pending"),
      permissionRequest: {
        ...createTaskWithPermission("pending").permissionRequest!,
        allowAlways: false,
      },
    });

    expect(html).toContain("<button type=\"button\">Approve</button>");
    expect(html).not.toContain("Always Allow");
    expect(html).toContain("<button type=\"button\">Deny</button>");
  });

  it("renders Computer Use action approvals as desktop actions", () => {
    const html = renderWorkbench({
      ...createTaskWithPermission("pending"),
      title: "需要确认桌面操作",
      commanderMessage: "需要你确认：点击屏幕坐标 (640, 420)。",
      permissionRequest: {
        id: "computer-permission-1",
        screenshotDataUrl: "data:image/png;base64,PREVIEW==",
        level: "confirmed_write",
        writeRiskLevel: "dangerous",
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
    expect(html).toContain("class=\"javis-status javis-risk-status risk-dangerous\"");
    expect(html).toContain("dangerous");
    expect(html).toContain("class=\"javis-permission-screenshot\"");
    expect(html).toContain("src=\"data:image/png;base64,PREVIEW==\"");
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

  it("does not show task-level approval when a Computer Use request disallows always-allow", () => {
    const html = renderWorkbench({
      ...createTaskWithPermission("pending"),
      permissionRequest: {
        id: "computer-fresh-permission-1",
        level: "confirmed_write",
        title: "Confirm desktop action",
        reason: "Javis is about to click a high-risk candidate.",
        status: "pending",
        allowAlways: false,
        dryRun: {
          operation: "computer.click",
          affectedPaths: [
            {
              source: "local desktop",
              target: "Click high-risk candidate",
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

  it("shows repair priority badges on agent summary cards", () => {
    const html = renderWorkbench({
      id: "task-agent-summary-capability",
      title: "Project inspected",
      userGoal: "Inspect project",
      status: "completed",
      commanderMessage: "Final conclusion.",
      plan: [],
      agents: [{
        id: "agent-shell",
        name: "Shell Agent",
        role: "Checks commands",
        status: "completed",
        task: "Checked scripts",
        capabilityScore: {
          score: 65,
          status: "usable",
          implemented: true,
          permissionReady: true,
          qaPassed: false,
          liveVerified: false,
          recentFailureRate: 0.25,
          highestPermissionLevel: "read",
          capabilityTags: ["shell_readonly"],
          evidenceRefs: ["docs/qa/shell.json"],
          gaps: ["product QA evidence is not marked as passed"],
        },
      }],
      logs: [],
    });

    expect(html).toContain("Shell Agent");
    expect(html).toContain("repair high");
    expect(html).toContain("javis-agent-summary-card-capability priority-high");
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

  it("shows workspace file tool entries in the inspector on click", () => {
    const onOpenDetail = vi.fn();
    const onOpenFile = vi.fn();
    const view = render(
      <JavisWorkbench
        computerEntries={[
          { name: "src", path: "E:/Javis/src", isDir: true },
          { name: "package.json", path: "E:/Javis/package.json", isDir: false, extension: "json", sizeBytes: 512 },
        ]}
        currentWorkspacePath="E:/Javis"
        draftGoal="Use files"
        initialIsInspectorOpen={true}
        onDraftGoalChange={vi.fn()}
        onOpenDetail={onOpenDetail}
        onOpenFile={onOpenFile}
        onSubmitGoal={vi.fn()}
        task={createIdleTask()}
        workspaceToolTabs={[{ id: "files-1", tool: "files" }]}
      />,
    );

    const fileButton = Array.from(
      view.container.querySelectorAll<HTMLButtonElement>(".javis-tool-file-entry.file"),
    ).find((button) => button.textContent?.includes("package.json"));
    expect(fileButton).toBeTruthy();
    fireEvent.click(fileButton!);
    expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({
      title: "package.json",
      kind: "Workspace file",
    }));
    expect(view.container.querySelector(".javis-review-card")?.textContent).toContain("E:/Javis/package.json");
    expect(onOpenFile).not.toHaveBeenCalled();

    fireEvent.doubleClick(fileButton!);
    expect(onOpenFile).toHaveBeenCalledWith("E:/Javis/package.json");
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

    const onRequestedBrowser = vi.fn().mockResolvedValue({
      url: "http://localhost:5173",
      title: "Local app",
      loadState: "snapshot",
    });
    view = render(
      <JavisWorkbench
        {...baseProps}
        initialIsInspectorOpen={false}
        onQuickActionBrowser={onRequestedBrowser}
        workspaceToolRequest={{
          id: "runtime-browser-request-1",
          tool: "browser",
          source: "browser.navigate",
        }}
      />,
    );
    await waitFor(() => expect(onRequestedBrowser).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "thread-1:task-session",
      workspaceRoot: "E:/Javis",
      activeTool: "browser",
    }), { action: "status" }));
    expect(view.container.querySelector(".javis-tool-browser-nav")).toBeTruthy();
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
    const refreshButton = [...view.container.querySelectorAll<HTMLButtonElement>(".browser-panel .icon-refresh")]
      .find((button) => !button.disabled);
    expect(refreshButton).toBeDefined();
    fireEvent.click(refreshButton!);
    await waitFor(() => expect(onBrowserRefresh).toHaveBeenCalledWith(expect.anything(), {
      action: "refresh",
      url: "http://localhost:5173",
    }));
    const details = view.container.querySelector<HTMLDetailsElement>(".javis-tool-browser-fallback")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(view.container.querySelector(".javis-tool-browser-frame")).not.toBeNull();
    view.unmount();

    const onApproveBrowserWrite = vi.fn().mockResolvedValue(undefined);
    const onDenyBrowserWrite = vi.fn().mockResolvedValue(undefined);
    view = render(
      <JavisWorkbench
        {...baseProps}
        workspaceToolTabs={[{ id: "browser-1", tool: "browser" }]}
        pendingBrowserWriteApproval={{
          approvalId: "browser-approval-1",
          sessionId: "browser-session-1",
          toolName: "browser.type",
          action: "type",
          previewHash: "hash-browser",
          selector: "input.secret",
          byteCount: 19,
        }}
        onApproveBrowserWrite={onApproveBrowserWrite}
        onDenyBrowserWrite={onDenyBrowserWrite}
      />,
    );
    expect(view.container.textContent).toContain("Approve browser write");
    expect(view.container.textContent).toContain("Type 19 byte(s)");
    expect(view.container.textContent).toContain("hash hash-browser");
    expect(view.container.textContent).not.toContain("SECRET_BROWSER_TEXT");
    fireEvent.click(view.getByText("Approve and execute"));
    await waitFor(() => expect(onApproveBrowserWrite).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "thread-1:task-session",
      activeTool: "browser",
    }), "browser-approval-1"));
    fireEvent.click(view.getByText("Deny"));
    await waitFor(() => expect(onDenyBrowserWrite).toHaveBeenCalledWith(expect.anything(), "browser-approval-1"));
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

  it("shows a visible approval gate before starting an interactive terminal", async () => {
    const terminalService = {
      planCreate: vi.fn(async () => ({
        approvalId: "terminal-approval-1",
        toolName: "terminal.create",
        action: "create" as const,
        previewHash: "terminal-preview-hash",
        preview: {
          terminalId: "term-1",
          workspaceRoot: "E:/Javis",
        },
      })),
      executeCreate: vi.fn(),
      create: vi.fn(),
      input: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    };

    const view = render(
      <JavisWorkbench
        activeHistoryEntryId="thread-1"
        currentWorkspacePath="E:/Javis"
        draftGoal="Use terminal"
        initialIsInspectorOpen={true}
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={createIdleTask()}
        terminalService={terminalService}
        workspaceToolTabs={[{ id: "terminal-1", tool: "terminal" }]}
      />,
    );

    expect(view.container.textContent).toContain("Start interactive terminal");
    expect(view.container.textContent).toContain("Approve and start");
    await waitFor(() => expect(view.container.textContent).toContain("terminal-approval-1"));
    expect(view.container.textContent).toContain("terminal-preview-hash");
    expect(terminalService.planCreate).toHaveBeenCalled();
    expect(terminalService.create).not.toHaveBeenCalled();
  });

  it("prepares and executes a Git push approval from the review tool", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const task: WorkbenchTask = {
      id: "task-git-push",
      title: "Git push",
      userGoal: "Push branch",
      status: "completed",
      commanderMessage: "Review is ready.",
      plan: [],
      agents: [],
      logs: [],
    };
    const pushPreview = {
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
    };
    const onReview = vi.fn().mockResolvedValue({
      changedFiles: ["README.md"],
      diffStat: " README.md | 1 +",
      diff: "diff --git a/README.md b/README.md",
      workspacePath: "E:/Javis",
      branch: "feature/git-push",
      upstream: "origin/feature/git-push",
      upstreamRemote: "origin",
      ahead: 1,
      behind: 0,
      remotes: [{ name: "origin", pushUrl: "file:///tmp/remote.git" }],
      pullRequests: {
        provider: "github-cli",
        pullRequests: [{
          number: 42,
          title: "Add PR list",
          state: "OPEN",
          url: "https://github.com/acme/repo/pull/42",
          author: "octocat",
          headRefName: "feature/git-push",
          baseRefName: "main",
          updatedAt: "2026-06-09T10:00:00Z",
        }],
      },
      pushPreview,
    });
    const onPlan = vi.fn().mockResolvedValue({
      approvalId: "approval-1",
      preview: pushPreview,
    });
    const onExecute = vi.fn().mockResolvedValue({
      workspacePath: "E:/Javis",
      branch: "feature/git-push",
      upstream: "origin/feature/git-push",
      remoteName: "origin",
      remoteBranch: "feature/git-push",
      commitCount: 1,
      pushed: true,
      output: "Done",
    });

    const view = render(
      <JavisWorkbench
        activeHistoryEntryId="thread-1"
        currentWorkspacePath="E:/Javis"
        draftGoal="Push branch"
        initialIsInspectorOpen
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={task}
        workspaceToolTabs={[{ id: "review-1", tool: "review" }]}
        onQuickActionReview={onReview}
        onQuickActionGitPushPlan={onPlan}
        onQuickActionGitPushExecute={onExecute}
      />,
    );

    fireEvent.click(getEnabledButton(view.container, ".javis-tool-action-btn"));
    await waitFor(() => expect(view.container.textContent).toContain("Push preview 1 commit(s)"));
    expect(view.container.textContent).toContain("#42 Add PR list");

    fireEvent.click(view.getByText("Prepare push"));
    await waitFor(() => expect(onPlan).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "thread-1:task-git-push",
      workspaceRoot: "E:/Javis",
      activeTool: "review",
    })));
    expect(view.container.textContent).toContain("Pending Push Approval");

    fireEvent.click(view.getByText("Approve and push"));
    await waitFor(() => expect(onExecute).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "thread-1:task-git-push",
      workspaceRoot: "E:/Javis",
      activeTool: "review",
    }), "approval-1"));
    await waitFor(() => expect(view.container.textContent).toContain("Pushed 1 commit(s)"));
  });

  it("prepares and executes a Git commit approval from the review tool", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const task: WorkbenchTask = {
      id: "task-git-commit",
      title: "Git commit",
      userGoal: "Commit changes",
      status: "completed",
      commanderMessage: "Review is ready.",
      plan: [],
      agents: [],
      logs: [],
    };
    const commitPreview = {
      workspaceRoot: "E:/Javis",
      branch: "feature/git-commit",
      message: "Commit changes",
      files: [
        {
          path: "README.md",
          indexStatus: "",
          worktreeStatus: "M",
          action: "modify" as const,
          contentHash: "hash-readme",
        },
      ],
      diffStat: " README.md | 1 +",
      diff: "diff --git a/README.md b/README.md",
      dryRun: {
        operation: "Preview Git commit",
        riskSummary: "Preview only. No Git write was executed.",
        reversible: false,
        affectedPaths: [{
          source: "README.md",
          target: "README.md",
          action: "modify" as const,
        }],
      },
    };
    const onReview = vi.fn().mockResolvedValue({
      changedFiles: ["README.md"],
      diffStat: " README.md | 1 +",
      diff: "diff --git a/README.md b/README.md",
      workspacePath: "E:/Javis",
      branch: "feature/git-commit",
      remotes: [],
    });
    const onPlan = vi.fn().mockResolvedValue({
      approvalId: "approval-commit-1",
      preview: commitPreview,
    });
    const onExecute = vi.fn().mockResolvedValue({
      workspacePath: "E:/Javis",
      branch: "feature/git-commit",
      commitHash: "abc123def4567890",
      subject: "Commit changes",
      fileCount: 1,
      committed: true,
      output: "[feature/git-commit abc123d] Commit changes",
    });

    const view = render(
      <JavisWorkbench
        activeHistoryEntryId="thread-1"
        currentWorkspacePath="E:/Javis"
        draftGoal="Commit changes"
        initialIsInspectorOpen
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={task}
        workspaceToolTabs={[{ id: "review-1", tool: "review" }]}
        onQuickActionReview={onReview}
        onQuickActionGitCommitPlan={onPlan}
        onQuickActionGitCommitExecute={onExecute}
      />,
    );

    fireEvent.click(getEnabledButton(view.container, ".javis-tool-action-btn"));
    await waitFor(() => expect(view.container.textContent).toContain("Edited 1 files"));
    const commitInput = view.container.querySelector<HTMLInputElement>('input[placeholder="Commit message"]');
    expect(commitInput).not.toBeNull();
    fireEvent.change(commitInput!, {
      target: { value: "Commit changes" },
    });

    const prepareCommitButton = [...view.container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Prepare commit" && !button.disabled);
    expect(prepareCommitButton).toBeDefined();
    fireEvent.click(prepareCommitButton!);
    await waitFor(() => expect(onPlan).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "thread-1:task-git-commit",
      workspaceRoot: "E:/Javis",
      activeTool: "review",
    }), "Commit changes"));
    expect(view.container.textContent).toContain("Pending Commit Approval");

    const approveCommitButton = [...view.container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Approve and commit" && !button.disabled);
    expect(approveCommitButton).toBeDefined();
    fireEvent.click(approveCommitButton!);
    await waitFor(() => expect(onExecute).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "thread-1:task-git-commit",
      workspaceRoot: "E:/Javis",
      activeTool: "review",
    }), "approval-commit-1", "Commit changes"));
    await waitFor(() => expect(view.container.textContent).toContain("Committed 1 file(s): Commit changes"));
  });

  it("prepares and executes a selected Git stage approval from the review tool", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const task: WorkbenchTask = {
      id: "task-git-stage",
      title: "Git stage",
      userGoal: "Stage selected changes",
      status: "completed",
      commanderMessage: "Review is ready.",
      plan: [],
      agents: [],
      logs: [],
    };
    const stagePreview = {
      workspaceRoot: "E:/Javis",
      files: [
        {
          path: "README.md",
          indexStatus: "",
          worktreeStatus: "M",
          action: "stage" as const,
          contentHash: "hash-readme",
        },
      ],
      diffStat: " README.md | 1 +",
      diff: "diff --git a/README.md b/README.md",
      dryRun: {
        operation: "Preview Git stage selected files",
        riskSummary: "Preview only. No Git write was executed.",
        reversible: true,
        affectedPaths: [{
          source: "README.md",
          target: "README.md",
          action: "stage" as const,
        }],
      },
    };
    const onReview = vi.fn().mockResolvedValue({
      changedFiles: ["README.md", "notes.md"],
      diffStat: " README.md | 1 +\n notes.md | 1 +",
      diff: "diff --git a/README.md b/README.md",
      workspacePath: "E:/Javis",
      branch: "feature/git-stage",
      remotes: [],
    });
    const onPlan = vi.fn().mockResolvedValue({
      approvalId: "approval-stage-1",
      preview: stagePreview,
    });
    const onExecute = vi.fn().mockResolvedValue({
      workspacePath: "E:/Javis",
      stagedPaths: ["README.md"],
      fileCount: 1,
      staged: true,
      output: "",
    });

    const view = render(
      <JavisWorkbench
        activeHistoryEntryId="thread-1"
        currentWorkspacePath="E:/Javis"
        draftGoal="Stage selected changes"
        initialIsInspectorOpen
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={task}
        workspaceToolTabs={[{ id: "review-1", tool: "review" }]}
        onQuickActionReview={onReview}
        onQuickActionGitStagePlan={onPlan}
        onQuickActionGitStageExecute={onExecute}
      />,
    );

    fireEvent.click(getEnabledButton(view.container, ".javis-tool-action-btn"));
    await waitFor(() => expect(view.container.textContent).toContain("Edited 2 files"));
    const checkboxes = [...view.container.querySelectorAll<HTMLInputElement>(".javis-tool-review-files input[type=\"checkbox\"]")];
    expect(checkboxes).toHaveLength(2);
    fireEvent.click(checkboxes[1]);
    await waitFor(() => expect(checkboxes[1].checked).toBe(false));

    const prepareStageButton = [...view.container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Prepare stage" && !button.disabled);
    expect(prepareStageButton).toBeDefined();
    fireEvent.click(prepareStageButton!);
    await waitFor(() => expect(onPlan).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "thread-1:task-git-stage",
      workspaceRoot: "E:/Javis",
      activeTool: "review",
    }), ["README.md"]));
    expect(view.container.textContent).toContain("Pending Stage Approval");

    const approveStageButton = [...view.container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Approve and stage" && !button.disabled);
    expect(approveStageButton).toBeDefined();
    fireEvent.click(approveStageButton!);
    await waitFor(() => expect(onExecute).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "thread-1:task-git-stage",
      workspaceRoot: "E:/Javis",
      activeTool: "review",
    }), "approval-stage-1", ["README.md"]));
    await waitFor(() => expect(view.container.textContent).toContain("Staged 1 file(s)"));
  });

  it("prepares and executes a draft Git pull request approval from the review tool", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const task: WorkbenchTask = {
      id: "task-git-pr",
      title: "Git PR",
      userGoal: "Create a draft pull request",
      status: "completed",
      commanderMessage: "Review is ready.",
      plan: [],
      agents: [],
      logs: [],
    };
    const pullRequestPreview = {
      workspaceRoot: "E:/Javis",
      provider: "github-cli",
      title: "Add README update",
      body: "Summarizes the README update.",
      baseBranch: "main",
      headBranch: "feature/readme",
      headCommit: "1234567890abcdef",
      remoteName: "origin",
      remoteUrl: "https://github.com/acme/repo.git",
      draft: true,
      dryRun: {
        operation: "git.createPullRequest",
        riskSummary: "Creates a draft GitHub pull request.",
        reversible: false,
        affectedPaths: [{
          source: "feature/readme",
          target: "main",
          action: "create_pr" as const,
        }],
      },
    };
    const onReview = vi.fn().mockResolvedValue({
      changedFiles: ["README.md"],
      diffStat: " README.md | 1 +",
      diff: "diff --git a/README.md b/README.md",
      workspacePath: "E:/Javis",
      branch: "feature/readme",
      remotes: [],
    });
    const onPlan = vi.fn().mockResolvedValue({
      approvalId: "approval-pr-1",
      preview: pullRequestPreview,
    });
    const onExecute = vi.fn().mockResolvedValue({
      workspacePath: "E:/Javis",
      provider: "github-cli",
      url: "https://github.com/acme/repo/pull/12",
      title: "Add README update",
      baseBranch: "main",
      headBranch: "feature/readme",
      draft: true,
      created: true,
      output: "https://github.com/acme/repo/pull/12",
    });

    const view = render(
      <JavisWorkbench
        activeHistoryEntryId="thread-1"
        currentWorkspacePath="E:/Javis"
        draftGoal="Create a draft pull request"
        initialIsInspectorOpen
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={task}
        workspaceToolTabs={[{ id: "review-1", tool: "review" }]}
        onQuickActionReview={onReview}
        onQuickActionGitCreatePullRequestPlan={onPlan}
        onQuickActionGitCreatePullRequestExecute={onExecute}
      />,
    );

    fireEvent.click(getEnabledButton(view.container, ".javis-tool-action-btn"));
    await waitFor(() => expect(view.container.textContent).toContain("Edited 1 files"));
    fireEvent.change(view.getByPlaceholderText("PR title"), {
      target: { value: "Add README update" },
    });
    fireEvent.change(view.getByPlaceholderText("PR body (optional)"), {
      target: { value: "Summarizes the README update." },
    });

    const preparePullRequestButton = [...view.container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Prepare PR" && !button.disabled);
    expect(preparePullRequestButton).toBeDefined();
    fireEvent.click(preparePullRequestButton!);
    await waitFor(() => expect(onPlan).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "thread-1:task-git-pr",
      workspaceRoot: "E:/Javis",
      activeTool: "review",
    }), {
      title: "Add README update",
      body: "Summarizes the README update.",
      baseBranch: "main",
      draft: true,
    }));
    expect(view.container.textContent).toContain("Pending PR Approval");

    const approvePullRequestButton = [...view.container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Approve and create PR" && !button.disabled);
    expect(approvePullRequestButton).toBeDefined();
    fireEvent.click(approvePullRequestButton!);
    await waitFor(() => expect(onExecute).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "thread-1:task-git-pr",
      workspaceRoot: "E:/Javis",
      activeTool: "review",
    }), "approval-pr-1", {
      title: "Add README update",
      body: "Summarizes the README update.",
      baseBranch: "main",
      draft: true,
    }));
    await waitFor(() => expect(view.container.textContent).toContain("Created PR: Add README update"));
  });

  it("prepares and executes a Git pull request comment approval from the review tool", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const task: WorkbenchTask = {
      id: "task-git-pr-comment",
      title: "Git PR comment",
      userGoal: "Comment on a pull request",
      status: "completed",
      commanderMessage: "Review is ready.",
      plan: [],
      agents: [],
      logs: [],
    };
    const commentPreview = {
      workspaceRoot: "E:/Javis",
      provider: "github-cli",
      pullRequest: "12",
      body: "Looks good after the latest changes.",
      remoteUrl: "https://github.com/acme/repo.git",
      dryRun: {
        operation: "git.commentPullRequest",
        riskSummary: "Posts a GitHub pull request comment.",
        reversible: false,
        affectedPaths: [{
          source: "12",
          target: "https://github.com/acme/repo.git",
          action: "comment_pr" as const,
        }],
      },
    };
    const onReview = vi.fn().mockResolvedValue({
      changedFiles: ["README.md"],
      diffStat: " README.md | 1 +",
      diff: "diff --git a/README.md b/README.md",
      workspacePath: "E:/Javis",
      branch: "feature/readme",
      remotes: [],
      pullRequests: {
        provider: "github-cli",
        pullRequests: [{
          number: 12,
          title: "Add README update",
          state: "OPEN",
          url: "https://github.com/acme/repo/pull/12",
        }],
      },
    });
    const onPlan = vi.fn().mockResolvedValue({
      approvalId: "approval-pr-comment-1",
      preview: commentPreview,
    });
    const onExecute = vi.fn().mockResolvedValue({
      workspacePath: "E:/Javis",
      provider: "github-cli",
      pullRequest: "12",
      commented: true,
      output: "https://github.com/acme/repo/pull/12#issuecomment-1",
    });

    const view = render(
      <JavisWorkbench
        activeHistoryEntryId="thread-1"
        currentWorkspacePath="E:/Javis"
        draftGoal="Comment on a pull request"
        initialIsInspectorOpen
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={task}
        workspaceToolTabs={[{ id: "review-1", tool: "review" }]}
        onQuickActionReview={onReview}
        onQuickActionGitCommentPullRequestPlan={onPlan}
        onQuickActionGitCommentPullRequestExecute={onExecute}
      />,
    );

    fireEvent.click(getEnabledButton(view.container, ".javis-tool-action-btn"));
    await waitFor(() => expect(view.container.textContent).toContain("PRs 1"));
    fireEvent.change(view.getByPlaceholderText("PR number, URL, or branch"), {
      target: { value: "12" },
    });
    fireEvent.change(view.getByPlaceholderText("PR comment"), {
      target: { value: "Looks good after the latest changes." },
    });

    let prepareCommentButton: HTMLButtonElement | undefined;
    await waitFor(() => {
      prepareCommentButton = [...view.container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === "Prepare PR comment" && !button.disabled);
      expect(prepareCommentButton).toBeDefined();
    });
    fireEvent.click(prepareCommentButton!);
    await waitFor(() => expect(onPlan).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "thread-1:task-git-pr-comment",
      workspaceRoot: "E:/Javis",
      activeTool: "review",
    }), {
      pullRequest: "12",
      body: "Looks good after the latest changes.",
    }));
    expect(view.container.textContent).toContain("Pending PR Comment Approval");

    const approveCommentButton = [...view.container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Approve and post comment" && !button.disabled);
    expect(approveCommentButton).toBeDefined();
    fireEvent.click(approveCommentButton!);
    await waitFor(() => expect(onExecute).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "thread-1:task-git-pr-comment",
      workspaceRoot: "E:/Javis",
      activeTool: "review",
    }), "approval-pr-comment-1", {
      pullRequest: "12",
      body: "Looks good after the latest changes.",
    }));
    await waitFor(() => expect(view.container.textContent).toContain("Posted PR comment on 12"));
  });

  it("syncs externally controlled workspace tool tabs without clearing internal tabs", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const task: WorkbenchTask = {
      id: "task-tabs",
      title: "Tool tabs",
      userGoal: "Use right rail tools",
      status: "completed",
      commanderMessage: "Tools are ready.",
      plan: [],
      agents: [],
      logs: [],
      codeProposedEdit: {
        proposalId: "proposal-tabs",
        workspacePath: "E:/Javis",
        summary: "Open review tab.",
        changedFiles: ["packages/ui/src/JavisWorkbench.tsx"],
        patch: "diff --git",
        patchHash: "hash-tabs",
      },
    };
    const baseProps = {
      currentWorkspacePath: "E:/Javis",
      draftGoal: "Use tools",
      initialIsInspectorOpen: true,
      onDraftGoalChange: vi.fn(),
      onSubmitGoal: vi.fn(),
      task,
    };

    const uncontrolled = render(<JavisWorkbench {...baseProps} />);
    fireEvent.click(uncontrolled.container.querySelector(".javis-artifact-card")!);
    await waitFor(() => expect(uncontrolled.container.textContent).toContain("Review"));
    uncontrolled.rerender(<JavisWorkbench {...baseProps} draftGoal="Use tools again" />);
    expect(uncontrolled.container.textContent).toContain("Review");
    uncontrolled.unmount();

    const controlled = render(
      <JavisWorkbench
        {...baseProps}
        workspaceToolTabs={[{ id: "review-1", tool: "review" }]}
      />,
    );
    expect(controlled.container.textContent).toContain("Review");
    controlled.rerender(
      <JavisWorkbench
        {...baseProps}
        workspaceToolTabs={[{ id: "terminal-1", tool: "terminal" }]}
      />,
    );
    await waitFor(() => expect(controlled.container.textContent).toContain("Terminal"));
    expect(controlled.container.textContent).not.toContain("Review");
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

  it("filters classified apps, shows details on click, and opens them only on double click", () => {
    const onOpenFile = vi.fn();
    const onOpenDetail = vi.fn();
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
        onOpenDetail={onOpenDetail}
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
    expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({
      title: "Calendar",
      kind: "Application",
    }));
    expect(view.container.querySelector(".javis-shell")?.className).toContain("inspector-open");
    expect(view.container.querySelector(".javis-review-card")?.textContent).toContain("C:/Apps/calendar.exe");
    expect(onOpenFile).not.toHaveBeenCalled();
    fireEvent.doubleClick(appButton!);
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

  it("keeps document and gallery category tabs scoped to their own resources", () => {
    const view = render(
      <JavisWorkbench
        activeView="documents"
        draftGoal=""
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={createIdleTask()}
        categoryStats={[{ category: "图片", count: 9 }]}
        userDocuments={[
          { name: "Contract.pdf", path: "E:/Docs/Contract.pdf", isDir: false, category: "Contracts" },
        ]}
        userImages={[
          { name: "Trip.png", path: "E:/Photos/Trip.png", isDir: false, category: "Travel" },
        ]}
      />,
    );

    const main = view.container.querySelector<HTMLElement>(".javis-main");
    expect(main).toBeInstanceOf(HTMLElement);
    const mainElement = main as HTMLElement;
    expect(within(mainElement).getByText("Contracts(1)")).toBeTruthy();
    expect(within(mainElement).queryByText("Travel(1)")).toBeNull();
    expect(within(mainElement).queryByText("图片(9)")).toBeNull();

    view.rerender(
      <JavisWorkbench
        activeView="gallery"
        draftGoal=""
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={createIdleTask()}
        categoryStats={[{ category: "图片", count: 9 }]}
        userDocuments={[
          { name: "Contract.pdf", path: "E:/Docs/Contract.pdf", isDir: false, category: "Contracts" },
        ]}
        userImages={[
          { name: "Trip.png", path: "E:/Photos/Trip.png", isDir: false, category: "Travel" },
        ]}
      />,
    );

    expect(within(mainElement).getByText("Travel(1)")).toBeTruthy();
    expect(within(mainElement).queryByText("Contracts(1)")).toBeNull();
    expect(within(mainElement).queryByText("图片(9)")).toBeNull();
  });

  it("opens the directory panel from the resource plus button", () => {
    const view = render(
      <JavisWorkbench
        activeView="documents"
        draftGoal=""
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        task={createIdleTask()}
        userDocuments={[
          { name: "Contract.pdf", path: "E:/Docs/Contract.pdf", isDir: false },
        ]}
      />,
    );

    const main = view.container.querySelector<HTMLElement>(".javis-main");
    expect(main).toBeInstanceOf(HTMLElement);
    const mainElement = main as HTMLElement;
    expect(within(mainElement).queryByText("扫描目录管理")).toBeNull();
    fireEvent.click(within(mainElement).getByLabelText("添加目录"));
    expect(within(mainElement).getByText("扫描目录管理")).toBeTruthy();
  });

  it("refreshes resource roots from the scan directory action", () => {
    const onRefreshResourceRoots = vi.fn();
    const onRefreshScan = vi.fn();
    const view = render(
      <JavisWorkbench
        activeView="gallery"
        draftGoal=""
        onDraftGoalChange={vi.fn()}
        onRefreshResourceRoots={onRefreshResourceRoots}
        onRefreshScan={onRefreshScan}
        onSubmitGoal={vi.fn()}
        task={createIdleTask()}
        userImages={[
          { name: "Trip.png", path: "E:/Photos/Trip.png", isDir: false },
        ]}
      />,
    );

    const main = view.container.querySelector<HTMLElement>(".javis-main");
    expect(main).toBeInstanceOf(HTMLElement);
    fireEvent.click(within(main as HTMLElement).getByLabelText("扫描目录"));
    expect(onRefreshResourceRoots).toHaveBeenCalledWith("images");
    expect(onRefreshScan).not.toHaveBeenCalled();
  });

  it("filters classified documents and opens them only on double click", async () => {
    const onOpenFile = vi.fn();
    const onOpenDetail = vi.fn();
    const view = render(
      <JavisWorkbench
        activeView="documents"
        draftGoal=""
        onDraftGoalChange={vi.fn()}
        onOpenDetail={onOpenDetail}
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
    expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({
      title: "Contract.pdf",
      kind: "Document",
    }));
    expect(view.container.querySelector(".javis-shell")?.className).toContain("inspector-open");
    expect(view.container.querySelector(".javis-review-card")?.textContent).toContain("E:/Docs/Contract.pdf");
    expect(onOpenFile).not.toHaveBeenCalled();
    fireEvent.doubleClick(docButton!);
    expect(onOpenFile).toHaveBeenCalledWith("E:/Docs/Contract.pdf");
  });

  it("lets users set a custom document category from the context menu", () => {
    const onUpdateFileCategory = vi.fn();
    const view = render(
      <JavisWorkbench
        activeView="documents"
        draftGoal=""
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        onUpdateFileCategory={onUpdateFileCategory}
        task={createIdleTask()}
        userDocuments={[
          { name: "Contract.pdf", path: "E:/Docs/Contract.pdf", isDir: false, category: "Contracts" },
        ]}
      />,
    );

    const docButton = within(view.container).getByText("Contract.pdf").closest("button");
    expect(docButton).toBeTruthy();
    fireEvent.contextMenu(docButton!);
    fireEvent.change(view.getByLabelText("自定义分类"), {
      target: { value: "项目资料" },
    });
    fireEvent.click(view.getByText("保存"));

    expect(onUpdateFileCategory).toHaveBeenCalledWith("E:/Docs/Contract.pdf", "项目资料");
  });

  it("filters classified gallery images and opens them only on double click", () => {
    const onOpenFile = vi.fn();
    const onOpenDetail = vi.fn();
    const view = render(
      <JavisWorkbench
        activeView="gallery"
        draftGoal=""
        onDraftGoalChange={vi.fn()}
        onOpenDetail={onOpenDetail}
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
    expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({
      title: "Trip.png",
      kind: "Image",
    }));
    expect(view.container.querySelector(".javis-shell")?.className).toContain("inspector-open");
    expect(view.container.querySelector(".javis-review-card")?.textContent).toContain("E:/Photos/Trip.png");
    expect(onOpenFile).not.toHaveBeenCalled();
    fireEvent.doubleClick(imageButton!);
    expect(onOpenFile).toHaveBeenCalledWith("E:/Photos/Trip.png");
  });

  it("lets users set a custom gallery category from the context menu", () => {
    const onUpdateFileCategory = vi.fn();
    const view = render(
      <JavisWorkbench
        activeView="gallery"
        draftGoal=""
        onDraftGoalChange={vi.fn()}
        onSubmitGoal={vi.fn()}
        onUpdateFileCategory={onUpdateFileCategory}
        task={createIdleTask()}
        userImages={[
          { name: "Trip.png", path: "E:/Photos/Trip.png", isDir: false, category: "Travel" },
        ]}
      />,
    );

    const imageButton = within(view.container).getByText("Trip.png").closest("button");
    expect(imageButton).toBeTruthy();
    fireEvent.contextMenu(imageButton!);
    fireEvent.change(view.getByLabelText("自定义分类"), {
      target: { value: "旅行照片" },
    });
    fireEvent.click(view.getByText("保存"));

    expect(onUpdateFileCategory).toHaveBeenCalledWith("E:/Photos/Trip.png", "旅行照片");
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
