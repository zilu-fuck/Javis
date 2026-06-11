#!/usr/bin/env node

import { access, constants, readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16_000_000;
const WORKER_SELF_TEST_TIMEOUT_MS = 3_000;
const MAX_SELF_TEST_OUTPUT_BYTES = 64 * 1024;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(helpText());
    return;
  }

  const runtime = parseRuntime(args.runtime);
  const checks = [];
  checks.push(await checkNodeVersion());
  checks.push(await checkNodeOverride());
  checks.push(await checkDesktopNodeRuntime({
    required: args.requireDesktopNodeRuntime === true || args.requireBundledDesktopNodeRuntime === true,
    allowOverride: args.requireBundledDesktopNodeRuntime !== true,
  }));
  if (!runtime) {
    checks.push(fail("runtime", `unsupported runtime: ${args.runtime}; expected auto, onnxruntime, openvino, or tensorrt`));
  }
  const workerPath = resolve(__dirname, "local-vision-worker.mjs");
  checks.push(await checkFile("worker", workerPath));
  checks.push(await checkFile("worker-cmd", resolve(__dirname, "local-vision-worker.cmd")));
  checks.push(await checkFile("onnx-adapter", resolve(__dirname, "local-vision-onnx-adapter.mjs")));
  checks.push(await checkWorkerSelfTest(workerPath));
  checks.push(await checkOnnxRuntimePackage());
  checks.push(await checkOnnxRuntimeCommonPackage());
  checks.push(await checkOnnxRuntime());
  if (args.image) {
    checks.push(await checkPngImage(resolve(args.image)));
  }
  if (args.model && runtime) {
    checks.push(...await checkModel(resolve(args.model), runtime));
  }
  if (args.adapter) {
    checks.push(await checkRegularFile("runtime-adapter", resolve(args.adapter)));
  }

  const failed = checks.filter((check) => check.status === "fail");
  const warnings = checks.filter((check) => check.status === "warn");
  const report = {
    passed: failed.length === 0,
    warningCount: warnings.length,
    failedCount: failed.length,
    checks,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) {
    process.exitCode = 2;
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
    if (arg === "--require-desktop-node-runtime") {
      args.requireDesktopNodeRuntime = true;
      continue;
    }
    if (arg === "--require-bundled-desktop-node-runtime") {
      args.requireBundledDesktopNodeRuntime = true;
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

async function checkNodeVersion() {
  const major = Number(process.versions.node.split(".")[0]);
  if (Number.isFinite(major) && major >= 20) {
    return pass("node", `Node ${process.versions.node}`);
  }
  return fail("node", `Node 20+ is recommended; current version is ${process.versions.node}`);
}

async function checkNodeOverride() {
  const nodePath = (process.env.JAVIS_LOCAL_VISION_NODE_PATH ?? "").trim();
  if (!nodePath) {
    return warn("node-override", "JAVIS_LOCAL_VISION_NODE_PATH is not set; desktop worker startup will try bundled Node before PATH");
  }
  try {
    const info = await stat(nodePath);
    if (!info.isFile()) {
      return fail("node-override", `JAVIS_LOCAL_VISION_NODE_PATH is not a file: ${safePathLabel(nodePath)}`);
    }
    return pass("node-override", safePathLabel(nodePath));
  } catch (error) {
    return fail(
      "node-override",
      `JAVIS_LOCAL_VISION_NODE_PATH is unreadable: ${safePathLabel(nodePath)}; ${sanitizeLocalVisionText(errorMessage(error), 240)}`,
    );
  }
}

async function checkDesktopNodeRuntime({ required, allowOverride }) {
  const nodePath = (process.env.JAVIS_LOCAL_VISION_NODE_PATH ?? "").trim();
  if (nodePath && allowOverride) {
    return pass("desktop-node-runtime", "JAVIS_LOCAL_VISION_NODE_PATH is set for desktop worker startup");
  }
  const bundledNode = await checkTauriBundledNodeRuntime();
  if (bundledNode?.status === "pass") {
    return pass("desktop-node-runtime", bundledNode.detail);
  }
  const bundledDetail = bundledNode?.detail ? `; ${bundledNode.detail}` : "";
  const detail = allowOverride
    ? `local vision desktop worker is JavaScript and no Node runtime override or bundled Node runtime was found; packaged startup will rely on PATH${bundledDetail}`
    : `local vision desktop worker is JavaScript and no bundled Node runtime was found; release packages must not rely on JAVIS_LOCAL_VISION_NODE_PATH or PATH${bundledDetail}`;
  return required ? fail("desktop-node-runtime", detail) : warn("desktop-node-runtime", detail);
}

async function checkTauriBundledNodeRuntime() {
  const configPath = resolve(__dirname, "..", "apps", "desktop", "src-tauri", "tauri.conf.json");
  try {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const resources = config?.bundle?.resources;
    if (!resources || typeof resources !== "object" || Array.isArray(resources)) {
      return { status: "warn", detail: "tauri bundle.resources is missing or invalid" };
    }
    for (const [source, target] of Object.entries(resources)) {
      if (!looksLikeNodeRuntimeTarget(target)) {
        continue;
      }
      const sourcePath = resolve(dirname(configPath), source);
      await access(sourcePath, constants.R_OK);
      if (looksLikeNodeRuntimeDirectoryTarget(target)) {
        const nodeName = process.platform === "win32" ? "node.exe" : "node";
        await access(resolve(sourcePath, nodeName), constants.R_OK);
      }
      return {
        status: "pass",
        detail: `tauri bundle resource includes Node runtime: ${safePathLabel(target)}`,
      };
    }
    return { status: "warn", detail: "tauri bundle.resources has no Node runtime target" };
  } catch (error) {
    return {
      status: "warn",
      detail: `could not inspect tauri bundled Node runtime: ${sanitizeLocalVisionText(errorMessage(error), 240)}`,
    };
  }
}

function looksLikeNodeRuntimeTarget(value) {
  const normalized = String(value).replace(/\\/g, "/").toLowerCase();
  return looksLikeNodeRuntimeDirectoryTarget(normalized) ||
    normalized.endsWith("/node.exe") ||
    normalized.endsWith("/node") ||
    normalized.endsWith("/node.cmd") ||
    normalized === "node.exe" ||
    normalized === "node" ||
    normalized === "node.cmd";
}

function looksLikeNodeRuntimeDirectoryTarget(value) {
  const normalized = String(value).replace(/\\/g, "/").toLowerCase();
  return normalized.endsWith("/bin/node/") ||
    normalized.endsWith("/bin/node") ||
    normalized === "bin/node/" ||
    normalized === "bin/node";
}

async function checkFile(name, path) {
  try {
    await access(path, constants.R_OK);
    return pass(name, safePathLabel(path));
  } catch {
    return fail(name, `missing or unreadable: ${safePathLabel(path)}`);
  }
}

async function checkRegularFile(name, path) {
  try {
    await access(path, constants.R_OK);
    const info = await stat(path);
    if (!info.isFile()) {
      return fail(name, `path is not a file: ${safePathLabel(path)}`);
    }
    return pass(name, safePathLabel(path));
  } catch (error) {
    return fail(name, `missing or unreadable: ${safePathLabel(path)}; ${sanitizeLocalVisionText(errorMessage(error), 240)}`);
  }
}

function selectedNodeExecutable() {
  return (process.env.JAVIS_LOCAL_VISION_NODE_PATH ?? "").trim() || process.execPath;
}

function checkWorkerSelfTest(workerPath) {
  return new Promise((resolveCheck) => {
    const nodePath = selectedNodeExecutable();
    let child;
    try {
      child = spawn(nodePath, [workerPath, "--self-test"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolveCheck(fail(
        "worker-self-test",
        `failed to start worker self-test with ${safePathLabel(nodePath)}: ${sanitizeLocalVisionText(errorMessage(error), 240)}`,
      ));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutId = setTimeout(() => {
      settle(fail("worker-self-test", `worker self-test timed out after ${WORKER_SELF_TEST_TIMEOUT_MS}ms`));
      child.kill();
    }, WORKER_SELF_TEST_TIMEOUT_MS);

    const settle = (check) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolveCheck(check);
    };
    const appendOutput = (current, chunk, label) => {
      const next = current + chunk;
      if (Buffer.byteLength(next, "utf8") > MAX_SELF_TEST_OUTPUT_BYTES) {
        settle(fail("worker-self-test", `${label} exceeded ${MAX_SELF_TEST_OUTPUT_BYTES} bytes`));
        child.kill();
      }
      return next;
    };

    child.stdout.on("data", (chunk) => {
      stdout = appendOutput(stdout, chunk, "stdout");
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendOutput(stderr, chunk, "stderr");
    });
    child.on("error", (error) => {
      settle(fail("worker-self-test", `failed to start worker self-test with ${safePathLabel(nodePath)}: ${sanitizeLocalVisionText(errorMessage(error), 240)}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code === 0 && stdout.includes("local vision worker self-test passed")) {
        settle(pass("worker-self-test", `passed via ${safePathLabel(nodePath)}`));
        return;
      }
      const detail = [
        `worker self-test exited with ${code}`,
        stderr.trim() ? `stderr=${sanitizeLocalVisionText(stderr.trim(), 240)}` : "",
        stdout.trim() ? `stdout=${sanitizeLocalVisionText(stdout.trim(), 240)}` : "",
      ].filter(Boolean).join("; ");
      settle(fail("worker-self-test", detail));
    });
  });
}

async function checkOnnxRuntimePackage() {
  return checkBundledNodePackage(
    "onnxruntime-node-package",
    "onnxruntime-node",
    "packaged desktop builds must bundle onnxruntime-node",
  );
}

async function checkOnnxRuntimeCommonPackage() {
  return checkBundledNodePackage(
    "onnxruntime-common-package",
    "onnxruntime-common",
    "packaged desktop builds must bundle onnxruntime-common with onnxruntime-node",
  );
}

async function checkBundledNodePackage(checkName, packageName, missingDetail) {
  const packageJson = resolve(__dirname, "node_modules", packageName, "package.json");
  try {
    await access(packageJson, constants.R_OK);
    return pass(checkName, `scripts/node_modules/${packageName}/package.json`);
  } catch {
    const resourceCheck = await checkTauriBundlePackageResource(packageName);
    if (resourceCheck) {
      return resourceCheck.status === "pass"
        ? pass(checkName, resourceCheck.detail)
        : warn(checkName, `${missingDetail}; ${resourceCheck.detail}`);
    }
    return warn(checkName, `scripts/node_modules/${packageName} is not present; ${missingDetail}`);
  }
}

async function checkTauriBundlePackageResource(packageName) {
  const target = `scripts/node_modules/${packageName}/`;
  const configPath = resolve(__dirname, "..", "apps", "desktop", "src-tauri", "tauri.conf.json");
  try {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const resources = config?.bundle?.resources;
    if (!resources || typeof resources !== "object" || Array.isArray(resources)) {
      return { status: "warn", detail: "tauri bundle.resources is missing or invalid" };
    }
    const source = sourceForResourceTarget(resources, target);
    if (!source) {
      return { status: "warn", detail: `tauri bundle resource target is missing: ${target}` };
    }
    const sourcePackageJson = resolve(dirname(configPath), source, "package.json");
    await access(sourcePackageJson, constants.R_OK);
    return {
      status: "pass",
      detail: `tauri bundle resource ${target} -> ${safePathLabel(source)}/package.json`,
    };
  } catch (error) {
    return {
      status: "warn",
      detail: `tauri bundle resource ${target} is unreadable: ${sanitizeLocalVisionText(errorMessage(error), 240)}`,
    };
  }
}

function sourceForResourceTarget(resources, target) {
  for (const [source, candidateTarget] of Object.entries(resources)) {
    if (candidateTarget === target) {
      return source;
    }
  }
  return undefined;
}

async function checkOnnxRuntime() {
  try {
    const ort = await import("onnxruntime-node");
    if (!ort.InferenceSession || !ort.Tensor) {
      return fail("onnxruntime-node", "onnxruntime-node loaded but does not expose InferenceSession/Tensor");
    }
    return pass("onnxruntime-node", "onnxruntime-node loaded");
  } catch (error) {
    return fail(
      "onnxruntime-node",
      `onnxruntime-node could not be loaded: ${sanitizeLocalVisionText(errorMessage(error), 240)}`,
    );
  }
}

async function checkPngImage(path) {
  try {
    await access(path, constants.R_OK);
    const info = await stat(path);
    if (!info.isFile()) {
      return fail("image", `image path is not a file: ${safePathLabel(path)}`);
    }
    if (info.size > MAX_IMAGE_BYTES) {
      return fail("image", `image exceeds ${MAX_IMAGE_BYTES} bytes: ${safePathLabel(path)}`);
    }
    const handle = await import("node:fs/promises").then((fs) => fs.open(path, "r"));
    try {
      const header = Buffer.alloc(24);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      if (bytesRead < 24 || header.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
        return fail("image", `image is not a PNG: ${safePathLabel(path)}`);
      }
      const width = header.readUInt32BE(16);
      const height = header.readUInt32BE(20);
      if (width <= 0 || height <= 0) {
        return fail("image", `PNG dimensions are invalid: ${safePathLabel(path)}`);
      }
      if (imageExceedsPixelLimit(width, height)) {
        return fail("image", `PNG dimensions exceed ${MAX_IMAGE_PIXELS} pixels: ${safePathLabel(path)} (${width}x${height})`);
      }
      return pass("image", `${safePathLabel(path)} (${width}x${height})`);
    } finally {
      await handle.close();
    }
  } catch (error) {
    return fail("image", `image missing or unreadable: ${safePathLabel(path)}; ${sanitizeLocalVisionText(errorMessage(error), 240)}`);
  }
}

function imageExceedsPixelLimit(width, height) {
  return width > 0 && height > Math.floor(MAX_IMAGE_PIXELS / width);
}

async function checkModel(path, runtime) {
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      return [fail("model", `model path is not a file: ${safePathLabel(path)}`)];
    }
    if (info.size <= 0) {
      return [fail("model", `model file is empty: ${safePathLabel(path)}`)];
    }
    const extension = modelExtension(path);
    const checks = [pass("model", `${safePathLabel(path)} (${info.size} bytes)`)];
    checks.push(runtimeModelCompatibilityCheck(path, runtime, extension));
    checks.push(modelPurposeCheck(path));
    if (extension === ".onnx" && (runtime === "auto" || runtime === "onnxruntime")) {
      checks.push(await checkOnnxModelMetadata(path));
    }
    if (runtime === "openvino" && extension === ".xml") {
      checks.push(await checkOpenvinoBinWeights(path));
    }
    return checks;
  } catch (error) {
    return [fail("model", `model missing or unreadable: ${safePathLabel(path)}; ${sanitizeLocalVisionText(errorMessage(error), 240)}`)];
  }
}

function parseRuntime(value) {
  if (value === undefined) {
    return "auto";
  }
  return value === "auto" || value === "onnxruntime" || value === "openvino" || value === "tensorrt"
    ? value
    : null;
}

function modelExtension(path) {
  const name = safePathLabel(path).toLowerCase();
  const dotIndex = name.lastIndexOf(".");
  return dotIndex >= 0 ? name.slice(dotIndex) : "";
}

function runtimeModelCompatibilityCheck(path, runtime, extension) {
  const label = safePathLabel(path);
  if (runtime === "openvino") {
    return extension === ".xml"
      ? pass("model-runtime", "openvino model extension .xml")
      : fail("model-runtime", `openvino runtime expects an .xml model: ${label}`);
  }
  if (runtime === "tensorrt") {
    return extension === ".engine"
      ? pass("model-runtime", "tensorrt model extension .engine")
      : fail("model-runtime", `tensorrt runtime expects an .engine model: ${label}`);
  }
  if (extension === ".onnx") {
    return pass("model-runtime", `${runtime} model extension .onnx`);
  }
  return runtime === "auto"
    ? warn("model-runtime", `auto runtime works best with .onnx for the bundled adapter: ${label}`)
    : fail("model-runtime", `${runtime} runtime expects an .onnx model: ${label}`);
}

function modelPurposeCheck(path) {
  const label = safePathLabel(path);
  const lower = label.toLowerCase();
  if (/^yolo26[nsmlx]\.(?:pt|onnx)$/.test(lower)) {
    return warn(
      "model-purpose",
      `${label} matches an official Ultralytics YOLO26 COCO weight name; use it for smoke/benchmark only, not as a UI-trained production model`,
    );
  }
  return pass("model-purpose", "model filename does not match the official YOLO26 COCO smoke-weight pattern");
}

async function checkOnnxModelMetadata(path) {
  try {
    const ort = await import("onnxruntime-node");
    const session = await ort.InferenceSession.create(path);
    const input = Array.isArray(session.inputMetadata) ? session.inputMetadata[0] : undefined;
    const output = Array.isArray(session.outputMetadata) ? session.outputMetadata[0] : undefined;
    const inputShape = formatModelShape(input?.shape);
    const outputShape = formatModelShape(output?.shape);
    const fixedInput = fixedSquareInputSize(input?.shape);
    const detail = [
      `input=${input?.name || "unknown"}${inputShape}`,
      `output=${output?.name || "unknown"}${outputShape}`,
      fixedInput ? `fixedInputSize=${fixedInput}` : "dynamicInputSize=unknown",
    ].join("; ");
    return pass("onnx-model-metadata", detail);
  } catch (error) {
    return warn(
      "onnx-model-metadata",
      `could not inspect ONNX model metadata for ${safePathLabel(path)}: ${sanitizeLocalVisionText(errorMessage(error), 240)}`,
    );
  }
}

function formatModelShape(shape) {
  if (!Array.isArray(shape)) return "";
  return `[${shape.map((dim) =>
    typeof dim === "number" && Number.isFinite(dim) ? String(dim) : "?"
  ).join(",")}]`;
}

function fixedSquareInputSize(shape) {
  if (!Array.isArray(shape) || shape.length < 4) return undefined;
  const height = Number(shape[shape.length - 2]);
  const width = Number(shape[shape.length - 1]);
  return Number.isFinite(height) && Number.isFinite(width) && height > 0 && width === height
    ? Math.trunc(height)
    : undefined;
}

async function checkOpenvinoBinWeights(xmlPath) {
  const binPath = xmlPath.replace(/\.xml$/i, ".bin");
  try {
    const info = await stat(binPath);
    if (!info.isFile() || info.size <= 0) {
      return fail("openvino-bin", `OpenVINO weights file is empty or not a file: ${safePathLabel(binPath)}`);
    }
    return pass("openvino-bin", `${safePathLabel(binPath)} (${info.size} bytes)`);
  } catch (error) {
    return fail("openvino-bin", `OpenVINO weights file missing beside model XML: ${safePathLabel(binPath)}; ${sanitizeLocalVisionText(errorMessage(error), 240)}`);
  }
}

function pass(name, detail) {
  return { name, status: "pass", detail };
}

function warn(name, detail) {
  return { name, status: "warn", detail };
}

function fail(name, detail) {
  return { name, status: "fail", detail };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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

function helpText() {
  return `Usage: node scripts/local-vision-doctor.mjs [options]

Options:
  --image <screen.png>  Optional PNG screenshot to validate.
  --model <model-file>  Optional model file to validate.
  --runtime <runtime>   Optional runtime: auto, onnxruntime, openvino, tensorrt.
  --adapter <path>      Optional runtime adapter module to validate.
  --require-desktop-node-runtime
                      Fail if packaged desktop startup would rely on PATH Node.
  --require-bundled-desktop-node-runtime
                      Fail unless Tauri bundle resources include a Node runtime.
`;
}

main().catch((error) => {
  process.stderr.write(`Error: ${sanitizeLocalVisionText(errorMessage(error), 320)}\n`);
  process.exitCode = 1;
});
