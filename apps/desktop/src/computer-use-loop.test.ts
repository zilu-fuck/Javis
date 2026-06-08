import { describe, expect, it, vi } from "vitest";
import type { ComputerTool } from "@javis/tools";
import type { ModelProvider } from "./model-provider";
import { runComputerUseLoop } from "./computer-use-loop";

function createModelProvider(responseText: string): ModelProvider {
  return {
    id: "test",
    settings: {
      provider: "test",
      model: "test",
      apiKeyReference: "",
      baseUrl: "",
    },
    defaultSettingsForLocale: {} as ModelProvider["defaultSettingsForLocale"],
    complete: vi.fn(async () => ({ text: responseText })),
    stream: vi.fn(async function* () {}),
  };
}

function createSequenceModelProvider(responseTexts: string[]): ModelProvider {
  const responses = [...responseTexts];
  return {
    id: "test",
    settings: {
      provider: "test",
      model: "test",
      apiKeyReference: "",
      baseUrl: "",
    },
    defaultSettingsForLocale: {} as ModelProvider["defaultSettingsForLocale"],
    complete: vi.fn(async () => ({ text: responses.shift() ?? responseTexts[responseTexts.length - 1] ?? "" })),
    stream: vi.fn(async function* () {}),
  };
}

function createComputerTool(): ComputerTool {
  return {
    searchLocalDocuments: vi.fn(),
    listDirectory: vi.fn(),
    screenshot: vi.fn(async () => ({
      dataUrl: "data:image/png;base64,AA==",
      width: 1920,
      height: 1080,
      capturedAt: "2026-06-04T00:00:00.000Z",
      methodUsed: "bitblt" as const,
    })),
    listWindows: vi.fn(),
    inspectUi: vi.fn(),
    focusWindow: vi.fn(),
    moveMouse: vi.fn(),
    click: vi.fn(async (request) => ({ x: request.x, y: request.y, clicked: true })),
    type: vi.fn(async (request) => ({ typed: true, length: request.text.length })),
    keyCombo: vi.fn(),
    scroll: vi.fn(),
    invokeUi: vi.fn(),
    setUiValue: vi.fn(),
    wait: vi.fn(),
    openPath: vi.fn(),
  };
}

