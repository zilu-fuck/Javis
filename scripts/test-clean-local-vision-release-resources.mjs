#!/usr/bin/env node

import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(__dirname, "clean-local-vision-release-resources.mjs");

async function main() {
  const help = await runClean(["--help"]);
  assert(help.code === 0, "help should pass");
  assert(help.stdout.includes("clean-local-vision-release-resources.mjs"), "help should include script name");

  const root = await mkdir(join(tmpdir(), `javis-clean-release-resources-${Date.now()}-`), { recursive: true });
  try {
    const releaseDir = join(root, "release");
    await writeFileWithDirs(releaseDir, "bin/node/node.exe");
    await writeFileWithDirs(releaseDir, "models/local-vision/yolo26n-ui.onnx");
    await writeFileWithDirs(releaseDir, "scripts/local-vision-worker.mjs");
    await writeFileWithDirs(releaseDir, "scripts/node_modules/onnxruntime-node/script/install.js");
    await writeFileWithDirs(releaseDir, "sidecar/browser/dist/index.js");

    const cleaned = await runClean(["--release-dir", releaseDir]);
    assert(cleaned.code === 0, `clean should pass: ${cleaned.stderr || cleaned.stdout}`);
    assert(!cleaned.stdout.includes(root), "clean output should not leak temp root");
    assert(!existsSync(join(releaseDir, "bin", "node")), "node runtime should be removed");
    assert(!existsSync(join(releaseDir, "models", "local-vision")), "local vision models should be removed");
    assert(!existsSync(join(releaseDir, "scripts", "local-vision-worker.mjs")), "worker should be removed");
    assert(!existsSync(join(releaseDir, "scripts", "node_modules", "onnxruntime-node")), "onnxruntime-node should be removed");
    assert(existsSync(join(releaseDir, "sidecar", "browser", "dist", "index.js")), "unrelated resources should remain");
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  process.stdout.write("local vision release resource clean test passed\n");
}

async function writeFileWithDirs(root, relativePath) {
  const path = join(root, ...relativePath.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "x");
}

function runClean(args) {
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
