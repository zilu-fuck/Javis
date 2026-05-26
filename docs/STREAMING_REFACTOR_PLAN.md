# Javis 流式输出改造方案

Last updated: 2026-05-26

## 一、现状分析

### 1.1 当前数据流模型：全量快照替换

```
User Input → Route → Tool Execution (await) → Full Snapshot emit → UI Full Re-render
```

每次状态变化，`RuntimeState.emit()` 发送完整 `TaskSnapshot` 对象，UI 订阅后整体替换渲染。工作流步骤之间通过 `await controller.wait()` 插入人工延迟来模拟"进行中"状态。

### 1.2 已有但未充分利用的基础设施

| 组件 | 位置 | 当前状态 |
|---|---|---|
| `TaskEventBus` | `packages/core/src/task-event-bus.ts` | 已定义事件类型 + 中间件链，但**仅在 `workflow-executor.ts` 中使用**，主流程 `index.ts` 未接入 |
| `ModelProvider.stream()` | `apps/desktop/src/model-provider.ts:73` | 已定义 `AsyncIterable<CompletionChunk>` 接口 + `StreamOptions.onChunk` 回调，但**实际调用全走 `complete()`（非流式）** |
| `stream_model_prompt` (Rust) | `apps/desktop/src-tauri/src/lib.rs` | 当前实现是**缓冲全部 chunk 后一次返回数组**，并非真正的 SSE 流式传输 |
| `CompletionChunk` | `apps/desktop/src/model-provider.ts:23` | 类型已定义，Tauri command 返回值也用此类型，但无逐块消费路径 |

### 1.3 核心瓶颈

1. **Tauri 层不是真流式**：`stream_model_prompt` 在 Rust 侧收集完所有响应才返回 `Vec<CompletionChunk>`，前端感知不到逐 token 输出
2. **Core 层没有增量事件**：`TaskSnapshot` 是完整对象替换，没有"追加一段文本"或"更新一个字段"的增量语义
3. **UI 层没有局部更新**：React 组件接收完整 `WorkbenchTask` prop，无法区分"新增了一行日志"和"整个任务变了"
4. **LLM 调用路径全走 `complete()`**：`planWithModelProvider`、`verifyWithModelProvider`、`proposeCodeEditWithModelProvider` 都等待完整响应才返回

---

## 二、目标架构

### 2.1 四层流式数据流

```text
┌─────────────────────────────────────────────────────────────────┐
│                        Tauri (Rust)                              │
│  SSE/Streaming HTTP → Tauri Event Emitter → 逐 chunk 推送        │
└──────────────────────────┬──────────────────────────────────────┘
                           │ Tauri event (stream-model-chunk)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Desktop App (TypeScript)                     │
│  ModelProvider.stream() → AsyncGenerator<CompletionChunk>        │
│  app-runtime.ts → 消费 stream，调用 taskEventBus.emit(chunk)     │
└──────────────────────────┬──────────────────────────────────────┘
                           │ TaskRuntimeEvent (增量)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Core (packages/core)                         │
│  TaskEventBus → DeltaReducer → TaskSnapshot (派生)               │
│  新增事件类型: agent.chunk / step.progress / tool.partial        │
└──────────────────────────┬──────────────────────────────────────┘
                           │ TaskSnapshot (含 streamingText 字段)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                      UI (packages/ui)                            │
│  ThreadView → StreamingMessage → 逐字渲染 + 打字机光标           │
│  ActivityLog → 增量追加日志条目                                  │
│  InspectorPanel → Agent 状态实时更新                             │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 核心设计原则

- **向下兼容**：现有非流式流程（文件扫描、项目检查等）不受影响，继续走 snapshot emit
- **Core 层不加 ModelProvider 依赖**：流式事件由 desktop 层注入，core 层只负责事件 → 快照的归约
- **增量优于全量**：新增 delta event 类型，UI 可选择性订阅局部更新
- **Tauri 事件优于轮询**：Rust 侧用 `app_handle.emit()` 推送 chunk，避免 JS 侧轮询

---

## 三、分层改造方案

### 3.1 第一层：Tauri Backend — 真流式 SSE

**当前问题**：`stream_model_prompt` 缓冲全部响应再返回。

**改造方案**：

#### 3.1.1 新增 Tauri Event 通道

```rust
// apps/desktop/src-tauri/src/streaming.rs (新增)

