#!/usr/bin/env node
/**
 * Release update manifest (G5).
 *
 * Generates — and, more importantly, re-verifies — the manifest an updater would
 * consume: version, publish time, minimum supported version, and one artifact per
 * platform with its SHA-256 and size.
 *
 * Nothing here publishes or installs. It exists so that "is this installer the one
 * we built?" has a mechanical answer, and so a future updater has a manifest whose
 * shape is already validated by `validateReleaseManifest`.
 *
 * Usage:
 *   node scripts/release/update-manifest.mjs generate --bundle-dir <dir> --base-url <https url> [--version 0.2.0] [--min-supported 0.1.0]
 *   node scripts/release/update-manifest.mjs verify --manifest <file> [--bundle-dir <dir>]
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        index += 1;
      }
      continue;
    }
    args._.push(token);
  }
  return args;
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/** Finds the installer-shaped files in a bundle directory. */
export function collectInstallers(bundleDir) {
  if (!fs.existsSync(bundleDir)) return [];
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(exe|msi)$/iu.test(entry.name)) {
        found.push(full);
      }
    }
  };
  walk(bundleDir);
  return found.sort();
}

export function platformFor(fileName) {
  if (/\.msi$/iu.test(fileName)) return "windows-x86_64-msi";
  if (/\.exe$/iu.test(fileName)) return "windows-x86_64-nsis";
  return "unknown";
}

async function generate(args) {
  const config = readJson("apps/desktop/src-tauri/tauri.conf.json");
  const version = typeof args.version === "string" ? args.version : config.version;
  const baseUrl = typeof args["base-url"] === "string" ? args["base-url"] : undefined;
  if (!baseUrl || !/^https:\/\//u.test(baseUrl)) {
    console.error("generate: --base-url must be an https URL (the manifest validation refuses plaintext).");
    process.exit(1);
  }
  const bundleDir = path.resolve(
    typeof args["bundle-dir"] === "string"
      ? args["bundle-dir"]
      : path.join(repoRoot, "apps", "desktop", "src-tauri", "target", "release", "bundle"),
  );
  const installers = collectInstallers(bundleDir);
  if (installers.length === 0) {
    console.error(`generate: no .exe/.msi installers found under ${bundleDir}.`);
    console.error("          Build the installer first (`pnpm desktop:build`), or pass --bundle-dir.");
    process.exit(1);
  }

  const artifacts = [];
  for (const installer of installers) {
    const fileName = path.basename(installer);
    artifacts.push({
      platform: platformFor(fileName),
      url: `${baseUrl.replace(/\/$/u, "")}/${encodeURIComponent(fileName)}`,
      sha256: await hashFile(installer),
      sizeBytes: fs.statSync(installer).size,
    });
  }

  const manifest = {
    version,
    publishedAt: new Date().toISOString(),
    ...(typeof args["min-supported"] === "string" ? { minSupportedVersion: args["min-supported"] } : {}),
    artifacts,
  };
  const outFile = typeof args.out === "string" ? path.resolve(args.out) : path.join(bundleDir, "update-manifest.json");
  fs.writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`generate: wrote ${outFile}`);
  for (const artifact of artifacts) {
    console.log(`  ${artifact.platform}  ${(artifact.sizeBytes / 1048576).toFixed(1)} MB  ${artifact.sha256.slice(0, 16)}…`);
  }
}

async function verify(args) {
  if (typeof args.manifest !== "string") {
    console.error("verify: --manifest <file> is required.");
    process.exit(1);
  }
  const manifestPath = path.resolve(args.manifest);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  // The full manifest validation lives in `packages/core/src/update-policy.ts` and is
  // enforced by its unit tests. A plain Node script cannot import that TypeScript
  // module, so this re-checks the two properties that decide whether an artifact may
  // be trusted at all — and says so, instead of pretending to run the real validator.
  const structural = [];
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+/u.test(manifest.version)) {
    structural.push("version must be a semver string");
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    structural.push("artifacts must be a non-empty array");
  }
  for (const [index, artifact] of (manifest.artifacts ?? []).entries()) {
    if (typeof artifact?.url !== "string" || !/^https:\/\//u.test(artifact.url)) {
      structural.push(`artifacts[${index}].url must be https`);
    }
    if (typeof artifact?.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(artifact.sha256)) {
      structural.push(`artifacts[${index}].sha256 must be a lowercase hex SHA-256`);
    }
  }
  if (structural.length > 0) {
    console.error("verify: the manifest is not usable:");
    for (const issue of structural) console.error(`  - ${issue}`);
    process.exit(1);
  }

  const bundleDir = path.resolve(
    typeof args["bundle-dir"] === "string"
      ? args["bundle-dir"]
      : path.dirname(manifestPath),
  );
  let failures = 0;
  for (const artifact of manifest.artifacts) {
    const fileName = decodeURIComponent(artifact.url.split("/").pop());
    const filePath = path.join(bundleDir, fileName);
    if (!fs.existsSync(filePath)) {
      console.error(`  MISSING ${fileName}`);
      failures += 1;
      continue;
    }
    const actual = await hashFile(filePath);
    const size = fs.statSync(filePath).size;
    const hashOk = actual === artifact.sha256;
    const sizeOk = artifact.sizeBytes === undefined || artifact.sizeBytes === size;
    if (!hashOk || !sizeOk) {
      console.error(`  MISMATCH ${fileName} (hash ${hashOk ? "ok" : "differs"}, size ${size}/${artifact.sizeBytes ?? "?"})`);
      failures += 1;
      continue;
    }
    console.log(`  OK ${fileName} ${(size / 1048576).toFixed(1)} MB`);
  }
  if (failures > 0) {
    console.error(`verify: ${failures} artifact(s) failed verification.`);
    process.exit(1);
  }
  console.log(`verify: ${manifest.artifacts.length} artifact(s) verified against ${path.basename(manifestPath)}.`);
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
if (command === "generate") {
  await generate(args);
} else if (command === "verify") {
  await verify(args);
} else {
  console.error("usage: update-manifest.mjs <generate|verify> [options]");
  process.exit(1);
}
