# Git Remote and PR Write Manual QA Evidence Template

Date: YYYY-MM-DD
Operator: <operator name>
Build: <app version, build id, or executable path>
Disposable remote: <owner/repo or remote URL>
Disposable branch: <branch name>
Result: PENDING
Artifacts: 31-git-review-status-pr-list.png, 32-git-stage-approval-card.png, 33-git-commit-approval-card.png, 34-git-push-approval-card.png, 35-git-create-pr-approval-card.png, 36-git-comment-pr-approval-card.png, 37-git-restored-approval-after-restart.png, git-remote-pr-qa-output.txt

## Preconditions

- The app under test is the packaged desktop build.
- The selected workspace is a disposable Git repository.
- The active branch is not protected and can be deleted after QA.
- `gh auth status` is valid for the disposable remote only.
- The test change contains no secrets or private data.

## Scenario Results

- GIT-QA-01: PENDING
  Evidence: Review panel showed local Git status, remote summary, and PR list.

- GIT-QA-02: PENDING
  Evidence: Stage selected files approval card listed only the intended paths.

- GIT-QA-03: PENDING
  Evidence: Approved stage executed once and staged only the approved paths.

- GIT-QA-04: PENDING
  Evidence: Commit approval card showed the intended message and staged paths.

- GIT-QA-05: PENDING
  Evidence: Approved commit executed once and created the expected commit.

- GIT-QA-06: PENDING
  Evidence: Push approval card showed the exact remote/refspec and safety checks.

- GIT-QA-07: PENDING
  Evidence: Approved push executed once and updated only the disposable branch.

- GIT-QA-08: PENDING
  Evidence: Draft PR approval card showed the target branch, title, and body.

- GIT-QA-09: PENDING
  Evidence: Approved draft PR creation executed once and returned the PR URL.

- GIT-QA-10: PENDING
  Evidence: PR comment approval card showed the target PR and exact comment body.

- GIT-QA-11: PENDING
  Evidence: Approved PR comment executed once and the comment appeared on the PR.

- GIT-QA-12: PENDING
  Evidence: A pending Git approval restored after packaged app restart and stayed bound to the original preview.

- GIT-QA-13: PENDING
  Evidence: A denied Git write made no stage, commit, remote branch, PR, or PR comment change.

## Notes

- Replace every `PENDING` with `PASS` only after the real packaged-app behavior
  was verified.
- Keep a concrete `Evidence:` line under every `PASS` scenario.
- Add extra artifact references to the `Artifacts:` line only if those files
  exist in this QA evidence folder.
- Do not paste API keys, tokens, or screenshot data URLs into this file.
