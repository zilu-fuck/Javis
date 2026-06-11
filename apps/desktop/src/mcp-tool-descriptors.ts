import {
  encodeMcpToolServerName,
  type McpCallRequest,
  type PermissionLevel,
  type ToolDescriptor,
  type WriteRiskLevel,
} from "@javis/tools";

export interface McpRuntimeServerConfig {
  name: string;
  source: string;
  transport: string;
  command?: string;
  url?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  enabled: boolean;
}

interface McpListedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export function isRunnableMcpServerConfig(server: { transport: string; command?: string }): boolean {
  return server.transport === "stdio" && Boolean(server.command?.trim());
}

export function isExecutableMcpServer(server: { transport: string; command?: string; enabled: boolean }): boolean {
  return server.enabled && isRunnableMcpServerConfig(server);
}

export function mcpRuntimeServerKey(server: Pick<McpRuntimeServerConfig, "source" | "name">): string {
  return `${server.source}:${server.name}`;
}

export function mcpRuntimeServerSignature(server: McpRuntimeServerConfig): string {
  return JSON.stringify({
    source: server.source,
    name: server.name,
    transport: server.transport,
    command: server.command ?? "",
    url: server.url ?? "",
    args: server.args ?? [],
    cwd: server.cwd ?? "",
    env: fingerprintMcpEnv(server.env),
    enabled: server.enabled,
  });
}

function fingerprintMcpEnv(env: Record<string, string> | undefined): Record<string, string> {
  const entries = Object.entries(env ?? {}).sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries.map(([key, value]) => [
    key,
    `${value.length}:${hashMcpSignatureValue(value)}`,
  ]));
}

