# Playwright Browser Agent 集成方案

## Context

Javis 的 `AgentKind` 类型已声明 `"browser"`，`workflows.ts` 也引用了 browser agent，但实际实现完全缺失：无 agent 定义、无 `browser.*` 工具、无 Rust 命令、无 Playwright 集成。本方案补全这一层，使 Javis 具备浏览器自动化能力——网页研究（导航、截图、内容提取）和 Playwright 测试辅助。

> **已知前置 Bug**：`research-trending-topics` 工作流（`workflows.ts:116`）的 `participatingAgentKinds` 包含 `"browser"`，且 `fetch-details` 步骤（L136）使用 `agentKind: "browser"`。当前 `demoAgents` 无 browser 条目，若 Commander 执行此工作流会导致 agent 查找失败。**修复策略**：实现本计划的 Phase 1.4（browser agent 定义）时此工作流即可正常运作；若需提前规避，可以先将 `"browser"` 从该工作流中移除以防爆炸。

## 架构选型

**Sidecar 模式**：Rust 后端 spawn 一个 Node.js 子进程运行 Playwright，通过 stdin/stdout JSONL 协议通信。

```
User Goal → Commander → Browser Agent → browser.navigate (read)
                                       → browser.click (confirmed_write)
                                           ↓
                                    Rust browser.rs → JSONL → Node.js sidecar (Playwright)
```

**为什么用 sidecar 而非其他方案**：
- Playwright 需要 Node.js 运行时，Rust 无原生 binding
- 匹配现有 `web.rs` 的 `search_with_agent_chrome` 子进程模式
- 进程隔离——sidecar 崩溃不影响主应用
- 无需额外端口（stdin/stdout，无防火墙问题）

**生命周期**：用户可配置——默认按需启动（任务结束后关闭），可选持久模式（整个会话保持运行）。

### Windows 注意事项

- **换行符**：stdin/stdout JSONL 协议在 Windows 上可能因 CRLF 导致解析异常，sidecar 内部应统一使用 `\n` 行分隔，Rust 端使用 `BufRead::read_line` 兼容 `\r\n`
- **进程清理**：Windows 无 SIGTERM/SIGINT，关闭 sidecar 时需通过 `taskkill /PID` 或 `Child::kill()`（内部调用 `TerminateProcess`）；`close` 方法应先尝试优雅退出再强制终止
- **Node.js 路径**：`which = "7"` crate 在 Windows 上能解析 `node.exe`，但 `JAVIS_NODE_PATH` 环境变量覆盖是主要使用路径，减少对 PATH 搜索的依赖
- **Playwright Chromium**：`npx playwright install chromium` 在 Windows 上将 Chromium 安装到 `%LOCALAPPDATA%\ms-playwright\`，无管理员权限即可完成

### 模型路由

Browser agent 需要调用 `browser.*` 工具（含截图 vision 分析），需评估模型选择：
- **DeepSeek（主模型）**：天然支持 tool calling + vision，维持 browser session 跨轮次
- **Mimo CLI sub-agent**：`claude -p` 无状态模式不支持多轮浏览器交互，无法维持 session

**建议**：browser agent 始终使用 DeepSeek 主模型运行，不走 Mimo CLI 分发路径。研究型任务（navigate → getContent → screenshot）通常 3-5 轮，token 开销可控。

---

## Phase 1: 类型基础（packages/tools + packages/core）

### 1.1 工具类型 — `packages/tools/src/types.ts`

在 `WebTool` 接口后（~L255）添加：

```typescript
// ── Browser Tool ──

