# Repo Project-Wide Symbol Graph Source QA

Date: 2026-06-11

## Scope

This source-level QA records bounded project-wide AST symbol graph enrichment
for repository intelligence. It is not packaged/live QA evidence.

## Source Changes

- `apps/desktop/src/repo-intelligence-service.ts` now accepts an optional
  `listScriptFiles()` provider.
- When script discovery and `readTextFile()` are available, trace results enrich
  the existing symbol graph with project script declarations, exports, imports,
  and imported-symbol call edges.
- The enrichment is capped by `maxProjectSymbolFiles` and prioritizes key files,
  module-link evidence paths, resolved module paths, and existing symbol-graph
  paths before scanning the rest of the discovered scripts.
- If file discovery fails, direct search and resolved-module evidence still
  return; the report records a confirmation gap instead of pretending the graph
  is complete.

## Remaining Blocker

`repo-intelligence-package-live` remains blocked until packaged desktop QA
captures visible key-file ranking, cross-file symbol graph evidence,
resolver/package evidence, and fallback diagnostics.

## Verification

Run:

```powershell
cd E:\Javis
corepack pnpm --filter @javis/desktop test -- src/repo-intelligence-service.test.ts
.\node_modules\.bin\tsc.CMD --noEmit -p apps\desktop\tsconfig.json
```
