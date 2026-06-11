# Git Remote and PR Write QA Scenarios

Date: 2026-06-09

Overall status: Not yet full PASS.

These scenarios validate the packaged desktop Review panel and native
confirmed-write enforcement for Git remote and PR workflows.

| ID | Scenario | Goal | Required evidence |
|---|---|---|---|
| GIT-QA-01 | Review status and PR list | Show that the packaged app can read local status, remote summary, and GitHub PR list without writes. | `31-git-review-status-pr-list.png` |
| GIT-QA-02 | Stage preview | Prepare selected-file staging and verify the approval card lists only intended paths. | `32-git-stage-approval-card.png` |
| GIT-QA-03 | Stage execute | Approve staging and verify only approved paths are staged. | `git-remote-pr-qa-output.txt` records `stage: PASS` |
| GIT-QA-04 | Commit preview | Prepare commit and verify message plus staged-path summary. | `33-git-commit-approval-card.png` |
| GIT-QA-05 | Commit execute | Approve commit and verify exactly one expected commit is created. | `git-remote-pr-qa-output.txt` records `commit: PASS` |
| GIT-QA-06 | Push preview | Prepare push and verify remote/refspec, protected-branch guard, and behind-upstream guard state. | `34-git-push-approval-card.png` |
| GIT-QA-07 | Push execute | Approve push and verify only the disposable branch updates. | `git-remote-pr-qa-output.txt` records `push: PASS` |
| GIT-QA-08 | Draft PR preview | Prepare draft PR creation and verify title, body, base, head, and remote. | `35-git-create-pr-approval-card.png` |
| GIT-QA-09 | Draft PR execute | Approve draft PR creation and verify the returned PR URL. | `git-remote-pr-qa-output.txt` records `pr create: PASS` |
| GIT-QA-10 | PR comment preview | Prepare PR comment and verify target PR plus exact body. | `36-git-comment-pr-approval-card.png` |
| GIT-QA-11 | PR comment execute | Approve PR comment and verify the comment appears on the PR. | `git-remote-pr-qa-output.txt` records `pr comment: PASS` |
| GIT-QA-12 | Restore pending approval | Leave a Git write approval pending, restart the packaged app, and verify the restored approval remains bound to the original preview. | `37-git-restored-approval-after-restart.png` and `git-remote-pr-qa-output.txt` records `restore: PASS` |
| GIT-QA-13 | Denial fail-closed | Deny one prepared Git write and verify the stage/commit/remote/PR target is unchanged. | `git-remote-pr-qa-output.txt` records `denial: PASS` |

Acceptance requires the product workflow gate to pass without
`-AllowKnownBlockers` for the dated evidence folder.
