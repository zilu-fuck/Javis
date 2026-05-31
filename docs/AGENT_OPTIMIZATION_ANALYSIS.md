# Agent Optimization Analysis — 2026-05-30

## Overview

全面审计 Javis 项目中 10 个 Agent 的定义、能力模型、工具分配、工作流集成情况。
识别出 13 个具体问题，按严重程度分为 P0（阻塞功能）、P1（架构偏离）、P2（维护性）、P3（改进建议）四个级别。

---

## 1. 逐个 Agent 深度分析

### 1.1 Commander (`agent-commander`)

| 维度 | 现状 |
|------|------|
| 工具 | `commander.plan` |
| 能力标签 | `planning`, `synthesis` |
| 上下文 | 16K tokens |
| 参与工作流 | 全部 7 个（作为 coordinator） |

**发现的问题**：

- `allowedToolNames` 只有 `commander.plan`，但 Commander 实际执行 `synthesize()` 方法。
  `commander.synthesize` 既不在 allowedToolNames 中，也没有对应的 tool descriptor。
  这意味着合成操作在审计日志和工具追踪中不可见。

- `safePlanWorkflow()` 中传入的 `availableAgents` 列表硬编码为 5 个 Agent
  （commander/file/shell/code/verifier），缺少 browser/computer/scheduler/research/chinese-reviewer。
  导致 Commander 规划阶段无法感知这些 Agent 的能力。
  详见 §2.1。

- systemPrompt 强调 "never execute write actions yourself"，但 Commander 本身没有
  写操作工具，该指令在当前上下文中无意义。应改为 "never hallucinate tool outputs"。

**修复方向**：
1. 添加 `commander.synthesize` 工具描述符并加入 `allowedToolNames`
2. 将 `safePlanWorkflow` 的 availableAgents 改为从 AgentRegistry 动态获取
3. 优化 systemPrompt，去掉不适用的安全声明

---

### 1.2 File Agent (`agent-file`)

| 维度 | 现状 |
|------|------|
| 工具 | `file.scanMarkdownDocuments`, `file.scanUserDocuments`, `file.classifyDocuments` |
| 能力标签 | `file_scan`, `document_classify` |
| 上下文 | 8K tokens |
| 参与工作流 | `read-current-project`, `find-local-document` |

**发现的问题**：

- PDF 整理工具 (`file.planPdfOrganization`, `file.executePdfOrganization`) 存在于
  tool descriptors 中，但没有分配给 File Agent。PDF 功能在 `index.ts` 中通过
  `isPdfOrganizationGoal()` → `runPdfOrganizationPreviewTask()` 硬编码分发，
  完全绕过了 Agent 系统。详见 §2.2。

- 与 Computer Agent 共享 `file.scanUserDocuments` 工具。
  两个 Agent 都能扫描用户文档，职责边界模糊。
  详见 §2.6。

- `file.classifyDocuments` 在 Agent 工具列表中，但实际分类逻辑在
  `apps/desktop/src/local-knowledge.ts` 中独立运行，不经过 Agent 系统调用。
  Agent 有这个工具但从没被工作流触发过。

**修复方向**：
1. 将 PDF 工具加入 File Agent 的 `allowedToolNames`
2. 移除 Computer Agent 的 `file.scanUserDocuments`，消除重叠
3. 在工作流中通过 capability dispatch 触发 `classifyDocuments` 而不是绕过 Agent

---

### 1.3 Shell Agent (`agent-shell`)

| 维度 | 现状 |
|------|------|
| 工具 | `shell.runReadOnlyCommand` |
| 能力标签 | `shell_readonly` |
| 上下文 | 4K tokens |
| 参与工作流 | `read-current-project` |

**发现的问题**：

- `shell.run`（预览级别）tool descriptor 存在，但没有 Agent 使用它。
  这是预留的还是死代码？

- 4K context 可能是瓶颈。Shell Agent 需要消化命令输出，复杂项目可能有很长的 stdout。
  建议提升至 8K。

- 功能单一且正确，是最简洁的 Agent 定义。可作为其他 Agent 定义的参考模板。

**修复方向**：
1. 将 minContextTokens 从 4000 提升至 8000
2. 确认 `shell.run` 的用途并分配或删除

---

### 1.4 Code Agent (`agent-code`)

| 维度 | 现状 |
|------|------|
| 工具 | `code.inspectRepository`, `code.proposeEdit`, `code.applyProposedEdit`, `shell.runReadOnlyCommand` |
| 能力标签 | `git_inspect`, `code_propose`, `code_apply`, `shell_readonly` |
| 上下文 | 16K tokens, prefersCode: true |
| 参与工作流 | `read-current-project`, `plan-spring-boot-project`, `browser-test` |

**发现的问题**：

