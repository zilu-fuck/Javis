/**
 * Agent tool ownership check.
 *
 * Tool ownership lives in two hand-maintained lists that no compiler compares:
 *   - `packages/core/src/agents.ts`        agent  -> allowedToolNames
 *   - `packages/tools/src/descriptors.ts`  tool   -> ownerAgentKinds
 *
 * The DAG executor enforces the second list at runtime ("Tool X is not owned by
 * agent Y"), so a drift between them is a task failure waiting for the right
 * goal. This check compares both directions and fails fast instead.
 *
 * Current state: zero drift across 19 agents and every tool that declares
 * `ownerAgentKinds`. The check exists to keep it that way.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT_DIR = path.resolve(__dirname, "..");
const AGENTS_SOURCE = "packages/core/src/agents.ts";
const DESCRIPTORS_SOURCE = "packages/tools/src/descriptors.ts";

/** Top-level descriptor fields are indented exactly four spaces. */
const AGENT_KIND_PATTERN = /^ {4}kind:\s*"([a-z0-9-]+)"/gm;
const TOOL_NAME_PATTERN = /^ {4}name:\s*"([^"]+)"/gm;

export async function checkAgentToolOwnership(rootDir = ROOT_DIR) {
  const agents = parseAgents(await fs.readFile(path.join(rootDir, AGENTS_SOURCE), "utf8"));
  const toolOwners = parseToolOwners(await fs.readFile(path.join(rootDir, DESCRIPTORS_SOURCE), "utf8"));

  const violations = [];
  for (const [agentKind, toolNames] of agents) {
    for (const toolName of toolNames) {
      const owners = toolOwners.get(toolName);
      // Tools without a declared owner list are outside the ownership surface
      // (dynamic MCP tools never appear in descriptors.ts at all).
      if (!owners) continue;
      if (!owners.includes(agentKind)) {
        violations.push({
          file: AGENTS_SOURCE,
          tool: toolName,
          agent: agentKind,
          reason: `"${agentKind}" may call ${toolName}, but ${DESCRIPTORS_SOURCE} does not list it in ownerAgentKinds (${owners.join(", ")})`,
        });
      }
    }
  }
  for (const [toolName, owners] of toolOwners) {
    for (const owner of owners) {
      // An owner that is not a registered agent kind cannot ever be satisfied by
      // the DAG executor, so a stale reference is flagged like a drift.
      const toolNames = agents.get(owner) ?? [];
      if (!toolNames.includes(toolName)) {
        violations.push({
          file: DESCRIPTORS_SOURCE,
          tool: toolName,
          agent: owner,
          reason: agents.has(owner)
            ? `${toolName} lists "${owner}" in ownerAgentKinds, but ${AGENTS_SOURCE} does not grant it that tool`
            : `${toolName} lists "${owner}" in ownerAgentKinds, but no agent kind "${owner}" is registered in ${AGENTS_SOURCE}`,
        });
      }
    }
  }

  return { violations, agentCount: agents.size, ownedToolCount: toolOwners.size };
}

export function parseAgents(source) {
  const chunks = splitOnMatches(source, AGENT_KIND_PATTERN);
  const agents = new Map();
  for (const { key, text } of chunks) {
    const allowed = text.match(/^ {4}allowedToolNames:\s*\[([\s\S]*?)\]/m);
    if (!allowed) continue;
    agents.set(key, [...allowed[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]));
  }
  return agents;
}

export function parseToolOwners(source) {
  const chunks = splitOnMatches(source, TOOL_NAME_PATTERN);
  const owners = new Map();
  for (const { key, text } of chunks) {
    const declared = text.match(/ownerAgentKinds:\s*\[([^\]]*)\]/);
    if (!declared) continue;
    owners.set(key, [...declared[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]));
  }
  return owners;
}

/** Slices `source` into one chunk per regex match, keyed by its first capture group. */
function splitOnMatches(source, pattern) {
  const marks = [];
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    marks.push({ key: match[1], at: match.index });
  }
  return marks.map((mark, index) => ({
    key: mark.key,
    text: source.slice(mark.at, index + 1 < marks.length ? marks[index + 1].at : source.length),
  }));
}

function printResult({ violations, agentCount, ownedToolCount }) {
  if (violations.length === 0) {
    console.log(`Agent tool ownership check passed (${agentCount} agents, ${ownedToolCount} tools with declared owners).`);
    return;
  }
  console.error("Agent tool ownership violations:");
  for (const violation of violations) {
    console.error(`- ${violation.tool} / ${violation.agent}: ${violation.reason}`);
  }
}

async function main() {
  const result = await checkAgentToolOwnership();
  printResult(result);
  if (result.violations.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  await main();
}
