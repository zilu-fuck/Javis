#!/usr/bin/env node
/**
 * Extraction-candidate analysis for the monolith files.
 *
 * Moving a function out of a 15,000-line module is only safe if it does not depend on a
 * web of that module's private helpers. Guessing "this looks self-contained" is how a
 * refactor turns into a rewrite, so this measures it: for each large top-level function,
 * count the identifiers it uses that are **declared elsewhere in the same file**.
 *
 * A low count means a clean seam. A high count means the seam is real but the helpers come
 * with it.
 *
 * Usage: node scripts/analyze-extraction.mjs [file] [--top 12]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const target = args.find((argument) => !argument.startsWith("--"))
  ?? "packages/core/src/workflow-executor.ts";
const topIndex = args.indexOf("--top");
const top = topIndex >= 0 ? Number(args[topIndex + 1]) : 12;

const full = path.join(repoRoot, target);
const lines = fs.readFileSync(full, "utf8").split(/\r?\n/u);

/** Top-level declarations, so a function's body can be isolated. */
const declarations = [];
let depth = 0;
for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index];
  const match = /^(?:export )?(?:async )?function ([A-Za-z0-9_]+)/u.exec(line)
    ?? /^(?:export )?const ([A-Za-z0-9_]+)\s*[=:]/u.exec(line);
  if (match && depth === 0) {
    declarations.push({ name: match[1], line: index + 1, kind: "decl" });
  }
  // Track brace depth crudely; good enough to find top-level starts.
  depth += (line.match(/\{/gu)?.length ?? 0) - (line.match(/\}/gu)?.length ?? 0);
  if (depth < 0) depth = 0;
}

const spans = [];
for (let index = 0; index < declarations.length; index += 1) {
  const start = declarations[index].line;
  const end = declarations[index + 1]?.line ?? lines.length + 1;
  spans.push({ name: declarations[index].name, start, end, size: end - start });
}

/** Names declared at the top level of this file, so a body's use of them can be counted. */
const moduleNames = new Set(declarations.map((declaration) => declaration.name));

const report = [];
for (const span of spans) {
  if (span.size < 120) continue;
  const body = lines.slice(span.start - 1, span.end - 1).join("\n");
  // Identifiers used in the body that this module declares elsewhere (excluding itself).
  const used = new Set();
  for (const match of body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/gu)) {
    const name = match[1];
    if (name !== span.name && moduleNames.has(name)) used.add(name);
  }
  for (const match of body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/gu)) {
    const name = match[1];
    if (name !== span.name && moduleNames.has(name)) used.add(name);
  }
  report.push({ ...span, dependencies: [...used].sort() });
}

report.sort((left, right) => right.size - left.size);
console.log(`${target}: ${spans.length} top-level declarations, ${lines.length} lines\n`);
console.log("largest functions, with their private-module dependencies:\n");
for (const entry of report.slice(0, top)) {
  console.log(`${String(entry.size).padStart(6)} lines  ${entry.name}`);
  console.log(`                deps: ${entry.dependencies.length}${entry.dependencies.length > 0 ? ` → ${entry.dependencies.slice(0, 12).join(", ")}${entry.dependencies.length > 12 ? ", …" : ""}` : ""}`);
}

// The best seam is the largest function with the fewest dependencies.
const candidates = report
  .filter((entry) => entry.size >= 200)
  .map((entry) => ({ ...entry, ratio: entry.size / Math.max(1, entry.dependencies.length) }))
  .sort((left, right) => right.ratio - left.ratio);
console.log("\nbest extraction candidates (lines per dependency, higher is cleaner):");
for (const entry of candidates.slice(0, 8)) {
  console.log(`  ${entry.ratio.toFixed(0).padStart(5)}  ${entry.name} (${entry.size} lines, ${entry.dependencies.length} deps)`);
}
