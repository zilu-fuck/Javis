# Release Build Summary Gate Source QA

Date: 2026-06-11

## Scope

This source-level QA records stricter signed-release evidence requirements. It
does not produce real signed MSI/NSIS artifacts.

## Source Changes

- `scripts/release/build-windows-signed.ps1` now writes
  `release-build-summary.json` under the dated QA folder after signature and
  hash verification succeeds.
- The summary records the generator script, version, commit, build timestamp,
  signing certificate thumbprint, timestamp URL, digest algorithm, signed
  artifact paths, signature status, signer thumbprints, and SHA-256 hashes.
- The product workflow gate now requires both `release-build-summary.json` and
  helper-generated `release-rollback-notes.md` before
  `release-and-rollback` can pass.
- The gate also checks that version, commit, MSI/NSIS paths, signature statuses,
  signer thumbprints, and SHA-256 hashes match between the build summary and
  rollback notes.
- Hand-written rollback prose remains blocked because it lacks the signed-build
  helper marker and machine-readable artifact summary.

## Remaining Blocker

`release-and-rollback` remains blocked until real signed MSI/NSIS artifacts,
`release-build-summary.json`, and `release-rollback-notes.md` are captured in a
dated QA folder.

## Verification

Run:

```powershell
cd E:\Javis
node scripts\test-check-product-workflow-evidence.mjs
node scripts\test-release-rollback-notes.mjs
```
