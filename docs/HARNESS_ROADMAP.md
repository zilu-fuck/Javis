# Javis Harness Roadmap

> 目标：把 Javis 做成一个**通用、好用、多 Agent 协作、可客制化**的本地工作台 / Agent Harness。
>
> 本文件是这份目标的**唯一勾选式账本**。规则：只写可验收的条目；每条要么有测试，要么有可量化证据；完成才打勾。

---

## 0. 先对齐一条判断：这个仓库有两条轴，不要混

| 轴 | 目标 | 现有文档 |
|---|---|---|
| **证明轴**（Proof） | 把已实现的能力盖上"产品可用"的章 | `docs/PRODUCT_READINESS.md`、`docs/MULTI_FUNCTION_AGENT_WORKBENCH_GAP_ANALYSIS.md`、`docs/qa/PRODUCT_WORKFLOWS.md` |
| **harness 轴**（本文件） | 抽象层 + 可靠性地基 + 扩展协议，让它**通用、好用、可客制化** | 本文件 |

两条轴不冲突，但**不能互相替代**。证明轴的"Recommended Next Steps"七条全是去补 QA 截图；如果只走那条轴，结果是「能力越来越宽，但越来越不好用、越来越难改」。

**通用化的顺序判断**：先可靠性（A/F），再扩展（B/C），最后协作与体验（D/E）。

---

## A. 地基可靠性 —— 不做这层，"通用"就是"通用地崩"

| # | 状态 | 条目 | 验收 |
|---|---|---|---|
| A1 | ✅ | **快照写放大**：`task_session_log` 单表曾 397 MB / 49,950 行；单个 8 分钟任务写 34,577 行 / 93.5 MB；任务已终态后仍以 ~52 次/秒重复写同一快照 15,929 次 | 见 §A1 明细 |
| A1a | ✅ | 写入去重：连续相同快照只写一次 | `task-session-log.test.ts` |
| A1b | ✅ | 状态跳变立即写（保证每个状态可续跑） | 同上 |
| A1c | ✅ | 同状态写入节流（默认 1.5s/任务） | 同上 |
| A1d | ✅ | 原生保留策略命令 `runtime_history_maintain`（会话日志 + workflow checkpoint 的每任务上限 + 超期清理 + 条件 VACUUM） | `database.rs` 8 个单测 |
| A1e | ✅ | 启动时执行一次带 VACUUM 的清理；任务终态后执行只删不 VACUUM 的节流清理 | `App.tsx` 接线 |
| A1f | ✅ | **生产级回归门禁**：TS 侧模拟 26,729 次通知（10,800 流式 + 15,929 终态重复）断言写入 < 500 行且终态后零写入；Rust 侧在 34,777 行真实体量上验证 prune 正确且有界 | `task-session-log.test.ts` + `task_session_log_prune_handles_production_volume` |
| A1g | ✅ | `workflow_checkpoints` 同类收敛（并入原生命令；711 → 76 行） | Rust 4 个单测 + 真实库实测 |
| A1h | ✅ | **52 次/秒重复通知的根因已定位并修复**：`index.ts` 的 eventBus→runtime 桥只校验 taskId、不校验终态，任务失败后仍在跑的模型流持续投递 delta → 每次通知都持久化一行；又因 sanitize 会剥掉 `streamingText`，这些行看起来字节相同。新增 `shouldAcceptRuntimeDelta` 终态拒绝 | `runtime-state.test.ts`（4 例，含"续跑复用 taskId 仍可流式"） |
| A1i | ✅ 决策完成 | `workflow_checkpoints` 只写不读：决定**保留写入**（已被每任务 20 条上限约束），恢复路径未接的问题归入 D6；本轮不再扩大范围 | 决策记录于本节 |
| A2 | ✅ | **跨语言 SQL 契约门禁**：`db_execute` / `db_select` 只接受手工维护的精确语句形状清单，漏登记就只在**运行时**炸（已真实发生：`Durable persistence failed in runtime-event-sink`）。新增门禁：Rust 测试扫描桌面 TS 源码 → 提取全部 SQL 字面量 → 解析 `${CONSTANT}` 表/列插值 → 断言 Rust 校验器接受每一条 | 见 §A2 明细（并已借它抓出 2 个真实缺陷） |
| A3 | ✅ | **超时与看门狗**：text-write 180s 硬超时导致 `文本内容生成失败` 且丢弃已生成正文；另有任务挂起 257 分钟。已实现 `withStallWatchdog`（60s 无进展即失败）+ 生成预算与任务预算分离 + 中断保留可用正文 | `task-wait.test.ts`（9）+ `text-write-flow.test.ts`（9） |
| A4 | ✅ | **工具输出 schema 降级**：`code.searchRepository output.actualFound[27].line must be a integer` 这类单条脏数据会杀死整个任务；该工具是失败榜首（58 次 / 全期工具失败 98 次）。已实现边界强制 + 有界单条丢弃 + 修复记录入上下文 | 见 §A4 明细 |
| A4b | ✅ | 修复记录不再只进 console：新增 `tool-output-repairs.ts`（有界环形日志 + 按工具汇总 = "修复率"分子），并镜像进 `SharedTaskContext` 的 `toolOutputRepairs` 键，随任务制品传递 | `tool-output-repairs.test.ts`（8）+ `workflow-executor.test.ts` 断言落到上下文 |
| A5 | ✅ | **上下文预飞预算**（真实 400：`requested 1259929 tokens > 1048565`）。**调查推翻了原假设**：历史早已被 `selectModelContextMessages` 按 64k/256k 上限裁剪，1.26M tokens 不可能来自历史 → 真正未受约束的是**当前回合的 prompt**（粘贴的长文档 / 注入的 `@document` 引用）。落地 `chat-turn-budget.ts`：按窗口计算回合预算并截断，保留首尾、保留换行格式 | `chat-turn-budget.test.ts`（7）+ `index.test.ts` 正常回合不受影响 |
| A6 | ⬜ | 终态不可再写；流式 producer 显式 join/abort；"任务数 vs 写入行数"不变量 | — |
| A7 | ⬜ | **失败可解释性**：`Some steps failed` 28 次、`模型请求失败` 13 次无下一步。统一失败信封（kind + 人类可读 + 可执行下一步） | — |
| A8 | ⬜ | 数据目录单点化 + 孤儿文件体检（`%APPDATA%\javis\javis.db` 是 0 字节野文件） | — |

### A1 明细与实测收益

策略（`database.rs::prune_task_session_log` / `prune_workflow_checkpoints` + `runtime-history-maintenance.ts`）：

1. 每个任务的**最新一行永远保留** → `resumeLatestTaskSessionSnapshot`、rewind、`latestByTaskId` 仍可用；
2. 在此前提下，每任务只保留最新 `keepLatestPerTask`（会话 100 / checkpoint 20）条；
3. 除规则 1 的那一行外，早于 `retainDays`（默认 30 天）的记录删除；
4. **checkpoint 若其 run 仍有 `approval_records` 记录则永不删除** —— 这是唯一会读回 checkpoint 的生产路径
   （`App.tsx` 的 durable approval-resume 通过 `latestByRunId` 读取）。runtime-event compaction **不依赖** checkpoint
   （它按 `runtime_events` 校验终态 run），所以 approval 是唯一约束；
5. 仅当可回收页 ≥ 16 MB 才 VACUUM（VACUUM 会重写整个文件，不能每次都做）。

**为什么是原生命令而不是 SQL**：通用 `db_execute` 通道只接受一份手工维护的精确语句形状清单，且明确拒绝 VACUUM（见
`rejects_unknown_or_dangerous_execute_statements` 测试）。这与既有 `approval_records_prune` / `runtime_events_compact` 的先例一致。

**在真实数据库副本上的实测**（2026-09-12 数据，`keepSession=100`，`keepCheckpoints=20`，`retainDays=30`）：

| 指标 | 清理前 | 清理后 |
|---|---|---|
| 库文件 | 464.6 MB | **14.9 MB（−96.8%）** |
| `task_session_log` 行数 | 49,950 | **494** |
| `workflow_checkpoints` 行数 | 711 | **76** |
| 两表合计载荷 | 456.7 MB | — |
| 耗时 | — | prune 1.5s + VACUUM 0.3s |

**顺带发现**：`workflow_checkpoints` 在生产中**只写不读**（除 approval-resume 的 `latestByRunId` 之外）：
`WorkflowCheckpointStore.latestByTaskId` / `listByTaskId` / `pruneByTaskId` 三者都没有生产调用者。
也就是说 Phase 3/4 的 workflow 恢复路径目前只在 approval 场景落地，其余快照纯属存储成本 → 见 A1i。

### A2 明细：为什么是"门禁"而不是"把白名单换成结构校验"

原计划是"把精确形状白名单换成结构校验"。真读了测试规格后改了结论：现有负例清单**故意拒绝**若干看起来合理的语句——
`DELETE FROM task_history WHERE status = ?`、`INSERT OR REPLACE INTO resource_scan_roots ...`、
`UPDATE resource_scan_roots SET enabled = ? WHERE id = ?` 都被要求拒绝，因为它们**走专用原生命令**而不是通用 SQL 通道。
所以纯结构校验会**削弱**安全边界，而不是改进它。

真正咬人的是另一个方向：**新增一条合法语句却忘了登记 → 只在运行时炸**。因此落地为跨语言门禁：

- `apps/desktop/src-tauri/src/database.rs` → `mod sql_ipc_contract`：
  扫描 `apps/desktop/src/**/*.ts(x)`（排除 `*.test.*`）→ 提取字符串字面量 → 按动词+必需子句过滤 → 解析 `${CONSTANT}`
  插值（读同文件 `const NAME = "literal"`）→ 断言 `validate_sql` 接受每一条；
  无法解析的插值替换为 `?`，从而**暴露**成表/列拒绝而不是被静默跳过。
- 覆盖量：**185 条语句受检、14 条显式豁免**（豁免必须写明理由：routed 到专用命令，或在调用点拼装的分片）。
- 反向保护：`gate_detects_a_forgotten_registration` 保证门禁不是空转；实测新增一个未登记语句会立刻红并指出文件与原因。

**它当场抓出 2 个真实缺陷（已修）**：

