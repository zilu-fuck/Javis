# Multi-Function Agent Workbench Gap Analysis

Audit date: 2026-06-11

Scope: current source tree plus product QA gates. This is not packaged/live QA
evidence. Do not treat source-level implementation as product readiness until
the required dated QA artifacts exist.

## Summary

Javis already has the core shape of a multi-function local-first Agent
workbench: task threads, a desktop workbench UI, Commander DAG planning,
agent/tool descriptors, read-only and confirmed-write tool classes, local
memory, repository intelligence, Git workflows, Browser/Terminal surfaces,
Computer Use, MCP/Skills, and release QA gates.

The remaining gap is now mostly product proof and a few productization surfaces,
not a lack of core architecture:

1. Product evidence is still incomplete. Several workflows are intentionally
   `BLOCKED` until packaged/live screenshots and structured outputs are
   captured.
2. High-risk writes mostly have source-level approval paths, but Git remote/PR,
   Browser writes, and Terminal input still need packaged approval evidence.
3. Domain tools exist for structured hot lists, but live/package evidence and
   more typed providers are still needed.
4. Repo intelligence now has rg, fallback attempts, AST, TypeScript compiler
   resolution, TypeChecker enrichment, local semantic rerank, vector index, and
   registry hooks; it still needs packaged/live proof.
5. Agent memory embedding provider selection now has source-level UI wiring,
   including configured model profile reuse; live/provider evidence still
   needs packaged proof.
6. Capability scoring exists in core/UI, but live evidence ingestion still
   needs packaged proof.

## Current Capability State

| Area | Current state | Main evidence |
| --- | --- | --- |
| Agent registry and tool ownership | Implemented. Agents have allowlists and tool descriptors carry permission, owner, and capability metadata. | `packages/core/src/agents.ts`, `packages/tools/src/descriptors.ts` |
| Commander DAG | Implemented. Steps support assigned agent, dependencies, context keys, tool input, output context, execution mode, and success criteria. Core also exposes a serializable handoff report builder that records producer/consumer context keys, missing inputs, unconsumed outputs, and compact value summaries; final Commander DAG snapshots carry the report; the UI can display it and expose source-level JSON/Markdown download controls. Core and UI both format stable handoff artifacts. | `packages/core/src/commander-plan-schema.ts`, `packages/core/src/workflow-executor.ts`, `packages/core/src/shared-context.ts`, `packages/ui/src/handoff-report-export.ts`, `packages/ui/src/components/AgentDetailSections.tsx` |
| Clarification | Implemented at source level through `commander.askUser` and clarification planning rules. | `packages/tools/src/descriptors.ts`, `packages/core/src/commander-plan-schema.ts` |
| ReAct and recovery | Partially implemented. Observations, bounded loops, and replan paths exist. Commander DAG failures now produce a serializable recovery report with generic failure kind, replan status, abandoned/replanned step IDs, completed-before context, suggested alternate paths, UI display, and source-level history persistence; more real workflow QA is still needed. | `packages/core/src/agent-react-loop.ts`, `packages/core/src/recovery-report.ts`, `packages/core/src/workflow-executor.ts`, `packages/ui/src/components/AgentDetailSections.tsx`, `apps/desktop/src/task-history.ts` |
| File Write | Source-level confirmed-write path exists with plan/write tools, native approval binding, preview hash, task/tool binding, path guards, and one-shot execution. Product QA evidence is still needed. | `packages/core/src/text-write-flow.ts`, `apps/desktop/src-tauri/src/file_write.rs`, `apps/desktop/src/app-runtime.ts` |
| Code Agent | Fixture path works with proposal, approve/deny, and native guarded apply. Live provider proposal/apply remains a product blocker until real provider evidence is captured. | `apps/desktop/src/app-runtime.ts`, `apps/desktop/src-tauri/src/code.rs`, `docs/qa/PRODUCT_WORKFLOWS.md` |
| Git | Source-level stage, commit, push, PR create, and PR comment confirmed-write paths exist with preview hashes, one-shot approval, audit records, Commander dispatch, Review panel quick actions, and durable restore coverage. Packaged disposable remote/PR evidence is still missing. | `apps/desktop/src-tauri/src/git.rs`, `apps/desktop/src/app-runtime.ts`, `packages/core/src/workflow-executor.ts`, `packages/tools/src/descriptors.ts` |
| Browser read | Implemented for navigation, status, screenshot/content, links, and safe read-only browsing. | `apps/desktop/src-tauri/src/browser.rs`, `packages/tools/src/descriptors.ts` |
| Browser writes | Source-level native plan/approve, runtime approval broker, visible Browser approval card, deny fail-closed path, audit records, and disabled agent exposure policy exist. Product QA screenshots/output are still missing. | `apps/desktop/src/browser-write-contract.test.ts`, `packages/ui/src/index.test.tsx`, `docs/qa/2026-06-11/browser-native-visible-approval-source-qa.md` |
| Terminal | Source-level native plan/approve and visible UI gate exist for start/input, with one-shot execution and redacted audit records. Product QA screenshots/output are still missing. | `apps/desktop/src/terminal-approval-contract.test.ts`, `docs/qa/2026-06-11/terminal-native-visible-approval-source-qa.md` |
| Computer Use | Stronger than Browser/Terminal at product safety design level: desktop automation, approval leases, sensitive-action checks, local-vision guardrails, cancellation, and audit paths exist. More real app QA is still needed. | `apps/desktop/src/computer-use-loop.ts`, `apps/desktop/src-tauri/src/computer.rs` |
| Local-first memory | Implemented with SQLite facts/summaries/injection logs and hybrid recall. Local embeddings, OpenAI-compatible embedding provider plumbing, privacy-settings UI, and configured model/key-reference reuse exist at source level; packaged/live provider evidence is still missing. | `apps/desktop/src/agent-memory.ts`, `apps/desktop/src/vector-index.ts`, `apps/desktop/src/agent-memory-embedding-provider.ts`, `packages/ui/src/components/ModelSettings.tsx` |
| Structured hot-list research | Generic `trend.fetchHotList` exists with provider IDs, adapter registry, fallback providers, diagnostics, and report integration. Live/package hot-list evidence is still missing. | `apps/desktop/src/trending-service.ts`, `packages/tools/src/descriptors.ts`, `docs/qa/2026-06-10/trend-hot-list/` |
| Repo intelligence | Source-level implementation is broad: rg/fallback attempts, clustering, key files, evidence sections, module links, package hints, tsconfig/compiler resolution, AST graphing, TypeChecker graph enrichment, semantic rerank, vector index, and registry hooks. Packaged/live evidence is still missing. | `apps/desktop/src/repo-intelligence-service.ts`, `packages/core/src/repo-intelligence.ts`, `docs/qa/2026-06-11/repo-typechecker-symbol-graph-source-qa.md` |
| Capability scoring | Core scoring and Inspector display exist, including QA/live evidence records, evidence refs, recent failure rate signals, repair-priority reasons, and compact summary-card badges. Packaged evidence ingestion proof is still missing. | `packages/core/src/agent-capability.ts`, `apps/desktop/src/capability-verification.ts`, `packages/ui/src/components/inspector/AgentDetailPanel.tsx`, `packages/ui/src/components/AgentSummaryCard.tsx` |
| Release and rollback | Source-level signed build summary and rollback-note gates exist. Real signed MSI/NSIS artifacts and generated release evidence are still missing. | `scripts/release/build-windows-signed.ps1`, `scripts/release/write-release-rollback-notes.ps1`, `scripts/qa/check-product-workflow-evidence.ps1` |

