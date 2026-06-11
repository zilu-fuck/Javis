#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const DEFAULT_CONFIDENCE_THRESHOLD = 0.25;
const DEFAULT_IOU_THRESHOLD = 0.45;
const DEFAULT_MAX_DETECTIONS = 20;
const MAX_DETECTIONS = 100;
const MAX_REQUEST_JSON_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16_000_000;
const MAX_RAW_DETECTIONS = 20_000;
const DEFAULT_TIMEOUT_MS = 120;
const MIN_TIMEOUT_MS = 20;
const MAX_TIMEOUT_MS = 2_000;
const DEFAULT_INPUT_SIZE = 640;
const MAX_INPUT_SIZE = 1_280;
const RUNTIME_ADAPTER_ENV = "JAVIS_LOCAL_VISION_RUNTIME_ADAPTER";
const IMAGE_DATA_URL_PATTERN = /data:image(?:\/|\\\/)[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+/gi;
const LOCAL_VISION_PATH_PATTERN = /(?:file:\/\/\/[^\r\n"'`<>()\[\]{}]+|[A-Za-z]:[\\/][^\r\n"'`<>()\[\]{}]+|\/(?:Users|home|tmp|var|mnt|Volumes|opt|workspace|private|run|data)\/[^\r\n"'`<>()\[\]{}]+)/g;
const LOCAL_VISION_PATH_EXTENSIONS = [".onnx", ".engine", ".xml", ".bin", ".mjs", ".js", ".json", ".png", ".jpg", ".jpeg", ".webp", ".txt"];
const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  if (process.argv[2] === "--self-test") {
    await runSelfTest();
    return;
  }
  if (process.argv[2] === "--server") {
    await runServer();
    return;
  }

  const startedAt = Date.now();
  const requestPath = process.argv[2] || process.env.JAVIS_LOCAL_VISION_REQUEST_PATH;
  const result = await runWorker(requestPath, startedAt);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function runServer() {
  const input = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  for await (const line of input) {
    const requestPath = line.trim();
    if (!requestPath) continue;
    const result = await runWorker(requestPath, Date.now());
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}

async function runWorker(requestPath, startedAt = Date.now()) {
  if (!requestPath) {
    return emptyResult({
      screenshotId: "",
      model: "none",
      runtime: "unknown",
      startedAt,
      error: "local vision request path is missing",
    });
  }

  let request;
  try {
    request = JSON.parse(await readRequestJsonFile(requestPath));
  } catch (error) {
    return emptyResult({
      screenshotId: "",
      model: "none",
      runtime: "unknown",
      startedAt,
      error: `failed to read local vision request: ${errorMessage(error)}`,
    });
  }

  const screenshotId = stringOrEmpty(request.screenshotId);
  const model = safeModelName(request.modelPath);
  const runtime = normalizeRuntime(request.runtime);

  let imageSize;
  try {
    imageSize = validateRequest(request);
  } catch (error) {
    return emptyResult({
      screenshotId,
      model,
      runtime,
      startedAt,
      error: errorMessage(error),
    });
  }

  const rawDetections = Array.isArray(request.rawDetections)
    ? request.rawDetections
    : undefined;
  if (rawDetections) {
    const requestError = typeof request.error === "string" ? request.error : undefined;
    const rawLimitError = rawDetectionsLimitError(rawDetections);
    if (request.timedOut === true || requestError || rawLimitError) {
      return {
        screenshotId,
        detections: [],
        latencyMs: Math.max(0, Date.now() - startedAt),
        model,
        runtime,
        timedOut: request.timedOut === true,
        diagnostics: sanitizeDiagnostics({
          rawDetectionCount: rawDetections.length,
          adaptedDetectionCount: 0,
        }),
        ...(requestError || rawLimitError ? { error: sanitizeLocalVisionText(requestError || rawLimitError, 320) } : {}),
      };
    }
    const detections = adaptRawDetections({
      rawDetections,
      imageSize,
      maxDetections: request.maxDetections,
      minConfidence: request.minConfidence,
      iouThreshold: request.iouThreshold,
      windowHandle: request.windowHandle,
      labelMap: request.labelMap,
    });
    return {
      screenshotId,
      detections,
      latencyMs: Math.max(0, Date.now() - startedAt),
      model,
      runtime,
      timedOut: false,
      diagnostics: {
        rawDetectionCount: rawDetections.length,
        adaptedDetectionCount: detections.length,
      },
    };
  }

  const readinessError = validateInferenceReadiness(request);
  if (readinessError) {
    return emptyResult({
      screenshotId,
      model,
      runtime,
      startedAt,
      error: readinessError,
    });
  }

  try {
    const inference = await runInference(request, imageSize);
    const inferredRawDetections = inference.rawDetections;
    const selectedRuntime = inference.runtime || runtime;
    const rawLimitError = rawDetectionsLimitError(inferredRawDetections);
    if (inference.timedOut) {
      return {
        screenshotId,
        detections: [],
        latencyMs: Math.max(0, Date.now() - startedAt),
        model,
        runtime: selectedRuntime,
        timedOut: true,
        diagnostics: sanitizeDiagnostics({
          ...inference.diagnostics,
          rawDetectionCount: inferredRawDetections.length,
          adaptedDetectionCount: 0,
        }),
        ...(inference.error || rawLimitError ? { error: sanitizeLocalVisionText(inference.error || rawLimitError, 320) } : {}),
      };
    }
    if (inference.error || rawLimitError) {
      return {
        screenshotId,
        detections: [],
        latencyMs: Math.max(0, Date.now() - startedAt),
        model,
        runtime: selectedRuntime,
        timedOut: false,
        diagnostics: sanitizeDiagnostics({
          ...inference.diagnostics,
          rawDetectionCount: inferredRawDetections.length,
          adaptedDetectionCount: 0,
        }),
        error: sanitizeLocalVisionText(inference.error || rawLimitError, 320),
      };
    }
    const detections = adaptRawDetections({
      rawDetections: inferredRawDetections,
      imageSize,
      maxDetections: request.maxDetections,
      minConfidence: request.minConfidence,
      iouThreshold: request.iouThreshold,
      windowHandle: request.windowHandle,
      labelMap: request.labelMap,
    });
    return {
      screenshotId,
      detections,
      latencyMs: Math.max(0, Date.now() - startedAt),
      model,
      runtime: selectedRuntime,
      timedOut: false,
      diagnostics: sanitizeDiagnostics({
        ...inference.diagnostics,
        rawDetectionCount: inferredRawDetections.length,
        adaptedDetectionCount: detections.length,
      }),
    };
  } catch (error) {
    const message = errorMessage(error);
    if (/timed out after \d+ms/i.test(message)) {
      return {
        screenshotId,
        detections: [],
        latencyMs: Math.max(0, Date.now() - startedAt),
        model,
        runtime,
        timedOut: true,
        error: sanitizeLocalVisionText(message, 320),
      };
    }
    return emptyResult({
      screenshotId,
      model,
      runtime,
      startedAt,
      error: sanitizeLocalVisionText(`local vision runtime adapter failed: ${message}`, 320),
    });
  }
}

function validateRequest(request) {
  const imagePath = stringOrEmpty(request.imagePath);
  if (!imagePath) {
    throw new Error("local vision request imagePath is missing");
  }
  let imageStat;
  try {
    imageStat = statSync(imagePath);
  } catch {
    throw new Error("local vision request imagePath does not exist");
  }
  if (!imageStat.isFile()) {
    throw new Error("local vision request imagePath is not a file");
  }
  if (imageStat.size > MAX_IMAGE_BYTES) {
    throw new Error(`local vision image exceeds ${MAX_IMAGE_BYTES} bytes`);
  }
  const size = readPngSizeSync(imagePath);
  if (size.width <= 0 || size.height <= 0) {
    throw new Error("local vision image dimensions are invalid");
  }
  if (imageExceedsPixelLimit(size.width, size.height)) {
    throw new Error(`local vision image exceeds ${MAX_IMAGE_PIXELS} pixels`);
  }
  return size;
}

function imageExceedsPixelLimit(width, height) {
  return width > 0 && height > Math.floor(MAX_IMAGE_PIXELS / width);
}

function validateInferenceReadiness(request) {
  const modelPath = stringOrEmpty(request.modelPath);
  if (!modelPath) {
    return "local vision modelPath is missing";
  }
  const modelName = pathBasename(modelPath);
  if (!existsSync(modelPath)) {
    return `local vision modelPath does not exist: ${modelName}`;
  }
  let modelStat;
  try {
    modelStat = statSync(modelPath);
  } catch (error) {
    return `failed to inspect local vision modelPath: ${errorMessage(error)}`;
  }
  if (!modelStat.isFile()) {
    return `local vision modelPath is not a file: ${modelName}`;
  }

  const requestedRuntime = stringOrEmpty(request.runtime) || "auto";
  if (!isSupportedRuntimeRequest(requestedRuntime)) {
    return `unsupported local vision runtime "${requestedRuntime}"; expected auto, onnxruntime, openvino, or tensorrt`;
  }
  if (!runtimeAdapterRef(request)) {
    return `local vision runtime adapter is not configured; set ${RUNTIME_ADAPTER_ENV} to an ONNX/OpenVINO/TensorRT adapter module`;
  }

  return undefined;
}

async function readRequestJsonFile(requestPath) {
  const requestStat = statSync(requestPath);
  if (!requestStat.isFile()) {
    throw new Error("local vision request path is not a file");
  }
  if (requestStat.size > MAX_REQUEST_JSON_BYTES) {
    throw new Error(`local vision request JSON exceeds ${MAX_REQUEST_JSON_BYTES} bytes`);
  }
  return stripUtf8Bom(await readFile(requestPath, "utf8"));
}

function stripUtf8Bom(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

async function runInference(request, imageSize) {
  const adapterRef = runtimeAdapterRef(request);
  if (!adapterRef) return [];

  const adapter = await loadRuntimeAdapter(adapterRef);
  const adapterRequest = normalizedAdapterRequest(request);
  const timeoutMs = normalizeTimeoutMs(adapterRequest.timeoutMs);
  const output = await withWorkerTimeout(
    Promise.resolve(adapter({
      request: adapterRequest,
      imageSize,
    })),
    timeoutMs,
    "local vision runtime adapter",
  );
  if (Array.isArray(output)) {
    return { rawDetections: output };
  }
  if (output && typeof output === "object" && Array.isArray(output.rawDetections)) {
    return {
      rawDetections: output.rawDetections,
      runtime: normalizeRuntime(output.runtime),
      diagnostics: sanitizeDiagnostics(output.diagnostics),
      timedOut: output.timedOut === true,
      error: typeof output.error === "string" ? output.error : undefined,
    };
  }
  throw new Error("runtime adapter must return an array or { rawDetections: [] }");
}

async function withWorkerTimeout(promise, timeoutMs, label) {
  let timeoutId;
  try {
    return await new Promise((resolveResult, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      promise.then(resolveResult, reject);
    });
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function normalizeTimeoutMs(value) {
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(numberOrDefault(value, DEFAULT_TIMEOUT_MS))));
}

function normalizedAdapterRequest(request) {
  return {
    ...request,
    imgsz: normalizeInputSize(request.imgsz),
    maxDetections: normalizeMaxDetections(request.maxDetections),
    minConfidence: normalizeConfidenceThreshold(request.minConfidence),
    iouThreshold: normalizeIouThreshold(request.iouThreshold),
    timeoutMs: normalizeTimeoutMs(request.timeoutMs),
  };
}

function normalizeInputSize(value) {
  return Math.min(MAX_INPUT_SIZE, Math.max(1, Math.trunc(numberOrDefault(value, DEFAULT_INPUT_SIZE))));
}

async function loadRuntimeAdapter(adapterRef) {
  const module = await import(toImportSpecifier(adapterRef));
  const detect = module.detect ?? module.default?.detect ?? module.default;
  if (typeof detect !== "function") {
    throw new Error("runtime adapter module must export detect() or a default function");
  }
  return detect;
}

function runtimeAdapterRef(request) {
  const explicit = stringOrEmpty(request.runtimeAdapterPath) || stringOrEmpty(process.env[RUNTIME_ADAPTER_ENV]);
  if (explicit) return explicit;
  const requestedRuntime = stringOrEmpty(request.runtime) || "auto";
  if (requestedRuntime === "auto" || requestedRuntime === "onnxruntime") {
    return join(__dirname, "local-vision-onnx-adapter.mjs");
  }
  return "";
}

function toImportSpecifier(value) {
  if (value.startsWith("file:")) return value;
  if (value.startsWith(".") || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) {
    return pathToFileURL(resolve(value)).href;
  }
  return value;
}

function adaptRawDetections({
  rawDetections,
  imageSize,
  maxDetections,
  minConfidence,
  iouThreshold,
  windowHandle,
  labelMap,
}) {
  const threshold = normalizeConfidenceThreshold(minConfidence);
  const nmsThreshold = normalizeIouThreshold(iouThreshold);
  const limit = normalizeMaxDetections(maxDetections);
  if (limit <= 0) return [];
  const normalized = rawDetections
    .map((raw, index) => normalizeRawDetection(raw, index, imageSize, windowHandle, labelMap))
    .filter((detection) => detection && detection.confidence >= threshold)
    .sort((a, b) => b.confidence - a.confidence);
  return nonMaxSuppression(normalized, nmsThreshold, limit);
}

function rawDetectionsLimitError(rawDetections) {
  return rawDetections.length > MAX_RAW_DETECTIONS
    ? `local vision raw detections exceed ${MAX_RAW_DETECTIONS} items`
    : undefined;
}

function normalizeRawDetection(raw, index, imageSize, windowHandle, labelMap) {
  if (!raw || typeof raw !== "object") return undefined;
  const confidence = numberOrDefault(raw.confidence ?? raw.score ?? raw.probability, Number.NaN);
  if (!Number.isFinite(confidence) || confidence < 0) return undefined;
  const label = sanitizeDetectionText(
    normalizeLabel(raw.label ?? raw.className ?? raw.class, labelMap),
    "possible_control",
  );
  const box = normalizeBox(raw.box ?? raw.bbox ?? raw, imageSize);
  if (!box || box.width <= 0 || box.height <= 0) return undefined;
  const id = sanitizeDetectionText(raw.id, `det_${index + 1}`);
  return {
    id,
    label,
    confidence: Math.min(1, confidence),
    box: {
      ...box,
      coordinateSpace: "screenshot",
      screenshotSize: { width: imageSize.width, height: imageSize.height },
      devicePixelRatio: 1,
      ...(windowHandle !== undefined ? { windowHandle } : {}),
    },
    center: {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
      coordinateSpace: "screenshot",
    },
    source: "yolo26",
  };
}

function normalizeBox(rawBox, imageSize) {
  if (!rawBox || typeof rawBox !== "object") return undefined;
  if (Array.isArray(rawBox)) {
    return normalizeArrayBox(rawBox, imageSize);
  }
  const x = numberOrDefault(rawBox.x ?? rawBox.left, Number.NaN);
  const y = numberOrDefault(rawBox.y ?? rawBox.top, Number.NaN);
  const width = numberOrDefault(rawBox.width ?? rawBox.w, Number.NaN);
  const height = numberOrDefault(rawBox.height ?? rawBox.h, Number.NaN);
  if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(width) && Number.isFinite(height)) {
    return clampBox({ x, y, width, height }, imageSize);
  }
  const x1 = numberOrDefault(rawBox.x1 ?? rawBox.left, Number.NaN);
  const y1 = numberOrDefault(rawBox.y1 ?? rawBox.top, Number.NaN);
  const x2 = numberOrDefault(rawBox.x2 ?? rawBox.right, Number.NaN);
  const y2 = numberOrDefault(rawBox.y2 ?? rawBox.bottom, Number.NaN);
  if (Number.isFinite(x1) && Number.isFinite(y1) && Number.isFinite(x2) && Number.isFinite(y2)) {
    return clampBox({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 }, imageSize);
  }
  return undefined;
}

function normalizeArrayBox(rawBox, imageSize) {
  if (rawBox.length < 4) return undefined;
  const [a, b, c, d] = rawBox.map((value) => numberOrDefault(value, Number.NaN));
  if (![a, b, c, d].every(Number.isFinite)) return undefined;
  if (c > a && d > b) {
    return clampBox({ x: a, y: b, width: c - a, height: d - b }, imageSize);
  }
  return clampBox({ x: a, y: b, width: c, height: d }, imageSize);
}

function clampBox(box, imageSize) {
  const x1 = clamp(box.x, 0, imageSize.width);
  const y1 = clamp(box.y, 0, imageSize.height);
  const x2 = clamp(box.x + box.width, 0, imageSize.width);
  const y2 = clamp(box.y + box.height, 0, imageSize.height);
  return {
    x: x1,
    y: y1,
    width: Math.max(0, x2 - x1),
    height: Math.max(0, y2 - y1),
  };
}

function nonMaxSuppression(detections, iouThreshold, limit = Number.POSITIVE_INFINITY) {
  if (limit <= 0) return [];
  const kept = [];
  for (const detection of detections) {
    if (kept.every((existing) => boxIou(existing.box, detection.box) <= iouThreshold)) {
      kept.push(detection);
      if (kept.length >= limit) break;
    }
  }
  return kept;
}

function boxIou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function normalizeLabel(value, labelMap) {
  const rawLabel = stringOrEmpty(value) || "possible_control";
  if (labelMap && typeof labelMap === "object" && typeof labelMap[rawLabel] === "string") {
    return labelMap[rawLabel];
  }
  return rawLabel;
}

function sanitizeDetectionText(value, fallback) {
  return sanitizeLocalVisionText(stringOrEmpty(value), 120) || fallback;
}

function numberOrDefault(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function readPngSizeSync(imagePath) {
  const bytes = readFileSyncCompat(imagePath, 24);
  if (bytes.length < 24) {
    throw new Error("local vision image is too small to be a PNG");
  }
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) {
      throw new Error("local vision image is not a PNG");
    }
  }
  if (bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("local vision PNG is missing IHDR");
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function readFileSyncCompat(path, maxBytes) {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function emptyResult({ screenshotId, model, runtime, startedAt, error }) {
  return {
    screenshotId,
    detections: [],
    latencyMs: Math.max(0, Date.now() - startedAt),
    model,
    runtime,
    timedOut: false,
    ...(error ? { error: sanitizeLocalVisionText(error, 320) } : {}),
  };
}

function sanitizeDiagnostics(value, depth = 0) {
  if (value === undefined || value === null) return undefined;
  if (depth > 3) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/data:image(?:\/|\\\/)[a-z0-9.+-]+;base64,/i.test(value)) {
      return "[redacted image data]";
    }
    return sanitizeLocalVisionText(value, 160);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 32)
      .map((entry) => sanitizeDiagnostics(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }
  if (typeof value === "object") {
    const output = {};
    for (const [key, entry] of Object.entries(value).slice(0, 32)) {
      const sanitized = sanitizeDiagnostics(entry, depth + 1);
      if (sanitized !== undefined) {
        output[sanitizeDiagnosticKey(key)] = sanitized;
      }
    }
    return output;
  }
  return undefined;
}

function sanitizeDiagnosticKey(value) {
  if (IMAGE_DATA_URL_PATTERN.test(value)) {
    IMAGE_DATA_URL_PATTERN.lastIndex = 0;
    return "[redacted image key]";
  }
  IMAGE_DATA_URL_PATTERN.lastIndex = 0;
  return sanitizeLocalVisionText(value, 80);
}

function normalizeRuntime(value) {
  return value === "onnxruntime" || value === "openvino" || value === "tensorrt"
    ? value
    : "unknown";
}

function isSupportedRuntimeRequest(value) {
  return value === "auto" || value === "onnxruntime" || value === "openvino" || value === "tensorrt";
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value.trim() : "";
}

function pathBasename(value) {
  const text = stringOrEmpty(value);
  if (!text) return "unknown";
  const normalized = text.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() || "[redacted local path]";
}

function safeModelName(value) {
  const text = stringOrEmpty(value);
  return text ? pathBasename(text) : "none";
}

function sanitizeLocalVisionText(value, maxLength) {
  const redacted = redactImageDataUrls(redactLocalVisionPaths(String(value)));
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength - 3)}...` : redacted;
}

function redactLocalVisionPaths(value) {
  LOCAL_VISION_PATH_PATTERN.lastIndex = 0;
  const redacted = value.replace(LOCAL_VISION_PATH_PATTERN, (match) => {
    const { path, suffix } = splitLocalVisionPathMatch(match);
    const filename = pathBasename(path).replace(/[)\]}.;:,]+$/g, "");
    const redaction = filename ? `[redacted local path:${filename}]` : "[redacted local path]";
    return `${redaction}${suffix}`;
  });
  LOCAL_VISION_PATH_PATTERN.lastIndex = 0;
  return redacted;
}

