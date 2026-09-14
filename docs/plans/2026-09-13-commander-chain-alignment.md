# 方案：把文本写入与 DAG 执行拉回"指挥官链路"

**日期**：2026-09-13
**目标链路（用户定义）**：用户请求 → 指挥官收到并回复 → 指挥官分析任务 → 指挥官下发任务 → 下级 agent 执行 → 下级 agent 向指挥官汇报 → 指挥官总结并回复用户
**状态**：实施中（执行记录见文末）

---

## 一、现状与差距（均有代码级证据）

| 目标链路步骤 | 现状 | 证据 |
|---|---|---|
| ① 用户请求 | 已有 | App → core |
| ② 指挥官收到并**回复** | 只有状态文案，不是模型回合 | `text-write-flow.ts:110/121` emit 模板句 |
| ③ 指挥官**分析任务** | 文本写入目标被前置路由截流；DAG 路径的规划器**无观察能力** | `runtime-chain.ts:100`；`agents.ts:11`（commander 仅 plan/synthesize/askUser/memory.search，而其系统提示词 `agents.ts:14` 写着 "Prefer read-only evidence"） |
| ④ 指挥官**下发** | 仅 DAG 路径；文本写入是写死的分工 | `CommanderDagPlan` vs `runTextWriteTask` |
| ⑤ 下级 agent **执行** | DAG 步骤命中 langchain/opencode 后端时是真 agent 回合；但**写入被权限过滤排除在 agent 循环外** | `workflow-executor.ts:8598+`（`runtime.run` + scoped gateway）、`migratedPermissionLevels=read/preview`（~8547）；文本写入路径里 "File Agent" 只是署名 |
| ⑥ 下级**向指挥官汇报** | 结构化（context key + handoffReport），非"每次汇报到达指挥官" | `writeStepOutput`（3035/3100）、`buildHandoffReport`（1462） |
| ⑦ 指挥官**总结并回复** | DAG 路径 `commander.synthesize` 真调用；文本写入路径是**模板字符串**，且验证是**自证** | `workflow-executor.ts:791/2951` vs `text-write-flow.ts:449-470`（写入成功后无条件置 verifier=completed 并声称"已验证"） |

### 1.1 一个决定性发现：DAG 的写入路径产不出 HTML

`extractWriteTextContent`（`workflow-executor.ts:3711`）的内容来源只有两条：

1. 步骤输入里显式给的 `content`；
2. 都没有时 → `buildMarkdownFromWriteEvidence()`：**拼一个 Markdown 模板**（`# 标题` + `> Source request: …` + 各段证据）。

所以"让产物目标改走 DAG"会把 bug 换个形态（HTML 请求变成模板 Markdown），**不是修复**。这也是本方案不改 `isTextWriteGoal` 分类、不取消前置截流的原因。

---

## 二、范围（四项工作流，按实施顺序）

### W1 —— 指挥官在规划时能看见工作区（P1b）

- `agents.ts`：commander 增加 `code.inspectWorkspace`；`descriptors.ts`：`code.inspectWorkspace` 的 `ownerAgentKinds` 增加 `"commander"`。两侧必须同步，否则新的 `pnpm agent:ownership` 会拦下。
- 规划请求注入**确定性工作区清单**：在 desktop 的 `plan` 处理器（`app-runtime.ts:1907`）里，用 `code.inspectWorkspace`（只读、有界、跳过依赖目录）取一份清单，作为 `workspaceInventory` 段注入规划提示词。规划器从"凭目标文本猜"变成"看着真实目录结构决定"。
- 依据：AGENTS.md 明确要求"项目理解走 `code.inspectWorkspace` 这个确定性原语"。

### W2 —— 指挥官先决定"产物契约"，再执行（P1a 的正确形态）

