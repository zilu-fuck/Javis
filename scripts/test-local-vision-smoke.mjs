#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const smokePath = resolve(__dirname, "local-vision-smoke.mjs");

async function main() {
  const help = await runSmoke(["--help"]);
  assert(help.code === 0, "help should exit successfully");
  assert(help.stdout.includes("Usage: node scripts/local-vision-smoke.mjs"), "help text should include usage");
  assert(help.stdout.includes("--model <model-file>"), "help text should describe model-file rather than only ONNX");
  assert(help.stdout.includes("--min-detections <number>"), "help text should include min detections gate");

  const missing = await runSmoke([]);
  assert(missing.code === 1, "missing args should fail");
  assert(missing.stderr.includes("--image is required"), "missing image error mismatch");
  assert(!missing.stderr.includes("\n    at "), "smoke missing args should not print stack");
  assert(!missing.stderr.includes("local-vision-smoke.mjs:"), "smoke missing args should not print script location");

  const dir = await mkdtemp(join(tmpdir(), "javis-local-vision-smoke-test-"));
  try {
    const imagePath = join(dir, "screen.png");
    const modelPath = join(dir, "model.onnx");
    const adapterPath = join(dir, "hanging-adapter.mjs");
    await writeFile(imagePath, createPngHeader(20, 20));
    await writeFile(modelPath, "placeholder model");
    await writeFile(adapterPath, "export async function detect() { await new Promise(() => {}); }\n");

    const unsupportedRuntime = await runSmoke([
      "--image", imagePath,
      "--model", modelPath,
      "--runtime", "cuda",
    ]);
    assert(unsupportedRuntime.code === 1, "unsupported runtime should fail");
    assert(unsupportedRuntime.stderr.includes("unsupported runtime: cuda"), "unsupported runtime error mismatch");
    assert(!unsupportedRuntime.stderr.includes("\n    at "), "unsupported runtime should not print stack");
    assert(!unsupportedRuntime.stderr.includes(dir), "unsupported runtime should not leak temp directory");

    const echoAdapterPath = join(dir, "echo-adapter.mjs");
    await writeFile(echoAdapterPath, `
export function detect({ request }) {
  return {
    diagnostics: {
      imgsz: request.imgsz,
      maxDetections: request.maxDetections,
      minConfidence: request.minConfidence,
      iouThreshold: request.iouThreshold,
      timeoutMs: request.timeoutMs,
    },
    rawDetections: [
      { id: "ok", label: "button", confidence: 0.9, box: { x: 1, y: 2, width: 3, height: 4 } },
    ],
  };
}
`);

    const pass = await runSmoke([
      "--image", imagePath,
      "--model", modelPath,
      "--adapter", echoAdapterPath,
      "--iou-threshold", "0.31",
    ]);
    assert(pass.code === 0, `smoke with iou threshold should pass: ${pass.stderr || pass.stdout}`);
    const passResult = JSON.parse(pass.stdout);
    assert(passResult.diagnostics.iouThreshold === 0.31, "smoke should forward iou threshold");
    assert(passResult.diagnostics.minConfidence === 0.75, "smoke should forward default min confidence");
    assert(passResult.diagnostics.timeoutMs === 2000, "smoke should forward default timeout");
    assert(passResult.model === "model.onnx", "smoke result should expose model filename only");
    assert(Array.isArray(passResult.warnings) && passResult.warnings.length === 0, "custom model smoke should not emit model-purpose warnings");
    assert(!pass.stdout.includes(dir), "smoke output should not leak temp directory");

    const cocoModelPath = join(dir, "yolo26n.onnx");
    await writeFile(cocoModelPath, "placeholder coco model");
    const cocoModel = await runSmoke([
      "--image", imagePath,
      "--model", cocoModelPath,
      "--adapter", echoAdapterPath,
    ]);
    assert(cocoModel.code === 0, `COCO smoke model warning should not fail smoke: ${cocoModel.stderr || cocoModel.stdout}`);
    const cocoModelResult = JSON.parse(cocoModel.stdout);
    assert(
      cocoModelResult.warnings.some((warning) => warning.includes("smoke/benchmark only")),
      "official YOLO26 COCO filename should warn that it is only for smoke/benchmark",
    );

    const separatorPass = await runSmoke([
      "--",
      "--image", imagePath,
      "--model", modelPath,
      "--adapter", echoAdapterPath,
      "--iou-threshold", "0.31",
    ]);
    assert(separatorPass.code === 0, `smoke should ignore npm-style -- separator: ${separatorPass.stderr || separatorPass.stdout}`);
    const separatorPassResult = JSON.parse(separatorPass.stdout);
    assert(separatorPassResult.diagnostics.iouThreshold === 0.31, "smoke separator run should parse arguments after --");
    assert(!separatorPass.stdout.includes(dir), "smoke separator run should not leak temp directory");

    const normalizedConfig = await runSmoke([
      "--image", imagePath,
      "--model", modelPath,
      "--adapter", echoAdapterPath,
      "--iou-threshold", "2",
      "--min-confidence", "-1",
      "--max-detections", "999",
      "--imgsz", "9999",
    ]);
    assert(normalizedConfig.code === 0, `normalized config smoke should pass: ${normalizedConfig.stderr || normalizedConfig.stdout}`);
    const normalizedConfigResult = JSON.parse(normalizedConfig.stdout);
    assert(normalizedConfigResult.diagnostics.imgsz === 1280, "smoke should cap imgsz");
    assert(normalizedConfigResult.diagnostics.maxDetections === 100, "smoke should normalize max detections");
    assert(normalizedConfigResult.diagnostics.minConfidence === 0.75, "smoke should normalize min confidence");
    assert(normalizedConfigResult.diagnostics.iouThreshold === 0.45, "smoke should normalize iou threshold");
    assert(normalizedConfigResult.diagnostics.timeoutMs === 2000, "smoke should use default timeout when not overridden");
    assert(!normalizedConfig.stdout.includes(dir), "normalized config smoke output should not leak temp directory");

    const minDetectionFail = await runSmoke([
      "--image", imagePath,
      "--model", modelPath,
      "--adapter", echoAdapterPath,
      "--min-detections", "2",
    ]);
    assert(minDetectionFail.code === 2, "smoke should fail when min detections is not met");
    const minDetectionFailResult = JSON.parse(minDetectionFail.stdout);
    assert(minDetectionFailResult.error.includes("expected at least 2"), "smoke min detections error mismatch");
    assert(minDetectionFailResult.detections.length === 1, "smoke min detections should keep detections for inspection");

    const timeout = await runSmoke([
      "--image", imagePath,
      "--model", modelPath,
      "--adapter", adapterPath,
      "--timeout-ms", "20",
    ]);
    assert(timeout.code === 2, `timeout smoke should exit with code 2: ${timeout.stderr || timeout.stdout}`);
    const timeoutResult = JSON.parse(timeout.stdout);
    assert(timeoutResult.timedOut === true, "timeout smoke should report timedOut=true");
    assert(timeoutResult.error.includes("timed out after 20ms"), "timeout smoke error mismatch");
    assert(!timeout.stdout.includes(dir), "timeout smoke output should not leak temp directory");

    const normalizedTimeout = await runSmoke([
      "--image", imagePath,
      "--model", modelPath,
      "--adapter", adapterPath,
      "--timeout-ms", "-1",
    ]);
    assert(normalizedTimeout.code === 2, "negative timeout smoke should fail with normalized timeout");
    const normalizedTimeoutResult = JSON.parse(normalizedTimeout.stdout);
    assert(normalizedTimeoutResult.timedOut === true, "negative timeout smoke should report timedOut=true");
    assert(normalizedTimeoutResult.error.includes("timed out after 20ms"), "negative timeout smoke should clamp timeout to 20ms");
    assert(!normalizedTimeout.stdout.includes(dir), "negative timeout smoke output should not leak temp directory");

    const blockingAdapterPath = join(dir, "blocking-adapter.mjs");
    await writeFile(blockingAdapterPath, `
export function detect() {
  const end = Date.now() + 500;
  while (Date.now() < end) {}
  return { rawDetections: [] };
}
`);
    const blocking = await runSmoke([
      "--image", imagePath,
      "--model", modelPath,
      "--adapter", blockingAdapterPath,
      "--timeout-ms", "20",
    ]);
    assert(blocking.code === 2, "blocking smoke should fail with code 2");
    const blockingResult = JSON.parse(blocking.stdout);
    assert(blockingResult.timedOut === true, "blocking smoke should report timedOut=true");
    assert(blockingResult.error.includes("timed out after 20ms"), "blocking smoke timeout error mismatch");
    assert(!blocking.stdout.includes(dir), "blocking smoke output should not leak temp directory");

    const noisyAdapterPath = join(dir, "noisy-adapter.mjs");
    await writeFile(noisyAdapterPath, `
export function detect() {
  process.stdout.write("x".repeat(1200000));
  return { rawDetections: [] };
}
`);
    const noisy = await runSmoke([
      "--image", imagePath,
      "--model", modelPath,
      "--adapter", noisyAdapterPath,
      "--timeout-ms", "2000",
    ]);
    assert(noisy.code === 2, "noisy smoke should fail with code 2");
    const noisyResult = JSON.parse(noisy.stdout);
    assert(noisyResult.error.includes("stdout exceeded"), "noisy smoke error mismatch");

    const pollutedAdapterPath = join(dir, "polluted-adapter.mjs");
    await writeFile(pollutedAdapterPath, `
export function detect() {
  process.stdout.write("not-json");
  return { rawDetections: [] };
}
`);
    const polluted = await runSmoke([
      "--image", imagePath,
      "--model", modelPath,
      "--adapter", pollutedAdapterPath,
    ]);
    assert(polluted.code === 2, "polluted stdout smoke should fail with code 2");
    const pollutedResult = JSON.parse(polluted.stdout);
    assert(pollutedResult.error.includes("worker stdout was not JSON"), "polluted stdout smoke error mismatch");

    const exitingAdapterPath = join(dir, "exiting-adapter.mjs");
    await writeFile(exitingAdapterPath, "export function detect() { process.exit(7); }\n");
    const exiting = await runSmoke([
      "--image", imagePath,
      "--model", modelPath,
      "--adapter", exitingAdapterPath,
    ]);
    assert(exiting.code === 2, "exiting worker smoke should fail with code 2");
    const exitingResult = JSON.parse(exiting.stdout);
    assert(exitingResult.error.includes("worker exited with 7"), "exiting worker smoke error mismatch");

    const softTimeoutAdapterPath = join(dir, "soft-timeout-adapter.mjs");
    await writeFile(softTimeoutAdapterPath, `
export function detect() {
  return {
    timedOut: true,
    rawDetections: [
      { id: "late", label: "button", confidence: 0.99, box: { x: 1, y: 2, width: 3, height: 4 } },
    ],
  };
}
`);
    const softTimeout = await runSmoke([
      "--image", imagePath,
      "--model", modelPath,
      "--adapter", softTimeoutAdapterPath,
      "--timeout-ms", "2000",
    ]);
    assert(softTimeout.code === 2, "adapter-reported timeout smoke should fail with code 2");
    const softTimeoutResult = JSON.parse(softTimeout.stdout);
    assert(softTimeoutResult.timedOut === true, "adapter-reported timeout should keep timedOut=true");
    assert(softTimeoutResult.detections.length === 0, "adapter-reported timeout should drop detections");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  process.stdout.write("local vision smoke CLI test passed\n");
}

function runSmoke(args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [smokePath, ...args], {
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

function createPngHeader(width, height) {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
