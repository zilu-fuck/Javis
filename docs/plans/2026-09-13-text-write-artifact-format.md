# 方案：文本写入流程的产物类型跟随请求

**日期**：2026-09-13
**起因**：`创建一个 HTML，内容是: SVG 绘制一个鹈鹕骑自行车的 2D 动画。` 被写成了 `一个-html-内容是-svg-绘制一个鹈鹕骑自行车的-2d-动画.md`
**状态**：已实现（见文末"执行记录"）

---

## 一、问题与证据

### 1.1 现象

用户在项目模式下要求"创建一个 HTML"，应用产出了：

- 文件名：`E:/测试/一个-html-内容是-svg-绘制一个鹈鹕骑自行车的-2d-动画.md`
- 内容（338 行）：一句中文说明 + ```` ```html ```` 围栏包裹的 HTML 文档

即**扩展名错**（`.md` 而非 `.html`）且**内容不洁**（散文前缀 + 代码围栏），双击打开不是网页。

### 1.2 代码链（每一环均已核对）

| 环节 | 位置 | 行为 |
|---|---|---|
| 分类 | `packages/core/src/text-write-flow.ts:53` | `isTextWriteGoal` 的 `hasFileTarget` **显式包含** `\bHTML\b`，所以"创建 HTML"被判为文本写入目标 |
| 路由 | `packages/core/src/index.ts:3035` | `textWriteGoal && planWriteText` → `runTextWriteTask(...)` 后 `return`，绕过 Commander/DAG 规划 |
| 取名 | `text-write-flow.ts:152 → 929 → 951 → 959` | `inferMarkdownTarget` 只认 `.md` 目的地；否则 `buildMarkdownTarget` 把整段目标 slug 化后**硬拼 `.md`**（第 973 行） |
| 提示词 | `text-write-flow.ts:859` | `"You are generating the complete contents of a local Markdown file"` —— 把模型按在 Markdown 上 |
| 内容清理 | `text-write-flow.ts:898` | `normalizeGeneratedContent` 只剥 ```` ``` ````/```` ```markdown ```` 围栏，```` ```html ```` 漏网 |
| 落盘 | `apps/desktop/src-tauri/src/file_write.rs` | 只做工作区包含 / 必须新文件 / 禁符号链接 / 审批绑定，**没有任何扩展名逻辑**（所以 `.md` 一路直通，不是被"转换"的） |

### 1.3 路由评估结论（决定本方案的边界）

审计轨迹（`task-1789271409084`，36 条）显示这条路径**治理是完好的**：

```
03:51:09 准备文本写入流程 → 03:53:52 File Agent 创建预览（file.planWriteText, preview 权限）
        → 03:53:52 file.writeText waiting_permission（审批卡）→ 03:54:14 批准后写入
        → 03:54:14 Verifier 已验证写入结果
```

被绕过的**只有"规划"这一层**，审批、文件代理、验证器全部参与。因此本方案**不改路由**：`shouldCommanderPlanTextWrite`（`runtime-chain.ts:202`）的门槛维持原样，`text-write-flow` 继续承担"生成完整文件内容并受控落盘"的职责。

> 附：`task-1789271409084` 的另外两条时间戳（03:50:09 `普通对话已回答`、03:50:20 `Generating DAG plan` → 03:50:34 引导性回答）是**同一 taskId 下的另外两轮对话**，不是一次请求内的路由竞争。taskId 在一次会话内复用。

### 1.4 修复目标

1. **扩展名跟随请求**：目标里明确要哪种产物，就产出哪种扩展名；没说要什么，保持 `.md` 默认。
2. **内容适配类型**：提示词按类型描述产物（HTML 就说 HTML 并给出首尾约束）。
3. **内容洁净**：剥掉与类型匹配的围栏与围栏外的散文，保证"改名就能用"。
4. **不破坏既有行为**：`.md` 路径的取名与清理结果逐字不变。
5. **顺带上锁**（结构性，非本次故障成因）：把 `agents.ts ↔ descriptors.ts` 的归属一致性固化成 CI 检查。

---

## 二、范围

### 在范围内

- `packages/core/src/text-write-flow.ts`：产物类型识别、取名、提示词、内容清理、重试后缀、状态文案
- `packages/core/src/text-write-flow.test.ts`：新增用例 + 既有行为的回归保护
- `scripts/check-agent-tool-ownership.mjs` + `scripts/test-check-agent-tool-ownership.mjs` + `package.json`：归属漂移 CI 检查
- 真机端到端复验（项目模式下重跑同一目标）

### 明确不在范围内（附理由）

