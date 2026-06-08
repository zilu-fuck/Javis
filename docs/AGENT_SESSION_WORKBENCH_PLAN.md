# Javis Agent Session Workbench 技术方案

## 结论

Javis 右侧区域不应继续被理解为“详情页”。它应该升级为 **Agent Session Workbench**：一个绑定当前 Agent 会话、当前工作区和当前权限上下文的右侧工作台。

目标不是堆更多卡片，而是让用户在同一个会话里完成：

- 看当前项目文件
- 在当前项目里运行终端命令
- 查看和处理 Git diff
- 打开本地或网页目标并验证结果
- 让 Agent 的对话、工具、权限、审查共享同一个上下文

最终信息结构：

```txt
Javis Workbench
├─ Sidebar: 项目、历史线程、本地知识库入口
├─ Thread: 当前 Agent 对话、任务输入、权限确认
└─ AgentInspector: 当前 Agent Session 的右侧工作台
   ├─ SessionHeader
   ├─ ToolLauncherGrid
   ├─ FilesPanel
   ├─ BrowserPanel
   ├─ ReviewPanel
   └─ TerminalPanel
```

## 当前代码现状

### 已有可复用前端

| 能力 | 当前位置 | 现状 |
|---|---|---|
| 主工作台布局 | `packages/ui/src/JavisWorkbench.tsx` | 已支持 sidebar/main/inspector/activity 的布局与展开收起 |
| 右侧 Inspector | `packages/ui/src/components/InspectorPanel.tsx` | 已有 agent 列表、details、tool tabs、quick actions |
| 工具面板 | `packages/ui/src/components/WorkspaceToolPanels.tsx` | 已有 files/browser/review/terminal/sideChat 的 UI 雏形 |
| 工作区文件入口 | `packages/ui/src/components/ComputerView.tsx` 与 `scan::list_directory` 回调 | 可复用目录列表和打开文件 |
| 聊天输入框 | `packages/ui/src/components/ChatComposer.tsx` | 可复用于侧边聊天输入 |
| 任务状态 | `WorkbenchTask` 类型 | 已含 workspacePath、agents、logs、permissionRequest、codeReviewPreview 等信息 |

### 已有可复用后端

| 能力 | 当前位置 | 现状 |
|---|---|---|
| 工作区 session | `apps/desktop/src/workspace-session.ts` | 已保存 current workspace 和 recent workspaces |
| 目录读取 | `apps/desktop/src-tauri/src/scan.rs` | 已有 `list_directory`、文件扫描、用户文档/图片扫描 |
| 只读 shell | `apps/desktop/src-tauri/src/shell.rs` | 允许 `git status`、`git diff --stat`、`git diff --check` 等 allowlist 命令 |
| 浏览器 sidecar | `apps/desktop/src-tauri/src/browser.rs` | 已有 navigate/screenshot/getContent/click/type/evaluate/runTest/close |
| 权限流 | `permissionRequest`、approval records、code patch approvals | 可复用为终端写操作、Git stage/revert、browser interaction 的权限基础 |
| 数据库持久化 | `apps/desktop/src-tauri/src/database.rs` 与 session/audit persistence | 可复用保存 terminal sessions、browser state、review comments |

## 核心问题

当前右侧工具更像几个临时 quick action，而不是共享同一个 Agent 会话上下文。具体表现：

1. `InspectorPanel` 没有明确的 `AgentSessionContext`。
2. `WorkspaceToolPanels` 的工具 props 是分散回调，不知道 `sessionId / workspaceRoot / permissionMode / activeBranch`。
3. `ReviewPanel` 现在通过前端回调临时跑 `git status/diff`，还没有后端 `GitService`。
4. `TerminalPanel` 现在是 read-only command runner，不是项目 PTY。
5. `BrowserPanel` 有后端 sidecar，但右栏 iframe/截图/DOM/console 状态没有统一绑定。
6. 文件面板使用目录列表，但还没有 `rg` 搜索、watcher、文件变化状态。

