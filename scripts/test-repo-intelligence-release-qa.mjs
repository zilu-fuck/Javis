#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const scriptPath = resolve(repoRoot, "docs", "qa", "2026-06-10", "repo-intelligence", "repo-intelligence-release-qa.ps1");

async function main() {
  const root = await mkdtemp(join(tmpdir(), "javis-repo-intelligence-qa-"));
  try {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "42-repo-search-key-files.png"), "png placeholder");
    await writeFile(join(root, "43-repo-trace-symbol-graph.png"), "png placeholder");
    await writeFile(
      join(root, "repo-intelligence-manual-qa-evidence.md"),
      [
        "# Manual evidence",
        "Date: 2026-06-10",
        "Operator: qa",
        "Build: 0.1.0",
        "Workspace: E:\\Javis",
        "Result: PASS",
        "Artifacts: 42-repo-search-key-files.png, 43-repo-trace-symbol-graph.png, repo-intelligence-package-live-qa-output.txt",
        "- REPO-QA-01: PASS",
        "- REPO-QA-02: PASS",
        "- REPO-QA-03: PASS",
        "- REPO-QA-04: PASS",
        "- REPO-QA-05: PASS",
      ].join("\n"),
    );

    const result = await runPowerShell(["-QaRoot", root]);
    assert(result.code === 0, `repo intelligence QA helper should pass\n${result.stdout}\n${result.stderr}`);

    const output = JSON.parse(await readFile(join(root, "repo-intelligence-package-live-qa-output.txt"), "utf8"));
    assert(output.PackagedApp === true, "output should record packaged app context");
    assert(typeof output.AppVersion === "string" && output.AppVersion.length > 0, "output should record app version");
    assert(/^\d{4}-\d{2}-\d{2}$/.test(output.QaDate), "output should record concrete QA date");
    assert(output.Artifacts.includes("42-repo-search-key-files.png"), "output should reference key-files screenshot");
    assert(output.Artifacts.includes("43-repo-trace-symbol-graph.png"), "output should reference symbol-graph screenshot");
    assert(output.keyFiles === "pass", "output should record key files pass");
    assert(output.symbolGraph === "pass", "output should record symbol graph pass");
    assert(output.resolver === "pass", "output should record resolver pass");
    assert(output.packageHints === "pass", "output should record package hints pass");
    assert(output.registryEvidence === "pass", "output should record external registry evidence pass");
    assert(output.fallbackDiagnostics === "pass", "output should record fallback diagnostics pass");
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  process.stdout.write("Repository intelligence release QA helper test passed\n");
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
