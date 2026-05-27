# Proma 代码级流程拆解

## 1. Chat 流式输出怎么建立

### 1.1 前端发送

入口：`apps/electron/src/renderer/components/chat/ChatView.tsx`

`handleSend()` 做几件事：

1. 保存附件到磁盘。
2. 初始化 `streamingStatesAtom`，把当前会话标记为 `streaming: true`。
3. 乐观插入一条临时 user message。
4. 调用 `window.electronAPI.sendMessage(input)`。

关键位置：

- `ChatView.tsx:207`：`handleSend`
- `ChatView.tsx:284`：初始化流式状态
- `ChatView.tsx:298`：构造 `ChatSendInput`
- `ChatView.tsx:312`：乐观更新用户消息
- `ChatView.tsx:324`：调用 preload API

### 1.2 IPC 进入主进程

入口：`apps/electron/src/main/ipc.ts`

`CHAT_IPC_CHANNELS.SEND_MESSAGE` handler 直接调用：

```ts
await sendMessage(input, event.sender)
```

这里的 `event.sender` 是 renderer 对应的 `webContents`，后面主进程靠它把 chunk 推回前端。

### 1.3 主进程建立模型流

入口：`apps/electron/src/main/lib/chat-service.ts`

`sendMessage()` 的主流程：

1. 通过 `channelId` 找渠道。
2. 解密 API Key。
3. 从本地 JSONL 读取历史消息。
4. 把用户消息先追加到 JSONL。
5. 裁剪上下文。
6. 提取文档附件文本，图片附件转 base64。
7. `getAdapter(channel.provider)` 选择 Provider Adapter。
8. 调用 adapter 生成 HTTP 请求。
9. 调用 `streamSSE()` 读取服务商 SSE。
10. 每来一个 chunk，就 `webContents.send(CHAT_IPC_CHANNELS.STREAM_CHUNK, ...)`。
11. 如果模型触发工具调用，则执行工具后把结果作为 continuation message 续接给模型。
12. 完成后保存 assistant message，并发送 `STREAM_COMPLETE`。

关键位置：

- `chat-service.ts:192`：`sendMessage`
- `chat-service.ts:203`：找渠道
- `chat-service.ts:216`：解密 API Key
- `chat-service.ts:236`：保存用户消息
- `chat-service.ts:255`：选择 Provider Adapter
- `chat-service.ts:281`：发送 `STREAM_CHUNK`
- `chat-service.ts:313`：构建 provider 请求
- `chat-service.ts:323`：`streamSSE`
- `chat-service.ts:340`：执行工具调用
- `chat-service.ts:374`：构建工具续接消息
- `chat-service.ts:436`：发送 `STREAM_COMPLETE`

### 1.4 Provider Adapter 的职责

入口：`packages/core/src/providers/`

核心接口：`packages/core/src/providers/types.ts`

Adapter 不直接 fetch，不读文件，只做纯转换：

- 把 Proma 的通用 `StreamRequestInput` 转成服务商请求。
- 把服务商 SSE line 转成 Proma 的通用 `StreamEvent`。
- 构建标题生成请求。

注册表：`packages/core/src/providers/index.ts`

```text
anthropic -> AnthropicAdapter
openai/custom/zhipu/doubao/qwen -> OpenAIAdapter
google -> GoogleAdapter
deepseek/kimi/minimax -> Anthropic 或 OpenAI 兼容分支
```

### 1.5 SSE 读取器

入口：`packages/core/src/providers/sse-reader.ts`

`streamSSE()` 做真正的流式读取：

1. `fetch(request.url, { method: 'POST', body, headers })`
2. `response.body.getReader()`
3. `TextDecoder` 解码 chunk。
4. 按行拆分 SSE。
5. 只处理 `data:` 行。
6. 委托 `adapter.parseSSELine(data)` 解析。
7. 累积 content / reasoning / thinkingBlocks / toolCalls。
8. 每个事件回调给 `chat-service.ts`。

所以 Chat 的服务商流式链路是：

