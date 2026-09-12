/**
 * Failure actions as renderable buttons (E2d).
 *
 * `failure-guidance` classifies a failure and returns ordered actions. An action is not
 * yet a button: some of them cannot run in the current context, and offering a button
 * that silently does nothing is worse than not offering it.
 *
 * So each action is resolved against the context into a descriptor carrying:
 *
 *  * the **concrete command** the UI dispatches (not an abstract verb, so there is one
 *    place that knows what "retry" means for this task);
 *  * whether it is **enabled**, and if not, the reason — so the button is shown disabled
 *    with an explanation rather than hidden or lying;
 *  * **emphasis**: exactly one primary action, chosen as the first *enabled* action,
 *    because `failure-guidance` already ordered them by usefulness.
 *
 * `retry` is the interesting case: it genuinely needs the original goal, so a task
 * without one cannot be retried, and saying so is better than a button that reopens an
 * empty composer.
 */

import type { FailureAction, FailureGuidance, FailureLocale } from "./failure-guidance";

export interface FailureActionContext {
  taskId: string;
  /** The original goal. `retry` cannot work without it. */
  userGoal?: string;
  /** True while a retry of this task is already in flight. */
  isRetrying?: boolean;
  /** Whether the host can open model settings from here. */
  hasSettingsSurface?: boolean;
  /** Whether the host can open the activity log for this task. */
  hasLogSurface?: boolean;
  /** Whether a workspace is selected, for actions that need one. */
  hasWorkspace?: boolean;
  locale?: FailureLocale;
}

export type FailureActionCommand =
  | { kind: "retry_task"; taskId: string; userGoal: string }
  | { kind: "open_settings"; section: "model" }
  | { kind: "open_log"; taskId: string }
  | { kind: "focus_input" }
  | { kind: "replan"; taskId: string; userGoal: string }
  | { kind: "choose_workspace" }
  | { kind: "inspect_tool_output"; taskId: string };

export interface FailureActionDescriptor {
  action: FailureAction;
  label: string;
  emphasis: "primary" | "secondary";
  command: FailureActionCommand;
  enabled: boolean;
  disabledReason?: string;
}

const LABELS: Record<FailureAction, Record<FailureLocale, string>> = {
  open_settings: { en: "Open settings", zhCN: "打开设置" },
  check_api_key: { en: "Check API key", zhCN: "检查 API 密钥" },
  switch_model: { en: "Switch model", zhCN: "切换模型" },
  retry: { en: "Retry", zhCN: "重试" },
  reduce_input: { en: "Shorten input", zhCN: "缩短输入" },
  inspect_log: { en: "View log", zhCN: "查看日志" },
  fix_tool_output: { en: "Inspect tool output", zhCN: "检查工具输出" },
  replan: { en: "Replan", zhCN: "重新规划" },
  adjust_permissions: { en: "Adjust permissions", zhCN: "调整权限" },
  none: { en: "", zhCN: "" },
};

/**
 * Resolves one action into a descriptor, or `undefined` when it maps to nothing
 * renderable (only `none` does).
 */
