# Computer Use Release QA

Date: 2026-06-09 21:12:32 +08:00

Executable: `E:\Javis\apps\desktop\src-tauri\target\release\javis-desktop.exe`

Evidence:

- App screenshot: `01-computer-use-release-app.png`
- JSON output: `computer-use-release-qa-output.json`

Checks:

- [PASS] release-app-start: release executable launched and DevTools target attached
- [PASS] release-app-screenshot: captured app evidence image
- [PASS] computer-screenshot-read: desktop screenshot returned 1920x1080 via bitblt
- [PASS] computer-screenshot-health: screenshot health reason:
- [PASS] computer-list-windows: listed 16 windows; foregroundPresent=True
- [PASS] computer-approval-lease: created and cancelled a scoped Computer Use task approval lease
- [PASS] computer-sensitive-approval: session-wide approval for computer.type was rejected
- [PASS] computer-dangerous-key-combo: approval preflight rejected computer.keyCombo Win+R without executing it
- [PASS] computer-emergency-hotkey-command: global Escape hotkey command enabled and disabled
- [PASS] local-vision-missing-model-fail-open: missing model returned structured empty result: timedOut=True, error='local vision worker timed out after 50ms'
- [PASS] local-vision-real-model: runtime=onnxruntime, detections=1, latency=291ms, wall=1085ms, error=''

Result: PASS
