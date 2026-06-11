import { encodeMcpToolServerName, type ToolDescriptor } from "@javis/tools";
import {
  mcpRuntimeServerKey,
  mcpRuntimeServerSignature,
  type McpRuntimeServerConfig,
} from "./mcp-tool-descriptors";

export const MCP_TOOL_DESCRIPTOR_CACHE_STORAGE_KEY = "javis.mcpToolDescriptors.v1";
export const MCP_TOOL_DESCRIPTOR_CACHE_MAX_AGE_MS = 12 * 60 * 60_000;

export interface McpToolDescriptorCacheEntry {
  signature: string;
  cachedAt: number;
  descriptors: ToolDescriptor[];
}

export type McpToolDescriptorCache = Map<string, McpToolDescriptorCacheEntry>;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface SerializedMcpToolDescriptorCache {
  entries?: Array<[string, unknown]>;
}

export function loadMcpToolDescriptorCache(
  storage: StorageLike | undefined,
  now = Date.now(),
): McpToolDescriptorCache {
  const cache: McpToolDescriptorCache = new Map();
  if (!storage) return cache;
  try {
    const raw = storage.getItem(MCP_TOOL_DESCRIPTOR_CACHE_STORAGE_KEY);
    if (!raw) return cache;
    const parsed = JSON.parse(raw) as SerializedMcpToolDescriptorCache;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
      return cache;
    }
    for (const [key, value] of parsed.entries) {
      if (!isSafeCacheKey(key)) continue;
      const entry = parseCacheEntry(value);
      if (!entry || !isFreshCacheEntry(entry, now)) continue;
      cache.set(key, entry);
    }
  } catch {
    return new Map();
  }
  return cache;
}

export function saveMcpToolDescriptorCache(
  storage: StorageLike | undefined,
  cache: McpToolDescriptorCache,
): void {
  if (!storage) return;
  try {
    const entries = [...cache.entries()]
      .filter(([key]) => isSafeCacheKey(key))
      .map(([key, entry]) => [key, entry] as const);
    if (entries.length === 0) {
      storage.removeItem(MCP_TOOL_DESCRIPTOR_CACHE_STORAGE_KEY);
      return;
    }
    storage.setItem(MCP_TOOL_DESCRIPTOR_CACHE_STORAGE_KEY, JSON.stringify({ entries }));
  } catch {
    // Cache persistence is best-effort and must never block MCP discovery.
  }
}

export function getFreshCachedMcpToolDescriptors(
  cache: McpToolDescriptorCache,
  server: McpRuntimeServerConfig,
  now = Date.now(),
): ToolDescriptor[] | null {
  const key = mcpRuntimeServerKey(server);
  const entry = cache.get(key);
  if (!entry || entry.signature !== mcpRuntimeServerSignature(server) || !isFreshCacheEntry(entry, now)) {
    return null;
  }
  const descriptors = entry.descriptors.filter((descriptor) =>
    isCachedMcpToolDescriptorForServer(descriptor, server)
  );
  if (descriptors.length !== entry.descriptors.length) {
    cache.delete(key);
    return null;
  }
  return descriptors;
}

export function setCachedMcpToolDescriptors(
  cache: McpToolDescriptorCache,
  server: McpRuntimeServerConfig,
  descriptors: readonly ToolDescriptor[],
  now = Date.now(),
): void {
  const filteredDescriptors = descriptors
    .filter((descriptor) => isCachedMcpToolDescriptorForServer(descriptor, server))
    .slice(0, 80);
  if (filteredDescriptors.length === 0) {
    cache.delete(mcpRuntimeServerKey(server));
    return;
  }
  cache.set(mcpRuntimeServerKey(server), {
    signature: mcpRuntimeServerSignature(server),
    cachedAt: now,
    descriptors: filteredDescriptors,
  });
}

export function pruneMcpToolDescriptorCache(
  cache: McpToolDescriptorCache,
  activeServerKeys: ReadonlySet<string>,
): void {
  for (const key of cache.keys()) {
    if (!activeServerKeys.has(key)) {
      cache.delete(key);
    }
  }
}

function parseCacheEntry(value: unknown): McpToolDescriptorCacheEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const signature = typeof record.signature === "string" ? record.signature : "";
  const cachedAt = typeof record.cachedAt === "number" ? record.cachedAt : NaN;
  const rawDescriptors = Array.isArray(record.descriptors) ? record.descriptors : [];
  const descriptors = rawDescriptors
    .map(parseCachedToolDescriptor)
    .filter((descriptor): descriptor is ToolDescriptor => descriptor !== null)
    .slice(0, 80);
  if (!signature || !Number.isFinite(cachedAt) || descriptors.length === 0) {
    return null;
  }
  return { signature, cachedAt, descriptors };
}

function parseCachedToolDescriptor(value: unknown): ToolDescriptor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.name !== "string" ||
    record.permissionLevel !== "read" ||
    typeof record.summary !== "string" ||
    !Array.isArray(record.capabilityTags) ||
    !Array.isArray(record.ownerAgentKinds)
  ) {
    return null;
  }
  const capabilityTags = record.capabilityTags.filter((item): item is string => typeof item === "string").slice(0, 12);
  const ownerAgentKinds = record.ownerAgentKinds.filter((item): item is string => typeof item === "string").slice(0, 12);
  return {
    name: record.name,
    permissionLevel: "read",
    summary: record.summary.slice(0, 600),
    capabilityTags,
    ownerAgentKinds,
    metadata: parseMetadata(record.metadata),
  };
}

function parseMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return { ...(value as Record<string, unknown>) };
}

function isFreshCacheEntry(entry: McpToolDescriptorCacheEntry, now: number): boolean {
  return entry.cachedAt <= now + 60_000 && now - entry.cachedAt <= MCP_TOOL_DESCRIPTOR_CACHE_MAX_AGE_MS;
}

function isSafeCacheKey(value: string): boolean {
  return value.length > 0 && value.length <= 240 && !/[\r\n\t]/.test(value);
}

function isCachedMcpToolDescriptorForServer(
  descriptor: ToolDescriptor,
  server: McpRuntimeServerConfig,
): boolean {
  const metadata = descriptor.metadata ?? {};
  const mcpToolName = typeof metadata.mcpToolName === "string"
    ? metadata.mcpToolName.trim()
    : "";
  const expectedName = mcpToolName
    ? `mcp.${encodeMcpToolServerName(mcpRuntimeServerKey(server))}.tool.${encodeMcpToolServerName(mcpToolName)}`
    : "";
  return descriptor.permissionLevel === "read" &&
    descriptor.name.startsWith("mcp.") &&
    descriptor.name === expectedName &&
    metadata.mcpAction === "callTool" &&
    metadata.mcpServerName === server.name &&
    metadata.mcpSource === server.source &&
    mcpToolName.length > 0;
}
