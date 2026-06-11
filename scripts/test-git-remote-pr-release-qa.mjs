#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const scriptPath = resolve(repoRoot, "docs", "qa", "2026-06-09", "git-remote-pr", "git-remote-pr-release-qa.ps1");

const requiredScreenshots = [
  "31-git-review-status-pr-list.png",
  "32-git-stage-approval-card.png",
  "33-git-commit-approval-card.png",
  "34-git-push-approval-card.png",
  "35-git-create-pr-approval-card.png",
  "36-git-comment-pr-approval-card.png",
  "37-git-restored-approval-after-restart.png",
];

async function main() {
  const root = await mkdtemp(join(tmpdir(), "javis-git-remote-pr-qa-"));
  try {
    await mkdir(root, { recursive: true });
    for (const screenshot of requiredScreenshots) {
      await writeFile(join(root, screenshot), "png placeholder");
    }
    await writeFile(
      join(root, "git-remote-pr-manual-qa-evidence.md"),
      [
        "# Manual evidence",
        "Date: 2026-06-11",
        "Operator: qa",
        "Build: 0.1.0",
        "Disposable remote: owner/repo",
        "Disposable branch: codex/qa-git-remote-pr",
        "Result: PASS",
        `Artifacts: ${requiredScreenshots.join(", ")}, git-remote-pr-qa-output.txt`,
        "- GIT-QA-01: PASS",
        "- GIT-QA-02: PASS",
        "- GIT-QA-03: PASS",
        "- GIT-QA-04: PASS",
        "- GIT-QA-05: PASS",
        "- GIT-QA-06: PASS",
        "- GIT-QA-07: PASS",
        "- GIT-QA-08: PASS",
        "- GIT-QA-09: PASS",
        "- GIT-QA-10: PASS",
        "- GIT-QA-11: PASS",
        "- GIT-QA-12: PASS",
        "- GIT-QA-13: PASS",
      ].join("\n"),
    );

    const result = await runPowerShell([
      "-QaRoot",
      root,
      "-Stage",
      "pass",
      "-Commit",
      "pass",
      "-Push",
      "pass",
      "-PrCreate",
      "pass",
        "-PrComment",
        "pass",
        "-Denial",
        "pass",
        "-Restore",
        "pass",
      "-Operator",
      "qa",
      "-Build",
      "0.1.0",
      "-Remote",
      "owner/repo",
      "-Branch",
      "codex/qa-git-remote-pr",
    ], root);
    assert(result.code === 0, `Git remote/PR QA helper should pass\n${result.stdout}\n${result.stderr}`);

    const outputText = await readFile(join(root, "git-remote-pr-qa-output.txt"), "utf8");
    const outputJson = JSON.parse(outputText.split("json:\n")[1]);
    assert(outputText.includes("PackagedApp: true"), "output should include packaged app text provenance");
    assert(outputJson.PackagedApp === true, "output should record packaged app JSON provenance");
    assert(typeof outputJson.AppVersion === "string" && outputJson.AppVersion.length > 0, "output should record app version");
    assert(/^\d{4}-\d{2}-\d{2}$/.test(outputJson.QaDate), "output should record concrete QA date");
    for (const screenshot of requiredScreenshots) {
      assert(outputJson.Artifacts.includes(screenshot), `output should reference ${screenshot}`);
    }
    assert(outputJson.Artifacts.includes("git-remote-pr-manual-qa-evidence.md"), "output should reference manual evidence");
    assert(outputJson.stage === "pass", "output should record stage pass");
    assert(outputJson.commit === "pass", "output should record commit pass");
    assert(outputJson.push === "pass", "output should record push pass");
    assert(outputJson.prCreate === "pass", "output should record PR create pass");
    assert(outputJson.prComment === "pass", "output should record PR comment pass");
    assert(outputJson.denial === "pass", "output should record denial pass");
    assert(outputJson.restore === "pass", "output should record restore pass");
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  process.stdout.write("Git remote/PR release QA helper test passed\n");
}

function runPowerShell(args, qaRoot) {
  return new Promise((resolvePromise) => {
    const child = spawn("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      ...args,
    ], { cwd: qaRoot });
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