function hashMcpSignatureValue(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function buildMcpListToolsDescriptor(server: McpRuntimeServerConfig): ToolDescriptor | null {
  if (!isExecutableMcpServer(server)) return null;
  const toolServerName = encodeMcpToolServerName(mcpRuntimeServerKey(server));
  if (!toolServerName) return null;
  const serverName = summarizeMcpText(server.name, 80) || server.name;
  const serverSummary = summarizeMcpText(server.command ?? server.url ?? server.transport, 100);
  return {
    name: `mcp.${toolServerName}.listTools`,
    permissionLevel: "read",
    summary: `Discovery only: list tools exposed by MCP server ${serverName}${serverSummary ? ` (${serverSummary})` : ""}. Prefer a specific mcp.*.tool.* descriptor when one matches the task.`,
    capabilityTags: ["local_search"],
    ownerAgentKinds: MCP_OWNER_AGENT_KINDS,
    metadata: {
      mcpServerName: server.name,
      mcpSource: server.source,
      mcpAction: "listTools",
    },
  };
}

export function buildMcpToolDescriptorsFromList(
  server: McpRuntimeServerConfig,
  listToolsResult: unknown,
): ToolDescriptor[] {
  if (!isExecutableMcpServer(server)) return [];
  const toolServerName = encodeMcpToolServerName(mcpRuntimeServerKey(server));
  if (!toolServerName) return [];
  return parseMcpListedTools(listToolsResult)
    .map((tool) => buildMcpToolDescriptor(server, toolServerName, tool))
    .filter((descriptor): descriptor is ToolDescriptor => descriptor !== null)
    .slice(0, MAX_MCP_TOOL_DESCRIPTORS_PER_SERVER);
}

export function isAllowlistedMcpCallToolRequest(
  descriptors: readonly ToolDescriptor[],
  request: McpCallRequest,
): boolean {
  if ((request.action ?? "callTool") !== "callTool") return false;
  const requestedToolName = mcpRequestToolName(request);
  const requestedSource = request.source?.trim();
  if (!requestedToolName || !requestedSource) return false;
  return descriptors.some((descriptor) =>
    descriptor.permissionLevel === "read" &&
    descriptor.metadata?.mcpAction === "callTool" &&
    descriptor.metadata.mcpServerName === request.serverName &&
    descriptor.metadata.mcpSource === requestedSource &&
    descriptor.metadata.mcpToolName === requestedToolName
  );
}

function mcpRequestToolName(request: McpCallRequest): string {
  const direct = request.toolName?.trim();
  if (direct) return direct;
  const value = request.input?.toolName;
  return typeof value === "string" ? value.trim() : "";
}

function buildMcpToolDescriptor(
  server: McpRuntimeServerConfig,
  encodedServerName: string,
  tool: McpListedTool,
): ToolDescriptor | null {
  const permission = classifyMcpToolPermission(tool);
  if (permission.permissionLevel !== "read") {
    return null;
  }
  const encodedToolName = encodeMcpToolServerName(tool.name);
  if (!encodedToolName) return null;
  return {
    name: `mcp.${encodedServerName}.tool.${encodedToolName}`,
    permissionLevel: permission.permissionLevel,
    ...(permission.writeRiskLevel ? { writeRiskLevel: permission.writeRiskLevel } : {}),
    summary: summarizeMcpTool(server, tool),
    capabilityTags: capabilityTagsForMcpTool(tool),
    ownerAgentKinds: MCP_OWNER_AGENT_KINDS,
    metadata: {
      mcpServerName: server.name,
      mcpSource: server.source,
      mcpAction: "callTool",
      mcpToolName: tool.name,
    },
  };
}

function parseMcpListedTools(value: unknown): McpListedTool[] {
  if (!value || typeof value !== "object") return [];
  const tools = (value as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .map((tool): McpListedTool | null => {
      if (!tool || typeof tool !== "object") return null;
      const record = tool as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name.trim() : "";
      if (!name) return null;
      return {
        name,
        description: typeof record.description === "string" ? record.description : undefined,
        inputSchema: record.inputSchema,
        annotations: parseMcpToolAnnotations(record.annotations),
      };
    })
    .filter((tool): tool is McpListedTool => tool !== null);
}

function parseMcpToolAnnotations(value: unknown): McpListedTool["annotations"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    title: typeof record.title === "string" ? record.title : undefined,
    readOnlyHint: typeof record.readOnlyHint === "boolean" ? record.readOnlyHint : undefined,
    destructiveHint: typeof record.destructiveHint === "boolean" ? record.destructiveHint : undefined,
    idempotentHint: typeof record.idempotentHint === "boolean" ? record.idempotentHint : undefined,
    openWorldHint: typeof record.openWorldHint === "boolean" ? record.openWorldHint : undefined,
  };
}

function classifyMcpToolPermission(tool: McpListedTool): {
  permissionLevel: PermissionLevel;
  writeRiskLevel?: WriteRiskLevel;
} {
  const annotations = tool.annotations;
  if (annotations?.destructiveHint === true) {
    return { permissionLevel: "confirmed_write", writeRiskLevel: "dangerous" };
  }
  const nameTokens = tokenizeMcpToolName(tool.name);
  if (nameTokens.some(isUnsafeMcpToolNameToken)) {
    return { permissionLevel: "confirmed_write", writeRiskLevel: "risky" };
  }
  if (annotations?.readOnlyHint === true) {
    return { permissionLevel: "read" };
  }
  if (annotations?.readOnlyHint === false) {
    return { permissionLevel: "confirmed_write", writeRiskLevel: "risky" };
  }
  if (nameTokens.some((token) => MCP_READONLY_TOOL_NAME_TOKENS.has(token))) {
    return { permissionLevel: "read" };
  }
  return { permissionLevel: "confirmed_write", writeRiskLevel: "risky" };
}

function tokenizeMcpToolName(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter(Boolean);
}

function isUnsafeMcpToolNameToken(token: string): boolean {
  return MCP_UNSAFE_TOOL_NAME_TOKENS.has(token) ||
    MCP_UNSAFE_COMPACT_PREFIXES.some((prefix) => token.length > prefix.length && token.startsWith(prefix));
}

function summarizeMcpTool(server: McpRuntimeServerConfig, tool: McpListedTool): string {
  const description = summarizeMcpText(tool.description, 300);
  const toolName = summarizeMcpText(tool.name, 120) || tool.name;
  const serverName = summarizeMcpText(server.name, 120) || server.name;
  const inputSummary = summarizeMcpInputSchema(tool.inputSchema);
  return [
    `Call read-only MCP tool ${toolName} on server ${serverName}.`,
    description,
    inputSummary
      ? `Arguments: pass a JSON object matching these fields: ${inputSummary}`
      : "Arguments: pass a JSON object only when the tool needs input.",
  ].filter(Boolean).join(" ");
}

function summarizeMcpInputSchema(schema: unknown): string {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return "";
  const record = schema as Record<string, unknown>;
  const properties = record.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return "";
  const required = Array.isArray(record.required)
    ? new Set(record.required.filter((item): item is string => typeof item === "string"))
    : new Set<string>();
  const names = Object.keys(properties).slice(0, 6);
  if (names.length === 0) return "";
  const suffix = Object.keys(properties).length > names.length ? ", ..." : "";
  return names
    .map((name) => summarizeMcpInputProperty(name, (properties as Record<string, unknown>)[name], required.has(name)))
    .join("; ") + suffix;
}

function summarizeMcpInputProperty(name: string, schema: unknown, required: boolean): string {
  const safeName = summarizeMcpText(name, 80) || name;
  const marker = required ? "*" : "";
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return `${safeName}${marker}`;
  }
  const record = schema as Record<string, unknown>;
  const type = summarizeMcpSchemaType(record);
  const description = summarizeMcpSchemaDescription(record);
  return [
    `${safeName}${marker}: ${type}`,
    description,
  ].filter(Boolean).join(" - ");
}

