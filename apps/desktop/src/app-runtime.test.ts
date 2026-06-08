import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletionResult, ModelProvider } from "./model-provider";

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

import { createJavisRuntime } from "./app-runtime";
import { DEFAULT_MODEL_SETTINGS } from "./model-settings";

describe("createJavisRuntime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    modelMocks.provider = undefined;
  });

  it("keeps startup immediate while waiting for Chinese preprocessing before Commander planning", async () => {
    const preprocessorResponse = deferred<CompletionResult>();
    const commanderPlanPrompts: string[] = [];
    const complete = vi.fn((prompt: string) => {
      if (prompt.includes("Chinese input preprocessor")) {
        return preprocessorResponse.promise;
      }
      if (prompt.includes("Output must match this JSON Schema")) {
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
    expect(complete).toHaveBeenCalledWith(expect.stringContaining("Chinese input preprocessor"), expect.objectContaining({
      maxTokens: 700,
      temperature: 0,
      locale: "zh-CN",
    }));

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
    expect(commanderPlanPrompts[0]).toContain("Available agents:");
    expect(commanderPlanPrompts[0]).toContain("Available tools: [{");
    expect(commanderPlanPrompts[0]).toContain("\"file.writeText\"");
    expect(commanderPlanPrompts[0]).toContain("\"permissionLevel\":\"confirmed_write\"");
    expect(commanderPlanPrompts[0]).toContain("\"ownerAgentKinds\"");
    expect(commanderPlanPrompts[0]).toContain("\"intent\":\"检查当前项目\"");

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

  it("repairs non-JSON Commander plan output before failing plan mode", async () => {
    const complete = vi.fn((prompt: string) => {
      if (prompt.includes("Chinese input preprocessor")) {
        return Promise.resolve({ text: "{}" });
      }
      if (
        prompt.startsWith("Your previous output was not valid JSON") ||
        prompt.includes("Previous invalid output:")
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
      if (prompt.includes("Output must match this JSON Schema")) {
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
      expect.stringContaining("Your previous output was not valid JSON"),
      expect.objectContaining({ maxTokens: 1600, temperature: 0, locale: "zh-CN" }),
    );

    runtime.dispose();
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
