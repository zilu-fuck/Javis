# Git Remote/PR Denial JSON Gate Source QA

Date: 2026-06-11

## Scope

This source-level QA records a stricter product evidence gate for Git remote
and pull request write workflows. It does not close `git-remote-pr-writes`
without packaged-app evidence from a disposable remote.

## Source Changes

- `docs/qa/2026-06-09/git-remote-pr/git-remote-pr-release-qa.ps1`
  now accepts `-Denial pass|fail|pending`, writes `denial: PASS`, and includes
  `denial` in the machine-readable JSON output.
- `scripts/qa/check-product-workflow-evidence.ps1` now requires Git workflow
  JSON status fields for `stage`, `commit`, `push`, `prCreate`, `prComment`,
  `denial`, and `restore`.
- The Git remote/PR manual QA playbook now includes `GIT-QA-13` for denial
  fail-closed behavior.

## Verification

Run:

```powershell
node scripts\test-git-remote-pr-release-qa.mjs
node scripts\test-check-product-workflow-evidence.mjs
```

Both tests pass with complete fixture evidence. The product workflow inventory
still reports `git-remote-pr-writes` as a known blocker until real packaged-app
evidence is captured.
