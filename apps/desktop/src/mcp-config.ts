import { invoke } from "@tauri-apps/api/core";

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "sse";
  command?: string;
  url?: string;
  args?: string[];
  enabled: boolean;
}

export async function loadMcpConfig(): Promise<McpServerConfig[]> {
  const result = await invoke<string | null>("read_mcp_config");
  if (!result) return [];
  const parsed: unknown = JSON.parse(result);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isMcpServerConfig);
}

export async function saveMcpConfig(config: McpServerConfig[]): Promise<void> {
  await invoke("write_mcp_config", { json: JSON.stringify(config, null, 2) });
}

function isMcpServerConfig(value: unknown): value is McpServerConfig {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.name === "string" &&
    (obj.transport === "stdio" || obj.transport === "sse") &&
    typeof obj.enabled === "boolean"
  );
}
