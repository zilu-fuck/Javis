# Agent 架构三模式分析与 Javis 适配评估

> 2026-05-29 | 基于 Plan / Multi-Agent / Human-in-the-Loop 三种 Agent 设计模式，
> 分析 Javis 当前实现程度并给出改进路线。

---

## 三种模式定义

### Plan 模式

单个 Agent 内部的执行策略——"先规划、再执行"。

接到任务后由规划器（LLM）生成结构化步骤计划，按步骤逐步调用工具完成。
核心要素：

- **动态步骤生成**：根据具体目标生成步骤，而非从预定义列表中选
- **DAG 依赖解析**：识别步骤间依赖，并行无依赖步骤
- **失败重规划**：某步失败后分析原因，调整后续步骤
- **Agent 内部循环**：每个 Agent 内部有 observe → plan → act → observe 闭环
- **工具自主选择**：Agent 根据当前状态决定使用哪个工具

### 多 Agent 模式

多个独立 Agent 的协作架构——"角色分工、协同工作"。

系统由不同角色的 Agent 组成，通过任务分解、消息传递、共享记忆协同完成复杂任务。
核心要素：

- **角色专业化**：每个 Agent 有明确职责边界和工具权限
- **任务分解与分发**：协调者将大任务分解为子任务分配给合适的 Agent
- **共享上下文**：Agent 间通过共享记忆传递中间结果
- **质量门**：独立校验 Agent 验证执行结果
- **可扩展性**：新增 Agent 类型不影响现有 Agent

### 人在回路 / 主动澄清模式

Agent 与人类交互的机制——"不懂就问"。

当 Agent 不确定性较高时暂停并请求人类输入，包含两个维度：

- **安全回路**：高风险操作（写入、删除、网络请求）需要人类确认
- **澄清回路**：信息不足、需求模糊时主动向用户提问

---

## Javis 实现评估

### 多 Agent 模式 — 已实现（★★★★☆ 4/5）

**已具备：**

| 要素 | 实现 |
|------|------|
| 角色专业化 | 12 个 Agent 类型（Commander / File / Shell / Code / Research / Computer / Scheduler / Verifier / ChineseReviewer / Browser / Vision / Workspace），各有限定工具白名单和双语系统提示词 |
| 任务分解与分发 | Commander 选择工作流，DAG 执行器按 `agentKind` + `requiredCapabilities` 分发步骤 |
| 共享上下文 | `SharedTaskContext` 在步骤间传递，`context.set(step:${id})` 写入中间结果 |
| 质量门 | Verifier Agent 逐项检查步骤证据是否满足成功标准 |
| 可扩展性 | Agent Capability Model（17 个 tag）+ Agent Registry 支持动态注册 |

**缺失：**

- 工作流只有 7 个预定义模板，Commander 不能**动态组合** Agent
- Agent 间通信是单向 DAG（上游→下游），没有**对等协商**（如 Code Agent 要求 File Agent 重新扫描）
- 缺少 Agent 执行日志的结构化追踪

**评分理由**：骨架完整，但工作流数量和 Agent 交互模式需要扩展。扣 1 分在"静态工作流"。

---

### Plan 模式 — 严重不足（★☆☆☆☆ 1/5）

**已具备：**

| 要素 | 实现 |
|------|------|
| DAG 依赖解析 | `workflow-dag-executor.ts` 正确实现了依赖分析 + 并行执行 |
| 步骤状态机 | `TaskStatus` 覆盖 `created → planning → running → verifying → completed` |
| 动态步骤生成 | P0-1: Commander LLM 动态生成 DAG（`runCommanderDagTask`），legacy 分支仅作 fallback |
| Agent ReAct 循环 | P0-2: `executeStepWithReAct` + `runAgentReActLoop`（max 4 iterations），LLM 决策下一步工具 |
| 失败重规划 | P0-3: `handleStepFailureReplan` + `replanDag`，Commander 生成 recovery steps |
| 工具注册表 | 42 个 ToolDescriptor 通过 `initialToolDescriptors` 暴露给 LLM 做 tool selection |

**缺失（按影响程度排序）：**

| 缺口 | 现状 | 影响 |
|------|------|------|
| **ReAct 仅在 Commander DAG 路径生效** | legacy fallback 分支仍用单次 tool call | 无 Commander Tool（离线/测试模式）时无 ReAct 循环 |
| **ReAct 决策依赖 LLM** | `reactDecideNext` 每次迭代需一次 LLM 调用 | 增加 token 消耗，延迟较高 |
| **ReAct 失败直接触发 replan** | 无本地重试策略（如换参数重试），失败直接抛给 Commander | 增加不必要的 LLM 调用 |

**当前 Plan 模式的实际流程：**