export interface BrowserNavigateRequest {
  url: string;
  waitForSelector?: string;
  timeoutMs?: number;
}
export interface BrowserScreenshotRequest {
  selector?: string;
  fullPage?: boolean;
  format?: "png" | "jpeg";
  quality?: number;
}
export interface BrowserGetContentRequest {
  selector?: string;
  format?: "text" | "html" | "markdown";
  maxLength?: number;
}
export interface BrowserClickRequest {
  selector: string;
  button?: "left" | "right" | "middle";
  clickCount?: number;
  timeoutMs?: number;
}
export interface BrowserTypeRequest {
  selector: string;
  text: string;
  delay?: number;
  clearBefore?: boolean;
  pressEnter?: boolean;
}
export interface BrowserEvaluateRequest {
  expression: string;
  timeoutMs?: number;
}
export interface BrowserRunTestRequest {
  script: string;
  testFile?: string;
  timeoutMs?: number;
}

export interface BrowserNavigateResult { url: string; title: string; status: number; loadState: string }
export interface BrowserScreenshotResult { dataUrl: string; width: number; height: number }
export interface BrowserGetContentResult { content: string; url: string; title: string }
export interface BrowserClickResult { selector: string; clicked: boolean; newUrl?: string }
export interface BrowserTypeResult { selector: string; typed: boolean; value: string }
export interface BrowserEvaluateResult { result: string; type: string }
export interface BrowserRunTestResult { passed: boolean; exitCode: number; stdout: string; stderr: string; duration: number }

export interface BrowserTool {
  navigate(request: BrowserNavigateRequest): Promise<BrowserNavigateResult>;
  screenshot(request: BrowserScreenshotRequest): Promise<BrowserScreenshotResult>;
  getContent(request: BrowserGetContentRequest): Promise<BrowserGetContentResult>;
  click(request: BrowserClickRequest): Promise<BrowserClickResult>;
  type(request: BrowserTypeRequest): Promise<BrowserTypeResult>;
  evaluate(request: BrowserEvaluateRequest): Promise<BrowserEvaluateResult>;
  runTest(request: BrowserRunTestRequest): Promise<BrowserRunTestResult>;
}
```

### 1.2 工具描述符 — `packages/tools/src/descriptors.ts`

在 `workspace.delete` 后（~L133）追加 7 个描述符：

| name | permissionLevel | summary |
|------|----------------|---------|
| `browser.navigate` | read | Navigate browser to URL, wait for load |
| `browser.screenshot` | read | Capture page/element screenshot |
| `browser.getContent` | read | Extract text/HTML from current page |
| `browser.click` | confirmed_write | Click a page element (requires approval) |
| `browser.type` | confirmed_write | Type into an input field (requires approval) |
| `browser.evaluate` | confirmed_write | Execute JS in page context (requires approval) |
| `browser.runTest` | confirmed_write | Run Playwright test script, return results (requires approval — script may contain page interactions) |

### 1.3 能力标签 — `packages/core/src/agent-capability.ts`

- `AgentCapabilityTag` 联合类型追加：`"browser_navigate" | "browser_interact" | "browser_test"`
- `inferCapabilityTags()` switch 追加映射：
  - `browser.navigate/screenshot/getContent` → `browser_navigate`
  - `browser.click/type/evaluate` → `browser_interact`
  - `browser.runTest` → `browser_test`

### 1.4 Agent 定义 — `packages/core/src/agents.ts`

在 `demoAgents` 数组末尾（`chinese-reviewer` 之后，L124 之前）添加 browser agent：

```typescript
{
  id: "agent-browser",
  kind: "browser",
  displayName: "Browser Agent",
  description: "Web browsing, content extraction, and Playwright test execution",
  allowedToolNames: [
    "browser.navigate", "browser.screenshot", "browser.getContent",
    "browser.click", "browser.type", "browser.evaluate", "browser.runTest",
  ],
  modelRequirements: { prefersVision: true, prefersCode: false, minContextTokens: 8000 },
  systemPrompt: {
    en: "You are the Browser Agent. Navigate web pages, extract content, and interact with page elements. Read-only operations (navigate, screenshot, getContent) are safe. Click, type, and evaluate require user approval. Never automate account-changing actions.",
    zhCN: "你是浏览器代理。浏览网页、提取内容、与页面元素交互。只读操作无需审批，点击/输入/执行需用户批准。绝不自动化账户变更操作。",
  },
},
```

### 1.5 路由 — `packages/core/src/routing.ts`

- `RouteKind` 联合类型追加 `"browser"`
- 新增 `createBrowserRouteScore()` 函数，关键词信号：
  - `browse/browser/open page/screenshot/网页/浏览/截图` → +3
  - `click/type/fill/submit/form/点击/输入/填写` → +1
  - `test/e2e/playwright/测试/自动化测试` → +2
  - URL 存在 + browser 关键词 → +1
- 新增 `isBrowserGoal()` helper
- 在 `scoreRoutes()` 返回数组中追加 `createBrowserRouteScore(userGoal)` 调用
- `routeToWorkflowId` 追加 `"browser"` case

### 1.6 工作流 — `packages/core/src/workflows.ts`

- `WorkbenchWorkflowId` 追加 `"browser-research" | "browser-test"`
- 新增两个工作流定义：
  - **browser-research**：navigate-page → extract-content → verify-extraction（3 步串行）
  - **browser-test**：inspect-project → run-tests → verify-results（3 步串行）

---

## Phase 2: Playwright Sidecar（Node.js）

### 2.1 目录结构

```
apps/desktop/src-tauri/sidecar/browser/
├── package.json          # playwright 依赖
├── tsconfig.json
└── src/
    └── index.ts          # JSONL 协议实现