### 当前必须先修的契约问题

这些问题会让右栏看起来已经有工具入口，但真实使用时容易失败。它们应放在 Phase 0，而不是等到 PTY 或 GitService 完成后再处理。

| 问题 | 影响 | 建议 |
|---|---|---|
| `App.tsx` 的 review quick action 使用 `git diff --unified=3`，但 `shell.rs` allowlist 目前只允许部分 git 命令 | 审查按钮可能直接失败 | 先统一为后端允许的参数，或在 `GitService` 里废弃临时 shell allowlist 调用 |
| `onQuickActionReview/onQuickActionTerminal` 传 `workspacePath: null` | 命令没有稳定 cwd，无法绑定当前项目 | 统一使用当前 workspaceRoot，没有工作区时禁用入口 |
| 侧边聊天直接调用 `complete_model_prompt`，但 Tauri 命令期望 `{ request: ... }` 包装 | 侧边聊天可能发起失败 | 复用 `model-provider.ts` 的调用方式，或修正 IPC 参数形状 |
| `browser.rs` 的 URL 校验拒绝 localhost/private IP | 无法复刻 Codex 里打开本地 dev server 的核心体验 | 增加 session-scoped local browser permission，只允许当前会话批准的本地地址 |
| iframe 页面和 Playwright sidecar 页面不是同一个浏览器状态 | 用户看到的页面和 Agent 读取的 DOM/截图可能不一致 | BrowserPanel 以 sidecar screenshot/DOM/console 为准，iframe 只做辅助预览 |
| 右栏组件里中文文案分散，部分文件可能出现编码显示问题 | UI 观感不稳定，后续维护困难 | 把工具文案收回 `locale.ts` 或统一常量文件，确保 UTF-8 |

## 设计原则

### 1. Session 优先

所有右侧工具都必须从同一个 session 读取上下文。

```ts
export interface AgentSessionContext {
  sessionId: string;
  threadId: string;
  taskId?: string;
  workspaceRoot: string;
  permissionMode: "read_only" | "confirmed_write" | "full_access";
  activeModel: string;
  activeBranch?: string;
  activeTool?: WorkbenchWorkspaceToolAction | null;
  selectedAgentId?: string;
}
```

工具调用不再只收 `command`、`url`、`path`，而是收：

```ts
{
  session: AgentSessionContext;
  input: ToolSpecificInput;
}
```

### 2. UI 只是服务状态的可视化

右栏工具不应该自己“猜”状态。它们应该展示服务层状态：

```txt
TerminalPanel  ← TerminalService session state
ReviewPanel    ← GitService working tree state
FilesPanel     ← FileService tree/search/watch state
BrowserPanel   ← BrowserService page state
```

### 3. 权限集中处理

所有可能修改本地环境的动作都走统一权限：

| 动作 | 权限 |
|---|---|
| 读文件、列目录、git diff、browser screenshot | read_only |
| terminal 运行只读命令 | read_only |
| terminal 任意命令、git stage、git revert、browser click/type | confirmed_write 或 full_access |
| 文件写入、删除、移动 | confirmed_write |

### 4. 先把当前项目跑顺，再做高级 Agent 自动化

最小可行目标不是“Agent 自主操作所有工具”，而是：

1. 用户打开右栏工具。
2. 工具默认绑定当前 workspace。
3. 用户和 Agent 都看到相同状态。
4. 后续 Agent 才能通过同一套 service 调用工具。

## 推荐技术栈

### Frontend

| 目标 | 推荐 |
|---|---|
| 基础 UI | 继续用 React + TypeScript |
| 右栏状态 | 先用 React state/context；复杂后再引入 Zustand |
| 终端显示 | `@xterm/xterm`、`@xterm/addon-fit`、`@xterm/addon-web-links` |
| 虚拟列表 | 继续用 `react-window` 展示大文件树、diff 文件列表 |
| diff 渲染 | 初期手写 line model；后续可引入 `diff2html` 或 Monaco diff |
| 图标 | 继续使用 `570Icons` SVG mask，避免混用图标体系 |

