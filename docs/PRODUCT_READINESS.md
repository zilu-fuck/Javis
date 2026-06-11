# Product Readiness

Last updated: 2026-06-11

This document defines the current target for Javis: a complete usable desktop
product, not only an MVP build.

## Target Definition

Javis is product-ready when a user can install the desktop app, connect it to a
real project, delegate everyday research and coding tasks, review risky actions
before they happen, recover from failures, and return later with useful task
history intact.

## Required Product Capabilities

| Area | Product-ready requirement | Current status |
| --- | --- | --- |
| Desktop workbench | Installable app with stable task thread, logs, agent state, and permission UI. | MVP implemented and packaged on Windows. |
| File and project understanding | Read project files safely, summarize relevant documents, inspect scripts, and recommend/run checks. | MVP implemented with Markdown scan and allowlisted checks. |
| Repo intelligence | Search existing implementation before proposing changes, cluster large result sets, identify key files, trace candidate call/reference chains, and separate actual evidence from inference and confirmation gaps. | Partial. Core now has `createRepositorySearchPlan`, `clusterRepositorySearchResults`, `buildRepositorySearchEvidenceReport`, and `buildRepositoryTraceEvidenceReport` contracts for fallback keyword attempts, concept phrase attempts, CJK phrase/window expansion, exact symbol/entrypoint trace attempts, path clustering, key-file ranking with optional `priorityPaths`, related test files, inferred test-file candidates, candidate nodes/edges, import/export/call/reference relation hints, module specifiers, module kind (relative/workspace/external), generic module-link hints, a generic evidence-derived `symbolGraph` with file/symbol nodes and declares/references/imports/exports/calls edges, and actual/inferred/needs-confirmation sections. `code.searchRepository` and `code.traceCallChain` are registered as read-only descriptors, typed on `CodeTool`, implemented in desktop via the existing read-only `files_search`/`rg` path, and exposed to the Code Agent only when the runtime implementation exists. Repository search and trace output, including attempted queries, fallback reasons, provider (`rg` / `ignore`), per-attempt result counts, status, duration, retry count, error kind, errors, top module-link hints, optional resolver status, package manifest hints, optional semantic rerank diagnostics, symbol graph, and test-file hints are carried on task snapshots and shown in the Code Agent details; single-attempt failures are retried once and recorded while later fallback attempts continue. Desktop `code.searchRepository` now best-effort reads `git status --short` and uses changed files as `priorityPaths` when the caller does not supply priority paths. Desktop search has a generic semantic rerank hook, wired by default to a local no-network text-hash embedding reranker, and falls back to lexical order with a confirmation gap if reranking fails. A generic persisted vector index module now exists with SQLite migrations, deterministic LSH buckets, exact cosine rerank, scoped search, hard-delete APIs, native SQL allowlist coverage, app startup migrations, default local no-network text-hash embeddings, an injectable OpenAI-compatible embedding provider factory, privacy-settings UI for embedding mode/provider/model/base URL/key reference/dimensions, runtime selection from saved preferences, native OpenAI-compatible embedding execution with OS-secret hydration, bounded startup backfill for existing memory facts, and agent-memory hybrid recall integration; packaged workflow QA remains future work. Desktop trace now has a conservative generic resolver for relative module specifiers, workspace package manifest roots, package.json `main`/`module`/`types`/`exports` hints, local external dependency manifest/lockfile hints, optional injectable npm registry metadata hints, tsconfig `paths`/`baseUrl` aliases with relative `extends` and nearest-config preference, TypeScript compiler `resolveModuleName` confirmation over discovered candidate files via scoped `read_file_chunk`, TypeScript AST evidence extraction for import/export/call/JSX/reference hits inside discovered candidate files, resolved-module AST expansion that follows confirmed module links into the target module file, resolved `file -> file` module graph edges, source-level AST `symbol -> symbol` call edges between enclosing caller declarations and resolved target declarations, and bounded TypeScript `Program`/`TypeChecker` project graph enrichment that resolves imports and calls through barrel exports into declaration files when project files are readable. |
| Research | Search or collect public sources, fetch evidence, compare at least three sources, cite excerpts, and label unknowns. | Implemented. User-provided URL flow works; automated search has `github-cli` and Agent Chrome provider paths. Fixture QA covers success/failure states, live `github-cli` plus Agent Chrome smoke QA passes. Source-comparison summaries call out overlap and differences. A first read-only structured trend tool now exists as `trend.fetchHotList`, with open provider IDs, a provider-adapter registry, optional fallback providers, an initial Weibo adapter that normalizes rank/title/hot-score/source metadata, incomplete-list warnings, structured fetch diagnostics, accumulated fallback diagnostics, and typed failure diagnostics for HTTP/network/parse/unsupported-provider/unavailable cases. Trend diagnostics are also surfaced in generated research-report summaries and unknowns. Product workflow QA now has a generic `trend-hot-list-live` evidence gate for typed hot-list research, provider/source metadata, requested count, non-empty item count, diagnostics, and report sources; it remains blocked until packaged/live evidence is captured. |
| Code Agent | Inspect code, propose changes, produce diffs, apply approved edits, and run verification. | Partial. Core routes code review goals to the Code Agent: lists changed files, shows diff preview, requests opencode-backed JSON patch proposals using desktop-managed model/provider settings, and applies approved patches through confirmed-write + native guard. Packaged-app fixture QA covers proposal denial and approved patch application. Proposal backend has DeepSeek/custom OpenAI-compatible fallback, stricter proposal-file binding, parser hardening, and redacted diagnostics. Agent optimization: 11/13 issues resolved; safePlanWorkflow dynamic agent reading fixed. Live provider smoke QA pending rerun with temporary credentials. |
| Persistence | Save task history, results, permission decisions as scoped records, and allow deletion. | Implemented. Completed, failed, and cancelled task snapshots stored locally with sidebar restore/delete. Durable approval records cover PDF, Code Patch, Git push, Git commit, Git stage, and PR create pending/resolved audit payloads. Packaged restart QA verifies approve/apply, deny, and expiry recovery for PDF and Code Patch, and the product gate now checks their stored statuses plus file/source/target outcomes; packaged task-history restore/delete QA now passes with a scoped QA history row; Git push/commit/stage/PR create restore has source-level native/TS tests and still needs packaged-app QA evidence. SQLite migration complete: all migration sets are deployed, model-settings migrated, and source-level localStorage migration verification passes for task history, approval records, recent workspaces/workspace session, scheduled tasks, user preferences, user profile memory, current goal, task-session JSONL, and tool-call audit JSONL. Valid handoff reports and step context keys now survive task-history and session-JSONL sanitization at source level; packaged restore evidence for this handoff surface is still needed. |
| Workspace management | Select and remember workspaces without relying on the launch directory. | Implemented. Desktop sidebar accepts manual paths and native directory picker, restores recent workspaces after restart, persists completed runs, supports deletion. Restart QA screenshots recorded. |
| Permission enforcement | Confirmed writes require visible approval and native enforcement for the current dry-run. | Partial. PDF organization has one-time native approval-state enforcement and validates restored/approved operations through a native path/source guard. Code Agent patch apply is gated by confirmed-write plus native approval id, proposal hash, one-shot consumption, path checks, current-file hashes, native tool binding, and native preview-hash binding. File Write now has source-level confirmed-write wiring through `file.planWriteText` / `file.writeText`, native approval binding, preview hash validation, task/tool binding, path guards, and one-shot execution. Git push now has a source-level native `git_plan_push` / `git_approve_push` / `git_execute_push` path plus a Review-panel quick action with remote summary, GitHub CLI PR list, push preview, task/tool binding, preview hash validation, protected-branch and behind-upstream guards, one-shot execution, initial tool-call audit records for plan/execute/failure, and a durable restore path that revalidates the persisted preview before recreated approval execution. Git commit now has source-level `git_plan_commit` / `git_approve_commit` / `git_execute_commit`, Review-panel quick action for current-all-changes commits, preview hash validation, task/tool binding, one-shot execution, plan/execute/failure audit records, durable restore path, explicit selected-path commit support, and Commander DAG dispatch through `git.createCommit` with confirmed-write approval. Git stage selected files now has a source-level `git_plan_stage_files` / `git_approve_stage_files` / `git_execute_stage_files` path with native approval binding, preview hash validation, task/tool binding, path guards, one-shot execution, Review-panel quick action, plan/execute/failure audit records, durable restore path, and Commander DAG stage dispatch through `git.stageFiles` with explicit path input and confirmed-write approval. GitHub CLI draft PR creation now has a source-level native confirmed-write path through `git_plan_create_pull_request` / `git_approve_create_pull_request` / `git_execute_create_pull_request`, with preview hash validation, task/tool binding, one-shot execution, Commander DAG / desktop runtime dispatch through `git.createPullRequest`, a Review-panel quick action, plan/execute/failure audit records, and durable restore path, but no packaged-app QA evidence yet. GitHub CLI PR comment now has source-level confirmed-write wiring through `git_plan_comment_pull_request` / `git_approve_comment_pull_request` / `git_execute_comment_pull_request`, preview hash validation, task/tool binding, one-shot execution, Commander DAG / desktop runtime dispatch, Review-panel quick action, plan/execute/failure audit records, and durable restore path; it still lacks packaged-app QA. Browser write operations now have source-level native `browser_plan_write` / `browser_approve_write` plus approval id, task/session/action, preview-hash, one-shot execution binding for click/type/evaluate/runTest, desktop runtime plan/approve/execute wiring, visible Workbench approval broker/card state, and tool-call audit records for plan/execute/failure without persisting raw typed text or test scripts. Interactive Terminal create/input now has source-level native `terminal_plan_create` / `terminal_plan_input` / `terminal_approve` with task/action/preview-hash binding, one-shot consumption, input previews that bind hashes without echoing raw input, desktop service plan/approve/execute wiring, tool-call audit records for plan/execute/failure without persisting raw input, and a source-level visible UI gate before starting a terminal or sending buffered input. Restored durable approvals recompute the dry-run binding hash and Code Patch restore checks persisted proposal files against the approved dry-run. File Write, Git push, Git commit, Git stage, PR create/comment, Browser writes, and Terminal interactive input still need packaged QA evidence before they can be treated as product-ready. |
| Error recovery | Failed tools show actionable errors and allow retry or alternate paths. | Partial. MVP failure states exist, failed tasks expose retry action. Chinese error messages localized through `error-localizer.ts` (70+ mappings). Keyring errors get readable Chinese messages on non-Windows. Source-level Commander DAG recovery now records a generic `recoveryReport` with failure classification, replan status, abandoned failed-step IDs, recovery step IDs, completed-before context, generic alternate-path suggestions, and redacted error summaries; final task snapshots can carry the report, task details display it, and task-history sanitization preserves valid reports while dropping malformed ones. Real workflow QA and tool-specific fallback evidence are still needed before alternate-path recovery can be called product-ready. |
| Release operations | Signed/versioned builds, repeatable QA evidence, release notes, and rollback notes. | Partial. Unsigned Windows build and QA evidence exist. Product workflow QA now has a matrix and evidence gate in `docs/qa/PRODUCT_WORKFLOWS.md`. The signed build helper now writes `release-build-summary.json` with version, commit, signed MSI/NSIS artifact paths, valid signature statuses, signer thumbprints, and SHA-256 hashes. The release rollback gate also requires helper-generated rollback notes with previous artifact SHA-256 provenance and verifies that version, commit, artifact paths, signatures, signer thumbprints, and hashes match the signed-build summary; the helper rejects unsigned artifacts and MSI/NSIS artifacts signed by different certificates, so hand-written signature prose cannot close the gate. Strict release evidence still needs real signed MSI/NSIS artifacts plus generated build summary and rollback notes. |
| Capability scoring | Show users which agents are implemented, permission-ready, QA-passed, live-verified, and worth fixing first. | Partial. Core now exposes `scoreAgentCapability` / `scoreAgentCapabilities`, deriving implemented and permission-ready status from tool descriptors, ingesting generic QA/live evidence records, deriving recent failure rates from tool-call signals, and carrying evidence refs. Core also exposes `rankAgentRepairPriorities`, a generic source-level repair-priority model that combines implementation gaps, permission readiness, QA/live evidence gaps, recent failure rate, permission risk, evidence refs, and next-evidence hints. Task agent snapshots carry optional capability scores; the inspector displays score, status, permission, QA, live, recent failure rate, evidence count/ref, gap signals, and a repair-priority label with reasons; agent summary cards also surface compact ready/repair badges. Runtime scoring now accepts injected verification; desktop session tool-call audit records and persisted SQLite recent audit records feed bounded recent-failure-rate signals; product workflow QA can be exported as JSON inventory, parsed with validation, and converted into generic QA/live capability evidence records; idle snapshots can be initialized or refreshed from the current runtime verification state. Core handoff reporting can serialize multi-agent producer/consumer context keys, missing inputs, unconsumed outputs, and compact value summaries; final Commander DAG snapshots can carry this report, task details can display and download JSON/Markdown artifacts, valid reports survive source-level history/session persistence, and core/UI can format stable JSON/Markdown handoff artifacts. Packaged QA evidence ingestion and saved/exported handoff evidence still need product evidence. |

