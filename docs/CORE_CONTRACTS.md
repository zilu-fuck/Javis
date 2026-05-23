# Core Contracts

This document describes the shared language between Desktop, Core, Tools, and
Tauri commands. Type definitions live in `packages/core/src/index.ts` and
`packages/tools/src/index.ts`; this document explains the intended semantics.

## Task State

A task is the user-visible unit of work. It has:

- A user goal.
- A status.
- A plan of steps.
- Agent snapshots.
- Logs.
- Optional result sections such as documents, commands, sources, research
  report, project inspection, permission request, or file organization result.

The desktop app persists completed, failed, and cancelled task snapshots for
sidebar history restore. Pending permission requests are not persisted because
confirmed-write approvals are scoped to the current in-memory dry-run.

Current statuses:

```text
created
planning
running
waiting_permission
verifying
retrying
completed
failed
cancelled
```

`retrying` and `cancelled` exist in the contract but are not fully exercised by
the MVP runtime yet.

## Agent State

Current built-in agents:

- `commander`
- `file`
- `shell`
- `code`
- `research`
- `verifier`

Placeholder agent kinds also exist for future browser work. Agent snapshots are
display state; they are not independent processes in the MVP.

## Tool Contracts

### File Tool

Supports:

- `scanMarkdownDocuments()`
- `planPdfOrganization()`
- `executePdfOrganization(operations, approvalId)`

Write operations require a dry-run, a current approval from Core, and the
approval id returned with the matching preview plan.

### Project Tool

Supports:

- `inspectProject()`

It returns workspace path, package manager, package scripts, and recommended
start/check commands.

### Shell Tool

Supports:

- `runReadOnlyCommand(request)`

Commands must be allowlisted and return command text, cwd, exit code, stdout,
and stderr.

### Web Tool

Supports:

- `fetchWebSource({ url })`
- optional `searchWeb({ query, maxResults })`

`fetchWebSource` returns URL, title when available, excerpt, and fetched
timestamp.

`searchWeb` is the search-provider extension point for product research. It is
optional because providers can vary by desktop environment. The current
provider order is `github-cli` first, then an embedded Chrome instance dedicated
to the agent as fallback. After Code Agent / OpenCode integration,
`expert-vision-software/opencode-intellisearch` should become the preferred
technical and code research provider through an OpenCode plugin adapter. Core
may use `searchWeb` when injected by an OpenCode plugin adapter, MCP adapter, or
native provider, but it must remain read-only and return auditable public source
candidates with URL, title or excerpt, fetched timestamp, and provider metadata
when available. Fallback results should include provider metadata such as
`github-cli`, `opencode-intellisearch`, or `agent-chrome` so the UI and logs can
show which path produced the evidence.

### Code Tool

Supports:

- `inspectRepository()`

It returns the workspace path, changed files, diff stat, and a bounded diff
preview for the current local repository state. The first implementation is
inspect-only: it does not propose new edits, apply patches, or call opencode.
Core treats the preview as a `preview` permission step before running read-only
verification.

## Permission Contract

Permission levels:

```text
read
preview
confirmed_write
dangerous
```

`read` actions may execute immediately. `preview` actions may inspect and
produce dry-runs. `confirmed_write` actions require an explicit pending
permission request. `dangerous` actions are rejected by default in the MVP.

Permission approval is scoped to one current dry-run. It must not be reused as a
general future approval. The native PDF organization command also treats
approval as one-time-use state: execution is rejected when the approval id is
missing, unapproved, stale, or paired with operations that differ from the
current dry-run.

## Verification Contract

Each completed route must produce evidence:

- Markdown scan: path, modified time, size, purpose.
- Project inspection: command outputs and exit codes.
- Research: source URLs and excerpt-backed report rows.
- Code review: workspace path, changed files, diff preview, permission
  decision, and read-only `git diff --check` output.
- PDF organization: dry-run, permission decision, execution counts.

Verifier output is currently a summary string and logs in the snapshot. A richer
event and evidence object model is planned.

## Public Import Boundary

Consumers should import Core from `@javis/core`. Internal Core files are allowed
to move as the runtime is split.

Tool consumers should import contracts from `@javis/tools`. Tauri command names
are desktop implementation details and should be adapted at the app boundary.
