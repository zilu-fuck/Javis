# P0-1 Live Code Agent GUI QA — Manual Test Steps

Date: 2026-05-27

## Prerequisites

- New release binary built with DeepSeek `/v1` URL fix
- DeepSeek API key (real credentials)
- Test workspace with git repo: `C:\Users\s1897\javis-qa-workspace`

## Step 1: Launch and Configure Provider

1. Launch `javis-desktop.exe`
2. Open Settings → Model Provider
3. Select "DeepSeek" as provider
4. Enter your DeepSeek API key
5. Select model (e.g., `deepseek-v4-pro` or `deepseek-v4-flash`)
6. Save settings
7. Verify the settings persist: close and reopen Settings

## Step 2: Select Workspace

1. Click workspace selector → browse to `C:\Users\s1897\javis-qa-workspace`
2. Confirm the workspace loads (file tree or project info displayed)
3. Verify the git status is shown

## Step 3: Run Code Agent Proposal

1. Type a task in the chat input, e.g.:
   > "Update README.md title from Hello World to Hello Javis"
2. Press Enter to submit
3. Observe:
   - Commander agent plans the task
   - Code Agent generates a proposal
   - Proposal card appears with summary, changed files, and patch diff

## Step 4: Review Proposal

1. Verify the proposal card shows:
   - Summary describing the change
   - List of changed files (README.md)
   - Diff preview showing the changes
2. Check the proposal is reasonable and correct

## Step 5: Approve and Apply

1. Click "Approve" on the proposal card
2. Observe the approval confirmation
3. Verify the patch is applied (file content changed on disk)
4. Check `C:\Users\s1897\javis-qa-workspace\README.md` now says "Hello Javis"

## Step 6: Verify

1. Observe the Verifier agent runs after apply
2. Verify the result is reported in the UI
3. Check git status shows the change

## Success Criteria (all must pass)

- [ ] App launches without errors
- [ ] DeepSeek provider configures and persists
- [ ] Code Agent generates a valid proposal for the given task
- [ ] Proposal card shows summary, changedFiles, and patch diff
- [ ] Approve button works and triggers apply
- [ ] Patch is correctly applied to the file on disk
- [ ] Verifier runs and reports results
- [ ] No console errors or crashes during the flow

## Evidence

Screenshots to capture at each step:
1. `step1-provider-configured.png` — Settings page with DeepSeek selected
2. `step2-workspace-selected.png` — Main UI with workspace loaded
3. `step3-proposal-generated.png` — Proposal card visible in chat
4. `step4-proposal-review.png` — Detailed view of proposal
5. `step5-patch-applied.png` — After approve/apply, showing success
6. `step6-verification.png` — Verifier results
