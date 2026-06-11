#!/usr/bin/env node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(__dirname, "qa", "check-product-workflow-evidence.ps1");

const baseFiles = [
  "01-idle-workbench.png",
  "02-markdown-scan-completed.png",
  "03-project-inspection-completed.png",
  "04-research-report-completed.png",
  "05-pdf-permission-card.png",
  "06-pdf-approved-result.png",
  "07-pdf-denied-result.png",
  "08-failed-verification-state.png",
  "09-search-github-cli-completed.png",
  "10-search-agent-chrome-fallback-completed.png",
  "11-search-weak-evidence-failed.png",
  "12-search-failed-fetch-state.png",
  "13-search-no-results-state.png",
  "14-search-live-github-cli-smoke.png",
  "15-search-live-agent-chrome-smoke.png",
  "01-workspace-recent-before-restart.png",
  "02-workspace-recent-after-restart.png",
  "16-code-agent-proposal-before-deny.png",
  "16-code-agent-denied-before-deny.png",
  "18-code-agent-proposal-before-approve.png",
  "18-code-agent-approved-before-approve.png",
  "18-code-agent-approved-failed-before-approve.png",
  "21-pdf-durable-approval-restored.png",
  "22-pdf-durable-approval-approved.png",
  "23-pdf-durable-approval-deny-restored.png",
  "24-pdf-durable-approval-denied.png",
  "25-pdf-durable-approval-expired.png",
  "26-code-patch-durable-approval-restored.png",
  "27-code-patch-durable-approval-approved.png",
  "28-code-patch-durable-approval-deny-restored.png",
  "29-code-patch-durable-approval-denied.png",
  "30-code-patch-durable-approval-expired.png",
  "workspace-restart-qa-output.txt",
  "research-search-qa-output.txt",
  "research-live-smoke-qa-output.txt",
  "code-agent-opencode-qa-output.txt",
  "task-history-restored-after-restart.png",
  "task-history-deleted-after-restart.png",
  "task-history-qa-output.txt",
  "model-secret-redaction-qa-output.txt",
  "pdf-durable-approval-qa-output.txt",
  "code-patch-durable-approval-qa-output.txt",
];

const gitFiles = [
  "31-git-review-status-pr-list.png",
  "32-git-stage-approval-card.png",
  "33-git-commit-approval-card.png",
  "34-git-push-approval-card.png",
  "35-git-create-pr-approval-card.png",
  "36-git-comment-pr-approval-card.png",
  "37-git-restored-approval-after-restart.png",
];

const trendFiles = [
  "38-trend-hot-list-report.png",
];

const browserTerminalFiles = [
  "39-terminal-start-approval-card.png",
  "40-terminal-input-approval-card.png",
  "41-browser-write-approval-card.png",
];

const repoIntelligenceFiles = [
  "42-repo-search-key-files.png",
  "43-repo-trace-symbol-graph.png",
];

const embeddingProviderFiles = [
  "44-agent-memory-embedding-settings.png",
];

const capabilityScoringFiles = [
  "45-capability-scoring-evidence-ingestion.png",
];

const codeAgentLiveFiles = [
  "20-code-agent-live-proposal-before-approve.png",
  "20-code-agent-live-approved.png",
];