```

### 2.2 JSONL 协议

```
请求:  {"id":"req-1","method":"navigate","params":{"url":"https://..."}}
响应:  {"id":"req-1","result":{"url":"...","title":"...","status":200}}
错误:  {"id":"req-1","error":{"code":-32000,"message":"..."}}
就绪:  {"id":"ready","result":{"status":"ready"}}
```

### 2.3 支持的方法

| 方法 | 参数 | 返回 |
|------|------|------|
| `navigate` | url, waitForSelector?, timeoutMs? | url, title, status, loadState |
| `screenshot` | selector?, fullPage?, format?, quality? | dataUrl (base64), width, height |
| `getContent` | selector?, format?, maxLength? | content, url, title |
| `click` | selector, button?, clickCount?, timeoutMs? | selector, clicked, newUrl |
| `type` | selector, text, delay?, clearBefore?, pressEnter? | selector, typed, value |
| `evaluate` | expression, timeoutMs? | result, type |
| `runTest` | script, testFile?, timeoutMs? | passed, exitCode, stdout, stderr, duration |
| `close` | — | closed: true |

### 2.4 生命周期

- 首次调用时 `ensureBrowser()` 启动 Chromium headless
- 使用临时 profile 目录（参考 `web.rs` 的 `create_agent_chrome_profile_dir`）
- 收到 `close` 方法或 SIGTERM/SIGINT 时清理退出
- `postinstall` 脚本：`npx playwright install chromium`（一次性下载 ~150MB，建议文档说明而非每次 install 触发；CI 环境可用 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` 跳过）

---

## Phase 3: Rust 后端 — `apps/desktop/src-tauri/src/browser.rs`

### 3.1 模块结构

```rust
// 状态
pub(crate) struct BrowserState {
    child: Mutex<Option<Child>>,     // sidecar 进程句柄
    lifecycle: Mutex<BrowserLifecycle>, // OnDemand | Persistent
}

// Tauri 命令（8 个）
browser_navigate      // read — 直接调用 sidecar
browser_screenshot    // read — 直接调用 sidecar
browser_get_content   // read — 直接调用 sidecar
browser_click         // confirmed_write — 验证 approval 后调用
browser_type          // confirmed_write — 验证 approval 后调用
browser_evaluate      // confirmed_write — 验证 approval 后调用
browser_run_test      // confirmed_write — 验证 approval 后调用（脚本可能含页面交互）
browser_close         // 关闭 sidecar 进程
```

### 3.2 Sidecar 管理