### Backend / Tauri

| 目标 | 推荐 |
|---|---|
| IPC | Tauri command + event streaming |
| 终端 PTY | Rust `portable-pty` |
| 文件 watch | Rust `notify` |
| 搜索 | 优先调用 `rg`；缺失时 fallback 到 Rust walk/search |
| Git | Rust service 调 `git` CLI，集中解析 stdout |
| 浏览器 | 继续复用当前 Playwright sidecar |
| 持久化 | SQLite 保存 session/tool state，JSONL 保存审计 |

### Rust dependencies 建议

```toml
[dependencies]
portable-pty = "0.8"
notify = "6"
ignore = "0.4"
shell-words = "1"
```

说明：

- `portable-pty` 用于 Windows PowerShell / macOS zsh / Linux bash。
- `notify` 用于文件变化 watcher。
- `ignore` 用于尊重 `.gitignore`，比自己遍历更稳。
- `shell-words` 用于解析命令时避免简单 split 的 bug。

## 目标架构

```txt
Frontend
  JavisWorkbench
    AgentInspector
      SessionHeader
      ToolLauncherGrid
      ToolTabs
      FilesPanel
      BrowserPanel
      ReviewPanel
      TerminalPanel

Bridge
  agentSession.getSnapshot
  files.*
  git.*
  browser.*
  terminal.*

Backend
  SessionManager
  FileService
  GitService
  BrowserService
  TerminalService
  PermissionService
```

### SessionManager

职责：

- 创建/恢复当前 Agent Session。
- 维护 `workspaceRoot`、`threadId`、`taskId`、`permissionMode`、`activeTool`。
- 汇总 Git、terminal、browser、files 的轻量状态，给右栏 header 展示。

建议接口：

```rust
#[tauri::command]
fn agent_session_snapshot(request: AgentSessionSnapshotRequest) -> Result<AgentSessionSnapshot, String>
```

```ts
interface AgentSessionSnapshot {
  sessionId: string;
  threadId: string;
  taskId?: string;
  workspaceRoot: string;
  permissionMode: PermissionMode;
  activeBranch?: string;
  gitDirtyCount: number;
  openTerminalIds: string[];
  browserUrl?: string;
  activeTool?: WorkbenchWorkspaceToolAction;
}
```

### FileService

复用现有：

- `scan::list_directory`
- `scan::read_file_chunk`
- `scan::read_image_data_url`
- `scan::scan_all_user_files`

新增：

```txt
files.search
files.watch_start
files.watch_stop
files.read_text
files.open_external
```

建议 Tauri commands：

```rust
files_list_tree({ sessionId, root, cursor, filter })
files_search({ sessionId, query, glob, maxResults })
files_read_text({ sessionId, path, range })
files_watch_start({ sessionId, root })
files_watch_stop({ sessionId })
```

事件：

```txt
files://changed
files://indexed
```

UI：

- 左侧/右侧文件树共享数据模型。
- 文件搜索输入默认用 `rg`。
- 点击文件可打开外部编辑器或未来内嵌只读预览。

### GitService

当前 `ReviewPanel` 的临时 git 命令应下沉到后端。

新增 `apps/desktop/src-tauri/src/git.rs`：

```rust
git_status({ sessionId, workspaceRoot })
git_diff({ sessionId, workspaceRoot, path?, staged? })
git_stage({ sessionId, workspaceRoot, paths })
git_unstage({ sessionId, workspaceRoot, paths })
git_revert({ sessionId, workspaceRoot, paths })
git_current_branch({ sessionId, workspaceRoot })
```

前端类型：

```ts
interface GitStatusSnapshot {
  workspaceRoot: string;
  branch?: string;
  ahead?: number;
  behind?: number;
  files: GitFileStatus[];
  diffStat: string;
}

interface GitFileStatus {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  additions?: number;
  deletions?: number;
}
```

