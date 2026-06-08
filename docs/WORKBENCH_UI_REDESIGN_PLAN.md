# Javis 工作台 UI 改造方案

## 1. 背景

本方案面向 `E:\Javis` 下真实的 Javis 工作台，不面向 `study/javis-agent-workspace-demo`。

当前真实 UI 主要入口：

```txt
packages/ui/src/JavisWorkbench.tsx
packages/ui/src/components/ChatView.tsx
packages/ui/src/components/ThreadView.tsx
packages/ui/src/components/InspectorPanel.tsx
packages/ui/src/components/ActivityLog.tsx
apps/desktop/src/App.css
```

这次改造不是新增 demo，而是在现有工作台基础上强化两个区域：

```txt
中央工作区：聊天消息流 + Agent 编排过程
右侧检查器：Agent 图谱 + 运行详情 + 资源状态
```

核心定位：

> 中央工作区负责看流程，右侧检查器负责看细节。

## 2. 当前真实实现盘点

### 2.1 顶层布局

`JavisWorkbench.tsx` 当前负责整体布局：

```txt
JavisWorkbench
├── Sidebar
├── main.javis-main
│   └── ChatView / resource views
├── InspectorPanel
└── ActivityLog
```

它已经维护了和本次改造直接相关的状态：

```ts
const [isActivityOpen, setIsActivityOpen] = useState(...);
const [isInspectorOpen, setIsInspectorOpen] = useState(...);
const [selectedAgentId, setSelectedAgentId] = useState<string | undefined>(undefined);
```

并且已有 Agent 选择链路：

```ts
function handleSelectAgent(agentId: string) {
  setSelectedAgentId(agentId);
  setInspectorOpenState(true);
}
```

这说明中央区和右侧检查器的联动基础已经存在，不需要从零搭建。

### 2.2 中央聊天区

`ChatView.tsx` 根据任务状态切换：

```txt
task.id === "task-idle" -> NewChat
otherwise -> ThreadView
```

`ThreadView.tsx` 是当前中央工作区核心，包含：

```txt
ThreadView
├── thread header
├── conversation messages
├── StreamingMessage
├── AgentOrchestrationPanel
│   ├── task stepper
│   ├── SVG dispatch connector
│   └── agent run grid
├── AgentSummaryList
├── TaskSections
└── ChatComposer
```

当前已经完成的中央区改造：

- 已从 `ThreadView.tsx` 拆出 `AgentOrchestrationPanel.tsx`。
- 中央 Agent run card 已从静态 `article` 改为可点击 `button`。
- 点击中央 Agent card 会复用现有 `onSelectAgent` 链路打开右侧 Inspector。
- 中央 Agent card 会根据 `selectedAgentId` 显示选中态。
- 已加入 `DispatchConnectorSvg`，用普通 React + CSS + SVG 表达 Commander 调度多个 Agent 的视觉结构。

仍需继续增强的点：

- Agent run card 的信息仍偏摘要，只展示名称、状态、任务和进度。
- Agent 的当前步骤、最新事件、产物归属还没有稳定的数据关联。
- `AgentSummaryList` 与 `AgentOrchestrationPanel` 的职责边界需要继续保持清晰：前者展示完成后的总结，后者展示执行中的编排状态。

### 2.3 右侧检查器

`InspectorPanel.tsx` 当前结构大致是：

```txt
InspectorPanel
├── inspector rail
│   ├── Agent Graph
│   └── Details
└── inspector panel
    ├── InspectorQuickActions
    ├── WorkspaceToolPanels
    ├── SelectedAgentDetail
    ├── AgentDetailSections
    ├── TaskOverview
    ├── DetailInspector
    └── AgentResourceCard + task.agents[]
```

它已经能做到：

- 点击 Agent 图谱卡片后进入 details。
- 如果 `selectedAgentId` 存在，显示 `SelectedAgentDetail`。
- 通过 `AgentDetailSections` 展示 plan、documents、commands、code review、research report、sources、desktop logs 等任务详情。
- 显示 CPU、内存和 Agent 完成数量。
- 打开 files、browser、review、terminal、sideChat 等 workspace tool tabs。

当前问题：