```text
ChatView.handleSend
  -> preload.sendMessage
  -> ipcMain CHAT.SEND_MESSAGE
  -> chat-service.sendMessage
  -> providerAdapter.buildStreamRequest
  -> streamSSE(fetch + ReadableStream)
  -> webContents.send(STREAM_CHUNK / STREAM_REASONING / STREAM_COMPLETE)
```

## 2. Chat 流式内容怎么渲染

### 2.1 preload 监听 IPC

入口：`apps/electron/src/preload/index.ts`

preload 暴露：

- `onStreamChunk`
- `onStreamReasoning`
- `onStreamComplete`
- `onStreamError`
- `onStreamToolActivity`

它们本质是 `ipcRenderer.on(...)` 包一层 cleanup。

### 2.2 全局 Chat listener 写入 Jotai

入口：`apps/electron/src/renderer/hooks/useGlobalChatListeners.ts`

它在应用顶层挂载，不随 ChatView 卸载。这样切换 tab 或设置页时，流式事件不会丢。

处理逻辑：

- `STREAM_CHUNK`：把 delta 拼到 `streamingStatesAtom[conversationId].content`
- `STREAM_REASONING`：拼到 reasoning
- `STREAM_COMPLETE`：标记 `streaming=false`，递增 `chatMessageRefreshAtom`
- `STREAM_ERROR`：记录到 `chatStreamErrorsAtom`
- `STREAM_TOOL_ACTIVITY`：追加工具活动

关键位置：

- `useGlobalChatListeners.ts:40`：注册全局监听
- `useGlobalChatListeners.ts:49`：更新流式 Map
- `useGlobalChatListeners.ts:76`：chunk 处理
- `useGlobalChatListeners.ts:96`：complete 处理
- `useGlobalChatListeners.ts:139`：error 处理
- `useGlobalChatListeners.ts:164`：工具活动处理

### 2.3 ChatView 读取状态并传给 ChatMessages

入口：`apps/electron/src/renderer/components/chat/ChatView.tsx`

ChatView 从 `streamingStatesAtom` 中取当前对话状态：

- `isStreaming`
- `streamingContent`
- `streamingReasoning`
- `streamingModel`
- `toolActivities`

然后传给 `ChatMessages`。

### 2.4 ChatMessages 渲染临时 assistant 气泡

入口：`apps/electron/src/renderer/components/chat/ChatMessages.tsx`

这里不是每个 chunk 都变成一条消息，而是渲染一个“正在生成的临时 assistant message”：

- `useSmoothStream()` 把高频 chunk 变成平滑逐字显示。
- `ChatToolActivityIndicator` 显示工具活动。
- `Reasoning` 显示推理内容。
- `MessageResponse` 渲染 Markdown。
- `StreamingIndicator` 显示尾部流式状态。

关键位置：

- `ChatMessages.tsx:188`：`useSmoothStream`
- `ChatMessages.tsx:384`：渲染临时 assistant message
- `ChatMessages.tsx:400`：工具活动
- `ChatMessages.tsx:403`：推理内容
- `ChatMessages.tsx:414`：流式正文

流结束后，主进程已把 assistant message 保存进 JSONL，`chatMessageRefreshAtom` 触发 ChatView 重新加载持久化消息。临时气泡随后被清理，避免内容重复。

## 3. Agent 怎么把服务商和本地执行连起来

Proma 的 Agent 与 Chat 不同。Chat 是 Proma 自己请求服务商 API；Agent 是通过 `@anthropic-ai/claude-agent-sdk` 启动本地 Claude Code / Agent SDK native binary，由 SDK 负责模型交互和本地工具执行。

### 3.1 前端发送 Agent 消息

入口：`apps/electron/src/renderer/components/agent/AgentView.tsx`

发送时：

1. 保存/附加文件。
2. 解析用户输入中的 `/skill:`、`#mcp:`、`&session:`。
3. 初始化 `agentStreamingStatesAtom`。
4. 乐观插入 SDKMessage 格式 user message。
5. 调用 `window.electronAPI.sendAgentMessage(input)`。

关键位置：