- 额外持有 `shell.runReadOnlyCommand`，使其也获得了 `shell_readonly` 能力标签。
  由于 `findByCapabilities` 使用 `Array.find()` 只返回第一个匹配项，而 Shell Agent 在
  `demoAgents` 数组中排在 Code Agent 前面，导致 Code Agent 的 `shell_readonly` 能力
  永远不会被基于能力的调度发现。不过这是有意设计——Code Agent 需要自行运行
  `git status` 等只读命令，实际调度中它通过 agentKind 直接匹配而非能力标签查询。
  建议在 systemPrompt 中明确说明 shell 工具的用途范围，并在注释中标记此已知重叠。

- `code.applyProposedEdit` 在 `allowedToolNames` 中，但实际执行时需要
  confirmed-write 审批流程，该流程在 `code.ts`（Rust）中实现。
  这是正确的，但 Agent 的 systemPrompt 没有提及审批流程的存在。

**修复方向**：
1. systemPrompt 中加入审批流程相关说明
2. 考虑给 Code Agent 添加 `synthesis` 能力标签（生成代码计划也是一种综合能力）

---

### 1.5 Research Agent (`agent-research`)

| 维度 | 现状 |
|------|------|
| 工具 | `web.search`, `web.fetchSource` |
| 能力标签 | `web_search`, `web_fetch`, `synthesis` |
| 上下文 | 8K tokens |
| 参与工作流 | `research-trending-topics`, `plan-spring-boot-project` |

**发现的问题**：

- `synthesis` 标签是通过 agent kind 特殊赋予的（[agent-capability.ts:244-246]）。
  这是唯一一个通过 kind 获得 synthesis 的非 Commander Agent。
  这意味着 `findByCapabilities(["synthesis"])` 返回 Commander + Research，可能产生歧义。

- systemPrompt 说 "clearly mark unknown or unverifiable information"——这是
  Verifier 的职责。Research Agent 应该负责收集，Verifier 负责标记可信度。

**修复方向**：
1. 考虑是否需要 Research Agent 有 synthesis 能力，或创建独立的 `research_synthesis` 标签
2. systemPrompt 中去掉 Verifier 的职责，聚焦于搜索和提取

---

### 1.6 Computer Agent (`agent-computer`)

| 维度 | 现状 |
|------|------|
| 工具 | `file.listDirectory`, `computer.openPath`, `file.scanUserDocuments`, `file.scanUserImages` |
| 能力标签 | `directory_list`, `local_search` |
| 上下文 | 4K tokens, prefersVision: true |
| 参与工作流 | `find-local-document` |

**发现的问题**：

- `prefersVision: true` 但所有工具都不产生图片。这个标记是为未来功能（截屏浏览文件？
  图像预览？）预留的。当前会导致模型评分系统浪费一个视觉模型槽位给
  实际上不需要视觉能力的任务。详见 §2.11。

- `file.scanUserImages` 映射到 `local_search` 标签（[agent-capability.ts:207-208]），
  而 `file.scanUserDocuments` 映射到 `file_scan`。同一类扫描操作产生了不同的能力标签，
  语义不一致。

- `computer.searchLocalDocuments` 方法在 `ComputerTool` 接口中存在，但没有对应的
  tool descriptor。这是个类型层面的功能缺口。

- 4K context + prefersVision = 实际可用的文本上下文非常有限，
  因为视觉模型的图片 token 消耗很大。

**修复方向**：
1. 将 `prefersVision` 改为 false，直到有实际视觉工具
2. minContextTokens 提升至 8K
3. 将 `file.scanUserImages` 映射改为 `file_scan` 或新建 `image_scan` 标签
4. 移除 `file.scanUserDocuments`（由 File Agent 专门负责）
5. 为 `computer.searchLocalDocuments` 添加 tool descriptor

---

### 1.7 Scheduler Agent (`agent-scheduler`)

| 维度 | 现状 |
|------|------|
| 工具 | `scheduler.createTask`, `scheduler.updateTask`, `scheduler.deleteTask` |
| 能力标签 | `schedule_create`, `schedule_update`, `schedule_delete` |
| 上下文 | 4K tokens |
| 参与工作流 | `daily-reminder` |

**发现的问题**：

- `SchedulerTool` 接口（[types.ts:401-403]）只定义了 `createTask` 方法。
  但 Agent 的 `allowedToolNames` 包含 update 和 delete，tool descriptors 也定义了它们。
  存在三层不一致：
  ```
  ToolDescriptor: createTask ✓ | updateTask ✓ | deleteTask ✓
  SchedulerTool:  createTask ✓ | updateTask ✗ | deleteTask ✗
  Agent:          createTask ✓ | updateTask ✓ | deleteTask ✓
  ```
  详见 §2.9。

- 4K context 对于解析自然语言提醒（"每两周的周三下午3点提醒我开会"）可能不够。

- 当前 `executeConcreteGenericStep` 只支持 `schedule_create` 能力调度
  （[workflow-executor.ts:705-713]），`schedule_update` 和 `schedule_delete`
  没有对应的执行路径。

