#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const doctorPath = resolve(__dirname, "local-vision-doctor.mjs");

async function main() {
  const help = await runDoctor(["--help"]);
  assert(help.code === 0, "help should exit successfully");
  assert(help.stdout.includes("Usage: node scripts/local-vision-doctor.mjs"), "help text should include usage");
  assert(help.stdout.includes("--model <model-file>"), "help text should describe model-file rather than only ONNX");
  assert(help.stdout.includes("--adapter <path>"), "help text should describe runtime adapter override");

  const missingValue = await runDoctor(["--image"]);
  assert(missingValue.code === 1, "missing image value should fail");
  assert(missingValue.stderr.includes("missing value for --image"), "missing image value error mismatch");
  assert(!missingValue.stderr.includes("\n    at "), "doctor missing value should not print stack");
  assert(!missingValue.stderr.includes("local-vision-doctor.mjs:"), "doctor missing value should not print script location");

  const base = await runDoctor([]);
  assert(base.code === 0, `base doctor should pass: ${base.stderr || base.stdout}`);
  const baseReport = JSON.parse(base.stdout);
  assert(baseReport.passed === true, "base doctor should report passed=true");
  assert(baseReport.checks.some((check) => check.name === "worker-self-test" && check.status === "pass"), "worker self-test should pass");
  assert(baseReport.checks.some((check) => check.name === "onnxruntime-node" && check.status === "pass"), "onnxruntime check should pass");
  assert(baseReport.checks.some((check) => check.name === "node-override" && check.status === "warn"), "missing node override should warn");
  assert(baseReport.checks.some((check) =>
    check.name === "node-override" &&
    check.status === "warn" &&
    check.detail.includes("try bundled Node before PATH")
  ), "missing node override should explain bundled Node fallback before PATH");
  const baseDesktopNode = baseReport.checks.find((check) => check.name === "desktop-node-runtime");
  assert(baseDesktopNode, "doctor should report desktop Node runtime status");
  const hasBundledDesktopNode = baseDesktopNode.status === "pass" &&
    baseDesktopNode.detail.includes("tauri bundle resource includes Node runtime");
  if (!hasBundledDesktopNode) {
    assert(
      baseDesktopNode.status === "warn" &&
      baseDesktopNode.detail.includes("packaged startup will rely on PATH"),
      "missing desktop Node runtime should warn that packaged startup relies on PATH",
    );
  }
  assert(baseReport.checks.some((check) =>
    check.name === "onnxruntime-node-package" &&
    check.status === "pass" &&
    check.detail.includes("tauri bundle resource")
  ), "doctor should pass packaged onnxruntime-node resource checks via tauri bundle config");
  assert(baseReport.checks.some((check) =>
    check.name === "onnxruntime-common-package" &&
    check.status === "pass" &&
    check.detail.includes("tauri bundle resource")
  ), "doctor should pass packaged onnxruntime-common resource checks via tauri bundle config");

  const strictDesktopNode = await runDoctor(["--require-desktop-node-runtime"]);
  assert(strictDesktopNode.code === (hasBundledDesktopNode ? 0 : 2), "strict desktop Node runtime doctor should follow bundled Node availability");
  const strictDesktopNodeReport = JSON.parse(strictDesktopNode.stdout);
  assert(strictDesktopNodeReport.passed === hasBundledDesktopNode, "strict desktop Node runtime report mismatch");
  if (!hasBundledDesktopNode) {
    assert(strictDesktopNodeReport.checks.some((check) =>
      check.name === "desktop-node-runtime" &&
      check.status === "fail" &&
      check.detail.includes("packaged startup will rely on PATH")
    ), "strict desktop Node runtime should fail the PATH fallback warning");
  }

  const bundledDesktopNode = await runDoctor(["--require-bundled-desktop-node-runtime"]);
  assert(bundledDesktopNode.code === (hasBundledDesktopNode ? 0 : 2), "bundled desktop Node runtime doctor should follow bundled Node availability");
  const bundledDesktopNodeReport = JSON.parse(bundledDesktopNode.stdout);
  if (!hasBundledDesktopNode) {
    assert(bundledDesktopNodeReport.checks.some((check) =>
      check.name === "desktop-node-runtime" &&
      check.status === "fail" &&
      check.detail.includes("release packages must not rely on JAVIS_LOCAL_VISION_NODE_PATH or PATH")
    ), "bundled desktop Node runtime should require Tauri bundled Node");
  }

  const dir = await mkdtemp(join(tmpdir(), "javis-local-vision-doctor-test-"));
  try {
    const imagePath = join(dir, "screen.png");
    const oversizedImagePath = join(dir, "oversized-screen.png");
    const invalidImagePath = join(dir, "not-image.txt");
    const modelPath = join(dir, "model.onnx");
    const adapterPath = join(dir, "runtime-adapter.mjs");
    const openvinoXmlPath = join(dir, "model.xml");
    const openvinoBinPath = join(dir, "model.bin");
    const tensorrtEnginePath = join(dir, "model.engine");
    const badNodePath = join(dir, process.platform === "win32" ? "bad-node.exe" : "bad-node");
    await writeFile(imagePath, createPngHeader(32, 16));
    await writeFile(oversizedImagePath, createPngHeader(20000, 20000));
    await writeFile(invalidImagePath, "not a png");
    await writeFile(modelPath, "placeholder model");
    await writeFile(adapterPath, "export default function detect() { return []; }\n");
    await writeFile(openvinoXmlPath, "<net></net>");
    await writeFile(tensorrtEnginePath, "placeholder engine");
    await writeFile(badNodePath, "not a real node executable");

    const withFiles = await runDoctor(["--image", imagePath, "--model", modelPath, "--adapter", adapterPath], {
      JAVIS_LOCAL_VISION_NODE_PATH: process.execPath,
    });
    assert(withFiles.code === 0, `doctor with files should pass: ${withFiles.stderr || withFiles.stdout}`);
    const withFilesReport = JSON.parse(withFiles.stdout);
    assert(withFilesReport.checks.some((check) => check.name === "node-override" && check.status === "pass"), "node override should pass");
    assert(withFilesReport.checks.some((check) => check.name === "desktop-node-runtime" && check.status === "pass"), "node override should satisfy desktop runtime check");
    assert(withFilesReport.checks.some((check) => check.name === "image" && check.status === "pass"), "image check should pass");
    assert(withFilesReport.checks.some((check) => check.name === "model" && check.status === "pass"), "model check should pass");
    assert(withFilesReport.checks.some((check) => check.name === "model-runtime" && check.status === "pass"), "default ONNX model runtime check should pass");
    assert(withFilesReport.checks.some((check) => check.name === "runtime-adapter" && check.status === "pass"), "runtime adapter check should pass");
    assert(withFilesReport.checks.some((check) => check.name === "worker-self-test" && check.status === "pass"), "worker self-test should pass with node override");
    assert(withFiles.stdout.includes("screen.png"), "doctor should include image filename");
    assert(withFiles.stdout.includes("model.onnx"), "doctor should include model filename");
    assert(withFiles.stdout.includes("runtime-adapter.mjs"), "doctor should include adapter filename");
    assert(withFiles.stdout.includes(process.execPath.replace(/\\/g, "/").split("/").pop()), "doctor should include node filename");
    assert(!withFiles.stdout.includes(dir), "doctor report should not leak temp directory");

    const strictWithOverride = await runDoctor(["--require-desktop-node-runtime"], {
      JAVIS_LOCAL_VISION_NODE_PATH: process.execPath,
    });
    assert(strictWithOverride.code === 0, `strict desktop Node runtime should pass with override: ${strictWithOverride.stderr || strictWithOverride.stdout}`);
    const strictWithOverrideReport = JSON.parse(strictWithOverride.stdout);
    assert(strictWithOverrideReport.checks.some((check) =>
      check.name === "desktop-node-runtime" &&
      check.status === "pass"
    ), "strict desktop Node runtime should pass when override is set");

    const bundledWithOverride = await runDoctor(["--require-bundled-desktop-node-runtime"], {
      JAVIS_LOCAL_VISION_NODE_PATH: process.execPath,
    });
    assert(bundledWithOverride.code === (hasBundledDesktopNode ? 0 : 2), "bundled desktop Node runtime with override should follow bundled Node availability");
    const bundledWithOverrideReport = JSON.parse(bundledWithOverride.stdout);
    if (!hasBundledDesktopNode) {
      assert(bundledWithOverrideReport.checks.some((check) =>
        check.name === "desktop-node-runtime" &&
        check.status === "fail" &&
        check.detail.includes("release packages must not rely on JAVIS_LOCAL_VISION_NODE_PATH or PATH")
      ), "bundled desktop Node runtime should not accept node override");
    }

    const withSeparator = await runDoctor(["--", "--image", imagePath, "--model", modelPath, "--adapter", adapterPath], {
      JAVIS_LOCAL_VISION_NODE_PATH: process.execPath,
    });
    assert(withSeparator.code === 0, `doctor should ignore npm-style -- separator: ${withSeparator.stderr || withSeparator.stdout}`);
    const withSeparatorReport = JSON.parse(withSeparator.stdout);
    assert(withSeparatorReport.passed === true, "doctor separator run should pass");
    assert(withSeparatorReport.checks.some((check) => check.name === "model" && check.status === "pass"), "doctor separator run should parse model");
    assert(!withSeparator.stdout.includes(dir), "doctor separator run should not leak temp directory");

    const badNodeOverride = await runDoctor([], {
      JAVIS_LOCAL_VISION_NODE_PATH: badNodePath,
    });
    assert(badNodeOverride.code === 2, "bad node override should fail with code 2");
    const badNodeOverrideReport = JSON.parse(badNodeOverride.stdout);
    assert(badNodeOverrideReport.checks.some((check) => check.name === "node-override" && check.status === "pass"), "bad node path still exists for node-override check");
    assert(badNodeOverrideReport.checks.some((check) => check.name === "worker-self-test" && check.status === "fail"), "bad node override should fail worker self-test");
    assert(badNodeOverride.stdout.includes(process.platform === "win32" ? "bad-node.exe" : "bad-node"), "bad node report should include filename");
    assert(!badNodeOverride.stdout.includes(dir), "bad node report should not leak temp directory");

    const onnxRuntime = await runDoctor(["--model", modelPath, "--runtime", "onnxruntime"]);
    assert(onnxRuntime.code === 0, `onnxruntime model check should pass: ${onnxRuntime.stderr || onnxRuntime.stdout}`);
    const onnxRuntimeReport = JSON.parse(onnxRuntime.stdout);
    assert(onnxRuntimeReport.checks.some((check) => check.name === "model-runtime" && check.status === "pass"), "onnxruntime should accept .onnx");
    assert(onnxRuntimeReport.checks.some((check) => check.name === "model-purpose" && check.status === "pass"), "custom model filename should pass model-purpose check");
    assert(onnxRuntimeReport.checks.some((check) => check.name === "onnx-model-metadata" && check.status === "warn"), "placeholder ONNX should warn on metadata inspection");

    const cocoSmokeModelPath = join(dir, "yolo26n.onnx");
    await writeFile(cocoSmokeModelPath, "placeholder coco model");
    const cocoSmokeModel = await runDoctor(["--model", cocoSmokeModelPath, "--runtime", "onnxruntime"]);
    assert(cocoSmokeModel.code === 0, `COCO smoke model warning should not fail doctor: ${cocoSmokeModel.stderr || cocoSmokeModel.stdout}`);
    const cocoSmokeModelReport = JSON.parse(cocoSmokeModel.stdout);
    assert(
      cocoSmokeModelReport.checks.some((check) =>
        check.name === "model-purpose" &&
        check.status === "warn" &&
        check.detail.includes("smoke/benchmark only")
      ),
      "official YOLO26 COCO filename should warn that it is only for smoke/benchmark",
    );

    const missingOpenvinoBin = await runDoctor(["--model", openvinoXmlPath, "--runtime", "openvino"]);
    assert(missingOpenvinoBin.code === 2, "openvino model without .bin should fail");
    const missingOpenvinoBinReport = JSON.parse(missingOpenvinoBin.stdout);
    assert(missingOpenvinoBinReport.checks.some((check) => check.name === "model-runtime" && check.status === "pass"), "openvino .xml extension should pass");
    assert(missingOpenvinoBinReport.checks.some((check) => check.name === "openvino-bin" && check.status === "fail"), "missing openvino .bin should fail");
    assert(!missingOpenvinoBin.stdout.includes(dir), "openvino missing .bin report should not leak temp directory");

    await writeFile(openvinoBinPath, "placeholder weights");
    const openvino = await runDoctor(["--model", openvinoXmlPath, "--runtime", "openvino"]);
    assert(openvino.code === 0, `openvino model with .bin should pass: ${openvino.stderr || openvino.stdout}`);
    const openvinoReport = JSON.parse(openvino.stdout);
    assert(openvinoReport.checks.some((check) => check.name === "openvino-bin" && check.status === "pass"), "openvino .bin should pass");

    const tensorrtMismatch = await runDoctor(["--model", modelPath, "--runtime", "tensorrt"]);
    assert(tensorrtMismatch.code === 2, "tensorrt should reject .onnx model path");
    const tensorrtMismatchReport = JSON.parse(tensorrtMismatch.stdout);
    assert(tensorrtMismatchReport.checks.some((check) => check.name === "model-runtime" && check.status === "fail"), "tensorrt mismatch should fail model-runtime");

    const tensorrt = await runDoctor(["--model", tensorrtEnginePath, "--runtime", "tensorrt"]);
    assert(tensorrt.code === 0, `tensorrt engine should pass: ${tensorrt.stderr || tensorrt.stdout}`);
    const tensorrtReport = JSON.parse(tensorrt.stdout);
    assert(tensorrtReport.checks.some((check) => check.name === "model-runtime" && check.status === "pass"), "tensorrt should accept .engine");

    const unsupportedRuntime = await runDoctor(["--model", tensorrtEnginePath, "--runtime", "cuda"]);
    assert(unsupportedRuntime.code === 2, "unsupported runtime should fail with code 2");
    const unsupportedRuntimeReport = JSON.parse(unsupportedRuntime.stdout);
    assert(unsupportedRuntimeReport.checks.some((check) => check.name === "runtime" && check.status === "fail"), "unsupported runtime should include failed runtime check");
    assert(!unsupportedRuntimeReport.checks.some((check) => check.name === "model-runtime"), "unsupported runtime should not run model-runtime compatibility checks");
    assert(!unsupportedRuntime.stderr.includes("\n    at "), "unsupported runtime should not print stack");

    const missingAdapter = await runDoctor(["--adapter", join(dir, "missing-adapter.mjs")]);
    assert(missingAdapter.code === 2, "missing adapter should fail with code 2");
    const missingAdapterReport = JSON.parse(missingAdapter.stdout);
    assert(missingAdapterReport.checks.some((check) => check.name === "runtime-adapter" && check.status === "fail"), "missing adapter should include failed runtime-adapter check");
    assert(missingAdapter.stdout.includes("missing-adapter.mjs"), "missing adapter report should include filename");
    assert(!missingAdapter.stdout.includes(dir), "missing adapter report should not leak temp directory");

    const adapterDirectory = await runDoctor(["--adapter", dir]);
    assert(adapterDirectory.code === 2, "adapter directory should fail with code 2");
    const adapterDirectoryReport = JSON.parse(adapterDirectory.stdout);
    assert(adapterDirectoryReport.checks.some((check) => check.name === "runtime-adapter" && check.status === "fail"), "adapter directory should include failed runtime-adapter check");
    assert(!adapterDirectory.stdout.includes(dir), "adapter directory report should not leak temp directory");

    const missing = await runDoctor(["--model", join(dir, "missing.onnx")]);
    assert(missing.code === 2, "missing model should fail with code 2");
    const missingReport = JSON.parse(missing.stdout);
    assert(missingReport.passed === false, "missing model report should fail");
    assert(missingReport.checks.some((check) => check.name === "model" && check.status === "fail"), "missing model should include failed model check");
    assert(missing.stdout.includes("missing.onnx"), "missing model report should include filename");
    assert(!missing.stdout.includes(dir), "missing model report should not leak temp directory");

    const invalidImage = await runDoctor(["--image", invalidImagePath]);
    assert(invalidImage.code === 2, "invalid image should fail with code 2");
    const invalidImageReport = JSON.parse(invalidImage.stdout);
    assert(invalidImageReport.checks.some((check) => check.name === "image" && check.status === "fail"), "invalid image should include failed image check");
    assert(invalidImage.stdout.includes("not-image.txt"), "invalid image report should include filename");
    assert(!invalidImage.stdout.includes(dir), "invalid image report should not leak temp directory");

    const oversizedImage = await runDoctor(["--image", oversizedImagePath]);
    assert(oversizedImage.code === 2, "oversized image should fail with code 2");
    const oversizedImageReport = JSON.parse(oversizedImage.stdout);
    assert(
      oversizedImageReport.checks.some((check) =>
        check.name === "image" && check.status === "fail" && check.detail.includes("exceed")
      ),
      "oversized image should include failed image size check",
    );
    assert(oversizedImage.stdout.includes("oversized-screen.png"), "oversized image report should include filename");
    assert(!oversizedImage.stdout.includes(dir), "oversized image report should not leak temp directory");

    process.stdout.write("local vision doctor CLI test passed\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runDoctor(args, env = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [doctorPath, ...args], {
      env: { ...process.env, ...env },
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
