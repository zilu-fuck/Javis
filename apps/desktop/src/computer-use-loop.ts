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
  ComputerUsePhase,
  ComputerUseStepTrace,
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
  config?: Partial<Omit<ComputerUseLoopConfig, "timeouts">> & {
    timeouts?: Partial<ComputerUseLoopConfig["timeouts"]>;
  };
  /** Supplies a confirmed-write approval binding for each write action. */
  approveAction?: (action: ComputerUseAction) => Promise<{ approvalId: string; taskId?: string; sessionWide?: boolean }>;
  /** Called after each step is recorded, for real-time UI progress updates. */
  onStep?: (step: ComputerUseStep) => void;
  /** Called during long-running steps so the UI can stay visibly alive. */
  onProgress?: (step: ComputerUseStep) => void;
  signal?: AbortSignal;
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
  const { modelProvider, computerTool, userGoal, approveAction, onStep, onProgress, signal } = options;
  const config: ComputerUseLoopConfig = {
    ...DEFAULT_COMPUTER_USE_CONFIG,
    ...options.config,
    timeouts: {
      ...DEFAULT_COMPUTER_USE_CONFIG.timeouts,
      ...options.config?.timeouts,
    },
  };

  const steps: ComputerUseStep[] = [];
  let correctionHint = "";
  let lastActionSignature = "";
  let repeatedActionCount = 0;
  const lockedScreenshotMethods = new Map<number, "bitblt" | "printWindow">();
  let nextScreenshot: ComputerScreenshotResult | undefined;
  let taskLease: { approvalId: string; taskId?: string } | undefined;
  let preferredUiWindowHandle: number | undefined;
  const uiCache = new Map<number, { context: UiPromptContext; expiresAt: number }>();

  for (let i = 0; i < config.maxSteps; i++) {
    throwIfAborted(signal);
    const stepStartedAt = Date.now();
    const stepController = createStepAbortController(signal, config.stepDeadlineMs);
    const trace: ComputerUseStepTrace = { startedAt: new Date(stepStartedAt).toISOString() };
    const emitProgress = createProgressEmitter({
      stepIndex: i,
      onProgress,
      config,
      getTrace: () => trace,
    });

    // 1. Take screenshot and refresh lightweight window context.
    emitProgress("observing", "Reading desktop state");
    const observation = await observeComputerState({
      computerTool,
      nextScreenshot,
      preferredUiWindowHandle,
      uiCache,
      config,
      signal: stepController.signal,
    });
    nextScreenshot = undefined;
    if (!observation.screenshot && !observation.windowList && !observation.uiContext) {
      const errorStep = createErrorStep(i, "observing", observation.error ?? "Computer Use observation failed.", trace, stepStartedAt);
      steps.push(errorStep);
      onStep?.(errorStep);
      stepController.dispose();
      break;
    }
    const { screenshot, windowList, uiContext } = observation;
    trace.freshAt = observation.freshAt;
    if (screenshot) trace.screenshot = summarizeScreenshotTrace(screenshot);
    if (windowList) trace.windows = summarizeWindowListTrace(windowList, observation.freshAt);
    if (uiContext) trace.ui = {
      freshAt: uiContext.freshAt,
      windowHandle: uiContext.windowHandle,
      title: uiContext.title,
      nodeCount: uiContext.nodeCount,
      cacheHit: uiContext.cacheHit,
    };
    const recordStep = (step: ComputerUseStep): void => {
      steps.push(step);
      onStep?.(step);
      stepController.dispose();
    };

    // 2. Build prompt
    emitProgress("planning", "Preparing desktop action prompt");
    const prompt = buildPrompt(userGoal, steps, config.historySteps, correctionHint, {
        width: screenshot?.width,
        height: screenshot?.height,
        sourceWidth: screenshot?.sourceWidth,
        sourceHeight: screenshot?.sourceHeight,
        screenshotUnavailableReason: screenshot ? undefined : observation.error ?? "screenshot unavailable",
        windowList,
        uiContext,
      });
    correctionHint = "";

    // 3. Call vision model — with context overflow recovery
    let rawResponse: { text: string };
    try {
      emitProgress("waiting_model", "Waiting for model action");
      rawResponse = await withHeartbeat(
        () => withTimeout(
          modelProvider.complete(prompt, screenshot ? { imageDataUrl: screenshot.dataUrl } : undefined),
          config.timeouts.modelMs,
          "Computer Use model call",
          stepController.signal,
        ),
        () => emitProgress("waiting_model", "Still waiting for model action"),
        config.heartbeatMs,
      );
    } catch (err) {
      const errMsg = String(err);
      // Detect context overflow from model API errors (e.g. DeepSeek "maximum context length").
      if (isContextOverflowError(errMsg) && config.historySteps > 0) {
        // Retry once with a minimal prompt — drop all step history.
        const minimalPrompt = buildPrompt(userGoal, [], 0, "", {
          width: screenshot?.width,
          height: screenshot?.height,
          sourceWidth: screenshot?.sourceWidth,
          sourceHeight: screenshot?.sourceHeight,
          screenshotUnavailableReason: screenshot ? undefined : observation.error ?? "screenshot unavailable",
          windowList,
          uiContext,
        });
        try {
          rawResponse = await withHeartbeat(
            () => withTimeout(
              modelProvider.complete(minimalPrompt, screenshot ? { imageDataUrl: screenshot.dataUrl } : undefined),
              config.timeouts.modelMs,
              "Computer Use model retry",
              stepController.signal,
            ),
            () => emitProgress("waiting_model", "Still waiting for model retry"),
            config.heartbeatMs,
          );
        } catch (retryErr) {
          const overflowStep: ComputerUseStep = {
            stepIndex: i,
            screenshotDataUrl: screenshot?.dataUrl ?? "",
            observation: "模型上下文已超出限制，无法继续。",
            action: { tool: "computer.wait", params: { ms: 0 } },
            target: "上下文溢出",
            confidence: "low",
            phase: "failed",
            trace: finishTrace(trace, stepStartedAt),
            error: `上下文溢出（${errMsg.slice(0, 120)}）`,
          };
          recordStep(overflowStep);
          break;
        }
      } else {
        const modelErrorStep = createErrorStep(i, "waiting_model", err instanceof Error ? err.message : String(err), trace, stepStartedAt);
        recordStep(modelErrorStep);
        break;
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
        const retryResponse = await withHeartbeat(
          () => withTimeout(
            modelProvider.complete(retryPrompt, screenshot ? { imageDataUrl: screenshot.dataUrl } : undefined),
            config.timeouts.modelMs,
            "Computer Use JSON retry",
            stepController.signal,
          ),
          () => emitProgress("waiting_model", "Still waiting for JSON retry"),
          config.heartbeatMs,
        );
        action = parseModelAction(retryResponse.text);
      } catch {
        // Second failure — record error step and continue
          const errorStep: ComputerUseStep = {
            stepIndex: i,
          screenshotDataUrl: screenshot?.dataUrl ?? "",
          observation: "模型没有返回可执行的 JSON 指令。",
          action: { tool: "computer.wait", params: { ms: 500 } },
          target: "跳过本次无法解析的输出",
          confidence: "low",
          phase: "failed",
          trace: finishTrace(trace, stepStartedAt),
          error: "模型输出连续解析失败",
        };
        recordStep(errorStep);
        correctionHint = "Your last output was invalid JSON. Output only valid JSON matching the schema.";
        continue;
      }
    }

    // 5. Completion signal
    if (action === null) {
      const rawOutput = tryParseOutput(rawResponse.text);
      const completionStep: ComputerUseStep = {
        stepIndex: i,
        screenshotDataUrl: screenshot?.dataUrl ?? "",
        observation: rawOutput?.observation ?? "目标已完成",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: rawOutput?.target ?? "完成",
        confidence: "high",
        phase: "completed",
        trace: finishTrace(trace, stepStartedAt),
      };
      recordStep(completionStep);
      break;
    }

    // 6. Execute the action
    const rawOutput = tryParseOutput(rawResponse.text);
    let result: unknown;
    let error: string | undefined;
    const requestedAction = lockScreenshotMethod(removeVerificationOnlyParams(action), lockedScreenshotMethods);
    const mappedAction = screenshot
      ? mapActionFromScreenshotCoordinates(requestedAction, screenshot)
      : requestedAction;
    const strategyResult = preferStructuredAction(mappedAction, observation, rawOutput);
    const executedAction = strategyResult.action;
    trace.action = {
      tool: executedAction.tool,
      approvalMode: "none",
      originalTool: action.tool === executedAction.tool ? undefined : action.tool,
      strategy: strategyResult.strategy,
      strategyReason: strategyResult.reason,
    };

    if (isWriteAction(executedAction) && !approveAction) {
      const missingApprovalStep: ComputerUseStep = {
        stepIndex: i,
        screenshotDataUrl: screenshot?.dataUrl ?? "",
        observation: rawOutput?.observation ?? "",
        action: executedAction,
        target: rawOutput?.target ?? "",
        confidence: rawOutput?.confidence ?? "low",
        phase: "failed",
        trace: finishTrace(trace, stepStartedAt),
        error: `${action.tool} 需要 confirmed_write 审批，但当前循环没有提供审批处理器。`,
      };
      recordStep(missingApprovalStep);
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
        screenshotDataUrl: screenshot?.dataUrl ?? "",
        observation: rawOutput?.observation ?? "",
        action: executedAction,
        target: rawOutput?.target ?? "",
        confidence: rawOutput?.confidence ?? "low",
        phase: "failed",
        trace: finishTrace(trace, stepStartedAt),
        error: `连续 ${repeatedActionCount} 次重复执行 ${action.tool}，已停止以避免循环。`,
      };
      recordStep(repeatStep);
      break;
    }

    try {
      let approval: { approvalId: string; taskId?: string } | undefined;
      if (isWriteAction(executedAction)) {
        emitProgress("preflight", "Checking desktop state before action");
        const preflight = await runPreflightCheck(executedAction, observation, {
          refreshUiContext: (windowHandle) => getUiContext({
            computerTool,
            windowList: observation.windowList,
            preferredHandle: windowHandle,
            uiCache,
            config,
            signal: stepController.signal,
            freshAt: new Date().toISOString(),
            bypassCache: true,
          }),
        });
        trace.preflight = preflight;
        if (!preflight.passed) {
          throw new Error(`Preflight failed: ${preflight.reason}`);
        }
        if (taskLease && !requiresFreshApproval(executedAction)) {
          trace.action.approvalMode = "task_lease";
          approval = taskLease;
        } else {
          trace.action.approvalMode = "per_action";
          emitProgress("waiting_permission", "Waiting for desktop action approval");
          const result = await withHeartbeat(
            () => withTimeout(
              approveAction?.(executedAction) ?? Promise.resolve(undefined),
              config.timeouts.approvalMs,
              "Computer Use approval",
              stepController.signal,
            ),
            () => emitProgress("waiting_permission", "Still waiting for desktop action approval"),
            config.heartbeatMs,
          );
          if (result) {
            approval = { approvalId: result.approvalId, taskId: result.taskId };
            if (result.sessionWide && !requiresFreshApproval(executedAction)) {
              taskLease = approval;
            }
          }
        }
      }
      emitProgress("executing", `Executing ${executedAction.tool}`);
      result = await withTimeout(
        dispatchAction(computerTool, executedAction, approval),
        getActionTimeoutMs(executedAction, config),
        executedAction.tool,
        stepController.signal,
      );
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
      if (isWriteAction(executedAction)) {
        emitProgress("verifying", "Verifying desktop action result");
        const verification = await withTimeout(
          verifyActionResult(executedAction, result, {
            before: observation,
            after: () => observeComputerState({
              computerTool,
              nextScreenshot: undefined,
              preferredUiWindowHandle,
              uiCache,
              config,
              signal: stepController.signal,
              bypassUiCache: true,
              includeUiValues: shouldInspectValuesForVerification(executedAction),
            }),
          }),
          config.timeouts.verificationMs,
          "Computer Use verification",
          stepController.signal,
        );
        trace.verification = verification;
        if (!verification.passed) {
          let passedAfterRetry = false;
          if (canRetryAfterVerificationFailure(executedAction, result)) {
            emitProgress("recovering", "Retrying desktop action once after verification failure");
            const retryApproval = await getRetryApproval({
              action: executedAction,
              taskLease,
              approval,
              approveAction,
              config,
              signal: stepController.signal,
              emitProgress,
            });
            await delayBeforeRetry(stepController.signal);
            result = await withTimeout(
              dispatchAction(computerTool, executedAction, retryApproval),
              getActionTimeoutMs(executedAction, config),
              `${executedAction.tool} retry`,
              stepController.signal,
            );
            const retryBase = verifyRetryToolResult(executedAction, result);
            const retryVerification = await withTimeout(
              verifyActionResult(executedAction, result, {
                before: observation,
                after: () => observeComputerState({
                  computerTool,
                  nextScreenshot: undefined,
                  preferredUiWindowHandle,
                  uiCache,
                  config,
                  signal: stepController.signal,
                  bypassUiCache: true,
                  includeUiValues: shouldInspectValuesForVerification(executedAction),
                }),
              }),
              config.timeouts.verificationMs,
              "Computer Use retry verification",
              stepController.signal,
            );
            const retryPassed = retryVerification.passed || retryBase.passed;
            trace.verification = {
              passed: retryPassed,
              reason: retryVerification.passed
                ? `${retryVerification.reason}; retried once after: ${verification.reason}`
                : `${retryBase.reason}; post-retry state check: ${retryVerification.reason}; retried once after: ${verification.reason}`,
            };
            if (retryPassed) {
              passedAfterRetry = true;
            }
          }
          if (!passedAfterRetry) {
            throw new Error(`Verification failed: ${verification.reason}`);
          }
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      if (trace.action?.approvalMode === "task_lease" && isTaskLeaseFailure(error)) {
        taskLease = undefined;
      }
    }

    // 7. Record the step
    const step: ComputerUseStep = {
      stepIndex: i,
      screenshotDataUrl: screenshot?.dataUrl ?? "",
      observation: rawOutput?.observation ?? "",
      action: executedAction,
      target: rawOutput?.target ?? "",
      confidence: rawOutput?.confidence ?? "medium",
      result,
      phase: error ? "failed" : "completed",
      trace: finishTrace(trace, stepStartedAt),
      error,
    };
    recordStep(step);

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
    const params = JSON.stringify(redactActionParamsForHistory(step.action));
    const resultStr = step.error
      ? `ERROR: ${step.error}`
      : step.result !== undefined
        ? `result: ${JSON.stringify(redactResultForHistory(step.result))}`
        : "";
    return `Step ${step.stepIndex + 1}: saw "${step.observation}" → ${toolName}(${params}) ${resultStr}`.trim();
  });

  return `PREVIOUS STEPS (most recent ${recent.length}):\n${lines.join("\n")}`;
}