use tauri::Emitter;

#[derive(Clone, Serialize)]
struct StreamChunkPayload {
    stream_id: String,
    text: String,
    model: Option<String>,
    provider: Option<String>,
    index: u32,
}

#[derive(Clone, Serialize)]
struct StreamDonePayload {
    stream_id: String,
    finish_reason: Option<String>,
    total_chunks: u32,
}

#[derive(Clone, Serialize)]
struct StreamErrorPayload {
    stream_id: String,
    error: String,
}
```

#### 3.1.2 Tauri Command：启动流式请求

```rust
// 替代现有的 stream_model_prompt
#[tauri::command]
async fn stream_model_prompt_start(
    request: ModelPromptRequest,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let stream_id = Uuid::new_v4().to_string();
    let app = app_handle.clone();

    tauri::async_runtime::spawn(async move {
        match execute_streaming_request(&request, &app, &stream_id).await {
            Ok(total) => {
                let _ = app.emit("stream-model-done", StreamDonePayload {
                    stream_id: stream_id.clone(),
                    finish_reason: Some("stop".into()),
                    total_chunks: total,
                });
            }
            Err(e) => {
                let _ = app.emit("stream-model-error", StreamErrorPayload {
                    stream_id: stream_id.clone(),
                    error: e.to_string(),
                });
            }
        }
    });

    Ok(stream_id)
}

async fn execute_streaming_request(
    request: &ModelPromptRequest,
    app: &tauri::AppHandle,
    stream_id: &str,
) -> Result<u32, Box<dyn Error>> {
    // 1. 根据 provider 构造 SSE 请求
    // 2. 逐行读取 SSE 事件
    // 3. 每收到一个 chunk: app.emit("stream-model-chunk", payload)
    // 4. 返回总 chunk 数
    todo!("Provider-specific SSE parsing")
}
```

#### 3.1.3 取消流式请求

```rust
#[tauri::command]
async fn stream_model_prompt_cancel(stream_id: String) -> Result<(), String> {
    // 发送取消信号给对应的流式任务
    todo!("Cancellation token per stream_id")
}
```

**涉及文件**：
- `apps/desktop/src-tauri/src/lib.rs`（注册新 commands + events）
- `apps/desktop/src-tauri/src/streaming.rs`（新增，SSE 流式逻辑）

**成功标准**：
- Tauri 前端能通过 `listen("stream-model-chunk", ...)` 收到逐 chunk 事件
- 非流式 `complete_model_prompt` 保持不变，向后兼容
- 支持取消正在进行的流式请求

---

### 3.2 第二层：Desktop App — 流式 ModelProvider 接入

**当前问题**：`planWithModelProvider` 和 `verifyWithModelProvider` 只用 `complete()`。

**改造方案**：

#### 3.2.1 ModelProvider.stream() 改为真流式

核心挑战：Tauri event listener 是 push 模式（回调），AsyncGenerator 是 pull 模式（`yield`）。需要一个队列 + Promise resolver 做桥接。

```typescript
// apps/desktop/src/model-provider.ts

stream(prompt, options): AsyncIterable<CompletionChunk> {
  return streamModelPromptRealtime(prompt, providerSettings, options);
}

