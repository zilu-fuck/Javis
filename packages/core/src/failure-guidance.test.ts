import { describe, expect, it } from "vitest";
import {
  classifyFailure,
  classifyFailureDetail,
  classifyFailureKind,
  isRetryableFailureSet,
  mergeFailureActions,
} from "./failure-guidance";

/**
 * The details below are the real strings from the production audit log, so this
 * suite is a regression pin on the failure taxonomy rather than an invented one.
 */
describe("classifyFailureKind", () => {
  it("classifies the model-configuration and auth failures", () => {
    expect(classifyFailureKind("Could not read model API key secret. Tried these references but none found: model.openai"))
      .toBe("model_unconfigured");
    expect(classifyFailureKind("API 密钥无效或已过期，请在设置中更新密钥。")).toBe("auth");
    expect(classifyFailureKind('API Key 验证失败（mimo 返回 401）')).toBe("auth");
    expect(classifyFailureKind("model.call.failed provider=deepseek status=403 Forbidden")).toBe("auth");
  });

  it("classifies throttling, timeouts and network faults", () => {
    expect(classifyFailureKind("请求频率过高，请稍后重试。")).toBe("rate_limit");
    expect(classifyFailureKind("workflow step write-summary timed out after 90000ms.")).toBe("timeout");
    expect(classifyFailureKind("Text content generation stalled")).toBe("unknown");
    expect(classifyFailureKind("Internal error: Sidecar error: ECONNREFUSED")).toBe("network");
  });

  it("classifies the response-shape failures rather than lumping them together", () => {
    expect(classifyFailureKind("Model completion returned no final message content. provider=deepseek"))
      .toBe("empty_final_content");
    expect(classifyFailureKind("Structured model response was truncated (length); refusing to parse incomplete JSON."))
      .toBe("truncated_output");
    expect(classifyFailureKind(
      "This model's maximum context length is 1048565 tokens. However, you requested 1259929 tokens",
    )).toBe("context_overflow");
  });

  it("classifies tool contract, availability and plan failures", () => {
    expect(classifyFailureKind("Tool code.searchRepository output.actualFound[27].line must be a integer."))
      .toBe("tool_schema");
    expect(classifyFailureKind("Tool code.inspectWorkspace input contains an undeclared field: workspaceEvidence."))
      .toBe("tool_schema");
    expect(classifyFailureKind("Command is not in the first-version read-only allowlist.")).toBe("tool_unavailable");
    expect(classifyFailureKind("Tool dispatch not implemented for: workspace.scaffold")).toBe("tool_unavailable");
    expect(classifyFailureKind(
      "Commander plan compilation failed: ERROR MISSING_PRIMARY_CAPABILITY [step=write-report]",
    )).toBe("plan_invalid");
    expect(classifyFailureKind("Commander plan has no capability-tagged steps.")).toBe("plan_invalid");
  });

  it("classifies user-driven outcomes", () => {
    expect(classifyFailureKind("Computer Use action denied by user.")).toBe("approval_denied");
    expect(classifyFailureKind("Task cancelled.")).toBe("cancelled");
  });

  it("falls back to unknown instead of guessing", () => {
    expect(classifyFailureKind("Some steps failed")).toBe("unknown");
    expect(classifyFailureKind("")).toBe("unknown");
  });

  it("prefers the specific match when several could apply", () => {
    // Holds a 401 *and* mentions a key: auth is the actionable cause.
    expect(classifyFailureKind("API 返回 401（deepseek）API 密钥无效")).toBe("auth");
    // A schema violation inside a timeout message is still a schema problem.
    expect(classifyFailureKind("Tool X output.line must be a integer")).toBe("tool_schema");
  });
});

describe("classifyFailure", () => {
  it("returns a localized message and ordered actions", () => {
    const guidance = classifyFailure(new Error("API Key 验证失败（mimo 返回 401）"));
    expect(guidance.kind).toBe("auth");
    expect(guidance.actions[0]).toBe("check_api_key");
    expect(guidance.retryable).toBe(false);
    expect(guidance.detail).toContain("401");

    const chinese = classifyFailureDetail("timed out after 90000ms", { locale: "zhCN" });
    expect(chinese.message).toContain("超时");
    expect(chinese.retryable).toBe(true);
  });

  it("keeps every template actionable rather than only descriptive", () => {
    const details = [
      "Could not read model API key secret",
      "401 unauthorized",
      "429 too many requests",
      "timed out",
      "network error",
      "no final message content",
      "maximum context length",
      "truncated (length)",
      "must be a integer",
      "not in the allowlist",
      "plan compilation failed",
      "denied by user",
      "cancelled",
      "some steps failed",
    ];
    for (const detail of details) {
      const guidance = classifyFailureDetail(detail);
      expect(guidance.message.length, detail).toBeGreaterThan(0);
      expect(guidance.actions.length, detail).toBeGreaterThan(0);
      // Unknown is the only kind allowed to be vague, and even it must be actionable.
      expect(guidance.actions, detail).not.toEqual([]);
    }
  });

  it("accepts non-Error values without throwing", () => {
    expect(classifyFailure("plain string").kind).toBe("unknown");
    expect(classifyFailure(undefined).kind).toBe("unknown");
    expect(classifyFailure(null).kind).toBe("unknown");
    expect(classifyFailure({ nope: true }).kind).toBe("unknown");
  });
});

describe("failure batch helpers", () => {
  it("merges actions in priority order without duplicates", () => {
    const actions = mergeFailureActions([
      classifyFailureDetail("429 too many requests"),
      classifyFailureDetail("network error"),
      classifyFailureDetail("429 too many requests"),
    ]);
    expect(actions).toEqual(["retry", "switch_model", "open_settings"]);
  });

  it("reports none when there is nothing to offer", () => {
    expect(mergeFailureActions([classifyFailureDetail("denied by user")])).toEqual(["none"]);
    expect(mergeFailureActions([])).toEqual(["none"]);
  });

  it("only calls a batch retryable when every failure is retryable", () => {
    expect(isRetryableFailureSet([
      classifyFailureDetail("timed out"),
      classifyFailureDetail("network error"),
    ])).toBe(true);
    expect(isRetryableFailureSet([
      classifyFailureDetail("timed out"),
      classifyFailureDetail("401 unauthorized"),
    ])).toBe(false);
    expect(isRetryableFailureSet([])).toBe(false);
  });
});
