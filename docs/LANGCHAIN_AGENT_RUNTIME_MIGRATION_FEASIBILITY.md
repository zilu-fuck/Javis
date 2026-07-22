# LangChain Agent Runtime 迁移可行性

> 调研日期：2026-07-18
> 结论：可行，但模型原生 Tool Call 协议迁移是 P0 前置工作，也是本次迁移的正式组成部分。先抽象 Javis 自有 Agent Runtime，再接入 LangChain adapter；不直接用 LangChain 类型改写业务层。

## 1. 决策摘要

Javis 可以迁移到 LangChain JS，但迁移对象应限定为“单个 Agent 在一个 DAG 步骤内的模型-工具循环”。以下能力不应交给 LangChain：

- Commander 计划生成、计划编译和失败重规划
- DAG 依赖、并行调度和 backpressure
- `SharedTaskContext`、Artifact Envelope、schema 校验和 Handoff Report
- UI 审批记录、native approval binding、路径守卫和一次性消费
- TaskSnapshot、运行时事件、审计和外层 workflow checkpoint
- Rust `rusqlite` 数据库及其 Tauri 调用边界

推荐采用下面的结构：

```text
Commander DAG / Workflow Executor
              |
              v
      Javis AgentRuntime API
      - AgentDefinition
      - AgentRunRequest / Result
      - AgentEvent
      - ModelGateway
      - ToolExecutionGateway
      - AgentCheckpointStore (optional)
              |
       +------+----------------+
       |                       |
       v                       v
LegacyReActBackend      LangChainAgentBackend
                               |
                         createAgent
                               |
                  JavisChatModel + JavisToolAdapter
                               |
                Rust model endpoints / native tools
```

最终判断是 **Go with gates**，目标状态必须满足：

1. 将原生 Tool Call 协议迁移列为 Phase 1 的 P0 交付，不以文本 JSON 模拟 `tool_calls`。
2. 所有迁移后的 Agent 都走 `tools -> assistant.tool_calls -> tool result -> next model turn` 标准消息闭环。
3. 先在只读 Agent 上做 POC；legacy backend 只作为发布期灰度和回滚开关，不是 provider 的长期兼容方案。
4. LangChain backend 达到行为等价后，逐步替换并最终删除 `runAgentReActLoop()`、ReAct decision prompt 和 JSON decision parser。
5. 不把 LangChain/LangGraph 类型暴露给 Commander、UI、工具契约或持久化业务代码。

## 2. 当前 Javis 的真实边界

### 2.1 当前 ReAct 是 workflow 的内部执行策略

现有链路不是简单的 ReAct loop：

```text
CommanderDagPlan
  -> plan compiler / validation
  -> workflow DAG scheduler
  -> validateStepInputContext
  -> runAgentReActLoop (仅部分 step)
  -> dispatchToolByName
  -> writeCommanderStepOutput
  -> handoff validation / replan
  -> workflow checkpoint / TaskSnapshot
```

`runAgentReActLoop()` 已包含以下 Javis 语义：

- Agent 工具 allowlist
- step 输入上下文校验
- model/tool timeout 与 AbortSignal
- observation 截断、敏感信息清理和可用证据检查
- `request_input` 与缺失 context key
- 迭代上限
- 将 observation 写回共享上下文

LangChain 可以替换模型和工具循环，但这些语义需要通过 Javis adapter、middleware 和结果映射保留。

### 2.2 当前模型协议不能直接驱动 LangChain `createAgent`

当前 `ModelProvider` 只返回文本：

```ts
interface ModelProvider {
  complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult>;
  stream(prompt: string, options?: StreamOptions): AsyncIterable<CompletionChunk>;
}
```

Rust `ModelCompletionRequest` 目前也只有文本 prompt、`user | assistant` 消息、媒体和采样参数。它没有：

- `system | user | assistant | tool` 完整消息角色
- tool definitions
- tool choice
- assistant tool calls
- tool result message / `tool_call_id`
- 流式 tool-call argument delta
- provider structured output 能力