- `resolve_node_executable()` — 检查 `JAVIS_NODE_PATH` 环境变量，fallback 到 PATH 上的 `node`
- `resolve_sidecar_script()` — 检查 `JAVIS_BROWSER_SIDECAR_PATH`，fallback 到 exe 同级 `sidecar/browser/dist/index.js`
- `spawn_sidecar()` — 启动 Node.js 进程，等待 `ready` 消息（30s 超时）
- `send_request()` — 写 stdin JSONL，读 stdout JSONL，60s 命令超时
- 崩溃恢复：`send_request` 检测到进程退出后自动 re-spawn

### 3.3 安全守卫

- `validate_url()` — 只允许 `http://` / `https://`，拒绝 `file://`、`javascript:`、内网地址
- `validate_browser_approval()` — 写操作需验证 approval ID、tool name、task ID（复用 `code.rs` 的 `require_native_approval_binding` 模式）

### 3.4 注册

- `lib.rs`：`mod browser;`，`.manage(browser::BrowserState::new())`，8 个命令加入 `generate_handler!`
- `Cargo.toml`：添加 `which = "7"`（解析 node 路径）
- `tauri.conf.json`：sidecar dist 目录加入 bundle resources

---

## Phase 4: 运行时接线 — `apps/desktop/src/app-runtime.ts`

### 4.1 browserTool 实现

```typescript
browserTool: {
  navigate: (req) => invoke("browser_navigate", { request: req }),
  screenshot: (req) => invoke("browser_screenshot", { request: req }),
  getContent: (req) => invoke("browser_get_content", { request: req }),
  click: (req) => /* approval flow → */ invoke("browser_click", { request: req }),
  type: (req) => /* approval flow → */ invoke("browser_type", { request: req }),
  evaluate: (req) => /* approval flow → */ invoke("browser_evaluate", { request: req }),
  runTest: (req) => /* approval flow → */ invoke("browser_run_test", { request: req }),
},
```

### 4.2 写操作审批流

`click`/`type`/`evaluate`/`runTest` 遵循 `code.applyProposedEdit` 的模式：
1. `createConfirmedWriteApproval()` — 创建 PermissionRequest（level: confirmed_write）
2. UI 显示审批卡片（展示 selector/表达式/目标 URL）
3. 用户批准后 `runtime.resolvePermission("approved", requestId)`
4. 调用 Rust 命令，附带 approvalId + taskId

### 4.3 路由集成

主 dispatch 逻辑添加 `isBrowserGoal(userGoal)` 检查，命中时路由到 browser-research 或 browser-test 工作流。

---

## Phase 5: 设置与配置

### 5.1 BrowserSettings 类型

```typescript
export interface BrowserSettings {
  lifecycle: "on-demand" | "persistent";
  defaultViewport: { width: number; height: number };
  engine: "chromium" | "firefox" | "webkit";
  headless: boolean;
  nodePath?: string;       // 覆盖 node 路径
  sidecarPath?: string;    // 覆盖 sidecar 脚本路径
}
```

### 5.2 持久化

存储到 SQLite `user_preferences` 表（复用现有 `user-preferences-persistence.ts` 模式）。

### 5.3 UI

设置面板新增 "Browser" section，包含生命周期模式、视口大小、引擎选择、Node.js 路径覆盖。

---

## Phase 6: 测试

### 6.1 Vitest 单元测试

- `packages/tools/src/` — BrowserTool 描述符完整性、权限级别正确性
- `packages/core/src/routing.test.ts` — browser 路由评分：命中/未命中/阈值边界
- `packages/core/src/agent-capability.test.ts` — browser agent 能力标签、findByCapabilities 查找

### 6.2 Rust 测试（browser.rs 内 `#[cfg(test)]`）

