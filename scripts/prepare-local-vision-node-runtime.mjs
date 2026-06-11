#!/usr/bin/env node

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { basename, resolve } from "node:path";

const DEFAULT_OUTPUT_DIR = "artifacts/local-vision/node-runtime";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(helpText());
    return;
  }

  const source = resolve(args.source || process.execPath);
  const outputDir = resolve(args.output || DEFAULT_OUTPUT_DIR);
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  const target = resolve(outputDir, nodeName);

  assertExecutableFile(source, "--source");
  if (basename(source).toLowerCase() !== nodeName) {
    throw new Error(`--source must point to ${nodeName}, got ${basename(source)}`);
  }

  await mkdir(outputDir, { recursive: true });
  await copyFile(source, target);
  await writeFile(
    resolve(outputDir, "manifest.json"),
    JSON.stringify({
      name: "javis-local-vision-node-runtime",
      version: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      source: basename(source),
      target: nodeName,
      preparedAt: new Date().toISOString(),
    }, null, 2),
  );

  process.stdout.write(`prepared local vision Node runtime: ${nodeName}\n`);
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
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for ${arg}`);
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

function assertExecutableFile(path, label) {
  let info;
  try {
    info = statSync(path);
  } catch (error) {
    throw new Error(`${label} does not exist: ${path}; ${error.message}`);
  }
  if (!info.isFile()) {
    throw new Error(`${label} is not a file: ${path}`);
  }
}

function helpText() {
  return `Usage: node scripts/prepare-local-vision-node-runtime.mjs [options]

Options:
  --source <node-exe>  Node executable to copy. Defaults to current process.
  --output <dir>       Output directory. Defaults to artifacts/local-vision/node-runtime.
`;
}

main().catch((error) => {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
