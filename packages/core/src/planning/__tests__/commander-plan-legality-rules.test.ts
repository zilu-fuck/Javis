import { describe, expect, it } from "vitest";
import { compileCommanderPlan } from "../commander-plan-compiler";
import type { CommanderDagPlan } from "../../commander-plan-schema";
import type { ToolDescriptor } from "@javis/tools";
import type { CompileCommanderPlanInput } from "../commander-plan-compiler";
import type { CommanderPlanIntents } from "../plan-legality";

// --- Test Helpers -------------------------------------------------------------

function makeToolDescriptor(
  name: string,
  overrides: Partial<ToolDescriptor> = {},
): ToolDescriptor {
  return {
    name,
    permissionLevel: "read",
    summary: `Tool: ${name}`,
    capabilityTags: [],
    ownerAgentKinds: [],
    ...overrides,
  };
}

function makeInput(
  overrides: Partial<CompileCommanderPlanInput> & { plan: CommanderDagPlan },
): CompileCommanderPlanInput {
  return {
    availableAgents: [
      { kind: "commander", allowedToolNames: ["commander.synthesize"] },
      { kind: "file", allowedToolNames: ["file.writeText"] },
      { kind: "research", allowedToolNames: ["web.search"] },
    ],
    availableTools: [
      makeToolDescriptor("commander.synthesize", { capabilityTags: ["synthesis"], ownerAgentKinds: ["commander"] }),
      makeToolDescriptor("file.writeText", {
        permissionLevel: "confirmed_write",
        requiredPlanIntent: "write",
        capabilityTags: ["file_execute"],
        ownerAgentKinds: ["file"],
        requiredInputs: [
          { name: "targetPath", type: "string", nonEmpty: true },
          { name: "content", type: "string" },
        ],
      }),
      makeToolDescriptor("web.search", { capabilityTags: ["web_search"], ownerAgentKinds: ["research"] }),
    ],
    supportedApprovalGatedTools: ["file.writeText"],
    preloadedContextKeys: ["userGoal", "taskId"],
    planIntents: NO_WRITE_INTENT,
    ...overrides,
  };
}

const NO_WRITE_INTENT: CommanderPlanIntents = {
  write: false,
  export: false,
  statistics: false,
  retrieval: true,
};

const WRITE_INTENT: CommanderPlanIntents = {
  write: true,
  export: false,
  statistics: false,
  retrieval: true,
};

function writeTextPlan(overrides: Partial<CommanderDagPlan["steps"][number]> = {}): CommanderDagPlan {
  return {
    title: "Write evidence",
    reasoning: "test",
    steps: [
      {
        id: "collect",
        title: "Collect evidence",
        assignedAgentKind: "research",
        toolName: "web.search",
        requiredCapabilities: ["web_search"],
        dependsOn: [],
        toolInput: { query: "latest topic" },
        outputContextKey: "researchEvidence",
        successCriteria: "Evidence collected.",
      },
      {
        id: "write",
        title: "Write report",
        assignedAgentKind: "file",
        toolName: "file.writeText",
        requiredCapabilities: [],
        dependsOn: ["collect"],
        inputContextKeys: ["researchEvidence"],
        toolInput: { targetPath: "report.md" },
        outputContextKey: "writeResult",
        successCriteria: "Report written.",
        ...overrides,
      },
    ],
  };
}

// --- Tests --------------------------------------------------------------------

