#!/usr/bin/env node

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const DEFAULT_OUTPUT_DIR = "artifacts/local-vision/node_modules";
const NAPI_VERSION = "napi-v6";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(helpText());
    return;
  }

  const platform = args.platform || process.platform;
  const arch = args.arch || process.arch;
  const outputRoot = resolve(args.output || DEFAULT_OUTPUT_DIR);

  assertSupportedPlatform(platform, arch);

  const nodeSource = packageRoot("onnxruntime-node");
  const commonSource = dependencyPackageRoot(nodeSource, "onnxruntime-common");
  const commonPackage = await readPackageJson(commonSource);
  const nodePackage = await readPackageJson(nodeSource);

  await mkdir(outputRoot, { recursive: true });
  await copyCommonRuntime(commonSource, resolve(outputRoot, "onnxruntime-common"));
  await copyNodeRuntime(nodeSource, resolve(outputRoot, "onnxruntime-node"), platform, arch);
  await writeFile(
    resolve(outputRoot, "manifest.json"),
    JSON.stringify({
      name: "javis-local-vision-onnxruntime-runtime",
      platform,
      arch,
      packages: {
        "onnxruntime-common": commonPackage.version,
        "onnxruntime-node": nodePackage.version,
      },
      preparedAt: new Date().toISOString(),
    }, null, 2),
  );

  process.stdout.write(`prepared local vision ONNX runtime: onnxruntime-node@${nodePackage.version} ${platform}/${arch}\n`);
}

async function copyCommonRuntime(sourceRoot, targetRoot) {
  await resetDir(targetRoot);
  await copyEntry(sourceRoot, targetRoot, "package.json");
  await copyEntry(sourceRoot, targetRoot, "README.md", { optional: true });
  await copyEntry(sourceRoot, targetRoot, "dist");
}

async function copyNodeRuntime(sourceRoot, targetRoot, platform, arch) {
  await resetDir(targetRoot);
  await copyEntry(sourceRoot, targetRoot, "package.json");
  await copyEntry(sourceRoot, targetRoot, "README.md", { optional: true });
  await copyEntry(sourceRoot, targetRoot, "dist");
  await copyEntry(sourceRoot, targetRoot, `bin/${NAPI_VERSION}/${platform}/${arch}`);
}

async function resetDir(path) {
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
}

async function copyEntry(sourceRoot, targetRoot, relativePath, options = {}) {
  const source = resolve(sourceRoot, ...relativePath.split("/"));
  const target = resolve(targetRoot, ...relativePath.split("/"));
  try {
    statSync(source);
  } catch (error) {
    if (options.optional) return;
    throw new Error(`missing runtime source ${relativePath}: ${error.message}`);
  }
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, force: true });
}

function packageRoot(name) {
  return dirname(require.resolve(`${name}/package.json`));
}

function dependencyPackageRoot(packageDir, dependencyName) {
  const candidate = resolve(packageDir, "..", dependencyName);
  try {
    const info = statSync(resolve(candidate, "package.json"));
    if (info.isFile()) {
      return candidate;
    }
  } catch {
    // Fall back to Node resolution for package managers that hoist dependencies.
  }
  return packageRoot(dependencyName);
}

async function readPackageJson(packageDir) {
  return JSON.parse(await readFile(resolve(packageDir, "package.json"), "utf8"));
}

function assertSupportedPlatform(platform, arch) {
  const supported = new Set([
    "win32:x64",
    "win32:arm64",
    "linux:x64",
    "linux:arm64",
    "darwin:arm64",
  ]);
  const key = `${platform}:${arch}`;
  if (!supported.has(key)) {
    throw new Error(`unsupported onnxruntime-node runtime target: ${key}`);
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

function helpText() {
  return `Usage: node scripts/prepare-local-vision-onnxruntime-runtime.mjs [options]

Options:
  --output <dir>      Output node_modules directory. Defaults to artifacts/local-vision/node_modules.
  --platform <name>   Runtime platform. Defaults to current process platform.
  --arch <name>       Runtime architecture. Defaults to current process architecture.
`;
}

main().catch((error) => {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
