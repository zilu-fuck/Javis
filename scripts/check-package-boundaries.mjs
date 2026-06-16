import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT_DIR = path.resolve(__dirname, "..");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const SKIP_DIRS = new Set([".git", ".tmp", "dist", "node_modules", "target"]);

const PACKAGE_RULES = [
  {
    name: "packages/core",
    sourceDir: "packages/core/src",
    packageJson: "packages/core/package.json",
    forbiddenPrefixes: ["@javis/ui", "@javis/desktop", "@tauri-apps/"],
    forbiddenRoots: ["apps/desktop", "packages/ui"],
  },
  {
    name: "packages/tools",
    sourceDir: "packages/tools/src",
    packageJson: "packages/tools/package.json",
    forbiddenPrefixes: ["@javis/core", "@javis/ui", "@javis/desktop", "@tauri-apps/"],
    forbiddenRoots: ["apps/desktop", "packages/core", "packages/ui"],
  },
  {
    name: "packages/ui",
    sourceDir: "packages/ui/src",
    packageJson: "packages/ui/package.json",
    forbiddenPrefixes: ["@javis/core", "@javis/desktop", "@tauri-apps/"],
    forbiddenRoots: ["apps/desktop", "packages/core"],
  },
];

export async function checkPackageBoundaries(rootDir = ROOT_DIR) {
  const violations = [];

  for (const rule of PACKAGE_RULES) {
    const sourceDir = path.join(rootDir, rule.sourceDir);
    await scanSourceDir(rootDir, sourceDir, rule, violations);
    await scanPackageJson(rootDir, path.join(rootDir, rule.packageJson), rule, violations);
  }

  return violations;
}

function isInsidePath(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function scanSourceDir(rootDir, sourceDir, rule, violations) {
  if (!(await exists(sourceDir))) {
    return;
  }

  for await (const file of walk(sourceDir)) {
    const content = await fs.readFile(file, "utf8");
    for (const specifier of extractImportSpecifiers(content)) {
      if (isForbiddenSpecifier(specifier, rule)) {
        violations.push(formatViolation(rootDir, file, specifier, rule.name, `imports forbidden package "${specifier}"`));
        continue;
      }
      if (!specifier.startsWith(".")) {
        continue;
      }
      const resolved = path.resolve(path.dirname(file), specifier);
      for (const forbiddenRoot of rule.forbiddenRoots) {
        if (isInsidePath(resolved, path.join(rootDir, forbiddenRoot))) {
          violations.push(formatViolation(
            rootDir,
            file,
            specifier,
            rule.name,
            `imports from forbidden workspace path "${forbiddenRoot}"`,
          ));
          break;
        }
      }
    }
  }
}

async function scanPackageJson(rootDir, packageJsonPath, rule, violations) {
  if (!(await exists(packageJsonPath))) {
    return;
  }

  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  for (const section of sections) {
    const dependencies = packageJson[section];
    if (!dependencies || typeof dependencies !== "object") {
      continue;
    }
    for (const dependencyName of Object.keys(dependencies)) {
      if (isForbiddenSpecifier(dependencyName, rule)) {
        violations.push(formatViolation(
          rootDir,
          packageJsonPath,
          dependencyName,
          rule.name,
          `declares forbidden dependency "${dependencyName}" in ${section}`,
        ));
      }
    }
  }
}

function isForbiddenSpecifier(specifier, rule) {
  return rule.forbiddenPrefixes.some((prefix) =>
    prefix.endsWith("/")
      ? specifier.startsWith(prefix)
      : specifier === prefix || specifier.startsWith(`${prefix}/`),
  );
}

function extractImportSpecifiers(content) {
  const specifiers = [];
  const importExportRe = /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
  const dynamicImportRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  const requireRe = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

  for (const regex of [importExportRe, dynamicImportRe, requireRe]) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(content))) {
      specifiers.push(match[1]);
    }
  }

  return specifiers;
}

async function* walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      yield* walk(fullPath);
      continue;
    }
    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      yield fullPath;
    }
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function formatViolation(rootDir, filePath, specifier, ruleName, reason) {
  return {
    file: path.relative(rootDir, filePath).split(path.sep).join("/"),
    specifier,
    ruleName,
    reason,
  };
}

function printViolations(violations) {
  if (violations.length === 0) {
    console.log("Package boundary check passed.");
    return;
  }

  console.error("Package boundary violations:");
  for (const violation of violations) {
    console.error(`- ${violation.file}: ${violation.reason}`);
  }
}

async function main() {
  const violations = await checkPackageBoundaries();
  printViolations(violations);
  if (violations.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  await main();
}
