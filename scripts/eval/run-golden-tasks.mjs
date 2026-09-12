#!/usr/bin/env node
/**
 * Golden-task eval runner (F1) — the headless scoring entry point.
 *
 * Runs the deterministic golden-task suite through Vitest's JSON reporter and
 * writes a scorecard to docs/qa/eval/<date>/. Exits non-zero when any golden task
 * fails, so it can gate a release the same way `pnpm check` does.
 *
 * Usage:
 *   node scripts/eval/run-golden-tasks.mjs [--no-write]
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const writeScorecard = !process.argv.includes("--no-write");
const evalTestPath = "src/eval/golden-tasks.test.ts";
const metaTestTitle = "covers every golden category with a usable plan or goal shape";

const jsonOut = path.join(os.tmpdir(), `javis-eval-${process.pid}.json`);
const command = process.platform === "win32" ? "corepack.cmd" : "corepack";

const run = spawnSync(
  command,
  [
    "pnpm",
    "--filter",
    "@javis/core",
    "exec",
    "vitest",
    "run",
    evalTestPath,
    "--reporter=json",
    `--outputFile=${jsonOut}`,
  ],
  { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" },
);

if (!fs.existsSync(jsonOut)) {
  console.error("eval: Vitest did not produce a JSON report; cannot score.");
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(jsonOut, "utf8"));
fs.rmSync(jsonOut, { force: true });

const assertions = (raw.testResults ?? []).flatMap((file) =>
  (file.assertionResults ?? []).map((assertion) => ({
    title: assertion.title ?? assertion.fullName ?? "unknown",
    status: assertion.status,
    durationMs: assertion.duration ?? 0,
    failureMessages: assertion.failureMessages ?? [],
  })),
);

const golden = assertions.filter((assertion) => assertion.title !== metaTestTitle);
const meta = assertions.filter((assertion) => assertion.title === metaTestTitle);

function categoryOf(id) {
  if (id.startsWith("routing-")) return "routing";
  if (id.startsWith("write-intent-")) return "write-intent";
  if (id.startsWith("plan-legality-")) return "plan-legality";
  return "other";
}

const byCategory = new Map();
for (const assertion of golden) {
  const category = categoryOf(assertion.title);
  const bucket = byCategory.get(category) ?? { total: 0, passed: 0, failed: 0 };
  bucket.total += 1;
  if (assertion.status === "passed") bucket.passed += 1;
  else bucket.failed += 1;
  byCategory.set(category, bucket);
}

const passed = golden.filter((assertion) => assertion.status === "passed").length;
const failed = golden.length - passed;
const successRate = golden.length === 0 ? 0 : passed / golden.length;
const totalMs = golden.reduce((sum, assertion) => sum + assertion.durationMs, 0);

const scorecard = {
  generatedAt: new Date().toISOString(),
  suite: "golden-tasks",
  node: process.version,
  platform: `${os.platform()}-${os.arch()}`,
  totals: {
    tasks: golden.length,
    passed,
    failed,
    successRate: Number(successRate.toFixed(4)),
    durationMs: Math.round(totalMs),
    coverageSelfCheck: meta[0]?.status ?? "missing",
  },
  byCategory: Object.fromEntries([...byCategory.entries()].sort()),
  failures: golden
    .filter((assertion) => assertion.status !== "passed")
    .map((assertion) => ({
      id: assertion.title,
      category: categoryOf(assertion.title),
      message: (assertion.failureMessages[0] ?? "").split("\n").slice(0, 8).join("\n"),
    })),
};

const lines = [
  "# Golden task scorecard",
  "",
  `- generated: ${scorecard.generatedAt}`,
  `- tasks: **${golden.length}** · passed **${passed}** · failed **${failed}** · success rate **${(successRate * 100).toFixed(1)}%**`,
  `- duration: ${Math.round(totalMs)} ms`,
  `- coverage self-check: ${scorecard.totals.coverageSelfCheck}`,
  "",
  "| category | total | passed | failed |",
  "| --- | --- | --- | --- |",
  ...[...byCategory.entries()]
    .sort()
    .map(([category, bucket]) => `| ${category} | ${bucket.total} | ${bucket.passed} | ${bucket.failed} |`),
];

if (scorecard.failures.length > 0) {
  lines.push("", "## Failures", "");
  for (const failure of scorecard.failures) {
    lines.push(`### ${failure.id} (${failure.category})`, "", "```", failure.message, "```", "");
  }
}

if (writeScorecard) {
  const date = new Date().toISOString().slice(0, 10);
  const dir = path.join(repoRoot, "docs", "qa", "eval", date);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "scorecard.json"), `${JSON.stringify(scorecard, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(dir, "scorecard.md"), `${lines.join("\n")}\n`, "utf8");
  console.log(`\neval: scorecard written to docs/qa/eval/${date}/`);
}

console.log(`\neval: ${passed}/${golden.length} golden tasks passed (${(successRate * 100).toFixed(1)}%)`);
for (const failure of scorecard.failures) {
  console.log(`  FAIL ${failure.id}`);
  console.log(`       ${failure.message.split("\n").slice(0, 3).join(" | ")}`);
}

const exitCode = run.status === 0 && failed === 0 && meta[0]?.status === "passed" ? 0 : 1;
process.exit(exitCode);
