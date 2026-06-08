/**
 * Computer Use action loop — drives a vision model through iterative
 * screenshot-analyze-act cycles until the goal is achieved or maxSteps is reached.
 *
 * Design decisions:
 * - The model is stateless; history is passed as text summaries (not raw screenshots) to save tokens.
 * - Approval is NOT handled here — the runtime layer (app-runtime.ts) is responsible for that.
 * - Each step emits via onStep callback for real-time UI updates.
 * - On JSON parse failure, retry once with a "Output valid JSON only" suffix.
 * - On invalid tool name, skip that step and add a correction prompt for the next iteration.
 */

import type { ModelProvider } from "./model-provider";
import type {
  ComputerListWindowsResult,
  ComputerScreenshotResult,
  ComputerTool,
} from "@javis/tools";
import type {
  ComputerUseLoopConfig,
  ComputerUseStep,
  ComputerUseAction,
} from "@javis/core";
import {
  parseModelAction,
  parseModelOutput,
  COMPUTER_USE_SYSTEM_PROMPT,
  DEFAULT_COMPUTER_USE_CONFIG,
} from "@javis/core";

// ── Public API ──────────────────────────────────────────────────────────────

export interface ComputerUseLoopOptions {
  modelProvider: ModelProvider;
  computerTool: ComputerTool;
  userGoal: string;
  config?: Partial<ComputerUseLoopConfig>;
  /** Supplies a confirmed-write approval binding for each write action. */
  approveAction?: (action: ComputerUseAction) => Promise<{ approvalId: string; taskId?: string; sessionWide?: boolean }>;
  /** Called after each step is recorded, for real-time UI progress updates. */
  onStep?: (step: ComputerUseStep) => void;
}

/**
 * Run the Computer Use action loop.
 *
 * Takes screenshots, feeds them to a vision model, parses the model's action,
 * executes it via the ComputerTool, and repeats until the model signals
 * completion or maxSteps is reached.
 */
