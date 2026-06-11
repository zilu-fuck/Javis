#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const benchmarkPath = resolve(__dirname, "local-vision-benchmark.mjs");

async function main() {
  const help = await runBenchmark(["--help"]);
  assert(help.code === 0, "help should exit successfully");
  assert(help.stdout.includes("Usage: node scripts/local-vision-benchmark.mjs"), "help text should include usage");
  assert(help.stdout.includes("--model <model-file>"), "help text should describe model-file rather than only ONNX");
  assert(help.stdout.includes("--min-detections <number>"), "help text should include min detections gate");

  const missing = await runBenchmark([]);
  assert(missing.code === 1, "missing args should fail");
  assert(missing.stderr.includes("--image is required"), "missing image error mismatch");
  assert(!missing.stderr.includes("\n    at "), "benchmark missing args should not print stack");
  assert(!missing.stderr.includes("local-vision-benchmark.mjs:"), "benchmark missing args should not print script location");

  const dir = await mkdtemp(join(tmpdir(), "javis-local-vision-benchmark-test-"));
  try {
    const imagePath = join(dir, "screen.png");
    const modelPath = join(dir, "model.onnx");
    const adapterPath = join(dir, "runtime-adapter.mjs");
    await writeFile(imagePath, createPngHeader(20, 20));
    await writeFile(modelPath, "placeholder model");
    await writeFile(adapterPath, `
export function detect({ request }) {
  if (request.iouThreshold !== 0.31) {
    throw new Error("iou threshold was not forwarded");
  }
  return {
    runtime: "onnxruntime",
    diagnostics: { inputSize: 640, requestedInputSize: 512, inputSizeSource: "model" },
    rawDetections: [
      { id: "ok", label: "button", confidence: 0.9, box: { x: 1, y: 2, width: 3, height: 4 } },
    ],
  };
}
`);

    const unsupportedRuntime = await runBenchmark([
      "--image", imagePath,
      "--model", modelPath,
      "--runtime", "cuda",
    ]);
    assert(unsupportedRuntime.code === 1, "unsupported runtime should fail");
    assert(unsupportedRuntime.stderr.includes("unsupported runtime: cuda"), "unsupported runtime error mismatch");
    assert(!unsupportedRuntime.stderr.includes("\n    at "), "unsupported runtime should not print stack");
    assert(!unsupportedRuntime.stderr.includes(dir), "unsupported runtime should not leak temp directory");

    const pass = await runBenchmark([
      "--image", imagePath,
      "--model", modelPath,
      "--adapter", adapterPath,
      "--iou-threshold", "0.31",
      "--iterations", "2",
      "--warmup", "1",
      "--max-error-count", "0",
    ]);
    assert(pass.code === 0, `benchmark should pass: ${pass.stderr || pass.stdout}`);
    const passReport = JSON.parse(pass.stdout);
    assert(passReport.image === "screen.png", "benchmark report should expose image filename only");
    assert(passReport.model === "model.onnx", "benchmark report should expose model filename only");
    assert(!pass.stdout.includes(dir), "benchmark report should not leak temp directory");
    assert(passReport.configuration.runtime === "onnxruntime", "benchmark report should include effective runtime");
    assert(passReport.configuration.imgsz === 640, "benchmark report should include effective imgsz");
    assert(passReport.configuration.maxDetections === 20, "benchmark report should include effective max detections");
    assert(passReport.configuration.minConfidence === 0.75, "benchmark report should include effective min confidence");
    assert(passReport.configuration.iouThreshold === 0.31, "benchmark report should include effective iou threshold");
    assert(passReport.configuration.timeoutMs === 2000, "benchmark report should include effective timeout");
    assert(passReport.configuration.runtimeAdapter === "runtime-adapter.mjs", "benchmark report should expose adapter filename only");
    assert(passReport.iterations === 2, "iteration count mismatch");
    assert(passReport.errorCount === 0, "expected no benchmark errors");
    assert(Array.isArray(passReport.latencyMs.samples), "samples should be present");
    assert(passReport.latencyMs.samples.length === 2, "sample count mismatch");
    assert(Array.isArray(passReport.detectionCount.samples), "detection count samples should be present");
    assert(passReport.detectionCount.samples.length === 2, "detection count sample mismatch");
    assert(passReport.detectionCount.max === 1, "detection count max mismatch");
    assert(passReport.detectionCount.p50 === 1, "detection count p50 mismatch");
    assert(passReport.runtimeCounts.onnxruntime === 2, "benchmark should count observed onnxruntime samples");
    assert(passReport.modelCounts["model.onnx"] === 2, "benchmark should count observed model samples by filename");
    assert(Array.isArray(passReport.warnings) && passReport.warnings.length === 0, "custom model benchmark should not emit model-purpose warnings");
    assert(passReport.inputSizeCounts["640"] === 2, "benchmark should count observed adapter input size");
    assert(passReport.requestedInputSizeCounts["512"] === 2, "benchmark should count observed requested input size");
    assert(passReport.inputSizeSourceCounts.model === 2, "benchmark should count observed input size source");
    assert(passReport.failureBreakdown.successfulSamples === 2, "passing benchmark successful sample count mismatch");
    assert(passReport.failureBreakdown.timeoutCount === 0, "passing benchmark timeout count mismatch");
    assert(passReport.failureBreakdown.workerErrorCount === 0, "passing benchmark worker error count mismatch");
    assert(passReport.failureBreakdown.minDetectionFailureCount === 0, "passing benchmark min detection failure count mismatch");
    assert(passReport.failureBreakdown.zeroDetectionSamples === 0, "passing benchmark zero detection count mismatch");
    assert(passReport.passed === true, "passing benchmark should report passed=true");
    assert(passReport.worker.reused === false, "default benchmark should not reuse worker");

    const cocoModelPath = join(dir, "yolo26n.onnx");
    await writeFile(cocoModelPath, "placeholder coco model");
    const cocoModel = await runBenchmark([
      "--image", imagePath,
      "--model", cocoModelPath,
      "--adapter", adapterPath,
      "--iou-threshold", "0.31",
      "--iterations", "1",
      "--warmup", "0",
    ]);
    assert(cocoModel.code === 0, `COCO benchmark model warning should not fail benchmark: ${cocoModel.stderr || cocoModel.stdout}`);
    const cocoModelReport = JSON.parse(cocoModel.stdout);
    assert(
      cocoModelReport.warnings.some((warning) => warning.includes("smoke/benchmark only")),
      "official YOLO26 COCO filename should warn that it is only for smoke/benchmark",
    );

    const separatorPass = await runBenchmark([
      "--",
      "--image", imagePath,
      "--model", modelPath,
      "--adapter", adapterPath,
      "--iou-threshold", "0.31",
      "--iterations", "1",
      "--warmup", "0",
    ]);
    assert(separatorPass.code === 0, `benchmark should ignore npm-style -- separator: ${separatorPass.stderr || separatorPass.stdout}`);
    const separatorPassReport = JSON.parse(separatorPass.stdout);
    assert(separatorPassReport.configuration.iouThreshold === 0.31, "benchmark separator run should parse arguments after --");
    assert(separatorPassReport.latencyMs.samples.length === 1, "benchmark separator run should use parsed iterations");
    assert(!separatorPass.stdout.includes(dir), "benchmark separator run should not leak temp directory");

    const permissiveAdapterPath = join(dir, "permissive-adapter.mjs");
    await writeFile(permissiveAdapterPath, `
export function detect() {
  return {
    runtime: "onnxruntime",
    diagnostics: { inputSize: 640, requestedInputSize: 1280, inputSizeSource: "request" },
    rawDetections: [
      { id: "ok", label: "button", confidence: 0.9, box: { x: 1, y: 2, width: 3, height: 4 } },
    ],
  };
}
`);
    const normalizedConfig = await runBenchmark([
      "--image", imagePath,
      "--model", modelPath,
      "--adapter", permissiveAdapterPath,
      "--iou-threshold", "2",
      "--min-confidence", "-1",
      "--max-detections", "999",
      "--imgsz", "9999",
      "--iterations", "1",
      "--warmup", "0",
      "--max-error-count", "1",
    ]);
    assert(normalizedConfig.code === 0, `normalized config benchmark should pass: ${normalizedConfig.stderr || normalizedConfig.stdout}`);
    const normalizedConfigReport = JSON.parse(normalizedConfig.stdout);
    assert(normalizedConfigReport.configuration.imgsz === 1280, "benchmark should cap imgsz");
    assert(normalizedConfigReport.configuration.maxDetections === 100, "benchmark should report normalized max detections");
    assert(normalizedConfigReport.configuration.minConfidence === 0.75, "benchmark should report normalized min confidence");
    assert(normalizedConfigReport.configuration.iouThreshold === 0.45, "benchmark should report normalized iou threshold");
    assert(normalizedConfigReport.configuration.timeoutMs === 2000, "benchmark should use default timeout when not overridden");
    assert(normalizedConfigReport.configuration.runtimeAdapter === "permissive-adapter.mjs", "normalized config should expose adapter filename only");
    assert(normalizedConfigReport.inputSizeCounts["640"] === 1, "normalized config should count adapter input size");
    assert(normalizedConfigReport.requestedInputSizeCounts["1280"] === 1, "normalized config should count requested input size");
    assert(normalizedConfigReport.inputSizeSourceCounts.request === 1, "normalized config should count input size source");
    assert(!normalizedConfig.stdout.includes(dir), "normalized config benchmark output should not leak temp directory");

    const runtimeAdapterPath = join(dir, "runtime-selection-adapter.mjs");
    await writeFile(runtimeAdapterPath, `
export function detect() {
  return {
    runtime: "openvino",
    diagnostics: { inputSize: 640, requestedInputSize: 640, inputSizeSource: "model" },
    rawDetections: [
      { id: "ok", label: "button", confidence: 0.9, box: { x: 1, y: 2, width: 3, height: 4 } },
    ],
  };
}
`);
    const runtimeSelection = await runBenchmark([
      "--image", imagePath,
      "--model", modelPath,
      "--adapter", runtimeAdapterPath,
      "--runtime", "auto",
      "--iterations", "1",
      "--warmup", "0",
    ]);
    assert(runtimeSelection.code === 0, `runtime-selection benchmark should pass: ${runtimeSelection.stderr || runtimeSelection.stdout}`);
    const runtimeSelectionReport = JSON.parse(runtimeSelection.stdout);
    assert(runtimeSelectionReport.configuration.runtime === "auto", "benchmark report should preserve requested auto runtime");
    assert(runtimeSelectionReport.configuration.runtimeAdapter === "runtime-selection-adapter.mjs", "runtime-selection report should expose adapter filename only");
    assert(runtimeSelectionReport.runtimeCounts.openvino === 1, "benchmark should report worker-selected runtime");
    assert(runtimeSelectionReport.runtimeCounts.auto === undefined, "benchmark should not report request runtime as observed runtime");
    assert(runtimeSelectionReport.modelCounts["model.onnx"] === 1, "runtime-selection benchmark should count model filename");
    assert(runtimeSelectionReport.inputSizeSourceCounts.model === 1, "runtime-selection benchmark should count input size source");

    const minDetectionFail = await runBenchmark([
      "--image", imagePath,
      "--model", modelPath,
      "--adapter", adapterPath,
      "--iou-threshold", "0.31",
      "--iterations", "1",
      "--warmup", "0",
      "--min-detections", "2",
      "--max-error-count", "0",
    ]);
    assert(minDetectionFail.code === 2, "benchmark should fail when min detections is not met");
    const minDetectionFailReport = JSON.parse(minDetectionFail.stdout);
    assert(minDetectionFailReport.errorCount === 1, "benchmark min detections should count one error");
    assert(minDetectionFailReport.failureBreakdown.minDetectionFailureCount === 1, "benchmark min detections should be categorized");
    assert(minDetectionFailReport.failureBreakdown.timeoutCount === 0, "benchmark min detections should not count timeout");
    assert(minDetectionFailReport.errors[0]?.type === "min_detections", "benchmark min detections error type mismatch");
    assert(minDetectionFailReport.errors[0]?.detectionCount === 1, "benchmark min detections error should include detection count");
    assert(minDetectionFailReport.errors[0]?.error.includes("minDetections 2"), "benchmark min detections error mismatch");
    assert(minDetectionFailReport.budgets.minDetections === 2, "benchmark report should include min detections budget");
    assert(minDetectionFailReport.detectionCount.samples[0] === 1, "benchmark min detections should report sample count");

    const statefulAdapterPath = join(dir, "stateful-adapter.mjs");
    await writeFile(statefulAdapterPath, `
let callCount = 0;
export function detect() {
  callCount += 1;
  if (callCount < 2) {
    throw new Error("warmup did not run first");
  }
  return {
    runtime: "onnxruntime",
    diagnostics: { callCount },
    rawDetections: [
      { id: "ok", label: "button", confidence: 0.9, box: { x: callCount, y: 2, width: 3, height: 4 } },
    ],
  };
}
`);
    const reused = await runBenchmark([
      "--image", imagePath,
      "--model", modelPath,
      "--adapter", statefulAdapterPath,
      "--iterations", "2",
      "--warmup", "1",
      "--reuse-worker",
    ]);
    assert(reused.code === 0, `reused-worker benchmark should pass: ${reused.stderr || reused.stdout}`);
    const reusedReport = JSON.parse(reused.stdout);
    assert(reusedReport.worker.reused === true, "reused-worker benchmark should report worker reuse");
    assert(reusedReport.errorCount === 0, "reused-worker benchmark should not count errors");
    assert(reusedReport.latencyMs.samples.length === 2, "reused-worker sample count mismatch");

    const fail = await runBenchmark([
      "--image", imagePath,
      "--model", modelPath,
      "--adapter", adapterPath,
      "--iou-threshold", "0.31",
      "--iterations", "1",
      "--warmup", "1",
      "--max-p95-ms", "-1",
    ]);
    assert(fail.code === 2, "budget failure should exit with code 2");
    const failReport = JSON.parse(fail.stdout);
    assert(failReport.passed === false, "budget failure should report passed=false");
    assert(failReport.budgetFailures.some((entry) => entry.includes("p95")), "budget failure should mention p95");

    const hangingAdapterPath = join(dir, "hanging-adapter.mjs");
    await writeFile(hangingAdapterPath, "export async function detect() { await new Promise(() => {}); }\n");
    const timeout = await runBenchmark([
      "--image", imagePath,
      "--model", modelPath,
      "--adapter", hangingAdapterPath,
      "--iterations", "1",
      "--warmup", "0",
      "--timeout-ms", "20",
      "--max-error-count", "0",
    ]);
    assert(timeout.code === 2, "timeout benchmark should fail budget with code 2");
    const timeoutReport = JSON.parse(timeout.stdout);
    assert(timeoutReport.errorCount === 1, "timeout benchmark should count one error");
    assert(timeoutReport.failureBreakdown.timeoutCount === 1, "timeout benchmark should categorize timeout");
    assert(timeoutReport.failureBreakdown.workerErrorCount === 0, "timeout benchmark should not count worker error");
    assert(timeoutReport.errors[0]?.type === "timeout", "timeout benchmark error type mismatch");
    assert(timeoutReport.errors[0]?.timedOut === true, "timeout benchmark error should include timedOut flag");
    assert(timeoutReport.errors[0]?.error.includes("timed out after 20ms"), "timeout benchmark error mismatch");
    assert(!timeout.stdout.includes(dir), "timeout benchmark output should not leak temp directory");

    const blockingAdapterPath = join(dir, "blocking-adapter.mjs");
    await writeFile(blockingAdapterPath, `
export function detect() {
  const end = Date.now() + 500;
  while (Date.now() < end) {}
  return { rawDetections: [] };
}
`);
    const blocking = await runBenchmark([
      "--image", imagePath,
      "--model", modelPath,
      "--adapter", blockingAdapterPath,
      "--iterations", "1",
      "--warmup", "0",
      "--timeout-ms", "20",
      "--max-error-count", "0",
    ]);
    assert(blocking.code === 2, "blocking benchmark should fail budget with code 2");
    const blockingReport = JSON.parse(blocking.stdout);
    assert(blockingReport.errorCount === 1, "blocking benchmark should count one error");
    assert(blockingReport.errors[0]?.error.includes("timed out after 20ms"), "blocking benchmark error mismatch");
    assert(!blocking.stdout.includes(dir), "blocking benchmark output should not leak temp directory");

    const reusedBlocking = await runBenchmark([
      "--image", imagePath,
      "--model", modelPath,
      "--adapter", blockingAdapterPath,
      "--iterations", "1",
      "--warmup", "0",
      "--timeout-ms", "20",
      "--max-error-count", "0",
      "--reuse-worker",
    ]);
    assert(reusedBlocking.code === 2, "blocking reused-worker benchmark should fail budget with code 2");
    const reusedBlockingReport = JSON.parse(reusedBlocking.stdout);
    assert(reusedBlockingReport.worker.reused === true, "blocking reused-worker report should record reuse");
    assert(reusedBlockingReport.errorCount === 1, "blocking reused-worker benchmark should count one error");
    assert(reusedBlockingReport.errors[0]?.error.includes("timed out after 20ms"), "blocking reused-worker timeout error mismatch");

    const noisyAdapterPath = join(dir, "noisy-adapter.mjs");
    await writeFile(noisyAdapterPath, `
export function detect() {
  process.stdout.write("x".repeat(1200000));
  return { rawDetections: [] };
}
`);
    const noisy = await runBenchmark([
      "--image", imagePath,
      "--model", modelPath,
      "--adapter", noisyAdapterPath,
      "--iterations", "1",
      "--warmup", "0",
      "--timeout-ms", "2000",
      "--max-error-count", "0",
    ]);
    assert(noisy.code === 2, "noisy benchmark should fail budget with code 2");
    const noisyReport = JSON.parse(noisy.stdout);
    assert(noisyReport.errorCount === 1, "noisy benchmark should count one error");
    assert(noisyReport.failureBreakdown.workerErrorCount === 1, "noisy benchmark should categorize worker error");
    assert(noisyReport.errors[0]?.type === "worker_error", "noisy benchmark error type mismatch");
    assert(noisyReport.errors[0]?.error.includes("stdout exceeded"), "noisy benchmark error mismatch");

    const pollutedAdapterPath = join(dir, "polluted-adapter.mjs");
    await writeFile(pollutedAdapterPath, `
export function detect() {
  process.stdout.write("not-json");
  return { rawDetections: [] };
}
`);
    const polluted = await runBenchmark([
      "--image", imagePath,
      "--model", modelPath,
      "--adapter", pollutedAdapterPath,
      "--iterations", "1",
      "--warmup", "0",
      "--max-error-count", "0",
    ]);
    assert(polluted.code === 2, "polluted stdout benchmark should fail budget with code 2");
    const pollutedReport = JSON.parse(polluted.stdout);
    assert(pollutedReport.errorCount === 1, "polluted stdout benchmark should count one error");
    assert(pollutedReport.errors[0]?.error.includes("worker stdout was not JSON"), "polluted stdout benchmark error mismatch");

    const exitingAdapterPath = join(dir, "exiting-adapter.mjs");
    await writeFile(exitingAdapterPath, "export function detect() { process.exit(7); }\n");
    const exiting = await runBenchmark([
      "--image", imagePath,
      "--model", modelPath,
      "--adapter", exitingAdapterPath,
      "--iterations", "1",
      "--warmup", "0",
      "--max-error-count", "0",
    ]);
    assert(exiting.code === 2, "exiting worker benchmark should fail budget with code 2");
    const exitingReport = JSON.parse(exiting.stdout);
    assert(exitingReport.errorCount === 1, "exiting worker benchmark should count one error");
    assert(exitingReport.errors[0]?.error.includes("worker exited with 7"), "exiting worker benchmark error mismatch");

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
    const softTimeout = await runBenchmark([
      "--image", imagePath,
      "--model", modelPath,
      "--adapter", softTimeoutAdapterPath,
      "--iterations", "1",
      "--warmup", "0",
      "--timeout-ms", "2000",
      "--max-error-count", "0",
    ]);
    assert(softTimeout.code === 2, "adapter-reported timeout benchmark should fail budget with code 2");
    const softTimeoutReport = JSON.parse(softTimeout.stdout);
    assert(softTimeoutReport.errorCount === 1, "adapter-reported timeout benchmark should count one error");
    assert(softTimeoutReport.errors[0]?.error.includes("timedOut=true"), "adapter-reported timeout benchmark error mismatch");

    process.stdout.write("local vision benchmark CLI test passed\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runBenchmark(args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [benchmarkPath, ...args], {
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
