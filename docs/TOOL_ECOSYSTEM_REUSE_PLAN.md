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
OpenCode                     代码领域执行层和代码工具
  - read / grep / glob        只读代码探索，受 Rust 工作区沙箱约束
  - patch proposal            生成补丁提案，不直接写文件
MCP                          可选的文件、Git、Fetch 等外部只读工具协议
Page Agent + Playwright      Javis 现有浏览器 Agent 和 Playwright Sidecar
Codex / Goose                工具注册、沙箱、审批和扩展机制的参考实现
```

LangGraph 暂时不接管 Javis 顶层 DAG。Javis 已经拥有任务级规划、依赖、重试、重规划和 checkpoint；LangChain 只负责一个步骤内部的工具循环即可。

OpenCode 作为代码领域的主执行层：代码探索、搜索、上下文读取和补丁提案优先交给 OpenCode。OpenCode 的内部只读工具运行在 Rust 创建的工作区只读沙箱中；文件修改、应用 patch、Git 写操作仍由 Javis 生成 direct apply 步骤并经过现有审批链路。

## 2. 当前问题

当前 `packages/tools/src/descriptors.ts` 已注册约 59 个工具，但工具定义、参数校验、具体分发和原生实现分散在多层：

- `ToolDescriptor` 主要描述名称、权限和少量 `requiredInputs`，缺少完整的 JSON Schema、输出 Schema、范围、枚举和字段说明。
- Agent tool schema 对非 MCP 工具默认允许额外字段，模型可以传入未声明参数。
- `workflow-executor.ts` 中存在大型按名称分发的 `switch`，调用处大量使用类型强转，容易出现描述和实现不一致。
- Rust 已有 `read_file_chunk` 等基础能力，但当前还没有统一的 Agent 文件读取契约；本方案暂不通过新增 `file.readText` 名称解决。
- 文件读取、目录浏览、代码搜索、浏览器操作和终端执行的输入输出格式不统一，模型难以稳定调用。
- 当前 OpenCode backend 已通过 Rust 调用 `opencode run --pure` 生成补丁提案，但 OpenCode 内部只读工具事件还没有完整投影到 Javis 的工具审计和 UI。
- 写操作已经有审批和 Rust 安全边界，不能因为接入第三方工具而绕过这些边界。

因此问题的核心不是缺少更多工具，而是缺少一个统一的工具契约和注册机制。

## 3. 复用项目

### 3.1 OpenCode：代码领域执行层

项目：[anomalyco/opencode](https://github.com/anomalyco/opencode/tree/dev/packages/opencode/src/tool)

许可证：MIT。

当前实现：

- `apps/desktop` 已依赖 `opencode-ai`，Rust 会优先解析随应用安装的 OpenCode CLI；
- `code.proposeEdit` 通过 `opencode run --pure` 生成结构化 patch proposal；
- OpenCode 进程运行在 Rust 的 workspace read-only sandbox 中；
- 当前配置禁止 OpenCode 直接使用 `edit`、`bash` 和 `webfetch`；
- OpenCode runtime 目前按一次补丁提案调用计量，内部工具调用尚未进入 Javis 的逐工具事件和审计链路。

目标定位：

- `read`、`grep`、`glob`、`edit`、`apply_patch`、`shell` 工具的输入输出设计；
- 工具注册表和工具描述文件；
- 输出截断、无效调用和工具失败结果；
- Todo、Plan 和代码任务的工具分层。

Javis 不再为代码 Agent 重复实现另一套 `read`、`grep` 和 `glob`。代码探索、调用链分析、代码上下文读取和 patch proposal 优先路由到 OpenCode backend。接入时需要解析 OpenCode JSON event stream，把内部只读工具的开始、完成、失败和截断信息投影为 Javis 事件。

OpenCode 的能力分两类处理：

- `read`、`grep`、`glob`：允许在 Rust 限定的 workspace read-only sandbox 中由 OpenCode 内部执行；
- `edit`、`apply_patch`、`shell`：不直接开放。OpenCode 只能返回 patch proposal，Javis 校验 proposal 后创建 direct apply 步骤；shell 继续使用 Javis 现有终端和审批模型。

因此 OpenCode 是 Javis 的代码领域执行层，但不是第二个权限控制面。Commander、任务状态、审批、持久化和最终写入仍由 Javis 负责。

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

Javis 已有 MCP server 配置、动态工具发现和 schema 校验。当前真正可执行的是启用且带 command 的 `stdio` server；`sse` 可以被配置解析，但还没有进入实际执行链路。

MCP 作为可选扩展协议，用于补充 OpenCode 和现有内置工具没有覆盖的通用只读能力：

- 文件列表、文件读取和目录查询；
- Git status、diff、log、show；
- HTTP 页面抓取。

这些 server 当前没有内置到 Javis。接入前需要逐项核对许可证、Windows 打包方式和启动命令；优先作为外部 `stdio` 进程运行，不要在没有确认许可证的情况下复制代码。

### 3.4 Page Agent + Playwright Sidecar：现有浏览器能力

Javis 已经有 Page Agent 和 Playwright Sidecar：

- Page Agent 是 Javis Agent Registry 中的网页 Agent，使用通用 DAG/ReAct runtime 完成来源选择、网页步骤执行和证据整理；
- `browser.*` 工具负责导航、读取、截图和交互；
- Tauri `browser.rs` 负责进程管理、网络策略和边界校验；
- Node sidecar 使用 Playwright 驱动实际浏览器。

因此当前不需要再接入 Playwright MCP。再接一层会变成：

```text
Page Agent -> Javis browser.* -> Playwright MCP -> Playwright
```

这会增加协议、进程和权限适配成本。Playwright MCP 可以作为参考实现，但不作为当前运行时依赖。

浏览器近期保持现状：

- Agent 工具继续使用 `browser.navigate`、`browser.getContent`、`browser.screenshot`、`browser.extractLinks` 等现有名称；
- 点击和输入继续使用 CSS selector；
- 原生 `browser_snapshot` 继续作为文本、截图和页面状态的快捷聚合命令，不新增同名 Agent Tool；
- accessibility snapshot 和稳定 `elementRef` 暂不列入本轮工具治理范围；
- `browser.upload` 当前未实现，不在默认工具表中。

点击、输入、evaluate 和 runTest 等现有写操作仍需经过 Javis 的审批和审计，不能直接把浏览器写操作暴露给普通 Agent。

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

每个工具只保留一份纯契约；真实执行器按运行环境单独注册。这样可以统一模型、权限和 UI 信息，同时保持现有包边界：

```ts
interface ToolContract<Input, Output> {
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
}