function redactActionParamsForHistory(action: ComputerUseAction): Record<string, unknown> {
  if (action.tool === "computer.type") {
    return {
      ...action.params,
      text: `[redacted:${action.params.text.length} chars]`,
    };
  }
  if (action.tool === "computer.setUiValue") {
    return {
      ...action.params,
      value: `[redacted:${action.params.value.length} chars]`,
    };
  }
  return action.params;
}

function redactResultForHistory(result: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof result === "string") {
    return result.startsWith("data:image/")
      ? `[redacted:image data URL:${result.length} chars]`
      : result;
  }
  if (!result || typeof result !== "object") {
    return result;
  }
  if (seen.has(result)) {
    return "[redacted:circular]";
  }
  seen.add(result);
  if (Array.isArray(result)) {
    return result.map((entry) => redactResultForHistory(entry, seen));
  }
  const record = result as Record<string, unknown>;
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const lowerKey = key.toLowerCase();
    if (typeof value === "string" && (lowerKey.endsWith("dataurl") || value.startsWith("data:image/"))) {
      redacted[key] = `[redacted:image data URL:${value.length} chars]`;
    } else if (lowerKey.includes("value") && typeof value === "string") {
      redacted[key] = `[redacted:${value.length} chars]`;
    } else if (key === "tree" && typeof value === "string") {
      redacted[key] = redactUiTreeValues(value);
    } else {
      redacted[key] = redactResultForHistory(value, seen);
    }
  }
  return redacted;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function removeVerificationOnlyParams(action: ComputerUseAction): ComputerUseAction {
  if (action.tool !== "computer.inspectUi" || action.params.includeValues === undefined) {
    return action;
  }
  const { includeValues: _includeValues, ...params } = action.params;
  return { tool: action.tool, params };
}

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
    width?: number;
    height?: number;
    sourceWidth?: number;
    sourceHeight?: number;
    screenshotUnavailableReason?: string;
    windowList?: ComputerListWindowsResult;
    uiContext?: UiPromptContext;
  },
): string {
  const parts: string[] = [
    COMPUTER_USE_SYSTEM_PROMPT.en,
    `USER GOAL: ${userGoal}`,
  ];
  if (screenshot.width !== undefined && screenshot.height !== undefined) {
    parts.push(
      `SCREENSHOT: ${screenshot.width}x${screenshot.height}. Coordinates start at (0,0) in the top-left corner; x increases right, y increases down.`,
    );
  } else {
    parts.push(
      `SCREENSHOT: unavailable (${screenshot.screenshotUnavailableReason ?? "unknown reason"}). Use WINDOWS/UIA context only; do not output coordinate mouse actions unless a later screenshot succeeds.`,
    );
  }
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

interface UiPromptContext {
  windowHandle: number;
  title?: string;
  tree: string;
  nodeCount: number;
  freshAt: string;
  cacheHit?: boolean;
}

interface ComputerObservation {
  screenshot?: ComputerScreenshotResult;
  windowList?: ComputerListWindowsResult;
  uiContext?: UiPromptContext;
  preferredUiWindowHandle?: number;
  coordinateTargetWindowHandle?: number;
  freshAt: string;
  error?: string;
  screenshotError?: string;
}

async function observeComputerState(options: {
  computerTool: ComputerTool;
  nextScreenshot: ComputerScreenshotResult | undefined;
  preferredUiWindowHandle: number | undefined;
  uiCache: Map<number, { context: UiPromptContext; expiresAt: number }>;
  config: ComputerUseLoopConfig;
  signal: AbortSignal;
  bypassUiCache?: boolean;
  includeUiValues?: boolean;
}): Promise<ComputerObservation> {
  const freshAt = new Date().toISOString();
  const screenshotPromise = options.nextScreenshot
    ? Promise.resolve(options.nextScreenshot)
    : withTimeout(Promise.resolve(options.computerTool.screenshot({})), options.config.timeouts.screenshotMs, "computer.screenshot", options.signal);
  const windowPromise = withTimeout(
    Promise.resolve(options.computerTool.listWindows({})),
    options.config.timeouts.listWindowsMs,
    "computer.listWindows",
    options.signal,
  );
  const preferredUiPromise = options.preferredUiWindowHandle === undefined
    ? undefined
    : getUiContext({
      computerTool: options.computerTool,
      windowList: undefined,
      preferredHandle: options.preferredUiWindowHandle,
      fallbackWindow: {
        handle: options.preferredUiWindowHandle,
        title: undefined,
      },
      uiCache: options.uiCache,
      config: options.config,
      signal: options.signal,
      freshAt,
      bypassCache: options.bypassUiCache,
      includeValues: options.includeUiValues,
    });
  const [screenshotResult, windowResult, preferredUiResult] = await Promise.allSettled([
    screenshotPromise,
    windowPromise,
    preferredUiPromise ?? Promise.resolve(undefined),
  ]);

  const screenshot = screenshotResult.status === "fulfilled" ? screenshotResult.value : undefined;
  const windowList = windowResult.status === "fulfilled" ? windowResult.value : undefined;
  const preferredUiContext = preferredUiResult.status === "fulfilled" ? preferredUiResult.value : undefined;
  const screenshotError = resultErrorMessage(screenshotResult);
  const coordinateTargetWindowHandle = resolveCoordinateTargetWindowHandle(
    screenshot,
    windowList,
    options.preferredUiWindowHandle,
  );
  if (!screenshot && options.preferredUiWindowHandle !== undefined) {
    const recoveredScreenshot = await recoverWindowScreenshot({
      computerTool: options.computerTool,
      windowHandle: options.preferredUiWindowHandle,
      failedMethod: options.nextScreenshot?.methodUsed,
      config: options.config,
      signal: options.signal,
    });
    if (recoveredScreenshot) {
      return {
        screenshot: recoveredScreenshot,
        windowList,
        uiContext: preferredUiContext ?? await getUiContext({
          computerTool: options.computerTool,
          windowList,
          preferredHandle: options.preferredUiWindowHandle,
          uiCache: options.uiCache,
          config: options.config,
          signal: options.signal,
          freshAt,
          bypassCache: options.bypassUiCache,
          includeValues: options.includeUiValues,
        }),
        preferredUiWindowHandle: options.preferredUiWindowHandle,
        coordinateTargetWindowHandle: resolveCoordinateTargetWindowHandle(
          recoveredScreenshot,
          windowList,
          options.preferredUiWindowHandle,
        ),
        freshAt,
        screenshotError,
      };
    }
  }
  const uiContext = preferredUiContext ?? await getUiContext({
    computerTool: options.computerTool,
    windowList,
    preferredHandle: options.preferredUiWindowHandle,
    uiCache: options.uiCache,
    config: options.config,
    signal: options.signal,
    freshAt,
    bypassCache: options.bypassUiCache,
    includeValues: options.includeUiValues,
  });

  return {
    screenshot,
    windowList,
    uiContext,
    preferredUiWindowHandle: options.preferredUiWindowHandle,
    coordinateTargetWindowHandle,
    freshAt,
    error: screenshot || windowList || uiContext ? undefined : screenshotError,
    screenshotError,
  };
}

async function recoverWindowScreenshot(options: {
  computerTool: ComputerTool;
  windowHandle: number;
  failedMethod?: "bitblt" | "printWindow";
  config: ComputerUseLoopConfig;
  signal: AbortSignal;
}): Promise<ComputerScreenshotResult | undefined> {
  const methods: Array<"bitblt" | "printWindow"> = options.failedMethod === "bitblt"
    ? ["printWindow"]
    : ["bitblt", "printWindow"];
  for (const method of methods) {
    try {
      return await withTimeout(
        Promise.resolve(options.computerTool.screenshot({
          windowHandle: options.windowHandle,
          method,
        })),
        options.config.timeouts.screenshotMs,
        `computer.screenshot.${method}`,
        options.signal,
      );
    } catch {
      // Try the next screenshot path before falling back to UIA-only observation.
    }
  }
  return undefined;
}

async function getUiContext(
  options: {
    computerTool: ComputerTool;
    windowList: ComputerListWindowsResult | undefined;
    preferredHandle: number | undefined;
    fallbackWindow?: { handle: number; title?: string };
    uiCache: Map<number, { context: UiPromptContext; expiresAt: number }>;
    config: ComputerUseLoopConfig;
    signal: AbortSignal;
    freshAt: string;
    bypassCache?: boolean;
    includeValues?: boolean;
  },
): Promise<UiPromptContext | undefined> {
  const fallbackWindow = options.fallbackWindow && options.preferredHandle === options.fallbackWindow.handle
    ? {
      handle: options.fallbackWindow.handle,
      title: options.fallbackWindow.title ?? "",
      className: "",
      rect: { x: 0, y: 0, width: 0, height: 0 },
      isVisible: true,
      isForeground: false,
    }
    : undefined;
  const window = selectUiWindow(options.windowList, options.preferredHandle) ?? fallbackWindow;
  if (!window) return undefined;
  const cached = options.uiCache.get(window.handle);
  if (!options.includeValues && !options.bypassCache && cached && cached.expiresAt > Date.now()) {
    return { ...cached.context, freshAt: options.freshAt, cacheHit: true };
  }
  try {
    const result = await withTimeout(
      Promise.resolve(options.computerTool.inspectUi({
        windowHandle: window.handle,
        maxDepth: 4,
        maxNodes: 120,
        ...(options.includeValues ? { includeValues: true } : {}),
      })),
      options.config.timeouts.inspectUiMs,
      "computer.inspectUi",
      options.signal,
    );
    if (!result.tree.trim()) return undefined;
    const context = {
      windowHandle: window.handle,
      title: window.title,
      tree: result.tree,
      nodeCount: result.nodeCount,
      freshAt: options.freshAt,
    };
    if (!options.includeValues) {
      options.uiCache.set(window.handle, {
        context,
        expiresAt: Date.now() + options.config.uiCacheMs,
      });
    }
    return context;
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
  const safeTree = redactUiTreeValues(context.tree);
  const tree = safeTree.length > 6000
    ? `${safeTree.slice(0, 6000)}\n...`
    : safeTree;
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

function createProgressEmitter(options: {
  stepIndex: number;
  onProgress?: (step: ComputerUseStep) => void;
  config: ComputerUseLoopConfig;
  getTrace: () => ComputerUseStepTrace;
}) {
  let lastEmittedAt = Number.NEGATIVE_INFINITY;
  return (phase: ComputerUsePhase, observation: string) => {
    if (!options.onProgress) return;
    const now = Date.now();
    if (now - lastEmittedAt < options.config.heartbeatMs) return;
    lastEmittedAt = now;
    options.onProgress({
      stepIndex: options.stepIndex,
      screenshotDataUrl: "",
      observation,
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: phase,
      confidence: "medium",
      phase,
      trace: options.getTrace(),
    });
  };
}

async function withHeartbeat<T>(
  operation: () => Promise<T>,
  emitHeartbeat: () => void,
  heartbeatMs: number,
): Promise<T> {
  emitHeartbeat();
  const intervalId = setInterval(emitHeartbeat, Math.max(heartbeatMs, 1));
  try {
    return await operation();
  } finally {
    clearInterval(intervalId);
  }
}

function createStepAbortController(parentSignal: AbortSignal | undefined, deadlineMs: number) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error(`Computer Use step exceeded ${deadlineMs}ms deadline.`));
  }, deadlineMs);
  const abortFromParent = () => controller.abort(parentSignal?.reason ?? new Error("Computer Use cancelled."));
  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeoutId);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error("Computer Use cancelled.");
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error(`${label} cancelled.`);
  }
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      abortHandler = () => reject(signal?.reason instanceof Error ? signal.reason : new Error(`${label} cancelled.`));
      signal?.addEventListener("abort", abortHandler, { once: true });
      promise.then(resolve, reject);
    });
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (abortHandler) signal?.removeEventListener("abort", abortHandler);
  }
}

