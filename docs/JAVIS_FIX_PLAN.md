# Javis 修复方案

> 基于 2026-06-06 产品体验走查的 20 项问题，分三阶段修复
> 目标：把 Agent 内部执行能力包装成连续、稳定、可追溯、用户可理解的产品体验
>
> **Phase 1 已完成**（2026-06-07）：6/6 工作流完成，详见下方
> **Phase 2 + Phase 3 待定**：被 Conversation-first 架构优化方案替代
>
> ⚡ **下一目标**：[JAVIS_CONVERSATION_FIRST_ARCHITECTURE.md](JAVIS_CONVERSATION_FIRST_ARCHITECTURE.md)
> 解决 Agent 模式"未响应"和"你好也要 3 次 LLM 调用"的根本问题

---

## 修正说明（基于独立 review）

本版本已修正以下原方案的错误：

- **step.* 事件已存在**：`task-event-bus.ts` 第 37-38 行已定义 `step:started` / `step:completed`，无需新建，只需**连接** `workflow-dag-executor.ts` 回调到 eventBus
- **askUser 不是独立 modal**：实际在 `ChatView.tsx`/`ThreadView.tsx` 中渲染，是渲染层问题而非架构改动
- **持久化不是"缺失"**：SQLite 已就绪，问题是恢复链路 bug（含 WAL checkpoint 时机）
- **2.2 不依赖 1.3**：状态机是纯逻辑，可与时间线并行开发
- **ask-user.ts 已有 `choices` 参数**：扩展时应基于现有字段，而非重复定义

---

## 第一阶段：稳定性 + 可追溯（P0，预计 5–7 天）

> 目标：Javis 能稳定运行，重启后不丢数据，对话流完整可追溯

### 1.1 修复 UI 主线程阻塞（P0-#1）

**问题**：Agent 执行时频繁"未响应"

**修复项**：

| 任务 | 位置 | 方案 |
|---|---|---|
| 日志列表加虚拟滚动 | `ThreadView.tsx` / 活动日志组件 | 已有 `react-window` 依赖，使用 `FixedSizeList` |
| 日志推送节流 | `task-event-bus.ts` | `requestAnimationFrame` 批量合并状态更新 |
| 大段 markdown 异步渲染 | `ChatView.tsx` | `marked.parse()` 放 `requestIdleCallback` 或 Web Worker |
| 文件扫描不阻塞主线程 | `use-scanned-data.ts` | 确认 Tauri invoke 已经是异步，检查是否有同步 await 链 |
| 模型调用确认异步 | `app-runtime.ts` | 检查 `executeWorkflow` 是否真正 release 了 event loop |

**验收标准**：
- 执行复杂任务（5+ 步骤 DAG）时 UI 不卡顿
- 日志列表滚动 60fps
- Windows 任务管理器不显示"未响应"

### 1.2 持久化恢复链路审计与修复（P0-#2, #14）

**问题**：重启后数据不显示。诊断修正 — 非"缺失持久化"，而是恢复链路有 bug。

**已有基础设施**（无需重建）：
- SQLite：`database.rs`，WAL 模式，9 套 migration，忙超时配置
- 持久化模块：`task-history.ts`、`workspace-session.ts`、`recent-workspaces.ts`、`approval-records-persistence.ts`、`scheduled-tasks-persistence.ts`、`jsonl-log-persistence.ts`
- QA 证据：`docs/qa/2026-05-27/` 证实任务历史跨重启可恢复 — 说明**部分**持久化工作正常

**修复项**：

