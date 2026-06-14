import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletionResult, ModelProvider } from "./model-provider";
import appRuntimeSource from "./app-runtime.ts?raw";

const normalizedAppRuntimeSource = appRuntimeSource.replace(/\r\n/g, "\n");

const modelMocks = vi.hoisted(() => ({
  provider: undefined as ModelProvider | undefined,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
}));

vi.mock("./model-provider", async () => {
  const actual = await vi.importActual<typeof import("./model-provider")>("./model-provider");
  return {
    ...actual,
    createConfiguredModelProvider: vi.fn(() => modelMocks.provider),
    createModelProviderFromProfile: vi.fn(() => modelMocks.provider),
  };
});

import { invoke } from "@tauri-apps/api/core";
import {
  COMPUTER_USE_BUNDLED_LOCAL_VISION_MODEL_PATH,
  COMPUTER_USE_LOCAL_VISION_STORAGE_KEY,
  createJavisRuntime,
  loadComputerUseConfigFromStorage,
  loadComputerUseLocalVisionSettingsFromStorage,
  loadComputerUseSettingsFromStorage,
  saveComputerUseLocalVisionSettingsToStorage,
  saveComputerUseSettingsToStorage,
} from "./app-runtime";
import { DEFAULT_MODEL_SETTINGS } from "./model-settings";
import { encodeMcpToolServerName, initialToolDescriptors } from "@javis/tools";
import { createGoalState, createInitialTaskSnapshot } from "@javis/core";

const COMMANDER_PLAN_SCHEMA_MARKER = '"steps"';