function resultErrorMessage(result: PromiseSettledResult<unknown>): string | undefined {
  if (result.status === "fulfilled") return undefined;
  return result.reason instanceof Error ? result.reason.message : String(result.reason);
}

function createErrorStep(
  stepIndex: number,
  phase: ComputerUsePhase,
  error: string,
  trace: ComputerUseStepTrace,
  startedAt: number,
): ComputerUseStep {
  return {
    stepIndex,
    screenshotDataUrl: "",
    observation: error,
    action: { tool: "computer.wait", params: { ms: 0 } },
    target: phase,
    confidence: "low",
    phase: "failed",
    trace: finishTrace(trace, startedAt),
    error,
  };
}

function finishTrace(trace: ComputerUseStepTrace, startedAt: number): ComputerUseStepTrace {
  return {
    ...trace,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
  };
}

function summarizeScreenshotTrace(screenshot: ComputerScreenshotResult): NonNullable<ComputerUseStepTrace["screenshot"]> {
  return {
    width: screenshot.width,
    height: screenshot.height,
    sourceWidth: screenshot.sourceWidth,
    sourceHeight: screenshot.sourceHeight,
    sourceOriginX: screenshot.sourceOriginX,
    sourceOriginY: screenshot.sourceOriginY,
    scaleX: screenshot.scaleX,
    scaleY: screenshot.scaleY,
    methodUsed: screenshot.methodUsed,
  };
}

