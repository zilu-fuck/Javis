#!/usr/bin/env node
/**
 * Bundle hygiene check (G2b).
 *
 * The measured desktop bundle contained the **TypeScript compiler** — 9.2 MB of the
 * ~10 MB `vendor` chunk — because `repo-intelligence-service.ts` imports it statically
 * and `app-runtime.ts` imports that service eagerly. The compiler is a build-time tool;
 * in a browser bundle it is pure weight on every cold start.
 *
 * Fixing that one file is a behavioural change (its four call sites must await a dynamic
 * import), so it is tracked in the roadmap rather than done blindly here. What this check
 * does is stop the problem from *growing*: a new static import of a known build-only or
 * node-only package fails the gate, with the reason and the remedy in the message.
 *
 * Usage: node scripts/check-bundle-hygiene.mjs [--json]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOTS = ["apps/desktop/src", "packages/core/src", "packages/ui/src", "packages/tools/src"];

/**
 * Packages that must never be imported statically into renderer code, with the measured
 * cost where it is known.
 */
const FORBIDDEN_STATIC_IMPORTS = [
  { package: "typescript", megabytes: 9.2, reason: "the TypeScript compiler is a build-time tool" },
  { package: "playwright", megabytes: undefined, reason: "browser automation runs in the sidecar, not the renderer" },
  { package: "playwright-core", megabytes: undefined, reason: "browser automation runs in the sidecar, not the renderer" },
  { package: "node:child_process", megabytes: undefined, reason: "node-only API; the renderer has no child processes" },
  { package: "node:fs", megabytes: undefined, reason: "node-only API; the renderer must use native commands" },
];

/**
 * Known offenders, each with the reason it is tolerated.
 *
 * The list is expected to shrink to empty; adding a new entry means accepting the weight.
 */
const ALLOWED = [
  {
    file: "apps/desktop/src/repo-intelligence-service.ts",
    package: "typescript",
    because: "AST analysis needs the compiler, and the module is reached only through a "
      + "dynamic import in app-runtime.ts with its own chunk (vendor-typescript), so the "
      + "compiler loads on demand rather than at startup. Measured: the eager vendor chunk "
      + "fell from 4,309 kB to 711 kB. If app-runtime.ts ever imports this service "
      + "statically again, the compiler returns to the initial bundle.",
  },
];

const IMPORT_PATTERN = /^\s*import\s[^;]*?from\s*["']([^"']+)["']/gmu;
const BARE_IMPORT_PATTERN = /^\s*import\s*["']([^"']+)["']/gmu;

function listSourceFiles() {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "target") continue;
        walk(full);
        continue;
      }
      if (/\.(ts|tsx)$/u.test(entry.name) && !/\.test\./u.test(entry.name)) {
        files.push(full);
      }
    }
  };
  for (const root of SOURCE_ROOTS) {
    const full = path.join(repoRoot, root);
    if (fs.existsSync(full)) walk(full);
  }
  return files;
}

const findings = [];
for (const file of listSourceFiles()) {
  const relative = path.relative(repoRoot, file).replace(/\\/gu, "/");
  const text = fs.readFileSync(file, "utf8");
  const imports = [
    ...text.matchAll(IMPORT_PATTERN),
    ...text.matchAll(BARE_IMPORT_PATTERN),
  ].map((match) => match[1]);

  for (const forbidden of FORBIDDEN_STATIC_IMPORTS) {
    if (!imports.includes(forbidden.package)) continue;
    const allowed = ALLOWED.find(
      (entry) => entry.file === relative && entry.package === forbidden.package,
    );
    if (allowed) {
      findings.push({ severity: "warning", file: relative, ...forbidden, because: allowed.because });
      continue;
    }
    findings.push({ severity: "error", file: relative, ...forbidden });
  }
}

const errors = findings.filter((finding) => finding.severity === "error");
const warnings = findings.filter((finding) => finding.severity === "warning");

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ findings }, null, 2));
} else {
  for (const warning of warnings) {
    const size = warning.megabytes ? ` (~${warning.megabytes} MB in the bundle)` : "";
    console.log(`WARN  ${warning.file} imports "${warning.package}" statically${size}.`);
    console.log(`      ${warning.because}`);
  }
  for (const error of errors) {
    const size = error.megabytes ? ` (~${error.megabytes} MB)` : "";
    console.log(`ERROR ${error.file} imports "${error.package}" statically${size}: ${error.reason}.`);
    console.log("      Import it dynamically at the point of use, or move the work out of the renderer.");
  }
  console.log(`bundle-hygiene: ${errors.length} error(s), ${warnings.length} known offender(s)`);
}

process.exit(errors.length > 0 ? 1 : 0);
