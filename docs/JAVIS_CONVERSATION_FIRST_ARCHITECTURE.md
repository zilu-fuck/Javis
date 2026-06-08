# Javis Conversation-first Agent 架构优化方案

> 状态：待实施（Phase 1 完成后下一目标）
> 日期：2026-06-07
> 基于：Phase 1 修复成果 + 2026-06-06 产品体验走查 + openhanako/Proma 参考架构

---

## 0. 前置条件

本方案依赖 Phase 1 修复成果：

| Phase 1 成果 | 位置 | 本方案中的用途 |
|---|---|---|
| 30 capability tags 全覆盖 | `agent-capability.ts` | L2 单 Agent 路由时按 capability 匹配 |
| `isValidCapabilityTag()` | `agent-capability.ts` | Router 推断 capability 后校验 |
| `AgentRegistry.findByCapabilities()` | `agent-capability.ts` | L2 选择 Agent 的核心方法 |
| `conversationMessages` 持久化 | `index.ts` respondToAskUser | L1 对话上下文在消息间保持 |
| `getTaskProgress()` | `task-state.ts` | L3 DAG 阶段进度百分比 |
| `useDeferredValue` Markdown | `Markdown.tsx` | 避免流式渲染阻塞 |
| SSE 流式后端 | `streaming.rs` | L1/L2/L3 流式输出的基础设施 |
| WAL checkpoint + exit handler | `database.rs` + `lib.rs` | 路由日志可靠性 |

---

## 1. 问题定位

### 1.1 真实耗时过高

当前 Agent 模式下，简单输入"你好"触发 **2-3 次 LLM 调用**：

```
用户"你好"
  → 中文预处理 LLM（并行，2s timeout）
  → Commander 生成 DAG Plan LLM（~3000 token prompt）
  → ReAct decideNext LLM（~1500 token prompt）
  → 回复
```

### 1.2 体感"未响应"

- Commander plan 和 ReAct 决策使用 `complete()`（同步阻塞），**无流式输出**
- Commander prompt 载入 10 个 Agent + 42 个 ToolDescriptor + 30 个 capability tag
- 用户看到 3-6 秒静止的 `Planning task` → 体感卡死

### 1.3 根因

> **Agent 模式把每条消息当作复杂多步工作流，Commander 是默认入口。**

对比 openhanako：所有消息统一走 `session.prompt()`（Pi SDK），LLM 自行决定是否调工具。简单消息 = 单次 LLM 调用 + 流式输出。

---

## 2. 核心原则

```
Conversation-first, Workflow-on-demand
```

```
旧模型: Agent Mode = 每条消息默认进入工作流
新模型: Agent Mode = 默认对话，需要时升级为工作流
```

```
Commander 不再是 Agent 模式默认入口。
Local Router 才是默认入口。
```

---

## 3. 架构总览

```
User Message
  │
  ▼
Immediate UI Feedback（发送后 0.5s 内）
  ├─ append 用户消息
  ├─ append assistant placeholder
  └─ typing / thinking 动画
  │
  ▼
Local Complexity Router（纯规则，不调 LLM）
  │
  ├─ L1: Direct Chat Stream    ← 普通对话/解释/建议
  ├─ L2: Single Agent Task     ← 明确单步工具任务
  └─ L3: Commander DAG         ← 多步骤/多Agent/复杂方案
```

> **注意**：原方案中的 L0 (Local Reply) 已砍掉。原因：硬编码模板回复在相邻消息间会造成风格割裂，省下的几百毫秒不值得。极短输入统一走 L1 Direct Chat。

---

## 4. 三级任务分层

### L1: Direct Chat Stream

**适用场景**：普通聊天、解释、建议、短问答、寒暄

```
你好 / 这个是什么意思？ / 你觉得怎么样？ / 简单解释一下 / 继续
```

**链路**：

```
用户输入 → Local Router 判为 L1 → Direct Chat Stream → token_delta 流式输出
```

**特点**：

| 项目 | 值 |
|---|---|
| LLM 调用 | 1 次（流式） |
| 进入 Commander | 否 |
| 进入 ReAct | 否 |
| 加载工具表 | 否 |
| 流式输出 | 是 |
| 预期首 token 延迟 | < 1s |

