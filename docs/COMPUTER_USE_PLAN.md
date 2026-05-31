# Windows Computer Use 集成方案

## Context

Javis 已有 Browser Agent（Playwright sidecar 模式，`browser.rs` 1070 行，8 个 Tauri 命令，JSONL 协议），但它的操作范围限于网页 DOM。Computer Use 需要的是**桌面级**能力——截取 Windows 桌面画面、理解截图内容、注入 OS 级鼠标键盘事件、跨多个桌面应用走流程。

Codex app 的 Windows Computer Use 原理是：**Codex app 本地插件负责截屏和注入前台输入，模型负责理解画面并决定下一步动作，权限系统负责限制能操作哪些 app 和高风险行为**。本方案在 Javis 的架构约束和安全模型内实现同等能力。

### 与 Browser Agent 的本质区别

| 维度 | Browser Agent (已有) | Computer Use (本方案) |
|------|---------------------|---------------------|
| 操作范围 | 仅网页 DOM | 整个 Windows 桌面 + 任意应用 |
| 画面来源 | Playwright page screenshot | DXGI/GDI 桌面截屏 |
| 输入方式 | Playwright 级 click/type | OS 级 SendInput 鼠标键盘事件 |
| 视觉理解 | 不需要（DOM 可读） | 必须用 vision 模型理解截图 |
| 跨应用 | 不支持 | 支持（浏览器→VS Code→设置面板→文件管理器） |
| 权限粒度 | 按操作审批 | 按应用信任 + 按敏感操作双重审批 |
| 技术路径 | Node.js sidecar (Playwright) | 纯 Rust (windows-sys GDI/DXGI + SendInput + image) |

> **已知前置条件**：Vision Agent 已实现（`vision.analyze` / `vision.describe` / `vision.extractText`），Computer Agent 已存在但能力极简（仅 `file.listDirectory` / `computer.openPath` / `file.scanUserImages`）。本方案将 Computer Agent 从"本地文件浏览"升级为"桌面视觉操控"。

---

## 架构概览

```
User Goal
  ↓
Commander Plan → "打开 VS Code，检查 settings.json 中是否有拼写错误"
  ↓
Computer Agent (prefersVision: true)
  ↓
┌─────────────────────────────────────────────────┐
│           Computer Use Action Loop              │
│                                                  │
│  ① computer.screenshot → 桌面截图 (base64 PNG)  │
│       ↓                                          │
│  ② 截图 + 指令 → DeepSeek Vision Model          │
│     模型输出结构化 action:                       │
│     {                                            │
│       "observation": "任务栏有 VS Code 图标",    │
│       "action": {                                │
│         "tool": "computer.click",                │
│         "params": { "x": 840, "y": 1060 }       │
│       },                                         │
│       "confidence": "high"                       │
│     }                                            │
│       ↓                                          │
│  ③ confirmed_write 审批卡片                      │
│     "Computer Agent 要点击 VS Code (840, 1060)" │
│       ↓ (用户批准)                                │
│  ④ computer.click(840, 1060)                    │
│     → Rust → SendInput → 前台鼠标事件            │
│       ↓                                          │
│  ⑤ computer.screenshot → 验证结果                │
│       ↓                                          │
│  ⑥ 循环，直到模型输出 { "status": "complete" }   │
└─────────────────────────────────────────────────┘
  ↓
Verifier Check → Desktop UI Result
```

核心设计原则：
- **每步一截图**：模型只输出下一步动作，不是一次输出所有步骤。每步后重新看截图校准，避免累积误差。
- **模型输出结构化 JSON**：`{observation, action: {tool, params}, confidence}` — 不依赖模型生成自由格式文本。
- **写操作 100% 经过审批**：所有 `computer.moveMouse/click/type/keyCombo/scroll/focusWindow` 都是 `confirmed_write`。
- **Rust 原生实现**：不引入新的 sidecar 依赖，直接用 `windows-sys` + `image` crate 调用 Win32 API。

---

## Phase 1: 类型基础（`packages/tools` + `packages/core`）

### 1.1 工具类型 — `packages/tools/src/types.ts`

在 `BrowserTool` 接口之后新增 `ComputerTool`：

```typescript
// ── Computer Use Tool ──

export interface ComputerScreenshotRequest {
  /** 截取整个桌面(default)或指定窗口句柄 */
  windowHandle?: number;
  /** 截取区域（相对于桌面或窗口的像素坐标） */
  region?: { x: number; y: number; width: number; height: number };
}
export interface ComputerScreenshotResult {
  /** base64 编码的 PNG 图片（无损，vision 模型需要像素精度） */
  dataUrl: string;
  width: number;
  height: number;
  /** 截图时间戳 (ISO 8601) */
  capturedAt: string;
}

export interface ComputerListWindowsRequest {}
export interface ComputerListWindowsResult {
  windows: Array<{
    handle: number;
    title: string;
    className: string;
    rect: { x: number; y: number; width: number; height: number };
    isVisible: boolean;
    isForeground: boolean;
  }>;
}

export interface ComputerFocusWindowRequest {
  handle: number;
}
export interface ComputerFocusWindowResult {
  focused: boolean;
  title: string;
}

export interface ComputerMoveMouseRequest {
  x: number;
  y: number;
  /** 移动速度: "instant"(default) | "linear"（人类模拟） */
  speed?: "instant" | "linear";
  /** linear 模式下的移动耗时 ms，默认 200 */
  durationMs?: number;
}
export interface ComputerMoveMouseResult {
  x: number;
  y: number;
}

export interface ComputerClickRequest {
  x: number;
  y: number;
  button?: "left" | "right" | "middle";
  clickCount?: 1 | 2;
}
export interface ComputerClickResult {
  x: number;
  y: number;
  clicked: boolean;
}

export interface ComputerTypeRequest {
  text: string;
  /** 每个字符间延迟 ms，默认 50（模拟人类打字） */
  delayMs?: number;
  /** 输入前是否清空（Ctrl+A + Delete） */
  clearBefore?: boolean;
}
export interface ComputerTypeResult {
  typed: boolean;
  length: number;
}

export interface ComputerKeyComboRequest {
  /** 组合键列表，如 ["Ctrl", "C"] */
  keys: string[];
  /** 每个键按下持续时间 ms，默认 50 */
  pressDurationMs?: number;
}
export interface ComputerKeyComboResult {
  combo: string;
  executed: boolean;
}

export interface ComputerScrollRequest {
  x: number;
  y: number;
  /** 正数向上滚动，负数向下滚动 */
  delta: number;
  /** 滚动方向: "vertical"(default) | "horizontal" */
  direction?: "vertical" | "horizontal";
}
export interface ComputerScrollResult {
  x: number;
  y: number;
  delta: number;
}

export interface ComputerWaitRequest {
  /** 等待毫秒数，Rust 层 clamp 到 [0, 10000] */
  ms: number;
}
export interface ComputerWaitResult {
  waited: number;
}

export interface ComputerTool {
  screenshot(request: ComputerScreenshotRequest): Promise<ComputerScreenshotResult>;
  listWindows(request: ComputerListWindowsRequest): Promise<ComputerListWindowsResult>;
  focusWindow(request: ComputerFocusWindowRequest): Promise<ComputerFocusWindowResult>;
  moveMouse(request: ComputerMoveMouseRequest): Promise<ComputerMoveMouseResult>;
  click(request: ComputerClickRequest): Promise<ComputerClickResult>;
  type(request: ComputerTypeRequest): Promise<ComputerTypeResult>;
  keyCombo(request: ComputerKeyComboRequest): Promise<ComputerKeyComboResult>;
  scroll(request: ComputerScrollRequest): Promise<ComputerScrollResult>;
  wait(request: ComputerWaitRequest): Promise<ComputerWaitResult>;
}
```

