import { describe, expect, it } from "vitest";
import { encodeMcpToolServerName, type ToolDescriptor } from "@javis/tools";
import {
  getFreshCachedMcpToolDescriptors,
  loadMcpToolDescriptorCache,
  MCP_TOOL_DESCRIPTOR_CACHE_MAX_AGE_MS,
  MCP_TOOL_DESCRIPTOR_CACHE_STORAGE_KEY,
  pruneMcpToolDescriptorCache,
  saveMcpToolDescriptorCache,
  setCachedMcpToolDescriptors,
} from "./mcp-tool-descriptor-cache";
import {
  mcpRuntimeServerKey,
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

const SEARCH_DESCRIPTOR: ToolDescriptor = {
  name: `mcp.${encodeMcpToolServerName("javis:filesystem")}.tool.${encodeMcpToolServerName("search")}`,
  permissionLevel: "read",
  summary: "Call read-only MCP tool search.",
  capabilityTags: ["local_search"],
  ownerAgentKinds: ["commander", "file"],
  metadata: {
    mcpServerName: "filesystem",
    mcpSource: "javis",
    mcpAction: "callTool",
    mcpToolName: "search",
  },
};

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

describe("mcp tool descriptor cache", () => {
  it("round-trips fresh descriptors for the same server signature", () => {
    const storage = new MemoryStorage();
    const cache = new Map();

    setCachedMcpToolDescriptors(cache, SERVER, [SEARCH_DESCRIPTOR], 10_000);
    saveMcpToolDescriptorCache(storage, cache);

    const loaded = loadMcpToolDescriptorCache(storage, 10_000);
    expect(getFreshCachedMcpToolDescriptors(loaded, SERVER, 10_000)).toEqual([SEARCH_DESCRIPTOR]);
  });

  it("does not cache empty descriptor results so fixed servers can be rediscovered", () => {
    const storage = new MemoryStorage();
    const cache = new Map();

    setCachedMcpToolDescriptors(cache, SERVER, [], 10_000);
    saveMcpToolDescriptorCache(storage, cache);

    const loaded = loadMcpToolDescriptorCache(storage, 10_000);
    expect(getFreshCachedMcpToolDescriptors(loaded, SERVER, 10_000)).toBeNull();
  });

  it("rejects stale cache entries", () => {
    const cache = new Map();

    setCachedMcpToolDescriptors(cache, SERVER, [SEARCH_DESCRIPTOR], 10_000);

    expect(getFreshCachedMcpToolDescriptors(
      cache,
      SERVER,
      10_000 + MCP_TOOL_DESCRIPTOR_CACHE_MAX_AGE_MS + 1,
    )).toBeNull();
  });

  it("rejects cached descriptors whose metadata does not match the server", () => {
    const cache = new Map();
    const wrongServerDescriptor: ToolDescriptor = {
      ...SEARCH_DESCRIPTOR,
      metadata: {
        ...SEARCH_DESCRIPTOR.metadata,
        mcpServerName: "other",
      },
    };

    setCachedMcpToolDescriptors(cache, SERVER, [wrongServerDescriptor], 10_000);

    expect(getFreshCachedMcpToolDescriptors(cache, SERVER, 10_000)).toBeNull();
  });

  it("rejects cached descriptors whose encoded name does not match metadata", () => {
    const cache = new Map();
    const wrongNameDescriptor: ToolDescriptor = {
      ...SEARCH_DESCRIPTOR,
      name: `mcp.${encodeMcpToolServerName("javis:filesystem")}.tool.${encodeMcpToolServerName("other")}`,
    };

    setCachedMcpToolDescriptors(cache, SERVER, [wrongNameDescriptor], 10_000);

    expect(getFreshCachedMcpToolDescriptors(cache, SERVER, 10_000)).toBeNull();
  });

  it("does not load write descriptors from storage", () => {
    const storage = new MemoryStorage();
    storage.setItem(MCP_TOOL_DESCRIPTOR_CACHE_STORAGE_KEY, JSON.stringify({
      entries: [[mcpRuntimeServerKey(SERVER), {
        signature: JSON.stringify({
          source: SERVER.source,
          name: SERVER.name,
          transport: SERVER.transport,
          command: SERVER.command,
          url: "",
          args: SERVER.args,
          cwd: "",
          env: {},
          enabled: SERVER.enabled,
        }),
        cachedAt: 10_000,
        descriptors: [{ ...SEARCH_DESCRIPTOR, permissionLevel: "confirmed_write" }],
      }]],
    }));

    const loaded = loadMcpToolDescriptorCache(storage, 10_000);

    expect(getFreshCachedMcpToolDescriptors(loaded, SERVER, 10_000)).toBeNull();
  });

  it("prunes descriptors for inactive servers", () => {
    const cache = new Map();
    setCachedMcpToolDescriptors(cache, SERVER, [SEARCH_DESCRIPTOR], 10_000);

    pruneMcpToolDescriptorCache(cache, new Set(["javis:other"]));

    expect(cache.size).toBe(0);
  });
});
