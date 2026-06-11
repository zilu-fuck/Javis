// Pure data types for Computer Use action loop — no I/O, no ModelProvider, no Tauri.

/** Configuration for the Computer Use action loop. */
export interface ComputerUseLoopConfig {
  /** Maximum number of action iterations, default 20. */
  maxSteps: number;
  /** Number of recent steps to include in model context, default 5. */
  historySteps: number;
  /** Per-step wall-clock deadline in milliseconds. */
  stepDeadlineMs: number;
  /** Per-tool timeout budgets in milliseconds. */
  timeouts: {
    listWindowsMs: number;
    inspectUiMs: number;
    screenshotMs: number;
    lowRiskWriteMs: number;
    textWriteMs: number;
    modelMs: number;
    approvalMs: number;
    verificationMs: number;
  };
  /** Minimum interval between progress heartbeat events. */
  heartbeatMs: number;
  /** Short-lived UIA cache duration in milliseconds. */
  uiCacheMs: number;
  /** Default mouse movement speed when the model does not specify one. */
  mouseSpeed: "instant" | "linear";
  /** Default linear mouse movement duration in milliseconds. */
  mouseDurationMs: number;
  /** Default delay between typed characters in milliseconds. */
  typeDelayMs: number;
  /** Additional case-insensitive window title substrings to block before desktop writes. */
  deniedWindowPatterns: string[];
  /** Optional local vision detector settings. */
  localVision: {
    enabled: boolean;
    mode: "off" | "passive" | "prompt_hint";
    modelPath?: string;
    runtime: "auto" | "onnxruntime" | "openvino" | "tensorrt";
    runtimeAdapterPath?: string;
    reuseWorker: boolean;
    imgsz: number;
    timeoutMs: number;
    maxDetections: number;
    promptTopK: number;
    minConfidence: number;
    iouThreshold: number;
    labelMap?: Record<string, string>;
    disableAfterConsecutiveTimeouts: number;
    disableAfterConsecutiveErrors: number;
    disableAfterConsecutiveActionFailures: number;
  };
}

/** A single step in the Computer Use action loop. */
export interface ComputerUseStep {
  stepIndex: number;
  screenshotDataUrl: string;
  observation: string;
  action: ComputerUseAction;
  target: string;
  confidence: "high" | "medium" | "low";
  phase?: ComputerUsePhase;
  trace?: ComputerUseStepTrace;
  result?: unknown;
  error?: string;
}

export type ComputerUsePhase =
  | "observing"
  | "planning"
  | "waiting_model"
  | "waiting_permission"
  | "preflight"
  | "executing"
  | "verifying"
  | "recovering"
  | "failed"
  | "completed";

export interface ComputerUseStepTrace {
  startedAt: string;
  completedAt?: string;
  freshAt?: string;
  durationMs?: number;
  observation?: {
    id: string;
  };
  screenshot?: {
    id?: string;
    visionSource?: "full" | "crop";
    width: number;
    height: number;
    sourceWidth?: number;
    sourceHeight?: number;
    sourceOriginX?: number;
    sourceOriginY?: number;
    scaleX?: number;
    scaleY?: number;
    methodUsed?: string;
  };
  localVision?: {
    observationId: string;
    screenshotId: string;
    enabled: boolean;
    used: boolean;
    mode: "off" | "passive" | "prompt_hint" | "timeout" | "error" | "disabled" | "not_available";
    model?: string;
    configuredModel?: string;
    runtime?: string;
    reuseWorker?: boolean;
    imgsz?: number;
    timeoutMs?: number;
    latencyMs?: number;
    detectionCount?: number;
    promptCandidateCount?: number;
    diagnostics?: Record<string, unknown>;
    selectedCandidateId?: string;
    selectedCandidateRank?: number;
    selectedCandidateSource?: string[];
    autoCropCandidateId?: string;
    autoCropRegion?: ComputerScreenshotRegion;
    autoCropReason?: string;
    fullScreenshotVlmCalled?: boolean;
    cropVlmCalled?: boolean;
    fullScreenshotVlmSkipped?: boolean;
    consecutiveTimeouts?: number;
    consecutiveErrors?: number;
    consecutiveActionFailures?: number;
    consecutiveSlowDetections?: number;
    effectiveImgSize?: number;
    disabledReason?: "timeout" | "error" | "action_failure";
    actionType?: string;
    actionRisk?: "low" | "medium" | "high";
    actionSucceeded?: boolean;
    fallbackReason?: string;
    error?: string;
  };
  windows?: {
    freshAt: string;
    count: number;
    foregroundHandle?: number;
    titles: string[];
  };
  ui?: {
    freshAt: string;
    windowHandle: number;
    title?: string;
    nodeCount: number;
    cacheHit?: boolean;
  };
  action?: {
    tool: string;
    approvalMode?: "none" | "per_action" | "task_lease";
    originalTool?: string;
    strategy?: "model" | "uia_preferred";
    strategyReason?: string;
  };
  preflight?: {
    passed: boolean;
    reason?: string;
  };
  verification?: {
    passed: boolean;
    reason?: string;
  };
}

