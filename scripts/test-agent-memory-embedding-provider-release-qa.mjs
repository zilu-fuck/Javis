#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const scriptPath = resolve(repoRoot, "docs", "qa", "2026-06-10", "agent-memory-embedding-provider", "agent-memory-embedding-provider-release-qa.ps1");

async function main() {
  const root = await mkdtemp(join(tmpdir(), "javis-embedding-provider-qa-"));
  try {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "44-agent-memory-embedding-settings.png"), "png placeholder");
    await writeFile(
      join(root, "agent-memory-embedding-provider-manual-qa-evidence.md"),
      [
        "# Manual evidence",
        "Date: 2026-06-11",
        "Operator: qa",
        "Build: 0.1.0",
        "Result: PASS",
        "Artifacts: 44-agent-memory-embedding-settings.png, agent-memory-embedding-provider-live-qa-output.txt",
        "- EMBEDDING-QA-01: PASS",
        "- EMBEDDING-QA-02: PASS",
        "- EMBEDDING-QA-03: PASS",
        "- EMBEDDING-QA-04: PASS",
      ].join("\n"),
    );

    const result = await runPowerShell([
      "-QaRoot",
      root,
      "-LocalEmbedding",
      "pass",
      "-NativeOpenAiCompatible",
      "pass",
      "-SecretReference",
      "pass",
      "-VectorSearch",
      "pass",
    ]);
    assert(result.code === 0, `Embedding provider QA helper should pass\n${result.stdout}\n${result.stderr}`);

    const outputText = await readFile(join(root, "agent-memory-embedding-provider-live-qa-output.txt"), "utf8");
    const outputJson = JSON.parse(outputText.split("json:\n")[1]);
    assert(outputJson.PackagedApp === true, "output should record packaged app provenance");
    assert(typeof outputJson.AppVersion === "string" && outputJson.AppVersion.length > 0, "output should record app version");
    assert(/^\d{4}-\d{2}-\d{2}$/.test(outputJson.QaDate), "output should record concrete QA date");
    assert(outputJson.Artifacts.includes("44-agent-memory-embedding-settings.png"), "output should reference settings screenshot");
    assert(outputJson.localEmbedding === "pass", "output should record local embedding pass");
    assert(outputJson.nativeOpenAiCompatible === "pass", "output should record native OpenAI-compatible pass");
    assert(outputJson.secretReference === "pass", "output should record secret reference pass");
    assert(outputJson.vectorSearch === "pass", "output should record vector search pass");
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  process.stdout.write("Agent memory embedding provider release QA helper test passed\n");
}

function runPowerShell(args) {
  return new Promise((resolvePromise) => {
    const child = spawn("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      ...args,
    ], { cwd: repoRoot });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
