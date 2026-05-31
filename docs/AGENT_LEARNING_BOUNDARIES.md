# Agent Learning Boundaries

This document defines the safe implementation boundary for adding
AutoSci-inspired learning to Javis. The goal is to let Javis remember useful
workspace experience without allowing remembered experience to bypass current
evidence, user intent, or the local-first permission model.

## Summary

Javis may learn from auditable task outcomes. It must not learn new authority.

Learning is limited to planning context: what worked before, what failed, what
the verifier found, and which workflow choices were useful in a specific
workspace. Learned records may help Commander choose or explain a plan, but they
must never directly execute tools, lower permission levels, widen filesystem
scope, or override the current verifier result.

The first implementation should be small:

```text
TaskSnapshot / verifier result
  -> summarizeMemoryEvent()
  -> SQLite agent_memory_events
  -> compileMemoryBrief(workspacePath, userGoal)
  -> Commander planning context / SharedTaskContext
```

## Non-Goals

- Do not fine-tune or train a model.
- Do not let Javis modify its own system prompts, source code, safety rules, or
  tool descriptors based on learned records.
- Do not build a broad knowledge graph in the first version.
- Do not import AutoSci's research-specific wiki schema.
- Do not create a second persistence mechanism outside the existing SQLite and
  task audit direction.
- Do not use learning to automate writes, approvals, shell commands, or browser
  interactions.

## What Javis May Learn

Javis may persist compact, evidence-backed lessons about local work:

- A workflow succeeded or failed for a goal pattern in a workspace.
- A tool failed with a concrete exit code, verifier verdict, or structured error.
- A smaller verification command was more reliable than a broader one.
- A known workspace setup detail matters for future planning, such as package
  manager, common check command, or missing environment dependency.
- The user repeatedly chose a particular safe workflow path.
- A verifier identified a recurring missing-evidence pattern.
- A previous failed plan has a concrete reason that should be avoided next time.

Examples:

- "In this workspace, `pnpm typecheck` succeeded after `pnpm check` failed
  because Rust dependencies were unavailable."
- "PDF organization approvals were denied twice when the plan touched files
  outside Downloads."
- "For code proposals, the verifier requires `git diff --check` evidence before
  marking the task complete."

## What Javis Must Not Learn

Javis must not persist or promote lessons that would weaken safety or encode
unverified assumptions:

- No learned record may grant permission for future writes.
- No learned record may reduce `confirmed_write` to `preview` or `read`.
- No learned record may mark a dangerous command as safe.
- No learned record may expand workspace, Downloads, or filesystem scope.
- No learned record may store API keys, tokens, secrets, full private logs, or
  large file contents.
- No learned record may override a current explicit user instruction.
- No learned record may replace current tool output or verifier evidence.
- No learned record may become a permanent rule after a single observation.

## Memory Record Shape

The first SQLite-backed record should be intentionally small and auditable:

```ts
type AgentMemoryEvent = {
  id: string;
  workspaceId: string;
  workspacePathDisplay?: string;
  taskId: string;
  workflowId?: string;
  agentKind?: string;
  toolName?: string;
  goalPattern: string;
  outcome: "succeeded" | "failed" | "cancelled" | "denied" | "verified" | "unverified";
  evidenceKind: "task_snapshot" | "tool_result" | "verifier_result" | "user_decision";
  evidenceRef: string;
  summary: string;
  failureReason?: string;
  suggestedAdjustment?: string;
  confidence: number; // 0.0 to 1.0
  status: "observed" | "suggested" | "reinforced" | "deprecated" | "ignored";
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
};
```

Notes:

- `evidenceRef` should point to an existing task, tool, verifier, or audit record.
- `summary` must be short and sanitized.
- `failureReason` must be specific. Avoid vague values such as "failed" or "bad".
- `confidence` starts low and changes only after later evidence.
- `status` controls whether the record is injected into planning context.
- `workspaceId` should be the stable lookup key. `workspacePathDisplay` is
  optional UI context and must be treated as potentially sensitive because local
  paths can contain usernames, customer names, or private project names.
- If the evidence referenced by `evidenceRef` is deleted or unavailable, the
  memory record must be deleted, deprecated, or reduced to a minimal
  non-sensitive evidence digest. A memory record without accessible evidence
  must not be promoted or injected as a strong planning hint.

## Lifecycle

Memory records should move through a conservative lifecycle:

```text
observed -> suggested -> reinforced
        -> deprecated
        -> ignored
```

- `observed`: one evidence-backed event. It can appear as a weak hint.
- `suggested`: repeated compatible evidence. It can influence plan ranking.
- `reinforced`: multiple successful confirmations or verifier-supported repeats.
  It can be included in the default memory brief.
- `deprecated`: current evidence contradicts the record. It should not influence
  planning except as historical context.
- `ignored`: user rejected or deleted the lesson. It must not be injected into
  planning context by default.

Single observations must not become strong rules. A failed task can create an
`observed` record, but promotion requires repeated evidence or explicit user
confirmation.

## Confidence Rules

Confidence is advisory and must stay bounded:

