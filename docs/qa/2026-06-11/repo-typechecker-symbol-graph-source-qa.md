# Repo TypeChecker Symbol Graph Source QA

Date: 2026-06-11

Scope:
- Source-level repository intelligence enrichment only.
- No live package registry calls.
- No packaged desktop run.
- No screenshot evidence captured.

What changed:
- `apps/desktop/src/repo-intelligence-service.ts` now builds a bounded in-memory
  TypeScript `Program` from the generic `listScriptFiles()` / `readTextFile()`
  hooks already used by repository intelligence.
- The TypeChecker pass enriches the existing generic `symbolGraph` contract with
  stronger `imports`, `calls`, `declares`, and `exports` evidence.
- The implementation remains repository-agnostic: it does not hardcode Weibo,
  product-specific paths, package names, or one workflow.
- If selected project files cannot be read, the service records a
  `needsConfirmation` gap instead of pretending the graph is complete.
- Existing caps still keep project-wide graphing bounded; capped runs remain a
  confirmation gap.

Source checks:
- `corepack pnpm --filter @javis/desktop test -- src/repo-intelligence-service.test.ts`

Covered scenarios:
- Bounded project-wide AST symbol graph still emits file/symbol nodes and
  import/call/export edges.
- TypeScript TypeChecker evidence links a caller through a barrel export to the
  original declaration file.
- Unreadable project files produce an explicit TypeChecker confirmation gap.

Still blocked:
- `repo-intelligence-package-live` remains blocked until real packaged app
  screenshots and structured output are captured under the product workflow QA
  folder.
