# LocalStorage Migration Source QA

Date: 2026-06-10

Scope: source-level verification that legacy localStorage consumers with durable
product data have SQLite repositories, startup import paths, fallback behavior,
and migration tests.

Command:

```powershell
node_modules\.bin\vitest.CMD run apps/desktop/src/approval-records-persistence.test.ts apps/desktop/src/recent-workspaces.test.ts apps/desktop/src/workspace-session.test.ts apps/desktop/src/task-history.test.ts apps/desktop/src/scheduled-tasks-persistence.test.ts apps/desktop/src/user-preferences-persistence.test.ts apps/desktop/src/user-profile-memory.test.ts apps/desktop/src/goal-persistence.test.ts apps/desktop/src/jsonl-log-persistence.test.ts apps/desktop/src/desktop-database.test.ts
```

Result:

```text
Test Files  10 passed (10)
Tests       166 passed (166)
```

Verified migrated stores:

- Task history
- Approval records
- Recent workspaces / workspace session
- Scheduled tasks
- User preferences
- User profile memory
- Current goal
- Task-session JSONL log
- Tool-call audit JSONL log
- Shared desktop database migration runner

Remaining localStorage use is expected only for fallback/bootstrap paths or
settings that still intentionally load before SQLite is ready. Packaged-app
restart evidence is still tracked by the product workflow gates for each
workflow, especially Git remote/PR write restore evidence.
