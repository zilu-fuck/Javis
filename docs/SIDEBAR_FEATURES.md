# Sidebar Features Implementation

This document defines the functional specification and implementation plan for
each sidebar navigation item in the Javis desktop workbench. Items marked
"implemented" are already working; all others are planned.

## Current Sidebar Structure

```text
Javis (brand)
[search box]

--- Primary ---
+ 新建对话 (New Chat)              — implemented
● 自动任务 (Automated Tasks)       — placeholder
# 技能广场 (Skill Market)          — placeholder

--- 本地知识库 (Local Knowledge Base) ---
▦ 应用 (Apps)                     — placeholder
▣ 文档 (Documents)                — placeholder
□ 图库 (Gallery)                  — placeholder
▰ 此电脑 (This Computer)          — placeholder

--- 历史 (History) ---
◒ <task entries>                  — implemented

--- Footer ---
Model settings (collapsible)
User profile
```

---

## 1. New Chat (新建对话)

Status: **implemented**.

Opens a fresh task input screen. The user types a natural-language goal, selects
a workspace, and submits. The core runtime routes the goal through Commander,
plans steps, dispatches agents, and streams snapshots back to the UI.

No further work needed for this item.

---

## 2. Automated Tasks (自动任务)

### Purpose

Agent-created scheduled or triggered tasks. After a conversation with the agent,
the agent can produce an automation rule (e.g. "every day at 9am, check trending
topics and summarize"). That rule is persisted and executes automatically on
schedule without further user input.

### Data Model

New file: `apps/desktop/src/scheduled-tasks.ts`.

```typescript
export interface ScheduledTask {
  id: string;
  name: string;             // display name, e.g. "Daily trending topics"
  goal: string;             // the exact prompt submitted to the runtime
  workspacePath: string;    // workspace context for execution
  schedule: ScheduleSpec;
  enabled: boolean;
  lastRunAt?: string;       // ISO timestamp — set after completion
  lastRunStartedAt?: string;// ISO timestamp — set on trigger, cleared on
                            // complete/fail; prevents duplicate triggers
  nextRunAt: string;        // ISO timestamp
  createdAt: string;
  source: "agent" | "user"; // who created this task ("user" creation UI is
                            // deferred to a follow-up phase)
}

export interface ScheduleSpec {
  type: "interval" | "daily" | "weekly" | "once";
  // interval: milliseconds between runs (stored as string for JSON
  //   compatibility; parsed with Number(value) at runtime)
  // daily: time of day "HH:MM"
  // weekly: day of week + time "Mon 09:00"
  // once: ISO timestamp for single execution
  value: string;
}
```

**"once" type lifecycle**: After a "once" task fires (successfully or after
crash recovery), `enabled` is set to `false` and `nextRunAt` is left unchanged
(it holds the original fire time). `computeNextRun()` returns `null` for
"once" tasks — the caller checks for `null` and disables the task. The sidebar
badge and management panel exclude disabled "once" tasks from the active count.
On app startup, crash recovery clears `lastRunStartedAt` for all tasks
including "once", giving them a second chance if the app crashed mid-execution.

Storage: `localStorage` key `javis.scheduledTasks.v1`. Same envelope pattern as
task history: `{ version: 1, tasks: ScheduledTask[] }`.

`PendingScheduledTask` type (used in Phase 4 agent integration):

```typescript
// Attached to AgentSnapshot when the agent proposes a scheduled task.
// Mirrors ScheduledTask minus the fields the frontend fills in (id, timestamps,
// enabled, source).
export interface PendingScheduledTask {
  name: string;
  goal: string;
  workspacePath: string;
  schedule: ScheduleSpec;
}
```

**Tech-debt note**: localStorage is acceptable for the initial implementation,
but scheduled tasks are a natural candidate for SQLite when the persistence
layer is upgraded (see `docs/IMPROVEMENT_PLAN.md` Phase 2.3). The envelope
pattern with a version key makes migration straightforward.

### Trigger Mechanism

Implemented entirely in the frontend layer. No new Rust commands required.

`App.tsx` maintains an `isTaskActive: boolean` state. It is set to `true` when
`onSubmitGoal()` is called, and reset to `false` via an `onTaskComplete`
callback passed to the runtime (fires when the task reaches a terminal status:
`completed`, `failed`, or `cancelled`).

1. **App startup**: clear `lastRunStartedAt` on all tasks (stale guard
   recovery after a crash or unclean exit), then check all tasks where
   `nextRunAt <= now`.
2. **`setInterval` (60s)**: periodic check for due tasks.
3. **`window.focus` event**: re-check after sleep/hibernate recovery.
4. When a task is due:
   - Check `isTaskActive`. If `true`, defer the scheduled task (poll on next
     interval). If `false`, proceed.
   - Set a `lastRunStartedAt` guard so the same task is not re-triggered while
     a previous run is still in progress.
   - Set `draftGoal` to the task's `goal` string.
   - Set `workspacePath` to the task's `workspacePath`.
   - Call `onSubmitGoal(goal, workspacePath, task.id)` — the third argument is
     the `scheduledTaskId`, carried through to the task history entry on
     completion so that "Last run" status can be derived.
   - Update `lastRunAt` and compute the next `nextRunAt`.
   - Clear `lastRunStartedAt`.
   - Re-save to localStorage.

**Crash recovery**: `lastRunStartedAt` is cleared unconditionally on app
startup. If the app crashed mid-task, the stale guard is removed and the
task will fire again on its next scheduled window. The worst case is a
duplicate run, which is far preferable to permanent silence. A heartbeat
mechanism (Phase 2) can make this more precise, but startup clearing is
sufficient for Phase 1.

**Background tab limitation**: `setInterval` is throttled by the browser
in background tabs (~1/minute minimum), which can cause up to 2-minute
drift when combined with the 60s interval. The `window.focus` event partially
mitigates this. In Phase 2, consider using `tauri::async_runtime::spawn` with
`tokio::time::interval` on the Rust side for a more reliable timer that is not
subject to browser throttling.

**Limitation**: Javis currently uses a single-task architecture (one
`TaskRuntime` runs one task at a time). If a manual task is in progress when a
scheduled task fires, the scheduled task is deferred — it does not queue or
interrupt. This behaviour should be documented in the UI and revisited once
multi-task support (`IMPROVEMENT_PLAN.md` Phase 3.4) is implemented.

### Agent Creation Flow

The agent creates a scheduled task by returning a structured JSON block in its
final response snapshot. The data flow is:

1. Commander prompt is extended with a system instruction: "When the user asks
   you to automate a recurring task, output a `<scheduled_task>` XML block
   containing a JSON payload..."
2. The agent wraps the JSON in an XML tag so it can be reliably extracted from
   free-text streaming output.
3. `TaskRuntime` (in `packages/core/src/index.ts`) parses the completed
   Commander snapshot text. When it finds a `<scheduled_task>...</scheduled_task>`
   block, it attaches a `pendingScheduledTask` field to the final
   `AgentSnapshot`.
4. The UI layer (`JavisWorkbench`) checks `task.snapshots[task.snapshots.length - 1]`
   for a `pendingScheduledTask` field. If present, it renders a confirmation
   card (similar to the permission-request card pattern).
5. On user approval, the frontend persists the task to localStorage and dismisses
   the card. On denial, the block is discarded.

Agent output format (embedded in Commander snapshot text):

```xml
<scheduled_task>
{
  "name": "Daily trending topics",
  "goal": "Search today's trending topics and summarize the top 5",
  "workspacePath": "<current workspace path>",
  "schedule": { "type": "daily", "value": "09:00" }
}
</scheduled_task>
```

The `workspacePath` field is set by the agent to the workspace it was working in
when the user made the request. If the agent does not specify a workspace, the
frontend defaults to the current `workspacePath` from the active task.

### UI

**Sidebar item**: shows count of enabled scheduled tasks as a badge (excludes
disabled tasks and fired "once" tasks). If count is 0, no badge is shown.
Clicking switches the main area to the scheduled tasks management panel.

**Main area panel**:
- List of all scheduled tasks with: name, schedule description, next run time,
  enabled toggle, delete button.
- "Last run" status for each task, derived as follows:
  - **"running"**: `isTaskActive === true` AND the active task was started with
    a `scheduledTaskId` matching this task's `id`.
  - **"success"**: the latest history entry with `scheduledTaskId === task.id`
    has `status === "completed"`.
  - **"failed"**: the latest history entry with `scheduledTaskId === task.id`
    has `status === "failed"` or `"cancelled"`.
  - **"never"**: no matching history entry exists and no active task matches.
- Click a task → view its run history. Each task history entry stores the
  `scheduledTaskId` that triggered it (added as an optional field to the
  history entry model: `scheduledTaskId?: string`). Filtering is by ID match,
  not by goal string comparison.

**Data flow for `scheduledTaskId`**: When a scheduled task fires, it calls
`onSubmitGoal(goal, workspacePath, scheduledTaskId)`. The `onSubmitGoal`
signature is extended from `() => void` to `(goal?: string, workspacePath?:
string, scheduledTaskId?: string) => void`. When `scheduledTaskId` is
provided, it is attached to the created task's metadata and persisted to the
history entry on task completion via the existing `onTaskComplete` pathway.

### Implementation Steps

1. Create `apps/desktop/src/scheduled-tasks.ts` — CRUD + persistence +
   `isDue()` check + `computeNextRun()` (returns `string | null`; returns
   `null` for `"once"` type, signalling the caller to set `enabled = false`).
2. In `App.tsx`:
   - Add `isTaskActive: boolean` state.
   - Extend `onSubmitGoal` signature to accept optional `scheduledTaskId`.
   - Add `useEffect` with `setInterval` and `focus` listener that calls
     `checkDueScheduledTasks(isTaskActive, scheduledTasks, onSubmitGoal)`.
   - Add `onTaskComplete` callback that sets `isTaskActive = false`.
3. Add `ScheduledTask[]` state (the unwrapped tasks array from the envelope
   `{ version: 1, tasks: ScheduledTask[] }`). Load envelope on mount, unwrap
   into state, re-wrap on save.
4. Add sidebar badge count and click handler to switch `activeView`.
5. Add main area rendering for the scheduled tasks management panel.
6. Extend `JavisWorkbench` props with `scheduledTasks`, `isTaskActive`, and
   `onToggleScheduledTask`, `onDeleteScheduledTask` callbacks.
7. Add locale strings for both zh-CN and en-US.

---

## 3. Skill Market (技能广场)

### Purpose

A read-only registry showing all capabilities available to the agent system:
built-in tool descriptors, agent roles, and (optionally) configured MCP servers.
Users browse this to understand what Javis can do.

### Data Sources

Most data already exists in the codebase. The MCP config file requires two new
Tauri commands (`read_mcp_config` and `write_mcp_config`) to read and write the
platform-specific config file (see MCP Config Scanning section below).

| Source | Location | Content |
|--------|----------|---------|
| Tool descriptors | `packages/tools/src/descriptors.ts:3` `initialToolDescriptors` | 10 tool entries with name, permission level, summary |
| Agent definitions | `packages/core/src/agents.ts` `demoAgents` | 6 agents with kind, displayName, description, allowedToolNames |
| MCP config (optional) | `dirs::config_dir()/javis/mcp.json` (cross-platform, see MCP Config Scanning section) | User-configured MCP server definitions |

### Data Model

No new types needed. Compose from existing interfaces at render time:

```typescript
// Computed view model
interface SkillEntry {
  id: string;
  name: string;
  description: string;
  category: "tool" | "agent" | "mcp";
  // permissionLevel is only meaningful when category === "tool".
  // For "agent" and "mcp" entries, it is undefined.
  permissionLevel?: "read" | "preview" | "confirmed_write" | "dangerous";
  // agentOwners is only meaningful when category === "tool".
  // For "agent" and "mcp" entries, it is an empty array.
  agentOwners: string[];
  enabled: boolean;         // always true for built-in tools and agents;
                            // toggleable for MCP servers
}
```

### MCP Config Scanning

New function in `apps/desktop/src/mcp-config.ts`:

```typescript
export interface McpServerConfig {
  name: string;
  transport: "stdio" | "sse";
  command?: string;         // for stdio
  url?: string;             // for sse
  args?: string[];
  enabled: boolean;
}

export async function loadMcpConfig(): Promise<McpServerConfig[]>
export async function saveMcpConfig(config: McpServerConfig[]): Promise<void>
```

Reads from the platform-appropriate config directory via the `dirs` crate
(`dirs::config_dir()` — resolves to `%APPDATA%/javis/mcp.json` on Windows,
`~/Library/Application Support/javis/mcp.json` on macOS,
`$XDG_CONFIG_HOME/javis/mcp.json` on Linux). Add `dirs` (or `dirs-next`)
as a Cargo dependency (~5 KB).

A corresponding `write_mcp_config(json: String)` Tauri command (also ~15 lines
Rust) writes the full config file. This enables the "Add MCP Server" button in
the UI to actually persist changes. Both commands operate on the same file path
resolved by `dirs::config_dir()`.

Rust signatures:
- `read_mcp_config() -> Result<Option<String>, String>` — returns `Ok(None)`
  when the config file does not exist; `Ok(Some(json))` with the raw file
  content; `Err(...)` on IO errors other than file-not-found.
- `write_mcp_config(json: String) -> Result<(), String>` — overwrites the
  config file; creates parent directories if they don't exist.

The TypeScript `loadMcpConfig()` wrapper converts `Ok(None)` to an empty array
and `Ok(Some(json))` to `JSON.parse(json)` validated against the
`McpServerConfig[]` shape.

### UI

**Sidebar item**: shows total skill count as a badge (built-in tools + agents +
MCP servers). The count may update asynchronously when MCP config finishes
loading. No badge is shown if the count is 0 (not expected in practice since
built-in entries always exist).

**Main area panel**:
- Three sections: Tools, Agents, MCP Servers.
- Each entry is a card showing: name, description, permission level chip
  (color-coded: green=read, yellow=preview, orange=write, red=dangerous),
  and the agents that own it (for tools, shown as agent name chips).
- MCP section has an enable/disable toggle per server and an "Add MCP Server"
  button (opens a form or directs to config file).
- Search/filter bar at the top.

### Implementation Steps

1. Create `apps/desktop/src/mcp-config.ts` — `loadMcpConfig()` and
   `saveMcpConfig(config: McpServerConfig[])`.
2. Add Rust commands:
   - `read_mcp_config` (~15 lines): read file from `dirs::config_dir()`,
     return `Result<Option<String>, String>`.
   - `write_mcp_config(json: String)` (~15 lines): write to
     `dirs::config_dir()`, return `Result<(), String>`.
3. Register both in `invoke_handler`.
4. In `App.tsx` — load MCP config on mount, compose `SkillEntry[]` from
   tool descriptors + agents + MCP config.
5. Pass `skills` prop to `JavisWorkbench`.
6. Add main area rendering for skill cards, wire "Add MCP Server" form to
   `saveMcpConfig`.
7. Add locale strings.

---

## 4. Local Knowledge Base (本地知识库)

This section has four sub-items that share a common Rust scanning
infrastructure.

### Shared Rust Infrastructure

New helper function in `apps/desktop/src-tauri/src/lib.rs`:

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
    size_bytes: Option<u64>,
    modified_at: Option<String>,
    extension: Option<String>,
}

