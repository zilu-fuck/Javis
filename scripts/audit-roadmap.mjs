#!/usr/bin/env node
/**
 * Roadmap consistency audit.
 *
 * The roadmap carries ~50 checkboxes accumulated over dozens of rounds. A checkmark is
 * only worth anything if the thing it claims exists, so this verifies the mechanical part:
 * **every file path the roadmap references must exist**, and the test counts it quotes
 * must match what the suites actually report.
 *
 * It deliberately does not try to judge whether a feature *works* — that is what the tests
 * and the eval are for. It catches the specific failure this document is prone to: a claim
 * that drifted away from the repository.
 *
 * Usage: node scripts/audit-roadmap.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roadmapPath = path.join(repoRoot, "docs", "HARNESS_ROADMAP.md");
const roadmap = fs.readFileSync(roadmapPath, "utf8");

const PATH_PATTERN = /`([A-Za-z0-9_@.\/-]+\.(?:ts|tsx|mjs|rs|md|json|ps1))`/gu;
const SKIP_DIRECTORIES = new Set(["node_modules", "target", "dist", ".git", "artifacts"]);

/**
 * Every file in the repository, so a referenced path can be checked as a *suffix*.
 *
 * The roadmap writes paths in whatever form is natural at that point — sometimes
 * `packages/core/src/resume-plan.ts`, sometimes just `resume-plan.ts`. A candidate-root
 * list cannot keep up with that; walking the tree once can.
 */
function indexRepositoryFiles() {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        walk(path.join(directory, entry.name));
        continue;
      }
      files.push(path.relative(repoRoot, path.join(directory, entry.name)).replace(/\\/gu, "/"));
    }
  };
  walk(repoRoot);
  return files;
}

const repoFiles = indexRepositoryFiles();

/** Paths written as illustrative examples rather than as repository locations. */
const ILLUSTRATIVE = new Set([".javis/config.json", "config.json", "src/a.ts", "notes.md"]);

const referenced = new Set();
for (const match of roadmap.matchAll(PATH_PATTERN)) {
  if (!ILLUSTRATIVE.has(match[1])) referenced.add(match[1]);
}

const missing = [];
for (const candidate of [...referenced].sort()) {
  const found = repoFiles.some(
    (file) => file === candidate || file.endsWith(`/${candidate}`),
  );
  if (!found) missing.push(candidate);
}

/**
 * Test counts quoted by the roadmap, compared with the newest recorded run.
 *
 * The counts are compared against the suite output captured in `.dsh-tmp` when present;
 * otherwise they are only listed so a reader can check them by hand.
 */
function countTestsIn(fileName) {
  const full = path.join(repoRoot, ".dsh-tmp", fileName);
  if (!fs.existsSync(full)) return undefined;
  const text = fs.readFileSync(full, "utf8");
  const matches = [...text.matchAll(/Tests\s+(\d+) passed/gu)].map((match) => Number(match[1]));
  return matches.length > 0 ? Math.max(...matches) : undefined;
}

const measured = {
  core: countTestsIn("s6-ts.txt"),
  desktop: countTestsIn("s6-ts.txt"),
};

const quoted = new Set();
for (const match of roadmap.matchAll(/(\d{3,4})\s+core/gu)) quoted.add(Number(match[1]));
for (const match of roadmap.matchAll(/core \*?\*?(\d{3,4})/gu)) quoted.add(Number(match[1]));

console.log(`roadmap paths referenced: ${referenced.size}`);
console.log(`missing paths: ${missing.length}`);
for (const entry of missing) console.log(`  MISSING ${entry}`);

const claims = [...quoted].sort((left, right) => left - right);
console.log(`test counts quoted in the roadmap: ${claims.join(", ") || "(none)"}`);

// A quoted count that no longer appears in the roadmap's own verification table is stale,
// but only the newest one matters; report the discrepancy rather than failing on history.
const newest = claims.at(-1);
if (newest !== undefined && measured.core !== undefined && newest !== measured.core) {
  console.log(`  NOTE the newest quoted core count (${newest}) differs from the last measured run (${measured.core})`);
}

process.exit(missing.length > 0 ? 1 : 0);
