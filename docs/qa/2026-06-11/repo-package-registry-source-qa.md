# Repo Package Registry Source QA

Date: 2026-06-11

## Scope

This source-level QA records generic external package registry resolution for
repository intelligence. It is not packaged/live QA evidence.

## Source Changes

- `apps/desktop/src/repo-intelligence-service.ts` exposes an injectable
  `externalPackageRegistry` resolver and normalizes npm metadata into generic
  package hints.
- External specifiers can now produce `registry:npm/<package>` hints with
  `main`, `module`, `types`, and selected `exports` metadata.
- Scoped package names are encoded before registry lookup.
- `apps/desktop/src/app-runtime.ts` injects global `fetch` into repository
  trace module resolution when `fetch` is available.
- Registry failures remain non-fatal and fall back to local package.json,
  lockfile, node_modules, tsconfig, and file-search evidence.

## Remaining Blocker

`repo-intelligence-package-live` remains blocked until packaged desktop QA
captures real repository search, symbol graph, resolver evidence, package hints
or registry evidence, and fallback diagnostics.

## Verification

Run:

```powershell
cd apps\desktop
..\..\node_modules\.bin\vitest.CMD run src\repo-intelligence-service.test.ts src\app-runtime.test.ts
cd ..\..
.\node_modules\.bin\tsc.CMD --noEmit -p apps\desktop\tsconfig.json
```
