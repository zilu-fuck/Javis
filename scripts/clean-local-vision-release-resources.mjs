#!/usr/bin/env node

import { rm } from "node:fs/promises";
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
  const targets = [
    "bin/node",
    "models/local-vision",
    "scripts/local-vision-worker.cmd",
    "scripts/local-vision-worker.mjs",
    "scripts/local-vision-onnx-adapter.mjs",
    "scripts/node_modules/onnxruntime-common",
    "scripts/node_modules/onnxruntime-node",
  ];

  for (const target of targets) {
    await rm(resolve(releaseDir, ...target.split("/")), { recursive: true, force: true });
  }

  process.stdout.write(`cleaned local vision release resources: ${safePathLabel(releaseDir)}\n`);
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
  return `Usage: node scripts/clean-local-vision-release-resources.mjs [options]

Options:
  --release-dir <dir>  Tauri release output directory.
`;
}

main().catch((error) => {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
