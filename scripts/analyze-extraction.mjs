#!/usr/bin/env node
/**
 * Transitive extraction analysis for the monolith files.
 *
 * The first version of this script counted only identifiers that *looked like calls* to
 * other declarations in the same file. That under-counted, and the under-count cost a real
 * extraction attempt: moving the `execute*DagStep` family produced 50 type errors because
 * the closure also needed private **constants** (`FILE_WRITE_TEXT_CONTENT_KEYS`), private
 * **helpers** (`isPlainRecord`) and **type-only imports** (`SharedTaskContext`).
 *
 * This version computes the closure properly:
 *
 *  * every top-level declaration is catalogued (functions, constants, types, enums);
 *  * comments and string literals are stripped before scanning, so a name mentioned in
 *    prose does not inflate the dependency set and a name used only in a string does not
 *    hide behind one;
 *  * the closure is iterated to a fixpoint, which is what "what must move together" means;
 *  * imports the moved code needs are reported per specifier, so the new module's imports
 *    can be written correctly the first time.
 *
 * Usage: node scripts/analyze-extraction.mjs [file] [--function NAME] [--top 12]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const target = args.find((argument) => !argument.startsWith("--"))
  ?? "packages/core/src/workflow-executor.ts";
const functionIndex = args.indexOf("--function");
const requestedFunction = functionIndex >= 0 ? args[functionIndex + 1] : undefined;
const topIndex = args.indexOf("--top");
const top = topIndex >= 0 ? Number(args[topIndex + 1]) : 12;

const full = path.join(repoRoot, target);
const source = fs.readFileSync(full, "utf8");
const lines = source.split(/\r?\n/u);

/** Removes comments and string literals so identifier scans see only code. */
function stripNonCode(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/\/\/[^\n]*/gu, " ")
    .replace(/"(?:[^"\\]|\\.)*"/gu, '""')
    .replace(/'(?:[^'\\]|\\.)*'/gu, "''")
    .replace(/`(?:[^`\\]|\\.)*`/gu, "``");
}

/** Catalogue of top-level declarations, with the span each occupies. */
const declarations = new Map();
{
  let depth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (depth === 0) {
      const match = /^(?:export )?(?:async )?function ([A-Za-z0-9_]+)/u.exec(line)
        ?? /^(?:export )?const ([A-Za-z0-9_]+)\s*[=:]/u.exec(line)
        ?? /^(?:export )?(?:type|interface|enum) ([A-Za-z0-9_]+)/u.exec(line);
      if (match && !declarations.has(match[1])) {
        declarations.set(match[1], { name: match[1], start: index });
      }
    }
    depth += (line.match(/\{/gu)?.length ?? 0) - (line.match(/\}/gu)?.length ?? 0);
    if (depth < 0) depth = 0;
  }
}

/** Assign each declaration the span up to the next declaration that starts deeper. */
const spans = [...declarations.values()].sort((left, right) => left.start - right.start);
for (let index = 0; index < spans.length; index += 1) {
  const next = spans[index + 1];
  spans[index].end = next && next.start > spans[index].start ? next.start - 1 : lines.length - 1;
}
const byStart = spans;
const spanByName = new Map(spans.map((span) => [span.name, span]));

/** Imported names, so the new module can be given exactly the imports it uses. */
const importNames = new Map();
for (const match of source.matchAll(/^import (?:type )?\{([\s\S]*?)\} from "([^"]+)";$/gmu)) {
  const specifier = match[2];
  for (const entry of match[1].split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const name = trimmed.split(/\s+as\s+/u).pop().trim();
    if (name) importNames.set(name, specifier);
  }
}

function bodyOf(span) {
  return stripNonCode(lines.slice(span.start, span.end + 1).join("\n"));
}

/**
 * The declarations and imports a starting declaration actually needs, to a fixpoint.
 */
function closureOf(rootName) {
  const root = spanByName.get(rootName);
  if (!root) return undefined;

  const needed = new Set([rootName]);
  const importsUsed = new Set();
  let frontier = [rootName];
  while (frontier.length > 0) {
    const next = [];
    for (const name of frontier) {
      const span = spanByName.get(name);
      if (!span) continue;
      const body = bodyOf(span);
      for (const match of body.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\b/gu)) {
        const token = match[1];
        if (token === name) continue;
        if (spanByName.has(token) && !needed.has(token)) {
          needed.add(token);
          next.push(token);
          continue;
        }
        if (importNames.has(token)) {
          importsUsed.add(token);
        }
      }
    }
    frontier = next;
  }

  const moving = [...needed]
    .map((name) => spanByName.get(name))
    .filter(Boolean)
    .sort((left, right) => left.start - right.start);
  return {
    name: rootName,
    moving,
    linesToMove: moving.reduce((sum, span) => sum + (span.end - span.start + 1), 0),
    importsBySpecifier: [...new Set([...importsUsed].map((name) => importNames.get(name)))].sort(),
    imports: [...importsUsed].sort(),
  };
}

if (requestedFunction) {
  const result = closureOf(requestedFunction);
  if (!result) {
    console.error(`no top-level declaration named ${requestedFunction} in ${target}`);
    process.exit(1);
  }
  console.log(`closure of ${result.name}: ${result.moving.length} declarations, ${result.linesToMove} lines\n`);
  for (const span of result.moving) {
    console.log(`  ${String(span.end - span.start + 1).padStart(5)} lines  ${span.name}`);
  }
  console.log(`\nimports needed (${result.imports.length} names):`);
  for (const entry of result.importsBySpecifier) {
    const names = result.imports.filter((name) => importNames.get(name) === entry);
    console.log(`  ${entry}\n    ${names.join(", ")}`);
  }
  process.exit(0);
}

/** Rank every sizeable declaration by lines-to-move per declaration in its closure. */
const ranked = [];
for (const span of byStart) {
  const size = span.end - span.start + 1;
  if (size < 120) continue;
  const closure = closureOf(span.name);
  if (!closure) continue;
  ranked.push({ ...closure, ownLines: size, declarationCount: closure.moving.length });
}

ranked.sort((left, right) => right.linesToMove - left.linesToMove);
console.log(`${target}: ${byStart.length} top-level declarations, ${lines.length} lines\n`);
console.log("largest transitive closures (what must move together):\n");
for (const entry of ranked.slice(0, top)) {
  console.log(`${String(entry.linesToMove).padStart(6)} lines to move  ${entry.name}`
    + ` (${entry.declarationCount} declarations, own size ${entry.ownLines})`);
}

const cleanest = [...ranked]
  .filter((entry) => entry.ownLines >= 150)
  .sort((left, right) => (left.declarationCount - right.declarationCount)
    || (right.ownLines - left.ownLines));
console.log("\ncleanest seams (fewest declarations to move with it):");
for (const entry of cleanest.slice(0, 8)) {
  console.log(`  ${String(entry.declarationCount).padStart(3)} decls, ${String(entry.linesToMove).padStart(5)} lines  ${entry.name}`);
}
