import { describe, expect, it, vi } from "vitest";
import type { BrowserTool, ComputerTool, FileTool, SchedulerTool, ShellTool, WorkspaceTool } from "@javis/tools";
import { createInitialTaskSnapshot, type TaskSnapshot } from "./index";
import { createSharedTaskContext } from "./shared-context";
import { executeCapabilityStep, runGenericWorkbenchWorkflow } from "./workflow-executor";

function createTestController() {
  let snapshot = createInitialTaskSnapshot();
  const emitted: TaskSnapshot[] = [];
  return {
    emitted,
    controller: {
      emit(nextSnapshot: TaskSnapshot) {
        snapshot = nextSnapshot;
        emitted.push(nextSnapshot);
      },
      getSnapshot() {
        return snapshot;
      },
      async wait() {},
    },
  };
}

function createBrowserTool(overrides: Partial<BrowserTool> = {}): BrowserTool {
  return {
    navigate: vi.fn(async () => ({ url: "https://example.test", title: "", status: 200, loadState: "load" })),
    screenshot: vi.fn(async () => ({
      dataUrl: "data:image/png;base64,AA==",
      width: 1,
      height: 1,
      capturedAt: "2026-06-08T00:00:00.000Z",
    })),
    getContent: vi.fn(async () => ({ content: "", url: "https://example.test", title: "" })),
    click: vi.fn(async () => ({ selector: "button", clicked: true })),
    type: vi.fn(async () => ({ selector: "input", typed: true, value: "" })),
    evaluate: vi.fn(async () => ({ result: "", type: "undefined" })),
    runTest: vi.fn(async () => ({ passed: true, exitCode: 0, stdout: "", stderr: "", duration: 1 })),
    ...overrides,
  };
}