fn collect_files(
    roots: &[PathBuf],
    extensions: &[&str],
    max_results: usize,
    recursive: bool,
) -> Result<Vec<FileEntry>, String>
```

This function:
- Iterates `roots` directories.
- Filters by `extensions` (case-insensitive). Empty `extensions` means all files.
- If `recursive`, descends into subdirectories (skipping `node_modules`,
  `.git`, `target`, `__pycache__`, `.venv`, `AppData`, `$RECYCLE.BIN`,
  `System Volume Information`, `.cache`, `.cargo`, `.rustup`, `Code`,
  `scoop`, `choco`).
- Stops at `max_results` entries.
- Returns sorted by `modified_at` descending.

Each sub-feature calls `collect_files` with different parameters, except
`scan_installed_apps` which has its own scanning logic (Start Menu `.lnk`
traversal with `mslnk` resolution) and returns `AppEntry` instead of
`FileEntry`.

---

### 4a. Apps (应用)

#### Purpose

Show installed desktop applications on this computer. Provides a quick launcher
view of what's available.

#### Rust Command

```rust
#[tauri::command]
fn scan_installed_apps() -> Result<Vec<AppEntry>, String>
```

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppEntry {
    name: String,
    path: String,           // executable or shortcut path
    icon_path: Option<String>,
    publisher: Option<String>,
    install_location: Option<String>,
}
```