describe("createJavisRuntime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(invoke).mockReset();
    vi.clearAllMocks();
    modelMocks.provider = undefined;
  });

  it("wires live external package registry resolution into repository tracing", () => {
    expect(appRuntimeSource).toContain("externalPackageRegistry");
    expect(appRuntimeSource).toContain("typeof fetch === \"function\"");
    expect(appRuntimeSource).toContain("resolveModuleSpecifierWithFileSearch(moduleRequest");
  });

  it("emits workspace tool activity and audit records from agent tool calls", () => {
    expect(appRuntimeSource).toContain("onWorkspaceToolActivity?: (activity: RuntimeWorkspaceToolActivity) => void");
    expect(appRuntimeSource).toContain("function notifyWorkspaceToolActivity(");
    expect(appRuntimeSource).toContain("toolName: `workspace.${tool}.sync`");
    expect(appRuntimeSource).toContain("notifyWorkspaceToolActivity(\"browser\", \"browser.navigate\"");
    expect(normalizedAppRuntimeSource).toContain("notifyWorkspaceToolActivity(\n          \"review\",\n          \"git.stageFiles\"");
    expect(normalizedAppRuntimeSource).toContain("notifyWorkspaceToolActivity(\n          \"terminal\",\n          \"shell.runReadOnlyCommand\"");
    expect(normalizedAppRuntimeSource).toContain("notifyWorkspaceToolActivity(\n          \"files\",\n          \"file.scanMarkdownDocuments\"");
  });

  it("parses structured Goal verifier results and prevents low-confidence completion", async () => {
    const complete = vi.fn(() => Promise.resolve({
      text: JSON.stringify({
        decision: "complete",
        confidence: "low",
        satisfiedCriteria: ["Persistence works"],
        unsatisfiedCriteria: ["Timeline is not visible"],
        evidence: ["goal_evaluations row exists"],
        completedChecks: ["Persistence works"],
        reason: "Persistence is implemented, but UI is incomplete.",
      }),
    }));
    modelMocks.provider = {
      id: "test-provider",
      settings: {
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyReference: "default",
        baseUrl: "",
      },
      complete,
      stream: vi.fn(async function* () {
        throw new Error("stream unavailable in test");
      }),
      defaultSettingsForLocale: vi.fn(),
    } as unknown as ModelProvider;

    const runtime = createJavisRuntime({
      getWorkspacePath: () => "E:/Javis",
      modelSettings: DEFAULT_MODEL_SETTINGS,
    });
    const decision = await runtime.evaluateGoalCompletion(
      createGoalState({
        id: "goal-1",
        objective: "Ship Goal mode",
        acceptanceCriteria: ["Persistence works", "Timeline is visible"],
        now: "2026-06-09T00:00:00.000Z",
      }),
      {
        ...createInitialTaskSnapshot(),
        id: "task-1",
        title: "Goal task",
        userGoal: "Implement persistence",
        status: "completed",
        commanderMessage: "Persistence implemented.",
      },
    );

    expect(decision.status).toBe("continue");
    expect(decision.confidence).toBe("low");
    expect(decision.satisfiedCriteria).toEqual(["Persistence works"]);
    expect(decision.unsatisfiedCriteria).toEqual(["Timeline is not visible"]);
    expect(decision.evidence).toEqual(["goal_evaluations row exists"]);
    expect(decision.reason).toContain("Goal cannot be marked complete");

    runtime.dispose();
  });

  it("prevents Goal completion when verifier omits concrete evidence", async () => {
    const complete = vi.fn(() => Promise.resolve({
      text: JSON.stringify({
        decision: "complete",
        confidence: "high",
        satisfiedCriteria: ["Everything passes"],
        unsatisfiedCriteria: [],
        evidence: [],
        completedChecks: ["Everything passes"],
        reason: "Looks done.",
      }),
    }));
    modelMocks.provider = {
      id: "test-provider",
      settings: {
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyReference: "default",
        baseUrl: "",
      },
      complete,
      stream: vi.fn(async function* () {
        throw new Error("stream unavailable in test");
      }),
      defaultSettingsForLocale: vi.fn(),
    } as unknown as ModelProvider;

    const runtime = createJavisRuntime({
      getWorkspacePath: () => "E:/Javis",
      modelSettings: DEFAULT_MODEL_SETTINGS,
    });
    const decision = await runtime.evaluateGoalCompletion(
      createGoalState({
        id: "goal-1",
        objective: "Ship Goal mode",
        acceptanceCriteria: ["Everything passes"],
        now: "2026-06-09T00:00:00.000Z",
      }),
      {
        ...createInitialTaskSnapshot(),
        id: "task-1",
        title: "Goal task",
        userGoal: "Verify Goal mode",
        status: "completed",
        commanderMessage: "Done.",
      },
    );

    expect(decision.status).toBe("continue");
    expect(decision.confidence).toBe("high");
    expect(decision.reason).toContain("did not provide concrete evidence");

    runtime.dispose();
  });

  it("keeps startup immediate while waiting for Chinese preprocessing before Commander planning", async () => {
    const preprocessorResponse = deferred<CompletionResult>();
    const commanderPlanPrompts: string[] = [];
    const complete = vi.fn((prompt: string) => {
      if (prompt.includes("Chinese input preprocessor")) {
        return preprocessorResponse.promise;
      }
      if (prompt.includes(COMMANDER_PLAN_SCHEMA_MARKER)) {
        commanderPlanPrompts.push(prompt);
      }
      return Promise.resolve({
        text: JSON.stringify({
          title: "Clarify request",
          reasoning: "Need one detail.",
          steps: [
            {
              id: "ask-scope",
              title: "Which folder should I inspect?",
              assignedAgentKind: "commander",
              toolName: "commander.askUser",
              dependsOn: [],
              successCriteria: "The user clarified the scope.",
            },
          ],
        }),
      });
    });
    const stream = vi.fn(async function* () {
      throw new Error("stream unavailable in test");
    });

    modelMocks.provider = {
      id: "test-provider",
      settings: {
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyReference: "default",
        baseUrl: "",
      },
      complete,
      stream,
      defaultSettingsForLocale: vi.fn(),
    } as unknown as ModelProvider;

    const runtime = createJavisRuntime({
      getWorkspacePath: () => "",
      modelSettings: DEFAULT_MODEL_SETTINGS,
    });
    const snapshots = subscribeToRuntime(runtime);

    runtime.start("帮我检查这个项目", { mode: "project" });

    expect(snapshots.some((snapshot) => snapshot.status === "planning")).toBe(true);
    await vi.waitFor(() =>
      expect(complete).toHaveBeenCalledWith(expect.stringContaining("Chinese input preprocessor"), expect.objectContaining({
        maxTokens: 700,
        temperature: 0,
        locale: "zh-CN",
        skipAgentMemory: true,
        skipSkillContext: true,
      }))
    );

    await vi.advanceTimersByTimeAsync(250);
    expect(commanderPlanPrompts).toEqual([]);

    preprocessorResponse.resolve({
      text: JSON.stringify({
        language: "zh-CN",
        intent: "检查当前项目",
        user_style: "直接",
        must_keep: ["当前项目"],
        must_avoid: ["跳过检查"],
        missing_info: [],
      }),
    });

    await vi.waitFor(() => expect(commanderPlanPrompts).toHaveLength(1));
    expect(commanderPlanPrompts[0]).toContain("Chinese input preprocessing result for planning");
    expect(commanderPlanPrompts[0]).toContain("可用 Agent:");
    expect(commanderPlanPrompts[0]).toContain("可用工具: [{");
    expect(commanderPlanPrompts[0]).toContain("\"file.writeText\"");
    expect(commanderPlanPrompts[0]).toContain("\"permissionLevel\":\"confirmed_write\"");
    expect(commanderPlanPrompts[0]).toContain("\"ownerAgentKinds\"");
    expect(commanderPlanPrompts[0]).toContain("\"browser.click\"");
    expect(commanderPlanPrompts[0]).toContain("\"browser.runTest\"");
    expect(commanderPlanPrompts[0]).not.toContain("\"browser.upload\"");
    expect(commanderPlanPrompts[0]).toContain("\"intent\":\"检查当前项目\"");

    runtime.dispose();
  });

  it("filters disabled tool descriptors out of Commander planning prompts", async () => {
    const commanderPlanPrompts: string[] = [];
    const complete = vi.fn((prompt: string) => {
      if (prompt.includes("Chinese input preprocessor")) {
        return Promise.resolve({ text: "{}" });
      }
      if (prompt.includes(COMMANDER_PLAN_SCHEMA_MARKER)) {
        commanderPlanPrompts.push(prompt);
      }
      return Promise.resolve({
        text: JSON.stringify({
          title: "Answer directly",
          reasoning: "No external memory tool is available.",
          steps: [{
            id: "answer",
            title: "Answer without memory",
            assignedAgentKind: "commander",
            executionMode: "direct_response",
            dependsOn: [],
            successCriteria: "The user receives an answer.",
          }],
        }),
      });
    });
    modelMocks.provider = {
      id: "test-provider",
      settings: {
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyReference: "default",
        baseUrl: "",
      },
      complete,
      stream: vi.fn(async function* () {
        throw new Error("stream unavailable in test");
      }),
      defaultSettingsForLocale: vi.fn(),
    } as unknown as ModelProvider;

    const runtime = createJavisRuntime({
      getWorkspacePath: () => "E:/Javis",
      modelSettings: DEFAULT_MODEL_SETTINGS,
      getAvailableToolDescriptors: () =>
        initialToolDescriptors.filter((descriptor) => descriptor.name !== "memory.search"),
    });
    const snapshots = subscribeToRuntime(runtime);

    runtime.start("What did we decide before?", { mode: "project" });

    await vi.waitFor(() => expect(commanderPlanPrompts).toHaveLength(1));
    expect(commanderPlanPrompts[0]).toContain("可用 Agent:");
    expect(commanderPlanPrompts[0]).toContain("可用工具: [{");
    expect(commanderPlanPrompts[0]).not.toContain("\"memory.search\"");
    await vi.waitFor(() => expect(snapshots[snapshots.length - 1]?.status).toBe("completed"));

    runtime.dispose();
  });

  it("includes discovered MCP subtool descriptors in Commander planning prompts", async () => {
    const commanderPlanPrompts: string[] = [];
    const mcpToolName = `mcp.${encodeMcpToolServerName("javis:filesystem")}.tool.${encodeMcpToolServerName("search")}`;
    const complete = vi.fn((prompt: string) => {
      if (prompt.includes("Chinese input preprocessor")) {
        return Promise.resolve({ text: "{}" });
      }
      if (prompt.includes(COMMANDER_PLAN_SCHEMA_MARKER)) {
        commanderPlanPrompts.push(prompt);
      }
      return Promise.resolve({
        text: JSON.stringify({
          title: "Use MCP",
          reasoning: "A read-only MCP subtool is available.",
          steps: [{
            id: "answer",
            title: "Answer",
            assignedAgentKind: "commander",
            executionMode: "direct_response",
            dependsOn: [],
            successCriteria: "The prompt included available MCP tools.",
          }],
        }),
      });
    });
    modelMocks.provider = {
      id: "test-provider",
      settings: {
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyReference: "default",
        baseUrl: "",
      },
      complete,
      stream: vi.fn(async function* () {
        throw new Error("stream unavailable in test");
      }),
      defaultSettingsForLocale: vi.fn(),
    } as unknown as ModelProvider;
    const runtime = createJavisRuntime({
      getWorkspacePath: () => "E:/Javis",
      modelSettings: DEFAULT_MODEL_SETTINGS,
      getAvailableToolDescriptors: () => [
        ...initialToolDescriptors,
        {
          name: mcpToolName,
          permissionLevel: "read",
          summary: "Search filesystem MCP.",
          capabilityTags: ["local_search"],
          ownerAgentKinds: ["commander"],
          metadata: {
            mcpServerName: "filesystem",
            mcpSource: "javis",
            mcpAction: "callTool",
            mcpToolName: "search",
          },
        },
      ],
    });
    const snapshots = subscribeToRuntime(runtime);

    runtime.start("Search files through MCP", { mode: "project" });

    await vi.waitFor(() => expect(commanderPlanPrompts).toHaveLength(1));
    expect(commanderPlanPrompts[0]).toContain(`"name":"${mcpToolName}"`);
    expect(commanderPlanPrompts[0]).not.toContain("mcp.filesystem.callTool");
    await vi.waitFor(() => expect(snapshots[snapshots.length - 1]?.status).toBe("completed"));

    runtime.dispose();
  });

  it("passes enabled skill context through Commander planning requests", async () => {
    const commanderPlanPrompts: string[] = [];
    const completeCalls: Array<{ prompt: string; options?: unknown }> = [];
    const complete = vi.fn((prompt: string, options?: unknown) => {
      completeCalls.push({ prompt, options });
      if (prompt.includes("Chinese input preprocessor")) {
        return Promise.resolve({ text: "{}" });
      }
      if (prompt.includes(COMMANDER_PLAN_SCHEMA_MARKER)) {
        commanderPlanPrompts.push(prompt);
      }
      return Promise.resolve({
        text: JSON.stringify({
          title: "Use skill",
          reasoning: "A matching enabled skill is available.",
          steps: [{
            id: "answer",
            title: "Answer with skill",
            assignedAgentKind: "commander",
            executionMode: "direct_response",
            dependsOn: [],
            successCriteria: "The answer uses the enabled skill context.",
          }],
        }),
      });
    });
    modelMocks.provider = {
      id: "test-provider",
      settings: {
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyReference: "default",
        baseUrl: "",
      },
      complete,
      stream: vi.fn(async function* () {
        throw new Error("stream unavailable in test");
      }),
      defaultSettingsForLocale: vi.fn(),
    } as unknown as ModelProvider;
    const getEnabledSkillContext = vi.fn(async (request) =>
      request.userGoal.includes("Godot")
        ? "Skill: Godot\nInstructions from SKILL.md:\nUse Godot 4 scene APIs."
        : "",
    );

    const runtime = createJavisRuntime({
      getWorkspacePath: () => "E:/Javis",
      modelSettings: DEFAULT_MODEL_SETTINGS,
      getEnabledSkillContext,
    });
    const snapshots = subscribeToRuntime(runtime);

    runtime.start("Build a Godot scene", { mode: "project" });

    await vi.waitFor(() => expect(commanderPlanPrompts).toHaveLength(1));
    expect(getEnabledSkillContext).toHaveBeenCalledWith(expect.objectContaining({
      agentKind: "commander",
      userGoal: "Build a Godot scene",
      options: expect.objectContaining({ agentKind: "commander" }),
    }));
    const commanderCall = completeCalls.find((call) => call.prompt.includes(COMMANDER_PLAN_SCHEMA_MARKER));
    expect(commanderCall?.options).toEqual(expect.objectContaining({
      skillContext: expect.stringContaining("Use Godot 4 scene APIs."),
    }));
    await vi.waitFor(() => expect(snapshots[snapshots.length - 1]?.status).toBe("completed"));

    runtime.dispose();
  });

  it("executes enabled MCP subtools selected from skill-guided Commander plans", async () => {
    const completeCalls: Array<{ prompt: string; options?: unknown }> = [];
    const encodedServerName = encodeMcpToolServerName("javis:filesystem");
    const mcpToolName = `mcp.${encodedServerName}.tool.${encodeMcpToolServerName("search")}`;
    const complete = vi.fn((prompt: string, options?: unknown) => {
      completeCalls.push({ prompt, options });
      if (prompt.includes("Chinese input preprocessor")) {
        return Promise.resolve({ text: "{}" });
      }
      if (prompt.includes("Write a concise natural-language answer")) {
        return Promise.resolve({ text: "Found matching MCP search results." });
      }
      return Promise.resolve({
        text: JSON.stringify({
          title: "Use skill-selected MCP",
          reasoning: "The enabled skill points to the filesystem MCP search tool.",
          steps: [{
            id: "mcp-search",
            title: "Search through MCP",
            assignedAgentKind: "commander",
            toolName: mcpToolName,
            requiredCapabilities: ["local_search"],
            executionMode: "direct_tool_call",
            toolInput: {
              parameters: {
                query: "skill-guided search",
              },
            },
            outputContextKey: "mcpSearchResult",
            dependsOn: [],
            successCriteria: "MCP search returns results.",
          }],
        }),
      });
    });
    modelMocks.provider = {
      id: "test-provider",
      settings: {
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyReference: "default",
        baseUrl: "",
      },
      complete,
      stream: vi.fn(async function* () {
        throw new Error("stream unavailable in test");
      }),
      defaultSettingsForLocale: vi.fn(),
    } as unknown as ModelProvider;
    const getEnabledSkillContext = vi.fn(async () =>
      "Skill: Filesystem Search\nInstructions from SKILL.md:\nUse the read-only filesystem MCP search tool when the user asks to search local files.",
    );
    const callMcpTool = vi.fn(async () => ({ results: ["match.md"] }));
    const runtime = createJavisRuntime({
      getWorkspacePath: () => "E:/Javis",
      modelSettings: DEFAULT_MODEL_SETTINGS,
      getEnabledSkillContext,
      callMcpTool,
      getAvailableToolDescriptors: () => [
        ...initialToolDescriptors,
        {
          name: `mcp.${encodedServerName}.listTools`,
          permissionLevel: "read",
          summary: "Discovery only: list filesystem MCP tools.",
          capabilityTags: ["local_search"],
          ownerAgentKinds: ["commander"],
          metadata: {
            mcpServerName: "filesystem",
            mcpSource: "javis",
            mcpAction: "listTools",
          },
        },
        {
          name: mcpToolName,
          permissionLevel: "read",
          summary: "Call read-only MCP tool search on server filesystem.",
          capabilityTags: ["local_search"],
          ownerAgentKinds: ["commander"],
          metadata: {
            mcpServerName: "filesystem",
            mcpSource: "javis",
            mcpAction: "callTool",
            mcpToolName: "search",
          },
        },
      ],
    });
    const snapshots = subscribeToRuntime(runtime);

    runtime.start("Use the filesystem search skill", { mode: "project", taskId: "task-skill-mcp-e2e" });

    await vi.waitFor(() => expect(callMcpTool).toHaveBeenCalledOnce());
    expect(callMcpTool).toHaveBeenCalledWith({
      serverName: "filesystem",
      source: "javis",
      action: "callTool",
      toolName: "search",
      arguments: {
        query: "skill-guided search",
      },
      input: {
        parameters: {
          query: "skill-guided search",
        },
        toolName: "search",
      },
    });
    const commanderCall = completeCalls.find((call) => call.prompt.includes(COMMANDER_PLAN_SCHEMA_MARKER));
    expect(commanderCall?.options).toEqual(expect.objectContaining({
      skillContext: expect.stringContaining("filesystem MCP search tool"),
    }));
    expect(commanderCall?.prompt).toContain(`"name":"${mcpToolName}"`);
    await vi.waitFor(() => expect(snapshots[snapshots.length - 1]?.status).toBe("completed"));

    runtime.dispose();
  });

  it("passes enabled MCP descriptors into Commander planning prompts", async () => {
    const commanderPlanPrompts: string[] = [];
    const complete = vi.fn((prompt: string) => {
      if (prompt.includes("Chinese input preprocessor")) {
        return Promise.resolve({ text: "{}" });
      }
      if (prompt.includes(COMMANDER_PLAN_SCHEMA_MARKER)) {
        commanderPlanPrompts.push(prompt);
      }
      return Promise.resolve({
        text: JSON.stringify({
          title: "Use MCP",
          reasoning: "An enabled MCP server is available.",
          steps: [{
            id: "answer",
            title: "Answer directly",
            assignedAgentKind: "commander",
            executionMode: "direct_response",
            dependsOn: [],
            successCriteria: "The user receives an answer.",
          }],
        }),
      });
    });
    modelMocks.provider = {
      id: "test-provider",
      settings: {
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyReference: "default",
        baseUrl: "",
      },
      complete,
      stream: vi.fn(async function* () {
        throw new Error("stream unavailable in test");
      }),
      defaultSettingsForLocale: vi.fn(),
    } as unknown as ModelProvider;

    const runtime = createJavisRuntime({
      getWorkspacePath: () => "E:/Javis",
      modelSettings: DEFAULT_MODEL_SETTINGS,
      getAvailableToolDescriptors: () => [
        ...initialToolDescriptors,
        {
          name: "mcp.filesystem.listTools",
          permissionLevel: "read",
          summary: "List filesystem MCP tools.",
          capabilityTags: ["local_search"],
          ownerAgentKinds: ["commander"],
        },
      ],
    });
    const snapshots = subscribeToRuntime(runtime);

    runtime.start("List filesystem MCP tools", { mode: "project" });

    await vi.waitFor(() => expect(commanderPlanPrompts).toHaveLength(1));
    expect(commanderPlanPrompts[0]).toContain("\"mcp.filesystem.listTools\"");
    expect(commanderPlanPrompts[0]).toContain("\"allowedToolNames\":[\"commander.plan\"");
    expect(commanderPlanPrompts[0]).toContain("\"mcp.filesystem.listTools\"");
    await vi.waitFor(() => expect(snapshots[snapshots.length - 1]?.status).toBe("completed"));

    runtime.dispose();
  });

  it("passes encoded MCP list descriptors into Commander planning prompts without metadata noise", async () => {
    const commanderPlanPrompts: string[] = [];
    const complete = vi.fn((prompt: string) => {
      if (prompt.includes("Chinese input preprocessor")) {
        return Promise.resolve({ text: "{}" });
      }
      if (prompt.includes(COMMANDER_PLAN_SCHEMA_MARKER)) {
        commanderPlanPrompts.push(prompt);
      }
      return Promise.resolve({
        text: JSON.stringify({
          title: "Use encoded MCP",
          reasoning: "An enabled MCP server is available.",
          steps: [{
            id: "answer",
            title: "Answer directly",
            assignedAgentKind: "commander",
            executionMode: "direct_response",
            dependsOn: [],
            successCriteria: "The user receives an answer.",
          }],
        }),
      });
    });
    modelMocks.provider = {
      id: "test-provider",
      settings: {
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyReference: "default",
        baseUrl: "",
      },
      complete,
      stream: vi.fn(async function* () {
        throw new Error("stream unavailable in test");
      }),
      defaultSettingsForLocale: vi.fn(),
    } as unknown as ModelProvider;
    const encodedServerName = encodeMcpToolServerName("@scope/filesystem server");

    const runtime = createJavisRuntime({
      getWorkspacePath: () => "E:/Javis",
      modelSettings: DEFAULT_MODEL_SETTINGS,
      getAvailableToolDescriptors: () => [
        ...initialToolDescriptors,
        {
          name: `mcp.${encodedServerName}.listTools`,
          permissionLevel: "read",
          summary: "List filesystem MCP tools.",
          capabilityTags: ["local_search"],
          ownerAgentKinds: ["commander"],
          metadata: { mcpServerName: "@scope/filesystem server" },
        },
      ],
    });
    const snapshots = subscribeToRuntime(runtime);

    runtime.start("List scoped filesystem MCP tools", { mode: "project" });

    await vi.waitFor(() => expect(commanderPlanPrompts).toHaveLength(1));
    expect(commanderPlanPrompts[0]).toContain(`"mcp.${encodedServerName}.listTools"`);
    expect(commanderPlanPrompts[0]).not.toContain(`"mcp.${encodedServerName}.callTool"`);
    expect(commanderPlanPrompts[0]).not.toContain("mcpServerName");
    await vi.waitFor(() => expect(snapshots[snapshots.length - 1]?.status).toBe("completed"));

    runtime.dispose();
  });

  it("caps MCP subtool descriptors in Commander planning prompts", async () => {
    const commanderPlanPrompts: string[] = [];
    const complete = vi.fn((prompt: string) => {
      if (prompt.includes("Chinese input preprocessor")) {
        return Promise.resolve({ text: "{}" });
      }
      if (prompt.includes(COMMANDER_PLAN_SCHEMA_MARKER)) {
        commanderPlanPrompts.push(prompt);
      }
      return Promise.resolve({
        text: JSON.stringify({
          title: "Use capped MCP",
          reasoning: "MCP prompt tools are bounded.",
          steps: [{
            id: "answer",
            title: "Answer directly",
            assignedAgentKind: "commander",
            executionMode: "direct_response",
            dependsOn: [],
            successCriteria: "The user receives an answer.",
          }],
        }),
      });
    });
    modelMocks.provider = {
      id: "test-provider",
      settings: {
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyReference: "default",
        baseUrl: "",
      },
      complete,
      stream: vi.fn(async function* () {
        throw new Error("stream unavailable in test");
      }),
      defaultSettingsForLocale: vi.fn(),
    } as unknown as ModelProvider;
    const encodedServerName = encodeMcpToolServerName("javis:filesystem");
    const mcpDescriptors = Array.from({ length: 20 }, (_, index) => {
      const tool = `read_${String(index).padStart(2, "0")}`;
      return {
        name: `mcp.${encodedServerName}.tool.${encodeMcpToolServerName(tool)}`,
        permissionLevel: "read" as const,
        summary: `Read MCP item ${index}.`,
        capabilityTags: ["local_search"],
        ownerAgentKinds: ["commander"],
        metadata: {
          mcpServerName: "filesystem",
          mcpSource: "javis",
          mcpAction: "callTool",
          mcpToolName: tool,
        },
      };
    });

    const runtime = createJavisRuntime({
      getWorkspacePath: () => "E:/Javis",
      modelSettings: DEFAULT_MODEL_SETTINGS,
      getAvailableToolDescriptors: () => [
        ...initialToolDescriptors,
        {
          name: `mcp.${encodedServerName}.listTools`,
          permissionLevel: "read",
          summary: "Discovery only: list filesystem MCP tools.",
          capabilityTags: ["local_search"],
          ownerAgentKinds: ["commander"],
          metadata: {
            mcpServerName: "filesystem",
            mcpSource: "javis",
            mcpAction: "listTools",
          },
        },
        ...mcpDescriptors,
      ],
    });
    const snapshots = subscribeToRuntime(runtime);

    runtime.start("Use capped MCP tools", { mode: "project" });

    await vi.waitFor(() => expect(commanderPlanPrompts).toHaveLength(1));
    const prompt = commanderPlanPrompts[0];
    expect(prompt).toContain(`"mcp.${encodedServerName}.listTools"`);
    expect(prompt).toContain(`"mcp.${encodedServerName}.tool.${encodeMcpToolServerName("read_00")}"`);
    expect(prompt).toContain(`"mcp.${encodedServerName}.tool.${encodeMcpToolServerName("read_11")}"`);
    expect(prompt).not.toContain(`"mcp.${encodedServerName}.tool.${encodeMcpToolServerName("read_12")}"`);
    expect(prompt).not.toContain(`"mcp.${encodedServerName}.tool.${encodeMcpToolServerName("read_19")}"`);
    await vi.waitFor(() => expect(snapshots[snapshots.length - 1]?.status).toBe("completed"));

    runtime.dispose();
  });

  it("rejects Commander plans that reference capped-out MCP subtools", async () => {
    const commanderPlanPrompts: string[] = [];
    const encodedServerName = encodeMcpToolServerName("javis:filesystem");
    const hiddenToolName = `mcp.${encodedServerName}.tool.${encodeMcpToolServerName("read_12")}`;
    const complete = vi.fn((prompt: string) => {
      if (prompt.includes("Chinese input preprocessor")) {
        return Promise.resolve({ text: "{}" });
      }
      if (prompt.includes(COMMANDER_PLAN_SCHEMA_MARKER)) {
        commanderPlanPrompts.push(prompt);
      }
      return Promise.resolve({
        text: JSON.stringify({
          title: "Use hidden MCP",
          reasoning: "This plan should not validate because the tool was capped from the prompt.",
          steps: [{
            id: "hidden-mcp",
            title: "Call hidden MCP tool",
            assignedAgentKind: "commander",
            toolName: hiddenToolName,
            executionMode: "direct_tool_call",
            toolInput: {},
            dependsOn: [],
            successCriteria: "The MCP tool is called.",
          }],
        }),
      });
    });
    modelMocks.provider = {
      id: "test-provider",
      settings: {
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyReference: "default",
        baseUrl: "",
      },
      complete,
      stream: vi.fn(async function* () {
        throw new Error("stream unavailable in test");
      }),
      defaultSettingsForLocale: vi.fn(),
    } as unknown as ModelProvider;
    const mcpDescriptors = Array.from({ length: 20 }, (_, index) => {
      const tool = `read_${String(index).padStart(2, "0")}`;
      return {
        name: `mcp.${encodedServerName}.tool.${encodeMcpToolServerName(tool)}`,
        permissionLevel: "read" as const,
        summary: `Read MCP item ${index}.`,
        capabilityTags: ["local_search"],
        ownerAgentKinds: ["commander"],
        metadata: {
          mcpServerName: "filesystem",
          mcpSource: "javis",
          mcpAction: "callTool",
          mcpToolName: tool,
        },
      };
    });

    const runtime = createJavisRuntime({
      getWorkspacePath: () => "E:/Javis",
      modelSettings: DEFAULT_MODEL_SETTINGS,
      getAvailableToolDescriptors: () => [
        ...initialToolDescriptors,
        {
          name: `mcp.${encodedServerName}.listTools`,
          permissionLevel: "read",
          summary: "Discovery only: list filesystem MCP tools.",
          capabilityTags: ["local_search"],
          ownerAgentKinds: ["commander"],
          metadata: {
            mcpServerName: "filesystem",
            mcpSource: "javis",
            mcpAction: "listTools",
          },
        },
        ...mcpDescriptors,
      ],
    });
    const snapshots = subscribeToRuntime(runtime);

    runtime.start("Use capped MCP tools", { mode: "project" });

    await vi.waitFor(() => expect(commanderPlanPrompts).toHaveLength(1));
    expect(commanderPlanPrompts[0]).not.toContain(hiddenToolName);
    await vi.waitFor(() => {
      const latest = snapshots[snapshots.length - 1];
      expect(latest?.status).toBe("failed");
      expect(latest?.userFacingError).toContain("outside commander allowedToolNames");
    });

    runtime.dispose();
  });

  it("keeps classification JSON-only calls isolated from enabled skill context", async () => {
    const completeCalls: Array<{ prompt: string; options?: Record<string, unknown> }> = [];
    const complete = vi.fn((prompt: string, options?: Record<string, unknown>) => {
      completeCalls.push({ prompt, options });
      return Promise.resolve({
        text: JSON.stringify([{
          name: "notes.md",
          path: "E:/Javis/notes.md",
          tags: ["notes"],
          category: "文档",
          confidence: 0.9,
        }]),
      });
    });
    modelMocks.provider = {
      id: "test-provider",
      settings: {
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyReference: "default",
        baseUrl: "",
      },
      complete,
      stream: vi.fn(async function* () {
        throw new Error("stream unavailable in test");
      }),
      defaultSettingsForLocale: vi.fn(),
    } as unknown as ModelProvider;
    const getEnabledSkillContext = vi.fn(async () => "Skill: Demo\nDo not enter JSON.");
    const runtime = createJavisRuntime({
      getWorkspacePath: () => "E:/Javis",
      modelSettings: DEFAULT_MODEL_SETTINGS,
      getEnabledSkillContext,
    });

    await runtime.classifyWithFileAgent([{ name: "notes.md", path: "E:/Javis/notes.md", extension: "md" }]);

    expect(getEnabledSkillContext).not.toHaveBeenCalled();
    expect(completeCalls[0]?.options).toEqual(expect.objectContaining({
      skipAgentMemory: true,
      skipSkillContext: true,
    }));
    expect(completeCalls[0]?.options).not.toEqual(expect.objectContaining({
      skillContext: expect.any(String),
    }));
    expect(completeCalls[0]?.prompt).toContain("if unclear, choose 其他 with low confidence");

    runtime.dispose();
  });

  it("keeps workspace scaffold JSON-only calls isolated from enabled skill context", async () => {
    const completeCalls: Array<{ prompt: string; options?: Record<string, unknown> }> = [];
    const complete = vi.fn((prompt: string, options?: Record<string, unknown>) => {
      completeCalls.push({ prompt, options });
      if (prompt.includes("Chinese input preprocessor")) {
        return Promise.resolve({ text: "{}" });
      }
      if (prompt.includes(COMMANDER_PLAN_SCHEMA_MARKER)) {
        return Promise.resolve({
          text: JSON.stringify({
            title: "Scaffold workspace",
            reasoning: "Use workspace scaffold.",
            steps: [{
              id: "scaffold-workspace",
              title: "Create workspace definition draft",
              assignedAgentKind: "workspace",
              toolName: "workspace.scaffold",
              requiredCapabilities: ["workspace_scaffold"],
              dependsOn: [],
              inputContextKeys: ["userGoal"],
              outputContextKey: "workspaceDraft",
              successCriteria: "Workspace JSON draft is created.",
            }],
          }),
        });
      }
      return Promise.resolve({
        text: JSON.stringify({
          id: "demo-workspace",
          title: "Demo Workspace",
          description: "Demo",
          icon: "D",
          enabled: true,
        }),
      });
    });
    modelMocks.provider = {
      id: "test-provider",
      settings: {
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyReference: "default",
        baseUrl: "",
      },
      complete,
      stream: vi.fn(async function* () {
        throw new Error("stream unavailable in test");
      }),
      defaultSettingsForLocale: vi.fn(),
    } as unknown as ModelProvider;
    const getEnabledSkillContext = vi.fn(async () => "Skill: Demo\nDo not enter JSON.");
    const runtime = createJavisRuntime({
      getWorkspacePath: () => "E:/Javis",
      modelSettings: DEFAULT_MODEL_SETTINGS,
      getEnabledSkillContext,
    });
    const snapshots = subscribeToRuntime(runtime);

    runtime.start("Create a demo workspace", { mode: "project" });

    await vi.waitFor(() => expect(snapshots[snapshots.length - 1]?.status).toBe("completed"));
    const scaffoldCall = completeCalls.find((call) =>
      call.prompt.includes("You are creating a Javis workspace definition"),
    );
    expect(scaffoldCall?.options).toEqual(expect.objectContaining({
      skipAgentMemory: true,
      skipSkillContext: true,
    }));
    expect(scaffoldCall?.options).not.toEqual(expect.objectContaining({
      skillContext: expect.any(String),
    }));
    expect(scaffoldCall?.prompt).toContain("rather than inventing facts");

    runtime.dispose();
  });

  it("turns Commander plan-field clarification JSON into an inline askUser question", async () => {
    const complete = vi.fn((prompt: string) => {
      if (prompt.includes("Chinese input preprocessor")) {
        return Promise.resolve({ text: "{}" });
      }
      return Promise.resolve({
        text: JSON.stringify({
          plan: [
            {
              id: "req-clarify",
              title: "Clarify requirements",
              agentKind: "commander",
              successCriteria: "Which local folder should I scan for wallpaper videos?",
            },
            {
              id: "file-scan",
              title: "Scan local video files",
              agentKind: "file",
              capability: "file_scan",
              successCriteria: "Video files are listed.",
            },
          ],
          riskSummary: "Need a local folder before scanning files.",
          needsClarification: true,
        }),
      });
    });

    modelMocks.provider = {
      id: "test-provider",
      settings: {
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyReference: "default",
        baseUrl: "",
      },
      complete,
      stream: vi.fn(async function* () {}),
      defaultSettingsForLocale: vi.fn(),
    } as unknown as ModelProvider;

    const runtime = createJavisRuntime({
      getWorkspacePath: () => "E:/Javis",
      modelSettings: DEFAULT_MODEL_SETTINGS,
    });
    const snapshots = subscribeToRuntime(runtime);

    runtime.start("Build a local wallpaper video browser", { mode: "project" });

    await vi.waitFor(() => {
      const latest = snapshots[snapshots.length - 1];
      expect(latest?.status).toBe("waiting_info");
      expect(latest?.askUserQuestion?.question).toBe("Which local folder should I scan for wallpaper videos?");
    });

    expect(snapshots[snapshots.length - 1]?.commanderMessage).not.toContain("\"plan\"");

    runtime.dispose();
  });

  it("maps runtime preferences into Core user-wait timeouts", async () => {
    const complete = vi.fn((prompt: string) => {
      if (prompt.includes("Chinese input preprocessor")) {
        return Promise.resolve({ text: "{}" });
      }
      return Promise.resolve({
        text: JSON.stringify({
          title: "Clarify quickly",
          reasoning: "Need one detail.",
          steps: [{
            id: "ask-folder",
            title: "Which folder should I inspect?",
            assignedAgentKind: "commander",
            toolName: "commander.askUser",
            dependsOn: [],
            successCriteria: "Folder is known.",
          }],
        }),
      });
    });

    modelMocks.provider = {
      id: "test-provider",
      settings: {
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyReference: "default",
        baseUrl: "",
      },
      complete,
      stream: vi.fn(async function* () {}),
      defaultSettingsForLocale: vi.fn(),
    } as unknown as ModelProvider;

    const runtime = createJavisRuntime({
      getWorkspacePath: () => "E:/Javis",
      modelSettings: DEFAULT_MODEL_SETTINGS,
      getRuntimePreferences: () => ({
        userWaitTimeoutPreset: "custom",
        userWaitTimeoutCustomMs: 60_000,
      }),
    });
    const snapshots = subscribeToRuntime(runtime);

    runtime.start("Inspect a folder", { mode: "project" });

    await vi.waitFor(() => {
      expect(snapshots[snapshots.length - 1]?.status).toBe("waiting_info");
    });
    await vi.advanceTimersByTimeAsync(60_000);

    await vi.waitFor(() => {
      const latest = snapshots[snapshots.length - 1];
      expect(latest?.status).toBe("failed");
      expect(latest?.logs.some((log) =>
        log.title === "timeout" &&
        log.detail.includes("60000ms")
      )).toBe(true);
    });

    runtime.dispose();
  });

  it("bridges Commander git.stageFiles steps to native Git stage commands", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "git_plan_stage_files") {
        return {
          approvalId: "approval-runtime-stage",
          preview: {
            workspaceRoot: "E:/Javis",
            files: [{
              path: "README.md",
              indexStatus: " ",
              worktreeStatus: "M",
              action: "stage",
              contentHash: "hash-1",
            }],
            diffStat: " README.md | 1 +",
            diff: "diff --git a/README.md b/README.md",
            dryRun: {
              operation: "git.stageFiles",
              affectedPaths: [{ source: "README.md", target: "Git index", action: "stage" }],
              riskSummary: "Stages selected files in the Git index.",
              reversible: true,
            },
          },
        };
      }
      if (command === "git_approve_stage_files") {
        return undefined;
      }
      if (command === "git_execute_stage_files") {
        return {
          workspaceRoot: "E:/Javis",
          stagedPaths: ["README.md"],
          fileCount: 1,
          staged: true,
          output: "",
        };
      }
      throw new Error(`Unexpected invoke command: ${command}`);
    });
    const complete = vi.fn((prompt: string) => {
      if (prompt.includes("Chinese input preprocessor")) {
        return Promise.resolve({ text: "{}" });
      }
      if (prompt.includes(COMMANDER_PLAN_SCHEMA_MARKER)) {
        return Promise.resolve({
          text: JSON.stringify({
            title: "Stage selected files",
            reasoning: "Use Code Agent Git staging after approval.",
            steps: [{
              id: "stage-selected",
              title: "Stage selected files",
              assignedAgentKind: "code",
              toolName: "git.stageFiles",
              toolInput: { paths: ["README.md"] },
              requiredCapabilities: ["git_stage"],
              dependsOn: [],
              successCriteria: "Selected files are staged.",
            }],
          }),
        });
      }
      return Promise.resolve({ text: "Staged README.md." });
    });
    modelMocks.provider = {
      id: "test-provider",
      settings: {
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyReference: "default",
        baseUrl: "",
      },
      complete,
      stream: vi.fn(async function* () {
        throw new Error("stream unavailable in test");
      }),
      defaultSettingsForLocale: vi.fn(),
    } as unknown as ModelProvider;

    const runtime = createJavisRuntime({
      getWorkspacePath: () => "E:/Javis",
      modelSettings: DEFAULT_MODEL_SETTINGS,
    });
    const snapshots = subscribeToRuntime(runtime);

    runtime.start("stage README.md", { mode: "project", taskId: "task-runtime-stage" });

    await vi.waitFor(() => {
      expect(snapshots.find((snapshot) =>
        snapshot.permissionRequest?.id === "approval-runtime-stage" &&
        snapshot.permissionRequest.title === "Approve Git stage"
      )).toBeDefined();
    });
    expect(invokeMock).toHaveBeenCalledWith("git_plan_stage_files", {
      request: {
        sessionId: "task-runtime-stage",
        workspaceRoot: "E:/Javis",
        taskId: "task-runtime-stage",
        paths: ["README.md"],
      },
    });

    runtime.resolvePermission("approved", "approval-runtime-stage");

    await vi.waitFor(() => {
      expect(snapshots[snapshots.length - 1]?.status).toBe("completed");
    });
    expect(invokeMock).toHaveBeenCalledWith("git_approve_stage_files", {
      approvalId: "approval-runtime-stage",
      taskId: "task-runtime-stage",
    });
    expect(invokeMock).toHaveBeenCalledWith("git_execute_stage_files", {
      request: {
        approvalId: "approval-runtime-stage",
        sessionId: "task-runtime-stage",
        workspaceRoot: "E:/Javis",
        taskId: "task-runtime-stage",
        paths: ["README.md"],
      },
    });
    expect(snapshots[snapshots.length - 1]?.verificationSummary).toContain("Staged 1 file(s): README.md.");

    runtime.dispose();
  });

  it("bridges Commander git.createCommit steps to native selected-path commit commands", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "git_plan_commit") {
        return {
          approvalId: "approval-runtime-commit",
          preview: {
            workspaceRoot: "E:/Javis",
            branch: "feature/test",
            message: "Commit README update",
            files: [{
              path: "README.md",
              indexStatus: " ",
              worktreeStatus: "M",
              action: "modify",
              contentHash: "hash-1",
            }],
            diffStat: " README.md | 1 +",
            diff: "diff --git a/README.md b/README.md",
            dryRun: {
              operation: "git.createCommit",
              affectedPaths: [{ source: "README.md", target: "README.md", action: "modify" }],
              riskSummary: "Creates a local Git commit for selected paths.",
              reversible: false,
            },
          },
        };
      }
      if (command === "git_approve_commit") {
        return undefined;
      }
      if (command === "git_execute_commit") {
        return {
          workspaceRoot: "E:/Javis",
          branch: "feature/test",
          commitHash: "1234567890abcdef",
          subject: "Commit README update",
          fileCount: 1,
          committed: true,
          output: "",
        };
      }
      throw new Error(`Unexpected invoke command: ${command}`);
    });
    const complete = vi.fn((prompt: string) => {
      if (prompt.includes("Chinese input preprocessor")) {
        return Promise.resolve({ text: "{}" });
      }
      if (prompt.includes(COMMANDER_PLAN_SCHEMA_MARKER)) {
        return Promise.resolve({
          text: JSON.stringify({
            title: "Commit selected files",
            reasoning: "Use Code Agent Git commit after approval.",
            steps: [{
              id: "commit-selected",
              title: "Commit selected files",
              assignedAgentKind: "code",
              toolName: "git.createCommit",
              toolInput: {
                message: "Commit README update",
                paths: ["README.md"],
              },
              requiredCapabilities: ["git_commit"],
              dependsOn: [],
              successCriteria: "Selected files are committed.",
            }],
          }),
        });
      }
      return Promise.resolve({ text: "Committed README.md." });
    });
    modelMocks.provider = {
      id: "test-provider",
      settings: {
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyReference: "default",
        baseUrl: "",
      },
      complete,
      stream: vi.fn(async function* () {
        throw new Error("stream unavailable in test");
      }),
      defaultSettingsForLocale: vi.fn(),
    } as unknown as ModelProvider;

    const runtime = createJavisRuntime({
      getWorkspacePath: () => "E:/Javis",
      modelSettings: DEFAULT_MODEL_SETTINGS,
    });
    const snapshots = subscribeToRuntime(runtime);

    runtime.start("commit README.md", { mode: "project", taskId: "task-runtime-commit" });

    await vi.waitFor(() => {
      expect(snapshots.find((snapshot) =>
        snapshot.permissionRequest?.id === "approval-runtime-commit" &&
        snapshot.permissionRequest.title === "Approve Git commit"
      )).toBeDefined();
    });
    expect(invokeMock).toHaveBeenCalledWith("git_plan_commit", {
      request: {
        sessionId: "task-runtime-commit",
        workspaceRoot: "E:/Javis",
        taskId: "task-runtime-commit",
        message: "Commit README update",
        paths: ["README.md"],
      },
    });

    runtime.resolvePermission("approved", "approval-runtime-commit");

    await vi.waitFor(() => {
      expect(snapshots[snapshots.length - 1]?.status).toBe("completed");
    });
    expect(invokeMock).toHaveBeenCalledWith("git_approve_commit", {
      approvalId: "approval-runtime-commit",
      taskId: "task-runtime-commit",
    });
    expect(invokeMock).toHaveBeenCalledWith("git_execute_commit", {
      request: {
        approvalId: "approval-runtime-commit",
        sessionId: "task-runtime-commit",
        workspaceRoot: "E:/Javis",
        taskId: "task-runtime-commit",
        message: "Commit README update",
        paths: ["README.md"],
      },
    });
    expect(snapshots[snapshots.length - 1]?.verificationSummary)
      .toContain("Created commit 1234567890ab for 1 file(s): Commit README update.");

    runtime.dispose();
  });

  it("bridges Commander git.createPullRequest steps to native draft PR commands", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "git_plan_create_pull_request") {
        return {
          approvalId: "approval-runtime-pr",
          preview: {
            workspaceRoot: "E:/Javis",
            provider: "github-cli",
            title: "Add README update",
            body: "Summarizes the README update.",
            baseBranch: "main",
            headBranch: "feature/readme",
            headCommit: "1234567890abcdef",
            remoteName: "origin",
            remoteUrl: "https://github.com/example/javis.git",
            draft: true,
            dryRun: {
              operation: "git.createPullRequest",
              affectedPaths: [{ source: "feature/readme", target: "main", action: "create_pr" }],
              riskSummary: "Creates a draft GitHub pull request.",
              reversible: false,
            },
          },
        };
      }
      if (command === "git_approve_create_pull_request") {
        return undefined;
      }
      if (command === "git_execute_create_pull_request") {
        return {
          workspaceRoot: "E:/Javis",
          provider: "github-cli",
          url: "https://github.com/example/javis/pull/12",
          title: "Add README update",
          baseBranch: "main",
          headBranch: "feature/readme",
          draft: true,
          created: true,
          output: "https://github.com/example/javis/pull/12",
        };
      }
      throw new Error(`Unexpected invoke command: ${command}`);
    });
    const complete = vi.fn((prompt: string) => {
      if (prompt.includes("Chinese input preprocessor")) {
        return Promise.resolve({ text: "{}" });
      }
      if (prompt.includes(COMMANDER_PLAN_SCHEMA_MARKER)) {
        return Promise.resolve({
          text: JSON.stringify({
            title: "Create pull request",
            reasoning: "Use Code Agent Git PR creation after approval.",
            steps: [{
              id: "create-pr",
              title: "Create draft pull request",
              assignedAgentKind: "code",
              toolName: "git.createPullRequest",
              toolInput: {
                title: "Add README update",
                body: "Summarizes the README update.",
                baseBranch: "main",
                draft: true,
              },
              requiredCapabilities: ["git_pr_create"],
              dependsOn: [],
              successCriteria: "Draft pull request is created.",
            }],
          }),
        });
      }
      return Promise.resolve({ text: "Created draft pull request." });
    });
    modelMocks.provider = {
      id: "test-provider",
      settings: {
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyReference: "default",
        baseUrl: "",
      },
      complete,
      stream: vi.fn(async function* () {
        throw new Error("stream unavailable in test");
      }),
      defaultSettingsForLocale: vi.fn(),
    } as unknown as ModelProvider;

    const runtime = createJavisRuntime({
      getWorkspacePath: () => "E:/Javis",
      modelSettings: DEFAULT_MODEL_SETTINGS,
    });
    const snapshots = subscribeToRuntime(runtime);

    runtime.start("create a PR", { mode: "project", taskId: "task-runtime-pr" });

    await vi.waitFor(() => {
      expect(snapshots.find((snapshot) =>
        snapshot.permissionRequest?.id === "approval-runtime-pr" &&
        snapshot.permissionRequest.title === "Approve Git pull request"
      )).toBeDefined();
    });
    expect(invokeMock).toHaveBeenCalledWith("git_plan_create_pull_request", {
      request: {
        sessionId: "task-runtime-pr",
        workspaceRoot: "E:/Javis",
        taskId: "task-runtime-pr",
        title: "Add README update",
        body: "Summarizes the README update.",
        baseBranch: "main",
        draft: true,
      },
    });

    runtime.resolvePermission("approved", "approval-runtime-pr");

    await vi.waitFor(() => {
      expect(snapshots[snapshots.length - 1]?.status).toBe("completed");
    });
    expect(invokeMock).toHaveBeenCalledWith("git_approve_create_pull_request", {
      approvalId: "approval-runtime-pr",
      taskId: "task-runtime-pr",
    });
    expect(invokeMock).toHaveBeenCalledWith("git_execute_create_pull_request", {
      request: {
        approvalId: "approval-runtime-pr",
        sessionId: "task-runtime-pr",
        workspaceRoot: "E:/Javis",
        taskId: "task-runtime-pr",
        title: "Add README update",
        body: "Summarizes the README update.",
        baseBranch: "main",
        draft: true,
      },
    });
    expect(snapshots[snapshots.length - 1]?.verificationSummary)
      .toContain("Created draft pull request https://github.com/example/javis/pull/12 from feature/readme to main.");

    runtime.dispose();
  });

  it("bridges Commander git.commentPullRequest steps to native PR comment commands", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "git_plan_comment_pull_request") {
        return {
          approvalId: "approval-runtime-pr-comment",
          preview: {
            workspaceRoot: "E:/Javis",
            provider: "github-cli",
            pullRequest: "12",
            body: "Looks good after the latest changes.",
            remoteUrl: "https://github.com/example/javis.git",
            dryRun: {
              operation: "git.commentPullRequest",
              affectedPaths: [{ source: "12", target: "https://github.com/example/javis.git", action: "comment_pr" }],
              riskSummary: "Posts a GitHub pull request comment.",
              reversible: false,
            },
          },
        };
      }
      if (command === "git_approve_comment_pull_request") {
        return undefined;
      }
      if (command === "git_execute_comment_pull_request") {
        return {
          workspaceRoot: "E:/Javis",
          provider: "github-cli",
          pullRequest: "12",
          commented: true,
          output: "https://github.com/example/javis/pull/12#issuecomment-1",
        };
      }
      throw new Error(`Unexpected invoke command: ${command}`);
    });
    const complete = vi.fn((prompt: string) => {
      if (prompt.includes("Chinese input preprocessor")) {
        return Promise.resolve({ text: "{}" });
      }
      if (prompt.includes(COMMANDER_PLAN_SCHEMA_MARKER)) {
        return Promise.resolve({
          text: JSON.stringify({
            title: "Comment on pull request",
            reasoning: "Use Code Agent Git PR comment after approval.",
            steps: [{
              id: "comment-pr",
              title: "Comment on pull request",
              assignedAgentKind: "code",
              toolName: "git.commentPullRequest",
              toolInput: {
                pullRequest: "12",
                body: "Looks good after the latest changes.",
              },
              requiredCapabilities: ["git_pr_comment"],
              dependsOn: [],
              successCriteria: "Pull request comment is posted.",
            }],
          }),
        });
      }
      return Promise.resolve({ text: "Posted pull request comment." });
    });
    modelMocks.provider = {
      id: "test-provider",
      settings: {
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyReference: "default",
        baseUrl: "",
      },
      complete,
      stream: vi.fn(async function* () {
        throw new Error("stream unavailable in test");
      }),
      defaultSettingsForLocale: vi.fn(),
    } as unknown as ModelProvider;

    const runtime = createJavisRuntime({
      getWorkspacePath: () => "E:/Javis",
      modelSettings: DEFAULT_MODEL_SETTINGS,
    });
    const snapshots = subscribeToRuntime(runtime);

    runtime.start("comment on a PR", { mode: "project", taskId: "task-runtime-pr-comment" });

    await vi.waitFor(() => {
      expect(snapshots.find((snapshot) =>
        snapshot.permissionRequest?.id === "approval-runtime-pr-comment" &&
        snapshot.permissionRequest.title === "Approve Git pull request comment"
      )).toBeDefined();
    });
    expect(invokeMock).toHaveBeenCalledWith("git_plan_comment_pull_request", {
      request: {
        sessionId: "task-runtime-pr-comment",
        workspaceRoot: "E:/Javis",
        taskId: "task-runtime-pr-comment",
        pullRequest: "12",
        body: "Looks good after the latest changes.",
      },
    });

    runtime.resolvePermission("approved", "approval-runtime-pr-comment");

    await vi.waitFor(() => {
      expect(snapshots[snapshots.length - 1]?.status).toBe("completed");
    });
    expect(invokeMock).toHaveBeenCalledWith("git_approve_comment_pull_request", {
      approvalId: "approval-runtime-pr-comment",
      taskId: "task-runtime-pr-comment",
    });
    expect(invokeMock).toHaveBeenCalledWith("git_execute_comment_pull_request", {
      request: {
        approvalId: "approval-runtime-pr-comment",
        sessionId: "task-runtime-pr-comment",
        workspaceRoot: "E:/Javis",
        taskId: "task-runtime-pr-comment",
        pullRequest: "12",
        body: "Looks good after the latest changes.",
      },
    });
    expect(snapshots[snapshots.length - 1]?.verificationSummary)
      .toContain("Posted pull request comment on 12.");

    runtime.dispose();
  });

  it("repairs non-JSON Commander plan output before failing plan mode", async () => {
    const complete = vi.fn((prompt: string) => {
      if (prompt.includes("Chinese input preprocessor")) {
        return Promise.resolve({ text: "{}" });
      }
      if (
        prompt.startsWith("Your previous output was not valid JSON") ||
        prompt.startsWith("你之前的输出不是所需 schema 的有效 JSON") ||
        prompt.includes("Previous invalid output:") ||
        prompt.includes("之前的无效输出:")
      ) {
        return Promise.resolve({
          text: JSON.stringify({
            plan: [
              {
                id: "req-clarify",
                title: "Which local wallpaper folder should I scan?",
                agentKind: "commander",
                successCriteria: "The wallpaper folder is known.",
              },
            ],
            riskSummary: "Need a local folder before scanning videos.",
            needsClarification: true,
          }),
        });
      }
      if (prompt.includes(COMMANDER_PLAN_SCHEMA_MARKER)) {
        return Promise.resolve({
          text: "I need to know which local wallpaper folder should be scanned before planning.",
        });
      }
      return Promise.resolve({ text: "{}" });
    });

    modelMocks.provider = {
      id: "test-provider",
      settings: {
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyReference: "default",
        baseUrl: "",
      },
      complete,
      stream: vi.fn(async function* () {
        throw new Error("stream unavailable in test");
      }),
      defaultSettingsForLocale: vi.fn(),
    } as unknown as ModelProvider;

    const runtime = createJavisRuntime({
      getWorkspacePath: () => "E:/Javis",
      modelSettings: DEFAULT_MODEL_SETTINGS,
    });
    const snapshots = subscribeToRuntime(runtime);

    runtime.start("Build a local wallpaper video browser", { mode: "project" });

    await vi.waitFor(() => {
      const latest = snapshots[snapshots.length - 1];
      expect(latest?.status).toBe("waiting_info");
      expect(latest?.askUserQuestion?.question).toBe("The wallpaper folder is known.");
    });

    expect(complete).toHaveBeenCalledWith(
      expect.stringContaining("之前的无效输出"),
      expect.objectContaining({ maxTokens: 1600, temperature: 0, locale: "zh-CN" }),
    );
    const repairPrompt = complete.mock.calls
      .map(([prompt]) => prompt)
      .find((prompt) => prompt.includes("之前的无效输出"));
    expect(repairPrompt).toContain("只修复语法/结构；保留语义，不补事实，不改变决策。");
    expect(repairPrompt).not.toMatch(/Original instruction \/|Previous invalid output \//);

    runtime.dispose();
  });

  it("passes the current task id through enabled memory.search calls", async () => {
    const complete = vi.fn((prompt: string) => {
      if (prompt.includes("Chinese input preprocessor")) {
        return Promise.resolve({ text: "{}" });
      }
      return Promise.resolve({
        text: JSON.stringify({
          title: "Recall memory",
          reasoning: "The user referenced prior work.",
          steps: [{
            id: "recall-memory",
            title: "Search memory",
            assignedAgentKind: "commander",
            toolName: "memory.search",
            requiredCapabilities: ["memory_search"],
            dependsOn: [],
            executionMode: "direct_tool_call",
            inputContextKeys: ["userGoal"],
            successCriteria: "Memory was searched.",
          }],
        }),
      });
    });
    modelMocks.provider = {
      id: "test-provider",
      settings: {
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyReference: "default",
        baseUrl: "",
      },
      complete,
      stream: vi.fn(async function* () {}),
      defaultSettingsForLocale: vi.fn(),
    } as unknown as ModelProvider;
    const searchAgentMemory = vi.fn(async () => [{
      id: "mem-1",
      fact: "Memory remains local.",
      kind: "design_principle",
      tags: ["memory"],
      confidence: 0.9,
      importance: 5,
      updatedAt: 1_700_000_000_000,
    }]);
    const runtime = createJavisRuntime({
      getWorkspacePath: () => "E:/Javis",
      modelSettings: DEFAULT_MODEL_SETTINGS,
      isAgentMemoryEnabled: () => true,
      searchAgentMemory,
    });
    const snapshots = subscribeToRuntime(runtime);

    runtime.start("What did we decide before?", { mode: "project", taskId: "task-memory-search" });

    await vi.waitFor(() => expect(searchAgentMemory).toHaveBeenCalledOnce());
    expect(searchAgentMemory).toHaveBeenCalledWith(expect.objectContaining({
      query: "What did we decide before?",
      taskId: "task-memory-search",
    }));
    await vi.waitFor(() => expect(snapshots[snapshots.length - 1]?.status).toBe("completed"));

    runtime.dispose();
  });

  it("injects audited Agent memory context into Commander planning prompts when enabled", async () => {
    const commanderPlanPrompts: string[] = [];
    const complete = vi.fn((prompt: string) => {
      if (prompt.includes("Chinese input preprocessor")) {
        return Promise.resolve({ text: "{}" });
      }
      if (prompt.includes(COMMANDER_PLAN_SCHEMA_MARKER)) {
        commanderPlanPrompts.push(prompt);
      }
      return Promise.resolve({
        text: JSON.stringify({
          title: "Use memory",
          reasoning: "Relevant prior context is available.",
          steps: [{
            id: "answer",
            title: "Answer from context",
            assignedAgentKind: "commander",
            executionMode: "direct_response",
            dependsOn: [],
            successCriteria: "The answer respects current user input.",
          }],
        }),
      });
    });
    modelMocks.provider = {
      id: "test-provider",
      settings: {
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyReference: "default",
        baseUrl: "",
      },
      complete,
      stream: vi.fn(async function* () {
        throw new Error("stream unavailable in test");
      }),
      defaultSettingsForLocale: vi.fn(),
    } as unknown as ModelProvider;
    const buildAgentMemoryPromptContext = vi.fn(async () =>
      [
        "Memory may be incomplete or outdated.",
        "[Workspace Memory]",
        "- Javis Agent memory stays local.",
      ].join("\n"),
    );
    const runtime = createJavisRuntime({
      getWorkspacePath: () => "E:/Javis",
      modelSettings: DEFAULT_MODEL_SETTINGS,
      isAgentMemoryEnabled: () => true,
      buildAgentMemoryPromptContext,
    });
    const snapshots = subscribeToRuntime(runtime);

    runtime.start("What did we decide before?", { mode: "project", taskId: "task-memory-prompt" });

    await vi.waitFor(() => expect(commanderPlanPrompts).toHaveLength(1));
    expect(buildAgentMemoryPromptContext).toHaveBeenCalledWith({
      userGoal: "What did we decide before?",
      taskId: "task-memory-prompt",
      agentKind: "commander",
    });
    expect(commanderPlanPrompts[0]).toContain("Commander 任务经验和记忆:");
    expect(commanderPlanPrompts[0]).toContain("仅作低 token 提示");
    expect(commanderPlanPrompts[0]).toContain("lesson/blocker/next/confidence");
    expect(commanderPlanPrompts[0]).toContain("[Workspace Memory]");
    expect(commanderPlanPrompts[0]).toContain("Javis Agent memory stays local.");
    await vi.waitFor(() => expect(snapshots[snapshots.length - 1]?.status).toBe("completed"));

    runtime.dispose();
  });

  it("does not build Agent memory prompt context when memory is disabled", async () => {
    const commanderPlanPrompts: string[] = [];
    const complete = vi.fn((prompt: string) => {
      if (prompt.includes("Chinese input preprocessor")) {
        return Promise.resolve({ text: "{}" });
      }
      if (prompt.includes(COMMANDER_PLAN_SCHEMA_MARKER)) {
        commanderPlanPrompts.push(prompt);
      }
      return Promise.resolve({
        text: JSON.stringify({
          title: "No memory",
          reasoning: "Memory is disabled.",
          steps: [{
            id: "answer",
            title: "Answer without memory",
            assignedAgentKind: "commander",
            executionMode: "direct_response",
            dependsOn: [],
            successCriteria: "The answer does not use memory.",
          }],
        }),
      });
    });
    modelMocks.provider = {
      id: "test-provider",
      settings: {
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyReference: "default",
        baseUrl: "",
      },
      complete,
      stream: vi.fn(async function* () {
        throw new Error("stream unavailable in test");
      }),
      defaultSettingsForLocale: vi.fn(),
    } as unknown as ModelProvider;
    const buildAgentMemoryPromptContext = vi.fn(async () => "[Workspace Memory]\n- Should not appear");
    const runtime = createJavisRuntime({
      getWorkspacePath: () => "E:/Javis",
      modelSettings: DEFAULT_MODEL_SETTINGS,
      isAgentMemoryEnabled: () => false,
      buildAgentMemoryPromptContext,
    });
    const snapshots = subscribeToRuntime(runtime);

    runtime.start("What did we decide before?", { mode: "project", taskId: "task-memory-off" });

    await vi.waitFor(() => expect(commanderPlanPrompts).toHaveLength(1));
    expect(buildAgentMemoryPromptContext).not.toHaveBeenCalled();
    expect(commanderPlanPrompts[0]).not.toContain("Commander task lessons and memory:");
    expect(commanderPlanPrompts[0]).not.toContain("Commander 任务经验和记忆:");
    await vi.waitFor(() => expect(snapshots[snapshots.length - 1]?.status).toBe("completed"));

    runtime.dispose();
  });

  it("passes Agent memory context through live agent chat prompts", async () => {
    const streamCalls: Array<{ prompt: string; options?: unknown }> = [];
    const complete = vi.fn((prompt: string) => {
      if (prompt.includes("Chinese input preprocessor")) {
        return Promise.resolve({ text: "{}" });
      }
      return Promise.resolve({ text: "fallback answer" });
    });
    const stream = vi.fn(async function* (prompt: string, options?: unknown) {
      streamCalls.push({ prompt, options });
      yield { text: "memory-aware answer" };
    });
    modelMocks.provider = {
      id: "test-provider",
      settings: {
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyReference: "default",
        baseUrl: "",
      },
      complete,
      stream,
      defaultSettingsForLocale: vi.fn(),
    } as unknown as ModelProvider;
    const buildAgentMemoryPromptContext = vi.fn(async () =>
      [
        "Memory may be incomplete or outdated.",
        "[Workspace Memory]",
        "- Javis Agent memory stays local.",
      ].join("\n"),
    );
    const runtime = createJavisRuntime({
      getWorkspacePath: () => "E:/Javis",
      modelSettings: DEFAULT_MODEL_SETTINGS,
      isAgentMemoryEnabled: () => true,
      buildAgentMemoryPromptContext,
    });
    const snapshots = subscribeToRuntime(runtime);

    runtime.start("What did we decide before?", { mode: "chat", taskId: "task-live-memory" });

    await vi.waitFor(() => expect(streamCalls).toHaveLength(1));
    expect(buildAgentMemoryPromptContext).toHaveBeenCalledWith({
      userGoal: "What did we decide before?",
      taskId: "task-live-memory",
      agentKind: "commander",
    });
    expect(streamCalls[0]?.options).toEqual(expect.objectContaining({
      agentKind: "commander",
      workspacePath: "E:/Javis",
      memoryContext: expect.stringContaining("Javis Agent memory stays local."),
    }));
    await vi.waitFor(() => expect(snapshots[snapshots.length - 1]?.status).toBe("completed"));

    runtime.dispose();
  });

  it("does not inject Agent memory into verifier evidence checks", async () => {
    const completeCalls: Array<{ prompt: string; options?: unknown }> = [];
    const complete = vi.fn((prompt: string, options?: unknown) => {
      completeCalls.push({ prompt, options });
      if (prompt.includes("Chinese input preprocessor")) {
        return Promise.resolve({ text: "{}" });
      }
      if (prompt.includes("Schema: {\"status\":\"pass|warn|fail\"")) {
        return Promise.resolve({
          text: JSON.stringify({
            status: "pass",
            summary: "Evidence passes.",
            detail: "Checked only current evidence.",
          }),
        });
      }
      if (prompt.includes("Write a concise natural-language answer")) {
        return Promise.resolve({
          text: "Verified.",
        });
      }
      return Promise.resolve({
        text: JSON.stringify({
          title: "Verify evidence",
          reasoning: "Use verifier.",
          steps: [{
            id: "verify-evidence",
            title: "Verify evidence",
            assignedAgentKind: "verifier",
            toolName: "verifier.check",
            dependsOn: [],
            inputContextKeys: [],
            successCriteria: "Evidence is sufficient.",
          }],
        }),
      });
    });
    modelMocks.provider = {
      id: "test-provider",
      settings: {
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyReference: "default",
        baseUrl: "",
      },
      complete,
      stream: vi.fn(async function* () {
        throw new Error("stream unavailable in test");
      }),
      defaultSettingsForLocale: vi.fn(),
    } as unknown as ModelProvider;
    const buildAgentMemoryPromptContext = vi.fn(async () => "[Workspace Memory]\n- Should not reach verifier.");
    const runtime = createJavisRuntime({
      getWorkspacePath: () => "E:/Javis",
      modelSettings: DEFAULT_MODEL_SETTINGS,
      isAgentMemoryEnabled: () => true,
      buildAgentMemoryPromptContext,
    });
    const snapshots = subscribeToRuntime(runtime);

    runtime.start("Verify this task", { mode: "project", taskId: "task-verifier-memory" });

    await vi.waitFor(() => expect(snapshots[snapshots.length - 1]?.status).toBe("completed"));
    const verifierCall = completeCalls.find((call) =>
      call.prompt.includes("Schema: {\"status\":\"pass|warn|fail\"")
    );
    expect(verifierCall?.options).toEqual(expect.objectContaining({ skipAgentMemory: true }));
    expect(verifierCall?.options).not.toEqual(expect.objectContaining({
      memoryContext: expect.any(String),
    }));
    expect(verifierCall?.prompt).not.toContain("Should not reach verifier.");
    expect(verifierCall?.prompt).toContain("Do not invent missing evidence");
    const synthesizeCall = completeCalls.find((call) =>
      call.prompt.includes("Write a concise natural-language answer"),
    );
    expect(synthesizeCall?.prompt).toContain("do not fill gaps with guesses");

    runtime.dispose();
  });

  it("fails verifier checks with malformed status", async () => {
    const complete = vi.fn((prompt: string) => {
      if (prompt.includes("Chinese input preprocessor")) {
        return Promise.resolve({ text: "{}" });
      }
      if (prompt.includes("Schema: {\"status\":\"pass|warn|fail\"")) {
        return Promise.resolve({
          text: JSON.stringify({
            status: "unknown",
            summary: "Evidence passes.",
            detail: "The status is malformed.",
          }),
        });
      }
      if (prompt.includes("Write a concise natural-language answer")) {
        return Promise.resolve({ text: "Verification failed." });
      }
      return Promise.resolve({
        text: JSON.stringify({
          title: "Verify evidence",
          reasoning: "Use verifier.",
          steps: [{
            id: "verify-evidence",
            title: "Verify evidence",
            assignedAgentKind: "verifier",
            toolName: "verifier.check",
            dependsOn: [],
            inputContextKeys: [],
            successCriteria: "Evidence is sufficient.",
          }],
        }),
      });
    });
    modelMocks.provider = {
      id: "test-provider",
      settings: {
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyReference: "default",
        baseUrl: "",
      },
      complete,
      stream: vi.fn(async function* () {
        throw new Error("stream unavailable in test");
      }),
      defaultSettingsForLocale: vi.fn(),
    } as unknown as ModelProvider;
    const runtime = createJavisRuntime({
      getWorkspacePath: () => "E:/Javis",
      modelSettings: DEFAULT_MODEL_SETTINGS,
    });
    const snapshots = subscribeToRuntime(runtime);

    runtime.start("Verify malformed status", { mode: "project", taskId: "task-verifier-invalid-status" });

    await vi.waitFor(() => expect(snapshots[snapshots.length - 1]?.status).toBe("failed"));
    const latest = snapshots[snapshots.length - 1];
    expect(latest?.verificationSummary).toBe("fail: Verifier returned invalid status.");

    runtime.dispose();
  });

  it("injects enabled skill context for structured ReAct decisions", async () => {
    const completeCalls: Array<{ prompt: string; options?: unknown }> = [];
    const complete = vi.fn((prompt: string, options?: unknown) => {
      completeCalls.push({ prompt, options });
      if (prompt.includes("Chinese input preprocessor")) {
        return Promise.resolve({ text: "{}" });
      }
      if (prompt.startsWith("你是 ReAct decision agent") || prompt.startsWith("You are a ReAct decision agent")) {
        return Promise.resolve({
          text: JSON.stringify({
            status: "completed",
            reason: "No more action needed.",
            output: "Done.",
          }),
        });
      }
      if (prompt.includes("Write a concise natural-language answer")) {
        return Promise.resolve({ text: "Done." });
      }
      return Promise.resolve({
        text: JSON.stringify({
          title: "Use ReAct",
          reasoning: "Exercise ReAct decision.",
          steps: [{
            id: "react-step",
            title: "Run ReAct step",
            assignedAgentKind: "commander",
            toolName: "memory.search",
            requiredCapabilities: ["memory_search"],
            capability: "memory_search",
            executionMode: "react",
            dependsOn: [],
            successCriteria: "ReAct completes.",
          }],
        }),
      });
    });
    modelMocks.provider = {
      id: "test-provider",
      settings: {
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyReference: "default",
        baseUrl: "",
      },
      complete,
      stream: vi.fn(async function* () {
        throw new Error("stream unavailable in test");
      }),
      defaultSettingsForLocale: vi.fn(),
    } as unknown as ModelProvider;
    const getEnabledSkillContext = vi.fn(async () => "Skill: Demo\nUse the demo ReAct guidance.");
    const runtime = createJavisRuntime({
      getWorkspacePath: () => "E:/Javis",
      modelSettings: DEFAULT_MODEL_SETTINGS,
      getEnabledSkillContext,
    });
    const snapshots = subscribeToRuntime(runtime);

    runtime.start("Exercise ReAct", { mode: "project", taskId: "task-react-skill-context" });

    await vi.waitFor(() => expect(snapshots[snapshots.length - 1]?.status).toBe("completed"));
    const reactCall = completeCalls.find((call) => call.prompt.includes("ReAct decision agent"));
    expect(getEnabledSkillContext).toHaveBeenCalledWith(expect.objectContaining({
      agentKind: "commander",
      userGoal: "Exercise ReAct",
      maxSkills: 2,
      maxContextChars: 6000,
    }));
    expect(reactCall?.options).toEqual(expect.objectContaining({
      skillContext: "Skill: Demo\nUse the demo ReAct guidance.",
      skillContextMaxSkills: 2,
      skillContextMaxChars: 6000,
    }));

    runtime.dispose();
  });

  it("fails ReAct decisions that return plain text instead of JSON", async () => {
    const completeCalls: Array<{ prompt: string; options?: unknown }> = [];
    const complete = vi.fn((prompt: string, options?: unknown) => {
      completeCalls.push({ prompt, options });
      if (prompt.includes("Chinese input preprocessor")) {
        return Promise.resolve({ text: "{}" });
      }
      if (prompt.includes("ReAct decision agent")) {
        return Promise.resolve({ text: "Done without JSON." });
      }
      return Promise.resolve({
        text: JSON.stringify({
          title: "Use ReAct",
          reasoning: "Exercise ReAct decision.",
          steps: [{
            id: "react-step",
            title: "Run ReAct step",
            assignedAgentKind: "commander",
            toolName: "memory.search",
            requiredCapabilities: ["memory_search"],
            capability: "memory_search",
            executionMode: "react",
            dependsOn: [],
            successCriteria: "ReAct completes.",
          }],
        }),
      });
    });
    modelMocks.provider = {
      id: "test-provider",
      settings: {
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyReference: "default",
        baseUrl: "",
      },
      complete,
      stream: vi.fn(async function* () {
        throw new Error("stream unavailable in test");
      }),
      defaultSettingsForLocale: vi.fn(),
    } as unknown as ModelProvider;
    const runtime = createJavisRuntime({
      getWorkspacePath: () => "E:/Javis",
      modelSettings: DEFAULT_MODEL_SETTINGS,
      getRuntimePreferences: () => ({ failureRecoveryPolicy: "stop" }),
    });
    const snapshots = subscribeToRuntime(runtime);

    runtime.start("Exercise ReAct plain text", { mode: "project", taskId: "task-react-plain-text" });

    await vi.waitFor(() => expect(snapshots[snapshots.length - 1]?.status).toBe("failed"));
    const reactCall = completeCalls.find((call) => call.prompt.includes("ReAct decision agent"));
    expect(reactCall).toBeDefined();
    const latest = snapshots[snapshots.length - 1];
    const logsText = JSON.stringify(latest?.logs ?? []);
    expect(logsText).toContain("ReAct decision LLM returned plain text instead of JSON.");
    expect(logsText).not.toContain("ReAct completed after");

    runtime.dispose();
  });

  it("returns no memory results when Agent memory is disabled", async () => {
    const complete = vi.fn((prompt: string) => {
      if (prompt.includes("Chinese input preprocessor")) {
        return Promise.resolve({ text: "{}" });
      }
      return Promise.resolve({
        text: JSON.stringify({
          title: "Recall memory",
          reasoning: "The user referenced prior work.",
          steps: [{
            id: "recall-memory",
            title: "Search memory",
            assignedAgentKind: "commander",
            toolName: "memory.search",
            requiredCapabilities: ["memory_search"],
            dependsOn: [],
            executionMode: "direct_tool_call",
            inputContextKeys: ["userGoal"],
            outputContextKey: "memoryResults",
            successCriteria: "Memory search was attempted.",
          }],
        }),
      });
    });
    modelMocks.provider = {
      id: "test-provider",
      settings: {
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyReference: "default",
        baseUrl: "",
      },
      complete,
      stream: vi.fn(async function* () {}),
      defaultSettingsForLocale: vi.fn(),
    } as unknown as ModelProvider;
    const searchAgentMemory = vi.fn(async () => [{
      id: "mem-1",
      fact: "Memory remains local.",
      kind: "design_principle",
      tags: ["memory"],
      confidence: 0.9,
      importance: 5,
      updatedAt: 1_700_000_000_000,
    }]);
    const runtime = createJavisRuntime({
      getWorkspacePath: () => "E:/Javis",
      modelSettings: DEFAULT_MODEL_SETTINGS,
      isAgentMemoryEnabled: () => false,
      searchAgentMemory,
    });
    const snapshots = subscribeToRuntime(runtime);

    runtime.start("What did we decide before?", { mode: "project", taskId: "task-memory-disabled" });

    await vi.waitFor(() => expect(snapshots[snapshots.length - 1]?.status).toBe("completed"));
    expect(searchAgentMemory).not.toHaveBeenCalled();

    runtime.dispose();
  });
});

