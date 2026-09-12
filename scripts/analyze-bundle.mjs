#!/usr/bin/env node
/**
 * Bundle contributor analysis (G2b).
 *
 * The build reports "some chunks are larger than 500 kB", which names a chunk but not a
 * cause. This runs the real desktop build with an extra plugin that sums each module's
 * rendered length, so the largest contributor is identified by measurement instead of by
 * guessing which dependency looks heavy.
 *
 * Usage: node scripts/analyze-bundle.mjs [--top 25] [--chunk vendor]
 */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const topCount = Number(args[args.indexOf("--top") + 1]) || 25;
const onlyChunk = args.includes("--chunk") ? args[args.indexOf("--chunk") + 1] : undefined;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = path.join(repoRoot, "apps", "desktop");

const chunkModules = new Map();
const globalModules = new Map();

// Vite is a desktop-app dependency, so it is resolved from there rather than from this
// script's location (bare imports resolve relative to the importing file).
const requireFromDesktop = createRequire(path.join(desktopRoot, "package.json"));
const { build } = await import(pathToFileURL(requireFromDesktop.resolve("vite")).href);

await build({
  root: desktopRoot,
  configFile: path.join(desktopRoot, "vite.config.ts"),
  logLevel: "error",
  plugins: [
    {
      name: "javis-analyze-bundle",
      generateBundle(_options, bundle) {
        for (const [fileName, output] of Object.entries(bundle)) {
          if (output.type !== "chunk") continue;
          for (const [id, mod] of Object.entries(output.modules ?? {})) {
            const size = mod.renderedLength ?? 0;
            globalModules.set(id, (globalModules.get(id) ?? 0) + size);
            const perChunk = chunkModules.get(fileName) ?? new Map();
            perChunk.set(id, (perChunk.get(id) ?? 0) + size);
            chunkModules.set(fileName, perChunk);
          }
        }
      },
    },
  ],
});

function shortName(id) {
  const normalized = id.replace(/\\/gu, "/");
  const marker = normalized.lastIndexOf("node_modules/");
  if (marker >= 0) {
    // Collapse a pnpm store path to the package name that identifies it.
    const rest = normalized.slice(marker + "node_modules/".length);
    const parts = rest.split("/");
    return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
  }
  return normalized.replace(`${repoRoot.replace(/\\/gu, "/")}/`, "");
}

/** Aggregates by package so a hundred tiny modules do not hide the one real cause. */
function byPackage(entries) {
  const packages = new Map();
  for (const [id, size] of entries) {
    const name = shortName(id);
    packages.set(name, (packages.get(name) ?? 0) + size);
  }
  return [...packages.entries()].sort((left, right) => right[1] - left[1]);
}

const targets = onlyChunk
  ? [...chunkModules.entries()].filter(([fileName]) => fileName.includes(onlyChunk))
  : [...chunkModules.entries()].sort(
      (left, right) => total(right[1]) - total(left[1]),
    ).slice(0, 1);

function total(map) {
  let sum = 0;
  for (const size of map.values()) {
    sum += size;
  }
  return sum;
}

for (const [fileName, modules] of targets) {
  console.log(`\n=== ${fileName} (${(total(modules) / 1024).toFixed(0)} kB rendered) ===`);
  console.log("by package:");
  for (const [name, size] of byPackage(modules).slice(0, topCount)) {
    console.log(`  ${(size / 1024).toFixed(0).padStart(7)} kB  ${name}`);
  }
  console.log("largest individual modules:");
  for (const [id, size] of [...modules.entries()].sort((left, right) => right[1] - left[1]).slice(0, 10)) {
    console.log(`  ${(size / 1024).toFixed(0).padStart(7)} kB  ${shortName(id)}  ${id.replace(repoRoot, ".").slice(0, 110)}`);
  }
}

console.log("\n=== whole build, by package ===");
for (const [name, size] of byPackage(globalModules).slice(0, topCount)) {
  console.log(`  ${(size / 1024).toFixed(0).padStart(7)} kB  ${name}`);
}