| 项 | 为什么不做 |
|---|---|
| 让 Commander 获得 `code.inspectWorkspace` 等只读观察能力 | 会改变规划器的行为面，需要单独的 live 验证设计；与本次故障无因果关系（本条故障里规划层根本没参与） |
| 合并 9 个无独占工具的 agent | 是维护成本与 UI 噪音议题，不是本故障成因；应由独立 ADR 决策 |
| 目标 slug 的质量（`一个-html-内容是-…`） | 纯命名美观问题。**刻意不动**：一旦从词干里删掉格式词会得到"一个-内容是-…"这种更差的词干，现有 `.md` 命名测试也会被牵连 |
| 非 Markdown 目标改走 Commander 规划 | 治理链已被证明完好，改路由的收益不抵风险 |

---

## 三、设计

### 3.1 产物类型模型

```ts
export interface TextArtifactFormat {
  extension: string;        // 规范扩展名，小写含点，如 ".html"
  label: string;            // 提示词/文案里的可读名，如 "HTML"
  fenceLanguages: string[]; // 模型可能用来包裹正文的围栏语言；空数组=该类型不会合法地带围栏
  markdown: boolean;        // Markdown 文档内部本就可以合法包含围栏
}
```

支持集合：`md/markdown`、`html`、`htm`、`css`、`js/javascript`、`mjs`、`json`、`svg`、`txt`。
未识别时使用默认 `Markdown`（`.md`）。

### 3.2 类型识别（精度优先）

按优先级取**最早出现**的信号：

- **规则 A（最强）**：目标里出现带受支持扩展名的文件名 token（`report.json`、`card.html`、`pelican.svg`）。取第一个匹配。
- **规则 B**：格式词 + 产物名词（`HTML 文件` / `HTML 页面` / `HTML file`）。取第一个匹配。
- **规则 C**：创建动词 + 可选量词 + 格式词（`创建一个 HTML，…`）。取第一个匹配，但**排除"话题名词"紧跟其后**的情形——`写一份 JS 教程` 里的 `JS` 修饰的是"教程"，产物是文档而不是 `.js` 文件。

若 A/B/C 均未命中 → 默认 Markdown。

> 精度取舍的理由：过度识别的代价是"关于某格式的文档被写成那个格式的文件"（内容全错），漏识别的代价是"退回 Markdown"（即当前行为）。因此宁可保守。

### 3.3 取名

```
resolveTextWriteTarget(userGoal) -> { path, explicit, format }
```

- 显式目的地（规则 A 命中）→ 直接采用该文件名，**不再 slug 化**（与既有 `.md` 显式路径行为一致）；
  正则从"仅 `.md`"放宽到"受支持的扩展名集合"，于是 `保存为 report.html` 也能被正确尊重。
- 否则 → 沿用既有 slug 逻辑，仅把末尾硬编码的 `.md` 换成 `format.extension`；兜底名 `untitled-document${ext}`。
- **词干逻辑逐字不动**（保证既有 `.md` 命名测试不变）。
- 内容反推命名（`# 标题` → 文件名）**仅对 Markdown 生效**：非 Markdown 内容没有这种标题约定，且可避免误把正文里的 `#` 当标题。

### 3.4 提示词

首行改为按类型描述：`You are generating the complete contents of a local ${label} file for the user.`

非 Markdown 追加一条约束：

```
The file must be a complete, standalone <label> document: start at its first character and end at its last. Do not add commentary, an introduction, or a surrounding code fence.
```

HTML 再追加：`Start with <!DOCTYPE html> and end with </html>.`

其余各行保持不变（长度约束、语言一致、来源列表等）。

### 3.5 内容清理

`normalizeGeneratedContent(content, format)`：

