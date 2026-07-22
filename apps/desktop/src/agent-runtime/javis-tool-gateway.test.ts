import { describe, expect, it, vi } from "vitest";
import type { ToolDescriptor } from "@javis/tools";
import type { AgentKind } from "@javis/core";
import { createReadOnlyToolExecutionGateway } from "./javis-tool-gateway";

const readTool: ToolDescriptor = {
  name: "web.search",
  permissionLevel: "read",
  summary: "Search",
  capabilityTags: ["web_search"],
  ownerAgentKinds: ["research"],
  requiredInputs: [{ name: "query", type: "string", nonEmpty: true }],
};
const writeTool: ToolDescriptor = {
  ...readTool,
  name: "file.writeText",
  permissionLevel: "confirmed_write",
  ownerAgentKinds: ["file"],
};

function request(toolName = "web.search", agentKind: AgentKind = "research") {
  return {
    taskId: "task-1",
    runId: "run-1",
    agentKind,
    toolName,
    input: { query: "rust" },
  };
}

describe("read-only Javis tool gateway", () => {
  it("dispatches an owned allowlisted read tool", async () => {
    const dispatch = vi.fn(async () => ({ results: ["ok"] }));
    const gateway = createReadOnlyToolExecutionGateway({
      descriptors: [readTool, writeTool],
      getAllowedToolNames: () => ["web.search"],
      dispatch,
    });
    await expect(gateway.execute(request())).resolves.toEqual({
      status: "success",
      output: { results: ["ok"] },
    });
  });

  it("rejects write tools before dispatch", async () => {
    const dispatch = vi.fn();
    const gateway = createReadOnlyToolExecutionGateway({
      descriptors: [readTool, writeTool],
      getAllowedToolNames: () => ["file.writeText"],
      dispatch,
    });
    await expect(gateway.execute(request("file.writeText", "file"))).resolves.toMatchObject({
      status: "error",
      reason: expect.stringContaining("never permits confirmed_write"),
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects missing required input and allowlist violations", async () => {
    const gateway = createReadOnlyToolExecutionGateway({
      descriptors: [readTool],
      getAllowedToolNames: () => ["web.search"],
      dispatch: vi.fn(),
    });
    await expect(gateway.execute({ ...request(), input: {} })).resolves.toMatchObject({
      status: "error",
      reason: expect.stringContaining("input.query"),
    });

    const denied = createReadOnlyToolExecutionGateway({
      descriptors: [readTool],
      getAllowedToolNames: () => [],
      dispatch: vi.fn(),
    });
    await expect(denied.execute(request())).resolves.toMatchObject({
      status: "error",
      reason: expect.stringContaining("allowlist"),
    });
  });

  it("rejects wrong types and undeclared MCP fields before dispatch", async () => {
    const dispatch = vi.fn();
    const gateway = createReadOnlyToolExecutionGateway({
      descriptors: [{
        ...readTool,
        requiredInputs: [],
        metadata: {
          mcpInputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
        },
      }],
      getAllowedToolNames: () => ["web.search"],
      dispatch,
    });

    await expect(gateway.execute({
      ...request(),
      input: { query: 42 },
    })).resolves.toMatchObject({
      status: "error",
      reason: expect.stringContaining("must be a string"),
    });
    await expect(gateway.execute({
      ...request(),
      input: { query: "rust", secret: "unexpected" },
    })).resolves.toMatchObject({
      status: "error",
      reason: expect.stringContaining("undeclared field"),
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
