# Computer Use + mimo-v2.5 + vLLM Live QA

- Date: 2026-06-16T17:30:23+08:00
- Result: BLOCKED
- Target stack: Codex Computer Use plugin + real mimo-v2.5 served through vLLM/OpenAI-compatible API
- Evidence JSON: llm-computer-use-live-qa-20260616.json
- Screenshot: llm-blocked-desktop-state.png

## Checks

1. Local vLLM endpoint probe: no listener on 127.0.0.1:8000, 8001, 8080, or 11434 for /v1/models.
2. Computer Use plugin bootstrap: failed before sky.list_apps() and before Computer Use screenshot APIs were available.
3. Key file: E:\Javis\临时apikey.txt exists and contains a hosted MiMo URL marker, but this does not prove local vLLM availability.

## Errors Recorded

- BLOCKER: Computer Use plugin bootstrap failed: Package subpath './dist/project/cua/sky_js/src/targets/windows/internal/computer_use_client_base.js' is not defined by "exports" in @oai/sky package.json.
- BLOCKER: vLLM endpoint not running locally on the probed OpenAI-compatible ports.

## Screenshot Note

llm-blocked-desktop-state.png was captured as desktop-state evidence after the blocker was detected. It is not a Computer Use plugin screenshot, because the plugin failed during initialization.

## Outcome

This run did not send any QQ message and did not validate mimo-v2.5 through vLLM. Existing hosted MiMo QA artifacts in this directory remain useful regression evidence, but they are not counted as this vLLM live QA.
