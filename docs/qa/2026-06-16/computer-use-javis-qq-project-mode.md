# Computer Use Live QA Log

Date: 2026-06-16

## Goal
- In project mode, use Javis Computer Use to操控 QQ, find contact `凤雏-大聪明`, type `你好`, and stop before the final send.

## Fixes made
- Scoped Commander planning inputs for Computer Use goals so the model only sees desktop-relevant agents/tools.
- Added a compact Computer Use Commander prompt to avoid the long generic planning prompt.
- Kept the routing change so Computer Use tasks still go through Commander instead of Vision.

## Verification
- `corepack pnpm --filter @javis/core exec vitest run src/commander-plan-schema.test.ts src/workflow-executor.test.ts src/index.test.ts`
- `corepack pnpm --filter @javis/desktop exec vitest run src/app-runtime.test.ts src/submission-routing.test.ts`
- `corepack pnpm typecheck`

## Screenshots
- [10-live-before-retry-commander-timeout.png](./2026-06-16/computer-use-javis-qq-project-mode/10-live-before-retry-commander-timeout.png)
- [11-after-fix-project-input-ready.png](./2026-06-16/computer-use-javis-qq-project-mode/11-after-fix-project-input-ready.png)
- [12-set-value-uia-error-state.png](./2026-06-16/computer-use-javis-qq-project-mode/12-set-value-uia-error-state.png)
- [13-task-typed-after-planning-scope-fix.png](./2026-06-16/computer-use-javis-qq-project-mode/13-task-typed-after-planning-scope-fix.png)
- [14-after-submit-empty-uia.png](./2026-06-16/computer-use-javis-qq-project-mode/14-after-submit-empty-uia.png)
- [15-after-planning-scope-fix-still-timeout.png](./2026-06-16/computer-use-javis-qq-project-mode/15-after-planning-scope-fix-still-timeout.png)
- [16-pre-retry-current-screen.png](./2026-06-16/computer-use-javis-qq-project-mode/16-pre-retry-current-screen.png)

## Live blockers
1. `set_value` on the task input failed once with:
   - `read UIA value read-only state: 所需属性不在 CacheRequest 中 (0x80070057)`
   - I switched to click + type for the same input path.
2. Commander planning still timed out once with:
   - `commander.plan timed out after 90000ms.`
3. After a frontend reload, `get_window_state` failed with:
   - `foreground window did not report a process id`

## Current status
- The code fix is in and tests pass.
- Live QQ send was not completed yet because the last Computer Use snapshot failed after reload.