/** Discriminated union of all Computer Use actions the model can output. */
export type ComputerScreenshotRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export const COMPUTER_USE_ACTION_TOOL_NAMES = [
  "computer.moveMouse",
  "computer.click",
  "computer.type",
  "computer.keyCombo",
  "computer.scroll",
  "computer.focusWindow",
  "computer.listWindows",
  "computer.inspectUi",
  "computer.invokeUi",
  "computer.setUiValue",
  "computer.screenshot",
  "computer.wait",
] as const;

export type ComputerUseActionToolName = typeof COMPUTER_USE_ACTION_TOOL_NAMES[number];

export type ComputerUseAction =
  | { tool: "computer.moveMouse"; params: { x: number; y: number; speed?: "instant" | "linear"; durationMs?: number } }
  | { tool: "computer.click"; params: { x: number; y: number; button?: "left" | "right" | "middle"; clickCount?: 1 | 2 } }
  | { tool: "computer.type"; params: { text: string; clearBefore?: boolean } }
  | { tool: "computer.keyCombo"; params: { keys: string[] } }
  | { tool: "computer.scroll"; params: { x: number; y: number; delta: number; direction?: "vertical" | "horizontal" } }
  | { tool: "computer.focusWindow"; params: { handle: number } }
  | { tool: "computer.listWindows"; params: Record<string, never> }
  | { tool: "computer.inspectUi"; params: { windowHandle: number; maxDepth?: number; maxNodes?: number; includeValues?: boolean } }
  | { tool: "computer.invokeUi"; params: { selector: UiElementSelector } }
  | { tool: "computer.setUiValue"; params: { selector: UiElementSelector; value: string } }
  | { tool: "computer.screenshot"; params: { windowHandle?: number; region?: ComputerScreenshotRegion; method?: "auto" | "bitblt" | "printWindow" } }
  | { tool: "computer.wait"; params: { ms: number } };

export interface UiElementSelector {
  windowHandle: number;
  automationId?: string;
  name?: string;
  controlType?: string;
}

const ALLOWED_TOOLS = new Set<string>(COMPUTER_USE_ACTION_TOOL_NAMES);

export interface ComputerUseModelOutput {
  observation: string;
  action: { tool: string; params: Record<string, unknown> };
  target: string;
  confidence: "high" | "medium" | "low";
  status?: "complete";
  summary?: string;
}

/**
 * Parse model JSON output into a ComputerUseAction.
 * Returns null if the model output signals completion.
 * Throws if JSON is invalid or tool is not recognized.
 */
export function parseModelAction(raw: string): ComputerUseAction | null {
  let cleaned = raw.trim();
  // Strip markdown code fences if present
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  const parsed: ComputerUseModelOutput = JSON.parse(cleaned);

  // Check for completion signal. Completion must be an explicit no-op so a
  // contradictory "complete + click/type" output cannot silently skip work.
  if (parsed.status === "complete") {
    if (!parsed.action || !parsed.action.tool) {
      throw new Error("Completion signal missing action.tool field");
    }
    if (!ALLOWED_TOOLS.has(parsed.action.tool)) {
      throw new Error(`Tool "${parsed.action.tool}" not in allowed list: ${[...ALLOWED_TOOLS].join(", ")}`);
    }
    const completionAction = validateActionParams(
      parsed.action.tool,
      normalizeActionParams(parsed.action.tool, parsed.action.params ?? {}),
    );
    if (completionAction.tool !== "computer.wait" || completionAction.params.ms !== 0) {
      throw new Error("Completion signal must use computer.wait with ms=0");
    }
    if (parsed.confidence !== "high") {
      throw new Error("Completion signal requires high confidence");
    }
    return null;
  }

  if (!parsed.action || !parsed.action.tool) {
    throw new Error("Model output missing action.tool field");
  }

  if (!ALLOWED_TOOLS.has(parsed.action.tool)) {
    throw new Error(`Tool "${parsed.action.tool}" not in allowed list: ${[...ALLOWED_TOOLS].join(", ")}`);
  }

  return validateActionParams(parsed.action.tool, normalizeActionParams(parsed.action.tool, parsed.action.params ?? {}));
}