async function* streamModelPromptRealtime(
  prompt: string,
  providerSettings: ModelProviderSettings,
  options?: StreamOptions,
): AsyncGenerator<CompletionChunk> {
  const streamId = await invoke<string>("stream_model_prompt_start", {
    request: createModelRequest(prompt, providerSettings, options),
  });

  // push→pull bridge
  const buffer: CompletionChunk[] = [];
  let pendingResolve:
    | ((value: IteratorResult<CompletionChunk>) => void)
    | null = null;
  let streamError: Error | null = null;
  let finished = false;

  function push(chunk: CompletionChunk) {
    if (pendingResolve) {
      pendingResolve({ value: chunk, done: false });
      pendingResolve = null;
    } else {
      buffer.push(chunk);
    }
  }

  function finish(error?: Error) {
    finished = true;
    if (error) streamError = error;
    if (pendingResolve) {
      pendingResolve(
        error
          ? { value: undefined as any, done: true }
          : { value: undefined as any, done: true },
      );
    }
  }

  const unlistenChunk = await listen<StreamChunkPayload>(
    "stream-model-chunk",
    (event) => {
      if (event.payload.stream_id !== streamId) return;
      const chunk: CompletionChunk = {
        text: event.payload.text,
        model: event.payload.model,
        provider: event.payload.provider,
      };
      options?.onChunk?.(chunk);
      push(chunk);
    },
  );

  const unlistenDone = await listen<StreamDonePayload>(
    "stream-model-done",
    (event) => {
      if (event.payload.stream_id !== streamId) return;
      finish();
    },
  );

  const unlistenError = await listen<StreamErrorPayload>(
    "stream-model-error",
    (event) => {
      if (event.payload.stream_id !== streamId) return;
      finish(new Error(event.payload.error));
    },
  );

  try {
    while (!finished) {
      if (buffer.length > 0) {
        yield buffer.shift()!;
      } else {
        await new Promise<IteratorResult<CompletionChunk>>((resolve) => {
          pendingResolve = resolve;
        }).then((result) => {
          if (!result.done) buffer.push(result.value);
        });
      }
    }
    // drain remaining buffered chunks
    while (buffer.length > 0) {
      yield buffer.shift()!;
    }
    if (streamError) throw streamError;
  } finally {
    unlistenChunk();
    unlistenDone();
    unlistenError();
  }
}
```

关键点：
- `try/finally` 确保 Tauri event listener 在任何退出路径（正常结束 / 异常 / 调用方 `break`）都能被清理。
- `push` 函数优先直接交给等待中的 `pendingResolve`，否则入队。避免每个 chunk 都创建新 Promise。
- `finish` 后的 `while (buffer.length > 0)` 排空剩余 chunk，防止最后一个 chunk 卡在队列里。

#### 3.2.2 app-runtime.ts 流式调用点

```typescript
// apps/desktop/src/app-runtime.ts

// 改造前: await modelProvider.complete(...)
// 改造后: for await (const chunk of modelProvider.stream(...))

async function planWithModelProviderStreaming(
  request: CommanderPlanRequest,
  modelProvider: ModelProvider,
  onChunk: (chunk: CompletionChunk) => void,
): Promise<CommanderPlanResult> {
  let fullText = "";
  for await (const chunk of modelProvider.stream(
    buildCommanderPrompt(request),
    { maxTokens: 1200, temperature: 0 },
  )) {
    fullText += chunk.text;
    onChunk(chunk);
  }
  return normalizeCommanderPlan(parseJsonObject(fullText));
}
```

#### 3.2.3 在 createJavisRuntime 中接入流式事件

不是创建孤立函数，而是修改 `app-runtime.ts` 中现有的 `commanderTool.plan` 和 `verifierTool.check` 实现。在原有 LLM 调用前后插入 chunk 事件发射。

```typescript
// apps/desktop/src/app-runtime.ts

// 改造前 (line 57-58):
//   commanderTool: {
//     plan: (request) => planWithModelProvider(request, modelProvider),
//   },

// 改造后: 包一层流式事件发射
commanderTool: {
  plan: async (request) => {
    eventBus.emit({ kind: "agent.chunk_start", taskId, agentKind: "commander" });
    try {
      const result = await planWithModelProviderStreaming(
        request,
        modelProvider,
        (chunk) => eventBus.emit({
          kind: "agent.chunk", taskId, agentKind: "commander", text: chunk.text,
        }),
      );
      eventBus.emit({
        kind: "agent.chunk_end", taskId, agentKind: "commander",
        fullText: result.reasoning,
      });
      return result;
    } catch (error) {
      eventBus.emit({
        kind: "agent.chunk_end", taskId, agentKind: "commander",
        fullText: "", error: String(error),
      });
      throw error;
    }
  },
},

