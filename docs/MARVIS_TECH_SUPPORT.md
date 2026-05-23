# Marvis Technical Support Notes

This document records what Javis can learn from the installed Marvis desktop
application at `C:\Program Files\Tencent\Marvis`. It is based on filesystem
layout, configuration files, logs, bundled assets, and readable scripts. It is
not based on decompiling binaries or decrypting protected prompt and skill
content.

## Purpose

Use these notes as a product and architecture reference for Javis:

- how a desktop agent product separates UI, native shell, local services, and
  agent capabilities
- how capability packs can be shipped and versioned
- how local execution safety can be made explicit
- how logs and process boundaries support troubleshooting

These notes should not be treated as a source-level implementation guide.

## Observed Package Layout

```text
C:\Program Files\Tencent\Marvis
  Application
    1.60.1000.21
      Marvis.exe
      MarvisHost.exe
      MarvisSvr.exe
      MarvisMCP.exe
      LocalModelService.exe
      marvis-offline-page
      marvisnode
      models
      logs
  MarvisAgent
    1.0.1100.151
      MarvisAgent.exe
      runtime\python311
      mcp_server
      prompts
      resource\security_rules
      skills
  Knowledgebase
    1.0.1000.96
  DocPreview
  BorderlessSpace
```

## High-Level Architecture

Marvis appears to use a layered desktop architecture:

```text
Native launcher and desktop shell
  -> Qt/CEF hosted web workbench
  -> IPC and gateway layer
  -> local services
  -> agent runtime
  -> skills, prompts, MCP servers, document tools, search/indexing tools
```

The main application layer includes Qt5, CEF, QCefView, SQLite, Poco, and
multiple process-specific executables. The web workbench is bundled as static
Vite/React assets under `marvis-offline-page`.

The agent layer ships as a Python 3.11 runtime with local scripts, resource
files, encrypted skill instructions, prompt assets, MCP server executables, and
security rules.

The knowledgebase layer packages document parsing, OCR, indexing, vector or
full-text retrieval, and local inference dependencies.

## Component Responsibilities

| Component | Observed responsibility |
| --- | --- |
| `Application` | Native desktop shell, web UI host, update/install logic, local process orchestration, logs. |
| `marvis-offline-page` | Static React/Vite UI, markdown rendering, diagrams, formulas, workbench animation assets. |
| `MarvisAgent` | Agent runtime, capability packs, MCP servers, prompts, command safety resources. |
| `Knowledgebase` | Local document parsing, indexing, retrieval, OCR, and local model/inference support. |
| `DocPreview` | Document preview SDK/runtime support. |
| `BorderlessSpace` | Remote control, streaming, virtual display/HID, and phone or app interaction support. |

## Runtime Signals From Logs

The logs show several useful boundaries:

- `MarvisAgentManager` starts, monitors, and terminates the agent process.
- `KnowledgeBaseManager` owns the local knowledgebase process lifecycle.
- `MarvisSvrManager` handles server process heartbeat and shutdown.
- `GatewayManager` handles IPC/gateway process lifecycle.
- `MarvisMCP.exe` performs an MCP initialization handshake and serves tools
  over stdin/stdout.
- UI logs mention `AGUIConnection` and `gateway.action`, suggesting a structured
  bridge between the web workbench and native services.
- The application records focus, process, login, update, and service state with
  named log channels.

For Javis, the important lesson is that each long-running subsystem should have
an owner, heartbeat or lifecycle state, and visible logs.

## Skill System

The `MarvisAgent\1.0.1100.151\skills` directory contains capability-oriented
folders such as:

- `agent-browser`
- `app-basic-ops`
- `docx`
- `excel-processing-and-analysis`
- `file-organizer`
- `file-search`
- `image-search`
- `invoice-retrieval`
- `pdf`
- `photo-to-video`
- `planning-with-files`
- `pptx`
- `report-writer`
- `smart-desktop-ops`
- `smart-phone-ops`
- `web-qqmail-invoice`

Many `SKILL.md` files are encrypted, but supporting Python scripts are present
for office documents, PDF handling, file organization, planning state, and media
generation. This suggests a pattern where instructions, templates, and scripts
are packaged together as versioned capability modules.

Javis can adopt the same product shape without copying implementation details:

- one folder per capability
- clear instructions for when the capability applies
- scripts for deterministic work
- templates for repeatable document/report output
- shared validators for risky file formats
- explicit versioning and compatibility metadata when needed

## Local Tooling

Marvis bundles many local tools and runtimes instead of relying only on cloud
model calls:

- Python 3.11 runtime
- Node/npm runtime
- ripgrep
- ONNX OCR models
- OpenVINO and OpenVINO GenAI
- LanceDB, Tantivy, PyArrow, pandas, sqlglot
- PyMuPDF, pypdf, pypdfium2, python-docx, python-pptx, openpyxl
- OpenCV and image-processing libraries

This supports a useful principle for Javis: use model calls for reasoning and
language tasks, but keep parsing, indexing, validation, file mutation, and
format conversion in deterministic local tools.

## Safety Model Observations

The agent resources include explicit dangerous-command rules for PowerShell,
Python, and Bash. The visible rule categories include:

- remote code download and execution
- network requests and possible data exfiltration
- recursive or forced deletion
- destructive git operations such as `git reset --hard`
- shell patterns that can cause broad filesystem damage

This maps closely to Javis's existing permission model. A useful improvement
path is to convert Javis's current allowlist and rejection rules into explicit,
testable rule files with stable IDs, descriptions, categories, and examples.

## Frontend Workbench Observations

The bundled frontend includes evidence of:

- React and Vite
- Markdown rendering
- Mermaid diagrams
- KaTeX formulas
- Monaco editor
- animated workbench assets and agent states
- connection management between UI and local services

The key design lesson is that the agent UI is not just a chat window. It has
space for task state, rich output, diagrams, editor-like surfaces, and animated
presence. Javis should keep this only where it supports task clarity; decorative
animation should not replace auditability or controls.

## Suggested Javis Application

Javis already has the right broad split:

```text
apps/desktop
packages/core
packages/tools
packages/ui
docs
```

The Marvis-inspired next step is not a large rewrite. Prefer these incremental
changes:

1. Define a capability-pack shape for Javis agents.
   Verify with one small capability, such as file search or document summary.

2. Move safety rules toward explicit rule files.
   Verify with unit tests for rejected command and filesystem patterns.

3. Add lifecycle ownership for future long-running services.
   Verify that the UI can show starting, ready, unhealthy, and stopped states.

4. Treat knowledgebase as a separate local service boundary.
   Verify with a minimal local index/search prototype before adding heavier
   vector or inference dependencies.

5. Keep deterministic scripts close to capability instructions.
   Verify each script independently before exposing it to model-driven agents.

## Boundaries And Unknowns

The following were not verified:

- proprietary binary internals
- encrypted skill or prompt content
- exact model-provider routing
- exact IPC protocol shape
- any private server-side behavior

The following were intentionally not attempted:

- binary decompilation
- prompt decryption
- credential extraction
- modification of the installed Marvis directory

## Support Checklist For Javis

When adapting a Marvis-like feature into Javis, answer these questions first:

- What layer owns the feature: UI, core runtime, native bridge, service, or
  capability pack?
- What permission level does the feature require?
- What deterministic script or tool can perform the concrete work?
- What state should the UI show before, during, and after execution?
- What logs are needed for troubleshooting?
- What test proves the safety boundary?
- What data must never be logged?

The answer should fit into the existing Javis architecture before adding a new
runtime, service, or dependency.
