import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentPromptBundle,
  createDefaultAgentRegistry,
  createRouteRegistry,
  createWorkflowRegistry,
} from "@javis/core";
import {
  loadWorkspaceDefinitions,
  planWorkspaceDefinitionCreate,
  planWorkspaceDefinitionDelete,
  registerWorkspaceAgents,
  registerWorkspaceRoutes,
  registerWorkspaceWorkflows,
  saveWorkspaceDefinition,
  deleteWorkspaceDefinition,
  validateWorkspaceDefinition,
} from "./workspace-loader";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

function validWorkspace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "secure-workspace",
    title: "Secure Workspace",
    icon: "S",
    description: "A test workspace",
    viewType: "chat",
    sidebarGroup: "custom",
    sidebarOrder: 10,
    version: "0.1.0",
    enabled: true,
    agents: [],
    ...overrides,
  };
}

function validAgent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "workspace-code",
    kind: "workspace.secure-workspace.code-reviewer",
    displayName: "Workspace Code",
    description: "Reviews code",
    allowedToolNames: [],
    modelRequirements: { prefersVision: false, prefersCode: true, minContextTokens: 8_000 },
    systemPrompt: { en: "Review code safely.", zhCN: "安全审查代码。" },
    ...overrides,
  };
}

function validWorkflow(
  id: string,
  steps: Array<Record<string, unknown>> = [{
    id: "run",
    title: "Run",
    agentKind: "commander",
    input: "Goal",
    output: "Result",
    permissionLevel: "read",
    dependsOn: [],
    canRunInParallel: false,
  }],
): Record<string, unknown> {
  return {
    id,
    title: id,
    triggerExamples: [id],
    goal: `Run ${id}`,
    coordinatorAgentKind: "commander",
    participatingAgentKinds: ["commander"],
    steps,
    currentSupport: "partial",
    safetyNotes: [],
  };
}

function validRoute(routeKind: string, workflowId: string): Record<string, unknown> {
  return {
    routeKind,
    workflowId,
    scoring: {
      keywordPatterns: [{ pattern: routeKind, weight: 2, signalName: `${routeKind}-match` }],
    },
  };
}