**L1 Prompt 结构**（~500 tokens，vs 当前 Commander ~3000 tokens）：

```
[Agent Identity]     ← Javis 是什么（2-3句，复用 getAgentSystemPrompt）
[Workspace Context]  ← 当前 workspace 路径 + 最近文件摘要
[User Style]         ← 用户配置的语气偏好（如有）
[Conversation]       ← 最近 N 条对话消息
---
User: 你好
```

**禁用**：
- Commander DAG JSON schema
- ReAct decision JSON schema
- 任何 ToolDescriptor
- capability tag 白名单
- DAG planning instruction

---

### L2: Single Agent Task

**适用场景**：明确的单步工具任务

```
总结这个文件 / 查一下这个资料 / 读取当前配置 / 搜索 XXX
```

**链路**：

```
用户输入 → Local Router 推断 capability → AgentRegistry.findByCapabilities() 选 Agent
  → 只加载该 Agent 允许的工具 → 执行 → 流式输出结果
```

**特点**：

| 项目 | 值 |
|---|---|
| LLM 调用 | 通常 1 次 |
| 进入 Commander | 否 |
| 进入 ReAct | 否（工具明确时直接调用） |
| 加载工具 | 仅相关 Agent 的 allowedToolNames |
| 流式输出 | 是 |

**Agent 选择**（复用 Phase 1 成果）：

```ts
// packages/core/src/agent-capability.ts 已有
const registry = createDefaultAgentRegistry();
const agent = registry.findByCapabilities([inferredCapability]);
```

**示例**：

```
"总结这个文件"
  → Router 推断 capability: file_scan
  → AgentRegistry.findByCapabilities(["file_scan"]) → File Agent
  → 只加载 file_scan / document_classify 相关工具
  → 流式输出总结
```

---

### L3: Commander DAG Workflow

**适用场景**：多步骤、多工具、多 Agent 协作的复杂任务

```
分析四个项目并生成架构方案 / 设计插件系统 / 完整重构方案
```

**链路**：

```
用户输入 → Local Router 判为 L3 → Commander 生成 DAG
  → 多 Agent 执行（每步有状态反馈） → Synthesizer 汇总 → 流式输出
```

**特点**：

| 项目 | 值 |
|---|---|
| LLM 调用 | 允许多次 |
| 进入 Commander | 是 |
| 工具加载 | 按 capability 懒加载（不一次加载全部 42 个） |
| 进度反馈 | 每步状态 + stage 进度百分比 |

**阶段进度 UI**（复用 `getTaskProgress()`）：

```
已拆解任务 (20%)
正在执行第 1/4 步：读取资料 (35%)
正在执行第 2/4 步：分析差异 (50%)
正在执行第 3/4 步：生成方案 (65%)
正在执行第 4/4 步：汇总输出 (80%)
完成 (100%)
```

---

## 5. Local Router 设计（纯规则，不调 LLM）

### 5.1 路由输出

```ts
type RouteLevel = "L1" | "L2" | "L3";

type RouteDecision = {
  level: RouteLevel;
  mode: "direct_chat" | "single_agent_task" | "commander_dag";
  score: number;
  reasons: string[];
};
```

### 5.2 复杂度评分

