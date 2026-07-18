import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { zhCNWorkbenchLocale } from "../locale";
import type { WorkbenchModelConfiguration, WorkbenchTask } from "../types";
import { ContextRing } from "./ContextRing";

describe("ContextRing", () => {
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

    const { container, getByRole } = render(
      <ContextRing
        labels={zhCNWorkbenchLocale.labels}
        locale={zhCNWorkbenchLocale}
        task={task}
        modelConfiguration={modelConfiguration}
      />,
    );

    const trigger = getByRole("button");
    expect(trigger.getAttribute("aria-label")).toContain("1.2k / 10k");

    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(
      container.querySelector<HTMLElement>(".javis-context-window-agent-bar span")?.style.width,
    ).toBe("100%");
  });
});