- Start new records at low confidence, for example `0.25`.
- Increase confidence only when the same goal pattern, workflow, or tool outcome
  repeats with compatible evidence.
- Decrease confidence when current verifier results contradict the lesson.
- Decay confidence over time when records are unused.
- Prefer current task evidence over historical confidence.

Suggested thresholds:

- `0.00-0.39`: weak hint, do not inject unless directly relevant.
- `0.40-0.69`: planning hint, include with caution language.
- `0.70-0.89`: strong planning hint, include in memory brief.
- `0.90+`: still not a permission rule. Treat only as strong context.

## Expiry And Decay

Lessons should not last forever by default.

- Workspace setup lessons may expire after 90 days unless reinforced.
- Tool failure lessons may expire after 30 to 60 days.
- User preference lessons may last longer, but must remain user-visible and
  deletable.
- Deprecated lessons should be hidden from normal planning after a short grace
  period.

Expired lessons may remain in audit storage, but should not be injected into
Commander planning context.

## Memory Brief

Before Commander planning, Javis may compile a bounded memory brief for the
current workspace and user goal.

The brief should contain:

- Relevant reinforced or suggested lessons.
- Recent failures with specific reasons.
- Current confidence and age.
- Explicit caveats when evidence is weak.

The brief must not contain:

- Secrets or raw file contents.
- Full task logs.
- Full diffs.
- Pending approval payloads.
- Any instruction to bypass confirmation.

Example:

```text
Workspace memory:
- Strong hint: previous project inspection found pnpm as the package manager.
- Weak hint: one prior `pnpm check` run failed because Rust dependencies were
  unavailable; prefer `pnpm typecheck` first unless the user asks for full check.
- Verification caveat: narrower checks may localize a failure, but they do not
  replace the documented full validation command unless the task records an
  explicit waiver or unresolved verification note.
- Safety reminder: no learned record may skip confirmed-write approval.
```

## Planner Integration

Learning should enter the runtime through planning only:

1. Load relevant memory records for `workspacePath` and `userGoal`.
2. Compile a short memory brief.
3. Put the brief in `SharedTaskContext`, for example `memoryBrief`.
4. Include the brief in Commander planning prompts.
5. Record whether Commander used or ignored the lesson.

The executor must still validate the generated workflow against existing tool,
permission, and DAG constraints. Memory does not relax validation.

## Verifier Integration

Verifier output is the main mechanism for correcting bad lessons.

- If a learned lesson predicts success but verifier fails the result, lower the
  lesson confidence.
- If a learned failure no longer reproduces, deprecate or lower confidence.
- If verifier confirms a repeated adjustment was useful, reinforce it.
- If verifier cannot find evidence, create at most a weak `observed` record.

Current verifier evidence always outranks historical memory.

## User Control

Users must be able to inspect and manage learned records.

Minimum product requirements:

- Show why Javis suggested a path when memory influenced planning.
- Let the user delete a lesson.
- Let the user disable memory for a workspace.
- Let the user mark a lesson as wrong, which changes status to `ignored`.
- Keep memory opt-out separate from task history deletion.

Good UI label: "Workspace Lessons".

Deletion and correction have different meanings:

- Delete means the lesson is removed from the user-visible memory set and must
  not be used for future planning. If an audit-retention copy is required, it
  must be inaccessible to memory retrieval and clearly marked as non-injectable.
- Mark wrong means the record may remain for audit and debugging, but its status
  becomes `ignored` and it must not be injected into planning by default.
- If a user deletes task history or audit evidence that a lesson depends on,
  Javis must also delete, deprecate, or evidence-digest that lesson so it cannot
  continue pretending to be fully auditable.

## Safety Red Lines

These rules are absolute:

- Memory must never lower a permission level.
- Memory must never execute tools directly.
- Memory must never auto-approve a write.
- Memory must never widen path or workspace scope.
- Memory must never override the user's latest explicit instruction.
- Memory must never replace current verifier evidence.
- Memory must never replace the documented final verification path with a
  narrower check. Narrower checks may be used only as triage unless the final
  result explicitly records the missing full verification.
- Memory must never store secrets or raw sensitive content.
- Memory must never turn one failed attempt into a permanent rule.

If any implementation path conflicts with these rules, keep the existing Javis
safety model and drop the learned recommendation.

## Suggested First Milestone

Implement only the smallest loop:

1. Add `agent_memory_events` SQLite schema and tests.
2. Add `summarizeMemoryEvent(snapshot, verifierResult?)`.
3. Add `compileMemoryBrief(workspacePath, userGoal)`.
4. Add a `memoryBrief` context key.
5. Inject the brief into Commander planning.
6. Add tests proving memory cannot affect permission levels.

Success criteria:

- A failed workflow creates a low-confidence, evidence-backed lesson.
- A later similar task receives a memory brief.
- Commander can mention the lesson in its plan rationale.
- The workflow executor still enforces the same permission and DAG validation.
- A contradictory verifier result lowers or deprecates the old lesson.
- User deletion or ignore prevents future injection.
