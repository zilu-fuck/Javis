# AI 操作可见性地图

> 这份文档回答两个问题：**一次任务到底经过了哪些 AI 环节**，以及**每一环节在哪里能看到**。
> 凡是"看不到"的，这里写明原因与要改哪里，不留模糊地带。

---

## 一、全链路（从用户请求到最终回复）

```
① 用户请求
   apps/desktop App.tsx → packages/core runAgentTask

② 路由决策（确定性预路由，不是模型决定）
   runtime-chain.ts decideDispatch() → chainDecision.dispatch.kind
     ├─ direct_chat / clarification …… 聊天模式、澄清提问
     ├─ single_agent_task ………………… 文本写入（runTextWriteTask，带审批流）
     ├─ vision_task ………………………… 图像分析（走多模态槽位）
     └─ commander_task ………………… Commander DAG 主路径

③ 分析
   · DAG 路径：commander.plan（提示词含可用 agent/工具描述符 + 确定性工作区清单）
   · 文本写入：decideTextWriteContract（产出格式 / 文件名 / requirements）

④ 下发
   · DAG：CommanderDagPlan（assignedAgentKind / dependsOn / inputContextKeys / outputContextKey）
   · 文本写入：契约绑定目标名、扩展名、requirements 进生成提示词

⑤ 执行
   · DAG 步骤：legacy 直接派发工具，或命中 langchain/opencode 后端时跑真实 agent 回合
     （只放 read/preview；写入类始终走 legacy + 原生审批）
   · 文本写入：一次流式生成 → File Agent 预览（preview）→ 用户审批（confirmed_write）→ 原生写入

⑥ 汇报
   每个产出步骤写 stepReports（writeStepOutput / writeStepArtifactOutput 两个写入器）
   → 汇总进 Commander 总结所读的 evidence

⑦ 验证
   · 文本写入：确定性边界检查 → verifierTool.check
   · DAG：verifier 步骤（verifier.check）

⑧ 总结
   · DAG：commander.synthesize（模型总结，带 evidence 校验）
   · 文本写入：流程内的指挥官消息（含契约结论与验证结论）
```

---

## 二、每类 AI 操作 → 记录在哪 → 怎么看

| AI 操作 | 记录位置 | 界面可见处 | 持久化 |
|---|---|---|---|
| 模型调用（文本写入流程） | `agent.model_call` 日志行：`<purpose> tokens=N` | 任务日志 / 活动面板 | ✓ 随快照 |
| 模型调用（DAG 及其他路径） | `usage_observations` 表：call_id / agent_kind / backend / provider / model / step_id / attempt / tokens | **目前只有 `pnpm metrics`**，UI 无出口 → **缺口** | ✓ SQLite |
| 思考过程 | 实时：`streamingReasoningText`；结束后：`reasoningDigest`（脱敏 + 320 字上限）+ 日志行"思考：…" | 实时=状态块；**结束后=回答下方独立的一行折叠条**（默认显示首行摘要，点开看全文，不是消息气泡） | ✓ 摘要随快照持久化（白名单字段，见下） |
| 路由决策 | 已有 `route_decided` 日志行（任务日志里可见） | 任务日志 | ✓ |
| 产物契约 | `text_write.contract` 日志：source / format / target / requirements / reasoning | 指挥官消息 + 任务日志 | ✓ |
| 计划与步骤状态 | `TaskSnapshot.plan`、agent 状态 | 执行进度面板 | ✓ |
| 工具调用 | `tool_call_audit`（`task-audit.jsonl` + `runtime_events`） | 日志面板 / Inspector | ✓ |
| 审批决定 | `approval_records` 表 + 权限请求卡 | 审批卡 | ✓ |
| 验证结论 | `verificationSummary` + verifier 状态（pass/warn/fail/unavailable） | 完成消息 + 日志 | ✓ |
| 步骤汇报 | `stepReports`（SharedContext，保留 key `stepReports`） | Inspector 上下文 | ✓ |
| 工作区清单（规划输入） | 规划提示词数据块 | 间接（影响计划） | 仅提示词 |

---

## 三、明确看不到的内容，以及原因与打开方式