```ts
function scoreComplexity(input: string): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  // 长度信号（弱信号）
  if (input.length > 100) { score += 1; reasons.push("long_input"); }
  if (input.length > 300) { score += 1; reasons.push("very_long_input"); }

  // 工具意图（中信号）
  const toolPatterns = [
    "读取文件", "总结文件", "搜索", "查一下", "帮我找",
    "打开", "运行", "执行", "创建", "删除", "修改",
  ];
  if (containsAny(input, toolPatterns)) { score += 2; reasons.push("tool_intent"); }

  // 分析/设计意图（弱信号 — 单独"分析"不足以判定复杂任务）
  const analysisPatterns = ["分析", "对比", "评估", "review"];
  if (containsAny(input, analysisPatterns) && input.length > 50) {
    score += 1; reasons.push("analysis_intent");
  }

  // 方案/架构意图（强信号）
  const designPatterns = ["方案", "架构", "设计", "重构", "系统"];
  if (containsAny(input, designPatterns)) { score += 2; reasons.push("design_intent"); }

  // 显式多步骤（强信号）
  const multiStepPattern = /先.*(?:再|然后|最后)/;
  if (multiStepPattern.test(input)) { score += 3; reasons.push("explicit_multi_step"); }

  // 多目标（多个问号或编号列表）
  const questionCount = (input.match(/[？?]/g) || []).length;
  if (questionCount >= 2) { score += 2; reasons.push("multiple_questions"); }

  // workspace/附件引用
  if (/@[\w/-]+/.test(input) || /附件|文件路径/.test(input)) {
    score += 2; reasons.push("workspace_reference");
  }

  return { score, reasons };
}
```

### 5.3 路由决策

```ts
function routeMessage(input: string): RouteDecision {
  const text = input.trim();

  // 空输入 → L1
  if (!text) {
    return { level: "L1", mode: "direct_chat", score: 0, reasons: ["empty_input"] };
  }

  const { score, reasons } = scoreComplexity(text);

  // L1: 总分 ≤ 2
  if (score <= 2) {
    return { level: "L1", mode: "direct_chat", score, reasons: [...reasons, "simple"] };
  }

  // L2: 总分 3-5 且有工具意图
  if (score <= 5 && reasons.includes("tool_intent")) {
    return { level: "L2", mode: "single_agent_task", score, reasons: [...reasons, "tool_task"] };
  }

  // L3: 总分 ≥ 6 或有显式多步骤/设计意图
  return { level: "L3", mode: "commander_dag", score, reasons: [...reasons, "complex"] };
}
```

### 5.4 路由日志

每次 run 记录 RouteLog，复用现有 JSONL 基础设施：

```ts
type RouteLog = {
  runId: string;
  inputPreview: string;       // 前 80 字符
  routeLevel: "L1" | "L2" | "L3";
  mode: string;
  complexityScore: number;
  reasons: string[];
  escalated: boolean;         // 执行中是否升级
  downgraded: boolean;        // 执行中是否降级
  timestamp: number;
};
```

存储：`jsonl-log-persistence.ts` 的 JSONL 追加写入。

用途：
- 排查 Router 误判
- 统计 L1/L2/L3 命中率
- 衡量 LLM 调用减少效果
- 优化评分规则

---

## 6. 升级与降级

Router 一定可能误判，双向兜底：

### 6.1 L1/L2 → L3 升级

当 Direct Chat 或 Single Agent 执行中发现任务比预期复杂时升级：

```
L1 Direct Chat → 发现需要多工具 / 多步骤 → 升级到 L3 Commander DAG
```

### 6.2 L3 → direct_reply 降级

Commander 内部保留降级能力。Router 可能把简单任务误判为 L3，Commander 不应硬生成 DAG：

```json
{ "mode": "direct_reply", "response": "..." }
```

---

## 7. UI 反馈改造（解决"未响应"体感）

### 7.1 即时反馈事件流

```ts
type AgentRunEvent =
  | { type: "run_started"; runId: string }
  | { type: "route_decided"; level: "L1" | "L2" | "L3"; reasons: string[] }
  | { type: "stage_started"; stage: "routing" | "generating" | "executing" | "synthesizing" }
  | { type: "token_delta"; text: string }        // 流式文本（复用现有 SSE 路径）
  | { type: "tool_started"; toolName: string }
  | { type: "tool_finished"; toolName: string }
  | { type: "run_completed" }
  | { type: "run_failed"; error: string };
```

### 7.2 前端显示策略

发送后 0.5 秒内必须：

```
1. append 用户消息气泡
2. append assistant placeholder 气泡
3. 显示 typing / thinking 动画
4. 显示当前阶段文案（每 2-3s 切换）
```

阶段文案轮播：

```
"正在理解你的问题..."
"正在生成回复..."
"正在读取文件..."
"正在规划任务..."
"正在整理结果..."
```