- 右侧 rail 只有 `agents/details` 两段，不足以表达“Agent 图谱 / 运行详情 / 资源状态”。
- `SelectedAgentDetail` 主要是 Agent 头部信息，真正详情仍来自全局 `AgentDetailSections`。
- `AgentDetailSections` 展示的是整任务详情，不是选中 Agent 的专属事件、产物和上下文。
- `AgentResourceCard` 位于 agents section 顶部，资源状态还没有独立入口。
- 右侧 `agentProgress()` 目前主要按 status 推导，和真实 step/log 进度关系较弱。

### 2.4 数据模型

当前类型在 `packages/ui/src/types.ts`：

```ts
export interface WorkbenchAgent {
  id: string;
  name: string;
  role: string;
  status: string;
  task: string;
  summaryText?: string;
}

export interface WorkbenchStep {
  id: string;
  title: string;
  status: string;
  successCriteria?: string;
  agentKind?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  errorSummary?: string;
}

export interface WorkbenchLogEntry {
  id: string;
  kind: string;
  title: string;
  detail: string;
  createdAt?: string;
  userMessage?: string;
  devDetail?: string;
}
```

主要缺口不是“没有数据”，而是 Agent 与 step/log/artifact 的关系还不够显式。UI 现在只能靠字符串推断 Agent 类型和日志归属，选中 Agent 后无法稳定过滤到该 Agent 的事件和产物。

## 3. 改造目标

改造后的用户体验：

```txt
用户提交任务
-> 中央消息流显示 Commander 响应
-> 中央出现 Agent 编排面板
-> 用户看到任务拆解、调度、并行执行、结果汇聚
-> 点击任意 Agent
-> 右侧打开该 Agent 的运行详情
-> 底部 ActivityLog 保留全局事件流
```

目标产品感：

> Javis 不只是聊天界面，而是一个能展示任务拆解、Agent 调度、执行进度、运行详情和资源状态的多 Agent 工作台。

## 4. 中央工作区方案

### 4.1 AgentOrchestrationPanel

已完成：

```txt
packages/ui/src/components/AgentOrchestrationPanel.tsx
```

组件结构：

```txt
AgentOrchestrationPanel
├── progress header
├── progress track
├── WorkflowStepper
├── DispatchConnectorSvg
├── AgentRunGrid
└── StepDetailList
```

保留的主要 class：

```txt
javis-task-progress-card
javis-task-stepper
javis-agent-run-grid
javis-agent-run-card
javis-task-step-list
```

新增或强化的 class：

```txt
javis-agent-run-stage
javis-dispatch-lines
javis-agent-run-card.active
```

样式入口是：

```txt
apps/desktop/src/App.css
```

注意：`packages/ui/src/index.tsx` 只是 UI package 的 export 入口，不是当前工作台样式入口。

### 4.2 中央 Agent 卡片选择

已完成：

```tsx
<button
  aria-pressed={selectedAgentId === agent.id}
  className={`javis-agent-run-card status-${agent.status}${selectedAgentId === agent.id ? " active" : ""}`}
  onClick={() => onSelectAgent?.(agent.id)}
  type="button"
>
  ...
</button>
```

效果：

- 用户不需要等 Agent 完成后再从 `AgentSummaryList` 打开详情。
- 运行中的 Agent 也能点击打开右侧检查器。
- 中央 run card 与右侧 Agent graph card 的选中态可以同步。

### 4.3 SVG 调度连线

已完成：

```txt
DispatchConnectorSvg
```

实现原则：

- 不引入 React Flow。
- 不做复杂画布。
- SVG 只负责静态虚线连接。
- 移动端窄宽度下隐藏，避免挤压卡片内容。

样式位于：

```txt
apps/desktop/src/App.css
```

关键选择器：

```css
.javis-dispatch-lines
.javis-dispatch-lines path
```

### 4.4 中央区层级边界

中央工作区建议稳定为三层：

```txt
聊天层：UserMessage / AssistantMessage / StreamingMessage
编排层：AgentOrchestrationPanel
产物层：ArtifactCards / AgentSummaryList / ContextStats
```

职责边界：

