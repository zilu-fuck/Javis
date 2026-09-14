# 文本写入误路由 + 上下文计量黑箱：根因与修复方案

- **状态**：待评审（本文档只做诊断与方案，未改动任何代码）
- **触发**：真实测试 — Agent 模式下输入 `创建一个 HTML，内容是：SVG 绘制一只鹈鹕骑自行车的 2D 动画。`
- **现象**：上下文窗口显示 `0 / 128k（0%）` + `未调用模型`；界面上只有一句机械提示
  「指挥官正在准备文本内容，写入文件前会请求确认写入授权。」，没有 回复→思考→干活→审查→测试 的 agent 形态
- **证据来源**：`%APPDATA%\app.javis.desktop\task-audit.jsonl`（任务 `task-1789271409084`）+ 磁盘产物
  `E:\测试\一个-html-内容是-svg-绘制一个鹈鹕骑自行车的-2d-动画.md`

---

## 1. 真实运行证据链

| 时刻（本地） | 审计记录 | 含义 |
|---|---|---|
| 03:50:09 | `agent-commander / completed / 普通对话已回答` | 上一条消息（"你好"）走了 L1 直答 |
| 03:50:20.300 | `agent-commander / planning / Generating DAG plan` | 本目标**曾进入 Commander DAG 规划** |
| 03:50:34.379 | `completed / 说明可做的事并引导用户选择方向` | 第一次尝试未落地为产物 |
| 03:51:09.713 | `agent-commander / planning / 准备文本写入流程` | **改走 `runTextWriteTask`（文本写入管道）** |
| 03:51:09 → 03:53:52 | （无任何审计记录）**静默 2 分 43 秒** | 单次 `chatTool.stream` 生成整篇正文 |
| 03:53:52.706 | `workspace.files.sync / Plan text write for …2d-动画.md` | 目标路径被推成 `.md` |
| 03:53:52.802 | `file.writeText / waiting_permission / create …2d-动画.md` | 进入确认写入授权 |
| 03:54:14.503 | `file.writeText started` | 用户批准后写入 |
| 03:54:14.557 | `agent-verifier / 已验证写入结果` | 仅"确认写入发生"，非内容审查 |

### 1.1 磁盘产物实证（前 3 行）

```
这是您需要的 HTML 页面，用 SVG 绘制了一只骑自行车的鹈鹕，并带有 2D 动画效果。
```html
<!DOCTYPE html>
```

用户要 `.html`，拿到的是 **`.md`**，且内容是「一句聊天话术 + ```html 代码块」——
**双击不可打开**，需要人工剪贴才能变成网页。共 338 行 / 14,772 字节，正文质量本身不差，问题在交付形态。

---

## 2. 根因一：路由契约把"产物生成"误判成"文本代写"（主因）

### 2.1 判定链（按执行顺序）

1. `packages/core/src/index.ts:2825`
   `const textWriteGoal = isTextWriteGoal(routingGoal);` → **true**
2. `packages/core/src/text-write-flow.ts:53` `isTextWriteGoal()`
   - `hasWriteAction`：`创建一个` 命中 `创建` → true
   - `hasFileTarget`：`|| /\bHTML\b/i.test(userGoal)`（第 61 行）→ **true**
   - 第 68 行 `TEXT_WRITE_EXPLICIT_DESTINATION` 未命中，第 73 行不是问句/评审 → **返回 true**
3. `packages/core/src/index.ts:2937` `decideRuntimeChain({ isTextWriteGoal: true, hasCommanderTool: true, … })`
4. `packages/core/src/runtime-chain.ts:202` `shouldCommanderPlanTextWrite()`
   → `hasCommanderTool && isTextWriteGoal` 成立，但第 206–215 行的"
   有 URL / 读当前项目 / 研究 / 项目巡检 / 代码评审 / PDF 整理 / 推荐工作流 / 专家 agent / 代码库理解"
   **全部为 false** → **返回 false**