| 任务 | 位置 | 方案 |
|---|---|---|
| **审计**启动恢复链路 | `App.tsx` useEffect 链 | 逐一确认 `workspace-session.load` → `taskHistory.load` → `Sidebar` 恢复是否被调用 |
| SQLite WAL checkpoint 排查 | `database.rs` | 应用退出时应触发 WAL checkpoint，确保写入不丢失；考虑在 `tauri::RunEvent::Exit` 时显式调用 |
| `TaskSnapshot` 字段审计 | `packages/tools/src/types.ts` | 确认对话消息体是否在 `TaskSnapshot` 中持久化 |
| 侧边栏恢复 | `Sidebar.tsx` | 确认 mount 时从持久化存储恢复选中状态和列表 |
| SQLite init loading state | `App.tsx` | 13 组 migration 期间显示加载指示器，而非空白 UI |
| 端到端重启测试 | 新测试文件 | 模拟：写入→"重启"（重新初始化）→读取→验证数据一致 |

**验收标准**：
- 重启应用后，左侧侧边栏显示之前的工作空间和对话
- 选中之前的对话，历史消息完整
- 任务状态正确恢复
- 启动期间有加载指示器

### 1.3 统一对话时间线（P0-#3）

**问题**：追问割裂主对话，提交后不可见。实际表现是在 `ChatView.tsx`/`ThreadView.tsx` 中追问卡片脱离对话流渲染，而非独立 modal。

⚠️ **注意**：此改动是 Phase 1 最高风险项，涉及 4+ 文件的结构性状态管理变更。

**修复项**：

| 任务 | 位置 | 方案 |
|---|---|---|
| 追问卡片内嵌到对话流 | `ChatView.tsx` / `ThreadView.tsx` | 追问作为对话中的特殊消息类型 (`kind: "ask_user_question"`) 内联渲染 |
| 用户回答作为正式消息插入 | `task-history.ts` + `app-runtime.ts` | 用户提交回答后，插入一条消息到当前对话，而非仅更新 task context |
| 回答后保持上下文可见 | `ThreadView.tsx` | 回答提交后滚动到最新消息，追问和回答均保留在时间线中 |
| 明确 ChatMessage 与 ConversationMessage 关系 | `packages/ui/src/types.ts` | 扩展现有 `ChatMessage` 类型增加 `kind`、`parentMessageId` 字段，或在 core 层新增 `ConversationMessage` 并建立映射 |
| 回退追问功能 | `ThreadView.tsx` | 用户可滚动回看之前的追问和回答 |

**验收标准**：
- 追问出现在对话流中，上方可见原始对话
- 用户回答后，回答作为对话消息保留在时间线中
- 整个对话可上下滚动回看

### 1.4 修复 capability 路由失败（P0-#5）

**问题**：`capability: unknown` 导致 ReAct loop。`agent-capability.ts` 已定义了 30 个精确 capability 标签，问题在于 planner 生成的名称与 registry 不匹配。

**修复项**：

| 任务 | 位置 | 方案 |
|---|---|---|
| planner 输出校验 | `commander-plan-schema.ts` | 校验生成的 capability 必须在 registry 中存在 |
| 添加兜底降级 | `workflow-dag-executor.ts` | `unknown` capability 降级为普通 reasoning step |
| capability 名称标准化 | `agent-capability.ts` + Commander prompt | 统一 capability 枚举值和 planner prompt 中的名称 |
| 错误不暴露给用户 | `app-runtime.ts` | `unknown` 映射为用户可读的"正在分析..." |

**验收标准**：
- `capability: unknown` 不再出现
- 无法匹配的步骤降级为普通分析步骤
- planner 生成的步骤全部可执行

### 1.5 任务执行失败时错误恢复（P0-#4）🆕

**问题**：API 调用失败或步骤执行出错时界面空白卡住，无重试或降级。

**修复项**：

| 任务 | 位置 | 方案 |
|---|---|---|
| 失败状态 UI | `ThreadView.tsx` / `ChatView.tsx` | 展示用户可读的错误信息 + 重试按钮 |
| 部分结果降级 | `app-runtime.ts` | LLM 超时时保留已生成的部分结果，不丢弃 |
| 错误信息用户可读化 | `error-localizer.ts` | 已有错误本地化模块，确认其输出被 UI 消费 |

**验收标准**：
- 任务失败时用户看到可理解的错误描述
- 有重试按钮
- 部分结果不丢失