- **Markdown**：保持现有行为逐字不变（只剥外层 ```` ``` ````/```` ```markdown ````）。
- **非 Markdown**：
  1. 若存在围栏，且其语言为空或属于 `format.fenceLanguages`，且能找到闭合围栏 → 取围栏**内部**作为正文，围栏前的散文与围栏后的尾巴一并丢弃。（这是 pelican 的实际形态：一句"这是您需要的 HTML 页面…" + ```` ```html ```` 围栏。）
  2. 否则（HTML 专属）裁到文档边界：出现 `<!DOCTYPE` 或 `<html` 时从其位置开始；出现 `</html>` 时在其后结束。
  3. 其他情况原样返回（不做猜测性裁剪）。

### 3.6 其他一致性修正

- `appendMarkdownTargetSuffix`：现逻辑对非 `.md` 会产出 `x.html-1` 这种坏名，改为对任意扩展名都产出 `x-1.html`。
- 状态/审计文案：`指挥官准备 Markdown 正文` / `等待 Markdown 正文` / `Markdown 正文已准备` → 按类型渲染（如 `HTML 正文已准备`）。已确认无外部测试断言这些字符串。

---

## 四、测试计划

### 4.1 单元测试（`packages/core/src/text-write-flow.test.ts`）

| 组 | 断言 |
|---|---|
| 类型识别 | pelican 目标 → `html`；`report.json` → `json`；`写一份 JS 教程` → **不**识别为 js（话题名词守卫）；无格式词 → 默认 md |
| 取名 | pelican 目标 → `...html` 且词干与既有规则一致；`保存为 report.html` → 精确 `report.html`；无格式词 → `.md`（回归） |
| 提示词 | HTML 目标的提示词出现 "HTML file" 与 `<!DOCTYPE html>` 约束；Markdown 目标不出现 |
| 内容清理 | pelican 形态（散文+```html 围栏）→ 无围栏、无散文、以 `<!DOCTYPE html>` 开头；Markdown 内容含围栏 → **原样保留**（回归）；无围栏的 HTML → 裁到 doctype 边界 |
| 重试后缀 | `x.html` + 1 → `x-1.html`；`x.md` + 1 → `x-1.md`（回归） |

### 4.2 真实样本回归

用**磁盘上那个真实产物的形态**（散文 + ```` ```html ```` 围栏 + `<!DOCTYPE html>…</html>`）作为固定输入，断言清理后可以原样保存为可用网页。测试内嵌该形态的短样本，保证自包含。

### 4.3 结构性检查

`scripts/check-agent-tool-ownership.mjs`：解析 `agents.ts` 与 `descriptors.ts`，双向比对（持有但非 owner / owner 但未持有），任何漂移即非零退出；`scripts/test-check-agent-tool-ownership.mjs` 用合成 fixture 验证检查器**真的会报错**（而不是恒绿）。
当前基线：0 漂移（62 个带 owner 的工具 × 19 个 agent）。

### 4.4 门禁与真机复验

- `pnpm typecheck`、core 全量单测、`docs:check`、`docs:test`、`roadmap:audit`、`bundle:check`、`pnpm eval`（含写意图 golden tasks）、desktop 单测、`rust:test`
- 真机：重启应用后在**项目模式**重发同一目标，确认产出 `.html`、内容以 `<!DOCTYPE html>` 开头、审批卡与验证器仍然参与

---

## 五、回滚

单文件为主（`text-write-flow.ts` + 其测试）。回滚 = 还原该文件；新导出的 `resolveTextWriteArtifact*` 只被本文件内部与测试使用，无外部耦合。CI 检查脚本为独立新增，删除脚本与 `package.json` 两行即可。

---

## 六、执行记录

### 6.1 改动清单

| 文件 | 改动 |
|---|---|
| `packages/core/src/text-write-flow.ts` | 新增产物类型模型与识别（`TextArtifactFormat` / `inferTextArtifactFormat`，规则 A 显式文件名 → 规则 B 格式词+产物名词 → 规则 C 创建动词+格式词，含话题名词守卫，取文本中最早信号）；`resolveTextWriteTarget` 取代 `inferMarkdownTarget` 并把扩展名从表里取；显式目的地正则从"仅 `.md`"放宽到受支持扩展名集合；`normalizeGeneratedContent(content, format)` 按类型清理（非 Markdown 剥匹配围栏+丢弃围栏外散文、HTML 裁到 `<!DOCTYPE`/`<html` 与 `</html>` 边界）；`buildTextGenerationPrompt` 按类型描述产物并给出形状约束；`appendTextTargetSuffix` 把重试后缀放到扩展名之前；计划步骤与状态文案按类型渲染 |
| `packages/core/src/text-write-flow.test.ts` | 新增 16 个用例（类型识别 5 / 取名 4 / 内容清理 5 / 提示词 2），共 25 个 |
| `scripts/check-agent-tool-ownership.mjs` | 新增：`agents.ts` ↔ `descriptors.ts` 归属双向比对，含"owner 未注册"分支 |
| `scripts/test-check-agent-tool-ownership.mjs` | 新增：6 组建模夹具 + 仓库零漂移断言 |
| `package.json` | 新增 `agent:ownership` / `agent:ownership:test`，并接入 `pnpm check` |
| `docs/qa/REAL_TEST_CASES.md` | A4 的 core 计数 1652 → 1668（指令文档必须为当前值） |
| `docs/HARNESS_ROADMAP.md` | 仅更新"当前状态"一节的 core 计数并注明来源；带日期的实测记录保持快照不动 |
| `.dsh-tmp/s6-ts.txt` | 刷新为**本轮**测试输出捕获（该文件是 `roadmap:audit` 用来比对的"上次实测"，旧捕获是 03:02 的 1652；未剥离 ANSI 的捕获会让审计静默失能，刷新时已剥离） |

### 6.2 方案 §1.4 修复目标逐条勾对

1. **扩展名跟随请求** ✅ 真机验证：同一目标产出 `.html` 而非 `.md`
2. **内容适配类型** ✅ 提示词按类型描述；真机进度文案由"准备 Markdown 正文"变为「准备 **HTML** 正文」
3. **内容洁净** ✅ 新产物首行即 `<!DOCTYPE html>`、结尾 `</html>`、无围栏（围栏计数 0）
4. **不破坏既有行为** ✅ 既有 `.md` 取名与清理断言逐字保留；core 1652 → 1668（+16 新增），desktop 1012 不变
5. **归属一致性上锁** ✅ `agent:ownership` 在仓库上 19 agents / 62 tools / **0 漂移**，故障注入自测可复现触发

### 6.3 门禁结果（本轮全部实跑）

```
typecheck（5 包）..................... 0 错误
vitest: core 1668 / desktop 1012(+2 skipped) / ui 219 / tools 53 / sidecar 6 ... 全绿
eval ................................ 29/29 golden tasks (100.0%)
eval:test / docs:test ............... 6 pass / 16 pass，0 fail
docs:check .......................... 0 error 0 warning
roadmap:audit ....................... 68 路径 0 缺失；计数一致（无 NOTE）
bundle:check ........................ 0 error / 1 known offender
agent:ownership(+:test) ............. 0 漂移 / 自测通过
rust:test ........................... 599 passed, 0 failed
desktop build + e2e:smoke ........... 构建成功；rendered=true 9184 chars，地标 3/3，0 错误
```

### 6.4 真机端到端复验（项目模式，同一目标）

| | 修复前 11:54 | 修复后 12:49 |
|---|---|---|
| 文件名 | `…2d-动画.md` | **`…2d-动画.html`** |
| 大小/行数 | 14772 字节 | 15379 字节 / 371 行 |
| 首行 | "这是您需要的 HTML 页面…" | **`<!DOCTYPE html>`** |
| 结尾 | ``` 围栏 | **`</html>`** |
| 真实浏览器渲染 | 渲染不出（.md） | **渲染出完整动画**（太阳/云/山/路面/鹈鹕骑自行车，见 `evidence/fix-02-html-renders.png`） |