Scanning strategy (Windows; on macOS/Linux, return an empty array — the command
is a no-op on non-Windows platforms):

1. **Start Menu shortcuts** (primary):
   - `C:\ProgramData\Microsoft\Windows\Start Menu\Programs` (all users)
   - `%APPDATA%\Microsoft\Windows\Start Menu\Programs` (current user)
   - Recursively find all `.lnk` files.
   - Extract target name from filename (strip `.lnk` extension).

2. **Desktop shortcuts** (secondary):
   - `%USERPROFILE%\Desktop`
   - `%PUBLIC%\Desktop`
   - Find `.lnk` files.

3. **UWP apps** (optional, Phase 2):
   - Use PowerShell `Get-StartApps` to list UWP/Store apps.

Deduplication: normalize names to lowercase, keep first occurrence.

**Phase 1 shortcut resolution**: Resolve `.lnk` targets to their executable
paths. On Windows, use `std::fs::read_link` (which resolves `.lnk` symlinks)
or the `mslnk` crate for full shortcut parsing. Without this resolution,
`AppEntry.path` holds the `.lnk` path rather than the executable, and the
"click to open" feature in the UI will not work correctly. The `mslnk` crate
adds minimal binary size (~50 KB) and is the recommended approach.

#### UI

**Sidebar item**: no badge (data requires async scan; showing "0" before scan
is misleading). Badge could be added in Phase 2 as a post-scan count.