| 缺陷 | 影响 | 修复 |
|---|---|---|
| `tool-call-audit.ts` 的 `SELECT_RECENT_TOOL_CALL_AUDIT_SQL` 未登记 | `App.tsx` 初始化链中**无 try/catch** 调用它；初始化链只有一个 `.catch()`，抛错会中止其后全部初始化（含 workspace 定义加载）。即每次启动都会静默退化 | 在 Rust 允许清单登记该查询形状 + 补测试 |
| `usage-observation-persistence.ts` 的按任务查询缺 `LIMIT 10000` | 与已登记形状不一致 → `listByTaskId` 一旦被调用必然抛 `db_only allows known app query shapes` | 补上 `LIMIT 10000`（保持有界读，与既有登记形状一致） |

---

### A4 明细：工具输出为什么不能"一个字错就整任务失败"

`validateToolDescriptorOutput`（`workflow-executor.ts`）以前把 `validateToolSchema` 的任何一条诊断直接 `throw`。
工具**输出**是工具实现产生的，不是模型产生的，所以一个数组里第 28 个元素的 `line` 是 `"27"` 不该判整个任务死刑。
真实日志里这类失败至少 3 次：`actualFound[27].line must be a integer`、`entries[0].sizeBytes must be a number`、
`output[19].heading must be a string`。

新增 `repairToolSchemaValue`（`packages/tools/src/tool-schema-validation.ts`），只做两件**有界**的事：

1. **强制类型**：仅当 schema 明确写了标量类型且转换无歧义时——`"27"` → `integer`、数字/布尔 → `string`、
   `"true"/"false"` → `boolean`、可选字段的 `null` 丢弃。**声明了 `enum` 就绝不转换**（否则等于替模型编意图）。
2. **丢弃坏元素**：只对**顶层数组**或**顶层对象里的数组属性**生效，且必须同时满足
   `dropped ≤ maxDroppedItems`（默认 20）与 `dropped / total ≤ maxDroppedRatio`（默认 10%）。
   超界即判为"形状错了"而不是"某一条脏了"，照旧失败。

未声明字段、缺必填字段、容器类型错误等一律仍然失败——**没有放宽任何安全属性，只是不再让一个标量致命**。
修复后的值会**替换**原始输出写入 SharedContext（否则下游拿到的还是脏数据）。

两个实现细节值得记下来：

- **不要无脑拷贝**：初版对每个输出都做了深拷贝，结果打挂了两个 provenance/artifact 哈希测试——
  它们依赖"写进 context 的对象就是工具返回的那个引用"（事后篡改才能被哈希比对发现）。
  现在 `repairs.length === 0` 时**原样返回入参**，既保住引用语义也避免对大输出做无谓深拷贝。
- **输入侧刻意不动**：`code.searchRepository input contains an undeclared field: workspaceEvidence` 这类输入失败
  是**有测试保护的既定行为**（`descriptors.test.ts:153` 明确断言要拒绝），且输入校验是网关的注入防线。
  只放宽输出，不动输入。

**告警现状（诚实说明）**：修复记录现在进有界日志 + `SharedTaskContext.toolOutputRepairs`（随制品/handoff 传递），并有按工具的汇总可直接作为"修复率"分子；**Inspector 上的可视化面板仍未做**（需要 UI 侧读取），记为 A4b 的剩余化妆品部分。

---

## B. Harness 抽象层 —— "通用"的技术前提

- [ ] **B1** 收敛唯一 `AgentRuntime` 协议；清掉或明确标注残留 ReAct（`packages/core/src` 仍有 195 处引用，而 commit `fd2099c` 声称已删除 legacy ReAct）
- [x] **B2** **声明式 Agent**（核心层 `applyAgentDeclarations`，15 测试）：`allowedToolNames` **替换**白名单（可收窄）而
  `additionalToolNames` **追加**（收窄不会被静默补回）；`systemPrompt` 按语言逐语覆盖，未给的语言保留内置；
  声明了不存在的 kind 且**提供了 persona** 才允许创建新 agent（不提供persona 直接报错，不替它编造人格）；
  `modelSlot` / `maxIterations` 作为 runtime override 单独返回，不污染 `Agent` 契约。15 个单测（含对真实 `demoAgents` 的用例）
- [x] **B2b** 运行时接线：启动时把声明的 agent **注册进既有 registry**（`register(agent, { allowKindReplacement: true })`）——
  必须是原地注册而非换对象，因为运行时在构造时就捕获了 registry 引用；合并结果新增 `changedAgents` 只返回被改动的 agent，
  避免每次启动重注册整套班底。3 个 registry 级测试证明改白名单/加新 kind 真的生效
- [ ] ~~B2c~~（不设：`.javis/agents/*.md` 的 frontmatter 形式已由 `config.json` 的 `agents[]` 覆盖，不再引入第二种写法）
- [x] **B3** **工具注册协议**（`packages/tools/src/tool-declaration.ts`，18 测试）：声明校验（`{category}.{action}` 命名、
  capability tag `lower_snake_case`、schema 自洽性——`required` 必须在 `properties` 里、`pattern` 必须能编译、`array` 缺 `items` 给警告）、
  按名合并（只覆盖声明里出现的字段；`capabilityTags`/`ownerAgentKinds` **整体替换**，避免收窄 owner 后被静默补回）、
  新增/覆盖/禁用三类结果分类。**关键不变量：配置层只能收紧权限，绝不能放宽**——`confirmed_write → read` 直接报错拒绝
  （否则一份签入仓库的配置文件就能绕开原生审批边界）。**已接线**：`.javis` 声明 `disabled: true` 的工具会真正从可用描述符里消失
- [ ] **B3b** 把"新增/覆盖"的工具描述符接进运行时描述符源（目前 `disabled` 已生效，added/overridden 仅校验与合并）
- [~] **B4** **拆巨石（第一刀已落）**：`packages/core/src/workflow-executor.ts` **15,054 → 14,847 行**，
  抽出 `packages/core/src/tool-dispatch-guards.ts`（234 行，22 个新测试）——这是**每次工具调用都要过的边界**：
  输入校验（schema、必填字段各类型、payload 体积、shell/computer 专用守卫）与输出校验（**可修复的机械错误就地修复并上报**、
  不可修复才抛错、体积限制）、以及超时取小。抽出的理由不只是行数：一个"失败即关闭"的守卫不该埋在 15,000 行文件里找不到、也不好测。
  **这只是一刀，不是解决方案**：还剩 `App.tsx` 6,597 行、`computer-use-loop.test.ts` 8,480 行，以及 `workflow-executor.ts` 内
  仍然混着的大量职责（能力派发、验证/综合、PDF/研究等流程）需要继续按接缝切分
- [~] **G2b 前端 bundle 拆分**（第一刀已落，**根因未查清**）：`apps/desktop/vite.config.ts` 原先的规则把**除 React 外的所有
  `node_modules` 塞进一个 `vendor` chunk**，构建报告 ~**4.9 MB**。改为按依赖族拆分后（`vendor-react` / `vendor-langchain` /
  `vendor-tauri` / `vendor`），实测：

  | chunk | 之前 | 之后 |
  |---|---|---|
  | `vendor`（大杂烩） | **4,945 kB** | **4,309 kB** |
  | `vendor-langchain` | — | 620 kB |
  | `vendor-tauri` | — | 15 kB |
  | `vendor-react` | 198 kB | 189 kB |

  收益是**可缓存性**：改应用代码不再让一个 4.7 MB 的大块失效，langchain 单独可缓存。
  **但 4.3 MB 的大块仍未查明来源**（langchain 只占其中 620 kB），所以：
  ① `chunk larger than 500 kB` 的告警**仍然存在**，只是现在能归因到具体 chunk 而不是一个"杂项袋"；
  ② 已找到两条线索待查：扫这个 chunk 发现里面含 **`child_process` 与 `node:` 前缀**——**浏览器 bundle 里出现 node 专用入口**，
  说明某个依赖的 node 版入口被打了进来；`zod` 出现 348 次（被完整打包）。
  下一步应当用 `rollup-plugin-visualizer` 或 `vite build --debug` 的模块图**定位贡献最大的模块**，再决定是懒加载还是排除 node 入口。

  **✅ 根因已查明（用实测，不是猜）**：新增 `scripts/analyze-bundle.mjs`（用 Vite JS API 的 `generateBundle` 累加每个模块的
  `renderedLength`，按**包名**聚合，避免上百个小模块掩盖真凶），跑真实构建得到：

  | 包 | 打进 bundle 的体积 |
  |---|---|
  | **`typescript`（TypeScript 编译器本体！）** | **9,240 kB** |
  | `langsmith` | 440 kB |
  | `zod` | 318 kB |
  | `@xterm/xterm` | 285 kB |

  也就是说 `vendor` 里那条 4.3 MB（未 gzip 前约 10 MB rendered）**几乎全是 TypeScript 编译器**。
  来源已定位到**唯一一处**：`apps/desktop/src/repo-intelligence-service.ts:11` 的 `import * as ts from "typescript"`，
  而 `app-runtime.ts:154-159` **急切导入**该服务。**这是真实缺陷而非体积问题**：编译器是构建期工具，
  放进渲染进程等于每次冷启动都白付一次。

  **✅ 已修复（本轮，实测前后对比）**：修法比预估的小——该服务在 `app-runtime.ts` 里每个导出符号恰好只有 1 个使用点，
  而两处调用点**都已在 async 处理函数内**，所以只需 **2 处插入**：
  ① 模块级惰性加载器（缓存 Promise，`await import("./repo-intelligence-service")`），删除静态导入；
  ② 两个调用点各加一行解构。**另需一步关键动作**：给 `typescript` **单独的 chunk**——
  否则 `manualChunks` 会把编译器留在被入口**静态**引入的 `vendor` 里，动态导入**只是引用它而无法把它移出首屏**。
  实测结果：

  | chunk | 修复前 | 修复后 |
  |---|---|---|
  | `vendor`（**首屏急切**） | 4,309 kB | **711 kB**（−83%） |
  | `vendor-typescript`（**按需**） | 混在 vendor 里 | 3,571 kB / gzip 1,023 kB |
  | `repo-intelligence-service`（按需） | 混在 index 里 | 29.7 kB |

  **惰性已核实**：入口 chunk 只是通过 Vite 的 `__vite__mapDeps` 惰性清单引用它，真正的动态导入目标是该服务 chunk。
  desktop 1012 个测试全绿（行为未变）。

  **✅ 已加的防复发闸门**：`scripts/check-bundle-hygiene.mjs`（`pnpm bundle:check`，已接入 `pnpm check`）——
  规则是"渲染进程代码**不得静态导入**构建期/node 专用包"（`typescript` / `playwright` / `node:fs` / `node:child_process`…），
  已知的那一处用**带理由的允许清单**容忍并只报 warning。**实测过它会失败**：注入一个 `import * as fs from "node:fs"` 的探针文件后
  如实报 ERROR 且非零退出，删除后恢复 0。
