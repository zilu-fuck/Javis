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
  /** Supplies a confirmed-write approval binding for write actions. */
  approveAction?: (action: ComputerUseAction) => Promise<{ approvalId: string; taskId?: string }>;
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

  for (let i = 0; i < config.maxSteps; i++) {
    // 1. Take screenshot
    const screenshot = await computerTool.screenshot({});

    // 2. Build prompt
    const prompt = buildPrompt(userGoal, steps, config.historySteps, correctionHint);
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
          observation: "Model output could not be parsed as valid JSON.",
          action: { tool: "computer.wait", params: { ms: 500 } },
          target: "skip unparsable step",
          confidence: "low",
          error: "JSON parse failed after retry",
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
        observation: rawOutput?.observation ?? "Goal achieved",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: rawOutput?.target ?? "done",
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

    try {
      const approval = isWriteAction(action) ? await approveAction?.(action) : undefined;
      result = await dispatchAction(computerTool, action, approval);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    // 7. Record the step
    const step: ComputerUseStep = {
      stepIndex: i,
      screenshotDataUrl: screenshot.dataUrl,
      observation: rawOutput?.observation ?? "",
      action,
      target: rawOutput?.target ?? "",
      confidence: rawOutput?.confidence ?? "medium",
      result,
      error,
    };
    steps.push(step);
    onStep?.(step);

    // Add correction hint so the model can adapt instead of repeating the failure.
    if (error) {
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
): string {
  const parts: string[] = [
    COMPUTER_USE_SYSTEM_PROMPT.en,
    `USER GOAL: ${userGoal}`,
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
      return computerTool.screenshot({});

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

    default:
      throw new Error(`Unknown computer action: ${(action as { tool: string }).tool}`);
  }
}

const WRITE_ACTIONS = new Set([
  "computer.moveMouse",
  "computer.click",
  "computer.type",
  "computer.keyCombo",
  "computer.scroll",
  "computer.focusWindow",
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
