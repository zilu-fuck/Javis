# Repository Intelligence Manual QA Evidence Template

Date: YYYY-MM-DD
Operator: <operator name>
Build: <app version, build id, or executable path>
Workspace: <repository path>
Result: PENDING
Artifacts: 42-repo-search-key-files.png, 43-repo-trace-symbol-graph.png, repo-intelligence-package-live-qa-output.txt

## Preconditions

- The app under test is the packaged desktop build.
- The selected workspace is a local repository.
- Evidence contains no secrets or private tokens.

## Scenario Results

- REPO-QA-01: PENDING
  Evidence: Repository search showed ranked key files before editing.

- REPO-QA-02: PENDING
  Evidence: Repository trace showed a cross-file symbol graph.

- REPO-QA-03: PENDING
  Evidence: Resolver evidence was recorded.

- REPO-QA-04: PENDING
  Evidence: Local package hints and external registry evidence were recorded.

- REPO-QA-05: PENDING
  Evidence: Fallback diagnostics were visible.

## Notes

- Replace every `PENDING` with `PASS` only after the real packaged-app behavior
  was verified.
- Keep a concrete `Evidence:` line under every `PASS` scenario.
- Do not paste secrets, tokens, or screenshot data URLs into this file.