## Product Release Blockers

Do not call Javis a complete usable product while any of these are true:

- Code Agent live opencode proposal/apply QA is not complete for real
  providers. Packaged-app fixture QA passes for proposal denial and approved
  patch application. The native proposal runner has reqwest 0.12 + native-tls,
  OpenAI-compatible fallback, fenced/pretty JSON parsing, and redacted provider
  diagnostics. Agent optimization: 11/13 issues resolved; safePlanWorkflow
  dynamic agent reading fixed. Live DeepSeek-compatible smoke previously failed
  with safe-fail (no writes attempted); reqwest request construction needs
  debugging against the working Python verification script. The packaged QA
  script now drives live proposal approval/apply when temporary provider
  credentials are supplied, and stores the temporary key under an isolated
  `model.code_agent_live_qa` reference.
- Source-level localStorage migration verification now passes for approval
  records, recent workspaces/workspace session, task history, scheduled tasks,
  user preferences, user profile memory, current goal, task-session JSONL, and
  tool-call audit JSONL. Packaged task-history restore/delete QA also passes
  with a scoped QA row. Remaining persistence evidence is workflow-specific,
  especially packaged restore evidence for Git push/commit/stage/PR approvals.
- Confirmed-write enforcement shares native approval binding for PDF, Code
  Patch, File Write, and the first Git push backend path (approval ID, tool,
  preview hash, task binding, one-shot consumption, path/scope guards where
  applicable). File Write and Git push have source-level confirmed-write
  integration. Git push now has a Review-panel quick action, initial
  tool-call audit records, and source-level durable restore coverage; Git
  commit now has source-level confirmed-write wiring, a Review-panel quick
  action for current-all-changes commits, selected-path native/Commander DAG
  support, initial tool-call audit records, and source-level durable restore
  coverage. Git stage selected files now has a
  source-level confirmed-write backend, Review-panel quick action, audit
  records, source-level durable restore coverage, and Commander DAG stage
  dispatch. These paths still need strict packaged-app QA
  evidence and broader write-command migration before they can be treated as
  product-ready.