describe("compile gate — file.writeText conditional rules", () => {
  it("rejects file.writeText with a non-direct_tool_call executionMode", () => {
    const result = compileCommanderPlan(makeInput({
      plan: writeTextPlan({ executionMode: "react" }),
      planIntents: WRITE_INTENT,
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((diagnostic) =>
        diagnostic.code === "INVALID_EXECUTION_MODE" &&
        diagnostic.stepId === "write" &&
        diagnostic.message.includes("direct_tool_call"),
      )).toBe(true);
    }
  });

  it("rejects absolute write targets with UNSAFE_WRITE_PATH", () => {
    const result = compileCommanderPlan(makeInput({
      plan: writeTextPlan({ toolInput: { targetPath: "E:/workspace/report.md" } }),
      planIntents: WRITE_INTENT,
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const diagnostic = result.diagnostics.find((entry) => entry.code === "UNSAFE_WRITE_PATH");
      expect(diagnostic?.severity).toBe("error");
      expect(diagnostic?.stepId).toBe("write");
      expect(result.repairable).toBe(true);
    }
  });

  it("rejects traversal write targets with UNSAFE_WRITE_PATH", () => {
    const result = compileCommanderPlan(makeInput({
      plan: writeTextPlan({ toolInput: { targetPath: "../escape.md" } }),
      planIntents: WRITE_INTENT,
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((diagnostic) => diagnostic.code === "UNSAFE_WRITE_PATH")).toBe(true);
    }
  });

  it("accepts a workspace-relative write target", () => {
    const result = compileCommanderPlan(makeInput({
      plan: writeTextPlan(),
      planIntents: WRITE_INTENT,
    }));
    expect(result.ok).toBe(true);
  });
});

describe("compile gate — write without user intent (Layer 5)", () => {
  it("rejects file.writeText when the user goal has no persistence intent", () => {
    const result = compileCommanderPlan(makeInput({
      plan: writeTextPlan(),
      planIntents: NO_WRITE_INTENT,
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const diagnostic = result.diagnostics.find((entry) => entry.code === "WRITE_WITHOUT_USER_INTENT");
      expect(diagnostic?.stepId).toBe("write");
      expect(diagnostic?.severity).toBe("error");
      // The planner can fix this by removing the write step: repairable.
      expect(result.repairable).toBe(true);
    }
  });

  it("allows file.writeText when the user goal asks to persist", () => {
    const result = compileCommanderPlan(makeInput({
      plan: writeTextPlan(),
      planIntents: WRITE_INTENT,
    }));
    expect(result.ok).toBe(true);
  });

  it("fails closed when intents are missing at runtime", () => {
    const input = makeInput({ plan: writeTextPlan(), planIntents: WRITE_INTENT });
    delete (input as { planIntents?: CommanderPlanIntents }).planIntents;

    const result = compileCommanderPlan(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((entry) => entry.code === "WRITE_WITHOUT_USER_INTENT")).toBe(true);
    }
  });

  it("does not gate non-write tools on missing write intent", () => {
    const plan: CommanderDagPlan = {
      title: "Search only",
      reasoning: "test",
      steps: [{
        id: "collect",
        title: "Collect evidence",
        assignedAgentKind: "research",
        toolName: "web.search",
        requiredCapabilities: ["web_search"],
        dependsOn: [],
        toolInput: { query: "topic" },
        successCriteria: "Evidence collected.",
      }],
    };
    const result = compileCommanderPlan(makeInput({ plan, planIntents: NO_WRITE_INTENT }));
    expect(result.ok).toBe(true);
  });

  it("automatically gates a future document-write tool from its descriptor", () => {
    const input = makeInput({
      plan: writeTextPlan({
        toolName: "file.appendText",
        toolInput: { targetPath: "report.md", content: "append" },
      }),
      planIntents: NO_WRITE_INTENT,
    });
    input.availableAgents = input.availableAgents.map((agent) =>
      agent.kind === "file"
        ? { ...agent, allowedToolNames: [...agent.allowedToolNames, "file.appendText"] }
        : agent
    );
    input.availableTools = [...input.availableTools, makeToolDescriptor("file.appendText", {
      permissionLevel: "confirmed_write",
      requiredPlanIntent: "write",
      capabilityTags: ["file_execute"],
      ownerAgentKinds: ["file"],
      requiredInputs: [
        { name: "targetPath", type: "string", nonEmpty: true },
        { name: "content", type: "string" },
      ],
    })];
    input.supportedApprovalGatedTools = [
      ...(input.supportedApprovalGatedTools ?? []),
      "file.appendText",
    ];

    const result = compileCommanderPlan(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "WRITE_WITHOUT_USER_INTENT",
          stepId: "write",
          message: expect.stringContaining("file.appendText"),
        }),
      ]));
    }
  });
});