**原则**：UI 不在同一静止状态停留超过 2 秒。

### 7.3 复用现有基础设施

| 需求 | 已有实现 |
|---|---|
| 流式 token 输出 | `streaming.rs` SSE 后端 + `use-smooth-stream.ts` 打字机动画 |
| assistant bubble | `ThreadView.tsx` StreamingMessage 组件 |
| 阶段进度 | `getTaskProgress()` + `TASK_STATUS_PROGRESS` |
| 对话消息持久化 | `conversationMessages` + `TaskSections.tsx` |

---

## 8. Rust LLM Client 改造

### 8.1 当前问题

```rust
// lib.rs — 所有 LLM 调用都用这个
let client = reqwest::blocking::Client::builder()
    .timeout(OPENCODE_PROPOSAL_TIMEOUT)  // 90s
    .build()?;
let response = request_builder.send()?;  // 阻塞
```

问题：
- 无法 token 级流式输出
- 线程被长时间占用
- L1 Direct Chat 无法实现流式

### 8.2 改造目标

**只改 L1 Direct Chat 路径**，不影响其他模块：

```rust
// 新增：L1 专用流式 client
async fn stream_model_prompt_direct(
    request: ModelCompletionRequest,
) -> Result<impl Stream<Item = String>, String> {
    let client = reqwest::Client::new();  // async client
    let response = client.post(&endpoint)
        .json(&body)
        .send()
        .await?;
    // 逐行解析 SSE / chunk
    // 通过 Tauri emit 发送 token_delta
}
```

现有 `complete_model_prompt` 保持 blocking 不动（供 L2/L3 使用，后续再改）。

---

## 9. Commander 优化

### 9.1 Commander 不再默认出场

```
L1: 不进 Commander
L2: 不进 Commander
L3: 才进 Commander
```

### 9.2 工具懒加载

Commander 只输出 capability 级步骤，具体工具交给 Executor 按需加载：

```json
{
  "steps": [
    { "capability": "file_scan", "goal": "读取参考项目" },
    { "capability": "web_search", "goal": "调研方案" },
    { "capability": "synthesis", "goal": "输出最终文档" }
  ]
}
```

Executor 根据 capability 加载对应工具：

```
file_scan   → list_files, read_file, search_file
web_search  → search_web, fetch_page
synthesis   → (纯文本生成，不需要工具)
```

**不加载无关工具**：如果 Commander DAG 只有 `file_scan` + `synthesis`，就不要给 Commander 看 `browser_navigate` / `desktop_input` / `schedule_create`。

### 9.3 ReAct 按需使用

Step 增加执行模式：

```ts
type StepExecutionMode =
  | "direct_response"     // 直接生成文本，不进 ReAct
  | "direct_tool_call"    // 工具明确时直接调用，不进 ReAct
  | "react";              // 探索型任务，需要 ReAct 循环
```

Commander 已经在 plan 中明确了 capability，**Executor 不需要再问 ReAct "要不要调工具"**。

---

## 10. PR 拆分与实施顺序

### PR 1: Immediate UI Feedback（纯前端，~2 天）

**目标**：先解决"未响应"体感，不改任务执行逻辑

**改动**：
- `ThreadView.tsx`: 发送后立即 append assistant placeholder bubble
- `ThreadView.tsx`: 显示 typing/thinking 动画（CSS animation）
- `packages/ui/src/components/`: 新增 `ThinkingIndicator` 组件
- 引入 `AgentRunEvent` 类型定义（`packages/core/src/`）
- 替换静止的 `Planning task` 为动态文案轮播

**验收**：
- 发送消息后 0.5 秒内出现可见反馈
- 即使底层仍走 Commander DAG，UI 也不像卡死

### PR 2: Local Router + RouteLog（纯前端规则引擎，~1.5 天）

**目标**：简单消息绕过 Commander

**改动**：
- `packages/core/src/`: 新增 `local-router.ts`（`routeMessage()` + `scoreComplexity()` + `RouteLog` 类型）
- `apps/desktop/src/app-runtime.ts`: `start()` 中注入 Router，L1 消息不再调 Commander
- `packages/core/src/index.ts`: 导出 Router 类型
- RouteLog 写入 `jsonl-log-persistence.ts` JSONL