describe("executeCapabilityStep permissions", () => {
  it("does not dispatch tools for non-owner agents", async () => {
    const scanMarkdownDocuments = vi.fn(async () => []);
    const context = createSharedTaskContext({});

    await expect(
      executeCapabilityStep(
        {
          id: "wrong-owner",
          title: "Wrong owner",
          assignedAgentKind: "commander",
          toolName: "file.scanMarkdownDocuments",
          requiredCapabilities: ["file_scan"],
          dependsOn: [],
          successCriteria: "Should not run.",
        },
        context,
        {
          fileTool: { scanMarkdownDocuments },
        },
      ),
    ).rejects.toThrow("not owned by agent commander");

    expect(scanMarkdownDocuments).not.toHaveBeenCalled();
  });

  it("does not resolve capability-only steps to tools owned by another agent", async () => {
    const scanMarkdownDocuments = vi.fn(async () => []);
    const context = createSharedTaskContext({});

    await expect(
      executeCapabilityStep(
        {
          id: "wrong-capability-owner",
          title: "Wrong capability owner",
          assignedAgentKind: "commander",
          capability: "file_scan",
          requiredCapabilities: ["file_scan"],
          dependsOn: [],
          successCriteria: "Should not run.",
        },
        context,
        {
          fileTool: { scanMarkdownDocuments },
        },
      ),
    ).rejects.toThrow('owned by agent "commander"');

    expect(scanMarkdownDocuments).not.toHaveBeenCalled();
  });

  it("dispatches read and preview descriptors that are exposed to Commander DAG plans", async () => {
    const planPdfOrganization = vi.fn<NonNullable<FileTool["planPdfOrganization"]>>(async () => ({
      approvalId: "preview-1",
      directoryPath: "Downloads",
      fileCount: 0,
      dryRun: {
        operation: "plan_pdf_organization",
        affectedPaths: [],
        riskSummary: "No files.",
        reversible: true,
      },
    }));
    const runReadOnlyCommand = vi.fn<ShellTool["runReadOnlyCommand"]>(async () => ({
      command: "git status --short",
      cwd: "E:/Javis",
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));
    const followCandidateLinks = vi.fn<NonNullable<BrowserTool["followCandidateLinks"]>>(async () => ({
      followed: [],
      skipped: 0,
    }));
    const list = vi.fn<WorkspaceTool["list"]>(async () => []);
    const scaffold = vi.fn<NonNullable<WorkspaceTool["scaffold"]>>(async () => ({ id: "demo-workspace" }));

    await executeCapabilityStep(
      {
        id: "plan-pdf",
        title: "Plan PDFs",
        assignedAgentKind: "file",
        toolName: "file.planPdfOrganization",
        requiredCapabilities: ["file_scan"],
        dependsOn: [],
        inputContextKeys: ["taskId"],
        successCriteria: "PDF plan created.",
      },
      createSharedTaskContext({ taskId: "task-1" }),
      {
        fileTool: {
          scanMarkdownDocuments: vi.fn(async () => []),
          planPdfOrganization,
        },
      },
    );

    await executeCapabilityStep(
      {
        id: "shell-status",
        title: "Run git status",
        assignedAgentKind: "code",
        toolName: "shell.runReadOnlyCommand",
        requiredCapabilities: ["shell_readonly"],
        dependsOn: [],
        inputContextKeys: ["program", "args"],
        successCriteria: "Command completed.",
      },
      createSharedTaskContext({ program: "git", args: ["status", "--short"] }),
      {
        shellTool: { runReadOnlyCommand },
      },
    );

    await executeCapabilityStep(
      {
        id: "follow-links",
        title: "Follow links",
        assignedAgentKind: "browser",
        toolName: "browser.followCandidateLinks",
        requiredCapabilities: ["browser_navigate"],
        dependsOn: [],
        inputContextKeys: ["candidateLinks", "maxFollow"],
        successCriteria: "Links followed.",
      },
      createSharedTaskContext({ candidateLinks: [], maxFollow: 2 }),
      {
        browserTool: createBrowserTool({ followCandidateLinks }),
      },
    );

    await executeCapabilityStep(
      {
        id: "workspace-list",
        title: "List workspaces",
        assignedAgentKind: "workspace",
        toolName: "workspace.list",
        requiredCapabilities: ["workspace_list"],
        dependsOn: [],
        successCriteria: "Workspaces listed.",
      },
      createSharedTaskContext({}),
      {
        workspaceTool: { list, scaffold, create: vi.fn(), delete: vi.fn() },
      },
    );

    await executeCapabilityStep(
      {
        id: "workspace-scaffold",
        title: "Scaffold workspace",
        assignedAgentKind: "workspace",
        toolName: "workspace.scaffold",
        requiredCapabilities: ["workspace_scaffold"],
        dependsOn: [],
        inputContextKeys: ["description"],
        successCriteria: "Workspace scaffolded.",
      },
      createSharedTaskContext({ description: "knowledge workspace" }),
      {
        workspaceTool: { list, scaffold, create: vi.fn(), delete: vi.fn() },
      },
    );

    expect(planPdfOrganization).toHaveBeenCalledWith("task-1");
    expect(runReadOnlyCommand).toHaveBeenCalledWith({
      program: "git",
      args: ["status", "--short"],
      workspacePath: undefined,
    });
    expect(followCandidateLinks).toHaveBeenCalledWith({
      candidateLinks: [],
      urlPattern: undefined,
      maxFollow: 2,
    });
    expect(list).toHaveBeenCalledWith();
    expect(scaffold).toHaveBeenCalledWith("knowledge workspace");
  });

  it("dispatches explicit user image scans through the FileTool contract", async () => {
    const scanUserImages = vi.fn<NonNullable<FileTool["scanUserImages"]>>(async () => [{
      name: "photo.png",
      path: "C:/Users/example/Pictures/photo.png",
      isDir: false,
      extension: "png",
    }]);
    const context = createSharedTaskContext({ maxResults: 3 });

    const result = await executeCapabilityStep(
      {
        id: "scan-images",
        title: "Scan images",
        assignedAgentKind: "computer",
        toolName: "file.scanUserImages",
        requiredCapabilities: ["image_scan"],
        dependsOn: [],
        inputContextKeys: ["maxResults"],
        outputContextKey: "images",
        successCriteria: "Images scanned.",
      },
      context,
      {
        fileTool: {
          scanMarkdownDocuments: vi.fn(async () => []),
          scanUserImages,
        },
      },
    );

    expect(scanUserImages).toHaveBeenCalledWith({ maxResults: 3 });
    expect(result.toolName).toBe("file.scanUserImages");
    expect(context.get("images")).toEqual(result.output);
  });

  it("forwards optional browser request parameters through explicit tool dispatch", async () => {
    const navigate = vi.fn<BrowserTool["navigate"]>(async () => ({
      url: "https://example.test",
      title: "",
      status: 200,
      loadState: "load",
    }));
    const screenshot = vi.fn<BrowserTool["screenshot"]>(async () => ({
      dataUrl: "data:image/png;base64,AA==",
      width: 1,
      height: 1,
      capturedAt: "2026-06-08T00:00:00.000Z",
    }));
    const getContent = vi.fn<BrowserTool["getContent"]>(async () => ({
      content: "",
      url: "https://example.test",
      title: "",
    }));
    const browserTool = createBrowserTool({ navigate, screenshot, getContent });

    await executeCapabilityStep(
      {
        id: "navigate",
        title: "Navigate",
        assignedAgentKind: "browser",
        toolName: "browser.navigate",
        requiredCapabilities: ["browser_navigate"],
        dependsOn: [],
        inputContextKeys: ["url", "waitForSelector", "timeoutMs"],
        successCriteria: "Navigated.",
      },
      createSharedTaskContext({
        url: "https://example.test",
        waitForSelector: "main",
        timeoutMs: 5000,
      }),
      { browserTool },
    );

    await executeCapabilityStep(
      {
        id: "screenshot",
        title: "Screenshot",
        assignedAgentKind: "browser",
        toolName: "browser.screenshot",
        requiredCapabilities: ["browser_navigate"],
        dependsOn: [],
        inputContextKeys: ["selector", "fullPage", "format", "quality"],
        successCriteria: "Screenshot captured.",
      },
      createSharedTaskContext({
        selector: "#hero",
        fullPage: true,
        format: "jpeg",
        quality: 80,
      }),
      { browserTool },
    );

    await executeCapabilityStep(
      {
        id: "content",
        title: "Content",
        assignedAgentKind: "browser",
        toolName: "browser.getContent",
        requiredCapabilities: ["browser_navigate"],
        dependsOn: [],
        inputContextKeys: ["selector", "format", "maxLength"],
        successCriteria: "Content extracted.",
      },
      createSharedTaskContext({
        selector: "article",
        format: "markdown",
        maxLength: 1234,
      }),
      { browserTool },
    );

    expect(navigate).toHaveBeenCalledWith({
      url: "https://example.test",
      waitForSelector: "main",
      timeoutMs: 5000,
    });
    expect(screenshot).toHaveBeenCalledWith({
      selector: "#hero",
      fullPage: true,
      format: "jpeg",
      quality: 80,
    });
    expect(getContent).toHaveBeenCalledWith({
      selector: "article",
      format: "markdown",
      maxLength: 1234,
    });
  });

  it("dispatches explicit installed app scans through the FileTool contract", async () => {
    const scanInstalledApps = vi.fn<NonNullable<FileTool["scanInstalledApps"]>>(async () => [{
      name: "Calculator",
      path: "C:/Windows/System32/calc.exe",
    }]);
    const context = createSharedTaskContext({});

    const result = await executeCapabilityStep(
      {
        id: "scan-apps",
        title: "Scan apps",
        assignedAgentKind: "computer",
        toolName: "file.scanInstalledApps",
        requiredCapabilities: ["local_search"],
        dependsOn: [],
        outputContextKey: "apps",
        successCriteria: "Apps scanned.",
      },
      context,
      {
        fileTool: {
          scanMarkdownDocuments: vi.fn(async () => []),
          scanInstalledApps,
        },
      },
    );

    expect(scanInstalledApps).toHaveBeenCalledWith();
    expect(result.toolName).toBe("file.scanInstalledApps");
    expect(context.get("apps")).toEqual(result.output);
  });

  it("dispatches explicit desktop UI inspection through the ComputerTool contract", async () => {
    const inspectUi = vi.fn<ComputerTool["inspectUi"]>(async () => ({
      tree: "Window > Button",
      nodeCount: 2,
    }));
    const context = createSharedTaskContext({ windowHandle: 42, maxDepth: 4 });

    const result = await executeCapabilityStep(
      {
        id: "inspect-ui",
        title: "Inspect UI tree",
        assignedAgentKind: "computer",
        toolName: "computer.inspectUi",
        requiredCapabilities: ["desktop_ui_tree"],
        dependsOn: [],
        inputContextKeys: ["windowHandle", "maxDepth"],
        outputContextKey: "uiTree",
        successCriteria: "UI tree inspected.",
      },
      context,
      {
        computerTool: {
          searchLocalDocuments: vi.fn(async () => []),
          listDirectory: vi.fn(async () => []),
          screenshot: vi.fn(async () => ({
            dataUrl: "data:image/png;base64,AA==",
            width: 1,
            height: 1,
            capturedAt: "2026-06-08T00:00:00.000Z",
          })),
          listWindows: vi.fn(async () => ({ windows: [] })),
          inspectUi,
          focusWindow: vi.fn(),
          moveMouse: vi.fn(),
          click: vi.fn(),
          type: vi.fn(),
          keyCombo: vi.fn(),
          scroll: vi.fn(),
          invokeUi: vi.fn(),
          setUiValue: vi.fn(),
          wait: vi.fn(async () => ({ waited: 1 })),
          openPath: vi.fn(async () => ({ opened: true })),
        },
      },
    );

    expect(inspectUi).toHaveBeenCalledWith({ windowHandle: 42, maxDepth: 4, maxNodes: undefined });
    expect(result.toolName).toBe("computer.inspectUi");
    expect(context.get("uiTree")).toEqual(result.output);
  });

  it("does not dispatch explicit confirmed-write tools without Core approval", async () => {
    const writeText = vi.fn();
    const context = createSharedTaskContext({
      targetPath: "notes.txt",
      content: "hello",
      approvalId: "renderer-supplied",
    });

    await expect(
      executeCapabilityStep(
        {
          id: "write-notes",
          title: "Write notes",
          assignedAgentKind: "file",
          toolName: "file.writeText",
          requiredCapabilities: ["file_execute"],
          dependsOn: [],
          inputContextKeys: ["targetPath", "content", "approvalId"],
          successCriteria: "File written.",
        },
        context,
        {
          fileTool: {
            scanMarkdownDocuments: vi.fn(async () => []),
            writeText,
          },
        },
      ),
    ).rejects.toThrow("requires confirmed_write approval");

    expect(writeText).not.toHaveBeenCalled();
  });

  it("does not dispatch capability-resolved confirmed-write tools without Core approval", async () => {
    const writeText = vi.fn();
    const context = createSharedTaskContext({
      targetPath: "notes.txt",
      content: "hello",
      approvalId: "renderer-supplied",
    });

    await expect(
      executeCapabilityStep(
        {
          id: "write-notes",
          title: "Write notes",
          assignedAgentKind: "file",
          capability: "file_execute",
          requiredCapabilities: ["file_execute"],
          dependsOn: [],
          inputContextKeys: ["targetPath", "content", "approvalId"],
          successCriteria: "File written.",
        },
        context,
        {
          fileTool: {
            scanMarkdownDocuments: vi.fn(async () => []),
            writeText,
          },
        },
      ),
    ).rejects.toThrow("requires confirmed_write approval");

    expect(writeText).not.toHaveBeenCalled();
  });

  it("records daily-reminder confirmed-write steps as unsupported instead of creating tasks", async () => {
    const createTask = vi.fn<SchedulerTool["createTask"]>(async (draft) => ({
      ...draft,
      id: "scheduled-task-1",
      enabled: true,
    }));
    const { controller, emitted } = createTestController();

    await runGenericWorkbenchWorkflow({
      controller,
      schedulerTool: { createTask },
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      taskId: "task-daily-reminder-test",
      userGoal: "remind me every day at 8",
      workflowId: "daily-reminder",
    });

    expect(createTask).not.toHaveBeenCalled();
    const finalSnapshot = emitted[emitted.length - 1];
    expect(finalSnapshot?.status).toBe("failed");
    expect(finalSnapshot?.plan.find((step) => step.id === "persist-reminder")?.status).toBe("skipped");
    expect(finalSnapshot?.commanderMessage).toContain("persist-reminder");
  });

  it("records browser-test confirmed-write steps as unsupported instead of running tests", async () => {
    const runTest = vi.fn<NonNullable<BrowserTool["runTest"]>>(async () => ({
      passed: true,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      duration: 1,
    }));
    const browserTool: BrowserTool = {
      navigate: vi.fn(async () => ({ url: "https://example.test", title: "", status: 200, loadState: "load" })),
      screenshot: vi.fn(async () => ({
        dataUrl: "data:image/png;base64,AA==",
        width: 1,
        height: 1,
        capturedAt: "2026-06-08T00:00:00.000Z",
      })),
      getContent: vi.fn(async () => ({ content: "", url: "https://example.test", title: "" })),
      click: vi.fn(async () => ({ selector: "button", clicked: true })),
      type: vi.fn(async () => ({ selector: "input", typed: true, value: "" })),
      evaluate: vi.fn(async () => ({ result: "", type: "undefined" })),
      runTest,
    };
    const { controller, emitted } = createTestController();

    await runGenericWorkbenchWorkflow({
      controller,
      browserTool,
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      taskId: "task-browser-test",
      userGoal: "run playwright tests",
      workflowId: "browser-test",
    });

    expect(runTest).not.toHaveBeenCalled();
    const finalSnapshot = emitted[emitted.length - 1];
    expect(finalSnapshot?.status).toBe("failed");
    expect(finalSnapshot?.plan.find((step) => step.id === "run-tests")?.status).toBe("skipped");
    expect(finalSnapshot?.commanderMessage).toContain("run-tests");
  });

  it("records generic computer-use confirmed-write steps as unsupported instead of pretending completion", async () => {
    const computerTool: ComputerTool = {
      searchLocalDocuments: vi.fn(async () => []),
      listDirectory: vi.fn(async () => []),
      screenshot: vi.fn(async () => ({
        dataUrl: "data:image/png;base64,AA==",
        width: 1,
        height: 1,
        capturedAt: "2026-06-08T00:00:00.000Z",
      })),
      listWindows: vi.fn(async () => ({ windows: [] })),
      inspectUi: vi.fn(async () => ({ tree: "", nodeCount: 0 })),
      focusWindow: vi.fn(async () => ({ focused: true, title: "" })),
      moveMouse: vi.fn(async () => ({ x: 0, y: 0 })),
      click: vi.fn(async () => ({ x: 0, y: 0, clicked: true })),
      type: vi.fn(async () => ({ typed: true, length: 0 })),
      keyCombo: vi.fn(async () => ({ combo: "", executed: true })),
      scroll: vi.fn(async () => ({ x: 0, y: 0, delta: 0 })),
      invokeUi: vi.fn(async () => ({ invoked: true, matchedName: "", matchedAutomationId: "" })),
      setUiValue: vi.fn(async () => ({ set: true, matchedName: "", matchedAutomationId: "" })),
      wait: vi.fn(async () => ({ waited: 0 })),
      openPath: vi.fn(async () => ({ opened: true })),
    };
    const { controller, emitted } = createTestController();

    await runGenericWorkbenchWorkflow({
      controller,
      computerTool,
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      taskId: "task-generic-computer-use",
      userGoal: "open calculator",
      workflowId: "computer-use",
    });

    expect(computerTool.click).not.toHaveBeenCalled();
    const finalSnapshot = emitted[emitted.length - 1];
    expect(finalSnapshot?.status).toBe("failed");
    expect(finalSnapshot?.plan.find((step) => step.id === "execute-actions")?.status).toBe("skipped");
    expect(finalSnapshot?.commanderMessage).toContain("execute-actions");
  });
});