- GitHub CLI draft PR creation has a source-level native confirmed-write path
  plus Commander DAG / desktop runtime wiring, a Review-panel quick action,
  initial tool-call audit records, and source-level durable restore coverage,
  but still needs product QA evidence before it is product-ready. GitHub CLI
  PR comment has source-level confirmed-write wiring plus Commander DAG /
  desktop runtime dispatch, Review-panel quick action, audit records, and
  source-level durable restore coverage, but still lacks product QA.
- Browser writes and interactive Terminal create/input now have source-level
  native approval binding and one-shot execution checks. Browser writes and
  Terminal create/input also have desktop service plan/approve/execute wiring
  plus tool-call audit records for plan/execute/failure without raw input or
  script persistence. Browser write tools remain behind the disabled exposure
  policy in Commander prompts and generic workflow dispatch. Browser now has a
  source-level visible approval card surface in the workspace Browser panel plus
  desktop runtime pending-approval broker wiring before native approval and
  execution. Terminal has a source-level visible approval gate that displays
  native approval id / preview hash before starting a shell or sending buffered
  input, then executes through native `terminal_approve` plus one-shot
  `terminal_create` / `terminal_input`. They remain product blockers until
  packaged-app QA evidence is captured.
- Product workflow QA now has an explicit `browser-terminal-approvals`
  evidence gate for Terminal start/input approval cards, Browser write approval
  cards, denial fail-closed behavior, stale-preview rejection, and one-shot
  execution. It is intentionally marked as a known blocker until packaged-app
  evidence is captured.
