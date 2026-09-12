/**
 * Failure action view model (E2d, app side).
 *
 * This is the seam between the core classifier and the UI. It exists for two reasons.
 *
 * **The UI may not import core.** Package boundaries forbid it, so something in the app
 * has to turn a core `FailureGuidance` into the plain values a component renders. That
 * "something" is this module, and keeping it a pure function is what makes it testable
 * without mounting a component.
 *
 * **Not every failure path sets `failureGuidance`.** Only the model-call failure path
 * populates it today; the plan-compilation and general paths still carry only a
 * `userFacingError` string. Deriving the guidance from that string means the action
 * buttons appear on those failures too, instead of the feature silently existing for one
 * path out of several.
 */

import {
  classifyFailureDetail,
  describeFailureActions,
  type FailureActionDescriptor,
  type FailureGuidance,
  type FailureLocale,
} from "@javis/core";

export interface FailureActionViewInput {
  taskId: string;
  /** The original goal, required for retry/replan to be offered. */
  userGoal?: string;
  /** The classified failure, when the path that failed produced one. */
  failureGuidance?: FailureGuidance;
  /** The user-facing message, always present on a failed task. */
  userFacingError?: string;
  isRetrying?: boolean;
  hasSettingsSurface?: boolean;
  hasLogSurface?: boolean;
  locale?: FailureLocale;
}

export interface FailureActionView {
  /** The message to show. Empty when there is no failure to report. */
  message: string;
  guidance?: FailureGuidance;
  actions: FailureActionDescriptor[];
  /** The action to emphasise, if any can run. */
  primary?: FailureActionDescriptor;
  /** True when a failure was present and was classified here rather than upstream. */
  derivedFromMessage: boolean;
}

/**
 * Builds the renderable failure view.
 *
 * Returns an empty view when there is nothing to report, so a caller can render it
 * unconditionally.
 */
export function buildFailureActionView(input: FailureActionViewInput): FailureActionView {
  const locale = input.locale ?? "en";
  const { guidance, derivedFromMessage } = resolveGuidance(input, locale);
  if (!guidance) {
    return { message: "", actions: [], derivedFromMessage: false };
  }

  const actions = describeFailureActions(guidance, {
    taskId: input.taskId,
    ...(input.userGoal !== undefined ? { userGoal: input.userGoal } : {}),
    ...(input.isRetrying !== undefined ? { isRetrying: input.isRetrying } : {}),
    ...(input.hasSettingsSurface !== undefined ? { hasSettingsSurface: input.hasSettingsSurface } : {}),
    ...(input.hasLogSurface !== undefined ? { hasLogSurface: input.hasLogSurface } : {}),
    locale,
  });

  const primary = actions.find((action) => action.emphasis === "primary");
  return {
    message: guidance.message,
    guidance,
    actions,
    ...(primary ? { primary } : {}),
    derivedFromMessage,
  };
}

function resolveGuidance(
  input: FailureActionViewInput,
  locale: FailureLocale,
): { guidance?: FailureGuidance; derivedFromMessage: boolean } {
  // Prefer the upstream classification: it saw the raw detail, which is strictly more
  // information than the user-facing sentence.
  if (input.failureGuidance) {
    return { guidance: input.failureGuidance, derivedFromMessage: false };
  }
  const message = input.userFacingError?.trim() ?? "";
  if (message.length === 0) {
    return { derivedFromMessage: false };
  }
  return {
    guidance: classifyFailureDetail(message, { locale }),
    derivedFromMessage: true,
  };
}