LangChain `createAgent` 每轮都会给模型绑定工具，并依赖 `AIMessage.tool_calls` 决定是否进入 ToolNode。自定义 `BaseChatModel` 至少需要实现 `_generate()` 和 `bindTools()`；原生流式还要实现 `_streamResponseChunks()` 或事件流接口。因此，仅把当前文本结果包装成 `AIMessage` 不能形成可用的 Agent loop。

可以用“提示模型输出 JSON，再伪造 tool_calls”做演示，但这会复制当前 ReAct decider 的脆弱路径，没有迁移价值，不建议进入生产代码。

### 2.3 Tool Call 迁移是目标，不是外部依赖

“当前协议没有原生 Tool Call”描述的是现状，不代表迁移范围可以绕过它。本方案明确要求一起迁移以下链路：

```text
当前链路（迁移后删除）
buildReActDecisionPrompt
  -> ModelProvider.complete(prompt)
  -> 文本 JSON { status, toolName, input }
  -> parseAgentReActDecision
  -> runAgentReActLoop

目标链路
createAgent.bindTools(tool schemas)
  -> JavisChatModel
  -> Rust provider endpoint
  -> provider-native tool call
  -> AIMessage.tool_calls
  -> JavisToolAdapter / ToolExecutionGateway
  -> ToolMessage(tool_call_id)
  -> 下一轮模型调用
```

强制约束：

- 已迁移 Agent 不得调用 `buildReActDecisionSystemPrompt()`、`buildReActDecisionUserPrompt()` 或 `parseAgentReActDecision()`。
- 不得从普通 assistant 文本中提取 JSON 并伪造 `AIMessage.tool_calls`。
- provider 明确声明不支持原生 Tool Call（capability 为 `false`）时，LangChain backend 标记为 unavailable；未声明 capability 的 provider 默认按支持处理。迁移期可以切回完整 legacy backend，但不能在 LangChain backend 内降级成 prompt JSON。
- 确定性 workflow 仍可直接调用工具；这里迁移的是“由模型决定调用哪个工具”的 Agent loop。
- canonical tool name、provider alias、tool-call id 和 tool result 必须端到端可追踪。

## 3. LangChain JS 与浏览器 / SQLite

### 3.1 浏览器环境受支持

本次核对的版本：

| 包 | 版本 | Node 要求 | 浏览器入口 |
| --- | --- | --- | --- |
| `langchain` | `1.5.3` | `>=20` | `./dist/browser.js` |
| `@langchain/core` | `1.2.3` | `>=20` | 浏览器可用的 core 模块 |
| `@langchain/langgraph` | `1.4.8` | `>=18` | `./dist/web.js` |

`langchain/browser` 直接导出 `createAgent`、tool、消息类型和主要 middleware。`@langchain/langgraph` 的 web 入口导出 `StateGraph`、`BaseCheckpointSaver`、`MemorySaver` 等。Javis 的 Node 22 CI 满足版本要求。

桌面端应显式从 `langchain/browser` 引入，避免 bundler 选择到 Node 入口。首次 POC 必须执行 Vite production build，并检查产物中不存在无法解析的 `node:*` 模块。

### 3.2 `better-sqlite3` 不是 LangGraph 核心依赖

`better-sqlite3` 只被可选包 `@langchain/langgraph-checkpoint-sqlite@1.0.3` 使用。它是 Node 原生 addon，通过 C/C++ binding 调用 SQLite，不能运行在 Tauri WebView/普通浏览器中。

这不代表 LangGraph 不考虑浏览器环境。浏览器侧可以使用：

- `MemorySaver`：只在内存中保存，重启即丢失
- 自定义 `BaseCheckpointSaver`：代理到应用自己的持久化端点
- 不配置 LangGraph checkpointer：由外层应用负责持久化和恢复

Javis 已经通过 Tauri 端点访问 Rust `rusqlite`，因此不应引入 `better-sqlite3`。建议分两步处理：

