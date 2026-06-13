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
  ComputerDetectUiObjectsResult,
  ComputerListWindowsResult,
  ComputerScreenshotResult,
  ComputerTool,
  ComputerUiDetection,
} from "@javis/tools";
import type {
  ComputerUseLoopConfig,
  ComputerUseStep,
  ComputerUseAction,
  ComputerScreenshotRegion,
  ComputerUsePhase,
  ComputerUseStepTrace,
} from "@javis/core";
import {
  parseModelAction,
  parseModelOutput,
  COMPUTER_USE_SYSTEM_PROMPT,
  DEFAULT_COMPUTER_USE_CONFIG,
} from "@javis/core";

const IMAGE_DATA_URL_PATTERN = /data:image(?:\/|\\\/)[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+/gi;
const LOCAL_VISION_PATH_PATTERN = /(?:file:\/\/\/[^\r\n"'`<>()\[\]{}]+|[A-Za-z]:[\\/][^\r\n"'`<>()\[\]{}]+|\/(?:Users|home|tmp|var|mnt|Volumes|opt|workspace|private|run|data)\/[^\r\n"'`<>()\[\]{}]+)/g;
const LOCAL_VISION_PATH_EXTENSIONS = [".onnx", ".engine", ".xml", ".bin", ".mjs", ".js", ".json", ".png", ".jpg", ".jpeg", ".webp", ".txt"];
const LOCAL_VISION_PROMPT_TEXT_MAX_LENGTH = 80;
const PROMPT_INLINE_TEXT_MAX_LENGTH = 120;
const RECORDED_TEXT_MAX_LENGTH = 4_000;
const RECORDED_ARRAY_MAX_ITEMS = 50;
const RECORDED_OBJECT_MAX_ENTRIES = 80;
const STEP_HISTORY_LINE_MAX_LENGTH = 6_000;
const PROMPT_USER_GOAL_MAX_LENGTH = 4_000;
const PROMPT_CORRECTION_HINT_MAX_LENGTH = 1_000;
const LOCAL_VISION_PATH_INPUT_MAX_LENGTH = 1_024;
const LOCAL_VISION_IMAGE_DATA_URL_PATTERN = /data:image(?:\/|\\\/)[a-z0-9.+-]+;base64,/i;
const LOCAL_VISION_OBSERVE_WAIT_MAX_MS = 160;
const AUTO_CROP_MIN_SCORE = 0.88;
const AUTO_CROP_PADDING_PX = 24;
const AUTO_CROP_MAX_AREA_RATIO = 0.45;
const AUTO_CROP_OPTIONAL_WAIT_MAX_MS = 160;
const TASK_APPROVAL_LEASE_TTL_MS = 2 * 60 * 1000;
const TASK_APPROVAL_LEASE_MAX_ACTIONS = 12;
const LOCAL_VISION_SLOW_LATENCY_RATIO = 0.85;
const LOCAL_VISION_SLOW_DETECTION_THRESHOLD = 2;
const LOCAL_VISION_MIN_DYNAMIC_IMGSZ = 512;
const COMPUTER_WAIT_MAX_MS = 10_000;
const COMPUTER_WAIT_MIN_TIMEOUT_MS = 250;
const COMPUTER_WAIT_TIMEOUT_OVERHEAD_MS = 250;
const POST_APPROVAL_PREFLIGHT_REFRESH_THRESHOLD_MS = 1_000;
const SUSPICIOUS_SCREENSHOT_MIN_AREA = 300_000;
const SUSPICIOUS_SCREENSHOT_MAX_BYTES_PER_PIXEL = 0.01;
const MAX_COMPUTER_USE_STEPS = 60;
const MAX_COMPUTER_USE_HISTORY_STEPS = 20;
const MAX_STEP_DEADLINE_MS = 300_000;
const TIMEOUT_LIMITS = {
  listWindowsMs: { min: 1, max: 5_000 },
  inspectUiMs: { min: 1, max: 5_000 },
  screenshotMs: { min: 1, max: 10_000 },
  lowRiskWriteMs: { min: 1, max: 10_000 },
  textWriteMs: { min: 1, max: 15_000 },
  modelMs: { min: 1, max: 120_000 },
  approvalMs: { min: 1, max: 180_000 },
  verificationMs: { min: 1, max: 10_000 },
} satisfies Record<keyof ComputerUseLoopConfig["timeouts"], { min: number; max: number }>;
let observationIdSequence = 0;

type ScreenshotVisionSource = "full" | "crop";

type TaskApprovalLease = {
  approvalId: string;
  taskId?: string;
  createdAtMs: number;
  remainingActions: number;
  windowHandle?: number;
  allowedTools: Set<ComputerUseAction["tool"]>;
};

type ComputerApprovalResult = {
  approvalId: string;
  taskId?: string;
  sessionWide?: boolean;
};

interface PendingScreenshotObservation {
  screenshot: ComputerScreenshotResult;
  source: ScreenshotVisionSource;
  windowHandle?: number;
}

interface PendingAutoCropObservation {
  promise: Promise<PendingScreenshotObservation | undefined>;
  candidateId: string;
  region: ComputerScreenshotRegion;
  reason: string;
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface ComputerUseLoopOptions {
  modelProvider: ModelProvider;
  computerTool: ComputerTool;
  userGoal: string;
  allowedToolNames?: string[];
  config?: Partial<Omit<ComputerUseLoopConfig, "timeouts" | "localVision">> & {
    timeouts?: Partial<ComputerUseLoopConfig["timeouts"]>;
    localVision?: Partial<ComputerUseLoopConfig["localVision"]>;
  };
  /** Supplies a confirmed-write approval binding for each write action. */
  approveAction?: (
    action: ComputerUseAction,
    options?: {
      requiresFreshApproval?: boolean;
      screenshotDataUrl?: string;
      trustedWindowTitle?: string;
      timeoutMs?: number;
    },
  ) => Promise<ComputerApprovalResult>;
  /** Include the current screenshot in live approval cards. */
  includeApprovalScreenshotPreview?: boolean;
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
  const { modelProvider, computerTool, userGoal, allowedToolNames, approveAction, onStep, onProgress, signal } = options;
  const config = normalizeComputerUseLoopConfig(options.config);
  const allowedToolNameSet = allowedToolNames?.length ? new Set(allowedToolNames) : undefined;

  const steps: ComputerUseStep[] = [];
  let correctionHint = "";
  let lastActionSignature = "";
  let repeatedActionCount = 0;
  const lockedScreenshotMethods = new Map<number, "bitblt" | "printWindow">();
  let nextScreenshot: PendingScreenshotObservation | undefined;
  let pendingAutoCrop: PendingAutoCropObservation | undefined;
  let taskLease: TaskApprovalLease | undefined;
  let preferredUiWindowHandle: number | undefined;
  const uiCache = new Map<number, { context: UiPromptContext; expiresAt: number }>();
  const localVisionState: LocalVisionRuntimeState = {
    consecutiveTimeouts: 0,
    consecutiveErrors: 0,
    consecutiveActionFailures: 0,
    consecutiveSlowDetections: 0,
    disabled: false,
  };

  // Pre-compute app name patterns from the goal for window matching on first observation.
  const goalAppPatterns = extractAppNamesFromGoal(userGoal);

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
    let autoCropTrace: Pick<NonNullable<ComputerUseStepTrace["localVision"]>, "autoCropCandidateId" | "autoCropRegion" | "autoCropReason"> | undefined;
    if (!nextScreenshot && pendingAutoCrop) {
      const pending = pendingAutoCrop;
      pendingAutoCrop = undefined;
      emitProgress("observing", "Waiting for cropped desktop state");
      nextScreenshot = await withHeartbeat(
        () => withTimeout(
          pending.promise,
          autoCropOptionalWaitMs(config),
          "computer.screenshot.autoCrop",
          stepController.signal,
        ),
        () => emitProgress("observing", "Still waiting for cropped desktop state"),
        config.heartbeatMs,
      ).catch(() => undefined);
      if (nextScreenshot) {
        autoCropTrace = {
          autoCropCandidateId: pending.candidateId,
          autoCropRegion: pending.region,
          autoCropReason: pending.reason,
        };
      }
    }

    // 1. Take screenshot and refresh lightweight window context.
    emitProgress("observing", "Reading desktop state");
    const observation = await observeComputerState({
      computerTool,
      nextScreenshot,
      preferredUiWindowHandle,
      uiCache,
      config,
      localVisionDetector: computerTool.detectUiObjects,
      localVisionState,
      signal: stepController.signal,
    });
    nextScreenshot = undefined;

    // On first iteration, if no preferred handle yet, try to match goal app name
    // against the window list we just got from observeComputerState.
    if (i === 0 && !preferredUiWindowHandle && goalAppPatterns.length > 0 && observation.windowList) {
      const resolvedHandle = resolveTargetWindowFromGoal(goalAppPatterns, observation.windowList);
      if (resolvedHandle) {
        preferredUiWindowHandle = resolvedHandle;
      }
    }
    const { screenshot, windowList, uiContext } = observation;
    trace.freshAt = observation.freshAt;
    trace.observation = { id: observation.id };
    if (screenshot) trace.screenshot = summarizeScreenshotTrace(
      screenshot,
      observation.screenshotId,
      observation.screenshotVisionSource,
    );
    if (observation.localVision) {
      trace.localVision = {
        ...summarizeLocalVisionTrace(observation.localVision),
        ...autoCropTrace,
      };
    }
    updateLocalVisionRuntimeState(localVisionState, observation.localVision, config.localVision);
    updateLocalVisionRuntimeTrace(trace, localVisionState);
    if (windowList) trace.windows = summarizeWindowListTrace(windowList, observation.freshAt);
    if (uiContext) trace.ui = {
      freshAt: uiContext.freshAt,
      windowHandle: uiContext.windowHandle,
      title: uiContext.title ? redactImageDataUrlsForRecord(uiContext.title) : undefined,
      nodeCount: uiContext.nodeCount,
      cacheHit: uiContext.cacheHit,
    };
    const recordStep = (step: ComputerUseStep): void => {
      const recordedStep = sanitizeStepForRecord(step);
      steps.push(recordedStep);
      onStep?.(recordedStep);
      stepController.dispose();
    };
    if (!observation.screenshot && !observation.windowList && !observation.uiContext) {
      const errorStep = createErrorStep(i, "observing", observation.error ?? "Computer Use observation failed.", trace, stepStartedAt);
      recordStep(errorStep);
      break;
    }
    const screenshotHealthIssue = screenshot
      ? detectSuspiciousFullScreenshot(screenshot, observation.screenshotVisionSource)
      : undefined;
    if (screenshotHealthIssue) {
      const errorStep = createErrorStep(i, "observing", screenshotHealthIssue, trace, stepStartedAt);
      recordStep(errorStep);
      break;
    }

    // 2. Build prompt
    emitProgress("planning", "Preparing desktop action prompt");
    const prompt = buildPrompt(userGoal, steps, config.historySteps, correctionHint, {
        width: screenshot?.width,
        height: screenshot?.height,
        sourceWidth: screenshot?.sourceWidth,
        sourceHeight: screenshot?.sourceHeight,
        visionSource: observation.screenshotVisionSource,
        screenshotUnavailableReason: screenshot ? undefined : observation.error ?? "screenshot unavailable",
        windowList,
        uiContext,
        localVision: observation.localVision,
      });
    correctionHint = "";
    const prepareAutoCrop = () => {
      if (!pendingAutoCrop && !nextScreenshot && i + 1 < config.maxSteps && screenshot && observation.screenshotVisionSource !== "crop") {
        const autoCrop = selectAutoCropCandidate({
          userGoal,
          screenshot,
          localVision: observation.localVision,
        });
        if (autoCrop) {
          if (trace.localVision) {
            trace.localVision.autoCropCandidateId = autoCrop.candidate.id;
            trace.localVision.autoCropRegion = autoCrop.region;
            trace.localVision.autoCropReason = autoCrop.reason;
          }
          pendingAutoCrop = {
            candidateId: autoCrop.candidate.id,
            region: autoCrop.region,
            reason: autoCrop.reason,
            promise: captureAutoCropScreenshot({
              computerTool,
              windowHandle: observation.screenshotWindowHandle,
              region: autoCrop.region,
              config,
              signal: signal ?? stepController.signal,
            }),
          };
        }
      }
    };

    // 3. Call vision model — with context overflow recovery
    let rawResponse: { text: string };
    const noteScreenshotModelCall = () => {
      if (screenshot && trace.localVision) {
        if (observation.screenshotVisionSource === "crop") {
          trace.localVision.cropVlmCalled = true;
          trace.localVision.fullScreenshotVlmCalled = false;
          trace.localVision.fullScreenshotVlmSkipped = true;
        } else {
          trace.localVision.fullScreenshotVlmCalled = true;
          trace.localVision.fullScreenshotVlmSkipped = false;
        }
      }
    };
    let createdTaskLeaseThisStep = false;
    let createdTaskLeaseDuringRetry = false;
    try {
      emitProgress("waiting_model", "Waiting for model action");
      noteScreenshotModelCall();
      rawResponse = await withHeartbeat(
        () => withTimeout(
          modelProvider.complete(prompt, {
            ...(screenshot ? { imageDataUrl: screenshot.dataUrl } : {}),
            skipAgentMemory: true,
            skipSkillContext: true,
            timeoutMs: config.timeouts.modelMs,
          }),
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
          visionSource: observation.screenshotVisionSource,
          screenshotUnavailableReason: screenshot ? undefined : observation.error ?? "screenshot unavailable",
          windowList,
          uiContext,
          localVision: observation.localVision,
        });
        try {
          noteScreenshotModelCall();
          rawResponse = await withHeartbeat(
            () => withTimeout(
              modelProvider.complete(minimalPrompt, {
                ...(screenshot ? { imageDataUrl: screenshot.dataUrl } : {}),
                skipAgentMemory: true,
                skipSkillContext: true,
                timeoutMs: config.timeouts.modelMs,
              }),
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
          pendingAutoCrop = undefined;
          recordStep(overflowStep);
          break;
        }
      } else {
        const modelErrorStep = createErrorStep(i, "waiting_model", err instanceof Error ? err.message : String(err), trace, stepStartedAt);
        pendingAutoCrop = undefined;
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
        noteScreenshotModelCall();
        const retryResponse = await withHeartbeat(
          () => withTimeout(
            modelProvider.complete(retryPrompt, {
              ...(screenshot ? { imageDataUrl: screenshot.dataUrl } : {}),
              skipAgentMemory: true,
              skipSkillContext: true,
              timeoutMs: config.timeouts.modelMs,
            }),
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
        pendingAutoCrop = undefined;
        recordStep(errorStep);
        correctionHint = "Your last output was invalid JSON. Output only valid JSON matching the schema.";
        continue;
      }
    }

    const rawOutput = tryParseOutput(rawResponse.text);
    // 5. Completion signal
    if (action === null) {
      pendingAutoCrop = undefined;
      const completionStep: ComputerUseStep = {
        stepIndex: i,
        screenshotDataUrl: screenshot?.dataUrl ?? "",
        observation: rawOutput?.observation ?? "目标已完成",
        action: { tool: "computer.wait", params: { ms: 0 } },
        target: rawOutput?.target ?? "完成",
        confidence: rawOutput?.confidence ?? "high",
        phase: "completed",
        trace: finishTrace(trace, stepStartedAt),
      };
      recordStep(completionStep);
      break;
    }

    if (allowedToolNameSet && !allowedToolNameSet.has(action.tool)) {
      pendingAutoCrop = undefined;
      const disabledToolStep: ComputerUseStep = {
        stepIndex: i,
        screenshotDataUrl: screenshot?.dataUrl ?? "",
        observation: rawOutput?.observation ?? "",
        action,
        target: rawOutput?.target ?? "",
        confidence: rawOutput?.confidence ?? "low",
        phase: "failed",
        trace: finishTrace(trace, stepStartedAt),
        error: `Computer Use tool is disabled: ${action.tool}`,
      };
      recordStep(disabledToolStep);
      correctionHint = `The tool ${action.tool} is disabled. Choose one of the enabled tools: ${[...allowedToolNameSet].join(", ")}.`;
      continue;
    }

    // 6. Execute the action
    let result: unknown;
    let error: string | undefined;
    const requestedAction = lockScreenshotMethod(removeVerificationOnlyParams(action), lockedScreenshotMethods);
    const mappedAction = screenshot
      ? mapActionFromScreenshotCoordinates(requestedAction, screenshot)
      : requestedAction;
    const strategyResult = preferStructuredAction(mappedAction, observation, rawOutput);
    const executedAction = strategyResult.action;
    const localVisionPreflightAction = isCoordinateAction(executedAction) ? requestedAction : executedAction;
    const actionRequiresFreshApproval = requiresFreshApprovalForCurrentAction(
      executedAction,
      observation.localVision,
      requestedAction,
    );
    if (actionRequiresFreshApproval) {
      taskLease = undefined;
    }
    const canPrepareAutoCropAfterSuccess = shouldKeepPendingAutoCropAfterAction(executedAction);
    if (!canPrepareAutoCropAfterSuccess) {
      pendingAutoCrop = undefined;
    }
    trace.action = {
      tool: executedAction.tool,
      approvalMode: "none",
      originalTool: action.tool === executedAction.tool ? undefined : action.tool,
      strategy: strategyResult.strategy,
      strategyReason: strategyResult.reason,
    };

    if (isWriteAction(executedAction) && !approveAction) {
      pendingAutoCrop = undefined;
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
      pendingAutoCrop = undefined;
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
      let approvalWaitMs: number | undefined;
      if (isWriteAction(executedAction)) {
        emitProgress("preflight", "Checking desktop state before action");
        const preflight = await runPreflightCheck(executedAction, observation, {
          candidateAction: localVisionPreflightAction,
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
        const deniedWindow = findDeniedWindowForAction(executedAction, observation, config);
        if (deniedWindow) {
          throw new Error(
            `Preflight failed: target window "${deniedWindow.title}" matches denied pattern "${deniedWindow.pattern}"`,
          );
        }
        const reusableLease = reusableTaskApprovalLeaseForAction(taskLease, executedAction, observation);
        if (reusableLease && !actionRequiresFreshApproval) {
          trace.action.approvalMode = "task_lease";
          approval = leaseApproval(reusableLease);
        } else {
          if (taskLease && !reusableLease) {
            taskLease = undefined;
          }
          trace.action.approvalMode = "per_action";
          emitProgress("waiting_permission", "Waiting for desktop action approval");
          const approvalStartedAt = Date.now();
          const result = await withHeartbeat(
            () => withTimeout(
              approveAction?.(executedAction, {
                requiresFreshApproval: actionRequiresFreshApproval,
                timeoutMs: config.timeouts.approvalMs,
                ...(options.includeApprovalScreenshotPreview && screenshot?.dataUrl
                  ? { screenshotDataUrl: screenshot.dataUrl }
                  : {}),
                trustedWindowTitle: inferTrustedWindowTitleForAction(executedAction, observation),
              }) ?? Promise.resolve(undefined),
              getApprovalCallbackTimeoutMs(config),
              "Computer Use approval",
              stepController.signal,
            ),
            () => emitProgress("waiting_permission", "Still waiting for desktop action approval"),
            config.heartbeatMs,
          );
          approvalWaitMs = Date.now() - approvalStartedAt;
          if (result) {
            approval = { approvalId: result.approvalId, taskId: result.taskId };
            if (result.sessionWide && !actionRequiresFreshApproval) {
              taskLease = createTaskApprovalLease(result, executedAction, observation);
              createdTaskLeaseThisStep = taskLease !== undefined;
            }
          }
        }
      }
      if (
        approval &&
        approvalWaitMs !== undefined &&
        approvalWaitMs >= POST_APPROVAL_PREFLIGHT_REFRESH_THRESHOLD_MS
      ) {
        if (requiresFreshObservationAfterSlowApproval(executedAction)) {
          throw new Error(
            "Post-approval preflight failed: keyboard target may have changed during approval; observe the current desktop before executing this action.",
          );
        }
        emitProgress("preflight", "Rechecking desktop state after approval");
        const refreshedObservation = await refreshObservationForPostApprovalPreflight({
          action: executedAction,
          computerTool,
          config,
          observation,
          signal: stepController.signal,
        });
        const postApprovalPreflight = await runPreflightCheck(executedAction, refreshedObservation, {
          candidateAction: localVisionPreflightAction,
          refreshUiContext: (windowHandle) => getUiContext({
            computerTool,
            windowList: refreshedObservation.windowList,
            preferredHandle: windowHandle,
            uiCache,
            config,
            signal: stepController.signal,
            freshAt: new Date().toISOString(),
            bypassCache: true,
          }),
        });
        trace.preflight = combinePreflightTrace(trace.preflight, postApprovalPreflight);
        if (!postApprovalPreflight.passed) {
          throw new Error(`Post-approval preflight failed: ${postApprovalPreflight.reason}`);
        }
      }
      emitProgress("executing", `Executing ${executedAction.tool}`);
      result = await withTimeout(
        dispatchAction(computerTool, executedAction, config, approval),
        getActionTimeoutMs(executedAction, config),
        executedAction.tool,
        stepController.signal,
      );
      if (trace.action?.approvalMode === "task_lease" && taskLease) {
        taskLease = consumeTaskApprovalLease(taskLease);
      }
      if (requestedAction.tool === "computer.screenshot") {
        if (requestedAction.params.windowHandle !== undefined) {
          preferredUiWindowHandle = requestedAction.params.windowHandle;
        }
        rememberScreenshotMethod(requestedAction, result, lockedScreenshotMethods);
        if (isScreenshotResult(result)) {
          nextScreenshot = {
            screenshot: result,
            source: requestedAction.params.region ? "crop" : "full",
            windowHandle: requestedAction.params.windowHandle,
          };
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
              localVisionDetector: computerTool.detectUiObjects,
              localVisionState,
              signal: stepController.signal,
              bypassUiCache: true,
              includeUiValues: shouldInspectValuesForVerification(executedAction),
              skipLocalVision: true,
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
            const retryInvalidatesTaskLease = trace.action?.approvalMode === "task_lease" || createdTaskLeaseThisStep;
            if (retryInvalidatesTaskLease) {
              taskLease = undefined;
            }
            const retryApproval = await getRetryApproval({
              action: executedAction,
              taskLease: retryInvalidatesTaskLease ? undefined : taskLease,
              approval,
              approveAction,
              observation,
              config,
              signal: stepController.signal,
              emitProgress,
              requiresFreshApproval: actionRequiresFreshApproval,
              screenshotDataUrl: options.includeApprovalScreenshotPreview ? screenshot?.dataUrl : undefined,
              trustedWindowTitle: inferTrustedWindowTitleForAction(executedAction, observation),
            });
            await delayBeforeRetry(stepController.signal);
            result = await withTimeout(
              dispatchAction(computerTool, executedAction, config, retryApproval),
              getActionTimeoutMs(executedAction, config),
              `${executedAction.tool} retry`,
              stepController.signal,
            );
            if (retryApproval?.approvalId === taskLease?.approvalId && taskLease) {
              taskLease = consumeTaskApprovalLease(taskLease);
            } else if (retryApproval?.sessionWide && !actionRequiresFreshApproval) {
              const retryLease = createTaskApprovalLease(retryApproval, executedAction, observation);
              taskLease = retryLease ? consumeTaskApprovalLease(retryLease) : undefined;
              createdTaskLeaseDuringRetry = taskLease !== undefined;
            }
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
                  localVisionDetector: computerTool.detectUiObjects,
                  localVisionState,
                  signal: stepController.signal,
                  bypassUiCache: true,
                  includeUiValues: shouldInspectValuesForVerification(executedAction),
                  skipLocalVision: true,
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
            } else if (createdTaskLeaseDuringRetry) {
              taskLease = undefined;
            }
          }
          if (!passedAfterRetry) {
            throw new Error(`Verification failed: ${verification.reason}`);
          }
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      if (trace.action?.approvalMode === "task_lease" || createdTaskLeaseThisStep || createdTaskLeaseDuringRetry) {
        taskLease = undefined;
      }
    }
    if (!error && canPrepareAutoCropAfterSuccess) {
      prepareAutoCrop();
    }
    if (error) {
      updateLocalVisionActionFailureState(localVisionState, observation.localVision, config.localVision, requestedAction);
      updateLocalVisionRuntimeTrace(trace, localVisionState);
    } else {
      localVisionState.consecutiveActionFailures = 0;
      updateLocalVisionRuntimeTrace(trace, localVisionState);
    }

    // 7. Record the step
    updateLocalVisionActionTrace(trace, observation.localVision, executedAction, error, requestedAction);
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
      pendingAutoCrop = undefined;
      if (/denied by user|permission denied/i.test(error)) {
        break;
      }
      if (isIrreversibleAction(executedAction) && isUnknownExecutionError(error)) {
        correctionHint = `Your last action (${executedAction.tool}) has unknown execution state due to timeout or IPC failure. DO NOT repeat this action — it may have already been executed. Instead, observe the current desktop state (screenshot + UIA) to verify whether the action took effect before deciding your next step.`;
      } else {
        correctionHint = `Your last action (${action.tool}) failed: ${error}. Try a different approach or a different target.`;
      }
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

  const normalizedMaxSteps = typeof maxSteps === "number" && Number.isFinite(maxSteps)
    ? Math.trunc(maxSteps)
    : 0;
  if (normalizedMaxSteps <= 0) return "";

  const recent = steps.slice(-normalizedMaxSteps);
  const lines = recent.map((step) => sanitizeStepForRecord(step)).map((step) => {
    const toolName = step.action.tool;
    const params = JSON.stringify(redactActionParamsForHistory(step.action));
    const resultStr = step.error
      ? `ERROR: ${step.error}`
      : step.result !== undefined
        ? `result: ${JSON.stringify(redactResultForHistory(step.result))}`
        : "";
    return truncateRecordedText(
      `Step ${step.stepIndex + 1}: saw "${step.observation}" → ${toolName}(${params}) ${resultStr}`.trim(),
      STEP_HISTORY_LINE_MAX_LENGTH,
    );
  });

  return `PREVIOUS STEPS (most recent ${recent.length}):\n${lines.join("\n")}`;
}

function redactActionParamsForHistory(action: ComputerUseAction): Record<string, unknown> {
  if (action.tool === "computer.type") {
    return {
      ...(redactResultForHistory(action.params) as typeof action.params),
      text: isRedactedTextPlaceholder(action.params.text)
        ? action.params.text
        : `[redacted:${action.params.text.length} chars]`,
    };
  }
  if (action.tool === "computer.setUiValue") {
    return {
      ...(redactResultForHistory(action.params) as typeof action.params),
      value: isRedactedTextPlaceholder(action.params.value)
        ? action.params.value
        : `[redacted:${action.params.value.length} chars]`,
    };
  }
  return redactResultForHistory(action.params) as Record<string, unknown>;
}

function isRedactedTextPlaceholder(value: string): boolean {
  return /^\[redacted:\d+ chars\]$/.test(value);
}

function containsImageDataUrl(value: string): boolean {
  IMAGE_DATA_URL_PATTERN.lastIndex = 0;
  const hasMatch = IMAGE_DATA_URL_PATTERN.test(value);
  IMAGE_DATA_URL_PATTERN.lastIndex = 0;
  return hasMatch;
}

function redactImageDataUrlsForRecord(value: string): string {
  IMAGE_DATA_URL_PATTERN.lastIndex = 0;
  const redacted = value.replace(IMAGE_DATA_URL_PATTERN, (match) => `[redacted:image data URL:${match.length} chars]`);
  IMAGE_DATA_URL_PATTERN.lastIndex = 0;
  return redacted;
}

function redactImageDataUrlFieldForRecord(value: string): string {
  const redacted = redactImageDataUrlsForRecord(value);
  return redacted === value
    ? `[redacted:image data URL:${value.length} chars]`
    : redacted;
}

function truncateRecordedText(value: string, maxLength = RECORDED_TEXT_MAX_LENGTH): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}\n...[truncated:${value.length - maxLength} chars]`;
}

function sanitizePromptInlineText(value: string | undefined, maxLength = PROMPT_INLINE_TEXT_MAX_LENGTH): string | undefined {
  if (!value) return undefined;
  const redacted = redactImageDataUrlsForRecord(value)
    .replace(/\s+/g, " ")
    .replace(/"/g, "'");
  const trimmed = redacted.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLength
    ? `${trimmed.slice(0, maxLength - 3)}...`
    : trimmed;
}

function sanitizePromptBlockText(value: string, maxLength: number): string {
  const redacted = redactImageDataUrlsForRecord(value);
  return redacted.length > maxLength
    ? `${redacted.slice(0, maxLength)}\n...`
    : redacted;
}

function redactResultForHistory(result: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof result === "string") {
    return truncateRecordedText(redactImageDataUrlsForRecord(result));
  }
  if (!result || typeof result !== "object") {
    return result;
  }
  if (seen.has(result)) {
    return "[redacted:circular]";
  }
  seen.add(result);
  if (Array.isArray(result)) {
    const entries = result
      .slice(0, RECORDED_ARRAY_MAX_ITEMS)
      .map((entry) => redactResultForHistory(entry, seen));
    if (result.length > RECORDED_ARRAY_MAX_ITEMS) {
      entries.push(`[truncated:${result.length - RECORDED_ARRAY_MAX_ITEMS} array items]`);
    }
    return entries;
  }
  const record = result as Record<string, unknown>;
  const redacted: Record<string, unknown> = {};
  const entries = Object.entries(record);
  for (const [key, value] of entries.slice(0, RECORDED_OBJECT_MAX_ENTRIES)) {
    const lowerKey = key.toLowerCase();
    if (typeof value === "string" && (lowerKey.endsWith("dataurl") || containsImageDataUrl(value))) {
      redacted[key] = truncateRecordedText(redactImageDataUrlFieldForRecord(value));
    } else if (lowerKey.includes("value") && typeof value === "string") {
      redacted[key] = `[redacted:${value.length} chars]`;
    } else if (key === "tree" && typeof value === "string") {
      redacted[key] = redactUiTreeValues(value);
    } else {
      redacted[key] = redactResultForHistory(value, seen);
    }
  }
  if (entries.length > RECORDED_OBJECT_MAX_ENTRIES) {
    redacted.__truncated = `${entries.length - RECORDED_OBJECT_MAX_ENTRIES} object fields`;
  }
  return redacted;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function sanitizeStepForRecord(step: ComputerUseStep): ComputerUseStep {
  return {
    ...step,
    screenshotDataUrl: "",
    observation: truncateRecordedText(redactImageDataUrlsForRecord(step.observation)),
    target: truncateRecordedText(redactImageDataUrlsForRecord(step.target)),
    action: sanitizeActionForRecord(step.action),
    result: sanitizeRecordedValue(step.result),
    trace: sanitizeRecordedValue(step.trace) as ComputerUseStepTrace | undefined,
    error: step.error ? truncateRecordedText(redactImageDataUrlsForRecord(step.error)) : undefined,
  };
}

function sanitizeActionForRecord(action: ComputerUseAction): ComputerUseAction {
  if (action.tool === "computer.type") {
    return {
      ...action,
      params: {
        ...(sanitizeRecordedValue(action.params) as typeof action.params),
        text: isRedactedTextPlaceholder(action.params.text)
          ? action.params.text
          : `[redacted:${action.params.text.length} chars]`,
      },
    };
  }
  if (action.tool === "computer.setUiValue") {
    return {
      ...action,
      params: {
        ...(sanitizeRecordedValue(action.params) as typeof action.params),
        value: isRedactedTextPlaceholder(action.params.value)
          ? action.params.value
          : `[redacted:${action.params.value.length} chars]`,
      },
    };
  }
  return {
    ...action,
    params: sanitizeRecordedValue(action.params) as ComputerUseAction["params"],
  } as ComputerUseAction;
}

function sanitizeRecordedValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    return truncateRecordedText(redactImageDataUrlsForRecord(value));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[redacted:circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const entries = value
      .slice(0, RECORDED_ARRAY_MAX_ITEMS)
      .map((entry) => sanitizeRecordedValue(entry, seen));
    if (value.length > RECORDED_ARRAY_MAX_ITEMS) {
      entries.push(`[truncated:${value.length - RECORDED_ARRAY_MAX_ITEMS} array items]`);
    }
    return entries;
  }
  const record = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  const entries = Object.entries(record);
  for (const [key, entry] of entries.slice(0, RECORDED_OBJECT_MAX_ENTRIES)) {
    const lowerKey = key.toLowerCase();
    const sanitizedKey = truncateRecordedText(redactImageDataUrlsForRecord(key), 240);
    if (
      typeof entry === "string" &&
      (containsImageDataUrl(entry) || lowerKey === "dataurl" || lowerKey.endsWith("dataurl"))
    ) {
      sanitized[sanitizedKey] = truncateRecordedText(redactImageDataUrlFieldForRecord(entry));
      continue;
    }
    if ((lowerKey === "text" || lowerKey === "value") && typeof entry === "string") {
      sanitized[sanitizedKey] = `[redacted:${entry.length} chars]`;
      continue;
    }
    if (key === "tree" && typeof entry === "string") {
      sanitized[sanitizedKey] = redactUiTreeValues(entry);
      continue;
    }
    sanitized[sanitizedKey] = sanitizeRecordedValue(entry, seen);
  }
  if (entries.length > RECORDED_OBJECT_MAX_ENTRIES) {
    sanitized.__truncated = `${entries.length - RECORDED_OBJECT_MAX_ENTRIES} object fields`;
  }
  return sanitized;
}

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
    visionSource?: ScreenshotVisionSource;
    screenshotUnavailableReason?: string;
    windowList?: ComputerListWindowsResult;
    uiContext?: UiPromptContext;
    localVision?: LocalVisionObservation;
  },
): string {
  const parts: string[] = [
    COMPUTER_USE_SYSTEM_PROMPT.en,
    `USER GOAL: ${sanitizePromptBlockText(userGoal, PROMPT_USER_GOAL_MAX_LENGTH)}`,
  ];
  if (screenshot.width !== undefined && screenshot.height !== undefined) {
    parts.push(
      `SCREENSHOT: ${screenshot.width}x${screenshot.height}. Coordinates start at (0,0) in the top-left corner; x increases right, y increases down.`,
    );
    if (screenshot.visionSource === "crop") {
      parts.push(
        "This is a cropped screenshot requested by a previous action. Output coordinates in this cropped image only; Javis maps them back to the original screen.",
      );
    }
  } else {
    parts.push(
      `SCREENSHOT: unavailable (${sanitizePromptInlineText(screenshot.screenshotUnavailableReason, PROMPT_INLINE_TEXT_MAX_LENGTH) ?? "unknown reason"}). Use WINDOWS/UIA context only; do not output coordinate mouse actions unless a later screenshot succeeds.`,
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
  const localVisionPromptContext = formatLocalVisionCandidates(screenshot.localVision);
  if (localVisionPromptContext) {
    parts.push(localVisionPromptContext);
  }

  const history = formatStepHistory(steps, historySteps);
  if (history) {
    parts.push(history);
  }

  if (correctionHint) {
    parts.push(`IMPORTANT: ${sanitizePromptBlockText(correctionHint, PROMPT_CORRECTION_HINT_MAX_LENGTH)}`);
  }

  parts.push(
    "Analyze the screenshot and output the single next action as JSON.",
  );

  return parts.join("\n\n");
}

interface LocalVisionObservation {
  observationId: string;
  screenshotId: string;
  enabled: boolean;
  used: boolean;
  skipRuntimeStateUpdate?: boolean;
  mode: "off" | "passive" | "prompt_hint" | "timeout" | "error" | "disabled" | "not_available";
  model?: string;
  configuredModel?: string;
  runtime?: string;
  reuseWorker?: boolean;
  imgsz?: number;
  timeoutMs?: number;
  latencyMs?: number;
  detections: ComputerUiDetection[];
  candidates: LocalUiCandidate[];
  promptCandidates: LocalUiCandidate[];
  diagnostics?: Record<string, unknown>;
  error?: string;
}

interface LocalVisionRuntimeState {
  consecutiveTimeouts: number;
  consecutiveErrors: number;
  consecutiveActionFailures: number;
  consecutiveSlowDetections: number;
  effectiveImgSize?: number;
  disabled: boolean;
  disabledReason?: "timeout" | "error" | "action_failure";
}

type LocalUiCandidateKind =
  | "possible_button"
  | "possible_input"
  | "possible_checkbox"
  | "possible_dropdown"
  | "possible_menu_item"
  | "possible_dialog"
  | "possible_icon"
  | "possible_table_cell"
  | "possible_link"
  | "unknown_region";

interface LocalUiCandidate {
  id: string;
  kind: LocalUiCandidateKind;
  box?: ComputerUiDetection["box"];
  center?: ComputerUiDetection["center"];
  text?: string;
  nearbyText?: string;
  score: number;
  evidence: {
    uia?: {
      windowHandle: number;
      controlType?: string;
      name?: string;
      automationId?: string;
      confidence: number;
    };
    yolo?: {
      detectionIds: string[];
      confidence: number;
    };
  };
  riskHint: "low" | "medium" | "high";
  executionMode?: "uia_only" | "uia_or_vlm_confirmed" | "user_confirmation_required" | "not_allowed";
  rankReason?: string;
}

type ComputerUseActionSelector = Extract<ComputerUseAction, { tool: "computer.invokeUi" }>["params"]["selector"];

interface UiPromptContext {
  windowHandle: number;
  title?: string;
  tree: string;
  nodeCount: number;
  freshAt: string;
  cacheHit?: boolean;
}

interface ComputerObservation {
  id: string;
  screenshot?: ComputerScreenshotResult;
  screenshotVisionSource?: ScreenshotVisionSource;
  screenshotId?: string;
  screenshotWindowHandle?: number;
  windowList?: ComputerListWindowsResult;
  uiContext?: UiPromptContext;
  localVision?: LocalVisionObservation;
  preferredUiWindowHandle?: number;
  coordinateTargetWindowHandle?: number;
  freshAt: string;
  error?: string;
  screenshotError?: string;
}

async function observeComputerState(options: {
  computerTool: ComputerTool;
  nextScreenshot: PendingScreenshotObservation | undefined;
  preferredUiWindowHandle: number | undefined;
  uiCache: Map<number, { context: UiPromptContext; expiresAt: number }>;
  config: ComputerUseLoopConfig;
  localVisionDetector: ComputerTool["detectUiObjects"];
  localVisionState: LocalVisionRuntimeState;
  signal: AbortSignal;
  bypassUiCache?: boolean;
  includeUiValues?: boolean;
  skipLocalVision?: boolean;
}): Promise<ComputerObservation> {
  const freshAt = new Date().toISOString();
  const observationId = createObservationId(freshAt);
  const screenshotPromise = options.nextScreenshot
    ? Promise.resolve(options.nextScreenshot.screenshot)
    : withTimeout(invokeTool(() => options.computerTool.screenshot({})), options.config.timeouts.screenshotMs, "computer.screenshot", options.signal);
  const screenshotVisionSource: ScreenshotVisionSource = options.nextScreenshot?.source ?? "full";
  const windowPromise = withTimeout(
    invokeTool(() => options.computerTool.listWindows({})),
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
  const earlyLocalVisionPromise = options.skipLocalVision
    ? Promise.resolve(undefined)
    : screenshotPromise
    .then((resolvedScreenshot) => {
      const resolvedScreenshotId = createScreenshotId(observationId, freshAt, resolvedScreenshot);
      if (screenshotVisionSource === "crop" && !options.localVisionState.disabled) {
        return createSkippedLocalVisionObservation({
          screenshotId: resolvedScreenshotId,
          observationId,
          config: options.config,
          error: "local vision skipped for cropped screenshot",
        });
      }
      return detectLocalVisionForObservation({
        screenshot: resolvedScreenshot,
        screenshotId: resolvedScreenshotId,
        observationId,
        windowHandle: options.preferredUiWindowHandle,
        detector: options.localVisionDetector,
        state: options.localVisionState,
        config: options.config,
        signal: options.signal,
      });
    })
    .catch(() => detectLocalVisionForObservation({
      screenshot: undefined,
      screenshotId: createScreenshotId(observationId, freshAt, undefined),
      observationId,
      windowHandle: options.preferredUiWindowHandle,
      detector: options.localVisionDetector,
      state: options.localVisionState,
      config: options.config,
      signal: options.signal,
    }));
  const [screenshotResult, windowResult, preferredUiResult] = await Promise.allSettled([
    screenshotPromise,
    windowPromise,
    preferredUiPromise ?? Promise.resolve(undefined),
  ]);

  const screenshot = screenshotResult.status === "fulfilled" ? screenshotResult.value : undefined;
  const windowList = windowResult.status === "fulfilled" ? windowResult.value : undefined;
  const preferredUiContext = preferredUiResult.status === "fulfilled" ? preferredUiResult.value : undefined;
  const screenshotId = createScreenshotId(observationId, freshAt, screenshot);
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
      failedMethod: options.nextScreenshot?.screenshot.methodUsed,
      config: options.config,
      signal: options.signal,
    });
    if (recoveredScreenshot) {
      const recoveredScreenshotId = createScreenshotId(observationId, freshAt, recoveredScreenshot);
      const [recoveredUiContext, recoveredLocalVision] = await Promise.all([
        preferredUiContext ?? getUiContext({
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
        options.skipLocalVision ? Promise.resolve(undefined) : detectLocalVisionForObservation({
          screenshot: recoveredScreenshot,
          screenshotId: recoveredScreenshotId,
          observationId,
          windowHandle: options.preferredUiWindowHandle,
          detector: options.localVisionDetector,
          state: options.localVisionState,
          config: options.config,
          signal: options.signal,
        }),
      ]);
  const fusedRecoveredLocalVision = fuseLocalVisionWithUiContext(
        recoveredLocalVision,
        recoveredUiContext,
        recoveredScreenshot,
        options.config.localVision,
      );
      return {
        screenshot: recoveredScreenshot,
        screenshotVisionSource: "full",
        id: observationId,
        screenshotId: recoveredScreenshotId,
        windowList,
        uiContext: recoveredUiContext,
        localVision: fusedRecoveredLocalVision,
        screenshotWindowHandle: options.preferredUiWindowHandle,
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
  const [uiContext, localVision] = await Promise.all([
    preferredUiContext ?? getUiContext({
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
    earlyLocalVisionPromise,
  ]);
  const fusedLocalVision = fuseLocalVisionWithUiContext(
    localVision,
    uiContext,
    screenshot,
    options.config.localVision,
  );

  return {
    screenshot,
    screenshotVisionSource: screenshot ? screenshotVisionSource : undefined,
    screenshotWindowHandle: screenshot ? options.nextScreenshot?.windowHandle : undefined,
    id: observationId,
    screenshotId,
    windowList,
    uiContext,
    localVision: fusedLocalVision,
    preferredUiWindowHandle: options.preferredUiWindowHandle,
    coordinateTargetWindowHandle,
    freshAt,
    error: screenshot || windowList || uiContext ? undefined : screenshotError,
    screenshotError,
  };
}

function normalizeComputerUseLoopConfig(
  input: ComputerUseLoopOptions["config"],
): ComputerUseLoopConfig {
  const mergedLocalVision = {
    ...DEFAULT_COMPUTER_USE_CONFIG.localVision,
    ...input?.localVision,
  };
  const timeouts = normalizeTimeouts(input?.timeouts);
  return {
    ...DEFAULT_COMPUTER_USE_CONFIG,
    ...input,
    maxSteps: clampInteger(
      input?.maxSteps,
      1,
      MAX_COMPUTER_USE_STEPS,
      DEFAULT_COMPUTER_USE_CONFIG.maxSteps,
    ),
    historySteps: clampInteger(
      input?.historySteps,
      0,
      MAX_COMPUTER_USE_HISTORY_STEPS,
      DEFAULT_COMPUTER_USE_CONFIG.historySteps,
    ),
    stepDeadlineMs: normalizeStepDeadlineMs(input, timeouts),
    heartbeatMs: clampInteger(
      input?.heartbeatMs,
      0,
      5_000,
      DEFAULT_COMPUTER_USE_CONFIG.heartbeatMs,
    ),
    uiCacheMs: clampInteger(
      input?.uiCacheMs,
      0,
      60_000,
      DEFAULT_COMPUTER_USE_CONFIG.uiCacheMs,
    ),
    mouseSpeed: normalizeMouseSpeed(input?.mouseSpeed),
    mouseDurationMs: clampInteger(
      input?.mouseDurationMs,
      0,
      1_000,
      DEFAULT_COMPUTER_USE_CONFIG.mouseDurationMs,
    ),
    typeDelayMs: clampInteger(
      input?.typeDelayMs,
      0,
      500,
      DEFAULT_COMPUTER_USE_CONFIG.typeDelayMs,
    ),
    deniedWindowPatterns: normalizeDeniedWindowPatterns(input?.deniedWindowPatterns),
    timeouts,
    localVision: normalizeLocalVisionConfig(mergedLocalVision),
  };
}

function normalizeMouseSpeed(value: unknown): ComputerUseLoopConfig["mouseSpeed"] {
  return value === "linear" ? "linear" : "instant";
}

function normalizeDeniedWindowPatterns(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const output: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const normalized = item.replace(/\s+/g, " ").trim().slice(0, 120);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
    if (output.length >= 32) break;
  }
  return output;
}

function normalizeTimeouts(
  input: NonNullable<ComputerUseLoopOptions["config"]>["timeouts"] | undefined,
): ComputerUseLoopConfig["timeouts"] {
  const merged = {
    ...DEFAULT_COMPUTER_USE_CONFIG.timeouts,
    ...(input ?? {}),
  };
  return {
    listWindowsMs: clampTimeout("listWindowsMs", merged.listWindowsMs),
    inspectUiMs: clampTimeout("inspectUiMs", merged.inspectUiMs),
    screenshotMs: clampTimeout("screenshotMs", merged.screenshotMs),
    lowRiskWriteMs: clampTimeout("lowRiskWriteMs", merged.lowRiskWriteMs),
    textWriteMs: clampTimeout("textWriteMs", merged.textWriteMs),
    modelMs: clampTimeout("modelMs", merged.modelMs),
    approvalMs: clampTimeout("approvalMs", merged.approvalMs),
    verificationMs: clampTimeout("verificationMs", merged.verificationMs),
  };
}

function clampTimeout(
  key: keyof ComputerUseLoopConfig["timeouts"],
  value: unknown,
): number {
  const limits = TIMEOUT_LIMITS[key];
  return clampInteger(value, limits.min, limits.max, DEFAULT_COMPUTER_USE_CONFIG.timeouts[key]);
}

function normalizeStepDeadlineMs(
  input: ComputerUseLoopOptions["config"],
  timeouts: ComputerUseLoopConfig["timeouts"],
): number {
  const observationBudget = Math.max(
    timeouts.screenshotMs,
    timeouts.listWindowsMs,
    timeouts.inspectUiMs,
  );
  const actionBudget = Math.max(
    timeouts.lowRiskWriteMs,
    timeouts.textWriteMs,
    timeouts.screenshotMs,
    timeouts.listWindowsMs,
    timeouts.inspectUiMs,
  );
  const computedDeadline = Math.max(
    DEFAULT_COMPUTER_USE_CONFIG.stepDeadlineMs,
    observationBudget + timeouts.modelMs + timeouts.approvalMs + actionBudget + timeouts.verificationMs + 1_000,
  );
  return clampInteger(input?.stepDeadlineMs, 250, MAX_STEP_DEADLINE_MS, computedDeadline);
}

function normalizeLocalVisionConfig(
  input: ComputerUseLoopConfig["localVision"],
): ComputerUseLoopConfig["localVision"] {
  const mode = input.mode === "passive" || input.mode === "prompt_hint" ? input.mode : "off";
  const modelPath = typeof input.modelPath === "string" ? sanitizeLocalVisionPathInput(input.modelPath) : "";
  const enabled = input.enabled === true && mode !== "off" && modelPath.length > 0;
  const runtimeAdapterPath = typeof input.runtimeAdapterPath === "string" ? sanitizeLocalVisionPathInput(input.runtimeAdapterPath) : "";
  return {
    enabled,
    mode: enabled ? mode : "off",
    modelPath: modelPath || undefined,
    runtime: normalizeLocalVisionRuntime(input.runtime),
    runtimeAdapterPath: runtimeAdapterPath || undefined,
    reuseWorker: input.reuseWorker === true,
    imgsz: clampInteger(input.imgsz, 320, 1280, DEFAULT_COMPUTER_USE_CONFIG.localVision.imgsz),
    timeoutMs: clampInteger(input.timeoutMs, 20, 2_000, DEFAULT_COMPUTER_USE_CONFIG.localVision.timeoutMs),
    maxDetections: clampInteger(input.maxDetections, 1, 100, DEFAULT_COMPUTER_USE_CONFIG.localVision.maxDetections),
    promptTopK: clampInteger(input.promptTopK, 0, 20, DEFAULT_COMPUTER_USE_CONFIG.localVision.promptTopK),
    minConfidence: clampNumber(input.minConfidence, 0, 1, DEFAULT_COMPUTER_USE_CONFIG.localVision.minConfidence),
    iouThreshold: normalizeIouThreshold(input.iouThreshold),
    labelMap: sanitizeLocalVisionLabelMap(input.labelMap),
    disableAfterConsecutiveTimeouts: clampInteger(
      input.disableAfterConsecutiveTimeouts,
      0,
      10,
      DEFAULT_COMPUTER_USE_CONFIG.localVision.disableAfterConsecutiveTimeouts,
    ),
    disableAfterConsecutiveErrors: clampInteger(
      input.disableAfterConsecutiveErrors,
      0,
      10,
      DEFAULT_COMPUTER_USE_CONFIG.localVision.disableAfterConsecutiveErrors,
    ),
    disableAfterConsecutiveActionFailures: clampInteger(
      input.disableAfterConsecutiveActionFailures,
      0,
      10,
      DEFAULT_COMPUTER_USE_CONFIG.localVision.disableAfterConsecutiveActionFailures,
    ),
  };
}

function normalizeLocalVisionRuntime(value: unknown): ComputerUseLoopConfig["localVision"]["runtime"] {
  return value === "onnxruntime" || value === "openvino" || value === "tensorrt" ? value : "auto";
}

function effectiveLocalVisionImgSize(
  state: LocalVisionRuntimeState,
  config: ComputerUseLoopConfig["localVision"],
): number {
  return clampLocalVisionImgSize(state.effectiveImgSize ?? config.imgsz);
}

function clampLocalVisionImgSize(value: number): number {
  return Math.min(1280, Math.max(320, Math.trunc(value)));
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const numberValue = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, numberValue));
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numberValue = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, numberValue));
}

function normalizeIouThreshold(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : DEFAULT_COMPUTER_USE_CONFIG.localVision.iouThreshold;
}

function sanitizeLocalVisionLabelMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 256)) {
    if (typeof entry !== "string") continue;
    const normalizedKey = sanitizeLocalVisionLabelMapText(key, 32);
    const normalizedValue = sanitizeLocalVisionLabelMapText(entry, 80);
    if (normalizedKey && normalizedValue) {
      output[normalizedKey] = normalizedValue;
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function sanitizeLocalVisionLabelMapText(value: string, maxLength: number): string {
  return sanitizeLocalVisionText(value.trim(), maxLength);
}

function sanitizeLocalVisionPathInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || LOCAL_VISION_IMAGE_DATA_URL_PATTERN.test(trimmed)) {
    return "";
  }
  return trimmed.slice(0, LOCAL_VISION_PATH_INPUT_MAX_LENGTH);
}

