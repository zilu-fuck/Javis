#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const tauriDir = resolve(repoRoot, "apps", "desktop", "src-tauri");
const modelPath = resolve(repoRoot, "artifacts", "local-vision", "yolo26n-ui.onnx");
const stubMarker = "JAVIS_CARGO_RESOURCE_STUB_DO_NOT_BUNDLE\n";
const allowedCargoCommands = new Set(["check", "test"]);

const cargoCommand = process.argv[2];
const cargoArgs = process.argv.slice(3);

if (!allowedCargoCommands.has(cargoCommand)) {
  process.stderr.write("Usage: node scripts/run-tauri-cargo-with-resource-stubs.mjs <check|test> [cargo args...]\n");
  process.exit(2);
}

let createdModelStub = false;

try {
  if (!existsSync(modelPath)) {
    await mkdir(dirname(modelPath), { recursive: true });
    await writeFile(modelPath, stubMarker, "utf8");
    createdModelStub = true;
  }

  const exitCode = await runCargo([cargoCommand, ...cargoArgs]);
  process.exitCode = exitCode;
} finally {
  if (createdModelStub) {
    await removeModelStubIfUntouched();
  }
}

function runCargo(args) {
  return new Promise((resolveExitCode, reject) => {
    const child = spawn("cargo", args, {
      cwd: tauriDir,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        process.stderr.write(`cargo ${args[0]} exited by signal ${signal}\n`);
        resolveExitCode(1);
        return;
      }
      resolveExitCode(code ?? 1);
    });
  });
}

async function removeModelStubIfUntouched() {
  try {
    const content = await readFile(modelPath, "utf8");
    if (content === stubMarker) {
      await rm(modelPath, { force: true });
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}
