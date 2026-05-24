import { describe, expect, it } from "vitest";
import { parseGitStatusFiles } from "./git-status";

describe("parseGitStatusFiles", () => {
  it("parses modified, untracked, and paths with spaces", () => {
    expect(
      parseGitStatusFiles([
        " M packages/core/src/index.ts",
        " M src/message.txt",
        "?? docs/product notes.md",
      ].join("\n")),
    ).toEqual(["packages/core/src/index.ts", "src/message.txt", "docs/product notes.md"]);
  });

  it("uses rename and copy targets for approval paths", () => {
    expect(
      parseGitStatusFiles([
        "R  old name.ts -> new name.ts",
        "C  source.ts -> copied target.ts",
      ].join("\n")),
    ).toEqual(["new name.ts", "copied target.ts"]);
  });

  it("unquotes quoted git paths and removes duplicates", () => {
    expect(
      parseGitStatusFiles([
        ' M "docs/quoted path.md"',
        ' M "docs/quoted path.md"',
        ' M "docs/has \\"quote\\".md"',
      ].join("\n")),
    ).toEqual(["docs/quoted path.md", 'docs/has "quote".md']);
  });
});
