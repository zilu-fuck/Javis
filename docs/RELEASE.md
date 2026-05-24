# Release Guide

This guide describes how to prepare desktop builds. It assumes Windows as the
primary target for the current project. The current release target is a complete
usable product as defined in `docs/PRODUCT_READINESS.md`; MVP builds are only
baseline verification artifacts.

## Release Readiness

Before creating a release build:

- Confirm `docs/PRODUCT_READINESS.md` reflects the current target and blockers.
- Confirm `docs/MVP_STATUS.md` reflects the implementation.
- Confirm `docs/ROADMAP.md` lists any known deferrals.
- Run `pnpm check`.
- Complete `docs/QA_CHECKLIST.md`.
- Save screenshots under `docs/qa/<date>/`.
- Review `docs/SECURITY_MODEL.md` and `docs/PERMISSIONS.md` if permission code
  changed.

## Build Commands

Install dependencies:

```sh
pnpm install
```

Run full verification:

```sh
pnpm check
```

Verify the bundled opencode native binaries are present:

```sh
node_modules/.pnpm/opencode-windows-x64@1.15.10/node_modules/opencode-windows-x64/bin/opencode.exe --version
node_modules/.pnpm/opencode-windows-x64-baseline@1.15.10/node_modules/opencode-windows-x64-baseline/bin/opencode.exe --version
```

Build the desktop frontend:

```sh
pnpm --filter @javis/desktop build
```

Build the Tauri app:

```sh
pnpm --filter @javis/desktop tauri build
```

## Manual QA Evidence

Create a dated folder:

```text
docs/qa/YYYY-MM-DD/
```

Include:

- `notes.md` with OS, branch, commit, commands run, and pass/fail notes.
- Screenshots required by `QA_CHECKLIST.md`.
- Any failure screenshots with a short reproduction note.
- Rollback notes that identify the previous usable build and the downgrade
  path for users.

## Version And Rollback Notes

Each product release candidate needs a short rollback record before it can be
called release-ready. Store it in the dated QA folder or in the final release
notes.

Required fields:

- Build version and commit.
- Previous known-good version and artifact path or URL.
- Whether local storage keys changed.
- Whether native permission state, file locations, or user data formats
  changed.
- Rollback steps for uninstalling the candidate and reinstalling the previous
  build.
- Known data that cannot be downgraded automatically.

If the build changes storage schemas, permission records, workspace history, or
task history, run restart QA before and after rollback. Do not publish the build
until the notes say whether old local data is preserved, ignored, migrated, or
requires manual cleanup.

## Release Notes Template

```md
# Javis Product Build YYYY-MM-DD

## Verification

- pnpm check: pass/fail
- Manual QA: pass/fail
- Platform: Windows version

## Included

- Desktop workbench
- Markdown scan
- Project inspection
- URL research
- PDF organization approval flow
- Automated research search
- Code Agent with approved edits
- Persistent task history
- Workspace selection

## Known Gaps

- List only non-blocking limitations. Product blockers from
  `PRODUCT_READINESS.md` must be fixed before release.

## Safety Notes

- Only the PDF organization flow writes files.
- Confirmed writes require approval for the current dry-run.
- The Windows build bundles opencode native binaries for proposal generation,
  but patch application still runs through Javis confirmed-write approval.

## Rollback

- Previous known-good build:
- Local data compatibility:
- Rollback steps:
- Non-downgradable data:
```

## Blocking Conditions

Do not publish a release build when:

- `pnpm check` fails.
- A `PRODUCT_READINESS.md` product release blocker is still true.
- A confirmed-write path can execute without visible approval.
- PDF organization can move non-PDF files or escape Downloads.
- The UI cannot show a pending permission request.
- Manual QA has an untriaged failure in a primary product scenario.
- The release build is unsigned or lacks version and rollback notes.
