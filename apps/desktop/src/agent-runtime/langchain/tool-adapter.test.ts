import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentToolSpec, ToolExecutionGateway } from "@javis/core";
import { createLangChainTools } from "./tool-adapter";

const spec: AgentToolSpec = {
  canonicalName: "web.search",
  modelName: "web__search",
  description: "Search",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

describe("LangChain tool adapter", () => {
  it("fails a hung gateway at the Javis tool timeout", async () => {
    const execute = vi.fn<ToolExecutionGateway["execute"]>(() => new Promise(() => undefined));
    const events: AgentEvent[] = [];
    const [search] = createLangChainTools({
      specs: [spec],
      gateway: { execute },
      request: {
        taskId: "task-1",
        runId: "run-1",
        messages: [],
        context: {},
      },
      agentKind: "research",
      toolTimeoutMs: 5,
      maxToolCalls: 1,
      onEvent: (event) => events.push(event),
    });

    await expect(search!.invoke(
      { query: "rust" },
      { toolCall: { id: "call-1", name: "web__search", args: { query: "rust" } } },
    )).rejects.toThrow("timed out");
    expect(events.map((event) => event.type)).toEqual(["tool.started", "tool.failed"]);
  });

  it("surfaces gateway failures as ordered tool events", async () => {
    const events: AgentEvent[] = [];
    const [search] = createLangChainTools({
      specs: [spec],
      gateway: {
        execute: vi.fn<ToolExecutionGateway["execute"]>(async () => ({
          status: "error",
          reason: "search unavailable",
        })),
      },
      request: {
        taskId: "task-failure",
        runId: "run-failure",
        messages: [],
        context: {},
      },
      agentKind: "research",
      toolTimeoutMs: 1_000,
      maxToolCalls: 1,
      onEvent: (event) => events.push(event),
    });

    await expect(search!.invoke({
      id: "call-failure",
      name: "web__search",
      args: { query: "rust" },
      type: "tool_call",
    })).rejects.toThrow("search unavailable");
    expect(events.map((event) => event.type)).toEqual(["tool.started", "tool.failed"]);
    expect(events[1]).toMatchObject({
      type: "tool.failed",
      toolName: "web.search",
      reason: "search unavailable",
    });
  });

  it("enforces the tool-call limit before a second dispatch", async () => {
    const execute = vi.fn<ToolExecutionGateway["execute"]>(async () => ({
      status: "success",
      output: "ok",
    }));
    const [search] = createLangChainTools({
      specs: [spec],
      gateway: { execute },
      request: {
        taskId: "task-1",
        runId: "run-1",
        messages: [],
        context: {},
      },
      agentKind: "research",
      toolTimeoutMs: 1_000,
      maxToolCalls: 1,
    });
    const config = {
      toolCall: { id: "call-1", name: "web__search", args: { query: "rust" } },
    };

    await expect(search!.invoke({ query: "rust" }, config)).resolves.toMatchObject({
      content: "ok",
      tool_call_id: "call-1",
    });
    await expect(search!.invoke({ query: "rust" }, config)).rejects.toThrow("tool call limit");
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
