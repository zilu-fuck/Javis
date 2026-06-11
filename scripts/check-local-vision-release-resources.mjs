#!/usr/bin/env node

import { access, constants, readdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RELEASE_DIR = resolve(__dirname, "..", "apps", "desktop", "src-tauri", "target", "release");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(helpText());
    return;
  }

  const releaseDir = resolve(args.releaseDir || DEFAULT_RELEASE_DIR);
  const required = [
    { path: "bin/node/node.exe", type: "file", platforms: ["win32"] },
    { path: "bin/node/node", type: "file", platforms: ["darwin", "linux"] },
    { path: "bin/node/manifest.json", type: "file" },
    { path: "scripts/local-vision-worker.mjs", type: "file" },
    { path: "scripts/local-vision-worker.cmd", type: "file", platforms: ["win32"] },
    { path: "scripts/local-vision-onnx-adapter.mjs", type: "file" },
    { path: "models/local-vision/yolo26n-ui.onnx", type: "file" },
    { path: "scripts/node_modules/onnxruntime-common/package.json", type: "file" },
    { path: "scripts/node_modules/onnxruntime-node/package.json", type: "file" },
    { path: "scripts/node_modules/onnxruntime-node/dist/index.js", type: "file" },
    { path: `scripts/node_modules/onnxruntime-node/bin/napi-v6/win32/${process.arch}/onnxruntime_binding.node`, type: "file", platforms: ["win32"] },
    { path: `scripts/node_modules/onnxruntime-node/bin/napi-v6/win32/${process.arch}/onnxruntime.dll`, type: "file", platforms: ["win32"] },
  ];

  for (const entry of required) {
    if (entry.platforms && !entry.platforms.includes(process.platform)) {
      continue;
    }
    await assertPath(resolve(releaseDir, entry.path), entry);
  }
  await assertNoPath(resolve(releaseDir, "scripts", "node_modules", "onnxruntime-node", "lib"), "scripts/node_modules/onnxruntime-node/lib");
  await assertNoPath(resolve(releaseDir, "scripts", "node_modules", "onnxruntime-node", "script"), "scripts/node_modules/onnxruntime-node/script");
  await assertOnlyCurrentNativeRuntime(resolve(releaseDir, "scripts", "node_modules", "onnxruntime-node", "bin", "napi-v6"));

  process.stdout.write(`local vision release resources verified: ${safePathLabel(releaseDir)}\n`);
}

async function assertPath(path, entry) {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    throw new Error(`missing release resource ${entry.path}: ${error.message}`);
  }
  if (entry.type === "file" && !info.isFile()) {
    throw new Error(`release resource is not a file: ${entry.path}`);
  }
  await access(path, constants.R_OK);
}

async function assertNoPath(path, label) {
  try {
    await stat(path);
  } catch {
    return;
  }
  throw new Error(`unexpected stale release resource: ${label}`);
}

async function assertOnlyCurrentNativeRuntime(nativeRoot) {
  const expected = `${process.platform}/${process.arch}`;
  const platformEntries = await readdir(nativeRoot, { withFileTypes: true });
  for (const platformEntry of platformEntries) {
    if (!platformEntry.isDirectory()) continue;
    const archRoot = resolve(nativeRoot, platformEntry.name);
    const archEntries = await readdir(archRoot, { withFileTypes: true });
    for (const archEntry of archEntries) {
      if (!archEntry.isDirectory()) continue;
      const candidate = `${platformEntry.name}/${archEntry.name}`;
      if (candidate !== expected) {
        throw new Error(`unexpected stale native runtime target: ${candidate}`);
      }
    }
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

function safePathLabel(path) {
  return String(path).replace(/\\/g, "/").replace(/^[A-Za-z]:/, "<drive>");
}

function helpText() {
  return `Usage: node scripts/check-local-vision-release-resources.mjs [options]

Options:
  --release-dir <dir>  Tauri release output directory.
`;
}

main().catch((error) => {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