- Product workflow QA now has an explicit `git-remote-pr-writes` evidence gate
  for Review-panel Git status/PR list, stage, commit, push, draft PR creation,
  PR comment, and restored Git approval evidence. It is intentionally marked as
  a known blocker until packaged-app evidence is captured. The manual evidence
  playbook, read-only preflight, and output helper live in
  `docs/qa/2026-06-09/git-remote-pr/`.
- Product workflow QA now has an explicit `trend-hot-list-live` evidence gate
  for typed hot-list research through `trend.fetchHotList`, provider/source
  metadata, requested count, non-empty item count, diagnostics, and report
  sources. The gate now requires valid structured JSON, so hand-written prose
  cannot close it. It is intentionally marked as a known blocker until
  packaged/live evidence is captured.
- Product workflow QA now has an explicit `repo-intelligence-package-live`
  evidence gate for packaged repository search key files, trace symbol graph,
  resolver evidence, package hints or registry evidence, and fallback
  diagnostics. Source-level repo intelligence now includes injectable npm
  registry metadata lookup for external package hints in addition to local
  package.json, lockfile, node_modules, tsconfig, TypeScript compiler
  resolution, and file-search evidence.
  Trace symbol graphs can also use an optional bounded `listScriptFiles()`
  provider to enrich project-wide AST declarations, exports, imports, and
  imported-symbol call edges without hardcoding repository layout. The same
  bounded project file set now feeds a source-level TypeScript
  `Program`/`TypeChecker` enrichment pass that can resolve imports and calls
  through barrel exports into declaration files, while recording confirmation
  gaps when files cannot be read or the graph is capped. It is intentionally
  marked as a known blocker until packaged/live evidence is captured.