| 内容 | 为什么现在看不到 | 要打开的话改哪里 |
|---|---|---|
| 完整思维链（逐 token 全文） | 体积 + 可能含从工具观测复制的凭据；`workflow-executor.ts` 里的 `REACT_*_SECRET_PATTERN` 与 320 字上限就是为这个立的规矩 | 放宽 `reasoning-digest.ts` 的上限/脱敏策略（不建议直接存原文） |
| 发给模型的完整提示词 | 含用户目标、工作区清单、证据内容；留存等于开第二个泄漏面 | 可先记 prompt 的 hash + 长度（前缀缓存诊断已有 `cacheProbeKey` 的先例）；全文需显式开关 |
| 提供商原始流量 | 未做留存（Rust `streaming.rs` 只在内存里解析） | 在 `streaming.rs` 加调试开关 + 脱敏 |
| DAG 路径的调用台账界面 | 数据齐全，缺 UI（对应路线图 M6/E5b 未接线） | 用量面板读 `usage_observations` |
| 路由决策理由 | 只在代码里算出来，没有落进日志/消息 | 在 `decideDispatch` 结果处补一条 `routing.decision` 日志行（改动很小） |

---

## 四、现场怎么查

```powershell
# 每次模型调用的台账（读 usage_observations）
corepack pnpm metrics

# 工具调用 / agent 运行审计（原始 JSONL）
notepad "$env:APPDATA\app.javis.desktop\task-audit.jsonl"

# 任务快照（含 plan / logs / verificationSummary / reasoningDigest）
# 表：task_history.snapshot_json
```

应用内：任务日志与活动面板、执行进度、审批卡、Inspector 上下文、验证结论消息。

---

## 五、本轮为透明化所做的改动

| 改动 | 文件 | 证据 |
|---|---|---|
| 思考摘要可留存：脱敏 + 320 字上限 | `packages/core/src/reasoning-digest.ts` | 5 个单测（含"密钥被脱敏""标签/图片数据被剔除""超长被截断"） |
| 思考在步骤结束后仍可见 | `delta-reducer.ts`（chunk_end 写 `reasoningDigest` + 日志行）、`packages/core/src/index.ts` 与 `packages/ui/src/types.ts`（快照字段）、`ThreadView.tsx` + `App.css`（面板保留摘要、"思考过程 · <agent>"标签） | 3 个 reducer 单测 |
| 每次模型调用一条台账 | `text-write-flow.ts`（purpose 化 recorder → `agent.model_call` 日志） | 1 条流程级断言（三条台账按序：artifact-contract / content-generation / content-continuation） |
| 决策理由不再被丢弃 | `text-write-flow.ts`（契约 `reasoning` 进指挥官消息与 `text_write.contract` 日志） | 2 个单测 |

**已知仍未闭合**：DAG 路径的调用台账没有界面出口（数据在 `usage_observations`）；路由决策理由未落日志；提示词全文与提供商原始流量按设计不留存。

---

## 六、思考为什么长期看不到（2026-09-13 追加的根因）

思考链路的**上游是通的**（Rust 解析 `reasoning_content`/`reasoning` → 批量发 `stream-model-reasoning`），
但**下游只有一条路径转发它**：

| 流式消费点 | 之前 | 现在 |
|---|---|---|
| L1 直答（`index.ts`） | ✅ 转发 `agent.reasoning_chunk*` | ✅ |
| 指挥官**规划**（`commander.plan`） | ❌ `onChunk` 是 `() => undefined`，思考被丢 | ✅ `createReasoningStreamForwarder` |
| 指挥官**总结**（`commander.synthesize`） | ❌ 只累加 `chunk.text` | ✅ 同上 |
| 文本写入**长文生成**（`generateTextContent`） | ❌ 只处理 `chunk.text` | ✅ 同上 |

所以"看不到思考"有两个独立原因，且**第一个是我们自己的责任**：

1. **我们丢掉了它**：走规划/总结/长文生成的步骤，即使提供方发了思考也不会产生任何事件。共享转发器
   `packages/core/src/reasoning-events.ts` 把三条路径统一接上（start / chunk / end 三事件配对，
   无思考的调用不发任何事件，失败时用 `error` 关闭并保留已累积文本）。
