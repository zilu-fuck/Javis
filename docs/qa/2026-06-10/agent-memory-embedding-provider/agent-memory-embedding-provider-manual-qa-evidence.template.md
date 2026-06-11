# Agent Memory Embedding Provider Manual QA Evidence Template

Date: YYYY-MM-DD
Operator: <operator name>
Build: <app version, build id, or executable path>
Result: PENDING
Artifacts: 44-agent-memory-embedding-settings.png, agent-memory-embedding-provider-live-qa-output.txt

## Scenario Results

- EMBEDDING-QA-01: PENDING
  Evidence: Local embedding mode produced vectors and recall remained usable.

- EMBEDDING-QA-02: PENDING
  Evidence: Native OpenAI-compatible embedding mode produced vectors using the
  configured base URL, model, and dimensions.

- EMBEDDING-QA-03: PENDING
  Evidence: The API key was selected by secret reference and was not visible in
  frontend state, logs, QA output, or screenshots.

- EMBEDDING-QA-04: PENDING
  Evidence: Vector search/recall used the configured embedding provider against
  disposable memory facts.

## Notes

- Replace every `PENDING` with `PASS` only after packaged-app behavior is
  verified.
- Do not paste API keys, bearer tokens, raw provider responses, or screenshot
  data URLs into this file.