- 新增 core 决策函数：给定目标（+可选工作区清单）调用一次小模型，产出 `{ format, targetPath, requirements[] }`，JSON 校验；**失败时回落到现有正则识别**（正则从"决策者"降级为"兜底"）。
- `runTextWriteTask` 流程改为：② 指挥官确认（把决策结果作为指挥官消息呈现）→ ③ 决策产物契约 → ④ 以契约为准下发（目标名、提示词、格式）→ ⑤ 执行（生成内容 + File Agent 预览/审批/落盘）→ ⑥⑦ 见 W3。
- 影响：每次文本写入多一次**小**模型调用（JSON 输出、低 max tokens）。收益：pelican 类故障从"猜错格式"变成"决定格式"。

### W3 —— 真验证 + 诚实结论（P2a/P2b）

- 把 `verifierTool` 传入 `runTextWriteTask`（core 侧从 `index.ts` 的 availableVerifierTool 取）。
- 写入后：先做**确定性边界检查**（产物存在、字节数一致、格式边界：HTML 有 doctype/闭合、无外层围栏），失败即 fail 且不浪费模型调用；通过后再调 `verifierTool.check({ stepId, successCriteria, evidence[] })` 做语义核验。
- `verificationSummary` 与 verifier 状态**由真实结果驱动**：验证不可用/未做时明确写"未独立验证"，删掉"写入成功即已验证"的自证。
- 契约（照 `workflow-executor.ts:10574` 的既有用法）：`check({ stepId, successCriteria, evidence: [{kind:"log",label,data}] })` → `{status, summary, detail}`。

### W4 —— 每步汇报到达指挥官（P3）

- 每个 DAG 步骤完成后产出**结构化步报**（step id、agent kind、状态、产出 context key、摘要、耗时），写进 `handoffReport` 并**进入总结请求的输入**（先核实是否已在；缺则补）。
- 审计/UI 可见一条"已汇报"记录。
- 明确不做：每步一次模型回复（会把一次任务变成 N 次模型调用，成本与上下文策略都需要独立设计）。这是"汇报"在**成本可接受**下的完整形态；若你要"每步都让指挥官说一句"，单独立项。

---

## 三、明确不做

| 项 | 理由 |
|---|---|
| 取消文本写入的前置截流，让其进 DAG | §1.1：DAG 的写入内容只有 Markdown 模板兜底，会换形态复发 |
| 把写入纳入 agent 运行时 ReAct 循环 | `migratedPermissionLevels` 只放 read/preview 是**安全设计**（原生审批绑定 + 一次性消费），动它等于动安全边界；保留并在文案与文档里说清 |
| 每步一次模型汇报 | 成本/上下文策略需独立设计（见 W4） |
| 改动审批链 | 与本方案无关；审批链的独立问题单独立项 |

---

## 四、测试与验证

| 层 | 内容 |
|---|---|
| 单测（core） | 产物契约决策：正常 JSON / 坏 JSON / 未知格式 / 与正则冲突时以模型为准 / 模型失败回落正则；确定性边界检查：HTML 有doctype、无围栏、尾闭合，各失败分支；verifier 结果 → 状态与摘要映射（pass/warn/fail/unavailable） |
| 单测（desktop） | 规划请求含工作区清单段；清单为空/工具失败时不阻断规划（降级） |
| 既有回归 | core 全量、desktop 全量（含既有规划提示词断言）、`agent:ownership`（W1 的两处同步） |
| 门禁 | typecheck / vitest / eval / docs / roadmap / bundle / rust / desktop build + e2e |
| 真机 | 项目模式重发 pelican 目标：确认产出 .html、进度条出现"指挥官确认/决定产物契约"、验证结论来自真验证器；另发一个必须读工作区的目标，确认规划器引用了真实结构 |

---

## 五、执行记录

### 5.1 改动清单