- [ ] **G2c** 前端首屏懒加载（把只在一部分功能里用到的依赖改为动态 import）——需先完成 G2b 的定位
- [ ] **B5** `RuntimeEvent` / `ArtifactEnvelope` / `SharedContext` / `WorkflowCheckpoint` 收敛成一份与代码对齐的对外契约（`docs/CORE_CONTRACTS.md`）
- [ ] **B6** preset 提升为一等公民（agents + tools + 权限策略 + 模型槽 + 提示词版本，可导入导出 / A-B）

---

## C. 客制化表面 —— 让用户改什么

> 已有底子：`apps/desktop/src/workspace-loader.ts` 的 `WorkspaceDefinition`（id/title/icon/agents/workflows/routes/侧边栏）+ `workspace.scaffold`（LLM 生成）。**但它只管"领域包"，管不到 harness 本身。**

- [x] **C1** 配置模型（核心层）：`.javis/config.json` 分层 `builtin < user < project`，纯 JSON（零新依赖）；按 `kind`/`id`/`name` 覆盖，
  `enabled:false` / `disabled:true` 用于**删除继承项**；解析产出结构化诊断（含"未知版本"警告），单条坏声明不影响其余；
  `resolveJavisConfig` 与层顺序无关并记录每项来源 scope。20 个单测
- [x] **C1b** 桌面侧加载器：Rust `load_javis_config_files` 读 `<workspace>/.javis/config.json` 与 `<config dir>/javis/config.json`
  （**先 canonicalize 再做包含性检查**，符号链接逃逸会被拒；256KB 上限；缺文件不是错误），TS 侧只做解析与合并；
  已接入 App 启动链（配置问题只产诊断，绝不让启动失败）。5 个 Rust 测试 + 8 个 TS 测试
- [x] **C2** Agent 定制面板**核心**（`packages/core/src/agent-customization.ts`，18 测试）：草稿校验 + **"这个 agent 到底能看到什么"的实时预览**。
  预览刻意用**生效后**的配置算（与运行时同一套输入），这样"它会看到什么"只有一个答案，而不是两个会互相矛盾的答案。
  要点：
  ① **不变量沿用 B3**——agent 只能收紧自己的权限，**永远不能超过宿主上限**（生效上限 = min(草稿声明, 宿主)，越界给警告且宿主限制生效）；
  ② **显式空 allowlist = 没有工具，`undefined` = 全部工具**（这个区分有专门测试钉住——把 `[]` 当成"无限制"是很容易犯的错）；
  ③ denylist 恒胜过 allowlist；被撤回的工具**逐条给出原因**（在拒绝名单 / 不在允许名单 / 需要 X 权限超过上限 Y）；
  ④ 点名了本版本不存在的工具 → 警告（它永远不会被调用）；只有一种语言的人格 → 警告；预算/轮次非正整数 → 错误；
  ⑤ 组装出的提示词**写明生效后的权限上限、上下文预算、最大轮次**，过长时警告（每轮都会重复的东西）
- [ ] **C2b** 面板 UI（核心校验与预览就绪，尚未接线）
- [x] **C3** Skill / 知识包（`config/skill-frontmatter.ts` + 接线，14 测试）：**先按你要求用仓库自带 Playwright 做了外部核对**
  （`code.claude.com/docs/en/skills`），确认了真实约定：`SKILL.md` + YAML frontmatter（`name`/`description` 属于 Agent Skills 开放标准，
  `allowed-tools`/`disable-model-invocation`/`argument-hint` 是扩展）、描述驱动自动选择、**清单文本上限 1,536 字符**、正文按需加载。
  落地：一个小 YAML 子集解析器（标量/引号/行内列表/块列表，遇到不认识的行**报诊断而不是猜**）、`createSkillListing`（超限**整条丢弃**而不是截半条）、
  以及**接线**：frontmatter 声明 `disable-model-invocation: true` 的 skill 不再被自动选中（保持安装，只能用户显式使用）。
  调查还发现 Javis 原本已有相关性打分 + 4 个/24k 字符的选择上限，所以这轮补的是**约定兼容的控制位**，不是重新发明选择算法
- [ ] **C3b** 清单式渐进加载（先注入 name+description 列表，命中后再取正文）——当前是"相关的前 4 个直接注入正文"
- [x] **C4** **Hook 引擎**（核心层）：四相位 `beforeToolCall` / `afterToolCall` / `beforeApproval` / `onTaskFail`；
  动作是**数据而非代码**（`deny` / `requireApproval` / `annotate` / `notify`）——刻意不支持任意代码 hook（会移动安全边界却无沙箱兜底），
  解析期直接拒绝 `exec` 类动作；`deny` 永远压过 `requireApproval`；工具匹配支持精确名 / `shell.*` 前缀 / `*`。
  **已真正生效**：`beforeToolCall` 在 `dispatchToolByName` 强制（实测被拒时工具根本不会被调用），`afterToolCall` 的注解/通知写入
  `SharedTaskContext.hookNotices` 随制品传递。33 个单测 + 2 个执行器强制测试
- [x] **C4b** `beforeApproval` 与 `onTaskFail` 接线：审批卡现在会**汇总命中 hook 的理由**（4 个测试，含"作用域到别的工具不生效"、
  "hook 永不能自行批准，请求保持 pending"）；`onTaskFail` 的提示写入模型失败的活动日志条目 + console。
  **覆盖差异照实记**：`beforeApproval` 有端到端测试，`onTaskFail` 只有 hook 单测（未构造完整的失败链路测试）- [x] **C5** MCP 工具延迟加载与搜索（`packages/core/src/tool-deferral.ts`，17 测试）：把工具分成"留在 system prompt 前缀里的核心集"
  与"通过工具搜索可达的其余部分"。两条设计不变量：
  ① **稳定优先于聪明**——前缀是输入的纯函数（排序已钉死：pin → 当前 agent 拥有 → 按用量 → 字母序），
   同输入产出**逐字节相同**的工具表，否则"贴心的重排"会把前缀缓存全部打掉；`diffToolPrefix` 直接报出进出前缀的工具名，
   这就是缓存失效的信号（有测试断言打乱输入顺序后前缀不变）；
  ② **没有任何工具变得不可达**——延迟的工具仍可按名字/能力标签/摘要搜到（名字 > 能力标签 > 摘要的权重有意排序），
   且前缀里会写明"还有 N 个工具可通过搜索获取"。超出上限的工具是**被延迟而不是被丢弃**（有测试断言两类之和恒等于全集）。
  这同时是 E5 缓存命中率问题的正面解法
- [x] **E3** 结论优先视图（`packages/core/src/conclusion-view.ts`，18 测试）：Inspector 不再一次倒出所有东西——
  **默认只给结论**（状态+目标作标题、答案、至多 5 条要点、证据只给**计数**），证据按 kind 分组留待展开。两个排序决策写进了设计：
  ① **缺口排在证据之上**（"diff 从未产出"比"读了 12 个文件"重要，把它埋在证据底下会让部分结果看起来像完整结果）——
   所以 `gaps` 是独立的、永不折叠的字段；
  ② **答案在句子边界截断**（中英标点都处理），退化到词边界，绝不在词中间切——折叠卡片里的半句话会被读成"答案被截断了"；
   而没有结论时明确说"没有产出最终结论"而不是给一张空卡片
- [ ] **C5b / E3b** 接进运行时与 Inspector UI（核心逻辑与测试就绪，尚未接线）
- [x] **C6** 插件清单（`config/plugin-manifest.ts`，12 测试）：manifest 校验（kebab-case id、semver 版本、**未知能力直接拒绝而不是忽略**）+
  `planPluginInstall` 信任分级——**声明与授予分离**：`process_spawn` / `filesystem_write` 明确拒绝并给理由；
  `confirmed_write_tools` 可授予但附警告"写入仍走原生用户审批"；插件**不得覆盖内置 tool 名或内置 agent kind**（供应链遮蔽）；
  `dangerous` 权限的插件工具直接拒绝；代码型 hook 动作拒绝。**安装本身永不在此发生**：计划恒为 `requiresApproval: true`，与实际安装（包下载/落盘）解耦
- [ ] **C6b** 插件安装执行体（下载/校验哈希/落盘/卸载）与 `plugin status/list` UI —— 目前只有清单与安装计划
- [x] **C7** 工作流图编辑**核心**（`packages/core/src/workflow-editing.ts`，26 测试）：图校验（空工作流 / 重复 id / 自依赖 / 悬空依赖 /
  **环**——直接与间接都报，并给出闭合路径）+ 四个编辑操作（增 / 删 / 改依赖 / 改 id）+ 拓扑排序与入口步骤。
  **图编辑器的失败模式不是"它拒绝了"，而是"它接受了，破坏稍后才以一个从不运行的步骤显现"**——所以每个操作除了合法性还返回
  `consequences`：删掉一个步骤时**当场**报出"会让 2 个步骤悬空：analyse、capture"，以及"另 1 个步骤依赖它们：write-report"，
  让编辑器在用户确认**之前**就能显示影响面，而不是在运行失败之后。
  其余要点：删除时**清理引用**而不是留下悬空引用；**被拒绝的编辑绝不泄漏一个坏图**（返回原始工作流，有测试断言 `toBe(original)`）；
  所有操作**不可变**（有 3 条测试断言输入未被修改），因为编辑器需要一个可撤销的工作流值栈；改 id 会**重写全部引用**并报出条数；
  菱形依赖不算环（有专门测试）
