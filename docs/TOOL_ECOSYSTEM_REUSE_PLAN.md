# Javis 工具生态复用与工具层治理方案

> 状态：提案
> 日期：2026-07-22
> 目标：减少重复造工具，统一工具协议，并让外部工具复用不破坏 Javis 的审批、安全和任务恢复能力。

## 1. 结论

Javis 不应继续为所有文件、Git、浏览器、代码和终端能力分别维护一套独立实现。

推荐采用下面的分工：

```text
Javis                         总控制面
  - Commander / DAG           规划、调度、重规划
  - Tool Gateway              工具白名单、权限、审计
  - TaskSnapshot / SQLite     状态、恢复、历史
  - Tauri / Rust              路径守卫、审批绑定、真正写入

LangChain                    单步骤模型-工具循环
OpenCode                     代码 Agent 和代码工具
MCP                          文件、Git、网页等通用工具接入协议
Page Agent + Playwright      Javis 现有浏览器 Agent 和 Playwright Sidecar
Codex / Goose                工具注册、沙箱、审批和扩展机制的参考实现
```

LangGraph 暂时不接管 Javis 顶层 DAG。Javis 已经拥有任务级规划、依赖、重试、重规划和 checkpoint；LangChain 只负责一个步骤内部的工具循环即可。

## 2. 当前问题

当前 `packages/tools/src/descriptors.ts` 已注册约 59 个工具，但工具定义、参数校验、具体分发和原生实现分散在多层：

- `ToolDescriptor` 主要描述名称、权限和少量 `requiredInputs`，缺少完整的 JSON Schema、输出 Schema、范围、枚举和字段说明。
- Agent tool schema 对非 MCP 工具默认允许额外字段，模型可以传入未声明参数。
- `workflow-executor.ts` 中存在大型按名称分发的 `switch`，调用处大量使用类型强转，容易出现描述和实现不一致。
- Rust 已有 `read_file_chunk` 等基础能力，但没有完整暴露为 Agent 可选的 `file.readText` 工具。
- 文件读取、目录浏览、代码搜索、浏览器操作和终端执行的输入输出格式不统一，模型难以稳定调用。
- 写操作已经有审批和 Rust 安全边界，不能因为接入第三方工具而绕过这些边界。

因此问题的核心不是缺少更多工具，而是缺少一个统一的工具契约和注册机制。

## 3. 复用项目

### 3.1 OpenCode：代码工具和代码 Agent

