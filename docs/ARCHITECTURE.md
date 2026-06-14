# Architecture

Javis is a local-first desktop workbench for auditable multi-agent task
execution. The current implementation uses deterministic routing and rule-based
helpers, but the product target requires model-backed research and code agents
inside the same visible permission and verification boundaries.

## Goals

- Make every task state visible in the desktop UI.
- Keep local filesystem and process access behind explicit tool boundaries.
- Separate planning, execution, permission, and verification concerns.
- Prefer mature external tools and OpenCode extensions over rebuilding
  commodity capabilities from scratch.
- Prefer small, testable modules before introducing more agent framework
  complexity.

## Runtime Flow

```text
User goal
  -> Desktop UI
  -> Core runtime
  -> Route selection
  -> Tool call or dry-run
  -> Permission request when needed
  -> Verification
  -> Final UI snapshot
```

Core emits both snapshot-style state updates and structured runtime events. The
UI presents planning, running, waiting for permission, verifying, completed,
failed, timeout, cancellation, and tool/audit phases.

## Layers

### Desktop App

`apps/desktop` owns the Tauri shell and React application. It wires tool
implementations into Core, renders snapshots, and forwards permission
decisions. It should not own Commander policy or tool safety rules.

### UI Package

`packages/ui` contains reusable workbench components. Components receive data
and callbacks through props; they should not call Tauri commands or tools
directly.

### Core Package

`packages/core` owns task routing, plans, agent snapshots, permission flow, and
verification summaries. The package currently supports:

- Markdown document scan and summary.
- Project inspection and allowlisted command checks.
- URL-based source collection and source-backed report generation.
- PDF organization dry-run, confirmation, execution, and verification.
- Commander DAG execution with typed shared context, handoff reports, schema
  validation, request_input replanning, and dynamic agent registry visibility.
- Browser, Code, Computer, Scheduler, trend, Git, MCP, and workspace tool
  contracts through runtime-injected implementations.

Core is being split into focused modules. The runtime is still centered in
`packages/core/src/workflow-executor.ts`; helper modules already exist for
agents, plans, research reporting, route detection, DAG execution, ReAct loops,
runtime timeouts/logging, and workflow step helpers.

### Tools Package

`packages/tools` defines shared tool contracts and small pure helpers. Native
execution is provided by the desktop app through Tauri commands, not by this
package directly.

### Tauri Backend

`apps/desktop/src-tauri` owns native filesystem, process, and HTTP bridge
commands. Rust code applies low-level safety checks before returning results to
the TypeScript runtime.

### Search Backends

Research source discovery uses a staged backend strategy:

1. The current desktop bridge uses `github-cli` repository search as the first
   available technical-search provider.
2. Once Code Agent / OpenCode is integrated,
   `expert-vision-software/opencode-intellisearch` becomes the preferred
   provider for OpenCode-backed technical and code research. Javis should
   connect to it through the narrowest available OpenCode/plugin adapter, or MCP
   when that preserves auditable source metadata.
3. An embedded Chrome instance dedicated to the agent is the fallback provider.
   It is used only when the primary provider is unavailable, returns no usable
   results, or cannot satisfy the query.

The embedded Chrome fallback must use an isolated profile controlled by Javis,
not the user's normal browser profile. It must not read cookies, passwords,
private keys, browser history, or account sessions. It is limited to read-only
public source discovery and retrieval unless a future safety design explicitly
expands that boundary.

The IntelliSearch adapter must not call package internals directly. Installation
(`bunx opencode-intellisearch install --scope local`) changes OpenCode
configuration and must be treated as a confirmed-write setup step. Runtime
search should go through OpenCode, for example an `opencode run --dir
<workspace> --format json` invocation that triggers `/search-intelligently`.
The `opencode-intellisearch` provider label is reserved for results that came
through that plugin path. Plain `gh search repos` results must be labelled
`github-cli`.

## Dependency Direction

```text
apps/desktop -> packages/ui
apps/desktop -> packages/core -> packages/tools
apps/desktop -> src-tauri commands
```

The important rule is that UI and Core do not bypass the tool layer for risky
actions. Tauri commands may enforce safety constraints, but they do not decide
agent policy.

## Agent Roles

- Commander: selects a route and presents the plan.
- File Agent: handles Markdown scans and PDF organization previews/execution.
- Shell Agent: runs allowlisted read-only project checks.
- Research Agent: searches and fetches public URL sources.
- Computer Agent: browses local computer views and searches indexed local
  files/documents under user-visible actions.
- Scheduler Agent: records reminders and scheduled tasks, then coordinates
  local notification execution.