- [ ] **C7b** 编辑器 UI（核心图操作与影响面计算就绪，尚未接线）；模型生成路径仍保持不变作为回退
- [x] **C8** 主题 / 语言 / 快捷键**核心**（`packages/core/src/ui-preferences.ts`，23 测试）：两块最容易出错的地方都做成了纯逻辑：
  ① **归一化**——`Ctrl+Shift+P` / `shift+ctrl+p` / `Control+Shift+p` 必须是同一个快捷键（修饰键顺序固定、别名解析、大小写折叠、
  拒绝"两个非修饰键"或"没有主键"的组合）。否则冲突检测会**同时**漏报真实的冲突并**虚报**不存在的冲突；
  ② **冲突分级刻意不合并**——用户改内置键是**合法定制**，只给 warning（并点名哪个命令失去这个键）；
  用户自己的两个命令抢同一个组合是 **error**（谁都无法可预测地胜出）；撞上**平台保留键**是 **error**（OS/应用会直接拿走，
  绑定它等于 bug 而不是偏好）；`darwin` 的保留集与 `win32` 不同（`Meta+Q` 在 mac 保留、在 Windows 不保留）。
  偏好分层沿用 C1（builtin < user < project），且 **`null` 是显式的"解绑"而不是"没有值"**——`unboundCommands` 单独记录，
  因为设置 UI 需要区分"你解绑了它"和"它本来就没有默认键"
- [ ] **C8b** 设置 UI 与主题实际应用（核心解析/校验/冲突检测就绪，尚未接线到 UI）

---

## D. 多 Agent 协作

- [x] **D1** 能力路由决策可见化（`packages/core/src/routing-decision.ts`，15 测试）：**先核查了现状**——
  `AgentRuntimeRoutingDecision` 已存在，但它描述的是**执行内核**（langchain/javis/opencode 哪个跑这步），不是"派给哪个 agent、哪个模型"。
  本轮补的是上面那一层：`decideAgentRouting` 返回一个可展示的对象——选中的 agent、**每个候选的评分与理由**、
  以及**每个被拒候选的被拒原因**（"为什么不是 explorer？"才是真正会被问到的问题），外加 `summary` 与
  `describeRoutingDecision` 的逐行解释。两条刻意的判定：
  ① **缺少必需能力 = 不合格，而不是分低**；缺上下文窗口、需要视觉却没有视觉模型，同样是**不合格**——
   混进评分会产出一个看起来很笃定的答案，却把视觉步骤静默派给"看不见"的模型；
  ② **平局要上报**（`unambiguous: false` + summary 写明"按字母序打破平局"），因为平局意味着结果取决于 tie-break，
   这正是值得暴露的路由意外。测试还钉住了**判定顺序**（先能力后视觉），因为它决定了用户读到的解释是否可行动
- [ ] **D1b** 把决策对象接进 Inspector 与任务日志（核心决策就绪，尚未接线）；`COMMANDER_CAPABILITY_ROUTING_REFACTOR_PLAN.md` 的收口仍未做
- [ ] **D2** 把 handoff report 从"工程报告"变成"协作叙事"（谁交给谁什么、缺什么、谁没被消费）
- [x] **D3** 并发预算与背压 —— **核查后确认已经实现**（不是我加的）：`workflow-dag-executor.ts` 有 `maxConcurrency`（默认 4，钳制 1–8）、
  `maxReadyQueueSize`、`waitForRateLimit` 限速、熔断器（连续失败阈值）、心跳、重试与 `onBackpressure` 回调；
  `workflow-dag-executor.test.ts:938-977` 用 `expect(maxActive).toBe(2)` 与 `onBackpressure` 断言把这条钉住了。
  **结论：本项无需改造，只需记录。** 缺的是"为什么某个步骤在等"的可视化（见 E5）
- [x] **D4** **并发写冲突租约**（`packages/core/src/write-lease.ts`，19 测试 + 3 个调度器级测试）：路径级互斥且支持包含关系
  （`src` 与 `src/a.ts` 双向冲突）、同一步骤可重入（自己不算冲突）、**TTL 让被杀掉的步骤不会永久锁死 DAG**（过期即自动可用）、
  显式释放与按步骤批量释放、路径归一化（分隔符/`./`/`..`/去重）。已接入调度器：声明了同一路径的两个并行步骤会被拒，
  且错误里指明持有者；不同路径仍可并行（有 `maxActive === 2` 断言）；串行步骤复用同一路径不会冲突（因为前一步已释放）
- [ ] **D4b** 让 Commander 计划步骤真正声明 `declaredWritePaths`（调度器已强制，但目前没有调用方填充它——即"守卫生效但没人申报"）
- [x] **D5** **统一审批中心**（`packages/core/src/approval-center.ts`，17 测试）：把文件写入/浏览器/终端/git/Computer Use/PDF 六个来源的审批
  归一化成一条队列，并提供三件队列才可能做到的事：
  ① **风险分级** `safe/risky/dangerous` **带理由**（顺带补上 `PRODUCT_READINESS.md:179` 列为缺失的 write-risk classification）——
   不可逆 / 逃出工作区（`..`）/ 已标 dangerous → dangerous；confirmed_write / 多路径 / git·terminal·browser → risky；
  ② **"本次会话不再询问"**：按 `toolName` + 路径作用域记忆，**永不覆盖 dangerous 项**（对破坏性操作做一揽子授权正是要防的错误），带 TTL 与撤销；
  ③ 队列摘要（按风险/来源计数 + 最久等待时长）供徽标与 SLA 提示。**它只记录决定，从不自己授权**——原生 approval binding 仍是执行边界。
  开发中测试抓到我一个逻辑漏洞：**已过期的 dangerous 条目会永久否决该工具的所有会话授权**，已修
- [ ] **D5b** 把各来源的审批请求真正投递进这个队列并接 UI 审批卡（核心模块与测试就绪，尚未接线）
- [x] **D2** **handoff 协作叙事**（`packages/core/src/handoff-narrative.ts`，7 测试）：把工程味的 `HandoffReport` 渲染成
  "谁把什么交给了谁"（`code → verifier: handed over "repoSearch"`）+ 三类缺口（被消费但无生产者 / 产出了没人读 / 形状不符 schema），
  中英双语、有上限并如实说明截断。**开发中抓到自己的一个静默错误**：我按 `step.id` 建索引而记录字段是 `stepId`，
  结果**每一次真实交接都会被渲染成"缺口"**——测试当场打红
- [ ] **D2b** 把叙事接进 Inspector（核心格式化就绪，UI 未使用）
- [x] **D6** 子代理会话 / fork / 轨迹可回溯**核心**（`packages/core/src/subagent-session.ts`，19 测试）：
  ① **fork 的收益是有条件的，这个条件才是重点**——服务商缓存的是**前缀匹配**而不是"包含关系"：一旦子会话的 system prompt 或工具表变了，
  继承来的消息就不再是同一个前缀，**什么都复用不到**，子会话**静默地**按冷启动计费。`planSubagentFork` 明确报出这一点
  （`prefixCacheable` + 原因），而不是给一个永远兑现不了的乐观 token 数；
  ② 超预算时**从最前面裁剪**（最近的轮次才是 fork 的意义），但裁剪本身也会让前缀失效——这两件事一起报；
  ③ **谱系可回溯**：ancestors 从根到直接父、descendants 广度优先；父会话已被清理时报 `orphaned` 而不是抛错（否则被剪枝的轨迹就没法显示了），
  谱系成环时停止而不是死循环；
  ④ **子上下文的 key 必须命名空间化**（`sub:<childId>:<key>`），并提供 `isForeignContextWrite` 判断"子会话是否在父作用域写"
- [ ] **D6b** 独立会话的持久化与 UI（子轨迹视图、按会话切换）；核心的 fork 经济性与谱系计算就绪，尚未接线
- [ ] **D7** 团队/多用户：会话共享、审计导出（**取决于目标用户是否只有你自己**）

---

## E. 好用

- [x] **E1** 首次运行引导（`packages/core/src/setup-diagnostics.ts`，11 测试）：把配置变成**有序清单 + 单一"下一步"**
  （provider → model → api_key → base_url），每条给出中英双语的**具体该做什么**，并区分"阻断"与"仅提醒"：
  缺工作区只是警告（聊天仍可用，文件/仓库任务需要它）；无需密钥的本地服务商不会被要求填 key；自建端点才要求 base URL；
  未知服务商给警告但不阻断（提示"仅当它兼容 OpenAI 接口才可用"）。`ready` / `blockers` / `nextStep` 直接可供引导 UI 使用
- [ ] **E1b** 引导 UI（核心诊断就绪，尚未接线）；连通性验证复用现有 `testModelConnection`
- [x] **E4 = D5** 统一审批中心（见 D5；UI 接线为 D5b）
- [x] **E5** 成本 / 缓存 / 上下文面板（`packages/core/src/usage-panel.ts`，15 测试）：把 `TokenUsageSummary` 变成
  **命中率 / 上下文占用率 / 重量级 agent / 成本**，并**在缺失时说明原因**而不是印 0%：
  服务商未回报缓存字段 → 显示 `no data` + 原因（0% 会被误读成"缓存坏了"）；命中率 < 30% 或上下文 > 85% 单独给出告警；
  **成本刻意可选**——本仓库不含各模型价目表，凭空编一份会给出"自信的错误金额"，所以只有调用方提供单价时才计算
  （且正确处理"`inputTokens` 是含缓存的总量"，缓存读/写分别按各自单价结算）
- [ ] **E5b** 成本面板接 UI + 价目表来源（趋势与"前缀断裂原因"仍缺）
- [x] **E2** **错误带"下一步"**（`packages/core/src/failure-guidance.ts`，13 测试）：把失败归成 14 类，每类给出
  **本地化短消息 + 有序动作**（`retry` / `check_api_key` / `switch_model` / `reduce_input` / `open_settings` / `inspect_log` /
  `fix_tool_output` / `replan` / `adjust_permissions` / `none`）+ `retryable` 标志，供 UI 直接渲染按钮。
  **测试用例直接取自生产日志原文**（`Could not read model API key secret`、`请求频率过高`、`maximum context length`、
  `Tool ... must be a integer`、`plan compilation failed`…），所以这是一条真实失败分类的回归钉。
  同时**删掉运行时里那份更小的重复分类器**（`classifyModelFailureKind` / `modelFailureUserMessage` 改为委托），
  运行时因此自动获得限流、上下文溢出、截断、工具 schema 这些原本只会落到 `unknown` 的类别
