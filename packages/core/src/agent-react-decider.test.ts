import { describe, expect, it } from "vitest";
import { buildReActDecisionPrompt } from "./agent-react-decider";

describe("buildReActDecisionPrompt", () => {
  const baseRequest = {
    agentKind: "file",
    stepId: "scan-files",
    stepTitle: "Scan markdown documents",
    userGoal: "Find all markdown files in the workspace",
    observations: [],
    availableTools: [
      { name: "file.scanMarkdownDocuments", summary: "Scan markdown files", capabilityTags: ["file_scan"] },
    ],
  };

  it("includes success criteria from Commander plan", () => {
    const prompt = buildReActDecisionPrompt({
      ...baseRequest,
      successCriteria: "At least 5 markdown files found and listed.",
    });

    expect(prompt).toContain("Success criteria: At least 5 markdown files found and listed.");
  });

  it("includes capability tag", () => {
    const prompt = buildReActDecisionPrompt({
      ...baseRequest,
      capability: "file_scan",
    });

    expect(prompt).toContain("Primary capability: file_scan");
  });

  it("uses default values when successCriteria and capability are omitted", () => {
    const prompt = buildReActDecisionPrompt(baseRequest);

    expect(prompt).toContain("Success criteria: Step completed with evidence.");
    expect(prompt).toContain("Primary capability: general");
  });

  it("includes prior observations in the prompt", () => {
    const prompt = buildReActDecisionPrompt({
      ...baseRequest,
      observations: [
        { iteration: 1, toolName: "file.scanMarkdownDocuments", status: "succeeded" as const, output: ["README.md", "CHANGELOG.md"] },
        { iteration: 2, toolName: "web.search", status: "failed" as const, output: undefined, error: "Network timeout" },
      ],
    });

    expect(prompt).toContain("[1] Tool: file.scanMarkdownDocuments | Status: succeeded");
    expect(prompt).toContain("[2] Tool: web.search | Status: failed | Error: Network timeout");
  });

  it("includes available tools JSON", () => {
    const prompt = buildReActDecisionPrompt(baseRequest);

    expect(prompt).toContain('"file.scanMarkdownDocuments"');
    expect(prompt).toContain('"file_scan"');
  });
});
