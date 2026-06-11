import { describe, it, expect } from "vitest";
import { parseModelAction, parseModelOutput } from "./computer-use-types";

describe("parseModelAction", () => {
  it("parses a valid click action", () => {
    const raw = JSON.stringify({
      observation: "I see a button at (100, 200)",
      action: { tool: "computer.click", params: { x: 100, y: 200 } },
      target: "Click the submit button",
      confidence: "high",
    });
    const result = parseModelAction(raw);
    expect(result).toEqual({ tool: "computer.click", params: { x: 100, y: 200 } });
  });

  it("parses a valid moveMouse action", () => {
    const raw = JSON.stringify({
      observation: "Moving to coordinates",
      action: { tool: "computer.moveMouse", params: { x: 500, y: 300, speed: "linear" } },
      target: "Move cursor to menu",
      confidence: "medium",
    });
    const result = parseModelAction(raw);
    expect(result).toEqual({ tool: "computer.moveMouse", params: { x: 500, y: 300, speed: "linear" } });
  });

  it("parses a valid type action", () => {
    const raw = JSON.stringify({
      observation: "Input field is focused",
      action: { tool: "computer.type", params: { text: "Hello World" } },
      target: "Type greeting",
      confidence: "high",
    });
    const result = parseModelAction(raw);
    expect(result).toEqual({ tool: "computer.type", params: { text: "Hello World" } });
  });

  it("parses a valid keyCombo action", () => {
    const raw = JSON.stringify({
      observation: "Ready to save",
      action: { tool: "computer.keyCombo", params: { keys: ["Ctrl", "S"] } },
      target: "Save file",
      confidence: "high",
    });
    const result = parseModelAction(raw);
    expect(result).toEqual({ tool: "computer.keyCombo", params: { keys: ["Ctrl", "S"] } });
  });

  it("parses a valid scroll action", () => {
    const raw = JSON.stringify({
      observation: "Need to scroll down",
      action: { tool: "computer.scroll", params: { x: 400, y: 300, delta: -3 } },
      target: "Scroll down to see more",
      confidence: "medium",
    });
    const result = parseModelAction(raw);
    expect(result).toEqual({ tool: "computer.scroll", params: { x: 400, y: 300, delta: -3 } });
  });

  it("parses a valid focusWindow action", () => {
    const raw = JSON.stringify({
      observation: "VS Code is behind other windows",
      action: { tool: "computer.focusWindow", params: { handle: 12345 } },
      target: "Bring VS Code to front",
      confidence: "high",
    });
    const result = parseModelAction(raw);
    expect(result).toEqual({ tool: "computer.focusWindow", params: { handle: 12345 } });
  });

  it("parses a valid listWindows action", () => {
    const raw = JSON.stringify({
      observation: "Need current window handles",
      action: { tool: "computer.listWindows", params: {} },
      target: "List windows",
      confidence: "medium",
    });
    const result = parseModelAction(raw);
    expect(result).toEqual({ tool: "computer.listWindows", params: {} });
  });

  it("parses a valid screenshot action", () => {
    const raw = JSON.stringify({
      observation: "Need to re-examine",
      action: { tool: "computer.screenshot", params: {} },
      target: "Take another look",
      confidence: "low",
    });
    const result = parseModelAction(raw);
    expect(result).toEqual({ tool: "computer.screenshot", params: {} });
  });

  it("parses a valid screenshot action with a crop region", () => {
    const raw = JSON.stringify({
      observation: "Need to inspect a likely target area",
      action: {
        tool: "computer.screenshot",
        params: {
          windowHandle: 42,
          region: { x: 100, y: 120, width: 320, height: 180 },
          method: "auto",
        },
      },
      target: "Take a cropped look at the candidate region",
      confidence: "medium",
    });
    const result = parseModelAction(raw);
    expect(result).toEqual({
      tool: "computer.screenshot",
      params: {
        windowHandle: 42,
        region: { x: 100, y: 120, width: 320, height: 180 },
        method: "auto",
      },
    });
  });

  it("throws on invalid screenshot crop region dimensions", () => {
    const raw = JSON.stringify({
      observation: "Need to inspect a likely target area",
      action: {
        tool: "computer.screenshot",
        params: {
          region: { x: 100, y: 120, width: 0, height: 180 },
        },
      },
      target: "Take a cropped look at the candidate region",
      confidence: "medium",
    });
    expect(() => parseModelAction(raw)).toThrow("Invalid region");
  });

  it("parses a valid wait action", () => {
    const raw = JSON.stringify({
      observation: "Waiting for animation",
      action: { tool: "computer.wait", params: { ms: 1000 } },
      target: "Wait for UI to settle",
      confidence: "medium",
    });
    const result = parseModelAction(raw);
    expect(result).toEqual({ tool: "computer.wait", params: { ms: 1000 } });
  });

  it("rejects negative wait durations before native dispatch", () => {
    const raw = JSON.stringify({
      observation: "Need to wait",
      action: { tool: "computer.wait", params: { ms: -1 } },
      target: "Wait for UI to settle",
      confidence: "medium",
    });

    expect(() => parseModelAction(raw)).toThrow("expected non-negative number");
  });

  it("normalizes common parameter aliases before validation", () => {
    const clickRaw = JSON.stringify({
      observation: "Target button found",
      action: { tool: "computer.click", params: { left: 100, top: 200 } },
      target: "Click the target",
      confidence: "high",
    });
    expect(parseModelAction(clickRaw)).toEqual({ tool: "computer.click", params: { x: 100, y: 200 } });

    const focusRaw = JSON.stringify({
      observation: "Target window found",
      action: { tool: "computer.focusWindow", params: { windowHandle: 12345 } },
      target: "Focus the target window",
      confidence: "high",
    });
    expect(parseModelAction(focusRaw)).toEqual({ tool: "computer.focusWindow", params: { handle: 12345 } });

    const waitRaw = JSON.stringify({
      observation: "Need to pause",
      action: { tool: "computer.wait", params: { durationMs: 250 } },
      target: "Wait briefly",
      confidence: "medium",
    });
    expect(parseModelAction(waitRaw)).toEqual({ tool: "computer.wait", params: { ms: 250 } });
  });

  it("parses UI Automation actions", () => {
    const inspectRaw = JSON.stringify({
      observation: "A target window is available",
      action: { tool: "computer.inspectUi", params: { hwnd: 12345, depth: 3 } },
      target: "Read UI controls",
      confidence: "medium",
    });
    expect(parseModelAction(inspectRaw)).toEqual({
      tool: "computer.inspectUi",
      params: { windowHandle: 12345, maxDepth: 3 },
    });

    const invokeRaw = JSON.stringify({
      observation: "A Save button exists in the UI tree",
      action: {
        tool: "computer.invokeUi",
        params: { selector: { windowHandle: 12345, automationId: "saveButton" } },
      },
      target: "Invoke Save",
      confidence: "high",
    });
    expect(parseModelAction(invokeRaw)).toEqual({
      tool: "computer.invokeUi",
      params: { selector: { windowHandle: 12345, automationId: "saveButton" } },
    });
  });

  it("returns null on completion signal", () => {
    const raw = JSON.stringify({
      observation: "Goal achieved",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "done",
      confidence: "high",
      status: "complete",
      summary: "Opened calculator and computed 2+2",
    });
    const result = parseModelAction(raw);
    expect(result).toBeNull();
  });

  it("rejects completion with a non-wait action", () => {
    const raw = JSON.stringify({
      observation: "Goal achieved",
      action: { tool: "computer.click", params: { x: 100, y: 200 } },
      target: "done",
      confidence: "high",
      status: "complete",
    });

    expect(() => parseModelAction(raw)).toThrow("Completion signal must use computer.wait with ms=0");
  });

  it("rejects low-confidence completion", () => {
    const raw = JSON.stringify({
      observation: "Probably done",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "done",
      confidence: "medium",
      status: "complete",
    });

    expect(() => parseModelAction(raw)).toThrow("Completion signal requires high confidence");
  });

  it("strips markdown code fences", () => {
    const raw = '```json\n{"observation":"test","action":{"tool":"computer.screenshot","params":{}},"target":"look","confidence":"low"}\n```';
    const result = parseModelAction(raw);
    expect(result).toEqual({ tool: "computer.screenshot", params: {} });
  });

  it("throws on invalid JSON", () => {
    expect(() => parseModelAction("not json")).toThrow();
  });

  it("throws on missing action field", () => {
    const raw = JSON.stringify({ observation: "test", target: "test", confidence: "high" });
    expect(() => parseModelAction(raw)).toThrow("missing action.tool");
  });

  it("throws on unknown tool name", () => {
    const raw = JSON.stringify({
      observation: "test",
      action: { tool: "computer.nonexistent", params: {} },
      target: "test",
      confidence: "high",
    });
    expect(() => parseModelAction(raw)).toThrow("not in allowed list");
  });

  it("throws on invalid click button", () => {
    const raw = JSON.stringify({
      observation: "test",
      action: { tool: "computer.click", params: { x: 100, y: 200, button: "primary" } },
      target: "test",
      confidence: "high",
    });
    expect(() => parseModelAction(raw)).toThrow("Invalid button");
  });

  it("throws on invalid move speed", () => {
    const raw = JSON.stringify({
      observation: "test",
      action: { tool: "computer.moveMouse", params: { x: 100, y: 200, speed: "fast" } },
      target: "test",
      confidence: "high",
    });
    expect(() => parseModelAction(raw)).toThrow("Invalid speed");
  });
});

describe("parseModelOutput", () => {
  it("parses valid JSON with all fields", () => {
    const raw = JSON.stringify({
      observation: "Desktop visible",
      action: { tool: "computer.click", params: { x: 100, y: 200 } },
      target: "Click button",
      confidence: "high",
    });
    const result = parseModelOutput(raw);
    expect(result.observation).toBe("Desktop visible");
    expect(result.target).toBe("Click button");
    expect(result.confidence).toBe("high");
  });

  it("strips markdown fences", () => {
    const raw = '```json\n{"observation":"test","action":{"tool":"computer.wait","params":{"ms":0}},"target":"done","confidence":"high"}\n```';
    const result = parseModelOutput(raw);
    expect(result.observation).toBe("test");
  });

  it("throws on invalid JSON", () => {
    expect(() => parseModelOutput("broken")).toThrow();
  });
});