**修复方向**：
1. 扩展 `SchedulerTool` 接口，添加 `updateTask` 和 `deleteTask` 方法
2. minContextTokens 提升至 8K
3. 添加 `schedule_update` 和 `schedule_delete` 的 capability executor
4. 或在未实现时将这些工具从 Agent 的 allowedToolNames 中移除

---

### 1.8 Verifier (`agent-verifier`)

| 维度 | 现状 |
|------|------|
| 工具 | `verifier.check` |
| 能力标签 | `evidence_check`, `planning` |
| 上下文 | 8K tokens |
| 参与工作流 | 全部 7 个 |

**发现的问题**：

- **`planning` 标签分配错误**。Verifier 通过 agent kind 获得了 `planning` 能力标签
  （[agent-capability.ts:249-251]），注释写的是 "Verifier additionally gets planning
  capability (verifies plans)"。但 `planning` 的定义是 "Decompose user goals into
  workflow steps"——这是 Commander 的职责，不是 Verifier 的。

  实际使用场景：`findByCapabilities(["planning"])` 会同时返回 Commander 和 Verifier，
  导致调度歧义。详见 §2.3。

- `verifier.check` 的 tool descriptor 声明 permissionLevel 为 "read"，
  但 Verifier 在工作流中经常需要标记步骤为 failed——这是一种判定权，
  应该显式记录在审计日志中。

**修复方向**：
1. 移除 Verifier 的 `planning` 标签
2. 如果需要 "plan verification" 能力，新建 `plan_verification` 标签
3. 考虑将 `verifier.check` 的 permissionLevel 改为 "preview"（check 结果会影响工作流走向）

---

### 1.9 Chinese Reviewer (`agent-chinese-reviewer`)

| 维度 | 现状 |
|------|------|
| 工具 | `[]` （空数组） |
| 能力标签 | `language_review`（仅通过 kind） |
| 上下文 | 8K tokens |
| 参与工作流 | 无（纯后处理管道） |

**发现的问题**：

- `allowedToolNames: []` 意味着该 Agent 完全不可通过能力系统发现。
  它只能通过显式的 agent kind 引用被调用。

- `WorkbenchStreamingAgentKind`（UI 类型）明确排除了 `chinese-reviewer`，
  意味着 UI 无法展示 "中文审校正在处理..." 的流式状态。

- 实际调用路径（`app-runtime.ts` 中的 `reviewChineseStyle()`）完全绕过 Agent 分发系统，
  直接构造 LLM prompt。该 "Agent" 本质上是一个纯函数管道模块，不是 Agent。

- systemPrompt.en 是 "Lightly review Chinese output..."——英文提示词用于中文审校，
  本质上是占位文本。所有实际逻辑在 zhCN 路径。

  详见 §2.12。

**修复方向**：
1. 选项 A：从 `AgentKind` 和 `demoAgents` 中移除，改为独立的管道模块
2. 选项 B：赋予实际的 tool（如 `reviewer.checkChinese`），纳入工具审计体系
3. 推荐选项 A——它不需要工作流编排，不需要 permission，不需要能力调度

---

### 1.10 Browser Agent (`agent-browser`)

| 维度 | 现状 |
|------|------|
| 工具 | 全部 7 个 browser 工具 |
| 能力标签 | `browser_navigate`, `browser_interact`, `browser_test` |
| 上下文 | 8K tokens, prefersVision: true |
| 参与工作流 | `browser-research`, `browser-test`（executor 已实现，workflow 标记仍为 "planned"） |
| 后端 | Rust `browser.rs` + Playwright sidecar（已完成） |
| 安全 | SSRF 防护、sidecar 崩溃恢复、Drop 防孤立进程（已完成） |

**发现的问题**：

- **工作流状态标记过时**。`browser-research` 和 `browser-test` 的 `currentSupport` 仍为
  `"planned"`，但 `executeConcreteGenericStep` 中已实现了完整的 browser 能力调度
  （`browser_navigate`、`browser_interact`、`browser_test`）和具体步骤执行
  （`navigate-page` → `browserTool.navigate()`、`extract-content` → `getContent()` +
  `screenshot()`、`run-tests` → `runTest()`）。应更新为 `"partial"` 或 `"implemented"`。

- **`safePlanWorkflow` 无法规划 Browser Agent**（与所有非 5 核心 Agent 共享的问题，
  详见 §2.1）。`browser-research` 和 `browser-test` 工作流走的是
  `runGenericWorkbenchWorkflow` 路径，但 Commander 的 `plan()` 调用中 `availableAgents`
  仍然不包含 browser。这导致 Commander 在有显式 browser 需求时规划出的 plan
  与实际可用的能力之间存在差距。

