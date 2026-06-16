import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkPackageBoundaries } from "./check-package-boundaries.mjs";

const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "javis-boundaries-"));

async function writeFixture(relativePath, content) {
  const fullPath = path.join(rootDir, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf8");
}

await writeFixture("packages/core/package.json", JSON.stringify({ name: "@javis/core" }));
await writeFixture("packages/tools/package.json", JSON.stringify({ name: "@javis/tools" }));
await writeFixture("packages/ui/package.json", JSON.stringify({ name: "@javis/ui" }));
await writeFixture("packages/ui/src/local.ts", "export const local = true;\n");

await writeFixture("packages/ui/src/bad.ts", 'import { route } from "@javis/core";\n');
let violations = await checkPackageBoundaries(rootDir);
assert.equal(violations.length, 1);
assert.equal(violations[0].file, "packages/ui/src/bad.ts");
assert.equal(violations[0].specifier, "@javis/core");

await writeFixture("packages/ui/src/bad.ts", 'import { local } from "./local";\nconsole.log(local);\n');
violations = await checkPackageBoundaries(rootDir);
assert.deepEqual(violations, []);

await writeFixture("packages/ui/src/bad.mjs", 'import "@javis/core";\n');
violations = await checkPackageBoundaries(rootDir);
assert.equal(violations.length, 1);
assert.equal(violations[0].file, "packages/ui/src/bad.mjs");
assert.equal(violations[0].specifier, "@javis/core");

await fs.rm(path.join(rootDir, "packages/ui/src/bad.mjs"), { force: true });
await writeFixture("packages/ui/src/prefix.ts", 'import "@javis/core-utils";\n');
violations = await checkPackageBoundaries(rootDir);
assert.deepEqual(violations, []);

await writeFixture(
  "packages/core/package.json",
  JSON.stringify({ name: "@javis/core", dependencies: { "@javis/ui": "workspace:*" } }),
);
violations = await checkPackageBoundaries(rootDir);
assert.equal(violations.length, 1);
assert.equal(violations[0].file, "packages/core/package.json");
assert.equal(violations[0].specifier, "@javis/ui");

await fs.rm(rootDir, { recursive: true, force: true });
console.log("Package boundary check tests passed.");