// verifierTool.check 同理，agentKind 改为 "verifier"
```

`eventBus` 和 `taskId` 的来源：在 `createJavisRuntime` 内部创建 `const eventBus = createTaskEventBus()`，`taskId` 由 core runtime 的 `start()` 回调传入。当前 `start()` 签名不传 taskId，需要 `createFileScanTaskRuntime` 增加一个 `onTaskStarted?: (taskId: string) => void` 回调参数——这是 core 层最小侵入的扩展点。

eventBus 的消费端：`eventBus.on((event) => runtimeState.emitDelta(event))`，由 DeltaReducer 归约为快照后通知 UI。

**涉及文件**：
- `apps/desktop/src/model-provider.ts`（stream() 改为 Tauri event 驱动）
- `apps/desktop/src/app-runtime.ts`（plan/verify 改用 stream + 发射增量事件）

**成功标准**：
- `planWithModelProvider` + `verifyWithModelProvider` 产生逐 chunk 的 `agent.chunk` 事件
- 非流式 `complete()` 路径保持可用（作为 fallback）

---

### 3.3 第三层：Core Package — 增量事件模型

**当前问题**：只有全量 `TaskSnapshot` 替换，无增量更新语义。

**改造方案**：

#### 3.3.1 扩展 TaskRuntimeEvent（增量事件类型）

```typescript
// packages/core/src/task-event-bus.ts — 追加以下事件类型

export type TaskRuntimeEvent =
  | { kind: "task.created"; taskId: ID }
  | { kind: "agent.status"; /* ... existing ... */ }
  // ... existing events ...

  // === 新增：流式 Agent 输出事件 ===
  | { kind: "agent.chunk_start"; taskId: ID; agentKind: AgentKind }
  | { kind: "agent.chunk"; taskId: ID; agentKind: AgentKind; text: string }
  | { kind: "agent.chunk_end"; taskId: ID; agentKind: AgentKind; fullText: string; error?: string }

  // === 新增：步骤级进度事件 ===
  | { kind: "step.progress"; taskId: ID; stepId: ID; percent: number; detail: string }
  | { kind: "step.started"; taskId: ID; stepId: ID }
  | { kind: "step.completed"; taskId: ID; stepId: ID; summary: string }

  // === 新增：工具局部输出事件 ===
  | { kind: "tool.partial"; taskId: ID; toolCallId: ID; partialOutput: string };
```

#### 3.3.2 DeltaReducer：事件 → 快照归约

```typescript
// packages/core/src/delta-reducer.ts (新增)

import type { TaskSnapshot, TaskRuntimeEvent, AgentKind } from "./index";

/**
 * 将增量 TaskRuntimeEvent fold 为完整 TaskSnapshot。
 * 每个事件类型只修改 snapshot 的相关字段，其余字段保持不变。
 */
export function createDeltaReducer(initial: TaskSnapshot) {
  let current = structuredClone(initial);
  const logs: TaskSnapshot["logs"] = [...initial.logs];

  /** agentKind → 累积中的流式文本 */
  const partialTexts = new Map<AgentKind, string>();

  return {
    getSnapshot: (): TaskSnapshot => ({
      ...current,
      logs: [...logs],
      streamingText:
        partialTexts.get("commander") ??
        partialTexts.get("verifier") ??
        partialTexts.get("research"),
    }),
    apply(event: TaskRuntimeEvent): TaskSnapshot {
      switch (event.kind) {
        case "agent.chunk_start": {
          current = { ...current, isStreaming: true };
          partialTexts.set(event.agentKind, "");
          logs.push({
            id: `${event.taskId}-chunk-start-${Date.now()}`,
            kind: "event",
            title: "agent.chunk_start",
            detail: `${event.agentKind} is generating output...`,
          });
          break;
        }
        case "agent.chunk": {
          const prev = partialTexts.get(event.agentKind) ?? "";
          partialTexts.set(event.agentKind, prev + event.text);
          break;
        }
        case "agent.chunk_end": {
          current = { ...current, isStreaming: false };
          partialTexts.delete(event.agentKind);
          // 仅在成功时写入最终文本；error 时保留上一个稳定值
          if (!event.error) {
            switch (event.agentKind) {
              case "commander":
                current = { ...current, commanderMessage: event.fullText };
                break;
              case "verifier":
                current = { ...current, verificationSummary: event.fullText };
                break;
              default:
                break;
            }
          }
          logs.push({
            id: `${event.taskId}-chunk-end-${Date.now()}`,
            kind: "event",
            title: "agent.chunk_end",
            detail: `${event.agentKind} completed output (${fullText.length} chars).`,
          });
          break;
        }
        case "step.progress": {
          current = {
            ...current,
            plan: current.plan.map((step) =>
              step.id === event.stepId
                ? { ...step, status: "running" }
                : step,
            ),
          };
          break;
        }
        case "step.started": {
          current = {
            ...current,
            plan: current.plan.map((step) =>
              step.id === event.stepId
                ? { ...step, status: "running" }
                : step,
            ),
          };
          break;
        }
        case "step.completed": {
          current = {
            ...current,
            plan: current.plan.map((step) =>
              step.id === event.stepId
                ? { ...step, status: "completed" }
                : step,
            ),
          };
          break;
        }
        case "task.completed":
        case "task.failed": {
          // 任务结束 → 清理所有流式状态
          current = { ...current, isStreaming: false };
          partialTexts.clear();
          break;
        }
        // 已有事件类型走原来的全量 emit 路径，DeltaReducer 不处理
        default:
          break;
      }
      return this.getSnapshot();
    },
  };
}
```

核心设计：
- `streamingText` 是**只读派生值**——取当前正在输出的最高优先级 agent 的部分文本（commander > verifier > research）。UI 只读这一个字段。
- `isStreaming` 在 `chunk_start` 设 true，`chunk_end` / `task.completed` / `task.failed` 设 false。
- `chunk_end` 时才把完整文本写入 `commanderMessage` 或 `verificationSummary`。流式过程中这些字段保持旧值不变，避免 UI 跳动。
- 已有事件类型（`task.created`、`agent.status` 等）走 `default` 分支不处理——它们继续使用原来的全量 `emit()` 路径。

#### 3.3.3 RuntimeState 扩展：emit 与 emitDelta 共存

```typescript
// packages/core/src/runtime-state.ts

