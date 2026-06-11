#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const scriptPath = resolve(repoRoot, "docs", "qa", "2026-06-10", "capability-scoring-evidence-ingestion", "capability-scoring-evidence-ingestion-release-qa.ps1");

async function main() {
  const root = await mkdtemp(join(tmpdir(), "javis-capability-scoring-qa-"));
  try {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "45-capability-scoring-evidence-ingestion.png"), "png placeholder");
    await writeFile(
      join(root, "capability-scoring-evidence-ingestion-manual-qa-evidence.md"),
      [
        "# Manual evidence",
        "Date: 2026-06-11",
        "Operator: qa",
        "Build: 0.1.0",
        "Result: PASS",
        "Artifacts: 45-capability-scoring-evidence-ingestion.png, capability-scoring-evidence-ingestion-qa-output.txt",
        "- CAPABILITY-QA-01: PASS",
        "- CAPABILITY-QA-02: PASS",
        "- CAPABILITY-QA-03: PASS",
        "- CAPABILITY-QA-04: PASS",
      ].join("\n"),
    );

    const result = await runPowerShell([
      "-QaRoot",
      root,
      "-QaEvidence",
      "pass",
      "-LiveEvidence",
      "pass",
      "-EvidenceRefs",
      "pass",
      "-RecentFailureRate",
      "pass",
      "-EvidenceReference",
      "docs/qa/2026-06-10/product-workflows.json#capability-scoring-evidence-ingestion",
      "-RecentFailureRateValue",
      "0.25",
    ]);
    assert(result.code === 0, `Capability scoring QA helper should pass\n${result.stdout}\n${result.stderr}`);

    const outputText = await readFile(join(root, "capability-scoring-evidence-ingestion-qa-output.txt"), "utf8");
    const outputJson = JSON.parse(outputText.split("json:\n")[1]);
    assert(outputJson.PackagedApp === true, "output should record packaged app provenance");
    assert(typeof outputJson.AppVersion === "string" && outputJson.AppVersion.length > 0, "output should record app version");
    assert(/^\d{4}-\d{2}-\d{2}$/.test(outputJson.QaDate), "output should record concrete QA date");
    assert(outputJson.Artifacts.includes("45-capability-scoring-evidence-ingestion.png"), "output should reference inspector screenshot");
    assert(outputJson.qaEvidence === "pass", "output should record QA evidence pass");
    assert(outputJson.liveEvidence === "pass", "output should record live evidence pass");
    assert(outputJson.evidenceRefs === "pass", "output should record evidence refs pass");
    assert(outputJson.recentFailureRate === "pass", "output should record recent failure rate pass");
    assert(
      outputJson.EvidenceReferences.includes("docs/qa/2026-06-10/product-workflows.json#capability-scoring-evidence-ingestion"),
      "output should include concrete evidence references",
    );
    assert(outputJson.RecentFailureRateValue === 0.25, "output should record numeric recent failure rate");
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  process.stdout.write("Capability scoring evidence ingestion release QA helper test passed\n");
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
