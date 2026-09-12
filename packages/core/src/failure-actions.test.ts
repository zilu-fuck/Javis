import { describe, expect, it } from "vitest";
import { classifyFailureDetail } from "./failure-guidance";
import {
  collectFailureCommands,
  describeFailureActions,
  primaryFailureAction,
  type FailureActionContext,
} from "./failure-actions";

function context(overrides: Partial<FailureActionContext> = {}): FailureActionContext {
  return { taskId: "task-1", userGoal: "Summarise the repository", ...overrides };
}

describe("describeFailureActions", () => {
  it("turns a classified failure into labelled, dispatchable buttons", () => {
    const guidance = classifyFailureDetail("API Key 验证失败（mimo 返回 401）", { locale: "zhCN" });
    const actions = describeFailureActions(guidance, context({ locale: "zhCN" }));
    expect(actions.map((entry) => entry.action)).toEqual(guidance.actions);
    expect(actions[0].label).toBe("检查 API 密钥");
    // The first enabled action is the one to highlight; the classifier already ordered
    // these by usefulness, so the primary is simply the first that can run.
    expect(actions[0].emphasis).toBe("primary");
    expect(actions[0].command).toEqual({ kind: "open_settings", section: "model" });
  });

  it("maps retry to a concrete command carrying the original goal", () => {
    const guidance = classifyFailureDetail("timed out");
    const retry = describeFailureActions(guidance, context()).find((entry) => entry.action === "retry");
    expect(retry?.command).toEqual({
      kind: "retry_task",
      taskId: "task-1",
      userGoal: "Summarise the repository",
    });
    expect(retry?.enabled).toBe(true);
  });

  it("disables retry with a reason when there is no original goal", () => {
    // A retry button that reopens an empty composer is worse than no button.
    const guidance = classifyFailureDetail("timed out");
    const retry = describeFailureActions(guidance, context({ userGoal: "   " }))
      .find((entry) => entry.action === "retry");
    expect(retry?.enabled).toBe(false);
    expect(retry?.disabledReason).toContain("no original goal");
    // Still rendered, so the failure does not look remedy-free.
    expect(retry).toBeDefined();
  });

  it("disables retry while a retry is already running", () => {
    const retry = describeFailureActions(classifyFailureDetail("timed out"), context({ isRetrying: true }))
      .find((entry) => entry.action === "retry");
    expect(retry?.enabled).toBe(false);
    expect(retry?.disabledReason).toContain("already running");
  });

  it("promotes the first enabled action when the natural primary cannot run", () => {
    const guidance = classifyFailureDetail("timed out");
    const actions = describeFailureActions(guidance, context({ userGoal: "" }));
    // `retry` is the classifier's first action but cannot run without a goal.
    expect(actions[0].action).toBe("retry");
    expect(actions[0].enabled).toBe(false);
    expect(primaryFailureAction(actions)?.action).not.toBe("retry");
    expect(primaryFailureAction(actions)?.enabled).toBe(true);
  });

  it("disables settings and log actions when the host cannot show them", () => {
    // Auth offers `check_api_key`/`open_settings`; an unclassified failure offers
    // `inspect_log`. Each surface is checked against a failure that actually has it.
    const auth = describeFailureActions(
      classifyFailureDetail("API Key 验证失败（mimo 返回 401）", { locale: "zhCN" }),
      context({ hasSettingsSurface: false, locale: "zhCN" }),
    );
    const settings = auth.find((entry) => entry.action === "open_settings");
    expect(settings?.enabled).toBe(false);
    expect(settings?.disabledReason).toContain("无法打开设置");

    const unrecognised = describeFailureActions(
      classifyFailureDetail("Durable persistence failed in runtime-event-sink", { locale: "zhCN" }),
      context({ hasLogSurface: false, locale: "zhCN" }),
    );
    const log = unrecognised.find((entry) => entry.action === "inspect_log");
    expect(log?.enabled).toBe(false);
    expect(log?.disabledReason).toContain("无法查看日志");
  });

  it("keeps shorten-input available, since it needs nothing", () => {
    const guidance = classifyFailureDetail(
      "This model's maximum context length is 1048565 tokens. However, you requested 1259929 tokens",
    );
    const reduce = describeFailureActions(guidance, context({ userGoal: "" }))
      .find((entry) => entry.action === "reduce_input");
    expect(reduce?.enabled).toBe(true);
    expect(reduce?.command).toEqual({ kind: "focus_input" });
  });

  it("maps replan to a command and blocks it without a goal", () => {
    const guidance = classifyFailureDetail("Commander plan compilation failed: ERROR MISSING_PRIMARY_CAPABILITY");
    expect(describeFailureActions(guidance, context()).find((entry) => entry.action === "replan")?.command)
      .toEqual({ kind: "replan", taskId: "task-1", userGoal: "Summarise the repository" });
    expect(describeFailureActions(guidance, context({ userGoal: "" }))
      .find((entry) => entry.action === "replan")?.enabled).toBe(false);
  });

  it("returns nothing for an action list of only `none`", () => {
    // An approval denial is not a failure to remedy: the user already decided.
    const guidance = classifyFailureDetail("denied by user");
    expect(guidance.actions).toEqual(["none"]);
    expect(describeFailureActions(guidance, context())).toEqual([]);
  });

  it("is deterministic across repeated calls", () => {
    const guidance = classifyFailureDetail("timed out");
    expect(describeFailureActions(guidance, context()))
      .toEqual(describeFailureActions(guidance, context()));
  });

  it("labels every action in both languages", () => {
    for (const detail of [
      "timed out",
      "API Key 验证失败",
      "429 too many requests",
      "network error",
      "no final message content",
      "maximum context length",
      "truncated (length)",
      "must be a integer",
      "not in the allowlist",
      "plan compilation failed",
      "cancelled",
      "some steps failed",
    ]) {
      for (const locale of ["en", "zhCN"] as const) {
        const actions = describeFailureActions(classifyFailureDetail(detail), context({ locale }));
        for (const entry of actions) {
          expect(entry.label.length, `${detail} / ${locale} / ${entry.action}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("always yields at most one primary action", () => {
    for (const detail of ["timed out", "API Key 验证失败", "some steps failed", "denied by user"]) {
      const actions = describeFailureActions(classifyFailureDetail(detail), context());
      expect(actions.filter((entry) => entry.emphasis === "primary").length).toBeLessThanOrEqual(1);
    }
  });
});

describe("collectFailureCommands", () => {
  it("returns only the commands that would actually run", () => {
    const guidance = classifyFailureDetail("timed out");
    const disabled = collectFailureCommands(describeFailureActions(guidance, context({ userGoal: "" })));
    // Retry and replan are both blocked without a goal, so what remains must exclude them.
    expect(disabled.some((command) => command.kind === "retry_task")).toBe(false);

    const enabled = collectFailureCommands(describeFailureActions(guidance, context()));
    expect(enabled[0]).toMatchObject({ kind: "retry_task", taskId: "task-1" });
  });

  it("is empty when nothing can run", () => {
    expect(collectFailureCommands(describeFailureActions(classifyFailureDetail("denied by user"), context())))
      .toEqual([]);
  });
});