export interface RuntimeState {
  // ... existing methods ...
  /** 增量更新：应用一个事件后通知订阅者。用于流式 LLM 输出路径。 */
  emitDelta(event: TaskRuntimeEvent): void;
}

export function createRuntimeState(
  initialSnapshot: TaskSnapshot,
  delayMs: number,
): RuntimeState {
  // ... existing setup ...

  // 新增：DeltaReducer 实例，emitDelta 时使用
  const deltaReducer = createDeltaReducer(initialSnapshot);

  return {
    // ... existing methods unchanged ...
    emit(nextSnapshot) {
      // 全量替换路径保持不变——非流式流程（文件扫描等）继续使用
      if (disposed) return;
      snapshot = nextSnapshot;
      for (const listener of listeners) listener(snapshot);
    },
    emitDelta(event) {
      // 增量路径：fold 事件 → 产生新快照 → 通知订阅者
      if (disposed) return;
      snapshot = deltaReducer.apply(event);
      for (const listener of listeners) listener(snapshot);
    },
    // ...
  };
}
```

**共存规则**：`emit` 和 `emitDelta` 写同一个内部 `snapshot` 引用，最后一条胜出。调用方保证同一个 task 不同时使用两种路径——流式 LLM 调用走 `emitDelta`，其余所有非流式流程走 `emit`。

`createRuntimeState` 内部创建 `DeltaReducer`，避免外部调用方感知这个细节。`createDeltaReducer` 需要从 core 包 export（在 `index.ts` 追加 export），因为 `runtime-state.ts` 需要引用它。

#### 3.3.4 TaskSnapshot 新增 streamingText / isStreaming 字段

```typescript
// packages/core/src/index.ts — TaskSnapshot 接口追加

export interface TaskSnapshot {
  // ... existing fields ...
  // (commanderMessage, verificationSummary 等保持不变)

