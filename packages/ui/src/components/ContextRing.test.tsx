import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { zhCNWorkbenchLocale } from "../locale";
import type { WorkbenchModelConfiguration, WorkbenchTask } from "../types";
import { ContextRing } from "./ContextRing";

describe("ContextRing", () => {
  afterEach(cleanup);

  it("uses the window paired with the most utilized model call", () => {
    const task: WorkbenchTask = {
      id: "task-actual-window",
      title: "Task",
      userGoal: "Goal",
      status: "completed",
      commanderMessage: "Done",
      plan: [],
      agents: [],
      logs: [],
      tokenUsage: {
        inputTokens: 12_000,
        outputTokens: 2_000,
        totalTokens: 14_000,
        peakContextTokens: 9_000,
        contextUsedTokens: 9_000,
        contextWindowTokens: 16_000,
        modelCalls: 2,
        byAgentKind: [],
      },
    };
    const modelConfiguration: WorkbenchModelConfiguration = {
      profiles: [{
        id: "primary",
        slot: "primary",
        displayName: "Primary",
        provider: "openai",
        model: "gpt-test",
        apiKeyReference: "default",
        baseUrl: "",
        apiKey: "",
        contextTokens: 128_000,
        capabilities: { vision: true, code: true, longContext: true },
      }],
      agentOverrides: {},
    };

    const { getByRole } = render(
      <ContextRing
        labels={zhCNWorkbenchLocale.labels}
        locale={zhCNWorkbenchLocale}
        task={task}
        modelConfiguration={modelConfiguration}
      />,
    );

    expect(getByRole("button").getAttribute("aria-label")).toContain("9k / 16k");
  });

  it("uses the largest single-call context instead of cumulative task tokens", () => {
    const task: WorkbenchTask = {
      id: "task-1",
      title: "Task",
      userGoal: "Goal",
      status: "completed",
      commanderMessage: "Done",
      plan: [],
      agents: [],
      logs: [],
      tokenUsage: {
        inputTokens: 1_000,
        outputTokens: 5_000,
        totalTokens: 6_000,
        peakContextTokens: 1_200,
        modelCalls: 3,
        byAgentKind: [{
          agentKind: "commander",
          inputTokens: 1_000,
          outputTokens: 5_000,
          totalTokens: 6_000,
          modelCalls: 3,
        }],
      },
    };
    const modelConfiguration: WorkbenchModelConfiguration = {
      profiles: [{
        id: "primary",
        slot: "primary",
        displayName: "Primary",
        provider: "openai",
        model: "gpt-test",
        apiKeyReference: "default",
        baseUrl: "",
        apiKey: "",
        contextTokens: 10_000,
        capabilities: { vision: true, code: true, longContext: true },
      }],
      agentOverrides: {},
    };

    const { container } = render(
      <ContextRing
        labels={zhCNWorkbenchLocale.labels}
        locale={zhCNWorkbenchLocale}
        task={task}
        modelConfiguration={modelConfiguration}
      />,
    );

    const trigger = container.querySelector<HTMLButtonElement>("button")!;
    expect(trigger.getAttribute("aria-label")).toContain("1.2k / 10k");

    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(
      container.querySelector<HTMLElement>(".javis-context-window-agent-bar span")?.style.width,
    ).toBe("100%");
  });

  it("shows the overall cache hit rate in the basic panel when cache reads are reported", () => {
    const task: WorkbenchTask = {
      id: "task-cache-hit",
      title: "Task",
      userGoal: "Goal",
      status: "running",
      commanderMessage: "",
      plan: [],
      agents: [],
      logs: [],
      tokenUsage: {
        inputTokens: 10_000,
        outputTokens: 1_000,
        totalTokens: 11_000,
        cacheReadTokens: 6_500,
        modelCalls: 4,
        byAgentKind: [],
      },
    };

    const { container, getByText } = render(
      <ContextRing
        labels={zhCNWorkbenchLocale.labels}
        locale={zhCNWorkbenchLocale}
        task={task}
      />,
    );

    fireEvent.click(container.querySelector<HTMLButtonElement>("button")!);
    expect(getByText("缓存命中")).not.toBeNull();
    expect(getByText("65%")).not.toBeNull();
  });

  it("omits the cache hit rate when the provider reports no cache reads", () => {
    const task: WorkbenchTask = {
      id: "task-no-cache",
      title: "Task",
      userGoal: "Goal",
      status: "running",
      commanderMessage: "",
      plan: [],
      agents: [],
      logs: [],
      tokenUsage: {
        inputTokens: 10_000,
        outputTokens: 1_000,
        totalTokens: 11_000,
        modelCalls: 4,
        byAgentKind: [],
      },
    };

    const { container, queryByText } = render(
      <ContextRing
        labels={zhCNWorkbenchLocale.labels}
        locale={zhCNWorkbenchLocale}
        task={task}
      />,
    );

    fireEvent.click(container.querySelector<HTMLButtonElement>("button")!);
    expect(queryByText("缓存命中")).toBeNull();
    expect(container.querySelector(".javis-context-window-cache-hit")).toBeNull();
  });
});
