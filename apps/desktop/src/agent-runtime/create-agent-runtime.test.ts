import { describe, expect, it } from "vitest";
import { OpenAICompatibleAdapter, registerAdapter } from "@javis/core";
import {
  AGENT_RUNTIME_BACKEND_STORAGE_KEY,
  AGENT_RUNTIME_ROLLOUT_STORAGE_KEY,
  resolveCommanderStepAgentRuntimeBackend,
  resolveCommanderStepAgentRuntimeRoutingDecision,
  resolveAgentRuntimeBackend,
  resolveReadOnlyPocAgentRuntimeBackend,
} from "./create-agent-runtime";

describe("Agent runtime backend selection", () => {
  it("keeps legacy as the rollout default", () => {
    expect(resolveAgentRuntimeBackend({ getItem: () => null })).toBe("legacy");
  });

  it("enables LangChain through the explicit rollout switch", () => {
    expect(resolveAgentRuntimeBackend({
      getItem: (key) => key === AGENT_RUNTIME_BACKEND_STORAGE_KEY ? "langchain" : null,
    })).toBe("langchain");
  });

  it("fails closed to legacy for unknown stored values", () => {
    expect(resolveAgentRuntimeBackend({ getItem: () => "other" })).toBe("legacy");
  });

  it("fails closed to legacy when the selected provider disables native Tool Call", () => {
    registerAdapter(new OpenAICompatibleAdapter(
      "legacy-agent-runtime-test",
      "https://example.test/v1",
      {
        vision: false,
        code: true,
        longContext: false,
        nativeToolCalling: false,
        streamingToolCalls: false,
      },
    ));

    expect(resolveAgentRuntimeBackend(
      { getItem: () => "langchain" },
      { provider: "legacy-agent-runtime-test" },
    )).toBe("legacy");
  });

  it("limits the Phase 2 rollout to the research Agent", () => {
    const storage = { getItem: () => "langchain" };
    expect(resolveReadOnlyPocAgentRuntimeBackend(
      "research",
      { provider: "openai" },
      storage,
    )).toBe("langchain");
    expect(resolveReadOnlyPocAgentRuntimeBackend(
      "code",
      { provider: "openai" },
      storage,
    )).toBe("legacy");
  });

  it("enables Phase 3 rollout by Agent kind while keeping unmatched Agents legacy", () => {
    const storage = storageWithRollout({ agentKinds: ["code"] });
    expect(resolveCommanderStepAgentRuntimeBackend(
      "code",
      "task-agent-rollout",
      { provider: "openai", model: "gpt-test" },
      storage,
    )).toBe("langchain");
    expect(resolveCommanderStepAgentRuntimeBackend(
      "research",
      "task-agent-rollout",
      { provider: "openai", model: "gpt-test" },
      storage,
    )).toBe("legacy");
  });

  it("expands the explicit global Phase 5 switch to every read Agent", () => {
    const storage = {
      getItem: (key: string) => key === AGENT_RUNTIME_BACKEND_STORAGE_KEY
        ? "langchain"
        : key === AGENT_RUNTIME_ROLLOUT_STORAGE_KEY
          ? JSON.stringify({
              verifiedModelProfiles: [
                { provider: "openai", model: "gpt-test" },
                { provider: "anthropic", model: "claude-test" },
              ],
            })
          : null,
    };
    expect(resolveCommanderStepAgentRuntimeBackend(
      "code",
      "task-global-read",
      { provider: "openai", model: "gpt-test" },
      storage,
      "read",
    )).toBe("langchain");
    expect(resolveCommanderStepAgentRuntimeBackend(
      "verifier",
      "task-global-read",
      { provider: "anthropic", model: "claude-test" },
      storage,
      "read",
    )).toBe("langchain");
  });

  it("requires a separate Phase 5 opt-in for preview and refuses write permissions", () => {
    const previewStorage = storageWithRollout({
      agentKinds: ["file"],
      permissionLevels: ["read", "preview"],
      previewToolNames: ["file.planPdfOrganization"],
    });
    expect(resolveCommanderStepAgentRuntimeBackend(
      "file",
      "task-preview",
      { provider: "openai", model: "gpt-test" },
      previewStorage,
      "preview",
      "file.planPdfOrganization",
    )).toBe("langchain");
    expect(resolveCommanderStepAgentRuntimeBackend(
      "file",
      "task-write",
      { provider: "openai", model: "gpt-test" },
      previewStorage,
      "confirmed_write",
    )).toBe("legacy");

    const readOnlyStorage = storageWithRollout({ agentKinds: ["file"] });
    expect(resolveCommanderStepAgentRuntimeBackend(
      "file",
      "task-preview-disabled",
      { provider: "openai", model: "gpt-test" },
      readOnlyStorage,
      "preview",
    )).toBe("legacy");
  });

  it("rejects rollout configuration that attempts to enable write permissions", () => {
    const storage = storageWithRollout({
      agentKinds: ["file"],
      permissionLevels: ["confirmed_write"],
    });
    expect(resolveCommanderStepAgentRuntimeBackend(
      "file",
      "task-invalid-write-rollout",
      { provider: "openai", model: "gpt-test" },
      storage,
      "read",
    )).toBe("legacy");
  });

  it("enables Phase 3 rollout by exact task id", () => {
    const storage = storageWithRollout({ taskIds: ["task-enabled"] });
    expect(resolveCommanderStepAgentRuntimeBackend(
      "code",
      "task-enabled",
      { provider: "openai", model: "gpt-test" },
      storage,
    )).toBe("langchain");
    expect(resolveCommanderStepAgentRuntimeBackend(
      "code",
      "task-other",
      { provider: "openai", model: "gpt-test" },
      storage,
    )).toBe("legacy");
  });

  it("fails closed for malformed Phase 3 rollout configuration", () => {
    const storage = {
      getItem: (key: string) => key === AGENT_RUNTIME_ROLLOUT_STORAGE_KEY
        ? '{"agentKinds":"code"}'
        : null,
    };
    expect(resolveCommanderStepAgentRuntimeBackend(
      "code",
      "task-invalid-rollout",
      { provider: "openai", model: "gpt-test" },
      storage,
    )).toBe("legacy");
  });

  it("keeps provider capability fail-closed above Phase 3 rollout flags", () => {
    const storage = storageWithRollout({ agentKinds: ["code"], taskIds: ["task-enabled"] });
    expect(resolveCommanderStepAgentRuntimeBackend(
      "code",
      "task-enabled",
      { provider: "legacy-agent-runtime-test", model: "legacy-test" },
      storage,
    )).toBe("legacy");
    expect(resolveCommanderStepAgentRuntimeRoutingDecision(
      "code",
      "task-enabled",
      { provider: "legacy-agent-runtime-test", model: "legacy-test" },
      storage,
      "read",
    )).toEqual({
      backend: "legacy",
      rolloutTargeted: true,
      fallbackReason: "native_tool_call_unavailable",
    });
  });

  it("requires an exact verified provider/model profile and rejects unknown providers", () => {
    const storage = storageWithRollout({ agentKinds: ["code"] });
    expect(resolveCommanderStepAgentRuntimeBackend(
      "code",
      "task-unverified-model",
      { provider: "openai", model: "gpt-unverified" },
      storage,
    )).toBe("legacy");
    expect(resolveCommanderStepAgentRuntimeBackend(
      "code",
      "task-unknown-provider",
      { provider: "unknown-provider", model: "unknown-model" },
      storageWithRollout({
        agentKinds: ["code"],
        verifiedModelProfiles: [{ provider: "unknown-provider", model: "unknown-model" }],
      }),
    )).toBe("legacy");
  });

  it("requires an explicit preview tool allowlist match", () => {
    const storage = storageWithRollout({
      agentKinds: ["file"],
      permissionLevels: ["read", "preview"],
      previewToolNames: ["file.planPdfOrganization"],
    });
    expect(resolveCommanderStepAgentRuntimeBackend(
      "file",
      "task-preview-without-tool",
      { provider: "openai", model: "gpt-test" },
      storage,
      "preview",
    )).toBe("legacy");
    expect(resolveCommanderStepAgentRuntimeBackend(
      "file",
      "task-preview-other-tool",
      { provider: "openai", model: "gpt-test" },
      storage,
      "preview",
      "file.planWriteText",
    )).toBe("legacy");
  });

  it("routes the Phase 2 code_propose contract to OpenCode without LangChain rollout", () => {
    expect(resolveCommanderStepAgentRuntimeBackend(
      "code",
      "task-code-propose",
      { provider: "openai", model: "gpt-test" },
      undefined,
      "preview",
      "code.proposeEdit",
      "code_propose",
    )).toBe("opencode");
    expect(resolveCommanderStepAgentRuntimeRoutingDecision(
      "code",
      "task-code-propose",
      { provider: "openai", model: "gpt-test" },
      undefined,
      "preview",
      "code.proposeEdit",
      "code_propose",
    )).toMatchObject({
      backend: "opencode",
      selectionReason: "phase2_code_propose",
    });
    expect(resolveCommanderStepAgentRuntimeRoutingDecision(
      "code",
      "task-code-propose-missing-profile",
      { provider: "", model: "" },
      undefined,
      "preview",
      "code.proposeEdit",
      "code_propose",
    )).toMatchObject({
      backend: "unavailable",
      fallbackReason: "runtime_factory_unavailable",
    });
  });
});

function storageWithRollout(value: Record<string, unknown>): Pick<Storage, "getItem"> {
  const rollout = {
    verifiedModelProfiles: [
      { provider: "openai", model: "gpt-test" },
      { provider: "anthropic", model: "claude-test" },
      { provider: "legacy-agent-runtime-test", model: "legacy-test" },
    ],
    ...value,
  };
  return {
    getItem: (key) => key === AGENT_RUNTIME_ROLLOUT_STORAGE_KEY
      ? JSON.stringify(rollout)
      : null,
  };
}
