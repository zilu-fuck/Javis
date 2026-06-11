import { describe, expect, it } from "vitest";
import { decodeMcpToolServerName, encodeMcpToolServerName } from "./mcp-tool-names";

describe("MCP tool server names", () => {
  it("keeps already-safe server names readable", () => {
    expect(encodeMcpToolServerName("filesystem")).toBe("filesystem");
    expect(decodeMcpToolServerName("filesystem")).toBe("filesystem");
  });

  it("round-trips server names that are not valid tool-name segments", () => {
    const original = "@scope/filesystem server";
    const encoded = encodeMcpToolServerName(original);

    expect(encoded).toMatch(/^u_[A-Za-z0-9_-]+$/);
    expect(decodeMcpToolServerName(encoded)).toBe(original);
  });

  it("encodes safe names that would otherwise collide with the encoded prefix", () => {
    const original = "u_filesystem";
    const encoded = encodeMcpToolServerName(original);

    expect(encoded).not.toBe(original);
    expect(decodeMcpToolServerName(encoded)).toBe(original);
  });
});
