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
- Complete `docs/QA_CHECKLIST.md` and the product workflow matrix in
  `docs/qa/PRODUCT_WORKFLOWS.md`.
- Run the strict product workflow evidence gate:
  `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/qa/check-product-workflow-evidence.ps1 -QaRoot docs/qa/YYYY-MM-DD`.
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

Build an unsigned local Tauri bundle for QA only:

```sh
pnpm --filter @javis/desktop tauri build
```

Unsigned bundles are not release-ready. A publishable Windows build must use the
signed build flow below.

## Versioning

Windows release versions must use numeric `major.minor.patch` values such as
`0.1.0`. Do not use prerelease or build metadata for MSI/NSIS releases; MSI
product versions cannot represent those values consistently.

Before tagging or signing a build, keep these files aligned:

- `package.json`
- `apps/desktop/package.json`
- `apps/desktop/src-tauri/tauri.conf.json`
- `apps/desktop/src-tauri/Cargo.toml`
- `apps/desktop/src-tauri/Cargo.lock`

Verify the version:

```powershell
.\scripts\release\check-release-version.ps1 -ExpectedVersion 0.1.0
```

The root package also exposes the same check:

```powershell
pnpm release:check-version -- -ExpectedVersion 0.1.0
```

If a version bump changes `Cargo.toml`, run the normal Rust/build checks and
commit the matching `Cargo.lock` update with the version bump.

## Signed Windows MSI/NSIS Build

Release-ready Windows builds must produce both MSI and NSIS installers and sign
them with an Authenticode code-signing certificate. The Tauri config pins the
Windows targets to `msi` and `nsis`, fixes the MSI upgrade code, and blocks
direct downgrade installs; rollback is handled by uninstalling the candidate
first, then reinstalling the previous known-good build.

Prerequisites:

- A code-signing certificate installed in `Cert:\CurrentUser\My` or
  `Cert:\LocalMachine\My`.
- The certificate SHA1 thumbprint stored outside the repo.
- A timestamp server. The default release script value is
  `http://timestamp.digicert.com`; set `JAVIS_WINDOWS_TIMESTAMP_URL` to use a
  different server. Set `JAVIS_WINDOWS_TIMESTAMP_TSP=1` only when the timestamp
  provider requires RFC 3161/TSP.

Find the certificate thumbprint:

```powershell
Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
  Select-Object Subject, Thumbprint, NotAfter
```

Build and sign:

```powershell
$env:JAVIS_WINDOWS_CERT_THUMBPRINT = "<certificate SHA1 thumbprint>"
.\scripts\release\build-windows-signed.ps1 -Version 0.1.0
```

The script performs these checks before reporting success:

- version alignment across package, Tauri, Cargo, and lock files
- `pnpm check`
- Tauri MSI and NSIS build with SHA-256 signing settings
- Authenticode signature verification on both installer artifacts
- SHA-256 hash output for release notes

Expected artifact locations:

```text
apps/desktop/src-tauri/target/release/bundle/msi/Javis_<version>_x64_en-US.msi
apps/desktop/src-tauri/target/release/bundle/nsis/Javis_<version>_x64-setup.exe
```

Manual signature and checksum verification:

```powershell
Get-AuthenticodeSignature .\apps\desktop\src-tauri\target\release\bundle\msi\Javis_0.1.0_x64_en-US.msi
Get-AuthenticodeSignature .\apps\desktop\src-tauri\target\release\bundle\nsis\Javis_0.1.0_x64-setup.exe
Get-FileHash -Algorithm SHA256 .\apps\desktop\src-tauri\target\release\bundle\msi\Javis_0.1.0_x64_en-US.msi
Get-FileHash -Algorithm SHA256 .\apps\desktop\src-tauri\target\release\bundle\nsis\Javis_0.1.0_x64-setup.exe
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
- MSI and NSIS artifact paths, Authenticode status, and SHA-256 hashes.

If the build changes storage schemas, permission records, workspace history, or
task history, run restart QA before and after rollback. Do not publish the build
until the notes say whether old local data is preserved, ignored, migrated, or
requires manual cleanup.

Rollback procedure for Windows installers:

1. Confirm the previous known-good MSI or NSIS artifact is signed and its
   checksum matches the release notes.
2. Close Javis and make sure no background process is still running.
3. If storage schemas, permission records, task history, workspace history, or
   model settings changed, back up the user's Javis app data before uninstalling.
4. Uninstall the candidate from Windows Settings > Apps, or use the installed
   uninstaller. Directly installing an older build over a newer build is blocked
   by `allowDowngrades=false`.
5. Install the previous known-good signed artifact.
6. Launch Javis, verify the version, run restart QA for task history/workspace
   recovery, and record whether existing local data was preserved, ignored,
   migrated, or manually cleaned up.

Do not delete user data during rollback unless the rollback notes explicitly say
the newer build wrote data that the previous build cannot read safely.

## Release Notes Template

```md
# Javis Product Build YYYY-MM-DD

## Verification

- pnpm check: pass/fail
- Version alignment: pass/fail
- MSI signature: pass/fail
- NSIS signature: pass/fail
- MSI SHA-256:
- NSIS SHA-256:
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

- Write-capable flows are intentionally narrow: PDF organization moves approved
  PDFs inside Downloads, and Code Agent applies approved patches inside the
  selected workspace.
- Confirmed writes require visible approval for the current dry-run/proposal.
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
