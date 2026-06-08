import { describe, expect, it } from "vitest";
import { buildCommanderPlanPrompt } from "./commander-plan-schema";

describe("buildCommanderPlanPrompt", () => {
  it("requires user-facing plan strings to follow the user's language", () => {
    const prompt = buildCommanderPlanPrompt({
      userGoal: "我想做一个本地视频壁纸播放器",
      workflowId: "commander-dag",
      availableAgents: [{ kind: "commander", allowedToolNames: ["commander.askUser"], capabilities: [] }],
    });

    expect(prompt).toContain("same natural language as the User goal");
    expect(prompt).toContain("If the User goal is Chinese");
    expect(prompt).toContain("Ask exactly ONE blocking question");
  });
});