- [x] **E2b** 失败指引接进真实失败路径（模型调用失败路径已接线）：`TaskSnapshot.failureGuidance` 现在携带
  `{ kind, message, actions, retryable, detail }`，UI 可以直接把 `actions` 渲染成按钮。
  **这轮最值钱的发现是一个"第三份分类器"**：`workflow-executor.ts:2193` 的 `toUserFacingError` 又是一个独立字符串匹配表，
  **只有中文、没有动作、也没有语言切换**——正是 E2 从 `index.ts` 里删掉的那种重复。本轮**只接线了一条失败路径**（模型调用失败），
  这条路径的覆盖缺口记为 **E2c**（见下）。
  另修掉匹配器一处真实缺口：`model_unconfigured` 只认"model settings are missing"，而线上文案是"**missing** model settings"，
  词序一变就掉进 `unknown`。**用户可见文案有变更**：该场景从泛泛的 "model request failed" 变为
  "No model is configured for this task. Choose a provider, model and API key in Settings."——这是 E2 的既定目标（消息必须可行动），
  已更新对应测试断言并注明这是刻意变更
- [x] **E2c** **第三份分类器已合并**（`workflow-executor.ts` 的 `toUserFacingError` 现在委托 `failure-guidance`）：
  删掉了一张**中文硬编码、无动作、无视语言**的 9 分支匹配表，全仓只剩一个失败分类器（`zhCN` 作默认值以保持该路径现状）。
  为了让这一步**不丢信息**，先补了两个分类：`request_invalid`（请求根本没发出去，重新规划修不了）、
  `plan_unparsed`（模型没返回可解析结构，与"结构非法"是两回事、给的建议也不同），并让它们的文案**逐字等于**原表的两句，
  所以**该路径的用户可见文案零回归**，同时新增了双语与动作。
  **过程中测试抓出我引入的一个真实回归**：原表的兜底分支会**保留原始错误文本**，而我的 `unknown` 模板会替换成
  "模型请求失败"——这对一个"持久化写入失败"来说不只是信息更少，而是**把原因归错了子系统**，用户会去查错地方。
  已修：`unknown` 在能引用原文时**引用原文**（只剥掉 `Error:`/`[tag]` 前缀），只有原文为空时才用模板。这条有专门测试。
  另有一处测试断言更新属于**刻意改进**（该路径已能分类，用户看到"只返回思考过程、没有最终回答"而不是原始英文 detail；
  原始 detail 仍保留在 `primaryFailure.message` 上并继续被断言）
- [x] **E2d** 失败动作**解析成可渲染按钮**（`packages/core/src/failure-actions.ts`，14 测试）：把 `actions` 解析成
  `{ label(双语), command(具体命令), enabled, disabledReason?, emphasis }`。
  核心判断：**一个动作不等于一个按钮**——有些在当前上下文跑不了，而**给一个点了没反应的按钮比不给更糟**。所以：
  ① `retry` **真的需要原始目标**——没有目标时按钮**禁用并说明原因**（"没有原始目标，无法重试"），而不是重开一个空输入框；
  正在重试中也禁用；
  ② `open_settings` / `inspect_log` 在宿主无法显示时禁用并说明，**但仍渲染**——隐藏会让失败看起来"无解"；
  ③ **恰好一个 primary**：取**第一个可用**动作（分类器已按有用性排过序），所以"自然首选不可用"时会自动顺延（有测试钉住）；
  ④ 按钮回传的是**具体命令**（`retry_task` 带 taskId+goal、`open_settings{section:"model"}`、`focus_input`…），
  于是"重试对这个任务意味着什么"只有一处定义；⑤ 分类器将来新增动作而这里没跟上时，**渲染为不可用而不是静默丢弃**
- [x] **E2d-ui（app 侧适配层已完成）**（`apps/desktop/src/failure-action-view.ts`，10 测试）：这一层存在的两个理由都写进了模块注释：
  ① **UI 不允许 import core**（包边界），所以必须有人在 app 侧把 core 的 `FailureGuidance` 转成组件能渲染的纯值——
  把它做成**纯函数**，就能**不挂载组件也测**（这正是我在这个环境里能验证的部分）；
  ② **不是所有失败路径都设置了 `failureGuidance`**——目前只有模型调用失败路径设置它，计划编译等路径只有 `userFacingError` 字符串。
  于是本模块**在没有分类时从消息反推**（`derivedFromMessage` 标志区分），让按钮在那些路径上也出现，
  而不是"功能只对几条路径生效"。
  另外：优先用上游分类（它看到了原始 detail，信息严格更多）；无失败时返回空视图（调用方可无条件渲染）；
  被测的还有"审批被拒 → 无按钮"与"未识别失败 → 保留具体消息而不编造原因"
- [ ] **E2d-ui-组件** 把 `FailureActionView` 渲染成实际按钮并接线到重试/设置/日志动作（纯值适配已完成；
  剩余为 JSX 与事件接线，**本环境无法验证 UI 渲染**，需要在跑起来的应用里确认）
- [x] **E3** 结论优先视图（见上方 C5 之后的 E3 行）
- [x] **E4** 审批中心（同 D5）
- [x] **E5** 成本 / 缓存 / 上下文面板（见上方 E5 行）
- [x] **E6** 命令面板**核心**（`packages/core/src/command-palette.ts`，23 测试）：命令注册表 + 可解释的模糊匹配 + 可用性过滤。
  分级刻意拉开（精确 id 100 > 精确标题 95 > 标题前缀 80 > **id 前缀 75** > 关键词 70/60 > 词边界 50 > 子序列 30 > id 包含 25），
  因为"谁都猜不到的模糊分数会产出谁都信不过的命令面板"。
  **诚实要求**：当前跑不了的命令**灰显并给出原因**，而不是隐藏——隐藏会让面板显得坏了（"明明有这个命令为什么搜不到"），
  而"需要 confirmed_write 权限（当前 read）"顺便教会了用户权限模型；测试断言两类之和恒等于全集。
  **开发中修掉自己一处不一致**：`grantedPermissionLevel` 未指定时我默认成 `read`，于是把写命令全灰掉——
  这与我给其它标志定的规则（"未知"不等于 `false`）自相矛盾，而且真正的门是原生审批边界，从不被绕过。已改为未指定不阻断
- [ ] **E6b** 面板 UI + 快捷键绑定（核心匹配与过滤就绪；`shortcut` 字段目前仅用于显示）

---

## `pnpm check` 全链实测记录（2026-09-13，逐项单独运行）

`pnpm check` 是 CI 门禁，但串起来会超时（历史记录 124 秒无输出）。本轮把**它的每一项**单独跑了一遍并记录实际结果——
这是"真实运行验证"的证据，也说明各部件确实能组合：

| 门禁项 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ 0 错误 |
| `pnpm package-boundaries` | ✅ `Package boundary check passed.` |
| `pnpm package-boundaries:test` | ✅ `Package boundary check tests passed.` |
| `pnpm test`（全仓） | ✅ core **1652** / desktop 1002 / ui 219 / tools 53 / sidecar 6 |
| `pnpm eval` | ✅ **29/29 golden tasks (100.0%)** → `docs/qa/eval/2026-09-12/` |
| `pnpm eval:test` | ✅ 6 pass / 0 fail |
| `pnpm docs:check` | ✅ no drift (0 error / 0 warning) |
| `pnpm docs:test` | ✅ 16 pass / 0 fail |
| `pnpm local-vision-worker:test` | ✅ 通过 |
| `pnpm --filter @javis/desktop build` | ✅ built in 20.9s（有一条 chunk >500 kB 的**既有**告警，与本轮无关） |
| `pnpm rust:check` | ✅ `Finished dev profile` |
| `pnpm rust:test` | ✅ 599 passed / 0 failed |
| `pnpm metrics` | ✅ 写出报告（读到真实 DB：2 tasks / 9575 tokens） |
| `pnpm diagnostics` | ✅ 脱敏包写出 `docs/qa/diagnostics/…` |

**结论**：全部门禁项通过。**唯一未实测的是串起来的 `pnpm check` 本身**（历史超时问题仍在），
以及 `desktop:build`（完整 NSIS 安装包，需要更长时间与签名配置）。

---

## 交接说明（给接手的下一个会话）

**当前状态**：`pnpm typecheck` / `pnpm docs:check` 与全部 **1652 core + 1002 desktop + 219 ui + 53 tools + 6 sidecar + 599 Rust** 测试全绿；
工作树干净；最近提交见 `git log --oneline`。

**每轮必须跑的验证**：

```bash
corepack pnpm typecheck
corepack pnpm -r --if-present test          # 全 TS
corepack pnpm docs:check                    # 文档漂移（有事实错误会非零退出）
$env:PATH="$env:USERPROFILE\.cargo\bin;C:\Program Files\Git\cmd;$env:PATH"; corepack pnpm rust:test
```

**注意**：`git` 与 `cargo` 不在默认 PATH 上，需按上面那样前置；PowerShell 控制台会把中文输出弄乱，
所以测试输出**写进文件再用 read 工具看**。源码编辑一律走 edit/write 工具，**不要用 shell 文本替换**（会毁掉 UTF-8 中文）。

**剩余项与它们的性质**（都已在上面勾选清单里具名）：

| 类型 | 条目 | 说明 |
|---|---|---|
| 核心逻辑未做 | `C2` `C7` `C8` `D6` | 多为 UI/架构工作；建议沿用本轮模式：先核查现状 → 抽出可测的决策核心 + 单测 → UI 留作 `*b` 缺口 |
| 接线缺口 | `B3b` `B4b` `C3b` `C5b` `C6b` `D1b` `D2b` `D4b` `D5b` `E1b` `E2b` `E3b` `E5b` `E6b` `E7b` | 核心逻辑**已就绪且有测试**，缺的是接进 UI/运行时。**这些是最快见效的部分** |
| 远端 | `G4b` `G5b` | 推分支开 PR 需要真实凭据；自动更新需要配置 Tauri `updater` 插件 + 签名公钥 + https 端点 |
| 已知不稳定 | `F5` | 审批卡波动测试，实测发现未修 |