1. 第一阶段不配置 LangGraph checkpointer，继续由 Javis workflow checkpoint 做任务级恢复。
2. 只有在需要 LangGraph interrupt、time travel 或 Agent 内部逐轮恢复时，才实现 `RustSqliteCheckpointSaver extends BaseCheckpointSaver`。

LangGraph saver 需要 `getTuple`、`list`、`put`、`putWrites`、`deleteThread` 等语义。不要把这些数据硬塞进现有 `workflow_checkpoints` 表；应建立独立表和 typed Tauri commands，或在 Javis 通用 `AgentCheckpointStore` 后面做转换。

### 3.3 两套 checkpoint 的职责

| 层 | 负责内容 | 第一阶段 |
| --- | --- | --- |
| Javis workflow checkpoint | DAG、step 状态、共享上下文、审批恢复、TaskSnapshot | 继续作为 source of truth |
| LangGraph checkpoint | 单个 Agent 的消息图、pending writes、interrupt 恢复 | 暂不启用 |

这样可以避免双重恢复、重复执行副作用和审批记录错位。

## 4. 通用 Agent Runtime 合同

通用层使用 Javis 类型，不暴露 `AIMessage`、`ToolMessage`、`Command`、`RunnableConfig` 或 LangGraph state。

### 4.1 核心接口

```ts
export interface AgentDefinition {
  id: string;
  kind: AgentKind;
  instructions: string;
  allowedToolNames: readonly string[];
  limits: {
    maxModelCalls: number;
    maxToolCalls: number;
    modelTimeoutMs: number;
    toolTimeoutMs: number;
  };
  outputSchema?: JsonSchema;
}

export interface AgentRunRequest {
  taskId: string;
  runId: string;
  threadId?: string;
  messages: readonly AgentMessage[];
  context: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
}

export interface AgentRunResult {
  status: "completed" | "failed" | "request_input" | "cancelled";
  output?: unknown;
  reason?: string;
  requestedContextKeys?: readonly string[];
  requestedAgentKind?: AgentKind;
  usage?: AgentTokenUsage;
}

export interface AgentRunHandle {
  events: AsyncIterable<AgentEvent>;
  result: Promise<AgentRunResult>;
  cancel(): void;
}

export interface AgentRuntime {
  run(definition: AgentDefinition, request: AgentRunRequest): AgentRunHandle;
}
```

`AgentEvent` 至少覆盖：

- `run.started | run.completed | run.failed`
- `model.started | model.delta | model.completed`
- `tool.requested | tool.started | tool.completed | tool.failed`
- `context.requested`
- `usage.updated`

事件由 desktop 层投影为现有 eventBus 和 TaskSnapshot。UI 不消费 LangChain 原始事件。

### 4.2 ModelGateway

新的模型协议应先在 Javis 层定义，再由 LangChain chat model adapter 消费：

```ts
export interface AgentModelGateway {
  capabilities(model: string): AgentModelCapabilities;
  complete(request: AgentChatRequest): Promise<AgentChatResponse>;
  stream(request: AgentChatRequest): AsyncIterable<AgentChatStreamEvent>;
}

export interface AgentChatRequest {
  model?: string;
  messages: readonly AgentMessage[];
  tools?: readonly AgentToolSpec[];
  toolChoice?: "auto" | "none" | "required" | { name: string };
  responseSchema?: JsonSchema;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}
```

消息和工具调用必须是可序列化、backend-neutral 的判别联合：

```ts
export type AgentMessage =
  | { role: "system" | "user"; content: readonly AgentContentBlock[] }
  | {
      role: "assistant";
      content: readonly AgentContentBlock[];
      toolCalls?: readonly AgentToolCall[];
    }
  | {
      role: "tool";
      toolCallId: string;
      name: string;
      content: readonly AgentContentBlock[];
      status: "success" | "error";
    };

export interface AgentToolSpec {
  /** Javis 审计和权限系统使用的名称。 */
  canonicalName: string;
  /** 发送给 provider、同时注册到 LangChain ToolNode 的稳定别名。 */
  modelName: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AgentChatResponse {
  message: Extract<AgentMessage, { role: "assistant" }>;
  finishReason: "stop" | "tool_calls" | "length" | "content_filter" | "cancelled" | "error";
  usage?: AgentTokenUsage;
}
```

