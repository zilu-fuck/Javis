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
| 角色专业化 | 9 个 Agent 类型（Commander / File / Shell / Code / Research / Computer / Scheduler / Verifier / ChineseReviewer），各有限定工具白名单和双语系统提示词 |
| 任务分解与分发 | Commander 选择工作流，DAG 执行器按 `agentKind` + `requiredCapabilities` 分发步骤 |
| 共享上下文 | `SharedTaskContext` 在步骤间传递，`context.set(step:${id})` 写入中间结果 |
| 质量门 | Verifier Agent 逐项检查步骤证据是否满足成功标准 |
| 可扩展性 | Agent Capability Model（17 个 tag）+ Agent Registry 支持动态注册 |

**缺失：**

- 工作流只有 5 个预定义模板，Commander 不能**动态组合** Agent
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

**缺失（按影响程度排序）：**

| 缺口 | 现状 | 影响 |
|------|------|------|
| **动态步骤生成** | Commander 只从 5 个硬编码工作流中选一个（`workflows.ts`），不生成步骤 | 换个项目类型（Rust vs Spring Boot）步骤完全一样，失去"智能"意义 |
| **Agent 内部 ReAct 循环** | 每个 Agent 执行一次 tool call 就结束，没有 observe→plan→act 闭环 | File Agent 扫描不全时不会自己补扫，Shell Agent 命令失败不会换方式重试 |
| **工具自主选择** | Agent 的 `allowedToolNames` 是固定白名单 | Agent 不会根据中间结果决定"下一步该用哪个工具" |
| **失败重规划** | DAG 某步失败 → 整个 workflow 直接 `failed` | 扫描超时不会触发降级策略，依赖失败不会重新调度 |

**当前 Plan 模式的实际流程：**

```
用户目标 → 路由评分（routing.ts）→ 匹配预定义 workflow → DAG 执行 → 完成/失败
              ↑ 这一步是"匹配"不是"规划"
```

**真正的 Plan 模式应该是：**

```
用户目标 → Commander 分析 → 动态生成步骤 DAG → 逐步执行
              ↓ (每步执行后)
         observe 结果 → 调整后续步骤 → 继续执行
                           ↓ (失败时)
                    分析原因 → 替换步骤 → 重新执行
```

**评分理由**：DAG 基础设施是好的，但规划层几乎是空的。Commander 的 system prompt 说 "decompose into concrete steps"，实际上它不做 decompose，它做的是 "select from 5 templates"。这是产品从"原型"到"可用"的最大障碍。

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

### 人在回路模式 — 安全有余、澄清为零（★★☆☆☆ 2/5）

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
| **无 AskUser 工具** | 工具描述符中没有 `commander.askUser` 或类似工具 | Agent 遇到歧义只能猜，不能问 |
| **Commander 不澄清** | `clarify-requirements` 步骤标记为 `planned`，从未实现 | 用户说"帮我看看这个项目"，Commander 不会反问"当前目录还是指定路径？" |
| **Agent 不追问** | 各 Agent system prompt 没有"信息不足时询问"的指令 | 缺参数时 Agent 用默认值填，而不是提示用户补充 |
| **无确认阈值策略** | 所有 confirmed_write 操作一视同仁 | 改一个变量名和删除一个文件的确认流程完全相同，没有风险分级 |

**评分理由**：安全回路是 Javis 的亮点——四道防线（UI → approval binding → path guard → one-shot）。但澄清回路完全没有，用户和 Agent 的交互仅限于"批准/拒绝"。桌面工作台产品的核心竞争力在于"让用户信任 Agent 能理解自己"，不会提问的 Agent 会让用户觉得不靠谱。

---

## 对比总览

| 维度 | 多 Agent 模式 | Plan 模式 | 主动澄清模式 |
|------|:---:|:---:|:---:|
| **当前评分** | ★★★★☆ | ★☆☆☆☆ | ★★☆☆☆ |
| **关注点** | Agent 间如何分工协作 | Agent 内部如何思考行动 | Agent 与人类如何交互 |
| **Javis 现状** | 9 个 Agent + DAG 调度 | 5 个静态工作流 | 安全审批完整，无澄清机制 |
| **最大短板** | 工作流不可动态组合 | Commander 不做规划 | Agent 不会提问 |
| **投产价值** | 已可用 | 核心逻辑缺失 | 安全隐患已覆盖 |

