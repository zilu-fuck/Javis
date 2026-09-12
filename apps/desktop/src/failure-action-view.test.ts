import { describe, expect, it } from "vitest";
import { classifyFailureDetail } from "@javis/core";
import { buildFailureActionView } from "./failure-action-view";

describe("buildFailureActionView", () => {
  it("prefers the upstream classification over re-deriving it from the message", () => {
    // The upstream classification saw the raw detail, which is strictly more information
    // than the user-facing sentence.
    const guidance = classifyFailureDetail("API Key 验证失败（mimo 返回 401）", { locale: "zhCN" });
    const view = buildFailureActionView({
      taskId: "t1",
      userGoal: "summarise the repo",
      failureGuidance: guidance,
      userFacingError: "模型鉴权失败，请检查 API 密钥、基础 URL 和模型名。",
      locale: "zhCN",
    });
    expect(view.derivedFromMessage).toBe(false);
    expect(view.guidance?.kind).toBe("auth");
    expect(view.message).toBe(guidance.message);
  });

  it("derives actions from the user-facing message when no classification exists", () => {
    // This is why the module exists: plan-compilation and other paths set only
    // `userFacingError`, and the buttons must still appear there.
    const view = buildFailureActionView({
      taskId: "t1",
      userGoal: "summarise the repo",
      userFacingError: "Commander plan compilation failed: ERROR MISSING_PRIMARY_CAPABILITY",
    });
    expect(view.derivedFromMessage).toBe(true);
    expect(view.guidance?.kind).toBe("plan_invalid");
    expect(view.actions.length).toBeGreaterThan(0);
    expect(view.actions[0].command).toMatchObject({ kind: "replan", taskId: "t1" });
  });

  it("returns an empty view when there is no failure at all", () => {
    expect(buildFailureActionView({ taskId: "t1" })).toEqual({
      message: "",
      actions: [],
      derivedFromMessage: false,
    });
    expect(buildFailureActionView({ taskId: "t1", userFacingError: "   " }).actions).toEqual([]);
  });

  it("emphasises exactly one action and never a disabled one", () => {
    const view = buildFailureActionView({
      taskId: "t1",
      userGoal: "summarise the repo",
      userFacingError: "timed out",
    });
    expect(view.primary?.emphasis).toBe("primary");
    expect(view.primary?.enabled).toBe(true);
    expect(view.actions.filter((action) => action.emphasis === "primary")).toHaveLength(1);
  });

  it("passes context through so unavailable actions are disabled, not dropped", () => {
    const view = buildFailureActionView({
      taskId: "t1",
      // No goal: retry cannot run, but it must still be shown with a reason.
      userFacingError: "timed out",
      hasSettingsSurface: false,
      hasLogSurface: false,
    });
    const retry = view.actions.find((action) => action.action === "retry");
    expect(retry?.enabled).toBe(false);
    expect(retry?.disabledReason).toBeTruthy();
    expect(view.primary?.action).not.toBe("retry");
  });

  it("forwards the retry-in-flight flag", () => {
    const view = buildFailureActionView({
      taskId: "t1",
      userGoal: "goal",
      userFacingError: "timed out",
      isRetrying: true,
    });
    expect(view.actions.find((action) => action.action === "retry")?.enabled).toBe(false);
  });

  it("labels actions in the requested locale", () => {
    const chinese = buildFailureActionView({
      taskId: "t1",
      userGoal: "goal",
      userFacingError: "timed out",
      locale: "zhCN",
    });
    expect(chinese.actions[0].label).toBe("重试");
    const english = buildFailureActionView({
      taskId: "t1",
      userGoal: "goal",
      userFacingError: "timed out",
      locale: "en",
    });
    expect(english.actions[0].label).toBe("Retry");
  });

  it("offers nothing for an approval denial, which is not a failure to remedy", () => {
    const view = buildFailureActionView({
      taskId: "t1",
      userGoal: "goal",
      userFacingError: "denied by user",
    });
    expect(view.actions).toEqual([]);
    expect(view.message.length).toBeGreaterThan(0);
  });

  it("keeps the specific message for an unrecognised failure", () => {
    // The action list may be empty of anything useful here, but the message must not
    // claim a cause it does not know.
    const view = buildFailureActionView({
      taskId: "t1",
      userGoal: "goal",
      userFacingError: "Durable persistence failed in checkpoint-sink",
    });
    expect(view.message).toContain("Durable persistence failed in checkpoint-sink");
  });

  it("is a pure function of its input", () => {
    const input = { taskId: "t1", userGoal: "goal", userFacingError: "timed out" };
    expect(buildFailureActionView(input)).toEqual(buildFailureActionView(input));
  });
});