`AgentChatResponse` 中的 tool calls 必须来自 provider 的结构化响应，不从文本中二次解析。流协议至少包含：

```ts
export type AgentChatStreamEvent =
  | { type: "message_start"; messageId: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_arguments_delta"; index: number; delta: string }
  | { type: "tool_call_end"; index: number }
  | { type: "usage"; usage: AgentTokenUsage }
  | { type: "message_end"; finishReason: AgentChatResponse["finishReason"] };
```

stream adapter 将每个 arguments delta 映射为对应的 `AIMessageChunk.tool_call_chunks`，并按 `index` 和 `id` 聚合；只有收到 terminal event、完成 JSON/schema 校验后，LangChain 才能得到完整 `AIMessage.tool_calls` 并进入工具执行。

Provider 映射：

- OpenAI-compatible：`tools` / `tool_choice`、`message.tool_calls`、`delta.tool_calls`
- Anthropic：`tools`、`tool_use` content block、`tool_result`、`input_json_delta`

### 4.3 Rust 与 provider 端点迁移

不要继续扩大 `complete_model_prompt` 的文本语义。新增版本化、typed Tauri commands：

```text
complete_model_chat
stream_model_chat_start
stream_model_chat_cancel
```

旧的 `complete_model_prompt` 在迁移期间继续服务非 Agent 文本补全，等调用方迁完后再决定是否合并。新的 Rust contract 至少包含：

```rust
struct ModelChatRequest {
    messages: Vec<ModelChatMessage>,
    tools: Vec<ModelToolDefinition>,
    tool_choice: Option<ModelToolChoice>,
    response_format: Option<ModelResponseFormat>,
    // provider/model/auth/sampling/timeout 等现有字段
}

enum ModelChatMessage {
    System { content: Vec<ModelContentBlock> },
    User { content: Vec<ModelContentBlock> },
    Assistant {
        content: Vec<ModelContentBlock>,
        tool_calls: Vec<ModelToolCall>,
    },
    Tool {
        tool_call_id: String,
        name: String,
        content: Vec<ModelContentBlock>,
        status: ModelToolStatus,
    },
}

struct ModelChatResponse {
    message: ModelAssistantMessage,
    finish_reason: ModelFinishReason,
    token_usage: Option<ModelUsage>,
}
```

Rust provider adapter 负责协议归一化：

- OpenAI-compatible request：将工具转成 `type=function`，回传时读取 `choices[0].message.tool_calls`；流式读取 `choices[*].delta.tool_calls[index]`。
- Anthropic request：将工具转成 `tools[].input_schema`；assistant `tool_use` 转为统一 tool call；下一轮统一 tool message 转成 Anthropic user `tool_result` block；流式读取 `content_block_start` 和 `input_json_delta`。
- 保留 provider 返回的 tool-call id；如果 provider 未返回 id，只能由对应 provider adapter 按稳定规则生成，并记录兼容性标记。
- 统一校验 finish reason、重复 call id、未知 tool name、无效 arguments JSON 和不完整 stream；这些错误不得进入 ToolExecutionGateway。
- Rust/TypeScript 日志只能记录清理后的工具名、call id 和 bounded 参数摘要，不能记录密钥或未清理的大体积 payload。

### 4.4 `JavisChatModel` 的 Tool Call 映射

desktop adapter 中的 `JavisChatModel extends BaseChatModel` 必须完成以下映射：

| LangChain 方法/类型 | Javis 行为 |
| --- | --- |
| `bindTools(tools)` | 返回绑定了 `AgentToolSpec[]` 的新 model 实例，不修改共享实例 |
| `_generate(messages)` | 调用 `AgentModelGateway.complete()`，返回带 `tool_calls` 的 `AIMessage` |
| `_streamResponseChunks(messages)` | 将 `AgentChatStreamEvent` 转成 `AIMessageChunk` 和 `tool_call_chunks` |
| `ToolMessage` 输入 | 保留 `tool_call_id`、name、status，转换为内部 `role=tool` 消息 |
| structured output | 仅当 capability 明确支持时启用 provider strategy，否则使用 LangChain tool strategy |

