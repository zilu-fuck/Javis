# Capability Runtime Ingestion Source QA

Date: 2026-06-10

## Scope

This source-level QA covers runtime capability verification injection, desktop
in-memory tool-call audit rollups, and persisted SQLite recent audit loading
for recent failure-rate signals.

It verifies:

- `createInitialTaskSnapshot` can be initialized with caller-provided
  capability verification instead of only using the built-in defaults.
- `createFileScanTaskRuntime` accepts a runtime `getCapabilityVerification`
  provider through the desktop runtime factory.
- Terminal tool-call audit records are converted into generic capability tool
  signals.
- Recent failure rates are derived from a bounded recent audit window.
- SQLite tool-call audit records can be loaded as a bounded recent window and
  fed into the same runtime verification path after startup import.

## Commands

```powershell
cd E:\Javis\packages\core
..\..\node_modules\.bin\tsc.CMD --noEmit
```

Result: passed.

```powershell
cd E:\Javis\apps\desktop
.\node_modules\.bin\tsc.CMD --noEmit
```

Result: passed.

```powershell
cd E:\Javis
.\node_modules\.bin\vitest.CMD run apps/desktop/src/tool-call-audit.test.ts apps/desktop/src/capability-verification.test.ts apps/desktop/src/app-runtime.test.ts packages/core/src/index.test.ts packages/core/src/agent-capability.test.ts
```

Result: passed, 5 files / 191 tests.

## Remaining Gaps

- This is source-level evidence only, not packaged-app evidence.
- Generic live QA evidence ingestion into runtime scoring remains open.
- Product gates should continue to treat capability scoring as partial until
  live evidence and packaged QA are captured.
