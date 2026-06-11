# Product Live/Package Evidence Gate Source QA

Date: 2026-06-11

Scope: source-level verification for stricter product workflow evidence gates.

What changed:

- Live/package blocker QA outputs now need packaged app context.
- Outputs must record app version or build, concrete QA date, and referenced artifacts.
- Every referenced QA artifact must exist in the evidence folder.
- The Code Agent live QA script now emits packaged app provenance fields in `code-agent-opencode-qa-output.txt`.
- The Code Agent live evidence gate now requires the QA output to reference the
  live proposal and approved-apply screenshots, not only store screenshots in
  the folder.
- The trend hot-list release QA helper now emits packaged app provenance fields in `trend-hot-list-live-qa-output.txt`.
- The repository intelligence release QA helper now emits packaged app provenance fields in `repo-intelligence-package-live-qa-output.txt`.
- The repository intelligence product gate now requires structured JSON pass
  fields for key files, symbol graph, resolver, local package hints, external
  registry evidence, and fallback diagnostics.
- The Git remote/PR release QA helper now emits packaged app provenance fields in `git-remote-pr-qa-output.txt`.
- The Git remote/PR product gate now requires machine-readable JSON status
  fields for stage, commit, push, PR create, PR comment, denial, and restore.
- The Browser/Terminal approval release QA helper now emits packaged app provenance fields in `browser-terminal-approval-qa-output.txt`.
- The agent-memory embedding provider release QA helper now emits packaged app provenance fields in `agent-memory-embedding-provider-live-qa-output.txt`.
- The capability scoring evidence ingestion release QA helper now emits packaged app provenance fields in `capability-scoring-evidence-ingestion-qa-output.txt`.
- Browser/Terminal, embedding provider, and capability scoring evidence gates
  now require machine-readable JSON status fields to be `pass`; prose-only
  `PASS` lines are no longer enough for those checks.
- Capability scoring evidence ingestion now also requires concrete
  `EvidenceReferences` and a numeric `RecentFailureRateValue`, not only status
  words.
- The shared metadata requirements apply to Code Agent live provider, structured hot-list research, repository intelligence, Git remote/PR writes, Browser/Terminal approvals, agent-memory embedding provider, and capability scoring evidence ingestion.

Commands:

```powershell
cd E:\Javis
corepack pnpm qa:product-workflows:source
```

Equivalent expanded command list:

```powershell
node scripts\test-check-product-workflow-evidence.mjs
node scripts\test-trend-hot-list-release-qa.mjs
node scripts\test-repo-intelligence-release-qa.mjs
node scripts\test-git-remote-pr-release-qa.mjs
node scripts\test-git-remote-pr-preflight.mjs
node scripts\test-browser-terminal-approval-release-qa.mjs
node scripts\test-agent-memory-embedding-provider-release-qa.mjs
node scripts\test-capability-scoring-evidence-ingestion-release-qa.mjs
node scripts\test-release-rollback-notes.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\qa\check-product-workflow-evidence.ps1 -AllowKnownBlockers
```

Result: passed for the source-level checker test; development inventory still reports known blockers where real packaged/live artifacts are missing.

Remaining gaps:

- This does not create packaged/live evidence by itself.
- Known blockers remain open until the required screenshots and QA outputs are captured from a packaged desktop build.
