#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerPath = resolve(__dirname, "local-vision-worker.mjs");
const MAX_WORKER_STDOUT_BYTES = 1024 * 1024;
const MAX_WORKER_STDERR_BYTES = 64 * 1024;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.75;
const DEFAULT_IOU_THRESHOLD = 0.45;
const DEFAULT_MAX_DETECTIONS = 20;
const MAX_DETECTIONS = 100;
const DEFAULT_TIMEOUT_MS = 2_000;
const MIN_TIMEOUT_MS = 20;
const MAX_TIMEOUT_MS = 2_000;
const DEFAULT_INPUT_SIZE = 640;
const MAX_INPUT_SIZE = 1_280;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(helpText());
    return;
  }
  const runtime = parseRuntime(args.runtime);
  if (!runtime) {
    throw new Error(`unsupported runtime: ${args.runtime}; expected auto, onnxruntime, openvino, or tensorrt`);
  }
  const imagePath = requiredPath(args.image, "--image");
  const modelPath = requiredPath(args.model, "--model");
  const minDetections = nonNegativeIntegerOrDefault(args.minDetections, 0);
  const runConfig = smokeRunConfig(args, runtime);
  const dir = await mkdtemp(join(tmpdir(), "javis-local-vision-smoke-"));
  try {
    const requestPath = join(dir, "request.json");
    await writeFile(requestPath, JSON.stringify({
      imagePath,
      screenshotId: `smoke-${Date.now()}-${basename(imagePath)}`,
      modelPath,
      runtime: runConfig.runtime,
      imgsz: runConfig.imgsz,
      maxDetections: runConfig.maxDetections,
      minConfidence: runConfig.minConfidence,
      iouThreshold: runConfig.iouThreshold,
      timeoutMs: runConfig.timeoutMs,
      ...(runConfig.runtimeAdapterPath ? { runtimeAdapterPath: runConfig.runtimeAdapterPath } : {}),
    }));
    const result = await runWorker(requestPath, runConfig.timeoutMs);
    result.warnings = [
      ...(Array.isArray(result.warnings) ? result.warnings : []),
      ...modelPurposeWarnings(modelPath),
    ];
    if (
      !result.error &&
      result.timedOut !== true &&
      minDetections > 0 &&
      detectionCount(result) < minDetections
    ) {
      result.error = `local vision smoke detected ${detectionCount(result)} objects; expected at least ${minDetections}`;
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.error || result.timedOut === true) {
      process.exitCode = 2;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for ${arg}`);
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

function parseRuntime(value) {
  if (value === undefined) {
    return "onnxruntime";
  }
  return value === "auto" || value === "onnxruntime" || value === "openvino" || value === "tensorrt"
    ? value
    : null;
}

function requiredPath(value, label) {
  if (!value) throw new Error(`${label} is required`);
  const path = resolve(value);
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${safePathLabel(path)}`);
  return path;
}

function smokeRunConfig(args, runtime) {
  return {
    runtime,
    imgsz: normalizeInputSize(args.imgsz),
    maxDetections: normalizeMaxDetections(args.maxDetections),
    minConfidence: normalizeConfidenceThreshold(args.minConfidence),
    iouThreshold: normalizeIouThreshold(args.iouThreshold),
    timeoutMs: normalizeTimeoutMs(args.timeoutMs),
    runtimeAdapterPath: args.adapter ? resolve(args.adapter) : undefined,
  };
}

