# Computer Use Javis Chain Blocked

- Date: 2026-06-16T18:42:44+08:00
- Result: BLOCKED
- Chain: Codex Computer Use -> Javis Computer Use -> QQ send
- Target contact: 凤雏-大聪明
- Intended message: 	est message
- Sent: NO

## Artifacts

- Screenshot: desktop-state-after-bootstrap-failure.png
- JSON report: computer-use-javis-chain-blocked-report.json

## Process

1. Attempted to initialize the required Windows Computer Use runtime.
2. Runtime initialization failed before list_apps.
3. Because Codex could not control Javis, Javis could not be driven to run its own Computer Use workflow against QQ.
4. No QQ draft was typed and no message was sent.

## Error

BLOCKER: $cuErrorMessage

## Screenshot Note

The screenshot is a desktop-state failure artifact, not a Computer Use plugin screenshot.
