# Build, Sign, and Release Runbook

This runbook is the step-by-step operational guide for producing a signed Javis
release. For reference documentation see [Release Guide](RELEASE.md); for the
current product target see [Product Readiness](PRODUCT_READINESS.md).

## Prerequisites

| Requirement | Check |
| --- | --- |
| Node.js + pnpm | `pnpm --version` |
| Rust toolchain | `rustc --version` |
| Tauri CLI | `pnpm --filter @javis/desktop tauri --version` |
| Code-signing certificate | `Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert` |
| opencode native binaries | See RELEASE.md for verification paths |

## Step 1: Pre-Flight

```powershell
# Full verification
pnpm check

# Version alignment (all 5 files must match)
.\scripts\release\check-release-version.ps1 -ExpectedVersion 0.1.0
# or: pnpm release:check-version -- -ExpectedVersion 0.1.0

# Product readiness gate (strict)
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts/qa/check-product-workflow-evidence.ps1 `
  -QaRoot docs/qa/YYYY-MM-DD

# During development, inventory coverage without blocking on known issues:
# powershell -NoProfile -ExecutionPolicy Bypass `
#   -File scripts/qa/check-product-workflow-evidence.ps1 -AllowKnownBlockers
```

If any check fails, fix before proceeding. Do not sign a failing build.

## Step 2: Version Bump

When bumping the version, update all five files to the same `major.minor.patch`:

| File | Field |
| --- | --- |
| `package.json` | `version` |
| `apps/desktop/package.json` | `version` |
| `apps/desktop/src-tauri/tauri.conf.json` | `version` |
| `apps/desktop/src-tauri/Cargo.toml` | `[package] version` |
| `apps/desktop/src-tauri/Cargo.lock` | `javis-desktop` package version |

After editing `Cargo.toml`, run `cargo check` to sync `Cargo.lock`:

```powershell
cd apps/desktop/src-tauri
cargo check
cd ../../..
```

`cargo check` updates dependencies and writes the matching version into
`Cargo.lock`. Verify alignment:

```powershell
.\scripts\release\check-release-version.ps1 -ExpectedVersion X.Y.Z
```

Windows MSI requires numeric `major.minor.patch` only. Major/minor <= 255,
patch <= 65535. No prerelease or build metadata.

## Step 3: Build and Sign

```powershell
# Set the certificate thumbprint
$env:JAVIS_WINDOWS_CERT_THUMBPRINT = "<SHA1 thumbprint>"

# Optional: custom timestamp server
$env:JAVIS_WINDOWS_TIMESTAMP_URL = "http://timestamp.digicert.com"

# Optional: set only if the timestamp provider requires RFC 3161/TSP
# $env:JAVIS_WINDOWS_TIMESTAMP_TSP = "1"

# Build, sign, and verify
.\scripts\release\build-windows-signed.ps1 -Version X.Y.Z
# or: pnpm release:windows:signed -- -Version X.Y.Z
```

The script will:
1. Verify version alignment across all 5 files
2. Run `pnpm check` (skip with `-SkipChecks` for debugging only:
   `.\scripts\release\build-windows-signed.ps1 -Version X.Y.Z -SkipChecks`)
3. Build MSI and NSIS installers with Authenticode signing
4. Verify signatures match the certificate thumbprint
5. Output SHA-256 hashes for release notes
6. Write `release-build-summary.json` under the QA folder

Expected artifacts:

```
apps/desktop/src-tauri/target/release/bundle/msi/Javis_X.Y.Z_x64_en-US.msi
apps/desktop/src-tauri/target/release/bundle/nsis/Javis_X.Y.Z_x64-setup.exe
```

## Step 4: Verify Artifacts

The build script already verifies signatures, prints hashes, and writes
`release-build-summary.json`. This step is a manual double-check for extra
confidence.

```powershell
# Signature verification
Get-AuthenticodeSignature .\apps\desktop\src-tauri\target\release\bundle\msi\Javis_X.Y.Z_x64_en-US.msi
Get-AuthenticodeSignature .\apps\desktop\src-tauri\target\release\bundle\nsis\Javis_X.Y.Z_x64-setup.exe

