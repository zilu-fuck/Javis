import { describe, expect, it } from "vitest";
import {
  canonicalToolNameToModelAlias,
  createToolNameAliasMap,
} from "./tool-name-alias";

describe("tool name aliases", () => {
  it("creates stable provider-safe aliases", () => {
    expect(canonicalToolNameToModelAlias("code.searchRepository"))
      .toBe("code__search_repository");
    expect(canonicalToolNameToModelAlias("file.scanMarkdownDocuments"))
      .toBe("file__scan_markdown_documents");
  });

  it("round trips names through the registered map", () => {
    const aliases = createToolNameAliasMap([
      "code.searchRepository",
      "file.scanMarkdownDocuments",
    ]);
    expect(aliases.toCanonicalName("code__search_repository"))
      .toBe("code.searchRepository");
    expect(aliases.toModelName("file.scanMarkdownDocuments"))
      .toBe("file__scan_markdown_documents");
  });

  it("rejects collisions instead of silently routing to the wrong tool", () => {
    expect(() => createToolNameAliasMap(["code.search-item", "code.search_item"]))
      .toThrow("Tool alias collision");
  });

  it("keeps long MCP names stable and within provider limits", () => {
    const canonicalName = `mcp.filesystem.tool.${"read_deeply_nested_repository_file_".repeat(3)}`;
    const alias = canonicalToolNameToModelAlias(canonicalName);
    expect(alias).toHaveLength(64);
    expect(alias).toMatch(/^[a-z][a-z0-9_]+$/);
    const aliases = createToolNameAliasMap([canonicalName]);
    expect(aliases.toCanonicalName(alias)).toBe(canonicalName);
  });
});
