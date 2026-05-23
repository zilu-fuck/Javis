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

Core currently emits snapshot-style state updates. A structured event stream is
planned, but the UI already presents the important phases: planning, running,
waiting for permission, verifying, completed, and failed.

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

Core is being split into focused modules. The runtime is still centered in
`packages/core/src/index.ts`; helper modules already exist for agents, plans,
research reporting, and route detection.

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
- Research Agent: fetches user-provided public URLs.
- Verifier: checks evidence and creates the final verification summary.

Browser and Code Agent roles are required for product readiness. Code Agent is
not implemented yet; browser/account-changing automation remains out of scope
unless a future design adds explicit safety rules.

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
  fallback, but product QA evidence and source-comparison polish are still
  incomplete.
- Completed, failed, and cancelled task history has an initial local snapshot
  store in the desktop app; broader restart QA and storage migration hardening
  are still needed.
- Permission decisions are per-task and not persisted.
- The runtime is not fully modular yet.

These tradeoffs are acceptable for the verified MVP baseline, but they are not
acceptable for complete product readiness. See `PRODUCT_READINESS.md` for the
active target.
