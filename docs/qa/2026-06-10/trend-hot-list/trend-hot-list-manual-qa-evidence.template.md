# Structured Hot-List Research Manual QA Evidence Template

Date: YYYY-MM-DD
Operator: <operator name>
Build: <app version, build id, or executable path>
Provider: <provider id>
Source URL: <source URL>
Result: PENDING
Artifacts: 38-trend-hot-list-report.png, trend-hot-list-live-qa-output.txt

## Preconditions

- The app under test is the packaged desktop build.
- The provider is a public hot-list source.
- The request asks for 20 items.
- Evidence contains no private cookies, tokens, or account-only data.

## Scenario Results

- TREND-QA-01: PENDING
  Evidence: The task used `trend.fetchHotList` with the recorded provider id.

- TREND-QA-02: PENDING
  Evidence: The result recorded the source URL and completed diagnostics.

- TREND-QA-03: PENDING
  Evidence: The returned item count was non-empty and any short-list warning was visible.

- TREND-QA-04: PENDING
  Evidence: The final research report preserved sources and provider metadata.

## Notes

- Replace every `PENDING` with `PASS` only after the real packaged-app behavior
  was verified.
- Keep a concrete `Evidence:` line under every `PASS` scenario.
- Do not paste secrets, cookies, or screenshot data URLs into this file.