```
用户目标 → Commander LLM 动态生成 DAG → ReAct 每步执行
              ↑ (P0-3: 失败时 replan)    ↑ (P0-2: observe→decide→act, max 4 iters)
         legacy fallback（仅无 Commander Tool 时）
```

**评分修正**：原评分 ★☆☆☆☆（1/5）已不准确。动态规划、ReAct 循环、失败重规划三项核心能力均已实现。剩余缺口为 legacy 路径覆盖和 ReAct 本地优化。修正为 **★★★☆☆（3/5）**。

**补充：动态规划的安全风险**

从静态工作流切换到 LLM 动态生成步骤 DAG，会引入新的 failure mode：

| 风险 | 说明 | 防御 |
|------|------|------|
| 幻觉工具名 | LLM 生成不存在的工具名 | 工具名白名单校验（对照 `descriptors.ts`），不匹配 → 拒绝该步骤 |
| 非法依赖图 | 循环依赖、依赖不存在的步骤 | DAG 合法性校验（现有 `validateWorkflowDag` 可复用） |
| 权限越界 | 只读 Agent 被分配 confirmed_write 步骤 | 步骤 agentKind → 工具权限交叉校验 |
| 步骤爆炸 | LLM 生成过多步骤导致 token 超限 | 步骤数上限（建议 ≤ 10），超出则要求 Commander 合并 |

这些校验是纯函数，可以放在 `packages/core/` 中，在 Commander 输出解析后、DAG 执行前运行。**动态规划 + 结构化校验 = 灵活且安全，不是二选一。**

---

### 人在回路模式 — 安全完整、澄清已就位（★★★☆☆ 3/5）

**已具备（安全回路）：**

| 要素 | 实现 |
|------|------|
| 确认写入流程 | `confirmed-write.ts`：dry run → 审批卡 → approve/deny → 原生绑定 |
| 原生安全绑定 | Rust 端 `NativeApprovalBinding`：approval_id + tool_name + task_id + preview_hash |
| 一次性消费 | 审批使用后立即消费，防止重放 |
| 路径沙箱 | `ensure_relative_path_stays_in_root()` 防止目录遍历 |
| 只读命令白名单 | `is_allowed_read_only_command()` 硬编码允许列表 |
| 状态机支持 | `TaskStatus.waiting_permission` 状态 + `PermissionLevel` 四级体系 |
| 跨会话恢复 | `restored-approval.ts` 支持 PDF + Code Patch 审批跨会话恢复 |

**缺失（澄清回路）：**

| 缺口 | 现状 | 影响 |
|------|------|------|
| **无 AskUser 工具** | ~~原缺口~~ **[已于 2026-05-31 修复]** `commander.askUser` 工具已实现：descriptor 存在（descriptors.ts:20-25），Commander 的 `allowedToolNames` 包含（agents.ts:11），workflow-executor.ts 有完整 DAG 处理（行 1487-1706），App.tsx 有 UI 卡片，task-history.ts 有持久化 | Agent 遇到歧义可以主动提问 |
| **Commander 不澄清** | Commander systemPrompt 已包含 "当目标模糊时必须先用 commander.askUser 向用户澄清"（agents.ts:14-15），P0-3/P0-4 replan+askUser 支持已实现（app-runtime.ts:899） | Commander 在目标模糊时能反问 |
| **Agent 不追问** | 各 Agent system prompt 没有"信息不足时询问"的指令 | 缺参数时 Agent 用默认值填，而不是提示用户补充 |
| **无确认阈值策略** | 所有 confirmed_write 操作一视同仁 | 改一个变量名和删除一个文件的确认流程完全相同，没有风险分级 |

**评分理由**：安全回路是 Javis 的亮点——四道防线（UI → approval binding → path guard → one-shot）。澄清回路已通过 `commander.askUser` 工具实现。风险分级仍未实现。扣分在"确认阈值策略"。

---

## 对比总览

| 维度 | 多 Agent 模式 | Plan 模式 | 主动澄清模式 |
|------|:---:|:---:|:---:|
| **当前评分** | ★★★★☆ | ★★★☆☆ | ★★★☆☆ |
| **关注点** | Agent 间如何分工协作 | Agent 内部如何思考行动 | Agent 与人类如何交互 |
| **Javis 现状** | 12 个 Agent + DAG 调度 | Commander LLM 动态 DAG + ReAct 循环 + 失败重规划，legacy fallback 仅作降级 | 安全审批完整，`commander.askUser` 澄清已实现 |
| **最大短板** | 工作流不可动态组合 | ReAct 依赖 LLM 决策，legacy 路径无 ReAct | 无风险分级审批（所有 confirmed_write 同级） |
| **投产价值** | 已可用 | 核心能力已就位 | 安全 + 澄清均已覆盖 |

---

## 改进路线

### 第一阶段：Plan 模式核心（P0）— ✅ 已完成