function runWorker(requestPath, timeoutMs) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [workerPath, requestPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const startedAt = Date.now();
    let settled = false;
    let stdout = "";
    let stderr = "";
    const settleWithError = (error) => {
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
        error: sanitizeLocalVisionText(error, 320),
      });
    };
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolveResult({
        screenshotId: "",
        detections: [],
        latencyMs: Math.max(0, Date.now() - startedAt),
        model: "unknown",
        runtime: "unknown",
        timedOut: true,
        error: `local vision worker timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > MAX_WORKER_STDOUT_BYTES) {
        settleWithError(`local vision worker stdout exceeded ${MAX_WORKER_STDOUT_BYTES} bytes`);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr, "utf8") > MAX_WORKER_STDERR_BYTES) {
        settleWithError(`local vision worker stderr exceeded ${MAX_WORKER_STDERR_BYTES} bytes`);
      }
    });
    child.on("error", (error) => {
      settleWithError(`failed to start local vision worker: ${error.message}`);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (code !== 0) {
        resolveResult({
          screenshotId: "",
          detections: [],
          latencyMs: Math.max(0, Date.now() - startedAt),
          model: "unknown",
          runtime: "unknown",
          timedOut: false,
          error: sanitizeLocalVisionText(`worker exited with ${code}: ${stderr}`, 320),
        });
        return;
      }
      try {
        resolveResult(JSON.parse(stdout));
      } catch (error) {
        resolveResult({
          screenshotId: "",
          detections: [],
          latencyMs: Math.max(0, Date.now() - startedAt),
          model: "unknown",
          runtime: "unknown",
          timedOut: false,
          error: sanitizeLocalVisionText(`worker stdout was not JSON: ${stdout}\n${error}`, 320),
        });
      }
    });
  });
}

function integerOrDefault(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.trunc(parsed)) : fallback;
}

function nonNegativeIntegerOrDefault(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : fallback;
}

function numberOrDefault(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeTimeoutMs(value) {
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(numberOrDefault(value, DEFAULT_TIMEOUT_MS))));
}

function normalizeInputSize(value) {
  return Math.min(MAX_INPUT_SIZE, integerOrDefault(value, DEFAULT_INPUT_SIZE));
}

function normalizeIouThreshold(value) {
  const threshold = numberOrDefault(value, DEFAULT_IOU_THRESHOLD);
  return threshold >= 0 && threshold <= 1 ? threshold : DEFAULT_IOU_THRESHOLD;
}

function normalizeConfidenceThreshold(value) {
  const threshold = numberOrDefault(value, DEFAULT_CONFIDENCE_THRESHOLD);
  return threshold >= 0 && threshold <= 1 ? threshold : DEFAULT_CONFIDENCE_THRESHOLD;
}

function normalizeMaxDetections(value) {
  return Math.min(MAX_DETECTIONS, Math.max(0, Math.trunc(numberOrDefault(value, DEFAULT_MAX_DETECTIONS))));
}

function detectionCount(result) {
  return Array.isArray(result?.detections) ? result.detections.length : 0;
}

function safePathLabel(value) {
  return basename(String(value).replace(/\\/g, "/")) || "[redacted local path]";
}

function modelPurposeWarnings(modelPath) {
  const label = safePathLabel(modelPath);
  return /^yolo26[nsmlx]\.(?:pt|onnx)$/i.test(label)
    ? [`${label} matches an official Ultralytics YOLO26 COCO weight name; use it for smoke/benchmark only, not as a UI-trained production model`]
    : [];
}

function sanitizeLocalVisionText(value, maxLength) {
  const redacted = String(value).replace(
    /(?:file:\/\/\/[^\s"'`<>()[\]{}]+|[A-Za-z]:[\\/][^\s"'`<>()[\]{}]+|\/(?:Users|home|tmp|var|mnt|Volumes|opt|workspace|private|run|data)\/[^\s"'`<>()[\]{}]+)/g,
    (match) => {
      const filename = safePathLabel(match);
      return filename ? `[redacted local path:${filename}]` : "[redacted local path]";
    },
  );
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength - 3)}...` : redacted;
}

function helpText() {
  return `Usage: node scripts/local-vision-smoke.mjs --image <screen.png> --model <model-file> [options]

Options:
  --runtime <auto|onnxruntime|openvino|tensorrt>  Runtime preference. Default: onnxruntime
  --imgsz <number>                               Model input size. Default: 640
  --max-detections <number>                      Max detections. Default: 20
  --min-detections <number>                      Fail unless at least this many detections are returned. Default: 0
  --min-confidence <number>                      Confidence threshold. Default: 0.75
  --iou-threshold <number>                       NMS IoU threshold. Default: 0.45
  --timeout-ms <number>                          Worker timeout metadata. Default: 2000
  --adapter <path>                               Override runtime adapter module.
`;
}

main().catch((error) => {
  process.stderr.write(`Error: ${sanitizeLocalVisionText(error instanceof Error ? error.message : String(error), 320)}\n`);
  process.exitCode = 1;
});