  /**
   * 流式输出期间的累积部分文本。
   * - 非空 → UI 渲染 StreamingMessage + 打字机光标
   * - 空/undefined → UI 渲染静态 commanderMessage
   * - chunk_end 后，对应 agent 的最终文本写入 commanderMessage 或
   *   verificationSummary，streamingText 随之清空
   */
  streamingText?: string;
  /** 当前是否处于流式生成中（控制 UI 输入禁用、光标动画等） */
  isStreaming?: boolean;
}
```

字段职责分离：
| 字段 | 流式过程中 | 流式结束后 |
|---|---|---|
| `streamingText` | 累积的 LLM 部分输出（Commander 或 Verifier） | `undefined`（清空） |
| `commanderMessage` | 上一个稳定状态的值（不变） | Commander 最终完整文本 |
| `verificationSummary` | 上一个稳定状态的值（不变） | Verifier 最终完整文本 |
| `isStreaming` | `true` | `false` |

UI 层判断逻辑：`isStreaming && streamingText` → 渲染打字机效果；否则渲染静态文本。

**涉及文件**：
- `packages/core/src/task-event-bus.ts`（扩展事件类型）
- `packages/core/src/delta-reducer.ts`（新增）
- `packages/core/src/runtime-state.ts`（扩展 emitDelta）
- `packages/core/src/index.ts`（TaskSnapshot 追加 streamingText/isStreaming）

**成功标准**：
- 现有非流式流程全部不受影响（事件归约产生相同快照）
- `emitDelta` 可被 desktop 层调用，逐 chunk 更新 UI
- DeltaReducer 纯函数，可独立测试

---

### 3.4 第四层：UI Package — 增量渲染

**当前问题**：React 组件接收完整 `WorkbenchTask`，无法区分局部更新。

**改造方案**：

#### 3.4.1 新增 StreamingMessage 组件

```tsx
// packages/ui/src/components/StreamingMessage.tsx (新增)

interface StreamingMessageProps {
  /** 流式累积文本（来自 task.streamingText） */
  text: string;
  /** 是否仍在生成中（来自 task.isStreaming） */
  isStreaming: boolean;
  /** 消息来源 Agent 名称 */
  agentLabel: string;
}

export function StreamingMessage({ text, isStreaming, agentLabel }: StreamingMessageProps) {
  return (
    <article className="javis-message streaming">
      <p className="javis-message-title">{agentLabel}</p>
      <p className="javis-message-body">
        {text}
        {isStreaming && <span className="javis-cursor-blink">|</span>}
      </p>
    </article>
  );
}
```

ThreadView 调用方式：
```tsx
{task.isStreaming && task.streamingText ? (
  <StreamingMessage
    text={task.streamingText}
    isStreaming={task.isStreaming}
    agentLabel={labels.commander}
  />
) : (
  <article className="javis-message">
    <p className="javis-message-title">{labels.commander}</p>
    <p className="javis-message-body">{task.commanderMessage}</p>
  </article>
)}
```

#### 3.4.2 ThreadView 支持流式渲染

```tsx
// packages/ui/src/components/ThreadView.tsx — 改动

// 判断逻辑:
const showStreaming = task.isStreaming && task.streamingText;

// 当 showStreaming === true 时：
// - commanderMessage 区域渲染 <StreamingMessage>（带打字机光标）
// - 不渲染 TaskSections（等 streaming 结束再展示最终结果）
// - 禁用输入框（流式生成期间不允许新输入）
// 当 showStreaming === false 时：渲染现有静态布局（行为不变）
```

#### 3.4.3 ActivityLog 增量追加

`ActivityLog` 当前已通过 `task.logs.length` 展示日志数量。改造方向：每条新日志以滑入动画追加，而非整体替换列表。

```tsx
// 关键改动：使用 CSS transition-group 或 animation
// 新增日志条目时添加 .log-entry-entering class → 触发滑入动画
```

#### 3.4.4 订阅频率控制

```typescript
// packages/ui/src/use-streaming-snapshot.ts (新增)

import { useEffect, useState, useRef } from "react";

/**
 * 流式场景下的订阅 hook。
 * 使用 requestAnimationFrame 节流，避免每个 chunk 都触发 React re-render。
 * 最多 60fps 更新，实际上 15-30fps 对打字机效果完全足够。
 */
