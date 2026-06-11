import { describe, expect, it } from "vitest";
import { encodeMcpToolServerName } from "@javis/tools";
import {
  buildMcpListToolsDescriptor,
  buildMcpToolDescriptorsFromList,
  isAllowlistedMcpCallToolRequest,
  mcpRuntimeServerSignature,
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
      ],
    });

    expect(descriptors).toEqual([]);
  });

  it("exposes conservative read-only tool names without annotations", () => {
    const descriptors = buildMcpToolDescriptorsFromList(SERVER, {
      tools: [
        { name: "read_file" },
        { name: "filesystem/read" },
        { name: "search" },
      ],
    });

    expect(descriptors.map((descriptor) => descriptor.metadata?.mcpToolName)).toEqual([
      "read_file",
      "filesystem/read",
      "search",
    ]);
  });

  it("allowlists only discovered read-only MCP callTool requests", () => {
    const descriptors = buildMcpToolDescriptorsFromList(SERVER, {
      tools: [
        { name: "search" },
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

  it("normalizes MCP input schema names and enum values", () => {
    const descriptors = buildMcpToolDescriptorsFromList(SERVER, {
      tools: [{
        name: "search",
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

    const summary = descriptors[0]?.summary ?? "";
    expect(summary).toContain("query ignore*: string unsafe - Query text.");
    expect(summary).toContain("mode: enum(files unsafe|content)");
    expect(summary).not.toContain("\n");
  });

  it("normalizes long MCP tool descriptions before adding them to planner summaries", () => {
    const descriptors = buildMcpToolDescriptorsFromList(SERVER, {
      tools: [{
        name: "search",
        description: `Line one\n\n${"x".repeat(500)}`,
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
      })),
    });

    expect(descriptors).toHaveLength(60);
  });
});