/**
 * Strip markdown fences and attempt JSON parse.
 * Returns the parsed object or throws.
 */
export function parseModelOutput(raw: string): ComputerUseModelOutput {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  return JSON.parse(cleaned);
}

function validateActionParams(
  tool: string,
  params: Record<string, unknown>,
): ComputerUseAction {
  switch (tool) {
    case "computer.moveMouse": {
      const speed = optionalEnum(params.speed, ["instant", "linear"], "speed");
      return {
        tool,
        params: {
          x: numberParam(params.x, "x"),
          y: numberParam(params.y, "y"),
          ...(speed ? { speed } : {}),
          ...(params.durationMs === undefined ? {} : { durationMs: numberParam(params.durationMs, "durationMs") }),
        },
      };
    }
    case "computer.click": {
      const button = optionalEnum(params.button, ["left", "right", "middle"], "button");
      const clickCount = optionalEnum(params.clickCount, [1, 2], "clickCount");
      return {
        tool,
        params: {
          x: numberParam(params.x, "x"),
          y: numberParam(params.y, "y"),
          ...(button ? { button } : {}),
          ...(clickCount ? { clickCount } : {}),
        },
      };
    }
    case "computer.type":
      return {
        tool,
        params: {
          text: stringParam(params.text, "text"),
          ...(params.clearBefore === undefined ? {} : { clearBefore: booleanParam(params.clearBefore, "clearBefore") }),
        },
      };
    case "computer.keyCombo":
      return {
        tool,
        params: {
          keys: stringArrayParam(params.keys, "keys"),
        },
      };
    case "computer.scroll": {
      const direction = optionalEnum(params.direction, ["vertical", "horizontal"], "direction");
      return {
        tool,
        params: {
          x: numberParam(params.x, "x"),
          y: numberParam(params.y, "y"),
          delta: numberParam(params.delta, "delta"),
          ...(direction ? { direction } : {}),
        },
      };
    }
    case "computer.focusWindow":
      return { tool, params: { handle: numberParam(params.handle, "handle") } };
    case "computer.listWindows":
      return { tool, params: {} };
    case "computer.inspectUi":
      return {
        tool,
        params: {
          windowHandle: numberParam(params.windowHandle, "windowHandle"),
          ...(params.maxDepth === undefined ? {} : { maxDepth: numberParam(params.maxDepth, "maxDepth") }),
          ...(params.maxNodes === undefined ? {} : { maxNodes: numberParam(params.maxNodes, "maxNodes") }),
          ...(params.includeValues === undefined ? {} : { includeValues: booleanParam(params.includeValues, "includeValues") }),
        },
      };
    case "computer.invokeUi":
      return { tool, params: { selector: uiSelectorParam(params.selector, "selector") } };
    case "computer.setUiValue":
      return {
        tool,
        params: {
          selector: uiSelectorParam(params.selector, "selector"),
          value: stringParam(params.value, "value"),
        },
      };
    case "computer.screenshot":
      return {
        tool,
        params: {
          ...(params.windowHandle === undefined ? {} : { windowHandle: numberParam(params.windowHandle, "windowHandle") }),
          ...(params.region === undefined ? {} : { region: screenshotRegionParam(params.region, "region") }),
          ...(params.method === undefined ? {} : { method: optionalEnum(params.method, ["auto", "bitblt", "printWindow"], "method") }),
        },
      };
    case "computer.wait":
      return { tool, params: { ms: nonNegativeNumberParam(params.ms, "ms") } };
    default:
      throw new Error(`Tool "${tool}" not in allowed list: ${[...ALLOWED_TOOLS].join(", ")}`);
  }
}