### 1.2 工具描述符 — `packages/tools/src/descriptors.ts`

在 `browser.runTest` 描述符后追加 9 个 `computer.*` 描述符：

| name | permissionLevel | capabilityTags | summary |
|------|----------------|----------------|---------|
| `computer.screenshot` | read | `desktop_screenshot` | Capture the current desktop or a specific window as a PNG screenshot. |
| `computer.listWindows` | read | `desktop_list_windows` | Enumerate all visible windows with titles, handles, and screen positions. |
| `computer.focusWindow` | confirmed_write | `desktop_focus` | Bring a specific window to the foreground by handle. Requires user approval. |
| `computer.moveMouse` | confirmed_write | `desktop_input` | Move the mouse cursor to absolute screen coordinates. Requires user approval. |
| `computer.click` | confirmed_write | `desktop_input` | Click at absolute screen coordinates. Requires user approval. |
| `computer.type` | confirmed_write | `desktop_input` | Type text via keyboard input simulation. Requires user approval. |
| `computer.keyCombo` | confirmed_write | `desktop_input` | Press a key combination (e.g. Ctrl+C). Requires user approval and allowlist check. |
| `computer.scroll` | confirmed_write | `desktop_input` | Scroll at absolute screen coordinates. Requires user approval. |
| `computer.wait` | read | `desktop_screenshot` | Wait for a specified duration (max 10 seconds). |

### 1.3 能力标签 — `packages/core/src/agent-capability.ts`

`AgentCapabilityTag` 联合类型追加：

```typescript
| "desktop_screenshot"    // Capture desktop/window screenshots
| "desktop_list_windows"  // Enumerate OS windows
| "desktop_focus"         // Focus/foreground a window
| "desktop_input"         // Inject mouse/keyboard input events
```

`inferCapabilityTags()` 的 tool→tag 映射保持不变（从 `ToolDescriptor.capabilityTags` 自动推导），不需要手动修改 switch。

### 1.4 Agent 定义 — `packages/core/src/agents.ts`

将现有的 `agent-computer` 从极简模式升级为 Computer Use 模式（替换原有 `allowedToolNames`）：

```typescript
{
  id: "agent-computer",
  kind: "computer",
  displayName: "Computer Agent",
  description: "Desktop Computer Use — screenshot the desktop, understand UI visually, and interact with any Windows application via mouse and keyboard.",
  allowedToolNames: [
    // 原有文件浏览能力（保留）
    "file.listDirectory",
    "computer.openPath",
    "file.scanUserImages",
    // 新增 Computer Use 能力
    "computer.screenshot",
    "computer.listWindows",
    "computer.focusWindow",
    "computer.moveMouse",
    "computer.click",
    "computer.type",
    "computer.keyCombo",
    "computer.scroll",
    "computer.wait",
  ],
  modelRequirements: { prefersVision: true, prefersCode: false, minContextTokens: 16000 },
  systemPrompt: {
    en: `You are the Computer Agent for Windows desktop automation.
You see the desktop through screenshots and interact via mouse/keyboard.

CAPABILITIES:
- Capture screenshots of the desktop or specific windows
- Move the mouse, click, type text, press key combinations, scroll
- List and focus application windows
- Navigate file directories

WORKFLOW (one step at a time):
1. Take a screenshot to understand the current desktop state
2. Analyze the screenshot: what windows are open? What buttons/inputs/menus are visible?
3. Decide the SINGLE next action needed to progress toward the goal
4. Output the action as structured JSON
5. After the action executes, take another screenshot to verify