describe("computer use local vision config", () => {
  const localVisionDegradationDefaults = {
    disableAfterConsecutiveTimeouts: 2,
    disableAfterConsecutiveErrors: 2,
    disableAfterConsecutiveActionFailures: 2,
  };
  const localVisionDegradationDisabled = {
    disableAfterConsecutiveTimeouts: 0,
    disableAfterConsecutiveErrors: 0,
    disableAfterConsecutiveActionFailures: 0,
  };

  it("loads and saves Computer Use base settings without dropping local vision config", () => {
    const storage = createMemoryStorage();
    storage.setItem(COMPUTER_USE_LOCAL_VISION_STORAGE_KEY, JSON.stringify({
      localVision: {
        enabled: true,
        mode: "prompt_hint",
        modelPath: "models/local-vision/yolo26n-ui.onnx",
        runtime: "onnxruntime",
      },
    }));

    expect(loadComputerUseSettingsFromStorage(storage)).toEqual({
      enabled: false,
      maxStepsPerTask: 20,
      mouseSpeed: "instant",
      mouseDurationMs: 200,
      typeDelayMs: 50,
      deniedWindowPatterns: [],
    });
    expect(saveComputerUseSettingsToStorage(storage, {
      enabled: true,
      maxStepsPerTask: 45,
      mouseSpeed: "linear",
      mouseDurationMs: 250,
      typeDelayMs: 25,
      deniedWindowPatterns: ["Task Manager", "  Admin  Console  "],
    })).toEqual({
      enabled: true,
      maxStepsPerTask: 45,
      mouseSpeed: "linear",
      mouseDurationMs: 250,
      typeDelayMs: 25,
      deniedWindowPatterns: ["Task Manager", "Admin Console"],
    });
    expect(loadComputerUseConfigFromStorage(storage)).toEqual({
      enabled: true,
      maxSteps: 45,
      mouseSpeed: "linear",
      mouseDurationMs: 250,
      typeDelayMs: 25,
      deniedWindowPatterns: ["Task Manager", "Admin Console"],
      localVision: expect.objectContaining({
        enabled: true,
        mode: "prompt_hint",
        modelPath: "models/local-vision/yolo26n-ui.onnx",
        runtime: "onnxruntime",
      }),
    });
    expect(loadComputerUseLocalVisionSettingsFromStorage(storage)).toEqual(expect.objectContaining({
      mode: "prompt_hint",
      modelPath: "models/local-vision/yolo26n-ui.onnx",
      runtime: "onnxruntime",
    }));
  });

  it("clamps Computer Use max steps and preserves explicit disabled runtime config", () => {
    const storage = createMemoryStorage();

    expect(saveComputerUseSettingsToStorage(storage, {
      enabled: false,
      maxStepsPerTask: 999,
      mouseSpeed: "slow" as never,
      mouseDurationMs: 9999,
      typeDelayMs: 9999,
      deniedWindowPatterns: ["", " Task Manager ", "task manager", "A".repeat(200)],
    })).toEqual({
      enabled: false,
      maxStepsPerTask: 60,
      mouseSpeed: "instant",
      mouseDurationMs: 1000,
      typeDelayMs: 500,
      deniedWindowPatterns: ["Task Manager", "A".repeat(120)],
    });
    expect(loadComputerUseSettingsFromStorage(storage)).toEqual({
      enabled: false,
      maxStepsPerTask: 60,
      mouseSpeed: "instant",
      mouseDurationMs: 1000,
      typeDelayMs: 500,
      deniedWindowPatterns: ["Task Manager", "A".repeat(120)],
    });
    expect(loadComputerUseConfigFromStorage(storage)).toEqual({
      enabled: false,
      maxSteps: 60,
      mouseSpeed: "instant",
      mouseDurationMs: 1000,
      typeDelayMs: 500,
      deniedWindowPatterns: ["Task Manager", "A".repeat(120)],
    });
  });

  it("loads an explicit local vision config from storage and clamps unsafe values", () => {
    const storage = createMemoryStorage();
    storage.setItem(COMPUTER_USE_LOCAL_VISION_STORAGE_KEY, JSON.stringify({
      localVision: {
        enabled: true,
        mode: "prompt_hint",
        modelPath: " models/yolo26n-ui.onnx ",
        runtime: "openvino",
        runtimeAdapterPath: " adapters/yolo26-ui.mjs ",
        reuseWorker: true,
        imgsz: 9999,
        timeoutMs: 5,
        maxDetections: 999,
        promptTopK: 0,
        minConfidence: 2,
        iouThreshold: -1,
        labelMap: {
          " 0 ": " button ",
          "1": "input",
          "data:image\\/png;base64,KEY==": "icon data:image\\/png;base64,VALUE==",
          ignored: 42,
        },
        disableAfterConsecutiveTimeouts: 0,
        disableAfterConsecutiveErrors: 99,
        disableAfterConsecutiveActionFailures: 99,
      },
    }));

    expect(loadComputerUseConfigFromStorage(storage)).toEqual({
      localVision: {
        enabled: true,
        mode: "prompt_hint",
        modelPath: "models/yolo26n-ui.onnx",
        runtime: "openvino",
        runtimeAdapterPath: "adapters/yolo26-ui.mjs",
        reuseWorker: true,
        imgsz: 1280,
        timeoutMs: 20,
        maxDetections: 100,
        promptTopK: 0,
        minConfidence: 1,
        iouThreshold: 0.45,
        labelMap: {
          "0": "button",
          "1": "input",
          "[redacted:image data URL]": "icon [redacted:image data URL]",
        },
        disableAfterConsecutiveTimeouts: 0,
        disableAfterConsecutiveErrors: 10,
        disableAfterConsecutiveActionFailures: 10,
      },
    });
  });

  it("keeps local vision disabled unless storage explicitly enables a supported mode", () => {
    const storage = createMemoryStorage();
    storage.setItem(COMPUTER_USE_LOCAL_VISION_STORAGE_KEY, JSON.stringify({
      localVision: {
        enabled: true,
        mode: "click_assist",
        runtime: "python",
      },
    }));

    expect(loadComputerUseConfigFromStorage(storage)).toEqual({
      localVision: {
        enabled: false,
        mode: "off",
      },
    });
  });

  it("defaults legacy enabled local vision settings to worker reuse", () => {
    const storage = createMemoryStorage();
    storage.setItem(COMPUTER_USE_LOCAL_VISION_STORAGE_KEY, JSON.stringify({
      localVision: {
        enabled: true,
        mode: "prompt_hint",
        modelPath: "models/local-vision/yolo26n-ui.onnx",
      },
    }));

    expect(loadComputerUseConfigFromStorage(storage)).toEqual({
      localVision: expect.objectContaining({
        enabled: true,
        mode: "prompt_hint",
        modelPath: "models/local-vision/yolo26n-ui.onnx",
        reuseWorker: true,
      }),
    });
    expect(loadComputerUseLocalVisionSettingsFromStorage(storage)).toEqual(expect.objectContaining({
      mode: "prompt_hint",
      modelPath: "models/local-vision/yolo26n-ui.onnx",
      reuseWorker: true,
    }));
  });

  it("treats enabled local vision with no model path as disabled", () => {
    const storage = createMemoryStorage();
    storage.setItem(COMPUTER_USE_LOCAL_VISION_STORAGE_KEY, JSON.stringify({
      localVision: {
        enabled: true,
        mode: "prompt_hint",
        modelPath: "   ",
        runtime: "onnxruntime",
        reuseWorker: true,
      },
    }));

    expect(loadComputerUseConfigFromStorage(storage)).toEqual({
      localVision: {
        enabled: false,
        mode: "off",
        runtime: "onnxruntime",
        reuseWorker: true,
      },
    });
    expect(loadComputerUseLocalVisionSettingsFromStorage(storage)).toEqual({
      mode: "prompt_hint",
      modelPath: "",
      runtime: "onnxruntime",
      runtimeAdapterPath: "",
      imgsz: 640,
      timeoutMs: 120,
      maxDetections: 20,
      minConfidence: 0.75,
      iouThreshold: 0.45,
      promptTopK: 8,
      ...localVisionDegradationDefaults,
      reuseWorker: true,
    });
  });

  it("rejects image data URLs and oversized strings in local vision paths", () => {
    const storage = createMemoryStorage();
    const oversizedPath = `E:/models/${"x".repeat(2_000)}.onnx`;
    storage.setItem(COMPUTER_USE_LOCAL_VISION_STORAGE_KEY, JSON.stringify({
      localVision: {
        enabled: true,
        mode: "prompt_hint",
        modelPath: "data:image/png;base64,MODEL_SHOULD_NOT_SURVIVE==",
        runtimeAdapterPath: "data:image\\/png;base64,ADAPTER_SHOULD_NOT_SURVIVE==",
        runtime: "onnxruntime",
        reuseWorker: true,
      },
    }));

    expect(loadComputerUseConfigFromStorage(storage)).toEqual({
      localVision: {
        enabled: false,
        mode: "off",
        runtime: "onnxruntime",
        reuseWorker: true,
      },
    });
    expect(loadComputerUseLocalVisionSettingsFromStorage(storage)).toEqual({
      mode: "prompt_hint",
      modelPath: "",
      runtime: "onnxruntime",
      runtimeAdapterPath: "",
      imgsz: 640,
      timeoutMs: 120,
      maxDetections: 20,
      minConfidence: 0.75,
      iouThreshold: 0.45,
      promptTopK: 8,
      ...localVisionDegradationDefaults,
      reuseWorker: true,
    });

    expect(saveComputerUseLocalVisionSettingsToStorage(storage, {
      mode: "prompt_hint",
      modelPath: oversizedPath,
      runtime: "auto",
      runtimeAdapterPath: oversizedPath,
      imgsz: 9999,
      timeoutMs: 9999,
      maxDetections: 999,
      minConfidence: 2,
      iouThreshold: 2,
      promptTopK: 8,
      disableAfterConsecutiveTimeouts: 99,
      disableAfterConsecutiveErrors: 99,
      disableAfterConsecutiveActionFailures: -1,
      reuseWorker: false,
    })).toEqual({
      mode: "prompt_hint",
      modelPath: oversizedPath.slice(0, 1_024),
      runtime: "auto",
      runtimeAdapterPath: oversizedPath.slice(0, 1_024),
      imgsz: 1280,
      timeoutMs: 2_000,
      maxDetections: 100,
      minConfidence: 1,
      iouThreshold: 1,
      promptTopK: 8,
      disableAfterConsecutiveTimeouts: 10,
      disableAfterConsecutiveErrors: 10,
      disableAfterConsecutiveActionFailures: 0,
      reuseWorker: false,
    });
  });

  it("loads and saves simplified local vision settings for the desktop UI", () => {
    const storage = createMemoryStorage();

    expect(loadComputerUseLocalVisionSettingsFromStorage(storage)).toEqual({
      mode: "off",
      modelPath: COMPUTER_USE_BUNDLED_LOCAL_VISION_MODEL_PATH,
      runtime: "auto",
      runtimeAdapterPath: "",
      imgsz: 640,
      timeoutMs: 120,
      maxDetections: 20,
      minConfidence: 0.75,
      iouThreshold: 0.45,
      promptTopK: 8,
      ...localVisionDegradationDefaults,
      reuseWorker: true,
    });

    expect(saveComputerUseLocalVisionSettingsToStorage(storage, {
      mode: "prompt_hint",
      modelPath: " E:/models/yolo26n-ui.onnx ",
      runtime: "onnxruntime",
      runtimeAdapterPath: " E:/models/yolo26-ui-adapter.mjs ",
      imgsz: 960,
      timeoutMs: 5,
      maxDetections: 12,
      minConfidence: 0.6,
      iouThreshold: 0.3,
      promptTopK: 0,
      disableAfterConsecutiveTimeouts: 1,
      disableAfterConsecutiveErrors: 0,
      disableAfterConsecutiveActionFailures: 3,
      reuseWorker: true,
    })).toEqual({
      mode: "prompt_hint",
      modelPath: "E:/models/yolo26n-ui.onnx",
      runtime: "onnxruntime",
      runtimeAdapterPath: "E:/models/yolo26-ui-adapter.mjs",
      imgsz: 960,
      timeoutMs: 20,
      maxDetections: 12,
      minConfidence: 0.6,
      iouThreshold: 0.3,
      promptTopK: 0,
      disableAfterConsecutiveTimeouts: 1,
      disableAfterConsecutiveErrors: 0,
      disableAfterConsecutiveActionFailures: 3,
      reuseWorker: true,
    });

    expect(loadComputerUseConfigFromStorage(storage)).toEqual({
      localVision: expect.objectContaining({
        enabled: true,
        mode: "prompt_hint",
        modelPath: "E:/models/yolo26n-ui.onnx",
        runtime: "onnxruntime",
        runtimeAdapterPath: "E:/models/yolo26-ui-adapter.mjs",
        imgsz: 960,
        timeoutMs: 20,
        maxDetections: 12,
        minConfidence: 0.6,
        iouThreshold: 0.3,
        promptTopK: 0,
        disableAfterConsecutiveTimeouts: 1,
        disableAfterConsecutiveErrors: 0,
        disableAfterConsecutiveActionFailures: 3,
        reuseWorker: true,
      }),
    });
    expect(loadComputerUseLocalVisionSettingsFromStorage(storage)).toEqual({
      mode: "prompt_hint",
      modelPath: "E:/models/yolo26n-ui.onnx",
      runtime: "onnxruntime",
      runtimeAdapterPath: "E:/models/yolo26-ui-adapter.mjs",
      imgsz: 960,
      timeoutMs: 20,
      maxDetections: 12,
      minConfidence: 0.6,
      iouThreshold: 0.3,
      promptTopK: 0,
      disableAfterConsecutiveTimeouts: 1,
      disableAfterConsecutiveErrors: 0,
      disableAfterConsecutiveActionFailures: 3,
      reuseWorker: true,
    });
  });

  it("keeps the selected local vision mode in settings while runtime is disabled without a model path", () => {
    const storage = createMemoryStorage();

    expect(saveComputerUseLocalVisionSettingsToStorage(storage, {
      mode: "prompt_hint",
      modelPath: "   ",
      runtime: "onnxruntime",
      runtimeAdapterPath: "",
      imgsz: 960,
      timeoutMs: 5,
      maxDetections: 12,
      minConfidence: 0.6,
      iouThreshold: 0.3,
      promptTopK: 0,
      ...localVisionDegradationDefaults,
      reuseWorker: true,
    })).toEqual({
      mode: "prompt_hint",
      modelPath: "",
      runtime: "onnxruntime",
      runtimeAdapterPath: "",
      imgsz: 960,
      timeoutMs: 20,
      maxDetections: 12,
      minConfidence: 0.6,
      iouThreshold: 0.3,
      promptTopK: 0,
      ...localVisionDegradationDefaults,
      reuseWorker: true,
    });

    expect(loadComputerUseConfigFromStorage(storage)).toEqual({
      localVision: {
        enabled: false,
        mode: "off",
        runtime: "onnxruntime",
        imgsz: 960,
        timeoutMs: 20,
        maxDetections: 12,
        minConfidence: 0.6,
        iouThreshold: 0.3,
        promptTopK: 0,
        ...localVisionDegradationDefaults,
        reuseWorker: true,
      },
    });
    expect(loadComputerUseLocalVisionSettingsFromStorage(storage)).toEqual({
      mode: "prompt_hint",
      modelPath: "",
      runtime: "onnxruntime",
      runtimeAdapterPath: "",
      imgsz: 960,
      timeoutMs: 20,
      maxDetections: 12,
      minConfidence: 0.6,
      iouThreshold: 0.3,
      promptTopK: 0,
      ...localVisionDegradationDefaults,
      reuseWorker: true,
    });
  });

  it("preserves the model path while local vision is off", () => {
    const storage = createMemoryStorage();

    expect(saveComputerUseLocalVisionSettingsToStorage(storage, {
      mode: "off",
      modelPath: " E:/models/yolo26n-ui.onnx ",
      runtime: "auto",
      runtimeAdapterPath: "",
      imgsz: 320,
      timeoutMs: 80,
      maxDetections: 20,
      minConfidence: 0.75,
      iouThreshold: 0.45,
      promptTopK: 0,
      ...localVisionDegradationDefaults,
      reuseWorker: false,
    })).toEqual({
      mode: "off",
      modelPath: "E:/models/yolo26n-ui.onnx",
      runtime: "auto",
      runtimeAdapterPath: "",
      imgsz: 320,
      timeoutMs: 80,
      maxDetections: 20,
      minConfidence: 0.75,
      iouThreshold: 0.45,
      promptTopK: 0,
      ...localVisionDegradationDefaults,
      reuseWorker: false,
    });

    expect(loadComputerUseConfigFromStorage(storage)).toEqual({
      localVision: {
        enabled: false,
        mode: "off",
        modelPath: "E:/models/yolo26n-ui.onnx",
        runtime: "auto",
        imgsz: 320,
        timeoutMs: 80,
        maxDetections: 20,
        minConfidence: 0.75,
        iouThreshold: 0.45,
        promptTopK: 0,
        ...localVisionDegradationDefaults,
        reuseWorker: false,
      },
    });
  });

  it("preserves hidden local vision label maps while saving desktop UI degradation thresholds", () => {
    const storage = createMemoryStorage();
    storage.setItem(COMPUTER_USE_LOCAL_VISION_STORAGE_KEY, JSON.stringify({
      localVision: {
        enabled: true,
        mode: "passive",
        modelPath: "old.onnx",
        runtime: "openvino",
        runtimeAdapterPath: "adapters/yolo26-ui.mjs",
        reuseWorker: false,
        imgsz: 960,
        timeoutMs: 80,
        maxDetections: 12,
        promptTopK: 5,
        minConfidence: 0.82,
        iouThreshold: 0.35,
        labelMap: {
          "0": "button",
        },
        disableAfterConsecutiveTimeouts: 0,
        disableAfterConsecutiveErrors: 0,
        disableAfterConsecutiveActionFailures: 0,
      },
    }));

    expect(saveComputerUseLocalVisionSettingsToStorage(storage, {
      mode: "prompt_hint",
      modelPath: " new.onnx ",
      runtime: "tensorrt",
      runtimeAdapterPath: " adapters/new-adapter.mjs ",
      imgsz: 640,
      timeoutMs: 40,
      maxDetections: 12,
      minConfidence: 0.6,
      iouThreshold: 0.3,
      promptTopK: 0,
      disableAfterConsecutiveTimeouts: 1,
      disableAfterConsecutiveErrors: 0,
      disableAfterConsecutiveActionFailures: 3,
      reuseWorker: true,
    })).toEqual({
      mode: "prompt_hint",
      modelPath: "new.onnx",
      runtime: "tensorrt",
      runtimeAdapterPath: "adapters/new-adapter.mjs",
      imgsz: 640,
      timeoutMs: 40,
      maxDetections: 12,
      minConfidence: 0.6,
      iouThreshold: 0.3,
      promptTopK: 0,
      disableAfterConsecutiveTimeouts: 1,
      disableAfterConsecutiveErrors: 0,
      disableAfterConsecutiveActionFailures: 3,
      reuseWorker: true,
    });

    expect(loadComputerUseConfigFromStorage(storage)).toEqual({
      localVision: {
        enabled: true,
        mode: "prompt_hint",
        modelPath: "new.onnx",
        runtime: "tensorrt",
        runtimeAdapterPath: "adapters/new-adapter.mjs",
        reuseWorker: true,
        imgsz: 640,
        timeoutMs: 40,
        maxDetections: 12,
        promptTopK: 0,
        minConfidence: 0.6,
        iouThreshold: 0.3,
        labelMap: {
          "0": "button",
        },
        disableAfterConsecutiveTimeouts: 1,
        disableAfterConsecutiveErrors: 0,
        disableAfterConsecutiveActionFailures: 3,
      },
    });
  });

  it("preserves hidden local vision label maps while toggling local vision off", () => {
    const storage = createMemoryStorage();
    storage.setItem(COMPUTER_USE_LOCAL_VISION_STORAGE_KEY, JSON.stringify({
      localVision: {
        enabled: true,
        mode: "prompt_hint",
        modelPath: "model.onnx",
        runtime: "tensorrt",
        runtimeAdapterPath: "adapters/yolo26-ui.mjs",
        reuseWorker: true,
        imgsz: 960,
        timeoutMs: 80,
        maxDetections: 12,
        promptTopK: 5,
        minConfidence: 0.82,
        iouThreshold: 0.35,
        labelMap: {
          "0": "button",
        },
        disableAfterConsecutiveTimeouts: 0,
        disableAfterConsecutiveErrors: 0,
        disableAfterConsecutiveActionFailures: 0,
      },
    }));

    expect(saveComputerUseLocalVisionSettingsToStorage(storage, {
      mode: "off",
      modelPath: "model.onnx",
      runtime: "tensorrt",
      runtimeAdapterPath: "adapters/yolo26-ui.mjs",
      imgsz: 960,
      timeoutMs: 80,
      maxDetections: 12,
      minConfidence: 0.82,
      iouThreshold: 0.35,
      promptTopK: 5,
      ...localVisionDegradationDisabled,
      reuseWorker: true,
    })).toEqual({
      mode: "off",
      modelPath: "model.onnx",
      runtime: "tensorrt",
      runtimeAdapterPath: "adapters/yolo26-ui.mjs",
      imgsz: 960,
      timeoutMs: 80,
      maxDetections: 12,
      minConfidence: 0.82,
      iouThreshold: 0.35,
      promptTopK: 5,
      ...localVisionDegradationDisabled,
      reuseWorker: true,
    });

    expect(loadComputerUseConfigFromStorage(storage)).toEqual({
      localVision: {
        enabled: false,
        mode: "off",
        modelPath: "model.onnx",
        runtime: "tensorrt",
        runtimeAdapterPath: "adapters/yolo26-ui.mjs",
        reuseWorker: true,
        imgsz: 960,
        timeoutMs: 80,
        maxDetections: 12,
        promptTopK: 5,
        minConfidence: 0.82,
        iouThreshold: 0.35,
        labelMap: {
          "0": "button",
        },
        disableAfterConsecutiveTimeouts: 0,
        disableAfterConsecutiveErrors: 0,
        disableAfterConsecutiveActionFailures: 0,
      },
    });
  });
});

function subscribeToRuntime(runtime: ReturnType<typeof createJavisRuntime>) {
  const snapshots: ReturnType<typeof runtime.getSnapshot>[] = [];
  runtime.subscribe((snapshot) => {
    snapshots.push(snapshot);
  });
  return snapshots;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}