Sidebar item click → main area shows:
- Grid or list of app cards: name, icon placeholder, publisher.
- Search/filter bar.
- Click an app → open via Tauri `opener` plugin (`tauri_plugin_opener`).

---

### 4b. Documents (文档)

#### Purpose

Index all document files across common user directories. Provides a unified
document search that the agent can also reference during tasks.

#### Rust Command

```rust
#[tauri::command]
fn scan_user_documents(
    extensions: Option<Vec<String>>,
    max_results: Option<usize>,
) -> Result<Vec<FileEntry>, String>
```

Default scan (when parameters are `None`/omitted from the frontend):
- Roots: `Desktop`, `Documents`, `Downloads` under `USERPROFILE`.
- Extensions: `docx`, `doc`, `txt`, `pdf`, `xlsx`, `xls`, `csv`, `pptx`,
  `ppt`, `md`, `rtf`, `odt`.
- Max results: 200.
- Recursive: true (with skip list).

Returns `FileEntry` (shared struct above). The Rust command applies defaults
when `extensions` is `None` or `max_results` is `None`, so the frontend can
call `invoke('scan_user_documents')` with no arguments for the default scan.

#### UI

**Sidebar item**: no badge (same rationale as Apps — data requires async scan).

Sidebar item click → main area shows:
- Table or list: file name, extension icon, size, modified date, full path.
- Filter chips by extension type (Documents, Spreadsheets, PDFs, Text).
- Search bar (filter by filename).
- Click a file → open via `tauri_plugin_opener`.

