#!/usr/bin/env node

import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(__dirname, "check-local-vision-release-resources.mjs");

async function main() {
  const help = await runCheck(["--help"]);
  assert(help.code === 0, "help should pass");
  assert(help.stdout.includes("check-local-vision-release-resources.mjs"), "help should include script name");

  const root = await mkdir(join(tmpdir(), `javis-release-resources-${Date.now()}-`), { recursive: true });
  try {
    const releaseDir = join(root, "release");
    await writeRequiredFiles(releaseDir);

    const passing = await runCheck(["--release-dir", releaseDir]);
    assert(passing.code === 0, `valid release tree should pass: ${passing.stderr || passing.stdout}`);
    assert(!passing.stdout.includes(root), "success output should not leak temp root");

    const staleTarget = otherRuntimeTarget();
    await writeFileWithDirs(releaseDir, `scripts/node_modules/onnxruntime-node/bin/napi-v6/${staleTarget}/onnxruntime_binding.node`);
    const stale = await runCheck(["--release-dir", releaseDir]);
    assert(stale.code === 1, "stale native runtime target should fail");
    assert(stale.stderr.includes("unexpected stale native runtime target"), "stale native runtime target error mismatch");
    await rm(join(releaseDir, "scripts", "node_modules", "onnxruntime-node", "bin", "napi-v6", ...staleTarget.split("/")), { recursive: true, force: true });

    await writeFileWithDirs(releaseDir, "scripts/node_modules/onnxruntime-node/script/install.js");
    const staleScript = await runCheck(["--release-dir", releaseDir]);
    assert(staleScript.code === 1, "stale dev script directory should fail");
    assert(staleScript.stderr.includes("unexpected stale release resource"), "stale dev script error mismatch");
    await rm(join(releaseDir, "scripts", "node_modules", "onnxruntime-node", "script"), { recursive: true, force: true });

    await rm(join(releaseDir, "scripts", "local-vision-worker.mjs"), { force: true });
    const failing = await runCheck(["--release-dir", releaseDir]);
    assert(failing.code === 1, "missing worker should fail");
    assert(failing.stderr.includes("missing release resource scripts/local-vision-worker.mjs"), "missing worker error mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  process.stdout.write("local vision release resource check test passed\n");
}

async function writeRequiredFiles(releaseDir) {
  const files = [
    "bin/node/manifest.json",
    "scripts/local-vision-worker.mjs",
    "scripts/local-vision-onnx-adapter.mjs",
    "models/local-vision/yolo26n-ui.onnx",
    "scripts/node_modules/onnxruntime-common/package.json",
    "scripts/node_modules/onnxruntime-node/package.json",
    "scripts/node_modules/onnxruntime-node/dist/index.js",
  ];
  if (process.platform === "win32") {
    files.push(
      "bin/node/node.exe",
      "scripts/local-vision-worker.cmd",
      `scripts/node_modules/onnxruntime-node/bin/napi-v6/win32/${process.arch}/onnxruntime_binding.node`,
      `scripts/node_modules/onnxruntime-node/bin/napi-v6/win32/${process.arch}/onnxruntime.dll`,
    );
  } else {
    files.push("bin/node/node");
  }
  for (const file of files) {
    await writeFileWithDirs(releaseDir, file);
  }
}

async function writeFileWithDirs(root, relativePath) {
  const path = join(root, ...relativePath.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "{}");
}

function otherRuntimeTarget() {
  const candidates = ["win32/x64", "win32/arm64", "linux/x64", "darwin/arm64"];
  return candidates.find((candidate) => candidate !== `${process.platform}/${process.arch}`) ?? "linux/x64";
}

function runCheck(args) {
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