- `AgentOrchestrationPanel` 展示“正在如何执行”。
- `AgentSummaryList` 展示“Agent 完成后产出了什么总结”。
- `ArtifactCards` 展示“可以打开或检查的产物”。
- `ActivityLog` 展示“完整事件流”。

## 5. 右侧检查器方案

### 5.1 从两段 rail 扩展为三类内容

当前：

```txt
Agent Graph
Details
```

目标：

```txt
Agent 图谱
运行详情
资源状态
```

建议状态：

```ts
type InspectorSection = "agents" | "details" | "resources";
```

短期可以先保留现有 rail 样式，只增强内容分区；中期再把 `activeSection` 扩展为三段。

### 5.2 拆分 InspectorPanel

`InspectorPanel.tsx` 当前职责偏多。建议第一阶段只做内部组件拆分，不改变外部 props：

```txt
packages/ui/src/components/inspector/
├── InspectorRail.tsx
├── AgentGraphPanel.tsx
├── AgentDetailPanel.tsx
├── ResourceStatusPanel.tsx
├── InspectorQuickActions.tsx
└── DetailInspector.tsx
```

迁移关系：

```txt
AgentResourceCard      -> ResourceStatusPanel
SelectedAgentDetail    -> AgentDetailPanel header
TaskOverview           -> TaskOverviewPanel
DetailInspector        -> DetailInspector.tsx
InspectorQuickActions  -> InspectorQuickActions.tsx
task.agents map        -> AgentGraphPanel
```

验收重点：

- Agent 图谱仍能展示全部 agents。
- 选中 Agent 后右侧仍自动进入详情。
- Workspace tool tabs 不回退。

### 5.3 Agent 详情按选中 Agent 过滤

当前逻辑只找到 Agent 本体：

```tsx
task.agents.find((agent) => agent.id === selectedAgentId)
```

后续应新增 UI selector：

```ts
function buildAgentDetailViewModel(task: WorkbenchTask, agentId: string) {
  const agent = task.agents.find((item) => item.id === agentId);
  if (!agent) {
    return { agent: null, steps: [], logs: [], artifacts: [] };
  }

  const steps = task.plan.filter((step) => step.agentKind === inferAgentKind(agent));
  const logs = task.logs.filter((log) => isLogRelatedToAgent(log, agent));
  const artifacts = buildArtifactsForAgent(task, agent);

  return { agent, steps, logs, artifacts };
}
```

短期可以继续使用字符串推断；长期应由真实任务事件生产方写入显式字段：

```ts
agentId?: string;
stepId?: string;
```

`selectedAgentId` 可能来自历史任务、任务切换前的旧状态或已关闭的 Inspector 状态。selector 必须处理找不到 Agent 的情况，不能假设 `task.agents.find(...)` 一定有结果。找不到时应回退到 `TaskOverview` 或清空 selection。

### 5.4 资源状态独立化

当前资源状态位于 Agent 图谱区顶部。建议升级为：

```txt
ResourceStatusPanel
├── CPU
├── Memory
├── Token usage
├── Model calls
├── Wall time
├── Completed agents
└── Log entries
```

可读取的数据：

```txt
systemResources
task.tokenUsage
task.executionTrace
task.agents
task.logs
```

资源状态不应占据中央主视觉，更适合放在右侧第三 section 或右侧底部摘要。

## 6. ActivityLog 定位

`ActivityLog.tsx` 已经使用 `react-window`，适合继续作为全局事件流。

建议保持定位：

```txt
底部 ActivityLog = 全局事件流
右侧 AgentDetailPanel = 选中 Agent 的过滤事件流
中央 AgentOrchestrationPanel = 摘要化执行进度
```

不要把底部日志搬进中央，也不要让右侧详情默认显示全部日志。

## 7. 数据模型建议

建议增量扩展类型，不破坏现有数据：

```ts
export interface WorkbenchAgent {
  id: string;
  name: string;
  role: string;
  status: string;
  task: string;
  summaryText?: string;
  kind?: string;
  currentStepId?: string;
  progressPercent?: number;
  lastEventId?: string;
}

export interface WorkbenchStep {
  id: string;
  title: string;
  status: string;
  successCriteria?: string;
  agentKind?: string;
  agentId?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  errorSummary?: string;
}

export interface WorkbenchLogEntry {
  id: string;
  kind: string;
  title: string;
  detail: string;
  createdAt?: string;
  userMessage?: string;
  devDetail?: string;
  agentId?: string;
  stepId?: string;
}
```