---

### 4c. Gallery (图库)

#### Purpose

Index image files for quick visual browsing.

#### Rust Command

```rust
#[tauri::command]
fn scan_user_images(
    max_results: Option<usize>,
) -> Result<Vec<FileEntry>, String>
```

Default scan (when `max_results` is `None`/omitted from the frontend):
- Roots: `Desktop`, `Documents`, `Pictures`, `Downloads` under `USERPROFILE`.
- Extensions: `jpg`, `jpeg`, `png`, `gif`, `bmp`, `webp`, `svg`, `ico`.
- Max results: 200.
- Recursive: true.

The Rust command applies the default `max_results` when `None` is passed, so
the frontend can call `invoke('scan_user_images')` with no arguments.

Optional Phase 2 enhancement: read image dimensions via the `image` crate
(adds ~2MB to binary size, defer if binary size is a concern).

#### UI

**Sidebar item**: no badge (same rationale as Apps — data requires async scan).

Sidebar item click → main area shows:
- Thumbnail grid with virtual scrolling (required — 200 images will freeze the
  DOM if all are rendered simultaneously).
- Hover shows: file name, size, dimensions (if available).
- Click → open in system default viewer.
- Filter by extension.

---

### 4d. This Computer (此电脑)

#### Purpose

A simple file explorer. Browse the local filesystem starting from the user's
home directory or a configurable root.

#### Rust Command

```rust
#[tauri::command]
fn list_directory(path: String) -> Result<Vec<FileEntry>, String>
```

- Lists direct children of `path` (non-recursive).
- Returns `FileEntry` with all fields populated.
- For directories: `size_bytes` is `None`, `extension` is `None`.
- Sort: directories first, then files, both alphabetical.

Security: validate that `path` exists and is a directory. Limit the initial
root to `USERPROFILE` and block navigation into system directories
(`C:\Windows`, `C:\Program Files`, `C:\$Recycle.Bin`, `C:\System Volume
Information`) to prevent accidental browsing of OS internals. Users who need
full-drive access can configure the root in a future settings panel.

#### UI

**Sidebar item**: no badge (data changes on every navigation — count is
meaningless).

Sidebar item click → main area shows:
- Breadcrumb path bar at the top.
- File/folder list: icon (folder/file), name, size, modified date.
- Click a directory → navigate into it (update breadcrumb, re-invoke
  `list_directory`).
- Click a file → open via `tauri_plugin_opener`.
- ".." entry to go up one level.

---

## 5. History (历史)

Status: **implemented**.

Shows completed, failed, and cancelled task snapshots. Entries are persisted to
`localStorage` key `javis.taskHistory.v1` with a 20-entry limit. Clicking an
entry restores the full task view. Each entry has a delete button.

The sidebar search box filters history entries by title match.

**Sidebar search box behavior by active view**:

| Active View | Search box behavior |
|-------------|---------------------|
| Chat (New Chat / task running) | Filters history entries (existing behaviour) |
| Automated Tasks | Filters scheduled tasks by name |
| Skill Market | Filters skill entries by name/description |
| Apps | Delegates to `AppsView` local search bar; sidebar search is hidden |
| Documents | Delegates to `DocumentsView` local search bar; sidebar search is hidden |
| Gallery | Delegates to `GalleryView` local filter bar; sidebar search is hidden |
| Computer | No search (file explorer uses breadcrumb navigation) |

Views with their own local search/filter bar hide the sidebar search box to
avoid confusion between two search inputs.

No further work needed for this item.

---

## Implementation Phases

### Phase 1: Rust Scanning Commands

Add six new Tauri commands and the shared `collect_files` helper.

Files changed:
- `apps/desktop/src-tauri/src/lib.rs` — ~250 lines added:
  - `FileEntry` struct.
  - `collect_files()` helper.
  - `scan_installed_apps()`.
  - `scan_user_documents()`.
  - `scan_user_images()`.
  - `list_directory()`.
  - `read_mcp_config()`.
  - `write_mcp_config(json: String)`.
  - Register all six in `invoke_handler`.

New crate dependencies for Phase 1:
- `mslnk` (~50 KB) — resolve `.lnk` shortcut targets for `scan_installed_apps`.
- `dirs` (or `dirs-next`, ~5 KB) — cross-platform config path resolution for
  `read_mcp_config`.

Plugin dependency: `tauri_plugin_opener` must be added to `Cargo.toml` and
registered in `tauri::Builder` if not already present. This plugin is required
for opening files and applications from the UI (used by all four local
knowledge base features).

### Phase 2: Frontend Data Layer

Add TypeScript modules for invoking the new commands and managing state.

