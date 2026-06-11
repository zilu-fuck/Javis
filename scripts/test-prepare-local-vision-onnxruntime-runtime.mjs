#!/usr/bin/env node

import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(__dirname, "prepare-local-vision-onnxruntime-runtime.mjs");

async function main() {
  const help = await runPrepare(["--help"]);
  assert(help.code === 0, "help should pass");
  assert(help.stdout.includes("prepare-local-vision-onnxruntime-runtime.mjs"), "help should include script name");

  const dir = await mkdtemp(join(tmpdir(), "javis-local-vision-onnxruntime-test-"));
  try {
    const output = join(dir, "node_modules");
    const prepared = await runPrepare(["--output", output]);
    assert(prepared.code === 0, `prepare should pass: ${prepared.stderr || prepared.stdout}`);
    assert(!prepared.stdout.includes(dir), "prepare output should not leak temp root");
    assertFile(output, "onnxruntime-common/package.json");
    assertFile(output, "onnxruntime-common/dist/cjs/index.js");
    assertFile(output, "onnxruntime-node/package.json");
    assertFile(output, "onnxruntime-node/dist/index.js");
    assertFile(output, `onnxruntime-node/bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`);
    if (process.platform === "win32") {
      assertFile(output, `onnxruntime-node/bin/napi-v6/${process.platform}/${process.arch}/onnxruntime.dll`);
    }

    const imported = await runNode(["-e", "import('onnxruntime-node').then(() => console.log('ok'))"], {
      cwd: dir,
    });
    assert(imported.code === 0, `prepared runtime should import: ${imported.stderr || imported.stdout}`);
    assert(imported.stdout.trim() === "ok", "prepared runtime import output mismatch");

    const badTarget = await runPrepare(["--platform", "win32", "--arch", "ia32", "--output", output]);
    assert(badTarget.code === 1, "unsupported target should fail");
    assert(badTarget.stderr.includes("unsupported onnxruntime-node runtime target"), "unsupported target error mismatch");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  process.stdout.write("local vision ONNX runtime prepare test passed\n");
}

function assertFile(root, relativePath) {
  const path = join(root, ...relativePath.split("/"));
  assert(existsSync(path), `expected file to exist: ${relativePath}`);
  assert(statSync(path).isFile(), `expected regular file: ${relativePath}`);
}

function runPrepare(args) {
  return runNode([scriptPath, ...args]);
}

function runNode(args, options = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, args, {
      ...options,
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
