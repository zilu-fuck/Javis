/**
 * Tests for the documentation drift helpers (G3).
 *
 * The point of the checker is to fail on a claim that is *factually wrong*, so these
 * tests cover both directions: real drift is caught, and legitimate prose is not
 * turned into noise.
 *
 * Run: node --test scripts/test-doc-drift.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  ERROR,
  WARNING,
  checkDocDrift,
  extractAgentKindLists,
  extractDatedSections,
  extractLineCountClaims,
  extractPnpmScripts,
  parseAgentKindAliases,
  parseAgentKindUnion,
} from "./docs/lib/doc-drift.mjs";

test("extractPnpmScripts ignores pnpm's own subcommands and flag forms", () => {
  const text = [
    "pnpm install --frozen-lockfile",
    "`pnpm check` and `pnpm rust:test`",
    "pnpm --filter @javis/core test",
    "pnpm -r typecheck",
    "`pnpm exec vitest run`",
  ].join("\n");
  assert.deepEqual(extractPnpmScripts(text), ["check", "rust:test"]);
});

test("extractAgentKindLists reads the piped backtick form only", () => {
  const lists = extractAgentKindLists("`commander | file | shell`\n\n`single`\n\n`a | b`");
  assert.equal(lists.length, 2);
  assert.deepEqual(lists[0].kinds, ["commander", "file", "shell"]);
  assert.deepEqual(lists[1].kinds, ["a", "b"]);
});

test("parseAgentKindUnion reads the declared union", () => {
  const source = 'export type AgentKind =\n  | "commander"\n  | "page-agent"\n  | "vision";\n\nexport type Other = 1;';
  assert.deepEqual(parseAgentKindUnion(source), ["commander", "page-agent", "vision"]);
  assert.deepEqual(parseAgentKindUnion("no union here"), []);
});

test("parseAgentKindAliases reads the legacy map", () => {
  const source = `const AGENT_KIND_ALIASES: Record<string, string> = {
  browser: "page-agent",
  "chinese-reviewer": "language-reviewer",
};`;
  assert.deepEqual(parseAgentKindAliases(source), {
    browser: "page-agent",
    "chinese-reviewer": "language-reviewer",
  });
});

test("extractLineCountClaims reads the documented size claims", () => {
  const claims = extractLineCountClaims(
    "`packages/core/src/workflow-executor.ts` is ~6,821 lines; `apps/desktop/src/App.tsx` is ~5,685 lines.",
  );
  assert.equal(claims.length, 2);
  assert.deepEqual(claims[0], {
    file: "packages/core/src/workflow-executor.ts",
    claimedLines: 6821,
    raw: "`packages/core/src/workflow-executor.ts` is ~6,821 lines",
  });
  assert.equal(claims[1].claimedLines, 5685);
});

test("extractDatedSections reads level-2 or deeper headings with a date", () => {
  const sections = extractDatedSections("# Title\n\n## Current State (2026-06-14)\n\n### Sub (2026-01-01)\n");
  assert.deepEqual(sections, [
    { title: "Current State", date: "2026-06-14" },
    { title: "Sub", date: "2026-01-01" },
  ]);
});

function check(documents, overrides = {}) {
  return checkDocDrift({
    documents,
    packageScripts: { check: "x", test: "y" },
    agentKinds: ["commander", "language-reviewer"],
    agentKindAliases: { "chinese-reviewer": "language-reviewer", browser: "page-agent" },
    now: "2026-09-13",
    ...overrides,
  });
}

test("flags a pnpm script that does not exist", () => {
  const result = check([{ path: "AGENTS.md", text: "Run `pnpm verify-all` before committing." }]);
  assert.equal(result.errors, 1);
  assert.match(result.issues[0].message, /not a script in package.json/);
});

test("flags an unknown agent kind as an error and a legacy one as a warning", () => {
  const result = check([{
    path: "CLAUDE.md",
    text: "`commander | chinese-reviewer | not-a-kind`",
  }]);
  assert.equal(result.errors, 1);
  assert.equal(result.warnings, 1);
  const messages = result.issues.map((issue) => `${issue.severity}:${issue.message}`).join(" | ");
  assert.match(messages, /error:lists agent kind "not-a-kind"/);
  assert.match(messages, /warning:lists the legacy agent kind "chinese-reviewer"/);
});

test("flags a line-count claim that drifted beyond tolerance, and only then", () => {
  const text = "`packages/core/src/workflow-executor.ts` is ~1,000 lines.";
  const close = check([{ path: "CLAUDE.md", text }], {
    lineCounts: { "packages/core/src/workflow-executor.ts": 1_100 },
  });
  assert.equal(close.issues.length, 0);

  const drifted = check([{ path: "CLAUDE.md", text }], {
    lineCounts: { "packages/core/src/workflow-executor.ts": 2_000 },
  });
  assert.equal(drifted.warnings, 1);
  assert.match(drifted.issues[0].message, /claims .* ~1000 lines; it is 2000/u);
});

test("flags a status section that is behind HEAD", () => {
  const result = check([{ path: "CLAUDE.md", text: "## Current State (2026-06-14)\n" }], {
    headDate: "2026-09-12",
    staleAfterDays: 45,
  });
  assert.equal(result.warnings, 1);
  assert.match(result.issues[0].message, /90 days behind HEAD/);
});

test("does not treat a release heading or a historical section as stale", () => {
  // A version stamp and an explicitly historical note are supposed to be old;
  // only a *status* claim is expected to be current.
  const result = check([{
    path: "CHANGELOG.md",
    text: "## 0.1.0 (2026-05-28)\n\n## Historical State (2026-06-05)\n",
  }], { headDate: "2026-09-12" });
  assert.equal(result.issues.length, 0);
});

test("accepts a fresh section", () => {
  const result = check([{ path: "CLAUDE.md", text: "## Current State (2026-09-01)\n" }], {
    headDate: "2026-09-12",
  });
  assert.equal(result.issues.length, 0);
});

test("flags a date stamped in the future as an error", () => {
  const result = check([{ path: "CLAUDE.md", text: "## Current State (2027-01-01)\n" }]);
  assert.equal(result.errors, 1);
  assert.match(result.issues[0].message, /stamped in the future/);
});

test("skips freshness checks when git is unavailable rather than guessing", () => {
  const result = check([{ path: "CLAUDE.md", text: "## Current State (2020-01-01)\n" }], {
    headDate: undefined,
  });
  assert.equal(result.issues.length, 0);
});

test("does not treat ordinary prose as a claim", () => {
  const result = check([{
    path: "README.md",
    text: [
      "Use pnpm install, then start the app.",
      "The `packages/core` package holds pure logic.",
      "Agent kinds include commander and verifier.",
      "This file has many lines of documentation.",
    ].join("\n\n"),
  }]);
  assert.equal(result.issues.length, 0);
});

test("reports the severity constants it uses", () => {
  assert.equal(ERROR, "error");
  assert.equal(WARNING, "warning");
});