| 文件 | 改动 |
|---|---|
| `packages/core/src/agents.ts` | commander 增加 `code.inspectWorkspace`；系统提示词说明"决定结构或文件目标前先用它取确定性清单"（中英双语） |
| `packages/tools/src/descriptors.ts` | `code.inspectWorkspace.ownerAgentKinds` 增加 `"commander"`（两侧同步，`agent:ownership` 把关） |
| `packages/tools/src/types.ts` | `CommanderPlanRequest` 新增可选 `workspaceInventory` |
| `packages/core/src/commander-plan-schema.ts` | 规划提示词渲染"工作区清单"数据块（带"按真实结构规划、不要凭空造结构"的本地化指引；**不加新规则行**以守住既有提示词预算） |
| `apps/desktop/src/planner-workspace-inventory.ts` | 新增：把 `code.inspectWorkspace` 结果压成有界清单；工具缺失/工作区未选/载荷畸形一律降级为空串，从不阻断规划 |
| `apps/desktop/src/app-runtime.ts` | 规划处理器采集清单并随请求下发；`planParams` 带上；调用点两处传 `verifierTool` |
| `packages/core/src/text-write-contract.ts` | 新增：指挥官产物契约决策（模型决策 → JSON 校验 → 格式/文件名/要求；失败回落正则）。**格式字段为准**，文件名扩展名与之不符时改写；拒绝越界文件名 |
| `packages/core/src/text-write-verification.ts` | 新增：确定性边界检查（空载荷/外层围栏/HTML 文档边界/SVG 边界/JSON 可解析）优先，通过后才调 `verifierTool.check`；verifier 崩溃或返回畸形一律 fail |
| `packages/core/src/text-write-flow.ts` | ② 先发"指挥官正在确认产物形态"→③ 决策→④ 以契约为准（目标名/提示词/requirements）→⑤ 执行→**⑥⑦ 按真实验证结果**决定状态、verifier 状态与 `verificationSummary`（删掉"写入成功即已验证"的自证） |
| `packages/core/src/shared-context.ts` | 新增 `STEP_REPORTS_CONTEXT_KEY` + `readStepReports`；**两个产出写入器**都记录结构化步报（`writeStepOutput` 与 `writeStepArtifactOutput`——后者是 Commander-DAG 的实际路径） |
| `packages/core/src/workflow-executor.ts` | 三处 `writeStepOutput` 传入 step 身份，使步报可归属 |
| 测试 | 新增 `planner-workspace-inventory.test.ts`(7) / `text-write-contract.test.ts`(15) / `text-write-verification.test.ts`(11) / `shared-context` 步报 4 例 / `text-write-flow` +1 / desktop 规划提示词集成 +1；`index.test.ts` 与 `descriptors.test.ts` 按新流程更新既有期望 |
| `docs/qa/REAL_TEST_CASES.md`、`docs/HARNESS_ROADMAP.md` | 引用的 core 测试数 1652 → 1699（指令文档与"当前状态"更新，带日期的实测记录保持快照） |

### 5.2 目标链路逐条勾对

| 步骤 | 之前 | 现在 |
|---|---|---|
| ② 指挥官**收到并回复** | 只有模板状态句 | 先发"指挥官正在确认产物形态：<目标>"，随后给出**决策结论**："指挥官判定：产出 HTML 文件「…」"（兜底时明说"由规则兜底，非模型决策"） |
| ③ 指挥官**分析任务** | 正则猜；规划器无观察能力 | 文本写入走一次**小模型决策**（格式/文件名/要求）；规划路径注入**确定性工作区清单**，且 commander 现在真的拥有 `code.inspectWorkspace` |
| ④ 指挥官**下发** | 分工写死 | 决策结果作为**契约**下发：目标名、扩展名、requirements 全部绑定到生成提示词 |
| ⑤ 下级 agent **执行** | 写入由 legacy 桥接（安全设计，保留） | 不变，但状态/文案不再伪装成 agent 回合 |
| ⑥ 下级**向指挥官汇报** | 无结构化汇报 | 每个产出步骤写一条 `stepReports`（stepId / agent / 输出 key / 摘要 / 时间），而**总结本来就把整个 shared context 当 evidence**，因此汇报直达指挥官；因它不是步骤声明的 handoff key，不会污染 handoffReport |
| ⑦ 指挥官**总结并回复** | 模板句 + 自证"已验证" | `verificationSummary` 与 verifier 状态由**真实验证结果**驱动：pass/warn/fail/unavailable 四态，未验证时明确写"未独立验证" |