describe("compile gate — lexical field checks", () => {
  it("warns on malformed context keys without blocking compilation", () => {
    const plan: CommanderDagPlan = {
      title: "Bad context key",
      reasoning: "test",
      steps: [{
        id: "collect",
        title: "Collect evidence",
        assignedAgentKind: "research",
        toolName: "web.search",
        requiredCapabilities: ["web_search"],
        dependsOn: [],
        toolInput: { query: "topic" },
        outputContextKey: "Research Evidence",
        successCriteria: "Evidence collected.",
      }],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.some((diagnostic) => diagnostic.code === "INVALID_CONTEXT_KEY_FORMAT")).toBe(true);
    }
  });

  it("warns on secret-looking toolInput values without blocking compilation", () => {
    const plan: CommanderDagPlan = {
      title: "Secret in input",
      reasoning: "test",
      steps: [{
        id: "collect",
        title: "Collect evidence",
        assignedAgentKind: "research",
        toolName: "web.search",
        requiredCapabilities: ["web_search"],
        dependsOn: [],
        toolInput: { query: "topic", apiKey: "sk-1234567890" },
        successCriteria: "Evidence collected.",
      }],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.some((diagnostic) =>
        diagnostic.code === "SENSITIVE_DATA_IN_TOOL_INPUT" && diagnostic.stepId === "collect",
      )).toBe(true);
    }
  });
});