端到端调用顺序固定为：

```text
createAgent
  -> bindTools(model aliases + JSON Schema)
  -> JavisChatModel -> complete_model_chat
  -> provider tool call
  -> Rust normalized ModelAssistantMessage
  -> AIMessage.tool_calls
  -> LangChain ToolNode
  -> JavisToolAdapter(alias -> canonical)
  -> ToolExecutionGateway
  -> ToolMessage(tool_call_id)
  -> JavisChatModel -> complete_model_chat
  -> final AIMessage
```

并行策略：read/幂等工具可以保留 provider 的 parallel tool calls；confirmed-write/dangerous 工具必须请求 `parallel_tool_calls=false`（provider 支持时）并在 Javis gateway 再做串行校验。不能依赖 provider 参数作为写安全边界。

### 4.5 ToolExecutionGateway

LangChain tool body 只能调用 Javis gateway，不能直接调用 Tauri command 或 native 写工具：

```ts
export interface ToolExecutionGateway {
  execute(request: {
    taskId: string;
    runId: string;
    agentKind: AgentKind;
    toolName: string;
    input: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<ToolExecutionResult>;
}
```

gateway 负责：

- descriptor 存在性和 owner/allowlist
- 输入 schema 校验
- permission level 和 write risk
- preview / approval / native binding
- timeout、取消、审计、输出清理
- 将工具结果写入 SharedTaskContext 的规则

LangChain 的 `humanInTheLoopMiddleware` 可以用于普通应用审批，但不能替代 Javis 的 native approval binding。第一阶段继续由 Javis 审批链路负责写操作，LangChain backend 只开放 read/preview 工具。

### 4.6 工具名称和 schema

Javis 工具名使用 `code.searchRepository` 格式。为兼容各模型 provider，adapter 使用稳定别名：

```text
code.searchRepository <-> code__search_repository
file.scanMarkdownDocuments <-> file__scan_markdown_documents
```

要求：

- 映射必须双向、确定性、无碰撞并有单元测试
- 模型只看到 alias；审计、权限和业务代码仍使用 canonical name
- `requiredInputs` 先转换为内部 JSON Schema，再转换成 LangChain tool schema
- MCP 的完整 input schema 优先于简化的 `requiredInputs`

## 5. LangChain adapter 的职责

建议目录边界：

```text
packages/core/src/agent-runtime/
  contracts.ts              # 纯类型和结果状态
  tool-name-alias.ts        # 纯映射
  tool-schema.ts            # descriptor -> JSON Schema
  event.ts                  # 后端无关事件

apps/desktop/src/agent-runtime/
  create-agent-runtime.ts   # backend 选择/灰度
  javis-tool-gateway.ts     # 接现有工具和审批
  legacy-react-backend.ts   # 仅迁移期灰度/回滚，最终删除
  langchain/
    javis-chat-model.ts     # BaseChatModel adapter
    tool-adapter.ts         # LangChain tool -> Javis gateway
    middleware.ts           # 限额、审计、清理、事件投影
    runner.ts               # createAgent 封装
    event-adapter.ts        # LangChain stream -> AgentEvent
```

`packages/core` 不依赖 LangChain，也不访问 ModelProvider/Tauri。LangChain 依赖只放在 `@javis/desktop`，符合现有 package boundary。

### 5.1 Tool Call 改造文件清单