5. `packages/core/src/runtime-chain.ts:99-101`
   → `dispatch = { kind: "single_agent_task", reason: "text_write_requires_approval_flow" }`
6. `packages/core/src/index.ts:3004-3052`（Legacy 分支）
   `single_agent_task && textWriteGoal` 成立 → **`void runTextWriteTask({...})` 直接 return**

**结果：Commander DAG、`file.writeText`（DAG 内本就有带审批的写入步骤）、Verifier、Test Runner 被整体短路。**

### 2.2 管道本身没有 agent 形态

`runTextWriteTask` → `generateTextContent()`（`text-write-flow.ts:646`）是
**一个 prompt 让模型一次吐出完整文件全文**，随后：

- 无工具调用（除可选的 `web.search`）
- 无内容审查（Verifier 只确认"写入发生了"）
- 无测试/自检
- **无格式意识**：`buildTextGenerationPrompt`（第 841 行）从不区分 `.md` 与 `.html`，
  所以模型自然按"对话式给代码"的惯性输出 ```html 包裹块
- 目标路径由 `inferMarkdownTarget`（第 929 行）决定，**函数名即契约：它只会推出 `.md`**
  （`buildMarkdownTarget` 第 973 行硬编码 `${basename}.md`）

### 2.3 这与已登记的"五层合法性"设计自相矛盾

`CLAUDE.md` / `AGENTS.md` 声明：`file.writeText` 属 Commander DAG 的合法步骤，走
「plan → UI approval → native approve → one-shot execute」，并且
`commander-route-contract.ts` 存在的目的就是"短目标需要专家时不能塌缩成 Commander-only 响应"。
本次故障是**反向塌缩**：一个有明确产物、可验证、可测试的目标，塌缩成了一条无审查的单轮文本管道。

### 2.4 被测试固化的行为（所以一直绿）

`packages/core/src/index.test.ts:3719-3723`

```ts
it("detects HTML/page create goals as text writes", () => {
  expect(isTextWriteGoal("创建一个 HTML，内容是: SVG 绘制一个鹈鹕骑自行车的 2D 动画。")).toBe(true);
  expect(isTextWriteGoal("create an HTML page with a parrot animation")).toBe(true);
```

**用户这次的真实目标被原文写成了期望值。** 改契约必须同时改这条测试，否则 CI 会挡住正确修复。

---

## 3. 根因二：就算改走 Commander，`file.writeText` 仍会被合法性闸门拒绝（隐藏连带）

只把路由从文本管道改到 DAG **不足以**修复，会撞上第二道门：

1. `packages/tools/src/descriptors.ts:326 / 338`
   `file.planWriteText` 与 `file.writeText` 都声明了 `requiredPlanIntent: "write"`
2. `packages/core/src/planning/commander-plan-validator.ts:702-716`
   `input.planIntents?.write !== true` 时 → 抛 `WRITE_WITHOUT_USER_INTENT`（**severity: error**）
3. `packages/core/src/planning/plan-legality.ts:108-127` `detectCommanderPlanIntents()`
   对该目标的判定（逐条核对）：
   - `EXPORT_PATTERNS`：`导出…` / `\bexport\b` → **不命中**
   - `PERSISTENCE_PATTERNS`：需要 `保存|写入|落盘|…` 或 `生成.{0,8}(文件|文档|报告|表格)`；
     目标里是 **`创建`** 而非 `生成`，也无 `文件` 紧跟 → **不命中**
   - `DOCUMENT_PRODUCTION_PATTERNS`：动词表 `(写|撰写|编写|起草|创建|制作|生成|…)` 命中 `创建`，
     但名词表 `(报告|报表|白皮书|纪要|文档|文件|README|…\.(md|txt|json|csv))` **不含 `HTML` / `网页` / `页面`**
     → **不命中**
   - 结论：`write = false`

**即：`创建/写一个 HTML 页面` 在整个 core 里既不是"文本写入意图"，也不是"文档生产意图"。**
两个分类器（`isTextWriteGoal` 与 `detectCommanderPlanIntents`）**一起漏掉了 HTML/网页/脚本类产物**，
只是一个漏向"错误管道"，一个漏向"拒绝"。

---

## 4. 根因三：上下文窗口 `0%（未调用模型）` 是必然，不是渲染故障

1. `text-write-flow.ts:127` 初始快照写死 `tokenUsage: createEmptyTokenUsageSummary()`
   → `modelCalls = 0`、`totalTokens = 0`、无 `contextUsedTokens / contextWindowTokens`
2. 真实用量要等 `generateTextContent` 结束（03:53:52）才由 `recordModelCall()` 回填——
   而 `tokenUsage` **只在 preview / waiting_permission / failed 三处快照里出现**
3. `packages/ui/src/components/ContextRing.tsx`
   - `modelCalls = 0` → `meta = labels.noModelCalls`（"未调用模型"）
   - `hasMeasuredContext = false` → `usedTokens = 0`、`maxTokens = resolveMaxTokens()` 兜底 128k
   - `label = usedTokens > 0 ? pct : "0%"` → 显示 `0%`

**推论：用户截图时刻正处在那个 2 分 43 秒的黑箱窗口内。**
对用户而言，这段时间就是"没有任何回复，只有一句机械内容，计数器还骗人说没调用模型"。

---

## 5. 修复方案

### H1 路由契约收敛（必做）— 让"产物生成"进 DAG

`packages/core/src/text-write-flow.ts`

- `isTextWriteGoal` 的 `hasFileTarget` **移除 `/\bHTML\b/i`**，并区分：
  - **纯文本正文**（`.md` / `.txt` / `报告|笔记|纪要|总结`）→ 保留文本写入管道
  - **产物类**（`.html` / `.css` / `.js` / `.ts` / `.svg` / `网页|页面|脚本`）→ 不进文本管道
- `inferMarkdownTarget` 一族保持"只做 Markdown"的语义（函数名即契约），不再被当成通用写入路径

`packages/core/src/planning/plan-legality.ts`

- `DOCUMENT_PRODUCTION_PATTERNS` 扩展产物名词：`HTML|网页|页面|脚本|SVG|web ?page|\.(html?|css|js|ts|svg)`
- 使 `detectCommanderPlanIntents("创建一个 HTML…")` → `write: true`，
  从而 `file.writeText` 步骤通过 Layer 5 闸门

**验收**：该目标 → `dispatch.kind === "commander_task"`，DAG 内出现
`file.planWriteText`（preview）+ `file.writeText`（confirmed_write）+ verifier 步骤，
目标路径扩展名为 `.html`。

### H2 写入保真（建议，可独立于 H1）

即使走了 DAG，`file.writeText` 目前按"文本"写入，需要明确：

- `targetPath` 扩展名由目标/内容决定（`.html` 就是 `.html`），不由"Markdown 推断"决定
- 内容规范：写 `.html` 时**不得**包裹 ```html 代码块、不得加对话式开场白

### H3 上下文计量实时可见（必做）

`packages/core/src/text-write-flow.ts`

- `recordModelCall` 在流式过程中就被调用（`onUsage` 已存在），并把结果同步进**正在流式的快照**
  （delta 路径），而不是只在生成结束后的 preview 快照里出现
- 生成期间在 UI 上给出明确的进行态，而不是 `未调用模型 · 0%`

`packages/ui/src/components/ContextRing.tsx`

- `modelCalls > 0` 时不得再展示 `noModelCalls` / `0%`；
  `contextUsedTokens` 缺失时应回退到 `peakContextTokens`，并标注其为估算值

### H4 已登记但需确认的历史遗留（不改，仅记录）

- `packages/core/src/index.ts` 第 2981–3003 行等处的**源码注释真损坏**（非我的读取工具问题）：
  文件内实际字节含 `鈥?` 这类 UTF-8 mojibake（已用字节级校验确认，全文非 ASCII 字符 755 个）。
  属注释层缺陷，不影响运行，但会持续污染编辑体验；建议单独立项清理。
- `packages/core/src/index.ts` 与 `apps/desktop/src/App.tsx` 仍是最大两个文件（历史登记项）。

---

## 6. 改动清单（评审通过后执行）

| # | 文件 | 改动 | 风险 |
|---|---|---|---|
| 1 | `packages/core/src/text-write-flow.ts` | `isTextWriteGoal` 产物类排除；移除 `HTML` 命中 | 中（影响路由契约） |
| 2 | `packages/core/src/planning/plan-legality.ts` | `DOCUMENT_PRODUCTION_PATTERNS` 补产物名词 | 中（影响写入闸门） |
| 3 | `packages/core/src/index.test.ts:3719` | 期望值翻转为 `false`，并新增"HTML 目标进 Commander"断言 | 必做，否则 CI 挡修复 |
| 4 | `packages/core/src/text-write-flow.ts` | usage 实时回填流式快照 | 低 |
| 5 | `packages/ui/src/components/ContextRing.tsx` | 调用过模型就不再显示"未调用模型 / 0%" | 低 |
| 6 | `docs/qa/2026-09-13/` | 回归证据（路由落点 + 产物形态） | — |

**测试要求**（`AGENTS.md`：新功能必须有测试）：
`text-write-flow.test.ts` + `plan-legality` 相关测试 + `ContextRing.test.tsx` 各补用例，
覆盖「HTML 目标不进文本管道」「HTML 目标 write intent 成立」「有调用但无 usage 时不显示 0%」。

---

## 7. 回归验证（本次执行）

1. **基线**：改动前跑 `pnpm check`（typecheck + Vitest + rust:check），确认闸门本来就绿，
   避免把既有失败误算到本次改动头上。
2. **改动后**：再跑 `pnpm check`。
3. **真实目标回归**：以 `创建一个 HTML，内容是：SVG 绘制一只鹈鹕骑自行车的 2D 动画。`
   走 `routeMessage` + `decideRuntimeChain` + `detectCommanderPlanIntents` + `compileCommanderPlan`，
   断言落点为 Commander DAG 且写步骤合法；证据存 `docs/qa/2026-09-13/`。

---

## 8. 附录 A：H1 补丁形态与必须守住的既有负例

### A.1 `detectCommanderPlanIntents` 只能"条件式"扩展，不能无脑加 `HTML`

`planIntents.write === false` 是**一批既有正例**（纯回答类目标）的期望值：

- `packages/core/src/planning/__tests__/plan-legality.test.ts:46-63`
  `总结今天微博热搜榜前20` / `review the project` / `explain this export function` /
  `这个 README.md 是做什么的` → 期望 `write === false`
- 同文件 `:79-86`：`检查当前项目的目录结构…` → 期望 `write === false`
- `packages/core/src/eval/golden-tasks.ts:150`：`如何创建一个 HTML 页面？` → 期望 `textWrite: false`

若把 `HTML` 直接塞进 `DOCUMENT_PRODUCTION_PATTERNS` 的名词表，会同时命中
`如何创建一个 HTML 页面？`（询问）与 `这个 README.md 是做什么的`（询问），
**把"回答问题"升级成"写入许可"，直接撞掉上述负例。**

因此 H1 的第二步须写成**条件式**（产物意图 ∧ ¬询问），而不是扩充裸名词表：

```ts
/** 非 .md 的产物类文件目标（网页/脚本/样式/矢量图）。 */
const ARTIFACT_FILE_PATTERNS: readonly RegExp[] = [
  /[^\s，。；;!?？"'`]+\.(?:html?|css|js|mjs|cjs|tsx?|jsx|svg)\b/i,
  /(?:网页|页面|静态页|landing page|web ?page)/,
  /\b(?:html|css|svg|canvas)\b/i,
];