function summarizeWindowListTrace(
  windowList: ComputerListWindowsResult,
  freshAt: string,
): NonNullable<ComputerUseStepTrace["windows"]> {
  return {
    freshAt,
    count: windowList.windows.length,
    foregroundHandle: windowList.windows.find((window) => window.isForeground)?.handle,
    titles: windowList.windows
      .filter((window) => window.isVisible && window.title.trim())
      .slice(0, 6)
      .map((window) => window.title),
  };
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

function isTaskLeaseFailure(error: string | undefined): boolean {
  if (!error) return false;
  return /Computer Use task approval/i.test(error);
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

async function getRetryApproval(options: {
  action: ComputerUseAction;
  taskLease: { approvalId: string; taskId?: string } | undefined;
  approval: { approvalId: string; taskId?: string } | undefined;
  approveAction: ComputerUseLoopOptions["approveAction"];
  config: ComputerUseLoopConfig;
  signal: AbortSignal;
  emitProgress: (phase: ComputerUsePhase, observation: string) => void;
}): Promise<{ approvalId: string; taskId?: string } | undefined> {
  if (options.taskLease && !requiresFreshApproval(options.action)) {
    return options.taskLease;
  }
  if (!options.approveAction) {
    return options.approval;
  }
  options.emitProgress("waiting_permission", "Waiting for retry approval");
  const result = await withHeartbeat(
    () => withTimeout(
      options.approveAction?.(options.action) ?? Promise.resolve(undefined),
      options.config.timeouts.approvalMs,
      "Computer Use retry approval",
      options.signal,
    ),
    () => options.emitProgress("waiting_permission", "Still waiting for retry approval"),
    options.config.heartbeatMs,
  );
  return result
    ? { approvalId: result.approvalId, taskId: result.taskId }
    : options.approval;
}

async function delayBeforeRetry(signal: AbortSignal): Promise<void> {
  await withTimeout(new Promise<void>((resolve) => {
    setTimeout(resolve, 60);
  }), 100, "Computer Use retry backoff", signal);
}

function preferStructuredAction(
  action: ComputerUseAction,
  observation: ComputerObservation,
  rawOutput: { observation?: string; target?: string } | undefined,
): { action: ComputerUseAction; strategy: "model" | "uia_preferred"; reason?: string } {
  if (action.tool !== "computer.click" || !observation.uiContext) {
    return { action, strategy: "model" };
  }
  const targetText = [rawOutput?.target, rawOutput?.observation]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  const candidate = resolveUiCandidate(observation.uiContext, targetText);
  if (!candidate) {
    return { action, strategy: "model" };
  }
  return {
    action: {
      tool: "computer.invokeUi",
      params: {
        selector: {
          windowHandle: observation.uiContext.windowHandle,
          ...(candidate.automationId ? { automationId: candidate.automationId } : {}),
          ...(candidate.name ? { name: candidate.name } : {}),
          ...(candidate.controlType ? { controlType: candidate.controlType } : {}),
        },
      },
    },
    strategy: "uia_preferred",
    reason: candidate.automationId
      ? `matched UIA automationId ${candidate.automationId}`
      : `matched UIA name ${candidate.name}`,
  };
}

interface UiCandidate {
  controlType: string;
  name: string;
  automationId: string;
}

function resolveUiCandidate(context: UiPromptContext, targetText: string): UiCandidate | undefined {
  const candidates = parseUiCandidates(context.tree)
    .filter((candidate) => candidate.automationId || candidate.name)
    .filter((candidate) => isActionableControl(candidate.controlType));
  const normalizedTarget = normalizeMatchText(targetText);
  if (!normalizedTarget) return undefined;
  return candidates.find((candidate) => candidate.automationId && normalizedTarget.includes(normalizeMatchText(candidate.automationId))) ??
    candidates.find((candidate) => candidate.name && normalizedTarget.includes(normalizeMatchText(candidate.name))) ??
    candidates.find((candidate) => {
      const name = normalizeMatchText(candidate.name);
      return name.length >= 3 && name.split(/\s+/).some((part) => part.length >= 3 && normalizedTarget.includes(part));
    });
}

function parseUiCandidates(tree: string): UiCandidate[] {
  const candidates: UiCandidate[] = [];
  const pattern = /<([A-Za-z][\w-]*)\s+name="([^"]*)"\s+automationId="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(tree)) !== null) {
    candidates.push({
      controlType: unescapeUiTreeText(match[1] ?? ""),
      name: unescapeUiTreeText(match[2] ?? ""),
      automationId: unescapeUiTreeText(match[3] ?? ""),
    });
  }
  return candidates;
}

