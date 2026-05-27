# 2026-05-28 项目全景分析 & 任务计划调整建议

## 一、当前项目状态

### 1.1 已完成（MVP+ 基线）

```
277 测试全绿 (203 TypeScript + 74 Rust)
├── 桌面端 (Tauri + React + Vite, Windows MSI/NSIS)
├── 流式输出 (Rust SSE → Tauri events → AsyncGenerator → DeltaReducer → UI)
├── 中文优化全链路 (预处理 → 术语注入 → 审查 → 错误本地化)
├── SQLite 持久化 (模型配置 / 任务历史 / 审批记录 / 工作区)
├── 多 Agent 工作流 (Commander → File/Shell/Code → Verifier)
├── DAG 并行执行器 (Promise.all 就绪但未利用)
├── 审批安全模型 (confirmed-write 四步守卫)
├── Code Agent (opencode + direct HTTP API fallback)
└── 代码审查 / PDF 整理 / Web 搜索 / 项目管理
```

### 1.2 今天已做的改动（未提交）

| 类别 | 改动 | 文件 |
|------|------|------|
| Bug 修复 | 流式输出竞态条件（Rust 线程与 JS listener 竞态） | `model-provider.ts`, `streaming.rs` |
| Bug 修复 | 流式输出不自动终止（finalText === targetText 死锁） | `ThreadView.tsx:useRenderedStreamingText` |
| Bug 修复 | 每次对话闪现 NewChat（isNewChat 无法区分 idle 和新任务） | `ChatView.tsx` |
| Bug 修复 | 点击历史预填旧 goal（改为清空） | `App.tsx:selectHistoryEntry` |
| 功能 | 回车发送 / Shift+回车换行 | `ChatComposer.tsx` |
| 功能 | 停止按钮（发送按钮 toggle 为停止） | `ChatComposer.tsx`, `ThreadView.tsx` |
| P0-1 | ModelSettings 多模型配置 UI（3 slot 面板） | `ModelSettings.tsx` |
| P0-1 | modelConfiguration 状态 + SQLite 持久化 + API key 管理 | `App.tsx` |
| P0-1 | Sidebar Settings 入口 | `Sidebar.tsx` |

### 1.3 工作树中的 17 个变更文件

```
apps/desktop/src-tauri/src/streaming.rs       — 接受可选 stream_id
apps/desktop/src/App.css                      — CSS 变更（部分清理）
apps/desktop/src/App.tsx                      — modelConfig + stopTask + selectHistory 修复
apps/desktop/src/app-runtime.ts               — stopTask() + streaming 事件修复
apps/desktop/src/model-profile-persistence.ts — 小修复
apps/desktop/src/model-provider.test.ts       — 适配新调用顺序
apps/desktop/src/model-provider.ts            — 竞态修复：先生成 streamId 再注册 listener
packages/ui/src/JavisWorkbench.tsx            — onStopTask 传递
packages/ui/src/components/ChatComposer.tsx   — Enter/Shift+Enter + stop/send toggle
packages/ui/src/components/ChatView.tsx       — isNewChat = task.id === "task-idle"
packages/ui/src/components/ModelSettings.tsx  — 多模型配置面板（175 行新增）
packages/ui/src/components/Sidebar.tsx        — Settings 面板重构（268 行变更）
packages/ui/src/components/ThreadView.tsx     — 流式死锁修复 + onStopTask
packages/ui/src/index.test.tsx                — 测试适配
packages/ui/src/locale.ts                     — stopTask 标签（中/英）
packages/ui/src/types.ts                      — stopTask / onStopTask 类型
packages/ui/src/utils.ts                      — 小修复
```

---

## 二、核心架构差距：Agent 模型

### 2.1 关键发现

Javis 具备了多 Agent 平台的所有**骨架**——DAG 执行器、事件总线、共享上下文、流式输出、审批系统——但 Agent 模型本身是**写死在源码里**的。

