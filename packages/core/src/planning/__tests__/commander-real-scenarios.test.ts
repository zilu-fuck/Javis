import { initialToolDescriptors } from "@javis/tools";
import { describe, expect, it } from "vitest";
import { demoAgents } from "../../agents";
import { compileCommanderPlan } from "../commander-plan-compiler";
import { inferCommanderRouteRequirements } from "../commander-route-contract";
import { detectCommanderPlanIntents } from "../plan-legality";
import scenarios from "../__fixtures__/commander-real-scenarios.json";

type Scenario = {
  id: string;
  prompt: string;
  fixture: string;
  expectedAgentKinds: string[];
  coveredToolNames: string[];
  writeBoundary: "none" | "approval_only";
  computerAgentPolicy: "forbidden" | "required";
};

const realScenarios = scenarios as Scenario[];

describe("Commander real-world QA scenarios", () => {
  it("keeps prompts short, natural, and focused on at most three agents", () => {
    const ids = new Set<string>();

    for (const scenario of realScenarios) {
      expect(ids.has(scenario.id), scenario.id).toBe(false);
      ids.add(scenario.id);
      expect(scenario.prompt.length, scenario.id).toBeGreaterThanOrEqual(6);
      expect(scenario.prompt.length, scenario.id).toBeLessThanOrEqual(32);
      expect(scenario.prompt, scenario.id).not.toMatch(/\b(?:agent|dag|tool|json|direct_tool_call)\b/i);
      expect(scenario.expectedAgentKinds.length, scenario.id).toBeGreaterThanOrEqual(1);
      expect(scenario.expectedAgentKinds.length, scenario.id).toBeLessThanOrEqual(3);
      expect(scenario.coveredToolNames.length, scenario.id).toBeGreaterThanOrEqual(1);
      expect(scenario.fixture.length, scenario.id).toBeGreaterThan(0);
    }
  });

  it("covers every built-in agent and registered tool across the scenario set", () => {
    const coveredAgents = new Set(realScenarios.flatMap((scenario) => scenario.expectedAgentKinds));
    const coveredTools = new Set(realScenarios.flatMap((scenario) => scenario.coveredToolNames));

    expect([...coveredAgents].sort()).toEqual(demoAgents.map((agent) => agent.kind).sort());
    expect([...coveredTools].sort()).toEqual(initialToolDescriptors.map((tool) => tool.name).sort());
  });

  it("keeps tool ownership aligned with each scenario's expected agents", () => {
    const toolsByName = new Map(initialToolDescriptors.map((tool) => [tool.name, tool]));

    for (const scenario of realScenarios) {
      for (const toolName of scenario.coveredToolNames) {
        const descriptor = toolsByName.get(toolName);
        expect(descriptor, `${scenario.id}:${toolName}`).toBeDefined();
        expect(
          descriptor?.ownerAgentKinds.some((owner) => scenario.expectedAgentKinds.includes(owner)),
          `${scenario.id}:${toolName}`,
        ).toBe(true);
      }
    }
  });

  it("separates read-only runs from approval-boundary runs", () => {
    const toolsByName = new Map(initialToolDescriptors.map((tool) => [tool.name, tool]));

    for (const scenario of realScenarios) {
      const writeTools = scenario.coveredToolNames.filter(
        (toolName) => toolsByName.get(toolName)?.permissionLevel === "confirmed_write",
      );
      if (scenario.writeBoundary === "none") {
        expect(writeTools, scenario.id).toEqual([]);
      } else {
        expect(writeTools.length, scenario.id).toBeGreaterThan(0);
      }
    }
  });

  it("allows Computer Agent only for genuine desktop or local-machine tasks", () => {
    const computerToolNames = new Set(
      initialToolDescriptors
        .filter((tool) => tool.ownerAgentKinds.includes("computer"))
        .map((tool) => tool.name),
    );

    for (const scenario of realScenarios) {
      const expectsComputer = scenario.expectedAgentKinds.includes("computer");
      expect(expectsComputer, scenario.id).toBe(scenario.computerAgentPolicy === "required");
      if (scenario.computerAgentPolicy === "forbidden") {
        expect(
          scenario.coveredToolNames.filter((toolName) => computerToolNames.has(toolName)),
          scenario.id,
        ).toEqual([]);
      }
    }
  });

  it("keeps inferred required routes inside each declared scenario", () => {
    for (const scenario of realScenarios) {
      const routes = inferCommanderRouteRequirements(scenario.prompt);
      for (const route of routes) {
        expect(scenario.expectedAgentKinds, `${scenario.id}:${route.reason}`)
          .toContain(route.agentKind);
        expect(scenario.coveredToolNames, scenario.id)
          .toEqual(expect.arrayContaining(route.requiredToolNames));
        if ((route.requiredAnyToolNames?.length ?? 0) > 0) {
          expect(
            route.requiredAnyToolNames?.some((toolName) =>
              scenario.coveredToolNames.includes(toolName)
            ),
            scenario.id,
          ).toBe(true);
        }
      }
    }
  });

  it.each(realScenarios)("rejects Commander-only completion for $id", (scenario) => {
    const result = compileCommanderPlan({
      plan: {
        title: "直接回答",
        reasoning: "由 Commander 直接总结。",
        steps: [{
          id: "answer",
          title: "直接回答",
          assignedAgentKind: "commander",
          toolName: "commander.synthesize",
          requiredCapabilities: ["synthesis"],
          executionMode: "direct_response",
          dependsOn: [],
          inputContextKeys: ["userGoal"],
          successCriteria: "回答用户问题。",
        }],
      },
      userGoal: scenario.prompt,
      availableAgents: demoAgents.map((agent) => ({
        kind: agent.kind,
        allowedToolNames: agent.allowedToolNames,
      })),
      availableTools: initialToolDescriptors,
      supportedApprovalGatedTools: initialToolDescriptors
        .filter((tool) => tool.permissionLevel === "confirmed_write")
        .map((tool) => tool.name),
      preloadedContextKeys: ["userGoal", "taskId", "imagePath"],
      planIntents: detectCommanderPlanIntents(scenario.prompt),
    });

    expect(result.ok, scenario.id).toBe(false);
  });
});