注意：只改 `packages/ui/src/types.ts` 不算完成数据模型阶段。`agentId` 和 `stepId` 必须由真实任务事件生产方写入，至少需要覆盖：

```txt
1. core executor 生成 plan/step 状态更新的位置
2. desktop bridge 将 task/log/trace 传给 UI 的位置
3. ActivityLog 当前读取 task.logs 的数据来源
```

UI selector 的读取规则：

```txt
优先使用 step.agentId / log.agentId / log.stepId
没有显式字段时，再 fallback 到现有字符串推断
找不到 selectedAgentId 对应 Agent 时，回退到 TaskOverview 或清空 selection
```

## 8. 实施步骤

### Phase 1：整理中央编排组件

状态：已完成。

目标：

- 从 `ThreadView.tsx` 拆出 `AgentOrchestrationPanel`。
- 保留原 TaskProgressCard 行为和样式语义。
- 中央 Agent run card 增加点击选中。
- `selectedAgentId` 高亮中央卡片。

涉及文件：

```txt
packages/ui/src/components/ThreadView.tsx
packages/ui/src/components/AgentOrchestrationPanel.tsx
packages/ui/src/index.test.tsx
apps/desktop/src/App.css
```

验收：

- `pnpm --filter @javis/ui test` 通过。
- `pnpm --filter @javis/ui typecheck` 通过。
- 点击中央 Agent card 后右侧检查器打开对应详情。
- 切换任务后，过期 `selectedAgentId` 不会导致详情空引用或错误详情。

### Phase 2：增加 SVG 调度连线

状态：已完成。

目标：

- 在 `AgentOrchestrationPanel` 中加入 `DispatchConnectorSvg`。
- 保持普通 React/CSS/SVG 实现。
- 在窄宽度下隐藏或简化。

涉及文件：

```txt
packages/ui/src/components/AgentOrchestrationPanel.tsx
apps/desktop/src/App.css
packages/ui/src/index.test.tsx
```

验收：

- 中央执行卡显示 Commander 调度多个 Agent 的视觉结构。
- 不影响 stepper 和 agent card 的可读性。
- 测试覆盖 `javis-dispatch-lines` 和 `dispatch-connector-svg`。

### Phase 3：拆分右侧检查器

状态：已完成第一阶段。

目标：

- 将 `InspectorPanel.tsx` 拆成更小组件。
- 不改变外部 props。
- 增强 `SelectedAgentDetail` 为更完整的 `AgentDetailPanel`。

建议文件：

```txt
packages/ui/src/components/InspectorPanel.tsx
packages/ui/src/components/inspector/AgentGraphPanel.tsx
packages/ui/src/components/inspector/AgentDetailPanel.tsx
packages/ui/src/components/inspector/ResourceStatusPanel.tsx
packages/ui/src/components/inspector/inspector-utils.ts
```

验收：

- Agent 图谱仍能展示全部 agents。
- 选中 Agent 后右侧自动进入详情。
- Workspace tool tabs 功能不回退。
- 右侧 rail 已扩展为 Agent 图谱、运行详情、资源状态三段。
- `AgentGraphPanel` 已升级为 Commander 根节点 + SVG 调度线 + Agent 节点列表。

### Phase 4：Agent 详情过滤

状态：已完成第一阶段。

目标：

- 右侧详情按 `selectedAgentId` 过滤 step、log、artifact。
- 没有显式 `agentId` 时先使用现有字符串推断。
- 将过滤逻辑封装为 selector。

建议文件：

```txt
packages/ui/src/components/inspector/agent-detail-model.ts
```

验收：

