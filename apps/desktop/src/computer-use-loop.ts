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
import type { ComputerTool } from "@javis/tools";
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
  /** Supplies a confirmed-write approval binding for write actions.
   *  Called for each write action unless sessionApproval is set.
   *  When sessionWide is true in the result, subsequent actions skip approval. */
  approveAction?: (action: ComputerUseAction) => Promise<{ approvalId: string; taskId?: string; sessionWide?: boolean }>;
  /** Pre-approved session token. When set, all write actions skip approveAction
   *  and reuse this binding. The first action must have been approved before
   *  starting the loop via a session-wide approve call. */
  sessionApproval?: { approvalId: string; taskId?: string };
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
  let sessionApproval = options.sessionApproval;
  const lockedScreenshotMethods = new Map<number, "bitblt" | "printWindow">();

  for (let i = 0; i < config.maxSteps; i++) {
    // 1. Take screenshot
    const screenshot = await computerTool.screenshot({});

    // 2. Build prompt
    const prompt = buildPrompt(userGoal, steps, config.historySteps, correctionHint, {
      width: screenshot.width,
      height: screenshot.height,
    });
    correctionHint = "";

    // 3. Call vision model
    const rawResponse = await modelProvider.complete(prompt, {
      imageDataUrl: screenshot.dataUrl,
    });

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
    const executedAction = lockScreenshotMethod(action, lockedScreenshotMethods);

    if (isWriteAction(executedAction) && !approveAction && !sessionApproval) {
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
        if (sessionApproval) {
          approval = sessionApproval;
        } else {
          const result = await approveAction?.(executedAction);
          if (result) {
            approval = { approvalId: result.approvalId, taskId: result.taskId };
            if (result.sessionWide) {
              sessionApproval = approval;
            }
          }
        }
      }
      result = await dispatchAction(computerTool, executedAction, approval);
      rememberScreenshotMethod(executedAction, result, lockedScreenshotMethods);
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
  screenshot: { width: number; height: number },
): string {
  const parts: string[] = [
    COMPUTER_USE_SYSTEM_PROMPT.en,
    `USER GOAL: ${userGoal}`,
    `SCREENSHOT: ${screenshot.width}x${screenshot.height}. Coordinates start at (0,0) in the top-left corner; x increases right, y increases down.`,
  ];

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