**验收**：
- "你好"不进入 Commander（验证：RouteLog 显示 L1）
- "总结这个文件"不进入 Commander（验证：RouteLog 显示 L2）
- "分析四个项目并生成架构方案"进入 Commander（验证：RouteLog 显示 L3）
- Router 决策可在日志中查看

### PR 3: Rust async streaming for L1 path（Rust ~2 天）

**目标**：L1 Direct Chat 支持流式输出

**改动**：
- `streaming.rs` / `lib.rs`: 新增 `stream_model_prompt_l1` Tauri command
  - 使用 `reqwest::Client`（async）
  - 解析 SSE/chunk → Tauri emit `token_delta`
- 现有 `complete_model_prompt` 保持 blocking 不动

**验收**：
- L1 路径可流式输出 token
- 不影响现有 L2/L3 blocking 路径

### PR 4: Direct Chat Stream（前端 + L1 prompt，~2 天）

**目标**：L1 路径端到端可用

**改动**：
- `apps/desktop/src/app-runtime.ts`: 新增 `runDirectChatTask()`
  - 构建 L1 prompt（~500 tokens）
  - 调用 PR 3 的流式接口
- `packages/ui/src/components/ThreadView.tsx`: 消费 `token_delta` 流式渲染
- L1 prompt 结构见 §4

**验收**：
- 普通聊天不进入 Commander，不进入 ReAct
- 2 秒内开始 `token_delta`
- 流式输出体验流畅

### PR 5: Commander 工具懒加载（~1.5 天）

**目标**：L3 路径下 Commander prompt 体积缩减

**改动**：
- `workflow-executor.ts` `runCommanderDagTask`:
  - 根据 L3 plan 中的 capabilities 过滤 tool 列表
  - Commander 只看相关 Agent + 相关工具
- `commander-plan-schema.ts`: prompt 中只注入过滤后的 tools

**验收**：
- Commander prompt 大小降低 50%+（不再默认携带全部 42 个工具）
- L3 任务首 token 延迟下降

### PR 6: ReAct 按需使用（~1.5 天）

**目标**：减少每个 step 的额外 ReAct LLM 决策

**改动**：
- `workflow-executor.ts` `executeStepWithReAct`:
  - 检查 step 的 `executionMode`
  - `direct_response` / `direct_tool_call` 模式跳过 ReAct loop
  - 只有 `react` 模式进入 ReAct
- Commander plan prompt 增加 `executionMode` 字段

**验收**：
- synthesis step 不再触发 `reactDecideNext`
- 明确工具调用 step 不再额外问 LLM

---

## 11. 代码复用清单

以下 Phase 1 成果直接用于本方案，无需重复建设：

| 成果 | 文件 | 本方案用途 |
|---|---|---|
| 30 capability tags | `agent-capability.ts` | Router 推断 + Agent 选择 |
| `isValidCapabilityTag()` | `agent-capability.ts` | Router 校验 |
| `AgentRegistry.findByCapabilities()` | `agent-capability.ts` | L2 选 Agent |
| `ALL_CAPABILITY_TAGS` | `agent-capability.ts` | Router 白名单 |
| `getTaskProgress()` | `task-state.ts` | L3 阶段进度 |
| `conversationMessages` | `index.ts` | L1 对话上下文保持 |
| SSE streaming backend | `streaming.rs` | L1/L2/L3 流式输出 |
| `StreamingMessage` + `useSmoothStream` | `ThreadView.tsx` | 打字机动画 |
| `useDeferredValue` Markdown | `Markdown.tsx` | 避免流式渲染阻塞 |
| `TaskSections.tsx` askUser 内联 | `TaskSections.tsx` | L2/L3 中追问内联展示 |
| WAL checkpoint | `database.rs` | RouteLog 可靠性 |
| `userFacingError` | `index.ts` | run_failed 事件 |

---

## 12. 风险与兜底