describe("compile gate — project-understanding delegation", () => {
  const projectAgents = [
    { kind: "commander", allowedToolNames: ["commander.synthesize"], capabilities: ["synthesis"] },
    { kind: "code", allowedToolNames: ["code.inspectWorkspace", "code.searchRepository"], capabilities: ["workspace_inspect", "code_search"] },
    { kind: "computer", allowedToolNames: ["computer.listDirectory"], capabilities: ["directory_list"] },
    { kind: "verifier", allowedToolNames: ["verifier.check"], capabilities: ["evidence_check"] },
  ];
  const projectTools: ToolDescriptor[] = [
    makeToolDescriptor("commander.synthesize", {
      capabilityTags: ["synthesis"],
      ownerAgentKinds: ["commander"],
    }),
    makeToolDescriptor("code.inspectWorkspace", {
      capabilityTags: ["workspace_inspect"],
      ownerAgentKinds: ["code"],
    }),
    makeToolDescriptor("code.searchRepository", {
      capabilityTags: ["code_search"],
      ownerAgentKinds: ["code"],
      requiredInputs: [{ name: "goal", type: "string", nonEmpty: true }],
    }),
    makeToolDescriptor("computer.listDirectory", {
      capabilityTags: ["directory_list"],
      ownerAgentKinds: ["computer"],
      requiredInputs: [{ name: "path", type: "string", nonEmpty: true }],
    }),
    makeToolDescriptor("verifier.check", {
      capabilityTags: ["evidence_check"],
      ownerAgentKinds: ["verifier"],
    }),
  ];
  const projectIntent: CommanderPlanIntents = {
    ...NO_WRITE_INTENT,
    projectUnderstanding: true,
    desktopInteraction: false,
  };

  function projectPlan(
    worker: CommanderDagPlan["steps"][number],
  ): CommanderDagPlan {
    return {
      title: "Inspect project",
      reasoning: "Gather, verify, and synthesize project evidence.",
      steps: [
        worker,
        {
          id: "verify-project",
          title: "Verify project evidence",
          assignedAgentKind: "verifier",
          toolName: "verifier.check",
          requiredCapabilities: ["evidence_check"],
          dependsOn: [worker.id],
          inputContextKeys: [worker.outputContextKey ?? "projectEvidence"],
          outputContextKey: "verifiedProjectEvidence",
          successCriteria: "Project evidence is independently verified.",
        },
        {
          id: "answer-project",
          title: "Answer with verified findings",
          assignedAgentKind: "commander",
          executionMode: "direct_response",
          requiredCapabilities: ["synthesis"],
          dependsOn: ["verify-project"],
          inputContextKeys: [
            worker.outputContextKey ?? "projectEvidence",
            "verifiedProjectEvidence",
          ],
          successCriteria: "Return the verified project structure and risks.",
        },
      ],
    };
  }

  it("rejects Computer Agent as the evidence worker for a non-GUI project inspection", () => {
    const plan = projectPlan({
      id: "list-root-directory",
      title: "List root directory",
      assignedAgentKind: "computer",
      toolName: "computer.listDirectory",
      executionMode: "direct_tool_call",
      requiredCapabilities: ["directory_list"],
      dependsOn: [],
      toolInput: { path: "E:/workspace" },
      outputContextKey: "projectEvidence",
      successCriteria: "List the workspace root.",
    });

    const result = compileCommanderPlan(makeInput({
      plan,
      availableAgents: projectAgents,
      availableTools: projectTools,
      planIntents: projectIntent,
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.repairable).toBe(true);
      expect(result.diagnostics.map((entry) => entry.code)).toEqual(expect.arrayContaining([
        "MISROUTED_PROJECT_INSPECTION",
        "MISSING_PROJECT_EVIDENCE_STEP",
      ]));
    }
  });

  it("accepts Code Agent evidence followed by Verifier and Commander", () => {
    const plan = projectPlan({
      id: "inspect-project",
      title: "Inspect project structure",
      assignedAgentKind: "code",
      toolName: "code.inspectWorkspace",
      executionMode: "direct_tool_call",
      requiredCapabilities: ["workspace_inspect"],
      dependsOn: [],
      toolInput: { maxDepth: 3, maxEntries: 400 },
      outputContextKey: "projectEvidence",
      successCriteria: "Return repository-backed module and risk evidence.",
    });

    const result = compileCommanderPlan(makeInput({
      plan,
      availableAgents: projectAgents,
      availableTools: projectTools,
      planIntents: projectIntent,
    }));

    expect(result.ok).toBe(true);
  });

  it("rejects Explorer/ReAct as the initial project evidence source", () => {
    const plan = projectPlan({
      id: "explore-project",
      title: "Explore project structure",
      assignedAgentKind: "explorer",
      executionMode: "react",
      primaryCapability: "code_explore",
      requiredCapabilities: ["code_explore"],
      dependsOn: [],
      outputContextKey: "projectEvidence",
      successCriteria: "Explore the workspace structure.",
    });
    const explorerAgents = [
      ...projectAgents,
      { kind: "explorer", allowedToolNames: ["code.searchRepository"], capabilities: ["code_explore"] },
    ];

    const result = compileCommanderPlan(makeInput({
      plan,
      availableAgents: explorerAgents,
      availableTools: projectTools,
      planIntents: projectIntent,
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map((entry) => entry.code)).toEqual(expect.arrayContaining([
        "MISROUTED_PROJECT_INSPECTION",
        "MISSING_PROJECT_EVIDENCE_STEP",
      ]));
    }
  });

  it("rejects project evidence that is not handed through Verifier to Commander", () => {
    const plan: CommanderDagPlan = {
      title: "Inspect project",
      reasoning: "Collect repository evidence without a handoff chain.",
      steps: [{
        id: "inspect-project",
        title: "Inspect project structure",
        assignedAgentKind: "code",
        toolName: "code.inspectWorkspace",
        executionMode: "direct_tool_call",
        requiredCapabilities: ["workspace_inspect"],
        dependsOn: [],
        toolInput: { maxDepth: 3, maxEntries: 400 },
        outputContextKey: "projectEvidence",
        successCriteria: "Return repository-backed module and risk evidence.",
      }],
    };

    const result = compileCommanderPlan(makeInput({
      plan,
      availableAgents: projectAgents,
      availableTools: projectTools,
      planIntents: projectIntent,
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.repairable).toBe(true);
      expect(result.diagnostics.map((entry) => entry.code)).toEqual(expect.arrayContaining([
        "MISSING_VERIFIER",
        "MISSING_PROJECT_SYNTHESIS_STEP",
      ]));
    }
  });

  it("keeps Computer Agent available when the user explicitly requests File Explorer", () => {
    const plan = projectPlan({
      id: "browse-project",
      title: "Browse project in File Explorer",
      assignedAgentKind: "computer",
      toolName: "computer.listDirectory",
      executionMode: "direct_tool_call",
      requiredCapabilities: ["directory_list"],
      dependsOn: [],
      toolInput: { path: "E:/workspace" },
      outputContextKey: "projectEvidence",
      successCriteria: "List the requested directory.",
    });

    const result = compileCommanderPlan(makeInput({
      plan,
      availableAgents: projectAgents,
      availableTools: projectTools,
      planIntents: { ...projectIntent, desktopInteraction: true },
    }));

    expect(result.ok).toBe(true);
  });
});