**已建立的几条约定**（新代码请沿用以保持一致）：
① 会腐化的数字/清单不要写进文档——`pnpm docs:check` 会检查；
② 守卫与决策**失败即关闭**，但"未知"不等于 `false`；
③ 安全类不变量（权限只能收紧不能放宽、会话授权永不覆盖 dangerous、插件不得遮蔽内置）都有测试钉住；
④ 每个 `*b` 缺口都写明"核心已就绪、缺什么"，不要把它说成完成。
- [x] **E7** 中断 / 续跑 / 回滚**规划**（`packages/core/src/resume-plan.ts`，19 测试）：三种模式统一到一张图上——
  `resume`（续跑未完成）、`retry_failed`（只重试失败的，**不牵连下游**）、`rollback`（回到某步 → 该步 + **全部下游**重跑，上游不动）。
  核心不是"选哪些步骤"，而是**随之而来的上下文失效**：某步重跑但它的输出 key 留在恢复出的上下文里，
  下游会**静默地**读到一份已经不属于本次尝试的产物（artifact 存在、schema 合法，只是过期）。
  所以每个将重跑步骤的 `outputContextKey` 都进入 `invalidatedContextKeys`，调用方应当**丢弃**它们而不是信任。
  另外：无法获取的输入不假装能续跑（报 `missingInputContextKeys` + "改去重新规划"）、每一步恰好被归类一次（有测试断言）、
  循环/悬空依赖在恢复路径上降级而不抛错（恢复路径上硬失败比保守前进更糟）。
  **开发中测试抓出我自己两个逻辑错误**：① `retry_failed` 里有一段把"既是完成又是放弃"的步骤删掉的死逻辑——那是重试失败，失败是更新的事实；
  ② 回滚警告把**用户明确要求重做的目标步**也算成"被牵连的已完成步骤"（目标不是附带损害）
- [ ] **E7b** 接进 UI 的"中断 / 从此步续跑 / 回到此步"按钮 + 与 `workflow-checkpoint-reconciliation.ts` 合并（核心规划就绪，尚未接线）
- [x] **E8** **术语统一**：核查发现这不是文档笔误而是**真实缺陷**——`AgentKind` 是 `language-reviewer`，
  但 `app-runtime.ts:3131` 调的是 `providerFor("chinese-reviewer")`，而 `normalizeAgentKind` 只映射了 `browser → page-agent`。
  **后果**：中文评审用的不是为该 agent 配置的模型档位，而是静默回落到主档。修复：别名表补上 `chinese-reviewer → language-reviewer`，
  调用点改用规范名，并加 **5 个词汇契约测试**（别名解析、内置 kind 不含旧名、每个内置 kind 都在 `AgentKind` 联合里、归一化幂等）

---

## F. 可观测与可评估 —— "前进一小步"必须能证明

- [x] **F1** **本地 golden task 集** + `pnpm eval` 一键跑分：29 条真实目标/计划用例（routing 6 / write-intent 10 / plan-legality 13），跑 `routeMessage` + `isTextWriteGoal` + `detectCommanderPlanIntents` + `compileCommanderPlan`（对**真实** `demoAgents`/`initialToolDescriptors`），输出 `docs/qa/eval/<date>/scorecard.{json,md}`，已接入 `pnpm check`
  - 首轮即抓出 3 个真实缺口并修复：问句打开写入流、评审请求打开写入流、空计划通过编译
- [x] **F2** `pnpm metrics`：读真实 `task-audit.jsonl` + `javis.db`，产出任务成功率 / p50-p95 时延 / agent 失败分类 / 每工具失败数 / 表体积 / token 用量 → `docs/qa/eval/<date>/runtime-metrics.{json,md}`
  - 首跑北极星数字：**216 个任务、100 失败、失败率 46.3%**；工具失败榜首仍是 `code.searchRepository`（58 次）
- [x] **F3** `pnpm diagnostics`：脱敏支持包（summary.md + diagnostics.json + audit-tail.jsonl），密钥/家目录/主机名一律替换；6 个 node:test 用例钉住脱敏规则（已接入 `pnpm check`）
- [ ] **F4** 遥测默认关闭 + 可审计（当前 Javis 无遥测；补偏好键与说明）

---

## G. 工程与发布

- [x] **G1** `pnpm typecheck` 覆盖 `apps/desktop`（原来没有 `typecheck` 脚本，`pnpm -r` 只跑 5/6）与 browser sidecar
- [ ] **G2** 巨石拆分（见 B4）
- [x] **G3** **文档漂移检查机制**（`scripts/docs/check-doc-drift.mjs` + `lib/doc-drift.mjs`，16 测试，已接入 `pnpm check`）：
  把文档里**可机械验证的声明**拿去和仓库比对——引用的 `pnpm` 脚本是否存在、backtick 里的 agent kind 列表是否都在 `AgentKind` 联合里
  （落在别名表里的算 warning）、`文件 is ~N lines` 的行数声明偏差是否 > 30%、`## Current State (日期)` 是否落后 HEAD > 45 天。
  失败分级：**事实错误报 error（非零退出）**，陈旧只报 warning。
  **首跑就抓出 3 处真实漂移并全部修掉**：CLAUDE.md 仍列 `chinese-reviewer`、行数声明差 121%（6,821 实际 15,054）、
  "Current State" 落后 90 天。修法不是"刷新数字"而是**去掉会腐化的硬编码**（行数改为不写死）+ 把状态节改标为历史快照。
  规则本身也修过一次：首版把 CHANGELOG 的版本日期也当作陈旧（那是发布日，本该是旧的），现只对**状态类**标题做新鲜度检查
- [x] **G4** **仓库卫生**：删除 5 个临时产物共 **128.1 MB**（`.tmp-gcli-main.zip` 23.4 + `.tmp-gcli-main/` 103.1 +
  `.tmp-pages/` 1.1 + 两个 `.tmp-gcli-*.txt`），并在 `.gitignore` 补 `.dsh-tmp/`、`.tmp-*/`、`.tmp-*`、`runs/`；
  生成型诊断包 `docs/qa/diagnostics/` 也忽略（含本机活动数据）。`git status` 从 37 条噪声降到 0（全是真实源码）。
  **并把 11 轮积压的工作提交了**：`ca4d58e`，94 文件 / +12,970 / −113，工作树干净
- [ ] **G4b** 推分支开 PR（本地已提交，远端未推；需要你的凭据与判断）
- [x] **G5** 更新决策与制品校验（`packages/core/src/update-policy.ts` 24 测试 + `scripts/release/update-manifest.mjs`）：
  **先核查了现状**——`tauri.conf.json` **根本没有配置 `updater` 插件**，且 `allowDowngrades: false`（降级安装会被 OS 层拒绝，
  所以回滚确实必须先卸载）。因此本轮交付的是"更新器存在之前就必须正确"的部分：
  版本比较（含预发布排序）、四类决策（`prompt` / `force` 低于最低支持版本 / `blocked_downgrade` 并给出 `uninstall_first` 步骤 /
  `blocked_unverified`）、以及**失败即关闭**的校验（哈希缺失或格式不对 → 直接不提供该更新）。
  制品侧：`pnpm release:update-manifest generate` 从 bundle 目录生成带 SHA-256 与体积的 manifest，
  `verify` 会重新哈希比对——**实测篡改安装包后如实报 MISMATCH 并非零退出**。
  清单校验（https 强制、semver、非空制品）在 core 的单测里，脚本里只做与运行相关的结构检查并**明确说明**为何不重复实现
- [ ] **G5b** 真正的自动更新：需要 ① 配置 Tauri `updater` 插件 + 签名公钥 ② 一个 https 承载端点 ③ 真实签名产物。
  本轮**没有**假装它可用
- [ ] **G6** 形态决策：只做桌面 GUI，还是 GUI + CLI + headless/SDK（决定 B1 要不要彻底剥离 Tauri 依赖）

---

## H. 需要先定的事

1. **目标用户**：只有你自己？还是要发布给别人？（决定 E1 / G5 / D7 的投入）
2. **客制化深度**：只到配置文件，还是到插件/代码级（可注册新工具、新 hook）？后者工作量 3-5 倍，但才叫 harness。
3. **形态**：桌面 GUI only，还是 GUI + CLI + headless？
4. **顺序**：先可靠（A/F）还是先扩展（B/C）？
5. **多 Agent 形态**：一个 Commander 调度工具型 Agent（现架构），还是多个可独立对话、互相派活的 Agent 同事？

---

## 里程碑（每一步独立可交付、可验证）

| 里程碑 | 内容 | 验收 | 状态 |
|---|---|---|---|
| **M1 地基** | A1 ✅、A2 ✅、A3 ✅、A4 ✅、A5 ✅、G1 ✅ | DB < 50 MB ✅（实测 14.9 MB）；单任务写入 < 500 行 ✅；无终态后写入 ✅ | ✅ 完成 |
| **M2 度量** | F1 ✅、F2 ✅、F3 ✅ | 29 条 golden task 一键跑分 + 真实运行指标 + 脱敏诊断包 | ✅ 完成（F4 归入后续） |
| **M3 Harness 抽象** | B2、B3、B4、B5、C1 | 不改代码即可新增一个 Agent + 一个工具 + 一个工作流 | ⬜ |
| **M4 客制化表面** | C2、C3、C4、C6、D2、D5 | UI 内可建 Agent、装 Skill、挂 Hook、统一审批 | ⬜ |
| **M5 协作与好用** | D1、D3、D4、D6、E2、E4、E5、E7 | 两 Agent 改同一文件不炸；失败信息带下一步；中断可续跑 | ⬜ |

---

## 已知不稳定

- [x] **F5 波动测试**（本轮修复）：根因不是"某一个测试不稳"，而是一个**系统性竞态**——审批卡测试等待的是**代理信号**（面板文本出现），
  然后**同步**去找"未禁用的按钮"。面板先渲染、按钮后启用，所以这一批测试都会间歇性失败，只是我那一次恰好有一个输了竞态。
  查证后：**8 处**同一写法，其中 7 处是竞态（1 处已在 `waitFor` 内、本来就正确）。
  修法是**等待真正需要的前置条件**（`findEnabledButtonByLabel` 用 `waitFor` 等"未禁用的按钮存在"），
  失败信息也从 `expect(...).toBeDefined()` 变成明确的"还没有标签为 X 的可用按钮"。
  验证：UI 套件连跑 **3 次均 117/117**，全量 TS 套件绿。

---

## 变更记录

- 2026-09-13（第 38 轮，工程）：**G2b 修复完成**——TypeScript 编译器（3,571 kB / gzip 1,023 kB）移出首屏。
  关键发现：光把服务的导入改成动态 import **不够**，因为 `manualChunks` 会把 `typescript` 留在被入口**静态**引入的 `vendor` 里，
  动态导入只能"引用"它而无法把它移出首屏；必须**同时**给编译器单独的 chunk。
  实测：**首屏 `vendor` 4,309 → 711 kB（−83%）**，编译器成为按需 chunk，并且核实了入口只通过 Vite 惰性清单引用它。
  desktop 1012 测试全绿（行为未变）；`bundle:check` 的允许清单理由已更新为"当前状态正确，但若恢复静态导入会回来"。