- `AgentView.tsx:1359`：初始化流式状态
- `AgentView.tsx:1376`：乐观 user SDKMessage
- `AgentView.tsx:1387`：构造 `AgentSendInput`
- `AgentView.tsx:1412`：发送 Agent 消息

### 3.2 IPC 进入 Agent 服务

入口：`apps/electron/src/main/ipc.ts`

`AGENT_IPC_CHANNELS.SEND_MESSAGE` 调用：

```ts
await runAgent(input, event.sender)
```

入口服务：`apps/electron/src/main/lib/agent-service.ts`

`agent-service.ts` 是薄层：

- 注册 `sessionId -> webContents`。
- 把 EventBus 事件转发成 `AGENT_IPC_CHANNELS.STREAM_EVENT`。
- 调用 `orchestrator.sendMessage()`。
- 完成时发 `STREAM_COMPLETE`。

### 3.3 AgentOrchestrator 准备运行环境

入口：`apps/electron/src/main/lib/agent-orchestrator.ts`

`sendMessage()` 是 Agent 核心编排函数。

它做的事情比 Chat 多很多：

1. 并发保护：同一个 session 同时只能跑一个 turn。
2. Windows shell 检查。
3. 读取渠道，解密 API Key。
4. 清理和注入 `ANTHROPIC_*` 环境变量。
5. 构造 SDK env：API Key、Base URL、代理、Shell、`CLAUDE_CONFIG_DIR`。
6. 确定 cwd：每个 Agent session 有独立工作目录。
7. 创建 `.claude/settings.json`，设置计划目录等。
8. 加载工作区 MCP。
9. 注入内置记忆工具和生图工具。
10. 构建动态上下文和系统 prompt。
11. 构造权限回调 `canUseTool`。
12. 构造 SDK query options。
13. 调用 adapter 的 `query()`，消费 `SDKMessage` async iterator。

关键位置：

- `agent-orchestrator.ts:893`：`sendMessage`
- `agent-orchestrator.ts:897`：并发保护
- `agent-orchestrator.ts:960`：读取渠道
- `agent-orchestrator.ts:974`：解密 API Key
- `agent-orchestrator.ts:506`：构建 SDK env
- `agent-orchestrator.ts:1106`：工作区 session cwd
- `agent-orchestrator.ts:1159`：构建 MCP server
- `agent-orchestrator.ts:1160`：注入记忆工具
- `agent-orchestrator.ts:1161`：注入生图 MCP
- `agent-orchestrator.ts:1198`：最终 prompt
- `agent-orchestrator.ts:1293`：`canUseTool`
- `agent-orchestrator.ts:1412`：SDK query options
- `agent-orchestrator.ts:1580`：调用 adapter query
- `agent-orchestrator.ts:1791`：EventBus 发 SDK message
- `agent-orchestrator.ts:1753` / `1808`：持久化 SDKMessage

### 3.4 ClaudeAgentAdapter 真正启动 SDK 子进程

入口：`apps/electron/src/main/lib/adapters/claude-agent-adapter.ts`

这个 adapter 实现统一接口：

```ts
query(input): AsyncIterable<SDKMessage>
abort(sessionId): void
sendQueuedMessage(...)
setPermissionMode(...)
```

最关键的点是：它创建一个长期 `MessageChannel`，把用户输入作为 `AsyncGenerator` 提供给 SDK。

为什么要这么做：

- SDK 的 prompt 支持流式输入。
- 如果 generator 只 yield 一次，SDK 会关闭 stdin，后续权限请求、追加消息、AskUser 等会失败。
- 所以 Proma 让 generator 在整个查询期间保持活跃。

核心流程：

1. 创建 AbortController。
2. 动态 import Claude Agent SDK。
3. 构造 SDK options。
4. 自定义 `spawnClaudeCodeProcess`，用 Node `spawn()` 启动 SDK native binary。
5. 记录 PID，方便 stop/退出时强杀残留进程。
6. 创建 `MessageChannel`。
7. 把初始 user prompt 入队。
8. 调用 `sdk.query({ prompt: channel.generator, options })`。
9. `for await (const sdkMessage of queryIterator)` 消费 SDK 输出。
10. 收到 `result` 且不是 keep-open 场景时关闭 channel。
11. `yield sdkMessage` 给 Orchestrator。

