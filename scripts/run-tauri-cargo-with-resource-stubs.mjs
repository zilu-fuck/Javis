#!/usr/bin/env node
import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const tauriDir = resolve(repoRoot, "apps", "desktop", "src-tauri");
const stubMarker = "JAVIS_CARGO_RESOURCE_STUB_DO_NOT_BUNDLE\n";
const allowedCargoCommands = new Set(["check", "test"]);

// tauri.conf.json resources additionally reference these local-vision
// entries. Without them, tauri-build fails even for source-only cargo
// check/test, so each missing entry is stubbed and cleaned up afterwards
// if untouched. File entries are stubbed as marker files; directory
// entries as marker files inside an empty directory.
const stubResources = [
  { path: resolve(repoRoot, "artifacts", "local-vision", "yolo26n-ui.onnx"), isDirectory: false },
  { path: resolve(repoRoot, "artifacts", "local-vision", "node_modules", "onnxruntime-common"), isDirectory: true },
  { path: resolve(repoRoot, "artifacts", "local-vision", "node_modules", "onnxruntime-node"), isDirectory: true },
  { path: resolve(repoRoot, "artifacts", "local-vision", "node-runtime"), isDirectory: true },
];

const cargoCommand = process.argv[2];
const cargoArgs = process.argv.slice(3);

if (!allowedCargoCommands.has(cargoCommand)) {
  process.stderr.write("Usage: node scripts/run-tauri-cargo-with-resource-stubs.mjs <check|test> [cargo args...]\n");
  process.exit(2);
}

const createdStubs = [];

try {
  for (const { path: resourcePath, isDirectory } of stubResources) {
    if (existsSync(resourcePath)) continue;
    if (isDirectory) {
      await mkdir(resourcePath, { recursive: true });
      await writeFile(resolve(resourcePath, ".stub-marker"), stubMarker, "utf8");
    } else {
      await mkdir(dirname(resourcePath), { recursive: true });
      await writeFile(resourcePath, stubMarker, "utf8");
    }
    createdStubs.push(resourcePath);
  }

  const exitCode = await runCargo([cargoCommand, ...cargoArgs]);
  process.exitCode = exitCode;
} finally {
  for (const { path: resourcePath, isDirectory } of stubResources) {
    if (!createdStubs.includes(resourcePath)) continue;
    await removeStubIfUntouched(resourcePath, isDirectory);
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

async function removeStubIfUntouched(resourcePath, isDirectory) {
  try {
    if (isDirectory) {
      const markerPath = resolve(resourcePath, ".stub-marker");
      const content = await readFile(markerPath, "utf8");
      if (content !== stubMarker) return;
      await rm(markerPath, { force: true });
    } else {
      const content = await readFile(resourcePath, "utf8");
      if (content !== stubMarker) return;
      await rm(resourcePath, { force: true });
    }
    // Remove the stub path and any parent directory that became empty as
    // a result. Non-recursive so sibling stubs or real resources are
    // never touched. Windows can briefly hold directory handles after
    // marker deletion, so retry a few times before giving up.
    let current = resourcePath;
    while (current.startsWith(resolve(repoRoot, "artifacts"))) {
      try {
        await removeEmptyDirectory(current);
      } catch {
        break;
      }
      current = dirname(current);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

async function removeEmptyDirectory(directoryPath) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      // fs.rm rejects empty directories with ERR_FS_EISDIR on Node 22;
      // rmdir is the dedicated empty-directory removal primitive.
      await rmdir(directoryPath);
      return;
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