export async function runComputerUseLoop(
  options: ComputerUseLoopOptions,
): Promise<ComputerUseStep[]> {
  const { modelProvider, computerTool, userGoal, approveAction, onStep } = options;
  const config: ComputerUseLoopConfig = {
    ...DEFAULT_COMPUTER_USE_CONFIG,
    ...options.config,
  };

  const steps: ComputerUseStep[] = [];
  let correctionHint = "";
  let lastActionSignature = "";
  let repeatedActionCount = 0;
  const lockedScreenshotMethods = new Map<number, "bitblt" | "printWindow">();
  let nextScreenshot: ComputerScreenshotResult | undefined;
  let taskLease: { approvalId: string; taskId?: string } | undefined;
  let preferredUiWindowHandle: number | undefined;

  for (let i = 0; i < config.maxSteps; i++) {
    // 1. Take screenshot and refresh lightweight window context.
    const [screenshot, windowList] = await Promise.all([
      nextScreenshot ? Promise.resolve(nextScreenshot) : computerTool.screenshot({}),
      getWindowList(computerTool),
    ]);
    const uiContext = await getUiContext(computerTool, windowList, preferredUiWindowHandle);
    nextScreenshot = undefined;

    // 2. Build prompt
    const prompt = buildPrompt(userGoal, steps, config.historySteps, correctionHint, {
        width: screenshot.width,
        height: screenshot.height,
        sourceWidth: screenshot.sourceWidth,
        sourceHeight: screenshot.sourceHeight,
        windowList,
        uiContext,
      });
    correctionHint = "";

    // 3. Call vision model — with context overflow recovery
    let rawResponse: { text: string };
    try {
      rawResponse = await modelProvider.complete(prompt, {
        imageDataUrl: screenshot.dataUrl,
      });
    } catch (err) {
      const errMsg = String(err);
      // Detect context overflow from model API errors (e.g. DeepSeek "maximum context length").
      if (isContextOverflowError(errMsg) && config.historySteps > 0) {
        // Retry once with a minimal prompt — drop all step history.
        const minimalPrompt = buildPrompt(userGoal, [], 0, "", {
          width: screenshot.width,
          height: screenshot.height,
          sourceWidth: screenshot.sourceWidth,
          sourceHeight: screenshot.sourceHeight,
          windowList,
          uiContext,
        });
        try {
          rawResponse = await modelProvider.complete(minimalPrompt, { imageDataUrl: screenshot.dataUrl });
        } catch (retryErr) {
          const overflowStep: ComputerUseStep = {
            stepIndex: i,
            screenshotDataUrl: screenshot.dataUrl,
            observation: "模型上下文已超出限制，无法继续。",
            action: { tool: "computer.wait", params: { ms: 0 } },
            target: "上下文溢出",
            confidence: "low",
            error: `上下文溢出（${errMsg.slice(0, 120)}）`,
          };
          steps.push(overflowStep);
          onStep?.(overflowStep);
          break;
        }
      } else {
        throw err;
      }
    }

    // 4. Parse response — retry once on JSON parse failure
    let action: ComputerUseAction | null;
    try {
      action = parseModelAction(rawResponse.text);
    } catch {
      // Retry with explicit JSON instruction
      try {
        const retryPrompt = prompt + "\n\nYour previous output was not valid JSON. Output valid JSON only — no markdown fences, no commentary.";
        const retryResponse = await modelProvider.complete(retryPrompt, {
          imageDataUrl: screenshot.dataUrl,
        });
        action = parseModelAction(retryResponse.text);
      } catch {
        // Second failure — record error step and continue
        const errorStep: ComputerUseStep = {
          stepIndex: i,
          screenshotDataUrl: screenshot.dataUrl,
          observation: "模型没有返回可执行的 JSON 指令。",
          action: { tool: "computer.wait", params: { ms: 500 } },
          target: "跳过本次无法解析的输出",
          confidence: "low",
          error: "模型输出连续解析失败",
        };
        steps.push(errorStep);
        onStep?.(errorStep);
        correctionHint = "Your last output was invalid JSON. Output only valid JSON matching the schema.";
        continue;
      }
    }

    // 5. Completion signal
    if (action === null) {
      const rawOutput = tryParseOutput(rawResponse.text);
      const completionStep: ComputerUseStep = {
        stepIndex: i,
        screenshotDataUrl: screenshot.dataUrl,
        observation: rawOutput?.observation ?? "目标已完成",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: rawOutput?.target ?? "完成",
        confidence: "high",
      };
      steps.push(completionStep);
      onStep?.(completionStep);
      break;
    }

    // 6. Execute the action
    const rawOutput = tryParseOutput(rawResponse.text);
    let result: unknown;
    let error: string | undefined;
    const requestedAction = lockScreenshotMethod(action, lockedScreenshotMethods);
    const executedAction = mapActionFromScreenshotCoordinates(requestedAction, screenshot);

    if (isWriteAction(executedAction) && !approveAction) {
      const missingApprovalStep: ComputerUseStep = {
        stepIndex: i,
        screenshotDataUrl: screenshot.dataUrl,
        observation: rawOutput?.observation ?? "",
        action: executedAction,
        target: rawOutput?.target ?? "",
        confidence: rawOutput?.confidence ?? "low",
        error: `${action.tool} 需要 confirmed_write 审批，但当前循环没有提供审批处理器。`,
      };
      steps.push(missingApprovalStep);
      onStep?.(missingApprovalStep);
      break;
    }

    const actionSignature = createActionSignature(executedAction);
    if (actionSignature === lastActionSignature) {
      repeatedActionCount += 1;
    } else {
      lastActionSignature = actionSignature;
      repeatedActionCount = 1;
    }

    if (repeatedActionCount >= 3) {
      const repeatStep: ComputerUseStep = {
        stepIndex: i,
        screenshotDataUrl: screenshot.dataUrl,
        observation: rawOutput?.observation ?? "",
        action: executedAction,
        target: rawOutput?.target ?? "",
        confidence: rawOutput?.confidence ?? "low",
        error: `连续 ${repeatedActionCount} 次重复执行 ${action.tool}，已停止以避免循环。`,
      };
      steps.push(repeatStep);
      onStep?.(repeatStep);
      break;
    }

    try {
      let approval: { approvalId: string; taskId?: string } | undefined;
      if (isWriteAction(executedAction)) {
        if (taskLease && !requiresFreshApproval(executedAction)) {
          approval = taskLease;
        } else {
          const result = await approveAction?.(executedAction);
          if (result) {
            approval = { approvalId: result.approvalId, taskId: result.taskId };
            if (result.sessionWide && !requiresFreshApproval(executedAction)) {
              taskLease = approval;
            }
          }
        }
      }
      result = await dispatchAction(computerTool, executedAction, approval);
      if (requestedAction.tool === "computer.screenshot") {
        if (requestedAction.params.windowHandle !== undefined) {
          preferredUiWindowHandle = requestedAction.params.windowHandle;
        }
        rememberScreenshotMethod(requestedAction, result, lockedScreenshotMethods);
        if (isScreenshotResult(result)) {
          nextScreenshot = result;
        }
      }
      preferredUiWindowHandle = getPreferredUiHandleAfterAction(executedAction) ?? preferredUiWindowHandle;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    // 7. Record the step
    const step: ComputerUseStep = {
      stepIndex: i,
      screenshotDataUrl: screenshot.dataUrl,
      observation: rawOutput?.observation ?? "",
      action: executedAction,
      target: rawOutput?.target ?? "",
      confidence: rawOutput?.confidence ?? "medium",
      result,
      error,
    };
    steps.push(step);
    onStep?.(step);

    // Add correction hint so the model can adapt instead of repeating the failure.
    if (error) {
      if (/denied by user|permission denied/i.test(error)) {
        break;
      }
      correctionHint = `Your last action (${action.tool}) failed: ${error}. Try a different approach or a different target.`;
    }
  }

  return steps;
}

// ── Step history formatting ──────────────────────────────────────────────────

/**
 * Format recent steps into a text summary for model context.
 * Only includes the last `maxSteps` entries, omitting raw screenshot data.
 */
export function formatStepHistory(steps: ComputerUseStep[], maxSteps: number): string {
  if (steps.length === 0) return "";

  const recent = steps.slice(-maxSteps);
  const lines = recent.map((step) => {
    const toolName = step.action.tool;
    const params = JSON.stringify(step.action.params);
    const resultStr = step.error
      ? `ERROR: ${step.error}`
      : step.result !== undefined
        ? `result: ${JSON.stringify(step.result)}`
        : "";
    return `Step ${step.stepIndex + 1}: saw "${step.observation}" → ${toolName}(${params}) ${resultStr}`.trim();
  });

  return `PREVIOUS STEPS (most recent ${recent.length}):\n${lines.join("\n")}`;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Build the full prompt string for the vision model.
 * Combines system prompt, goal, history, and any correction hints.
 */
function buildPrompt(
  userGoal: string,
  steps: ComputerUseStep[],
  historySteps: number,
  correctionHint: string,
  screenshot: {
    width: number;
    height: number;
    sourceWidth?: number;
    sourceHeight?: number;
    windowList?: ComputerListWindowsResult;
    uiContext?: UiPromptContext;
  },
): string {
  const parts: string[] = [
    COMPUTER_USE_SYSTEM_PROMPT.en,
    `USER GOAL: ${userGoal}`,
    `SCREENSHOT: ${screenshot.width}x${screenshot.height}. Coordinates start at (0,0) in the top-left corner; x increases right, y increases down.`,
  ];
  if (
    screenshot.sourceWidth &&
    screenshot.sourceHeight &&
    (screenshot.sourceWidth !== screenshot.width || screenshot.sourceHeight !== screenshot.height)
  ) {
    parts.push(
      `The screenshot image was resized from ${screenshot.sourceWidth}x${screenshot.sourceHeight}; still output coordinates in the visible ${screenshot.width}x${screenshot.height} screenshot image. Javis will map them to real screen coordinates before execution.`,
    );
  }
  const windowContext = formatWindowList(screenshot.windowList);
  if (windowContext) {
    parts.push(windowContext);
  }
  const uiPromptContext = formatUiContext(screenshot.uiContext);
  if (uiPromptContext) {
    parts.push(uiPromptContext);
  }

  const history = formatStepHistory(steps, historySteps);
  if (history) {
    parts.push(history);
  }

  if (correctionHint) {
    parts.push(`IMPORTANT: ${correctionHint}`);
  }

  parts.push(
    "Analyze the screenshot and output the single next action as JSON.",
  );

  return parts.join("\n\n");
}

async function getWindowList(computerTool: ComputerTool): Promise<ComputerListWindowsResult | undefined> {
  try {
    return await computerTool.listWindows({});
  } catch {
    return undefined;
  }
}

interface UiPromptContext {
  windowHandle: number;
  title?: string;
  tree: string;
  nodeCount: number;
}

async function getUiContext(
  computerTool: ComputerTool,
  windowList: ComputerListWindowsResult | undefined,
  preferredHandle: number | undefined,
): Promise<UiPromptContext | undefined> {
  const window = selectUiWindow(windowList, preferredHandle);
  if (!window) return undefined;
  try {
    const result = await computerTool.inspectUi({
      windowHandle: window.handle,
      maxDepth: 4,
      maxNodes: 120,
    });
    if (!result.tree.trim()) return undefined;
    return {
      windowHandle: window.handle,
      title: window.title,
      tree: result.tree,
      nodeCount: result.nodeCount,
    };
  } catch {
    return undefined;
  }
}

function selectUiWindow(
  windowList: ComputerListWindowsResult | undefined,
  preferredHandle: number | undefined,
): ComputerListWindowsResult["windows"][number] | undefined {
  const visibleWindows = windowList?.windows.filter((window) =>
    window.isVisible &&
    window.title.trim().length > 0
  ) ?? [];
  if (visibleWindows.length === 0) return undefined;
  return visibleWindows.find((window) => window.handle === preferredHandle) ??
    visibleWindows.find((window) => window.isForeground) ??
    visibleWindows[0];
}

function formatUiContext(context: UiPromptContext | undefined): string {
  if (!context) return "";
  const tree = context.tree.length > 6000
    ? `${context.tree.slice(0, 6000)}\n...`
    : context.tree;
  return [
    `UIA CONTEXT (fresh inspectUi for handle=${context.windowHandle}${context.title ? `, title="${context.title}"` : ""}; ${context.nodeCount} nodes):`,
    tree,
    "Prefer invokeUi/setUiValue with automationId or name from this tree before coordinate clicks.",
  ].join("\n");
}

function formatWindowList(windowList: ComputerListWindowsResult | undefined): string {
  if (!windowList?.windows?.length) return "";
  const windows = windowList.windows
    .filter((window) => window.isVisible && window.title.trim().length > 0)
    .slice(0, 12)
    .map((window) => {
      const foreground = window.isForeground ? " foreground" : "";
      return `- handle=${window.handle}${foreground}; title="${window.title}"; rect=${window.rect.x},${window.rect.y},${window.rect.width}x${window.rect.height}`;
    });
  if (windows.length === 0) return "";
  return `WINDOWS (fresh list; prefer these handles for inspectUi/focusWindow):\n${windows.join("\n")}`;
}

/**
 * Attempt to parse raw model output into a ComputerUseModelOutput.
 * Returns undefined on failure (non-fatal — used only for metadata extraction).
 */
function tryParseOutput(raw: string) {
  try {
    return parseModelOutput(raw);
  } catch {
    return undefined;
  }
}

/**
 * Dispatch a parsed ComputerUseAction to the appropriate ComputerTool method.
 * Approval is NOT handled here — the runtime layer is responsible.
 */
async function dispatchAction(
  computerTool: ComputerTool,
  action: ComputerUseAction,
  approval?: { approvalId: string; taskId?: string },
): Promise<unknown> {
  switch (action.tool) {
    case "computer.screenshot":
      return computerTool.screenshot(action.params);

    case "computer.inspectUi":
      return computerTool.inspectUi(action.params);

    case "computer.listWindows":
      return computerTool.listWindows({});

    case "computer.wait":
      return computerTool.wait(action.params);

    case "computer.moveMouse":
      return computerTool.moveMouse({ ...action.params, ...requireApproval(action, approval) });

    case "computer.click":
      return computerTool.click({ ...action.params, ...requireApproval(action, approval) });

    case "computer.type":
      return computerTool.type({ ...action.params, ...requireApproval(action, approval) });

    case "computer.keyCombo":
      return computerTool.keyCombo({ ...action.params, ...requireApproval(action, approval) });

    case "computer.scroll":
      return computerTool.scroll({ ...action.params, ...requireApproval(action, approval) });

    case "computer.focusWindow":
      return computerTool.focusWindow({ ...action.params, ...requireApproval(action, approval) });

    case "computer.invokeUi":
      return computerTool.invokeUi({ ...action.params, ...requireApproval(action, approval) });

    case "computer.setUiValue":
      return computerTool.setUiValue({ ...action.params, ...requireApproval(action, approval) });

    default:
      return assertNever(action);
  }
}

const WRITE_ACTIONS = new Set([
  "computer.moveMouse",
  "computer.click",
  "computer.type",
  "computer.keyCombo",
  "computer.scroll",
  "computer.focusWindow",
  "computer.invokeUi",
  "computer.setUiValue",
]);

function isWriteAction(action: ComputerUseAction): boolean {
  return WRITE_ACTIONS.has(action.tool);
}

function requiresFreshApproval(action: ComputerUseAction): boolean {
  return action.tool === "computer.type" ||
    action.tool === "computer.keyCombo" ||
    action.tool === "computer.setUiValue" ||
    action.tool === "computer.invokeUi" && selectorLooksSensitive(action.params.selector);
}

function selectorLooksSensitive(selector: unknown): boolean {
  if (!selector || typeof selector !== "object") return false;
  const record = selector as Record<string, unknown>;
  return [record.name, record.automationId]
    .filter((value): value is string => typeof value === "string")
    .some((value) => /password|token|secret|credential|密码|令牌|密钥/i.test(value));
}

function requireApproval(
  action: ComputerUseAction,
  approval: { approvalId: string; taskId?: string } | undefined,
): { approvalId: string; taskId?: string } {
  if (!approval?.approvalId) {
    throw new Error(`${action.tool} requires confirmed_write approval`);
  }
  return approval;
}

function lockScreenshotMethod(
  action: ComputerUseAction,
  lockedMethods: Map<number, "bitblt" | "printWindow">,
): ComputerUseAction {
  if (action.tool !== "computer.screenshot" || action.params.windowHandle === undefined) {
    return action;
  }
  const lockedMethod = lockedMethods.get(action.params.windowHandle);
  if (!lockedMethod || action.params.method === "bitblt" || action.params.method === "printWindow") {
    return action;
  }
  return {
    ...action,
    params: {
      ...action.params,
      method: lockedMethod,
    },
  };
}

function rememberScreenshotMethod(
  action: ComputerUseAction,
  result: unknown,
  lockedMethods: Map<number, "bitblt" | "printWindow">,
): void {
  if (action.tool !== "computer.screenshot" || action.params.windowHandle === undefined) {
    return;
  }
  if (!result || typeof result !== "object" || !("methodUsed" in result)) {
    return;
  }
  const methodUsed = (result as { methodUsed?: unknown }).methodUsed;
  if (methodUsed === "bitblt" || methodUsed === "printWindow") {
    lockedMethods.set(action.params.windowHandle, methodUsed);
  }
}

function getPreferredUiHandleAfterAction(action: ComputerUseAction): number | undefined {
  switch (action.tool) {
    case "computer.focusWindow":
      return action.params.handle;
    case "computer.inspectUi":
      return action.params.windowHandle;
    case "computer.invokeUi":
    case "computer.setUiValue":
      return action.params.selector.windowHandle;
    case "computer.screenshot":
      return action.params.windowHandle;
    default:
      return undefined;
  }
}

function mapActionFromScreenshotCoordinates(
  action: ComputerUseAction,
  screenshot: ComputerScreenshotResult,
): ComputerUseAction {
  if (!isCoordinateAction(action)) {
    return action;
  }
  const mapped = mapPointFromScreenshotCoordinates(action.params.x, action.params.y, screenshot);
  return {
    ...action,
    params: {
      ...action.params,
      x: mapped.x,
      y: mapped.y,
    },
  } as ComputerUseAction;
}

function isCoordinateAction(
  action: ComputerUseAction,
): action is Extract<ComputerUseAction, { params: { x: number; y: number } }> {
  return action.tool === "computer.moveMouse" ||
    action.tool === "computer.click" ||
    action.tool === "computer.scroll";
}

function mapPointFromScreenshotCoordinates(
  x: number,
  y: number,
  screenshot: ComputerScreenshotResult,
): { x: number; y: number } {
  const scaleX = positiveNumberOrDefault(screenshot.scaleX, 1);
  const scaleY = positiveNumberOrDefault(screenshot.scaleY, 1);
  const originX = finiteNumberOrDefault(screenshot.sourceOriginX, 0);
  const originY = finiteNumberOrDefault(screenshot.sourceOriginY, 0);
  return {
    x: Math.round(originX + x / scaleX),
    y: Math.round(originY + y / scaleY),
  };
}

function positiveNumberOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function finiteNumberOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isScreenshotResult(value: unknown): value is ComputerScreenshotResult {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { dataUrl?: unknown }).dataUrl === "string" &&
    typeof (value as { width?: unknown }).width === "number" &&
    typeof (value as { height?: unknown }).height === "number",
  );
}

function assertNever(action: never): never {
  throw new Error(`Unknown computer action: ${JSON.stringify(action)}`);
}

function createActionSignature(action: ComputerUseAction): string {
  return `${action.tool}:${stableStringify(action.params)}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Detect context overflow from model API error messages. */
function isContextOverflowError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("maximum context length") ||
    lower.includes("context length") ||
    lower.includes("too many tokens") ||
    lower.includes("prompt is too long") ||
    lower.includes("reduce the length")
  );
}
