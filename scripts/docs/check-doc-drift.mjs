#!/usr/bin/env node
/**
 * Documentation drift check (G3).
 *
 * Verifies the mechanical claims in the repository's own documentation against the
 * repository, and exits non-zero on any claim that is factually wrong (an unknown
 * agent kind, a `pnpm` script that does not exist, a date stamped in the future).
 * Staleness — an old status section, a drifted line count — is reported as a warning
 * so it is visible without blocking work.
 *
 * Usage:
 *   node scripts/docs/check-doc-drift.mjs [--json] [--strict]
 *   --strict also fails on warnings (use in a release gate, not in CI on every push)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  ERROR,
  checkDocDrift,
  parseAgentKindAliases,
  parseAgentKindUnion,
} from "./lib/doc-drift.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const strict = args.includes("--strict");

/** Documents whose claims are checked. */
const DOCUMENTED_FILES = ["AGENTS.md", "CLAUDE.md", "README.md", "CHANGELOG.md"];

function readIfPresent(relativePath) {
  const full = path.join(repoRoot, relativePath);
  return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : undefined;
}

function readHeadDate() {
  for (const executable of ["git", "C:/Program Files/Git/cmd/git.exe"]) {
    try {
      const iso = execFileSync(executable, ["-C", repoRoot, "log", "-1", "--format=%cI"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (iso.length >= 10) {
        return iso.slice(0, 10);
      }
    } catch {
      // git is unavailable: freshness checks are skipped rather than guessed.
    }
  }
  return undefined;
}

const documents = [];
for (const relativePath of DOCUMENTED_FILES) {
  const text = readIfPresent(relativePath);
  if (text !== undefined) {
    documents.push({ path: relativePath, text });
  }
}

const packageJson = JSON.parse(readIfPresent("package.json") ?? "{}");
const indexSource = readIfPresent("packages/core/src/index.ts") ?? "";
const agentsSource = readIfPresent("packages/core/src/agents.ts") ?? "";
const agentKinds = parseAgentKindUnion(indexSource);
const agentKindAliases = parseAgentKindAliases(agentsSource);

if (agentKinds.length === 0) {
  console.error("doc-drift: could not read the AgentKind union; refusing to report a false pass.");
  process.exit(1);
}

// Line counts come from the claim itself, resolved against the repository root.
const claimedFiles = new Set();
for (const doc of documents) {
  for (const match of doc.text.matchAll(/`([\w./@-]+\.(?:ts|tsx|rs))`[^.\n]{0,40}?~?[\d,]{2,}\s*lines/gu)) {
    claimedFiles.add(match[1]);
  }
}
const lineCounts = {};
for (const relativePath of claimedFiles) {
  const full = path.join(repoRoot, relativePath);
  if (!fs.existsSync(full)) continue;
  lineCounts[relativePath] = fs.readFileSync(full, "utf8").split(/\r?\n/u).length;
}

const headDate = readHeadDate();
const result = checkDocDrift({
  documents,
  packageScripts: packageJson.scripts ?? {},
  agentKinds,
  agentKindAliases,
  lineCounts,
  ...(headDate ? { headDate } : {}),
});

if (asJson) {
  console.log(JSON.stringify({ headDate, agentKinds, ...result }, null, 2));
} else {
  console.log(`doc-drift: ${documents.length} documents, ${agentKinds.length} declared agent kinds`
    + `${headDate ? `, HEAD ${headDate}` : ", HEAD date unavailable"}`);
  if (result.issues.length === 0) {
    console.log("doc-drift: no drift detected.");
  }
  for (const issue of result.issues) {
    const tag = issue.severity === ERROR ? "ERROR" : "WARN ";
    console.log(`  ${tag} ${issue.doc}: ${issue.message}`);
  }
  console.log(`doc-drift: ${result.errors} error(s), ${result.warnings} warning(s)`);
}

const failed = result.errors > 0 || (strict && result.warnings > 0);
process.exit(failed ? 1 : 0);