| 维度 | 现状 | 目标状态（专家团可插拔） |
|------|------|--------------------------|
| Agent 定义 | `demoAgents` 数组，10 种固定 `AgentKind` | 可注册的能力标签系统 |
| 步骤分配 | workflow 步骤写死 `agentKind: "code"` | 声明 `requiredCapabilities: ["git_diff"]` |
| 步骤调度 | `switch(step.id)` 硬编码到具体函数 | Registry 按能力标签动态匹配 |
| 模型选择 | `DEFAULT_AGENT_SLOT` 静态映射 | 每个 Agent 声明 `modelRequirements` |
| 新 Agent 接入 | 改 4+ 文件、重新编译 | 配置声明 → 热加载 |

### 2.2 矛盾的焦点

`ModelProfile.capabilities`（`vision`, `code`, `longContext`）从类型定义 → SQLite schema → UI 表单 → App.tsx 整个链路都通了，但**全代码库没有一处读它来做调度决策**。它是为未来预留的字段，但"未来"需要现在就规划。

### 2.3 路线图

```
第一步（今天做）：并行化现有 Agent
  拆掉 read-current-project workflow 的人工依赖链
  → scan-files / inspect-project / analyze-code 三者并行
  → 验证 DAG 并行能力，用户体验"多个 Agent 同时工作"

第二步（核心抽象）：Agent Capability 模型
  在 packages/core/src/ 新建 agent-capability.ts
  引入 AgentRegistration { capabilities, modelRequirements }
  把 demoAgents 迁移到 Registry
  把 ModelProfile.capabilities 真正用于模型选择

第三步（调度改造）：按能力匹配
  工作流步骤改为声明 requiredCapabilities
  Commander 输出 capability tags 替代 assignedAgentKind
  executeStep 改为 Registry.find(tags) → 动态调用

第四步（热插拔）：配置驱动
  Agent 从 JSON/YAML 配置加载
  agentRegistry.register() 在启动时批量导入
```

---

## 三、05-28 任务计划审视

### 3.1 已完成或接近完成

| # | 任务 | 状态 | 说明 |
|---|------|------|------|
| P0-1 | Model Profile 完善 | **90%** | Settings UI 面板已写完，SQLite 持久化已通，API key 管理已接。剩余：agent override UI + 边界情况测试 |
| - | 流式 Bug 修复 | **100%** | 竞态 + 死锁 + isNewChat + 回车发送 全修完，测试全绿 |
| P1-2 | 构建文档 | **0%** | 未开始 |

### 3.2 P0-1 剩余工作

P0-1 的 Settings UI 已有 175 行新增代码。剩余：

1. **Agent Override UI**: 目前 `agentOverrides` 状态已管理但 Settings 面板中尚无 Agent → Profile 的下拉选择
2. **ModelSettings 测试**: `ModelSettings.tsx` 新增代码无测试覆盖
3. **保存反馈**: 保存后无 toast/确认提示
4. **Provider 列表**: 目前硬编码，应从已知 provider 列表动态生成

### 3.3 任务优先级调整建议

**核心判断**：P0-2（AI 文件分类）和 P0-3（中文 RAG）依赖 P0-1 完成才能开始（需要 secondary slot 来调分类/embedding 模型），但 P0-1 的 UI 核心路径已就绪，可以并行推进。同时，**Agent Capability 模型应该被提升为一个显式任务**，因为它是连接 P0-1（ModelProfile.capabilities）和 P1-1（ProviderAdapter）的桥梁——没有它，这两个任务都只能做到一半。

```
原来：
  P0-1 → P0-2 + P0-3 → P1-1 → P1-2 + P1-3

建议：
  P0-1 收尾 + P1-2 文档 + Agent 并行化（可并行）
    ↓
  P0-2 + P0-3（仍然按原计划，不阻塞）
    ↓
  【新增 P0-4】Agent Capability 模型
    ↓
  P1-1 ProviderAdapter（受益于 Capability 模型）
    ↓
  P1-3 用户偏好
```

---

## 四、推荐今天完成的事情

### 第一优先级（今天必须做）