- **测试覆盖不完整**。现有测试主要覆盖 Rust 后端（`browser.rs` 6 个新增测试），
  但 TypeScript 侧（`workflow-executor.ts` 的 browser 步骤、`dispatchGenericByCapability`
  的 browser case）缺少单元测试。

- **`browserSnapshot()` 函数已定义但调用情况需确认**（[agents.ts:183-185]）。
  该辅助函数在 Browser Agent 工作流通过 `agentTracker` 管理状态后可能仍未被使用。

- `prefersVision: true` 对于需要截屏分析的 Browser Agent 是正确的，但需要确保
  `resolveModelForAgent` 的评分系统正确匹配了视觉模型到 browser agent。

**修复方向**：
1. 将 `browser-research` 和 `browser-test` 工作流的 `currentSupport` 从 `"planned"` 更新为 `"partial"`
2. 修复 §2.1（`safePlanWorkflow` 动态化）后 browser Agent 自动可见
3. 为 `workflow-executor.ts` 的 browser 相关分支补充单元测试
4. 确认 `browserSnapshot()` 是否有实际调用点，如无则清理

---

## 2. 跨 Agent 问题深入分析

### 2.1 P0 - `safePlanWorkflow` 硬编码 availableAgents

**文件**：[workflow-executor.ts:505-528](packages/core/src/workflow-executor.ts:505-528)

**问题**：Commander 执行 `plan()` 时传入的 `availableAgents` 是硬编码的 5 个 Agent：

```typescript
availableAgents: [
  { kind: "commander", allowedToolNames: ["commander.plan"] },
  { kind: "file", allowedToolNames: ["file.scanMarkdownDocuments"] },
  { kind: "shell", allowedToolNames: ["shell.runReadOnlyCommand"] },
  { kind: "code", allowedToolNames: ["code.inspectRepository"] },
  { kind: "verifier", allowedToolNames: ["verifier.check"] },
],
```

缺失的 5 个 Agent：browser, computer, scheduler, research, chinese-reviewer。

**影响**：
- Commander 规划的步骤无法引用缺失 Agent 的工具
- `browser-research` 工作流中 step 的 agentKind 是 "browser"，但 Commander
  看不到 browser Agent，会产生不一致的 plan
- 用户无法在对话中说 "让 Browser Agent 打开这个页面" 并得到正确的步骤规划

**根因**：最初的实现只有 5 个 Agent，后续添加的 Agent 没有被同步到这段硬编码中。

**修复方案**：
```typescript
// 改为从 AgentRegistry 动态获取
import { createDefaultAgentRegistry } from "./agents";

async function safePlanWorkflow(...) {
  const registry = createDefaultAgentRegistry();
  const availableAgents = registry.list().map(reg => ({
    kind: reg.agent.kind,
    allowedToolNames: reg.agent.allowedToolNames,
  }));
  return await commanderTool.plan({ userGoal, workflowId, availableAgents });
}
```

**影响文件**：仅 `workflow-executor.ts`，约 10 行改动。

---

### 2.2 P0 - PDF 工具无 Agent 分配

**涉及文件**：
- [descriptors.ts:60-68](packages/tools/src/descriptors.ts:60-68) — 工具描述符存在
- [agents.ts:19-28](packages/core/src/agents.ts:19-28) — File Agent 的 allowedToolNames 没有 PDF 工具
- [index.ts:701-711](packages/core/src/index.ts:701-711) — 硬编码的 PDF 路由

**问题**：PDF 整理功能存在完整的后端实现（Rust `pdf.rs`，5 个 Tauri 命令）、
前端 UI（`InspectorPanel.tsx` 中的 PDF 操作卡片）、和路由逻辑，
但它完全绕过了 Agent 系统。`isPdfOrganizationGoal()` 直接在 `createFileScanTaskRuntime`
中分发给 `runPdfOrganizationPreviewTask()`，不经过 Agent 分发。

**影响**：
- PDF 操作没有 Agent 归属，审计日志中 agentKind 为 unknown
- 无法通过 Agent 能力系统发现 PDF 功能
- 与项目的 Agent 驱动架构不一致

**修复方案**：
1. 将 `file.planPdfOrganization` 和 `file.executePdfOrganization` 加入 File Agent 的 `allowedToolNames`
2. 在 `inferCapabilityTags` 中添加映射：
   ```
   "file.planPdfOrganization" → "file_scan"（预览阶段）
   "file.executePdfOrganization" → "file_execute"（新标签，写操作）
   ```
3. 创建 PDF 工作流，替代硬编码的 `runPdfOrganizationPreviewTask`

**影响文件**：`agents.ts`, `agent-capability.ts`, `index.ts`, `workflows.ts`, `workflow-executor.ts`

---

### 2.3 P1 - Verifier 的 `planning` 标签分配错误

**文件**：[agent-capability.ts:249-251](packages/core/src/agent-capability.ts:249-251)

**问题**：
```typescript
// Verifier additionally gets planning capability (verifies plans)
if (agent.kind === "verifier") {
  tags.add("planning");
}
```