---

## 改进路线

### 第一阶段：Plan 模式核心（P0，预计 3-5 天）

```
目标：让 Commander 从"匹配工作流"变成"规划工作流"
```

| 项 | 说明 |
|----|------|
| Commander 动态规划 | Commander 接到目标后，调用 LLM 动态生成步骤列表（含 agentKind / tool / dependsOn / 预期输出），输出结构化的 `WorkbenchWorkflow` |
| Commander 智能路由 | 用户未明确选择工作流时，Commander 分析意图自动选择模式。替代当前正则关键词匹配（`routing.ts`），改为 LLM 驱动的意图分类 + 工作流推荐 |
| Agent ReAct 循环 | 每个 Agent 改为多轮循环：执行工具 → 观察结果 → 判断是否完成 → 未完成则选择下一个工具 |
| 失败重规划 | DAG 某步失败后触发 Commander 重新评估，注入失败原因到上下文，生成修正后的后续步骤 |
| 工具注册表 | 将 `descriptors.ts` 中的 21 个工具描述符暴露给 LLM 做 tool selection，替代固定 `allowedToolNames` |

**验收标准：**

- Commander 对非预定义目标（如"分析这个 Rust 项目"）能生成 ≥ 3 步的有效 DAG
- DAG 通过 `validateWorkflowDag` 校验
- 至少 5 个不同类型的用户目标（读项目、查文档、搜网页、创建提醒、代码修改）均生成合法步骤
- 动态规划失败（非法工具名 / 循环依赖）时返回明确错误而非静默跳过
- **智能路由**：用户输入模糊目标（如"帮我看看这个"）时，Commander 基于上下文（workspace 类型、文件类型、git 状态）推断最合适的工作流，准确率 ≥ 当前正则路由

### 第二阶段：主动澄清（P1，预计 2-3 天）

```
目标：让 Agent 学会提问
```

| 项 | 说明 |
|----|------|
| `commander.askUser` 工具 | 新增工具描述符 + Rust 命令。LLM 调用时暂停 DAG，UI 弹出问题卡片，用户回复后继续 |
| Commander 澄清 prompt | 在 Commander system prompt 中加入"遇到以下情况时必须先问用户：目标模糊、路径未指定、多选无法自动判断" |
| 确认阈值分级 | 将 confirmed_write 分为 `safe`（修改变量名）/ `risky`（删除文件）/ `dangerous`（修改配置），UI 警告级别不同 |
| 澄清超时策略 | 用户 5 分钟未响应 → 提示一次 → 30 分钟未响应 → 任务自动暂停（而非永久阻塞） |

**验收标准：**

- Commander 在目标模糊时调用 `askUser` 而非猜测（如"帮我看看"→ 反问"当前目录还是指定路径？"）
- 用户回复后 DAG 从暂停点继续执行
- 超时暂停的任务可在 UI 中手动恢复
- confirmed_write 分级 UI 展示：safe（蓝色）/ risky（橙色）/ dangerous（红色）

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
| Commander | `commander.plan` | read |
| File | `file.scanMarkdownDocuments`, `file.scanUserDocuments`, `file.classifyDocuments` | read |
| Shell | `shell.runReadOnlyCommand` | read |
| Code | `code.inspectRepository`, `code.proposeEdit`, `code.applyProposedEdit` | read / preview / confirmed_write |
| Research | `web.search`, `web.fetchSource` | read |
| Computer | `file.listDirectory`, `computer.openPath`, `file.scanUserDocuments`, `file.scanUserImages` | read |
| Scheduler | `scheduler.createTask`, `scheduler.updateTask`, `scheduler.deleteTask` | confirmed_write |
| Verifier | `verifier.check` | read |
| ChineseReviewer | (无工具，纯文本审校) | — |
| Browser | (类型已定义，Agent 定义缺失 — 见 `AgentKind` 含 `browser` 但 `agents.ts` 无对应条目) | read |

> **已知不一致**：`AgentKind` 类型和 `workflows.ts` 中引用了 `browser` Agent，但 `agents.ts` 的 `demoAgents` 数组中没有 Browser Agent 定义。需要补 Agent 定义或从类型中移除。