关键位置：

- `claude-agent-adapter.ts:642`：`query`
- `claude-agent-adapter.ts:660`：SDK options
- `claude-agent-adapter.ts:712`：自定义 spawn
- `claude-agent-adapter.ts:745`：创建消息通道
- `claude-agent-adapter.ts:748`：初始 prompt 入队
- `claude-agent-adapter.ts:758`：`sdk.query`
- `claude-agent-adapter.ts:774`：消费 SDK async iterator
- `claude-agent-adapter.ts:810`：result 后关闭 channel
- `claude-agent-adapter.ts:837`：运行中追加消息
- `claude-agent-adapter.ts:883`：动态切权限模式

### 3.5 “服务商”和“本地”的连接方式

Proma 自己不直接替 Agent 发模型请求。它把服务商信息转成 SDK 环境变量：

```text
ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN
ANTHROPIC_BASE_URL
ANTHROPIC_CUSTOM_HEADERS
HTTPS_PROXY / HTTP_PROXY
CLAUDE_CODE_SHELL
CLAUDE_CONFIG_DIR
```

然后 SDK native binary 在本地进程里：

- 通过这些环境变量连接服务商。
- 在指定 cwd 下执行 Read/Edit/Bash 等本地工具。
- 通过 stdout 产生 SDKMessage。
- 通过 stdin 接收 Proma 注入的用户消息、权限响应等。

Proma 负责：

- 选择渠道和模型。
- 设置 env/cwd/mcp/plugins。
- 权限回调。
- 消息持久化。
- UI 事件转发。
- 子进程生命周期管理。

## 4. Agent 流式输出怎么渲染

### 4.1 SDKMessage 进入 EventBus

Orchestrator 收到 SDKMessage 后：

```ts
this.eventBus.emit(sessionId, { kind: 'sdk_message', message: msg })
```

`agent-service.ts` 给 EventBus 注册了 middleware，把事件转发给对应 webContents：

```text
EventBus -> webContents.send(AGENT_IPC_CHANNELS.STREAM_EVENT)
```

### 4.2 前端全局 Agent listener

入口：`apps/electron/src/renderer/hooks/useGlobalAgentListeners.ts`

它接收 `onAgentStreamEvent` 后做两件事：

1. 新路径：把原始 `SDKMessage` 追加到 `liveMessagesMapAtom`。
2. 兼容路径：把 `SDKMessage` 转成旧的 `AgentEvent`，更新 `agentStreamingStatesAtom`。

关键位置：

- `useGlobalAgentListeners.ts:493`：监听 Agent stream event
- `useGlobalAgentListeners.ts:516`：SDKMessage 写入 live messages
- `useGlobalAgentListeners.ts:552`：转换 legacy events
- `useGlobalAgentListeners.ts:571`：更新 `agentStreamingStatesAtom`
- `useGlobalAgentListeners.ts:817`：监听 Agent stream complete
- `useGlobalAgentListeners.ts:843`：complete 后标记 running false

### 4.3 AgentView 合并持久化消息和实时消息

入口：`apps/electron/src/renderer/components/agent/AgentView.tsx`

AgentView 会从磁盘加载持久化 SDKMessage：

- `window.electronAPI.getAgentSessionSDKMessages(sessionId)`

同时读取 live messages。渲染时由 `AgentMessages` 合并两者。

### 4.4 AgentMessages 分组渲染

入口：`apps/electron/src/renderer/components/agent/AgentMessages.tsx`

这里会把：

- persisted SDK messages
- live SDK messages

合并去重，然后交给 `groupIntoTurns()` 分组。

核心逻辑：

- 真正用户输入单独成组。
- assistant / tool result / system progress 归入 assistant turn。
- compact / permission_denied 这类 system message 独立渲染。
- live group 会禁用 fork/rewind 等动作，避免流式未完成时操作。

关键位置：

- `AgentMessages.tsx:521`：合并 persisted/live
- `AgentMessages.tsx:534`：分组
- `AgentMessages.tsx:545`：标记 live group
- `AgentMessages.tsx:617`：渲染每个 group

