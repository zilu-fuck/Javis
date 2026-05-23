# Contributing

Javis is early, but contributions should already follow the safety and
architecture boundaries documented in this repository.

## Before You Change Code

Read:

- [README](README.md)
- [MVP Status](docs/MVP_STATUS.md)
- [Development Guide](docs/DEVELOPMENT.md)
- [Security Model](docs/SECURITY_MODEL.md)

## Working Principles

- Prefer small, verifiable changes.
- Match existing patterns before adding new abstractions.
- Do not add speculative features.
- Do not bypass the permission model for convenience.
- Keep UI, Core, Tools, and Tauri responsibilities separate.

## Required Checks

Run:

```sh
pnpm check
```

For smaller inner-loop work:

```sh
pnpm typecheck
pnpm rust:test
```

## Safety Rules

Any change that writes, moves, deletes, overwrites, installs, publishes, or runs
non-allowlisted commands must include:

- a dry-run or preview
- a visible permission request
- explicit user approval before execution
- result verification
- tests for dangerous edge cases where practical

Do not add:

- recursive delete
- overwrite-by-default behavior
- force push
- package publishing
- credential reading
- hidden background automation

## Review Checklist

Before handing off a change, review:

- Does every changed line support the requested behavior?
- Does the UI show task status, agent state, logs, and verification?
- Are read/preview/write boundaries still clear?
- Are denied permissions true no-ops?
- Are conflicts skipped by default?
- Are errors visible and understandable?
- Did `pnpm check` pass?
