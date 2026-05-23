# Troubleshooting

This page collects common local development and release issues.

## Vite Port Is Already In Use

The desktop Vite config uses port `1420` with `strictPort: true` because Tauri
expects a stable dev server URL.

Check whether the app is already running:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:1420
```

Find the owning process:

```powershell
Get-Process -Id (Get-NetTCPConnection -LocalPort 1420 | Select-Object -First 1 -ExpandProperty OwningProcess)
```

If the existing server is yours, reuse it for visual QA. Otherwise stop the
process before running `pnpm dev`.

## Frontend Preview Cannot Call Tauri

`pnpm --filter @javis/desktop dev` starts Vite only. It is useful for layout
checks, but native commands such as file scanning, shell checks, and PDF moves
require the Tauri runtime.

Use:

```sh
pnpm dev
```

for native desktop testing.

## Rust Toolchain Missing

If `pnpm rust:check` or `pnpm rust:test` fails before compiling, verify Rust is
available:

```sh
cargo --version
rustc --version
```

Install or repair the Rust toolchain before running Tauri build commands.

## Tauri Build Fails After Frontend Changes

Run the checks separately to locate the failing layer:

```sh
pnpm typecheck
pnpm --filter @javis/desktop build
pnpm rust:check
```

Frontend TypeScript and Vite errors usually surface before Rust packaging
starts.

## PDF Organization Finds No Files

The current PDF organization scenario scans the user's Downloads folder. To QA
the permission flow, place test PDF files in Downloads before submitting:

```text
Organize PDFs in Downloads
```

Do not use private documents for screenshots. Create disposable test PDFs.

## Screenshot Evidence

Manual QA evidence belongs under:

```text
docs/qa/YYYY-MM-DD/
```

If browser automation cannot capture a screenshot, use Chrome headless or the
desktop screenshot tool, then record the workaround in `notes.md`.