interface UiValueCandidate extends UiCandidate {
  value: string;
}

function parseUiValueCandidates(tree: string): UiValueCandidate[] {
  const candidates: UiValueCandidate[] = [];
  const pattern = /<([A-Za-z][\w-]*)\s+name="([^"]*)"\s+automationId="([^"]*)"(?:\s+value="([^"]*)")?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(tree)) !== null) {
    if (match[4] === undefined) continue;
    candidates.push({
      controlType: unescapeUiTreeText(match[1] ?? ""),
      name: unescapeUiTreeText(match[2] ?? ""),
      automationId: unescapeUiTreeText(match[3] ?? ""),
      value: unescapeUiTreeText(match[4] ?? ""),
    });
  }
  return candidates;
}

function selectorMatchesValueCandidate(
  selector: { automationId?: string; name?: string; controlType?: string },
  candidate: UiValueCandidate,
): boolean {
  const automationIdMatches = selector.automationId === undefined ||
    candidate.automationId === selector.automationId;
  const nameMatches = selector.name === undefined ||
    candidate.name.includes(selector.name);
  const controlTypeMatches = selector.controlType === undefined ||
    candidate.controlType.toLowerCase() === selector.controlType.toLowerCase() ||
    selector.controlType.toLowerCase().startsWith("controltype");
  return automationIdMatches && nameMatches && controlTypeMatches;
}

