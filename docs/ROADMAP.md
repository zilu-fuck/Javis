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
- Prefer MCP-backed search integration when it can preserve source URL, title,
  fetched timestamp, excerpt, and error evidence.
- Fetch and compare at least three accessible public sources by default.
- Preserve source URL, title, fetched timestamp, and excerpt.
- Clearly label unsupported or unverifiable claims.
- Add retry and manual-source fallback UI.
- Add tests and QA screenshots for search success, weak evidence, failed fetch,
  and no-results states.

## Milestone 2: Code Agent

- Add a `CodeTool` interface.
- Integrate opencode as an optional backend.
- Treat opencode as an extensible kernel:
  - use MCP for memory, search, indexing, and other external capabilities
  - evaluate OpenCode plugins such as FullAutoAgent-style workflow plugins and
    Systematic-style engineering-process plugins before building equivalents
  - evaluate orchestration plugins such as agent-forge when tasks need
    Researcher / Reviewer / implementer separation
- Keep opencode under Javis permission rules:
  - read project context
  - produce analysis
  - produce diff preview
  - ask for confirmation before applying edits
  - run checks through Shell Tool policy
- Add tests around rejected dangerous commands and approved edit application.
- Add QA for inspect-only, diff preview, approved edit, denied edit, and failed
  verification states.

## Milestone 3: Persistence And Workspace Management

- Store task history locally.
- Store permission decisions only as scoped records, never as broad reusable
  approval.
- Add a clear history deletion path.
- Add workspace selection and remembered recent workspaces.
- Avoid storing secrets, tokens, raw cookies, or private keys.

## Milestone 4: Generalized Permission System

- Move approval-state enforcement from the PDF-specific path into a reusable
  confirmed-write mechanism.
- Require write tools to execute only the approved current dry-run.
- Add expiration/cancellation behavior for stale permission requests.
- Add audit records for what changed, what was skipped, and what failed.
- Keep dangerous actions rejected by default.

## Milestone 5: Product Hardening

- Improve empty states, loading states, and recovery paths.
- Add structured event stream objects instead of only snapshot updates.
- Add telemetry-free diagnostics export for local debugging.
- Add signed builds, version strategy, artifact checksums, release notes, and
  rollback notes.
- Expand manual QA from MVP scenarios to complete-product workflows.

## Explicit Non-Goals Until Product-Ready Core Is Complete

- Plugin marketplace.
- Cross-device control.
- Long-term memory and vector database.
- Editable agent graph.
- Production deployment automation.
- Payments, purchases, messaging, or account-changing browser automation.