UI：

- 文件列表：modified / added / deleted / renamed。
- diff view：按文件切换。
- inline comment：先本地内存态，后续可挂 PR/GitHub。
- stage/revert：必须走权限确认。

### TerminalService

这是最优先做的服务，因为价值高、边界清晰。

新增 `apps/desktop/src-tauri/src/terminal.rs`。

推荐模型：

```rust
TerminalManager {
  sessions: HashMap<TerminalId, TerminalSession>
}

TerminalSession {
  id: String,
  workspace_root: PathBuf,
  shell: ShellKind,
  permission_mode: PermissionMode,
  child: PtyChild,
  writer: PtyWriter,
}
```

Commands：

```rust
terminal_create({ sessionId, workspaceRoot, shell, cols, rows })
terminal_input({ terminalId, data })
terminal_resize({ terminalId, cols, rows })
terminal_kill({ terminalId })
terminal_list({ sessionId })
```

Events：

```txt
terminal://output
terminal://exit
terminal://error
```

前端：

- `TerminalPanel` 使用 `@xterm/xterm`。
- 打开 tab 时创建 terminal session。
- resize 跟随 panel 宽高。
- 输入通过 IPC 发给后端。

安全策略：

- `read_only` 模式下可以只允许当前 allowlist 命令，或者进入“受限 shell”。
- `confirmed_write` 模式下，首次非 allowlist 命令触发权限确认。
- `full_access` 模式下允许直接输入。
- 所有输入输出写 audit log，避免不可追踪。

### BrowserService

当前后端 `browser.rs` 已经比较接近目标，应继续复用。

已有：

```txt
browser_navigate
browser_screenshot
browser_get_content
browser_click
browser_type
browser_evaluate
browser_run_test
browser_close
```

需要增强：

- 每个 Agent session 绑定一个 browser state，而不是全局一个 browser。
- 前端 BrowserPanel 不只显示 iframe，还要显示 sidecar 的真实 URL/title/loadState。
- 支持 console logs、DOM outline、selected element。
- 支持本地站点发现，例如读取 Vite/Tauri dev server 端口或用户输入 localhost。

新增建议：

```rust
browser_snapshot({ sessionId })
browser_console_logs({ sessionId, since })
browser_dom_outline({ sessionId, selector? })
browser_set_viewport({ sessionId, width, height })
```

UI：

- 地址栏 + 当前 sidecar 状态。
- 截图预览作为真实浏览器状态，不要依赖 iframe 成功加载。
- iframe 只作为可视化辅助；对 Agent 来说以 sidecar screenshot/DOM 为准。

## Frontend 重构方案

### 1. 增加 AgentSessionContext 类型

位置建议：

```txt
packages/ui/src/types.ts
```

新增：

```ts
export interface WorkbenchAgentSessionContext {
  sessionId: string;
  threadId: string;
  taskId?: string;
  workspaceRoot: string;
  permissionMode: WorkbenchPermissionLevel | "full_access";
  activeModel: string;
  activeBranch?: string;
  activeTool?: WorkbenchWorkspaceToolAction | null;
}
```

### 2. App.tsx 生成 session context

来源：

- `workspacePath` from `useWorkspaceSessionControls`
- `task.id`
- `activeHistoryEntryId`
- `modelConfiguration`
- `permissionRequest?.level`
- Git branch from future `git_current_branch`

### 3. InspectorPanel 接收 session

```tsx
<InspectorPanel
  session={agentSession}
  ...
/>
```

### 4. WorkspaceToolPanels 接收 session

```tsx
<WorkspaceToolPanels
  session={session}
  tool={activeTool}
  ...
/>
```

所有 tool props 改成：

```ts
onTerminalCreate(session)
onGitStatus(session)
onFileSearch(session, query)
onBrowserNavigate(session, url)
```

而不是现在的：

```ts
onQuickActionTerminal(command)
onQuickActionReview()
onQuickActionBrowser(url)
```