`planning` 标签定义是 "Decompose user goals into workflow steps"。
但 Verifier 做的是 "verifies plans"，即检查/验证计划——这是完全不同的能力。

**影响**：
```typescript
// 这行代码返回两个结果，但 Commander 才是正确答案
registry.findByCapabilities(["planning"]);
// → [Commander, Verifier]  // Verifier 不应该在这里
```

**修复方案**：
1. 从 Verifier 移除 `planning` 标签
2. 如果 Verifier 的 "验证计划" 能力需要被查询，创建新标签 `plan_verification`：
   ```
   "plan_verification" // Check step evidence against success criteria in a plan
   ```
3. 将 Verifier 的 kind-based 标签改为 `plan_verification` + `evidence_check`

---

### 2.4 P1 - Commander 缺少 `commander.synthesize` 工具

**涉及文件**：
- [agents.ts:11](packages/core/src/agents.ts:11) — `allowedToolNames: ["commander.plan"]`
- [types.ts:191](packages/tools/src/types.ts:191) — `CommanderTool.synthesize?()` 方法已定义
- [workflow-executor.ts:1510-1527](packages/core/src/workflow-executor.ts:1510-1527) — `safeSynthesizeConclusion()` 实际调用

**问题**：Commander 有两个方法 `plan()` 和 `synthesize()`，但工具列表和描述符都只覆盖了 `plan`。
synthesize 操作没有 tool descriptor，不在 `allowedToolNames` 中，没有对应的 capability tag。

**影响**：
- 工具审计日志无法记录 synthesize 操作
- 能力系统无法表达 "这个 Agent 能综合证据得出结论"
- Commander 的 `synthesis` 标签只能通过 kind 获得，无法从工具名推导

**修复方案**：
1. 添加 tool descriptor：
   ```typescript
   {
     name: "commander.synthesize",
     permissionLevel: "read",
     summary: "Synthesize collected evidence into a user-facing conclusion.",
   }
   ```
2. 加入 Commander 的 `allowedToolNames`
3. 在 `inferCapabilityTags` 中添加 `"commander.synthesize" → "synthesis"` 映射
4. 移除 Commander 的 kind-based `synthesis` 特殊处理（变为纯工具推导）

---

### 2.5 P1 - Workspace 工具无 Agent 分配

**涉及文件**：
- [descriptors.ts:114-133](packages/tools/src/descriptors.ts:114-133) — 4 个 workspace 工具描述符
- [types.ts:413-423](packages/tools/src/types.ts:413-423) — `WorkspaceTool` 接口
- Agent 定义中无任何 Agent 包含 workspace 工具

**问题**：Workspace CRUD 操作（list/scaffold/create/delete）完全在 UI 层直接调用
Tauri invoke，不经过 Agent 系统。没有 "Workspace Agent" 存在。

**影响**：
- Workspace 操作不受 Agent 审计追踪
- 无法通过 Commander 规划 workspace 管理工作流
- 权限控制依赖 UI 层而不是 Agent 系统的 confirmed-write 流程

**修复方案**：
1. 选项 A：创建 Workspace Agent，赋予所有 workspace 工具
2. 选项 B：将 workspace 工具分配给 Commander（作为管理类操作）
3. 推荐选项 A——创建轻量级 Workspace Agent，专门处理 workspace 生命周期

---

### 2.6 P1 - File Agent 与 Computer Agent 职责重叠

**涉及文件**：
- [agents.ts:19-28](packages/core/src/agents.ts:19-28) — File Agent
- [agents.ts:72-87](packages/core/src/agents.ts:72-87) — Computer Agent
- [agent-capability.ts:174-209](packages/core/src/agent-capability.ts:174-209) — 能力标签映射

**当前工具分配**：

| 工具 | File Agent | Computer Agent | 能力标签 |
|------|-----------|----------------|---------|
| `file.scanMarkdownDocuments` | ✓ | ✗ | `file_scan` |
| `file.scanUserDocuments` | ✓ | ✓ | `file_scan` |
| `file.scanUserImages` | ✗ | ✓ | `local_search` |
| `file.listDirectory` | ✗ | ✓ | `directory_list` |
| `file.classifyDocuments` | ✓ | ✗ | `document_classify` |
| `computer.openPath` | ✗ | ✓ | `local_search` |

**问题**：
- `file.scanUserDocuments` 两个 Agent 都有，语义重叠
- `file.scanUserImages` → `local_search` 与 `file.scanUserDocuments` → `file_scan` 标签不一致
- Computer Agent 名称为 "Computer" 但实际是文件浏览，不如 "File Explorer Agent" 准确

