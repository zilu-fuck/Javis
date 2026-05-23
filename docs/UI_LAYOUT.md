# 桌面布局设计

## 设计方向

Javis 的桌面布局参考 Codex 的工作台体验：用户始终围绕一个任务线程工作，同时能看到上下文、执行过程、工具输出和需要确认的动作。

这里的“参考 Codex”指信息架构和交互节奏，不是逐像素复刻视觉样式。

## 布局目标

第一版 UI 要解决四件事：

1. 用户能自然输入目标和继续追问。
2. 用户能看到 Javis 正在让哪些 Agent 工作。
3. 用户能看到工具调用、日志、结果和验证状态。
4. 用户能在高风险动作前批准、拒绝或中止。

## 主布局

桌面端采用三栏加底部状态区：

```text
┌──────────────┬──────────────────────────────┬──────────────────────┐
│ Sidebar      │ Main Thread                  │ Agent / Context      │
│              │                              │ Inspector            │
│ Projects     │ Conversation                 │                      │
│ Tasks        │ Task Cards                   │ Agent Graph          │
│ History      │ Results                      │ Selected Agent       │
│ Settings     │ Composer                     │ Tool Context         │
├──────────────┴──────────────────────────────┴──────────────────────┤
│ Activity / Logs / Confirmations                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### Sidebar

Sidebar 用来放长期导航，不承载复杂操作。

内容：

- 当前工作区。
- 最近任务。
- 常用项目。
- Agent 配置入口。
- 模型和工具设置入口。

第一版可以只做工作区、任务历史和设置入口。

### Main Thread

Main Thread 是用户主要工作区，类似 Codex 的任务线程。

内容：

- 用户输入。
- Commander 回复。
- 任务计划。
- 阶段性结果。
- 最终报告。
- 需要用户处理的确认卡片。

Main Thread 应保持叙事连续，让用户能从上到下理解 Javis 做了什么。

### Agent / Context Inspector

右侧区域展示当前任务的结构和上下文。

内容：

- Agent Graph：展示 Commander、Worker、Verifier 的状态。
- Selected Agent：展示当前选中 Agent 的角色、模型、任务和输出。
- Tool Context：展示当前工具权限、工作目录、引用来源。
- Verification：展示 Verifier 的检查结果。

第一版 Agent Graph 可以先是只读状态图，不急着做可编辑编排。

### Activity / Logs / Confirmations

底部区域展示执行过程，适合放高频变化的信息。

内容：

- 工具调用日志。
- 命令输出。
- 文件操作 dry-run。
- 需要确认的动作。
- 错误和重试记录。

底部区域可以折叠，但有待确认动作时必须明显提示。

## 关键交互

### 任务开始

用户在 Main Thread 输入目标后：

1. Main Thread 显示 Commander 的理解和计划。
2. 右侧 Agent Graph 出现参与任务的 Agent。
3. 底部 Activity 显示工具调用和日志。

### Agent 执行

每个 Agent 应有清晰状态：

- Idle：空闲。
- Planning：规划中。
- Running：执行中。
- Waiting：等待用户或其他 Agent。
- Verifying：验证中。
- Done：完成。
- Failed：失败。

状态变化要能在 Agent Graph 和 Activity 中同时看见。

### 用户确认

高风险动作必须以确认卡片出现。

确认卡片应包含：

- 将要执行什么。
- 会影响哪些文件、命令或应用。
- 风险等级。
- dry-run 结果。
- 批准、拒绝、中止按钮。

## 第一版范围

第一版只需要实现：

- 左侧基础 Sidebar。
- 中间 Main Thread。
- 右侧只读 Agent 状态面板。
- 底部 Activity 日志。
- 确认卡片。

暂不实现：

- 可拖拽编辑的 Agent 图。
- 多窗口布局。
- 复杂主题系统。
- 插件市场 UI。
- 跨设备控制面板。

## 视觉原则

- 信息密度接近开发工具，而不是营销页面。
- 操作区要稳定，不因日志或长文本突然改变布局。
- 主要按钮用于明确命令，Agent 状态更多使用图标、颜色和短标签。
- 高风险动作使用明显但克制的提示。
- 不把工具日志、确认卡片和结果报告混在同一个视觉层级里。

## 后续升级

后续可以逐步加入：

- React Flow 驱动的可编辑 Agent Graph。
- 可保存的工作区布局。
- 任务回放。
- Agent 性能和成本统计。
- 模型路由可视化。
