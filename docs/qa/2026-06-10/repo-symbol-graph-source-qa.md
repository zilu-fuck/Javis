# Repo Symbol Graph Source QA

Date: 2026-06-10

## Scope

This source-level QA records the generic repository trace symbol graph added to
the Code Agent repo intelligence path. It is not packaged/live QA evidence.

## Source Changes

- `packages/core/src/repo-intelligence.ts` now returns `symbolGraph` from
  `buildRepositoryTraceEvidenceReport`.
- `packages/tools/src/types.ts` exposes the same `CodeRepositorySymbolGraph`
  shape on `CodeRepositoryTraceResult`.
- `scripts/qa/check-product-workflow-evidence.ps1` now includes
  `repo-intelligence-package-live` as a known blocker.
- The graph is derived from existing trace evidence and uses generic file and
  symbol nodes with `declares`, `references`, `imports`, `exports`, and `calls`
  edges.
- The graph does not depend on a specific framework, repository layout, or
  provider.

## Remaining Blocker

This is still an evidence-derived graph, not a full TypeScript TypeChecker
project graph. Packaged/live QA and full project-wide symbol resolution remain
open.

## Verification

Run:

```powershell
.\node_modules\.bin\vitest.CMD run packages/core/src/repo-intelligence.test.ts packages/core/src/workflow-executor.test.ts
.\node_modules\.bin\tsc.CMD --noEmit -p packages\core\tsconfig.json
.\node_modules\.bin\tsc.CMD --noEmit -p packages\tools\tsconfig.json
.\node_modules\.bin\tsc.CMD --noEmit -p apps\desktop\tsconfig.json
```