### 5.3 门禁结果（本轮全部实跑）

```
typecheck（5 包）..................... 0 错误
vitest: core 1699 / desktop 1020(+2 skipped) / ui 219 / tools 53 / sidecar 6 ... 全绿 (EXIT=0)
eval ................................ 29/29 golden tasks (100.0%)
eval:test / docs:test ............... 6 pass / 16 pass，0 fail
docs:check .......................... 0 error 0 warning
roadmap:audit ....................... 68 路径 0 缺失；计数一致（基线捕获已刷新到本轮）
bundle:check ........................ 0 error / 1 known offender
agent:ownership(+:test) ............. 19 agents / 62 tools / 0 漂移；自测通过
rust:test ........................... 599 passed, 0 failed
desktop build + e2e:smoke ........... 构建成功；rendered=true 9184 chars，地标 3/3，0 错误
```

### 5.4 过程中发现并修掉的两个真实缺陷（我自己引入/暴露的）

1. **决策后的取消检查写成 `throwIfTaskAborted`，位于 `try` 之外**，而本流程在 index.ts 是 `void` 启动（即发即忘）→ 取消时异常逃逸成 **2 个未处理的 rejection**（vitest 报 "Errors 2"、退出码 1，但所有用例通过——很容易被误读为"全绿"）。改为流程既有的"检查 `signal.aborted` 后 `return`"。
2. **验证文案只有英文**：`verificationSummary` 是用户可见文案，按仓库双语约定改为本地化（含状态标签：已验证 / 未独立验证 / 验证有保留 / 验证未通过）。

### 5.5 本轮追加：AI 操作透明化（T1–T3）

| 项 | 改动 | 验证 |
|---|---|---|
| **T1 思考可留存** | 新增 `packages/core/src/reasoning-digest.ts`：把模型思考脱敏（复用 `sensitive-data.redactSensitiveText`）+ 剔除 `thinking` 标签与图片数据 + 限长 320 字；`delta-reducer` 在 `agent.reasoning_chunk_end` 写入快照字段 `reasoningDigest`/`reasoningDigestAgentKind` 并追加一条"思考：<摘要>"日志；`ThreadView` + `App.css` 让面板在流式结束后继续展示该摘要（标题"思考过程 · <agent>"），不再随流式结束而消失 | 5 个 digest 单测 + 3 个 reducer 单测；core 1710 |
| **T2 调用台账** | 文本写入流程的 recorder 改为带 `purpose`，每次调用记一条 `agent.model_call` 日志（`artifact-contract` / `content-generation` / `content-continuation`），随完成快照落盘 | 流程级断言：三条台账按序出现 |
| **T3 链路与可见性地图** | 新增 `docs/AI_OPERATION_VISIBILITY.md`：八段链路 + 每一类 AI 操作的记录位置/界面出口/是否持久化 + "明确看不到的内容及原因与打开方式" + 现场查询命令 | 文档门禁通过 |
| **附带修复** | 决策理由不再被丢弃：契约 `reasoning` 现在进指挥官消息与 `text_write.contract` 日志 | 2 个单测 |

**过程中我引入的一个真实缺陷（已被新断言抓住）**：T2 的 recorder 起初引用 `artifactFormat`，而该变量在决策调用**之后**才声明 → 决策那次调用无法记账（`artifact-contract` 台账缺失）。去掉前向引用后三条台账齐全。**诚实说明**：我未能完全复现"异常被 `decideTextWriteContract` 的 catch 吞掉"这一步（决策结果当时仍生效、产物名仍是模型选的），所以执行记录里不把它写成定论，只保留约束——**recorder 不得引用其调用点之后声明的绑定**，并已写进代码注释。