### 4.5 SDKMessageRenderer 渲染 assistant turn

入口：`apps/electron/src/renderer/components/agent/SDKMessageRenderer.tsx`

它负责把 SDKMessage 内容块渲染成 UI：

- text block -> Markdown 内容。
- thinking block -> 推理折叠。
- tool_use block -> 工具调用行。
- tool_result -> 找到对应 tool_use 后展示结果。
- Agent/Task 子代理 -> 嵌套渲染。
- TaskCreate/TaskUpdate/TodoWrite -> 聚合成 `TaskProgressCard`。

关键位置：

- `SDKMessageRenderer.tsx:395`：构建任务进度数据
- `SDKMessageRenderer.tsx:446`：历史 TaskCreate subject 映射
- `SDKMessageRenderer.tsx:518`：渲染 assistant turn
- `SDKMessageRenderer.tsx:556`：识别 Agent/Task tool_use
- `SDKMessageRenderer.tsx:567`：把子代理内容挂到 parent toolUseId
- `SDKMessageRenderer.tsx:614`：渲染 top-level block
- `SDKMessageRenderer.tsx:618`：TaskProgressCard
- `SDKMessageRenderer.tsx:630`：ContentBlock

## 5. 多 Agent / SubAgent 协作怎么实现

### 5.1 Proma 自己不手写多 Agent 调度器

Proma 的多 Agent 能力主要来自 Claude Agent SDK 的 `Agent` / `Task` 工具。

Proma 做三件事：

1. 通过 SDK options 注册内置 SubAgent 定义。
2. 通过 system prompt 教主 Agent 什么时候委派。
3. 渲染 SDK 产生的 sidechain 消息和 task system message。

### 5.2 内置 SubAgent 定义

入口：`apps/electron/src/main/lib/agent-prompt-builder.ts`

`buildBuiltinAgents()` 注册三个内置子代理：

- `code-reviewer`
- `explorer`
- `researcher`

每个子代理定义：

- description
- prompt
- tools
- 可选 model

关键位置：

- `agent-prompt-builder.ts:20`：`buildBuiltinAgents`
- `agent-prompt-builder.ts:30`：`code-reviewer`
- `agent-prompt-builder.ts:50`：`explorer`
- `agent-prompt-builder.ts:66`：`researcher`

Orchestrator 把它们传给 SDK：

- `agent-orchestrator.ts:1472`：`agents: buildBuiltinAgents(claudeAvailable)`

### 5.3 Prompt 里指导主 Agent 委派

入口：`agent-prompt-builder.ts`

`buildSystemPrompt()` 里有专门的 “SubAgent 委派策略”：

- 复杂任务先探索再行动。
- 用 `explorer` 搜索代码。
- 用 `researcher` 做方案调研。
- 用 `code-reviewer` 做最终审查。
- 可以同时启动多个 SubAgent。
- 子 Agent 返回结果后，主 Agent 负责整合和决策。

这不是硬编码调度，而是把可用代理和协作规则注入给 SDK 的主 Agent。

### 5.4 SDK 如何表示子代理输出

SDK 会产生带 `parent_tool_use_id` 的消息。

含义：

- 主 Agent 发起一个 `Agent` 或 `Task` tool_use。
- 子代理内部的 assistant/tool messages 会带上这个 parent id。
- Proma 用这个 id 把子代理消息嵌套回对应工具调用下面。

相关类型：

- `packages/shared/src/types/agent.ts`
- `SDKAssistantMessage.parent_tool_use_id`
- `SDKUserMessage.parent_tool_use_id`
- system message 的 `task_started` / `task_progress` / `task_notification`

### 5.5 前端怎么渲染子代理

入口：

- `SDKMessageRenderer.tsx`
- `ContentBlock.tsx`

渲染步骤：

1. `SDKMessageRenderer` 扫描 assistant content blocks。
2. 找到 top-level 的 `Agent` 或 `Task` tool_use id。
3. 如果其他 block 的 `parentToolUseId` 指向这个 id，就归入 `childBlocksMap`。
4. `ContentBlock` 渲染 Agent/Task 工具行。
5. 用户展开后，递归渲染子代理内部工具调用。
6. `SubAgentFooter` 展示子代理最终输出和 token/耗时/工具调用次数。

