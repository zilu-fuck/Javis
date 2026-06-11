#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const scriptPath = resolve(repoRoot, "docs", "qa", "2026-06-10", "trend-hot-list", "trend-hot-list-release-qa.ps1");

async function main() {
  const root = await mkdtemp(join(tmpdir(), "javis-trend-hot-list-qa-"));
  try {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "38-trend-hot-list-report.png"), "png placeholder");
    await writeFile(
      join(root, "trend-hot-list-manual-qa-evidence.md"),
      [
        "# Manual evidence",
        "Date: 2026-06-10",
        "Operator: qa",
        "Build: 0.1.0",
        "Provider: example-provider",
        "Source URL: https://example.test/hot-list",
        "Result: PASS",
        "Artifacts: 38-trend-hot-list-report.png, trend-hot-list-live-qa-output.txt",
        "- TREND-QA-01: PASS",
        "- TREND-QA-02: PASS",
        "- TREND-QA-03: PASS",
        "- TREND-QA-04: PASS",
      ].join("\n"),
    );

    const result = await runPowerShell([
      "-Provider", "example-provider",
      "-RequestedCount", "20",
      "-ItemCount", "20",
      "-SourceUrl", "https://example.test/hot-list",
      "-QaRoot", root,
    ]);
    assert(result.code === 0, `trend hot-list QA helper should pass\n${result.stdout}\n${result.stderr}`);

    const output = JSON.parse(await readFile(join(root, "trend-hot-list-live-qa-output.txt"), "utf8"));
    assert(output.PackagedApp === true, "output should record packaged app context");
    assert(typeof output.AppVersion === "string" && output.AppVersion.length > 0, "output should record app version");
    assert(output.QaDate === "2026-06-10" || /^\d{4}-\d{2}-\d{2}$/.test(output.QaDate), "output should record concrete QA date");
    assert(output.toolName === "trend.fetchHotList", "output should record trend tool name");
    assert(output.Provider === "example-provider", "output should record provider");
    assert(output.RequestedCount === 20, "output should record requested count");
    assert(output.ItemCount === 20, "output should record item count");
    assert(output.SourceUrl === "https://example.test/hot-list", "output should record source URL");
    assert(output.Artifacts.includes("38-trend-hot-list-report.png"), "output should reference report screenshot");
    assert(output.Artifacts.includes("trend-hot-list-manual-qa-evidence.md"), "output should reference manual evidence");
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  process.stdout.write("Trend hot-list release QA helper test passed\n");
}

function runPowerShell(args) {
  return new Promise((resolvePromise) => {
    const child = spawn("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      ...args,
    ], { cwd: repoRoot });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