describe("workspace-loader validation", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("binds workspace create and delete to native plan-approve-execute calls", async () => {
    const definition = validateWorkspaceDefinition(validWorkspace());
    const createPlan = {
      approvalId: "approval-create",
      workspaceId: "secure-workspace",
      action: "create",
      payloadHash: "create-hash",
      dryRun: { operation: "workspace.create", affectedPaths: [], riskSummary: "create", reversible: true },
    };
    const deletePlan = {
      approvalId: "approval-delete",
      workspaceId: "secure-workspace",
      action: "delete",
      payloadHash: "delete-hash",
      dryRun: { operation: "workspace.delete", affectedPaths: [], riskSummary: "delete", reversible: false },
    };
    invokeMock.mockResolvedValueOnce(createPlan);
    await expect(planWorkspaceDefinitionCreate(
      definition,
      "task-create",
    )).resolves.toEqual(createPlan);
    invokeMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    await saveWorkspaceDefinition(
      definition,
      "approval-create",
      "task-create",
    );

    invokeMock.mockResolvedValueOnce(deletePlan);
    await expect(planWorkspaceDefinitionDelete("secure-workspace", "task-delete"))
      .resolves.toEqual(deletePlan);
    invokeMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    await deleteWorkspaceDefinition("secure-workspace", "approval-delete", "task-delete");

    expect(invokeMock.mock.calls).toEqual([
      ["plan_workspace_create", { request: { definition, taskId: "task-create" } }],
      ["approve_workspace_mutation", { request: { approvalId: "approval-create", taskId: "task-create" } }],
      ["execute_workspace_create", { request: { approvalId: "approval-create", definition, taskId: "task-create" } }],
      ["plan_workspace_delete", { request: { workspaceId: "secure-workspace", taskId: "task-delete" } }],
      ["approve_workspace_mutation", { request: { approvalId: "approval-delete", taskId: "task-delete" } }],
      ["execute_workspace_delete", { request: { approvalId: "approval-delete", workspaceId: "secure-workspace", taskId: "task-delete" } }],
    ]);
  });

  it("rejects an invalid workspace definition before native preview or execution", async () => {
    const invalid = { id: "Broken", title: "Broken" } as ReturnType<typeof validateWorkspaceDefinition>;

    await expect(planWorkspaceDefinitionCreate(invalid, "task-invalid"))
      .rejects.toThrow(/id has an invalid format/i);
    await expect(saveWorkspaceDefinition(invalid, "approval-invalid", "task-invalid"))
      .rejects.toThrow(/id has an invalid format/i);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("rejects malformed agent schema, unsupported fields, and duplicate ids", () => {
    expect(() => validateWorkspaceDefinition(validWorkspace({
      agents: [validAgent({ extra: "ignore safety" })],
    }))).toThrow(/unsupported field extra/);

    expect(() => validateWorkspaceDefinition(validWorkspace({
      agents: [validAgent({ allowedToolNames: ["code.searchRepository", "code.searchRepository"] })],
    }))).toThrow(/contains duplicates/);

    expect(() => validateWorkspaceDefinition(validWorkspace({
      agents: [
        validAgent(),
        validAgent({ kind: "workspace.secure-workspace.second-reviewer" }),
      ],
    }))).toThrow(/Duplicate workspace agent id/);
  });

  it("bounds prompt text and validates enum values", () => {
    expect(() => validateWorkspaceDefinition(validWorkspace({ sidebarGroup: "unsafe" })))
      .toThrow(/sidebarGroup/);
    expect(() => validateWorkspaceDefinition(validWorkspace({
      agents: [validAgent({ systemPrompt: { en: "x".repeat(8_001), zhCN: "ok" } })],
    }))).toThrow(/exceeds 8000/);
    expect(() => validateWorkspaceDefinition(validWorkspace({
      agents: [validAgent({ kind: "unknown-agent" })],
    }))).toThrow(/kind/);
  });

  it("rejects duplicate agent ids across loaded definitions", async () => {
    invokeMock.mockResolvedValue([
      validWorkspace({
        id: "first",
        agents: [validAgent({ id: "shared-agent", kind: "workspace.first.reviewer" })],
      }),
      validWorkspace({
        id: "second",
        agents: [validAgent({ id: "shared-agent", kind: "workspace.second.reviewer" })],
      }),
    ]);

    await expect(loadWorkspaceDefinitions()).rejects.toThrow(/Duplicate workspace agent id/);
  });

  it("requires owned custom kinds and does not let workspace agents shadow a built-in kind", () => {
    const registry = createDefaultAgentRegistry();

    expect(() => validateWorkspaceDefinition(validWorkspace({
      agents: [validAgent({ kind: "code" })],
    }))).toThrow(/must use the namespace workspace\.secure-workspace/);
    expect(registry.findByKind("code")?.agent.id).not.toBe("workspace-code");
  });

  it("registers an owned custom agent without promoting its prompt into system policy", () => {
    const registry = createDefaultAgentRegistry();
    const definition = validateWorkspaceDefinition(validWorkspace({ agents: [validAgent()] }));

    registerWorkspaceAgents([definition], registry);
    try {
      expect(registry.findByKind("workspace.secure-workspace.code-reviewer")?.agent.id)
        .toBe("workspace-code");
      const prompt = buildAgentPromptBundle({
        kind: "workspace.secure-workspace.code-reviewer",
        locale: "en",
      });
      expect(prompt.systemPrompt).not.toContain("Review code safely.");
      expect(prompt.runtimeMessage).toContain("Review code safely.");
    } finally {
      registry.unregister("workspace-code");
    }
  });

  it("rejects custom agent kinds owned by a different workspace", () => {
    expect(() => validateWorkspaceDefinition(validWorkspace({
      agents: [validAgent({ kind: "workspace.other-workspace.reviewer" })],
    }))).toThrow(/must use the namespace workspace\.secure-workspace/);
  });

  it("rejects cyclic workspace workflows during definition validation", () => {
    expect(() => validateWorkspaceDefinition(validWorkspace({
      workflows: [validWorkflow("cyclic-workflow", [
        {
          id: "first-step",
          title: "First",
          agentKind: "commander",
          input: "Goal",
          output: "First result",
          permissionLevel: "read",
          dependsOn: ["second-step"],
          canRunInParallel: false,
        },
        {
          id: "second-step",
          title: "Second",
          agentKind: "commander",
          input: "First result",
          output: "Second result",
          permissionLevel: "read",
          dependsOn: ["first-step"],
          canRunInParallel: false,
        },
      ])],
    }))).toThrow(/cyclic dependency: first-step -> second-step -> first-step/);
  });

  it("preflights route collisions without partially registering earlier routes", () => {
    const registry = createRouteRegistry();
    registry.register("workspace.first.research", "existing-workflow", () => ({
      route: "workspace.first.research",
      score: 9,
      signals: ["existing"],
    }));
    const first = validateWorkspaceDefinition(validWorkspace({
      id: "first",
      workflows: [validWorkflow("first-workflow")],
      routes: [validRoute("workspace.first.research", "first-workflow")],
    }));
    const second = validateWorkspaceDefinition(validWorkspace({
      id: "second",
      workflows: [validWorkflow("second-workflow")],
      routes: [validRoute("workspace.second.code", "second-workflow")],
    }));

    expect(() => registerWorkspaceRoutes([first, second], registry))
      .toThrow(/workspace\.first\.research is already registered and cannot be shadowed/);
    expect(registry.getWorkflowId("workspace.second.code")).toBeUndefined();
    expect(registry.getWorkflowId("workspace.first.research")).toBe("existing-workflow");
  });

  it("preflights workflow collisions without partially registering earlier workflows", () => {
    const registry = createWorkflowRegistry();
    const first = validateWorkspaceDefinition(validWorkspace({
      id: "first",
      workflows: [validWorkflow("shared-workflow")],
    }));
    const second = validateWorkspaceDefinition(validWorkspace({
      id: "second",
      workflows: [validWorkflow("shared-workflow")],
    }));

    expect(() => registerWorkspaceWorkflows([first, second], registry))
      .toThrow(/Duplicate workspace workflow id: shared-workflow/);
    expect(registry.get("shared-workflow")).toBeUndefined();
  });

  it("rejects route regex features that can cause catastrophic backtracking", () => {
    const unsafePatterns = [
      "(a+)+$",
      "(a|aa)+$",
      "(?=unsafe)unsafe",
      "(unsafe)\\1",
      "a.*b.*c",
      "a{0,64}a{0,64}z",
      "a{0,65}",
    ];

    for (const pattern of unsafePatterns) {
      expect(() => validateWorkspaceDefinition(validWorkspace({
        workflows: [validWorkflow("safe-route-workflow")],
        routes: [{
          routeKind: "workspace.secure-workspace.safe-route",
          workflowId: "safe-route-workflow",
          scoring: {
            keywordPatterns: [{ pattern, weight: 2, signalName: "unsafe-pattern" }],
          },
        }],
      }))).toThrow(/pattern is potentially unsafe/);
    }
  });

  it("keeps malformed route regex errors distinct from unsafe-but-valid patterns", () => {
    expect(() => validateWorkspaceDefinition(validWorkspace({
      workflows: [validWorkflow("invalid-route-workflow")],
      routes: [{
        routeKind: "workspace.secure-workspace.invalid-route",
        workflowId: "invalid-route-workflow",
        scoring: {
          keywordPatterns: [{ pattern: "(", weight: 2, signalName: "invalid-pattern" }],
        },
      }],
    }))).toThrow(/not a valid regular expression/);
  });

  it("keeps documented alternation and one wildcard repeat per alternative", () => {
    const registry = createRouteRegistry();
    const definition = validateWorkspaceDefinition(validWorkspace({
      workflows: [validWorkflow("writing-workflow")],
      routes: [{
        routeKind: "workspace.secure-workspace.writing",
        workflowId: "writing-workflow",
        scoring: {
          keywordPatterns: [{
            pattern: "polish|improve.*writing|plan.*day",
            weight: 3,
            signalName: "writing-match",
          }],
          threshold: 2,
        },
      }],
    }));

    registerWorkspaceRoutes([definition], registry);

    expect(registry.scoreAll("Please improve this technical writing")[0]).toMatchObject({
      route: "workspace.secure-workspace.writing",
      score: 3,
      signals: ["writing-match"],
      threshold: 2,
    });
  });

  it("rolls back all workspace agents when registration mutates then throws", () => {
    const registry = createDefaultAgentRegistry();
    const first = validateWorkspaceDefinition(validWorkspace({
      id: "first",
      agents: [validAgent({ id: "first-agent", kind: "workspace.first.reviewer" })],
    }));
    const second = validateWorkspaceDefinition(validWorkspace({
      id: "second",
      agents: [validAgent({ id: "second-agent", kind: "workspace.second.reviewer" })],
    }));
    const originalRegister = registry.register.bind(registry);
    let calls = 0;
    const registerSpy = vi.spyOn(registry, "register").mockImplementation((agent, options) => {
      originalRegister(agent, options);
      calls += 1;
      if (calls === 2) throw new Error("agent registration failed");
    });

    try {
      expect(() => registerWorkspaceAgents([first, second], registry))
        .toThrow(/agent registration failed/);
      expect(registry.findByKind("workspace.first.reviewer")).toBeUndefined();
      expect(registry.findByKind("workspace.second.reviewer")).toBeUndefined();
    } finally {
      registerSpy.mockRestore();
      registry.unregister("first-agent");
      registry.unregister("second-agent");
    }
  });

  it("rolls back all workspace workflows when registration mutates then throws", () => {
    const registry = createWorkflowRegistry();
    const definition = validateWorkspaceDefinition(validWorkspace({
      workflows: [validWorkflow("first-workflow"), validWorkflow("second-workflow")],
    }));
    const originalRegister = registry.register.bind(registry);
    let calls = 0;
    vi.spyOn(registry, "register").mockImplementation((workflow) => {
      originalRegister(workflow);
      calls += 1;
      if (calls === 2) throw new Error("workflow registration failed");
    });

    expect(() => registerWorkspaceWorkflows([definition], registry))
      .toThrow(/workflow registration failed/);
    expect(registry.get("first-workflow")).toBeUndefined();
    expect(registry.get("second-workflow")).toBeUndefined();
  });

  it("rolls back all workspace routes when registration mutates then throws", () => {
    const registry = createRouteRegistry();
    const definition = validateWorkspaceDefinition(validWorkspace({
      workflows: [validWorkflow("first-workflow"), validWorkflow("second-workflow")],
      routes: [
        validRoute("workspace.secure-workspace.first", "first-workflow"),
        validRoute("workspace.secure-workspace.second", "second-workflow"),
      ],
    }));
    const originalRegister = registry.register.bind(registry);
    let calls = 0;
    vi.spyOn(registry, "register").mockImplementation((routeKind, workflowId, scoringFn) => {
      originalRegister(routeKind, workflowId, scoringFn);
      calls += 1;
      if (calls === 2) throw new Error("route registration failed");
    });

    expect(() => registerWorkspaceRoutes([definition], registry))
      .toThrow(/route registration failed/);
    expect(registry.getWorkflowId("workspace.secure-workspace.first")).toBeUndefined();
    expect(registry.getWorkflowId("workspace.secure-workspace.second")).toBeUndefined();
  });

  it("revalidates definitions before registration", () => {
    const registry = createDefaultAgentRegistry();
    const malformed = validWorkspace({ agents: [validAgent({ allowedToolNames: ["not a tool"] })] }) as never;

    expect(() => registerWorkspaceAgents([malformed], registry)).toThrow(/allowedToolNames/);
  });
});