---

## 第二阶段：产品化包装（P1，预计 5–7 天）

> 目标：Javis 用起来像一个产品，而不是调试工具

### 2.1 用户可读渲染层（P1-#6, #12）

**问题**：内部 JSON、event bus、ReAct loop 泄露到 UI。

> 📝 `task-event-bus.ts` 已有 `taskEventToLogEntry` 映射，但产出仍是技术描述。需要**升级该映射**为双层输出（用户文本 + 技术详情），而非新建独立渲染模块。

**修复项**：

| 任务 | 位置 | 方案 |
|---|---|---|
| 升级 `taskEventToLogEntry` | `task-event-bus.ts` | 每个事件产出 `{ userMessage, devDetail }` 双字段 |
| Commander plan → 步骤列表 | `ChatView.tsx` | 解析 plan JSON，渲染为"我会分 N 步处理..." |
| 日志分级显示 | `ThreadView.tsx` / 活动日志组件 | 普通模式只显示 `userMessage`，开发者模式显示 `devDetail` |
| 开发者模式切换 | `ThreadView.tsx` | 设置面板或右键菜单切换，默认普通模式 |
| AgentDetailSections 默认折叠 | `ThreadView.tsx` 中 `commanderExpanded` | 默认 `false`，开发者手动展开 |

**渲染映射表**（升级 `taskEventToLogEntry`）：

| 事件类型 | 用户可见文本 (userMessage) | 技术详情 (devDetail) |
|---|---|---|
| `task.created` | 任务已创建 | `Task event bus recorded task creation` |
| `commander.generating` | 正在生成回复... | `commander is generating output` |
| `step:started` | 正在执行: {stepName} | `Dispatching step via capability: {name}` |
| `step:completed` | {stepName} 完成 | `Step completed in {ms}ms` |
| `react.loop` | （隐藏） | `ReAct loop iteration {n}` |
| `error` | 出错: {userMessage} | 完整 stack trace |

**验收标准**：
- 普通模式下看不到 JSON、event bus、ReAct loop 等内部术语
- Commander 规划展示为清晰的步骤列表
- `commanderExpanded` 默认关闭
- 开发者可切换查看原始日志

### 2.2 统一任务状态机（P1-#8, #10）

**问题**：状态语义混乱，进度永远 0%。

> ⚠️ **修正**：状态机是纯逻辑定义，**不依赖** 1.3 时间线统一。可与 Phase 1 并行开发。

⚠️ 注意：改变状态语义需同步更新 `TaskSnapshot` 类型、`workflow-dag-executor.ts` 和 `use-task-runtime.ts`，遗漏任何消费者都会出现不一致。

**修复项**：

| 任务 | 位置 | 方案 |
|---|---|---|
| 定义统一状态枚举 + 进度 | `packages/tools/src/types.ts` | 6 个状态 + 对应进度百分比 |
| 状态转换规则 + 校验 | `task-event-bus.ts` / `workflow-executor.ts` | 合法转换路径白名单，非法转换 warn |
| 进度自动计算 | `use-task-runtime.ts` | 根据状态映射百分比，不依赖步骤计数 |
| UI 状态标签统一 | `ThreadView.tsx` / `ChatView.tsx` | 单一状态文案来源 |
| 同步 `TaskSnapshot` 消费者 | 全局 grep `status` 字段 | 确保 `workflow-dag-executor.ts`、task-history 等全部更新 |

**统一状态机**：

```
created (10%) → planning (20%)
  → waiting_info (35%)    ← askUser 触发
  → waiting_permission (40%) ← confirmed-write 触发
  → running (50%)           ← 开始执行步骤
  → generating (75%)        ← 生成最终结果
  → completed (100%)
  → failed (显示阶段文案，不显示百分比)
```

**验收标准**：
- 整个应用只有一套状态文案
- 进度随任务推进而更新，不再卡在 0%
- "等待信息" 和 "等待确认" 是不同的视觉状态