function resolveAction(
  action: FailureAction,
  context: FailureActionContext,
): Omit<FailureActionDescriptor, "emphasis"> | undefined {
  const locale = context.locale ?? "en";
  const isChinese = locale === "zhCN";
  const label = LABELS[action][locale];
  const goal = context.userGoal?.trim() ?? "";

  switch (action) {
    case "none":
      return undefined;
    case "retry": {
      if (goal.length === 0) {
        return {
          action,
          label,
          command: { kind: "retry_task", taskId: context.taskId, userGoal: "" },
          enabled: false,
          disabledReason: isChinese
            ? "没有原始目标，无法重试"
            : "there is no original goal to retry",
        };
      }
      if (context.isRetrying) {
        return {
          action,
          label,
          command: { kind: "retry_task", taskId: context.taskId, userGoal: goal },
          enabled: false,
          disabledReason: isChinese ? "正在重试" : "a retry is already running",
        };
      }
      return {
        action,
        label,
        command: { kind: "retry_task", taskId: context.taskId, userGoal: goal },
        enabled: true,
      };
    }
    case "replan": {
      if (goal.length === 0) {
        return {
          action,
          label,
          command: { kind: "replan", taskId: context.taskId, userGoal: "" },
          enabled: false,
          disabledReason: isChinese ? "没有目标可以重新规划" : "there is no goal to replan",
        };
      }
      return {
        action,
        label,
        command: { kind: "replan", taskId: context.taskId, userGoal: goal },
        enabled: true,
      };
    }
    case "open_settings":
    case "check_api_key":
      return settingsDescriptor(action, label, "model", context);
    case "switch_model":
      return settingsDescriptor(action, label, "model", context);
    case "adjust_permissions":
      return settingsDescriptor(action, label, "model", context);
    case "inspect_log":
      return logDescriptor(action, label, context);
    case "fix_tool_output":
      // Tool-output repair is only meaningful where the log is, since the repair text
      // lives there.
      if (context.hasLogSurface === false) {
        return {
          action,
          label,
          command: { kind: "inspect_tool_output", taskId: context.taskId },
          enabled: false,
          disabledReason: isChinese
            ? "此处无法查看工具输出"
            : "tool output is not inspectable here",
        };
      }
      return {
        action,
        label,
        command: { kind: "inspect_tool_output", taskId: context.taskId },
        enabled: true,
      };
    case "reduce_input":
      return { action, label, command: { kind: "focus_input" }, enabled: true };
    default:
      // An action the classifier grows before this switch learns it: surface it as
      // unavailable rather than dropping it silently.
      return {
        action,
        label: label || String(action),
        command: { kind: "open_log", taskId: context.taskId },
        enabled: false,
        disabledReason: isChinese ? "此操作尚不可用" : "this action is not available yet",
      };
  }
}

function settingsDescriptor(
  action: FailureAction,
  label: string,
  section: "model",
  context: FailureActionContext,
): Omit<FailureActionDescriptor, "emphasis"> {
  const isChinese = (context.locale ?? "en") === "zhCN";
  if (context.hasSettingsSurface === false) {
    return {
      action,
      label,
      command: { kind: "open_settings", section },
      enabled: false,
      disabledReason: isChinese
        ? "此处无法打开设置"
        : "settings cannot be opened from here",
    };
  }
  return { action, label, command: { kind: "open_settings", section }, enabled: true };
}

function logDescriptor(
  action: FailureAction,
  label: string,
  context: FailureActionContext,
): Omit<FailureActionDescriptor, "emphasis"> {
  const isChinese = (context.locale ?? "en") === "zhCN";
  if (context.hasLogSurface === false) {
    return {
      action,
      label,
      command: { kind: "open_log", taskId: context.taskId },
      enabled: false,
      disabledReason: isChinese ? "此处无法查看日志" : "the log cannot be opened from here",
    };
  }
  return { action, label, command: { kind: "open_log", taskId: context.taskId }, enabled: true };
}

/**
 * All renderable actions for a failure, in the classifier's order.
 *
 * The first *enabled* action becomes `primary`; the rest are `secondary`. Unavailable
 * actions are still returned so the UI can show them disabled with a reason — hiding them
 * would make the failure look like it has no remedy.
 */
export function describeFailureActions(
  guidance: FailureGuidance,
  context: FailureActionContext,
): FailureActionDescriptor[] {
  const resolved: FailureActionDescriptor[] = [];
  for (const action of guidance.actions) {
    const descriptor = resolveAction(action, context);
    if (descriptor) {
      resolved.push({ ...descriptor, emphasis: "secondary" });
    }
  }
  const firstEnabled = resolved.find((descriptor) => descriptor.enabled);
  if (firstEnabled) {
    firstEnabled.emphasis = "primary";
  }
  return resolved;
}

/** The action a UI should highlight, or `undefined` when none can run. */
export function primaryFailureAction(
  descriptors: readonly FailureActionDescriptor[],
): FailureActionDescriptor | undefined {
  return descriptors.find((descriptor) => descriptor.emphasis === "primary");
}

/** The commands an enabled action list would dispatch, for tests and logging. */
export function collectFailureCommands(
  descriptors: readonly FailureActionDescriptor[],
): FailureActionCommand[] {
  return descriptors.filter((descriptor) => descriptor.enabled).map((descriptor) => descriptor.command);
}
