# Release Operations Source QA

Date: 2026-06-10

Scope: non-signing verification of release/version/rollback tooling.

Commands:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release\check-release-version.ps1 -ExpectedVersion 0.1.0
node scripts\test-release-rollback-notes.mjs
node scripts\test-check-product-workflow-evidence.mjs
```

Result:

```text
Release version is aligned for Windows installers: 0.1.0
Release rollback notes helper test passed
Product workflow QA evidence checker test passed
```

What this proves:

- Release version fields are aligned for the current source tree.
- The rollback-notes helper has source-level coverage.
- The product workflow evidence checker has source-level coverage.
- The signed build helper now writes `release-build-summary.json` after signed
  artifact verification.
- The `release-and-rollback` evidence gate requires helper-generated rollback
  notes plus `release-build-summary.json` with version, commit, signed MSI/NSIS
  paths, valid signature statuses, signer thumbprints, and 64-character
  SHA-256 hashes. It also checks that those release fields match between the
  two files; hand-written or mismatched signature prose remains blocked.

What this does not prove:

- No signed MSI/NSIS artifacts were produced in this run.
- No Authenticode certificate was used or verified in this run.
- No real build summary or rollback notes were generated from signed artifacts
  in this run.
- The `release-and-rollback` product gate remains blocked until signed artifact
  evidence, build summary, and rollback notes are captured under the QA
  directory.