- Agent memory embeddings now have source-level runtime preference selection,
  privacy-settings UI for local/OpenAI-compatible modes, provider/model/base
  URL/key-reference/dimensions fields, configured-profile selection that can
  reuse an existing model profile's provider/base URL/key reference, and native
  OpenAI-compatible execution with OS-secret hydration through
  `embed_model_texts`, so API keys do not need to be read into frontend state.
  Product workflow QA now has an explicit
  `agent-memory-embedding-provider-live` evidence gate for local embeddings,
  native OpenAI-compatible embeddings, secret-reference redaction, and vector
  search. It is intentionally marked as a known blocker until packaged/live
  evidence is captured.
- Capability scoring now has source-level product workflow QA/live evidence
  ingestion through JSON product gate output and generic
  `AgentCapabilityEvidenceRecord` conversion. The inspector now shows score,
  QA/live status, recent failure rate, evidence count, multiple evidence refs,
  and gap signals from the selected agent capability score. Product workflow QA
  now has an explicit `capability-scoring-evidence-ingestion` gate for
  inspector evidence, QA evidence ingestion, live evidence ingestion, evidence
  refs, and recent failure-rate display. It is intentionally marked as a known
  blocker until packaged/live evidence is captured.
- Product workflow QA gate does not pass strictly, including live Code Agent
  provider apply, repository intelligence packaged/live evidence, structured
  hot-list live evidence, Git remote/PR write evidence, Browser/Terminal
  approval evidence, agent memory embedding provider evidence, capability
  scoring evidence ingestion, and signed release rollback evidence. The
  live/package QA output gate now also requires packaged-app provenance,
  version/build, QA date, and verifies every referenced artifact exists for
  the affected blocker workflows, including Code Agent live provider evidence.
- Source-level localStorage migration audit now distinguishes migrated durable
  stores from intentional settings/cache/fallback consumers. Approval records,
  workspaces, task history, model settings, scheduled tasks, preferences,
  profile memory, current goal, and JSONL logs have import/remove coverage;
  packaged restart evidence is still required before treating this as a
  product-level closure.
- Release/version/rollback helper source QA passes and now requires a signed
  build summary plus previous artifact SHA-256 provenance, but release builds
  are still unsigned or lack real signed-artifact build summary and rollback
  notes in the QA folder.
- A primary user workflow requires editing docs, scripts, or fixtures by hand.

## Current Stage

The project has a verified MVP foundation with Chinese optimization complete and
streaming UI consumption fully implemented (Rust SSE → Tauri events →
delta-reducer → ThreadView StreamingMessage → useSmoothStream typewriter
animation with cancel). SQLite migration complete (9 migration sets, all
localStorage consumers migrated). Browser Agent complete (6-phase Playwright
integration with SSRF hardening, crash recovery, 1183 lines Rust).
VisionBridge complete (image paste → multimodal analysis → Commander injection).
Chinese Reviewer extracted from Agent system to pipeline module.
The next stage is product completion:

1. Debug reqwest HTTP request construction for DeepSeek API calls (fix the gap
   between Rust and the working Python verification script).
2. Run the complete-product workflow QA matrix in `docs/qa/PRODUCT_WORKFLOWS.md`
   and close any strict gate blockers.
3. Add release signing/versioning/rollback documentation.
4. Integrate Workspace Agent, Computer Use, File Write, and Git push/commit/stage tools
   into complete-product workflow QA, including approve, deny, stale-preview,
   guard, and one-shot execution evidence.
5. Add confirmed-write risk classification (safe / risky / dangerous).

`docs/MVP_STATUS.md` remains useful as a baseline acceptance record, but it is
not the current finish line.