**本轮明确不做（附理由）**：
- **路由决策理由落日志**：`runAgentTask` 这一层作用域内只有 `controller`，没有日志/事件通道；在此 emit 一个尚未成型的快照会干扰各流程自己的计划语义，而把 routing 决策透传进 8 条流程会改动全部签名。插入点与理由已写进 `docs/AI_OPERATION_VISIBILITY.md` §3，作为独立小项。
- **提示词全文与提供商原始流量**：按设计不留存（含用户目标/工作区清单/证据，属第二泄漏面）。文档中给出"hash+长度"这类折中与显式开关的位置。
- **DAG 路径调用台账的 UI**：数据已在 `usage_observations`（`pnpm metrics` 可读），缺的是界面出口，对应路线图 M6/E5b。

### 5.7 布局与持久化修复（使用者反馈驱动）

使用者的两张截图暴露了两个不同的问题，均已修复：

1. **思考被渲染成"又一条助手消息"**（复用 `javis-message` 类 → 带头像气泡、追加在回答之后）。
2. **折叠后无处展开**：把摘要移进「执行详情」的折叠体里，用户反馈"没有地方能展开看"。
   最终形态：回答下方**独立的一行折叠条** `javis-reasoning-digest`（标题 + 首行摘要 + ▸/▾），默认折叠、点开看全文，且**不再是消息气泡**。CSS 在 `App.css`。
3. **真正的数据根因（我漏掉的一环）**：`apps/desktop/src/task-history.ts` 的 `sanitizeTaskSnapshot` 是**白名单拷贝**——我的新字段没被复制，于是**持久化时被丢弃**，任务一从历史水合，思考就没了（数据库里最新任务确实查不到 `reasoningDigest`）。已加白名单字段 + 类型守卫，并补"往返存活"测试。

验证：ui 221（含"可见预览 / 默认折叠 / 点击展开 / 非气泡 / 不埋在详情里"1 例）、desktop 1022（含往返存活 2 例）。

**观察（非本次改动引入）**：全仓四包并行跑时，`uses English planner few-shot rules...` 偶发超时失败（单独跑与 desktop 整包跑均通过）。属既有测试在满载下的抖动，未擅自改动。

### 5.8 思考可见性的真正根因（第三次反馈驱动）

使用者的两张截图（有思考 / 无思考）对照后定位到**两个独立原因**：

1. **我们自己的流式消费点丢掉了 `chunk.reasoning`**：全仓只有 `packages/core/src/index.ts:3827`（L1 直答）转发思考事件；指挥官**规划**（`onChunk` 是 `() => undefined`）、指挥官**总结**、文本写入**长文生成**三处只处理 `chunk.text`。因此走规划/总结路径的答复（正是使用者最近两次）连思考事件都不会产生。
   - 修复：新增 `packages/core/src/reasoning-events.ts` 的 `createReasoningStreamForwarder`（start/chunk/end 配对、无思考不发事件、失败用 `error` 关闭并保留已累积文本），接入上述三处 + 从 core 导出（`index.ts:65`）。
   - 测试：转发器 6 例；core 1716。
2. **持久化白名单丢弃新字段**（上一节已修）：`sanitizeTaskSnapshot` 是白名单拷贝，`reasoningDigest` 未登记 → 任务从历史水合后思考消失。已登记 + 往返测试。
3. **提供方是否回传思考**仍未验证（`opencode-go` 中转为未知项）：判断方法是换原生 DeepSeek 跑一次；我不解密使用者密钥去探测端点。

**顺带纠正**：`route_decided` 日志**本来就存在**（使用者的任务快照里可见），我在可见性地图里曾把它列为缺口——已更正。

### 5.9 "为什么会进问答环节"与"思考条把窗口撑大了"（第四次反馈驱动）

使用者两问。两个都用实测证据回答，而不是推测。