| 文件/模块 | 改造内容 | 最终状态 |
| --- | --- | --- |
| `packages/core/src/agent-runtime/contracts.ts` | 新增消息、工具、tool call、stream event 的框架无关合同 | 新增，作为统一协议 source of truth |
| `packages/core/src/provider-adapter.ts` | 复用 provider capability；旧文本 `ModelMessage` 不继续扩张为 Agent 协议 | 文本补全兼容保留 |
| `apps/desktop/src/agent-runtime/agent-model-gateway.ts` | 调用新的 typed Tauri chat commands | 新增 |
| `apps/desktop/src/agent-runtime/langchain/javis-chat-model.ts` | 实现 `bindTools/_generate/_streamResponseChunks` | 新增 |
| `apps/desktop/src/model-provider.ts` | 继续负责普通文本补全；共享鉴权、模型选择和 usage helper 可抽取复用 | 不直接承载 LangChain 类型 |
| `apps/desktop/src-tauri/src/model_chat.rs` | 定义 chat request/response、OpenAI-compatible 归一化和 typed commands | 新增 |
| `apps/desktop/src-tauri/src/anthropic.rs` | 增加 `tool_use/tool_result/input_json_delta` 映射 | 扩展 |
| `apps/desktop/src-tauri/src/streaming.rs` | 发出 provider-neutral text/tool-call stream events | 扩展或拆分到 `model_chat.rs` |
| `apps/desktop/src/app-runtime.ts` | 迁移 Agent 不再注入 `reactDecideNext` | 逐 Agent 移除 |
| `packages/core/src/workflow-executor.ts` | step 内改为调用 `AgentRuntime`，保留 DAG/handoff/replan | 替换 ReAct 分支 |
| `packages/core/src/agent-react-loop.ts` | 仅作为迁移期 legacy backend | 全量迁移后删除 |
| `packages/core/src/agent-react-decider.ts` | 不再为迁移 Agent 生成 JSON decision prompt | 全量迁移后删除 |

新增 Rust chat 模块时应继续遵守现有 secret hydration、请求校验、超时、取消和日志脱敏规则，不能复制一套弱化的 HTTP client。

adapter 内部可以使用：

- `createAgent`：模型-工具循环
- `beforeAgent` / `afterAgent`：run 生命周期
- `beforeModel` / `afterModel` / `wrapModelCall`：prompt、模型策略、超时和 usage
- `wrapToolCall`：调用 Javis ToolExecutionGateway
- `modelCallLimitMiddleware` / `toolCallLimitMiddleware`：硬限制
- `modelRetryMiddleware` / `toolRetryMiddleware`：仅对幂等、可重试错误启用
- `responseFormat`：模型协议支持后用于结构化输出

不在第一阶段采用：

- LangChain subagents：Commander 已经负责多 Agent 调度，叠加会形成双重 orchestrator
- LangChain HITL 作为写安全边界：不能代替 Rust guard
- LangGraph SQLite saver：浏览器不可用且与现有持久化重复
- LangSmith Cloud 强依赖：可选 observability 不能成为本地运行前提

## 6. 能力映射

| Javis 现有能力 | LangChain 对应能力 | 处理方式 |
| --- | --- | --- |
| ReAct JSON decision loop | `createAgent` 原生 tool loop | 替换 |
| `maxIterations` | model/tool call limit + recursion limit | adapter 映射 |
| model/tool timeout | signal + wrapper/middleware | 保留 Javis 超时语义 |
| observation bound/redaction | `wrapToolCall` 后处理 | 复用现有 sanitizer |
| Agent tool allowlist | 动态 tools + gateway 校验 | 双层校验 |
| `request_input` | adapter 内部 `Command` 或内部 control tool | 映射回 Javis result |
| SharedTaskContext | runtime context / tool gateway | Javis 仍为 source of truth |
| schema-invalid handoff | 无直接等价物 | 保留 Javis preflight/replan |
| Commander failure replan | 无直接等价物 | 保留 Javis |
| TaskSnapshot/eventBus | event streaming | 转换为 `AgentEvent` 后投影 |
| workflow checkpoint | LangGraph checkpointer | 第一阶段不替换 |
| native write approval | HITL middleware | 不替换；只做 UI 辅助也必须经过 native guard |

## 7. 分阶段迁移