审计轨迹（同一目标新一轮，`task-1789274753792`）：

```
04:49:19 Commander completed    HTML 正文已准备
04:49:19 workspace.files.sync   Plan text write for 一个-html-内容是-….html
04:49:19 file.writeText         waiting_permission  create E:/测试/一个-html-内容是-….html requires confirmed-write approval
04:49:26 file.writeText         succeeded
04:49:26 Verifier completed     已验证写入结果
```

证据：`docs/qa/2026-09-13/evidence/fix-01-plan-html-step.png`（进度项显示"指挥官准备 HTML 正文"）、`fix-02-html-renders.png`（渲染结果）。

### 6.5 与方案的偏离（2 处，均如实标注）

1. **Markdown 清理改为"成对解包"**：方案原文说 Markdown 行为"逐字不变"。实现时发现既有逻辑**独立**剥离首尾围栏，会吃掉"合法以代码块结尾的 markdown"的闭合围栏（内容污染，与本次同类）。改为"只有剥掉开头围栏时才剥结尾围栏"，既有包装场景行为不变，新增一条回归用例覆盖。属于修小的既有缺陷，非扩大范围。
2. **文档计数维护**：方案 §4.4 未含文档更新，但新增 16 个用例使 `roadmap:audit` 报出计数不一致。按"指令文档更新、历史记录不动"的原则处理（见 6.1 末两行）。

### 6.6 未决事项（安全相关，本次未查清）

本轮真机复验中，`file.writeText` 在**我没有做任何批准操作**的情况下，于 `waiting_permission` 后 7 秒被放行并写入成功：

- 持久化审批表 `approval_records` 中**没有**该任务的记录（最新记录仍是 6 月的 QA 数据）；
- `app-runtime.ts` 中未找到自动批准路径，全仓也没有 auto-approve / skipApproval 类开关；
- 底栏那个被读成"完全访问"的芯片，全仓只对应 `locale.ts` 的 `请求完全访问`（一个**请求**按钮），不足以解释放行。

**结论：放行来路未查明**，与本次改动无因果关系（本方案未触碰审批链），但属于"审批是否可被绕过"这一类问题，建议单独立项核查。已在真机验证中如实记录，不猜测原因。

