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

  const imagePath = requiredPath(args.image, "--image");
  const modelPath = requiredPath(args.model, "--model");
  const runtime = parseRuntime(args.runtime);
  if (!runtime) {
    throw new Error(`unsupported runtime: ${args.runtime}; expected auto, onnxruntime, openvino, or tensorrt`);
  }
  const iterations = integerOrDefault(args.iterations, 20);
  const warmup = nonNegativeIntegerOrDefault(args.warmup, 1);
  const maxErrorCount = nonNegativeIntegerOrDefault(args.maxErrorCount, 0);
  const minDetections = nonNegativeIntegerOrDefault(args.minDetections, 0);
  const maxP95Ms = optionalNumber(args.maxP95Ms);
  const runConfig = benchmarkRunConfig(args, runtime);
  const dir = await mkdtemp(join(tmpdir(), "javis-local-vision-benchmark-"));
  const latencies = [];
  const detectionCounts = [];
  const runtimes = [];
  const models = [];
  const observedInputSizes = [];
  const observedRequestedInputSizes = [];
  const observedInputSizeSources = [];
  const errors = [];
  let workerServer;

  try {
    if (args.reuseWorker === true) {
      workerServer = startWorkerServer();
    }
    for (let index = 0; index < warmup + iterations; index += 1) {
      const result = await runOnce({
        dir,
        imagePath,
        modelPath,
        runConfig,
        index,
        workerServer,
      });
      if (index < warmup) continue;
      latencies.push(numberOrDefault(result.latencyMs, 0));
      const detections = detectionCount(result);
      detectionCounts.push(detections);
      runtimes.push(safeRuntimeLabel(result?.runtime));
      models.push(safePathLabel(result?.model || "unknown"));
      observedInputSizes.push(safeNumericLabel(result?.diagnostics?.inputSize));
      observedRequestedInputSizes.push(safeNumericLabel(result?.diagnostics?.requestedInputSize));
      observedInputSizeSources.push(safeInputSizeSourceLabel(result?.diagnostics?.inputSizeSource));
      const error = resultErrorReason(result, minDetections);
      if (error) {
        errors.push({
          iteration: index - warmup + 1,
          type: resultErrorType(result, minDetections),
          detectionCount: detections,
          timedOut: result?.timedOut === true,
          error,
        });
      }
    }

    const report = buildReport({
      imagePath,
      modelPath,
      iterations,
      warmup,
      latencies,
      detectionCounts,
      runtimes,
      models,
      observedInputSizes,
      observedRequestedInputSizes,
      observedInputSizeSources,
      errors,
      maxP95Ms,
      maxErrorCount,
      minDetections,
      reuseWorker: args.reuseWorker === true,
      runConfig,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.passed) {
      process.exitCode = 2;
    }
  } finally {
    workerServer?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

function benchmarkRunConfig(args, runtime) {
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

async function runOnce({ dir, imagePath, modelPath, runConfig, index, workerServer }) {
  const requestPath = join(dir, `request-${index + 1}.json`);
  await writeFile(requestPath, JSON.stringify({
    imagePath,
    screenshotId: `benchmark-${Date.now()}-${index + 1}-${basename(imagePath)}`,
    modelPath,
    runtime: runConfig.runtime,
    imgsz: runConfig.imgsz,
    maxDetections: runConfig.maxDetections,
    minConfidence: runConfig.minConfidence,
    iouThreshold: runConfig.iouThreshold,
    timeoutMs: runConfig.timeoutMs,
    ...(runConfig.runtimeAdapterPath ? { runtimeAdapterPath: runConfig.runtimeAdapterPath } : {}),
  }));
  if (workerServer) {
    return workerServer.run(requestPath, runConfig.timeoutMs);
  }
  return runWorker(requestPath, runConfig.timeoutMs);
}

function buildReport({
  imagePath,
  modelPath,
  iterations,
  warmup,
  latencies,
  detectionCounts,
  runtimes,
  models,
  observedInputSizes,
  observedRequestedInputSizes,
  observedInputSizeSources,
  errors,
  maxP95Ms,
  maxErrorCount,
  minDetections,
  reuseWorker,
  runConfig,
}) {
  const sorted = [...latencies].sort((left, right) => left - right);
  const p50 = percentile(sorted, 0.5);
  const p95 = percentile(sorted, 0.95);
  const max = sorted[sorted.length - 1] ?? 0;
  const sortedDetectionCounts = [...detectionCounts].sort((left, right) => left - right);
  const budgetFailures = [];
  if (maxP95Ms !== undefined && p95 > maxP95Ms) {
    budgetFailures.push(`p95 ${p95}ms exceeds ${maxP95Ms}ms`);
  }
  if (errors.length > maxErrorCount) {
    budgetFailures.push(`errorCount ${errors.length} exceeds ${maxErrorCount}`);
  }
  const failureBreakdown = summarizeBenchmarkFailures(errors, detectionCounts, iterations);
  return {
    image: safePathLabel(imagePath),
    model: safePathLabel(modelPath),
    warnings: modelPurposeWarnings(modelPath),
    configuration: {
      runtime: runConfig.runtime,
      imgsz: runConfig.imgsz,
      maxDetections: runConfig.maxDetections,
      minConfidence: runConfig.minConfidence,
      iouThreshold: runConfig.iouThreshold,
      timeoutMs: runConfig.timeoutMs,
      runtimeAdapter: runConfig.runtimeAdapterPath ? safePathLabel(runConfig.runtimeAdapterPath) : undefined,
    },
    iterations,
    warmup,
    latencyMs: {
      p50,
      p95,
      max,
      samples: latencies,
    },
    detectionCount: {
      p50: percentile(sortedDetectionCounts, 0.5),
      p95: percentile(sortedDetectionCounts, 0.95),
      max: sortedDetectionCounts[sortedDetectionCounts.length - 1] ?? 0,
      samples: detectionCounts,
    },
    runtimeCounts: countSamples(runtimes),
    modelCounts: countSamples(models),
    inputSizeCounts: countSamples(observedInputSizes),
    requestedInputSizeCounts: countSamples(observedRequestedInputSizes),
    inputSizeSourceCounts: countSamples(observedInputSizeSources),
    errorCount: errors.length,
    failureBreakdown,
    errors: errors.slice(0, 5),
    budgets: {
      maxP95Ms,
      maxErrorCount,
      minDetections,
    },
    worker: {
      reused: reuseWorker,
    },
    passed: budgetFailures.length === 0,
    budgetFailures,
  };
}

function countSamples(values) {
  const counts = {};
  for (const value of values) {
    const key = String(value || "unknown");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function modelPurposeWarnings(modelPath) {
  const label = safePathLabel(modelPath);
  return /^yolo26[nsmlx]\.(?:pt|onnx)$/i.test(label)
    ? [`${label} matches an official Ultralytics YOLO26 COCO weight name; use it for smoke/benchmark only, not as a UI-trained production model`]
    : [];
}

function summarizeBenchmarkFailures(errors, detectionCounts, iterations) {
  const byType = {
    timeout: 0,
    workerError: 0,
    minDetections: 0,
  };
  for (const error of errors) {
    if (error.type === "timeout") {
      byType.timeout += 1;
    } else if (error.type === "min_detections") {
      byType.minDetections += 1;
    } else {
      byType.workerError += 1;
    }
  }
  return {
    successfulSamples: Math.max(0, iterations - errors.length),
    timeoutCount: byType.timeout,
    workerErrorCount: byType.workerError,
    minDetectionFailureCount: byType.minDetections,
    zeroDetectionSamples: detectionCounts.filter((count) => count === 0).length,
  };
}

function percentile(sorted, quantile) {
  if (sorted.length === 0) return 0;
  const index = Math.ceil(sorted.length * quantile) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, index))];
}

function resultErrorReason(result, minDetections = 0) {
  if (result?.timedOut === true) {
    return typeof result.error === "string" && result.error.trim()
      ? result.error
      : "local vision worker reported timedOut=true";
  }
  return typeof result?.error === "string" && result.error.trim()
    ? result.error
    : minDetections > 0 && detectionCount(result) < minDetections
      ? `detectionCount ${detectionCount(result)} is below minDetections ${minDetections}`
      : undefined;
}

function resultErrorType(result, minDetections = 0) {
  if (result?.timedOut === true) return "timeout";
  if (typeof result?.error === "string" && result.error.trim()) return "worker_error";
  return minDetections > 0 && detectionCount(result) < minDetections
    ? "min_detections"
    : "worker_error";
}

function detectionCount(result) {
  return Array.isArray(result?.detections) ? result.detections.length : 0;
}

function safeRuntimeLabel(value) {
  return value === "onnxruntime" || value === "openvino" || value === "tensorrt" || value === "unknown"
    ? value
    : "unknown";
}

function safeInputSizeSourceLabel(value) {
  return value === "model" || value === "request" ? value : "unknown";
}

function safeNumericLabel(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : "unknown";
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
    if (arg === "--reuse-worker") {
      args.reuseWorker = true;
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

function startWorkerServer() {
  const child = spawn(process.execPath, [workerPath, "--server"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = [];
  let stdout = "";
  let stderr = "";
  let disposed = false;
  let closed = false;
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    let newlineIndex;
    while ((newlineIndex = stdout.indexOf("\n")) >= 0) {
      const line = stdout.slice(0, newlineIndex).trim();
      stdout = stdout.slice(newlineIndex + 1);
      const next = pending.shift();
      if (!next) continue;
      next.finishWithLine(line);
    }
    if (Buffer.byteLength(stdout, "utf8") > MAX_WORKER_STDOUT_BYTES) {
      failPending(`local vision worker stdout exceeded ${MAX_WORKER_STDOUT_BYTES} bytes`);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (Buffer.byteLength(stderr, "utf8") > MAX_WORKER_STDERR_BYTES) {
      failPending(`local vision worker stderr exceeded ${MAX_WORKER_STDERR_BYTES} bytes`);
    }
  });
  child.on("error", (error) => {
    closed = true;
    failPending(error.message);
  });
  child.on("close", (code) => {
    closed = true;
    if (!disposed && pending.length > 0) {
      failPending(`local vision worker server exited with ${code}: ${stderr}`);
    }
  });

  function failPending(error) {
    while (pending.length > 0) {
      pending.shift()?.finishWithError(error);
    }
    child.kill();
  }

  return {
    run(requestPath, timeoutMs) {
      return new Promise((resolveResult) => {
        const startedAt = Date.now();
        const errorResult = (error, timedOut = false) => ({
          screenshotId: "",
          detections: [],
          latencyMs: Math.max(0, Date.now() - startedAt),
          model: "unknown",
          runtime: "unknown",
          timedOut,
          error: sanitizeLocalVisionText(error, 320),
        });
        if (closed || !child.stdin.writable) {
          resolveResult(errorResult("local vision worker server is not available"));
          return;
        }
        let settled = false;
        let entry;
        const timeoutId = setTimeout(() => {
          if (settled) return;
          settled = true;
          const index = pending.indexOf(entry);
          if (index >= 0) pending.splice(index, 1);
          child.kill();
          closed = true;
          resolveResult(errorResult(`local vision worker timed out after ${timeoutMs}ms`, true));
        }, timeoutMs);
        entry = {
          finishWithLine(line) {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            try {
              resolveResult(JSON.parse(line));
            } catch (error) {
              resolveResult({
                screenshotId: "",
                detections: [],
                latencyMs: Math.max(0, Date.now() - startedAt),
                model: "unknown",
                runtime: "unknown",
                timedOut: false,
                error: sanitizeLocalVisionText(`worker stdout was not JSON: ${line}\n${error}`, 320),
              });
            }
          },
          finishWithError(error) {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            resolveResult(errorResult(error));
          },
        };
        pending.push(entry);
        child.stdin.write(`${requestPath}\n`, (error) => {
          if (!error) return;
          const index = pending.indexOf(entry);
          if (index >= 0) pending.splice(index, 1);
          entry.finishWithError(`failed to write local vision worker request: ${error.message}`);
        });
      });
    },
    dispose() {
      disposed = true;
      closed = true;
      child.stdin.end();
      child.kill();
    },
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

function safePathLabel(value) {
  return basename(String(value).replace(/\\/g, "/")) || "[redacted local path]";
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

function optionalNumber(value) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`expected a number, got ${value}`);
  }
  return parsed;
}

function helpText() {
  return `Usage: node scripts/local-vision-benchmark.mjs --image <screen.png> --model <model-file> [options]

Options:
  --runtime <auto|onnxruntime|openvino|tensorrt>  Runtime preference. Default: onnxruntime
  --imgsz <number>                               Model input size. Default: 640
  --max-detections <number>                      Max detections. Default: 20
  --min-detections <number>                      Count samples with fewer detections as errors. Default: 0
  --min-confidence <number>                      Confidence threshold. Default: 0.75
  --iou-threshold <number>                       NMS IoU threshold. Default: 0.45
  --timeout-ms <number>                          Worker timeout metadata. Default: 2000
  --adapter <path>                               Override runtime adapter module.
  --iterations <number>                          Measured iterations. Default: 20
  --warmup <number>                              Warmup iterations. Default: 1
  --reuse-worker                                 Reuse one worker process across all iterations.
  --max-p95-ms <number>                          Fail with exit code 2 if p95 exceeds this budget.
  --max-error-count <number>                     Fail with exit code 2 if errors exceed this budget. Default: 0
`;
}

main().catch((error) => {
  process.stderr.write(`Error: ${sanitizeLocalVisionText(error instanceof Error ? error.message : String(error), 320)}\n`);
  process.exitCode = 1;
});