| # | 任务 | 预估 | 理由 |
|---|------|------|------|
| 1 | **提交当前 17 个文件的改动** | 15min | 目前全是 uncommitted，容易搞混。按功能拆成 2-3 个 commit |
| 2 | **P0-1 收尾**：Agent Override UI + 保存反馈 | 1h | Model Profile 面板就能用了 |
| 3 | **Agent 并行化**：拆 workflow 依赖，三步并行 | 1h | 验证 DAG 能力，给 P0-4 铺路 |
| 4 | **P1-2**：构建/签名/回滚文档 | 1h | 独立任务，不阻塞其他 |

### 第二优先级（时间允许）

| # | 任务 | 预估 | 理由 |
|---|------|------|------|
| 5 | **P0-2**：AI 文件分类核心（classifyDocuments） | 2h | 依赖 P0-1 的 secondary slot |
| 6 | **P0-3**：中文 RAG 最小可用 | 2h | 需要 @mention UI + read_file_chunk |

### 第三优先级（设计先行，代码延后）

| # | 任务 | 预估 | 理由 |
|---|------|------|------|
| 7 | **【新】Agent Capability 模型设计文档** | 1h | 写清楚接口和迁移路径，代码明天做 |

---

## 五、具体改动建议

### 5.1 当前改动先提交

17 个文件混在一起，建议拆成 3 个 commit：

```
Commit 1: "fix: streaming race condition, auto-termination deadlock, and isNewChat flash"
  streaming.rs, model-provider.ts, model-provider.test.ts,
  ThreadView.tsx, ChatView.tsx, App.tsx (selectHistory + stopTask),
  app-runtime.ts (stopTask), JavisWorkbench.tsx, ChatComposer.tsx,
  locale.ts, types.ts, index.test.tsx

Commit 2: "feat: model profile multi-slot settings panel with SQLite persistence"
  ModelSettings.tsx, App.tsx (modelConfiguration), Sidebar.tsx,
  model-profile-persistence.ts, utils.ts

Commit 3: "style: cleanup dead CSS and adjust composer layout"
  App.css
```

### 5.2 P0-1 Model Profile 收尾

- `ModelSettings.tsx`: 每个 slot 下方加 Agent Override 下拉选择（`KNOWN_AGENT_KINDS` → profile 选择）
- `App.tsx`: `onModelConfigurationChange` 调用后加 toast（简洁的成功/失败提示）
- `model-settings.ts`: `DEFAULT_AGENT_SLOT` 加上注释说明何时会被 override 替换

### 5.3 Agent 并行化

按之前已批准的方案执行：
- `workflows.ts`: 拆掉 scan-files/inspect-project/analyze-code 之间的依赖
- `workflow-executor.ts`: 重构 runAnalyzeCodeStep（移除 contextSnapshot），增强 runSummarizeProjectStep
- 测试适配

### 5.4 Agent Capability 模型（设计文档）

新的 P0-4 任务，输出到 `docs/2026-05-29_AGENT_CAPABILITY_PLAN.md`：

```typescript
// 核心接口草稿
interface AgentCapability {
  tags: string[];  // e.g., ["file_scan", "git_diff", "json_parse"]
}

interface AgentRegistration {
  id: string;
  capabilities: AgentCapability;
  modelRequirements: {
    prefersCodeModel: boolean;
    prefersVision: boolean;
    minContextTokens?: number;
  };
  execute(input: unknown, context: SharedTaskContext): Promise<unknown>;
}

const agentRegistry = new Map<string, AgentRegistration>();
```

关键设计问题：
1. 现有 9 个 agent 的 capabilities.tags 怎么定义？
2. Commander 的 prompt 怎么改让它输出 capability tags 而不是 agent kind？
3. executeStep 怎么从 switch(step.id) 改成 registry.find(tags)？
4. 向后兼容：现有 workflow 怎么平滑迁移？

---

## 六、不做的事

| 事项 | 原因 |
|------|------|
| 热插拔/动态注册 | 需要先有 Capability 模型，本末倒置 |
| 多任务并行 | 单任务模型还在完善 |
| 向量数据库 | 明确 defer，P0-3 用纯 prompt 注入 |
| Pi Agent 替换 opencode | 已有决策文档，不换 |
| 大规模重构 | 当前架构足够支撑 P0 任务 |
