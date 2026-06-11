#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const scriptPath = resolve(__dirname, "qa", "check-computer-use-evidence.ps1");

const scenarioIds = [
  "CU-QA-01",
  "CU-QA-02",
  "CU-QA-03",
  "CU-QA-04",
  "CU-QA-05",
  "CU-QA-06",
  "CU-QA-07",
  "CU-QA-08",
];

async function main() {
  await verifyManualEvidenceTemplate();

  const root = await mkdtemp(join(tmpdir(), "javis-computer-use-qa-"));
  try {
    const qaRoot = join(root, "computer-use");
    await writeQaEvidence(qaRoot, "manual");

    const defaultCheck = await runCheck(["-QaRoot", qaRoot]);
    assert(defaultCheck.code === 0, `default check should pass: ${defaultCheck.stderr || defaultCheck.stdout}`);
    assert(defaultCheck.stdout.includes("scenario-status-not-overclaimed"), "default check should enforce non-overclaim status");

    await rm(join(qaRoot, "01-computer-use-release-app.png"), { force: true });
    const missingScreenshot = await runCheck(["-QaRoot", qaRoot]);
    assert(missingScreenshot.code !== 0, "default check should fail when screenshot evidence is missing");
    assert(
      missingScreenshot.stdout.includes("screenshot-exists") &&
      missingScreenshot.stderr.includes("failing check"),
      `missing screenshot failure should report the screenshot existence check\nSTDOUT:\n${missingScreenshot.stdout}\nSTDERR:\n${missingScreenshot.stderr}`,
    );

    await writeQaEvidence(qaRoot, "manual");
    const strictManual = await runCheck(["-QaRoot", qaRoot, "-RequireManualScenarioPass"]);
    assert(strictManual.code !== 0, "strict manual scenario gate should fail while rows are manual opt-in");
    assert(
      strictManual.stdout.includes("scenario-CU-QA-01-pass") &&
      strictManual.stderr.includes("failing check"),
      "strict failure should report manual scenario rows",
    );

    await writeQaEvidence(qaRoot, "pass");
    const strictMissingEvidence = await runCheck(["-QaRoot", qaRoot, "-RequireManualScenarioPass"]);
    assert(strictMissingEvidence.code !== 0, "strict manual scenario gate should fail without manual evidence note");
    assert(
      strictMissingEvidence.stdout.includes("manual-evidence-exists") &&
      strictMissingEvidence.stderr.includes("failing check"),
      "strict failure should report missing manual evidence note",
    );

    await writeManualEvidence(qaRoot, "FAIL");
    const strictFailingEvidence = await runCheck(["-QaRoot", qaRoot, "-RequireManualScenarioPass"]);
    assert(strictFailingEvidence.code !== 0, "strict manual scenario gate should fail when manual evidence result is not PASS");
    assert(
      strictFailingEvidence.stdout.includes("manual-evidence-result") &&
      strictFailingEvidence.stderr.includes("failing check"),
      "strict failure should report non-PASS manual evidence result",
    );

    await writeManualEvidence(qaRoot, "PASS", "CU-QA-04");
    const strictPartialScenarioEvidence = await runCheck(["-QaRoot", qaRoot, "-RequireManualScenarioPass"]);
    assert(strictPartialScenarioEvidence.code !== 0, "strict manual scenario gate should fail when any manual scenario evidence is not PASS");
    assert(
      strictPartialScenarioEvidence.stdout.includes("manual-evidence-CU-QA-04") &&
      strictPartialScenarioEvidence.stderr.includes("failing check"),
      "strict failure should report the non-PASS manual scenario evidence row",
    );

    await writeManualEvidence(qaRoot, "PASS", undefined, { omitScenarioDetails: true });
    const strictMissingScenarioDetail = await runCheck(["-QaRoot", qaRoot, "-RequireManualScenarioPass"]);
    assert(strictMissingScenarioDetail.code !== 0, "strict manual scenario gate should fail when scenario evidence detail is missing");
    assert(
      strictMissingScenarioDetail.stdout.includes("manual-evidence-CU-QA-01-detail") &&
      strictMissingScenarioDetail.stderr.includes("failing check"),
      "strict failure should report missing scenario evidence detail",
    );

    await writeManualEvidence(qaRoot, "PASS", undefined, { omitArtifactsLine: true });
    const strictMissingArtifactsLine = await runCheck(["-QaRoot", qaRoot, "-RequireManualScenarioPass"]);
    assert(strictMissingArtifactsLine.code !== 0, "strict manual scenario gate should fail without an Artifacts line");
    assert(
      strictMissingArtifactsLine.stdout.includes("manual-evidence-artifacts") &&
      strictMissingArtifactsLine.stderr.includes("failing check"),
      `strict failure should report missing manual artifact line\nSTDOUT:\n${strictMissingArtifactsLine.stdout}\nSTDERR:\n${strictMissingArtifactsLine.stderr}`,
    );

    await writeManualEvidence(qaRoot, "PASS", undefined, { artifactLine: "Artifacts: missing-manual-proof.png" });
    const strictMissingArtifactFile = await runCheck(["-QaRoot", qaRoot, "-RequireManualScenarioPass"]);
    assert(strictMissingArtifactFile.code !== 0, "strict manual scenario gate should fail when referenced artifacts do not exist");
    assert(
      strictMissingArtifactFile.stdout.includes("manual-evidence-artifacts-exist") &&
      strictMissingArtifactFile.stderr.includes("failing check"),
      "strict failure should report missing manual artifact references",
    );

    await writeManualEvidence(qaRoot, "PASS");
    const strictPass = await runCheck(["-QaRoot", qaRoot, "-RequireManualScenarioPass"]);
    assert(strictPass.code === 0, `strict check should pass once all scenario rows are PASS: ${strictPass.stderr || strictPass.stdout}`);
    assert(strictPass.stdout.includes("scenario-status-full-pass"), "strict check should report full-pass gate");
    assert(strictPass.stdout.includes("manual-evidence-CU-QA-08"), "strict check should validate manual evidence coverage");
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  process.stdout.write("Computer Use QA evidence checker test passed\n");
}

async function verifyManualEvidenceTemplate() {
  const templatePath = join(
    repoRoot,
    "docs",
    "qa",
    "2026-06-09",
    "computer-use",
    "computer-use-manual-qa-evidence.template.md",
  );
  const templateText = await readFile(templatePath, "utf8");

  assert(
    /^\s*Result:\s*PENDING\s*$/im.test(templateText),
    "manual QA evidence template should stay in PENDING state",
  );
  assert(
    !/^\s*Result:\s*PASS\s*$/im.test(templateText),
    "manual QA evidence template must not claim Result: PASS",
  );
  assert(!templateText.includes("data:image"), "manual QA evidence template must not include screenshot data URLs");
  for (const scenarioId of scenarioIds) {
    assert(templateText.includes(scenarioId), `manual QA evidence template should include ${scenarioId}`);
    assert(
      new RegExp(`^\\s*-\\s*${scenarioId}:\\s*PENDING\\b`, "im").test(templateText),
      `manual QA evidence template should keep ${scenarioId} as PENDING`,
    );
  }
}

async function writeQaEvidence(qaRoot, scenarioMode) {
  await mkdir(qaRoot, { recursive: true });
  await writeFile(join(qaRoot, "computer-use-release-qa-report.md"), "# Computer Use Release QA\n\nResult: PASS\n");
  await writeFile(join(qaRoot, "01-computer-use-release-app.png"), "png");
  await writeFile(
    join(qaRoot, "computer-use-qa-scenarios.md"),
    scenarioMode === "pass" ? scenarioChecklistPass() : scenarioChecklistManual(),
  );
  await writeFile(
    join(qaRoot, "computer-use-release-qa-output.json"),
    JSON.stringify(createEvidenceJson(), null, 2),
  );
}

async function writeManualEvidence(qaRoot, result, failingScenarioId, options = {}) {
  const artifactLines = options.omitArtifactsLine
    ? ["Notes: related report is computer-use-release-qa-report.md, but this is not the required artifact index line."]
    : [options.artifactLine ?? "Artifacts: 01-computer-use-release-app.png, computer-use-release-qa-report.md, computer-use-release-qa-output.json"];
  await writeFile(
    join(qaRoot, "computer-use-manual-qa-evidence.md"),
    [
      "# Computer Use Manual QA Evidence",
      "",
      "Date: 2026-06-09",
      "Operator: QA Tester",
      "Build: javis-desktop.exe test build",
      `Result: ${result}`,
      ...artifactLines,
      "",
      ...scenarioIds.flatMap((id) => [
        `- ${id}: ${id === failingScenarioId ? "FAIL" : "PASS"}`,
        ...(options.omitScenarioDetails ? [] : [`  Evidence: verified ${id} during manual desktop QA.`]),
      ]),
      "",
    ].join("\n"),
  );
}

function scenarioChecklistManual() {
  return [
    "# Computer Use QA Scenarios",
    "",
    "Overall 8-scenario status: Not yet full PASS.",
    "",
    "| ID | Scenario | Goal | Current coverage | Status |",
    "|---|---|---|---|---|",
    ...scenarioIds.map((id) => `| ${id} | Scenario | Goal | Automated coverage only. | Manual opt-in required |`),
    "",
  ].join("\n");
}

function scenarioChecklistPass() {
  return [
    "# Computer Use QA Scenarios",
    "",
    "Overall 8-scenario status: PASS",
    "",
    "| ID | Scenario | Goal | Current coverage | Status |",
    "|---|---|---|---|---|",
    ...scenarioIds.map((id) => `| ${id} | Scenario | Goal | Manual evidence recorded. | PASS |`),
    "",
  ].join("\n");
}

function createEvidenceJson() {
  const requiredChecks = [
    "release-app-start",
    "release-app-screenshot",
    "computer-screenshot-read",
    "computer-screenshot-health",
    "computer-list-windows",
    "computer-approval-lease",
    "computer-sensitive-approval",
    "computer-dangerous-key-combo",
    "computer-emergency-hotkey-command",
    "local-vision-missing-model-fail-open",
    "local-vision-real-model",
  ];
  return {
    checks: requiredChecks.map((id) => ({ id, passed: true, detail: "ok" })),
    basic: {
      screenshot: {
        width: 1920,
        height: 1080,
        health: { suspiciousBlank: false },
      },
      windows: { count: 3 },
      approval: {
        leaseCreated: true,
        sensitiveSessionWideRejected: true,
        dangerousKeyComboRejected: true,
      },
      emergencyHotkey: { toggled: true },
      missingLocalVision: {
        returned: true,
        detections: 0,
        timedOut: true,
        error: "missing model",
      },
    },
    localVision: {
      model: "yolo26n-ui.onnx",
      runtime: "onnxruntime",
      detections: 1,
      latencyMs: 80,
      timedOut: false,
      error: "",
    },
  };
}

function runCheck(args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      ...args,
    ], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolveResult({ code, stdout, stderr });
    });
  });
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