| 风险 | 缓解 |
|---|---|
| Router 误判简单→复杂 | L3 Commander 可 `direct_reply` 降级 |
| Router 误判复杂→简单 | L1/L2 可升级到 L3 |
| reqwest 改造影响现有模块 | 只改 L1 路径，现有 blocking 路径保留不动 |
| L1 prompt 太小丢失 Agent 感 | 保留 Agent identity + workspace context + user style |
| PR 改动量过大 | 6 个 PR 独立可测，互不阻塞（PR 3-4 除外） |

---

## 13. 验收指标

### 简单消息（"你好"）

```
- 0.5s 内出现 assistant bubble + typing 动画
- 不进入 Commander
- 不进入 ReAct
- LLM 调用 ≤ 1 次
- 首 token 延迟 < 1s
```

### 普通聊天

```
- 0.5s 内出现可见反馈
- 2s 内开始 token_delta
- 不加载完整工具表
- 不进入 DAG
```

### 单工具任务

```
- 不进入 Commander
- 只加载相关 Agent 的工具
- tool_started / tool_finished 可见
- 最终输出支持流式
```

### 复杂任务

```
- 有明确 stage 进度（TASK_STATUS_PROGRESS）
- Commander 不加载无关工具
- 每步有状态反馈
- 失败时显示 userFacingError
```

### Router 可观测

```
- 每次 run 有 RouteLog
- 可查看 routeLevel / score / reasons
- 可统计 L1/L2/L3 命中率
```

---

## 14. 典型链路优化前后对比

### "你好"

| | 优化前 | 优化后 |
|---|---|---|
| 路径 | 中文预处理 → Commander DAG → ReAct → 回复 | Local Router L1 → Direct Chat Stream |
| LLM 调用 | 2-3 次 | 1 次（流式） |
| 可见反馈 | 3-6 秒 | < 0.5 秒 |
| 首 token | 无（blocking complete） | < 1 秒 |

### "总结这个文件"

| | 优化前 | 优化后 |
|---|---|---|
| 路径 | Commander → ReAct → 选工具 → 读文件 → 总结 | Local Router L2 → File Agent → read_file → 流式总结 |
| LLM 调用 | 3+ 次 | 1 次 |
| 进入 Commander | 是 | 否 |
| 加载工具 | 42 个 | ~5 个（File Agent） |

### "分析四个项目并生成架构方案"

| | 优化前 | 优化后 |
|---|---|---|
| 路径 | Commander DAG (不变) | Local Router L3 → Commander DAG |
| LLM 调用 | 多次（不变） | 多次 |
| Commander prompt | ~3000 tokens（42 tools） | ~1500 tokens（仅相关 tools） |
| 进度反馈 | 无（静止） | 每步状态 + 百分比 |

---

## 15. 不做的优化

- **L0 Local Reply** — 砍掉，极短输入走 L1 Direct Chat。原因：硬编码模板回复在相邻消息间造成风格割裂
- **全量 Rust async 改造** — 仅 L1 路径改为 async reqwest，其余模块保持 blocking 不动
- **LLM 路由（用 LLM 判断复杂度）** — 用纯规则 Router，避免为路由引入额外 LLM 调用
- **openhanako 整体架构迁移** — 不改 Javis 的 Tauri + Rust 架构，只调整 Agent 入口逻辑

---

## 16. 总结

**核心改动**：Agent 模式入口从 Commander 改为 Local Router。

**关键原则**：
```
默认对话，按需升级工作流。
让"你好"根本不要见到 Commander。
```

**实施顺序**：
```
PR 1: Immediate UI Feedback（0.5s 反馈）
PR 2: Local Router + RouteLog（L1/L2/L3 分流）
PR 3: Rust async streaming（L1 流式基础设施）
PR 4: Direct Chat Stream（L1 端到端）
PR 5: Commander 工具懒加载（L3 prompt 瘦身）
PR 6: ReAct 按需使用（减少无用 LLM 决策）
```

**一句话**：
```
Javis Agent 模式从"每条消息都是工作流"，升级为
"Conversation-first、Workflow-on-demand" 的智能执行架构。
```