### 2.3 执行过程可视化（P1-#11）

**问题**：运行中主区域空白。

> ⚠️ **修正**：`task-event-bus.ts` 第 37-38 行已有 `step:started` / `step:completed` 事件定义。**关键工作是连接 `workflow-dag-executor.ts` 的回调到 eventBus**，而非创建新事件。

**前置调查**：

| 任务 | 位置 | 方案 |
|---|---|---|
| 确认 step.* 事件是否被 emit | `workflow-dag-executor.ts` | grep `step:started` / `step:completed`，检查 executeStep 是否调用了 eventBus |
| 确认 UI 是否监听 step.* 事件 | `ThreadView.tsx` / `ChatView.tsx` | grep `step:started` 看是否有 listener |

**实现项**（如果事件已定义但未连接）：

| 任务 | 位置 | 方案 |
|---|---|---|
| 连接 step 回调到 eventBus | `workflow-dag-executor.ts` | 每个 step 开始/结束时 emit 事件 |
| DAG 步骤进度卡片组件 | **新建** UI 组件 | 展示每个步骤的名称、状态图标、耗时 |
| 步骤卡片列表 | `ThreadView.tsx` | 在对话流中插入可折叠的步骤进度卡片 |

**验收标准**：
- 任务运行时主区域显示步骤卡片而非空白
- 每步状态随执行更新（⏳ / 🔄 / ✅ / ❌）
- 完成后可折叠

### 2.4 统一输入入口（P1-#9）

**问题**：页面同时有多个输入位置。

**修复项**：

| 任务 | 位置 | 方案 |
|---|---|---|
| 移除活动日志中的提交表单 | 活动日志组件 | 日志只读，不含交互 |
| 追问回答入口置入对话流 | `ChatView.tsx` | 追问卡片内含回答输入框 |
| 底部输入框加状态提示 | `NewChat.tsx` | 等待用户补充时显示提示文字，而非禁用 |

**验收标准**：
- 用户能明确知道在哪里回答追问
- 同一时间只有一个活跃输入入口

---

## 第三阶段：交互质量提升（P2，预计 3–5 天）

> 目标：Javis 好用、信息架构清晰

### 3.1 追问选项化（P2-#7）

**问题**：追问只给空输入框。

> 📝 `ask-user.ts` 已有 `CreateAskUserRequest` 通过 `choices?: string[]` 支持选项。扩展时应在现有字段基础上增加结构化选项（label + value + isRecommended），而非新增重复字段。

**修复项**：

| 任务 | 位置 | 方案 |
|---|---|---|
| 扩展 choices 为结构化选项 | `ask-user.ts` + `packages/tools/src/types.ts` | 在 `AskUserQuestionRequest` 中扩展 `choices` 从 `string[]` 到支持 `{label, value, isRecommended}` |
| Commander prompt 强制选项 | prompt templates | 修改 Commander 系统提示词，要求 askUser 时提供 2-4 个选项 |
| 选项 UI 渲染 | `ChatView.tsx` | 选项渲染为可点击按钮 + "其他"自由输入 |
| "帮我决定"兜底 | `ChatView.tsx` | 增加"我不确定，帮我决定"选项，触发 LLM 自动决策 |

**验收标准**：
- 追问显示为可点击选项 + "其他"自由输入
- 推荐选项有视觉区分
- "帮我决定"选项可用

### 3.2 侧边栏信息架构整理（P2-#15, #16）

**问题**：混合了不同层级的内容，标题不可辨认。

> ⚠️ 引入树形结构会改变 `sidebarNavItems` prop 和 `builtin-nav.ts` 系统。需明确新旧导航系统的共存策略。

**修复项**：