export function useStreamingSnapshot(runtime: TaskRuntime) {
  const [snapshot, setSnapshot] = useState(runtime.getSnapshot());
  const rafId = useRef<number>(0);
  const pending = useRef<TaskSnapshot | null>(null);

  useEffect(() => {
    return runtime.subscribe((next) => {
      pending.current = next;
      if (rafId.current === 0) {
        rafId.current = requestAnimationFrame(() => {
          rafId.current = 0;
          if (pending.current) {
            setSnapshot(pending.current);
            pending.current = null;
          }
        });
      }
    });
  }, [runtime]);

  return snapshot;
}
```

**涉及文件**：
- `packages/ui/src/components/StreamingMessage.tsx`（新增）
- `packages/ui/src/components/ThreadView.tsx`（isStreaming 条件渲染）
- `packages/ui/src/components/ActivityLog.tsx`（增量追加动画）
- `packages/ui/src/use-streaming-snapshot.ts`（新增，RAF 节流订阅）

**成功标准**：
- LLM 输出逐 token 出现在 UI，带打字机光标
- 非流式流程 UI 行为不变
- 流式期间不出现布局跳动（commanderMessage 区域预留最小高度）

#### 3.4.5 流式状态生命周期

```
Task 开始 (非流式)            LLM 调用开始              LLM 输出完成          Task 结束
   │                              │                        │                    │
   │ isStreaming: undefined       │ isStreaming: true      │ isStreaming: false  │ isStreaming: undefined
   │ streamingText: undefined     │ streamingText: ""      │ streamingText:      │ streamingText: undefined
   │                              │                        │   undefined         │
   │                              │ chun​k_start ──────────→│                     │
   │                              │ chun​k ──────┐          │                     │
   │                              │ chun​k ──────┤ (loop)   │                     │
   │                              │ chun​k_end ───┴────────→│                     │
   │                              │                        │                     │
   │                              │              task.completed ─────────────────→│