### 5. SessionHeader

右栏顶部显示：

```txt
E:\Javis
branch: codex/...
permission: full access
model: 5.5
dirty: 34 files
```

这会把“详情页”心智改成“当前会话工作台”。

## 分阶段实施

### Phase 0: 收口现有 UI 和上下文

目标：

- 定义 `WorkbenchAgentSessionContext`。
- App 创建 session 并传入 Inspector/ToolPanels。
- 修正 review/terminal 当前调用里 `workspacePath: null` 的问题，改为当前 workspace。
- 修正 review quick action 和 `shell.rs` allowlist 的参数不一致。
- 修正 side chat 调用 `complete_model_prompt` 的 IPC 参数形状。
- 给本地浏览器入口增加 localhost/private URL 的 session 级允许策略。
- 清理右栏工具中文乱码和临时文案。

验证：

- `pnpm --filter @javis/ui build`
- `pnpm --filter @javis/desktop build`
- UI 测试：打开右栏工具，确认 workspace path 显示一致。
- 审查、侧边聊天、本地浏览器 quick action 至少能完成一次真实调用。

### Phase 1: TerminalService + xterm.js

目标：

- 加 `portable-pty`。
- 后端创建 PTY session。
- 前端 `TerminalPanel` 使用 xterm.js。
- 支持 create/input/resize/kill/output event。

为什么先做：

- 用户价值最高。
- 后端边界清晰。
- 可以马上验证“右侧工具共享 workspaceRoot”的核心假设。

验收：

- 打开终端默认 cwd 是当前工作区。
- `pwd`/`Get-Location` 显示 workspaceRoot。
- resize 不错位。
- kill terminal 后进程退出。
- 无工作区时禁用或提示选择工作区。

### Phase 2: GitService + ReviewPanel

目标：

- 后端集中处理 `git status/diff/current_branch`。
- ReviewPanel 展示文件状态、diff stat、单文件 diff。
- stage/unstage/revert 先做 UI 和权限确认，执行可分两步。

验收：

- 当前 branch 显示在 session header。
- dirty file count 同 GitService 一致。
- diff 大文件不会卡死。
- stage/revert 需要确认权限。

### Phase 3: FileService search/watch

目标：

- 文件树绑定 workspaceRoot。
- 搜索使用 `rg`。
- 文件变化通过 watcher 更新。

验收：

- 搜索结果尊重 `.gitignore`。
- 文件变化后右栏自动刷新。
- 大仓库不会一次性渲染全部节点。

### Phase 4: BrowserService 可视化增强

目标：

- BrowserPanel 绑定 session browser state。
- 展示 URL/title/loadState/screenshot/DOM outline/console logs。
- 支持本地站点快速打开。

验收：

- 打开 localhost 页面后 Agent 可读 screenshot/content。
- console error 能显示。
- click/type 操作走权限。

### Phase 5: Agent 工具联动

目标：

- Agent 执行 terminal/git/browser/files 工具时，右栏同步展示。
- 用户手动操作和 Agent 自动操作共享同一 service state。
- 每次工具调用进入 audit log。

验收：

- Agent 跑命令时 TerminalPanel 有输出。
- Agent 打开浏览器时 BrowserPanel 跟随。
- Agent 查看 diff 时 ReviewPanel 跟随。

## 关键技术细节

### IPC 事件命名

建议统一：

```txt
agent-session://updated
terminal://output
terminal://exit
files://changed
git://status
browser://snapshot
browser://console
```

事件 payload 都带：

```ts
{
  sessionId: string;
  workspaceRoot: string;
  timestamp: string;
}
```

### 权限模型

不要让每个 service 各自判断权限。建议集中：

```txt
PermissionService
  canRead(session, action)
  requiresApproval(session, action)
  recordApproval(session, action)
```

前端展示：

- read_only：绿色/灰色 badge
- confirmed_write：黄色 badge
- full_access：强调 badge

### 审计

所有会改变状态的操作都写入 audit：