describe("runComputerUseLoop", () => {
  it("executes one write step and exits on the completion signal", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "A target button is visible",
        action: { tool: "computer.click", params: { x: 100, y: 200 } },
        target: "Click the target",
        confidence: "high",
      }),
      JSON.stringify({
        observation: "Goal achieved",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "done",
        confidence: "high",
        status: "complete",
      }),
    ]);
    const computerTool = createComputerTool();
    const approveAction = vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click the target",
      approveAction,
      config: { maxSteps: 5 },
    });

    expect(steps).toHaveLength(2);
    expect(computerTool.click).toHaveBeenCalledTimes(1);
    expect(steps[1].confidence).toBe("high");
  });

  it("maps screenshot image coordinates back to real screen coordinates", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "A target button is visible in a scaled screenshot",
        action: { tool: "computer.click", params: { x: 960, y: 540 } },
        target: "Click the target",
        confidence: "high",
      }),
      JSON.stringify({
        observation: "Goal achieved",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "done",
        confidence: "high",
        status: "complete",
      }),
    ]);
    const computerTool = createComputerTool();
    vi.mocked(computerTool.screenshot).mockResolvedValue({
      dataUrl: "data:image/png;base64,AA==",
      width: 1920,
      height: 1080,
      sourceWidth: 3840,
      sourceHeight: 2160,
      sourceOriginX: -1920,
      sourceOriginY: 0,
      scaleX: 0.5,
      scaleY: 0.5,
      capturedAt: "2026-06-04T00:00:00.000Z",
      methodUsed: "bitblt",
    });
    const approveAction = vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" }));

    await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click the target",
      approveAction,
      config: { maxSteps: 2 },
    });

    expect(computerTool.click).toHaveBeenCalledWith(expect.objectContaining({
      x: 0,
      y: 1080,
    }));
  });

  it("uses the preferred window screenshot as the coordinate preflight target", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "Need target window screenshot",
        action: { tool: "computer.screenshot", params: { windowHandle: 99, method: "auto" } },
        target: "Inspect target window",
        confidence: "medium",
      }),
      JSON.stringify({
        observation: "The target button is visible in the window screenshot",
        action: { tool: "computer.click", params: { x: 100, y: 100 } },
        target: "Click target",
        confidence: "high",
      }),
    ]);
    const computerTool = createComputerTool();
    vi.mocked(computerTool.screenshot)
      .mockResolvedValueOnce({
        dataUrl: "data:image/png;base64,FULL==",
        width: 1920,
        height: 1080,
        capturedAt: "2026-06-04T00:00:00.000Z",
        methodUsed: "bitblt",
      })
      .mockResolvedValueOnce({
        dataUrl: "data:image/png;base64,WINDOW==",
        width: 300,
        height: 300,
        sourceWidth: 300,
        sourceHeight: 300,
        sourceOriginX: 400,
        sourceOriginY: 0,
        scaleX: 1,
        scaleY: 1,
        capturedAt: "2026-06-04T00:00:01.000Z",
        methodUsed: "printWindow",
      })
      .mockResolvedValue({
        dataUrl: "data:image/png;base64,AFTER==",
        width: 300,
        height: 300,
        sourceWidth: 300,
        sourceHeight: 300,
        sourceOriginX: 400,
        sourceOriginY: 0,
        scaleX: 1,
        scaleY: 1,
        capturedAt: "2026-06-04T00:00:02.000Z",
        methodUsed: "printWindow",
      });
    vi.mocked(computerTool.listWindows).mockResolvedValue({
      windows: [
        {
          handle: 42,
          title: "Foreground App",
          className: "ForegroundWindow",
          rect: { x: 0, y: 0, width: 300, height: 300 },
          isVisible: true,
          isForeground: true,
        },
        {
          handle: 99,
          title: "Target App",
          className: "TargetWindow",
          rect: { x: 400, y: 0, width: 300, height: 300 },
          isVisible: true,
          isForeground: false,
        },
      ],
    });
    const approveAction = vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click target in another window",
      approveAction,
      config: { maxSteps: 2 },
    });

    expect(steps[1].error).toBeUndefined();
    expect(steps[1].trace?.preflight?.passed).toBe(true);
    expect(computerTool.click).toHaveBeenCalledWith(expect.objectContaining({
      x: 500,
      y: 100,
    }));
  });

  it("does not keep an old preferred window as the coordinate target after a full screenshot", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "Need target window screenshot",
        action: { tool: "computer.screenshot", params: { windowHandle: 99, method: "auto" } },
        target: "Inspect target window",
        confidence: "medium",
      }),
      JSON.stringify({
        observation: "Need full desktop screenshot",
        action: { tool: "computer.screenshot", params: {} },
        target: "Inspect foreground window",
        confidence: "medium",
      }),
      JSON.stringify({
        observation: "The foreground button is visible",
        action: { tool: "computer.click", params: { x: 100, y: 100 } },
        target: "Click foreground target",
        confidence: "high",
      }),
    ]);
    const computerTool = createComputerTool();
    vi.mocked(computerTool.screenshot)
      .mockResolvedValueOnce({
        dataUrl: "data:image/png;base64,FULL-1==",
        width: 1920,
        height: 1080,
        capturedAt: "2026-06-04T00:00:00.000Z",
        methodUsed: "bitblt",
      })
      .mockResolvedValueOnce({
        dataUrl: "data:image/png;base64,WINDOW==",
        width: 300,
        height: 300,
        sourceWidth: 300,
        sourceHeight: 300,
        sourceOriginX: 400,
        sourceOriginY: 0,
        scaleX: 1,
        scaleY: 1,
        capturedAt: "2026-06-04T00:00:01.000Z",
        methodUsed: "printWindow",
      })
      .mockResolvedValueOnce({
        dataUrl: "data:image/png;base64,FULL-2==",
        width: 1920,
        height: 1080,
        sourceWidth: 1920,
        sourceHeight: 1080,
        sourceOriginX: 0,
        sourceOriginY: 0,
        scaleX: 1,
        scaleY: 1,
        capturedAt: "2026-06-04T00:00:02.000Z",
        methodUsed: "bitblt",
      })
      .mockResolvedValue({
        dataUrl: "data:image/png;base64,AFTER==",
        width: 1920,
        height: 1080,
        sourceWidth: 1920,
        sourceHeight: 1080,
        sourceOriginX: 0,
        sourceOriginY: 0,
        scaleX: 1,
        scaleY: 1,
        capturedAt: "2026-06-04T00:00:03.000Z",
        methodUsed: "bitblt",
      });
    vi.mocked(computerTool.listWindows).mockResolvedValue({
      windows: [
        {
          handle: 42,
          title: "Foreground App",
          className: "ForegroundWindow",
          rect: { x: 0, y: 0, width: 300, height: 300 },
          isVisible: true,
          isForeground: true,
        },
        {
          handle: 99,
          title: "Target App",
          className: "TargetWindow",
          rect: { x: 400, y: 0, width: 300, height: 300 },
          isVisible: true,
          isForeground: false,
        },
      ],
    });
    const approveAction = vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click foreground target after inspecting another window",
      approveAction,
      config: { maxSteps: 3 },
    });

    expect(steps[2].error).toBeUndefined();
    expect(steps[2].trace?.preflight?.passed).toBe(true);
    expect(computerTool.click).toHaveBeenCalledWith(expect.objectContaining({
      x: 100,
      y: 100,
    }));
  });

  it("retries invalid JSON once and executes the retry action", async () => {
    const modelProvider = createSequenceModelProvider([
      "not json",
      JSON.stringify({
        observation: "Need to wait",
        action: { tool: "computer.wait", params: { ms: 25 } },
        target: "Wait briefly",
        confidence: "medium",
      }),
    ]);
    const computerTool = createComputerTool();

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Wait",
      config: { maxSteps: 1 },
    });

    expect(modelProvider.complete).toHaveBeenCalledTimes(2);
    expect(computerTool.wait).toHaveBeenCalledWith({ ms: 25 });
    expect(steps[0].error).toBeUndefined();
  });

  it("records invalid JSON after retry failure and continues", async () => {
    const modelProvider = createModelProvider("not json");
    const computerTool = createComputerTool();

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: { maxSteps: 2 },
    });

    expect(steps).toHaveLength(2);
    expect(modelProvider.complete).toHaveBeenCalledTimes(4);
    expect(computerTool.wait).not.toHaveBeenCalled();
  });

  it("stops write actions when no approval handler is available", async () => {
    const responseText = JSON.stringify({
      observation: "A target button is visible",
      action: { tool: "computer.click", params: { x: 100, y: 200 } },
      target: "Click the target",
      confidence: "high",
    });
    const modelProvider = createModelProvider(responseText);
    const computerTool = createComputerTool();

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click the target",
      config: { maxSteps: 5 },
    });

    expect(steps).toHaveLength(1);
    expect(steps[0].error).toContain("confirmed_write");
    expect(computerTool.click).not.toHaveBeenCalled();
  });

  it("stops immediately when permission is denied", async () => {
    const responseText = JSON.stringify({
      observation: "A target button is visible",
      action: { tool: "computer.click", params: { x: 100, y: 200 } },
      target: "Click the target",
      confidence: "high",
    });
    const modelProvider = createModelProvider(responseText);
    const computerTool = createComputerTool();
    const approveAction = vi.fn(async () => {
      throw new Error("denied by user");
    });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click the target",
      approveAction,
      config: { maxSteps: 5 },
    });

    expect(steps).toHaveLength(1);
    expect(steps[0].error).toContain("denied by user");
    expect(computerTool.click).not.toHaveBeenCalled();
    expect(modelProvider.complete).toHaveBeenCalledTimes(1);
  });

  it("passes screenshot dimensions and step history into the next prompt", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "Desktop is visible",
        action: { tool: "computer.wait", params: { ms: 1 } },
        target: "Let the UI settle",
        confidence: "medium",
      }),
      JSON.stringify({
        observation: "Goal achieved",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "done",
        confidence: "high",
        status: "complete",
      }),
    ]);
    const computerTool = createComputerTool();

    await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Wait for the UI",
      config: { maxSteps: 2 },
    });

    const secondPrompt = vi.mocked(modelProvider.complete).mock.calls[1]?.[0] ?? "";
    expect(secondPrompt).toContain("SCREENSHOT: 1920x1080");
    expect(secondPrompt).toContain("PREVIOUS STEPS");
    expect(secondPrompt).toContain("computer.wait");
  });

  it("includes a fresh window list in the model prompt", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Goal achieved",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "done",
      confidence: "high",
      status: "complete",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.listWindows).mockResolvedValue({
      windows: [{
        handle: 42,
        title: "Target App",
        className: "TargetWindow",
        rect: { x: 10, y: 20, width: 800, height: 600 },
        isVisible: true,
        isForeground: true,
      }],
    });

    await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the target app",
      config: { maxSteps: 1 },
    });

    const prompt = vi.mocked(modelProvider.complete).mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("WINDOWS");
    expect(prompt).toContain("handle=42 foreground");
    expect(prompt).toContain('title="Target App"');
  });

  it("includes fresh UIA context for the foreground window in the prompt", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Goal achieved",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "done",
      confidence: "high",
      status: "complete",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.listWindows).mockResolvedValue({
      windows: [{
        handle: 42,
        title: "Target App",
        className: "TargetWindow",
        rect: { x: 10, y: 20, width: 800, height: 600 },
        isVisible: true,
        isForeground: true,
      }],
    });
    vi.mocked(computerTool.inspectUi)
      .mockResolvedValueOnce({
        tree: "Button name=\"Save\" automationId=\"saveButton\"",
        nodeCount: 1,
      })
      .mockResolvedValueOnce({
        tree: "Button name=\"Save\" automationId=\"saveButton\"",
        nodeCount: 1,
      })
      .mockResolvedValue({
        tree: "Text name=\"Saved\" automationId=\"statusText\"",
        nodeCount: 1,
      });

    await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click Save",
      config: { maxSteps: 1 },
    });

    const prompt = vi.mocked(modelProvider.complete).mock.calls[0]?.[0] ?? "";
    expect(computerTool.inspectUi).toHaveBeenCalledWith({
      windowHandle: 42,
      maxDepth: 4,
      maxNodes: 120,
    });
    expect(prompt).toContain("UIA CONTEXT");
    expect(prompt).toContain("saveButton");
    expect(prompt).toContain("Prefer invokeUi/setUiValue");
  });

  it("prefers a matching UIA invoke over a model coordinate click", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "The Save button is visible",
      action: { tool: "computer.click", params: { x: 120, y: 80 } },
      target: "Click Save",
      confidence: "high",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.listWindows).mockResolvedValue({
      windows: [{
        handle: 42,
        title: "Target App",
        className: "TargetWindow",
        rect: { x: 0, y: 0, width: 800, height: 600 },
        isVisible: true,
        isForeground: true,
      }],
    });
    vi.mocked(computerTool.inspectUi).mockResolvedValue({
      tree: "<Button name=\"Save\" automationId=\"saveButton\">",
      nodeCount: 1,
    });
    vi.mocked(computerTool.invokeUi).mockResolvedValue({
      invoked: true,
      matchedName: "Save",
      matchedAutomationId: "saveButton",
    });
    const approveAction = vi.fn(async (action) => {
      expect(action.tool).toBe("computer.invokeUi");
      return { approvalId: "approval-1", taskId: "task-1" };
    });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click Save",
      approveAction,
      config: { maxSteps: 1 },
    });

    expect(computerTool.click).not.toHaveBeenCalled();
    expect(computerTool.invokeUi).toHaveBeenCalledWith(expect.objectContaining({
      selector: expect.objectContaining({
        windowHandle: 42,
        automationId: "saveButton",
        name: "Save",
      }),
      approvalId: "approval-1",
      taskId: "task-1",
    }));
    expect(steps[0].action.tool).toBe("computer.invokeUi");
    expect(steps[0].trace?.action?.originalTool).toBe("computer.click");
    expect(steps[0].trace?.action?.strategy).toBe("uia_preferred");
  });

  it("prefers the model-requested window handle for automatic UIA context", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "Need target window screenshot",
        action: { tool: "computer.screenshot", params: { windowHandle: 99, method: "auto" } },
        target: "Inspect target window",
        confidence: "medium",
      }),
      JSON.stringify({
        observation: "Target UI is visible",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "done",
        confidence: "high",
        status: "complete",
      }),
    ]);
    const computerTool = createComputerTool();
    vi.mocked(computerTool.listWindows).mockResolvedValue({
      windows: [
        {
          handle: 42,
          title: "Foreground App",
          className: "ForegroundWindow",
          rect: { x: 0, y: 0, width: 800, height: 600 },
          isVisible: true,
          isForeground: true,
        },
        {
          handle: 99,
          title: "Target App",
          className: "TargetWindow",
          rect: { x: 20, y: 20, width: 800, height: 600 },
          isVisible: true,
          isForeground: false,
        },
      ],
    });
    vi.mocked(computerTool.inspectUi).mockResolvedValue({
      tree: "Button name=\"Target\" automationId=\"targetButton\"",
      nodeCount: 1,
    });

    await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the target app",
      config: { maxSteps: 2 },
    });

    expect(computerTool.inspectUi).toHaveBeenNthCalledWith(1, {
      windowHandle: 42,
      maxDepth: 4,
      maxNodes: 120,
    });
    expect(computerTool.inspectUi).toHaveBeenNthCalledWith(2, {
      windowHandle: 99,
      maxDepth: 4,
      maxNodes: 120,
    });
    const secondPrompt = vi.mocked(modelProvider.complete).mock.calls[1]?.[0] ?? "";
    expect(secondPrompt).toContain("handle=99");
    expect(secondPrompt).toContain("targetButton");
  });

  it("dispatches model-requested window listing as a read-only action", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "Need current window handles",
        action: { tool: "computer.listWindows", params: {} },
        target: "List windows",
        confidence: "medium",
      }),
      JSON.stringify({
        observation: "Goal achieved",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "done",
        confidence: "high",
        status: "complete",
      }),
    ]);
    const computerTool = createComputerTool();
    vi.mocked(computerTool.listWindows).mockResolvedValue({ windows: [] });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "List windows",
      config: { maxSteps: 2 },
    });

    expect(computerTool.listWindows).toHaveBeenCalled();
    expect(steps[0].action.tool).toBe("computer.listWindows");
    expect(steps[0].error).toBeUndefined();
  });

  it("locks auto window screenshot calls to the first successful method", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "Need a window screenshot",
        action: { tool: "computer.screenshot", params: { windowHandle: 42, method: "auto" } },
        target: "Inspect the window",
        confidence: "medium",
      }),
      JSON.stringify({
        observation: "Need another window screenshot",
        action: { tool: "computer.screenshot", params: { windowHandle: 42, method: "auto" } },
        target: "Inspect the window again",
        confidence: "medium",
      }),
      JSON.stringify({
        observation: "Goal achieved",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "done",
        confidence: "high",
        status: "complete",
      }),
    ]);
    const computerTool = createComputerTool();
    vi.mocked(computerTool.screenshot).mockImplementation(async (request) => ({
      dataUrl: "data:image/png;base64,AA==",
      width: 1920,
      height: 1080,
      capturedAt: "2026-06-04T00:00:00.000Z",
      methodUsed: request.windowHandle === 42 ? "printWindow" as const : "bitblt" as const,
    }));

    await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect a window",
      config: { maxSteps: 3 },
    });

    const windowScreenshotCalls = vi.mocked(computerTool.screenshot).mock.calls
      .map(([request]) => request)
      .filter((request) => request.windowHandle === 42);
    expect(windowScreenshotCalls).toHaveLength(2);
    expect(windowScreenshotCalls[0].method).toBe("auto");
    expect(windowScreenshotCalls[1].method).toBe("printWindow");
  });

  it("uses a model-requested screenshot as the next vision input", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "Need a window screenshot",
        action: { tool: "computer.screenshot", params: { windowHandle: 42, method: "auto" } },
        target: "Inspect the window",
        confidence: "medium",
      }),
      JSON.stringify({
        observation: "Goal achieved",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "done",
        confidence: "high",
        status: "complete",
      }),
    ]);
    const computerTool = createComputerTool();
    vi.mocked(computerTool.screenshot).mockImplementation(async (request) => ({
      dataUrl: request.windowHandle === 42
        ? "data:image/png;base64,WINDOW=="
        : "data:image/png;base64,DESKTOP==",
      width: 1920,
      height: 1080,
      capturedAt: "2026-06-04T00:00:00.000Z",
      methodUsed: request.windowHandle === 42 ? "printWindow" as const : "bitblt" as const,
    }));

    await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect a window",
      config: { maxSteps: 2 },
    });

    const secondPrompt = vi.mocked(modelProvider.complete).mock.calls[1]?.[0] ?? "";
    expect(vi.mocked(modelProvider.complete).mock.calls[1]?.[1]?.imageDataUrl).toBe("data:image/png;base64,WINDOW==");
    expect(secondPrompt).toContain("[redacted:image data URL:");
    expect(secondPrompt).not.toContain("data:image/png;base64,WINDOW==");
  });

  it("tries a target-window screenshot when desktop capture fails", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "Need to focus the target window",
        action: { tool: "computer.focusWindow", params: { handle: 42 } },
        target: "Focus target window",
        confidence: "medium",
      }),
      JSON.stringify({
        observation: "Recovered window view",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "done",
        confidence: "high",
        status: "complete",
      }),
    ]);
    const computerTool = createComputerTool();
    vi.mocked(computerTool.listWindows).mockResolvedValue({
      windows: [{
        handle: 42,
        title: "Target App",
        className: "TargetWindow",
        rect: { x: 0, y: 0, width: 800, height: 600 },
        isVisible: true,
        isForeground: true,
      }],
    });
    vi.mocked(computerTool.focusWindow).mockResolvedValue({
      focused: true,
      title: "Target App",
    });
    vi.mocked(computerTool.screenshot).mockImplementation(async (request) => {
      if (request.windowHandle === 42 && request.method === "bitblt") {
        return {
          dataUrl: "data:image/png;base64,WINDOW_RECOVERED==",
          width: 800,
          height: 600,
          capturedAt: "2026-06-04T00:00:00.000Z",
          methodUsed: "bitblt",
        };
      }
      if (request.windowHandle === undefined) {
        if (vi.mocked(computerTool.screenshot).mock.calls.length > 1) {
          throw new Error("desktop capture failed");
        }
        return {
          dataUrl: "data:image/png;base64,DESKTOP==",
          width: 1920,
          height: 1080,
          capturedAt: "2026-06-04T00:00:00.000Z",
          methodUsed: "bitblt",
        };
      }
      throw new Error("unexpected screenshot request");
    });

    await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect a window",
      approveAction: vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" })),
      config: { maxSteps: 2 },
    });

    expect(vi.mocked(modelProvider.complete).mock.calls[1]?.[1]?.imageDataUrl).toBe("data:image/png;base64,WINDOW_RECOVERED==");
  });

  it("stops before approving or executing the third identical action", async () => {
    const responseText = JSON.stringify({
      observation: "The same target is still visible",
      action: { tool: "computer.click", params: { x: 100, y: 200 } },
      target: "Click the target",
      confidence: "medium",
    });
    const modelProvider = createModelProvider(responseText);
    const computerTool = createComputerTool();
    const approveAction = vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click the target",
      approveAction,
      config: { maxSteps: 5 },
    });

    expect(steps).toHaveLength(3);
    expect(steps[2].error).toContain("连续 3 次重复执行 computer.click");
    expect(approveAction).toHaveBeenCalledTimes(2);
    expect(computerTool.click).toHaveBeenCalledTimes(2);
  });

  it("reuses task approval for later low-risk write actions", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "First target is visible",
        action: { tool: "computer.click", params: { x: 100, y: 200 } },
        target: "Click first target",
        confidence: "high",
      }),
      JSON.stringify({
        observation: "Second target is visible",
        action: { tool: "computer.click", params: { x: 120, y: 220 } },
        target: "Click second target",
        confidence: "high",
      }),
      JSON.stringify({
        observation: "Goal achieved",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "done",
        confidence: "high",
        status: "complete",
      }),
    ]);
    const computerTool = createComputerTool();
    const approveAction = vi.fn(async () => ({
      approvalId: "approval-1",
      taskId: "task-1",
      sessionWide: true,
    }));

    await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click both targets",
      approveAction,
      config: { maxSteps: 3 },
    });

    expect(approveAction).toHaveBeenCalledTimes(1);
    expect(computerTool.click).toHaveBeenCalledTimes(2);
    expect(computerTool.click).toHaveBeenNthCalledWith(2, expect.objectContaining({
      approvalId: "approval-1",
      taskId: "task-1",
    }));
  });

  it("drops a stale task approval lease after native lease failure so the next action can ask again", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "First target is visible",
        action: { tool: "computer.click", params: { x: 100, y: 200 } },
        target: "Click first target",
        confidence: "high",
      }),
      JSON.stringify({
        observation: "Second target is visible",
        action: { tool: "computer.click", params: { x: 120, y: 220 } },
        target: "Click second target",
        confidence: "high",
      }),
      JSON.stringify({
        observation: "Third target is visible",
        action: { tool: "computer.click", params: { x: 140, y: 240 } },
        target: "Click third target",
        confidence: "high",
      }),
    ]);
    const computerTool = createComputerTool();
    vi.mocked(computerTool.click)
      .mockResolvedValueOnce({ x: 100, y: 200, clicked: true })
      .mockRejectedValueOnce(new Error("Computer Use task approval expired; please approve the next action again."))
      .mockResolvedValueOnce({ x: 140, y: 240, clicked: true });
    const approveAction = vi.fn()
      .mockResolvedValueOnce({
        approvalId: "approval-1",
        taskId: "task-1",
        sessionWide: true,
      })
      .mockResolvedValueOnce({
        approvalId: "approval-2",
        taskId: "task-1",
        sessionWide: true,
      });

    await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click three targets",
      approveAction,
      config: { maxSteps: 3 },
    });

    expect(approveAction).toHaveBeenCalledTimes(2);
    expect(computerTool.click).toHaveBeenNthCalledWith(3, expect.objectContaining({
      approvalId: "approval-2",
      taskId: "task-1",
    }));
  });

  it("reuses task approval for non-sensitive UIA invocations", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "Save button is available",
        action: {
          tool: "computer.invokeUi",
          params: {
            selector: { windowHandle: 42, automationId: "saveButton", name: "Save" },
          },
        },
        target: "Invoke Save",
        confidence: "high",
      }),
      JSON.stringify({
        observation: "Close button is available",
        action: {
          tool: "computer.invokeUi",
          params: {
            selector: { windowHandle: 42, automationId: "closeButton", name: "Close" },
          },
        },
        target: "Invoke Close",
        confidence: "high",
      }),
    ]);
    const computerTool = createComputerTool();
    vi.mocked(computerTool.listWindows).mockResolvedValue({
      windows: [{
        handle: 42,
        title: "Target App",
        className: "TargetWindow",
        rect: { x: 0, y: 0, width: 800, height: 600 },
        isVisible: true,
        isForeground: true,
      }],
    });
    vi.mocked(computerTool.inspectUi)
      .mockResolvedValueOnce({
        tree: "<Button name=\"Save\" automationId=\"saveButton\">\n<Button name=\"Close\" automationId=\"closeButton\">",
        nodeCount: 2,
      })
      .mockResolvedValueOnce({
        tree: "<Button name=\"Save\" automationId=\"saveButton\">\n<Button name=\"Close\" automationId=\"closeButton\">",
        nodeCount: 2,
      })
      .mockResolvedValueOnce({
        tree: "<Text name=\"Saved\" automationId=\"statusText\">\n<Button name=\"Close\" automationId=\"closeButton\">",
        nodeCount: 2,
      })
      .mockResolvedValueOnce({
        tree: "<Text name=\"Saved\" automationId=\"statusText\">\n<Button name=\"Close\" automationId=\"closeButton\">",
        nodeCount: 2,
      })
      .mockResolvedValue({
        tree: "<Text name=\"Done\" automationId=\"statusText\">",
        nodeCount: 1,
      });
    vi.mocked(computerTool.invokeUi).mockResolvedValue({
      invoked: true,
      matchedName: "Save",
      matchedAutomationId: "saveButton",
    });
    const approveAction = vi.fn(async () => ({
      approvalId: "approval-1",
      taskId: "task-1",
      sessionWide: true,
    }));

    await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Invoke two buttons",
      approveAction,
      config: { maxSteps: 2 },
    });

    expect(approveAction).toHaveBeenCalledTimes(1);
    expect(computerTool.invokeUi).toHaveBeenCalledTimes(2);
    expect(computerTool.invokeUi).toHaveBeenNthCalledWith(2, expect.objectContaining({
      approvalId: "approval-1",
      taskId: "task-1",
    }));
  });

  it("does not reuse task approval for sensitive text entry", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "A low-risk target is visible",
        action: { tool: "computer.click", params: { x: 100, y: 200 } },
        target: "Click first target",
        confidence: "high",
      }),
      JSON.stringify({
        observation: "Input is focused",
        action: { tool: "computer.type", params: { text: "hello" } },
        target: "Type text",
        confidence: "high",
      }),
      JSON.stringify({
        observation: "Goal achieved",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "done",
        confidence: "high",
        status: "complete",
      }),
    ]);
    const computerTool = createComputerTool();
    const approveAction = vi.fn(async () => ({
      approvalId: "approval-1",
      taskId: "task-1",
      sessionWide: true,
    }));

    await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click then type",
      approveAction,
      config: { maxSteps: 3 },
    });

    expect(approveAction).toHaveBeenCalledTimes(2);
    expect(computerTool.type).toHaveBeenCalledTimes(1);
  });

  it("records a failed step when the model call times out", async () => {
    vi.useFakeTimers();
    const modelProvider = createModelProvider("");
    vi.mocked(modelProvider.complete).mockImplementation(() => new Promise(() => {}));
    const computerTool = createComputerTool();

    const runPromise = runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: { maxSteps: 1, timeouts: { modelMs: 25 } },
    });

    await vi.advanceTimersByTimeAsync(25);
    const steps = await runPromise;
    vi.useRealTimers();

    expect(steps).toHaveLength(1);
    expect(steps[0].phase).toBe("failed");
    expect(steps[0].error).toContain("Computer Use model call timed out");
  });

  it("continues when listWindows times out but screenshot succeeds", async () => {
    vi.useFakeTimers();
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Goal achieved",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "done",
      confidence: "high",
      status: "complete",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.listWindows).mockImplementation(() => new Promise(() => {}));

    const runPromise = runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: { maxSteps: 1, timeouts: { listWindowsMs: 10 } },
    });

    await vi.advanceTimersByTimeAsync(10);
    const steps = await runPromise;
    vi.useRealTimers();

    expect(steps).toHaveLength(1);
    expect(steps[0].phase).toBe("completed");
    expect(modelProvider.complete).toHaveBeenCalledTimes(1);
  });

  it("reuses short-lived UIA context cache across quick steps", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "Need to wait briefly",
        action: { tool: "computer.wait", params: { ms: 1 } },
        target: "Let UI settle",
        confidence: "medium",
      }),
      JSON.stringify({
        observation: "Goal achieved",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "done",
        confidence: "high",
        status: "complete",
      }),
    ]);
    const computerTool = createComputerTool();
    vi.mocked(computerTool.listWindows).mockResolvedValue({
      windows: [{
        handle: 42,
        title: "Target App",
        className: "TargetWindow",
        rect: { x: 0, y: 0, width: 800, height: 600 },
        isVisible: true,
        isForeground: true,
      }],
    });
    vi.mocked(computerTool.inspectUi)
      .mockResolvedValueOnce({
        tree: "Button name=\"Save\" automationId=\"saveButton\"",
        nodeCount: 1,
      })
      .mockResolvedValueOnce({
        tree: "Button name=\"Save\" automationId=\"saveButton\"",
        nodeCount: 1,
      })
      .mockResolvedValue({
        tree: "Text name=\"Saved\" automationId=\"statusText\"",
        nodeCount: 1,
      });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Wait",
      config: { maxSteps: 2, uiCacheMs: 60_000 },
    });

    expect(computerTool.inspectUi).toHaveBeenCalledTimes(1);
    expect(steps[1].trace?.ui?.cacheHit).toBe(true);
  });

  it("emits progress phases while a step is running", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Need one click",
      action: { tool: "computer.click", params: { x: 100, y: 100 } },
      target: "Click target",
      confidence: "high",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.listWindows).mockResolvedValue({
      windows: [{
        handle: 42,
        title: "Target App",
        className: "TargetWindow",
        rect: { x: 0, y: 0, width: 800, height: 600 },
        isVisible: true,
        isForeground: true,
      }],
    });
    const approveAction = vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" }));
    const progress: string[] = [];

    await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click",
      approveAction,
      onProgress: (step) => {
        if (step.phase) progress.push(step.phase);
      },
      config: { maxSteps: 1, heartbeatMs: 0 },
    });

    expect(progress).toContain("observing");
    expect(progress).toContain("waiting_model");
    expect(progress).toContain("preflight");
    expect(progress).toContain("executing");
  });

  it("emits repeated heartbeat progress while waiting for the model", async () => {
    vi.useFakeTimers();
    const modelProvider = createModelProvider("");
    vi.mocked(modelProvider.complete).mockImplementation(async () =>
      new Promise((resolve) => {
        setTimeout(() => resolve({
          text: JSON.stringify({
            observation: "Goal achieved",
            action: { tool: "computer.wait", params: { ms: 0 } },
            target: "done",
            confidence: "high",
            status: "complete",
          }),
        }), 35);
      })
    );
    const computerTool = createComputerTool();
    const waitingModelProgress: string[] = [];

    const runPromise = runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      onProgress: (step) => {
        if (step.phase === "waiting_model") {
          waitingModelProgress.push(step.observation);
        }
      },
      config: { maxSteps: 1, heartbeatMs: 10, timeouts: { modelMs: 100 } },
    });

    await vi.advanceTimersByTimeAsync(45);
    const steps = await runPromise;
    vi.useRealTimers();

    expect(steps[0].phase).toBe("completed");
    expect(waitingModelProgress.length).toBeGreaterThanOrEqual(3);
    expect(waitingModelProgress).toContain("Still waiting for model action");
  });

  it("stops before executing when the abort signal fires", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Need one click",
      action: { tool: "computer.click", params: { x: 100, y: 100 } },
      target: "Click target",
      confidence: "high",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.listWindows).mockResolvedValue({
      windows: [{
        handle: 42,
        title: "Target App",
        className: "TargetWindow",
        rect: { x: 0, y: 0, width: 800, height: 600 },
        isVisible: true,
        isForeground: true,
      }],
    });
    const controller = new AbortController();
    const approveAction = vi.fn(async () => {
      controller.abort(new Error("cancel test"));
      return { approvalId: "approval-1", taskId: "task-1" };
    });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click",
      approveAction,
      signal: controller.signal,
      config: { maxSteps: 1 },
    });

    expect(steps).toHaveLength(1);
    expect(steps[0].phase).toBe("failed");
    expect(steps[0].error).toContain("cancel test");
    expect(computerTool.click).not.toHaveBeenCalled();
  });

  it("blocks coordinate write actions outside visible windows during preflight", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Need one click",
      action: { tool: "computer.click", params: { x: 900, y: 900 } },
      target: "Click outside",
      confidence: "medium",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.listWindows).mockResolvedValue({
      windows: [{
        handle: 42,
        title: "Target App",
        className: "TargetWindow",
        rect: { x: 0, y: 0, width: 300, height: 300 },
        isVisible: true,
        isForeground: true,
      }],
    });
    const approveAction = vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click outside",
      approveAction,
      config: { maxSteps: 1 },
    });

    expect(steps).toHaveLength(1);
    expect(steps[0].phase).toBe("failed");
    expect(steps[0].trace?.preflight?.passed).toBe(false);
    expect(steps[0].error).toContain("outside visible windows");
    expect(approveAction).not.toHaveBeenCalled();
    expect(computerTool.click).not.toHaveBeenCalled();
  });

  it("blocks coordinate write actions outside the foreground target window", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Need one click",
      action: { tool: "computer.click", params: { x: 450, y: 100 } },
      target: "Click another visible window",
      confidence: "medium",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.listWindows).mockResolvedValue({
      windows: [
        {
          handle: 42,
          title: "Target App",
          className: "TargetWindow",
          rect: { x: 0, y: 0, width: 300, height: 300 },
          isVisible: true,
          isForeground: true,
        },
        {
          handle: 99,
          title: "Other App",
          className: "OtherWindow",
          rect: { x: 400, y: 0, width: 300, height: 300 },
          isVisible: true,
          isForeground: false,
        },
      ],
    });
    const approveAction = vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click the target",
      approveAction,
      config: { maxSteps: 1 },
    });

    expect(steps[0].phase).toBe("failed");
    expect(steps[0].error).toContain("outside target window");
    expect(approveAction).not.toHaveBeenCalled();
    expect(computerTool.click).not.toHaveBeenCalled();
  });

  it("refreshes UIA before selector writes and blocks stale selectors before approval", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Save button is available in a target window",
      action: {
        tool: "computer.invokeUi",
        params: {
          selector: { windowHandle: 99, automationId: "saveButton", name: "Save" },
        },
      },
      target: "Invoke Save",
      confidence: "high",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.listWindows).mockResolvedValue({
      windows: [
        {
          handle: 42,
          title: "Foreground App",
          className: "ForegroundWindow",
          rect: { x: 0, y: 0, width: 800, height: 600 },
          isVisible: true,
          isForeground: true,
        },
        {
          handle: 99,
          title: "Target App",
          className: "TargetWindow",
          rect: { x: 20, y: 20, width: 800, height: 600 },
          isVisible: true,
          isForeground: false,
        },
      ],
    });
    vi.mocked(computerTool.inspectUi)
      .mockResolvedValueOnce({
        tree: "<Button name=\"Foreground\" automationId=\"foregroundButton\">",
        nodeCount: 1,
      })
      .mockResolvedValueOnce({
        tree: "<Text name=\"No Save\" automationId=\"statusText\">",
        nodeCount: 1,
      });
    const approveAction = vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Invoke Save",
      approveAction,
      config: { maxSteps: 1 },
    });

    expect(computerTool.inspectUi).toHaveBeenNthCalledWith(2, {
      windowHandle: 99,
      maxDepth: 4,
      maxNodes: 120,
    });
    expect(steps[0].phase).toBe("failed");
    expect(steps[0].error).toContain("selector is not present");
    expect(approveAction).not.toHaveBeenCalled();
    expect(computerTool.invokeUi).not.toHaveBeenCalled();
  });

  it("refreshes same-window UIA before selector writes instead of trusting cached context", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Save button is available in the current window",
      action: {
        tool: "computer.invokeUi",
        params: {
          selector: { windowHandle: 42, automationId: "saveButton", name: "Save" },
        },
      },
      target: "Invoke Save",
      confidence: "high",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.listWindows).mockResolvedValue({
      windows: [{
        handle: 42,
        title: "Target App",
        className: "TargetWindow",
        rect: { x: 0, y: 0, width: 800, height: 600 },
        isVisible: true,
        isForeground: true,
      }],
    });
    vi.mocked(computerTool.inspectUi)
      .mockResolvedValueOnce({
        tree: "<Button name=\"Save\" automationId=\"saveButton\">",
        nodeCount: 1,
      })
      .mockResolvedValueOnce({
        tree: "<Text name=\"Save is gone\" automationId=\"statusText\">",
        nodeCount: 1,
      });
    const approveAction = vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Invoke Save",
      approveAction,
      config: { maxSteps: 1, uiCacheMs: 60_000 },
    });

    expect(computerTool.inspectUi).toHaveBeenCalledTimes(2);
    expect(steps[0].phase).toBe("failed");
    expect(steps[0].error).toContain("selector is not present");
    expect(approveAction).not.toHaveBeenCalled();
    expect(computerTool.invokeUi).not.toHaveBeenCalled();
  });

  it("continues with UIA context when screenshot fails", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Save button is available in UIA",
      action: {
        tool: "computer.invokeUi",
        params: {
          selector: { windowHandle: 42, automationId: "saveButton", name: "Save" },
        },
      },
      target: "Invoke Save",
      confidence: "high",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.screenshot).mockRejectedValue(new Error("capture failed"));
    vi.mocked(computerTool.listWindows).mockResolvedValue({
      windows: [{
        handle: 42,
        title: "Target App",
        className: "TargetWindow",
        rect: { x: 0, y: 0, width: 800, height: 600 },
        isVisible: true,
        isForeground: true,
      }],
    });
    vi.mocked(computerTool.inspectUi)
      .mockResolvedValueOnce({
        tree: "Button name=\"Save\" automationId=\"saveButton\"",
        nodeCount: 1,
      })
      .mockResolvedValueOnce({
        tree: "Button name=\"Save\" automationId=\"saveButton\"",
        nodeCount: 1,
      })
      .mockResolvedValue({
        tree: "Text name=\"Saved\" automationId=\"statusText\"",
        nodeCount: 1,
      });
    vi.mocked(computerTool.invokeUi).mockResolvedValue({
      invoked: true,
      matchedName: "Save",
      matchedAutomationId: "saveButton",
    });
    const approveAction = vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Save the document",
      approveAction,
      config: { maxSteps: 1 },
    });

    expect(steps).toHaveLength(1);
    expect(steps[0].error).toBeUndefined();
    expect(steps[0].phase).toBe("completed");
    expect(modelProvider.complete).toHaveBeenCalledWith(expect.stringContaining("SCREENSHOT: unavailable"), undefined);
    expect(computerTool.invokeUi).toHaveBeenCalledWith(expect.objectContaining({
      approvalId: "approval-1",
      taskId: "task-1",
    }));
  });

  it("falls back to screenshot-driven actions when UIA inspection fails", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Target is visible in the screenshot",
      action: { tool: "computer.click", params: { x: 100, y: 100 } },
      target: "Click target",
      confidence: "high",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.listWindows).mockResolvedValue({
      windows: [{
        handle: 42,
        title: "Target App",
        className: "TargetWindow",
        rect: { x: 0, y: 0, width: 800, height: 600 },
        isVisible: true,
        isForeground: true,
      }],
    });
    vi.mocked(computerTool.inspectUi).mockRejectedValue(new Error("uia unavailable"));
    vi.mocked(computerTool.screenshot)
      .mockResolvedValueOnce({
        dataUrl: "data:image/png;base64,BEFORE==",
        width: 1920,
        height: 1080,
        capturedAt: "2026-06-04T00:00:00.000Z",
        methodUsed: "bitblt",
      })
      .mockResolvedValueOnce({
        dataUrl: "data:image/png;base64,AFTER==",
        width: 1920,
        height: 1080,
        capturedAt: "2026-06-04T00:00:01.000Z",
        methodUsed: "bitblt",
      });
    const approveAction = vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click target",
      approveAction,
      config: { maxSteps: 1 },
    });

    expect(modelProvider.complete).toHaveBeenCalledWith(expect.stringContaining("SCREENSHOT: 1920x1080"), expect.objectContaining({
      imageDataUrl: "data:image/png;base64,BEFORE==",
    }));
    expect(computerTool.click).toHaveBeenCalledWith(expect.objectContaining({
      x: 100,
      y: 100,
      approvalId: "approval-1",
      taskId: "task-1",
    }));
    expect(steps[0].error).toBeUndefined();
  });

  it("blocks coordinate writes when screenshot fails and no window geometry is available", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "No visual context",
      action: { tool: "computer.click", params: { x: 100, y: 100 } },
      target: "Click target",
      confidence: "low",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.screenshot).mockRejectedValue(new Error("capture failed"));
    vi.mocked(computerTool.listWindows).mockResolvedValue({ windows: [] });
    const approveAction = vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click target",
      approveAction,
      config: { maxSteps: 1 },
    });

    expect(steps).toHaveLength(1);
    expect(steps[0].phase).toBe("failed");
    expect(steps[0].error).toContain("coordinate action requires screenshot");
    expect(modelProvider.complete).toHaveBeenCalledTimes(1);
    expect(computerTool.click).not.toHaveBeenCalled();
  });

  it("verifies setUiValue with a post-action UIA value without exposing the value to the prompt", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Editable field is available",
      action: {
        tool: "computer.setUiValue",
        params: {
          selector: { windowHandle: 42, automationId: "nameInput", name: "Name" },
          value: "Alice",
        },
      },
      target: "Set the name",
      confidence: "high",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.listWindows).mockResolvedValue({
      windows: [{
        handle: 42,
        title: "Target App",
        className: "TargetWindow",
        rect: { x: 0, y: 0, width: 800, height: 600 },
        isVisible: true,
        isForeground: true,
      }],
    });
    vi.mocked(computerTool.inspectUi)
      .mockResolvedValueOnce({
        tree: "<Edit name=\"Name\" automationId=\"nameInput\">",
        nodeCount: 1,
      })
      .mockResolvedValueOnce({
        tree: "<Edit name=\"Name\" automationId=\"nameInput\">",
        nodeCount: 1,
      })
      .mockResolvedValueOnce({
        tree: "<Edit name=\"Name\" automationId=\"nameInput\" value=\"Alice\">",
        nodeCount: 1,
      });
    vi.mocked(computerTool.setUiValue).mockResolvedValue({
      set: true,
      matchedName: "Name",
      matchedAutomationId: "nameInput",
    });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Set the name",
      approveAction: vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" })),
      config: { maxSteps: 1 },
    });

    expect(steps[0].error).toBeUndefined();
    expect(steps[0].trace?.verification?.passed).toBe(true);
    expect(steps[0].trace?.verification?.reason).toContain("UIA value matched");
    expect(computerTool.inspectUi).toHaveBeenNthCalledWith(1, {
      windowHandle: 42,
      maxDepth: 4,
      maxNodes: 120,
    });
    expect(computerTool.inspectUi).toHaveBeenNthCalledWith(2, {
      windowHandle: 42,
      maxDepth: 4,
      maxNodes: 120,
    });
    expect(computerTool.inspectUi).toHaveBeenNthCalledWith(3, {
      windowHandle: 42,
      maxDepth: 4,
      maxNodes: 120,
      includeValues: true,
    });
    expect(vi.mocked(modelProvider.complete).mock.calls[0]?.[0]).not.toContain("Alice");
  });

  it("fails setUiValue verification when the selected UIA value remains different", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Editable field is available",
      action: {
        tool: "computer.setUiValue",
        params: {
          selector: { windowHandle: 42, automationId: "nameInput", name: "Name" },
          value: "Alice",
        },
      },
      target: "Set the name",
      confidence: "high",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.listWindows).mockResolvedValue({
      windows: [{
        handle: 42,
        title: "Target App",
        className: "TargetWindow",
        rect: { x: 0, y: 0, width: 800, height: 600 },
        isVisible: true,
        isForeground: true,
      }],
    });
    vi.mocked(computerTool.inspectUi)
      .mockResolvedValueOnce({
        tree: "<Edit name=\"Name\" automationId=\"nameInput\">",
        nodeCount: 1,
      })
      .mockResolvedValueOnce({
        tree: "<Edit name=\"Name\" automationId=\"nameInput\">",
        nodeCount: 1,
      })
      .mockResolvedValueOnce({
        tree: "<Edit name=\"Name\" automationId=\"nameInput\" value=\"Bob\">",
        nodeCount: 1,
      });
    vi.mocked(computerTool.setUiValue).mockResolvedValue({
      set: true,
      matchedName: "Name",
      matchedAutomationId: "nameInput",
    });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Set the name",
      approveAction: vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" })),
      config: { maxSteps: 1 },
    });

    expect(steps[0].phase).toBe("failed");
    expect(steps[0].error).toContain("UIA value did not match");
  });

  it("redacts UIA values and typed text from later model history", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "Input is focused",
        action: { tool: "computer.type", params: { text: "secret note" } },
        target: "Type note",
        confidence: "high",
      }),
      JSON.stringify({
        observation: "Done",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "done",
        confidence: "high",
        status: "complete",
      }),
    ]);
    const computerTool = createComputerTool();
    vi.mocked(computerTool.listWindows).mockResolvedValue({
      windows: [{
        handle: 42,
        title: "Target App",
        className: "TargetWindow",
        rect: { x: 0, y: 0, width: 800, height: 600 },
        isVisible: true,
        isForeground: true,
      }],
    });
    vi.mocked(computerTool.inspectUi)
      .mockResolvedValueOnce({
        tree: "<Edit name=\"Note\" automationId=\"noteInput\">",
        nodeCount: 1,
      })
      .mockResolvedValueOnce({
        tree: "<Edit name=\"Note\" automationId=\"noteInput\" value=\"secret note\">",
        nodeCount: 1,
      })
      .mockResolvedValueOnce({
        tree: "<Edit name=\"Note\" automationId=\"noteInput\">",
        nodeCount: 1,
      });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Type a note",
      approveAction: vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" })),
      config: { maxSteps: 2, uiCacheMs: 0 },
    });

    const secondPrompt = vi.mocked(modelProvider.complete).mock.calls[1]?.[0] ?? "";
    expect(steps[0].trace?.verification?.reason).toContain("11 chars");
    expect(secondPrompt).toContain("[redacted:11 chars]");
    expect(secondPrompt).not.toContain("secret note");
  });

  it("retries a low-risk write once when the tool reports explicit failure", async () => {
    vi.useFakeTimers();
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Need one click",
      action: { tool: "computer.click", params: { x: 100, y: 100 } },
      target: "Click target",
      confidence: "high",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.listWindows).mockResolvedValue({
      windows: [{
        handle: 42,
        title: "Target App",
        className: "TargetWindow",
        rect: { x: 0, y: 0, width: 300, height: 300 },
        isVisible: true,
        isForeground: true,
      }],
    });
    vi.mocked(computerTool.click)
      .mockResolvedValueOnce({ x: 100, y: 100, clicked: false })
      .mockResolvedValueOnce({ x: 100, y: 100, clicked: true });
    vi.mocked(computerTool.screenshot)
      .mockResolvedValue({
        dataUrl: "data:image/png;base64,BEFORE==",
        width: 300,
        height: 300,
        capturedAt: "2026-06-04T00:00:00.000Z",
        methodUsed: "bitblt",
      });
    const approveAction = vi.fn()
      .mockResolvedValueOnce({ approvalId: "approval-1", taskId: "task-1" })
      .mockResolvedValueOnce({ approvalId: "approval-2", taskId: "task-1" });

    const runPromise = runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click target",
      approveAction,
      config: { maxSteps: 1 },
    });
    await vi.advanceTimersByTimeAsync(60);
    const steps = await runPromise;
    vi.useRealTimers();

    expect(steps[0].phase).toBe("completed");
    expect(steps[0].trace?.verification?.reason).toContain("retried once");
    expect(approveAction).toHaveBeenCalledTimes(2);
    expect(computerTool.click).toHaveBeenCalledTimes(2);
    expect(computerTool.click).toHaveBeenNthCalledWith(2, expect.objectContaining({
      approvalId: "approval-2",
      taskId: "task-1",
    }));
  });

  it("does not retry text entry when value verification fails", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Input is focused",
      action: { tool: "computer.type", params: { text: "secret note" } },
      target: "Type note",
      confidence: "high",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.listWindows).mockResolvedValue({
      windows: [{
        handle: 42,
        title: "Target App",
        className: "TargetWindow",
        rect: { x: 0, y: 0, width: 800, height: 600 },
        isVisible: true,
        isForeground: true,
      }],
    });
    vi.mocked(computerTool.inspectUi)
      .mockResolvedValueOnce({
        tree: "<Edit name=\"Note\" automationId=\"noteInput\">",
        nodeCount: 1,
      })
      .mockResolvedValueOnce({
        tree: "<Edit name=\"Note\" automationId=\"noteInput\" value=\"\">",
        nodeCount: 1,
      });
    vi.mocked(computerTool.type).mockResolvedValue({ typed: true, length: 11 });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Type a note",
      approveAction: vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" })),
      config: { maxSteps: 1 },
    });

    expect(steps[0].phase).toBe("failed");
    expect(computerTool.type).toHaveBeenCalledTimes(1);
  });
});