关键位置：

- `SDKMessageRenderer.tsx:556`：识别 Agent/Task
- `SDKMessageRenderer.tsx:567`：建立 `childBlocksMap`
- `SDKMessageRenderer.tsx:625`：把 childBlocks 传给 ContentBlock
- `ContentBlock.tsx:365`：识别 Agent/Task 工具
- `ContentBlock.tsx:397`：Agent/Task 特殊渲染
- `ContentBlock.tsx:450`：递归渲染子代理工具调用
- `ContentBlock.tsx:463`：SubAgent 完成信息

### 5.6 TaskCreate 和 SubAgent 是两种东西

代码里有两个容易混淆的概念：

1. `Agent` / `Task` tool：真正的子代理 / 子任务执行，由 SDK 管。
2. `TaskCreate` / `TaskUpdate` / `TaskList` / `TaskGet`：任务计划和进度工具，更像 todo/task board。

Proma 对第二类工具做了 UI 聚合：

- `TaskCreate/TaskUpdate/TodoWrite` 会被聚合成 `TaskProgressCard`。
- `TaskGet/TaskList` 有专门的结果 renderer。

相关位置：

- `SDKMessageRenderer.tsx:395`：聚合 task progress
- `components/agent/task-progress.ts`
- `components/agent/TaskProgressCard.tsx`
- `components/agent/tool-result-renderers/task-get-result.tsx`
- `components/agent/tool-result-renderers/task-list-result.tsx`

## 6. 一张总图

```text
Chat:
React ChatView
  -> preload sendMessage
  -> ipcMain CHAT.SEND_MESSAGE
  -> chat-service
  -> @proma/core ProviderAdapter
  -> streamSSE(fetch provider API)
  -> webContents STREAM_CHUNK
  -> useGlobalChatListeners
  -> streamingStatesAtom
  -> ChatMessages temporary assistant bubble
  -> JSONL persisted assistant message

Agent:
React AgentView
  -> preload sendAgentMessage
  -> ipcMain AGENT.SEND_MESSAGE
  -> agent-service
  -> AgentOrchestrator
  -> ClaudeAgentAdapter
  -> @anthropic-ai/claude-agent-sdk
  -> local native binary process
  -> provider API + local tools in cwd
  -> SDKMessage async iterator
  -> EventBus
  -> webContents AGENT.STREAM_EVENT
  -> useGlobalAgentListeners
  -> liveMessagesMapAtom / agentStreamingStatesAtom
  -> AgentMessages + SDKMessageRenderer
  -> JSONL persisted SDKMessage
```

## 7. 读代码建议顺序

如果只关心 Chat 流式：

1. `ChatView.tsx`
2. `ipc.ts` 的 `CHAT_IPC_CHANNELS.SEND_MESSAGE`
3. `chat-service.ts`
4. `packages/core/src/providers/types.ts`
5. `packages/core/src/providers/sse-reader.ts`
6. `useGlobalChatListeners.ts`
7. `ChatMessages.tsx`

如果只关心 Agent：

1. `AgentView.tsx`
2. `ipc.ts` 的 `AGENT_IPC_CHANNELS.SEND_MESSAGE`
3. `agent-service.ts`
4. `agent-orchestrator.ts`
5. `claude-agent-adapter.ts`
6. `agent-event-bus.ts`
7. `useGlobalAgentListeners.ts`
8. `AgentMessages.tsx`
9. `SDKMessageRenderer.tsx`
10. `ContentBlock.tsx`

如果只关心多 Agent：

1. `agent-prompt-builder.ts`
2. `agent-orchestrator.ts` 里的 `agents: buildBuiltinAgents(...)`
3. `packages/shared/src/types/agent.ts` 的 `parent_tool_use_id` 和 task system messages
4. `SDKMessageRenderer.tsx` 的 `childBlocksMap`
5. `ContentBlock.tsx` 的 Agent/Task 特殊渲染