function summarizeMcpSchemaType(schema: Record<string, unknown>): string {
  const enumValues = Array.isArray(schema.enum)
    ? schema.enum
        .filter((value) => ["string", "number", "boolean"].includes(typeof value))
        .slice(0, 4)
        .map((value) => summarizeMcpText(String(value), 30))
        .filter(Boolean)
    : [];
  if (enumValues.length > 0) {
    const suffix = Array.isArray(schema.enum) && schema.enum.length > enumValues.length ? "|..." : "";
    return `enum(${enumValues.join("|")}${suffix})`;
  }
  const type = schema.type;
  if (typeof type === "string" && type.trim()) {
    return summarizeMcpText(type, 60);
  }
  if (Array.isArray(type)) {
    const types = type
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => summarizeMcpText(item, 30))
      .filter(Boolean);
    if (types.length > 0) {
      return types.join("|");
    }
  }
  if (typeof schema.$ref === "string" && schema.$ref.trim()) {
    return "ref";
  }
  return "value";
}

function summarizeMcpSchemaDescription(schema: Record<string, unknown>): string {
  const description = typeof schema.description === "string"
    ? schema.description
    : typeof schema.title === "string"
      ? schema.title
      : "";
  return summarizeMcpText(description, 90);
}

function summarizeMcpText(value: string | undefined, maxChars: number): string {
  return (value ?? "").trim().replace(/\s+/g, " ").slice(0, maxChars);
}

function capabilityTagsForMcpTool(tool: McpListedTool): string[] {
  const name = tool.name.toLowerCase();
  if (name.includes("git")) return ["git_inspect", "local_search"];
  if (name.includes("web") || name.includes("http") || name.includes("url")) return ["web_fetch"];
  return ["local_search"];
}

const MCP_OWNER_AGENT_KINDS = ["commander", "workspace", "file", "research", "code"];
const MAX_MCP_TOOL_DESCRIPTORS_PER_SERVER = 60;
const MCP_UNSAFE_TOOL_NAME_TOKENS = new Set([
  "write",
  "delete",
  "remove",
  "create",
  "update",
  "edit",
  "set",
  "add",
  "append",
  "insert",
  "upsert",
  "replace",
  "rename",
  "save",
  "clear",
  "reset",
  "drop",
  "truncate",
  "format",
  "overwrite",
  "mutate",
  "modify",
  "enable",
  "disable",
  "move",
  "copy",
  "run",
  "execute",
  "exec",
  "shell",
  "command",
  "apply",
  "patch",
  "install",
  "start",
  "stop",
  "restart",
  "open",
  "click",
  "type",
  "send",
  "post",
  "put",
  "deploy",
  "publish",
  "upload",
  "download",
  "clone",
  "checkout",
  "commit",
  "push",
  "merge",
  "grant",
  "revoke",
  "login",
  "auth",
  "subscribe",
  "mkdir",
  "rmdir",
]);
const MCP_UNSAFE_COMPACT_PREFIXES = [
  "write",
  "delete",
  "remove",
  "create",
  "update",
  "edit",
  "append",
  "insert",
  "upsert",
  "replace",
  "rename",
  "save",
  "clear",
  "reset",
  "drop",
  "truncate",
  "format",
  "overwrite",
  "mutate",
  "modify",
  "enable",
  "disable",
  "move",
  "copy",
  "run",
  "execute",
  "exec",
  "shell",
  "command",
  "apply",
  "patch",
  "install",
  "start",
  "stop",
  "restart",
  "click",
  "type",
  "send",
  "post",
  "put",
  "deploy",
  "publish",
  "upload",
  "download",
  "clone",
  "checkout",
  "commit",
  "push",
  "merge",
  "grant",
  "revoke",
  "login",
  "auth",
  "subscribe",
  "mkdir",
  "rmdir",
];
const MCP_READONLY_TOOL_NAME_TOKENS = new Set([
  "read",
  "get",
  "list",
  "search",
  "find",
  "query",
  "fetch",
  "lookup",
  "inspect",
  "describe",
  "stat",
  "status",
  "show",
  "view",
  "resolve",
  "explain",
  "info",
]);