```

关键清理时机：
- `agent.chunk_end` 时：`isStreaming = false`，对应 agent 的最终文本写入目标字段（`commanderMessage` / `verificationSummary`），`streamingText` 在 `getSnapshot()` 中因 `partialTexts` 清空而变为 `undefined`
- `task.completed` / `task.failed` 时：`isStreaming = false`，`partialTexts.clear()`，兜底清理
- 流式期间取消任务（`cancelStream`）：desktop 层调用 `stream_model_prompt_cancel` → Tauri 侧清理 → `stream-model-error` 事件 → DeltaReducer 收到 `agent.chunk_end(error)` → 回退到最后一个稳定快照

---

## 四、实施路线

### 1. Tauri Backend — 真流式 SSE

| 步骤 | 内容 | 涉及文件 |
|---|---|---|
| 1.1 | Rust 侧实现 SSE 解析 + Tauri event 推送 | `src-tauri/src/streaming.rs`（新增） |
| 1.2 | 注册 `stream_model_prompt_start` / `stream_model_prompt_cancel` commands | `src-tauri/src/lib.rs` |
| 1.3 | TypeScript 侧 `ModelProvider.stream()` 改为 Tauri event 驱动 | `model-provider.ts` |
| 1.4 | 验证：`for await (const chunk of stream)` 端到端测试 | `model-provider.test.ts` |

**验收**：能从 Tauri event 收到逐 chunk 数据，首 chunk 延迟 < 50ms。

### 2. Core — 增量事件模型

| 步骤 | 内容 | 涉及文件 |
|---|---|---|
| 2.1 | 扩展 `TaskRuntimeEvent` 联合类型（新增 `agent.chunk_*`、`step.progress`） | `task-event-bus.ts` |
| 2.2 | 实现 `DeltaReducer`（事件序列 → 快照归约，纯函数） | `delta-reducer.ts`（新增） |
| 2.3 | `RuntimeState` 增加 `emitDelta`，内部创建 DeltaReducer，与 `emit` 共存 | `runtime-state.ts` |
| 2.4 | `TaskSnapshot` 增加 `streamingText` / `isStreaming` | `index.ts` |
| 2.5 | Core `index.ts` 追加 export：`createDeltaReducer`、`TaskRuntimeEvent`（已有 `createTaskEventBus`） | `index.ts` |
| 2.6 | 单元测试：事件 fold 结果与直接 emit 等价 | `delta-reducer.test.ts`（新增） |

**验收**：`emitDelta` 序列产生与直接 `emit` 等价的最终快照，纯函数可独立测试。Core 层新增的两个导出（`createDeltaReducer`、`TaskRuntimeEvent` 类型）可被步骤 3 的 desktop 层 import。

### 3. Desktop App — 流式接入现有流程

| 步骤 | 内容 | 涉及文件 |
|---|---|---|
| 3.1 | `createFileScanTaskRuntime` 增加 `onTaskStarted?: (taskId: string) => void` 回调参数（taskId 在 `start()` 内部创建，desktop 层此前拿不到） | `packages/core/src/index.ts` |
| 3.2 | `createJavisRuntime` 内创建 `const eventBus = createTaskEventBus()`，并 `eventBus.on((e) => runtimeState.emitDelta(e))` | `app-runtime.ts` |
| 3.3 | `commanderTool.plan` 改为 `planWithModelProviderStreaming` + 逐 chunk 发射事件 | `app-runtime.ts` |
| 3.4 | `verifierTool.check` 改为 `verifyWithModelProviderStreaming` | `app-runtime.ts` |
| 3.5 | `onTaskStarted` 回调中记录 taskId，供 commanderTool/verifierTool 的闭包引用 | `app-runtime.ts` |

**验收**：Commander/Verifier 输出逐字出现在快照中，非流式 tool（file scan 等）不受影响。

### 4. UI — 增量渲染

| 步骤 | 内容 | 涉及文件 |
|---|---|---|
| 4.1 | 实现 `StreamingMessage` 组件（打字机光标 + 自动滚动） | `StreamingMessage.tsx`（新增） |
| 4.2 | `ThreadView` 条件渲染：流式时显示 StreamingMessage，静态时显示 TaskSections | `ThreadView.tsx` |
| 4.3 | RAF 节流订阅 hook（避免每 chunk 触发 render） | `use-streaming-snapshot.ts`（新增） |
| 4.4 | CSS 光标闪烁动画 + 流式消息过渡样式 | `styles/` |

**验收**：Commander 逐字输出带闪烁光标，无布局跳动，非流式流程 UI 行为不变。

### 5. 错误处理与收尾

| 步骤 | 内容 |
|---|---|
| 5.1 | 流式期间取消任务 → 正确清理 Tauri event listener + 回退快照 |
| 5.2 | Provider 不支持 SSE → 自动降级为 `complete()`，用户无感知 |
| 5.3 | 流式请求超时/网络错误 → emit error 事件，快照回退到最后一个稳定状态 |
| 5.4 | 全量回归（`pnpm check`：typecheck + Vitest + Rust test + build） |
| 5.5 | 手动 QA：发起 research / project-inspection 任务，观察流式效果 |

---

## 五、风险与降级策略

| 风险 | 降级方案 |
|---|---|
| Tauri event 通道在高频 chunk 下丢帧 | RAF 节流（Phase 4）+ 超过 60fps 的 chunk 合并 |
| 某些 Provider 不支持 SSE | 自动降级为 `complete()`（非流式），用户无感知 |
| 流式 JSON 解析失败（只收到部分 JSON） | 只在 `agent.chunk_end` 时解析完整 JSON；流式阶段只展示纯文本 |
| Rust 侧 SSE 解析库选择 | 优先用 `reqwest` + `tokio::io::AsyncBufRead` 逐行读，避免引入重量级依赖 |
| 现有非流式流程被破坏 | DeltaReducer 的事件 fold 结果必须与现有 emit 结果等价（Phase 2.5 测试保证） |

---

## 六、与 5.26 Task Plan 的关系

5.26 Task Plan（`docs/2026-05-26_TASK_PLAN.md`）聚焦中文 Agent 外壳 + 安全收尾。本流式方案是**独立的并行工作流**，两者没有代码冲突：

- **5.26 改动的文件**：`agents.ts`、`chinese-reviewer.ts`、`terminology.ts`、`app-runtime.ts`、`error-localizer.ts`、`lib.rs`
- **本方案改动的文件**：`task-event-bus.ts`、`runtime-state.ts`、`model-provider.ts`、`ThreadView.tsx`、`lib.rs`（streaming 部分）、新增 `delta-reducer.ts`、`streaming.rs`

共同触及的文件仅 `app-runtime.ts` 和 `lib.rs`，且改动区域不同（中文层在 prompt 处理，流式层在 I/O 路径）。建议**先完成 5.26 再启动流式改造**，或在不同分支并行。

---

## 七、不做的事项

- 不做 WebSocket 双向流式（Javis 是本地桌面应用，不需要 WS）
- 不做 tool call 中途流式输出（Code Agent 的 diff/proposal 不适合流式，保持批处理）
- 不做 SSE → UI 的零拷贝路径（经过 Tauri event + TypeScript 事件总线是必要的安全边界）
- 不改变现有非流式 tool 的行为（file scan、project inspection、PDF organization 保持批处理模式）
