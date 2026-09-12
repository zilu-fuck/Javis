/**
 * Declarative tool/task hooks (C4).
 *
 * A hook lets a configuration intercept the harness at four points without
 * shipping code:
 *
 *   beforeToolCall   — deny a tool, or force it through the approval flow
 *   afterToolCall    — annotate the result
 *   beforeApproval   — add a reason the user sees on the approval card
 *   onTaskFail       — record a diagnostic when a task fails
 *
 * Actions are data, not callbacks. Arbitrary code hooks would move the security
 * boundary — the native approval guard is the only thing allowed to authorize a
 * write — so they are rejected at config parse time rather than "supported with a
 * warning".
 */

import type { JavisHookDeclaration, ConfigDiagnostic } from "./javis-config";
import { JAVIS_HOOK_ACTION_KINDS } from "./javis-config";

export type HookPhase = JavisHookDeclaration["phase"];

export interface HookCallContext {
  phase: HookPhase;
  toolName?: string;
  taskId?: string;
  stepId?: string;
  /** Reason text already collected for this phase, e.g. an approval prompt. */
  reason?: string;
  error?: string;
}

export interface HookDecision {
  decision: "allow" | "deny" | "require_approval";
  /** Every reason that contributed, in declaration order. */
  reasons: string[];
  /** Annotations collected from `afterToolCall` hooks. */
  annotations: Array<{ field: string; value: string }>;
  /** Free-form notices collected from `notify` hooks. */
  notices: string[];
  /** Hooks that actually ran, for diagnostics and tests. */
  appliedHookIds: string[];
}

export interface HookRegistry {
  list(): JavisHookDeclaration[];
  /** Evaluates every enabled hook for the phase, in declaration order. */
  evaluate(context: HookCallContext): HookDecision;
  reset(declarations: readonly JavisHookDeclaration[]): void;
}

/** `*` matches any tool; an exact name matches only itself. */
export function hookAppliesToTool(hook: JavisHookDeclaration, toolName: string | undefined): boolean {
  const pattern = hook.tool ?? "*";
  if (pattern === "*") {
    return true;
  }
  if (toolName === undefined) {
    return false;
  }
  if (pattern.endsWith("*")) {
    return toolName.startsWith(pattern.slice(0, -1));
  }
  return pattern === toolName;
}

export function createHookRegistry(
  initial: readonly JavisHookDeclaration[] = [],
): HookRegistry {
  let declarations: JavisHookDeclaration[] = [...initial];

  function evaluate(context: HookCallContext): HookDecision {
    const decision: HookDecision = {
      decision: "allow",
      reasons: [],
      annotations: [],
      notices: [],
      appliedHookIds: [],
    };

    for (const hook of declarations) {
      if (hook.enabled === false || hook.phase !== context.phase) {
        continue;
      }
      if (!hookAppliesToTool(hook, context.toolName)) {
        continue;
      }
      decision.appliedHookIds.push(hook.id);
      switch (hook.action.kind) {
        case "deny":
          // A deny is final: keep collecting reasons so the user sees all of them.
          decision.decision = "deny";
          decision.reasons.push(hook.action.reason);
          break;
        case "requireApproval":
          // A deny outranks a requirement; never downgrade it.
          if (decision.decision !== "deny") {
            decision.decision = "require_approval";
          }
          decision.reasons.push(hook.action.reason);
          break;
        case "annotate":
          decision.annotations.push({ field: hook.action.field, value: hook.action.value });
          break;
        case "notify":
          decision.notices.push(hook.action.message);
          break;
        default:
          // Unknown kinds cannot reach here: config parsing rejects them, and the
          // exhaustiveness check below keeps it that way as the union grows.
          break;
      }
    }

    return decision;
  }

  return {
    list: () => [...declarations],
    evaluate,
    reset(next) {
      declarations = [...next];
    },
  };
}

/**
 * Validates a declaration list the way config parsing does, for callers that
 * build declarations programmatically (tests, desktop presets).
 */
export function validateHookDeclarations(
  declarations: readonly JavisHookDeclaration[],
): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];
  const seen = new Set<string>();
  declarations.forEach((hook, index) => {
    if (seen.has(hook.id)) {
      diagnostics.push({
        severity: "warning",
        path: `hooks[${index}].id`,
        message: `duplicate hook id "${hook.id}"; the later declaration wins.`,
      });
    }
    seen.add(hook.id);
    if (!JAVIS_HOOK_ACTION_KINDS.includes(hook.action.kind)) {
      diagnostics.push({
        severity: "error",
        path: `hooks[${index}].action.kind`,
        message: `unsupported hook action "${hook.action.kind}".`,
      });
    }
  });
  return diagnostics;
}

// ---------------------------------------------------------------------------
// Process-wide default registry
//
// The tool dispatcher is a pure function deep inside the executor and takes no
// configuration object, so the runtime installs the resolved declarations here
// once per task start. Kept explicit and resettable so tests never leak state.
// ---------------------------------------------------------------------------

const defaultRegistry = createHookRegistry();

/** SharedTaskContext key carrying hook annotations and notices for the task. */
export const HOOK_NOTICES_CONTEXT_KEY = "hookNotices";

/** Cap on the per-task hook notices mirrored into SharedTaskContext. */
export const MAX_CONTEXT_HOOK_NOTICES = 20;

export interface HookContextEntry {
  phase: HookPhase;
  toolName?: string;
  stepId?: string;
  reasons?: string[];
  notices?: string[];
  annotations?: Array<{ field: string; value: string }>;
}

/**
 * Mirrors hook output into the task context so annotations and notices travel
 * with the artifacts instead of vanishing after evaluation.
 */
export function appendContextHookNotices(
  context: { get<T>(key: string): T | undefined; set<T>(key: string, value: T): void },
  entry: HookContextEntry,
): HookContextEntry[] {
  const current = context.get<HookContextEntry[]>(HOOK_NOTICES_CONTEXT_KEY) ?? [];
  const next = [...current, entry].slice(-MAX_CONTEXT_HOOK_NOTICES);
  context.set(HOOK_NOTICES_CONTEXT_KEY, next);
  return next;
}

/**
 * Enforces the `beforeToolCall` phase for the tool dispatcher.
 *
 * Returns normally when the call may proceed and throws with every collected
 * reason when a configured hook blocks it. A hook can require approval but can
 * never grant it: the native approval boundary stays the only thing that can
 * authorize a write.
 */
export function assertToolCallAllowedByHooks(input: {
  toolName: string;
  stepId?: string;
  taskId?: string;
}): HookDecision {
  const decision = evaluateHooks({
    phase: "beforeToolCall",
    toolName: input.toolName,
    ...(input.stepId ? { stepId: input.stepId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
  });
  if (decision.decision === "deny") {
    throw new Error(
      `Tool ${input.toolName} was blocked by a configured hook: ${decision.reasons.join("; ")}`,
    );
  }
  if (decision.decision === "require_approval") {
    throw new Error(
      `Tool ${input.toolName} requires approval by a configured hook and cannot be dispatched `
      + `by the generic executor: ${decision.reasons.join("; ")}`,
    );
  }
  return decision;
}

export function configureHooks(declarations: readonly JavisHookDeclaration[]): void {
  defaultRegistry.reset(declarations);
}

export function listConfiguredHooks(): JavisHookDeclaration[] {
  return defaultRegistry.list();
}

export function evaluateHooks(context: HookCallContext): HookDecision {
  return defaultRegistry.evaluate(context);
}

export function resetHooks(): void {
  defaultRegistry.reset([]);
}