- Verifier: checks evidence and creates the final verification summary.

Browser and Code Agent roles are required for product readiness. Code Agent now
has an initial Core/UI scaffold for changed-file listing, diff preview,
read-only verification, opencode-backed proposal metadata, and confirmed-write
approval for patch application. The desktop app asks opencode for proposal-only
JSON with the model/provider configured in the workbench, injects those
settings into opencode's per-run config, and keeps file writes inside Javis's
native approved-patch apply command.
Browser/account-changing automation remains out of scope unless a future design
adds explicit safety rules.

## Multi-Agent Workflow Blueprints

`packages/core/src/workflows.ts` records the product workflow templates that the
future scheduler should consume. They are intentionally lightweight blueprints,
not a hidden autonomous runtime. Commander remains the coordinator, and each
step declares its agent, inputs, outputs, permission level, dependencies, and
whether it can run in parallel.

Current built-in blueprints:

- Read current project: Commander coordinates File, Shell, Code, and Verifier
  to scan files, inspect scripts, analyze structure, and produce an
  evidence-backed project summary.
- Research trending topics: Research and Browser collect public current
  sources, then Verifier deduplicates and ranks the brief.
- Plan a Spring Boot project: Commander clarifies requirements, Research checks
  current guidance, Code drafts steps/snippets, and Verifier checks consistency.
- Find a local document: Commander parses the query, Computer searches local
  file metadata, and Verifier ranks matches.
- Daily reminder: Commander parses the schedule, Scheduler persists the local
  reminder, and Verifier confirms the next run.

These workflows describe the target collaboration model for a Marvis/Mavis-style
workbench while preserving Javis's safety rule: read steps can run directly, but
local writes, file changes, or durable scheduled-state changes must remain
visible and approval-bound.

## OpenCode Extension Strategy

OpenCode should be treated as an extensible agent kernel, not as a place to
hand-build every missing capability. When a capability is common, Javis should
evaluate existing open-source tools first and connect them through the narrowest
safe boundary that fits the task.

Preferred extension paths:

- MCP tools for external capabilities such as cross-session project memory,
  public web search, indexing, and source retrieval.
  `expert-vision-software/opencode-intellisearch` is the preferred
  OpenCode-side search plugin for technical and code research after Code Agent
  integration, when it can fit this boundary. Candidate memory tools include
  Python ecosystem services such as Muninn and JavaScript ecosystem tools such
  as `@opencode-manager/memory`, provided they fit the local-first security
  model.
- OpenCode plugins for agent workflow behavior. FullAutoAgent-style plugins can
  provide autonomous workflow state machines, while Systematic-style plugins can
  add structured engineering procedures without pushing that logic into Javis
  Core.
- Multi-agent orchestration for work that benefits from separation of duties.
  Agent factory patterns such as `agent-forge` can create an Orchestrator and
  delegate bounded work to Researcher, Reviewer, or implementation agents.

Adoption rules:

- Check existing dependencies and architecture extension points first.
- Then evaluate mature GitHub and ecosystem projects. Prefer tools with active
  maintenance, clear interfaces, compatible licenses, and local or
  user-controlled execution paths that fit the Javis privacy model.
- Build a custom implementation only when the need is narrow, the dependency is
  too heavy, the license is unsuitable, or the safety boundary requires direct
  control.
- Explain the tradeoff before introducing a new dependency, plugin, or external
  service; do not silently expand the dependency surface.
- Keep every external tool behind Javis permission, audit, and verification
  boundaries.
- Do not introduce broad plugin marketplace behavior before the product-ready
  core is complete.

## Current Tradeoffs

- Routing is rule-based instead of model-based.
- Search-backed research is wired through `github-cli` and Agent Chrome
  fallback. Fixture QA and live smoke evidence exist; IntelliSearch evidence
  remains blocked on Code Agent / OpenCode integration.
- Persistence is SQLite-backed for task history, approval records, scheduled
  tasks, user preferences, JSONL logs, model settings, model profiles, workspace
  settings, and memory/vector-index storage.
- Permission decisions are scoped per task/tool/workspace/preview hash and are
  persisted as durable approval records for restore and audit, not as broad
  reusable grants.
- The runtime is being modularized incrementally; `workflow-executor.ts` and
  `App.tsx` remain large and should be split through small behavior-preserving
  extractions.

These tradeoffs are acceptable only while the product-ready core continues to
harden. See `PRODUCT_READINESS.md`, `SECURITY_MODEL.md`, and
`docs/adr/0001-native-write-boundary.md` for the active targets.