Files changed:
- `apps/desktop/src/App.tsx` — add state and invoke calls for each scanner.
- New file: `apps/desktop/src/scheduled-tasks.ts` — CRUD + scheduling logic.
- New file: `apps/desktop/src/mcp-config.ts` — MCP config reader.
- New file (optional): `apps/desktop/src/local-knowledge.ts` — shared
  `FileEntry` type and invoke wrappers for the three `collect_files`-based
  scan commands (`scan_user_documents`, `scan_user_images`, `list_directory`).
  `scan_installed_apps` has its own return type (`AppEntry`) and is handled
  separately.

### Phase 3: UI Rendering

Update the workbench to support multiple views.

**Architecture**: `activeView` state lives in `JavisWorkbench` (the component
that owns both `<Sidebar>` and `<main>`). Each sub-component receives
data-fetching callbacks from `App.tsx` via `JavisWorkbench` props, and calls
them lazily on mount (not eagerly). The Sidebar receives `activeView` and view
data (badge counts, search visibility) as props.

**UI state requirements**: Every view must handle three states explicitly:

| State | Apps | Documents | Gallery | Computer | Skills | Scheduled Tasks |
|-------|-------|-----------|---------|----------|--------|-----------------|
| **Loading** | Spinner + `scanInProgress` locale | Same | Skeleton grid (8 placeholder tiles) | Spinner | N/A (data is local) | N/A (data is local) |
| **Empty** | "No applications found" | "No documents found" | "No images found" | `fileExplorerEmpty` locale | N/A (always has built-in entries) | "No scheduled tasks" + create hint |
| **Error** | Inline error banner with Rust `Err` message + retry button | Same | Same | Inline error banner | N/A | N/A |

Missing locale keys to add: `noAppsFound`, `noDocumentsFound`, `noImagesFound`,
`noScheduledTasks`, `scanFailed`, `retry`.

These states should be rendered by each per-view sub-component (see Architectural
note above), not by a centralized error boundary in `JavisWorkbench`.

**Architectural note**: This phase introduces an `activeView` state that switches
the main area between fundamentally different layouts (chat, scheduled tasks,
skill market, apps, documents, gallery, file explorer). This effectively turns
the workbench into a view router — a significant architectural change to a
component that was originally designed as a single-view layout.

**Hard requirement**: The main area rendering MUST be split into per-view
sub-components (`ChatView`, `ScheduledTasksView`, `SkillMarketView`,
`AppsView`, `DocumentsView`, `GalleryView`, `ComputerView`). Each sub-component
owns its own loading/empty/error state rendering and calls its data-fetching
callback on mount. The `JavisWorkbench` component routes `activeView` to the
correct sub-component and passes only the props relevant to that view. Without
this split, the props interface will exceed 40+ fields and the conditional
rendering block will be unmaintainable.

Files changed:
- `packages/ui/src/JavisWorkbench.tsx`:
  - Add `activeView` state: `"chat" | "automated" | "skills" | "apps" |
    "documents" | "gallery" | "computer"`.
  - Replace the existing `{isNewChat ? <NewChat/> : <ThreadView/>}` ternary
    with a view router: `{activeView === "chat" && (isNewChat ? <ChatView
    newChat/> : <ChatView task/>)} {activeView === "automated" &&
    <ScheduledTasksView/>}` etc.
  - `JavisWorkbench` serves as a passthrough layer — it receives data and
    callbacks from `App.tsx` and routes them to the active sub-component.
- `packages/ui/src/components/Sidebar.tsx`:
  - Accept new props: `activeView`, `scheduledTaskCount`, `skillCount`,
    `onChangeActiveView`.
  - Sidebar click handlers call `onChangeActiveView(view)` instead of being
    hardcoded.
  - Conditionally render the search box based on the `activeView` search
    behavior table (Section 5).
  - Display badge counts per the rules defined in each view's UI section.
- New files (one per view, under `packages/ui/src/components/`):
  - `ChatView.tsx` — existing chat UI (`NewChat` and `ThreadView`), extracted
    from `JavisWorkbench`.
  - `ScheduledTasksView.tsx` — scheduled task management panel.
  - `SkillMarketView.tsx` — skill cards (Tools, Agents, MCP Servers).
  - `AppsView.tsx` — installed applications grid.
  - `DocumentsView.tsx` — document table with filter chips.
  - `GalleryView.tsx` — thumbnail grid with virtual scrolling (use
    `react-window` FixedSizeGrid or `react-virtuoso` for the implementation).
  - `ComputerView.tsx` — file explorer with breadcrumb navigation.
- Each sub-component receives only the props it needs (not the full
  `JavisWorkbench` props union).
- `packages/ui/src/index.tsx` — add exports for new sub-components.
- `packages/ui/src/locale.ts` — add locale strings for both
  `zhCNWorkbenchLocale` and `enUSWorkbenchLocale`.

### Phase 4: Agent Integration