**建议的重新划分**：
```
File Agent (文档专家):
  file.scanMarkdownDocuments  → file_scan
  file.scanUserDocuments      → file_scan
  file.classifyDocuments      → document_classify
  file.planPdfOrganization    → file_preview (新标签)
  file.executePdfOrganization → file_execute (新标签)

Computer Agent (文件浏览器):
  file.listDirectory          → directory_list
  file.scanUserImages         → image_scan (新标签)
  computer.openPath           → file_open (新标签)
  computer.searchLocalDocuments → local_search (需新增 tool descriptor)
```

> **类型归属注意**：`file.scanUserImages` 当前是 `FileTool` 接口的方法，如果分配给
> Computer Agent，需要将其从 `FileTool` 移到 `ComputerTool`，或者在 Computer Agent
> 中注入 `FileTool` 实例。建议保持工具名前缀 `file.*` 不变（表示操作对象类型），
> 仅调整 Agent 的 `allowedToolNames` 和能力标签映射。

---

### 2.7 P2 - 能力标签推导逻辑分散

**文件**：[agent-capability.ts:163-254](packages/core/src/agent-capability.ts:163-254)

**问题**：能力标签有三种来源，分散在同一个函数的不同位置：
1. **工具名推导**（switch/case，line 173-236）—— 主力逻辑
2. **Agent kind 特殊处理**（line 168-171, 239-251）—— Commander、Chinese Reviewer、Research、Verifier
3. **隐式映射表**（switch case 的 fall-through）

kind-based 特殊处理导致：
- Commander 的 `synthesis` 标签无法从工具名推导（因为没有 `commander.synthesize` 工具）
- Verifier 的 `planning` 标签语义错误
- Research 的 `synthesis` 标签来源不明

**修复方案**：
将所有能力标签统一为纯工具名推导：

1. 补齐缺失的工具名（`commander.synthesize`）
2. 移除所有 kind-based 特殊处理
3. 对于 Chinese Reviewer：如果保留为 Agent，添加 `reviewer.checkChinese` 工具；
   如果改为管道模块，从 Agent 系统中移除

```typescript
function inferCapabilityTags(agent: Agent): AgentCapabilityTag[] {
  const tags = new Set<AgentCapabilityTag>();
  for (const tool of agent.allowedToolNames) {
    const tag = TOOL_TO_CAPABILITY[tool];
    if (tag) tags.add(tag);
  }
  return [...tags];
}

// 显式映射表，单一真相源
const TOOL_TO_CAPABILITY: Record<string, AgentCapabilityTag> = {
  "commander.plan": "planning",
  "commander.synthesize": "synthesis",
  "file.scanMarkdownDocuments": "file_scan",
  "file.scanUserDocuments": "file_scan",
  "file.scanUserImages": "image_scan",
  "file.classifyDocuments": "document_classify",
  // ... etc
};
```

---

### 2.8 P2 - `shell.run` 工具描述符无 Agent 使用

**文件**：[descriptors.ts:25-28](packages/tools/src/descriptors.ts:25-28)

**问题**：
```typescript
{
  name: "shell.run",
  permissionLevel: "preview",
  summary: "Preview shell commands before execution.",
}
```
该 descriptor 存在但没有 Agent 的 `allowedToolNames` 包含它。

两种可能：
- 预留的写操作工具（先 preview，确认后执行）
- 写了一半被废弃的功能

**修复方案**：
- 如果是预留：添加注释标记为 "planned"，并删除 descriptor 直到有实现
- 如果是废弃：直接删除

---

### 2.9 P2 - Scheduler 接口定义不完整

**涉及文件**：
- [types.ts:401-403](packages/tools/src/types.ts:401-403) — `SchedulerTool` 只有 `createTask`
- [descriptors.ts:99-113](packages/tools/src/descriptors.ts:99-113) — 三个 scheduler tool descriptor
- [agents.ts:89-98](packages/core/src/agents.ts:89-98) — Agent 有 3 个工具
- [workflow-executor.ts:705-713](packages/core/src/workflow-executor.ts:705-713) — 只有 `schedule_create` executor

**当前接口**：
```typescript
export interface SchedulerTool {
  createTask(request: ScheduledTaskDraft): Promise<ScheduledTaskDraft & { id: string; enabled: boolean }>;
}
```

应该扩展为：
```typescript
export interface SchedulerTool {
  createTask(request: ScheduledTaskDraft): Promise<ScheduledTaskDraft & { id: string; enabled: boolean }>;
  updateTask?(id: string, request: Partial<ScheduledTaskDraft>): Promise<ScheduledTaskDraft & { id: string; enabled: boolean }>;
  deleteTask?(id: string): Promise<void>;
}
```

---

### 2.10 P3 - 低 minContextTokens 配置

**涉及文件**：[agents.ts](packages/core/src/agents.ts)

| Agent | 当前 | 建议 | 理由 |
|-------|------|------|------|
| Shell | 4K | 8K | 复杂命令输出可能超过 4K |
| Scheduler | 4K | 8K | 自然语言解析需要更多上下文 |
| Computer | 4K | 8K | 文件列表和路径信息较大 |