function splitLocalVisionPathMatch(match) {
  const lower = match.toLowerCase();
  let end = match.length;
  for (const extension of LOCAL_VISION_PATH_EXTENSIONS) {
    const extensionEnd = lower.lastIndexOf(extension);
    if (extensionEnd < 0) continue;
    const candidateEnd = extensionEnd + extension.length;
    if (!/[\\/]/.test(match.slice(candidateEnd)) && candidateEnd < end) {
      end = candidateEnd;
    }
  }
  while (end > 0 && /[)\]}.;:,]/.test(match[end - 1] ?? "")) {
    end -= 1;
  }
  return {
    path: match.slice(0, end),
    suffix: match.slice(end),
  };
}

function redactImageDataUrls(value) {
  IMAGE_DATA_URL_PATTERN.lastIndex = 0;
  const redacted = value.replace(IMAGE_DATA_URL_PATTERN, (match) => `[redacted:image data URL:${match.length} chars]`);
  IMAGE_DATA_URL_PATTERN.lastIndex = 0;
  return redacted;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function runSelfTest() {
  const dir = await mkdtemp(join(tmpdir(), "javis-local-vision-worker-"));
  const imagePath = join(dir, "shot.png");
  const modelPath = join(dir, "yolo26n-ui.onnx");
  const adapterPath = join(dir, "runtime-adapter.mjs");
  const requestPath = join(dir, "request.json");
  try {
    await writeFile(
      imagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    await writeFile(modelPath, "placeholder model for protocol self-test");
    await writeFile(adapterPath, `
export function detect() {
  return {
    runtime: "onnxruntime",
    rawDetections: [],
  };
}
`);
    await writeFile(requestPath, JSON.stringify({
      imagePath,
      screenshotId: "self-test-shot",
      modelPath,
      runtime: "onnxruntime",
      runtimeAdapterPath: adapterPath,
      timeoutMs: 120,
    }));
    const result = await runWorker(requestPath);
    if (result.screenshotId !== "self-test-shot") {
      throw new Error("self-test screenshotId mismatch");
    }
    if (!Array.isArray(result.detections) || result.detections.length !== 0) {
      throw new Error("self-test expected empty detections");
    }
    if (result.error) {
      throw new Error(`self-test expected adapter success, got: ${result.error}`);
    }
    process.stdout.write("local vision worker self-test passed\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stdout.write(JSON.stringify(emptyResult({
    screenshotId: "",
    model: "none",
    runtime: "unknown",
    startedAt: Date.now(),
    error: errorMessage(error),
  })));
  process.stdout.write("\n");
});