**问一：为什么"你会做些什么"又弹出澄清卡，AI 在哪理解错了？**

从 `task_session_log` 把 `task-1789308179895` 逐帧调出来（结论见 `docs/AI_OPERATION_VISIBILITY.md` §七）：
14:03:09 收到目标 → **一次**规划模型调用（`usage_observations` 8194 in / 969 out，`modelCalls` 显示**没走**修复循环）
→ 14:03:17.398 产出的计划**只有一步** `clarify-capability-scope`，标题就是问句「你希望我协助哪类任务？」。
错在规则的字面应用：规划提示词第 685/711 行写的是"目标含糊时不要猜，先问一个阻塞问题"，
能力问题天然"没有目标、没有范围"，于是模型合规地反问了——而答案其实全在运行时里。
（顺带纠正一个我曾怀疑的方向：这不是路由竞争，也不是修复循环逼出来的。）

修法三层：提示词豁免（`COMMANDER_PLAN_PROMPT_VERSION` 1.7.0）+ 编译期确定性替换
（只由澄清步骤组成的计划 → 一步 `answer-capabilities` 直接回答）+ `SELF_CAPABILITY_ANSWER_SUBSTITUTED` 警告留痕。
谓词 `isSelfCapabilityQuestion` 整句匹配 + 40 字上限，"你能做什么，顺便帮我把 README 更新一下" 之类不受影响。

**问二：是不是思考条把内部窗口撑大了？是。**

用一个真实 Chromium 页面（`App.css` 原样引入，DOM 复刻 `.javis-thread` 的网格子项）量的。
探针留在 `.dsh-tmp/layout-probe/index.html`（被 gitignore，可重跑：仓库根起 `python -m http.server 8788` 后打开
`http://127.0.0.1:8788/.dsh-tmp/layout-probe/index.html`，页面里的 `probeReport()` 会打印对照数据）：

| 状态 | `.javis-thread` clientWidth | scrollWidth | 溢出 | 右对齐项位置 |
|---|---|---|---|---|
| 修复前 | 1030 px | **2421 px** | **+1391 px** | 用户气泡被推到 x=2233 |
| 修复后 | 1030 px | 1030 px | 0 | 用户气泡回到 x=842 |

机理：思考条是 `.javis-thread`（`display:grid`）的子项，里层预览是 `white-space: nowrap`，
它的 **min-content 宽度 ≈ 一行 320 字的真实宽度（~2000px）**；`max-width: min(760px, 78%)`
在网格轨道定尺阶段按"百分比不可用"处理，于是**轨道被撑到 2421px**，容器出现水平滚动条，
`justify-self: end` 的用户消息/卡片全部错位。把思考条改成和执行面板 `.javis-execution-summary`
同一套写法（`width: min(780px, calc(100% - 108px))` + `min-width: 0` + `margin-left: 68px` + `overflow: hidden`）后：
溢出 0，思考行左边界 106 / 宽 780，与执行面板**逐像素对齐**。实时思考面板 `.javis-reasoning-stream` 同列处理。

**同一个缺陷的第二个症状：用户消息"消失"**（使用者随后反馈"用户发的消息也没有了"）。
这不是新问题——`justify-self: end` 的用户气泡是按**轨道**右对齐的，轨道被撑到 2421 px 后，
它们被排到 x≈2181–2233，而视口只有 1030 px 宽。用真实对话内容（从快照导出的 6 条消息）复现：

| 被测样式 | 轨道宽 | 三条用户消息的 x | 视口内可见？ |
|---|---|---|---|
| 修复前 | 2421 px | 2233 / 2233 / 2181 | **全部不可见** |
| 修复后 | 1030 px | 842 / 842 / 790 | 全部可见 |

所以"用户的消息没了"和"有点点错位"是**同一条根因**：右对齐内容按被撑宽的轨道排布。
截图对比也一致：修复前只有助手气泡在左侧可见，用户气泡的位置是一片空白。