function autoCropOptionalWaitMs(config: ComputerUseLoopConfig): number {
  return Math.max(
    1,
    Math.min(
      config.timeouts.screenshotMs,
      config.localVision.timeoutMs,
      AUTO_CROP_OPTIONAL_WAIT_MAX_MS,
    ),
  );
}

function localVisionObserveWaitMs(config: ComputerUseLoopConfig): number {
  return Math.max(1, Math.min(config.localVision.timeoutMs, LOCAL_VISION_OBSERVE_WAIT_MAX_MS));
}

async function detectLocalVisionForObservation(
  options: Parameters<typeof detectLocalVision>[0],
): Promise<LocalVisionObservation | undefined> {
  const { localVision } = options.config;
  if (!localVision.enabled || localVision.mode === "off") {
    return undefined;
  }
  const waitMs = localVisionObserveWaitMs(options.config);
  const controller = createLocalVisionObserveAbortController(options.signal, waitMs);
  try {
    return await detectLocalVision({
      ...options,
      signal: controller.signal,
      timeoutMsOverride: waitMs,
    });
  } finally {
    controller.dispose();
  }
}

function createLocalVisionObserveAbortController(parentSignal: AbortSignal, waitMs: number) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error(`local vision observe wait timed out after ${waitMs}ms`));
  }, waitMs);
  const abortFromParent = () => controller.abort(parentSignal.reason ?? new Error("Computer Use cancelled."));
  if (parentSignal.aborted) {
    abortFromParent();
  } else {
    parentSignal.addEventListener("abort", abortFromParent, { once: true });
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeoutId);
      parentSignal.removeEventListener("abort", abortFromParent);
    },
  };
}