### Phase 0：冻结合同和行为基线

- 建立 Agent Runtime 的 backend-neutral 类型
- 为当前 ReAct 行为建立 contract tests
- 固化工具别名、schema 转换和事件序列
- 记录现有成功率、模型调用数、延迟和 token 使用

验收：不改变生产行为，legacy backend 通过所有现有测试。

### Phase 1：扩展模型 tool-calling 协议

- Phase 1A：定义 `AgentMessage`、`AgentToolSpec`、`AgentToolCall`、chat response 和 stream event 合同
- Phase 1A：新增 `complete_model_chat` / `stream_model_chat_start` typed Tauri commands
- Phase 1B：实现 OpenAI-compatible 非流式及流式 tool calls
- Phase 1C：实现 Anthropic 非流式及流式 tool use/tool result
- Phase 1D：实现 `JavisChatModel.bindTools()`、`_generate()`、`_streamResponseChunks()`
- 加 capability flag；Tool Call 默认可用，只有显式声明不支持原生 Tool Call 的 provider 不注册 LangChain backend
- 为请求序列化、响应解析、call id、并行调用、流式 arguments、错误和敏感字段清理补测试

验收：同一套内部消息/tool contract 可通过两个 provider fixture 完成“tool call -> tool result -> final answer”的非流式和流式闭环；整个闭环不调用 ReAct decision prompt/parser。

### Phase 2：只读 LangChain POC

- 在 desktop 层引入精确版本的 LangChain 包
- 实现 `JavisChatModel`、tool alias 和只读 gateway
- 选择 `research` 或 `code.searchRepository` 作为单 Agent POC
- 不配置 LangGraph checkpointer，不开放 confirmed_write/dangerous 工具
- 验证 Vite production build 和 packaged Tauri smoke test

验收：真实模型完成“模型 -> 工具 -> 模型 -> final”闭环；取消、超时、工具失败和 usage 事件可见。

### Phase 3：接入 Commander step

- `executeStepWithReAct` 改为调用 `AgentRuntime`
- 按 Agent kind / task feature flag 选择 legacy 或 LangChain backend
- 保留 step input validation、context output、handoff 和 replan
- 建立 legacy/LangChain 同输入的事件与结果对照测试

验收：只读 Commander workflow 在两种 backend 下具有一致的完成/失败/request_input 语义。

### Phase 4：结构化输出、UI 事件和持久化增强

- 将 LangChain events 映射到现有平滑流式 UI
- 按 provider capability 启用 structured output
- 评估是否真的需要 Agent 内部恢复；需要时实现 Rust SQLite custom saver

验收：流式文本和 tool 事件无重复、无乱序；重启恢复不会重放已经执行的副作用。

### Phase 5：扩大灰度并删除 legacy loop

- 先 read，再 preview，最后评估 write flow
- 按 provider、Agent kind、任务类型统计回退率
- 所有目标 provider 完成原生 Tool Call capability 验证
- 删除已迁移路径对 ReAct decision prompt/parser 的调用
- 只有所有关键 QA 和 packaged restart 场景通过后才删除 legacy backend

最终完成标准：

- `runAgentReActLoop()` 不再被生产 Agent 路径引用。
- `reactDecideNext` 不再是 `runCommanderDagTask` 的运行时依赖。
- `buildReActDecisionPrompt()` 和 `parseAgentReActDecision()` 仅可在迁移期测试中存在，最终删除。
- 模型选择工具只通过 provider-native Tool Call；没有文本 JSON 兼容分支。
- direct deterministic workflow 的直接工具调用不受影响。

## 8. 主要风险