function isActionableControl(controlType: string): boolean {
  return /button|menuitem|tabitem|hyperlink|checkbox|radio|splitbutton/i.test(controlType);
}

function normalizeMatchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/&quot;/g, "\"")
    .replace(/&amp;/g, "&")
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, " ")
    .trim();
}

function unescapeUiTreeText(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function redactUiTreeValues(tree: string): string {
  return tree.replace(/\svalue="([^"]*)"/g, (_match, value: string) =>
    ` value="[redacted:${unescapeUiTreeText(value).length} chars]"`
  );
}

function stripUiTreeValues(tree: string): string {
  return tree.replace(/\svalue="[^"]*"/g, "");
}

function getActionTimeoutMs(action: ComputerUseAction, config: ComputerUseLoopConfig): number {
  switch (action.tool) {
    case "computer.screenshot":
      return config.timeouts.screenshotMs;
    case "computer.listWindows":
      return config.timeouts.listWindowsMs;
    case "computer.inspectUi":
      return config.timeouts.inspectUiMs;
    case "computer.type":
    case "computer.keyCombo":
    case "computer.setUiValue":
      return config.timeouts.textWriteMs;
    case "computer.wait":
      return Math.min(Math.max(action.params.ms, 0), config.stepDeadlineMs);
    case "computer.moveMouse":
    case "computer.click":
    case "computer.scroll":
    case "computer.focusWindow":
    case "computer.invokeUi":
      return config.timeouts.lowRiskWriteMs;
    default:
      return assertNever(action);
  }
}

async function runPreflightCheck(
  action: ComputerUseAction,
  observation: ComputerObservation,
  options?: {
    refreshUiContext?: (windowHandle: number) => Promise<UiPromptContext | undefined>;
  },
): Promise<NonNullable<ComputerUseStepTrace["preflight"]>> {
  if (!isWriteAction(action)) {
    return { passed: true, reason: "read-only action" };
  }

  if (isCoordinateAction(action)) {
    return checkCoordinatePreflight(action, observation);
  }

  if (action.tool === "computer.focusWindow") {
    const window = findWindowByHandle(observation.windowList, action.params.handle);
    if (!observation.windowList) {
      return { passed: true, reason: "window list unavailable" };
    }
    if (!window || !window.isVisible) {
      return { passed: false, reason: `window ${action.params.handle} is not visible` };
    }
    return { passed: true, reason: "target window is visible" };
  }

  if (action.tool === "computer.invokeUi" || action.tool === "computer.setUiValue") {
    return checkSelectorPreflight(action.params.selector, observation, options);
  }

  return { passed: true, reason: "no preflight rule for action" };
}

function checkCoordinatePreflight(
  action: Extract<ComputerUseAction, { params: { x: number; y: number } }>,
  observation: ComputerObservation,
): NonNullable<ComputerUseStepTrace["preflight"]> {
  const visibleWindows = observation.windowList?.windows.filter((window) =>
    window.isVisible && window.rect.width > 0 && window.rect.height > 0
  ) ?? [];
  if (visibleWindows.length === 0) {
    const screenshot = observation.screenshot;
    if (!screenshot) {
      return { passed: false, reason: "coordinate action requires screenshot or visible window geometry" };
    }
    const minX = finiteNumberOrDefault(screenshot.sourceOriginX, 0);
    const minY = finiteNumberOrDefault(screenshot.sourceOriginY, 0);
    const maxX = minX + finiteNumberOrDefault(screenshot.sourceWidth, screenshot.width);
    const maxY = minY + finiteNumberOrDefault(screenshot.sourceHeight, screenshot.height);
    const insideScreenshot = action.params.x >= minX &&
      action.params.x <= maxX &&
      action.params.y >= minY &&
      action.params.y <= maxY;
    return insideScreenshot
      ? { passed: true, reason: "coordinate is inside screenshot bounds" }
      : { passed: false, reason: `coordinate ${action.params.x},${action.params.y} is outside screenshot bounds` };
  }
  const insideVisibleWindow = visibleWindows.some((window) =>
    pointInRect(action.params.x, action.params.y, window.rect)
  );
  if (!insideVisibleWindow) {
    return { passed: false, reason: `coordinate ${action.params.x},${action.params.y} is outside visible windows` };
  }
  const targetWindow = selectTargetWindowForCoordinateAction(
    visibleWindows,
    observation.coordinateTargetWindowHandle,
  );
  const insideTargetWindow = targetWindow
    ? pointInRect(action.params.x, action.params.y, targetWindow.rect)
    : true;
  return insideTargetWindow
    ? { passed: true, reason: targetWindow ? "coordinate is inside the target window" : "coordinate is inside a visible window" }
    : { passed: false, reason: `coordinate ${action.params.x},${action.params.y} is outside target window ${targetWindow?.handle}` };
}