function createObservationId(freshAt: string): string {
  observationIdSequence += 1;
  return `obs_${freshAt}_${observationIdSequence}`;
}

function createScreenshotId(
  observationId: string,
  freshAt: string,
  screenshot: ComputerScreenshotResult | undefined,
): string {
  const capturedAt = screenshot?.capturedAt ?? freshAt;
  const size = screenshot ? `${screenshot.width}x${screenshot.height}` : "unavailable";
  const source = screenshot
    ? `${screenshot.sourceOriginX ?? 0},${screenshot.sourceOriginY ?? 0},${screenshot.sourceWidth ?? screenshot.width}x${screenshot.sourceHeight ?? screenshot.height},${screenshot.scaleX ?? 1},${screenshot.scaleY ?? 1},${screenshot.methodUsed ?? "unknown"}`
    : "unavailable";
  return `shot_${observationId}_${freshAt}_${capturedAt}_${size}_${source}`;
}

function createSkippedLocalVisionObservation(options: {
  screenshotId: string;
  observationId: string;
  config: ComputerUseLoopConfig;
  error: string;
}): LocalVisionObservation | undefined {
  const { localVision } = options.config;
  if (!localVision.enabled || localVision.mode === "off") {
    return undefined;
  }
  return {
    screenshotId: options.screenshotId,
    observationId: options.observationId,
    enabled: true,
    used: false,
    skipRuntimeStateUpdate: true,
    mode: "disabled",
    detections: [],
    candidates: [],
    promptCandidates: [],
    timeoutMs: options.config.localVision.timeoutMs,
    error: options.error,
  };
}