# Checksum verification
Get-FileHash -Algorithm SHA256 .\apps\desktop\src-tauri\target\release\bundle\msi\Javis_X.Y.Z_x64_en-US.msi
Get-FileHash -Algorithm SHA256 .\apps\desktop\src-tauri\target\release\bundle\nsis\Javis_X.Y.Z_x64-setup.exe
```

Both signatures must show `Status: Valid` and the signer certificate thumbprint
must match `$env:JAVIS_WINDOWS_CERT_THUMBPRINT`.

## Step 5: QA Evidence

Create a dated evidence folder and run the QA scripts:

```powershell
$qaDir = "docs/qa/$(Get-Date -Format 'yyyy-MM-dd')"
New-Item -ItemType Directory -Path $qaDir -Force | Out-Null
```

Required evidence:

| Evidence | Script or manual |
| --- | --- |
| `pnpm check` output | Capture terminal output |
| Version alignment | `check-release-version.ps1` output |
| MSI signature | Step 4 output |
| NSIS signature | Step 4 output |
| MSI SHA-256 | Step 4 output |
| NSIS SHA-256 | Step 4 output |
| Product workflow matrix | `scripts/qa/check-product-workflow-evidence.ps1` |
| Screenshots | Manual, per `QA_CHECKLIST.md` |
| Rollback notes | Manual, see template below |

Save all evidence under `$qaDir`. Write a `notes.md` with:

- Date, OS version, branch, commit hash
- All commands run and their pass/fail status
- Screenshot filenames
- Any failures and triage decisions

## Step 6: Rollback Notes

Before declaring the build release-ready, write rollback notes. Required fields:

```markdown
## Rollback Record — Javis X.Y.Z (YYYY-MM-DD)

- **Build version**: X.Y.Z
- **Commit**: <full hash>
- **Previous known-good version**: X.Y.Z (or "none — first release")
- **Previous artifact location**: <path or URL>
- **Previous artifact SHA-256**: 64-character hash (or `none` for first release)
- **Storage schema changes**: yes/no
  - If yes: which stores (task history, approval records, workspaces, model settings)
  - Migration direction: forward-only / reversible / no change
- **Permission state changes**: yes/no
- **User data format changes**: yes/no
- **Rollback steps**:
  1. Close Javis (verify no background process)
  2. If schemas changed: back up %LOCALAPPDATA%\app.javis.desktop
  3. Uninstall via Windows Settings > Apps
  4. Install previous signed artifact
  5. Launch, verify version, run restart QA
- **Non-downgradable data**: <list or "none">
```

The notes can be generated from signed artifacts:

```powershell
.\scripts\release\write-release-rollback-notes.ps1 `
  -Version X.Y.Z `
  -QaRoot docs\qa\YYYY-MM-DD `
  -PreviousKnownGoodBuild X.Y.Z `
  -PreviousArtifactLocation <path-or-url> `
  -PreviousArtifactSha256 <64-character-sha256>
```

The helper refuses unsigned artifacts, requires MSI and NSIS artifacts to be
signed by the same certificate thumbprint, and writes the product-gate file
`release-rollback-notes.md` with `Previous known-good build`, MSI/NSIS
signature status, signer thumbprints, installer SHA-256 hashes, and the
previous artifact SHA-256 used for rollback provenance.

## Step 7: Release Notes

Use the template from `RELEASE.md`. Key sections:

- **Verification**: pass/fail for each check, artifact checksums
- **Included**: features in this build
- **Known Gaps**: non-blocking limitations only
- **Safety Notes**: write-capable flows and approval model
- **Rollback**: reference to the rollback record

## Step 8: Final Gate

Do not publish when any of these are true:

- `pnpm check` fails
- A `PRODUCT_READINESS.md` blocker is still open
- A confirmed-write path can execute without visible approval
- The build is unsigned
- Version/rollback notes are missing
- Manual QA has an untriaged failure in a primary scenario

## Rollback Procedure

If a published build needs to be rolled back:

1. Confirm the previous known-good artifact is signed and its checksum matches
   the release notes.
2. Close Javis. Verify no background process:
   ```powershell
   Get-Process -Name Javis -ErrorAction SilentlyContinue
   ```
3. If storage schemas changed in the bad build, back up user data:
   ```powershell
   # Tauri app data (identifier: app.javis.desktop)
   $src = "$env:LOCALAPPDATA\app.javis.desktop"
   $dst = "$env:LOCALAPPDATA\app.javis.desktop-backup-$(Get-Date -Format 'yyyyMMdd')"
   Copy-Item -Recurse $src $dst
   ```
   Key files: `javis.db` (SQLite), `task-audit.jsonl`, `task-session.jsonl`,
   plus localStorage state in the webview storage directory.
4. Uninstall the bad build from Windows Settings > Apps. Direct downgrade
   install is blocked by `allowDowngrades=false` in the Tauri config.
5. Install the previous known-good signed artifact.
6. Launch Javis. Verify the version matches the expected rollback target.
7. Run restart QA for task history, workspace recovery, and approval records.
8. Record whether existing local data was preserved, ignored, migrated, or
   requires manual cleanup.

Do not delete user data during rollback unless the rollback notes explicitly say
the newer build wrote data the previous build cannot read safely.

## Checklist Summary

```
[ ] pnpm check passes
[ ] Version aligned across all 5 files
[ ] MSI + NSIS built with Authenticode signing
[ ] Signature verification passes for both artifacts
[ ] SHA-256 hashes recorded
[ ] Product workflow evidence gate passes
[ ] QA screenshots captured
[ ] Rollback notes written
[ ] Release notes written
[ ] No product blockers from PRODUCT_READINESS.md
[ ] No untriaged QA failures
```