## Product Blockers That Must Stay Open

The current product workflow inventory still marks these scenarios as blocked
unless real evidence artifacts are added:

- `code-agent-live-provider`
- `trend-hot-list-live`
- `repo-intelligence-package-live`
- `git-remote-pr-writes`
- `browser-terminal-approvals`
- `agent-memory-embedding-provider-live`
- `capability-scoring-evidence-ingestion`
- `release-and-rollback`

Run the development inventory with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\qa\check-product-workflow-evidence.ps1 -AllowKnownBlockers
```

## User-Requested Behaviors

| Behavior | Current state | Notes |
| --- | --- | --- |
| Ask required questions before designing memory or risky systems | Available through Commander clarification rules and `commander.askUser`; still depends on model discipline for ambiguous prose. |
| Organize repair priorities from prior Javis issues | Source-level capability repair ranking now combines implementation gaps, permission readiness, QA/live evidence gaps, recent failure rate, evidence refs, and next-evidence hints; Inspector details now surface a repair-priority label and reasons from each capability score. Product use still depends on captured history and packaged evidence ingestion. |
| Plan first, then execute, and name steps requiring confirmation | Available through DAG and permission model; product UX can still make confirmations more explicit. |
| Self-review a proposal and revise it | Source-level planning rules now require a review step before risky designs, migrations, or implementations; packaged behavior evidence is still missing. |
| Recover from tool failure instead of only reporting failure | Source-level replan prompts classify common failure kinds and provide generic recovery hints. Commander DAG snapshots now also attach a recovery report that records attempted replans, abandoned failed steps, recovery step IDs, completed-before context, generic alternate-path suggestions, and redacted error summaries; task details display it and source-level history persistence keeps valid reports. Real workflow QA and tool-specific fallback evidence are still needed. |
| Handle "optimize this" with clarification, planning, execution | Source-level planning rules now require target artifact plus optimization dimension before edits; product behavior evidence is still missing. |
| Split work across multiple Agents with handoffs | Source-level planning rules now require producer `outputContextKey`, receiver `inputContextKeys`, and handoff success evidence; Inspector plan details now show handoff input/output context keys; core can build and attach a serializable handoff report with producer/consumer links, missing inputs, unconsumed outputs, and value summaries; the task details UI can display the report and download JSON/Markdown artifacts; task history and session JSONL sanitizers preserve valid handoff reports and step context keys; core and UI can produce stable JSON/Markdown report artifacts. Packaged save/download evidence is still missing. |
| Prevent accidental computer operations | Strong for Computer Use and source-level confirmed writes; product evidence for Browser/Terminal/Git remote remains required. |
| Capability scoring table | Source/UI exists; product evidence ingestion proof remains blocked. |
| Search existing code before proposing a solution | Source-level repo intelligence exists and is exposed to the Code Agent when runtime implementation exists. |
| Locate bugs when the user uses the wrong name | Partially supported by fallback/concept/CJK search, semantic rerank, AST/TypeChecker graph evidence, and confirmation gaps. |
| Search all related code but report only key files | Supported at source level through clustering and key-file ranking; product UX evidence still needed. |
| Retry with different keywords after no results | Supported at source level through planned attempts, fallback terms, retry count, provider/error diagnostics. |
| Separate actual evidence, inference, and confirmation gaps | Supported in repository evidence reports and trace reports. |
| Trace from UI entry to backend call | Partially supported by `code.traceCallChain`, resolver hints, AST/TypeChecker graph edges, and package hints; packaged evidence is still missing. |
| Find semantically related implementations | Improved with local semantic rerank and vector primitives; still not a full language-server-grade semantic code search product. |
| Cluster too many search results before conclusion | Supported at source level through repository search clustering. |

## Example: "Summarize Today's Top 20 Weibo Hot Searches"

This should stay generic. The product path should not hardcode one hot-list
provider or one research report shape:

1. Parse the request as a structured hot-list research task:
   - domain/provider hint: Weibo hot search
   - item count: 20
   - freshness: today/current
   - output: summary/report with sources
2. Call a typed read-only hot-list tool such as `trend.fetchHotList` with:
   - provider id
   - requested count
   - freshness metadata
   - fallback providers where configured
3. Preserve structured item fields:
   - rank
   - title
   - URL/source
   - heat score when available
   - source/provider metadata
   - as-of time and diagnostics
4. Convert the structured list into a research report:
   - cite the hot-list source
   - summarize top themes
   - label missing/weak data as unknowns
   - retain diagnostics for incomplete or stale lists

Current source status: the typed tool, provider registry, initial Weibo adapter,
fallback diagnostics, and report integration exist. The blocker is real
packaged/live evidence for a top-20 request.

## Recommended Next Steps

1. Capture packaged/live evidence for the current blocker set instead of
   continuing to treat source-level tests as product readiness.
2. Run disposable remote Git QA for stage/commit/push/PR create/comment with
   screenshots and structured output.
3. Run Browser/Terminal packaged approval QA for approve, deny, stale preview,
   one-shot execution, and visible cards.
4. Run live Code Agent provider QA with temporary credentials and no API keys
   in screenshots, logs, or notes.
5. Run structured hot-list live/package QA for a top-20 request and confirm the
   report carries provider/source diagnostics.
6. Run packaged repo intelligence QA showing key files, symbol graph, resolver
   evidence, package/registry evidence, and fallback diagnostics.
7. Produce real signed release artifacts plus generated build summary and
   rollback notes.

## Key Files

For the workbench capability boundary:

1. `packages/core/src/agents.ts`
2. `packages/tools/src/descriptors.ts`
3. `packages/core/src/workflow-executor.ts`

For high-risk write safety:

- `apps/desktop/src-tauri/src/file_write.rs`
- `apps/desktop/src-tauri/src/git.rs`
- `apps/desktop/src-tauri/src/browser.rs`
- `apps/desktop/src-tauri/src/terminal.rs`
- `apps/desktop/src-tauri/src/computer.rs`

For product evidence gates:

- `docs/qa/PRODUCT_WORKFLOWS.md`
- `scripts/qa/check-product-workflow-evidence.ps1`
- `docs/PRODUCT_READINESS.md`
