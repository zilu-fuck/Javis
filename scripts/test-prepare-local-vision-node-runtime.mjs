#!/usr/bin/env node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(__dirname, "prepare-local-vision-node-runtime.mjs");

async function main() {
  const help = await runPrepare(["--help"]);
  assert(help.code === 0, "help should pass");
  assert(help.stdout.includes("prepare-local-vision-node-runtime.mjs"), "help should include script name");

  const dir = await mkdtemp(join(tmpdir(), "javis-local-vision-node-runtime-test-"));
  try {
    const output = join(dir, "node-runtime");
    const prepared = await runPrepare(["--output", output]);
    assert(prepared.code === 0, `prepare should pass: ${prepared.stderr || prepared.stdout}`);
    const nodeName = process.platform === "win32" ? "node.exe" : "node";
    const nodePath = join(output, nodeName);
    const manifestPath = join(output, "manifest.json");
    assert(existsSync(nodePath), "prepared node executable should exist");
    assert(statSync(nodePath).isFile(), "prepared node should be a file");
    assert(existsSync(manifestPath), "manifest should exist");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert(manifest.version === process.versions.node, "manifest version should match current node");
    assert(manifest.target === nodeName, "manifest target mismatch");
    assert(!prepared.stdout.includes(dir), "prepare output should not leak temp root");

    const badSource = await runPrepare(["--source", join(dir, "missing-node.exe"), "--output", output]);
    assert(badSource.code === 1, "missing source should fail");
    assert(badSource.stderr.includes("--source does not exist"), "missing source error mismatch");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  process.stdout.write("local vision Node runtime prepare test passed\n");
}

function runPrepare(args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
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
      resolveResult({ code, stdout, stderr });
    });
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
