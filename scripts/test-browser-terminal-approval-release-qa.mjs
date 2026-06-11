#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const scriptPath = resolve(repoRoot, "docs", "qa", "2026-06-10", "browser-terminal-approvals", "browser-terminal-approval-release-qa.ps1");

const requiredScreenshots = [
  "39-terminal-start-approval-card.png",
  "40-terminal-input-approval-card.png",
  "41-browser-write-approval-card.png",
];

async function main() {
  const root = await mkdtemp(join(tmpdir(), "javis-browser-terminal-qa-"));
  try {
    await mkdir(root, { recursive: true });
    for (const screenshot of requiredScreenshots) {
      await writeFile(join(root, screenshot), "png placeholder");
    }
    await writeFile(
      join(root, "browser-terminal-approval-manual-qa-evidence.md"),
      [
        "# Manual evidence",
        "Date: 2026-06-11",
        "Operator: qa",
        "Build: 0.1.0",
        "Workspace: E:\\Javis",
        "Result: PASS",
        `Artifacts: ${requiredScreenshots.join(", ")}, browser-terminal-approval-qa-output.txt`,
        "- BROWSER-TERM-QA-01: PASS",
        "- BROWSER-TERM-QA-02: PASS",
        "- BROWSER-TERM-QA-03: PASS",
        "- BROWSER-TERM-QA-04: PASS",
        "- BROWSER-TERM-QA-05: PASS",
        "- BROWSER-TERM-QA-06: PASS",
      ].join("\n"),
    );

    const result = await runPowerShell([
      "-QaRoot",
      root,
      "-TerminalStart",
      "pass",
      "-TerminalInput",
      "pass",
      "-BrowserWrite",
      "pass",
      "-Denial",
      "pass",
      "-StalePreview",
      "pass",
      "-OneShot",
      "pass",
      "-Operator",
      "qa",
      "-Build",
      "0.1.0",
      "-Workspace",
      "E:\\Javis",
    ]);
    assert(result.code === 0, `Browser/Terminal QA helper should pass\n${result.stdout}\n${result.stderr}`);

    const outputText = await readFile(join(root, "browser-terminal-approval-qa-output.txt"), "utf8");
    const outputJson = JSON.parse(outputText.split("json:\n")[1]);
    assert(outputText.includes("PackagedApp: true"), "output should include packaged app text provenance");
    assert(outputJson.PackagedApp === true, "output should record packaged app JSON provenance");
    assert(typeof outputJson.AppVersion === "string" && outputJson.AppVersion.length > 0, "output should record app version");
    assert(/^\d{4}-\d{2}-\d{2}$/.test(outputJson.QaDate), "output should record concrete QA date");
    for (const screenshot of requiredScreenshots) {
      assert(outputJson.Artifacts.includes(screenshot), `output should reference ${screenshot}`);
    }
    assert(outputJson.Artifacts.includes("browser-terminal-approval-manual-qa-evidence.md"), "output should reference manual evidence");
    assert(outputJson.terminalStart === "pass", "output should record terminal start pass");
    assert(outputJson.terminalInput === "pass", "output should record terminal input pass");
    assert(outputJson.browserWrite === "pass", "output should record browser write pass");
    assert(outputJson.denial === "pass", "output should record denial pass");
    assert(outputJson.stalePreview === "pass", "output should record stale preview pass");
    assert(outputJson.oneShot === "pass", "output should record one-shot pass");
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  process.stdout.write("Browser/Terminal approval release QA helper test passed\n");
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
