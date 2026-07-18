import { describe, expect, it } from "vitest";
import appSource from "./App.tsx?raw";

describe("MCP tool execution contract", () => {
  it("rebuilds the execution allowlist from a live manifest", () => {
    expect(appSource).toContain("Persistent descriptors are planning hints only");
    expect(appSource).toContain("const listToolsResult = await invoke<unknown>(\"call_mcp_server_tool\"");
    expect(appSource).toContain("const liveDescriptors = buildMcpToolDescriptorsFromList(server, listToolsResult)");
    expect(appSource).toContain("isAllowlistedMcpCallToolRequest(liveDescriptors, boundRequest)");
  });
});
