import { describe, expect, it } from "vitest";
import { encodeMcpToolServerName } from "@javis/tools";
import {
  buildMcpListToolsDescriptor,
  buildMcpToolDescriptorsFromList,
  isAllowlistedMcpCallToolRequest,
  mcpRuntimeServerSignature,
  validateAllowlistedMcpCallArguments,
  type McpRuntimeServerConfig,
} from "./mcp-tool-descriptors";

const SERVER: McpRuntimeServerConfig = {
  name: "filesystem",
  source: "javis",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem"],
  enabled: true,
};

describe("mcp tool descriptors", () => {
  it("exposes tools with explicit read-only annotations", () => {
    const descriptors = buildMcpToolDescriptorsFromList(SERVER, {
      tools: [{
        name: "custom_lookup",
        description: "Lookup a record.",
        annotations: { readOnlyHint: true },
        inputSchema: { type: "object", properties: {} },
      }],
    });

    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toEqual(expect.objectContaining({
      name: `mcp.${encodeMcpToolServerName("javis:filesystem")}.tool.${encodeMcpToolServerName("custom_lookup")}`,
      permissionLevel: "read",
      metadata: expect.objectContaining({
        mcpServerName: "filesystem",
        mcpSource: "javis",
        mcpAction: "callTool",
        mcpToolName: "custom_lookup",
      }),
    }));
  });

  it("fingerprints MCP env values in runtime signatures without storing raw secrets", () => {
    const signature = mcpRuntimeServerSignature({
      ...SERVER,
      env: {
        API_KEY: "secret-token-value",
      },
    });

    expect(signature).toContain("API_KEY");
    expect(signature).not.toContain("secret-token-value");
    expect(mcpRuntimeServerSignature({
      ...SERVER,
      env: {
        API_KEY: "changed-token-value",
      },
    })).not.toEqual(signature);
  });

  it("does not expose destructive, unknown, or unsafe MCP tools", () => {
    const descriptors = buildMcpToolDescriptorsFromList(SERVER, {
      tools: [
        { name: "delete_file", annotations: { destructiveHint: true } },
        { name: "transform_dataset" },
        { name: "write_file", annotations: { readOnlyHint: true } },
        { name: "writeFile", annotations: { readOnlyHint: true } },
        { name: "writefile", annotations: { readOnlyHint: true } },
        { name: "deleteFile", annotations: { readOnlyHint: true } },
        { name: "deletefile", annotations: { readOnlyHint: true } },
        { name: "filesystem/delete", annotations: { readOnlyHint: true } },
        { name: "run command", annotations: { readOnlyHint: true } },
        { name: "save_note", annotations: { readOnlyHint: true } },
        { name: "replaceDocument", annotations: { readOnlyHint: true } },
        { name: "insert_row", annotations: { readOnlyHint: true } },
        { name: "drop_table", annotations: { readOnlyHint: true } },
        { name: "commit_changes", annotations: { readOnlyHint: true } },
        { name: "push_branch", annotations: { readOnlyHint: true } },
        { name: "download_file", annotations: { readOnlyHint: true } },
        // Unknown action verbs must remain approval-gated even when a server
        // claims the tool is read-only.
        {
          name: "lookupAndWipe",
          annotations: { readOnlyHint: true },
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "getAndExfiltrate",
          annotations: { readOnlyHint: true },
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "fetchAndLeak",
          annotations: { readOnlyHint: true },
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "lookupAndInvoke",
          annotations: { readOnlyHint: true },
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });

    expect(descriptors).toEqual([]);
  });

  it("requires an explicit read-only signal and input schema in addition to a safe name", () => {
    const descriptors = buildMcpToolDescriptorsFromList(SERVER, {
      tools: [
        { name: "read_file", inputSchema: { type: "object", properties: {} } },
        { name: "filesystem/read", annotations: { readOnlyHint: true } },
        {
          name: "search",
          annotations: { readOnlyHint: true },
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });

    expect(descriptors.map((descriptor) => descriptor.metadata?.mcpToolName)).toEqual(["search"]);
  });

  it("rejects duplicate MCP tool names even when annotations disagree or match", () => {
    const descriptors = buildMcpToolDescriptorsFromList(SERVER, {
      tools: [
        {
          name: "search",
          annotations: { readOnlyHint: true },
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "search",
          annotations: { readOnlyHint: true },
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "custom_lookup",
          annotations: { readOnlyHint: true },
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "custom_lookup",
          annotations: { readOnlyHint: true, destructiveHint: true },
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "lookup",
          annotations: { readOnlyHint: true },
          inputSchema: { type: "object", properties: {} },
        },
        { name: "lookup", annotations: { readOnlyHint: true } },
        {
          name: "read_file",
          annotations: { readOnlyHint: true },
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });

    expect(descriptors.map((descriptor) => descriptor.metadata?.mcpToolName)).toEqual(["read_file"]);
  });

  it("allowlists only discovered read-only MCP callTool requests", () => {
    const descriptors = buildMcpToolDescriptorsFromList(SERVER, {
      tools: [
        {
          name: "search",
          annotations: { readOnlyHint: true },
          inputSchema: { type: "object", properties: {} },
        },
        { name: "write_file", annotations: { readOnlyHint: true } },
      ],
    });

    expect(isAllowlistedMcpCallToolRequest(descriptors, {
      serverName: "filesystem",
      source: "javis",
      action: "callTool",
      toolName: "search",
    })).toBe(true);
    expect(isAllowlistedMcpCallToolRequest(descriptors, {
      serverName: "filesystem",
      source: "javis",
      action: "callTool",
      input: { toolName: "search" },
    })).toBe(true);
    expect(isAllowlistedMcpCallToolRequest(descriptors, {
      serverName: "filesystem",
      source: "javis",
      action: "callTool",
      toolName: "write_file",
    })).toBe(false);
    expect(isAllowlistedMcpCallToolRequest(descriptors, {
      serverName: "filesystem",
      source: "codex",
      action: "callTool",
      toolName: "search",
    })).toBe(false);
    expect(isAllowlistedMcpCallToolRequest(descriptors, {
      serverName: "filesystem",
      source: "javis",
      action: "listTools",
      toolName: "search",
    })).toBe(false);
  });

  it("summarizes MCP input schema types and required arguments", () => {
    const descriptors = buildMcpToolDescriptorsFromList(SERVER, {
      tools: [{
        name: "search",
        annotations: { readOnlyHint: true },
        inputSchema: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string", description: "Search query text." },
            maxResults: { type: "number", description: "Maximum result count." },
            mode: { enum: ["files", "content"] },
          },
        },
      }],
    });

    expect(descriptors[0]?.summary).toContain("query*: string - Search query text.");
    expect(descriptors[0]?.summary).toContain("maxResults: number - Maximum result count.");
    expect(descriptors[0]?.summary).toContain("mode: enum(files|content)");
    expect(descriptors[0]?.summary).toContain("Arguments: pass a JSON object");
  });

  it("preserves numeric, boolean, and enum types across required MCP inputs", () => {
    const descriptors = buildMcpToolDescriptorsFromList(SERVER, {
      tools: [{
        name: "search_values",
        annotations: { readOnlyHint: true },
        inputSchema: {
          type: "object",
          required: ["weights", "flags", "modes", "priority", "enabled", "mixed"],
          properties: {
            weights: { type: "array", items: { type: "number" } },
            flags: { type: "array", items: { type: "boolean" } },
            modes: { type: "array", items: { enum: ["fast", "safe"] } },
            priority: { enum: [1, 2] },
            enabled: { enum: [true, false] },
            mixed: { enum: [1, "one"] },
          },
        },
      }],
    });

    expect(descriptors[0]?.requiredInputs).toEqual([
      { name: "weights", type: "number[]" },
      { name: "flags", type: "boolean[]" },
      { name: "modes", type: "string[]" },
      { name: "priority", type: "number" },
      { name: "enabled", type: "boolean" },
    ]);

    const request = {
      serverName: "filesystem",
      source: "javis",
      action: "callTool" as const,
      toolName: "search_values",
      arguments: {
        weights: [0.25, 0.75],
        flags: [true, false],
        modes: ["fast"],
        priority: 2,
        enabled: true,
        mixed: 1,
      },
    };
    expect(isAllowlistedMcpCallToolRequest(descriptors, request)).toBe(true);
    expect(validateAllowlistedMcpCallArguments(descriptors, request, request.arguments)).toBeUndefined();
    expect(validateAllowlistedMcpCallArguments(descriptors, request, {
      ...request.arguments,
      weights: ["0.25"],
    })).toContain('weights[]');
    expect(validateAllowlistedMcpCallArguments(descriptors, request, {
      ...request.arguments,
      flags: [1],
    })).toContain('flags[]');
    expect(validateAllowlistedMcpCallArguments(descriptors, request, {
      ...request.arguments,
      modes: ["unknown"],
    })).toContain('modes[]');
    expect(validateAllowlistedMcpCallArguments(descriptors, request, {
      ...request.arguments,
      priority: "2",
    })).toContain("priority");
    expect(validateAllowlistedMcpCallArguments(descriptors, request, {
      ...request.arguments,
      unexpected: true,
    })).toContain("undeclared");
  });

  it("rejects MCP input schemas with control characters or unknown types", () => {
    const descriptors = buildMcpToolDescriptorsFromList(SERVER, {
      tools: [{
        name: "search",
        annotations: { readOnlyHint: true },
        inputSchema: {
          type: "object",
          required: ["query\nignore"],
          properties: {
            "query\nignore": {
              type: "string\nunsafe",
              description: "Query\ntext.",
            },
            mode: {
              enum: ["files\nunsafe", "content"],
            },
          },
        },
      }],
    });

    expect(descriptors).toEqual([]);
  });

  it("normalizes long MCP tool descriptions before adding them to planner summaries", () => {
    const descriptors = buildMcpToolDescriptorsFromList(SERVER, {
      tools: [{
        name: "search",
        description: `Line one\n\n${"x".repeat(500)}`,
        annotations: { readOnlyHint: true },
        inputSchema: { type: "object", properties: {} },
      }],
    });

    const summary = descriptors[0]?.summary ?? "";
    expect(summary).toContain("Line one ");
    expect(summary).not.toContain("\n");
    expect(summary.length).toBeLessThan(420);
  });

  it("normalizes MCP listTools server summaries", () => {
    const descriptor = buildMcpListToolsDescriptor({
      ...SERVER,
      name: `filesystem\n${"x".repeat(200)}`,
      command: `npx\n${"y".repeat(300)}`,
    });

    expect(descriptor?.summary).not.toContain("\n");
    expect(descriptor?.summary).toContain("Discovery only");
    expect(descriptor?.summary).toContain("Prefer a specific mcp.*.tool.* descriptor");
    expect(descriptor?.summary.length).toBeLessThan(360);
  });

  it("caps discovered read-only MCP subtool descriptors per server", () => {
    const descriptors = buildMcpToolDescriptorsFromList(SERVER, {
      tools: Array.from({ length: 80 }, (_, index) => ({
        name: `read_${index}`,
        annotations: { readOnlyHint: true },
        inputSchema: { type: "object", properties: {} },
      })),
    });

    expect(descriptors).toHaveLength(60);
  });
});