- 2026-09-13（第 37 轮，工程）：**G2b 根因查明**——用实测（新增 `scripts/analyze-bundle.mjs`，按包名聚合每个模块的 `renderedLength`）
  定位到 `vendor` 那 4.3 MB 的 **9,240 kB 全是 `typescript` 编译器本体**，来源是 `repo-intelligence-service.ts:11` 的静态 import
  加上 `app-runtime.ts` 的急切导入。**这是真实缺陷**（构建期工具进了渲染进程），修法是 4 个调用点改动态 import，
  但**本轮没做**——跨越 3,000 行运行时文件的 async 重构在剩余预算内风险过高，已把精确位置与做法写进路线图。
  同时加了**防复发闸门** `pnpm bundle:check`（已接入 `pnpm check`），并**实测它会失败**（注入探针后报 ERROR 非零退出）。
- 2026-09-13（第 36 轮，工程）：G2b 前端 bundle **第一刀**——把"除 React 外所有 node_modules 塞进一个 vendor chunk"改为按依赖族拆分，
  实测 `vendor` **4,945 → 4,309 kB**，并分出 `vendor-langchain`(620 kB) 与 `vendor-tauri`(15 kB)，收益是可缓存性。
  **但 4.3 MB 的来源仍未查明**（langchain 只占 620 kB），已把两条线索写进路线图（chunk 内含 `child_process`/`node:` 前缀
  → 某依赖的 node 入口被打了进来；`zod` 完整打包），并给出下一步做法（模块图定位）。
  **没有把"告警仍然存在"说成已解决**。下一轮：用模块图定位 4.3 MB 贡献者。
- 2026-09-13（第 35 轮，接线切片）：E2d **app 侧适配层**完成（`failure-action-view.ts`，10 测试）。
  两个设计要点：UI 不能 import core（包边界）→ 必须有 app 侧纯函数做转换，好处是**不挂载组件也能测**；
  以及**不是所有失败路径都设置 `failureGuidance`** → 无分类时**从消息反推**，让按钮在计划编译等路径上也出现，
  而不是"功能只对一条路径生效"。剩余为 JSX 渲染与事件接线（本环境无法验证渲染，已如实标注）。
- 2026-09-13（第 34 轮，**真实运行验证**）：把 `pnpm check` 的**每一项单独跑通并记录实际结果**（见上方"全链实测记录"表）——
  package-boundaries 通过（本轮首次运行）、golden eval **29/29 (100%)**、docs 检查 0 漂移、desktop 前端构建 20.9s、
  rust:check Finished、metrics/diagnostics 均写出真实报告。唯一未实测的是**串起来的 `pnpm check` 本身**（历史超时问题仍在），已如实记录。
- 2026-09-13（第 33 轮，接线切片）：E2d——失败动作解析成可渲染按钮（14 测试）。核心判断：**动作不等于按钮**，
  给一个点了没反应的按钮比不给更糟，所以跑不了的动作**禁用并给原因但仍渲染**（隐藏会让失败看起来无解）；
  `retry` 真的需要原始目标；恰好一个 primary 且取第一个可用者（自然首选不可用时自动顺延）。
  修掉自己一处测试错误：我假设 auth 的动作列表里有 `inspect_log`（实际没有），改为各自用真正包含该动作的失败类型来测两个界面。
  下一轮：E2d-ui（描述符接进失败面板）。
- 2026-09-13（第 32 轮，接线切片）：**E2c 完成**——第三份失败分类器合并，全仓只剩一个（中文硬编码/无动作/无视语言的那张表已删除）。
  为"不丢信息"先补 `request_invalid` 与 `plan_unparsed` 两个分类并把文案设为与原表逐字相同，故该路径**用户可见文案零回归**。
  测试抓出我引入的真实回归：`unknown` 模板会把"持久化写入失败"说成"模型请求失败"——**归错了子系统**；
  已改为能引用原文就引用原文（只剥 `Error:`/`[tag]` 前缀）。下一轮：E2d（把 actions 渲染成按钮）。
- 2026-09-13（第 31 轮，接线切片）：E2c **前置工作**完成——核查发现"删表直接委托"会**丢信息**（`complete_model_prompt` 在
  `failure-guidance` 里无匹配 → 掉到 `unknown`，比原来更差），于是先补 `request_invalid` 分类（双语 + 动作，且排在 `plan_invalid`
  之前，因为请求没发出去时重新规划修不了它）与匹配器。剩余委托工作已很机械，路线图里写明了要改的两处断言与原因。
- 2026-09-13（第 30 轮，接线切片）：E2b——失败指引接进模型调用失败路径（`TaskSnapshot.failureGuidance` 携带 kind/actions/retryable）。
  **发现"第三份分类器"**：`workflow-executor.ts:2193` 的 `toUserFacingError` 是另一张独立字符串表，只有中文、没有动作、无语言切换
  （正是 E2 从 index.ts 删掉的重复）；本轮只接线了一条路径，缺口记为 **E2c/E2d**。
  修掉匹配器一处真实缺口（"missing model settings" 词序不同就掉进 unknown）；
  **用户可见文案变更**：模型未配置时从泛泛的 "model request failed" 改为明确指出原因与做法的英文/中文消息（已更新断言并注明）。
- 2026-09-13（第 29 轮，接线切片）：**F5 波动测试已修**。追查后发现问题比"一个偶发测试"更大：审批卡那批测试等待的是**代理信号**
  （面板文本），再**同步**查"未禁用的按钮"——面板先渲染、按钮后启用，所以**8 处同写法里 7 处都是竞态**，我那次只是其中一个输了。
  改为等待真正的前置条件（`findEnabledButtonByLabel`），并改善失败信息。UI 套件连跑 3 次全绿。
  下一轮：E2b（把失败指引的 actions 接进真实失败路径）。
- 2026-09-13（第 28 轮，批次⑦）：C7 工作流图编辑核心（26 测试）——**批次⑦ 的"核心逻辑"部分到此全部完成**。
  设计要点：图编辑器的失败模式是"接受了但破坏稍后才显现"，所以操作返回**影响面**（删一步会当场报出哪些步骤会悬空、哪些间接受影响）；
  被拒编辑不泄漏坏图；操作不可变（可撤销栈）。下一阶段转向**接线类切片**（17 个 `*b`，交接说明里标注为"最快见效"）。
- 2026-09-13（第 27 轮，批次⑦）：C8 主题/语言/快捷键核心（23 测试）。两块做成纯逻辑：快捷键**归一化**（否则冲突检测会同时漏报与虚报）
  与**冲突三级分级**（改内置键=合法定制给 warning；自己两个命令抢同一组合=error；撞平台保留键=error，且 mac/Windows 保留集不同）。
  偏好分层沿用 C1，`null` 是显式解绑而非缺值。下一轮：C7 工作流可视化编辑核心（最后一项核心逻辑）。
- 2026-09-13（第 26 轮，批次⑦）：D6 子代理会话/fork/谱系核心（19 测试）。重点是**fork 收益的条件**：服务商缓存的是前缀匹配而非包含关系，
  改了 system prompt 就什么都复用不到，且**静默**按冷启动计费——所以明确报 `prefixCacheable` 与原因。
  测试抓出我自己一处**标志与原因自相矛盾**：零继承消息时原因写"没有前缀可复用"、标志却仍说可缓存（已修，两者现在一致）。
  下一轮：C7 工作流可视化编辑核心 / C8 主题与快捷键核心。
- 2026-09-13（第 25 轮，批次⑦）：C2 Agent 定制核心（18 测试）：草稿校验 + "它到底能看到什么"的预览（用生效后的配置算，
  与运行时同一套输入）。沿用了 B3 的不变量：**agent 只能收紧权限，永远不能超过宿主上限**。
  修掉自己两处测试写错：按索引取撤回工具（应**按名字查**——撤回列表跟随注册表顺序，index 0 是另一个工具）、
  以及把可用工具数算成 2（实际 3——两个 confirmed_write 加一个 read 在 confirmed_write 上限下都可用）。
- 2026-09-13（第 24 轮，批次⑦）：E6 命令面板核心（23 测试）。修掉自己一处**自相矛盾**：未指定权限等级时我默认成 `read`，
  把写命令全灰掉，违背了我给其它标志定的"未知不等于 false"规则。新增 id 前缀匹配分级（`file.w` → `file.write`）。
  另外在路线图补了**交接说明**一节：验证命令、环境坑（PATH/中文输出/shell 改源码会毁 UTF-8）、剩余项分类与已建立的约定。
- 2026-09-13（第 23 轮，批次⑦）：D1 能力路由决策可见化（15 测试）。核查发现既有的 `AgentRuntimeRoutingDecision` 只管**执行内核**，
  本轮补的是"派给哪个 agent/模型 + 为什么 + 为什么不是别人"。核心判定：**缺能力是不合格而非分低**（避免笃定地把视觉步骤派给看不到的模型）、
  **平局上报**。另外修掉自己一处测试写错（断言了根本不会触发的视觉拒绝分支——因为它被更早的能力过滤挡掉了，
  这反而证明了判定顺序正确，现补了一条专门钉顺序的测试）。下一轮：C2 Agent 定制面板 / E6 命令面板。
- 2026-09-13（第 22 轮，批次⑦）：E7 中断/续跑/回滚**规划**（`resume-plan.ts`，19 测试）：三种模式统一到一张依赖图上，
  核心是"**某步重跑就必须让下游上下文失效**"——否则下游会静默读到上一次尝试的产物（artifact 存在、schema 合法，只是过期）。
  开发中测试抓出我自己两个逻辑错误：`retry_failed` 里一段把"既完成又放弃"的步骤删掉的**死逻辑**（那是重试失败，失败是更新的事实）、
  以及回滚警告把**用户明确要求重做的目标步**算成"被牵连的已完成步骤"（目标不是附带损害）。均已修。
  下一轮：D1 能力路由可见化 / C2 Agent 定制面板。
- 2026-09-13（第 21 轮，批次⑦）：C5 工具延迟加载与搜索（17 测试；前缀是输入的纯函数以保证缓存不被打掉，超出上限的工具被延迟而非丢弃，
  这同时是 E5 缓存命中率问题的正面解法）、E3 结论优先视图（18 测试；缺口永不折叠、答案在句子边界截断）。
  下一轮继续批次⑦：D1 能力路由可见化 / E7 中断续跑 / C2 Agent 定制面板。
