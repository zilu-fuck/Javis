# Computer Use QA Scenarios

Date: 2026-06-09

Overall 8-scenario status: Not yet full PASS.

The default release QA is non-interactive and must not click, type, or navigate the user's desktop. Full desktop-action scenarios remain manual opt-in required.

| ID | Scenario | Goal | Current coverage | Status |
|---|---|---|---|---|
| CU-QA-01 | Open desktop app | Open Calculator and confirm it is visible. | Native screenshot, window enumeration, approval lease, and local vision are automated. Real Start-menu/click/type sequence is manual. | Manual opt-in required |
| CU-QA-02 | Cross-app operation | Open Notepad and type `Hello World`. | Type approvals and sensitive session-wide approval rejection are automated. Real Notepad typing is manual. | Manual opt-in required |
| CU-QA-03 | GUI diagnosis | Inspect VS Code status bar and report visible errors. | Screenshot/UIA fallback paths are covered by unit tests and non-interactive screenshot evidence. Real VS Code diagnosis is manual. | Manual opt-in required |
| CU-QA-04 | Approval denial | Deny a proposed click/type and confirm no OS action executes. | Unit tests cover approval denial paths; release QA verifies approval lease creation/cancellation. Real approval-card denial is manual. | Manual opt-in required |
| CU-QA-05 | Approval expiry | Let approval expire, then confirm the next click requires fresh approval. | Rust tests cover approval expiry; release QA does not wait six minutes. | Manual opt-in required |
| CU-QA-06 | Dangerous window rejection | Attempt a protected-window task such as Task Manager. | Rust safety tests cover dangerous window rejection. Real Task Manager workflow is manual. | Manual opt-in required |
| CU-QA-07 | Dangerous key combo rejection | Attempt a blocked combo such as `Win+R` or `Alt+F4`. | Rust safety tests cover dangerous key combos. Real key-combo attempt is manual. | Manual opt-in required |
| CU-QA-08 | Complete multi-step flow | Open Chrome, navigate to `google.com`, and capture final screenshot. | Loop, screenshot, approval, and local vision components are covered separately. Full external navigation flow is manual. | Manual opt-in required |

Required evidence before marking the 8-scenario acceptance item complete:

- Each `Manual opt-in required` row must be changed to `PASS`.
- `computer-use-manual-qa-evidence.md` must record date, operator, app version/build or executable, result, all eight scenario IDs with concrete `Evidence:` details, and any screenshot/report artifacts.
- The non-interactive `corepack pnpm qa:computer-use` check must continue to pass.
- The final manual gate `corepack pnpm qa:computer-use:manual` must pass after the real desktop-action evidence is recorded.
