# Repository Symbol Graph Source QA

Date: 2026-06-11

Scope: source-level verification for generic repository intelligence graphing.

What changed:

- Resolved module links now enrich `symbolGraph` with `file -> file` imports/exports edges.
- TypeScript AST enrichment now adds `symbol -> symbol` call edges from the enclosing caller declaration to the target symbol.
- Resolved target module files now add AST declaration/export edges for the target symbol.

Commands:

```powershell
cd E:\Javis\apps\desktop
..\..\node_modules\.bin\vitest.CMD run src\repo-intelligence-service.test.ts
..\..\node_modules\.bin\tsc.CMD --noEmit -p tsconfig.json
```

Result: passed.

Remaining gaps:

- This is source-level QA only.
- It is not a full TypeScript TypeChecker project graph.
- The `repo-intelligence-package-live` blocker remains open until packaged/live evidence is captured.