项目：[anomalyco/opencode](https://github.com/anomalyco/opencode/tree/dev/packages/opencode/src/tool)

许可证：MIT。

重点借鉴：

- `read`、`grep`、`glob`、`edit`、`apply_patch`、`shell` 工具的输入输出设计；
- 工具注册表和工具描述文件；
- 输出截断、无效调用和工具失败结果；
- Todo、Plan 和代码任务的工具分层。

Javis 已经依赖 `opencode-ai`，代码 Agent 应优先通过现有 OpenCode backend 使用这些能力，而不是在 Javis 中重新实现一套代码工具。

### 3.2 OpenAI Codex：终端、沙箱和审批机制

项目：[openai/codex](https://github.com/openai/codex/tree/main/codex-rs/core/src/tools)

许可证：Apache-2.0。

重点借鉴：

- 工具注册表和路由；
- 命令执行生命周期和取消；
- 命令执行前审批；
- 沙箱策略和网络访问审批；
- 工具事件、调用追踪和测试组织方式。

不建议直接复制 Codex 的完整执行器。Javis 已经有自己的 Tauri/Rust 原生安全模型，应借鉴设计和测试边界，并把 Javis 的审批 ID、task ID、preview hash 作为最终绑定依据。

### 3.3 MCP 官方参考服务器：文件、Git 和 Fetch

项目：[modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers)

重点目录：

- [Filesystem](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem)
- [Git](https://github.com/modelcontextprotocol/servers/tree/main/src/git)
- [Fetch](https://github.com/modelcontextprotocol/servers/tree/main/src/fetch)

Javis 已有 MCP server 配置、动态工具发现和 schema 校验，因此应优先把通用只读能力作为 MCP server 接入：

- 文件列表、文件读取和目录查询；
- Git status、diff、log、show；
- HTTP 页面抓取。

这些服务的具体子项目许可证需要逐项核对。可以优先作为外部进程运行和参考实现，不要在没有确认许可证的情况下复制代码。

### 3.4 Page Agent + Playwright Sidecar：现有浏览器能力

Javis 已经有 Page Agent 和 Playwright Sidecar：

- Page Agent 负责网页任务的规划、来源选择和证据整理；
- `browser.*` 工具负责导航、读取、截图和交互；
- Tauri `browser.rs` 负责进程管理、网络策略和边界校验；
- Node sidecar 使用 Playwright 驱动实际浏览器。

因此当前不需要再接入 Playwright MCP。再接一层会变成：

```text
Page Agent -> Javis browser.* -> Playwright MCP -> Playwright
```

这会增加协议、进程和权限适配成本。Playwright MCP 可以作为参考实现，但不作为当前运行时依赖。

优先借鉴以下设计并补回现有 Sidecar：

- `browser.snapshot`：返回页面的可访问性结构和可读文本；
- 稳定的 `elementRef`：点击和输入优先使用元素引用，CSS selector 作为兼容方式；
- 统一导航等待、页面状态和超时错误；
- 每次交互后重新读取页面状态。

点击、输入、上传、evaluate 等操作仍需经过 Javis 的审批和审计，不能直接把浏览器写操作暴露给普通 Agent。

### 3.5 Goose：Rust 扩展和工具监控

项目：[aaif-goose/goose](https://github.com/aaif-goose/goose)

许可证：Apache-2.0。

重点借鉴：

- Rust 中的 MCP 扩展管理；
- 工具权限和工具监控；
- 工具结果、错误和执行状态的统一表示；
- 长任务的会话和上下文管理。

Goose 更适合作为架构参考，不建议整体嵌入 Javis。

## 4. 目标工具架构

每个工具只保留一份定义。定义同时服务于模型、运行时、权限和 UI：

```ts
interface ToolDefinition<Input, Output> {
  name: string;
  summary: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  permissionLevel: "read" | "preview" | "confirmed_write" | "dangerous";
  writeRiskLevel?: "safe" | "risky" | "dangerous";
  ownerAgentKinds: readonly string[];
  capabilityTags: readonly string[];
  limits?: {
    timeoutMs?: number;
    maxInputBytes?: number;
    maxOutputBytes?: number;
  };
  execute(context: ToolExecutionContext, input: Input): Promise<Output>;
}
```

这份定义应生成或驱动：

- Commander planner 可见的工具说明；
- LangChain `AgentToolSpec`；
- MCP 动态工具描述；
- 运行时输入校验；
- 权限和审批判断；
- UI 工具展示信息；
- 工具契约测试。

包边界保持不变：

- `packages/tools`：纯工具契约、JSON Schema、权限和结果类型；
- `packages/core`：Tool Gateway、路由、执行策略和事件；
- `apps/desktop`：Tauri 调用、Provider、MCP 进程和 UI 投影；
- `apps/desktop/src-tauri`：路径守卫、审批绑定、沙箱和真正的副作用执行。

## 5. 工具分层

### 第一层：稳定基础工具

优先建设以下工具，其他工具暂时不要继续扩张：

1. `file.listDirectory`
2. `file.readText`
3. `file.searchText`
4. `shell.runReadOnlyCommand`
5. `git.status`
6. `git.diff`
7. `browser.snapshot`
8. `browser.navigate`
9. `code.proposeEdit`
10. `code.applyProposedEdit`

每个工具必须有完整输入 Schema、输出格式、超时、输出大小上限和失败原因。

### 第二层：只读 Agent 工具

LangChain 只开放 `read` 以及明确灰度的 `preview` 工具，例如：

- 文件扫描和读取；
- Git 查询；
- 网页搜索和抓取；
- 浏览器导航、截图和页面读取；
- 代码搜索和修改预览。

### 第三层：Javis direct apply 工具

以下操作永远不直接进入 LangChain/OpenCode 的普通工具循环：

- 写文件；
- 应用 patch；
- Git stage、commit、push、创建 PR；
- 浏览器点击、输入、上传；
- 鼠标、键盘和桌面 UI 操作；
- 运行危险或非只读命令。

Agent 只能先生成 proposal/preview，之后由 Javis 创建 direct apply 步骤，经 UI 审批和 Rust 校验后执行。

## 6. 分阶段实施

### Phase 0：工具盘点和契约冻结

- 建立工具清单：名称、实现位置、调用方、权限、输入、输出、测试和替代项目；
- 为不稳定或未接通的工具取消默认暴露；
- 统一工具名称和错误格式；
- 将 `additionalProperties` 默认改为拒绝；
- 明确每个工具的最大输入、最大输出和超时。

验收：每个已暴露工具都能找到唯一的定义、唯一的执行入口和至少一个契约测试。

### Phase 1：补齐基础工具注册表

- 增加 `file.readText`、`file.listDirectory` 和 `file.searchText`；
- 将已有 `read_file_chunk`、`rg`/搜索和目录能力接入统一工具定义；
- 用注册表替代 `workflow-executor.ts` 中新增工具继续堆叠的 `switch`；
- 为工具生成 LangChain schema 和 planner 描述。

验收：错误参数在执行前被拒绝，模型可以稳定完成“查找文件 -> 读取文件 -> 搜索内容”的基本流程。

### Phase 2：接入成熟外部工具

- 文件、Git、Fetch：优先接入 MCP 官方参考服务器；
- 浏览器：保留 Page Agent 和现有 Playwright Sidecar，借鉴 snapshot、稳定元素引用和错误模型；
- 代码：通过 OpenCode backend 使用 read/grep/edit/apply_patch 设计；
- 终端和审批：对照 Codex 的 registry、lifecycle 和 sandboxing 重新整理 Javis 实现；
- MCP 工具仍需经过 Javis 的本地权限分类，第三方的 `readOnlyHint` 不能单独授予执行权限。

验收：外部工具和内置工具都能进入同一个 Tool Gateway，审计记录包含 task、run、tool、call ID 和结果状态。

### Phase 3：LangChain 和 UI 接入

- LangChain 只接收统一的工具 schema；
- 工具事件映射为 `requested -> started -> completed/failed`；
- UI 展示步骤、工具、证据和验证摘要，不展示原始思维链；
- 保留 legacy backend 作为启动前回退，不允许调用一半后切换后端。

验收：同一只读任务在 legacy 和 LangChain backend 下，完成、失败、取消和 `request_input` 语义一致。

### Phase 4：扩大灰度和收缩旧实现

- 先扩大只读 Agent 范围，再开放经过审批的 preview；
- 完成真实 provider、打包重启、resume 和产品工作流验收；
- 确认没有生产路径继续依赖旧的文本 JSON ReAct 后，再删除 legacy loop；
- 暂不引入第二套任务级 checkpoint。

## 7. 安全规则

1. 第三方工具只能通过 Javis Tool Gateway 执行，禁止直接调用 Tauri 写命令。
2. `confirmed_write` 和 `dangerous` 工具必须有 UI 审批、native approval binding、路径/作用域检查和一次性消费。
3. 工具参数必须在模型调用前和实际执行前各校验一次。
4. 工具输出必须截断、脱敏并限制大小，不能把完整文件、密钥或大段日志直接回传模型。
5. 任何 provider 的 tool call capability 未明确可用时，LangChain backend 不得用文本 JSON 伪造工具调用。
6. MCP server 的 schema、注解和工具名称都属于不可信输入，必须经过本地权限分类和 allowlist。

## 8. 验收标准

- 所有默认暴露工具都有完整输入 Schema、输出格式、超时和错误结果；
- 非法类型、缺少必填字段、未知字段、越界数值都在执行前失败；
- 读操作不会产生写副作用；写操作不会绕过审批；
- 工具调用支持取消、超时、输出截断和事件追踪；
- 工具结果可写入 SharedContext，并能在 checkpoint 恢复；
- MCP、LangChain、OpenCode 和内置工具都经过同一个 Tool Gateway；
- 通过 `pnpm typecheck`、相关 Vitest、`pnpm rust:test`、`pnpm rust:check`；
- 至少完成一次真实 provider 的只读 smoke test，以及一次打包后的重启恢复测试。

## 9. 最终建议

第一步不要接入更多 Agent 框架，而是先把工具注册表和基础文件工具补齐。

最小可行路线是：

```text
统一 ToolDefinition
  -> file.readText / file.listDirectory / file.searchText
  -> MCP Filesystem + Page Agent / Playwright Sidecar
  -> OpenCode 负责代码工具
  -> Codex 参考终端和审批实现
  -> LangChain 只运行只读/预览步骤
```

Javis 保留任务控制、审批、安全和持久化；外部项目只提供成熟的工具实现和执行模式。