async function main() {
  const root = await mkdtemp(join(tmpdir(), "javis-product-workflow-qa-"));
  try {
    const qaRoot = join(root, "2026-06-10");
    await mkdir(qaRoot, { recursive: true });
    await writeFile(join(qaRoot, "notes.md"), "# QA Notes\n");
    for (const file of baseFiles) {
      const content = file === "code-agent-opencode-qa-output.txt"
        ? JSON.stringify({
          LiveProviderConfigured: false,
          LiveCredentialStorageEnabled: false,
          Results: [
            { Scenario: "denied", FileText: "hello reviewed" },
            { Scenario: "approved", FileText: "hello approved" },
          ],
        }, null, 2)
        : file === "research-search-qa-output.txt"
          ? [
            "09-search-github-cli-completed.png",
            "10-search-agent-chrome-fallback-completed.png",
            "11-search-weak-evidence-failed.png",
            "12-search-failed-fetch-state.png",
            "13-search-no-results-state.png",
          ].join("\n")
        : file === "research-live-smoke-qa-output.txt"
          ? [
            "14-search-live-github-cli-smoke.png",
            "15-search-live-agent-chrome-smoke.png",
          ].join("\n")
        : file === "workspace-restart-qa-output.txt"
          ? JSON.stringify({
            StoredBeforeRestart: "[\"E:\\\\Javis\"]",
            StoredAfterRestart: "[\"E:\\\\Javis\"]",
            Screenshots: [
              "01-workspace-recent-before-restart.png",
              "02-workspace-recent-after-restart.png",
            ],
          }, null, 2)
        : file === "pdf-durable-approval-qa-output.txt"
          ? JSON.stringify({
            Results: [
              {
                Scenario: "approved",
                SourceExistsAfterDecision: false,
                TargetExistsAfterDecision: true,
                StoredStatus: "approved",
              },
              {
                Scenario: "denied",
                SourceExistsAfterDecision: true,
                TargetExistsAfterDecision: false,
                StoredStatus: "denied",
              },
              {
                Scenario: "expired",
                SourceExistsAfterDecision: true,
                TargetExistsAfterDecision: false,
                StoredStatus: "expired",
              },
            ],
          }, null, 2)
        : file === "code-patch-durable-approval-qa-output.txt"
          ? JSON.stringify({
            Results: [
              { Scenario: "approved", FileText: "hello approved", StoredStatus: "approved" },
              { Scenario: "denied", FileText: "hello reviewed", StoredStatus: "denied" },
              { Scenario: "expired", FileText: "hello reviewed", StoredStatus: "expired" },
            ],
          }, null, 2)
        : file === "task-history-qa-output.txt"
          ? [
            "restore: PASS",
            "delete: PASS",
          ].join("\n")
        : file === "model-secret-redaction-qa-output.txt"
          ? [
            "save_model_api_key_secret: exercised",
            "scan: 0 findings",
            "verdict: PASS",
          ].join("\n")
        : `${file}\n`;
      await writeFile(join(qaRoot, file), content);
    }

    const missingGit = await runCheck(["-QaRoot", qaRoot, "-AllowKnownBlockers"]);
    assert(missingGit.code === 0, `inventory should allow known Git blocker: ${missingGit.stderr || missingGit.stdout}`);
    assert(missingGit.stdout.includes("BLOCKED git-remote-pr-writes"), "missing Git evidence should be reported as a known blocker");
    assert(missingGit.stdout.includes("Git workflow output records PR comment pass"), "Git PR comment requirement should be visible");
    assert(missingGit.stdout.includes("BLOCKED trend-hot-list-live"), "missing trend hot-list evidence should be reported as a known blocker");
    assert(missingGit.stdout.includes("Trend output records provider id"), "trend provider requirement should be visible");
    assert(missingGit.stdout.includes("BLOCKED browser-terminal-approvals"), "missing Browser/Terminal approval evidence should be reported as a known blocker");
    assert(missingGit.stdout.includes("Stale preview is rejected"), "Browser/Terminal stale-preview requirement should be visible");
    assert(missingGit.stdout.includes("BLOCKED repo-intelligence-package-live"), "missing repo intelligence packaged evidence should be reported as a known blocker");
    assert(missingGit.stdout.includes("Repository trace records symbol graph"), "repo intelligence symbol graph requirement should be visible");
    assert(missingGit.stdout.includes("BLOCKED agent-memory-embedding-provider-live"), "missing embedding provider live evidence should be reported as a known blocker");
    assert(missingGit.stdout.includes("Embedding secret is referenced, not logged"), "embedding secret reference requirement should be visible");
    assert(missingGit.stdout.includes("BLOCKED capability-scoring-evidence-ingestion"), "missing capability scoring evidence ingestion should be reported as a known blocker");
    assert(missingGit.stdout.includes("Capability scoring ingests live evidence"), "capability scoring live evidence requirement should be visible");

    for (const file of codeAgentLiveFiles) {
      await writeFile(join(qaRoot, file), `${file}\n`);
    }
    await writeFile(
      join(qaRoot, "code-agent-opencode-qa-output.txt"),
      JSON.stringify({
        PackagedApp: true,
        AppVersion: "0.1.0",
        QaDate: "2026-06-10",
        Artifacts: ["16-code-agent-proposal-before-deny.png"],
        LiveProviderConfigured: true,
        LiveCredentialStorageEnabled: true,
        Results: [
          { Scenario: "denied", FileText: "hello reviewed" },
          { Scenario: "approved", FileText: "hello approved" },
        ],
        LiveResult: {
          Scenario: "live-approved",
          Status: "pass",
          Screenshots: [],
        },
      }, null, 2),
    );
    const withUnreferencedCodeAgentLive = await runCheck(["-QaRoot", qaRoot, "-AllowKnownBlockers"]);
    assert(withUnreferencedCodeAgentLive.code === 0, `inventory should allow known Code Agent live blocker when output omits screenshot refs: ${withUnreferencedCodeAgentLive.stderr || withUnreferencedCodeAgentLive.stdout}`);
    assert(withUnreferencedCodeAgentLive.stdout.includes("BLOCKED code-agent-live-provider"), "Code Agent live workflow should stay blocked when output omits live screenshot refs");
    assert(withUnreferencedCodeAgentLive.stdout.includes("Live output references proposal screenshot"), "Code Agent live screenshot reference requirement should be visible");

    await writeFile(
      join(qaRoot, "code-agent-opencode-qa-output.txt"),
      JSON.stringify({
        PackagedApp: true,
        AppVersion: "0.1.0",
        QaDate: "2026-06-10",
        Artifacts: codeAgentLiveFiles,
        LiveProviderConfigured: true,
        LiveCredentialStorageEnabled: true,
        Results: [
          { Scenario: "denied", FileText: "hello reviewed" },
          { Scenario: "approved", FileText: "hello approved" },
        ],
        LiveResult: {
          Scenario: "live-approved",
          Status: "pass",
          Screenshots: codeAgentLiveFiles,
        },
      }, null, 2),
    );
    const withCodeAgentLive = await runCheck(["-QaRoot", qaRoot, "-AllowKnownBlockers"]);
    assert(withCodeAgentLive.code === 0, `inventory should pass with Code Agent live evidence present: ${withCodeAgentLive.stderr || withCodeAgentLive.stdout}`);
    assert(withCodeAgentLive.stdout.includes("PASS    code-agent-live-provider"), "Code Agent live provider workflow should pass with complete evidence");

    for (const file of gitFiles) {
      await writeFile(join(qaRoot, file), `${file}\n`);
    }
    await writeFile(
      join(qaRoot, "git-remote-pr-qa-output.txt"),
      [
        ...packagedQaLines(["31-git-review-status-pr-list.png", "missing-git-artifact.png"]),
        "stage: PASS",
        "commit: PASS",
        "push: PASS",
        "pr create: PASS",
        "pr comment: PASS",
        "denial: PASS",
        "restore: PASS",
        "",
        "json:",
        JSON.stringify({
          stage: "pass",
          commit: "pass",
          push: "pass",
          prCreate: "pass",
          prComment: "pass",
          denial: "pass",
          restore: "pass",
        }, null, 2),
      ].join("\n"),
    );

    const withMissingGitArtifact = await runCheck(["-QaRoot", qaRoot, "-AllowKnownBlockers"]);
    assert(withMissingGitArtifact.code === 0, `inventory should allow known Git blocker with missing artifact reference: ${withMissingGitArtifact.stderr || withMissingGitArtifact.stdout}`);
    assert(withMissingGitArtifact.stdout.includes("BLOCKED git-remote-pr-writes"), "Git workflow should stay blocked when QA output references a missing artifact");
    assert(withMissingGitArtifact.stdout.includes("QA output artifact references exist"), "missing artifact-reference requirement should be visible");
    assert(withMissingGitArtifact.stdout.includes("missing-git-artifact.png"), "missing artifact name should be visible");

    await writeFile(
      join(qaRoot, "git-remote-pr-qa-output.txt"),
      [
        ...packagedQaLines(["31-git-review-status-pr-list.png", "32-git-stage-approval-card.png"]),
        "stage: PASS",
        "commit: PASS",
        "push: PASS",
        "pr create: PASS",
        "pr comment: PASS",
        "denial: PASS",
        "restore: PASS",
        "",
        "json:",
        JSON.stringify({
          stage: "pass",
          commit: "pass",
          push: "pass",
          prCreate: "pass",
          prComment: "pass",
          denial: "pass",
          restore: "pass",
        }, null, 2),
      ].join("\n"),
    );

    const withGit = await runCheck(["-QaRoot", qaRoot, "-AllowKnownBlockers"]);
    assert(withGit.code === 0, `inventory should pass with Git evidence present: ${withGit.stderr || withGit.stdout}`);
    assert(withGit.stdout.includes("PASS    git-remote-pr-writes"), "Git workflow should pass with complete evidence");

    for (const file of trendFiles) {
      await writeFile(join(qaRoot, file), `${file}\n`);
    }
    await writeFile(
      join(qaRoot, "trend-hot-list-live-qa-output.txt"),
      [
        "trend.fetchHotList completed",
        "Provider: example-provider",
        "RequestedCount: 20",
        "ItemCount: 20",
        "https://example.test/hot-list",
        "ResearchReport Sources completed",
      ].join("\n"),
    );
    const withTrendProse = await runCheck(["-QaRoot", qaRoot, "-AllowKnownBlockers"]);
    assert(withTrendProse.code === 0, `inventory should allow known trend blocker with prose evidence: ${withTrendProse.stderr || withTrendProse.stdout}`);
    assert(withTrendProse.stdout.includes("BLOCKED trend-hot-list-live"), "hand-written trend prose should not pass JSON evidence gate");
    assert(withTrendProse.stdout.includes("Trend output JSON schema is valid"), "trend JSON schema requirement should be visible");

    await writeFile(
      join(qaRoot, "trend-hot-list-live-qa-output.txt"),
      JSON.stringify({
        PackagedApp: true,
        AppVersion: "0.1.0",
        QaDate: "2026-06-10",
        Artifacts: ["38-trend-hot-list-report.png"],
        toolName: "trend.fetchHotList",
        Provider: "example-provider",
        RequestedCount: 20,
        ItemCount: 20,
        SourceUrl: "https://example.test/hot-list",
        Diagnostics: [{ Status: "completed" }],
        ResearchReport: {
          Sources: ["https://example.test/hot-list"],
        },
      }, null, 2),
    );

    const withTrend = await runCheck(["-QaRoot", qaRoot, "-AllowKnownBlockers"]);
    assert(withTrend.code === 0, `inventory should pass with trend evidence present: ${withTrend.stderr || withTrend.stdout}`);
    assert(withTrend.stdout.includes("PASS    trend-hot-list-live"), "trend hot-list workflow should pass with complete evidence");

    for (const file of browserTerminalFiles) {
      await writeFile(join(qaRoot, file), `${file}\n`);
    }
    await writeFile(
      join(qaRoot, "browser-terminal-approval-qa-output.txt"),
      [
        ...packagedQaLines("39-terminal-start-approval-card.png"),
        "terminal start: PASS",
        "terminal input: PASS",
        "browser write: PASS",
        "denial: PASS",
        "stale preview: PASS",
        "one shot: PASS",
        "",
        "json:",
        JSON.stringify({
          terminalStart: "pass",
          terminalInput: "pass",
          browserWrite: "pass",
          denial: "pass",
          stalePreview: "pass",
          oneShot: "pass",
        }, null, 2),
      ].join("\n"),
    );

    const withBrowserTerminal = await runCheck(["-QaRoot", qaRoot, "-AllowKnownBlockers"]);
    assert(withBrowserTerminal.code === 0, `inventory should pass with Browser/Terminal evidence present: ${withBrowserTerminal.stderr || withBrowserTerminal.stdout}`);
    assert(withBrowserTerminal.stdout.includes("PASS    browser-terminal-approvals"), "Browser/Terminal approval workflow should pass with complete evidence");

    for (const file of repoIntelligenceFiles) {
      await writeFile(join(qaRoot, file), `${file}\n`);
    }
    await writeFile(
      join(qaRoot, "repo-intelligence-package-live-qa-output.txt"),
      JSON.stringify({
        PackagedApp: true,
        AppVersion: "0.1.0",
        QaDate: "2026-06-10",
        Artifacts: ["42-repo-search-key-files.png"],
        keyFiles: "pass",
        symbolGraph: "pass",
        resolver: "pass",
        packageHints: "pass",
        registryEvidence: "pass",
        fallbackDiagnostics: "pass",
      }, null, 2),
    );

    const withRepoIntelligence = await runCheck(["-QaRoot", qaRoot, "-AllowKnownBlockers"]);
    assert(withRepoIntelligence.code === 0, `inventory should pass with repo intelligence evidence present: ${withRepoIntelligence.stderr || withRepoIntelligence.stdout}`);
    assert(withRepoIntelligence.stdout.includes("PASS    repo-intelligence-package-live"), "repo intelligence packaged workflow should pass with complete evidence");

    for (const file of embeddingProviderFiles) {
      await writeFile(join(qaRoot, file), `${file}\n`);
    }
    await writeFile(
      join(qaRoot, "agent-memory-embedding-provider-live-qa-output.txt"),
      [
        ...packagedQaLines("44-agent-memory-embedding-settings.png"),
        "local embedding: PASS",
        "native openai compatible: PASS",
        "secret reference: PASS",
        "vector search: PASS",
        "",
        "json:",
        JSON.stringify({
          localEmbedding: "pass",
          nativeOpenAiCompatible: "pass",
          secretReference: "pass",
          vectorSearch: "pass",
        }, null, 2),
      ].join("\n"),
    );

    const withEmbeddingProvider = await runCheck(["-QaRoot", qaRoot, "-AllowKnownBlockers"]);
    assert(withEmbeddingProvider.code === 0, `inventory should pass with embedding provider evidence present: ${withEmbeddingProvider.stderr || withEmbeddingProvider.stdout}`);
    assert(withEmbeddingProvider.stdout.includes("PASS    agent-memory-embedding-provider-live"), "embedding provider live workflow should pass with complete evidence");

    for (const file of capabilityScoringFiles) {
      await writeFile(join(qaRoot, file), `${file}\n`);
    }
    await writeFile(join(qaRoot, "product-workflows.json"), JSON.stringify({
      scenarios: [{ Scenario: "capability-scoring-evidence-ingestion", Status: "PASS" }],
    }, null, 2));
    await writeFile(
      join(qaRoot, "capability-scoring-evidence-ingestion-qa-output.txt"),
      [
        ...packagedQaLines("45-capability-scoring-evidence-ingestion.png"),
        "qa evidence: PASS",
        "live evidence: PASS",
        "evidence refs: PASS",
        "recent failure rate: PASS",
        "",
        "json:",
        JSON.stringify({
          qaEvidence: "pass",
          liveEvidence: "pass",
          evidenceRefs: "pass",
          recentFailureRate: "pass",
          EvidenceReferences: [
            "docs/qa/2026-06-10/product-workflows.json#capability-scoring-evidence-ingestion",
          ],
          RecentFailureRateValue: 0.25,
        }, null, 2),
      ].join("\n"),
    );

    const withCapabilityScoring = await runCheck(["-QaRoot", qaRoot, "-AllowKnownBlockers"]);
    assert(withCapabilityScoring.code === 0, `inventory should pass with capability scoring evidence present: ${withCapabilityScoring.stderr || withCapabilityScoring.stdout}`);
    assert(withCapabilityScoring.stdout.includes("PASS    capability-scoring-evidence-ingestion"), "capability scoring evidence ingestion workflow should pass with complete evidence");

    await writeFile(
      join(qaRoot, "release-rollback-notes.md"),
      [
        "# Release Rollback Notes",
        "- Build version: 0.1.0",
        "- Commit: abcdef1234567890",
        "- Previous known-good build: 0.0.9",
        "- MSI: apps/desktop/src-tauri/target/release/bundle/msi/Javis_0.1.0_x64_en-US.msi",
        "- MSI signature: Valid",
        `- MSI SHA-256: ${"A".repeat(64)}`,
        "- NSIS: apps/desktop/src-tauri/target/release/bundle/nsis/Javis_0.1.0_x64-setup.exe",
        "- NSIS signature: Valid",
        `- NSIS SHA-256: ${"B".repeat(64)}`,
      ].join("\n"),
    );
    const withHandWrittenRelease = await runCheck(["-QaRoot", qaRoot, "-AllowKnownBlockers"]);
    assert(withHandWrittenRelease.code === 0, `inventory should allow known release blocker with hand-written notes: ${withHandWrittenRelease.stderr || withHandWrittenRelease.stdout}`);
    assert(withHandWrittenRelease.stdout.includes("BLOCKED release-and-rollback"), "hand-written release notes should not pass generated evidence gate");
    assert(withHandWrittenRelease.stdout.includes("Build summary is generated by signed build helper"), "release build summary marker requirement should be visible");
    assert(withHandWrittenRelease.stdout.includes("Rollback notes are generated by release helper"), "release helper marker requirement should be visible");
    assert(withHandWrittenRelease.stdout.includes("MSI signer thumbprint is recorded"), "release signer thumbprint requirement should be visible");

    await writeFile(join(qaRoot, "release-rollback-notes.md"), generatedReleaseRollbackNotes());
    await writeFile(join(qaRoot, "release-build-summary.json"), generatedReleaseBuildSummary({ msiSha256: "E".repeat(64) }));
    const withMismatchedRelease = await runCheck(["-QaRoot", qaRoot, "-AllowKnownBlockers"]);
    assert(withMismatchedRelease.code === 0, `inventory should allow known release blocker with mismatched generated evidence: ${withMismatchedRelease.stderr || withMismatchedRelease.stdout}`);
    assert(withMismatchedRelease.stdout.includes("BLOCKED release-and-rollback"), "mismatched generated release evidence should stay blocked");
    assert(withMismatchedRelease.stdout.includes("Release build summary matches rollback notes"), "release consistency requirement should be visible");

    await writeFile(join(qaRoot, "release-build-summary.json"), generatedReleaseBuildSummary());
    const withRelease = await runCheck(["-QaRoot", qaRoot, "-AllowKnownBlockers", "-Json"]);
    assert(withRelease.code === 0, `inventory should pass with generated release evidence present: ${withRelease.stderr || withRelease.stdout}`);
    assert(scenarioStatus(withRelease.stdout, "release-and-rollback") === "PASS", "release rollback workflow should pass with generated evidence");

    const jsonInventory = await runCheck(["-QaRoot", qaRoot, "-AllowKnownBlockers", "-Json"]);
    assert(jsonInventory.code === 0, `JSON inventory should pass with known blockers allowed: ${jsonInventory.stderr || jsonInventory.stdout}`);
    const parsedInventory = JSON.parse(jsonInventory.stdout);
    assert(parsedInventory.qaRoot.endsWith("2026-06-10"), "JSON inventory should include repo-relative QA root");
    assert(
      parsedInventory.scenarios.some((scenario) =>
        scenario.Scenario === "agent-memory-embedding-provider-live" &&
        scenario.Status === "PASS",
      ),
      "JSON inventory should include machine-readable embedding provider scenario status",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  process.stdout.write("Product workflow QA evidence checker test passed\n");
}

function runCheck(args) {
  return new Promise((resolvePromise) => {
    const child = spawn("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      ...args,
    ], { cwd: resolve(__dirname, "..") });
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

function scenarioStatus(stdout, scenarioId) {
  return JSON.parse(stdout).scenarios.find((scenario) => scenario.Scenario === scenarioId)?.Status;
}

function packagedQaLines(artifacts) {
  const artifactList = Array.isArray(artifacts) ? artifacts : [artifacts];
  return [
    "PackagedApp: true",
    "AppVersion: 0.1.0",
    "QaDate: 2026-06-10",
    `Artifacts: ${artifactList.join(", ")}`,
  ];
}

function generatedReleaseRollbackNotes() {
  return [
    "# Release Rollback Notes",
    "",
    "<!-- generated-by: scripts/release/write-release-rollback-notes.ps1 -->",
    "",
    "## Rollback Record - Javis 0.1.0 (2026-06-10)",
    "",
    "- Build version: 0.1.0",
    "- Commit: abcdef1234567890abcdef1234567890abcdef12",
    "- Previous known-good build: 0.0.9",
    "- Previous artifact location: https://example.invalid/javis/0.0.9",
    `- Previous artifact SHA-256: ${"D".repeat(64)}`,
    "- Storage schema changes: no",
    "- Storage schema details: none",
    "- Permission state changes: no",
    "- User data format changes: no",
    "- Non-downgradable data: none",
    "",
    "## Artifacts",
    "",
    "- MSI: apps/desktop/src-tauri/target/release/bundle/msi/Javis_0.1.0_x64_en-US.msi",
    "- MSI signature: Valid",
    `- MSI signer thumbprint: ${"C".repeat(40)}`,
    `- MSI SHA-256: ${"A".repeat(64)}`,
    "- NSIS: apps/desktop/src-tauri/target/release/bundle/nsis/Javis_0.1.0_x64-setup.exe",
    "- NSIS signature: Valid",
    `- NSIS signer thumbprint: ${"C".repeat(40)}`,
    `- NSIS SHA-256: ${"B".repeat(64)}`,
  ].join("\n");
}

function generatedReleaseBuildSummary(options = {}) {
  const msiSha256 = options.msiSha256 ?? "A".repeat(64);
  const nsisSha256 = options.nsisSha256 ?? "B".repeat(64);
  return JSON.stringify({
    generatedBy: "scripts/release/build-windows-signed.ps1",
    version: "0.1.0",
    commit: "abcdef1234567890abcdef1234567890abcdef12",
    builtAt: "2026-06-10T00:00:00.0000000Z",
    certificateThumbprint: "C".repeat(40),
    timestampUrl: "http://timestamp.digicert.com",
    digestAlgorithm: "sha256",
    artifacts: [
      {
        Artifact: "apps/desktop/src-tauri/target/release/bundle/msi/Javis_0.1.0_x64_en-US.msi",
        Signature: "Valid",
        SignerThumbprint: "C".repeat(40),
        SHA256: msiSha256,
      },
      {
        Artifact: "apps/desktop/src-tauri/target/release/bundle/nsis/Javis_0.1.0_x64-setup.exe",
        Signature: "Valid",
        SignerThumbprint: "C".repeat(40),
        SHA256: nsisSha256,
      },
    ],
  }, null, 2);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