- 2026-09-13（第 20 轮，批次⑥收尾开局）：B4 第一刀——抽出 `tool-dispatch-guards.ts`（工具调用边界，22 测试），
  `workflow-executor.ts` 15,054 → 14,847 行。抽取后全量测试无变化（行为保持），中途靠 `noUnusedLocals` 清掉被孤立的导入。
  **明确这只是一刀**：`App.tsx` 6,597 行与流程族仍未拆。下一批：⑦ 剩余（C2/C5/C7/C8、D1/D6、E3/E6/E7）。
- 2026-09-13（第 19 轮，批次⑥）：G5 更新决策 + 制品校验（24 测试 + manifest 生成/校验脚本；**核查发现 Tauri updater 插件根本没配置**，
  所以只交付"更新器存在前必须正确"的部分：决策、失败即关闭的哈希校验、降级阻断并给出卸载步骤；实测篡改安装包会被拒）。
  修掉自己脚本里一处不诚实：原本动态 import 一个 `.ts` 校验器会静默失败，等于假装校验过——改为显式结构检查并说明理由。
  下一批：B4/G2 拆巨石。
- 2026-09-13（第 18 轮，批次⑥开局）：G3 文档漂移检查机制（16 测试，接入 `pnpm check`；首跑抓出并修掉 3 处真实漂移，且修法是"去掉会腐化的硬编码"而不是"刷新数字"）、
  G4 仓库卫生（删 128.1 MB 临时产物 + 补 `.gitignore` + **提交 11 轮积压工作** `ca4d58e`：94 文件 / +12,970）。
  下一批：B4/G2 拆巨石、G5 更新与回滚。
- 2026-09-13（第 17 轮，批次⑤收尾）：E1 首次运行诊断（有序清单 + 单一"下一步"，区分阻断与提醒）、
  E5 用量面板（命中率/上下文占用/重量级 agent，缺失时说明原因；**成本刻意可选**——本仓库无价目表，编一份会给出自信的错误金额）。
  **批次⑤ 好用完成**。下一批：⑥ 工程（G3 文档同步 / G4 仓库卫生 / G5 更新回滚 / G2 拆巨石）。
- 2026-09-13（第 16 轮，批次⑤开局）：E2 失败指引（14 类 + 本地化消息 + 有序动作，用例取自生产日志原文；并**删掉运行时里的重复分类器**改为委托）、
  E8 术语统一（查到的是**真实缺陷**而非文档笔误：`providerFor("chinese-reviewer")` 从来没被归一化，中文评审静默用主档模型；
  已修别名 + 调用点 + 5 个词汇契约测试）。下一批：E1/E5/E4（引导、成本与缓存面板、审批中心 UI 复用）。
- 2026-09-13（第 15 轮，批次④收尾）：D5 统一审批中心（归一化队列 + 带理由的风险分级 + "本次会话不再询问"且**永不覆盖 dangerous**）
  、D2 handoff 协作叙事（中英双语 + 三类缺口）。**批次④ 多 agent 协作完成**。本轮抓到三个自己的问题：D5 的"过期 dangerous 永久否决授权"、
  D2 的"`step.id` vs `stepId` 导致每次交接都被误报为缺口"，以及一个**流程错误**——我用 PowerShell `Get-Content -Raw`+`-replace`+`Set-Content`
  改 TS 源码，**把 UTF-8 中文注释与文案整段弄成乱码**，只能用 write 工具整体重写两个文件修复。结论：源码编辑一律走 edit/write 工具，不做 shell 文本替换。
  下一批：⑤ 好用（E1/E2/E5/E8）。
- 2026-09-13（第 14 轮，批次④开局）：D3 核查后确认**已实现且有测试**（并发上限/背压/限速/熔断/心跳/重试），只做记录；
  D4 落地并发写冲突租约（19 单测 + 3 个调度器级测试）并接入调度器。**过程中既有测试抓出我引入的一个真实回归**：
  我的 `executeStep` 包装只透传了两个参数，丢掉了第三个参数（该次尝试的 abort signal），导致 `aborts a timed-out step attempt` 变红——
  已改为 `(...args) => executeStep(...args)` 全量透传。这正是"每轮必须跑全量测试"的价值。
- 2026-09-13（第 13 轮，批次③收尾）：C3（SKILL frontmatter，**外部约定经仓库自带 Playwright 核对**：Agent Skills 标准字段 +
  1,536 字符清单上限 + `disable-model-invocation` 已接线为"不被自动选中"）、C6（插件清单 + 信任分级安装计划，声明与授予分离、
  禁止遮蔽内置 tool/agent、恒需审批）。**批次③ 客制化核心完成**。
  下一批：④多 agent 协作（D3 并发预算 / D4 写冲突租约 / D5 统一审批 / D2 handoff 叙事）。
- 2026-09-13（第 12 轮，批次③）：B3 工具注册协议（18 测试）。**过程中修掉一个我自己写反的不变量**：初版把"read → confirmed_write"
  当作需要拒绝的升级，方向正好相反——真正危险的是**放宽**权限（`confirmed_write → read`），会把签入仓库的配置文件变成绕过原生审批的通道。
  现已改为只拒绝放宽、允许收紧，并把这个语义写进函数名（`isPermissionRelaxation`）与测试名。
  接线：配置里 `disabled: true` 的工具已真正从可用描述符中移除。
- 2026-09-13（第 11 轮，批次③）：B2b（声明式 agent 注册进**既有** registry——原地注册而非换对象，因为运行时已捕获引用；
  新增 `changedAgents` 只返回改动项）+ C4b（`beforeApproval` 汇总 hook 理由进审批卡，4 测试；`onTaskFail` 写入失败日志）。
  B2/C4 至此端到端可用了：`.javis/config.json` 能改 agent 白名单/人格，也能真的拦住工具。
- 2026-09-13（第 10 轮，批次③）：C1b（受守卫的 Rust 配置读取 + 桌面加载器 + 接入启动链）、B2（声明式 agent 合并：替换 vs 追加、
  逐语 prompt 覆盖、仅在给出 persona 时才创建新 kind、runtime override 分离，15 测试）、C4 接线到应用启动（`.javis` 里的 hook 现在真的会装进运行时）。
  缺口：B2b（运行时重建 agentRegistry）、C4b（beforeApproval/onTaskFail）。
- 2026-09-13（第 9 轮，批次③开局）：C1 配置模型（分层/覆盖/删除/诊断，20 测试）+ C4 Hook 引擎
  （四相位、纯声明式动作、`beforeToolCall` 已在调度器真正强制，33 测试 + 2 个执行器强制测试）。
  C1b（桌面加载器）与 C4b（审批/失败相位接线）留作下一步。
- 2026-09-13（第 8 轮，批次②收尾）：**M1 完成**。A4b 落地 —— `tool-output-repairs.ts` 有界日志（200 条，按工具汇总即"修复率"分子）
  + 镜像进 `SharedTaskContext.toolOutputRepairs`（随 handoff/制品传递），三处输出校验点全部接入；10 个新测试
  （8 个日志单测 + 执行器侧的上下文断言）。Inspector 可视化面板留作后续。
- 2026-09-13（第 7 轮，批次②）：M1 收尾 —— A3（`withStallWatchdog` 停摆看门狗 + 生成预算与任务预算分离 + 中断保留正文）、
  A5（当前回合预飞预算 `chat-turn-budget.ts`）。**A5 的调查推翻了原假设**：历史早已有预算，真正的缺口是当前回合；
  我第一版实现了重复的第二层预算，被 3 个既有测试当场打红，遂回退并改为只约束当前回合——这条过程记录留在 A5 行里。
  顺带修正：A3 的生成预算 helper 与 write-intent 门禁共 9 个测试。
- 2026-09-13（第 6 轮，批次①②）：F 度量层落地 —— `pnpm eval`（29 条 golden task + scorecard，接入 `pnpm check`）、
  `pnpm metrics`（真实运行指标，首跑失败率 46.3%）、`pnpm diagnostics`（脱敏包 + 6 个脱敏单测）。
  A1f/A1h/A1i 收口：**A1h 根因定位**——eventBus→runtime 桥不校验终态，失败任务仍在跑的模型流按 delta 速率触发持久化；
  新增 `shouldAcceptRuntimeDelta` 修复。A1f 补生产级回归（TS 26,729 次通知 / Rust 34,777 行）。
  顺带：golden 集抓出并修复问句/评审误开写入流 + 空计划通过编译；写入热路径加 `appendEntry` 快路径（sanitize 3 次 → 1 次，负载测试 20s+ → 9.6s）。
- 2026-09-13（第 4 轮）：A4 基本落地 —— 新增 `repairToolSchemaValue`（有界强制类型 + 有界丢弃坏数组元素），
  接入 `validateToolDescriptorOutput`，修复后的值替换原始输出写入 SharedContext。输入侧刻意不动（有测试保护的既定行为）。
  实现中修掉一个自己引入的回归：无脑深拷贝会破坏 artifact/provenance 的引用语义（2 个既有测试红），
  现改为"无修复时原样返回入参"。告警仅到 `console.warn` → 记 A4b。
- 2026-09-13（第 3 轮）：A1g 落地 —— 把 `workflow_checkpoints` 纳入同一条原生命令（命令更名 `runtime_history_maintain`，
  请求/报告随之扩展），并加 approval-resume 保护规则。真实库副本实测 **464.6 MB → 14.9 MB（−96.8%）**，
  checkpoint 711 → 76 行。顺带发现 `workflow_checkpoints` 在生产中只写不读（记为 A1i）。
- 2026-09-13（第 2 轮）：A2 落地 —— `sql_ipc_contract` 跨语言门禁（185 条受检 / 14 条豁免），并借它抓出并修复 2 个真实缺陷
  （`SELECT_RECENT_TOOL_CALL_AUDIT_SQL` 未登记导致启动初始化链中途中止；`usage_observations` 按任务查询缺 `LIMIT 10000`）。
- 2026-09-13：建立本文件。M1 落地 A1a–A1e（写入去重/节流 + 原生保留策略 + 启动与终态接线）、G1（typecheck 覆盖 apps/desktop 与 sidecar）。
