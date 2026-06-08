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
    vi.mocked(computerTool.inspectUi).mockResolvedValue({
      tree: "Button name=\"Save\" automationId=\"saveButton\"",
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

    expect(vi.mocked(modelProvider.complete).mock.calls[1]?.[1]?.imageDataUrl).toBe("data:image/png;base64,WINDOW==");
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
});