interface ToolHandler<Input, Output> {
  toolName: ToolContract<Input, Output>["name"];
  execute(context: ToolExecutionContext, input: Input): Promise<Output>;
}
```

纯契约应生成或驱动：

- Commander planner 可见的工具说明；
- LangChain `AgentToolSpec`；
- MCP 动态工具描述；
- 运行时输入校验；
- 权限和审批判断；
- UI 工具展示信息；
- 工具契约测试。

`ToolHandler` 不进入 `packages/tools`。需要 Tauri、Provider、文件 I/O 或外部进程的 handler 位于 `apps/desktop`，最终副作用继续由 Rust 命令执行。

包边界保持不变：

- `packages/tools`：纯工具契约、JSON Schema、权限和结果类型；
- `packages/core`：Tool Gateway、路由、执行策略和事件；
- `apps/desktop`：Tauri 调用、Provider、MCP 进程和 UI 投影；
- `apps/desktop/src-tauri`：路径守卫、审批绑定、沙箱和真正的副作用执行。

## 5. 工具分层

### 第一层：稳定基础工具

优先治理以下现有工具，暂不发起跨域重命名：

1. `computer.listDirectory`
2. `file.scanMarkdownDocuments`
3. `code.inspectRepository`
4. `code.searchRepository`
5. `code.traceCallChain`
6. `shell.runReadOnlyCommand`
7. `browser.navigate`
8. `browser.getContent`
9. `browser.screenshot`
10. `code.proposeEdit`
11. `code.applyProposedEdit`

每个工具必须有完整输入 Schema、输出格式、超时、输出大小上限和失败原因。

`read_file_chunk` 和 `list_directory` 暂时保留为原生命令，不在本阶段新增 `file.readText`、`file.listDirectory` 或 `file.searchText` 别名。代码文件读取、搜索和目录探索由 OpenCode code layer 负责；其他文件场景继续使用现有 File/Computer Agent 工具。

### 第二层：只读 Agent 工具

LangChain 只开放 `read` 以及明确灰度的 `preview` 工具，例如：

- 文件扫描和读取；
- Git 查询；
- 网页搜索和抓取；
- 浏览器导航、截图和页面读取；
- 代码搜索和修改预览。

代码领域任务优先交给 OpenCode。LangChain 不再承担代码仓库内的自由探索循环，只在 Commander 明确选择的非代码步骤中使用统一工具 schema。

### 第三层：Javis direct apply 工具

以下操作永远不直接进入 LangChain/OpenCode 的普通工具循环：

- 写文件；
- 应用 patch；
- Git stage、commit、push、创建 PR；
- 浏览器点击、输入、evaluate、runTest；
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

- 不改现有工具名称，先为 `computer.listDirectory`、`file.scanMarkdownDocuments`、`code.inspectRepository`、`code.searchRepository` 和 `code.traceCallChain` 补齐纯契约；
- `read_file_chunk` 和 `list_directory` 保持原生命令，不在本阶段新增 `file.*` Agent Tool；
- 用注册表替代 `workflow-executor.ts` 中新增工具继续堆叠的 `switch`；
- 为工具生成 LangChain schema 和 planner 描述。

验收：错误参数在执行前被拒绝；现有 File/Computer Agent 流程不因契约治理改变工具名称或行为。

### Phase 2：建立 OpenCode code layer

- 代码探索、读取、`grep`、`glob`、调用链调查和 patch proposal 优先路由到 OpenCode backend；
- 保留 Rust workspace read-only sandbox，OpenCode 不获得直接文件写入、shell 或 webfetch 权限；
- 解析 OpenCode JSON event stream，将内部只读工具事件映射为 Javis 的 started/completed/failed 事件；
- 对内部工具输出执行截断、脱敏和大小限制；
- OpenCode 只返回结构化 patch proposal，Javis 继续校验 changed files、patch hash 和 workspace scope；
- patch apply、Git 写入和终端写操作继续走现有 direct apply 与审批链路。

验收：Code Agent 可以通过 OpenCode 稳定完成“搜索 -> 读取 -> 分析 -> 生成 patch proposal”；Javis 能关联 task、run、step 和 OpenCode 内部只读工具事件；OpenCode 无法直接修改工作区。

### Phase 3：MCP、LangChain 和 UI 接入

- 文件、Git、Fetch 的额外只读能力按需接入 MCP `stdio` server，不替换现有内置工具；
- MCP 工具仍需经过 Javis 的本地权限分类，第三方的 `readOnlyHint` 不能单独授予执行权限；
- 浏览器保持 Page Agent + Playwright Sidecar 现状，不接入 Playwright MCP；
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

1. Javis 可见的第三方工具只能通过 Javis Tool Gateway 执行，禁止直接调用 Tauri 写命令；OpenCode 内部只读工具是受 Rust workspace read-only sandbox 约束的代码后端能力，不得获得副作用权限。
2. `confirmed_write` 和 `dangerous` 工具必须有 UI 审批、native approval binding、路径/作用域检查和一次性消费。
3. 工具参数必须在模型调用前和实际执行前各校验一次。
4. 工具输出必须截断、脱敏并限制大小，不能把完整文件、密钥或大段日志直接回传模型；OpenCode 内部工具输出也必须遵守同一限制。
5. 任何 provider 的 tool call capability 未明确可用时，LangChain backend 不得用文本 JSON 伪造工具调用。
6. MCP server 的 schema、注解和工具名称都属于不可信输入，必须经过本地权限分类和 allowlist。

## 8. 验收标准

- 所有默认暴露工具都有完整输入 Schema、输出格式、超时和错误结果；
- 非法类型、缺少必填字段、未知字段、越界数值都在执行前失败；
- 读操作不得产生未经授权的工作区、用户文件、远程资源或账户数据写入；写操作不会绕过审批；
- 工具调用支持取消、超时、输出截断和事件追踪；
- 工具结果可写入 SharedContext，并能在 checkpoint 恢复；
- Javis 可见的 MCP、LangChain 和内置工具都经过同一个 Tool Gateway；OpenCode 内部只读工具由 Rust sandbox 约束，并有 session/tool 级事件和审计投影；
- 通过 `pnpm typecheck`、相关 Vitest、`pnpm rust:test`、`pnpm rust:check`；
- 至少完成一次真实 provider 的只读 smoke test，以及一次打包后的重启恢复测试。

## 9. 最终建议

第一步不要接入更多 Agent 框架，而是先冻结现有工具契约，并建立 OpenCode code layer 的只读探索和 patch proposal 链路。

最小可行路线是：

```text
统一 ToolContract + Desktop ToolHandler
  -> 保留现有 computer.* / code.* / browser.* 工具名
  -> OpenCode 负责代码领域 read / grep / glob / patch proposal
  -> MCP Filesystem / Git / Fetch（按需，stdio，只读）
  -> Page Agent / Playwright Sidecar（浏览器现状不变）
  -> Codex 参考终端和审批实现
  -> LangChain 运行非代码的只读/预览步骤
```

Javis 保留任务控制、审批、安全和持久化；外部项目只提供成熟的工具实现和执行模式。
