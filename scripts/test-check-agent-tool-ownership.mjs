import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  checkAgentToolOwnership,
  parseAgents,
  parseToolOwners,
} from "./check-agent-tool-ownership.mjs";

const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "javis-ownership-"));

const AGENTS = "packages/core/src/agents.ts";
const DESCRIPTORS = "packages/tools/src/descriptors.ts";

/** Writes both ownership sources, so each case differs from the baseline by one thing. */
async function writeSources({ agents, descriptors }) {
  for (const [relativePath, content] of [[AGENTS, agents], [DESCRIPTORS, descriptors]]) {
    const fullPath = path.join(rootDir, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf8");
  }
}

function agent(kind, toolNames) {
  return `  {\n    kind: "${kind}",\n    allowedToolNames: [${toolNames.map((name) => `"${name}"`).join(", ")}],\n  },\n`;
}

function descriptor(name, owners) {
  return `  {\n    name: "${name}",\n    ownerAgentKinds: [${owners.map((owner) => `"${owner}"`).join(", ")}],\n  },\n`;
}

// --- the parsers ignore nested `name:` fields (requiredInputs, schemas) -------
const parsedOwners = parseToolOwners(`
  {
    name: "file.writeText",
    permissionLevel: "confirmed_write",
    ownerAgentKinds: ["file", "doc-updater"],
    requiredInputs: [
      { name: "targetPath", type: "string" },
      { name: "content", type: "string" },
    ],
  },
`);
assert.deepEqual([...parsedOwners.keys()], ["file.writeText"]);
assert.deepEqual(parsedOwners.get("file.writeText"), ["file", "doc-updater"]);

const parsedAgents = parseAgents(`
  {
    kind: "file",
    allowedToolNames: ["file.writeText", "file.planWriteText"],
    systemPrompt: { en: "kind: \\"not-an-agent\\"", zhCN: "" },
  },
`);
assert.deepEqual([...parsedAgents.keys()], ["file"]);
assert.deepEqual(parsedAgents.get("file"), ["file.writeText", "file.planWriteText"]);

// --- consistent lists pass ----------------------------------------------------
const consistentAgents = agent("file", ["file.writeText"]) + agent("doc-updater", ["file.writeText"]);
const consistentDescriptors = descriptor("file.writeText", ["file", "doc-updater"]);

await writeSources({ agents: consistentAgents, descriptors: consistentDescriptors });
let result = await checkAgentToolOwnership(rootDir);
assert.deepEqual(result.violations, []);
assert.equal(result.agentCount, 2);
assert.equal(result.ownedToolCount, 1);

// --- an agent that holds a tool its owner list omits is a violation ----------
await writeSources({
  agents: consistentAgents + agent("commander", ["file.writeText"]),
  descriptors: consistentDescriptors,
});
result = await checkAgentToolOwnership(rootDir);
assert.equal(result.violations.length, 1);
assert.equal(result.violations[0].tool, "file.writeText");
assert.equal(result.violations[0].agent, "commander");
assert.match(result.violations[0].reason, /ownerAgentKinds/);

// --- an owner that no longer holds the tool is a violation too ---------------
await writeSources({
  agents: agent("file", ["file.writeText"]) + agent("doc-updater", []),
  descriptors: consistentDescriptors,
});
result = await checkAgentToolOwnership(rootDir);
assert.equal(result.violations.length, 1);
assert.equal(result.violations[0].agent, "doc-updater");
assert.match(result.violations[0].reason, /does not grant it that tool/);

// --- an owner that is not a registered agent kind is a violation -------------
await writeSources({
  agents: agent("file", ["file.writeText"]),
  descriptors: descriptor("file.writeText", ["file", "ghost"]),
});
result = await checkAgentToolOwnership(rootDir);
assert.equal(result.violations.length, 1);
assert.equal(result.violations[0].agent, "ghost");
assert.match(result.violations[0].reason, /no agent kind "ghost" is registered/);

// --- tools without a declared owner list are outside the surface -------------
await writeSources({
  agents: consistentAgents + agent("explorer", ["mcp.dynamicTool"]),
  descriptors: consistentDescriptors,
});
result = await checkAgentToolOwnership(rootDir);
assert.deepEqual(result.violations, []);

await fs.rm(rootDir, { recursive: true, force: true });

// --- the repository itself must stay drift-free ------------------------------
const repoResult = await checkAgentToolOwnership();
assert.deepEqual(
  repoResult.violations,
  [],
  `repository ownership drift: ${JSON.stringify(repoResult.violations, null, 2)}`,
);
assert.equal(repoResult.agentCount, 19);
assert.ok(repoResult.ownedToolCount > 0);

console.log("Agent tool ownership check tests passed.");