Wire automated task creation into the agent conversation flow, following the
data flow specified in Section 2 (Agent Creation Flow).

Files changed:
- `packages/core/src/index.ts` — extend Commander prompt with the
  `<scheduled_task>` XML block instruction. Add parsing logic to
  `TaskRuntime`: scan the final Commander snapshot text for
  `<scheduled_task>...</scheduled_task>`, parse the inner JSON, and attach a
  `pendingScheduledTask` field to the `AgentSnapshot`. Export the
  `PendingScheduledTask` type.
- `packages/core/src/index.ts` types — add `pendingScheduledTask?:
  PendingScheduledTask` to `AgentSnapshot`.
- `apps/desktop/src/App.tsx` — after task completion, check the final snapshot
  for `pendingScheduledTask`. If present, render a confirmation card.
  On approval: persist via `scheduled-tasks.ts` CRUD. On denial: discard.
- `packages/ui/src/components/ScheduledTaskConfirmCard.tsx` — confirmation
  card component (name, goal, schedule summary, approve/deny buttons).
  Reuses the visual pattern from the existing permission-request card.

---

## Rust Command Registration

Final `invoke_handler` after all phases:

```rust
.invoke_handler(tauri::generate_handler![
    // existing
    scan_markdown_documents,
    run_read_only_command,
    fetch_web_source,
    search_web_sources,
    inspect_project,
    save_model_api_key_secret,
    delete_model_api_key_secret,
    propose_code_edit,
    approve_code_patch,
    apply_code_patch,
    plan_pdf_organization,
    approve_pdf_organization,
    restore_pdf_organization_approval,
    execute_pdf_organization,
    // new — Phase 1
    scan_installed_apps,
    scan_user_documents,
    scan_user_images,
    list_directory,
    read_mcp_config,
    write_mcp_config,
])
```

---

## Key Implementation Notes

1. **Crate dependencies for Phase 1.** `mslnk` (~50 KB) for `.lnk` shortcut
   resolution and `dirs`/`dirs-next` (~5 KB) for cross-platform config path
   resolution. All other filesystem scanning uses `std::fs` which is already
   available. The skip-list (Section 4 Shared Rust Infrastructure) prevents
   deep scans of dependency directories.

2. **Scan performance.** Recursive scans of `Documents` and `Downloads` can be
   slow on large directories. Mitigations:
   - Skip known-heavy directories (`node_modules`, `.git`, `target`,
     `__pycache__`, `.venv`, `AppData`, `$RECYCLE.BIN`,
     `System Volume Information`, `.cache`, `.cargo`, `.rustup`, `Code`,
     `scoop`, `choco`).
   - Enforce `max_results` cap (default 200).
   - Run scans asynchronously via `tokio::spawn` or `tauri::async_runtime`.
   - Cache results in app state with a TTL (e.g. 5 minutes).
   - Note: Documents and Gallery both scan `Desktop`, `Documents`, and
     `Downloads`. The cache TTL prevents redundant re-scans when the user
     switches between these views within the TTL window.

3. **Thumbnail rendering for Gallery.** Prefer Tauri's `convertFileSrc()` to
   produce `asset://` URLs over raw `file://` paths. If `file://` must be used,
   restrict it via a targeted CSP directive (`img-src file://`) rather than
   setting the entire CSP to `null`. Virtual scrolling is required (see Gallery
   UI section) — do not render all 200 thumbnails simultaneously.

4. **File explorer navigation state.** The current path for "This Computer"
   should be stored in React state, not passed as a prop. Reset to
   `USERPROFILE` when the sidebar item is clicked.

5. **Scan request lifecycle.** Each view that triggers a scan (Apps, Documents,
   Gallery) must implement an abort-and-discard pattern:
   - When `activeView` changes away from a scanning view, abort any in-flight
     Tauri invoke (using an `AbortController` or a generation counter).
   - When a scan result arrives for a view the user has already navigated away
     from, discard the result (stale state).
   - When the same view is re-entered within the cache TTL (see Note 2), serve
     cached results without re-scanning.
   - Without this, rapid sidebar clicks will pile up parallel scan operations
     and stale results will overwrite the current view's state.

7. **Automated task execution isolation.** When a scheduled task fires while no
   other task is running, it creates a new task via `onSubmitGoal()`. If a task
   is already running, the scheduled execution is deferred to the next interval
   check. The `lastRunStartedAt` guard prevents duplicate triggers. Concurrent
   task execution is deferred to multi-task support (`IMPROVEMENT_PLAN.md`
   Phase 3.4).

8. **MCP config location.** Use `dirs::config_dir()` (from the `dirs` crate)
   for cross-platform config path resolution (see Section 3 MCP Config Scanning).

---

## Error Handling

Each new Rust command must define its error behaviour before implementation:

| Command | Error condition | Behaviour |
|---------|----------------|-----------|
| `scan_installed_apps` | Running on non-Windows platform | Return empty array (no-op) |
| `scan_installed_apps` | Start Menu / Desktop directories not found | Return empty array, log warning to console |
| `scan_installed_apps` | Permission denied on a subdirectory | Skip that directory, continue with remaining |
| `scan_user_documents` | Root directory (Desktop/Documents/Downloads) missing | Return empty array with an error message string |
| `scan_user_documents` | Recursive scan hits permission error | Skip that subtree, continue scan |
| `scan_user_images` | Same as documents | Same behaviour |
| `list_directory` | Path does not exist | Return `Err("Path not found: {path}")` |
| `list_directory` | Path is a file, not a directory | Return `Err("Path is not a directory: {path}")` |
| `list_directory` | Permission denied | Return `Err("Permission denied: {path}")` |
| `read_mcp_config` | Config file does not exist | Return `Ok(None)` |
| `read_mcp_config` | Config file has invalid JSON | Return `Err("Invalid MCP config JSON: {detail}")` |
| `write_mcp_config` | Config directory cannot be created | Return `Err("Cannot create config directory: {path}")` |
| `write_mcp_config` | Write permission denied | Return `Err("Cannot write MCP config: {detail}")` |

General rules:
- Read-only scans should degrade gracefully — return whatever they can find.
- Never panic or crash on filesystem errors.
- Permission errors on individual files or subdirectories are skipped, not
  surfaced as command-level failures.
- Structural errors (path not found, not a directory) become `Err(String)` that
  the frontend can display inline.

---

## Tool Descriptor Registration

The four new scanning features must be registered as tool descriptors so the
permission system and skill market can discover them:

```typescript
// Add to packages/tools/src/descriptors.ts initialToolDescriptors:
{ name: "file.scanInstalledApps",    permissionLevel: "read", summary: "..." },
{ name: "file.scanUserDocuments",    permissionLevel: "read", summary: "..." },
{ name: "file.scanUserImages",       permissionLevel: "read", summary: "..." },
{ name: "file.listDirectory",        permissionLevel: "read", summary: "..." },
```

All four are `read` level — they do not modify the filesystem. No confirmed-write
approval is needed.

**Agent assignment**: `file.scanUserDocuments` is assigned to the File Agent
(append to `agent-file.allowedToolNames`) so the agent can reference documents
during tasks. The other three (`file.scanInstalledApps`, `file.scanUserImages`,
`file.listDirectory`) are **UI-only** — they are triggered exclusively by the
user clicking sidebar items, never by agents. The Skill Market displays them with
an empty `agentOwners` array and a "UI feature" label instead of agent name chips.

The skill market (Section 3) should display these alongside the existing 10
tools, bringing the total to 14.

---

## Locale Keys to Add

Both `zhCNWorkbenchLocale` and `enUSWorkbenchLocale` need these new keys:

```typescript
// zh-CN
automatedTasksTitle: "自动任务管理",
scheduledTaskEnabled: "已启用",
scheduledTaskDisabled: "已禁用",
scheduledTaskNextRun: "下次运行",
scheduledTaskLastRun: "上次运行",
skillMarketTitle: "技能广场",
skillCategoryTool: "工具",
skillCategoryAgent: "智能体",
skillCategoryMcp: "MCP 服务",
noMcpConfig: "暂无 MCP 配置",
skillUiFeatureLabel: "界面功能",
appsTitle: "已安装应用",
documentsTitle: "文档检索",
galleryTitle: "图库",
computerTitle: "文件浏览",
fileExplorerBreadcrumb: "路径",
fileExplorerEmpty: "此文件夹为空",
scanInProgress: "扫描中...",
scanComplete: "扫描完成",
noAppsFound: "未找到已安装应用",
noDocumentsFound: "未找到文档",
noImagesFound: "未找到图片",
noScheduledTasks: "暂无自动任务",
scanFailed: "扫描失败",
retry: "重试",

// en-US
automatedTasksTitle: "Automated Tasks",
scheduledTaskEnabled: "Enabled",
scheduledTaskDisabled: "Disabled",
scheduledTaskNextRun: "Next run",
scheduledTaskLastRun: "Last run",
skillMarketTitle: "Skill Market",
skillCategoryTool: "Tool",
skillCategoryAgent: "Agent",
skillCategoryMcp: "MCP Server",
noMcpConfig: "No MCP servers configured",
skillUiFeatureLabel: "UI feature",
appsTitle: "Installed Applications",
documentsTitle: "Document Search",
galleryTitle: "Gallery",
computerTitle: "File Explorer",
fileExplorerBreadcrumb: "Path",
fileExplorerEmpty: "This folder is empty",
scanInProgress: "Scanning...",
scanComplete: "Scan complete",
noAppsFound: "No applications found",
noDocumentsFound: "No documents found",
noImagesFound: "No images found",
noScheduledTasks: "No scheduled tasks",
scanFailed: "Scan failed",
retry: "Retry",
```