- terminal input
- git stage/revert
- file write/delete/move
- browser click/type/evaluate

只读操作可采样记录：

- browser screenshot
- git diff
- file search

### 大数据处理

不要把大 diff、大文件、大 terminal buffer 全塞 React state。

建议：

- terminal 由 xterm buffer 管。
- diff 按文件分页。
- file tree virtualized。
- browser screenshot 限制尺寸或只保留最新。

## 测试策略

### Frontend

- `InspectorPanel` 渲染 session header。
- `WorkspaceToolPanels` 每个工具收到 session。
- `TerminalPanel` mock event 输出。
- `ReviewPanel` 大 diff 不溢出。
- `FilesPanel` 搜索和空状态。

### Backend

- `terminal_create` cwd 正确。
- `terminal_kill` 清理进程。
- `git_status` 解析新增/修改/删除。
- `files_search` 尊重 workspaceRoot。
- `browser_snapshot` 对无页面状态安全。

### Integration

- 选择工作区 -> 打开右栏 -> 终端 cwd 正确。
- 修改文件 -> GitService dirty count 改变。
- 运行 dev server -> BrowserPanel 打开 localhost。
- 权限降级时写操作被阻止。

## Review

### 主要风险

1. **PTY 安全风险**
   - 任意 shell 比当前 allowlist 强得多。
   - 必须先实现 permission gating 和 audit。

2. **session 边界不清**
   - 如果 browser/terminal/git 仍是全局状态，多线程/历史会话会串。
   - 必须所有事件和 service state 带 `sessionId`。

3. **前端状态膨胀**
   - terminal 输出、diff、文件树都可能很大。
   - 必须用 streaming/virtualization/pagination。

4. **浏览器 iframe 与 sidecar 状态不一致**
   - iframe 只是 UI 辅助，Agent 依据应是 sidecar screenshot/DOM/content。
   - 不要把 iframe 当真实 browser service。

5. **当前代码已有部分中文显示可能受编码影响**
   - 需要统一文件编码和文本来源。
   - UI 文案最好收回 locale.ts，避免组件里散落中文。

6. **现有 quick action 的契约不一致**
   - 部分按钮已经可见，但后端命令参数、workspace 绑定、URL 校验还没完全对齐。
   - 如果不先修，用户会误以为工具已完成，实际点击后失败。

7. **本地浏览器访问和安全策略冲突**
   - Codex 风格工作台必须能打开 `localhost`/`127.0.0.1`。
   - 但开放 private IP 不能变成全局默认，应绑定到当前 session 和明确权限。

### 建议先改的最小代码点

1. 新增 `WorkbenchAgentSessionContext` 类型。
2. `App.tsx` 创建 `agentSession`。
3. `InspectorPanel` 和 `WorkspaceToolPanels` 接收 session。
4. `onQuickActionReview/onQuickActionTerminal` 使用当前 `workspacePath`，不再传 `null`。
5. 统一 review quick action 的 `git diff` 参数和后端 allowlist。
6. 侧边聊天改用 `model-provider.ts` 或正确的 `{ request }` IPC 参数。
7. BrowserService 增加 session-scoped localhost 允许逻辑。
8. 新建 `terminal.rs` 和 xterm panel，先完成 MVP。

### 不建议现在做

- 不建议先做复杂浏览器自动点击可视化。
- 不建议先做 GitHub PR inline comments。
- 不建议引入 Monaco 做完整 IDE。
- 不建议让 Agent 自动执行任意 shell，除非权限和审计先完成。

## 推荐下一步

从 Phase 0 + Phase 1 开始：

```txt
Step 1: AgentSessionContext
Step 2: session header
Step 3: workspace-bound review/terminal/side-chat quick actions
Step 4: local browser permission and sidecar state binding
Step 5: TerminalService PTY MVP
Step 6: xterm.js TerminalPanel
```

完成这六步后，右侧区域的心智就会从“详情页”正式变成“当前 Agent 会话工作台”。
