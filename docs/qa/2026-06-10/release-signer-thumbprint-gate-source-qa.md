# Release Signer Thumbprint Gate Source QA

Date: 2026-06-10

## Scope

This source-level QA hardens release rollback evidence requirements. It does
not provide real signed release artifacts.

## Source Changes

- `scripts/release/write-release-rollback-notes.ps1` now requires each signed
  artifact to expose a valid 40-character signer thumbprint.
- The rollback helper rejects MSI and NSIS artifacts signed by different
  certificates.
- `scripts/qa/check-product-workflow-evidence.ps1` now requires MSI and NSIS
  signer thumbprints in generated rollback notes.
- `scripts/test-check-product-workflow-evidence.mjs` verifies that missing
  signer thumbprints keep `release-and-rollback` blocked.

## Remaining Blocker

`release-and-rollback` remains blocked until real signed MSI/NSIS artifacts and
helper-generated rollback notes are captured in a dated QA folder.

## Verification

Run:

```powershell
node scripts/test-check-product-workflow-evidence.mjs
node scripts/test-release-rollback-notes.mjs
```