2. **提供方可能不发**：`opencode-go` 这类中转若不回传 `reasoning_content`，就没有内容可显示。
   判定方法：换原生 DeepSeek 跑一次；若出现思考行，则是中转的差异。

**另一个曾经让"数据存在但看不见"的原因**：`sanitizeTaskSnapshot`（`apps/desktop/src/task-history.ts`）是
**白名单拷贝**，新字段若未登记会在持久化时被丢弃——`reasoningDigest` 已登记并有往返测试守住。

---

## 七、"你会做些什么"为什么会被反问（2026-09-13 追加）

任务 `task-1789308179895` 的会话快照（`task_session_log`）把过程完整记下来了：

| 时刻 | 快照 | 发生了什么 |
|---|---|---|
| 14:03:09.828 | `你会做些什么` / generating | 项目模式下发目标 |
| 14:03:12–17.388 | planning ×3 | 一次规划模型调用（`usage_observations` 累计 8194 in / 969 out，`modelCalls` 表明**没有**走修复循环） |
| 14:03:17.398 | plan = `[clarify-capability-scope]` / `能力范围澄清` | 模型的计划**只有一步**：`capability="clarification"`，标题就是问句「你希望我协助哪类任务？」 |
| 14:03:17.399 | `ask_user.requested` | 弹出问题卡（`workflow-executor.ts:5427` 是全仓**唯一**的 ask_user 事件来源） |
| 14:03:39.455 | `ask_user.responded` | 用户回答「只是问你你会做什么」 |
| 14:03:39.457–48.4 | 重新规划 → `answer-capabilities` | 这一轮模型改判为"直接回答"，产出最终答案 |

**根因**：规划提示词的歧义规则是"目标含糊时不要猜，先问一个阻塞问题"（`commander-plan-schema.ts`
第 685/711 行）。能力问题天然符合"没有目标、没有范围"的字面特征，于是模型照规则反问了——
但它的答案**全在运行时里**（agent、工具、权限模型），并不需要向用户索取信息。

**修法（三层，都是确定性的）**：

1. **提示词豁免**：同一规则里补一句"问助手自身能力（你会做些什么）不算含糊：用 direct_response 直接回答"
   （`COMMANDER_PLAN_PROMPT_VERSION` 1.6.0 → 1.7.0）。
2. **编译期替换**（兜底，模型再想反问也拦得住）：`compileCommanderPlan` 里，当目标是自述能力问题、
   且计划**只由澄清步骤组成**时，替换成一步 Commander 直接回答（`answer-capabilities`，
   `capability="synthesis"` / `executionMode="direct_response"`）。只澄清的计划不含任何工作，
   替换不会丢步骤。
3. **可追溯**：替换会在计划里留下 `SELF_CAPABILITY_ANSWER_SUBSTITUTED` 警告，
   随 `PlanGenerationTrace` 落进快照，所以"跑的计划 ≠ 模型产出的计划"这件事是能查到的。

判定用的谓词是 `isSelfCapabilityQuestion`（`agent-intent.ts`）：整句匹配 + 40 字上限，
所以「你能做什么，顺便帮我把 README 更新一下」「这个项目你能做什么」这类**带真实任务**的说法不受影响。

---

## 八、"用户发的消息不见了"是布局缺陷，不是数据丢失（2026-09-13 追加）

已完成任务的会话里"只剩助手消息、用户消息消失"，第一反应会怀疑持久化丢数据。实测不是：

- 数据库里 6 条消息**都在**（`task_history.snapshot_json.conversationMessages`，3 条 user + 3 条 assistant）；
- 真正的原因是思考条把 `.javis-thread` 的**网格轨道**撑到 2421 px（见方案文档 §5.9），
  而 `justify-self: end` 的用户气泡按轨道右对齐 → 被排到 x≈2181–2233，
  视口只有 1030 px 宽，于是**用户消息全部落在视口之外**，助手消息（左对齐）照常可见。

修复后（思考条与执行面板同列 + `overflow: hidden`）：轨道回到 1030 px，气泡回到 x≈790–842。
`pnpm e2e:smoke` 现在有一条真实浏览器里的布局断言守着这件事（已实测会失败：旧规则 → `overflowX=901px`、
气泡右边界 1828 > 视口 1000）。