**诚实说明**：截图（PNG 像素分析）只能证明"有约 2100–2400px 的幽灵宽度"和"思考行比相邻卡片靠左"，
坐实"就是思考条"靠的是浏览器里的对照实验（隐藏它 → 溢出归零；恢复旧规则 → 溢出复现）。
同一探针还顺手排除了"普遍性隐患"：把 320 字的无空格长串塞进 `.javis-message` 的正文，轨道仍为 1030 px，
说明问题只出在思考条这一处写法，不是全仓消息布局的通病。

**防复发**：`scripts/e2e/smoke.mjs`（`pnpm e2e:smoke`，已在 `pnpm check` 里）新增布局断言——在同一次
真实浏览器运行中注入 `ThreadView` 结构探针，断言 `.javis-thread` 不横向溢出且右对齐气泡不越界。
**该断言已实测会失败**：把旧规则临时写回构建产物后运行 → `overflowX=901px`、`userBubbleRight=1828/1000`，
非零退出；恢复修复后 → `overflowX=0`、`927/1000`，通过。

### 5.6 未决 / 未完成

- **真机复验（部分已由使用者的实机截图证实）**：应用带新代码启动后，使用者截图显示本次目标已走新链路：
  - 指挥官消息为 **「指挥官判定：产出 HTML 文件「pelican-bicycle-2d-animation.html」」**，且**没有**"由规则兜底"后缀 → `contract.source=commander`，是**模型决策**而非正则；
  - 文件名是**语义命名**（`pelican-bicycle-2d-animation.html`），而正则路径会产出 `一个-html-内容是-svg-绘制…` 这类 slug → 直接证明 W2 在真机生效；
  - 进度条处于「正在准备文本文件写入 · 规划中 20%」，第 3 步（生成）尚未开始。
  - 我此前因**前台全屏游戏**主动停止了 GUI 操作（未抢焦点、未发送输入），因此**完成态**（写入结果与 `verification=` 结论）仍需下一次复验：项目模式重发同一目标，确认产出 `.html`、内容可渲染，并核对审计行 `text_write.contract source=commander format=.html` 与 `verification=<pass|warn|fail>`。
- **`writeStepArtifactOutput` 的步报覆盖**：已实现，但"每一步一次模型汇报"**刻意不做**（一次任务变 N 次模型调用，成本与上下文策略需独立设计）。
- 规划器权限：commander 现在拥有 `code.inspectWorkspace`，但**规划提示词之外**的 ReAct 使用未验证（规划是一次 completion，不是工具循环）；若要"规划时真的自己去看"，属于运行时改造，单独立项。
- **思考过程可见性**（本轮新增的发现与部分修复）：
  - 链路本身是通的：Rust（`lib.rs:1585` 提取 `reasoning_content`/`reasoning` → `streaming.rs:274` 批量 → 事件 `stream-model-reasoning`）→ `model-provider.ts:381` → `delta-reducer.ts:61` 按 agent 聚合 → `ThreadView.tsx:583` 有专门面板。
  - **但面板只在流式进行中显示**（`showStreamingResponse = showStreaming && isActiveTask && !hasActivePrompt`），且 `streamingReasoningText` 只在 `TaskSnapshot` 上，**不落盘、不进历史**。
  - 已修：产物契约决策的 `reasoning`（一句判断理由）此前被解析后丢弃，现在会**出现在指挥官消息里**并写入 `text_write.contract` 日志（`reasoning=`），新增 2 个用例。
  - 仍未验证：使用者当前模型走 `opencode-go` 中转，**是否回传 reasoning 增量未知**（无明文密钥可探测）。若中转不传，UI 再改也看不到内容。
  - 未做（需设计）：把思考做成**可回看**的记录，必须先定长度上限与脱敏规则——仓库已有先例可循（`MAX_REACT_REASON_LOG_CHARS = 320`、`REACT_REASONING_*` 剥离正则，以及"推理文本可能含从工具观测复制的凭据"的注释）。