function selectTargetWindowForCoordinateAction(
  visibleWindows: ComputerListWindowsResult["windows"],
  coordinateTargetWindowHandle: number | undefined,
): ComputerListWindowsResult["windows"][number] | undefined {
  const preferredWindow = coordinateTargetWindowHandle === undefined
    ? undefined
    : visibleWindows.find((window) => window.handle === coordinateTargetWindowHandle);
  if (preferredWindow) return preferredWindow;
  return visibleWindows.find((window) => window.isForeground) ?? visibleWindows[0];
}

function resolveCoordinateTargetWindowHandle(
  screenshot: ComputerScreenshotResult | undefined,
  windowList: ComputerListWindowsResult | undefined,
  preferredWindowHandle: number | undefined,
): number | undefined {
  if (!screenshot || preferredWindowHandle === undefined) return undefined;
  const window = findWindowByHandle(windowList, preferredWindowHandle);
  if (!window?.isVisible) return undefined;
  const originX = finiteNumberOrDefault(screenshot.sourceOriginX, 0);
  const originY = finiteNumberOrDefault(screenshot.sourceOriginY, 0);
  const sourceWidth = finiteNumberOrDefault(screenshot.sourceWidth, screenshot.width);
  const sourceHeight = finiteNumberOrDefault(screenshot.sourceHeight, screenshot.height);
  const rectMatches = originX === window.rect.x &&
    originY === window.rect.y &&
    sourceWidth === window.rect.width &&
    sourceHeight === window.rect.height;
  return rectMatches ? preferredWindowHandle : undefined;
}

async function checkSelectorPreflight(
  selector: { windowHandle: number; automationId?: string; name?: string },
  observation: ComputerObservation,
  options?: {
    refreshUiContext?: (windowHandle: number) => Promise<UiPromptContext | undefined>;
  },
): Promise<NonNullable<ComputerUseStepTrace["preflight"]>> {
  const window = findWindowByHandle(observation.windowList, selector.windowHandle);
  if (observation.windowList && (!window || !window.isVisible)) {
    return { passed: false, reason: `selector window ${selector.windowHandle} is not visible` };
  }
  const refreshedUiContext = await options?.refreshUiContext?.(selector.windowHandle);
  const uiContext = refreshedUiContext ??
    (observation.uiContext?.windowHandle === selector.windowHandle ? observation.uiContext : undefined);
  if (!uiContext || uiContext.windowHandle !== selector.windowHandle) {
    return { passed: false, reason: "matching UIA tree unavailable for selector preflight" };
  }
  if (selectorAppearsInUiTree(selector, uiContext.tree)) {
    return { passed: true, reason: "selector appears in current UIA tree" };
  }
  return { passed: false, reason: "selector is not present in current UIA tree" };
}

function selectorAppearsInUiTree(
  selector: { automationId?: string; name?: string; controlType?: string },
  tree: string,
): boolean {
  const candidates = parseUiCandidates(tree);
  if (candidates.length > 0) {
    return candidates.some((candidate) => selectorMatchesUiCandidate(selector, candidate));
  }
  const lowerTree = tree.toLowerCase();
  const automationIdMatches = selector.automationId === undefined ||
    lowerTree.includes(selector.automationId.toLowerCase());
  const nameMatches = selector.name === undefined ||
    lowerTree.includes(selector.name.toLowerCase());
  return automationIdMatches && nameMatches;
}

function selectorMatchesUiCandidate(
  selector: { automationId?: string; name?: string; controlType?: string },
  candidate: UiCandidate,
): boolean {
  const automationIdMatches = selector.automationId === undefined ||
    candidate.automationId === selector.automationId;
  const nameMatches = selector.name === undefined ||
    candidate.name.includes(selector.name);
  const controlTypeMatches = selector.controlType === undefined ||
    candidate.controlType.toLowerCase() === selector.controlType.toLowerCase() ||
    selector.controlType.toLowerCase().startsWith("controltype");
  return automationIdMatches && nameMatches && controlTypeMatches;
}

async function verifyActionResult(
  action: ComputerUseAction,
  result: unknown,
  context: {
    before: ComputerObservation;
    after: () => Promise<ComputerObservation>;
  },
): Promise<NonNullable<ComputerUseStepTrace["verification"]>> {
  if (!isWriteAction(action)) {
    return { passed: true, reason: "read-only action" };
  }
  if (!result || typeof result !== "object") {
    return { passed: false, reason: "action returned no structured result" };
  }
  const record = result as Record<string, unknown>;
  let base: NonNullable<ComputerUseStepTrace["verification"]>;
  switch (action.tool) {
    case "computer.click":
      base = booleanResult(record.clicked, "click completed");
      break;
    case "computer.type":
      base = booleanResult(record.typed, "text typed");
      break;
    case "computer.keyCombo":
      base = booleanResult(record.executed, "key combo executed");
      break;
    case "computer.focusWindow":
      base = booleanResult(record.focused, "window focused");
      break;
    case "computer.invokeUi":
      base = booleanResult(record.invoked, "UI element invoked");
      break;
    case "computer.setUiValue":
      base = booleanResult(record.set, "UI value set");
      break;
    case "computer.moveMouse":
      base = numericResult(record.x) && numericResult(record.y)
        ? { passed: true, reason: "mouse position reported" }
        : { passed: false, reason: "mouse move returned no coordinates" };
      break;
    case "computer.scroll":
      base = numericResult(record.delta)
        ? { passed: true, reason: "scroll delta reported" }
        : { passed: true, reason: "scroll completed without explicit delta" };
      break;
    default:
      base = { passed: true, reason: "no verification rule for action" };
  }
  if (!base.passed) return base;
  const needsStateChange = action.tool === "computer.click" ||
    action.tool === "computer.type" ||
    action.tool === "computer.invokeUi" ||
    action.tool === "computer.setUiValue" ||
    action.tool === "computer.scroll";
  if (!needsStateChange) return base;

  const after = await context.after();
  if (action.tool === "computer.setUiValue") {
    const valueCheck = verifySetUiValueFromObservation(action, after);
    if (valueCheck) return valueCheck;
  }
  if (action.tool === "computer.type") {
    const valueCheck = verifyTypeFromObservation(action, after);
    if (valueCheck?.passed) return valueCheck;
    const change = summarizeObservationChange(context.before, after);
    if (valueCheck && change === "unchanged") {
      return { passed: false, reason: `${base.reason}; readable UI values did not include typed text and no state change was observed` };
    }
    if (change === "changed") {
      return { passed: true, reason: `${base.reason}; observed state changed` };
    }
    return base;
  }
  const change = summarizeObservationChange(context.before, after);
  if (change === "changed") {
    return { passed: true, reason: `${base.reason}; observed state changed` };
  }
  if (change === "unchanged") {
    return { passed: false, reason: `${base.reason}; no screenshot/window/UIA change observed` };
  }
  return { passed: true, reason: `${base.reason}; post-action state unavailable` };
}

