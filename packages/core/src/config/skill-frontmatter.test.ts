import { describe, expect, it } from "vitest";
import {
  SKILL_LISTING_DESCRIPTION_MAX_CHARS,
  createSkillListing,
  isSkillAutoInvocable,
  parseSkillFrontmatter,
} from "./skill-frontmatter";

const SKILL = `---
name: summarize-changes
description: Summarizes uncommitted changes and flags anything risky. Use when the user asks what changed.
allowed-tools: [shell.runReadOnlyCommand, code.searchRepository]
argument-hint: [issue-number]
---

## Current changes

Run the read-only diff and summarise it.
`;

describe("parseSkillFrontmatter", () => {
  it("parses the documented keys and separates the body", () => {
    const parsed = parseSkillFrontmatter(SKILL);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.frontmatter).toMatchObject({
      name: "summarize-changes",
      description: expect.stringContaining("Summarizes uncommitted changes"),
      allowedTools: ["shell.runReadOnlyCommand", "code.searchRepository"],
      argumentHint: "[issue-number]",
      disableModelInvocation: false,
    });
    expect(parsed.body.startsWith("## Current changes")).toBe(true);
    expect(parsed.body).not.toContain("name: summarize-changes");
  });

  it("reads disable-model-invocation in its several spellings", () => {
    for (const value of ["true", "yes", "1", "TRUE"]) {
      const parsed = parseSkillFrontmatter(`---\ndisable-model-invocation: ${value}\n---\nbody\n`);
      expect(parsed.frontmatter.disableModelInvocation, value).toBe(true);
      expect(isSkillAutoInvocable(parsed.frontmatter)).toBe(false);
    }
    const off = parseSkillFrontmatter("---\ndisable-model-invocation: false\n---\nbody\n");
    expect(isSkillAutoInvocable(off.frontmatter)).toBe(true);
  });

  it("handles block lists as well as inline lists", () => {
    const block = parseSkillFrontmatter(`---
name: a
allowed-tools:
  - file.scanMarkdownDocuments
  - web.search
---
body
`);
    expect(block.frontmatter.allowedTools).toEqual(["file.scanMarkdownDocuments", "web.search"]);
    expect(block.diagnostics).toEqual([]);
  });

  it("strips surrounding quotes and tolerates CRLF", () => {
    const parsed = parseSkillFrontmatter("---\r\nname: \"quoted-name\"\r\ndescription: 'single'\r\n---\r\nbody\r\n");
    expect(parsed.frontmatter.name).toBe("quoted-name");
    expect(parsed.frontmatter.description).toBe("single");
  });

  it("reports a missing or unclosed frontmatter block instead of guessing", () => {
    const none = parseSkillFrontmatter("# Just a body\n");
    expect(none.frontmatter.name).toBeUndefined();
    expect(none.body).toBe("# Just a body\n");
    expect(none.diagnostics[0]).toContain("no frontmatter block");

    const unclosed = parseSkillFrontmatter("---\nname: a\n");
    expect(unclosed.diagnostics[0]).toContain("not closed");
  });

  it("records keys it recognises but does not act on", () => {
    const parsed = parseSkillFrontmatter("---\nname: a\nmodel: opus\n---\nbody\n");
    expect(parsed.frontmatter.unhandledKeys).toEqual(["model"]);
  });

  it("reports a malformed line rather than silently dropping it", () => {
    const parsed = parseSkillFrontmatter("---\nname: a\nthis is not yaml\n---\nbody\n");
    expect(parsed.diagnostics[0]).toContain('not a "key: value" pair');
    expect(parsed.frontmatter.name).toBe("a");
  });

  it("keeps an empty skill body usable", () => {
    const parsed = parseSkillFrontmatter("---\nname: a\n---\n");
    expect(parsed.frontmatter.name).toBe("a");
    expect(parsed.body).toBe("");
  });
});

describe("createSkillListing", () => {
  const entries = [
    { name: "alpha", description: "First skill." },
    { name: "beta", description: "Second skill.", argumentHint: "[file]" },
  ];

  it("lists name, argument hint and description", () => {
    const { listing, included, omitted } = createSkillListing(entries);
    expect(listing).toContain("- alpha: First skill.");
    expect(listing).toContain("- beta (args: [file]): Second skill.");
    expect(included).toEqual(["alpha", "beta"]);
    expect(omitted).toEqual([]);
  });

  it("drops whole entries past the cap instead of truncating one", () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      name: `skill-${index}`,
      description: "x".repeat(80),
    }));
    const { listing, included, omitted } = createSkillListing(many, { maxChars: 400 });
    expect(listing.length).toBeLessThanOrEqual(400);
    expect(omitted.length).toBeGreaterThan(0);
    expect(included.length + omitted.length).toBe(many.length);
    // No half-written entry survives.
    for (const line of listing.split("\n")) {
      expect(line.endsWith("x")).toBe(true);
    }
  });

  it("defaults the cap to the documented listing size", () => {
    expect(SKILL_LISTING_DESCRIPTION_MAX_CHARS).toBe(1_536);
    const many = Array.from({ length: 200 }, (_, index) => ({
      name: `skill-${index}`,
      description: "y".repeat(200),
    }));
    expect(createSkillListing(many).listing.length).toBeLessThanOrEqual(1_536);
  });

  it("collapses whitespace in a description so one skill cannot break the listing", () => {
    const { listing } = createSkillListing([
      { name: "multi", description: "line one\n\n   line two" },
    ]);
    expect(listing).toBe("- multi: line one line two");
  });

  it("handles an entry with no description", () => {
    expect(createSkillListing([{ name: "bare" }]).listing).toBe("- bare:");
  });
});
