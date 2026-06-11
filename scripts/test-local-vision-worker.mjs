#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerPath = resolve(__dirname, "local-vision-worker.mjs");
const MAX_WORKER_STDOUT_BYTES = 1024 * 1024;
const MAX_WORKER_STDERR_BYTES = 64 * 1024;
const WORKER_TEST_TIMEOUT_MS = 3_000;

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "javis-local-vision-worker-test-"));
  const imagePath = join(dir, "screen.png");
  const modelPath = join(dir, "yolo26n-ui.onnx");
  const adapterPath = join(dir, "runtime-adapter.mjs");
  const timedOutAdapterPath = join(dir, "timed-out-adapter.mjs");
  const hangingAdapterPath = join(dir, "hanging-adapter.mjs");
  const errorAdapterPath = join(dir, "error-adapter.mjs");
  const excessiveAdapterPath = join(dir, "excessive-adapter.mjs");
  const noisyAdapterPath = join(dir, "noisy-adapter.mjs");
  const pathErrorAdapterPath = join(dir, "path-error-adapter.mjs");
  const requestPath = join(dir, "request.json");
  try {
    await writeFile(
      imagePath,
      createPngHeader(100, 100),
    );
    await writeFile(modelPath, "placeholder model for readiness tests");
    await writeFile(adapterPath, `
export function detect({ request, imageSize }) {
  if (request.screenshotId !== "adapter-shot") throw new Error("unexpected screenshotId");
  return {
    runtime: "onnxruntime",
    diagnostics: {
      imgsz: request.imgsz,
      maxDetections: request.maxDetections,
      minConfidence: request.minConfidence,
      iouThreshold: request.iouThreshold,
      timeoutMs: request.timeoutMs,
      outputDims: [1, 6, 8400],
      rawNote: "data:image\\/png;base64,AAAA",
      "data:image\\/png;base64,KEY_SHOULD_NOT_SURVIVE==": "safe value",
      veryLong: "x".repeat(200),
    },
    rawDetections: [
      { id: "adapter-save", label: "button", confidence: 0.93, box: { x: 20, y: 30, width: 40, height: 50 } },
      { id: "adapter-weak", label: "icon", confidence: 0.1, box: { x: 0, y: 0, width: imageSize.width, height: imageSize.height } },
    ],
  };
}
`);
    await writeFile(timedOutAdapterPath, `
export function detect() {
  return {
    runtime: "onnxruntime",
    timedOut: true,
    error: "adapter exceeded timeout budget",
    diagnostics: { reason: "late partial output" },
    rawDetections: [
      { id: "late-save", label: "button", confidence: 0.99, box: { x: 20, y: 30, width: 40, height: 50 } },
    ],
  };
}
`);
    await writeFile(hangingAdapterPath, `
export function detect() {
  return new Promise(() => {});
}
`);
    await writeFile(errorAdapterPath, `
export function detect() {
  return {
    runtime: "onnxruntime",
    error: "adapter failed after partial output",
    diagnostics: { reason: "partial decode failure" },
    rawDetections: [
      { id: "partial-save", label: "button", confidence: 0.99, box: { x: 20, y: 30, width: 40, height: 50 } },
    ],
  };
}
`);
    await writeFile(excessiveAdapterPath, `
export function detect() {
  return {
    runtime: "onnxruntime",
    rawDetections: Array.from({ length: 20001 }, (_, index) => ({
      id: "det-" + index,
      label: "button",
      confidence: 0.99,
      box: { x: 10, y: 10, width: 20, height: 20 },
    })),
  };
}
`);
    await writeFile(noisyAdapterPath, `
export function detect() {
  process.stdout.write("x".repeat(1200000));
  return { runtime: "onnxruntime", rawDetections: [] };
}
`);
    await writeFile(pathErrorAdapterPath, `
export function detect() {
  return {
    runtime: "onnxruntime",
    error: "adapter failed at C:\\\\Users\\\\alice\\\\adapters\\\\runtime-adapter.mjs",
    diagnostics: {
      adapterPath: "C:\\\\Users\\\\alice\\\\adapters\\\\runtime-adapter.mjs",
      cachePath: "/home/alice/.cache/javis/model-cache.bin",
    },
    rawDetections: [
      { id: "path-error-save", label: "button", confidence: 0.99, box: { x: 20, y: 30, width: 40, height: 50 } },
    ],
  };
}
`);
    await writeFile(requestPath, JSON.stringify({
      imagePath,
      screenshotId: "worker-test-shot",
      modelPath: "models/yolo26n-ui.onnx",
      runtime: "onnxruntime",
      maxDetections: 2,
      minConfidence: 0.5,
      timeoutMs: 120,
      rawDetections: [
        { id: "save-1", label: "button", confidence: 0.92, box: { x: 10, y: 20, width: 30, height: 40 } },
        { id: "save-overlap", label: "button", confidence: 0.91, box: { x: 12, y: 22, width: 30, height: 40 } },
        { id: "input-1", label: "text_input", confidence: 0.7, box: [-5, -5, 8, 9] },
        { id: "weak-1", label: "icon", confidence: 0.2, box: { x: 0, y: 0, width: 1, height: 1 } },
      ],
    }));

    const result = await runWorker(requestPath);
    assert(result.screenshotId === "worker-test-shot", "screenshotId mismatch");
    assert(Array.isArray(result.detections), "detections must be an array");
    assert(result.detections.length === 2, "expected filtered/NMS detections");
    assert(result.detections[0].id === "save-1", "highest confidence detection should be first");
    assert(result.detections[0].center.x === 25, "center x mismatch");
    assert(result.detections[0].center.y === 40, "center y mismatch");
    assert(result.detections[1].id === "input-1", "second detection should survive NMS");
    assert(result.detections[1].box.x === 0, "box should be clamped to screenshot x");
    assert(result.detections[1].box.y === 0, "box should be clamped to screenshot y");
    assert(result.model === "yolo26n-ui.onnx", "model mismatch");
    assert(result.runtime === "onnxruntime", "runtime mismatch");
    assert(result.timedOut === false, "timedOut should be false");
    assert(result.error === undefined, "detections should not include protocol-worker error");
    assert(result.diagnostics.rawDetectionCount === 4, "rawDetections diagnostics count mismatch");
    assert(result.diagnostics.adaptedDetectionCount === 2, "adapted diagnostics count mismatch");

    const bomRequestPath = join(dir, "request-bom.json");
    await writeFile(bomRequestPath, `\uFEFF${JSON.stringify({
      imagePath,
      screenshotId: "bom-request-shot",
      modelPath,
      runtime: "onnxruntime",
      maxDetections: 1,
      minConfidence: 0.5,
      rawDetections: [
        { id: "bom-save", label: "button", confidence: 0.92, box: { x: 10, y: 20, width: 30, height: 40 } },
      ],
      timeoutMs: 120,
    })}`);
    const bomResult = await runWorker(bomRequestPath);
    assert(bomResult.screenshotId === "bom-request-shot", "BOM request screenshotId mismatch");
    assert(bomResult.detections.length === 1, "BOM request should parse detections");
    assert(bomResult.detections[0].id === "bom-save", "BOM request detection mismatch");
    assert(bomResult.error === undefined, `BOM request should not fail JSON parse: ${bomResult.error}`);

    const zeroMaxDetectionsResult = await runWorkerWithRequest(dir, {
      imagePath,
      screenshotId: "zero-max-detections-shot",
      modelPath,
      runtime: "onnxruntime",
      maxDetections: 0,
      minConfidence: 0.5,
      rawDetections: [
        { id: "save-zero", label: "button", confidence: 0.92, box: { x: 10, y: 20, width: 30, height: 40 } },
      ],
      timeoutMs: 120,
    });
    assert(zeroMaxDetectionsResult.detections.length === 0, "maxDetections=0 should not return detections");
    assert(zeroMaxDetectionsResult.diagnostics.rawDetectionCount === 1, "zero max raw diagnostic count mismatch");
    assert(zeroMaxDetectionsResult.diagnostics.adaptedDetectionCount === 0, "zero max adapted diagnostic count mismatch");

    const strictNmsResult = await runWorkerWithRequest(dir, {
      imagePath,
      screenshotId: "strict-nms-shot",
      modelPath,
      runtime: "onnxruntime",
      minConfidence: 0.5,
      iouThreshold: 0.1,
      rawDetections: [
        { id: "overlap-a", label: "button", confidence: 0.9, box: { x: 10, y: 10, width: 40, height: 40 } },
        { id: "overlap-b", label: "button", confidence: 0.8, box: { x: 20, y: 20, width: 40, height: 40 } },
      ],
      timeoutMs: 120,
    });
    assert(strictNmsResult.detections.length === 1, "strict iouThreshold should suppress overlapping boxes");
    assert(strictNmsResult.detections[0].id === "overlap-a", "strict NMS should keep highest confidence box");

    const looseNmsResult = await runWorkerWithRequest(dir, {
      imagePath,
      screenshotId: "loose-nms-shot",
      modelPath,
      runtime: "onnxruntime",
      minConfidence: 0.5,
      iouThreshold: 0.9,
      rawDetections: [
        { id: "overlap-a", label: "button", confidence: 0.9, box: { x: 10, y: 10, width: 40, height: 40 } },
        { id: "overlap-b", label: "button", confidence: 0.8, box: { x: 20, y: 20, width: 40, height: 40 } },
      ],
      timeoutMs: 120,
    });
    assert(looseNmsResult.detections.length === 2, "loose iouThreshold should keep moderately overlapping boxes");

    const clampedNmsResult = await runWorkerWithRequest(dir, {
      imagePath,
      screenshotId: "clamped-nms-shot",
      modelPath,
      runtime: "onnxruntime",
      minConfidence: 0.5,
      iouThreshold: 9,
      rawDetections: [
        { id: "same-a", label: "button", confidence: 0.9, box: { x: 10, y: 10, width: 40, height: 40 } },
        { id: "same-b", label: "button", confidence: 0.8, box: { x: 10, y: 10, width: 40, height: 40 } },
      ],
      timeoutMs: 120,
    });
    assert(clampedNmsResult.detections.length === 1, "iouThreshold above 1 should be clamped before NMS");

    const clampedThresholdResult = await runWorkerWithRequest(dir, {
      imagePath,
      screenshotId: "clamped-threshold-shot",
      modelPath,
      runtime: "onnxruntime",
      maxDetections: 500,
      minConfidence: -1,
      rawDetections: [
        { id: "weak-negative-threshold", label: "button", confidence: 0.1, box: { x: 0, y: 0, width: 10, height: 10 } },
        { id: "strong-negative-threshold", label: "button", confidence: 0.9, box: { x: 20, y: 20, width: 10, height: 10 } },
      ],
      timeoutMs: 120,
    });
    assert(clampedThresholdResult.detections.length === 1, "negative minConfidence should fall back to default threshold");
    assert(clampedThresholdResult.detections[0].id === "strong-negative-threshold", "threshold fallback should keep strong detection only");

    const clampedMaxDetectionsResult = await runWorkerWithRequest(dir, {
      imagePath,
      screenshotId: "clamped-max-detections-shot",
      modelPath,
      runtime: "onnxruntime",
      maxDetections: 500,
      minConfidence: 0.5,
      rawDetections: Array.from({ length: 150 }, (_, index) => ({
        id: `max-det-${index}`,
        label: "button",
        confidence: 0.99 - index * 0.001,
        box: { x: index % 100, y: Math.floor(index / 100) * 20, width: 1, height: 1 },
      })),
      timeoutMs: 120,
    });
    assert(clampedMaxDetectionsResult.detections.length === 100, "maxDetections should be clamped to worker output limit");

    const missingModelPathResult = await runWorkerWithRequest(dir, {
      imagePath,
      screenshotId: "missing-model-path-shot",
      runtime: "onnxruntime",
      timeoutMs: 120,
    });
    assert(missingModelPathResult.screenshotId === "missing-model-path-shot", "missing modelPath screenshotId mismatch");
    assert(missingModelPathResult.detections.length === 0, "missing modelPath should not detect");
    assert(missingModelPathResult.error.includes("modelPath is missing"), "missing modelPath should be explicit");

    const missingModelFileResult = await runWorkerWithRequest(dir, {
      imagePath,
      screenshotId: "missing-model-file-shot",
      modelPath: join(dir, "missing.onnx"),
      runtime: "onnxruntime",
      timeoutMs: 120,
    });
    assert(missingModelFileResult.screenshotId === "missing-model-file-shot", "missing model file screenshotId mismatch");
    assert(missingModelFileResult.detections.length === 0, "missing model file should not detect");
    assert(missingModelFileResult.error.includes("modelPath does not exist"), "missing model file should be explicit");
    assert(missingModelFileResult.error.includes("missing.onnx"), "missing model file should include filename");
    assert(!missingModelFileResult.error.includes(dir), "missing model file error should not leak full path");

    const defaultOnnxAdapterResult = await runWorkerWithRequest(dir, {
      imagePath,
      screenshotId: "default-onnx-adapter-shot",
      modelPath,
      runtime: "onnxruntime",
      timeoutMs: 120,
    });
    assert(defaultOnnxAdapterResult.screenshotId === "default-onnx-adapter-shot", "default ONNX adapter screenshotId mismatch");
    assert(defaultOnnxAdapterResult.detections.length === 0, "invalid placeholder model should not detect");
    assert(
      defaultOnnxAdapterResult.error.includes("local vision runtime adapter failed"),
      `invalid placeholder model should return adapter failure: ${defaultOnnxAdapterResult.error}`,
    );

    const adapterResult = await runWorkerWithRequest(dir, {
      imagePath,
      screenshotId: "adapter-shot",
      modelPath,
      runtime: "auto",
      minConfidence: 0.5,
      runtimeAdapterPath: adapterPath,
      timeoutMs: 120,
    });
    assert(adapterResult.screenshotId === "adapter-shot", "adapter result screenshotId mismatch");
    assert(adapterResult.detections.length === 1, "adapter raw detections should be filtered");
    assert(adapterResult.detections[0].id === "adapter-save", "adapter detection mismatch");
    assert(adapterResult.detections[0].box.screenshotSize.width === 100, "adapter detection screenshot width mismatch");
    assert(adapterResult.runtime === "onnxruntime", "adapter selected runtime mismatch");
    assert(JSON.stringify(adapterResult.diagnostics.outputDims) === JSON.stringify([1, 6, 8400]), "adapter diagnostics output dims mismatch");
    assert(adapterResult.diagnostics.imgsz === 640, "adapter default imgsz mismatch");
    assert(adapterResult.diagnostics.maxDetections === 20, "adapter default maxDetections mismatch");
    assert(adapterResult.diagnostics.minConfidence === 0.5, "adapter minConfidence should preserve request value");
    assert(adapterResult.diagnostics.iouThreshold === 0.45, "adapter default iouThreshold mismatch");
    assert(adapterResult.diagnostics.timeoutMs === 120, "adapter timeoutMs mismatch");
    assert(adapterResult.diagnostics.rawDetectionCount === 2, "adapter raw diagnostic count mismatch");
    assert(adapterResult.diagnostics.adaptedDetectionCount === 1, "adapter adapted diagnostic count mismatch");
    assert(adapterResult.diagnostics.rawNote === "[redacted image data]", "adapter diagnostics should redact image data URLs");
    assert(adapterResult.diagnostics["[redacted image key]"] === "safe value", "adapter diagnostics should redact image data URL keys");
    assert(!JSON.stringify(adapterResult.diagnostics).includes("KEY_SHOULD_NOT_SURVIVE"), "adapter diagnostic keys should not leak image data");
    assert(adapterResult.diagnostics.veryLong.length <= 160, "adapter diagnostics should truncate long strings");
    assert(
      adapterResult.error === undefined,
      `adapter success should not include error: ${adapterResult.error}`,
    );

    const normalizedAdapterRequestResult = await runWorkerWithRequest(dir, {
      imagePath,
      screenshotId: "adapter-shot",
      modelPath,
      runtime: "onnxruntime",
      imgsz: 9999,
      maxDetections: 999,
      minConfidence: -1,
      iouThreshold: 9,
      runtimeAdapterPath: adapterPath,
      timeoutMs: -1,
    });
    assert(normalizedAdapterRequestResult.detections.length === 1, "normalized adapter request should still detect strong candidate");
    assert(normalizedAdapterRequestResult.diagnostics.imgsz === 1280, "worker should cap adapter imgsz");
    assert(normalizedAdapterRequestResult.diagnostics.maxDetections === 100, "worker should cap adapter maxDetections");
    assert(normalizedAdapterRequestResult.diagnostics.minConfidence === 0.25, "worker should normalize adapter minConfidence");
    assert(normalizedAdapterRequestResult.diagnostics.iouThreshold === 0.45, "worker should normalize adapter iouThreshold");
    assert(normalizedAdapterRequestResult.diagnostics.timeoutMs === 20, "worker should clamp adapter timeoutMs");

    const timedOutAdapterResult = await runWorkerWithRequest(dir, {
      imagePath,
      screenshotId: "timed-out-adapter-shot",
      modelPath,
      runtime: "onnxruntime",
      runtimeAdapterPath: timedOutAdapterPath,
      timeoutMs: 120,
    });
    assert(timedOutAdapterResult.screenshotId === "timed-out-adapter-shot", "timed-out adapter screenshotId mismatch");
    assert(timedOutAdapterResult.timedOut === true, "timed-out adapter should set timedOut=true");
    assert(timedOutAdapterResult.detections.length === 0, "timed-out adapter detections must be dropped");
    assert(timedOutAdapterResult.diagnostics.rawDetectionCount === 1, "timed-out adapter raw diagnostic count mismatch");
    assert(timedOutAdapterResult.diagnostics.adaptedDetectionCount === 0, "timed-out adapter adapted diagnostic count mismatch");
    assert(timedOutAdapterResult.error.includes("adapter exceeded timeout budget"), "timed-out adapter error mismatch");

    const hangingAdapterResult = await runWorkerWithRequest(dir, {
      imagePath,
      screenshotId: "hanging-adapter-shot",
      modelPath,
      runtime: "onnxruntime",
      runtimeAdapterPath: hangingAdapterPath,
      timeoutMs: 20,
    });
    assert(hangingAdapterResult.screenshotId === "hanging-adapter-shot", "hanging adapter screenshotId mismatch");
    assert(hangingAdapterResult.timedOut === true, "hanging adapter should set timedOut=true");
    assert(hangingAdapterResult.detections.length === 0, "hanging adapter detections must be empty");
    assert(hangingAdapterResult.error.includes("timed out after 20ms"), "hanging adapter timeout error mismatch");

    const errorAdapterResult = await runWorkerWithRequest(dir, {
      imagePath,
      screenshotId: "error-adapter-shot",
      modelPath,
      runtime: "onnxruntime",
      runtimeAdapterPath: errorAdapterPath,
      timeoutMs: 120,
    });
    assert(errorAdapterResult.screenshotId === "error-adapter-shot", "error adapter screenshotId mismatch");
    assert(errorAdapterResult.timedOut === false, "error adapter should not set timedOut=true");
    assert(errorAdapterResult.detections.length === 0, "error adapter detections must be dropped");
    assert(errorAdapterResult.diagnostics.rawDetectionCount === 1, "error adapter raw diagnostic count mismatch");
    assert(errorAdapterResult.diagnostics.adaptedDetectionCount === 0, "error adapter adapted diagnostic count mismatch");
    assert(errorAdapterResult.error.includes("adapter failed after partial output"), "error adapter error mismatch");

    const excessiveAdapterResult = await runWorkerWithRequest(dir, {
      imagePath,
      screenshotId: "excessive-adapter-shot",
      modelPath,
      runtime: "onnxruntime",
      runtimeAdapterPath: excessiveAdapterPath,
      timeoutMs: 120,
    });
    assert(excessiveAdapterResult.screenshotId === "excessive-adapter-shot", "excessive adapter screenshotId mismatch");
    assert(excessiveAdapterResult.timedOut === false, "excessive adapter should not set timedOut=true");
    assert(excessiveAdapterResult.detections.length === 0, "excessive adapter detections must be dropped");
    assert(excessiveAdapterResult.diagnostics.rawDetectionCount === 20001, "excessive adapter raw diagnostic count mismatch");
    assert(excessiveAdapterResult.diagnostics.adaptedDetectionCount === 0, "excessive adapter adapted diagnostic count mismatch");
    assert(excessiveAdapterResult.error.includes("raw detections exceed"), "excessive adapter error mismatch");

    const noisyAdapterResult = await runWorkerWithRequest(dir, {
      imagePath,
      screenshotId: "noisy-adapter-shot",
      modelPath,
      runtime: "onnxruntime",
      runtimeAdapterPath: noisyAdapterPath,
      timeoutMs: 120,
    });
    assert(noisyAdapterResult.error.includes("stdout exceeded"), "noisy adapter output should be bounded");

    const pathErrorAdapterResult = await runWorkerWithRequest(dir, {
      imagePath,
      screenshotId: "path-error-adapter-shot",
      modelPath,
      runtime: "onnxruntime",
      runtimeAdapterPath: pathErrorAdapterPath,
      timeoutMs: 120,
    });
    const pathErrorSerialized = JSON.stringify(pathErrorAdapterResult);
    assert(pathErrorAdapterResult.detections.length === 0, "path error adapter detections must be dropped");
    assert(pathErrorSerialized.includes("[redacted local path:runtime-adapter.mjs]"), "adapter error path should be redacted to filename");
    assert(pathErrorSerialized.includes("[redacted local path:model-cache.bin]"), "diagnostic cache path should be redacted to filename");
    assert(!pathErrorSerialized.includes("alice"), "path error output should not leak usernames");
    assert(!pathErrorSerialized.includes("C:\\\\Users"), "path error output should not leak Windows paths");
    assert(!pathErrorSerialized.includes("/home/alice"), "path error output should not leak Unix paths");

    const spacedPathResult = await runWorkerWithRequest(dir, {
      imagePath,
      screenshotId: "spaced-path-shot",
      modelPath,
      runtime: "onnxruntime",
      rawDetections: [{
        id: "det_data:image/png;base64,ID_SHOULD_NOT_SURVIVE==_C:\\Users\\alice\\My Models\\detector cache.bin",
        label: "button data:image/png;base64,LABEL_SHOULD_NOT_SURVIVE== C:\\Users\\alice\\My Models\\button label.txt",
        confidence: 0.99,
        box: { x: 10, y: 10, width: 20, height: 20 },
      }],
      timedOut: false,
      error: "adapter log C:\\Users\\alice\\My Models\\runtime adapter.mjs kept message",
      timeoutMs: 120,
    });
    const spacedPathSerialized = JSON.stringify(spacedPathResult);
    assert(spacedPathResult.detections.length === 0, "error raw detections with spaced paths must be dropped");
    assert(spacedPathSerialized.includes("[redacted local path:runtime adapter.mjs]"), "spaced adapter path should be redacted");
    assert(!spacedPathSerialized.includes("My Models"), "spaced path output should not leak folder names");
    assert(!spacedPathSerialized.includes("ID_SHOULD_NOT_SURVIVE"), "spaced path output should not leak image data from dropped detections");
    assert(!spacedPathSerialized.includes("LABEL_SHOULD_NOT_SURVIVE"), "spaced path output should not leak label image data from dropped detections");

    const spacedDetectionResult = await runWorkerWithRequest(dir, {
      imagePath,
      screenshotId: "spaced-detection-shot",
      modelPath,
      runtime: "onnxruntime",
      rawDetections: [{
        id: "det_data:image/png;base64,ID_SHOULD_NOT_SURVIVE==_C:\\Users\\alice\\My Models\\detector cache.bin",
        label: "button data:image/png;base64,LABEL_SHOULD_NOT_SURVIVE== C:\\Users\\alice\\My Models\\button label.txt",
        confidence: 0.99,
        box: { x: 10, y: 10, width: 20, height: 20 },
      }],
      timeoutMs: 120,
    });
    const spacedDetectionSerialized = JSON.stringify(spacedDetectionResult);
    assert(spacedDetectionResult.detections.length === 1, "spaced detection should survive without error");
    assert(spacedDetectionSerialized.includes("[redacted local path:detector cache.bin]"), "detection id path should be redacted");
    assert(spacedDetectionSerialized.includes("[redacted local path:button label.txt]"), "detection label path should be redacted");
    assert(!spacedDetectionSerialized.includes("My Models"), "detection output should not leak spaced folder names");
    assert(!spacedDetectionSerialized.includes("ID_SHOULD_NOT_SURVIVE"), "detection id should not leak image data");
    assert(!spacedDetectionSerialized.includes("LABEL_SHOULD_NOT_SURVIVE"), "detection label should not leak image data");

    const timedOutRawRequestResult = await runWorkerWithRequest(dir, {
      imagePath,
      screenshotId: "timed-out-raw-request-shot",
      modelPath,
      runtime: "onnxruntime",
      rawDetections: [{
        id: "raw-timeout-save",
        label: "button",
        confidence: 0.99,
        box: { x: 10, y: 10, width: 20, height: 20 },
      }],
      timedOut: true,
      error: "request timed out after partial detections",
      timeoutMs: 120,
    });
    assert(timedOutRawRequestResult.screenshotId === "timed-out-raw-request-shot", "timed-out raw request screenshotId mismatch");
    assert(timedOutRawRequestResult.timedOut === true, "timed-out raw request should set timedOut=true");
    assert(timedOutRawRequestResult.detections.length === 0, "timed-out raw request detections must be dropped");
    assert(timedOutRawRequestResult.diagnostics.rawDetectionCount === 1, "timed-out raw request raw diagnostic count mismatch");
    assert(timedOutRawRequestResult.diagnostics.adaptedDetectionCount === 0, "timed-out raw request adapted diagnostic count mismatch");
    assert(timedOutRawRequestResult.error.includes("partial detections"), "timed-out raw request error mismatch");

    const oversizedImagePath = join(dir, "oversized-screen.png");
    await writeFile(oversizedImagePath, createPngHeader(20000, 20000));
    const oversizedImageResult = await runWorkerWithRequest(dir, {
      imagePath: oversizedImagePath,
      screenshotId: "oversized-image-shot",
      modelPath,
      runtime: "onnxruntime",
      timeoutMs: 120,
    });
    assert(oversizedImageResult.screenshotId === "oversized-image-shot", "oversized image screenshotId mismatch");
    assert(oversizedImageResult.detections.length === 0, "oversized image must not detect");
    assert(oversizedImageResult.error.includes("image exceeds"), "oversized image error mismatch");

    const oversizedRequestPath = join(dir, "request-oversized.json");
    await writeFile(oversizedRequestPath, JSON.stringify({
      imagePath,
      screenshotId: "oversized-request-shot",
      modelPath,
      runtime: "onnxruntime",
      rawDetections: [],
      padding: "x".repeat(600 * 1024),
    }));
    const oversizedRequestResult = await runWorker(oversizedRequestPath);
    assert(oversizedRequestResult.screenshotId === "", "oversized request should not trust screenshotId");
    assert(oversizedRequestResult.detections.length === 0, "oversized request must not detect");
    assert(oversizedRequestResult.error.includes("request JSON exceeds"), "oversized request error mismatch");

    process.stdout.write("local vision worker protocol test passed\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runWorkerWithRequest(dir, request) {
  const requestPath = join(dir, `request-${request.screenshotId}.json`);
  await writeFile(requestPath, JSON.stringify(request));
  return runWorker(requestPath);
}

function runWorker(requestPath) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [workerPath, requestPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const startedAt = Date.now();
    let settled = false;
    let stdout = "";
    let stderr = "";
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`worker test timed out after ${WORKER_TEST_TIMEOUT_MS}ms`));
    }, WORKER_TEST_TIMEOUT_MS);
    const settleWithBoundedOutputError = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      child.kill();
      resolveResult({
        screenshotId: "",
        detections: [],
        latencyMs: Math.max(0, Date.now() - startedAt),
        model: "unknown",
        runtime: "unknown",
        timedOut: false,
        error,
      });
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > MAX_WORKER_STDOUT_BYTES) {
        settleWithBoundedOutputError(`local vision worker stdout exceeded ${MAX_WORKER_STDOUT_BYTES} bytes`);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr, "utf8") > MAX_WORKER_STDERR_BYTES) {
        settleWithBoundedOutputError(`local vision worker stderr exceeded ${MAX_WORKER_STDERR_BYTES} bytes`);
      }
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (code !== 0) {
        reject(new Error(`worker exited with ${code}: ${stderr}`));
        return;
      }
      try {
        resolveResult(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`worker stdout was not JSON: ${stdout}\n${error}`));
      }
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