| 任务 | 位置 | 方案 |
|---|---|---|
| 清晰的层级分组 | `Sidebar.tsx` | 增加分组渲染模式（树形），保留现有扁平 `sidebarNavItems` 兼容 |
| 与 builtin-nav 交互 | `builtin-nav.ts` | 扩展 `getBuiltinSidebarNavItems` 返回层级结构，或新增 `getBuiltinSidebarTree` |
| 自动生成任务标题 | `task-history.ts` | 从首条用户消息提取前 30 字作为标题 |
| 失败任务移入子页面 | `Sidebar.tsx` | 不在主导航直接暴露，归入"任务历史" |

**信息架构**：

```
📁 工作空间名称
  ├── 📂 项目 A
  │   ├── 💬 对话 1 (前30字标题)
  │   ├── 💬 对话 2
  │   └── 📄 文件
  ├── 📂 项目 B
  └── ⚙️ 设置
📋 任务历史
⏰ 自动任务
📚 知识库
```

### 3.3 杂项修复（P2-#17, #18, #19, #20）

| 问题 | 位置 | 方案 |
|---|---|---|
| 日志时间不正确 (#17) | Rust 命令 + `utils.ts` | 后端 UTC 时间戳 → 前端 `.toLocaleString()` + 悬浮完整时间 |
| 布局空白过大 (#18) | `ThreadView.tsx` / `ChatView.tsx` | 规划/追问卡片最大宽度 720px 居中 |
| 附件静默丢弃 (#19) | `ChatView.tsx` | 超过 5 张时显示提示 "已选择 N 张，最多 5 张，超出部分未添加" |
| 删除无确认 (#20) | `App.tsx` / Sidebar | `deleteHistoryEntry` / `deleteScheduledTask` 加确认对话框 |
| 流式文本闪烁 (#21) | `ThreadView.tsx` `useRenderedStreamingText` | Commander/Verifier 切换时加过渡动效，防止内容重复闪烁 |

---

## 参考设计模式（来自 study/ 项目）

> 5 个参考项目提供了可直接应用于 Javis 修复方案的具体实现模式。

### Proma（主要参考 — Electron + React 桌面 Agent）

Proma 是 Javis 最接近的同类项目，其设计模式直接可迁移：

| Proma 模式 | 文件 | 对应 Javis 问题 | 应用方式 |
|---|---|---|---|
| **AskUserBanner** — 追问内联浮动卡片，选项按钮 + 键盘导航 + "Other"自定义输入 | `study/Proma/.../AskUserBanner.tsx` (460行) | #3 时间线断裂、#7 无选项 | 替代当前 askUser 渲染方式，在 ChatView 对话流中嵌入带选项的内联卡片 |
| **groupIntoTurns()** — 所有消息进入单一时序，user → assistant+tool+progress 自动分组，相邻同模型回合合并 | `study/Proma/.../SDKMessageRenderer.tsx:280` | #3 时间线断裂 | 移植回合分组逻辑到 `ThreadView.tsx`，将 askUser 卡片 + 用户回答并入同一对话序列 |
| **getToolPhrase()** — 每个工具调用映射为 `{label, loadingLabel}` 人类可读短语 | `study/Proma/.../tool-phrase.ts` | #6 JSON 暴露、#12 日志技术化 | 升级 `taskEventToLogEntry` 为双层输出，类似 Proma 的 phrase 映射 |
| **TaskProgressCard** — TaskCreate/Update/TodoWrite 聚合为进度卡片，非原始 JSON | `study/Proma/.../TaskProgressCard.tsx` | #6 JSON 暴露、#11 运行中空白 | 新建 `TaskProgressCard` 组件，替代原始 plan JSON 展示 |
| **ContentBlock** — 子 Agent 输出嵌套在可折叠块内，默认隐藏 | `study/Proma/.../ContentBlock.tsx:397` | #6 JSON 暴露 | Commander plan 步骤默认折叠，用户手动展开看详情 |
| **JSON索引 + JSONL追加流** — 会话元数据 JSON + 消息流 JSONL 追加写 | `study/Proma/.../agent-session-manager.ts` | #2 持久化恢复 | Javis 已有 SQLite，但 JSONL 追加模式可用于消息流的高效写入 |
| **Jotai atomFamily 限制重渲染范围** — 每个 session 独立 atom，流式更新只触发当前 session 重渲染 | `study/Proma/.../agent-atoms.ts:221` | #1 UI 阻塞 | 在 eventBus 消费者中使用 scoped state，避免全局重渲染 |
| **全局监听器防消息丢失** — 监听器挂在 App 根节点，tab 切换不丢流事件 | `study/Proma/.../useGlobalAgentListeners.ts` | #1 UI 阻塞、流式稳定性 | 确认 Javis 的 eventBus listener 在组件卸载时不被移除 |
| **会话指示器状态 dot** — `blocked > running > completed > idle` 优先级 | `study/Proma/.../agent-atoms.ts:513` | #8 状态混乱 | Sidebar 历史项加状态 dot，统一优先级规则 |
| **侧边栏按时间分组** — Today / Yesterday / This Week / Older + 置顶区 | `study/Proma/.../LeftSidebar.tsx` (83KB) | #14 侧边栏混乱、#15 标题截断 | 引入时间分组 + 置顶，替代扁平列表 |
| **Agent orchestrator concurrency guard** — 会话活跃时拒绝新消息 | `study/Proma/.../agent-orchestrator.ts:898` | #1 UI 阻塞 | 在 `app-runtime.ts` 加并发锁，防止重复触发执行 |
| **Fallback 上下文重建** — SDK session resume 失败时从 JSONL 重建上下文 | `study/Proma/.../agent-orchestrator.ts:1633` | #2 持久化恢复、#4 错误恢复 | Javis 任务恢复时如 SQLite 读取失败，回退到 JSONL 日志重建 |

### openhanako（Electron + React 桌面 Agent）

| 模式 | 文件 | 对应 Javis 问题 | 应用方式 |
|---|---|---|---|
| **SessionConfirmationBlock** — 内联确认卡片，含 severity/actions/status，`surface: 'message'` 表示嵌入对话流 | `study/openhanako/.../chat-types.ts:102-120` | #3 时间线、#7 无选项 | askUser 卡片类型定义参考，区分 severity 等级 |
| **ContentBlock 双模式** — TextDecorator (upsert 流式组装) + RichBlock (push 离散事件) | `study/openhanako/.../chat-types.ts` | #20 流式闪烁 | 区分流式 token 和离散事件，避免文本闪烁 |
| **SubAgent block** — 子 Agent 执行嵌入父对话，含 streamStatus | `study/openhanako/.../chat-types.ts:163-177` | #11 运行中空白 | DAG 步骤进度卡片可参考 subagent block 设计 |

### AutoSci（Claude Code 研究流水线）

| 模式 | 文件 | 对应 Javis 问题 | 应用方式 |
|---|---|---|---|
| **YAML 驱动状态机** — 实体生命周期在 YAML 中声明，`loader.py` 程序化校验转换 | `study/AutoSci/runtime/schema/entities.yaml:97-100` | #8 状态混乱 | Javis 状态机可参考：在 `types.ts` 中声明式定义合法转换路径 |
| **Pipeline progress file** — YAML frontmatter + Markdown 日志，跨 session 恢复 | `study/AutoSci/wiki/outputs/pipeline-progress.md` | #2 持久化恢复 | Javis 可加 task-progress snapshot 文件作为 SQLite 的快速恢复缓存 |
| **Fallback chain 错误处理** — TeX→PDF→vision API，失败不丢弃已成功数据 | `study/AutoSci/.../error-handling.md` | #4 错误恢复 | 借鉴 fallback 链模式：LLM 超时→部分结果→用户可见→可重试 |

### javis-agent-workspace-demo（Javis 自己的 UI 蓝图）

| 模式 | 文件 | 对应 Javis 问题 | 应用方式 |
|---|---|---|---|
| **AgentStatus: idle/queued/running/completed/failed** | `study/javis-agent-workspace-demo/src/App.tsx` | #8 状态混乱 | 这是 Javis 已设计的 5 状态模型，修复时应参照此蓝图 |
| **WorkflowStep: pending/running/completed** | 同上 | #10 进度 0%、#11 空白 | DAG 步骤已有三级状态设计 |
| **OrchestrationPanel + AgentRunCard** — SVG 连接线 + 进度条 + 状态 badge | 同上 | #11 运行中空白 | 执行过程可视化的 UI 参考 |

### TG-HELPER（Python PyQt5 Agent）

| 模式 | 文件 | 对应 Javis 问题 | 应用方式 |
|---|---|---|---|
| **confirm_callback lambda** — 每个危险操作注入确认回调，返回 bool | `study/TG-HELPER/.../tools.py:40-42` | #9 输入冲突 | Javis 已有 confirmed-write 流程，可借鉴其注入模式简化权限检查 |
| **stop_event 中断机制** — Agent run loop 每轮检查 `stop_event.is_set()` | `study/TG-HELPER/.../agent.py:501-588` | #1 UI 阻塞 | Javis 已有 `cancel_all_model_streams`，确认其能中断 DAG 执行而不仅是流式输出 |

---

## 执行顺序依赖

```
Phase 1 可并行启动的独立任务：
├── 1.1 UI 阻塞修复（纯前端，可独立）
├── 1.2 持久化审计（Rust + TS，可独立）
├── 1.4 capability 修复（Core + prompt，可独立）
├── 1.5 错误恢复（可独立）
└── 2.2 统一状态机（纯逻辑，可与 Phase 1 并行！）← 修正：不依赖 1.3

Phase 1 依赖：
└── 1.3 统一时间线 → 依赖 1.2（需要持久化机制支撑）

Phase 2 依赖：
├── 2.1 用户可读渲染层 → 依赖 1.3（需要时间线统一后才能改日志显示）
├── 2.3 执行过程可视化 → 依赖 2.2 + 2.1（状态机 + 渲染层就绪后连接）
└── 2.4 统一输入入口 → 依赖 1.3

Phase 3：
├── 3.1 追问选项化 → 依赖 1.3 + 2.4
├── 3.2 侧边栏重构 → 依赖 1.2 + 1.3
└── 3.3 杂项修复 → 可随时修（独立改动）
```

---

## 风险矩阵

| 风险 | 等级 | 原因 | 缓解措施 |
|---|---|---|---|
| 1.3 统一时间线 | 🔴 高 | 跨 4+ 文件状态管理变更，可能破坏对话流 | 先写集成测试锁定当前行为，小步提交 |
| 1.2 WAL checkpoint | 🟡 中高 | 若根因在 Rust 层退出时机，可能需要 Tauri lifecycle 改动 | 先加日志确认写入成功，再排查退出时 WAL 状态 |
| 2.2 状态机同步 | 🟡 中 | `TaskSnapshot` 消费者分散在多处，遗漏会导致不一致 | 全局 grep `status` 字段，列出所有消费者再逐一更新 |
| 3.2 侧边栏重构 | 🟡 中 | 从扁平列表改为树形结构，涉及 `builtin-nav` 兼容 | 保留现有 prop 接口，新增加分组模式 |

---

## 跨阶段测试策略

| 阶段 | 测试类型 | 内容 |
|---|---|---|
| Phase 1 | 集成测试 | 1.2 重启恢复测试、1.3 时间线完整测试、1.4 capability 降级测试 |
| Phase 1 | Rust 测试 | WAL checkpoint 测试、approval 恢复测试 |
| Phase 2 | 单元测试 | 2.1 taskEventToLogEntry 双输出测试、2.2 状态转换合法/非法测试 |
| Phase 2 | 快照测试 | 2.3 步骤卡片渲染、2.1 日志分级渲染 |
| Phase 3 | E2E 测试 | 追问选项化流程、侧边栏树形交互 |
| 全部 | 回归 | `pnpm check` 必须保持绿色（当前 740 tests） |

---

## 不做的优化（明确排除）

- ~~PDF 操作用户体验~~ — 已有完整流程，不在本次范围
- ~~模型设置页重设计~~ — `ModelSettings.tsx` 功能完整
- ~~Streaming 底层重写~~ — SSE 后端已稳定
- ~~权限系统重构~~ — 4 层安全守卫已实现
- ~~暗色模式/主题系统~~ — 需求不明确，P2 之后评估
- ~~离线检测~~ — 桌面应用场景下 API 失败已有错误恢复覆盖

---

## 成功标准

修复完成后：

1. 打开 Javis，看到之前的工作空间和对话历史（1.2）
2. 启动时有加载指示器，不显示空白 UI（1.2）
3. 输入任务，看到人类可读的步骤计划而非 JSON（2.1）
4. Agent 追问时，在对话流中选择选项或自由输入（1.3 + 3.1）
5. 回答后，回答保留在对话时间线中可回看（1.3）
6. 任务执行中看到每步实时进度，进度条随阶段推进（2.2 + 2.3）
7. 任务失败时有重试按钮和可读错误信息（1.5）
8. 软件始终响应，不卡顿（1.1）
9. 重启后一切数据都在（1.2）
10. 普通用户看不到 event bus、ReAct loop、capability 等内部术语（2.1）

---

## Phase 1 完成状态

| 工作流 | 解决问题 | 改动文件 | 状态 |
|---|---|---|---|
| 1.4 Capability 路由 | P0-#5 `capability: unknown` | `workflow-executor.ts` (Map 5→30, dispatch 9→30), `agent-capability.ts` (+ALL_CAPABILITY_TAGS, +isValidCapabilityTag), `commander-plan-schema.ts` (prompt注入, normalizeCommanderPlan删除), `app-runtime.ts` (normalizeCommanderStep验证) | ✅ |
| 1.1 UI 阻塞 | P0-#1 频繁未响应 | `Markdown.tsx` (useDeferredValue) | ✅ |
| 1.2 持久化 | P0-#2 重启数据消失 | `database.rs` (WAL checkpoint), `lib.rs` (exit handler .build().run()), `App.tsx` (ref比较修复) | ✅ |
| 1.5 错误恢复 | P0-#4 失败无提示 | `index.ts` (+userFacingError), `workflow-executor.ts` (+toUserFacingError), `TaskSections.tsx` (展示), `types.ts` (+字段) | ✅ |
| 1.3 对话时间线 | P0-#3 追问割裂 | `index.ts` (respondToAskUser保留答案到conversationMessages) | ✅ |
| 2.2 状态机 | P1-#8/#10 进度0% | `task-state.ts` (+TASK_STATUS_PROGRESS, +getTaskProgress) | ✅ |
| ReAct JSON 兜底 | 你好卡死bug | `app-runtime.ts` (reactDecideNext纯文本→completed fallback) | ✅ |

**质量门**：TypeScript typecheck 全绿 (4/4 packages), Vitest 565 tests 全绿 (240+250+75), Rust cargo check 全绿.

---

## 下一目标

Phase 2 + Phase 3 的 P1/P2 优化被 **Conversation-first 架构优化** 替代。

原因：当前最影响用户体验的不是 UI 细节，而是 Agent 模式的根本架构问题 —
"你好"也要走 Commander DAG → 2-3 次 LLM 调用 → 3-6 秒静止等待 → 体感卡死。

详见 **[JAVIS_CONVERSATION_FIRST_ARCHITECTURE.md](JAVIS_CONVERSATION_FIRST_ARCHITECTURE.md)**：
- Local Router 三级分流（L1 Direct Chat / L2 Single Agent / L3 Commander DAG）
- 6 个 PR 逐步实施（优先 Immediate UI Feedback → Local Router → Rust streaming → Direct Chat）
- 验收指标：简单消息 < 0.5s 反馈 + < 1 次 LLM 调用