将这些提升到 8K 可以与其他 Agent（File、Research、Verifier、Browser、Chinese Reviewer）保持一致。
Commander 和 Code Agent 保持 16K（需要处理大量计划/代码上下文）。

---

### 2.11 P3 - Computer Agent 的 `prefersVision` 无工具支撑

**文件**：[agents.ts:82](packages/core/src/agents.ts:82)

**问题**：`modelRequirements: { prefersVision: true, prefersCode: false, minContextTokens: 4000 }`

但 Computer Agent 的所有工具都不产生或消费图片：
- `file.listDirectory` → 返回路径列表
- `computer.openPath` → OS 操作
- `file.scanUserDocuments` → 文件元数据
- `file.scanUserImages` → 扫描图片文件（元数据，非图片内容）

**影响**：`resolveModelForAgent()` 中的评分系统会因为 `prefersVision: true`
而给不具备视觉能力的模型打低分。如果用户没有配置视觉模型，Computer Agent 可能无法被分配模型。

**修复方案**：将 `prefersVision` 改为 `false`。等未来添加了实际的视觉工具（如
屏幕截图分析、图片内容描述）后再改为 `true`。

---

### 2.12 P3 - Chinese Reviewer 的架构定位问题

**涉及文件**：
- [agents.ts:112-123](packages/core/src/agents.ts:112-123) — Agent 定义
- [agent-capability.ts:239-241](packages/core/src/agent-capability.ts:239-241) — kind-based 标签
- [types.ts:419](packages/ui/src/types.ts:419) — `WorkbenchStreamingAgentKind` 排除
- [app-runtime.ts](apps/desktop/src/app-runtime.ts) — 实际调用路径

**问题**：Chinese Reviewer 不是一个真正的 Agent：
- 无工具 (`allowedToolNames: []`)
- 无工作流参与
- 无 permission 模型
- 无 UI 流式状态
- 仅通过 `app-runtime.ts` 中的 `reviewChineseStyle()` 直接调用 LLM

**实际定位**：中文审校是一个**后处理管道步骤**（pipeline step），不是 Agent。
它应该和 `input-preprocessor.ts`（输入预处理）对称地作为 `output-postprocessor.ts`（输出后处理）。

**修复方案（推荐）**：
1. 从 `AgentKind` 联合类型中移除 `"chinese-reviewer"`
2. 从 `demoAgents` 数组中移除该条目
3. 从 `inferCapabilityTags` 中移除 kind-based 特殊处理
4. 从 `agent-capability.ts` 中移除 `language_review` 标签
5. 保留 `chinese-reviewer.ts` 的 prompt 构建逻辑，作为纯管道模块
6. 在 `app-runtime.ts` 中保持 `reviewChineseStyle()` 的调用方式不变

---

### 2.13 P2 - `file-scan` Route 不映射到任何 Workflow

**文件**：[routing.ts:129-151](packages/core/src/routing.ts:129-151)

**问题**：`routeToWorkflowId()` 的 switch 覆盖了 `research`、`spring-boot`、`local-document`、
`schedule`、`project`、`browser` 六种 route，但 `"file-scan"` 落入 `default: return undefined`。
这意味着文件扫描路由虽然能命中（score >= 2），但 `getRecommendedWorkflowIds()` 不会为它
返回任何工作流 ID。

**影响**：
- 在 `createFileScanTaskRuntime` 中，file-scan 路由永远不会进入
  `runGenericWorkbenchWorkflow` 分支（因为 `recommendedWorkflowIds` 为空）
- 文件扫描完全依赖 `isDocumentScanGoal()` 硬编码判断和 `runFileScanTask()` 直接调用
- 绕过了工作流系统，与其他已工作流化的路由（research、pdf）不一致

**修复方案**：
1. 创建 `scan-workspace-documents` 工作流蓝图
2. 在 `routeToWorkflowId` 中添加：
   ```typescript
   case "file-scan":
     return "scan-workspace-documents";
   ```

**影响文件**：`routing.ts`, `workflows.ts`

---

## 3. 修复路线图

### Phase 1: 阻塞修复（预计 2-3 小时）

| 序号 | 问题 | 改动文件 | 风险 | 状态 |
|------|------|---------|------|------|
| 1 | `safePlanWorkflow` 硬编码 → AgentRegistry 动态获取 | `workflow-executor.ts` | 低 | ✅ 已完成 |
| 2 | PDF 工具分配给 File Agent + 创建工作流 | `agents.ts`, `workflows.ts`, `index.ts` | 中 | ⚠️ 部分（工具已分配，硬编码路由待清理） |
| 3 | 添加 `commander.synthesize` 工具 | `descriptors.ts`, `agents.ts`, `agent-capability.ts` | 低 | ✅ 已完成 |
| 14 | Browser 工作流 `currentSupport` 标记更新 ("planned" → "partial") | `workflows.ts` | 低 | ✅ 已完成 |

