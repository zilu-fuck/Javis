# Roadmap

This roadmap now targets a complete usable Javis desktop product. The verified
MVP is Milestone 0: a baseline that proves the workbench, tool boundaries,
verification loop, and PDF permission model.

## Milestone 0: Verified MVP Baseline

Status: complete for the 2026-05-23 QA pass.

- Desktop workbench shell.
- Markdown scan and summary.
- Project inspection with allowlisted checks.
- User-provided URL research report.
- PDF organization dry-run, approval, execution, denial, and conflict skip.
- Native approval-state enforcement for the PDF confirmed-write path.
- Manual QA evidence under `docs/qa/2026-05-23/`.

## Milestone 1: Complete Research

- Add a search provider abstraction.
- Evaluate maintained search tools and providers before implementing search
  logic directly.
- Use a staged search backend:
  - current desktop bridge: `github-cli` repository search, then embedded Agent
    Chrome fallback
  - product Code Agent path: `expert-vision-software/opencode-intellisearch`
    through OpenCode/plugin boundaries
  - final fallback: embedded Chrome when the primary provider is unavailable,
    returns no usable results, or cannot satisfy the query
- Adapt IntelliSearch only through OpenCode/plugin boundaries first; prefer MCP
  or other narrow adapters only when they preserve source URL, title, fetched
  timestamp, excerpt, and error evidence.
- Treat `bunx opencode-intellisearch install --scope local` as a confirmed-write
  setup step because it modifies OpenCode configuration.
- Reserve the `opencode-intellisearch` provider label for results produced
  through the OpenCode plugin path; label direct GitHub CLI repository search as
  `github-cli`.
- Keep embedded Chrome isolated from the user's normal browser profile and use
  it only for read-only public source discovery and retrieval.
- Fetch and compare at least three accessible public sources by default.
- Preserve source URL, title, fetched timestamp, and excerpt.
- Clearly label unsupported or unverifiable claims.
- Expand retry, manual-source fallback UI, and clear messaging when Javis
  switches from `github-cli` or IntelliSearch to embedded Chrome. Initial
  failed-research fallback messaging is present in the workbench.
- Add tests and QA screenshots for `github-cli` success, IntelliSearch success
  after Code Agent integration, Chrome fallback, weak evidence, failed fetch,
  and no-results states. Live `github-cli` and Agent Chrome smoke evidence are
  already captured.

## Milestone 2: Code Agent

- Add a `CodeTool` interface. Initial inspect-only diff preview is
  implemented.
- Integrate opencode as an optional backend. Initial proposal-only adapter is
  implemented, uses desktop-managed model settings, has DeepSeek/custom
  OpenAI-compatible fallback, proposal parser hardening, redacted provider
  diagnostics, and Windows DPAPI secret-reference credential storage.
  Packaged-app fixture QA covers proposal denial and approved patch
  application, including exact patch-body preservation for `git apply`. Live
  DeepSeek-compatible smoke reaches proposal generation and should be rerun
  after the latest prompt/parser/apply hardening.
- Treat opencode as an extensible kernel:
  - use MCP for memory, search, indexing, and other external capabilities
  - evaluate OpenCode plugins such as FullAutoAgent-style workflow plugins and
    Systematic-style engineering-process plugins before building equivalents
  - evaluate orchestration plugins such as agent-forge when tasks need
    Researcher / Reviewer / implementer separation
- Keep opencode under Javis permission rules:
  - read project context
  - produce analysis
  - produce diff preview (initial current-diff preview is implemented)
  - ask for confirmation before applying edits
  - run checks through Shell Tool policy
- Route code review goals through the Code Agent scaffold. Initial routing,
  changed-file listing, preview approval, read-only `git diff --check`
  verification, opencode-backed proposed-edit contract, confirmed-write apply
  approval, desktop model configuration, and a local approved-patch apply
  command are implemented. Fixture opencode proposal/apply QA passes. Live
  DeepSeek-compatible proposal smoke now runs through native secret-reference
  credential injection and remains gated to proposal-only smoke until the
  hardened real-provider path is rerun with temporary credentials.
- Add tests around rejected dangerous commands and approved edit application.
- Add QA for inspect-only, diff preview, approved edit, denied edit, and failed
  verification states.

## Milestone 3: Persistence And Workspace Management

Status: substantially complete (2026-05-31).

- Store task history locally. Initial completed/failed/cancelled snapshot
  persistence is implemented in the desktop app.
- Add durable approval records for pending and resolved confirmed-write
  decisions. Start with PDF organization so approval cards can survive app
  restart before Code Patch is migrated. Initial desktop storage and PDF restore
  plumbing are implemented; packaged restart QA verifies the PDF approve, deny,
  and expiry paths. Code Patch pending/resolved approval audit records now
  retain the proposal payload, and packaged restart QA verifies approve/apply,
  deny, and expiry paths.
- Store permission decisions only as scoped records tied to a task, tool,
  workspace, preview hash, and expiry. Never persist them as broad reusable
  approval.