RULES:
- Always screenshot FIRST before any interaction — never guess coordinates blindly
- Output exactly ONE action per turn — the loop handles iteration
- Click on the CENTER of target elements, not edges
- When typing, first click the target input field, then call computer.type
- Never interact with system dialogs (UAC, Task Manager, Registry Editor, system settings)
- Never automate browser-internal pages (chrome://, about:, edge://)
- Never input passwords, credit card numbers, or authentication tokens
- If you're unsure what to click, screenshot again and describe what you see
- If the goal is achieved, output {"status":"complete","summary":"..."}`,
    zhCN: `你是 Windows 桌面操控代理。
通过截图理解桌面状态，通过鼠标键盘执行操作。

能力范围：截取桌面/窗口截图、移动鼠标、点击、输入文字、组合键、滚动、列出和聚焦窗口、浏览文件目录。

工作方式（逐步循环）：
1. 先截图理解当前桌面状态
2. 分析截图：有哪些窗口？显示了什么按钮/输入框/菜单？
3. 决定推进目标的**单步**动作
4. 以结构化 JSON 输出该动作
5. 动作执行后，再次截图验证

规则：
- 任何交互前必须先截图——绝不瞎猜坐标
- 每次只输出一步——循环负责迭代
- 点击目标元素的中心，不点边缘
- 输入文字前先点击目标输入框，再调用 computer.type
- 绝不操作系统对话框（UAC、任务管理器、注册表编辑器、系统设置）
- 绝不操作浏览器内部页面
- 绝不输入密码、信用卡号或认证令牌
- 不确定点什么时就再截图描述所见
- 目标达成时输出 {"status":"complete","summary":"..."}`,
  },
},
```

### 1.5 路由 — `packages/core/src/routing.ts`

- `RouteKind` 联合类型追加 `"computer-use"`
- 新增 `createComputerUseRouteScore()`。

**路由关键词设计**（避免误匹配）：

Computer Use 的关键挑战是 "打开/点击/输入" 这类词太过常见，会命中几乎所有中文任务。路由策略分两层：

**Layer 1 — 桌面操控动词（加权 +4）**：
`操控桌面 / 操作电脑 / 控制桌面 / 桌面自动化 / 操作 GUI / desktop automation / control computer / use computer`

**Layer 2 — GUI 上下文组合（加权 +4）**：
仅当**同时出现** "应用名 + 动作词" 时才加分：
- 应用名：`VS Code / Excel / Word / Chrome / 计算器 / 记事本 / 画图 / 文件资源管理器 / Notion / PowerPoint / Outlook / 浏览器 / 设置`
- 动作词：`打开 / 启动 / 点击 / 输入 / 填写 / 配置`
- 示例：
  - "打开计算器" → +4 ✅（应用名 + 动作词）
  - "点击按钮" → 不加分 ❌（无应用名，太泛）

**Layer 3 — 桌面/窗口关键词（加权 +2）**：
`桌面 / 窗口 / 屏幕 / 任务栏 / 开始菜单 / 系统托盘 / desktop / window / screen / taskbar / start menu`

**阈值**：总分 ≥4 才命中 `computer-use` 路由。
- "打开计算器" → Layer 1:0 + Layer 2:4 + Layer 3:0 = **4 ≥ 4** ✅
- "操控桌面打开 Chrome" → Layer 1:4 + Layer 2:4 + Layer 3:2 = **10 ≥ 4** ✅
- "打开项目文件夹" → Layer 1:0 + Layer 2:0 + Layer 3:0 = **0 < 4** ❌（正确拒绝）
- "点击确认按钮" → Layer 1:0 + Layer 2:0 + Layer 3:0 = **0 < 4** ❌（正确拒绝）
- "输入命令" → Layer 1:0 + Layer 2:0 + Layer 3:0 = **0 < 4** ❌（正确拒绝）

实际阈值在实现阶段根据 `routing.test.ts` 的测试数据调整。

- 新增 `isComputerUseGoal()` helper
- 在 `scoreRoutes()` 中追加 `createComputerUseRouteScore(userGoal)`
- `routeToWorkflowId` 追加 `"computer-use"` case

### 1.6 工作流 — `packages/core/src/workflows.ts`

- `WorkbenchWorkflowId` 追加 `"computer-use"`
- 新增 `computer-use` 工作流（3 步串行）：
  1. **analyze-desktop**（Commander + Computer Agent）— 解析指令，截图了解桌面状态
  2. **execute-actions**（Computer Agent）— 进入 action loop 执行操作
  3. **verify-outcome**（Verifier）— 对比目标与最终截图验证结果

---

## Phase 2: Rust 原生层（`apps/desktop/src-tauri/src/computer.rs`）

### 2.1 依赖

项目使用 `windows-sys = "0.61"`（Windows-targeted），不是 `windows` crate。需要新增两个 crate。

**Cargo.toml 新增**：

```toml
[dependencies]
image = "0.25"  # PNG 编码（截屏输出）

[target.'cfg(windows)'.dependencies]
windows-sys = { version = "0.61", features = [
    # 已有
    "Win32_Foundation",
    "Win32_Security_Cryptography",
    "Win32_System_Memory",
    "Win32_Storage_FileSystem",
    # Computer Use 新增
    "Win32_Graphics_Gdi",
    "Win32_UI_Input_KeyboardAndMouse",
    "Win32_UI_WindowsAndMessaging",
    "Win32_System_SystemInformation",   # GetSystemMetrics
] }
```

核心 API（`windows-sys` 路径，与 `windows` crate 不同）：

```rust
// 截屏（GDI）
use windows_sys::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleDC, CreateCompatibleBitmap, GetDC, ReleaseDC,
    SelectObject, DeleteDC, DeleteObject, GetDIBits, SRCCOPY, BITMAPINFO, ...
};
// 高性能截屏可选（DXGI）
use windows_sys::Win32::Graphics::Dxgi::...;

// 输入
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_MOUSE, INPUT_KEYBOARD, MOUSEINPUT, KEYBDINPUT,
    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, KEYEVENTF_KEYDOWN, KEYEVENTF_KEYUP, ...
};
// 窗口管理
use windows_sys::Win32::UI::WindowsAndMessaging::{
    SetCursorPos, GetCursorPos, EnumWindows, GetWindowTextW,
    SetForegroundWindow, GetWindowRect, IsWindowVisible,
    GetForegroundWindow, GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN, ...
};
```

> **注意**：`windows-sys` 是 raw FFI bindings（`extern "system"` 函数指针），API 是 `unsafe` 的，需要手动管理 HDC/HBITMAP 生命周期。如果 `windows` crate（safe wrapper）已在依赖树中，可用其更安全的 API，但需确认不引入版本冲突。

### 2.2 模块结构

```rust
// computer.rs

use crate::error::JavisError;
use crate::NativeApprovalBinding;
use crate::require_native_approval_binding;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use image::{codecs::png::PngEncoder, ImageEncoder};
use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
use windows_sys::Win32::UI::WindowsAndMessaging::*;
use windows_sys::Win32::Graphics::Gdi::*;
use windows_sys::Win32::Foundation::*;

// ── 请求/响应类型 ──
// （全部 9 对 request/result，与 Phase 1.1 的 TypeScript 类型一一对应）
```

**关键设计决策**：Computer Use 的写操作**复用** `lib.rs` 已有的 `NativeApprovalBinding` + `require_native_approval_binding()` 机制（与 `pdf.rs`、`code.rs`、`file_write.rs` 一致）。不创建独立的 `ComputerState`。

`preview_hash` 的映射：Computer Use 没有传统的 "dry-run plan"。审批建联时，用操作参数的确定性哈希作为 `preview_hash`：

```
preview_hash = SHA256({tool, ...params}) → binding
```

这样 Rust 层执行前可以验证：提交的操作参数哈希是否匹配审批时的哈希，防止审批后参数被篡改。

```rust
use sha2::{Digest, Sha256};

fn hash_action_params(tool: &str, params: &serde_json::Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(tool.as_bytes());
    hasher.update(serde_json::to_string(params).unwrap_or_default().as_bytes());
    format!("{:x}", hasher.finalize())
}
```

### 2.3 核心函数

#### 截屏

```rust
/// 截取整个桌面或指定窗口。
///
/// 桌面截屏流程：
/// 1. GetDC(null) 获取桌面 DC
/// 2. CreateCompatibleDC + CreateCompatibleBitmap
/// 3. BitBlt SRCCOPY 拷贝像素
/// 4. 编码为 PNG → base64
///
/// 窗口截屏流程（当指定 windowHandle 时）：
/// 1. GetWindowDC(handle) 获取窗口 DC
/// 2. BitBlt / PrintWindow 拷贝窗口内容
/// 3. 编码 → base64
fn capture_screenshot(request: &ComputerScreenshotRequest) -> Result<ComputerScreenshotResult, JavisError>
```

性能目标：1080p 桌面截屏 < 100ms，PNG 编码 < 50ms。

#### 鼠标控制

```rust
/// 移动鼠标到绝对坐标。
///
/// instant: SetCursorPos(x, y) 瞬移
/// linear:  分多步插值 → SetCursorPos，模拟人类移动轨迹
fn move_mouse(request: &ComputerMoveMouseRequest) -> Result<ComputerMoveMouseResult, JavisError>

/// 在指定坐标点击。
///
/// 1. SetCursorPos(x, y) 先移动
/// 2. SendInput(MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_LEFTUP)
///    或 MOUSEEVENTF_RIGHTDOWN 等
/// 3. 等待 50ms 让目标应用处理点击事件
fn click(request: &ComputerClickRequest) -> Result<ComputerClickResult, JavisError>
```

#### 键盘控制

```rust
/// 模拟键盘输入文本。
///
/// 1. 逐字符调用 SendInput(KEYBDINPUT)
/// 2. 每个字符间 delayMs 延迟
/// 3. 处理 Shift 状态（大写字母 + 符号）
/// 4. 如果 clearBefore: 先发 Ctrl+A → Delete 清空
fn type_text(request: &ComputerTypeRequest) -> Result<ComputerTypeResult, JavisError>

/// 执行组合键。
///
/// 1. 按下所有 modifier 键（Ctrl/Alt/Shift/Win）
/// 2. 按下主键
/// 3. 释放主键
/// 4. 释放 modifier 键（逆序）
fn key_combo(request: &ComputerKeyComboRequest) -> Result<ComputerKeyComboResult, JavisError>
```

#### 窗口管理

```rust
/// 枚举所有可见窗口。
///
/// 1. EnumWindows 回调收集窗口句柄
/// 2. GetWindowTextW 获取标题
/// 3. IsWindowVisible 过滤隐藏窗口
/// 4. GetWindowRect 获取位置和大小
/// 5. GetForegroundWindow 比对当前前台窗口
fn list_windows() -> Result<ComputerListWindowsResult, JavisError>

/// 将指定窗口切换到前台。
///
/// 1. SetForegroundWindow(handle)
/// 2. 等待 200ms 让窗口完成切换动画
/// 3. 验证窗口确实在前台
fn focus_window(request: &ComputerFocusWindowRequest) -> Result<ComputerFocusWindowResult, JavisError>
```

### 2.4 安全守卫

```rust
// ── 危险窗口拒绝列表 ──
const DENIED_WINDOW_PATTERNS: &[&str] = &[
    "Task Manager", "任务管理器",
    "Registry Editor", "注册表编辑器",
    "Windows Security", "Windows 安全中心",
    "User Account Control", "用户账户控制",
    "System Configuration", "系统配置",
    "Computer Management", "计算机管理",
];

// ── 危险组合键拒绝列表 ──
const DENIED_KEY_COMBOS: &[&[&str]] = &[
    &["Win", "R"],              // 运行对话框（重要：不能禁 Win+I 设置页面但需监控）
    &["Ctrl", "Alt", "Del"],    // 安全选项
    &["Win", "L"],              // 锁屏
    &["Ctrl", "Shift", "Esc"],  // 任务管理器
    &["Alt", "F4"],             // 关闭窗口
    &["Win", "D"],              // 显示桌面
];

/// 验证窗口标题是否在拒绝列表中。
/// 使用子串匹配 — "Task Manager" 会拦截 "Task Manager"、"Windows Task Manager" 等变体。
fn validate_window(window_title: &str) -> Result<(), JavisError>

/// 验证组合键是否在拒绝列表中。
/// 对 key 做标准化（"ctrl"→"Ctrl", "control"→"Ctrl"）后精确匹配。
fn validate_key_combo(keys: &[String]) -> Result<(), JavisError>

/// 坐标边界检查：通过 GetSystemMetrics(SM_CXSCREEN/SM_CYSCREEN) 获取分辨率，
/// 拒绝 x<0、y<0、以及超出当前显示器范围的坐标。
fn validate_screen_coordinates(x: i32, y: i32) -> Result<(), JavisError>

// ── 重要 — 以下由 lib.rs 的共享机制提供，不在 computer.rs 内重复实现 ──

/// Computer Use 写命令的审批验证流程（在 Tauri command 中调用）：
/// 
/// 1. 从 TS 层接收 NativeApprovalBinding (已由 confirmed-write flow 创建)
/// 2. 对请求参数做 hash_action_params(tool, params) → preview_hash
/// 3. 调用 lib.rs 的 require_native_approval_binding(binding, approvalId, toolName, taskId, preview_hash, ...)
/// 4. 通过后执行实际操作
///
/// 这和 code.rs 的 propose/apply 用的是同一套 NativeApprovalBinding 结构，
/// 确保 Computer Use 的审批记录和 PDF/Code Patch 审批记录在同一个审计体系内。
```

### 2.5 Tauri 命令（9 个）

```rust
// Read — 不需要 approval
#[tauri::command] computer_screenshot(request)    → ComputerScreenshotResult
#[tauri::command] computer_list_windows(request)  → ComputerListWindowsResult
#[tauri::command] computer_wait(request)          → ComputerWaitResult  (clamp ms ≤ 10000)

// Confirmed Write — 每个命令内调用 require_native_approval_binding()
#[tauri::command] computer_focus_window(binding: NativeApprovalBinding, request) → ComputerFocusWindowResult
#[tauri::command] computer_move_mouse(binding: NativeApprovalBinding, request)   → ComputerMoveMouseResult
#[tauri::command] computer_click(binding: NativeApprovalBinding, request)        → ComputerClickResult
#[tauri::command] computer_type(binding: NativeApprovalBinding, request)         → ComputerTypeResult
#[tauri::command] computer_key_combo(binding: NativeApprovalBinding, request)    → ComputerKeyComboResult
#[tauri::command] computer_scroll(binding: NativeApprovalBinding, request)       → ComputerScrollResult
```

写命令模板（以 `computer_click` 为例）：

```rust
#[tauri::command]
pub(crate) fn computer_click(
    approvals: tauri::State<'_, std::sync::Mutex<ApprovalRecordMap>>,
    approval_id: String,
    task_id: String,
    request: ComputerClickRequest,
) -> Result<ComputerClickResult, String> {
    // 1. 坐标边界检查
    validate_screen_coordinates(request.x as i32, request.y as i32)
        .map_err(|e| e.to_string())?;
    
    // 2. 从 ApprovalRecordMap 查找 binding，验证审批（复用 lib.rs 共享机制）
    let preview_hash = hash_action_params("computer.click", &serde_json::to_value(&request).unwrap());
    let guard = approvals.lock().map_err(|e| format!("Lock error: {e}"))?;
    let binding = guard.get(&approval_id)
        .ok_or_else(|| format!("Approval {approval_id} not found"))?;
    require_native_approval_binding(
        binding,
        &approval_id,
        "computer.click",
        Some(&task_id),
        &preview_hash,
        "Approval hash mismatch — operation params differ from approved action.",
        "Computer Use click action requires confirmed-write approval.",
    ).map_err(|e| e.to_string())?;
    drop(guard);
    
    // 3. 执行
    execute_click(&request).map_err(|e| e.to_string())
}
```

> **审批传递方式**：与 `code.rs`、`pdf.rs` 一致 — 写命令接收 `approval_id` + `task_id` 作为独立参数，从 Tauri `State<Mutex<ApprovalRecordMap>>` 查找 `NativeApprovalBinding`。Computer Use 在 loop 中高频调用，内存查找无 I/O 开销。approval 由 Phase 5 的 `invokeWithApproval()` 在 TS 层创建并传入 Rust。

### 2.6 注册 — `lib.rs`

```rust
mod computer;
// generate_handler 追加 9 个命令，共享已有的 ApprovalRecordMap State
```

---

## Phase 3: Vision 模型驱动的 Action Loop

> **架构约束**：Action loop 调用 `ModelProvider.complete()` 发送截图到 vision 模型 — 这属于 I/O 操作，必须放在 `apps/desktop/src/`，不能放在 `packages/core/`。Core 只提供纯数据的类型定义和 prompt 模板。

### 3.1 文件拆分

| 文件 | 层 | 内容 |
|------|-----|------|
| `packages/core/src/computer-use-types.ts` | Core (pure data) | `ComputerUseLoopConfig`、`ComputerUseStep`、`ComputerUseAction` 类型 + action JSON 解析/验证纯函数 |
| `packages/core/src/computer-use-prompt.ts` | Core (pure data) | System prompt 模板（bilingual `en` + `zhCN`）+ action output schema |
| `apps/desktop/src/computer-use-loop.ts` | Desktop (I/O) | `runComputerUseLoop()` — 调用 `ModelProvider.complete()`，执行截图→模型→action 循环 |

### 3.2 核心概念

Computer Use 不是简单把工具暴露给模型就完了。它需要一个**闭环**：

```
screenshot → vision model → structured action → execute → screenshot → ...
```

模型在每次迭代中只得到：
1. 用户原始指令
2. 当前截图（base64 PNG）
3. 最近 N 步的历史动作（防止死循环）
4. 可用的工具列表

模型输出结构化 JSON：
```json
{
  "observation": "VS Code 窗口已打开，左侧是文件浏览器，右侧是空的编辑器区域",
  "action": {
    "tool": "computer.click",
    "params": { "x": 300, "y": 400 }
  },
  "target": "点击文件浏览器中的 settings.json",
  "confidence": "high"
}
```

### 3.3 Core 类型 — `packages/core/src/computer-use-types.ts`

```typescript
// Pure data — 无 I/O、无 ModelProvider、无 Tauri

export interface ComputerUseLoopConfig {
  maxSteps: number;          // 最大迭代步数，默认 20
  historySteps: number;      // 保留最近 N 步到上下文，默认 5
}

export interface ComputerUseStep {
  stepIndex: number;
  screenshotDataUrl: string;
  observation: string;
  action: ComputerUseAction;
  target: string;
  confidence: "high" | "medium" | "low";
  result?: unknown;
  error?: string;
}

export type ComputerUseAction =
  | { tool: "computer.moveMouse"; params: { x: number; y: number; speed?: string } }
  | { tool: "computer.click"; params: { x: number; y: number; button?: string } }
  | { tool: "computer.type"; params: { text: string; clearBefore?: boolean } }
  | { tool: "computer.keyCombo"; params: { keys: string[] } }
  | { tool: "computer.scroll"; params: { x: number; y: number; delta: number } }
  | { tool: "computer.focusWindow"; params: { handle: number } }
  | { tool: "computer.screenshot"; params: {} }
  | { tool: "computer.wait"; params: { ms: number } };

/**
 * 解析模型返回的 JSON 为 ComputerUseAction。
 * 返回 null 表示模型输出了终止信号 {"status":"complete"}。
 * 抛出错误表示 JSON 格式无效。
 */
export function parseModelAction(raw: string): ComputerUseAction | null;
```

### 3.4 Core Prompt 模板 — `packages/core/src/computer-use-prompt.ts`

```typescript
// Pure data — System prompt 模板和 action output schema

export const COMPUTER_USE_SYSTEM_PROMPT = {
  en: `...`,   // 与 Phase 1.4 Agent 定义中的 systemPrompt 一致
  zhCN: `...`,
};

/** 注入到模型请求中的 JSON schema 约束 */
export const COMPUTER_USE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    observation: { type: "string" },
    action: {
      type: "object",
      properties: {
        tool: { type: "string", enum: ["computer.moveMouse", "computer.click", ...] },
        params: { type: "object" },
      },
      required: ["tool", "params"],
    },
    target: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["observation", "action", "target", "confidence"],
};
```

### 3.5 Action Loop 实现 — `apps/desktop/src/computer-use-loop.ts`

```typescript
import type { ModelProvider } from "./model-provider";
import type { ComputerTool } from "@javis/tools";
import type { ComputerUseLoopConfig, ComputerUseStep } from "@javis/core";
import { parseModelAction, COMPUTER_USE_SYSTEM_PROMPT, COMPUTER_USE_OUTPUT_SCHEMA } from "@javis/core";
import { invoke } from "@tauri-apps/api/core";

/**
 * Computer Use action loop — Desktop 层（I/O 操作在此）。
 *
 * 循环：
 *   1. invoke computer_screenshot → base64 PNG
 *   2. modelProvider.complete({ messages: [system + screenshot + history], tools, response_format })
 *   3. parseModelAction(response) → tool + params
 *   4. 如果 status=complete → 退出循环
 *   5. invoke computer_xxx (可能过审批) → 执行
 *   6. goto 1
 */
export async function runComputerUseLoop(
  modelProvider: ModelProvider,
  computerTool: ComputerTool,
  userGoal: string,
  config?: Partial<ComputerUseLoopConfig>,
): Promise<ComputerUseStep[]> {
  // ...
}
```

### 3.6 模型返回解析的容错处理

模型不一定总是返回合法 JSON。需要多层防御：

```
raw response
  → 1. trim + 去掉 markdown ```json 标记
  → 2. JSON.parse()
     → 失败: 重试 1 次（追加 "Output valid JSON only" 提示）
     → 仍失败: 终止 loop，返回 error step
  → 3. 检查 status 字段
     → "complete" → 退出循环
  → 4. 校验 action.tool 是否在允许列表中
     → 不在: 跳过该步，追加 "Tool X not available, pick from [list]" 提示继续
  → 5. 校验必填 params
     → 缺失: 同上处理
```

### 3.7 模型路由

Computer Use 必须使用 vision-capable 模型：
- DeepSeek（主模型，支持 vision + tool calling）
- 维持多轮上下文以保持桌面状态连续性
- 不走 Mimo CLI 子代理路径（无状态，无法维持 loop）

---

## Phase 4: 权限模型

### 4.1 权限分层

参照 Codex 的权限设计，Javis 的 Computer Use 权限分为三层：

| 层 | 机制 | 触发时机 |
|---|------|---------|
| **应用信任** | 首次操作某应用时弹出 "允许 Computer Agent 操作 [AppName]?" — 用户可 Always Allow | `computer.click/type/keyCombo` 等写操作首次针对新窗口 |
| **操作审批** | 每次敏感操作用卡片展示具体动作（坐标/按键/窗口标题） | 每次 `confirmed_write` 操作 |
| **拒绝列表** | Rust 原生层硬编码拒绝危险窗口 + 危险组合键 | 系统窗口、UAC、任务管理器、Win+R 等 |

### 4.2 应用信任列表 — `apps/desktop/src/computer-trust.ts`

```typescript
export interface ComputerTrustEntry {
  appName: string;       // 窗口标题模式（支持前缀匹配）
  windowClass: string;   // Windows 窗口类名
  trustLevel: "always" | "ask" | "never";
  createdAt: string;
  lastUsedAt: string;
}

// 持久化到 SQLite user_preferences
```

### 4.3 审批卡片增强

Computer Use 的审批卡片比现有 PDF/Code Agent 卡片多一层信息：

```
┌─────────────────────────────────────────┐
│  Computer Agent 请求执行操作              │
│                                          │
│  目标窗口: VS Code - settings.json       │
│  操作: 鼠标左键点击                       │
│  位置: (840, 1060)                       │
│  目的: 打开 VS Code 窗口                  │
│  信任状态: 首次操作此应用                  │
│                                          │
│  [拒绝]  [仅此次允许]  [始终允许此应用]    │
└─────────────────────────────────────────┘
```

### 4.4 与 Vision Agent 的关系

Computer Agent 和 Vision Agent 都标记了 `prefersVision: true`，但职责不同：

| 维度 | Vision Agent (已有) | Computer Agent (升级后) |
|------|---------------------|------------------------|
| 触发方式 | 用户直接上传图片/截图请求分析 | Commander 路由到 computer-use 工作流 |
| 输入 | 单张用户提供的图片 | 连续桌面截图流（action loop 每步一张） |
| 输出 | 图片描述/分析/OCR 文本 | 桌面操控动作 (click/type/move/...) |
| 工具 | `vision.analyze/describe/extractText` | `computer.screenshot/click/type/...` |
| 上下文 | 无状态、单次调用 | 有状态、多轮 loop |

**结论**：两者独立运行，不互相调用。Vision Agent 是"看图说话"，Computer Agent 是"看图动手"。如果未来需要 Computer Agent 先 OCR 识别截图中的文字再决定动作，它直接使用 DeepSeek 的 vision 能力完成，不需要通过 Vision Agent。

### 4.5 额外的安全约束

1. **截屏数据不落盘**：截图 base64 仅在内存中传递，不写入 SQLite 或 JSONL 日志
2. **任务历史脱敏**：只在 task history 中保存步骤摘要（`"点击了 VS Code (840,1060)"`），不保存完整截图
3. **TTL 保护**：approval 5 分钟过期，防止"批准一次、全天可用"
4. **上下文隔离**：Computer Use 的截图不会进入其他 Agent 的上下文

---

## Phase 5: 运行时接线（`apps/desktop/src/app-runtime.ts`）

### 5.1 `computerTool` 实现

```typescript
computerTool: {
  screenshot: (req) => invoke("computer_screenshot", { request: req }),
  listWindows: (req) => invoke("computer_list_windows", { request: req }),
  // ── 写操作全部经过审批流 ──
  focusWindow: (req) => invokeWithApproval("computer_focus_window", req),
  moveMouse: (req) => invokeWithApproval("computer_move_mouse", req),
  click: (req) => invokeWithApproval("computer_click", req),
  type: (req) => invokeWithApproval("computer_type", req),
  keyCombo: (req) => invokeWithApproval("computer_key_combo", req),
  scroll: (req) => invokeWithApproval("computer_scroll", req),
  wait: (req) => invoke("computer_wait", { request: req }),
},
```

其中 `invokeWithApproval()` 是重用现有的 confirmed-write 审批模式：
1. `createConfirmedWriteApproval()` 创建 PermissionRequest
2. UI 显示审批卡片
3. 用户批准后 `runtime.resolvePermission("approved", requestId)`
4. 调用 Rust 命令，附带 `approvalId + taskId`

### 5.2 路由集成

主 dispatch 添加 `isComputerUseGoal(userGoal)` 检查，命中时路由到 `computer-use` 工作流。

### 5.3 Action Loop 集成

**Loop 与 workflow executor 的关系**：

```
Workflow Step "execute-actions" (computer agent)
  ↓
  runComputerUseLoop(modelProvider, computerTool, goal, config)
  ↓
  ┌─ for step in 1..maxSteps ─────────────────────────────┐
  │                                                         │
  │  ① invoke computer_screenshot                           │
  │     → emit TaskSnapshot { streamingText: "截图中..." }  │
  │                                                         │
  │  ② modelProvider.complete(screenshot + history)         │
  │     → emit TaskSnapshot { streamingText: "分析中..." }  │
  │                                                         │
  │  ③ parseModelAction(response) → action                  │
  │     → emit TaskSnapshot { streamingText: target }       │
  │                                                         │
  │  ④ if action is read (screenshot/wait):                 │
  │       直接执行 → accumulate step result                 │
  │     if action is write (click/type/...):                 │
  │       创建 PermissionRequest → 等待用户审批             │
  │       → 批准: 执行, 拒绝: 终止 loop                     │
  │                                                         │
  │  ⑤ emit TaskSnapshot { resultSections: [...steps] }    │
  │                                                         │
  └─────────────────────────────────────────────────────────┘
  ↓
  返回步骤列表 → Verifier
```

**关键点**：
- Loop 的每一步通过 `eventBus.emit()` 发送 `TaskSnapshot` 更新，UI 实时看到每一步的截图和动作描述
- 写操作的审批是**同步阻塞**的 — loop 停下来等用户点批准/拒绝
- 用户拒绝任意写操作 → loop 终止 → workflow step 标记为 failed
- Loop 支持 "紧急停止" — ESC 键触发 → 发送 `cancel_all_model_streams` + 终止 loop
- Loop 作为 workflow 的一个 step 运行，被 workflow executor 的 `Promise.allSettled` / 串行调度管理

---

## Phase 6: 测试

### 6.1 Rust 测试（`computer.rs` 内 `#[cfg(test)]`）

| 测试 | 说明 |
|------|------|
| `test_screenshot_produces_valid_png` | 桌面截屏返回有效的 PNG 数据 |
| `test_screenshot_region_clipping` | 超出屏幕的 region 参数被裁剪 |
| `test_list_windows_returns_results` | 枚举窗口返回非空列表 |
| `test_reject_system_window_click` | 拒绝点击任务管理器/注册表编辑器等系统窗口 |
| `test_reject_dangerous_key_combo` | 拒绝 Win+R、Ctrl+Alt+Del 等危险组合键 |
| `test_approval_required_for_click` | 缺少 approval 时 click 被拒绝 |
| `test_approval_consumed_once` | approval ID 只能消费一次 |
| `test_approval_expired` | 过期的 approval 被拒绝 |
| `test_approval_wrong_tool_name` | tool name 不匹配被拒绝 |
| `test_approval_wrong_task_id` | task ID 不匹配被拒绝 |
| `test_validate_screen_coordinates` | 负坐标 + 超出分辨率范围的坐标被拒绝 |
| `test_validate_window_patterns` | 危险窗口标题被拒绝 |

### 6.2 Vitest 测试

- `packages/tools/src/` — 9 个 ComputerTool 描述符存在性 + 权限级别正确性
- `packages/core/src/routing.test.ts` — `computer-use` 路由评分：命中/未命中/阈值
- `packages/core/src/agent-capability.test.ts` — Computer Agent 四个新 capability tag
- `packages/core/src/computer-use-types.test.ts` — `parseModelAction()` 解析 JSON、maxSteps 截断、confidence 阈值、终止信号检测、格式错误恢复
- `apps/desktop/src/computer-use-loop.test.ts` — action loop 集成：mock ModelProvider + mock Tauri invoke，验证循环迭代、审批阻断、maxSteps 截断

### 6.3 QA 场景（`docs/qa/YYYY-MM-DD/computer-use/`）

| # | 场景 | 操作 | 预期 |
|---|------|------|------|
| 1 | 打开桌面应用 | "打开计算器" | 截图→点击开始菜单→输入 calc→截图确认计算器已打开 |
| 2 | 跨应用操作 | "打开记事本，输入 Hello World" | 截图→打开记事本→点击编辑区→输入文字→截图验证 |
| 3 | GUI 问题诊断 | "检查 VS Code 底部状态栏是否显示错误" | 截图→聚焦 VS Code→截图→分析状态栏→报告结果 |
| 4 | 审批拒绝 | 触发 click 操作 → 用户点拒绝 | 操作不执行，loop 中断，UI 显示"已拒绝" |
| 5 | 审批过期 | 等待 6 分钟 → 再执行 click | 操作被拒绝，需要重新审批 |
| 6 | 危险窗口拒绝 | "打开任务管理器查看 CPU" | Rust 层拒绝，返回 "任务管理器不在允许列表中" |
| 7 | 危险组合键拒绝 | 执行 Win+R 组合键 | Rust 层拒绝，返回 "此组合键不在允许列表中" |
| 8 | 完整流程 | "打开 Chrome，导航到 google.com，截图" | 3 步 loop 完成：打开 Chrome → 点击地址栏 → 输入 URL |

---

## Phase 7: 设置与配置

### 7.1 ComputerUseSettings 类型

```typescript
export interface ComputerUseSettings {
  enabled: boolean;              // 总开关，默认 false
  maxStepsPerTask: number;       // 每个任务最大步数，默认 20
  mouseSpeed: "instant" | "linear";
  mouseDurationMs: number;       // linear 模式移动耗时，默认 200
  typeDelayMs: number;           // 打字每个字符延迟，默认 50
  trustedApps: ComputerTrustEntry[];
  deniedWindowPatterns: string[];
}
```

### 7.2 持久化

存储到 SQLite `user_preferences` 表，复用现有 `user-preferences-persistence.ts`。

### 7.3 UI

设置面板新增 "Computer Use" section：
- 启用/禁用开关
- maxSteps、mouseSpeed、typeDelayMs 配置
- 信任应用列表（可查看/移除）
- 危险窗口模式（可追加自定义模式）

---

## 新增文件清单

| 文件 | 说明 |
|------|------|
| `docs/COMPUTER_USE_PLAN.md` | 本文档 |
| `apps/desktop/src-tauri/src/computer.rs` | Rust 模块：Windows 截屏 + SendInput + 窗口管理 + 安全守卫 + 9 个 Tauri 命令 |
| `packages/core/src/computer-use-types.ts` | 纯数据：`ComputerUseLoopConfig`、`ComputerUseStep`、`ComputerUseAction` 类型 + `parseModelAction()` |
| `packages/core/src/computer-use-prompt.ts` | 纯数据：System prompt 模板 + action output JSON schema |
| `apps/desktop/src/computer-use-loop.ts` | I/O 层：`runComputerUseLoop()` — 截图→模型→action→执行循环 |
| `apps/desktop/src/computer-trust.ts` | 应用信任列表管理 + 持久化 |

## 修改文件清单

| 文件 | 变更 |
|------|------|
| `packages/tools/src/types.ts` | +`ComputerTool` 接口 + 18 个 request/result 类型 |
| `packages/tools/src/descriptors.ts` | +9 个 `computer.*` 工具描述符 |
| `packages/core/src/agent-capability.ts` | +4 个 capability tag |
| `packages/core/src/agents.ts` | 升级 `agent-computer`：扩展 `allowedToolNames` + `prefersVision: true` + `minContextTokens: 16000` |
| `packages/core/src/routing.ts` | +`computer-use` RouteKind + `createComputerUseRouteScore()` + `isComputerUseGoal()` |
| `packages/core/src/workflows.ts` | +`computer-use` 工作流定义 |
| `packages/core/src/index.ts` | 导出 `computer-use-types` 和 `computer-use-prompt` 类型 |
| `apps/desktop/src-tauri/src/lib.rs` | +`mod computer` + generate_handler 追加 9 个命令 |
| `apps/desktop/src-tauri/Cargo.toml` | `windows-sys` features 追加 `Win32_Graphics_Gdi`、`Win32_UI_Input_KeyboardAndMouse`、`Win32_UI_WindowsAndMessaging`、`Win32_System_SystemInformation`；新增 `image` crate |
| `apps/desktop/src/app-runtime.ts` | +`computerTool` 实现 + 审批流 + 路由集成 + action loop 注入 |
| `apps/desktop/src/App.tsx` | +Computer Use 相关 UI：正在进行中指示器、ESC 紧急停止、截屏预览、审批卡片增强 |
| `packages/ui/src/components/` | 可选：`ComputerUseApprovalCard` 组件（含截屏缩略图 + 操作详情） |

## 依赖变更

- **Cargo 新增**：`image = "0.25"`（PNG 截屏编码），`sha2 = "0.10"`（action params 哈希用于 preview_hash 绑定）
- **Cargo 修改**：`windows-sys` features 追加 4 个（见上表）
- **npm**：无新增依赖（截屏在 Rust 层完成，base64 在前端标准 `atob` 解码）

## 工期估算

| Phase | 内容 | 工期 |
|-------|------|------|
| 1 | 类型基础（tools + core + routing + agent + workflows） | 1-2 天 |
| 2 | Rust 原生层（computer.rs + 截屏 + 输入 + 窗口管理 + 安全守卫） | 4-5 天 |
| 3 | Vision action loop（model→action JSON→execute→verify 循环） | 2-3 天 |
| 4 | 权限模型（应用信任 + 拒绝列表 + 审批卡片增强） | 1-2 天 |
| 5 | 运行时接线（app-runtime + 审批流 + 路由集成） | 1-2 天 |
| 6 | 测试（Rust + Vitest + QA） | 2-3 天 |
| 7 | 设置与配置（UI + 持久化） | 1 天 |
| **合计** | | **12-18 天** |

## 风险与注意事项

1. **截屏性能**：GDI `BitBlt` 在 4K 屏幕上可能较慢（>200ms）。若性能不足，改用 DXGI `IDXGIOutputDuplication`（~10ms），但 API 复杂度更高（需要 D3D11 设备 + 纹理拷贝）。建议先用 GDI 实现，性能不够再升级。

2. **`windows-sys` unsafe 代码量**：`windows-sys` 是 raw FFI，所有截屏 API（`GetDC`、`BitBlt`、`CreateCompatibleBitmap` 等）都是 `unsafe`。需要手动管理 HDC/HBITMAP 生命周期防止 GDI 泄漏。如果 `unsafe` 体量过大，可评估改用 `windows` crate（safe wrapper），但需要确认与现有 `windows-sys = "0.61"` 的版本兼容性。

3. **SendInput 权限**：`SendInput` 在普通用户权限下可用，但以管理员身份运行的窗口不接收来自非管理员进程的输入（Windows UIPI）。Javis 以普通用户身份运行时，无法操控"以管理员身份运行"的应用窗口。

4. **前台窗口抢占**：Computer Use 会移动鼠标和注入输入，如果用户同时在使用电脑会冲突。需要在前端显示明显的"Computer Use 正在进行中"指示器，并支持紧急停止按钮（ESC 全局快捷键触发 `cancel_all_model_streams`）。

5. **Vision 模型坐标精度**：模型输出的坐标是像素估算值，可能不精确。需要在 loop 中容忍"点了没反应"的情况，让模型看到新截图后自我纠正。建议加入 dead-loop 检测：连续 3 步相同 action 无效果 → 提示模型尝试不同策略。

6. **最小化窗口**：如果目标窗口被最小化，`SetForegroundWindow` 会尝试恢复。但某些应用可能不会立即响应。需要 `computer.wait` 配合。

7. **远程桌面 / 锁屏**：Computer Use 需要活动桌面。如果用户 RDP 断开或锁屏，截屏将返回黑屏或锁屏画面。需在 action loop 的 screenshot 后检测（纯黑/纯色/锁屏画面）→ 暂停循环并提示用户。

8. **Windows 版本兼容**：目标 Win10 1903+ 和 Win11。`SetForegroundWindow` 在不同版本的 foreground lock 行为略有差异，需要实测验证。`EnumWindows` 在 UWP 应用上可能拿不到标题。

9. **路由误匹配**："打开" "点击" 这类词极其常见。三层评分 + 阈值 ≥5 是初步防御，但需要在 `routing.test.ts` 中对以下类型输入做负向验证：
   - "打开项目文件夹"（应该是 file scan，不是 computer use）
   - "点击确认按钮"（太模糊，不应路由到 computer use）
   - "输入命令"（应该是 shell agent）
   - "帮我看看这个网站"（应该是 research / browser）

10. **`image` crate 大小**：`image = "0.25"` 及其依赖（PNG 编码器）会增加 Windows 构建时间和二进制大小。如果只用 PNG 编码一个功能，可改用轻量 `png` crate（`png = "0.17"`），减少依赖树。

## 验收标准

- [ ] 9 个 `computer.*` Tauri 命令全部实现并注册
- [ ] Rust 安全测试全部通过（12 个测试用例）
- [ ] Vision action loop 能完成端到端 GUI 任务（如"打开计算器，输入 2+2"）
- [ ] 所有写操作经过 confirmed_write 审批流
- [ ] 危险窗口 + 危险组合键在 Rust 层被拒绝
- [ ] Approval 一次性消费 + 过期机制生效
- [ ] 8 个 QA 场景全部 PASS
- [ ] `pnpm check` 通过
