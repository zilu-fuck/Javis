#!/usr/bin/env node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const scriptPath = resolve(repoRoot, "docs", "qa", "2026-06-09", "git-remote-pr", "git-remote-pr-preflight.ps1");

async function main() {
  const root = await mkdtemp(join(tmpdir(), "javis-git-pr-preflight-"));
  try {
    const repo = join(root, "repo");
    const bare = join(root, "remote.git");
    await run("git", ["init", repo]);
    await run("git", ["-C", repo, "config", "user.email", "javis@example.test"]);
    await run("git", ["-C", repo, "config", "user.name", "Javis QA"]);
    await run("git", ["-C", repo, "commit", "--allow-empty", "-m", "seed"]);

    const protectedOutput = join(root, "protected-output.txt");
    const protectedRun = await runPowerShell([
      "-WorkspacePath", repo,
      "-OutputPath", protectedOutput,
    ], { allowFailure: true });
    assert(protectedRun.code !== 0, "protected branch preflight should fail");
    const protectedText = await readFile(protectedOutput, "utf8");
    assert(protectedText.includes("qa-branch-not-protected"), "protected failure should mention branch check");

    await run("git", ["init", "--bare", bare]);
    await run("git", ["-C", repo, "checkout", "-b", "qa/git-pr-preflight"]);
    await run("git", ["-C", repo, "remote", "add", "origin", bare]);
    await run("git", ["-C", repo, "push", "-u", "origin", "qa/git-pr-preflight"]);

    const passingOutput = join(root, "passing-output.txt");
    const passingRun = await runPowerShell([
      "-WorkspacePath", repo,
      "-OutputPath", passingOutput,
    ]);
    assert(passingRun.stdout.includes("Git/PR preflight passed"), "safe local preflight should pass without -RequireGhAuth");
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  process.stdout.write("Git/PR preflight checker test passed\n");
}

function run(file, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { cwd: repoRoot });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code, stdout, stderr };
      if (code !== 0 && !options.allowFailure) {
        reject(new Error(`${file} ${args.join(" ")} failed\n${stdout}\n${stderr}`));
        return;
      }
      resolvePromise(result);
    });
  });
}

function runPowerShell(args, options = {}) {
  return run("powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    ...args,
  ], options);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