- Restore pending approval cards from durable approval records, and persist
  approve/deny/expired outcomes as audit evidence.
- Add a clear history deletion path. Initial sidebar deletion is implemented.
- Add workspace selection and remembered recent workspaces. Implemented: desktop sidebar accepts manual paths and native directory picker, restores recent workspaces after restart.
- Avoid storing secrets, tokens, raw cookies, or private keys.
- SQLite migration: all 9 migration sets deployed, model-settings migrated; task history/approval/workspaces migration verification in progress.

## Milestone 4: Generalized Permission System

Status: partially complete (2026-05-31).

- Move approval-state enforcement from the PDF-specific path into a reusable
  confirmed-write mechanism.
- Require write tools to execute only the approved current dry-run.
- Add expiration/cancellation behavior for stale permission requests.
- Add audit records for what changed, what was skipped, and what failed.
- Add shared native guard helpers for approval id, task/tool binding, preview
  hash, workspace/path scope, file extension, and current file hash.
- Migrate PDF organization and Code Patch apply onto the shared guards without
  changing their user-visible behavior. Code Patch proposal/apply now use the
  shared relative path and approved-file guard, and Code Patch apply validates
  approval id, proposal patch hash, approved files, and current-file hashes
  with one-shot native consumption. PDF approval/restore now validates operation
  path scope and PDF source type before pending state is accepted. Code Patch
  restart restore/apply is wired through durable records, and PDF / Code Patch
  approval id, approved-state, tool-name, and preview-hash checks now share a
  native approval binding abstraction. Durable approval restore also recomputes
  the dry-run binding hash and checks Code Patch proposal files against the
  approved dry-run. Task binding and broader write-command migration remain.
- File Write tool (`file.planWriteText` / `file.writeText` / `file_write.rs`) has source-level confirmed-write wiring with native approval binding, preview hash validation, task/tool binding, workspace path guards, and one-shot execution. Git push has a first source-level confirmed-write backend through `git_plan_push` / `git_approve_push` / `git_execute_push` plus a Review-panel quick action, including remote summary, GitHub CLI PR list, push preview, protected-branch and behind-upstream guards, preview hash validation, task/tool binding, one-shot execution against a fixed refspec, initial plan/execute/failure tool-call audit records, and source-level durable restore coverage. Git commit has source-level confirmed-write wiring through `git_plan_commit` / `git_approve_commit` / `git_execute_commit`, Review-panel quick action for current-all-changes commits, preview hash validation, task/tool binding, one-shot execution, plan/execute/failure audit records, source-level durable restore coverage, explicit `paths` support for selected-path commits, and Commander DAG dispatch through `git.createCommit` with confirmed-write approval. Git stage selected files has source-level confirmed-write wiring through `git_plan_stage_files` / `git_approve_stage_files` / `git_execute_stage_files`, preview hash validation, task/tool binding, path guards, one-shot execution, Review-panel quick action, audit records, source-level durable restore coverage, and Commander DAG stage dispatch through `git.stageFiles` with explicit path input and confirmed-write approval. GitHub CLI draft PR creation has a source-level native confirmed-write path through `git_plan_create_pull_request` / `git_approve_create_pull_request` / `git_execute_create_pull_request`, with preview hash validation, task/tool binding, one-shot execution, Commander DAG / desktop runtime dispatch through `git.createPullRequest`, Review-panel quick action, initial plan/execute/failure audit records, and source-level durable restore coverage. GitHub CLI PR comment has source-level confirmed-write wiring through `git_plan_comment_pull_request` / `git_approve_comment_pull_request` / `git_execute_comment_pull_request`, preview hash validation, task/tool binding, one-shot execution, Commander DAG / desktop runtime dispatch through `git.commentPullRequest`, Review-panel quick action, audit records, and source-level durable restore coverage; product QA remains. Product QA evidence and broader write-command migration remain.
- Keep dangerous actions rejected by default.

## Milestone 5: Product Hardening

Status: partially complete (2026-05-31).

- Improve empty states, loading states, and recovery paths.
- Keep browser local storage free of model API keys. New saves now persist only
  provider/model/base URL and a key reference, legacy stored keys are cleared on
  load, and Windows native storage protects the referenced secret with DPAPI
  before single-request use by the Code Agent proposal command.
- Add structured event stream objects instead of only snapshot updates. Streaming pipeline complete: Rust SSE → Tauri events → delta-reducer → StreamingMessage → useSmoothStream typewriter animation with cancel support.
- Add telemetry-free diagnostics export for local debugging.
- Add signed builds, version strategy, artifact checksums, release notes, and
  rollback notes. (not yet done)
- Expand manual QA from MVP scenarios to complete-product workflows. QA evidence at docs/qa/2026-05-30/. 740 total tests (564 Vitest + 176 Rust).

## Explicit Non-Goals Until Product-Ready Core Is Complete

- Plugin marketplace.
- Cross-device control.
- Long-term memory and vector database.
- Editable agent graph.
- Production deployment automation.
- Payments, purchases, messaging, or account-changing browser automation.