async function detectLocalVision(options: {
  screenshot: ComputerScreenshotResult | undefined;
  screenshotId: string;
  observationId: string;
  windowHandle: number | undefined;
  detector: ComputerTool["detectUiObjects"];
  state: LocalVisionRuntimeState;
  config: ComputerUseLoopConfig;
  signal: AbortSignal;
  timeoutMsOverride?: number;
}): Promise<LocalVisionObservation | undefined> {
  const { localVision } = options.config;
  const detectionTimeoutMs = options.timeoutMsOverride ?? localVision.timeoutMs;
  const effectiveImgSize = effectiveLocalVisionImgSize(options.state, localVision);
  const configuredModel = sanitizeLocalVisionModelName(localVision.modelPath);
  if (!localVision.enabled || localVision.mode === "off") {
    return undefined;
  }
  if (options.state.disabled) {
    const error = localVisionDisabledReason(options.state);
    return {
      screenshotId: options.screenshotId,
      observationId: options.observationId,
      enabled: true,
      used: false,
      mode: "disabled",
      configuredModel,
      reuseWorker: localVision.reuseWorker,
      imgsz: effectiveImgSize,
      timeoutMs: detectionTimeoutMs,
      detections: [],
      candidates: [],
      promptCandidates: [],
      error,
    };
  }
  if (!options.screenshot) {
    return {
      screenshotId: options.screenshotId,
      observationId: options.observationId,
      enabled: true,
      used: false,
      mode: "disabled",
      configuredModel,
      reuseWorker: localVision.reuseWorker,
      imgsz: effectiveImgSize,
      timeoutMs: detectionTimeoutMs,
      detections: [],
      candidates: [],
      promptCandidates: [],
      error: "screenshot unavailable",
    };
  }
  if (!options.detector) {
    return {
      screenshotId: options.screenshotId,
      observationId: options.observationId,
      enabled: true,
      used: false,
      mode: "not_available",
      configuredModel,
      reuseWorker: localVision.reuseWorker,
      imgsz: effectiveImgSize,
      timeoutMs: detectionTimeoutMs,
      detections: [],
      candidates: [],
      promptCandidates: [],
      error: "local vision detector is not available",
    };
  }
  if (!localVision.modelPath?.trim()) {
    return {
      screenshotId: options.screenshotId,
      observationId: options.observationId,
      enabled: true,
      used: false,
      mode: "not_available",
      configuredModel,
      reuseWorker: localVision.reuseWorker,
      imgsz: effectiveImgSize,
      timeoutMs: detectionTimeoutMs,
      detections: [],
      candidates: [],
      promptCandidates: [],
      error: "local vision modelPath is not configured",
    };
  }

  try {
    const result = await withTimeout(
      Promise.resolve(options.detector({
        imageDataUrl: options.screenshot.dataUrl,
        screenshotId: options.screenshotId,
        observationId: options.observationId,
        windowHandle: options.windowHandle,
        modelPath: localVision.modelPath,
        runtime: localVision.runtime,
        runtimeAdapterPath: localVision.runtimeAdapterPath,
        reuseWorker: localVision.reuseWorker,
        imgsz: effectiveImgSize,
        maxDetections: localVision.maxDetections,
        minConfidence: localVision.minConfidence,
        iouThreshold: localVision.iouThreshold,
        timeoutMs: detectionTimeoutMs,
        labelMap: localVision.labelMap,
      })),
      detectionTimeoutMs,
      "computer.detectUiObjects",
      options.signal,
    );
    if (result.screenshotId !== options.screenshotId) {
      return {
        screenshotId: options.screenshotId,
        observationId: options.observationId,
        enabled: true,
        used: false,
        mode: "disabled",
        model: result.model,
        configuredModel,
        runtime: result.runtime,
        reuseWorker: localVision.reuseWorker,
        imgsz: effectiveImgSize,
        timeoutMs: detectionTimeoutMs,
        latencyMs: result.latencyMs,
        detections: [],
        candidates: [],
        promptCandidates: [],
        diagnostics: sanitizeLocalVisionDiagnostics(result.diagnostics),
        error: sanitizeLocalVisionText(`discarded stale local vision result for ${result.screenshotId}`),
      };
    }
    if (result.timedOut) {
      return {
        screenshotId: options.screenshotId,
        observationId: options.observationId,
        enabled: true,
        used: false,
        mode: "timeout",
        model: result.model,
        configuredModel,
        runtime: result.runtime,
        reuseWorker: localVision.reuseWorker,
        imgsz: effectiveImgSize,
        timeoutMs: detectionTimeoutMs,
        latencyMs: result.latencyMs,
        detections: [],
        candidates: [],
        promptCandidates: [],
        diagnostics: sanitizeLocalVisionDiagnostics(result.diagnostics),
        error: sanitizeLocalVisionError(result.error),
      };
    }
    if (result.error) {
      return {
        screenshotId: options.screenshotId,
        observationId: options.observationId,
        enabled: true,
        used: false,
        mode: "error",
        model: result.model,
        configuredModel,
        runtime: result.runtime,
        reuseWorker: localVision.reuseWorker,
        imgsz: effectiveImgSize,
        timeoutMs: detectionTimeoutMs,
        latencyMs: result.latencyMs,
        detections: [],
        candidates: [],
        promptCandidates: [],
        diagnostics: sanitizeLocalVisionDiagnostics(result.diagnostics),
        error: sanitizeLocalVisionError(result.error),
      };
    }
    const detections = sanitizeLocalVisionDetections(
      result,
      options.screenshot,
      localVision.maxDetections,
      localVision.minConfidence,
    );
    const canUseUiCandidates = canUseLocalVisionModelForUiCandidates(result.model, localVision.modelPath);
    const candidates = canUseUiCandidates
      ? buildUiCandidatesFromDetections(detections)
      : [];
    return {
      screenshotId: options.screenshotId,
      observationId: options.observationId,
      enabled: true,
      used: canUseUiCandidates && detections.length > 0,
      mode: result.timedOut ? "timeout" : localVision.mode,
      model: result.model,
      configuredModel,
      runtime: result.runtime,
      reuseWorker: localVision.reuseWorker,
      imgsz: effectiveImgSize,
      timeoutMs: detectionTimeoutMs,
      latencyMs: result.latencyMs,
      detections,
      candidates,
      promptCandidates: canUseUiCandidates && localVision.mode === "prompt_hint"
        ? selectPromptCandidates(candidates, localVision.minConfidence, localVision.promptTopK)
        : [],
      diagnostics: sanitizeLocalVisionDiagnostics(result.diagnostics),
      error: sanitizeLocalVisionError(result.error),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      screenshotId: options.screenshotId,
      observationId: options.observationId,
      enabled: true,
      used: false,
      mode: /timed out/i.test(message) ? "timeout" : "error",
      configuredModel,
      reuseWorker: localVision.reuseWorker,
      imgsz: effectiveImgSize,
      timeoutMs: detectionTimeoutMs,
      detections: [],
      candidates: [],
      promptCandidates: [],
      error: sanitizeLocalVisionText(message),
    };
  }
}

