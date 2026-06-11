# LocalStorage Consumer Migration Audit Source QA

Date: 2026-06-11

## Scope

This source-level QA audits localStorage consumers after the SQLite migration
work. It does not replace packaged restart QA.

## Verified Migration Consumers

The following legacy localStorage stores have import paths that remove the
legacy key after successful or malformed import handling:

- task history: `apps/desktop/src/task-history.ts`
- approval records: `apps/desktop/src/approval-records-persistence.ts`
- recent workspaces/workspace session: `apps/desktop/src/recent-workspaces.ts`
  and `apps/desktop/src/workspace-session.ts`
- model settings: `apps/desktop/src/model-settings-persistence.ts`
- scheduled tasks: `apps/desktop/src/scheduled-tasks-persistence.ts`
- user preferences: `apps/desktop/src/user-preferences-persistence.ts`
- user profile memory: `apps/desktop/src/user-profile-memory.ts`
- current goal: `apps/desktop/src/goal-persistence.ts`
- task/session JSONL and tool-call audit JSONL:
  `apps/desktop/src/jsonl-log-persistence.ts`

## Intentional LocalStorage Consumers

These consumers remain localStorage-backed by design and are not migration
misses:

- `javis.pendingUserPreferences.v1`: temporary pending preferences used before
  the SQLite-backed preferences repository is ready.
- `javis.computerUse.localVision.v1`: user-editable Computer Use/local vision
  settings, loaded and saved through `apps/desktop/src/app-runtime.ts`.
- `javis.mcpToolDescriptors.v1`: MCP tool descriptor cache.
- localStorage fallback paths in persistence modules when the SQLite repository
  is unavailable.

## Evidence

Searches used:

```powershell
rg -n "localStorage|sessionStorage|Storage\b|setItem\(|getItem\(|removeItem\(" apps\desktop\src packages\ui\src packages\core\src -S
rg -n "javis\.|STORAGE_KEY|StorageKey|LOCAL_STORAGE|storage key|localStorage" apps\desktop\src packages\ui\src packages\core\src -S
```

Existing tests cover import/remove and fallback behavior across the migrated
stores, including task history, approvals, workspaces, model settings,
scheduled tasks, preferences, profile memory, current goal, and JSONL logs.

## Remaining Risk

This closes the source-level audit gap only. Product readiness still needs a
packaged restart run proving the migrated stores survive app restart and that
the intentional localStorage consumers remain bounded to settings/cache/pending
preference use.