- `test_resolve_sidecar_script_missing` — sidecar 未安装时返回 NotFound
- `test_spawn_sidecar_timeout` — 30s 超时后返回 Timeout error
- `test_browser_approval_validation` — 缺 approval、错误 tool name、错误 task ID
- `test_browser_approval_expired` — 过期审批 ID 被拒绝
- `test_validate_url` — 拒绝 file://、javascript://、data:、内网地址（127.0.0.1、10.x、172.16-31.x、192.168.x）
- `test_validate_url_allow` — 允许 http/https 公网 URL
- `test_browser_request_serialization` — 所有 8 种请求类型 JSON roundtrip（含 runTest）
- `test_concurrent_requests` — 多个并发请求串行化处理（不交叉响应）
- `test_sidecar_crash_recovery` — send_request 检测到进程退出后自动 re-spawn 并重试
- `test_persistent_mode_reuse` — 持久模式下重复调用不创建新进程
- `test_on_demand_cleanup` — on-demand 模式下任务结束后进程被关闭

### 6.3 QA 场景（`docs/qa/2026-05-31/`）

| # | 场景 | 预期 |
|---|------|------|
| 1 | 只读研究：导航 → 提取内容 → 截图 | 全程无需审批 |
| 2 | 交互流：导航 → 点击 → 输入 | 每个写操作弹出审批卡 |
| 3 | 测试执行：运行 Playwright 测试脚本 | 弹出审批卡（confirmed_write），批准后返回 pass/fail 结果 |
| 4 | Sidecar 崩溃恢复：手动 kill 进程后再次调用 | 自动 re-spawn |
| 5 | 持久模式：多次导航不重新启动浏览器 | 无冷启动延迟 |

---

## 新增文件清单

| 文件 | 说明 |
|------|------|
| `apps/desktop/src-tauri/sidecar/browser/package.json` | sidecar 项目，依赖 playwright |
| `apps/desktop/src-tauri/sidecar/browser/tsconfig.json` | TypeScript 配置 |
| `apps/desktop/src-tauri/sidecar/browser/src/index.ts` | JSONL 协议 + Playwright 调用 |
| `apps/desktop/src-tauri/src/browser.rs` | Rust 模块：sidecar 管理 + 8 个 Tauri 命令 |

## 修改文件清单

| 文件 | 变更 |
|------|------|
| `packages/tools/src/types.ts` | +BrowserTool 接口 + 14 个 request/result 类型 |
| `packages/tools/src/descriptors.ts` | +7 个 browser.* 工具描述符 |
| `packages/core/src/agent-capability.ts` | +3 个 capability tag + inferCapabilityTags 映射 |
| `packages/core/src/agents.ts` | +browser agent 定义（双语 prompt） |
| `packages/core/src/routing.ts` | +browser RouteKind + 评分函数 + isBrowserGoal |
| `packages/core/src/workflows.ts` | +browser-research + browser-test 工作流 |
| `apps/desktop/src-tauri/src/lib.rs` | +mod browser + manage state + 8 个 handler |
| `apps/desktop/src-tauri/Cargo.toml` | +which = "7" |
| `apps/desktop/src-tauri/tauri.conf.json` | +sidecar resources |
| `apps/desktop/src/app-runtime.ts` | +browserTool 实现 + 审批流 + 路由集成 |

## 依赖变更

- **npm**：`playwright ^1.52.0`（仅 sidecar package.json）
- **Cargo**：`which 7`（解析 node 可执行文件路径）

## 工期估算

| Phase | 内容 | 工期 |
|-------|------|------|
| 1 | 类型基础（tools + core + routing + agent + workflows） | 1-2 天 |
| 2 | Playwright sidecar（Node.js JSONL 协议） | 3-4 天 |
| 3 | Rust 后端（browser.rs + sidecar 生命周期） | 3-4 天 |
| 4 | 运行时接线（app-runtime + 审批流） | 2-3 天 |
| 5 | 设置与配置 | 1 天 |
| 6 | 测试（单元 + Rust + QA） | 2-3 天 |
| **合计** | | **12-17 天** |

## 验证方式

1. `pnpm check` — typecheck + Vitest + Rust 全部通过
2. `pnpm dev` — 启动 Tauri dev server，手动测试 browser-research 工作流
3. 输入 "open https://example.com and take a screenshot" 验证只读路径
4. 输入 "click the login button" 验证审批卡片弹出
5. 手动 kill sidecar 进程，验证自动恢复