function sanitizeLocalVisionDiagnostics(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 24)) {
    const sanitized = sanitizeLocalVisionDiagnosticValue(entry, depth + 1);
    if (sanitized !== undefined) {
      output[sanitizeLocalVisionDiagnosticKey(key)] = sanitized;
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function sanitizeLocalVisionModelName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = redactImageDataUrlsForRecord(value.trim());
  if (!trimmed) return undefined;
  const filename = trimmed.replace(/\\/g, "/").split("/").filter(Boolean).pop();
  return (filename || "[redacted local path]").slice(0, 160);
}

function canUseLocalVisionModelForUiCandidates(...models: Array<string | undefined>): boolean {
  return models.every((model) =>
    localVisionModelPurposeWarning(sanitizeLocalVisionModelName(model)) === undefined
  );
}

function sanitizeLocalVisionError(value: string | undefined): string | undefined {
  return value ? sanitizeLocalVisionText(value, 320) : undefined;
}

function sanitizeLocalVisionText(value: string, maxLength = 160): string {
  const redacted = redactImageDataUrlsForRecord(redactLocalVisionPaths(value));
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength - 3)}...` : redacted;
}

function redactLocalVisionPaths(value: string): string {
  LOCAL_VISION_PATH_PATTERN.lastIndex = 0;
  const redacted = value.replace(LOCAL_VISION_PATH_PATTERN, (match) => {
    const { path, suffix } = splitLocalVisionPathMatch(match);
    const filename = localVisionPathFilename(path);
    const redaction = filename ? `[redacted local path:${filename}]` : "[redacted local path]";
    return `${redaction}${suffix}`;
  });
  LOCAL_VISION_PATH_PATTERN.lastIndex = 0;
  return redacted;
}

function splitLocalVisionPathMatch(match: string): { path: string; suffix: string } {
  const lower = match.toLowerCase();
  let end = match.length;
  for (const extension of LOCAL_VISION_PATH_EXTENSIONS) {
    const extensionEnd = lower.lastIndexOf(extension);
    if (extensionEnd < 0) continue;
    const candidateEnd = extensionEnd + extension.length;
    if (!/[\\/]/.test(match.slice(candidateEnd)) && candidateEnd < end) {
      end = candidateEnd;
    }
  }
  while (end > 0 && /[)\]}.;:,]/.test(match[end - 1] ?? "")) {
    end -= 1;
  }
  return {
    path: match.slice(0, end),
    suffix: match.slice(end),
  };
}

function localVisionPathFilename(value: string): string | undefined {
  const normalized = value
    .replace(/^file:\/\/\/?/i, "")
    .replace(/\\/g, "/")
    .replace(/[)\]}.;:,]+$/g, "");
  return normalized.split("/").filter(Boolean).pop();
}

function sanitizeLocalVisionDiagnosticKey(value: string): string {
  if (containsImageDataUrl(value)) {
    return "[redacted image key]";
  }
  return sanitizeLocalVisionText(value, 80);
}

function sanitizeLocalVisionDiagnosticValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined || depth > 3) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (containsImageDataUrl(value)) {
      return "[redacted image data]";
    }
    return sanitizeLocalVisionText(value, 160);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 24)
      .map((entry) => sanitizeLocalVisionDiagnosticValue(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }
  if (typeof value === "object") {
    return sanitizeLocalVisionDiagnostics(value, depth);
  }
  return undefined;
}

function sanitizeLocalVisionDetections(
  result: ComputerDetectUiObjectsResult,
  screenshot: ComputerScreenshotResult,
  maxDetections: number,
  minConfidence: number,
): ComputerUiDetection[] {
  return result.detections
    .filter((detection) =>
      Number.isFinite(detection.confidence) &&
      detection.confidence >= minConfidence &&
      detection.box.coordinateSpace === "screenshot" &&
      detection.center.coordinateSpace === "screenshot" &&
      isFiniteDetectionBox(detection.box) &&
      isFiniteDetectionPoint(detection.center) &&
      detectionCenterInsideScreenshot(detection, screenshot) &&
      detectionBoxOverlapsScreenshot(detection.box, screenshot)
    )
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, Math.max(maxDetections, 0))
    .map((detection, index) => ({
      ...detection,
      id: sanitizeLocalVisionDetectionText(detection.id, 120) || `det_${index + 1}`,
      label: sanitizeLocalVisionDetectionText(detection.label, 120) || "unknown_region",
      box: clampDetectionBoxToScreenshot(detection.box, screenshot),
    }))
    .filter((detection) => isFiniteDetectionBox(detection.box));
}

function sanitizeLocalVisionDetectionText(value: string, maxLength: number): string {
  return sanitizeLocalVisionText(value.trim(), maxLength);
}

function isFiniteDetectionBox(box: ComputerUiDetection["box"]): boolean {
  return Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height) &&
    box.width > 0 &&
    box.height > 0;
}

function isFiniteDetectionPoint(point: ComputerUiDetection["center"]): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function detectionCenterInsideScreenshot(
  detection: ComputerUiDetection,
  screenshot: ComputerScreenshotResult,
): boolean {
  return detection.center.x >= 0 &&
    detection.center.y >= 0 &&
    detection.center.x <= screenshot.width &&
    detection.center.y <= screenshot.height;
}

function detectionBoxOverlapsScreenshot(
  box: ComputerUiDetection["box"],
  screenshot: ComputerScreenshotResult,
): boolean {
  return box.x < screenshot.width &&
    box.y < screenshot.height &&
    box.x + box.width > 0 &&
    box.y + box.height > 0;
}

function clampDetectionBoxToScreenshot(
  box: ComputerUiDetection["box"],
  screenshot: ComputerScreenshotResult,
): ComputerUiDetection["box"] {
  const x = Math.max(0, Math.min(screenshot.width, box.x));
  const y = Math.max(0, Math.min(screenshot.height, box.y));
  const right = Math.max(x, Math.min(screenshot.width, box.x + box.width));
  const bottom = Math.max(y, Math.min(screenshot.height, box.y + box.height));
  return {
    ...box,
    x,
    y,
    width: right - x,
    height: bottom - y,
    screenshotSize: {
      width: screenshot.width,
      height: screenshot.height,
    },
  };
}

function mapScreenRectToScreenshotBox(
  rect: { x: number; y: number; width: number; height: number },
  screenshot: ComputerScreenshotResult,
  windowHandle: number,
): ComputerUiDetection["box"] | undefined {
  const scaleX = positiveNumberOrDefault(screenshot.scaleX, 1);
  const scaleY = positiveNumberOrDefault(screenshot.scaleY, 1);
  const originX = finiteNumberOrDefault(screenshot.sourceOriginX, 0);
  const originY = finiteNumberOrDefault(screenshot.sourceOriginY, 0);
  const x = (rect.x - originX) * scaleX;
  const y = (rect.y - originY) * scaleY;
  const width = rect.width * scaleX;
  const height = rect.height * scaleY;
  const box: ComputerUiDetection["box"] = {
    x,
    y,
    width,
    height,
    coordinateSpace: "screenshot",
    screenshotSize: {
      width: screenshot.width,
      height: screenshot.height,
    },
    windowHandle,
  };
  if (!isFiniteDetectionBox(box) || !detectionBoxOverlapsScreenshot(box, screenshot)) {
    return undefined;
  }
  return clampDetectionBoxToScreenshot(box, screenshot);
}

function buildUiCandidatesFromDetections(detections: ComputerUiDetection[]): LocalUiCandidate[] {
  return detections
    .map((detection): LocalUiCandidate => ({
      id: `candidate_${detection.id}`,
      kind: mapDetectionLabelToCandidateKind(detection.label),
      box: detection.box,
      center: detection.center,
      text: detection.label,
      score: detection.confidence,
      evidence: {
        yolo: {
          detectionIds: [detection.id],
          confidence: detection.confidence,
        },
      },
      riskHint: riskHintForDetectionLabel(detection.label),
    }))
    .map(applyExecutionPolicy)
    .sort((left, right) => right.score - left.score);
}

function mapDetectionLabelToCandidateKind(label: string): LocalUiCandidateKind {
  const normalized = label.toLowerCase().replace(/[\s-]+/g, "_");
  switch (normalized) {
    case "button":
    case "possible_button":
      return "possible_button";
    case "input":
    case "text_input":
    case "possible_input":
    case "possible_text_area":
      return "possible_input";
    case "checkbox":
    case "possible_checkbox":
      return "possible_checkbox";
    case "radio":
      return "possible_checkbox";
    case "dropdown":
    case "possible_dropdown":
      return "possible_dropdown";
    case "menu":
    case "menu_item":
    case "possible_menu_item":
      return "possible_menu_item";
    case "dialog":
    case "modal":
    case "possible_dialog":
      return "possible_dialog";
    case "icon":
    case "possible_icon":
      return "possible_icon";
    case "table_cell":
    case "possible_table_cell":
      return "possible_table_cell";
    case "link":
    case "possible_link":
      return "possible_link";
    default:
      return "unknown_region";
  }
}

const LOCAL_VISION_HIGH_RISK_TEXT_PATTERN =
  /dialog|modal|submit|delete|remove|pay|purchase|overwrite|send|publish|install|grant|permission|password|token|secret|credential|删除|移除|付款|支付|购买|转账|提交|发送|发布|覆盖|安装|授权|权限|密码|令牌|密钥|凭据|凭证/i;

function riskHintForDetectionLabel(label: string): "low" | "medium" | "high" {
  if (LOCAL_VISION_HIGH_RISK_TEXT_PATTERN.test(label)) {
    return "high";
  }
  const normalized = label.toLowerCase();
  if (/input|text|dropdown|table/.test(normalized)) {
    return "medium";
  }
  return "low";
}

function selectPromptCandidates(
  candidates: LocalUiCandidate[],
  minConfidence: number,
  promptTopK: number,
): LocalUiCandidate[] {
  return candidates
    .filter((candidate) => candidate.score >= minConfidence && candidate.evidence.yolo)
    .map(rankPromptCandidate)
    .sort((left, right) => right.promptRankScore - left.promptRankScore)
    .map(({ promptRankScore: _promptRankScore, ...candidate }) => candidate)
    .slice(0, Math.max(promptTopK, 0));
}

function selectAutoCropCandidate(options: {
  userGoal: string;
  screenshot: ComputerScreenshotResult;
  localVision: LocalVisionObservation | undefined;
}): { candidate: LocalUiCandidate; region: ComputerScreenshotRegion; reason: string } | undefined {
  const localVision = options.localVision;
  if (
    !localVision ||
    localVision.mode !== "prompt_hint" ||
    localVision.promptCandidates.length === 0
  ) {
    return undefined;
  }
  const goalText = normalizeMatchText(options.userGoal);
  if (!goalText) return undefined;
  for (const candidate of localVision.promptCandidates) {
    const region = candidate.box
      ? paddedScreenshotRegion(candidate.box, options.screenshot, AUTO_CROP_PADDING_PX)
      : undefined;
    if (
      !region ||
      candidate.riskHint === "high" ||
      candidate.score < AUTO_CROP_MIN_SCORE ||
      !candidateMatchesGoal(candidate, goalText) ||
      isOversizedCrop(region, options.screenshot, AUTO_CROP_MAX_AREA_RATIO)
    ) {
      continue;
    }
    const source = candidate.evidence.uia && candidate.evidence.yolo
      ? "uia+yolo"
      : candidate.evidence.uia
        ? "uia"
        : "yolo";
    return {
      candidate,
      region,
      reason: `auto crop for ${source} candidate ${candidate.id}`,
    };
  }
  return undefined;
}

function candidateMatchesGoal(candidate: LocalUiCandidate, normalizedGoal: string): boolean {
  return candidateMatchTokens(candidate).some((token) =>
    token.length >= 3 && (normalizedGoal.includes(token) || token.includes(normalizedGoal))
  );
}

function paddedScreenshotRegion(
  box: ComputerUiDetection["box"],
  screenshot: ComputerScreenshotResult,
  padding: number,
): ComputerScreenshotRegion | undefined {
  const x = Math.max(0, Math.floor(box.x - padding));
  const y = Math.max(0, Math.floor(box.y - padding));
  const right = Math.min(screenshot.width, Math.ceil(box.x + box.width + padding));
  const bottom = Math.min(screenshot.height, Math.ceil(box.y + box.height + padding));
  const width = right - x;
  const height = bottom - y;
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}

function isOversizedCrop(
  region: ComputerScreenshotRegion,
  screenshot: ComputerScreenshotResult,
  maxAreaRatio: number,
): boolean {
  const screenshotArea = screenshot.width * screenshot.height;
  if (screenshotArea <= 0) return true;
  return (region.width * region.height) / screenshotArea > maxAreaRatio;
}

async function captureAutoCropScreenshot(options: {
  computerTool: ComputerTool;
  windowHandle: number | undefined;
  region: ComputerScreenshotRegion;
  config: ComputerUseLoopConfig;
  signal: AbortSignal;
}): Promise<PendingScreenshotObservation | undefined> {
  try {
    const screenshot = await withTimeout(
      invokeTool(() => options.computerTool.screenshot({
        ...(options.windowHandle === undefined ? {} : { windowHandle: options.windowHandle }),
        region: options.region,
        method: "auto",
      })),
      options.config.timeouts.screenshotMs,
      "computer.screenshot.autoCrop",
      options.signal,
    );
    return { screenshot, source: "crop", windowHandle: options.windowHandle };
  } catch {
    return undefined;
  }
}

function rankPromptCandidate(candidate: LocalUiCandidate): LocalUiCandidate & { promptRankScore: number } {
  const policyCandidate = applyExecutionPolicy(candidate);
  const hasUia = Boolean(policyCandidate.evidence.uia);
  const hasYolo = Boolean(policyCandidate.evidence.yolo);
  const sourceCount = localVisionCandidateSources(policyCandidate).length;
  const riskPenalty = policyCandidate.riskHint === "high" ? 0.18 : policyCandidate.riskHint === "medium" ? 0.06 : 0;
  const evidenceBoost = hasUia && hasYolo ? 0.36 : hasUia ? 0.2 : 0;
  const yoloOnlyPenalty = hasYolo && !hasUia ? 0.18 : 0;
  return {
    ...policyCandidate,
    rankReason: rankReasonForCandidate(policyCandidate, sourceCount),
    promptRankScore: policyCandidate.score + evidenceBoost - riskPenalty - yoloOnlyPenalty,
  };
}

function applyExecutionPolicy(candidate: LocalUiCandidate): LocalUiCandidate {
  const sourceCount = localVisionCandidateSources(candidate).length;
  return {
    ...candidate,
    executionMode: executionModeForCandidate(candidate),
    rankReason: rankReasonForCandidate(candidate, sourceCount),
  };
}

function executionModeForCandidate(candidate: LocalUiCandidate): NonNullable<LocalUiCandidate["executionMode"]> {
  if (candidate.riskHint === "high") {
    return candidate.evidence.uia ? "user_confirmation_required" : "not_allowed";
  }
  if (candidate.evidence.uia) {
    return candidate.evidence.yolo ? "uia_or_vlm_confirmed" : "uia_only";
  }
  if (candidate.evidence.yolo) {
    return "user_confirmation_required";
  }
  return "uia_or_vlm_confirmed";
}

function rankReasonForCandidate(candidate: LocalUiCandidate, sourceCount: number): string {
  if (candidate.evidence.uia && candidate.evidence.yolo) {
    return "uia+yolo evidence; prefer selector for execution";
  }
  if (candidate.evidence.uia) {
    return "uia evidence; selector-capable candidate";
  }
  if (candidate.evidence.yolo) {
    return sourceCount > 1
      ? "visual candidate with supporting evidence"
      : "yolo-only visual region; coordinate hint requires confirmation";
  }
  return "weak candidate; verify before action";
}

function fuseLocalVisionWithUiContext(
  localVision: LocalVisionObservation | undefined,
  uiContext: UiPromptContext | undefined,
  screenshot: ComputerScreenshotResult | undefined,
  config: ComputerUseLoopConfig["localVision"],
): LocalVisionObservation | undefined {
  if (!localVision || !uiContext) {
    return localVision;
  }
  const uiCandidates = buildUiCandidatesFromUiContext(uiContext, screenshot);
  if (uiCandidates.length === 0) {
    return localVision;
  }
  const merged = mergeLocalCandidates(localVision.candidates, uiCandidates);
  const canUsePromptCandidates = localVision.mode === "prompt_hint";
  return {
    ...localVision,
    candidates: merged,
    promptCandidates: canUsePromptCandidates
      ? selectPromptCandidates(merged, config.minConfidence, config.promptTopK)
      : [],
  };
}

function updateLocalVisionRuntimeState(
  state: LocalVisionRuntimeState,
  localVision: LocalVisionObservation | undefined,
  config: ComputerUseLoopConfig["localVision"],
): void {
  if (!localVision || !localVision.enabled || localVision.skipRuntimeStateUpdate) {
    return;
  }
  if (localVision.mode === "timeout") {
    state.consecutiveTimeouts += 1;
    state.consecutiveErrors = 0;
    state.consecutiveActionFailures = 0;
    state.consecutiveSlowDetections = 0;
    if (
      config.disableAfterConsecutiveTimeouts > 0 &&
      state.consecutiveTimeouts >= config.disableAfterConsecutiveTimeouts
    ) {
      state.disabled = true;
      state.disabledReason = "timeout";
    }
    return;
  }
  if (
    config.disableAfterConsecutiveErrors > 0 &&
    localVision.error &&
    localVision.detections.length === 0 &&
    localVision.mode !== "disabled" &&
    localVision.mode !== "not_available"
  ) {
    state.consecutiveErrors += 1;
    state.consecutiveTimeouts = 0;
    state.consecutiveActionFailures = 0;
    state.consecutiveSlowDetections = 0;
    if (state.consecutiveErrors >= config.disableAfterConsecutiveErrors) {
      state.disabled = true;
      state.disabledReason = "error";
    }
    return;
  }
  if (localVision.mode !== "disabled" || !state.disabled) {
    state.consecutiveTimeouts = 0;
    state.consecutiveErrors = 0;
  }
  updateLocalVisionPerformanceState(state, localVision, config);
}

function updateLocalVisionPerformanceState(
  state: LocalVisionRuntimeState,
  localVision: LocalVisionObservation,
  config: ComputerUseLoopConfig["localVision"],
): void {
  if (state.disabled || localVision.mode !== "passive" && localVision.mode !== "prompt_hint") {
    return;
  }
  const latencyMs = localVision.latencyMs;
  if (typeof latencyMs !== "number" || !Number.isFinite(latencyMs)) {
    return;
  }
  const timeoutBudgetMs = localVision.timeoutMs ?? config.timeoutMs;
  const slowThresholdMs = Math.max(1, timeoutBudgetMs * LOCAL_VISION_SLOW_LATENCY_RATIO);
  if (
    latencyMs >= slowThresholdMs &&
    config.imgsz > LOCAL_VISION_MIN_DYNAMIC_IMGSZ
  ) {
    state.consecutiveSlowDetections += 1;
    if (state.consecutiveSlowDetections >= LOCAL_VISION_SLOW_DETECTION_THRESHOLD) {
      state.effectiveImgSize = Math.min(config.imgsz, LOCAL_VISION_MIN_DYNAMIC_IMGSZ);
    }
    return;
  }
  state.consecutiveSlowDetections = 0;
}

function updateLocalVisionRuntimeTrace(
  trace: ComputerUseStepTrace,
  state: LocalVisionRuntimeState,
): void {
  if (!trace.localVision) return;
  trace.localVision.consecutiveTimeouts = state.consecutiveTimeouts;
  trace.localVision.consecutiveErrors = state.consecutiveErrors;
  trace.localVision.consecutiveActionFailures = state.consecutiveActionFailures;
  trace.localVision.consecutiveSlowDetections = state.consecutiveSlowDetections;
  trace.localVision.effectiveImgSize = state.effectiveImgSize ?? trace.localVision.imgsz;
  trace.localVision.disabledReason = state.disabledReason;
}

function updateLocalVisionActionFailureState(
  state: LocalVisionRuntimeState,
  localVision: LocalVisionObservation | undefined,
  config: ComputerUseLoopConfig["localVision"],
  action: ComputerUseAction,
): void {
  const selectedCandidate = selectCandidateForAction(localVision?.candidates ?? [], action);
  if (
    state.disabled ||
    !localVision ||
    localVision.mode !== "prompt_hint" ||
    !selectedCandidate?.candidate.evidence.yolo ||
    config.disableAfterConsecutiveActionFailures <= 0
  ) {
    return;
  }
  state.consecutiveActionFailures += 1;
  if (state.consecutiveActionFailures >= config.disableAfterConsecutiveActionFailures) {
    state.disabled = true;
    state.disabledReason = "action_failure";
  }
}

function localVisionDisabledReason(state: LocalVisionRuntimeState): string {
  if (state.disabledReason === "error") {
    return `local vision disabled after ${state.consecutiveErrors} consecutive errors`;
  }
  if (state.disabledReason === "action_failure") {
    return `local vision disabled after ${state.consecutiveActionFailures} consecutive action failures`;
  }
  return `local vision disabled after ${state.consecutiveTimeouts} consecutive timeouts`;
}

function buildUiCandidatesFromUiContext(
  context: UiPromptContext,
  screenshot: ComputerScreenshotResult | undefined,
): LocalUiCandidate[] {
  return parseUiCandidates(context.tree)
    .filter((candidate) => candidate.automationId || candidate.name)
    .filter((candidate) => isPromptableUiControl(candidate.controlType))
    .slice(0, 24)
    .map((candidate, index): LocalUiCandidate => {
      const kind = mapUiControlTypeToCandidateKind(candidate.controlType);
      const box = candidate.bounds && screenshot
        ? mapScreenRectToScreenshotBox(candidate.bounds, screenshot, context.windowHandle)
        : undefined;
      return {
        id: `uia_${context.windowHandle}_${candidate.automationId || candidate.name || index}`,
        kind,
        ...(box ? {
          box,
          center: {
            x: box.x + box.width / 2,
            y: box.y + box.height / 2,
            coordinateSpace: "screenshot" as const,
          },
        } : {}),
        text: candidate.name || candidate.automationId || undefined,
        score: 0.82,
        evidence: {
          uia: {
            windowHandle: context.windowHandle,
            controlType: candidate.controlType,
            name: candidate.name || undefined,
            automationId: candidate.automationId || undefined,
            confidence: 0.82,
          },
        },
        riskHint: riskHintForUiControl(candidate.controlType, candidate.name),
      };
    })
    .map(applyExecutionPolicy);
}

function mergeLocalCandidates(
  visualCandidates: LocalUiCandidate[],
  uiCandidates: LocalUiCandidate[],
): LocalUiCandidate[] {
  const merged = [...visualCandidates];
  for (const uiCandidate of uiCandidates) {
    const existing = merged.find((candidate) => candidatesLikelyMatch(candidate, uiCandidate));
    if (!existing) {
      merged.push(uiCandidate);
      continue;
    }
    existing.kind = existing.kind === "unknown_region" ? uiCandidate.kind : existing.kind;
    existing.text = uiCandidate.evidence.uia?.name ?? existing.text ?? uiCandidate.text;
    existing.nearbyText = existing.nearbyText ?? uiCandidate.nearbyText;
    existing.score = Math.min(1, Math.max(existing.score, uiCandidate.score) + 0.08);
    existing.box = existing.box ?? uiCandidate.box;
    existing.center = existing.center ?? uiCandidate.center;
    existing.evidence = {
      ...existing.evidence,
      uia: uiCandidate.evidence.uia,
    };
    existing.riskHint = highestRiskHint(existing.riskHint, uiCandidate.riskHint);
  }
  return merged.map(applyExecutionPolicy).sort((left, right) => right.score - left.score);
}

function candidatesLikelyMatch(left: LocalUiCandidate, right: LocalUiCandidate): boolean {
  if (left.box && right.box && boxesLikelyOverlap(left.box, right.box)) {
    return true;
  }
  const leftTokens = candidateMatchTokens(left);
  const rightTokens = candidateMatchTokens(right);
  return leftTokens.some((leftToken) =>
    rightTokens.some((rightToken) => leftToken.length >= 3 && (leftToken.includes(rightToken) || rightToken.includes(leftToken)))
  );
}

function boxesLikelyOverlap(
  left: ComputerUiDetection["box"],
  right: ComputerUiDetection["box"],
): boolean {
  const intersection = boxIntersectionArea(left, right);
  if (intersection <= 0) return false;
  const smallerArea = Math.min(left.width * left.height, right.width * right.height);
  return smallerArea > 0 && intersection / smallerArea >= 0.45;
}

function boxIntersectionArea(
  left: ComputerUiDetection["box"],
  right: ComputerUiDetection["box"],
): number {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width);
  const y2 = Math.min(left.y + left.height, right.y + right.height);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function candidateMatchTokens(candidate: LocalUiCandidate): string[] {
  return [
    candidate.text,
    candidate.nearbyText,
    candidate.evidence.uia?.name,
    candidate.evidence.uia?.automationId,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .flatMap((value) => tokenizeCandidateText(value))
    .filter((value) => value.length > 0 && !isGenericCandidateMatchToken(value));
}

function tokenizeCandidateText(value: string): string[] {
  const spaced = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const normalized = normalizeMatchText(spaced);
  const tokens = normalized.split(/\s+/).filter(Boolean);
  return [...tokens, normalized.replace(/\s+/g, "")].filter((token) => token.length > 0);
}

function isGenericCandidateMatchToken(value: string): boolean {
  return [
    "possible",
    "control",
    "button",
    "input",
    "icon",
    "menu",
    "item",
    "region",
    "unknown",
    "data",
    "image",
    "png",
    "jpg",
    "jpeg",
    "webp",
    "base64",
    "redacted",
    "chars",
  ].includes(value);
}

function isPromptableUiControl(controlType: string): boolean {
  return /button|menuitem|tabitem|hyperlink|checkbox|radio|splitbutton|edit|combobox|listitem/i.test(controlType);
}

function mapUiControlTypeToCandidateKind(controlType: string): LocalUiCandidateKind {
  if (/edit/i.test(controlType)) return "possible_input";
  if (/checkbox|radio/i.test(controlType)) return "possible_checkbox";
  if (/combobox/i.test(controlType)) return "possible_dropdown";
  if (/menuitem/i.test(controlType)) return "possible_menu_item";
  if (/hyperlink/i.test(controlType)) return "possible_link";
  if (/listitem/i.test(controlType)) return "possible_table_cell";
  return "possible_button";
}

function riskHintForUiControl(controlType: string, name: string): "low" | "medium" | "high" {
  const text = `${controlType} ${name}`.toLowerCase();
  if (LOCAL_VISION_HIGH_RISK_TEXT_PATTERN.test(text)) {
    return "high";
  }
  if (/edit|combobox|input|listitem/.test(text)) {
    return "medium";
  }
  return "low";
}

function highestRiskHint(
  left: "low" | "medium" | "high",
  right: "low" | "medium" | "high",
): "low" | "medium" | "high" {
  const order = { low: 0, medium: 1, high: 2 };
  return order[right] > order[left] ? right : left;
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
        invokeTool(() => options.computerTool.screenshot({
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
      invokeTool(() => options.computerTool.inspectUi({
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
  const tree = sanitizePromptBlockText(safeTree, 6000);
  const title = sanitizePromptInlineText(context.title);
  return [
    `UIA CONTEXT (fresh inspectUi for handle=${context.windowHandle}${title ? `, title="${title}"` : ""}; ${context.nodeCount} nodes):`,
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
      const title = sanitizePromptInlineText(window.title) ?? "";
      return `- handle=${window.handle}${foreground}; title="${title}"; rect=${window.rect.x},${window.rect.y},${window.rect.width}x${window.rect.height}`;
    });
  if (windows.length === 0) return "";
  return `WINDOWS (fresh list; prefer these handles for inspectUi/focusWindow):\n${windows.join("\n")}`;
}

function formatLocalVisionCandidates(localVision: LocalVisionObservation | undefined): string {
  if (!localVision || localVision.mode !== "prompt_hint" || localVision.promptCandidates.length === 0) {
    return "";
  }
  const lines = localVision.promptCandidates.map((candidate) => {
    const box = candidate.box;
    const boxText = box
      ? `[${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)},${Math.round(box.height)}]`
      : "unavailable";
    const evidence: string[] = [];
    if (candidate.evidence.uia) {
      const label = candidate.evidence.uia.automationId || candidate.evidence.uia.name || candidate.evidence.uia.controlType || "control";
      evidence.push(`uia:${sanitizePromptInlineText(label, LOCAL_VISION_PROMPT_TEXT_MAX_LENGTH) ?? "control"}`);
    }
    const yoloEvidence = candidate.evidence.yolo
      ? `yolo:${candidate.evidence.yolo.confidence.toFixed(2)}`
      : undefined;
    if (yoloEvidence) evidence.push(yoloEvidence);
    const text = sanitizePromptInlineText(candidate.text, LOCAL_VISION_PROMPT_TEXT_MAX_LENGTH);
    const executionMode = candidate.executionMode ? `, mode=${candidate.executionMode}` : "";
    const reason = sanitizePromptInlineText(candidate.rankReason, LOCAL_VISION_PROMPT_TEXT_MAX_LENGTH);
    return `- ${sanitizePromptInlineText(candidate.id, LOCAL_VISION_PROMPT_TEXT_MAX_LENGTH) ?? "candidate"}: ${candidate.kind}${text ? `, text="${text}"` : ""}, score=${candidate.score.toFixed(2)}, risk=${candidate.riskHint}${executionMode}, box=${boxText}, evidence=${evidence.join("+") || "none"}${reason ? `, reason="${reason}"` : ""}`;
  });
  return [
    "LOCAL_UI_CANDIDATES (local vision hints; use as candidates, not proof of semantics):",
    "Treat yolo-only candidates as location hints only. Do not click them directly unless another source such as UIA or a later visual check confirms the target.",
    ...lines,
  ].join("\n");
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
    options.onProgress(sanitizeStepForRecord({
      stepIndex: options.stepIndex,
      screenshotDataUrl: "",
      observation,
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: phase,
      confidence: "medium",
      phase,
      trace: options.getTrace(),
    }));
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

function invokeTool<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error);
  }
}

function resultErrorMessage(result: PromiseSettledResult<unknown>): string | undefined {
  if (result.status === "fulfilled") return undefined;
  return result.reason instanceof Error ? result.reason.message : String(result.reason);
}

function detectSuspiciousFullScreenshot(
  screenshot: ComputerScreenshotResult,
  visionSource: ScreenshotVisionSource | undefined,
): string | undefined {
  if (visionSource !== "full") {
    return undefined;
  }
  const area = screenshot.width * screenshot.height;
  if (!Number.isFinite(area) || area < SUSPICIOUS_SCREENSHOT_MIN_AREA) {
    return undefined;
  }
  if (screenshot.health?.suspiciousBlank) {
    return createSuspiciousScreenshotMessage(screenshot.health.reason);
  }
  const byteLength = estimatePngDataUrlByteLength(screenshot.dataUrl);
  if (byteLength === undefined) {
    return undefined;
  }
  const bytesPerPixel = byteLength / area;
  if (bytesPerPixel > SUSPICIOUS_SCREENSHOT_MAX_BYTES_PER_PIXEL) {
    return undefined;
  }
  return createSuspiciousScreenshotMessage();
}

function createSuspiciousScreenshotMessage(reason?: string): string {
  const detail = reason === "dark"
    ? "dark"
    : reason === "solid"
      ? "mostly one color"
      : "blank or locked";
  return `Computer Use paused because the desktop screenshot appears ${detail}. Check that the active desktop is visible, the session is not locked, and remote desktop is connected before trying again.`;
}

function estimatePngDataUrlByteLength(dataUrl: string): number | undefined {
  const marker = "data:image/png;base64,";
  if (!dataUrl.toLowerCase().startsWith(marker)) {
    return undefined;
  }
  const payload = dataUrl.slice(marker.length).trim();
  if (!payload.startsWith("iVBORw0KGgo")) {
    return undefined;
  }
  const sanitized = payload.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(sanitized) || sanitized.length === 0) {
    return undefined;
  }
  const padding = sanitized.endsWith("==") ? 2 : sanitized.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((sanitized.length * 3) / 4) - padding);
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

function summarizeScreenshotTrace(
  screenshot: ComputerScreenshotResult,
  screenshotId: string | undefined,
  visionSource: ScreenshotVisionSource | undefined,
): NonNullable<ComputerUseStepTrace["screenshot"]> {
  return {
    id: screenshotId,
    visionSource,
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

function summarizeLocalVisionTrace(
  localVision: LocalVisionObservation,
): NonNullable<ComputerUseStepTrace["localVision"]> {
  const model = sanitizeLocalVisionModelName(localVision.model);
  const configuredModel = sanitizeLocalVisionModelName(localVision.configuredModel);
  return {
    observationId: localVision.observationId,
    screenshotId: localVision.screenshotId,
    enabled: localVision.enabled,
    used: localVision.used,
    mode: localVision.mode,
    model,
    configuredModel,
    runtime: localVision.runtime,
    reuseWorker: localVision.reuseWorker,
    imgsz: localVision.imgsz,
    timeoutMs: localVision.timeoutMs,
    latencyMs: localVision.latencyMs,
    detectionCount: localVision.detections.length,
    promptCandidateCount: localVision.promptCandidates.length,
    diagnostics: withLocalVisionModelPurposeDiagnostics(localVision.diagnostics, model, configuredModel),
    fullScreenshotVlmCalled: false,
    cropVlmCalled: false,
    fullScreenshotVlmSkipped: false,
    error: localVision.error,
  };
}

function withLocalVisionModelPurposeDiagnostics(
  diagnostics: Record<string, unknown> | undefined,
  ...models: Array<string | undefined>
): Record<string, unknown> | undefined {
  const warnings = models
    .map((model) => localVisionModelPurposeWarning(model))
    .filter((warning): warning is string => warning !== undefined);
  if (warnings.length === 0) return diagnostics;
  const existingWarnings = Array.isArray(diagnostics?.warnings)
    ? diagnostics.warnings.filter((value): value is string => typeof value === "string")
    : [];
  return {
    ...(diagnostics ?? {}),
    warnings: Array.from(new Set([...existingWarnings, ...warnings])),
  };
}

function localVisionModelPurposeWarning(model: string | undefined): string | undefined {
  if (!model || !/^yolo26[nsmlx]\.(?:pt|onnx)$/i.test(model)) return undefined;
  return `${model} matches an official Ultralytics YOLO26 COCO weight name; use it for smoke/benchmark only, not as a UI-trained production model`;
}

function updateLocalVisionActionTrace(
  trace: ComputerUseStepTrace,
  localVision: LocalVisionObservation | undefined,
  action: ComputerUseAction,
  error: string | undefined,
  candidateAction?: ComputerUseAction,
): void {
  if (!trace.localVision || !localVision) {
    return;
  }
  const selectedCandidate = selectCandidateForAction(localVision.candidates, candidateAction ?? action);
  trace.localVision.selectedCandidateId = selectedCandidate?.candidate.id;
  trace.localVision.selectedCandidateRank = selectedCandidate?.rank;
  trace.localVision.selectedCandidateSource = selectedCandidate
    ? localVisionCandidateSources(selectedCandidate.candidate)
    : undefined;
  trace.localVision.actionType = action.tool;
  trace.localVision.actionRisk = selectedCandidate
    ? highestRiskHint(actionRiskHint(action), selectedCandidate.candidate.riskHint)
    : actionRiskHint(action);
  trace.localVision.actionSucceeded = !error;
  trace.localVision.fallbackReason = error ? classifyComputerUseFailureReason(error) : undefined;
}

function selectCandidateForAction(
  candidates: LocalUiCandidate[],
  action: ComputerUseAction,
): { candidate: LocalUiCandidate; rank: number } | undefined {
  const selector = actionSelector(action);
  const rankedCandidates = candidates.map((candidate, index) => ({ candidate, rank: index + 1 }));
  if (selector) {
    const selectorMatches = rankedCandidates
      .filter(({ candidate }) => localUiCandidateMatchesSelector(selector, candidate))
      .sort((left, right) =>
        candidateRiskRank(right.candidate.riskHint) - candidateRiskRank(left.candidate.riskHint) ||
        right.candidate.score - left.candidate.score
      );
    if (selectorMatches[0]) return selectorMatches[0];
  }

  const point = actionPoint(action);
  if (!point) return undefined;
  return rankedCandidates
    .filter(({ candidate }) => candidate.box && pointInsideBox(point, candidate.box))
    .sort((left, right) =>
      candidateRiskRank(right.candidate.riskHint) - candidateRiskRank(left.candidate.riskHint) ||
      right.candidate.score - left.candidate.score
    )[0];
}

function actionSelector(
  action: ComputerUseAction,
): ComputerUseActionSelector | undefined {
  switch (action.tool) {
    case "computer.invokeUi":
    case "computer.setUiValue":
      return action.params.selector;
    default:
      return undefined;
  }
}

function localUiCandidateMatchesSelector(
  selector: ComputerUseActionSelector,
  candidate: LocalUiCandidate,
): boolean {
  const uia = candidate.evidence.uia;
  if (!uia || uia.windowHandle !== selector.windowHandle) return false;
  const automationIdMatches = selector.automationId === undefined ||
    uia.automationId === selector.automationId;
  const nameMatches = selector.name === undefined ||
    Boolean(uia.name?.includes(selector.name));
  const controlTypeMatches = selector.controlType === undefined ||
    uia.controlType?.toLowerCase() === selector.controlType.toLowerCase() ||
    selector.controlType.toLowerCase().startsWith("controltype");
  return automationIdMatches && nameMatches && controlTypeMatches;
}

function candidateRiskRank(risk: LocalUiCandidate["riskHint"]): number {
  return risk === "high" ? 2 : risk === "medium" ? 1 : 0;
}

function actionPoint(action: ComputerUseAction): { x: number; y: number } | undefined {
  switch (action.tool) {
    case "computer.click":
    case "computer.moveMouse":
    case "computer.scroll":
      return { x: action.params.x, y: action.params.y };
    default:
      return undefined;
  }
}

function pointInsideBox(point: { x: number; y: number }, box: ComputerUiDetection["box"]): boolean {
  return point.x >= box.x &&
    point.y >= box.y &&
    point.x <= box.x + box.width &&
    point.y <= box.y + box.height;
}

function localVisionCandidateSources(candidate: LocalUiCandidate): string[] {
  const sources: string[] = [];
  if (candidate.evidence.uia) sources.push("uia");
  if (candidate.evidence.yolo) sources.push("yolo");
  return sources;
}

function actionRiskHint(action: ComputerUseAction): "low" | "medium" | "high" {
  switch (action.tool) {
    case "computer.type":
    case "computer.keyCombo":
    case "computer.setUiValue":
      return "high";
    case "computer.invokeUi":
    case "computer.click":
    case "computer.scroll":
      return "medium";
    default:
      return "low";
  }
}

function classifyComputerUseFailureReason(error: string): string {
  if (/timed out|timeout/i.test(error)) return "yolo_timeout";
  if (/stale/i.test(error)) return "stale_screenshot";
  if (/Preflight failed|window.*changed|not visible/i.test(error)) return "window_changed";
  if (/UIA|selector|automation/i.test(error)) return "uia_missing";
  if (/permission|approval|denied/i.test(error)) return "permission_required";
  if (/no screenshot|coordinate|outside|mouse|click|no .*change/i.test(error)) return "coordinate_mismatch";
  if (/blocked|failed/i.test(error)) return "action_blocked";
  return "unknown";
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
      .map((window) => redactImageDataUrlsForRecord(window.title)),
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
  config: ComputerUseLoopConfig,
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

    case "computer.moveMouse": {
      const speed = action.params.speed ?? config.mouseSpeed;
      return computerTool.moveMouse({
        ...action.params,
        speed,
        ...(speed === "linear" ? { durationMs: action.params.durationMs ?? config.mouseDurationMs } : {}),
        ...requireApproval(action, approval),
      });
    }

    case "computer.click":
      return computerTool.click({ ...action.params, ...requireApproval(action, approval) });

    case "computer.type":
      return computerTool.type({
        ...action.params,
        delayMs: config.typeDelayMs,
        ...requireApproval(action, approval),
      });

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

function shouldKeepPendingAutoCropAfterAction(action: ComputerUseAction): boolean {
  return action.tool === "computer.wait" ||
    action.tool === "computer.listWindows" ||
    action.tool === "computer.inspectUi";
}

function requiresFreshApproval(action: ComputerUseAction): boolean {
  return action.tool === "computer.type" ||
    action.tool === "computer.keyCombo" ||
    action.tool === "computer.setUiValue" && (
      selectorLooksSensitive(action.params.selector) ||
      textLooksSensitive(action.params.value)
    ) ||
    action.tool === "computer.invokeUi" && selectorLooksSensitive(action.params.selector);
}

function requiresFreshApprovalForCurrentAction(
  action: ComputerUseAction,
  localVision: LocalVisionObservation | undefined,
  candidateAction: ComputerUseAction,
): boolean {
  if (requiresFreshApproval(action)) {
    return true;
  }
  const selectedCandidate = selectCandidateForAction(localVision?.candidates ?? [], candidateAction);
  return selectedCandidate?.candidate.riskHint === "high" ||
    selectedCandidate?.candidate.executionMode === "user_confirmation_required" ||
    selectedCandidate?.candidate.executionMode === "not_allowed";
}

const SENSITIVE_SELECTOR_TEXT_PATTERN =
  /delete|remove|pay|purchase|submit|send|publish|overwrite|install|grant|permission|password|passcode|token|secret|credential|api[_\s-]?key|private[_\s-]?key|删除|移除|付款|支付|购买|转账|提交|发送|发布|覆盖|安装|授权|权限|密码|口令|令牌|密钥|私钥|凭据|凭证/i;

const SENSITIVE_VALUE_TEXT_PATTERN =
  /password|passcode|pin|otp|2fa|mfa|token|secret|credential|api[_\s-]?key|private[_\s-]?key|\bsk-[a-z0-9_-]+|ghp_[a-z0-9_]+|xox[abprs]-[a-z0-9-]+|akia[0-9a-z]{12,}|eyj[a-z0-9_-]+|credit\s*card|card\s*number|cvv|ssn|passport|密码|口令|验证码|动态码|令牌|密钥|私钥|凭据|凭证|信用卡|银行卡|身份证|护照/i;

function selectorLooksSensitive(selector: unknown): boolean {
  if (!selector || typeof selector !== "object") return false;
  const record = selector as Record<string, unknown>;
  const textValues = [record.name, record.automationId]
    .filter((value): value is string => typeof value === "string");
  return textValues.some((value) => SENSITIVE_SELECTOR_TEXT_PATTERN.test(value));
}

function textLooksSensitive(value: string): boolean {
  return SENSITIVE_VALUE_TEXT_PATTERN.test(value);
}

function createTaskApprovalLease(
  approval: { approvalId: string; taskId?: string },
  action: ComputerUseAction,
  observation: ComputerObservation,
): TaskApprovalLease | undefined {
  const windowHandle = inferActionWindowHandle(action, observation);
  if (windowHandle === undefined) {
    return undefined;
  }
  const allowedTools = reusableTaskApprovalToolsFor(action.tool);
  if (allowedTools.size === 0) {
    return undefined;
  }
  return {
    approvalId: approval.approvalId,
    taskId: approval.taskId,
    createdAtMs: Date.now(),
    remainingActions: TASK_APPROVAL_LEASE_MAX_ACTIONS - 1,
    windowHandle,
    allowedTools,
  };
}

function reusableTaskApprovalLease(lease: TaskApprovalLease | undefined): TaskApprovalLease | undefined {
  if (!lease) return undefined;
  if (lease.remainingActions <= 0) return undefined;
  if (Date.now() - lease.createdAtMs > TASK_APPROVAL_LEASE_TTL_MS) return undefined;
  return lease;
}

function reusableTaskApprovalLeaseForAction(
  lease: TaskApprovalLease | undefined,
  action: ComputerUseAction,
  observation: ComputerObservation,
): TaskApprovalLease | undefined {
  const reusableLease = reusableTaskApprovalLease(lease);
  if (!reusableLease) return undefined;
  if (!reusableLease.allowedTools.has(action.tool)) {
    return undefined;
  }
  if (!taskLeaseMatchesCurrentWindow(reusableLease, action, observation)) {
    return undefined;
  }
  return reusableLease;
}

function consumeTaskApprovalLease(lease: TaskApprovalLease): TaskApprovalLease | undefined {
  const remainingActions = lease.remainingActions - 1;
  return remainingActions > 0
    ? { ...lease, remainingActions }
    : undefined;
}

function reusableTaskApprovalToolsFor(tool: ComputerUseAction["tool"]): Set<ComputerUseAction["tool"]> {
  switch (tool) {
    case "computer.focusWindow":
      return new Set([
        "computer.focusWindow",
        "computer.moveMouse",
        "computer.click",
        "computer.scroll",
      ]);
    case "computer.moveMouse":
    case "computer.click":
    case "computer.scroll":
      return new Set([
        "computer.moveMouse",
        "computer.click",
        "computer.scroll",
      ]);
    case "computer.invokeUi":
      return new Set(["computer.invokeUi"]);
    case "computer.setUiValue":
      return new Set(["computer.setUiValue"]);
    default:
      return new Set();
  }
}

function leaseApproval(lease: TaskApprovalLease): { approvalId: string; taskId?: string } {
  return {
    approvalId: lease.approvalId,
    taskId: lease.taskId,
  };
}

function taskLeaseMatchesCurrentWindow(
  lease: TaskApprovalLease,
  action: ComputerUseAction,
  observation: ComputerObservation,
): boolean {
  const actionWindowHandle = inferActionWindowHandle(action, observation);
  return actionWindowHandle !== undefined && actionWindowHandle === lease.windowHandle;
}

function inferActionWindowHandle(
  action: ComputerUseAction,
  observation: ComputerObservation,
): number | undefined {
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
    case "computer.click":
    case "computer.moveMouse":
    case "computer.scroll":
      return inferCoordinateActionWindowHandle(action, observation);
    default:
      return undefined;
  }
}

function inferTrustedWindowTitleForAction(
  action: ComputerUseAction,
  observation: ComputerObservation,
): string | undefined {
  const handle = inferActionWindowHandle(action, observation);
  const title = handle === undefined
    ? observation.uiContext?.title
    : findWindowByHandle(observation.windowList, handle)?.title ?? observation.uiContext?.title;
  return normalizeTrustedWindowTitle(title);
}

function findDeniedWindowForAction(
  action: ComputerUseAction,
  observation: ComputerObservation,
  config: ComputerUseLoopConfig,
): { title: string; pattern: string } | undefined {
  if (!isWriteAction(action) || config.deniedWindowPatterns.length === 0) {
    return undefined;
  }
  const title = inferWindowTitleForAction(action, observation);
  if (!title) return undefined;
  const lowerTitle = title.toLowerCase();
  const pattern = config.deniedWindowPatterns.find((entry) =>
    lowerTitle.includes(entry.toLowerCase())
  );
  return pattern ? { title, pattern } : undefined;
}

function inferWindowTitleForAction(
  action: ComputerUseAction,
  observation: ComputerObservation,
): string | undefined {
  const handle = inferActionWindowHandle(action, observation);
  if (handle !== undefined) {
    return findWindowByHandle(observation.windowList, handle)?.title ?? observation.uiContext?.title;
  }
  if (action.tool === "computer.type" || action.tool === "computer.keyCombo") {
    return observation.windowList?.windows.find((window) => window.isForeground)?.title ??
      observation.uiContext?.title;
  }
  return observation.uiContext?.title;
}

function normalizeTrustedWindowTitle(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = redactImageDataUrlsForRecord(value)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return normalized || undefined;
}

function inferCoordinateActionWindowHandle(
  action: Extract<ComputerUseAction, { params: { x: number; y: number } }>,
  observation: ComputerObservation,
): number | undefined {
  const visibleWindows = observation.windowList?.windows.filter((window) =>
    window.isVisible && window.rect.width > 0 && window.rect.height > 0
  ) ?? [];
  if (visibleWindows.length === 0) {
    return observation.coordinateTargetWindowHandle;
  }
  const targetWindow = selectTargetWindowForCoordinateAction(
    visibleWindows,
    observation.coordinateTargetWindowHandle,
  );
  if (targetWindow && pointInRect(action.params.x, action.params.y, targetWindow.rect)) {
    return targetWindow.handle;
  }
  return visibleWindows.find((window) => pointInRect(action.params.x, action.params.y, window.rect))?.handle;
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
  taskLease: TaskApprovalLease | undefined;
  approval: { approvalId: string; taskId?: string } | undefined;
  approveAction: ComputerUseLoopOptions["approveAction"];
  observation: ComputerObservation;
  config: ComputerUseLoopConfig;
  signal: AbortSignal;
  emitProgress: (phase: ComputerUsePhase, observation: string) => void;
  requiresFreshApproval?: boolean;
  screenshotDataUrl?: string;
  trustedWindowTitle?: string;
}): Promise<ComputerApprovalResult | undefined> {
  const reusableLease = reusableTaskApprovalLeaseForAction(
    options.taskLease,
    options.action,
    options.observation,
  );
  if (reusableLease && !options.requiresFreshApproval && !requiresFreshApproval(options.action)) {
    return leaseApproval(reusableLease);
  }
  if (!options.approveAction) {
    return undefined;
  }
  options.emitProgress("waiting_permission", "Waiting for retry approval");
  const result = await withHeartbeat(
    () => withTimeout(
      options.approveAction?.(options.action, {
        requiresFreshApproval: options.requiresFreshApproval,
        timeoutMs: options.config.timeouts.approvalMs,
        ...(options.screenshotDataUrl ? { screenshotDataUrl: options.screenshotDataUrl } : {}),
        trustedWindowTitle: options.trustedWindowTitle,
      }) ?? Promise.resolve(undefined),
      getApprovalCallbackTimeoutMs(options.config),
      "Computer Use retry approval",
      options.signal,
    ),
    () => options.emitProgress("waiting_permission", "Still waiting for retry approval"),
    options.config.heartbeatMs,
  );
  return result
    ? { approvalId: result.approvalId, taskId: result.taskId, sessionWide: result.sessionWide }
    : undefined;
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
  bounds?: { x: number; y: number; width: number; height: number };
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
  return parseUiElementCandidates(tree).map(({ value: _value, ...candidate }) => candidate);
}

interface UiValueCandidate extends UiCandidate {
  value: string;
}

function parseUiValueCandidates(tree: string): UiValueCandidate[] {
  return parseUiElementCandidates(tree)
    .filter((candidate): candidate is UiValueCandidate => candidate.value !== undefined);
}

function parseUiElementCandidates(tree: string): Array<UiCandidate & { value?: string }> {
  return tree
    .split(/\r?\n/)
    .map(parseUiElementLine)
    .filter((candidate): candidate is UiCandidate & { value?: string } => candidate !== undefined);
}

function parseUiElementLine(line: string): (UiCandidate & { value?: string }) | undefined {
  const match = line.match(/^\s*<?([A-Za-z][\w-]*)\b([^>]*)>?/);
  if (!match) return undefined;
  const attributes = parseUiElementAttributes(match[2] ?? "");
  return {
    controlType: unescapeUiTreeText(match[1] ?? ""),
    name: unescapeUiTreeText(attributes.name ?? ""),
    automationId: unescapeUiTreeText(attributes.automationId ?? attributes.automation_id ?? ""),
    ...(attributes.bounds === undefined ? {} : { bounds: parseUiBounds(attributes.bounds) }),
    ...(attributes.value === undefined ? {} : { value: unescapeUiTreeText(attributes.value) }),
  };
}

function parseUiElementAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([A-Za-z][\w-]*)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    attributes[match[1] ?? ""] = match[2] ?? "";
  }
  return attributes;
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

function parseUiBounds(value: string): UiCandidate["bounds"] | undefined {
  const parts = value.split(",").map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    return undefined;
  }
  const [x, y, width, height] = parts;
  if (width <= 0 || height <= 0) {
    return undefined;
  }
  return { x, y, width, height };
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
      return getWaitActionTimeoutMs(action.params.ms, config);
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

function getWaitActionTimeoutMs(requestedMs: number, config: ComputerUseLoopConfig): number {
  const waitMs = Math.min(Math.max(requestedMs, 0), COMPUTER_WAIT_MAX_MS);
  const timeoutMs = Math.max(
    COMPUTER_WAIT_MIN_TIMEOUT_MS,
    waitMs + COMPUTER_WAIT_TIMEOUT_OVERHEAD_MS,
  );
  return Math.min(timeoutMs, config.stepDeadlineMs);
}

function getApprovalCallbackTimeoutMs(config: ComputerUseLoopConfig): number {
  return Math.min(config.timeouts.approvalMs + 1_000, config.stepDeadlineMs);
}

function requiresFreshObservationAfterSlowApproval(action: ComputerUseAction): boolean {
  return action.tool === "computer.type" || action.tool === "computer.keyCombo";
}

async function refreshObservationForPostApprovalPreflight(options: {
  action: ComputerUseAction;
  computerTool: ComputerTool;
  config: ComputerUseLoopConfig;
  observation: ComputerObservation;
  signal: AbortSignal;
}): Promise<ComputerObservation> {
  if (!shouldRefreshWindowListForPostApprovalPreflight(options.action)) {
    return {
      ...options.observation,
      freshAt: new Date().toISOString(),
    };
  }

  let windowList = options.observation.windowList;
  try {
    windowList = await withTimeout(
      invokeTool(() => options.computerTool.listWindows({})),
      options.config.timeouts.listWindowsMs,
      "computer.listWindows.postApproval",
      options.signal,
    );
  } catch {
    windowList = options.observation.windowList;
  }

  return {
    ...options.observation,
    windowList,
    coordinateTargetWindowHandle: resolveCoordinateTargetWindowHandle(
      options.observation.screenshot,
      windowList,
      options.observation.preferredUiWindowHandle,
    ),
    freshAt: new Date().toISOString(),
  };
}

function shouldRefreshWindowListForPostApprovalPreflight(action: ComputerUseAction): boolean {
  return isCoordinateAction(action) ||
    action.tool === "computer.focusWindow" ||
    action.tool === "computer.invokeUi" ||
    action.tool === "computer.setUiValue";
}

function combinePreflightTrace(
  before: NonNullable<ComputerUseStepTrace["preflight"]> | undefined,
  after: NonNullable<ComputerUseStepTrace["preflight"]>,
): NonNullable<ComputerUseStepTrace["preflight"]> {
  const beforeReason = before?.reason ? `${before.reason}; ` : "";
  return {
    passed: before?.passed !== false && after.passed,
    reason: `${beforeReason}post-approval: ${after.reason ?? "passed"}`,
  };
}

async function runPreflightCheck(
  action: ComputerUseAction,
  observation: ComputerObservation,
  options?: {
    candidateAction?: ComputerUseAction;
    refreshUiContext?: (windowHandle: number) => Promise<UiPromptContext | undefined>;
  },
): Promise<NonNullable<ComputerUseStepTrace["preflight"]>> {
  if (!isWriteAction(action)) {
    return { passed: true, reason: "read-only action" };
  }

  const observationAgeMs = Date.now() - new Date(observation.freshAt).getTime();
  const STALE_THRESHOLD_MS = 8_000;
  if (observationAgeMs > STALE_THRESHOLD_MS) {
    return {
      passed: false,
      reason: `observation is stale (${Math.round(observationAgeMs / 1000)}s old, threshold ${STALE_THRESHOLD_MS / 1000}s). Re-observe the desktop before executing.`,
    };
  }

  const localVisionCheck = checkLocalVisionCandidatePreflight(
    options?.candidateAction ?? action,
    observation.localVision,
  );
  if (!localVisionCheck.passed) {
    return localVisionCheck;
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

function checkLocalVisionCandidatePreflight(
  action: ComputerUseAction,
  localVision: LocalVisionObservation | undefined,
): NonNullable<ComputerUseStepTrace["preflight"]> {
  const selectedCandidate = selectCandidateForAction(localVision?.candidates ?? [], action);
  if (selectedCandidate?.candidate.executionMode === "not_allowed") {
    return {
      passed: false,
      reason: `local vision candidate ${selectedCandidate.candidate.id} is not allowed for direct execution`,
    };
  }
  if (isCoordinateAction(action) && selectedCandidate?.candidate.riskHint === "high") {
    return {
      passed: false,
      reason: `local vision candidate ${selectedCandidate.candidate.id} is high risk and requires selector or fresh user-confirmed execution`,
    };
  }
  return { passed: true, reason: "local vision candidate preflight passed" };
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

function isIrreversibleAction(action: ComputerUseAction): boolean {
  switch (action.tool) {
    case "computer.type":
    case "computer.keyCombo":
    case "computer.setUiValue":
      return true;
    case "computer.invokeUi":
      return isSensitiveSelector((action.params as Record<string, unknown>).selector);
    case "computer.click":
      return false;
    default:
      return false;
  }
}

function isSensitiveSelector(selector: unknown): boolean {
  if (!selector || typeof selector !== "object") return false;
  const record = selector as Record<string, unknown>;
  const texts = [record.name, record.automationId].filter((v): v is string => typeof v === "string");
  return texts.some((t) => /send|submit|delete|remove|pay|purchase|publish|发送|提交|删除|付款|发布/i.test(t));
}

function isUnknownExecutionError(error: string): boolean {
  return /timed?\s*out|timeout|IPC|connection\s*(lost|closed|reset)|transport|ECONNRESET|ETIMEDOUT|aborted|channel\s*closed/i.test(error);
}

function resolveTargetWindowFromGoal(
  appPatterns: RegExp[],
  windowList: ComputerListWindowsResult | undefined,
): number | undefined {
  if (!windowList?.windows?.length || appPatterns.length === 0) return undefined;
  for (const pattern of appPatterns) {
    const match = windowList.windows.find((w) =>
      w.title && pattern.test(w.title),
    );
    if (match) return match.handle;
  }
  return undefined;
}

function extractAppNamesFromGoal(goal: string): RegExp[] {
  const patterns: RegExp[] = [];
  const lower = goal.toLowerCase();
  const appKeywords: [RegExp, string[]][] = [
    [/\bqq\b/i, ["qq"]],
    [/\bwechat|微信\b/i, ["wechat", "微信"]],
    [/\bwechat\b/i, ["weixin"]],
    [/\bchrome\b/i, ["chrome"]],
    [/\bedge\b/i, ["edge"]],
    [/\bfirefox\b/i, ["firefox"]],
    [/\bvs\s*code\b/i, ["visual studio code", "vscode"]],
    [/\btelegram\b/i, ["telegram"]],
    [/\bdiscord\b/i, ["discord"]],
    [/\bslack\b/i, ["slack"]],
    [/\b飞书|feishu|lark\b/i, ["飞书", "feishu", "lark"]],
    [/\b钉钉|dingtalk\b/i, ["钉钉", "dingtalk"]],
    [/\bteams\b/i, ["teams"]],
    [/\bnotepad\b/i, ["notepad"]],
    [/\bexplorer|资源管理器|文件管理器\b/i, ["explorer", "资源管理器", "文件管理器"]],
    [/\bword\b/i, ["word"]],
    [/\bexcel\b/i, ["excel"]],
    [/\bppt|powerpoint\b/i, ["powerpoint", "ppt"]],
  ];
  for (const [trigger, keywords] of appKeywords) {
    if (trigger.test(lower)) {
      for (const kw of keywords) {
        patterns.push(new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
      }
    }
  }
  // Generic: extract quoted or capitalized words that look like app names
  const quoted = goal.match(/[""']([^""']+)[""']/g);
  if (quoted) {
    for (const q of quoted) {
      const inner = q.slice(1, -1).trim();
      if (inner.length >= 2 && inner.length <= 30) {
        patterns.push(new RegExp(inner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
      }
    }
  }
  return patterns;
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
    parts.push(`screenshot:${stableStringHash(observation.screenshot.dataUrl)}:${observation.screenshot.width}x${observation.screenshot.height}`);
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

function stableStringHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
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
