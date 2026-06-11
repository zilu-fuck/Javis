# Git Remote and PR Write QA

This folder contains the packaged-app QA playbook for Git remote and pull
request confirmed-write workflows.

The workflow is intentionally manual because it can stage, commit, push, create
draft pull requests, and post pull request comments against a real remote.

## Preconditions

- Run against the packaged Tauri app, not the dev server.
- Use a disposable repository and remote branch.
- Authenticate `gh` only for the disposable remote used by this run.
- Do not use secrets, private tokens, customer data, or protected branches.
- Keep all evidence files under this folder or another dated `docs/qa/YYYY-MM-DD`
  folder.

## Required Evidence

The product workflow gate looks for these filenames:

```text
31-git-review-status-pr-list.png
32-git-stage-approval-card.png
33-git-commit-approval-card.png
34-git-push-approval-card.png
35-git-create-pr-approval-card.png
36-git-comment-pr-approval-card.png
37-git-restored-approval-after-restart.png
git-remote-pr-qa-output.txt
```

## Manual Run

First run the read-only preflight against the disposable workspace:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docs\qa\2026-06-09\git-remote-pr\git-remote-pr-preflight.ps1 `
  -WorkspacePath <disposable-repo-path> `
  -RequireGhAuth
```

The preflight only reads Git/GitHub state. It does not stage, commit, push,
create PRs, or comment on PRs.

1. Copy `git-remote-pr-manual-qa-evidence.template.md` to
   `git-remote-pr-manual-qa-evidence.md`.
2. Follow `git-remote-pr-qa-scenarios.md` in order.
3. Capture each required screenshot with the exact filename above.
4. Mark every scenario in `git-remote-pr-manual-qa-evidence.md` as `PASS` only
   after the packaged app behavior is verified.
5. Generate the machine-readable output:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docs\qa\2026-06-09\git-remote-pr\git-remote-pr-release-qa.ps1 `
  -Stage pass `
  -Commit pass `
  -Push pass `
  -PrCreate pass `
  -PrComment pass `
  -Denial pass `
  -Restore pass
```

6. Re-run the product workflow gate:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\qa\check-product-workflow-evidence.ps1 -QaRoot docs\qa\2026-06-09
```

The helper script refuses to emit a passing output unless all required
screenshots and the completed manual evidence file exist. The output also
records packaged-app provenance (`PackagedApp`, `AppVersion`, `QaDate`) and an
`Artifacts` list; every referenced artifact must exist in the QA evidence
folder before the product workflow gate can mark `git-remote-pr-writes` as
passing.

The product gate also requires machine-readable JSON status fields for
`stage`, `commit`, `push`, `prCreate`, `prComment`, `denial`, and `restore`;
hand-written prose is not enough to close the workflow.
