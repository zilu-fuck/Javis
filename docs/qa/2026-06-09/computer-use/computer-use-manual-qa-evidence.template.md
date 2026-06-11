# Computer Use Manual QA Evidence Template

Date: YYYY-MM-DD
Operator: <operator name>
Build: <app version, build id, or executable path>
Result: PENDING
Artifacts: 01-computer-use-release-app.png, computer-use-release-qa-report.md, computer-use-release-qa-output.json

## Preconditions

- Computer Use is enabled only for this manual QA session.
- Emergency stop is available and verified before starting desktop-action scenarios.
- The release/non-interactive QA evidence in this folder is current and passes `corepack pnpm qa:computer-use`.
- No passwords, payment data, tokens, private keys, or other secrets are used as test input.

## Scenario Results

- CU-QA-01: PENDING
  Evidence: Calculator opened and visible after the Computer Use flow.

- CU-QA-02: PENDING
  Evidence: Notepad opened, `Hello World` typed, and no unrelated app received input.

- CU-QA-03: PENDING
  Evidence: VS Code status bar was inspected and visible errors, if any, were reported.

- CU-QA-04: PENDING
  Evidence: A proposed click/type was denied and no OS action executed.

- CU-QA-05: PENDING
  Evidence: A task approval expired and the next desktop write required fresh approval.

- CU-QA-06: PENDING
  Evidence: A protected-window task such as Task Manager was rejected.

- CU-QA-07: PENDING
  Evidence: A blocked key combo such as `Win+R` or `Alt+F4` was rejected before execution.

- CU-QA-08: PENDING
  Evidence: A complete multi-step Chrome navigation flow finished and final screenshot/report artifacts were recorded.

## Notes

- Replace every `PENDING` with `PASS` only after the real desktop action was performed and verified.
- Keep a concrete `Evidence:` line under every `PASS` scenario.
- Add extra artifact references to the `Artifacts:` line only if the files exist in this QA evidence folder.
- Do not paste screenshot data URLs into this file.