- 点击 Code Agent，只看到与代码相关的 step/log/artifact。
- 点击 Research Agent，只看到 research report、sources、相关 logs。
- 点击 Computer Agent，只看到 desktop/computer 相关 logs。
- ActivityLog 仍保留全局日志，不被 `selectedAgentId` 过滤。
- 当前实现已新增 `buildAgentDetailViewModel()`，优先读取未来可接入的 `agentId` / `stepId`，没有显式字段时 fallback 到 `agentKind`、Agent 名称、角色和任务文本推断。
- 当前实现已让 `AgentDetailPanel` 展示选中 Agent 的当前步骤、相关步骤、相关事件和相关产物，不再直接把整任务全局详情铺到选中 Agent 详情里。
- 当前实现已在 `AgentDetailPanel` 中加入快捷工具入口，可从选中 Agent 详情直接打开 files、terminal、browser、review、sideChat 等右侧工具。

### Phase 5：数据模型补链

状态：已完成第一阶段。

目标：

- 给 `WorkbenchStep`、`WorkbenchLogEntry` 增加可选 `agentId` / `stepId`。
- 后端任务事件逐步写入这些字段。
- UI selector 优先使用显式字段，fallback 到字符串推断。

涉及范围：

```txt
packages/ui/src/types.ts
packages/core/src/*
apps/desktop/src-tauri/src/*
```

当前已落地：

```txt
packages/ui/src/types.ts
packages/core/src/index.ts
packages/core/src/task-event-bus.ts
packages/core/src/workflow-executor.ts
apps/desktop/src/task-history.ts
```

实现状态：

- `WorkbenchStep` / `TaskStep` 已支持可选 `agentId`。
- `WorkbenchLogEntry` / `TaskLogEntry` 已支持可选 `agentId` / `stepId`。
- `TaskRuntimeEvent` 的 step 事件已支持可选 `agentKind` / `agentId`。
- `taskEventToLogEntry()` 已为 Agent 事件写入 `agentId`，为 step 事件写入 `stepId`，并在事件提供 Agent 信息时同步写入 `agentId`。
- Commander DAG plan 和 recovery plan 已为每个 step 写入 `agentId`。
- desktop history sanitizer 已允许这些显式归属字段被持久化。
- UI `buildAgentDetailViewModel()` 已优先使用显式字段，再 fallback 到字符串推断。

验收：

- 新任务能稳定把 step/log 归属到具体 Agent。
- 旧任务数据仍然能展示。
- 能在实际任务数据中看到 `agentId` 或 `stepId`，而不只是 UI 类型声明里有字段。

## 9. 测试计划

当前已覆盖：

```txt
1. 渲染中央 Agent 编排进度与 Agent cards
2. 渲染 SVG 调度连线
3. 点击中央 Agent run card 后打开右侧 Inspector details
4. 中央 run card 与右侧 graph card 选中态同步
5. stale selectedAgentId 不会导致错误详情
6. ActivityLog 继续作为虚拟列表渲染
```

后续建议补充：

```txt
1. 右侧 ResourceStatusPanel 显示 CPU、Memory、Token、Wall time
2. AgentDetailPanel 只展示选中 Agent 的相关事件
3. ActivityLog 不被 selectedAgentId 过滤
4. Inspector 三段 rail 的切换行为
5. 桌面端视觉回归截图
```

## 10. 设计约束

- 不把中央编排区做成复杂画布。
- 不引入 React Flow。
- 保留当前 ActivityLog 的虚拟列表优势。
- 不让右侧检查器重复中央卡片信息。
- 不把资源状态放到中央主视觉里。
- 不一次性重构整个 `JavisWorkbench`。
- 不破坏已有 workspace tool tabs：files、sideChat、browser、review、terminal。

## 11. 最终形态

中央区：

```txt
用户消息
-> Commander 消息 / streaming
-> AgentOrchestrationPanel
   接收任务 -> 任务拆解 -> 调度代理 -> 并行执行 -> 结果汇聚 -> 综合输出

              -> File Agent   Shell Agent   Research Agent   Computer Agent
                 completed    running       waiting          waiting
                 100%         68%           0%               0%
-> ArtifactCards / AgentSummaryList / ContextStats
-> Composer
```

右侧检查器：

```txt
Agent 图谱
├── Commander
├── File Agent
├── Shell Agent
├── Research Agent
└── Computer Agent

运行详情
├── 当前 Agent
├── 当前步骤
├── 相关事件
├── 相关产物
└── 快捷工具

资源状态
├── CPU / Memory
├── Token usage
├── Wall time
├── Agent 完成数
└── Log entries
```
