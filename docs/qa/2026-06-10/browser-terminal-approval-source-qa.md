# Browser And Terminal Approval Source QA

Date: 2026-06-10

Scope: source-level native approval binding for browser write operations and
interactive terminal operations.

Command:

```powershell
cargo test --lib
```

Directory:

```text
apps/desktop/src-tauri
```

Result:

```text
Finished test profile
```

Covered behavior:

- Browser write approvals bind approval id, task id, session id, action, and
  preview hash.
- Browser approvals are consumed once and reject changed payloads.
- Terminal create/input approvals bind approval id, task id, action, and preview
  hash.
- Terminal input previews bind raw input by hash and byte count without exposing
  the raw input text.
- Terminal approvals are consumed once and reject changed input hashes.

Remaining product work:

- Packaged visible approval evidence for Browser and Terminal writes.
- Packaged-app QA evidence for approve, deny, stale-preview, guard, and one-shot
  execution paths.

Follow-up source evidence:

- `docs/qa/2026-06-10/terminal-visible-approval-source-qa.md` covers the
  source-level Terminal visible approval surface.
- `docs/qa/2026-06-11/browser-write-visible-approval-source-qa.md` covers the
  source-level Browser visible approval surface and desktop runtime
  pending-approval broker.
