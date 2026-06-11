# Browser and Terminal Approval Manual QA Evidence Template

Date: YYYY-MM-DD
Operator: <operator name>
Build: <app version, build id, or executable path>
Workspace: <disposable workspace path>
Result: PENDING
Artifacts: 39-terminal-start-approval-card.png, 40-terminal-input-approval-card.png, 41-browser-write-approval-card.png, browser-terminal-approval-qa-output.txt

## Preconditions

- The app under test is the packaged desktop build.
- Browser write testing uses a disposable local page or test target.
- Terminal testing uses a disposable command/session with no secrets.
- No private tokens, credentials, customer data, or destructive commands are
  entered.

## Scenario Results

- BROWSER-TERM-QA-01: PENDING
  Evidence: Terminal start approval card displayed command/session scope,
  approval id, and preview hash before starting the session.

- BROWSER-TERM-QA-02: PENDING
  Evidence: Terminal input approval card displayed the input scope and preview
  hash without logging raw sensitive input.

- BROWSER-TERM-QA-03: PENDING
  Evidence: Browser write approval card displayed action, target/session scope,
  and preview hash before the write action.

- BROWSER-TERM-QA-04: PENDING
  Evidence: Denying an approval failed closed and did not execute the write or
  terminal input.

- BROWSER-TERM-QA-05: PENDING
  Evidence: Changing the pending operation after preview creation rejected the
  stale preview.

- BROWSER-TERM-QA-06: PENDING
  Evidence: Reusing an already consumed approval was rejected.

## Notes

- Replace every `PENDING` with `PASS` only after the real packaged-app behavior
  was verified.
- Keep concrete `Evidence:` details under every `PASS` scenario.
- Add extra artifact references to the `Artifacts:` line only if those files
  exist in this QA evidence folder.
- Do not paste API keys, tokens, raw terminal secrets, or screenshot data URLs
  into this file.
