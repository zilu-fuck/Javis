# QA Notes

Date: 2026-05-24

Operating system: Microsoft Windows NT 10.0.26200.0

Scope:

- Workspace native directory picker readiness.
- Recent workspace persistence after a real packaged desktop app restart.

Commands:

```sh
pnpm --filter @javis/desktop test
pnpm --filter @javis/ui test
pnpm --filter @javis/desktop build
pnpm --filter @javis/desktop tauri build
powershell -ExecutionPolicy Bypass -File docs/qa/2026-05-24/workspace-restart-qa.ps1
```

Command output:

- `workspace-restart-qa-output.txt`

Command status:

- `pnpm --filter @javis/desktop test`: pass
- `pnpm --filter @javis/ui test`: pass
- `pnpm --filter @javis/desktop build`: pass
- `pnpm --filter @javis/desktop tauri build`: pass
- `workspace-restart-qa.ps1`: pass

Evidence:

- `01-workspace-recent-before-restart.png`: packaged desktop app after a completed
  workspace-aware project inspection, with `E:\Javis` visible in recent
  workspaces.
- `02-workspace-recent-after-restart.png`: packaged desktop app after closing and
  relaunching, with `E:\Javis` restored as the active workspace and visible in
  recent workspaces.
- `workspace-restart-qa-output.txt`: confirms `javis.recentWorkspaces.v1`
  contained `["E:\\Javis"]` before and after restart.

Manual QA verdict: pass for workspace selection and recent-workspace restart
persistence.

Notes:

- `workspace-restart-qa.ps1` launches the packaged release executable with
  WebView2 remote debugging enabled, drives the real desktop UI, closes the
  process, relaunches it, and captures native-window screenshots.
- The native directory picker is implemented through the Tauri dialog plugin.
  This pass verifies the released app includes the workspace controls and
  restart persistence evidence. The script does not automate the OS folder
  picker dialog itself because that native modal is intentionally outside the
  WebView DOM.
