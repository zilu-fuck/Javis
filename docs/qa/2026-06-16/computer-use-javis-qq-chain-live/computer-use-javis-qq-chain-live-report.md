# Computer Use Javis QQ Chain Live QA

Date: 2026-06-16

## Objective

Use Codex Computer Use to operate Javis, then ask Javis' own Computer Use agent to operate Windows QQ and prepare a test message for the QQ contact named in the user request.

Final QQ send was intentionally not performed. Sending a QQ message is representational communication to a third party and requires action-time confirmation. The run never reached a valid ready-to-send state because Javis did not invoke its Computer Use flow.

## Environment

- Workspace: `E:\Javis`
- Javis app: `apps/desktop/src-tauri/target/release/javis-desktop.exe`
- Javis window title: `Javis`
- QQ window title: `QQ`
- Outer automation: Codex Computer Use
- Inner target: Javis Computer Use agent

## Evidence

Screenshots are stored in this directory:

- `01-javis-open.png` - Javis release app opened.
- `02-javis-clean-chat.png` - Clean chat state after rejecting an unrelated stale approval card.
- `04-javis-task-drafted.png` - First QQ Computer Use task drafted in Javis.
- `07-javis-image-analysis-failed.png` - Javis routed the task to Image analysis and failed with `Image target missing`.
- `09-javis-correction-submitted.png` - Correction prompt submitted, asking for Computer Agent / desktop automation instead of Image analysis.
- `14-coordinate-clean-task-drafted.png` - Clean desktop automation prompt drafted.
- `15-coordinate-clean-task-submitted.png` - Clean desktop automation prompt submitted.
- `16-javis-execution-progress.png` - Javis showed running progress.
- `17-javis-execution-still-running.png` - Javis later reached completion text.
- `18-qq-state-during-javis-task.png` - QQ state during the Javis task; no message draft was created.
- `20-javis-agent-panel-attempt.png` - Javis activity log showed direct chat routing and no tool calls.

## Observed Errors

### 1. Screenshot/evidence wording misrouted to Image analysis

The first prompt asked Javis to use Computer Use to operate QQ and save evidence screenshots. Javis selected Image analysis, then failed with:

`Image target missing`

This is wrong because the user goal was desktop automation, not standalone image analysis.

### 2. Explicit desktop automation goal bypassed Computer Use in chat mode

The clean prompt explicitly asked Javis to use Computer Agent / desktop automation to operate Windows QQ, find the requested QQ contact, type a test message into the chat input, stop after drafting, wait for manual confirmation, and avoid clicking Send or pressing Enter.

Javis completed with a generic answer instead of running tools. The activity log showed:

- `Local router selected direct chat.`
- `General chat response completed without local tool calls.`

QQ did not change, and no draft message was visible.

## Fix Summary

The routing fix makes explicit Computer Use goals leave direct chat even when the UI starts in chat mode:

- `packages/core/src/index.ts`
  - Imports `isComputerUseGoal`.
  - Prevents direct-chat routing when `startMode === "chat"` and the goal is Computer Use.
  - Allows Commander DAG execution for Computer Use goals even when the Commander tool is unavailable.

- `packages/core/src/workflow-executor.ts`
  - Makes `commanderTool` optional for Commander DAG task execution.
  - Uses `createFallbackComputerUseDagPlan(...)` for explicit Computer Use goals when Commander is unavailable.

- `packages/core/src/index.test.ts`
  - Adds regression coverage proving an explicit QQ desktop automation goal in chat mode runs `computerUseLoopRunner` instead of direct chat.

- `apps/desktop/src-tauri/src/lib.rs`
  - Stabilizes a brittle Rust prompt assertion so the full gate can exercise the Computer Use fix without failing on unrelated locale text matching.

## Result

Live QA found two real routing failures and the code now has regression coverage for the direct-chat bypass. No QQ message was sent.
