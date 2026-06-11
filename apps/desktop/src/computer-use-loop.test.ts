import { describe, expect, it, vi } from "vitest";
import type { ComputerDetectUiObjectsResult, ComputerTool } from "@javis/tools";
import type { ComputerUseLoopConfig, ComputerUseStep } from "@javis/core";
import type { ModelProvider } from "./model-provider";
import { formatStepHistory, runComputerUseLoop } from "./computer-use-loop";

const TINY_BLACK_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

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

function createLocalVisionDetection(options: {
  id: string;
  label: string;
  confidence: number;
  x: number;
  y: number;
  width: number;
  height: number;
}): ComputerDetectUiObjectsResult["detections"][number] {
  return {
    id: options.id,
    label: options.label,
    confidence: options.confidence,
    box: {
      x: options.x,
      y: options.y,
      width: options.width,
      height: options.height,
      coordinateSpace: "screenshot" as const,
    },
    center: {
      x: options.x + options.width / 2,
      y: options.y + options.height / 2,
      coordinateSpace: "screenshot" as const,
    },
    source: "yolo26" as const,
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

  it("passes the current screenshot to approval when live previews are enabled", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "A target button is visible",
      action: { tool: "computer.click", params: { x: 100, y: 200 } },
      target: "Click the target",
      confidence: "high",
    }));
    const computerTool = createComputerTool();
    const approveAction = vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" }));

    await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click the target",
      approveAction,
      includeApprovalScreenshotPreview: true,
      config: { maxSteps: 1 },
    });

    expect(approveAction).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "computer.click" }),
      expect.objectContaining({
        requiresFreshApproval: false,
        screenshotDataUrl: "data:image/png;base64,AA==",
      }),
    );
  });

  it("passes the approval timeout budget to the approval handler", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "A target button is visible",
      action: { tool: "computer.click", params: { x: 100, y: 200 } },
      target: "Click the target",
      confidence: "high",
    }));
    const computerTool = createComputerTool();
    const approveAction = vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" }));

    await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click the target",
      approveAction,
      config: { maxSteps: 1, timeouts: { approvalMs: 2_500 } },
    });

    expect(approveAction).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "computer.click" }),
      expect.objectContaining({ timeoutMs: 2_500 }),
    );
  });

  it("applies configured mouse and typing pacing to native write requests", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "A field is visible",
        action: { tool: "computer.moveMouse", params: { x: 100, y: 200 } },
        target: "Move to field",
        confidence: "high",
      }),
      JSON.stringify({
        observation: "The field is focused",
        action: { tool: "computer.type", params: { text: "Hello" } },
        target: "Type greeting",
        confidence: "high",
      }),
    ]);
    const computerTool = createComputerTool();
    vi.mocked(computerTool.moveMouse).mockResolvedValue({ x: 100, y: 200 });
    vi.mocked(computerTool.type).mockResolvedValue({ typed: true, length: 5 });
    const approveAction = vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" }));

    await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Move and type",
      approveAction,
      config: {
        maxSteps: 2,
        mouseSpeed: "linear",
        mouseDurationMs: 300,
        typeDelayMs: 15,
      },
    });

    expect(computerTool.moveMouse).toHaveBeenCalledWith(expect.objectContaining({
      speed: "linear",
      durationMs: 300,
    }));
    expect(computerTool.type).toHaveBeenCalledWith(expect.objectContaining({
      text: "Hello",
      delayMs: 15,
    }));
  });

  it("blocks custom denied window patterns before approval", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "A button is visible in the admin console",
      action: { tool: "computer.click", params: { x: 100, y: 200 } },
      target: "Click the admin button",
      confidence: "high",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.listWindows).mockResolvedValue({
      windows: [{
        handle: 7,
        title: "Admin Console",
        className: "AdminWindow",
        rect: { x: 0, y: 0, width: 800, height: 600 },
        isVisible: true,
        isForeground: true,
      }],
    });
    const approveAction = vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click the admin button",
      approveAction,
      config: { maxSteps: 1, deniedWindowPatterns: ["admin console"] },
    });

    expect(approveAction).not.toHaveBeenCalled();
    expect(computerTool.click).not.toHaveBeenCalled();
    expect(steps[0].error).toContain("matches denied pattern");
  });

  it("pauses before model planning when the full desktop screenshot looks blank or locked", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Click the visible target",
      action: { tool: "computer.click", params: { x: 100, y: 200 } },
      target: "Click target",
      confidence: "high",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.screenshot).mockResolvedValue({
      dataUrl: TINY_BLACK_PNG_DATA_URL,
      width: 1920,
      height: 1080,
      capturedAt: "2026-06-04T00:00:00.000Z",
      methodUsed: "bitblt",
    });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click the target",
      config: { maxSteps: 1 },
    });

    expect(steps).toHaveLength(1);
    expect(steps[0].phase).toBe("failed");
    expect(steps[0].error).toContain("screenshot appears blank or locked");
    expect(modelProvider.complete).not.toHaveBeenCalled();
    expect(computerTool.click).not.toHaveBeenCalled();
  });

  it("uses native screenshot health to pause on mostly solid full-desktop captures", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Click the visible target",
      action: { tool: "computer.click", params: { x: 100, y: 200 } },
      target: "Click target",
      confidence: "high",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.screenshot).mockResolvedValue({
      dataUrl: "data:image/png;base64,AA==",
      width: 1920,
      height: 1080,
      capturedAt: "2026-06-04T00:00:00.000Z",
      methodUsed: "bitblt",
      health: {
        sampledPixels: 4096,
        dominantColorRatio: 1,
        darkPixelRatio: 0,
        suspiciousBlank: true,
        reason: "solid",
      },
    });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click the target",
      config: { maxSteps: 1 },
    });

    expect(steps).toHaveLength(1);
    expect(steps[0].phase).toBe("failed");
    expect(steps[0].error).toContain("screenshot appears mostly one color");
    expect(modelProvider.complete).not.toHaveBeenCalled();
    expect(computerTool.click).not.toHaveBeenCalled();
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
    vi.mocked(computerTool.inspectUi).mockResolvedValue({
      tree: "<Button name=\"Delete\" automationId=\"deleteButton\">",
      nodeCount: 1,
    });
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

  it("does not keep screenshot data URLs in recorded steps", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "Need target window screenshot",
        action: { tool: "computer.screenshot", params: { windowHandle: 99, method: "auto" } },
        target: "Inspect target window",
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
        capturedAt: "2026-06-04T00:00:01.000Z",
        methodUsed: "printWindow",
      });
    vi.mocked(computerTool.listWindows).mockResolvedValue({
      windows: [{
        handle: 99,
        title: "Target App",
        className: "TargetWindow",
        rect: { x: 400, y: 0, width: 300, height: 300 },
        isVisible: true,
        isForeground: true,
      }],
    });
    const recordedSteps: unknown[] = [];

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect target",
      onStep: (step) => recordedSteps.push(step),
      config: { maxSteps: 2 },
    });

    expect(vi.mocked(modelProvider.complete).mock.calls[0]?.[1]?.imageDataUrl).toBe("data:image/png;base64,FULL==");
    expect(vi.mocked(modelProvider.complete).mock.calls[1]?.[1]?.imageDataUrl).toBe("data:image/png;base64,WINDOW==");
    expect(JSON.stringify(steps)).not.toContain("data:image");
    expect(JSON.stringify(recordedSteps)).not.toContain("data:image");
    expect(steps[0].screenshotDataUrl).toBe("");
    expect((steps[0].result as { dataUrl?: string }).dataUrl).toContain("[redacted:image data URL:");
  });

  it("redacts embedded image data URLs from recorded tool results", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Need window list",
      action: { tool: "computer.listWindows", params: {} },
      target: "Inspect windows",
      confidence: "medium",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.listWindows).mockResolvedValue({
      windows: [{
        handle: 1,
        title: "preview data:image/png;base64,EMBEDDED== end",
        className: "Window",
        rect: { x: 0, y: 0, width: 100, height: 100 },
        isVisible: true,
        isForeground: true,
      }],
    });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "List windows",
      config: { maxSteps: 1 },
    });

    const serialized = JSON.stringify(steps);
    expect(serialized).not.toContain("data:image");
    expect(serialized).toContain("[redacted:image data URL:");
    expect(steps[0].trace?.windows?.titles.join("\n")).not.toContain("data:image");
  });

  it("redacts embedded image data URLs from recorded action params", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Invoke the visible target",
      action: {
        tool: "computer.invokeUi",
        params: {
          selector: {
            windowHandle: 42,
            automationId: "saveButton",
            name: "Save data:image/png;base64,ACTION_PARAM_SHOULD_NOT_SURVIVE==",
          },
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
    vi.mocked(computerTool.inspectUi).mockResolvedValue({
      tree: "<Button name=\"Save\" automationId=\"saveButton\">",
      nodeCount: 1,
    });
    vi.mocked(computerTool.invokeUi).mockResolvedValue({
      invoked: true,
      matchedName: "Save",
      matchedAutomationId: "saveButton",
    });
    const approveAction = vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" }));
    const recordedSteps: unknown[] = [];

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Invoke Save",
      approveAction,
      onStep: (step) => recordedSteps.push(step),
      config: { maxSteps: 1 },
    });

    expect(JSON.stringify(steps)).not.toContain("data:image");
    expect(JSON.stringify(recordedSteps)).not.toContain("data:image");
    expect(JSON.stringify(steps)).not.toContain("ACTION_PARAM_SHOULD_NOT_SURVIVE");
    expect(JSON.stringify(recordedSteps)).not.toContain("ACTION_PARAM_SHOULD_NOT_SURVIVE");
    expect(JSON.stringify(steps[0].action.params)).toContain("[redacted:image data URL:");
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

  it("allows zero-duration waits to complete with normal IPC overhead", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Need an immediate settle tick",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "Let the desktop settle",
      confidence: "medium",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.wait).mockImplementation(async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { waited: request.ms };
    });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Wait briefly",
      config: { maxSteps: 1 },
    });

    expect(computerTool.wait).toHaveBeenCalledWith({ ms: 0 });
    expect(steps[0].phase).toBe("completed");
    expect(steps[0].error).toBeUndefined();
  });

  it("does not treat contradictory completion output as done", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "Goal achieved, but also clicking a target",
        action: { tool: "computer.click", params: { x: 100, y: 200 } },
        target: "Click the target",
        confidence: "high",
        status: "complete",
      }),
      JSON.stringify({
        observation: "Need to wait instead",
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
    expect(computerTool.click).not.toHaveBeenCalled();
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

  it("does not let the default step deadline preempt a slow approval within approvalMs", async () => {
    vi.useFakeTimers();
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Target window is visible",
      action: { tool: "computer.focusWindow", params: { handle: 42 } },
      target: "Focus target window",
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
    vi.mocked(computerTool.focusWindow).mockResolvedValue({ focused: true, title: "Target App" });
    const approveAction = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 13_000));
      return { approvalId: "approval-1", taskId: "task-1" };
    });

    const runPromise = runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Focus target window",
      approveAction,
      config: { maxSteps: 1, timeouts: { approvalMs: 20_000 } },
    });

    await vi.advanceTimersByTimeAsync(13_000);
    const steps = await runPromise;
    vi.useRealTimers();

    expect(approveAction).toHaveBeenCalledTimes(1);
    expect(computerTool.focusWindow).toHaveBeenCalledWith(expect.objectContaining({
      approvalId: "approval-1",
      taskId: "task-1",
    }));
    expect(steps[0].phase).toBe("completed");
    expect(steps[0].error).toBeUndefined();
  });

  it("rechecks window geometry after slow approval before executing coordinates", async () => {
    vi.useFakeTimers();
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "The target button is in the foreground window",
      action: { tool: "computer.click", params: { x: 50, y: 50 } },
      target: "Click target",
      confidence: "high",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.listWindows)
      .mockResolvedValueOnce({
        windows: [{
          handle: 42,
          title: "Target App",
          className: "TargetWindow",
          rect: { x: 0, y: 0, width: 100, height: 100 },
          isVisible: true,
          isForeground: true,
        }],
      })
      .mockResolvedValueOnce({
        windows: [{
          handle: 42,
          title: "Target App",
          className: "TargetWindow",
          rect: { x: 500, y: 500, width: 100, height: 100 },
          isVisible: true,
          isForeground: true,
        }],
      });
    const approveAction = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      return { approvalId: "approval-1", taskId: "task-1" };
    });

    const runPromise = runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click target",
      approveAction,
      config: { maxSteps: 1, timeouts: { approvalMs: 5_000 } },
    });

    await vi.advanceTimersByTimeAsync(1_200);
    const steps = await runPromise;
    vi.useRealTimers();

    expect(computerTool.listWindows).toHaveBeenCalledTimes(2);
    expect(computerTool.click).not.toHaveBeenCalled();
    expect(steps[0].error).toContain("Post-approval preflight failed");
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
    expect(secondPrompt).not.toContain("data:image/png;base64");
  });

  it("omits previous steps when historySteps is zero", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "First step",
        action: { tool: "computer.wait", params: { ms: 1 } },
        target: "Wait",
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
      userGoal: "Wait without history",
      config: { maxSteps: 2, historySteps: 0 },
    });

    const secondPrompt = vi.mocked(modelProvider.complete).mock.calls[1]?.[0] ?? "";
    expect(secondPrompt).not.toContain("PREVIOUS STEPS");
    expect(formatStepHistory([{
      stepIndex: 0,
      screenshotDataUrl: TINY_BLACK_PNG_DATA_URL,
      observation: "Old step",
      action: { tool: "computer.wait", params: { ms: 1 } },
      target: "Old target",
      confidence: "medium",
    }], 0)).toBe("");
  });

  it("normalizes unsafe loop step counts", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Keep waiting",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "wait",
      confidence: "medium",
    }));
    const computerTool = createComputerTool();

    const minimumSteps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Do at least one observation",
      config: { maxSteps: 0 as never },
    });

    expect(minimumSteps).toHaveLength(1);

    const cappedModelProvider = createSequenceModelProvider(
      Array.from({ length: 100 }, (_, index) => JSON.stringify({
        observation: `Keep waiting ${index}`,
        action: { tool: "computer.wait", params: { ms: index + 1 } },
        target: "wait",
        confidence: "medium",
      })),
    );
    const cappedSteps = await runComputerUseLoop({
      modelProvider: cappedModelProvider,
      computerTool,
      userGoal: "Do not run forever",
      config: { maxSteps: 999 as never },
    });

    expect(cappedSteps).toHaveLength(60);
    expect(cappedModelProvider.complete).toHaveBeenCalledTimes(60);
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
      tree: "<Button automationId=\"saveButton\" name=\"Save\">",
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

  it("allows a high-risk coordinate target to use a matching UIA selector with fresh approval", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "The Delete button is visible",
      action: { tool: "computer.click", params: { x: 210, y: 210 } },
      target: "Delete",
      confidence: "high",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.screenshot)
      .mockResolvedValueOnce({
        dataUrl: "data:image/png;base64,DELETE-BEFORE==",
        width: 1920,
        height: 1080,
        capturedAt: "2026-06-04T00:00:00.000Z",
        methodUsed: "bitblt" as const,
      })
      .mockResolvedValueOnce({
        dataUrl: "data:image/png;base64,DELETE-AFTER==",
        width: 1920,
        height: 1079,
        capturedAt: "2026-06-04T00:00:01.000Z",
        methodUsed: "bitblt" as const,
      });
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
      tree: "<Button name=\"Delete\" automationId=\"deleteButton\">",
      nodeCount: 1,
    });
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [createLocalVisionDetection({
        id: "det_delete",
        label: "deleteButton",
        confidence: 0.95,
        x: 180,
        y: 190,
        width: 80,
        height: 40,
      })],
      latencyMs: 4,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));
    vi.mocked(computerTool.invokeUi).mockResolvedValue({
      invoked: true,
      matchedName: "Delete",
      matchedAutomationId: "deleteButton",
    });
    const approveAction = vi.fn(async (action, options) => {
      expect(action.tool).toBe("computer.invokeUi");
      expect(options).toEqual(expect.objectContaining({
        requiresFreshApproval: true,
        trustedWindowTitle: "Target App",
      }));
      return { approvalId: "approval-1", taskId: "task-1", sessionWide: true };
    });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Delete the item",
      approveAction,
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          minConfidence: 0.75,
        },
      },
    });

    expect(computerTool.click).not.toHaveBeenCalled();
    expect(computerTool.invokeUi).toHaveBeenCalledWith(expect.objectContaining({
      selector: expect.objectContaining({
        windowHandle: 42,
        automationId: "deleteButton",
        name: "Delete",
      }),
      approvalId: "approval-1",
      taskId: "task-1",
    }));
    expect(steps[0].phase).toBe("completed");
    expect(steps[0].trace?.preflight).toEqual(expect.objectContaining({
      passed: true,
      reason: "selector appears in current UIA tree",
    }));
    expect(steps[0].trace?.action).toEqual(expect.objectContaining({
      originalTool: "computer.click",
      strategy: "uia_preferred",
      approvalMode: "per_action",
    }));
    expect(steps[0].trace?.localVision).toEqual(expect.objectContaining({
      selectedCandidateId: "candidate_det_delete",
      selectedCandidateSource: ["uia", "yolo"],
      actionRisk: "high",
      actionSucceeded: true,
    }));
  });

  it("fuses UIA bounds with local vision candidates by spatial overlap", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Inspect candidates",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "continue",
      confidence: "medium",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.screenshot).mockResolvedValue({
      dataUrl: "data:image/png;base64,SCREEN==",
      width: 800,
      height: 600,
      sourceWidth: 800,
      sourceHeight: 600,
      sourceOriginX: 100,
      sourceOriginY: 200,
      scaleX: 1,
      scaleY: 1,
      capturedAt: "2026-06-04T00:00:00.000Z",
      methodUsed: "bitblt",
    });
    vi.mocked(computerTool.listWindows).mockResolvedValue({
      windows: [{
        handle: 42,
        title: "Target App",
        className: "TargetWindow",
        rect: { x: 100, y: 200, width: 800, height: 600 },
        isVisible: true,
        isForeground: true,
      }],
    });
    vi.mocked(computerTool.inspectUi).mockResolvedValue({
      tree: "<Button name=\"Save\" automationId=\"saveButton\" bounds=\"220,280,90,32\">",
      nodeCount: 1,
    });
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [createLocalVisionDetection({
        id: "det_generic",
        label: "possible_control",
        confidence: 0.86,
        x: 118,
        y: 76,
        width: 96,
        height: 40,
      })],
      latencyMs: 5,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click Save",
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
        },
      },
    });

    const prompt = vi.mocked(modelProvider.complete).mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("LOCAL_UI_CANDIDATES");
    expect(prompt).toContain("text=\"Save\"");
    expect(prompt).toContain("evidence=uia:saveButton+yolo:0.86");
    expect(prompt).toContain("mode=uia_or_vlm_confirmed");
    expect(prompt).toContain("uia+yolo evidence; prefer selector");
    expect(steps[0].trace?.localVision?.promptCandidateCount).toBe(1);
  });

  it("maps scaled UIA bounds into screenshot coordinates before local vision fusion", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Inspect candidates",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "continue",
      confidence: "medium",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.screenshot).mockResolvedValue({
      dataUrl: "data:image/png;base64,SCALED==",
      width: 960,
      height: 540,
      sourceWidth: 1920,
      sourceHeight: 1080,
      sourceOriginX: -1920,
      sourceOriginY: 0,
      scaleX: 0.5,
      scaleY: 0.5,
      capturedAt: "2026-06-04T00:00:00.000Z",
      methodUsed: "bitblt",
    });
    vi.mocked(computerTool.listWindows).mockResolvedValue({
      windows: [{
        handle: 42,
        title: "Scaled App",
        className: "ScaledWindow",
        rect: { x: -1920, y: 0, width: 1920, height: 1080 },
        isVisible: true,
        isForeground: true,
      }],
    });
    vi.mocked(computerTool.inspectUi).mockResolvedValue({
      tree: "<Button name=\"Save\" automationId=\"saveButton\" bounds=\"-1720,120,200,80\">",
      nodeCount: 1,
    });
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [createLocalVisionDetection({
        id: "det_scaled",
        label: "possible_control",
        confidence: 0.88,
        x: 98,
        y: 58,
        width: 104,
        height: 44,
      })],
      latencyMs: 5,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));

    await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click Save",
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
        },
      },
    });

    const prompt = vi.mocked(modelProvider.complete).mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("text=\"Save\"");
    expect(prompt).toContain("evidence=uia:saveButton+yolo:0.88");
    expect(prompt).toContain("box=[98,58,104,44]");
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

  it("passes a model-requested screenshot crop region through without recording image data", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "Need a closer look at a likely Save button",
        action: {
          tool: "computer.screenshot",
          params: {
            windowHandle: 42,
            region: { x: 100, y: 120, width: 320, height: 180 },
            method: "auto",
          },
        },
        target: "Inspect the candidate region",
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
      dataUrl: request.region
        ? "data:image/png;base64,CROP=="
        : "data:image/png;base64,DESKTOP==",
      width: request.region?.width ?? 1920,
      height: request.region?.height ?? 1080,
      sourceWidth: request.region?.width,
      sourceHeight: request.region?.height,
      sourceOriginX: request.region?.x,
      sourceOriginY: request.region?.y,
      scaleX: 1,
      scaleY: 1,
      capturedAt: "2026-06-04T00:00:00.000Z",
      methodUsed: request.windowHandle === 42 ? "printWindow" as const : "bitblt" as const,
    }));
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [{
        id: "det_save",
        label: "saveButton",
        confidence: 0.92,
        box: {
          x: 100,
          y: 120,
          width: 320,
          height: 180,
          coordinateSpace: "screenshot" as const,
        },
        center: {
          x: 260,
          y: 210,
          coordinateSpace: "screenshot" as const,
        },
        source: "yolo26" as const,
      }],
      latencyMs: 3,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));
    const recordedSteps: unknown[] = [];

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect a likely target region",
      onStep: (step) => recordedSteps.push(step),
      config: {
        maxSteps: 2,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
        },
      },
    });

    expect(computerTool.screenshot).toHaveBeenNthCalledWith(2, {
      windowHandle: 42,
      region: { x: 100, y: 120, width: 320, height: 180 },
      method: "auto",
    });
    expect(computerTool.detectUiObjects).toHaveBeenCalledTimes(1);
    const firstPrompt = vi.mocked(modelProvider.complete).mock.calls[0]?.[0] ?? "";
    const secondPrompt = vi.mocked(modelProvider.complete).mock.calls[1]?.[0] ?? "";
    expect(firstPrompt).toContain("LOCAL_UI_CANDIDATES");
    expect(secondPrompt).not.toContain("LOCAL_UI_CANDIDATES");
    expect(vi.mocked(modelProvider.complete).mock.calls[1]?.[1]?.imageDataUrl).toBe("data:image/png;base64,CROP==");
    expect(secondPrompt).toContain("cropped screenshot requested by a previous action");
    expect(steps[1].trace?.screenshot).toEqual(expect.objectContaining({
      visionSource: "crop",
      sourceOriginX: 100,
      sourceOriginY: 120,
    }));
    expect(JSON.stringify(steps)).not.toContain("data:image/png;base64,CROP==");
    expect(JSON.stringify(recordedSteps)).not.toContain("data:image/png;base64,CROP==");
    expect((steps[0].result as { dataUrl?: string }).dataUrl).toContain("[redacted:image data URL:");
    expect(steps[1].trace?.localVision).toEqual(expect.objectContaining({
      mode: "disabled",
      used: false,
      detectionCount: 0,
      promptCandidateCount: 0,
      cropVlmCalled: true,
      fullScreenshotVlmCalled: false,
      fullScreenshotVlmSkipped: true,
    }));
    expect(steps[1].trace?.localVision?.error).toBe("local vision skipped for cropped screenshot");
  });

  it("maps coordinate actions from a cropped screenshot back to screen coordinates", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "Need a closer look",
        action: {
          tool: "computer.screenshot",
          params: {
            region: { x: 100, y: 120, width: 320, height: 180 },
            method: "auto",
          },
        },
        target: "Inspect region",
        confidence: "medium",
      }),
      JSON.stringify({
        observation: "The target is visible in the cropped screenshot",
        action: { tool: "computer.click", params: { x: 10, y: 20 } },
        target: "Click target in crop",
        confidence: "high",
      }),
    ]);
    const computerTool = createComputerTool();
    vi.mocked(computerTool.screenshot).mockImplementation(async (request) => ({
      dataUrl: request.region
        ? "data:image/png;base64,CROP=="
        : "data:image/png;base64,FULL==",
      width: request.region?.width ?? 1920,
      height: request.region?.height ?? 1080,
      sourceWidth: request.region?.width,
      sourceHeight: request.region?.height,
      sourceOriginX: request.region?.x,
      sourceOriginY: request.region?.y,
      scaleX: 1,
      scaleY: 1,
      capturedAt: request.region
        ? "2026-06-04T00:00:01.000Z"
        : "2026-06-04T00:00:00.000Z",
      methodUsed: "bitblt" as const,
    }));
    vi.mocked(computerTool.click).mockResolvedValue({
      x: 110,
      y: 140,
      clicked: true,
    });
    const approveAction = vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click the target in the cropped region",
      approveAction,
      config: { maxSteps: 2 },
    });

    expect(computerTool.click).toHaveBeenCalledWith(expect.objectContaining({
      x: 110,
      y: 140,
    }));
    expect(steps[1].action).toEqual(expect.objectContaining({
      tool: "computer.click",
      params: expect.objectContaining({ x: 110, y: 140 }),
    }));
    expect(steps[1].trace?.screenshot).toEqual(expect.objectContaining({
      visionSource: "crop",
      sourceOriginX: 100,
      sourceOriginY: 120,
    }));
    expect(JSON.stringify(steps)).not.toContain("data:image/png;base64,CROP==");
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

  it("reuses task approval for later low-risk writes in the same known window", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "Target window is visible",
        action: { tool: "computer.focusWindow", params: { handle: 42 } },
        target: "Focus target window",
        confidence: "high",
      }),
      JSON.stringify({
        observation: "Target window still needs focus",
        action: { tool: "computer.focusWindow", params: { handle: 42 } },
        target: "Focus target window again",
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
    vi.mocked(computerTool.focusWindow).mockResolvedValue({ focused: true, title: "Target App" });
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
    expect(computerTool.focusWindow).toHaveBeenCalledTimes(2);
    expect(computerTool.focusWindow).toHaveBeenNthCalledWith(2, expect.objectContaining({
      approvalId: "approval-1",
      taskId: "task-1",
    }));
  });

  it("does not cache a frontend task approval lease when the action window cannot be inferred", async () => {
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
    ]);
    const computerTool = createComputerTool();
    const approveAction = vi.fn()
      .mockResolvedValueOnce({ approvalId: "approval-1", taskId: "task-1", sessionWide: true })
      .mockResolvedValueOnce({ approvalId: "approval-2", taskId: "task-1", sessionWide: true });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click both targets",
      approveAction,
      config: { maxSteps: 2 },
    });

    expect(steps.map((step) => step.trace?.action?.approvalMode)).toEqual(["per_action", "per_action"]);
    expect(approveAction).toHaveBeenCalledTimes(2);
    expect(computerTool.click).toHaveBeenNthCalledWith(2, expect.objectContaining({
      approvalId: "approval-2",
      taskId: "task-1",
    }));
  });

  it("refreshes task approval instead of reusing an expired frontend lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T00:00:00.000Z"));
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
    ]);
    const computerTool = createComputerTool();
    vi.mocked(computerTool.click)
      .mockImplementationOnce(async (request) => {
        vi.setSystemTime(new Date("2026-06-04T00:02:01.000Z"));
        return { x: request.x, y: request.y, clicked: true };
      })
      .mockImplementationOnce(async (request) => ({ x: request.x, y: request.y, clicked: true }));
    vi.mocked(computerTool.screenshot).mockImplementation(async () => ({
      dataUrl: `data:image/png;base64,${Date.now()}==`,
      width: 1920,
      height: 1080,
      capturedAt: new Date(Date.now()).toISOString(),
      methodUsed: "bitblt" as const,
    }));
    const approveAction = vi.fn()
      .mockResolvedValueOnce({ approvalId: "approval-1", taskId: "task-1", sessionWide: true })
      .mockResolvedValueOnce({ approvalId: "approval-2", taskId: "task-1", sessionWide: true });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click both targets",
      approveAction,
      config: { maxSteps: 2 },
    });

    expect(steps.map((step) => step.trace?.action?.approvalMode)).toEqual(["per_action", "per_action"]);
    expect(approveAction).toHaveBeenCalledTimes(2);
    expect(computerTool.click).toHaveBeenNthCalledWith(2, expect.objectContaining({
      approvalId: "approval-2",
      taskId: "task-1",
    }));
    vi.useRealTimers();
  });

  it("refreshes task approval after the frontend lease action limit is reached", async () => {
    const actions = Array.from({ length: 14 }, (_, index) => JSON.stringify({
      observation: `Target ${index + 1} is visible`,
      action: { tool: "computer.moveMouse", params: { x: 100 + index, y: 200 + index } },
      target: `Move to target ${index + 1}`,
      confidence: "high",
    }));
    const modelProvider = createSequenceModelProvider(actions);
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
    vi.mocked(computerTool.moveMouse).mockImplementation(async (request) => ({
      x: request.x,
      y: request.y,
    }));
    const approveAction = vi.fn()
      .mockResolvedValueOnce({ approvalId: "approval-1", taskId: "task-1", sessionWide: true })
      .mockResolvedValueOnce({ approvalId: "approval-2", taskId: "task-1", sessionWide: true });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Move through targets",
      approveAction,
      config: { maxSteps: 14 },
    });

    expect(steps).toHaveLength(14);
    expect(approveAction).toHaveBeenCalledTimes(2);
    expect(steps.filter((step) => step.trace?.action?.approvalMode === "task_lease")).toHaveLength(12);
    expect(steps[12].trace?.action?.approvalMode).toBe("per_action");
    expect(computerTool.moveMouse).toHaveBeenNthCalledWith(13, expect.objectContaining({
      approvalId: "approval-2",
      taskId: "task-1",
    }));
  });

  it("refreshes task approval before reusing a frontend lease across windows", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "First target is in the foreground window",
        action: { tool: "computer.focusWindow", params: { handle: 42 } },
        target: "Focus first window",
        confidence: "high",
      }),
      JSON.stringify({
        observation: "Second target is in another visible window",
        action: { tool: "computer.focusWindow", params: { handle: 99 } },
        target: "Focus second window",
        confidence: "high",
      }),
    ]);
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
    vi.mocked(computerTool.focusWindow).mockResolvedValue({ focused: true, title: "Target App" });
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

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click targets in two windows",
      approveAction,
      config: { maxSteps: 2 },
    });

    expect(steps.map((step) => step.trace?.action?.approvalMode)).toEqual(["per_action", "per_action"]);
    expect(approveAction).toHaveBeenCalledTimes(2);
    expect(computerTool.focusWindow).toHaveBeenNthCalledWith(2, expect.objectContaining({
      approvalId: "approval-2",
      taskId: "task-1",
    }));
  });

  it("drops the frontend task approval lease after any leased action failure", async () => {
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
    vi.mocked(computerTool.screenshot).mockImplementation(async () => ({
      dataUrl: `data:image/png;base64,${vi.mocked(computerTool.screenshot).mock.calls.length}==`,
      width: 1920,
      height: 1080,
      capturedAt: "2026-06-04T00:00:00.000Z",
      methodUsed: "bitblt" as const,
    }));
    vi.mocked(computerTool.click)
      .mockResolvedValueOnce({ x: 100, y: 200, clicked: true })
      .mockRejectedValueOnce(new Error("target moved before click"))
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

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click three targets",
      approveAction,
      config: { maxSteps: 3 },
    });

    expect(steps.map((step) => step.trace?.action?.approvalMode)).toEqual(["per_action", "task_lease", "per_action"]);
    expect(steps[1].error).toContain("target moved before click");
    expect(approveAction).toHaveBeenCalledTimes(2);
    expect(computerTool.click).toHaveBeenNthCalledWith(3, expect.objectContaining({
      approvalId: "approval-2",
      taskId: "task-1",
    }));
  });

  it("drops a newly created task approval lease when its first action fails", async () => {
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
    vi.mocked(computerTool.click)
      .mockRejectedValueOnce(new Error("target moved before click"))
      .mockResolvedValueOnce({ x: 120, y: 220, clicked: true });
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

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click two targets",
      approveAction,
      config: { maxSteps: 2 },
    });

    expect(steps.map((step) => step.trace?.action?.approvalMode)).toEqual(["per_action", "per_action"]);
    expect(steps[0].error).toContain("target moved before click");
    expect(approveAction).toHaveBeenCalledTimes(2);
    expect(computerTool.click).toHaveBeenNthCalledWith(2, expect.objectContaining({
      approvalId: "approval-2",
      taskId: "task-1",
    }));
  });

  it("uses fresh approval when retrying a newly leased first action", async () => {
    vi.useFakeTimers();
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Target is visible",
      action: { tool: "computer.click", params: { x: 100, y: 200 } },
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
    vi.mocked(computerTool.click)
      .mockResolvedValueOnce({ x: 100, y: 200, clicked: false })
      .mockResolvedValueOnce({ x: 100, y: 200, clicked: true });
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

    const runPromise = runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click target",
      approveAction,
      config: { maxSteps: 1 },
    });
    await vi.advanceTimersByTimeAsync(80);
    const steps = await runPromise;
    vi.useRealTimers();

    expect(steps[0].phase).toBe("completed");
    expect(steps[0].trace?.verification?.reason).toContain("retried once");
    expect(approveAction).toHaveBeenCalledTimes(2);
    expect(computerTool.click).toHaveBeenNthCalledWith(2, expect.objectContaining({
      approvalId: "approval-2",
      taskId: "task-1",
    }));
  });

  it("keeps a new session-wide retry approval for the next low-risk action", async () => {
    vi.useFakeTimers();
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
    vi.mocked(computerTool.screenshot).mockImplementation(async () => ({
      dataUrl: `data:image/png;base64,RETRY-LEASE-${vi.mocked(computerTool.screenshot).mock.calls.length}==`,
      width: 1920,
      height: 1080,
      capturedAt: "2026-06-04T00:00:00.000Z",
      methodUsed: "bitblt" as const,
    }));
    vi.mocked(computerTool.click)
      .mockResolvedValueOnce({ x: 100, y: 200, clicked: false })
      .mockResolvedValueOnce({ x: 100, y: 200, clicked: true })
      .mockResolvedValueOnce({ x: 120, y: 220, clicked: true });
    const approveAction = vi.fn()
      .mockResolvedValueOnce({
        approvalId: "approval-1",
        taskId: "task-1",
        sessionWide: false,
      })
      .mockResolvedValueOnce({
        approvalId: "approval-2",
        taskId: "task-1",
        sessionWide: true,
      });

    const runPromise = runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click two targets",
      approveAction,
      config: { maxSteps: 2 },
    });
    await vi.advanceTimersByTimeAsync(80);
    const steps = await runPromise;
    vi.useRealTimers();

    expect(steps.map((step) => step.trace?.action?.approvalMode)).toEqual(["per_action", "task_lease"]);
    expect(approveAction).toHaveBeenCalledTimes(2);
    expect(computerTool.click).toHaveBeenNthCalledWith(2, expect.objectContaining({
      approvalId: "approval-2",
      taskId: "task-1",
    }));
    expect(computerTool.click).toHaveBeenNthCalledWith(3, expect.objectContaining({
      approvalId: "approval-2",
      taskId: "task-1",
    }));
  });

  it("drops a new session-wide retry approval when the retry still fails", async () => {
    vi.useFakeTimers();
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
    vi.mocked(computerTool.screenshot).mockImplementation(async () => ({
      dataUrl: `data:image/png;base64,RETRY-FAIL-${vi.mocked(computerTool.screenshot).mock.calls.length}==`,
      width: 1920,
      height: 1080,
      capturedAt: "2026-06-04T00:00:00.000Z",
      methodUsed: "bitblt" as const,
    }));
    vi.mocked(computerTool.click)
      .mockResolvedValueOnce({ x: 100, y: 200, clicked: false })
      .mockResolvedValueOnce({ x: 100, y: 200, clicked: false })
      .mockResolvedValueOnce({ x: 120, y: 220, clicked: true });
    const approveAction = vi.fn()
      .mockResolvedValueOnce({
        approvalId: "approval-1",
        taskId: "task-1",
        sessionWide: false,
      })
      .mockResolvedValueOnce({
        approvalId: "approval-2",
        taskId: "task-1",
        sessionWide: true,
      })
      .mockResolvedValueOnce({
        approvalId: "approval-3",
        taskId: "task-1",
        sessionWide: true,
      });

    const runPromise = runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click two targets",
      approveAction,
      config: { maxSteps: 2 },
    });
    await vi.advanceTimersByTimeAsync(80);
    const steps = await runPromise;
    vi.useRealTimers();

    expect(steps.map((step) => step.trace?.action?.approvalMode)).toEqual(["per_action", "per_action"]);
    expect(steps[0].phase).toBe("failed");
    expect(steps[0].error).toContain("Verification failed");
    expect(approveAction).toHaveBeenCalledTimes(3);
    expect(computerTool.click).toHaveBeenNthCalledWith(3, expect.objectContaining({
      approvalId: "approval-3",
      taskId: "task-1",
    }));
  });

  it("keeps a new task approval lease after a leased action retries with fresh session approval", async () => {
    vi.useFakeTimers();
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
    vi.mocked(computerTool.screenshot).mockImplementation(async () => ({
      dataUrl: `data:image/png;base64,RETRY-${vi.mocked(computerTool.screenshot).mock.calls.length}==`,
      width: 1920,
      height: 1080,
      capturedAt: "2026-06-04T00:00:00.000Z",
      methodUsed: "bitblt" as const,
    }));
    vi.mocked(computerTool.click)
      .mockResolvedValueOnce({ x: 100, y: 200, clicked: true })
      .mockResolvedValueOnce({ x: 120, y: 220, clicked: false })
      .mockResolvedValueOnce({ x: 120, y: 220, clicked: true })
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
      })
      .mockResolvedValueOnce({
        approvalId: "approval-3",
        taskId: "task-1",
        sessionWide: true,
      });

    const runPromise = runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click three targets",
      approveAction,
      config: { maxSteps: 3 },
    });
    await vi.advanceTimersByTimeAsync(80);
    const steps = await runPromise;
    vi.useRealTimers();

    expect(steps.map((step) => step.trace?.action?.approvalMode)).toEqual(["per_action", "task_lease", "task_lease"]);
    expect(steps[1].phase).toBe("completed");
    expect(steps[1].trace?.verification?.reason).toContain("retried once");
    expect(approveAction).toHaveBeenCalledTimes(2);
    expect(computerTool.click).toHaveBeenNthCalledWith(3, expect.objectContaining({
      approvalId: "approval-2",
      taskId: "task-1",
    }));
    expect(computerTool.click).toHaveBeenNthCalledWith(4, expect.objectContaining({
      approvalId: "approval-2",
      taskId: "task-1",
    }));
  });

  it("drops a frontend task approval lease before fresh-approval text entry", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "First target is visible",
        action: { tool: "computer.click", params: { x: 100, y: 200 } },
        target: "Click first target",
        confidence: "high",
      }),
      JSON.stringify({
        observation: "The input is focused",
        action: { tool: "computer.type", params: { text: "hello" } },
        target: "Type text",
        confidence: "high",
      }),
      JSON.stringify({
        observation: "Final target is visible",
        action: { tool: "computer.click", params: { x: 140, y: 240 } },
        target: "Click final target",
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
    vi.mocked(computerTool.screenshot).mockImplementation(async () => ({
      dataUrl: `data:image/png;base64,FRESH-${vi.mocked(computerTool.screenshot).mock.calls.length}==`,
      width: 1920,
      height: 1080,
      capturedAt: "2026-06-04T00:00:00.000Z",
      methodUsed: "bitblt" as const,
    }));
    vi.mocked(computerTool.type).mockResolvedValue({ typed: true, length: 5 });
    const approveAction = vi.fn()
      .mockResolvedValueOnce({
        approvalId: "approval-1",
        taskId: "task-1",
        sessionWide: true,
      })
      .mockResolvedValueOnce({
        approvalId: "approval-2",
        taskId: "task-1",
        sessionWide: false,
      })
      .mockResolvedValueOnce({
        approvalId: "approval-3",
        taskId: "task-1",
        sessionWide: true,
      });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click, type, then click",
      approveAction,
      config: { maxSteps: 3 },
    });

    expect(steps.map((step) => step.trace?.action?.approvalMode)).toEqual(["per_action", "per_action", "per_action"]);
    expect(approveAction).toHaveBeenCalledTimes(3);
    expect(computerTool.type).toHaveBeenCalledWith(expect.objectContaining({
      approvalId: "approval-2",
      taskId: "task-1",
    }));
    expect(computerTool.click).toHaveBeenNthCalledWith(2, expect.objectContaining({
      approvalId: "approval-3",
      taskId: "task-1",
    }));
  });

  it("does not reuse a task approval lease for yolo-only coordinate candidates", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "First target is visible",
        action: { tool: "computer.click", params: { x: 100, y: 200 } },
        target: "Click first target",
        confidence: "high",
      }),
      JSON.stringify({
        observation: "The visual-only target is visible",
        action: { tool: "computer.click", params: { x: 240, y: 260 } },
        target: "Click visual-only target",
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
    vi.mocked(computerTool.inspectUi).mockResolvedValue({
      tree: "",
      nodeCount: 0,
    });
    vi.mocked(computerTool.screenshot).mockImplementation(async () => ({
      dataUrl: `data:image/png;base64,LEASE-YOLO-${vi.mocked(computerTool.screenshot).mock.calls.length}==`,
      width: 1920,
      height: 1080,
      capturedAt: "2026-06-04T00:00:00.000Z",
      methodUsed: "bitblt" as const,
    }));
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [createLocalVisionDetection({
        id: "det_visual_only",
        label: "possible_icon",
        confidence: 0.93,
        x: 220,
        y: 240,
        width: 80,
        height: 60,
      })],
      latencyMs: 4,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));
    const approvalOptions: Array<{ requiresFreshApproval?: boolean } | undefined> = [];
    const approveAction = vi.fn(async (_action, options) => {
      approvalOptions.push(options);
      return {
        approvalId: approvalOptions.length === 1 ? "approval-1" : "approval-2",
        taskId: "task-1",
        sessionWide: true,
      };
    });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click both targets",
      approveAction,
      config: {
        maxSteps: 2,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          minConfidence: 0.75,
        },
      },
    });

    expect(steps.map((step) => step.trace?.action?.approvalMode)).toEqual(["per_action", "per_action"]);
    expect(approveAction).toHaveBeenCalledTimes(2);
    expect(approvalOptions).toEqual([
      expect.objectContaining({ requiresFreshApproval: false }),
      expect.objectContaining({ requiresFreshApproval: true }),
    ]);
    expect(steps[1].trace?.localVision).toEqual(expect.objectContaining({
      selectedCandidateId: "candidate_det_visual_only",
      selectedCandidateSource: ["yolo"],
      actionRisk: "medium",
      actionSucceeded: true,
    }));
    expect(computerTool.click).toHaveBeenNthCalledWith(2, expect.objectContaining({
      approvalId: "approval-2",
      taskId: "task-1",
    }));
  });

  it("does not create a reusable lease from fresh-only local vision approval", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "The visual-only target is visible",
        action: { tool: "computer.click", params: { x: 240, y: 260 } },
        target: "Click visual-only target",
        confidence: "high",
      }),
      JSON.stringify({
        observation: "A normal target is visible",
        action: { tool: "computer.click", params: { x: 100, y: 200 } },
        target: "Click normal target",
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
    vi.mocked(computerTool.inspectUi).mockResolvedValue({
      tree: "",
      nodeCount: 0,
    });
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => {
      const firstObservation = vi.mocked(computerTool.detectUiObjects!).mock.calls.length === 1;
      return {
        screenshotId: request.screenshotId,
        detections: firstObservation
          ? [createLocalVisionDetection({
            id: "det_visual_only",
            label: "possible_icon",
            confidence: 0.93,
            x: 220,
            y: 240,
            width: 80,
            height: 60,
          })]
          : [],
        latencyMs: 4,
        model: "yolo26n-ui.onnx",
        runtime: "onnxruntime" as const,
        timedOut: false,
      };
    });
    const approvalOptions: Array<{ requiresFreshApproval?: boolean } | undefined> = [];
    const approveAction = vi.fn(async (_action, options) => {
      approvalOptions.push(options);
      return {
        approvalId: `approval-${approvalOptions.length}`,
        taskId: "task-1",
        sessionWide: true,
      };
    });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click both targets",
      approveAction,
      config: {
        maxSteps: 2,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          minConfidence: 0.75,
        },
      },
    });

    expect(steps.map((step) => step.trace?.action?.approvalMode)).toEqual(["per_action", "per_action"]);
    expect(approvalOptions).toEqual([
      expect.objectContaining({ requiresFreshApproval: true }),
      expect.objectContaining({ requiresFreshApproval: false }),
    ]);
    expect(computerTool.click).toHaveBeenNthCalledWith(1, expect.objectContaining({
      approvalId: "approval-1",
      taskId: "task-1",
    }));
    expect(computerTool.click).toHaveBeenNthCalledWith(2, expect.objectContaining({
      approvalId: "approval-2",
      taskId: "task-1",
    }));
  });

  it("does not reuse a coordinate task approval lease for invokeUi", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "A button is visible",
        action: { tool: "computer.click", params: { x: 100, y: 200 } },
        target: "Click first target",
        confidence: "high",
      }),
      JSON.stringify({
        observation: "The safe UIA button is visible",
        action: {
          tool: "computer.invokeUi",
          params: {
            selector: { windowHandle: 42, automationId: "safeButton", name: "Safe" },
          },
        },
        target: "Invoke safe button",
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
    vi.mocked(computerTool.inspectUi).mockResolvedValue({
      tree: "<Button name=\"Safe\" automationId=\"safeButton\">",
      nodeCount: 1,
    });
    vi.mocked(computerTool.invokeUi).mockResolvedValue({
      invoked: true,
      matchedName: "Safe",
      matchedAutomationId: "safeButton",
    });
    let approvalSequence = 0;
    const approveAction = vi.fn(async () => {
      approvalSequence += 1;
      return {
        approvalId: `approval-${approvalSequence}`,
        taskId: "task-1",
        sessionWide: true,
      };
    });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click then invoke",
      approveAction,
      config: { maxSteps: 2 },
    });

    expect(steps.map((step) => step.trace?.action?.approvalMode)).toEqual(["per_action", "per_action"]);
    expect(approveAction).toHaveBeenCalledTimes(2);
    expect(computerTool.invokeUi).toHaveBeenCalledWith(expect.objectContaining({
      approvalId: "approval-2",
      taskId: "task-1",
    }));
  });

  it("keeps fresh approval required when retrying a high-risk selector action", async () => {
    vi.useFakeTimers();
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Delete button is available",
      action: {
        tool: "computer.invokeUi",
        params: {
          selector: { windowHandle: 42, automationId: "deleteButton", name: "Delete" },
        },
      },
      target: "Delete",
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
      tree: "<Button name=\"Delete\" automationId=\"deleteButton\">",
      nodeCount: 1,
    });
    vi.mocked(computerTool.invokeUi)
      .mockResolvedValueOnce({ invoked: false, matchedName: "Delete", matchedAutomationId: "deleteButton" })
      .mockResolvedValueOnce({ invoked: true, matchedName: "Delete", matchedAutomationId: "deleteButton" });
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [createLocalVisionDetection({
        id: "det_delete",
        label: "deleteButton",
        confidence: 0.95,
        x: 180,
        y: 190,
        width: 80,
        height: 40,
      })],
      latencyMs: 4,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));
    const approveAction = vi.fn()
      .mockResolvedValueOnce({ approvalId: "approval-1", taskId: "task-1", sessionWide: true })
      .mockResolvedValueOnce({ approvalId: "approval-2", taskId: "task-1", sessionWide: true });

    const runPromise = runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Delete the selected item",
      approveAction,
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          minConfidence: 0.75,
        },
      },
    });
    await vi.advanceTimersByTimeAsync(80);
    const steps = await runPromise;
    vi.useRealTimers();

    expect(steps[0].phase).toBe("completed");
    expect(steps[0].trace?.localVision).toEqual(expect.objectContaining({
      selectedCandidateId: "candidate_det_delete",
      actionRisk: "high",
      actionSucceeded: true,
    }));
    expect(steps[0].trace?.verification?.reason).toContain("retried once");
    expect(approveAction).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ tool: "computer.invokeUi" }),
      expect.objectContaining({ requiresFreshApproval: true }),
    );
    expect(approveAction).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ tool: "computer.invokeUi" }),
      expect.objectContaining({ requiresFreshApproval: true }),
    );
    expect(computerTool.invokeUi).toHaveBeenNthCalledWith(2, expect.objectContaining({
      approvalId: "approval-2",
      taskId: "task-1",
    }));
  });

  it("blocks direct execution for not-allowed yolo-only high-risk candidates", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Click the delete button",
      action: { tool: "computer.click", params: { x: 210, y: 210 } },
      target: "Delete",
      confidence: "high",
    }));
    const computerTool = createComputerTool();
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [
        createLocalVisionDetection({
          id: "det_safe_overlay",
          label: "button",
          confidence: 0.99,
          x: 170,
          y: 180,
          width: 120,
          height: 80,
        }),
        createLocalVisionDetection({
          id: "det_delete",
          label: "deleteButton",
          confidence: 0.95,
          x: 180,
          y: 190,
          width: 80,
          height: 40,
        }),
      ],
      latencyMs: 4,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));
    const approveAction = vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" }));
    vi.mocked(computerTool.screenshot)
      .mockResolvedValueOnce({
        dataUrl: "data:image/png;base64,BEFORE==",
        width: 1920,
        height: 1080,
        capturedAt: "2026-06-04T00:00:00.000Z",
        methodUsed: "bitblt" as const,
      })
      .mockResolvedValueOnce({
        dataUrl: "data:image/png;base64,AFTER==",
        width: 1920,
        height: 1079,
        capturedAt: "2026-06-04T00:00:01.000Z",
        methodUsed: "bitblt" as const,
      });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click delete",
      approveAction,
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          minConfidence: 0.75,
        },
      },
    });

    expect(approveAction).not.toHaveBeenCalled();
    expect(computerTool.click).not.toHaveBeenCalled();
    expect(steps[0].phase).toBe("failed");
    expect(steps[0].error).toContain("not allowed for direct execution");
    expect(steps[0].trace?.preflight).toEqual(expect.objectContaining({
      passed: false,
    }));
    expect(steps[0].trace?.localVision).toEqual(expect.objectContaining({
      selectedCandidateId: "candidate_det_delete",
      actionRisk: "high",
      actionSucceeded: false,
    }));
  });

  it("blocks high-risk local vision candidates even when prompt Top-K hides them", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Click the visible delete target",
      action: { tool: "computer.click", params: { x: 210, y: 210 } },
      target: "Delete",
      confidence: "high",
    }));
    const computerTool = createComputerTool();
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [
        createLocalVisionDetection({
          id: "det_safe_overlay",
          label: "button",
          confidence: 0.99,
          x: 170,
          y: 180,
          width: 120,
          height: 80,
        }),
        createLocalVisionDetection({
          id: "det_delete",
          label: "deleteButton",
          confidence: 0.95,
          x: 180,
          y: 190,
          width: 80,
          height: 40,
        }),
      ],
      latencyMs: 4,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));
    const approveAction = vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" }));
    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click delete",
      approveAction,
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          minConfidence: 0.75,
          promptTopK: 1,
        },
      },
    });

    const prompt = vi.mocked(modelProvider.complete).mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("candidate_det_safe_overlay");
    expect(prompt).not.toContain("candidate_det_delete");
    expect(approveAction).not.toHaveBeenCalled();
    expect(computerTool.click).not.toHaveBeenCalled();
    expect(steps[0].phase).toBe("failed");
    expect(steps[0].error).toContain("not allowed for direct execution");
    expect(steps[0].trace?.localVision).toEqual(expect.objectContaining({
      selectedCandidateId: "candidate_det_delete",
      selectedCandidateRank: 2,
      promptCandidateCount: 1,
      actionRisk: "high",
      actionSucceeded: false,
    }));
  });

  it("blocks Chinese high-risk local vision labels before coordinate execution", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Click the visible submit button",
      action: { tool: "computer.click", params: { x: 210, y: 210 } },
      target: "提交订单",
      confidence: "high",
    }));
    const computerTool = createComputerTool();
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [
        createLocalVisionDetection({
          id: "det_submit_cn",
          label: "提交订单按钮",
          confidence: 0.95,
          x: 180,
          y: 190,
          width: 80,
          height: 40,
        }),
      ],
      latencyMs: 4,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));
    const approveAction = vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "提交订单",
      approveAction,
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          minConfidence: 0.75,
        },
      },
    });

    expect(approveAction).not.toHaveBeenCalled();
    expect(computerTool.click).not.toHaveBeenCalled();
    expect(steps[0].phase).toBe("failed");
    expect(steps[0].error).toContain("not allowed for direct execution");
    expect(steps[0].trace?.localVision).toEqual(expect.objectContaining({
      selectedCandidateId: "candidate_det_submit_cn",
      actionRisk: "high",
      actionSucceeded: false,
    }));
  });

  it("uses a matching UIA selector with fresh approval for high-risk local vision candidates", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Click the delete button",
      action: { tool: "computer.click", params: { x: 210, y: 210 } },
      target: "Delete",
      confidence: "high",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.screenshot)
      .mockResolvedValueOnce({
        dataUrl: "data:image/png;base64,DELETE-UIA-BEFORE==",
        width: 1920,
        height: 1080,
        capturedAt: "2026-06-04T00:00:00.000Z",
        methodUsed: "bitblt" as const,
      })
      .mockResolvedValueOnce({
        dataUrl: "data:image/png;base64,DELETE-UIA-AFTER==",
        width: 1920,
        height: 1079,
        capturedAt: "2026-06-04T00:00:01.000Z",
        methodUsed: "bitblt" as const,
      });
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
      tree: "<Button name=\"Delete\" automationId=\"deleteButton\">",
      nodeCount: 1,
    });
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [
        createLocalVisionDetection({
          id: "det_delete",
          label: "deleteButton",
          confidence: 0.95,
          x: 180,
          y: 190,
          width: 80,
          height: 40,
        }),
      ],
      latencyMs: 4,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));
    vi.mocked(computerTool.invokeUi).mockResolvedValue({
      invoked: true,
      matchedName: "Delete",
      matchedAutomationId: "deleteButton",
    });
    const approveAction = vi.fn(async () => ({
      approvalId: "approval-1",
      taskId: "task-1",
      sessionWide: true,
    }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click delete",
      approveAction,
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          minConfidence: 0.75,
        },
      },
    });

    const prompt = vi.mocked(modelProvider.complete).mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("candidate_det_delete");
    expect(prompt).toContain("mode=user_confirmation_required");
    expect(approveAction).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "computer.invokeUi" }),
      expect.objectContaining({ requiresFreshApproval: true }),
    );
    expect(computerTool.click).not.toHaveBeenCalled();
    expect(computerTool.invokeUi).toHaveBeenCalledWith(expect.objectContaining({
      selector: expect.objectContaining({
        windowHandle: 42,
        automationId: "deleteButton",
        name: "Delete",
      }),
      approvalId: "approval-1",
      taskId: "task-1",
    }));
    expect(steps[0].phase).toBe("completed");
    expect(steps[0].error).toBeUndefined();
    expect(steps[0].trace?.preflight).toEqual(expect.objectContaining({
      passed: true,
      reason: "selector appears in current UIA tree",
    }));
    expect(steps[0].trace?.action).toEqual(expect.objectContaining({
      originalTool: "computer.click",
      strategy: "uia_preferred",
      approvalMode: "per_action",
    }));
    expect(steps[0].trace?.localVision).toEqual(expect.objectContaining({
      selectedCandidateId: "candidate_det_delete",
      selectedCandidateSource: ["uia", "yolo"],
      actionRisk: "high",
      actionSucceeded: true,
    }));
  });

  it("matches yolo-only high-risk candidates in resized screenshot coordinates before executing screen coordinates", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Click the delete button",
      action: { tool: "computer.click", params: { x: 105, y: 105 } },
      target: "Delete",
      confidence: "high",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.screenshot).mockResolvedValue({
      dataUrl: "data:image/png;base64,RESIZED==",
      width: 960,
      height: 540,
      sourceWidth: 1920,
      sourceHeight: 1080,
      sourceOriginX: 0,
      sourceOriginY: 0,
      scaleX: 0.5,
      scaleY: 0.5,
      capturedAt: "2026-06-04T00:00:00.000Z",
      methodUsed: "bitblt" as const,
    });
    vi.mocked(computerTool.listWindows).mockResolvedValue({
      windows: [{
        handle: 42,
        title: "Target App",
        className: "TargetWindow",
        rect: { x: 0, y: 0, width: 1920, height: 1080 },
        isVisible: true,
        isForeground: true,
      }],
    });
    vi.mocked(computerTool.inspectUi).mockResolvedValue({ tree: "", nodeCount: 0 });
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [
        createLocalVisionDetection({
          id: "det_delete_resized",
          label: "deleteButton",
          confidence: 0.95,
          x: 90,
          y: 90,
          width: 40,
          height: 30,
        }),
      ],
      latencyMs: 4,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));
    const approveAction = vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click delete",
      approveAction,
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          minConfidence: 0.75,
        },
      },
    });

    expect(approveAction).not.toHaveBeenCalled();
    expect(computerTool.click).not.toHaveBeenCalled();
    expect(steps[0].phase).toBe("failed");
    expect(steps[0].action).toEqual({
      tool: "computer.click",
      params: { x: 210, y: 210 },
    });
    expect(steps[0].trace?.preflight).toEqual(expect.objectContaining({
      passed: false,
      reason: expect.stringContaining("not allowed for direct execution"),
    }));
    expect(steps[0].trace?.localVision).toEqual(expect.objectContaining({
      selectedCandidateId: "candidate_det_delete_resized",
      selectedCandidateRank: 1,
      selectedCandidateSource: ["yolo"],
      actionRisk: "high",
      actionSucceeded: false,
    }));
  });

  it("ignores low-confidence high-risk local vision detections for prompt and preflight", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Click the ordinary button",
      action: { tool: "computer.click", params: { x: 210, y: 210 } },
      target: "Continue",
      confidence: "high",
    }));
    const computerTool = createComputerTool();
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [
        createLocalVisionDetection({
          id: "det_delete_noise",
          label: "deleteButton",
          confidence: 0.2,
          x: 180,
          y: 190,
          width: 80,
          height: 40,
        }),
      ],
      latencyMs: 4,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));
    const approveAction = vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" }));
    vi.mocked(computerTool.screenshot)
      .mockResolvedValueOnce({
        dataUrl: "data:image/png;base64,LOWCONF-BEFORE==",
        width: 1920,
        height: 1080,
        capturedAt: "2026-06-04T00:00:00.000Z",
        methodUsed: "bitblt" as const,
      })
      .mockResolvedValueOnce({
        dataUrl: "data:image/png;base64,LOWCONF-AFTER==",
        width: 1920,
        height: 1079,
        capturedAt: "2026-06-04T00:00:01.000Z",
        methodUsed: "bitblt" as const,
      });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click continue",
      approveAction,
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          minConfidence: 0.75,
        },
      },
    });

    const prompt = vi.mocked(modelProvider.complete).mock.calls[0]?.[0] ?? "";
    expect(prompt).not.toContain("det_delete_noise");
    expect(approveAction).toHaveBeenCalledTimes(1);
    expect(computerTool.click).toHaveBeenCalledTimes(1);
    expect(steps[0].phase).toBe("completed");
    expect(steps[0].trace?.localVision).toEqual(expect.objectContaining({
      detectionCount: 0,
      promptCandidateCount: 0,
      selectedCandidateId: undefined,
      actionRisk: "medium",
      actionSucceeded: true,
    }));
  });

  it("drops local vision detections whose clamped screenshot box has no area", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Inspect the desktop",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "done",
      confidence: "high",
      status: "complete",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.screenshot).mockResolvedValue({
      dataUrl: "data:image/png;base64,EDGE==",
      width: 100,
      height: 100,
      capturedAt: "2026-06-04T00:00:00.000Z",
      methodUsed: "bitblt" as const,
    });
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [
        {
          id: "det_zero_after_clamp",
          label: "deleteButton",
          confidence: 0.99,
          box: {
            x: 100,
            y: 10,
            width: 20,
            height: 20,
            coordinateSpace: "screenshot" as const,
          },
          center: {
            x: 100,
            y: 20,
            coordinateSpace: "screenshot" as const,
          },
          source: "yolo26",
        },
      ],
      latencyMs: 4,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          minConfidence: 0.75,
        },
      },
    });

    const prompt = vi.mocked(modelProvider.complete).mock.calls[0]?.[0] ?? "";
    expect(prompt).not.toContain("LOCAL_UI_CANDIDATES");
    expect(steps[0].trace?.localVision).toEqual(expect.objectContaining({
      detectionCount: 0,
      promptCandidateCount: 0,
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
    vi.mocked(computerTool.screenshot).mockImplementation(async () => ({
      dataUrl: `data:image/png;base64,NATIVE-${vi.mocked(computerTool.screenshot).mock.calls.length}==`,
      width: 1920,
      height: 1080,
      capturedAt: "2026-06-04T00:00:00.000Z",
      methodUsed: "bitblt" as const,
    }));
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

  it("does not reuse task approval for Chinese high-risk UIA invocations", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "Safe button is available",
        action: {
          tool: "computer.invokeUi",
          params: {
            selector: { windowHandle: 42, automationId: "nextButton", name: "下一步" },
          },
        },
        target: "Invoke next",
        confidence: "high",
      }),
      JSON.stringify({
        observation: "Submit button is available",
        action: {
          tool: "computer.invokeUi",
          params: {
            selector: { windowHandle: 42, automationId: "submitButton", name: "提交订单" },
          },
        },
        target: "Invoke submit",
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
        tree: "<Button name=\"下一步\" automationId=\"nextButton\">\n<Button name=\"提交订单\" automationId=\"submitButton\">",
        nodeCount: 2,
      })
      .mockResolvedValueOnce({
        tree: "<Button name=\"下一步\" automationId=\"nextButton\">\n<Button name=\"提交订单\" automationId=\"submitButton\">",
        nodeCount: 2,
      })
      .mockResolvedValueOnce({
        tree: "<Text name=\"Ready\" automationId=\"statusText\">\n<Button name=\"提交订单\" automationId=\"submitButton\">",
        nodeCount: 2,
      })
      .mockResolvedValueOnce({
        tree: "<Text name=\"Ready\" automationId=\"statusText\">\n<Button name=\"提交订单\" automationId=\"submitButton\">",
        nodeCount: 2,
      })
      .mockResolvedValue({
        tree: "<Text name=\"Done\" automationId=\"statusText\">",
        nodeCount: 1,
      });
    vi.mocked(computerTool.invokeUi).mockResolvedValue({
      invoked: true,
      matchedName: "下一步",
      matchedAutomationId: "nextButton",
    });
    let approvalCount = 0;
    const approvalOptions: Array<{ requiresFreshApproval?: boolean } | undefined> = [];
    const approveAction = vi.fn(async (_action, options) => {
      approvalOptions.push(options);
      return {
      approvalId: ++approvalCount === 1 ? "approval-1" : "approval-2",
      taskId: "task-1",
      sessionWide: true,
      };
    });

    await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Invoke next then submit",
      approveAction,
      config: { maxSteps: 2 },
    });

    expect(approveAction).toHaveBeenCalledTimes(2);
    expect(approvalOptions[1]).toEqual(expect.objectContaining({ requiresFreshApproval: true }));
    expect(computerTool.invokeUi).toHaveBeenNthCalledWith(2, expect.objectContaining({
      approvalId: "approval-2",
      taskId: "task-1",
    }));
  });

  it("records selector-based local vision candidate usage in action trace", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Save button is available",
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
        tree: "<Button name=\"Save\" automationId=\"saveButton\">",
        nodeCount: 1,
      })
      .mockResolvedValue({
        tree: "<Text name=\"Saved\" automationId=\"statusText\">",
        nodeCount: 1,
      });
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [
        createLocalVisionDetection({
          id: "det_save",
          label: "saveButton",
          confidence: 0.92,
          x: 10,
          y: 10,
          width: 120,
          height: 40,
        }),
      ],
      latencyMs: 3,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));
    vi.mocked(computerTool.invokeUi).mockResolvedValue({
      invoked: true,
      matchedName: "Save",
      matchedAutomationId: "saveButton",
    });
    const approveAction = vi.fn(async () => ({
      approvalId: "approval-1",
      taskId: "task-1",
    }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Invoke Save",
      approveAction,
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          minConfidence: 0.75,
        },
      },
    });

    expect(steps[0].phase).toBe("completed");
    expect(steps[0].trace?.localVision).toEqual(expect.objectContaining({
      selectedCandidateId: "candidate_det_save",
      selectedCandidateRank: 1,
      selectedCandidateSource: ["uia", "yolo"],
      actionType: "computer.invokeUi",
      actionRisk: "medium",
      actionSucceeded: true,
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

  it("reuses task approval for non-sensitive setUiValue in the same window", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "Name field is available",
        action: {
          tool: "computer.setUiValue",
          params: {
            selector: { windowHandle: 42, automationId: "firstName", name: "First name" },
            value: "Alice",
          },
        },
        target: "Set first name",
        confidence: "high",
      }),
      JSON.stringify({
        observation: "City field is available",
        action: {
          tool: "computer.setUiValue",
          params: {
            selector: { windowHandle: 42, automationId: "city", name: "City" },
            value: "Shanghai",
          },
        },
        target: "Set city",
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
        tree: "<Edit name=\"First name\" automationId=\"firstName\">\n<Edit name=\"City\" automationId=\"city\">",
        nodeCount: 2,
      })
      .mockResolvedValueOnce({
        tree: "<Edit name=\"First name\" automationId=\"firstName\">\n<Edit name=\"City\" automationId=\"city\">",
        nodeCount: 2,
      })
      .mockResolvedValueOnce({
        tree: "<Edit name=\"First name\" automationId=\"firstName\" value=\"Alice\">\n<Edit name=\"City\" automationId=\"city\">",
        nodeCount: 2,
      })
      .mockResolvedValueOnce({
        tree: "<Edit name=\"First name\" automationId=\"firstName\" value=\"Alice\">\n<Edit name=\"City\" automationId=\"city\">",
        nodeCount: 2,
      })
      .mockResolvedValue({
        tree: "<Edit name=\"First name\" automationId=\"firstName\" value=\"Alice\">\n<Edit name=\"City\" automationId=\"city\" value=\"Shanghai\">",
        nodeCount: 2,
      });
    vi.mocked(computerTool.setUiValue).mockResolvedValue({
      set: true,
      matchedName: "First name",
      matchedAutomationId: "firstName",
    });
    const approveAction = vi.fn(async () => ({
      approvalId: "approval-1",
      taskId: "task-1",
      sessionWide: true,
    }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Fill basic profile fields",
      approveAction,
      config: { maxSteps: 2 },
    });

    expect(approveAction).toHaveBeenCalledTimes(1);
    expect(steps.map((step) => step.trace?.action?.approvalMode)).toEqual(["per_action", "task_lease"]);
    expect(computerTool.setUiValue).toHaveBeenCalledTimes(2);
    expect(computerTool.setUiValue).toHaveBeenNthCalledWith(2, expect.objectContaining({
      approvalId: "approval-1",
      taskId: "task-1",
    }));
  });

  it("does not reuse task approval for sensitive setUiValue", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "Name field is available",
        action: {
          tool: "computer.setUiValue",
          params: {
            selector: { windowHandle: 42, automationId: "firstName", name: "First name" },
            value: "Alice",
          },
        },
        target: "Set first name",
        confidence: "high",
      }),
      JSON.stringify({
        observation: "Password field is available",
        action: {
          tool: "computer.setUiValue",
          params: {
            selector: { windowHandle: 42, automationId: "passwordInput", name: "Password" },
            value: "secret-token-123",
          },
        },
        target: "Set password",
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
        tree: "<Edit name=\"First name\" automationId=\"firstName\">\n<Edit name=\"Password\" automationId=\"passwordInput\">",
        nodeCount: 2,
      })
      .mockResolvedValueOnce({
        tree: "<Edit name=\"First name\" automationId=\"firstName\">\n<Edit name=\"Password\" automationId=\"passwordInput\">",
        nodeCount: 2,
      })
      .mockResolvedValue({
        tree: "<Edit name=\"First name\" automationId=\"firstName\" value=\"Alice\">\n<Edit name=\"Password\" automationId=\"passwordInput\">",
        nodeCount: 2,
      });
    vi.mocked(computerTool.setUiValue).mockResolvedValue({
      set: true,
      matchedName: "Field",
      matchedAutomationId: "field",
    });
    let approvalCount = 0;
    const approvalOptions: Array<{ requiresFreshApproval?: boolean } | undefined> = [];
    const approveAction = vi.fn(async (_action, options) => {
      approvalOptions.push(options);
      return {
        approvalId: ++approvalCount === 1 ? "approval-1" : "approval-2",
        taskId: "task-1",
        sessionWide: true,
      };
    });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Fill name then password",
      approveAction,
      config: { maxSteps: 2 },
    });

    expect(approveAction).toHaveBeenCalledTimes(2);
    expect(approvalOptions).toEqual([
      expect.objectContaining({ requiresFreshApproval: false }),
      expect.objectContaining({ requiresFreshApproval: true }),
    ]);
    expect(steps.map((step) => step.trace?.action?.approvalMode)).toEqual(["per_action", "per_action"]);
    expect(computerTool.setUiValue).toHaveBeenNthCalledWith(2, expect.objectContaining({
      approvalId: "approval-2",
      taskId: "task-1",
    }));
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

  it("starts local vision after the screenshot without waiting for slow window context", async () => {
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
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => {
      return {
        screenshotId: request.screenshotId,
        detections: [],
        latencyMs: 1,
        model: "yolo26n-ui.onnx",
        runtime: "onnxruntime" as const,
        timedOut: false,
      };
    });

    const runPromise = runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 1,
        timeouts: { listWindowsMs: 500 },
        localVision: {
          enabled: true,
          mode: "passive",
          modelPath: "models/yolo26n-ui.onnx",
          timeoutMs: 20,
        },
      },
    });

    await vi.advanceTimersByTimeAsync(20);
    expect(computerTool.detectUiObjects).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    const steps = await runPromise;
    vi.useRealTimers();

    expect(steps[0].phase).toBe("completed");
  });

  it("adds local vision prompt hints without changing execution behavior", async () => {
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
        rect: { x: 0, y: 0, width: 800, height: 600 },
        isVisible: true,
        isForeground: true,
      }],
    });
    vi.mocked(computerTool.inspectUi).mockResolvedValue({
      tree: "<Button name=\"Save\" automationId=\"saveButton\">",
      nodeCount: 1,
    });
    vi.mocked(computerTool.screenshot)
      .mockResolvedValueOnce({
        dataUrl: "data:image/png;base64,BEFORE==",
        width: 1920,
        height: 1080,
        capturedAt: "2026-06-04T00:00:00.000Z",
        methodUsed: "bitblt",
      })
      .mockResolvedValue({
        dataUrl: "data:image/png;base64,AFTER==",
        width: 1920,
        height: 1080,
        capturedAt: "2026-06-04T00:00:01.000Z",
        methodUsed: "bitblt",
      });
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [{
        id: "det_save",
        label: "saveButton",
        confidence: 0.92,
        box: {
          x: 100,
          y: 200,
          width: 80,
          height: 30,
          coordinateSpace: "screenshot" as const,
        },
        center: {
          x: 140,
          y: 215,
          coordinateSpace: "screenshot" as const,
        },
        source: "yolo26" as const,
      }],
      latencyMs: 12,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          runtime: "onnxruntime",
          reuseWorker: true,
          imgsz: 960,
          minConfidence: 0.75,
        },
      },
    });

    const prompt = vi.mocked(modelProvider.complete).mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("LOCAL_UI_CANDIDATES");
    expect(prompt).toContain("candidate_det_save");
    expect(prompt).toContain("possible_button");
    expect(prompt).toContain("text=\"Save\"");
    expect(prompt).toContain("evidence=uia:saveButton+yolo:0.92");
    expect(prompt).not.toContain("data:image/png;base64");
    expect(vi.mocked(computerTool.detectUiObjects).mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      observationId: steps[0].trace?.observation?.id,
      modelPath: "models/yolo26n-ui.onnx",
      runtime: "onnxruntime",
      reuseWorker: true,
      imgsz: 960,
      minConfidence: 0.75,
    }));
    expect(steps[0].trace?.localVision).toEqual(expect.objectContaining({
      observationId: steps[0].trace?.observation?.id,
      mode: "prompt_hint",
      reuseWorker: true,
      used: true,
      detectionCount: 1,
      promptCandidateCount: 1,
    }));
  });

  it("sorts unsorted local vision detections before limiting prompt candidates", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Goal achieved",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "done",
      confidence: "high",
      status: "complete",
    }));
    const computerTool = createComputerTool();
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [
        createLocalVisionDetection({
          id: "det_low",
          label: "button",
          confidence: 0.78,
          x: 20,
          y: 20,
          width: 80,
          height: 30,
        }),
        createLocalVisionDetection({
          id: "det_high",
          label: "button",
          confidence: 0.96,
          x: 120,
          y: 120,
          width: 80,
          height: 30,
        }),
      ],
      latencyMs: 4,
      model: "external-detector",
      runtime: "unknown" as const,
      timedOut: false,
    }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          maxDetections: 1,
          promptTopK: 1,
          minConfidence: 0.75,
        },
      },
    });

    const prompt = vi.mocked(modelProvider.complete).mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("candidate_det_high");
    expect(prompt).not.toContain("candidate_det_low");
    expect(steps[0].trace?.localVision).toEqual(expect.objectContaining({
      detectionCount: 1,
      promptCandidateCount: 1,
    }));
  });

  it("marks Chinese high-risk fused local vision candidates as high risk", async () => {
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
        rect: { x: 0, y: 0, width: 800, height: 600 },
        isVisible: true,
        isForeground: true,
      }],
    });
    vi.mocked(computerTool.inspectUi).mockResolvedValue({
      tree: "<Button name=\"提交订单\" automationId=\"submitOrderButton\" bounds=\"100,200,80,30\">",
      nodeCount: 1,
    });
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [createLocalVisionDetection({
        id: "det_submit",
        label: "button",
        confidence: 0.92,
        x: 100,
        y: 200,
        width: 80,
        height: 30,
      })],
      latencyMs: 4,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));

    await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect submit order button",
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
        },
      },
    });

    const prompt = vi.mocked(modelProvider.complete).mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("LOCAL_UI_CANDIDATES");
    expect(prompt).toContain("candidate_det_submit");
    expect(prompt).toContain("text=\"提交订单\"");
    expect(prompt).toContain("risk=high");
  });

  it("prepares a cropped VLM observation for a high-confidence goal-matched local vision candidate", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "The Save button is likely visible",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "Review Save",
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
    vi.mocked(computerTool.inspectUi).mockResolvedValue({
      tree: "<Button name=\"Save\" automationId=\"saveButton\">",
      nodeCount: 1,
    });
    let waited = false;
    vi.mocked(computerTool.wait).mockImplementation(async (request) => {
      waited = true;
      return { waited: request.ms };
    });
    vi.mocked(computerTool.screenshot).mockImplementation(async (request) => ({
      dataUrl: request.region
        ? waited
          ? "data:image/png;base64,AUTO_CROP_AFTER_WAIT=="
          : "data:image/png;base64,AUTO_CROP_BEFORE_WAIT=="
        : "data:image/png;base64,FULL==",
      width: request.region?.width ?? 1920,
      height: request.region?.height ?? 1080,
      sourceWidth: request.region?.width,
      sourceHeight: request.region?.height,
      sourceOriginX: request.region?.x,
      sourceOriginY: request.region?.y,
      scaleX: 1,
      scaleY: 1,
      capturedAt: request.region
        ? "2026-06-04T00:00:01.000Z"
        : "2026-06-04T00:00:00.000Z",
      methodUsed: request.region ? "printWindow" as const : "bitblt" as const,
    }));
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [createLocalVisionDetection({
        id: "det_save",
        label: "saveButton",
        confidence: 0.95,
        x: 100,
        y: 200,
        width: 80,
        height: 30,
      })],
      latencyMs: 5,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Review the Save button",
      config: {
        maxSteps: 2,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
        },
      },
    });

    expect(computerTool.screenshot).toHaveBeenNthCalledWith(2, {
      region: { x: 76, y: 176, width: 128, height: 78 },
      method: "auto",
    });
    expect(vi.mocked(computerTool.screenshot).mock.calls[1]?.[0]).not.toHaveProperty("windowHandle");
    expect(vi.mocked(modelProvider.complete).mock.calls[1]?.[1]?.imageDataUrl).toBe("data:image/png;base64,AUTO_CROP_AFTER_WAIT==");
    const secondPrompt = vi.mocked(modelProvider.complete).mock.calls[1]?.[0] ?? "";
    expect(secondPrompt).toContain("cropped screenshot requested by a previous action");
    expect(secondPrompt).not.toContain("LOCAL_UI_CANDIDATES");
    expect(steps[0].trace?.localVision).toEqual(expect.objectContaining({
      autoCropCandidateId: "candidate_det_save",
      autoCropRegion: { x: 76, y: 176, width: 128, height: 78 },
    }));
    expect(steps[1].trace?.screenshot).toEqual(expect.objectContaining({
      visionSource: "crop",
      sourceOriginX: 76,
      sourceOriginY: 176,
    }));
    expect(steps[1].trace?.localVision).toEqual(expect.objectContaining({
      autoCropCandidateId: "candidate_det_save",
      cropVlmCalled: true,
      fullScreenshotVlmCalled: false,
      fullScreenshotVlmSkipped: true,
      mode: "disabled",
    }));
    expect(computerTool.detectUiObjects).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(steps)).not.toContain("data:image/png;base64,AUTO_CROP_AFTER_WAIT==");
    expect(JSON.stringify(steps)).not.toContain("data:image/png;base64,AUTO_CROP_BEFORE_WAIT==");
  });

  it("falls back to a full screenshot when a pending auto-crop is slow", async () => {
    vi.useFakeTimers();
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "The Save button is likely visible",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "Review Save",
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
    vi.mocked(computerTool.inspectUi).mockResolvedValue({
      tree: "<Button name=\"Save\" automationId=\"saveButton\">",
      nodeCount: 1,
    });
    vi.mocked(computerTool.wait).mockResolvedValue({ waited: 0 });
    vi.mocked(computerTool.screenshot).mockImplementation(async (request) => {
      if (request.region) {
        return new Promise(() => {});
      }
      return {
        dataUrl: vi.mocked(computerTool.screenshot).mock.calls.length > 1
          ? "data:image/png;base64,FULL_AFTER_SLOW_CROP=="
          : "data:image/png;base64,FULL_BEFORE_SLOW_CROP==",
        width: 1920,
        height: 1080,
        capturedAt: vi.mocked(computerTool.screenshot).mock.calls.length > 1
          ? "2026-06-04T00:00:01.000Z"
          : "2026-06-04T00:00:00.000Z",
        methodUsed: "bitblt" as const,
      };
    });
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [createLocalVisionDetection({
        id: "det_save",
        label: "saveButton",
        confidence: 0.95,
        x: 100,
        y: 200,
        width: 80,
        height: 30,
      })],
      latencyMs: 5,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));

    const runPromise = runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Review the Save button",
      config: {
        maxSteps: 2,
        timeouts: { screenshotMs: 500 },
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          timeoutMs: 20,
        },
      },
    });

    await vi.advanceTimersByTimeAsync(20);
    const steps = await runPromise;
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();

    expect(computerTool.screenshot).toHaveBeenNthCalledWith(2, {
      region: { x: 76, y: 176, width: 128, height: 78 },
      method: "auto",
    });
    expect(computerTool.screenshot).toHaveBeenNthCalledWith(3, {});
    expect(vi.mocked(modelProvider.complete).mock.calls[1]?.[1]?.imageDataUrl).toBe("data:image/png;base64,FULL_AFTER_SLOW_CROP==");
    expect(steps[1].trace?.screenshot).toEqual(expect.objectContaining({
      visionSource: "full",
    }));
    expect(steps[1].trace?.localVision?.autoCropCandidateId).toBeUndefined();
    expect(JSON.stringify(steps)).not.toContain("FULL_AFTER_SLOW_CROP");
  });

  it("keeps window screenshot coordinates when auto-cropping a window observation", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "Need the target window",
        action: { tool: "computer.screenshot", params: { windowHandle: 42, method: "auto" } },
        target: "Inspect window",
        confidence: "medium",
      }),
      JSON.stringify({
        observation: "The Save button is visible",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "Review Save",
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
      dataUrl: request.region
        ? "data:image/png;base64,WINDOW_CROP=="
        : request.windowHandle
          ? "data:image/png;base64,WINDOW=="
          : "data:image/png;base64,FULL==",
      width: request.region?.width ?? (request.windowHandle ? 800 : 1920),
      height: request.region?.height ?? (request.windowHandle ? 600 : 1080),
      sourceWidth: request.region?.width,
      sourceHeight: request.region?.height,
      sourceOriginX: request.region?.x,
      sourceOriginY: request.region?.y,
      scaleX: 1,
      scaleY: 1,
      capturedAt: request.region
        ? "2026-06-04T00:00:02.000Z"
        : request.windowHandle
          ? "2026-06-04T00:00:01.000Z"
          : "2026-06-04T00:00:00.000Z",
      methodUsed: request.windowHandle ? "printWindow" as const : "bitblt" as const,
    }));
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [createLocalVisionDetection({
        id: "det_save",
        label: "saveButton",
        confidence: 0.95,
        x: 100,
        y: 200,
        width: 80,
        height: 30,
      })],
      latencyMs: 5,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Review the Save button",
      config: {
        maxSteps: 3,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
        },
      },
    });

    expect(computerTool.screenshot).toHaveBeenNthCalledWith(2, {
      windowHandle: 42,
      method: "auto",
    });
    expect(computerTool.screenshot).toHaveBeenNthCalledWith(3, {
      windowHandle: 42,
      region: { x: 76, y: 176, width: 128, height: 78 },
      method: "auto",
    });
    expect(vi.mocked(modelProvider.complete).mock.calls[2]?.[1]?.imageDataUrl).toBe("data:image/png;base64,WINDOW_CROP==");
    expect(steps[2].trace?.screenshot).toEqual(expect.objectContaining({
      visionSource: "crop",
      sourceOriginX: 76,
      sourceOriginY: 176,
    }));
  });

  it("does not inherit an old window handle when auto-cropping after a full screenshot request", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "Need the target window",
        action: { tool: "computer.screenshot", params: { windowHandle: 42, method: "auto" } },
        target: "Inspect window",
        confidence: "medium",
      }),
      JSON.stringify({
        observation: "Need the full desktop",
        action: { tool: "computer.screenshot", params: {} },
        target: "Inspect desktop",
        confidence: "medium",
      }),
      JSON.stringify({
        observation: "The Save button is visible",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "Review Save",
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
      dataUrl: request.region
        ? "data:image/png;base64,FULL_CROP=="
        : request.windowHandle
          ? "data:image/png;base64,WINDOW=="
          : "data:image/png;base64,FULL==",
      width: request.region?.width ?? (request.windowHandle ? 800 : 1920),
      height: request.region?.height ?? (request.windowHandle ? 600 : 1080),
      sourceWidth: request.region?.width,
      sourceHeight: request.region?.height,
      sourceOriginX: request.region?.x,
      sourceOriginY: request.region?.y,
      scaleX: 1,
      scaleY: 1,
      capturedAt: request.region
        ? "2026-06-04T00:00:03.000Z"
        : request.windowHandle
          ? "2026-06-04T00:00:01.000Z"
          : "2026-06-04T00:00:02.000Z",
      methodUsed: request.windowHandle ? "printWindow" as const : "bitblt" as const,
    }));
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [createLocalVisionDetection({
        id: "det_save",
        label: "saveButton",
        confidence: 0.95,
        x: 100,
        y: 200,
        width: 80,
        height: 30,
      })],
      latencyMs: 5,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Review the Save button",
      config: {
        maxSteps: 4,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
        },
      },
    });

    const cropRequests = vi.mocked(computerTool.screenshot).mock.calls
      .map((call) => call[0])
      .filter((request) => request.region?.x === 76 && request.region?.y === 176);
    expect(cropRequests).toContainEqual({
      region: { x: 76, y: 176, width: 128, height: 78 },
      method: "auto",
    });
    expect(vi.mocked(modelProvider.complete).mock.calls[3]?.[1]?.imageDataUrl).toBe("data:image/png;base64,FULL_CROP==");
    expect(steps[3].trace?.screenshot).toEqual(expect.objectContaining({
      visionSource: "crop",
      sourceOriginX: 76,
      sourceOriginY: 176,
    }));
  });

  it("does not auto-crop low-confidence or goal-unmatched local vision candidates", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "Need another look",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "wait",
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
    vi.mocked(computerTool.inspectUi).mockResolvedValue({
      tree: "<Button name=\"Open\" automationId=\"openButton\">",
      nodeCount: 1,
    });
    vi.mocked(computerTool.screenshot).mockResolvedValue({
      dataUrl: "data:image/png;base64,FULL==",
      width: 1920,
      height: 1080,
      capturedAt: "2026-06-04T00:00:00.000Z",
      methodUsed: "bitblt",
    });
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [
        createLocalVisionDetection({
          id: "det_low_save",
          label: "saveButton",
          confidence: 0.82,
          x: 100,
          y: 200,
          width: 80,
          height: 30,
        }),
        createLocalVisionDetection({
          id: "det_open",
          label: "openButton",
          confidence: 0.95,
          x: 300,
          y: 200,
          width: 80,
          height: 30,
        }),
      ],
      latencyMs: 5,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Review the Save button",
      config: {
        maxSteps: 2,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          minConfidence: 0.75,
        },
      },
    });

    expect(computerTool.screenshot).toHaveBeenCalledTimes(2);
    expect(vi.mocked(computerTool.screenshot).mock.calls[1]?.[0]).toEqual({});
    expect(steps[0].trace?.localVision?.autoCropCandidateId).toBeUndefined();
    expect(steps[1].trace?.screenshot?.visionSource).toBe("full");
    expect(vi.mocked(modelProvider.complete).mock.calls[1]?.[1]?.imageDataUrl).toBe("data:image/png;base64,FULL==");
  });

  it("does not prepare auto-crop before a desktop-mutating action", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "Click the Save button",
        action: { tool: "computer.click", params: { x: 140, y: 215 } },
        target: "Save",
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
    vi.mocked(computerTool.screenshot).mockImplementation(async (request) => ({
      dataUrl: request.region
        ? "data:image/png;base64,UNEXPECTED_CROP=="
        : "data:image/png;base64,FULL==",
      width: request.region?.width ?? 1920,
      height: request.region?.height ?? 1080,
      sourceWidth: request.region?.width,
      sourceHeight: request.region?.height,
      sourceOriginX: request.region?.x,
      sourceOriginY: request.region?.y,
      scaleX: 1,
      scaleY: 1,
      capturedAt: request.region
        ? "2026-06-04T00:00:01.000Z"
        : "2026-06-04T00:00:00.000Z",
      methodUsed: request.region ? "printWindow" as const : "bitblt" as const,
    }));
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [createLocalVisionDetection({
        id: "det_save",
        label: "saveButton",
        confidence: 0.95,
        x: 100,
        y: 200,
        width: 80,
        height: 30,
      })],
      latencyMs: 5,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));
    vi.mocked(computerTool.click).mockResolvedValue({ x: 140, y: 215, clicked: true });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click the Save button",
      approveAction: vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" })),
      config: {
        maxSteps: 2,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
        },
      },
    });

    expect(vi.mocked(computerTool.screenshot).mock.calls.some((call) => call[0].region)).toBe(false);
    expect(vi.mocked(modelProvider.complete).mock.calls[1]?.[1]?.imageDataUrl).toBe("data:image/png;base64,FULL==");
    expect(steps[1].trace?.screenshot?.visionSource).toBe("full");
    expect(JSON.stringify(steps)).not.toContain("data:image/png;base64,UNEXPECTED_CROP==");
  });

  it("normalizes direct local vision loop config before running detection", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Goal achieved",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "done",
      confidence: "high",
      status: "complete",
    }));
    const computerTool = createComputerTool();
    const detections = Array.from({ length: 30 }, (_, index): ComputerDetectUiObjectsResult["detections"][number] => ({
      id: `det_${index + 1}`,
      label: "button",
      confidence: 0.95,
      box: {
        x: index * 10,
        y: 20,
        width: 8,
        height: 8,
        coordinateSpace: "screenshot" as const,
      },
      center: {
        x: index * 10 + 4,
        y: 24,
        coordinateSpace: "screenshot" as const,
      },
      source: "yolo26" as const,
    }));
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections,
      latencyMs: 5,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));

    const unsafeLocalVisionConfig = {
      enabled: true,
      mode: "prompt_hint",
      modelPath: " models/yolo26n-ui.onnx ",
      runtime: "unsupported",
      runtimeAdapterPath: " adapters/custom-local-vision.mjs ",
      imgsz: 9999,
      timeoutMs: 9999,
      maxDetections: 9999,
      promptTopK: 9999,
      minConfidence: -1,
      iouThreshold: 2,
      labelMap: {
        " 0 ": " button data:image/png;base64,MAP== ",
        "1": "input",
        "2": String.raw`C:\Users\alice\models\labels\danger-button.txt`,
        bad: 42,
      },
      disableAfterConsecutiveTimeouts: 0,
      disableAfterConsecutiveErrors: 0,
      disableAfterConsecutiveActionFailures: 0,
    } as unknown as Partial<ComputerUseLoopConfig["localVision"]>;

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 1,
        localVision: unsafeLocalVisionConfig,
      },
    });

    expect(vi.mocked(computerTool.detectUiObjects).mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      modelPath: "models/yolo26n-ui.onnx",
      runtime: "auto",
      runtimeAdapterPath: "adapters/custom-local-vision.mjs",
      imgsz: 1280,
      timeoutMs: 160,
      maxDetections: 100,
      minConfidence: 0,
      iouThreshold: 0.45,
      labelMap: {
        "0": "button [redacted:image data URL:27 chars]",
        "1": "input",
        "2": "[redacted local path:danger-button.txt]",
      },
    }));
    const prompt = vi.mocked(modelProvider.complete).mock.calls[0]?.[0] ?? "";
    const candidateLines = prompt.split("\n").filter((line) => line.startsWith("- candidate_det_"));
    expect(candidateLines).toHaveLength(20);
    expect(steps[0].trace?.localVision).toEqual(expect.objectContaining({
      mode: "prompt_hint",
      detectionCount: 30,
      promptCandidateCount: 20,
    }));
  });

  it("allows promptTopK 0 to trace detections without adding prompt candidates", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Goal achieved",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "done",
      confidence: "high",
      status: "complete",
    }));
    const computerTool = createComputerTool();
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [createLocalVisionDetection({
        id: "det_save",
        label: "saveButton",
        confidence: 0.91,
        x: 100,
        y: 200,
        width: 80,
        height: 30,
      })],
      latencyMs: 5,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          promptTopK: 0,
        },
      },
    });

    const prompt = vi.mocked(modelProvider.complete).mock.calls[0]?.[0] ?? "";
    expect(computerTool.detectUiObjects).toHaveBeenCalledTimes(1);
    expect(prompt).not.toContain("LOCAL_UI_CANDIDATES");
    expect(steps[0].trace?.localVision).toEqual(expect.objectContaining({
      mode: "prompt_hint",
      detectionCount: 1,
      promptCandidateCount: 0,
    }));
  });

  it("uses eligible local vision candidates for preflight when promptTopK is 0", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Click the dangerous hidden target",
      action: { tool: "computer.click", params: { x: 625, y: 525 } },
      target: "Hidden delete target",
      confidence: "medium",
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
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [createLocalVisionDetection({
        id: "hidden_delete_candidate",
        label: "deleteButton",
        confidence: 0.9,
        x: 600,
        y: 500,
        width: 100,
        height: 50,
      })],
      latencyMs: 4,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));
    const approveAction = vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click the dangerous hidden target",
      approveAction,
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          minConfidence: 0.75,
          promptTopK: 0,
        },
      },
    });

    const prompt = vi.mocked(modelProvider.complete).mock.calls[0]?.[0] ?? "";
    expect(prompt).not.toContain("LOCAL_UI_CANDIDATES");
    expect(computerTool.click).not.toHaveBeenCalled();
    expect(approveAction).not.toHaveBeenCalled();
    expect(steps[0].phase).toBe("failed");
    expect(steps[0].trace?.preflight).toEqual(expect.objectContaining({
      passed: false,
      reason: expect.stringContaining("candidate_hidden_delete_candidate"),
    }));
    expect(steps[0].trace?.localVision).toEqual(expect.objectContaining({
      detectionCount: 1,
      promptCandidateCount: 0,
      selectedCandidateId: "candidate_hidden_delete_candidate",
      actionRisk: "high",
      actionSucceeded: false,
    }));
  });

  it("rejects unsupported local vision modes passed directly to the loop", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Goal achieved",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "done",
      confidence: "high",
      status: "complete",
    }));
    const computerTool = createComputerTool();
    computerTool.detectUiObjects = vi.fn();

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "click_assist" as never,
          modelPath: "models/yolo26n-ui.onnx",
        },
      },
    });

    const prompt = vi.mocked(modelProvider.complete).mock.calls[0]?.[0] ?? "";
    expect(computerTool.detectUiObjects).not.toHaveBeenCalled();
    expect(prompt).not.toContain("LOCAL_UI_CANDIDATES");
    expect(steps[0].trace?.localVision).toBeUndefined();
  });

  it("keeps local vision disabled when enabled without a model path", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Goal achieved",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "done",
      confidence: "high",
      status: "complete",
    }));
    const computerTool = createComputerTool();
    computerTool.detectUiObjects = vi.fn();

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "   ",
        },
      },
    });

    const prompt = vi.mocked(modelProvider.complete).mock.calls[0]?.[0] ?? "";
    expect(computerTool.detectUiObjects).not.toHaveBeenCalled();
    expect(prompt).not.toContain("LOCAL_UI_CANDIDATES");
    expect(steps[0].trace?.localVision).toBeUndefined();
  });

  it("keeps local vision disabled when model path is an image data URL", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Goal achieved",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "done",
      confidence: "high",
      status: "complete",
    }));
    const computerTool = createComputerTool();
    computerTool.detectUiObjects = vi.fn();

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "data:image/png;base64,MODEL_SHOULD_NOT_SURVIVE==",
          runtimeAdapterPath: "data:image\\/png;base64,ADAPTER_SHOULD_NOT_SURVIVE==",
        },
      },
    });

    const prompt = vi.mocked(modelProvider.complete).mock.calls[0]?.[0] ?? "";
    expect(computerTool.detectUiObjects).not.toHaveBeenCalled();
    expect(prompt).not.toContain("LOCAL_UI_CANDIDATES");
    expect(prompt).not.toContain("MODEL_SHOULD_NOT_SURVIVE");
    expect(JSON.stringify(steps)).not.toContain("data:image");
    expect(steps[0].trace?.localVision).toBeUndefined();
  });

  it("records local vision action trace fields for selected candidates", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Click the Save button",
      action: { tool: "computer.click", params: { x: 140, y: 215 } },
      target: "Save",
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
    vi.mocked(computerTool.screenshot)
      .mockResolvedValueOnce({
        dataUrl: "data:image/png;base64,BEFORE==",
        width: 1920,
        height: 1080,
        capturedAt: "2026-06-04T00:00:00.000Z",
        methodUsed: "bitblt",
      })
      .mockResolvedValue({
        dataUrl: "data:image/png;base64,AFTER==",
        width: 1920,
        height: 1080,
        capturedAt: "2026-06-04T00:00:01.000Z",
        methodUsed: "bitblt",
      });
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [{
        id: "det_save",
        label: "saveButton",
        confidence: 0.9,
        box: {
          x: 100,
          y: 200,
          width: 80,
          height: 30,
          coordinateSpace: "screenshot" as const,
        },
        center: {
          x: 140,
          y: 215,
          coordinateSpace: "screenshot" as const,
        },
        source: "yolo26" as const,
      }],
      latencyMs: 4,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));
    vi.mocked(computerTool.click).mockResolvedValue({ x: 140, y: 215, clicked: true });
    vi.mocked(computerTool.invokeUi).mockResolvedValue({
      invoked: true,
      matchedName: "Save",
      matchedAutomationId: "saveButton",
    });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click save",
      approveAction: vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" })),
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
        },
      },
    });

    expect(steps[0].trace?.localVision).toEqual(expect.objectContaining({
      selectedCandidateId: "candidate_det_save",
      selectedCandidateSource: ["uia", "yolo"],
      actionType: "computer.invokeUi",
      actionRisk: "medium",
      actionSucceeded: true,
      fullScreenshotVlmCalled: true,
      cropVlmCalled: false,
      fullScreenshotVlmSkipped: false,
    }));
  });

  it("keeps local vision disabled instead of adding UIA-only prompt candidates when the model is missing", async () => {
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
        rect: { x: 0, y: 0, width: 800, height: 600 },
        isVisible: true,
        isForeground: true,
      }],
    });
    vi.mocked(computerTool.inspectUi).mockResolvedValue({
      tree: "<Edit name=\"Project name\" automationId=\"projectNameInput\">",
      nodeCount: 1,
    });
    computerTool.detectUiObjects = vi.fn();

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
        },
      },
    });

    const prompt = vi.mocked(modelProvider.complete).mock.calls[0]?.[0] ?? "";
    expect(prompt).not.toContain("LOCAL_UI_CANDIDATES");
    expect(computerTool.detectUiObjects).not.toHaveBeenCalled();
    expect(steps[0].trace?.localVision).toBeUndefined();
  });

  it("does not add UIA-only local vision prompt candidates when detection returns no boxes", async () => {
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
        rect: { x: 0, y: 0, width: 800, height: 600 },
        isVisible: true,
        isForeground: true,
      }],
    });
    vi.mocked(computerTool.inspectUi).mockResolvedValue({
      tree: "<Button name=\"Save\" automationId=\"saveButton\" bounds=\"100,200,80,30\">",
      nodeCount: 1,
    });
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [],
      latencyMs: 4,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
        },
      },
    });

    const prompt = vi.mocked(modelProvider.complete).mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("UIA CONTEXT");
    expect(prompt).toContain("saveButton");
    expect(prompt).not.toContain("LOCAL_UI_CANDIDATES");
    expect(steps[0].trace?.localVision).toEqual(expect.objectContaining({
      mode: "prompt_hint",
      used: false,
      detectionCount: 0,
      promptCandidateCount: 0,
    }));
  });

  it("drops malformed local vision detections before adding prompt hints", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Goal achieved",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "done",
      confidence: "high",
      status: "complete",
    }));
    const computerTool = createComputerTool();
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [
        {
          id: "det_bad",
          label: "button",
          confidence: 0.99,
          box: {
            x: Number.NaN,
            y: 10,
            width: 20,
            height: 20,
            coordinateSpace: "screenshot" as const,
          },
          center: {
            x: 20,
            y: 20,
            coordinateSpace: "screenshot" as const,
          },
          source: "yolo26" as const,
        },
        {
          id: "det_good",
          label: "button",
          confidence: 0.9,
          box: {
            x: 10,
            y: 20,
            width: 30,
            height: 40,
            coordinateSpace: "screenshot" as const,
          },
          center: {
            x: 25,
            y: 40,
            coordinateSpace: "screenshot" as const,
          },
          source: "yolo26" as const,
        },
      ],
      latencyMs: 4,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          minConfidence: 0.75,
        },
      },
    });

    const prompt = vi.mocked(modelProvider.complete).mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("candidate_det_good");
    expect(prompt).not.toContain("candidate_det_bad");
    expect(prompt).not.toContain("NaN");
    expect(steps[0].trace?.localVision).toEqual(expect.objectContaining({
      used: true,
      detectionCount: 1,
      promptCandidateCount: 1,
    }));
  });

  it("bounds local vision detections to the current screenshot before prompt hints", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Goal achieved",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "done",
      confidence: "high",
      status: "complete",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.screenshot).mockResolvedValue({
      dataUrl: "data:image/png;base64,SMALL==",
      width: 100,
      height: 80,
      capturedAt: "2026-06-04T00:00:00.000Z",
      methodUsed: "bitblt",
    });
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [
        createLocalVisionDetection({
          id: "offscreen",
          label: "button",
          confidence: 0.99,
          x: 180,
          y: 120,
          width: 40,
          height: 30,
        }),
        createLocalVisionDetection({
          id: "partial",
          label: "button",
          confidence: 0.91,
          x: -10,
          y: 20,
          width: 30,
          height: 20,
        }),
      ],
      latencyMs: 4,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          minConfidence: 0.75,
        },
      },
    });

    const prompt = vi.mocked(modelProvider.complete).mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("candidate_partial");
    expect(prompt).toContain("box=[0,20,20,20]");
    expect(prompt).not.toContain("candidate_offscreen");
    expect(steps[0].trace?.localVision).toEqual(expect.objectContaining({
      detectionCount: 1,
      promptCandidateCount: 1,
    }));
  });

  it("redacts local vision model paths from recorded trace", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Goal achieved",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "done",
      confidence: "high",
      status: "complete",
    }));
    const computerTool = createComputerTool();
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [],
      latencyMs: 4,
      model: String.raw`C:\Users\alice\models\yolo26n-ui.onnx`,
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "passive",
          modelPath: String.raw`C:\Users\alice\models\yolo26n-ui.onnx`,
        },
      },
    });

    const serialized = JSON.stringify(steps);
    expect(steps[0].trace?.localVision?.model).toBe("yolo26n-ui.onnx");
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain(String.raw`C:\Users`);
  });

  it("redacts local vision error and diagnostic paths from recorded trace", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Goal achieved",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "done",
      confidence: "high",
      status: "complete",
    }));
    const computerTool = createComputerTool();
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [],
      latencyMs: 4,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
      error: String.raw`adapter failed at C:\Users\alice\My Models\runtime adapter.mjs`,
      diagnostics: {
        adapterPath: String.raw`C:\Users\alice\My Models\runtime adapter.mjs`,
        nested: {
          cachePath: "/home/alice/.cache/javis/model cache.bin",
        },
      },
    }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "passive",
          modelPath: String.raw`C:\Users\alice\models\yolo26n-ui.onnx`,
        },
      },
    });

    const serialized = JSON.stringify(steps);
    expect(serialized).toContain("[redacted local path:runtime adapter.mjs]");
    expect(serialized).toContain("[redacted local path:model cache.bin]");
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain(String.raw`C:\Users`);
    expect(serialized).not.toContain("My Models");
    expect(serialized).not.toContain("/home/alice");
  });

  it("keeps local vision diagnostics in trace without adding them to prompt history", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Goal achieved",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "done",
      confidence: "high",
      status: "complete",
    }));
    const computerTool = createComputerTool();
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [{
        id: "det_ok",
        label: "button",
        confidence: 0.92,
        box: {
          x: 10,
          y: 20,
          width: 30,
          height: 40,
          coordinateSpace: "screenshot" as const,
        },
        center: {
          x: 25,
          y: 40,
          coordinateSpace: "screenshot" as const,
        },
        source: "yolo26" as const,
      }],
      latencyMs: 4,
      model: "yolo26n.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
      diagnostics: {
        outputDims: [1, 6, 8400],
        rawDetectionCount: 12,
        rawPreview: "data:image/png;base64,SHOULD_NOT_SURVIVE",
        secondRawPreview: "data:image/png;base64,SECOND_SHOULD_NOT_SURVIVE",
        longMessage: "x".repeat(220),
      },
    }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n.onnx",
          minConfidence: 0.75,
        },
      },
    });

    const prompt = vi.mocked(modelProvider.complete).mock.calls[0]?.[0] ?? "";
    expect(prompt).not.toContain("LOCAL_UI_CANDIDATES");
    expect(prompt).not.toContain("candidate_det_ok");
    expect(prompt).not.toContain("outputDims");
    expect(prompt).not.toContain("SHOULD_NOT_SURVIVE");
    expect(prompt).not.toContain("smoke/benchmark only");
    expect(JSON.stringify(steps)).not.toContain("data:image");
    expect(steps[0].trace?.localVision?.diagnostics).toEqual(expect.objectContaining({
      outputDims: [1, 6, 8400],
      rawDetectionCount: 12,
      rawPreview: "[redacted image data]",
      secondRawPreview: "[redacted image data]",
      warnings: expect.arrayContaining([
        expect.stringContaining("smoke/benchmark only"),
      ]),
    }));
    expect(steps[0].trace?.localVision).toEqual(expect.objectContaining({
      used: false,
      detectionCount: 1,
      promptCandidateCount: 0,
    }));
    expect(String(steps[0].trace?.localVision?.diagnostics?.longMessage).length).toBeLessThanOrEqual(160);
  });

  it("does not let official COCO model paths produce UI candidates even if the worker reports a UI model name", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Goal achieved",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "done",
      confidence: "high",
      status: "complete",
    }));
    const computerTool = createComputerTool();
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [createLocalVisionDetection({
        id: "det_fake_ui",
        label: "button",
        confidence: 0.95,
        x: 10,
        y: 20,
        width: 30,
        height: 40,
      })],
      latencyMs: 4,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n.onnx",
          minConfidence: 0.75,
        },
      },
    });

    const prompt = vi.mocked(modelProvider.complete).mock.calls[0]?.[0] ?? "";
    expect(prompt).not.toContain("LOCAL_UI_CANDIDATES");
    expect(prompt).not.toContain("candidate_det_fake_ui");
    expect(steps[0].trace?.localVision).toEqual(expect.objectContaining({
      model: "yolo26n-ui.onnx",
      configuredModel: "yolo26n.onnx",
      used: false,
      detectionCount: 1,
      promptCandidateCount: 0,
    }));
    expect(steps[0].trace?.localVision?.diagnostics).toEqual(expect.objectContaining({
      warnings: expect.arrayContaining([
        expect.stringContaining("yolo26n.onnx matches an official Ultralytics YOLO26 COCO weight name"),
      ]),
    }));
  });

  it("redacts image data URLs recursively from recorded trace fields", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Goal achieved",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "done",
      confidence: "high",
      status: "complete",
    }));
    const computerTool = createComputerTool();
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [],
      latencyMs: 4,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
      diagnostics: {
        nested: {
          previewDataUrl: "data:image\\/png;base64,TRACE_SHOULD_NOT_SURVIVE==",
          values: ["data:image/png;base64,TRACE_ARRAY_SHOULD_NOT_SURVIVE=="],
          "data:image\\/png;base64,TRACE_KEY_SHOULD_NOT_SURVIVE==": "safe value",
        },
      },
    }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "passive",
          modelPath: "models/yolo26n-ui.onnx",
        },
      },
    });

    expect(JSON.stringify(steps)).not.toContain("data:image");
    expect(JSON.stringify(steps)).not.toContain("data:image\\/");
    expect(JSON.stringify(steps)).not.toContain("SHOULD_NOT_SURVIVE");
    expect(steps[0].trace?.localVision?.diagnostics).toEqual(expect.objectContaining({
      nested: expect.objectContaining({
        previewDataUrl: expect.stringContaining("[redacted"),
        values: ["[redacted image data]"],
        "[redacted image key]": "safe value",
      }),
    }));
  });

  it("redacts image data URLs when formatting unsanitized step history", () => {
    const history = formatStepHistory([
      {
        stepIndex: 0,
        screenshotDataUrl: "data:image/png;base64,SCREEN_SHOULD_NOT_SURVIVE==",
        observation: "Saw target data:image/png;base64,OBS_SHOULD_NOT_SURVIVE==",
        action: {
          tool: "computer.invokeUi",
          params: {
            selector: {
              windowHandle: 42,
              automationId: "saveButton",
              name: "Save data:image/png;base64,PARAM_SHOULD_NOT_SURVIVE==",
            },
          },
        },
        target: "Invoke target data:image/png;base64,TARGET_SHOULD_NOT_SURVIVE==",
        confidence: "high",
        result: {
          nested: {
            previewDataUrl: "data:image/png;base64,RESULT_SHOULD_NOT_SURVIVE==",
          },
        },
      },
      {
        stepIndex: 1,
        screenshotDataUrl: "",
        observation: "Retry failed data:image/png;base64,OBS2_SHOULD_NOT_SURVIVE==",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "Wait",
        confidence: "low",
        error: "Failed data:image/png;base64,ERROR_SHOULD_NOT_SURVIVE==",
      },
    ] satisfies ComputerUseStep[], 2);

    expect(history).toContain("PREVIOUS STEPS");
    expect(history).toContain("[redacted");
    expect(history).not.toContain("data:image");
    expect(history).not.toContain("SHOULD_NOT_SURVIVE");
  });

  it("bounds oversized fields in recorded step history", () => {
    const hugeText = "x".repeat(12_000);
    const hugeArray = Array.from({ length: 75 }, (_value, index) => index);
    const history = formatStepHistory([
      {
        stepIndex: 0,
        screenshotDataUrl: "data:image/png;base64,SCREEN_SHOULD_NOT_SURVIVE==",
        observation: hugeText,
        action: {
          tool: "computer.invokeUi",
          params: {
            selector: {
              windowHandle: 42,
              name: hugeText,
            },
          },
        },
        target: hugeText,
        confidence: "high",
        result: {
          message: hugeText,
          values: hugeArray,
        },
      },
    ] satisfies ComputerUseStep[], 1);

    expect(history).toContain("[truncated:");
    expect(history).not.toContain("data:image");
    expect(history.length).toBeLessThan(8_000);
  });

  it("redacts image data URLs from prompt-only computer use context", async () => {
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
        title: "Preview data:image/png;base64,WINDOW_TITLE_SHOULD_NOT_SURVIVE==",
        className: "TargetWindow",
        rect: { x: 0, y: 0, width: 800, height: 600 },
        isVisible: true,
        isForeground: true,
      }],
    });
    vi.mocked(computerTool.inspectUi).mockResolvedValue({
      tree: "<Button name=\"Save data:image/png;base64,UIA_NAME_SHOULD_NOT_SURVIVE==\" automationId=\"save data:image/png;base64,UIA_ID_SHOULD_NOT_SURVIVE==\">",
      nodeCount: 1,
    });
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [{
        id: String.raw`det_data:image/png;base64,DETECTION_ID_SHOULD_NOT_SURVIVE==_C:\Users\alice\My Models\detector cache.bin`,
        label: String.raw`button data:image/png;base64,DETECTION_LABEL_SHOULD_NOT_SURVIVE== C:\Users\alice\My Models\button label.txt ${"x".repeat(180)}`,
        confidence: 0.92,
        box: {
          x: 10,
          y: 20,
          width: 30,
          height: 40,
          coordinateSpace: "screenshot" as const,
        },
        center: {
          x: 25,
          y: 40,
          coordinateSpace: "screenshot" as const,
        },
        source: "yolo26" as const,
      }],
      latencyMs: 4,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));

    await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          minConfidence: 0.75,
        },
      },
    });

    const prompt = vi.mocked(modelProvider.complete).mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("LOCAL_UI_CANDIDATES");
    expect(prompt).toContain("[redacted:image data URL:");
    expect(prompt).toContain("[redacted local path:");
    expect(prompt).not.toContain("data:image");
    expect(prompt).not.toContain("SHOULD_NOT_SURVIVE");
    expect(prompt).not.toContain(String.raw`C:\Users\alice`);
    expect(prompt).not.toContain("My Models");
    const candidateLine = prompt.split("\n").find((line) => line.startsWith("- candidate_det_")) ?? "";
    expect(candidateLine.length).toBeLessThan(500);
  });

  it("redacts image data URLs from user goal and screenshot failure prompt text", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Use window context",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "done",
      confidence: "high",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.screenshot).mockRejectedValue(
      new Error(`capture failed data:image/png;base64,GOAL_PROMPT_SHOULD_NOT_SURVIVE== ${"x".repeat(300)}`),
    );
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

    await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: `Inspect data:image/png;base64,USER_GOAL_SHOULD_NOT_SURVIVE== ${"y".repeat(6_000)}`,
      config: { maxSteps: 1 },
    });

    const prompt = vi.mocked(modelProvider.complete).mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("USER GOAL:");
    expect(prompt).toContain("[redacted:image data URL:");
    expect(prompt).toContain("SCREENSHOT: unavailable");
    expect(prompt).toContain("...");
    expect(prompt).not.toContain("data:image");
    expect(prompt).not.toContain("SHOULD_NOT_SURVIVE");
    expect(prompt.length).toBeLessThan(12_000);
  });

  it("ranks multi-evidence candidates ahead of yolo-only prompt hints", async () => {
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
        rect: { x: 0, y: 0, width: 800, height: 600 },
        isVisible: true,
        isForeground: true,
      }],
    });
    vi.mocked(computerTool.inspectUi).mockResolvedValue({
      tree: "<Button name=\"Save\" automationId=\"saveButton\">",
      nodeCount: 1,
    });
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [
        {
          id: "det_yolo_only",
          label: "possible_icon",
          confidence: 0.99,
          box: {
            x: 500,
            y: 100,
            width: 30,
            height: 30,
            coordinateSpace: "screenshot" as const,
          },
          center: {
            x: 515,
            y: 115,
            coordinateSpace: "screenshot" as const,
          },
          source: "yolo26" as const,
        },
        {
          id: "det_save",
          label: "saveButton",
          confidence: 0.86,
          box: {
            x: 100,
            y: 200,
            width: 80,
            height: 30,
            coordinateSpace: "screenshot" as const,
          },
          center: {
            x: 140,
            y: 215,
            coordinateSpace: "screenshot" as const,
          },
          source: "yolo26" as const,
        },
      ],
      latencyMs: 5,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));

    await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          minConfidence: 0.75,
          promptTopK: 2,
        },
      },
    });

    const prompt = vi.mocked(modelProvider.complete).mock.calls[0]?.[0] ?? "";
    const candidateBlock = prompt.split("LOCAL_UI_CANDIDATES")[1] ?? "";
    const candidateLines = candidateBlock.split("\n").filter((line) => line.startsWith("- "));
    expect(candidateLines[0]).toContain("candidate_det_save");
    expect(candidateLines[1]).toContain("candidate_det_yolo_only");
    expect(candidateBlock).toContain("Do not click them directly");
    expect(prompt).toContain("mode=user_confirmation_required");
    expect(prompt).toContain("reason=\"uia+yolo evidence; prefer selector for execution\"");
    expect(prompt).not.toContain("mode=coordinate_assist_allowed");
    expect(prompt).toContain("reason=\"yolo-only visual region; coordinate hint requires confirmation\"");
  });

  it("accepts custom local vision detection source strings as candidate hints", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Goal achieved",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "done",
      confidence: "high",
      status: "complete",
    }));
    const computerTool = createComputerTool();
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [{
        ...createLocalVisionDetection({
          id: "det_custom_source",
          label: "possible_button",
          confidence: 0.92,
          x: 20,
          y: 30,
          width: 40,
          height: 20,
        }),
        source: "openvino-yolo26-ui",
      }],
      latencyMs: 6,
      model: "yolo26n-ui.onnx",
      runtime: "openvino" as const,
      timedOut: false,
    }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          runtime: "openvino",
          minConfidence: 0.75,
        },
      },
    });

    const prompt = vi.mocked(modelProvider.complete).mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("candidate_det_custom_source");
    expect(prompt).toContain("evidence=yolo:0.92");
    expect(prompt).not.toContain("openvino-yolo26-ui");
    expect(steps[0].trace?.localVision).toEqual(expect.objectContaining({
      mode: "prompt_hint",
      runtime: "openvino",
      detectionCount: 1,
      promptCandidateCount: 1,
    }));
  });

  it("continues when local vision detection times out", async () => {
    vi.useFakeTimers();
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Goal achieved",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "done",
      confidence: "high",
      status: "complete",
    }));
    const computerTool = createComputerTool();
    computerTool.detectUiObjects = vi.fn((): Promise<ComputerDetectUiObjectsResult> => new Promise(() => {}));

    const runPromise = runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          timeoutMs: 20,
        },
      },
    });

    await vi.advanceTimersByTimeAsync(20);
    const steps = await runPromise;
    vi.useRealTimers();

    expect(steps).toHaveLength(1);
    expect(steps[0].phase).toBe("completed");
    expect(vi.mocked(computerTool.detectUiObjects).mock.calls[0]?.[0]?.timeoutMs).toBe(20);
    expect(steps[0].trace?.localVision).toEqual(expect.objectContaining({
      mode: "timeout",
      used: false,
      detectionCount: 0,
    }));
    expect(modelProvider.complete).toHaveBeenCalledTimes(1);
  });

  it("does not wait for the full local vision worker timeout during observation", async () => {
    vi.useFakeTimers();
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Goal achieved",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "done",
      confidence: "high",
      status: "complete",
    }));
    const computerTool = createComputerTool();
    computerTool.detectUiObjects = vi.fn((): Promise<ComputerDetectUiObjectsResult> => new Promise(() => {}));

    const runPromise = runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          timeoutMs: 2_000,
        },
      },
    });

    await vi.advanceTimersByTimeAsync(160);
    const steps = await runPromise;
    vi.useRealTimers();

    expect(computerTool.detectUiObjects).toHaveBeenCalledTimes(1);
    expect(vi.mocked(computerTool.detectUiObjects).mock.calls[0]?.[0]?.timeoutMs).toBe(160);
    expect(modelProvider.complete).toHaveBeenCalledTimes(1);
    expect(steps[0].phase).toBe("completed");
    expect(steps[0].trace?.durationMs).toBeLessThan(2_000);
    expect(steps[0].trace?.localVision).toEqual(expect.objectContaining({
      mode: "timeout",
      used: false,
      detectionCount: 0,
    }));
  });

  it("drops detections returned with a timed-out local vision result", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Goal achieved",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "done",
      confidence: "high",
      status: "complete",
    }));
    const computerTool = createComputerTool();
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [createLocalVisionDetection({
        id: "late_save",
        label: "saveButton",
        confidence: 0.99,
        x: 100,
        y: 120,
        width: 80,
        height: 30,
      })],
      latencyMs: 121,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: true,
      error: "worker exceeded timeout budget",
    }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          timeoutMs: 120,
        },
      },
    });

    const prompt = vi.mocked(modelProvider.complete).mock.calls[0]?.[0] ?? "";
    expect(prompt).not.toContain("LOCAL_UI_CANDIDATES");
    expect(prompt).not.toContain("late_save");
    expect(steps[0].trace?.localVision).toEqual(expect.objectContaining({
      mode: "timeout",
      used: false,
      detectionCount: 0,
      promptCandidateCount: 0,
      error: "worker exceeded timeout budget",
    }));
  });

  it("drops detections returned with a local vision error result", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Goal achieved",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "done",
      confidence: "high",
      status: "complete",
    }));
    const computerTool = createComputerTool();
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [createLocalVisionDetection({
        id: "error_save",
        label: "saveButton",
        confidence: 0.99,
        x: 100,
        y: 120,
        width: 80,
        height: 30,
      })],
      latencyMs: 10,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
      error: "local vision runtime adapter failed after partial decode",
    }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
        },
      },
    });

    const prompt = vi.mocked(modelProvider.complete).mock.calls[0]?.[0] ?? "";
    expect(prompt).not.toContain("LOCAL_UI_CANDIDATES");
    expect(prompt).not.toContain("error_save");
    expect(steps[0].trace?.localVision).toEqual(expect.objectContaining({
      mode: "error",
      used: false,
      detectionCount: 0,
      promptCandidateCount: 0,
      error: "local vision runtime adapter failed after partial decode",
    }));
  });

  it("disables local vision after repeated detection timeouts in one task", async () => {
    vi.useFakeTimers();
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "Need another look",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "continue",
        confidence: "medium",
      }),
      JSON.stringify({
        observation: "Still checking",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "continue",
        confidence: "medium",
      }),
      JSON.stringify({
        observation: "Keep checking",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "continue",
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
    computerTool.detectUiObjects = vi.fn((): Promise<ComputerDetectUiObjectsResult> => new Promise(() => {}));

    const runPromise = runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 4,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          timeoutMs: 20,
          disableAfterConsecutiveTimeouts: 2,
        },
      },
    });

    await vi.advanceTimersByTimeAsync(40);
    const steps = await runPromise;
    vi.useRealTimers();

    expect(steps).toHaveLength(3);
    expect(computerTool.detectUiObjects).toHaveBeenCalledTimes(2);
    expect(steps[0].trace?.localVision?.mode).toBe("timeout");
    expect(steps[0].trace?.localVision).toEqual(expect.objectContaining({
      consecutiveTimeouts: 1,
      consecutiveErrors: 0,
      consecutiveActionFailures: 0,
    }));
    expect(steps[1].trace?.localVision?.mode).toBe("timeout");
    expect(steps[1].trace?.localVision).toEqual(expect.objectContaining({
      consecutiveTimeouts: 2,
      consecutiveErrors: 0,
      consecutiveActionFailures: 0,
      disabledReason: "timeout",
    }));
    expect(steps[2].trace?.localVision).toEqual(expect.objectContaining({
      mode: "disabled",
      used: false,
      detectionCount: 0,
      consecutiveTimeouts: 2,
      disabledReason: "timeout",
    }));
    expect(steps[2].trace?.localVision?.error).toContain("local vision disabled after 2 consecutive timeouts");
  });

  it("uses the default repeated-timeout threshold to disable local vision after two timeouts", async () => {
    vi.useFakeTimers();
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "Need another look",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "continue",
        confidence: "medium",
      }),
      JSON.stringify({
        observation: "Still checking",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "continue",
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
    computerTool.detectUiObjects = vi.fn((): Promise<ComputerDetectUiObjectsResult> => new Promise(() => {}));

    const runPromise = runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 4,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          timeoutMs: 20,
        },
      },
    });

    await vi.advanceTimersByTimeAsync(40);
    const steps = await runPromise;
    vi.useRealTimers();

    expect(steps).toHaveLength(3);
    expect(computerTool.detectUiObjects).toHaveBeenCalledTimes(2);
    expect(steps[1].trace?.localVision).toEqual(expect.objectContaining({
      consecutiveTimeouts: 2,
      disabledReason: "timeout",
    }));
    expect(steps[2].trace?.localVision).toEqual(expect.objectContaining({
      mode: "disabled",
      detectionCount: 0,
      disabledReason: "timeout",
    }));
  });

  it("lowers local vision image size for the rest of the task after repeated slow detections", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "Need another look",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "continue",
        confidence: "medium",
      }),
      JSON.stringify({
        observation: "Still checking",
        action: { tool: "computer.wait", params: { ms: 1 } },
        target: "continue",
        confidence: "medium",
      }),
      JSON.stringify({
        observation: "Try a lower-cost look",
        action: { tool: "computer.wait", params: { ms: 2 } },
        target: "continue",
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
    const latencies = [150, 150, 20, 20];
    let detectionIndex = 0;
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [createLocalVisionDetection({
        id: `det_${detectionIndex += 1}`,
        label: "button",
        confidence: 0.9,
        x: 10,
        y: 10,
        width: 20,
        height: 20,
      })],
      latencyMs: latencies.shift() ?? 20,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 4,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          imgsz: 960,
          timeoutMs: 200,
        },
      },
    });

    expect(steps).toHaveLength(4);
    expect(vi.mocked(computerTool.detectUiObjects).mock.calls.map((call) => call[0].imgsz)).toEqual([
      960,
      960,
      512,
      512,
    ]);
    expect(steps[0].trace?.localVision).toEqual(expect.objectContaining({
      imgsz: 960,
      effectiveImgSize: 960,
      consecutiveSlowDetections: 1,
    }));
    expect(steps[1].trace?.localVision).toEqual(expect.objectContaining({
      imgsz: 960,
      effectiveImgSize: 512,
      consecutiveSlowDetections: 2,
    }));
    expect(steps[2].trace?.localVision).toEqual(expect.objectContaining({
      imgsz: 512,
      effectiveImgSize: 512,
      consecutiveSlowDetections: 0,
    }));
    expect(steps[3].trace?.localVision).toEqual(expect.objectContaining({
      imgsz: 512,
      effectiveImgSize: 512,
      consecutiveSlowDetections: 0,
    }));
  });

  it("keeps local vision enabled when repeated-timeout disabling is set to zero", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "Need another look",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "continue",
        confidence: "medium",
      }),
      JSON.stringify({
        observation: "Still checking",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "continue",
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
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [],
      latencyMs: 20,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: true,
      error: "worker exceeded timeout budget",
    }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 3,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          timeoutMs: 20,
          disableAfterConsecutiveTimeouts: 0,
          disableAfterConsecutiveErrors: 2,
        },
      },
    });

    expect(steps).toHaveLength(3);
    expect(computerTool.detectUiObjects).toHaveBeenCalledTimes(3);
    expect(steps.map((step) => step.trace?.localVision?.mode)).toEqual(["timeout", "timeout", "timeout"]);
    expect(steps[1].trace?.localVision).toEqual(expect.objectContaining({
      consecutiveTimeouts: 2,
      consecutiveErrors: 0,
      disabledReason: undefined,
    }));
    expect(steps[2].trace?.localVision).toEqual(expect.objectContaining({
      consecutiveTimeouts: 3,
      consecutiveErrors: 0,
      disabledReason: undefined,
    }));
    expect(steps[1].trace?.localVision?.error).not.toContain("local vision disabled");
  });

  it("disables local vision after repeated detector errors in one task", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "Need another look",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "continue",
        confidence: "medium",
      }),
      JSON.stringify({
        observation: "Still checking",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "continue",
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
    computerTool.detectUiObjects = vi.fn(async () => {
      throw new Error("onnxruntime-node is not installed");
    });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 3,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          disableAfterConsecutiveErrors: 2,
        },
      },
    });

    expect(steps).toHaveLength(3);
    expect(computerTool.detectUiObjects).toHaveBeenCalledTimes(2);
    expect(steps[0].trace?.localVision?.mode).toBe("error");
    expect(steps[1].trace?.localVision?.mode).toBe("error");
    expect(steps[0].trace?.localVision?.error).toContain("onnxruntime-node is not installed");
    expect(steps[1].trace?.localVision?.error).toContain("onnxruntime-node is not installed");
    expect(steps[2].trace?.localVision).toEqual(expect.objectContaining({
      mode: "disabled",
      used: false,
      detectionCount: 0,
    }));
    expect(steps[2].trace?.localVision?.error).toContain("local vision disabled after 2 consecutive errors");
  });

  it("disables local vision after repeated worker error results in one task", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "Need another look",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "continue",
        confidence: "medium",
      }),
      JSON.stringify({
        observation: "Still checking",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "continue",
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
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [],
      latencyMs: 0,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
      error: "Node.js executable not found for local vision worker; set JAVIS_LOCAL_VISION_NODE_PATH or add node to PATH",
    }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 3,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          disableAfterConsecutiveErrors: 2,
        },
      },
    });

    expect(steps).toHaveLength(3);
    expect(computerTool.detectUiObjects).toHaveBeenCalledTimes(2);
    expect(steps.map((step) => step.trace?.localVision?.mode)).toEqual(["error", "error", "disabled"]);
    expect(steps[0].trace?.localVision?.error).toContain("Node.js executable not found");
    expect(steps[1].trace?.localVision?.error).toContain("Node.js executable not found");
    expect(steps[2].trace?.localVision?.error).toContain("local vision disabled after 2 consecutive errors");
  });

  it("keeps local vision enabled when repeated-error disabling is set to zero", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "Need another look",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "continue",
        confidence: "medium",
      }),
      JSON.stringify({
        observation: "Still checking",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "continue",
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
    computerTool.detectUiObjects = vi.fn(async () => {
      throw new Error("onnxruntime-node is not installed");
    });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 3,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          disableAfterConsecutiveErrors: 0,
        },
      },
    });

    expect(steps).toHaveLength(3);
    expect(computerTool.detectUiObjects).toHaveBeenCalledTimes(3);
    expect(steps.map((step) => step.trace?.localVision?.mode)).toEqual(["error", "error", "error"]);
    expect(steps[2].trace?.localVision?.error).not.toContain("local vision disabled");
  });

  it("disables local vision hints after repeated action failures in one task", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "Need to click the visual target",
        action: { tool: "computer.click", params: { x: 140, y: 215 } },
        target: "Click target",
        confidence: "medium",
      }),
      JSON.stringify({
        observation: "Need to try again differently",
        action: { tool: "computer.click", params: { x: 140, y: 215 } },
        target: "Click target again",
        confidence: "medium",
      }),
      JSON.stringify({
        observation: "Use fallback context",
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
    vi.mocked(computerTool.inspectUi).mockResolvedValue({
      tree: "<Button name=\"Save\" automationId=\"saveButton\">",
      nodeCount: 1,
    });
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [{
        id: "det_save",
        label: "saveButton",
        confidence: 0.9,
        box: {
          x: 100,
          y: 200,
          width: 80,
          height: 30,
          coordinateSpace: "screenshot" as const,
        },
        center: {
          x: 140,
          y: 215,
          coordinateSpace: "screenshot" as const,
        },
        source: "yolo26" as const,
      }],
      latencyMs: 4,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));
    vi.mocked(computerTool.click).mockResolvedValue({
      x: 140,
      y: 215,
      clicked: false,
    });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click the target",
      approveAction: vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" })),
      config: {
        maxSteps: 3,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          disableAfterConsecutiveActionFailures: 2,
        },
      },
    });

    expect(steps).toHaveLength(3);
    expect(steps[0].phase).toBe("failed");
    expect(steps[1].phase).toBe("failed");
    expect(steps[0].trace?.localVision).toEqual(expect.objectContaining({
      consecutiveActionFailures: 1,
    }));
    expect(steps[1].trace?.localVision).toEqual(expect.objectContaining({
      consecutiveActionFailures: 2,
      disabledReason: "action_failure",
    }));
    const firstPrompt = vi.mocked(modelProvider.complete).mock.calls[0]?.[0] ?? "";
    const thirdPrompt = vi.mocked(modelProvider.complete).mock.calls[2]?.[0] ?? "";
    expect(firstPrompt).toContain("LOCAL_UI_CANDIDATES");
    expect(thirdPrompt).not.toContain("LOCAL_UI_CANDIDATES");
    expect(steps[2].trace?.localVision).toEqual(expect.objectContaining({
      mode: "disabled",
      used: false,
      detectionCount: 0,
      promptCandidateCount: 0,
    }));
    expect(steps[2].trace?.localVision?.error).toContain("local vision disabled after 2 consecutive action failures");
  });

  it("keeps local vision hints after action failures when action-failure disabling is set to zero", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "Need to click the visual target",
        action: { tool: "computer.click", params: { x: 140, y: 215 } },
        target: "Click target",
        confidence: "medium",
      }),
      JSON.stringify({
        observation: "Need to try again differently",
        action: { tool: "computer.click", params: { x: 140, y: 215 } },
        target: "Click target again",
        confidence: "medium",
      }),
      JSON.stringify({
        observation: "Use fallback context",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "continue",
        confidence: "medium",
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
    vi.mocked(computerTool.inspectUi).mockResolvedValue({
      tree: "<Button name=\"Save\" automationId=\"saveButton\">",
      nodeCount: 1,
    });
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [createLocalVisionDetection({
        id: "det_save",
        label: "saveButton",
        confidence: 0.9,
        x: 100,
        y: 200,
        width: 80,
        height: 30,
      })],
      latencyMs: 4,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));
    vi.mocked(computerTool.click).mockResolvedValue({
      x: 140,
      y: 215,
      clicked: false,
    });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click the target",
      approveAction: vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" })),
      config: {
        maxSteps: 3,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          disableAfterConsecutiveActionFailures: 0,
        },
      },
    });

    const thirdPrompt = vi.mocked(modelProvider.complete).mock.calls[2]?.[0] ?? "";
    expect(steps).toHaveLength(3);
    expect(steps[0].phase).toBe("failed");
    expect(steps[1].phase).toBe("failed");
    expect(thirdPrompt).toContain("LOCAL_UI_CANDIDATES");
    expect(steps[2].trace?.localVision?.mode).toBe("prompt_hint");
  });

  it("does not disable local vision after failures unrelated to local vision candidates", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "Need to click somewhere else",
        action: { tool: "computer.click", params: { x: 500, y: 500 } },
        target: "Click unrelated location",
        confidence: "medium",
      }),
      JSON.stringify({
        observation: "Need to try the unrelated location again",
        action: { tool: "computer.click", params: { x: 500, y: 500 } },
        target: "Click unrelated location again",
        confidence: "medium",
      }),
      JSON.stringify({
        observation: "Use fallback context",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "continue",
        confidence: "medium",
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
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [createLocalVisionDetection({
        id: "det_save",
        label: "saveButton",
        confidence: 0.9,
        x: 100,
        y: 200,
        width: 80,
        height: 30,
      })],
      latencyMs: 4,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));
    vi.mocked(computerTool.click).mockResolvedValue({
      x: 500,
      y: 500,
      clicked: false,
    });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click the target",
      approveAction: vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" })),
      config: {
        maxSteps: 3,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          disableAfterConsecutiveActionFailures: 2,
        },
      },
    });

    const thirdPrompt = vi.mocked(modelProvider.complete).mock.calls[2]?.[0] ?? "";
    expect(steps).toHaveLength(3);
    expect(steps[0].phase).toBe("failed");
    expect(steps[1].phase).toBe("failed");
    expect(steps[0].trace?.localVision?.selectedCandidateId).toBeUndefined();
    expect(steps[1].trace?.localVision?.selectedCandidateId).toBeUndefined();
    expect(steps[1].trace?.localVision).toEqual(expect.objectContaining({
      consecutiveActionFailures: 0,
      disabledReason: undefined,
    }));
    expect(thirdPrompt).toContain("LOCAL_UI_CANDIDATES");
    expect(steps[2].trace?.localVision?.mode).toBe("prompt_hint");
  });

  it("blocks high-risk local vision candidates even when prompt Top-K omits them", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Click the requested area",
      action: { tool: "computer.click", params: { x: 625, y: 525 } },
      target: "Dangerous hidden candidate",
      confidence: "medium",
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
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [
        createLocalVisionDetection({
          id: "safe_top_candidate",
          label: "possible_button",
          confidence: 0.99,
          x: 100,
          y: 100,
          width: 80,
          height: 30,
        }),
        createLocalVisionDetection({
          id: "hidden_delete_candidate",
          label: "deleteButton",
          confidence: 0.9,
          x: 600,
          y: 500,
          width: 100,
          height: 50,
        }),
      ],
      latencyMs: 4,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));
    const approveAction = vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click the requested area",
      approveAction,
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
          minConfidence: 0.75,
          promptTopK: 1,
        },
      },
    });

    const prompt = vi.mocked(modelProvider.complete).mock.calls[0]?.[0] ?? "";
    const candidateBlock = prompt.split("LOCAL_UI_CANDIDATES")[1] ?? "";
    expect(candidateBlock).toContain("candidate_safe_top_candidate");
    expect(candidateBlock).not.toContain("candidate_hidden_delete_candidate");
    expect(computerTool.click).not.toHaveBeenCalled();
    expect(approveAction).not.toHaveBeenCalled();
    expect(steps[0].phase).toBe("failed");
    expect(steps[0].trace?.preflight).toEqual(expect.objectContaining({
      passed: false,
      reason: expect.stringContaining("candidate_hidden_delete_candidate"),
    }));
    expect(steps[0].trace?.localVision).toEqual(expect.objectContaining({
      detectionCount: 2,
      promptCandidateCount: 1,
      selectedCandidateId: "candidate_hidden_delete_candidate",
      actionRisk: "high",
      actionSucceeded: false,
    }));
  });

  it("does not run local vision during post-action verification observations", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Click the visual target",
      action: { tool: "computer.click", params: { x: 140, y: 215 } },
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
    vi.mocked(computerTool.screenshot)
      .mockResolvedValueOnce({
        dataUrl: "data:image/png;base64,BEFORE==",
        width: 800,
        height: 600,
        capturedAt: "2026-06-04T00:00:00.000Z",
        methodUsed: "bitblt",
      })
      .mockResolvedValueOnce({
        dataUrl: "data:image/png;base64,AFTER==",
        width: 800,
        height: 600,
        capturedAt: "2026-06-04T00:00:01.000Z",
        methodUsed: "bitblt",
      });
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: request.screenshotId,
      detections: [createLocalVisionDetection({
        id: "det_save",
        label: "saveButton",
        confidence: 0.9,
        x: 100,
        y: 200,
        width: 80,
        height: 30,
      })],
      latencyMs: 4,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
    }));
    vi.mocked(computerTool.click).mockResolvedValue({
      x: 140,
      y: 215,
      clicked: true,
    });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click the target",
      approveAction: vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" })),
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
        },
      },
    });

    expect(computerTool.detectUiObjects).toHaveBeenCalledTimes(1);
    expect(steps[0].trace?.localVision).toEqual(expect.objectContaining({
      selectedCandidateId: "candidate_det_save",
      promptCandidateCount: 1,
    }));
    expect(steps[0].trace?.verification).toEqual(expect.objectContaining({
      passed: true,
    }));
  });

  it("discards stale local vision results from older screenshots", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Goal achieved",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "done",
      confidence: "high",
      status: "complete",
    }));
    const computerTool = createComputerTool();
    computerTool.detectUiObjects = vi.fn(async (): Promise<ComputerDetectUiObjectsResult> => ({
      screenshotId: "old-shot",
      detections: [{
        id: "det_stale",
        label: "possible_button",
        confidence: 0.99,
        box: {
          x: 10,
          y: 20,
          width: 30,
          height: 40,
          coordinateSpace: "screenshot" as const,
        },
        center: {
          x: 25,
          y: 40,
          coordinateSpace: "screenshot" as const,
        },
        source: "yolo26" as const,
      }],
      latencyMs: 5,
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime" as const,
      timedOut: false,
      diagnostics: {
        layout: "row-major",
        rawPreview: "data:image/png;base64,STALE_DIAGNOSTIC_SHOULD_NOT_SURVIVE==",
      },
    }));

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
        },
      },
    });

    const prompt = vi.mocked(modelProvider.complete).mock.calls[0]?.[0] ?? "";
    expect(prompt).not.toContain("LOCAL_UI_CANDIDATES");
    expect(prompt).not.toContain("det_stale");
    expect(prompt).not.toContain("STALE_DIAGNOSTIC_SHOULD_NOT_SURVIVE");
    expect(steps[0].trace?.localVision).toEqual(expect.objectContaining({
      mode: "disabled",
      used: false,
      detectionCount: 0,
      promptCandidateCount: 0,
      diagnostics: expect.objectContaining({
        layout: "row-major",
        rawPreview: "[redacted image data]",
      }),
    }));
    expect(JSON.stringify(steps)).not.toContain("STALE_DIAGNOSTIC_SHOULD_NOT_SURVIVE");
    expect(steps[0].trace?.localVision?.error).toContain("discarded stale local vision result");
  });

  it("uses per-observation screenshot ids even when capturedAt and size repeat", async () => {
    const modelProvider = createSequenceModelProvider([
      JSON.stringify({
        observation: "Need another observation",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: "continue",
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
    vi.mocked(computerTool.screenshot).mockResolvedValue({
      dataUrl: "data:image/png;base64,SAME_SECOND==",
      width: 800,
      height: 600,
      capturedAt: "2026-06-04T00:00:00Z",
      methodUsed: "bitblt",
    });
    let firstScreenshotId = "";
    computerTool.detectUiObjects = vi.fn(async (request): Promise<ComputerDetectUiObjectsResult> => {
      if (!firstScreenshotId) {
        firstScreenshotId = request.screenshotId;
        return {
          screenshotId: request.screenshotId,
          detections: [],
          latencyMs: 3,
          model: "yolo26n-ui.onnx",
          runtime: "onnxruntime" as const,
          timedOut: false,
        };
      }
      return {
        screenshotId: firstScreenshotId,
        detections: [createLocalVisionDetection({
          id: "old_same_second",
          label: "button",
          confidence: 0.99,
          x: 10,
          y: 20,
          width: 30,
          height: 40,
        })],
        latencyMs: 3,
        model: "yolo26n-ui.onnx",
        runtime: "onnxruntime" as const,
        timedOut: false,
      };
    });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 2,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
        },
      },
    });

    expect(computerTool.detectUiObjects).toHaveBeenCalledTimes(2);
    const ids = vi.mocked(computerTool.detectUiObjects).mock.calls.map((call) => call[0].screenshotId);
    expect(ids[0]).not.toBe(ids[1]);
    expect(steps[1].trace?.localVision).toEqual(expect.objectContaining({
      mode: "disabled",
      used: false,
      detectionCount: 0,
      promptCandidateCount: 0,
    }));
    expect(steps[1].trace?.localVision?.error).toContain("discarded stale local vision result");
    const secondPrompt = vi.mocked(modelProvider.complete).mock.calls[1]?.[0] ?? "";
    expect(secondPrompt).not.toContain("old_same_second");
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
    computerTool.detectUiObjects = vi.fn();
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
    expect(modelProvider.complete).toHaveBeenCalledWith(
      expect.stringContaining("SCREENSHOT: unavailable"),
      expect.objectContaining({ skipAgentMemory: true, skipSkillContext: true }),
    );
    expect(computerTool.invokeUi).toHaveBeenCalledWith(expect.objectContaining({
      approvalId: "approval-1",
      taskId: "task-1",
    }));
  });

  it("records local vision as disabled instead of dropping trace when screenshot fails", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Goal achieved",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "done",
      confidence: "high",
      status: "complete",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.screenshot).mockRejectedValue(new Error("capture failed"));
    computerTool.detectUiObjects = vi.fn();
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

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect the desktop",
      config: {
        maxSteps: 1,
        localVision: {
          enabled: true,
          mode: "prompt_hint",
          modelPath: "models/yolo26n-ui.onnx",
        },
      },
    });

    expect(modelProvider.complete).toHaveBeenCalledWith(
      expect.stringContaining("SCREENSHOT: unavailable"),
      expect.objectContaining({ skipAgentMemory: true, skipSkillContext: true }),
    );
    expect(computerTool.detectUiObjects).not.toHaveBeenCalled();
    expect(steps[0].trace?.localVision).toEqual(expect.objectContaining({
      enabled: true,
      used: false,
      mode: "disabled",
      detectionCount: 0,
      promptCandidateCount: 0,
      fullScreenshotVlmCalled: false,
      fullScreenshotVlmSkipped: false,
      cropVlmCalled: false,
      error: "screenshot unavailable",
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

  it("detects screenshot-only verification changes beyond the shared data URL prefix", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Target is visible in the screenshot",
      action: { tool: "computer.click", params: { x: 100, y: 100 } },
      target: "Click target",
      confidence: "high",
    }));
    const computerTool = createComputerTool();
    const sharedPrefix = `data:image/png;base64,${"A".repeat(160)}`;
    vi.mocked(computerTool.screenshot)
      .mockResolvedValueOnce({
        dataUrl: `${sharedPrefix}BEFORE==`,
        width: 1920,
        height: 1080,
        capturedAt: "2026-06-04T00:00:00.000Z",
        methodUsed: "bitblt",
      })
      .mockResolvedValueOnce({
        dataUrl: `${sharedPrefix}AFTER==`,
        width: 1920,
        height: 1080,
        capturedAt: "2026-06-04T00:00:01.000Z",
        methodUsed: "bitblt",
      });
    vi.mocked(computerTool.listWindows).mockResolvedValue({ windows: [] });
    vi.mocked(computerTool.click).mockResolvedValue({ x: 100, y: 100, clicked: true });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Click target",
      approveAction: vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-1" })),
      config: { maxSteps: 1 },
    });

    expect(steps[0].error).toBeUndefined();
    expect(steps[0].trace?.verification).toEqual(expect.objectContaining({
      passed: true,
      reason: expect.stringContaining("observed state changed"),
    }));
    expect(JSON.stringify(steps)).not.toContain(sharedPrefix);
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

  it("records fully failed observations through the sanitized step path", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Should not be called",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "none",
      confidence: "low",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.screenshot).mockRejectedValue(new Error("capture failed data:image/png;base64,SCREEN=="));
    vi.mocked(computerTool.listWindows).mockRejectedValue(new Error("windows failed data:image/png;base64,WINDOWS=="));
    vi.mocked(computerTool.inspectUi).mockRejectedValue(new Error("uia failed data:image/png;base64,UIA=="));
    const recordedSteps: unknown[] = [];

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect desktop",
      onStep: (step) => recordedSteps.push(step),
      config: { maxSteps: 1 },
    });

    expect(modelProvider.complete).not.toHaveBeenCalled();
    expect(steps).toHaveLength(1);
    expect(steps[0].phase).toBe("failed");
    expect(steps[0].screenshotDataUrl).toBe("");
    expect(JSON.stringify(steps)).not.toContain("data:image");
    expect(JSON.stringify(recordedSteps)).not.toContain("data:image");
  });

  it("records synchronously thrown observation failures instead of rejecting the loop", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Should not be called",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "none",
      confidence: "low",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.screenshot).mockImplementation(() => {
      throw new Error("sync capture failed data:image/png;base64,SCREEN==");
    });
    vi.mocked(computerTool.listWindows).mockImplementation(() => {
      throw new Error("sync windows failed data:image/png;base64,WINDOWS==");
    });
    vi.mocked(computerTool.inspectUi).mockImplementation(() => {
      throw new Error("sync uia failed data:image/png;base64,UIA==");
    });

    const steps = await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect desktop",
      config: { maxSteps: 1 },
    });

    expect(modelProvider.complete).not.toHaveBeenCalled();
    expect(steps).toHaveLength(1);
    expect(steps[0].phase).toBe("failed");
    expect(steps[0].error).toContain("sync capture failed");
    expect(JSON.stringify(steps)).not.toContain("data:image");
  });

  it("redacts image data URLs from progress snapshots", async () => {
    const modelProvider = createModelProvider(JSON.stringify({
      observation: "Should not be called",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "none",
      confidence: "low",
    }));
    const computerTool = createComputerTool();
    vi.mocked(computerTool.screenshot).mockRejectedValue(new Error("capture failed data:image/png;base64,SCREEN=="));
    vi.mocked(computerTool.listWindows).mockRejectedValue(new Error("windows failed data:image/png;base64,WINDOWS=="));
    vi.mocked(computerTool.inspectUi).mockRejectedValue(new Error("uia failed data:image/png;base64,UIA=="));
    const progressSteps: unknown[] = [];

    await runComputerUseLoop({
      modelProvider,
      computerTool,
      userGoal: "Inspect desktop",
      onProgress: (step) => progressSteps.push(step),
      config: { maxSteps: 1, heartbeatMs: 0 },
    });

    expect(progressSteps.length).toBeGreaterThan(0);
    expect(JSON.stringify(progressSteps)).not.toContain("data:image");
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
        tree: "<Edit value=\"Alice\" automationId=\"nameInput\" name=\"Name\">",
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

  it("does not reuse a consumed per-action approval when retry approval is denied", async () => {
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
      .mockResolvedValueOnce({ x: 100, y: 100, clicked: false });
    const approveAction = vi.fn()
      .mockResolvedValueOnce({ approvalId: "approval-1", taskId: "task-1" })
      .mockResolvedValueOnce(undefined);

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

    expect(steps[0].phase).toBe("failed");
    expect(steps[0].error).toContain("requires confirmed_write approval");
    expect(approveAction).toHaveBeenCalledTimes(2);
    expect(computerTool.click).toHaveBeenCalledTimes(1);
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
