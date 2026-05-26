# QA Notes

Date: 2026-05-26

Operating system: Microsoft Windows NT 10.0.26200.0

Scope: Code Agent Live QA rerun with DeepSeek API credentials.

## Commands

```sh
pnpm check                                    # Full validation: typecheck + Vitest + Rust + build
pnpm --filter @javis/desktop tauri build       # Release build
cargo test                                     # Rust tests
```

## Results

### Validation Gate

- TypeScript typecheck: 4/4 packages passed
- Vitest: 197 tests passed (16 ui + 89 core + 92 desktop)
- Rust tests: 71 passed
- Vite build: passed
- Tauri build: passed (MSI + NSIS)

### Fixture QA (Code Agent deny + approve)

```sh
powershell -ExecutionPolicy Bypass -File docs/qa/2026-05-24/code-agent-opencode-qa.ps1
```

- **Deny scenario**: PASS - "Code Agent patch denied", file unchanged at "hello reviewed"
- **Approve scenario**: PASS - "Code Agent patch applied", file changed to "hello approved"

### Live Provider QA (DeepSeek)

Provider: deepseek
Model: deepseek-v4-flash
Base URL: https://api.deepseek.com

- Live proposal: FAIL-SAFE (provider-hardening-needed) - proposal generation did not produce parseable output. No file writes were attempted. API connectivity verified via independent Python test (HTTP 200, valid JSON proposal).

## Fixes Applied

1. **Skip opencode for credentialed providers**: Modified `propose_code_edit_with_opencode` to bypass the globally-installed opencode binary when API credentials are available. The opencode binary returns NDJSON event streams that cannot be parsed as proposal JSON. Direct HTTP API calls produce valid proposal JSON (verified via Python test).

2. **Add baseGitHead to apply_code_patch**: The Rust `apply_code_patch_in_workspace` recomputes the proposal hash including `base_git_head`, but the TypeScript frontend was not sending this field. This caused hash mismatch errors on fixture approve tests. Fixed by adding `baseGitHead: edit.baseGitHead` to the `apply_code_patch` invoke.

## Evidence

- `pnpm-check.txt`: full `pnpm check` output (available if needed)
- Rust tests: 71/71 passed
- Fixture QA: deny + approve both passed with tauri-built release binary
- Live QA: provider-hardening-needed (safe failure, no writes attempted)
- Commit: `fix: skip opencode for credentialed providers, add baseGitHead to apply`

## Notes

- The `can_fallback_from_opencode_error` function was removed as dead code since opencode is now skipped entirely for credentialed providers.
- Live provider QA continues to show "provider-hardening-needed" - the ureq HTTP client in the Rust release binary may have TLS/certificate configuration issues on this Windows system. The API call succeeds from Python (urllib) and curl. Further investigation should check ureq TLS configuration for the release build.
- The `deepseek-v4-flash` model uses reasoning tokens (thinking) by default. The Rust code sends `"thinking": {"type": "disabled"}` which is silently ignored by DeepSeek API (not an error). The model correctly returns `content` with the proposal JSON in tests.