/** 询问/评审类目标只是"问怎么做"，不得升级为写入意图。 */
const ARTIFACT_QUESTION_PATTERN =
  /^\s*(?:如何|怎么|怎样|为什么|什么是|请问|能否|可不可以|是不是)|[?？]\s*$|\b(?:how (?:do|can|would|should) i|how to|what is|why (?:is|does)|can you explain)\b/iu;

const ARTIFACT_REVIEW_PATTERN =
  /评审|审查|检查一下|排查|分析一下|解释|总结一下|回顾|复盘|\b(?:review|explain|analy[sz]e|summari[sz]e|inspect)\b/iu;

const artifactProduction =
  matchesAny(ARTIFACT_FILE_PATTERNS, goal) &&
  !ARTIFACT_QUESTION_PATTERN.test(goal) &&
  !ARTIFACT_REVIEW_PATTERN.test(goal);
```

> 注：`ARTIFACT_QUESTION_PATTERN` / `ARTIFACT_REVIEW_PATTERN` 与
> `text-write-flow.ts:42-47` 的 `TEXT_WRITE_QUESTION_PATTERN` / `TEXT_WRITE_REVIEW_PATTERN`
> 语义相同。实现时应**抽到共享位置**（`packages/core` 内），避免两处正则各自漂移——
> 本次故障的成因之一正是"同一概念在两个分类器里各写一份，然后一起漏掉 HTML"。

### A.2 `isTextWriteGoal` 的收敛点

只改一处即可：第 61 行把 `|| /\bHTML\b/i.test(userGoal)` 从 `hasFileTarget` 中**移除**，
并让扩展名白名单明确排除产物类：

```ts
const hasFileTarget =
  /\.(md|txt)\b/i.test(userGoal)                                  // 纯文本正文
  || /文件|文档|笔记|报告|纪要|总结|\b(?:file|document|docs?|notes?|report|markdown)\b/i.test(userGoal);