function shouldInspectValuesForVerification(action: ComputerUseAction): boolean {
  return action.tool === "computer.type" || action.tool === "computer.setUiValue";
}

function canRetryAfterVerificationFailure(action: ComputerUseAction, result: unknown): boolean {
  if (!result || typeof result !== "object") {
    return false;
  }
  const record = result as Record<string, unknown>;
  const returnedExplicitFailure =
    record.clicked === false ||
    record.invoked === false ||
    record.focused === false ||
    record.executed === false ||
    record.set === false ||
    record.typed === false;
  if (!returnedExplicitFailure) {
    return false;
  }
  return action.tool === "computer.click" ||
    action.tool === "computer.scroll" ||
    action.tool === "computer.invokeUi" ||
    action.tool === "computer.focusWindow" ||
    action.tool === "computer.moveMouse";
}

function verifyRetryToolResult(
  action: ComputerUseAction,
  result: unknown,
): NonNullable<ComputerUseStepTrace["verification"]> {
  if (!result || typeof result !== "object") {
    return { passed: false, reason: "retry returned no structured result" };
  }
  const record = result as Record<string, unknown>;
  switch (action.tool) {
    case "computer.click":
      return booleanResult(record.clicked, "retry click completed");
    case "computer.invokeUi":
      return booleanResult(record.invoked, "retry UI element invoked");
    case "computer.focusWindow":
      return booleanResult(record.focused, "retry window focused");
    case "computer.moveMouse":
      return numericResult(record.x) && numericResult(record.y)
        ? { passed: true, reason: "retry mouse position reported" }
        : { passed: false, reason: "retry mouse move returned no coordinates" };
    case "computer.scroll":
      return numericResult(record.delta)
        ? { passed: true, reason: "retry scroll delta reported" }
        : { passed: true, reason: "retry scroll completed without explicit delta" };
    default:
      return { passed: false, reason: "retry is not allowed for this action" };
  }
}

function verifySetUiValueFromObservation(
  action: Extract<ComputerUseAction, { tool: "computer.setUiValue" }>,
  after: ComputerObservation,
): NonNullable<ComputerUseStepTrace["verification"]> | undefined {
  const uiContext = after.uiContext;
  if (!uiContext || uiContext.windowHandle !== action.params.selector.windowHandle) {
    return undefined;
  }
  const candidates = parseUiValueCandidates(uiContext.tree)
    .filter((candidate) => selectorMatchesValueCandidate(action.params.selector, candidate));
  if (candidates.length === 0) return undefined;

  const expected = action.params.value;
  const matched = candidates.some((candidate) =>
    expected.length === 0 ? candidate.value === expected : candidate.value === expected || candidate.value.includes(expected)
  );
  return matched
    ? { passed: true, reason: `UIA value matched selector after setUiValue (${expected.length} chars expected)` }
    : { passed: false, reason: `UIA value did not match selector after setUiValue (${expected.length} chars expected)` };
}

function verifyTypeFromObservation(
  action: Extract<ComputerUseAction, { tool: "computer.type" }>,
  after: ComputerObservation,
): NonNullable<ComputerUseStepTrace["verification"]> | undefined {
  const expected = action.params.text;
  if (expected.length === 0 || !after.uiContext) {
    return undefined;
  }
  const values = parseUiValueCandidates(after.uiContext.tree).map((candidate) => candidate.value);
  if (values.length === 0) return undefined;
  const matched = values.some((value) => value.includes(expected));
  return matched
    ? { passed: true, reason: `UIA value contains typed text (${expected.length} chars)` }
    : { passed: false, reason: `readable UI values did not include typed text (${expected.length} chars)` };
}

function booleanResult(value: unknown, successReason: string): NonNullable<ComputerUseStepTrace["verification"]> {
  return value === false
    ? { passed: false, reason: `${successReason} returned false` }
    : { passed: true, reason: successReason };
}

function numericResult(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function summarizeObservationChange(before: ComputerObservation, after: ComputerObservation): "changed" | "unchanged" | "unknown" {
  const beforeParts = observationComparableParts(before);
  const afterParts = observationComparableParts(after);
  if (beforeParts.length === 0 || afterParts.length === 0) {
    return "unknown";
  }
  return beforeParts.join("\n") === afterParts.join("\n") ? "unchanged" : "changed";
}

function observationComparableParts(observation: ComputerObservation): string[] {
  const parts: string[] = [];
  if (observation.screenshot) {
    parts.push(`screenshot:${observation.screenshot.dataUrl.slice(0, 96)}:${observation.screenshot.width}x${observation.screenshot.height}`);
  }
  if (observation.windowList) {
    parts.push(`windows:${observation.windowList.windows.map((window) =>
      `${window.handle}:${window.title}:${window.isForeground}:${window.rect.x},${window.rect.y},${window.rect.width},${window.rect.height}`
    ).join("|")}`);
  }
  if (observation.uiContext) {
    parts.push(`ui:${observation.uiContext.windowHandle}:${stripUiTreeValues(observation.uiContext.tree).slice(0, 4000)}`);
  }
  return parts;
}

function findWindowByHandle(
  windowList: ComputerListWindowsResult | undefined,
  handle: number,
): ComputerListWindowsResult["windows"][number] | undefined {
  return windowList?.windows.find((window) => window.handle === handle);
}

function pointInRect(
  x: number,
  y: number,
  rect: { x: number; y: number; width: number; height: number },
): boolean {
  return x >= rect.x &&
    x <= rect.x + rect.width &&
    y >= rect.y &&
    y <= rect.y + rect.height;
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
