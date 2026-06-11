#!/usr/bin/env node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const scriptPath = resolve(repoRoot, "scripts", "release", "write-release-rollback-notes.ps1");

async function main() {
  const root = await mkdtemp(join(tmpdir(), "javis-release-rollback-notes-"));
  try {
    const qaRoot = join(root, "qa");
    const msiPath = join(root, "Javis_0.1.0_x64_en-US.msi");
    const nsisPath = join(root, "Javis_0.1.0_x64-setup.exe");
    await mkdir(qaRoot, { recursive: true });
    await writeFile(msiPath, "unsigned msi placeholder");
    await writeFile(nsisPath, "unsigned nsis placeholder");

    const missingPreviousHash = await runPowerShell([
      "-Version", "0.1.0",
      "-QaRoot", qaRoot,
      "-MsiPath", msiPath,
      "-NsisPath", nsisPath,
      "-PreviousKnownGoodBuild", "0.0.9",
      "-PreviousArtifactLocation", "https://example.invalid/javis/0.0.9",
    ], { allowFailure: true });
    assert(missingPreviousHash.code !== 0, "rollback notes must require a previous artifact SHA-256");
    assert(
      `${missingPreviousHash.stdout}\n${missingPreviousHash.stderr}`.includes("PreviousArtifactSha256"),
      "missing previous hash failure should mention PreviousArtifactSha256",
    );

    const result = await runPowerShell([
      "-Version", "0.1.0",
      "-QaRoot", qaRoot,
      "-MsiPath", msiPath,
      "-NsisPath", nsisPath,
      "-PreviousKnownGoodBuild", "0.0.9",
      "-PreviousArtifactLocation", "https://example.invalid/javis/0.0.9",
      "-PreviousArtifactSha256", "a".repeat(64),
    ], { allowFailure: true });

    assert(result.code !== 0, "unsigned placeholder artifacts must not produce rollback notes");
    assert(
      result.stderr.includes("signature is not valid") || result.stdout.includes("signature is not valid"),
      "failure should be caused by Authenticode signature validation",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  process.stdout.write("Release rollback notes helper test passed\n");
}

function runPowerShell(args, options = {}) {
  return new Promise((resolvePromise, reject) => {
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
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code, stdout, stderr };
      if (code !== 0 && !options.allowFailure) {
        reject(new Error(`rollback notes helper failed\n${stdout}\n${stderr}`));
        return;
      }
      resolvePromise(result);
    });
  });
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