| 风险 | 严重度 | 缓解 |
| --- | --- | --- |
| 模型 provider 的 tool-call 格式差异 | 高 | Javis 先统一协议，provider adapter 分别解析 |
| LangChain 类型渗透业务层 | 高 | 只允许 desktop adapter 引入 LangChain 类型 |
| 双重 orchestrator 导致状态和成本失控 | 高 | Commander 保持唯一跨 Agent orchestrator |
| 双 checkpoint 导致恢复时重复副作用 | 高 | 第一阶段禁用 LangGraph persistence |
| 写工具绕过审批 | 阻断级 | 所有 tool body 只能调用 Javis gateway，Rust guard 不变 |
| tool 名称不被 provider 接受 | 中 | canonical/alias 双向映射及碰撞测试 |
| 浏览器 bundle 引入 Node addon | 中 | 使用 `langchain/browser`，不安装 SQLite saver，执行 bundle smoke test |
| LangChain 升级带来 API 变化 | 中 | 精确版本、adapter 隔离、contract tests、受控升级 |
| middleware retry 重放非幂等工具 | 高 | write tool 禁止通用 retry；gateway 依据幂等性决定 |
| 流式 tool arguments 被截断或交错 | 高 | 按 index/id 聚合，只在 terminal event 后解析和执行 |
| provider 声称兼容但不完整支持 Tool Call | 高 | capability probe + fixture/live contract test；未声明 capability 仍默认可用，发现不兼容后由适配器显式标记 `false`，不做文本降级 |

## 9. 工作量估算

单人、包含测试和 Windows packaged QA 的粗略估算：

| 阶段 | 估算 |
| --- | --- |
| Phase 0 合同与基线 | 2-3 人日 |
| Phase 1 原生 Tool Call 协议与 `JavisChatModel` | 8-12 人日 |
| Phase 2 只读 POC | 3-5 人日 |
| Phase 3 Commander step 灰度接入 | 5-8 人日 |
| Phase 4 structured output/UI 事件/可选 saver | 4-8 人日 |
| Phase 5 扩大灰度与清理 | 3-5 人日 |

完整迁移约 5-8 周；如果第一版只覆盖 OpenAI-compatible 的原生非流式和流式 Tool Call，并接入一个只读 Agent，约 2-3 周可以得到可信 POC。实际工期主要取决于 provider Tool Call 兼容性和 packaged restart QA，而不是 LangChain API 本身。

## 10. POC 通过标准

只有同时满足以下条件，才建议进入 Phase 3：

1. `pnpm check` 全部通过。
2. Vite/Tauri 构建不包含 `better-sqlite3`，没有 unresolved Node builtin。
3. OpenAI-compatible 和 Anthropic fixture 均能完成非流式及流式 tool call/tool result 闭环。
4. POC 的 LangChain 路径不调用 `reactDecideNext`，不解析文本 JSON decision。
5. canonical tool name、alias、call id 在模型、审计和结果消息之间不丢失。
6. arguments delta 交错、截断、重复 id、未知工具和非法 JSON 均有失败测试。
7. 非 allowlist 工具、invalid schema、confirmed_write 工具都在 gateway 前或 gateway 中被拒绝。
8. AbortSignal、model timeout、tool timeout、迭代/调用上限均有测试。
9. LangChain backend 的事件能完整投影到 TaskSnapshot，且不会把 LangChain 类型持久化。
10. legacy backend 可一键回退，数据库 schema 不需要回滚；回退发生在 backend 选择层，不发生在 Tool Call 解析层。

## 11. 参考资料

- [LangChain JS Agents](https://docs.langchain.com/oss/javascript/langchain/agents)
- [LangChain JS Middleware](https://docs.langchain.com/oss/javascript/langchain/middleware/overview)
- [LangChain JS Custom Middleware](https://docs.langchain.com/oss/javascript/langchain/middleware/custom)
- [LangChain JS Tools](https://docs.langchain.com/oss/javascript/langchain/tools)
- [LangChain JS Structured Output](https://docs.langchain.com/oss/javascript/langchain/structured-output)
- [LangChain JS Multi-agent](https://docs.langchain.com/oss/javascript/langchain/multi-agent)
- [LangGraph JS Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)
- [langchain npm](https://www.npmjs.com/package/langchain)
- [@langchain/langgraph-checkpoint-sqlite npm](https://www.npmjs.com/package/@langchain/langgraph-checkpoint-sqlite)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