```

- 保留 `.md/.txt` → 既有 4 条 golden `write-intent-*` 仍为 `textWrite: true`
- 移除 `HTML` 与 `页面|网页|脚本` → 本目标落入 Commander DAG
- `inferMarkdownTarget` / `buildMarkdownTarget`（第 929/973 行）**不做泛化**，
  继续只服务 Markdown；通用写入由 DAG 的 `file.writeText` 承担

### A.3 必须同步改的断言（否则 CI 会挡住正确修复）

| 位置 | 现状 | 改为 |
|---|---|---|
| `packages/core/src/index.test.ts:3719-3723` | `it("detects HTML/page create goals as text writes")`，本目标断言 `true` | 断言 `false`，并改写用例名语义为"HTML 产物目标**不**走文本管道" |
| `packages/core/src/eval/golden-tasks.ts` | 无 `创建 HTML` 陈述句用例 | 新增 `expectation: { textWrite: false, planIntents: { write: true } }` |
| `packages/core/src/planning/__tests__/plan-legality.test.ts:39-44` | 无产物类正例 | 新增 `创建一个 HTML，内容是…2D 动画` → `write === true` |
| 同文件 `:46-63` | 纯回答负例 | **保持不变**，作为 A.1 条件式的回归护栏 |

### A.4 交付物形态验收（H2）

`.html` 目标的最终产物必须满足：扩展名 `.html`、无外层 ```html 围栏、无"这是您需要的…"式开场白。
建议在 `docs/qa/2026-09-13/` 存一份产物头部 10 行 + 扩展名断言作为证据。

---

## 9. 结论（一句话）

不是模型没回答，而是**这条目标被一个把 `HTML` 当"文本文件"的正则，从 agent 循环里劫持进了一条
"一次性吐全文、只会写 `.md`、没有审查与测试"的代写管道**；而 `0%（未调用模型）` 是那条管道
在 2 分 43 秒生成期间从不回报用量的必然显示。修法必须**路由与写入闸门成对修改**——只改其中一处，
目标会从"写错格式"变成"直接被合法性拒绝"。