### Phase 2: 架构对齐（预计 3-4 小时）

| 序号 | 问题 | 改动文件 | 风险 | 状态 |
|------|------|---------|------|------|
| 4 | Verifier 移除 `planning` 标签 | `agent-capability.ts` | 低 | ✅ 已完成 |
| 5 | File/Computer Agent 工具重分配 | `agents.ts`, `agent-capability.ts` | 中 | ✅ 已完成 |
| 6 | 创建 Workspace Agent 或分配工具 | `agents.ts`, `workflows.ts` | 中 | ✅ 已完成 |
| 7 | 能力标签推导统一为映射表 | `agent-capability.ts` | 中 | ⚠️ 部分（仍有 2 个 kind-based tag：chinese-reviewer→language_review, research→synthesis） |
| 13 | `file-scan` Route 映射到 Workflow | `routing.ts`, `workflows.ts` | 低 | ❌ 未完成 |

### Phase 3: 清理和完善（预计 2-3 小时）

| 序号 | 问题 | 改动文件 | 风险 | 状态 |
|------|------|---------|------|------|
| 8 | SchedulerTool 接口扩展 | `types.ts`, `desktop/src/app-runtime.ts` | 中 | ✅ 已完成 |
| 9 | Chinese Reviewer 改为管道模块 | `agents.ts`, `agent-capability.ts`, `types.ts`, `ui/types.ts` | 中 | ❌ 未完成 |
| 10 | minContextTokens 统一 8K | `agents.ts` | 低 | ✅ 已完成 |
| 11 | Computer Agent `prefersVision: false` | `agents.ts` | 低 | ✅ 已完成 |
| 12 | `shell.run` descriptor 清理 | `descriptors.ts` | 低 | ✅ 已完成 |

---

## 4. 附录：当前 Agent 矩阵（已更新至 2026-05-31）

> **状态说明**：✅ = 已实现 | ⚠️ = 部分实现 | ❌ = 未实现

| Agent | 工具数 | 能力标签 | 上下文 | Vision | Code |
|-------|--------|---------|--------|--------|------|
| Commander | 3 | planning, synthesis, clarification | 16K | ✗ | ✗ |
| File | 7 | file_scan, document_classify, file_execute | 8K | ✗ | ✗ |
| Shell | 1 | shell_readonly | 8K | ✗ | ✗ |
| Code | 4 | git_inspect, code_propose, code_apply, shell_readonly | 16K | ✗ | ✓ |
| Research | 2 | web_search, web_fetch, synthesis (kind-based) | 8K | ✗ | ✗ |
| Computer | 3 | directory_list, image_scan, local_search | 8K | ✗ | ✗ |
| Vision | 3 | image_analyze, image_describe, image_ocr | 16K | ✓ | ✗ |
| Scheduler | 3 | schedule_create, schedule_update, schedule_delete | 8K | ✗ | ✗ |
| Verifier | 1 | evidence_check | 8K | ✗ | ✗ |
| Browser | 10 | browser_navigate, browser_interact, browser_test | 8K | ✓ | ✗ |
| Workspace | 4 | workspace_list, workspace_scaffold, workspace_create, workspace_delete | 8K | ✗ | ✗ |
| Chinese Reviewer | 0 | language_review (kind-based) | 8K | ✗ | ✗ |

共计 **12 个 Agent**。总计 **42 个 Tool Descriptor**。

**已实现的 Capability Tag（共 19 个）**：
`planning`, `synthesis`, `clarification`, `file_scan`, `document_classify`, `file_execute`, `shell_readonly`,
`git_inspect`, `code_propose`, `code_apply`, `web_search`, `web_fetch`, `directory_list`,
`image_scan`, `local_search`, `image_analyze`, `image_describe`, `image_ocr`,
`evidence_check`, `schedule_create`, `schedule_update`, `schedule_delete`,
`browser_navigate`, `browser_interact`, `browser_test`,
`workspace_list`, `workspace_scaffold`, `workspace_create`, `workspace_delete`,
`language_review`

**Dangling Tool Descriptor（有 descriptor 但无 Agent 使用）**：
`project.inspect` — ownerAgentKinds ["shell", "file"]，但 shell/file agent 均未包含此工具。
`file.scanInstalledApps` — ownerAgentKinds ["computer"]，但 computer agent 未包含此工具。

**有实现但缺 Tool Descriptor 的工具**：
`computer.searchLocalDocuments` — `ComputerTool` 接口 + `app-runtime.ts` 中有完整实现，但缺少 descriptor。

**待从 Agent 系统移除的**：
`language_review` 标签（随 Chinese Reviewer 迁移为管道模块）

---

*分析日期：2026-05-30 | 分析范围：10 Agents, 7 Workflows, 32 Tool Descriptors, 21 Capability Tags*
