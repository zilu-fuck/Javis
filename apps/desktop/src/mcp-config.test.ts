import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { loadMcpConfig, parseMcpConfigText, saveMcpConfig } from "./mcp-config";

describe("mcp config", () => {
  it("parses standard mcpServers object configs", () => {
    const config = parseMcpConfigText(JSON.stringify({
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem"],
        },
        docs: {
          transport: "sse",
          url: "http://localhost:3000/sse",
          enabled: false,
        },
      },
    }));

    expect(config).toEqual([
      {
        name: "filesystem",
        transport: "stdio",
        command: "npx",
        url: undefined,
        args: ["-y", "@modelcontextprotocol/server-filesystem"],
        cwd: undefined,
        env: undefined,
        enabled: true,
        raw: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem"],
        },
      },
      {
        name: "docs",
        transport: "sse",
        command: undefined,
        url: "http://localhost:3000/sse",
        args: undefined,
        cwd: undefined,
        env: undefined,
        enabled: false,
        raw: {
          transport: "sse",
          url: "http://localhost:3000/sse",
          enabled: false,
        },
      },
    ]);
  });

  it("keeps mcpServers shape when saving a loaded object config", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(JSON.stringify({
      mcpServers: {
        filesystem: {
          command: "npx",
          env: { ROOT: "E:/Javis" },
          cwd: "E:/Javis",
        },
      },
    }));

    const config = await loadMcpConfig();
    expect(config[0]).toEqual(expect.objectContaining({
      cwd: "E:/Javis",
      env: { ROOT: "E:/Javis" },
    }));
    await saveMcpConfig(config.map((server) => ({ ...server, enabled: false })));

    expect(invoke).toHaveBeenLastCalledWith("write_mcp_config", {
      json: JSON.stringify({
        mcpServers: {
          filesystem: {
            command: "npx",
            env: { ROOT: "E:/Javis" },
            cwd: "E:/Javis",
            transport: "stdio",
            url: undefined,
            args: undefined,
            enabled: false,
          },
        },
      }, null, 2),
    });
  });

  it("does not expose raw metadata when saving array configs", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(JSON.stringify([
      {
        name: "filesystem",
        transport: "stdio",
        command: "npx",
        enabled: true,
      },
    ]));

    const config = await loadMcpConfig();
    await saveMcpConfig(config);

    expect(invoke).toHaveBeenLastCalledWith("write_mcp_config", {
      json: JSON.stringify([
        {
          name: "filesystem",
          transport: "stdio",
          command: "npx",
          enabled: true,
        },
      ], null, 2),
    });
  });

  it("filters array stdio servers without commands", () => {
    const config = parseMcpConfigText(JSON.stringify([
      {
        name: "missing-command",
        transport: "stdio",
        enabled: true,
      },
      {
        name: "filesystem",
        transport: "stdio",
        command: "npx",
        enabled: true,
      },
    ]));

    expect(config.map((server) => server.name)).toEqual(["filesystem"]);
  });
});
