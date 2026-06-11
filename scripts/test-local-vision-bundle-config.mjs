#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";

async function main() {
  const configPath = "apps/desktop/src-tauri/tauri.conf.json";
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const configDir = dirname(resolve(configPath));
  assert(config?.build?.beforeBuildCommand === "corepack pnpm build:bundle", "tauri beforeBuildCommand must prepare local vision Node runtime before packaging");
  const resources = config?.bundle?.resources;
  assert(resources && typeof resources === "object" && !Array.isArray(resources), "bundle.resources must be an object");

  const requiredTargets = [
    "scripts/local-vision-worker.cmd",
    "scripts/local-vision-worker.mjs",
    "scripts/local-vision-onnx-adapter.mjs",
    "models/local-vision/yolo26n-ui.onnx",
    "scripts/node_modules/onnxruntime-common/",
    "scripts/node_modules/onnxruntime-node/",
    "bin/node/",
  ];
  const resourceTargets = new Set(Object.values(resources));
  for (const target of requiredTargets) {
    assert(resourceTargets.has(target), `missing local vision bundled resource target: ${target}`);
    const source = sourceForTarget(resources, target);
    assert(source, `missing local vision bundled resource source for target: ${target}`);
    assertResourceSourceExists(configDir, source, target);
  }

  const onnxRuntimeNodeSource = sourceForTarget(resources, "scripts/node_modules/onnxruntime-node/");
  const onnxRuntimeNodePackage = JSON.parse(await readFile(
    resolve(configDir, onnxRuntimeNodeSource, "package.json"),
    "utf8",
  ));
  assert(
    onnxRuntimeNodePackage?.dependencies?.["onnxruntime-common"],
    "onnxruntime-node package requires onnxruntime-common but bundle resource is missing or stale",
  );

  const bundledNodeSource = sourceForTarget(resources, "bin/node/");
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  assertResourceSourceExists(configDir, `${bundledNodeSource}/${nodeName}`, `bin/node/${nodeName}`);

  process.stdout.write("local vision bundle config test passed\n");
}

function sourceForTarget(resources, target) {
  for (const [source, candidateTarget] of Object.entries(resources)) {
    if (candidateTarget === target) return source;
  }
  return undefined;
}

function assertResourceSourceExists(configDir, source, target) {
  const sourcePath = resolve(configDir, source);
  let info;
  try {
    info = statSync(sourcePath);
  } catch (error) {
    throw new Error(`missing local vision bundle source for ${target}: ${sourcePath}; ${error.message}`);
  }
  if (target.endsWith("/")) {
    assert(info.isDirectory(), `local vision bundle source for ${target} must be a directory: ${sourcePath}`);
  } else {
    assert(info.isFile(), `local vision bundle source for ${target} must be a file: ${sourcePath}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