const PARAM_ALIASES: Record<string, Record<string, string[]>> = {
  "computer.moveMouse": {
    x: ["left", "screenX"],
    y: ["top", "screenY"],
    durationMs: ["duration", "duration_ms"],
  },
  "computer.click": {
    x: ["left", "screenX"],
    y: ["top", "screenY"],
    clickCount: ["count", "clicks"],
  },
  "computer.type": {
    text: ["value", "input", "content"],
    clearBefore: ["clear", "replace"],
  },
  "computer.keyCombo": {
    keys: ["key", "combo"],
  },
  "computer.scroll": {
    x: ["left", "screenX"],
    y: ["top", "screenY"],
    delta: ["amount", "scrollDelta"],
  },
  "computer.focusWindow": {
    handle: ["windowHandle", "hwnd"],
  },
  "computer.listWindows": {},
  "computer.inspectUi": {
    windowHandle: ["handle", "hwnd"],
    maxDepth: ["depth"],
    maxNodes: ["limit"],
  },
  "computer.invokeUi": {},
  "computer.setUiValue": {
    value: ["text", "input", "content"],
  },
  "computer.screenshot": {
    windowHandle: ["handle", "hwnd"],
  },
  "computer.wait": {
    ms: ["milliseconds", "delayMs", "durationMs"],
  },
};

function normalizeActionParams(
  tool: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const aliases = PARAM_ALIASES[tool];
  if (!aliases) return params;

  const normalized: Record<string, unknown> = { ...params };
  for (const [canonicalName, aliasNames] of Object.entries(aliases)) {
    let canonicalValue = normalized[canonicalName];
    for (const aliasName of aliasNames) {
      if (normalized[aliasName] === undefined) continue;
      if (canonicalValue === undefined) {
        canonicalValue = normalized[aliasName];
      }
      delete normalized[aliasName];
    }
    if (canonicalValue !== undefined) {
      normalized[canonicalName] = canonicalValue;
    }
  }

  return normalized;
}

function numberParam(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid ${name}: expected finite number`);
  }
  return value;
}

function nonNegativeNumberParam(value: unknown, name: string): number {
  const numberValue = numberParam(value, name);
  if (numberValue < 0) {
    throw new Error(`Invalid ${name}: expected non-negative number`);
  }
  return numberValue;
}

function stringParam(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid ${name}: expected string`);
  }
  return value;
}

function booleanParam(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Invalid ${name}: expected boolean`);
  }
  return value;
}

function stringArrayParam(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid ${name}: expected string array`);
  }
  return value;
}

function uiSelectorParam(value: unknown, name: string): UiElementSelector {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${name}: expected object`);
  }
  const record = value as Record<string, unknown>;
  const selector: UiElementSelector = {
    windowHandle: numberParam(record.windowHandle ?? record.handle ?? record.hwnd, `${name}.windowHandle`),
  };
  const automationId = record.automationId ?? record.automation_id;
  if (automationId !== undefined) {
    selector.automationId = stringParam(automationId, `${name}.automationId`);
  }
  if (record.name !== undefined) {
    selector.name = stringParam(record.name, `${name}.name`);
  }
  if (record.controlType !== undefined) {
    selector.controlType = stringParam(record.controlType, `${name}.controlType`);
  }
  if (!selector.automationId && !selector.name) {
    throw new Error(`Invalid ${name}: expected automationId or name`);
  }
  return selector;
}

function screenshotRegionParam(value: unknown, name: string): ComputerScreenshotRegion {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${name}: expected object`);
  }
  const record = value as Record<string, unknown>;
  const region = {
    x: numberParam(record.x, `${name}.x`),
    y: numberParam(record.y, `${name}.y`),
    width: numberParam(record.width, `${name}.width`),
    height: numberParam(record.height, `${name}.height`),
  };
  if (region.width <= 0 || region.height <= 0) {
    throw new Error(`Invalid ${name}: width and height must be positive`);
  }
  return region;
}

function optionalEnum<const T extends readonly (string | number)[]>(
  value: unknown,
  allowed: T,
  name: string,
): T[number] | undefined {
  if (value === undefined) return undefined;
  if ((allowed as readonly unknown[]).includes(value)) return value as T[number];
  throw new Error(`Invalid ${name}: expected one of ${allowed.join(", ")}`);
}