> **实施状态（2026-05-31）**：6 项全部实现。Commander LLM 动态 DAG 为主路径（`runCommanderDagTask`），legacy 路由仅在无 Commander Tool 时作为 fallback。

| 项 | 说明 | 状态 |
|----|------|------|
| Commander 动态规划 | Commander 调用 LLM 动态生成 DAG（agentKind / tool / dependsOn / 预期输出） | ✅ P0-1 |
| Commander 智能路由 | Commander DAG 替代正则路由为主路径，legacy routing 仅做 fallback | ✅ P0-1 |
| Agent ReAct 循环 | `executeStepWithReAct` + `runAgentReActLoop`，max 4 iterations，LLM 决策 | ✅ P0-2 |
| 失败重规划 | `handleStepFailureReplan` + `replanDag`，Commander 生成 recovery steps | ✅ P0-3 |
| 工具注册表 | 42 个 `initialToolDescriptors` 为单一真相源，暴露给 LLM | ✅ |
| 动态规划安全校验 | 非法工具名/循环依赖/权限越界/步骤爆炸四道防线（`validateWorkflowDag` 等） | ✅ |

**遗留**：legacy fallback 路径无 ReAct/Replan 支持（仅无 Commander Tool 时触发）。

### 第二阶段：主动澄清（P1）— ⚠️ 部分完成

> **实施状态（2026-05-31）**：`commander.askUser` 已完整实现（descriptor + DAG handler + UI + 持久化）。风险分级审批未做。

| 项 | 说明 | 状态 |
|----|------|------|
| `commander.askUser` 工具 | descriptor 存在 + DAG 中暂停执行 + UI 弹出问题卡片 + 用户回复后继续 | ✅ P0-4 |
| Commander 澄清 prompt | systemPrompt 含 "当目标模糊时必须先用 commander.askUser 向用户澄清" | ✅ |
| 确认阈值分级 | confirmed_write 分为 safe / risky / dangerous，UI 警告级别不同 | ❌ |
| 澄清超时策略 | 用户超时未响应 → 任务自动暂停 | ❌ |

**验收标准**：Commander 在目标模糊时调用 `askUser`（✅）。confirmed_write 分级 UI（❌）。

### 第三阶段：多 Agent 深化（P2，预计 2-3 天）

```
目标：从"流水线"升级为"团队协作"
```

| 项 | 说明 |
|----|------|
| Agent 间对等通信 | Agent A 可以向 Agent B 发起请求（如 Code Agent 要求 File Agent 重新扫描特定目录） |
| 动态 Agent 注册 | 支持 Runtime 注册新的 Agent 类型，不需要修改 `agents.ts` |
| 结构化执行追踪 | 每次 DAG 执行生成 JSON trace，包含每个步骤的输入/输出/耗时/token 用量 |

**验收标准：**

- Code Agent 可以在执行过程中向 File Agent 发起重新扫描请求
- Runtime 注册的新 Agent 出现在 Agent Registry 中且可被 Commander 调度
- 单次 DAG 执行的 JSON trace 可读，包含所有步骤的 wall-time 和 token 统计

---

## 附录：当前工具矩阵

### 安全回路（已实现）

```
Tool Dry Run → UI Approval Card → User Approve/Deny
                                      ↓ (approve)
                              Rust NativeApprovalBinding
                              (approval_id + hash + task_id)
                                      ↓
                              Path Guard + One-Shot Consume
                                      ↓
                              Execute Write
```

### Agent 工具权限矩阵

| Agent | 工具 | 权限 |
|-------|------|------|
| Commander | `commander.plan`, `commander.synthesize` | read |
| File | `file.scanMarkdownDocuments`, `file.scanUserDocuments`, `file.classifyDocuments`, `file.planPdfOrganization`, `file.executePdfOrganization`, `file.planWriteText`, `file.writeText` | read / preview / confirmed_write |
| Shell | `shell.runReadOnlyCommand` | read |
| Code | `code.inspectRepository`, `code.proposeEdit`, `code.applyProposedEdit` | read / preview / confirmed_write |
| Research | `web.search`, `web.fetchSource` | read |
| Computer | `file.listDirectory`, `computer.openPath`, `file.scanUserImages` | read |
| Vision | `vision.analyze`, `vision.describe`, `vision.extractText` | read |
| Scheduler | `scheduler.createTask`, `scheduler.updateTask`, `scheduler.deleteTask` | confirmed_write |
| Workspace | `workspace.list`, `workspace.scaffold`, `workspace.create`, `workspace.delete` | read / preview / confirmed_write |
| Verifier | `verifier.check` | read |
| ChineseReviewer | (无 tool，纯 LLM 输出审校) | — |
| Browser | `browser.navigate`, `browser.screenshot`, `browser.getContent`, `browser.click`, `browser.type`, `browser.evaluate`, `browser.runTest` | read / confirmed_write |
