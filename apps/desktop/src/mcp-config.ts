import { invoke } from "@tauri-apps/api/core";

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "sse";
  command?: string;
  url?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  enabled: boolean;
  raw?: Record<string, unknown>;
}

type McpConfigFileFormat = "array" | "mcpServers";

let lastLoadedFormat: McpConfigFileFormat = "mcpServers";

export async function loadMcpConfig(): Promise<McpServerConfig[]> {
  const result = await invoke<string | null>("read_mcp_config");
  if (!result) return [];
  const parsed: unknown = JSON.parse(result);
  const normalized = normalizeMcpConfig(parsed);
  lastLoadedFormat = normalized.format;
  return normalized.servers;
}

export async function saveMcpConfig(config: McpServerConfig[]): Promise<void> {
  await invoke("write_mcp_config", { json: JSON.stringify(serializeMcpConfig(config, lastLoadedFormat), null, 2) });
}

export function parseMcpConfigText(json: string): McpServerConfig[] {
  const normalized = normalizeMcpConfig(JSON.parse(json));
  return normalized.servers;
}

function normalizeMcpConfig(value: unknown): { servers: McpServerConfig[]; format: McpConfigFileFormat } {
  if (Array.isArray(value)) {
    return {
      servers: value
        .map(normalizeArrayMcpServer)
        .filter((server): server is McpServerConfig => server !== null),
      format: "array",
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { servers: [], format: "mcpServers" };
  }
  const obj = value as Record<string, unknown>;
  const mcpServers = obj.mcpServers;
  if (typeof mcpServers !== "object" || mcpServers === null || Array.isArray(mcpServers)) {
    return { servers: [], format: "mcpServers" };
  }
  const servers = Object.entries(mcpServers)
    .map(([name, config]) => normalizeNamedMcpServer(name, config))
    .filter((server): server is McpServerConfig => server !== null);
  return { servers, format: "mcpServers" };
}

function serializeMcpConfig(config: McpServerConfig[], format: McpConfigFileFormat): unknown {
  if (format === "array") {
    return config.map(({ raw: _raw, ...server }) => server);
  }
  return {
    mcpServers: Object.fromEntries(config.map((server) => [
      server.name,
      {
        ...(server.raw ?? {}),
        transport: server.transport,
        command: server.command,
        url: server.url,
        args: server.args,
        cwd: server.cwd,
        env: server.env,
        enabled: server.enabled,
      },
    ])),
  };
}

function normalizeArrayMcpServer(value: unknown): McpServerConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name : undefined;
  if (!name) return null;
  return normalizeNamedMcpServer(name, value);
}

function normalizeNamedMcpServer(name: string, value: unknown): McpServerConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const transport = obj.transport === "sse" ? "sse" : "stdio";
  const command = typeof obj.command === "string" ? obj.command : undefined;
  const url = typeof obj.url === "string" ? obj.url : undefined;
  const args = Array.isArray(obj.args) ? obj.args.filter((arg): arg is string => typeof arg === "string") : undefined;
  const cwd = typeof obj.cwd === "string" ? obj.cwd : undefined;
  const env = normalizeStringRecord(obj.env);
  if (transport === "stdio" && !command) return null;
  if (transport === "sse" && !url) return null;
  return {
    name,
    transport,
    command,
    url,
    args,
    cwd,
    env,
    enabled: obj.enabled !== false,
    raw: { ...obj },
  };
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
