# REAL_TEST_CASES.md 执行报告

**执行日期**：2026-09-13
**执行方式**：第一部分命令行自动跑；第二部分在真机桌面应用里用电脑操作（UI Automation + 截图）逐条执行
**代码版本**：分支 `codex/langchain-agent-runtime-migration`，HEAD `3997622`（执行时工作区干净）
**环境**：Windows 10.0.26200 · Node v24.14.0 · pnpm 10.32.1 · cargo 1.95.0 · git 2.47.1
**应用**：`pnpm dev` 启动的 Tauri dev 构建（`javis-desktop.exe`，debug），活动工作区 = `E:\测试`

---

## 一、总体结论

| 部分 | 结果 |
|---|---|
| 第一部分 A1–A4 | **全部通过**，计数与文档声明完全一致（含故障注入复验） |
| 第二部分 M1 | 4/5 检查点实测（1 条因无法构造"空工作区"未测）；**E1b 缺口确认**，且发现"缺密钥→模型列表也清空"的连锁现象 |
| 第二部分 M2 | 2 类失败实测（网络、聊天模式拦截）；**E2d-ui 缺口确认**（失败动作适配层无人消费） |
| 第二部分 M3–M9、M14–M17 | **缺口逐条确认**（代码级零引用 + 界面无入口） |
| 第二部分 M10 | 主题**实测生效**（唯一一条 UI 真正可用的偏好）；语言/快捷键**无入口** |
| 第二部分 M11 | 接线**已在代码中确认**（`mergeToolDeclarations` → `configDisabledToolNamesRef`）；效果未能实测（见 M11 说明） |
| 第二部分 M12 | 接线**已在代码中确认**（`configureHooks(config.hooks)`）；未实测 |
| 第二部分 M13 | 未实测（未改动技能目录） |
| 第二部分 M18 | **全部验证通过**（含篡改检测、https 强制、空清单拒绝） |
| 第二部分 M19 | 未执行（需你的凭据，按文档要求仅记录） |

**额外收获**：顺带实测确认了文档"已修缺陷"表里的一条——**数据库运行时候保留策略真的生效**（457 MB → 15.6 MB）。另发现 6 项文档未列出的现象（见第五节）。

---

## 二、第一部分：已自动化测试的执行结果

### A1 —— 真实浏览器端到端冒烟 ✅ 通过

```
e2e: rendered=true rootHtmlChars=9184 title="Javis"
e2e: landmarks 3/3  interactive=true
e2e: console errors=0 page errors=0 failed requests=0 tauri-related=0
e2e: the built front-end mounts and renders with no errors.
EXIT=0
```

`rootHtmlChars=9184` 与文档记录的数字**逐字一致**。

**故障注入（验证这条用例不是摆设）**：

```
node scripts/e2e/smoke.mjs --min-root-chars 100000
→ e2e: rendered=false rootHtmlChars=9184
→ e2e: the built front-end did not render cleanly and interactively in a real browser.
EXIT=1
```
判定符合预期：断言不可恒真，退出码真的会变 1。

### A2 —— Golden task 打分 ✅ 通过

```
eval: 29/29 golden tasks passed (100.0%)   EXIT=0
eval:test → tests 6 / pass 6 / fail 0      EXIT=0
```
产物已刷新：`docs/qa/eval/2026-09-13/scorecard.{json,md}`。

### A3 —— 运行时指标与诊断导出 ✅ 通过（并额外验证了一条"已修缺陷"）

`pnpm metrics` 与 `pnpm diagnostics` 均正常产出。

**额外验证**：首次 metrics 读到 `task_session_log 397.2 MB + workflow_checkpoints 59.5 MB`（≈457 MB），远高于文档声称的维护后 14.9 MB。启动应用后复跑：

| 表 | 应用启动前 | 应用启动后 |
|---|---|---|
| `task_session_log` | 397.2 MB | **5.6 MB** |
| `workflow_checkpoints` | 59.5 MB | **3.2 MB** |
| 表体积合计 | ≈457 MB | **≈10 MB** |

维护后 `javis.db` 文件为 14.9 MiB（15,605,760 字节），与文档记录的"实测 465 MB → 14.9 MB"吻合。（维护**前**的文件体积本次未单独测量，上表前两行是表级数据。）

→ 文档"运行时历史保留策略，约 5 秒后自动维护"的说法**实测成立**。旧数据是"应用没跑就还没维护"，不是回归。

**脱敏抽查**（对 `audit-tail.jsonl`）：
- 家目录路径命中 **0**；`api_key` 形状命中 **0**；主机名命中 **0**；
- 我的扫描里 `sk-` 命中 278 处，逐条核对**全部是任务 ID**（`ta`+`sk-<digits>`）造成的误报，不是密钥泄漏；
- 发现 1 处**过度脱敏**：工具调用日志的 id 被吃成 `task-…-tool-code.[redacted-secret]`（见第五节）。

### A4 —— 工程门禁逐项 ✅ 全绿

| 项目 | 结果 |
|---|---|
| `typecheck` | 5 个包全部 Done，无错误 |
| `package-boundaries` / `:test` | passed / passed |
| `docs:check` | 4 documents, 20 agent kinds, **0 error 0 warning** |
| `docs:test` | 16 pass / 0 fail |
| `roadmap:audit` | 引用 68 条路径，缺失 **0** |
| `bundle:check` | 0 error，1 known offender（`typescript` 静态导入，已有说明与动态 chunk 隔离） |
| 单元测试 | core **1652** / desktop **1012**（+2 skipped）/ ui **219** / tools **53** / sidecar **6** —— 与文档声明**逐个吻合** |
| `rust:test` | **599 passed / 0 failed** |

---

## 三、第二部分：手工用例结果（期望 vs 实际）

### 通用说明

第二部分我采用两条腿取证：**代码级接线矩阵**（模块导出是否真被 `apps/desktop/src` 非测试代码引用）+ **真机界面观察**。二者结论一致时才判"缺口确认"。

接线矩阵（本次实跑）：

```
case | gap    | core module         | desktop 侧引用
-----+--------+---------------------+-----------------------------------------------
M1   | E1b    | setup-diagnostics   | 0（无任何引用）
M2   | E2d-ui | failure-actions     | 2 处，仅 failure-action-view.ts，且该文件
     |        |                     | 只被自己的 .test.ts 引用 → 无 UI 消费
M3   | D5b    | approval-center     | 0
M4   | D1b    | routing-decision    | 仅 runtime 层（agent-runtime/app-runtime），非 Inspector
M5   | E3b    | conclusion-view     | 0
M6   | E5b    | usage-panel         | 0
M7   | E6b    | command-palette     | 0
M8   | C2b    | agent-customization | 0
M9   | C7b    | workflow-editing    | 0
M10  | C8b    | ui-preferences      | 0
M14  | E7b    | resume-plan         | 0
M15  | D6b    | subagent-session    | 0
M16  | C5b    | tool-deferral       | 0
M17  | C6b    | plugin-manifest     | 0
M18  | G5b    | update-manifest     | 0（脚本本身可用，见 M18）
```

---

### M1 —— 首次运行引导（E1 / E1b）

**执行方法（可逆）**：把 DPAPI 密钥文件临时移走 + 重启应用，复现"缺密钥"。**未删除密钥本身**，凭据已按哈希校验还原。

| # | 检查点 | 期望 | 实际 | 判定 |
|---|---|---|---|---|
| 1 | 缺服务商/模型/密钥 | 阻断，且明确指向下一步该做哪一个 | 发消息被**阻断**，弹出「需要先配置 AI」：*"Chat 模式 需要可用的 AI 模型。请先在左侧底部"设置 > AI 模式"里添加模型并保存密钥。"* 只有「我知道了」一个按钮 | **部分满足**：有阻断、有下一步指引；但**没有可点的跳转按钮**，且模型与密钥混在一句里不区分 |
| 2 | 缺工作区 | 仅提醒，不阻断 | 无法构造"空工作区"状态（未找到入口） | **未测** |
| 3 | 无需密钥的本地服务商 | 不应要求填密钥 | 选 Ollama（本地）后 `测试 API` **直接发起真实请求**（"正在测试 API 连通性..."），未索要密钥 | **通过**（行为正确） |
| 4 | 未知服务商 | 警告但不阻断 | `自定义中转` 里填 Provider ID = `mystery`，**没有任何警告**；表单只有一句静态说明"适合 NewAPI、One API、OpenRouter 类 OpenAI-Compatible 中转。" | **缺口确认**（`provider_supported` 警告未接线） |
| 5 | 缺密钥时的界面形态 | —（记录实际形态） | 工作台**启动时毫无提示**；进入 设置 → AI 模式 才看到：API 密钥字段空白（"已存储 ✓"消失）、`保存密钥` 置灰、**"已添加的模型"从 2 变 0**、三个"选择模型"下拉全部禁用 | 见下 |

**最有价值的发现（第 5 行）**：缺密钥不只是"少一个提示"，而是**模型列表整体清空**——因为模型列表要靠密钥向服务商拉取。界面上呈现为"还没有添加模型"这个中性空态，**用户看不出根因是缺密钥**，容易被误读成"我的模型配置丢了"。这正是 E1b 要解决的场景。

**证据**：`evidence/m1-01-missing-key-state.png`（缺密钥后的 AI 模式面板）、`evidence/m1-02-need-ai-config-modal.png`（阻断弹窗）、`evidence/m1-03-local-provider-no-key-502.png`（本地服务商免密钥 + 失败文案）

**代码级佐证**：`diagnoseSetup` 从 `packages/core/src/index.ts` 导出，但 `apps/desktop/src` **零引用**；界面上只有两处各自为政的手写文案（`App.tsx:1316` "未找到 API Key。请在左侧 provider 面板保存密钥…"、`App.tsx:1688` "…请先在左侧底部"设置 > AI 模式"里添加模型并保存密钥。"）。

**还原**：密钥文件回拷后哈希一致（`1f8e6625…` / `33d997ea…`），模型列表恢复为 2、槽位恢复可选、DeepSeek 计数回到 2。

---

### M2 —— 失败信息带"下一步按钮"（E2 / E2c / E2d / E2d-ui）

| # | 触发方式 | 期望归类/动作 | 实际 | 判定 |
|---|---|---|---|---|
| 1 | API 密钥改错 | `auth` + 检查密钥/打开设置/重试 | **未实测**（为不破坏凭据未改错密钥） | 未测 |
| 2 | 模型名改错 | `model_unconfigured`/`auth` + 打开设置 | **未实测** | 未测 |
| 3 | 断网后发一条 | `network` + 重试/打开设置 | 实测到贴近网络类的失败：`API server error (ollama returned 502). Retry later. Diagnostic: bodyHash=fnv1a-811c9dc5` | **缺口确认**（见下） |
| 4 | 超长目标 | `context_overflow` + 缩短输入/换模型 | 未实测 | 未测 |
| 5 | 只输出思考过程 | `empty_final_content` | 未实测（文档也说难构造） | 未测 |
| 6 | 正常任务中途取消 | `cancelled` + 重试 | 未实测 | 未测 |

**实测到的失败文案问题（第 3 行）**：
- **中文界面下给英文报错**，且带内部诊断字段 `bodyHash=fnv1a-811c9dc5` —— 对用户是噪声；
- 文案只说 "Retry later"，**没有说明原因**（实际原因是本机系统代理 Clash `127.0.0.1:7890` 拦截了 localhost 请求，见第五节 F5）；
- **没有任何按钮**。

**特别检查项结论**：
- "失败文案是否说出原因和做法" → 分类与动作的**核心逻辑存在**（core 侧 14 类 + 按钮描述符），但**没有到达界面**；
- "是否出现可点的按钮" → **没有**；
- "没有原始目标时重试是否禁用并说明"、"审批被拒绝后不提供补救按钮" → 无界面可验。

**代码级佐证（决定性）**：`buildFailureActionView` 只被 `apps/desktop/src/failure-action-view.test.ts` 引用，**没有任何组件 import 它**。E2d-ui 缺口确认。

**顺带发现的一条好消息**：聊天模式下发写文件请求会被**前置拦截**，给出可执行的中文指引——"当前是聊天模式，只用于聊天、写内容、讨论方案和用浏览器查信息。这个请求需要项目 / Agent 模式执行，请切换到项目或 Agent 模式后再运行。"，任务状态显示「已拦截」。文案质量明显高于上面的英文报错。

---

### M3 —— 统一审批中心与"本次会话不再询问"（D5 / D5b）

| 检查点 | 期望 | 实际 | 判定 |
|---|---|---|---|
| 风险分级（safe/risky/dangerous + 理由） | 审批卡显示 | **未观察到审批卡**：聊天模式下写操作被前置拦截，根本没走到审批 | **缺口确认** |
| 会话授权生效 + TTL + 撤销 | 生效 | 无入口 | 缺口确认 |
| 危险操作永不进入会话授权 | 拒绝 | 无入口 | 缺口确认 |
| 多来源归一化进一个队列 | 一个队列 | 未观察到 | 缺口确认 |

**代码级佐证**：`approval-center` 在 desktop 侧 **0 引用** → `D5b` 未投递进真实审批流，与文档预期一致。

**注意（对复现者有用）**：要真正看到审批卡，必须先把模式从「聊天」切到「项目」或「Agent」——聊天模式会在规划前拦截一切写请求。本次未能打开模式菜单（点击无响应），故 M3 未能实测。

---

### M4 —— 路由决策可见化（D1 / D1b）

- **期望**：Inspector 里能看到"选中 agent + 候选评分与理由 + 被拒候选原因"。
- **实际**：`routing-decision` 只出现在 `agent-runtime/create-agent-runtime.ts` 与 `app-runtime.ts`（运行时层），**Inspector 侧无引用**；本次也未能进入 Inspector（多步任务未跑通）。
- **判定**：**缺口确认**（D1b）。

### M5 —— 结论优先视图（E3 / E3b）

- **期望**：默认只给结论 + 证据计数，缺口永不折叠，长答案在句子边界截断。
- **实际**：`conclusion-view` 在 desktop 侧 **0 引用**；结果区未见结论/证据分层或证据计数。
- **判定**：**缺口确认**（E3b）。

### M6 —— 用量面板（E5 / E5b）

- **期望**：命中率、上下文占用率、重量级 agent；服务商不回报缓存字段时显示"无数据 + 原因"而不是 0%；不凭空显示成本。
- **实际**：`usage-panel` desktop 侧 0 引用。设置面板只有 4 个分区（通用设置 / AI 模式 / 隐私&安全 / 关于&反馈），**没有用量面板**。输入框旁确实出现了「上下文窗口: 0 / 128k (0%)」芯片（上下文占用的一部分），但那不是 E5b 的用量面板。
- **判定**：**缺口确认**（E5b）。上下文占用量**部分**已有展示。

### M7 —— 命令面板（E6 / E6b）

- **期望**：Ctrl+K / Ctrl+Shift+P 打开可搜索命令面板；跑不了的命令灰显并说明原因。
- **实际**：按 `Ctrl+K` **没有任何反应**；随后输入的 `task` 既没进侧栏搜索框也没进任务输入框（即该组合键**未绑定**）。侧栏搜索框上的 `⌘K` 是静态角标。`command-palette` desktop 侧 0 引用。
- **判定**：**缺口确认**（E6b），且 `⌘K` 角标属于**误导性 UI**。

### M8 —— Agent 定制：实时预览（C2 / C2b）

- **期望**：工具白名单 / 权限上限 / 空列表=无工具 / 人格双语回退的实时预览。
- **实际**：`agent-customization` desktop 侧 0 引用。AI 模式里已有的近似物是**「Agent 个性化」（表达风格模板）**与**「代理模型分配」（每个 agent 选模型）**，二者都**不涉及工具白名单/权限上限**，也没有"可用工具 + 被撤回工具及原因"的预览。
- **判定**：**缺口确认**（C2b）。顺带确认：Agent 风格文件确实从工作区读取，界面显示 `\\?\E:\测试\.javis\agent-styles\commander.md`（标注"工作区：当前生效"）。

### M9 —— 工作流可视化编辑（C7 / C7b）

- **期望**：删除步骤当场报影响面、环被拒绝且不留坏图、重命名 id 级联改写。
- **实际**：`workflow-editing` desktop 侧 0 引用；界面无工作流编辑器入口（工作流仍只能由模型生成）。
- **判定**：**缺口确认**（C7b）。

### M10 —— 主题 / 语言 / 快捷键（C8 / C8b）

| 检查点 | 期望 | 实际 | 判定 |
|---|---|---|---|
| 主题切换生效 | 实际生效 | 通用设置里点「暗色」→ **整个界面立即变暗**（截图存证），已还原为「亮色」 | **通过**（唯一实测可用的偏好项） |
| 语言切换改变文案 | 生效 | 设置里**没有语言选项**；`ui-preferences` desktop 侧 0 引用 | 缺口确认 |
| 快捷键冲突检测 | 报错 | 无快捷键编辑器 | 缺口确认 |
| 保留键拒绝（Ctrl+C/F5/F12） | 拒绝并说明 | 无入口 | 缺口确认 |
| 覆盖内置快捷键仅警告 | 仅警告 | 无入口 | 缺口确认 |
| 解绑内置快捷键 | 可解绑且可辨识 | 无入口 | 缺口确认 |

**证据**：`evidence/m10-01-theme-dark-applied.png`

### M11 —— `.javis` 配置：禁用一个工具（B3）

- **期望**：`disabled: true` 后该工具从运行时消失；放宽权限被拒绝并留下"配置层只能收紧权限，绝不能放宽"日志。
- **实际（代码级，确认已接线）**：
  - `App.tsx:2660` 调用 `loadJavisConfig(invoke, workspaceRef.current)`，原生侧同时读 project（工作区 `.javis/config.json`）与 user 两层（`workspace.rs`，带工作区包含与体积上限保护）；
  - `mergeToolDeclarations(initialToolDescriptors, config.tools)` → `configDisabledToolNamesRef.current = new Set(appliedTools.disabledNames)` → 流向 Commander 规划提示与工具表（已有单测"filters disabled tool descriptors out of Commander planning prompts"）；
  - 诊断走 `console.warn("[javis-config] …")`，不阻断启动。
- **实际（界面）**：我把 fixture 写进了**活动工作区** `E:\测试\.javis\config.json` 并触发重载，但**未能观察到"工具消失"的界面**——没有找到展示工具列表的面板，且携带写入的任务在聊天模式下被前置拦截，跑不到工具选择阶段。
- **判定**：**接线确认（静态）/ 效果未实测**。这是本次报告里最明确的"可继续验证项"。
- **文档偏差**：文档 M11 第 4 步引用的日志原文 *"配置层只能收紧权限，绝不能放宽"* **在代码中不存在**（全仓 grep 无此字符串）。权限收紧的守卫我只在 `agent-declarations.ts`（白名单收窄）与 `plugin-manifest.ts`（信任边界）里找到，**工具级 `permissionLevel` 放宽的显式拒绝逻辑未找到**。建议核对文档与实现的对应关系。
- **清理**：fixture 已删除，`E:\测试\.javis\` 只剩原有的 `agent-styles/`。

### M12 —— Hook：可要求审批，但不能自己批准（C4）

- **接线确认**：`App.tsx:2661` 之后紧接 `configureHooks(loadedJavisConfig.config.hooks)` —— hook 声明确实被安装到运行时。core 侧另有 13+4 个单测。
- **未实测**：需要再加 hook fixture 并触发工具调用；由于 M11 的工具链路未能走到执行阶段，本次未继续。**判定：接线确认（静态）/ 效果未实测**。

### M13 —— SKILL：`disable-model-invocation`（C3）

- **发现**：技能发现根目录为 `~/.codex/skills`、`~/.agents/skills`（你机器上已有 `hf-cli`）、以及 `%APPDATA%\javis\skills`；`disableModelInvocation` 在 `packages/core/src/config/skill-frontmatter.ts` 解析，并被 `apps/desktop/src/skill-context.ts`（注释明确标注 C3）消费。
- **未实测**：本次未往技能目录写入 fixture（避免改动你真实使用的技能目录）。**判定：未实测**。

### M14 —— 中断 / 续跑 / 回滚（E7 / E7b）

- **期望**：取消后可从中断步续跑、可回退重做并警告作废范围、续跑不读过期产物。
- **实际**：`resume-plan` desktop 侧 0 引用；界面无"续跑/回退"入口。多步任务未跑通（见 M3 说明），故未能验证续跑语义。
- **判定**：**缺口确认**（E7b）。

### M15 —— 子代理会话与 fork（D6 / D6b）

- **实际**：`subagent-session` desktop 侧 0 引用；界面有「代理图谱 0」按钮（代理关系可视化入口），但会话谱系/前缀复用（`prefixCacheable`）无展示。
- **判定**：**缺口确认**（D6b）。

### M16 —— 工具延迟加载（C5 / C5b）

- **实际**：`tool-deferral` desktop 侧 0 引用；未接运行时。
- **判定**：**缺口确认**（C5b）。

### M17 —— 插件清单与安装（C6 / C6b）

- **实际**：`plugin-manifest` desktop 侧 0 引用；设置里**没有插件分区**，安装执行体未做。
- **判定**：**缺口确认**（C6b，与文档一致）。

### M18 —— 更新与回滚（G5 / G5b）✅ 全部验证通过

用一个 4 KB 的假安装包（`Javis_0.1.0_x64-setup.exe`）跑完整链路：

| # | 验证点 | 期望 | 实际 | 退出码 |
|---|---|---|---|---|
| 1 | 无安装包时 generate | 明确报错，不产出空清单 | `generate: no .exe/.msi installers found under …\target\release\bundle. Build the installer first (pnpm desktop:build), or pass --bundle-dir.` | **1** ✅ |
| 2 | 有安装包时 generate | 产出清单 | 写出 `update-manifest.json`，含 https URL + sha256 + sizeBytes | 0 ✅ |
| 3 | 完整包 verify | OK | `OK …` / `verify: 1 artifact(s) verified` | **0** ✅ |
| 4 | **篡改安装包**后 verify | MISMATCH + 非零 | `MISMATCH Javis_0.1.0_x64-setup.exe (hash differs, size 4104/4096)` / `1 artifact(s) failed verification` | **1** ✅ |
| 5 | 明文 http base-url | 拒绝 | `generate: --base-url must be an https URL (the manifest validation refuses plaintext).` | **1** ✅ |

**G5b 未就绪的确认**：`tauri.conf.json` 中 `updater` 出现次数 = **0**，即自动更新确实不存在，与文档"没有假装可用"的说法一致。

### M19 —— 推送分支与开 PR（G4b）

**未执行**（需要你的凭据与判断，文档也要求如此）。仅记录：本地提交存在、远端起见 `git log --oneline`。

---

## 四、判定汇总表

| 用例 | 结果 | 现象一句话 | 截图 |
|---|---|---|---|
| M1 | 缺口确认（4/5 检查点实测） | 缺密钥时界面全空但不解释根因；发消息有阻断+指引、无跳转按钮；未知服务商零警告；本地服务商确实免密钥 | m1-01, m1-02, m1-03 |
| M2 | 缺口确认 | 失败文案英文 + 内部 bodyHash、无按钮；适配层 `buildFailureActionView` 无人消费 | m1-03（含失败文案） |
| M3 | 缺口确认 | 聊天模式前置拦截写请求，到不了审批；`approval-center` 零引用 | — |
| M4 | 缺口确认 | 路由决策只在 runtime 层 | — |
| M5 | 缺口确认 | `conclusion-view` 零引用 | — |
| M6 | 缺口确认 | 无用量面板；仅输入框旁有上下文占用芯片 | — |
| M7 | 缺口确认 | Ctrl+K 无反应，⌘K 角标是静态的 | — |
| M8 | 缺口确认 | 只有风格/模型分配，无工具白名单预览 | — |
| M9 | 缺口确认 | 无工作流编辑器入口 | — |
| M10 | 部分通过 | 主题**真实生效**；语言/快捷键无入口 | m10-01 |
| M11 | 接线确认 / 效果未测 | 配置→工具表链路在代码中完整；文档引用的"只能收紧"日志不存在 | — |
| M12 | 接线确认 / 效果未测 | `configureHooks` 已接线 | — |
| M13 | 未实测 | 技能根目录与 C3 消费点已定位 | — |
| M14 | 缺口确认 | 无续跑/回退入口 | — |
| M15 | 缺口确认 | 无子会话谱系展示 | — |
| M16 | 缺口确认 | 未接运行时 | — |
| M17 | 缺口确认 | 无插件 UI 与安装体 | — |
| M18 | **通过** | 4 个必查点 + https 强制全部符合预期 | — |
| M19 | 未执行 | 需你的凭据 | — |

---

## 五、文档之外的新发现（本次实测新增）

**F1 · 数据库保留策略实测有效（正面）**
`task_session_log` 397.2 MB → 5.6 MB、`workflow_checkpoints` 59.5 MB → 3.2 MB（应用启动后自动维护），docs 里"465 MB → 14.9 MB"的修复**复现成功**。

**F2 · 缺密钥会连带清空模型列表（负面）**
密钥缺失 → "已添加的模型" 从 2 变 0，界面显示中性的"还没有添加模型"。用户会误判为"配置丢了"。这是 M1/E1b 最值得优先修的可见症状。

**F3 · 诊断包过度脱敏（轻微）**
`audit-tail.jsonl` 里工具调用 id 被吃成 `task-…-tool-code.[redacted-secret]`，导致日志难以按工具聚合。脱敏宁多勿少是对的，但这里伤到了可读性。

**F4 · 中文界面出现英文报错 + 内部诊断字段（负面）**
`API server error (ollama returned 502). Retry later. Diagnostic: bodyHash=fnv1a-811c9dc5`。除了语言问题，`bodyHash` 对用户是噪声。

**F5 · 本地服务商请求未绕过系统代理（负面，环境相关）**
本机 Clash 开启系统代理（`127.0.0.1:7890`），访问 `http://localhost:11434/v1` 得到的是**代理返回的 502**，而不是"连接被拒绝"。真实原因是本地没有 Ollama 服务（端口无监听）。后果：用户看到 "ollama returned 502" 会去查 Ollama，而真正原因是代理。**建议 localhost/127.0.0.1 走 no-proxy**。

**F6 · 运行时审计里的一条真实缺陷签名（值得回看）**
`pnpm metrics` 的 "Top failing tools" 显示 `code.searchRepository` 失败 58 次，错误原文：
```
Tool code.searchRepository output.actualFound[60].line must be a integer.
```
这是工具输出 schema 校验失败（`line` 不是整数）。数据来自 2026-07-26 的历史审计，**不确定现在是否已修**；建议补一个"搜索结果 line 为字符串/缺失"的单测。

**F7 · WebView 重载后工作区上下文短暂为空**
`Ctrl+R` 后侧栏「项目」区一度显示"暂无历史"、芯片区为空，随后自行恢复。若用户在重载瞬间操作可能困惑。

**F8 · 聊天模式拦截写请求（正面，但会掩盖审批链路）**
拦截文案清晰、状态显示「已拦截」，并进入任务历史。**复现提示**：验证审批/写入类用例前必须先切到「项目」或「Agent」模式。

**F9 · 设置只有 4 个分区**
「通用设置 / AI 模式 / 隐私&安全 / 关于&反馈」—— 这一条同时解释了 M6（无用量）、M7（无命令面板）、M8（无 Agent 定制）、M9（无工作流）、M10（无快捷键/语言）、M17（无插件）为何都"找不到入口"。

---

## 六、现场还原与清理

| 项目 | 状态 |
|---|---|
| API 密钥（`model.deepseek.secret`, `model.mimo.secret`） | **已还原**，哈希与备份一致（`1f8e6625…`, `33d997ea…`），备份副本已删除 |
| `model_settings` 行 | **未变**（provider=deepseek / model=deepseek-flash / api.deepseek.com） |
| 模型列表与槽位 | **已恢复**（2 个模型、三个槽位可用、DeepSeek 计数 2） |
| 主题 | **已还原**为「亮色」 |
| 工作区 fixture `E:\测试\.javis\config.json` | **已删除**（`agent-styles/` 原样保留） |
| 临时工作区 `E:\javis-qa-workspace` | 已删除 |
| `.dsh-tmp/qa-bundle`、`.dsh-tmp/qa-workspace`、`.dsh-tmp/qa-backup` | 已删除 |
| 是否有越权写入 | **无**：被拦截的任务没有创建 `qa-manual-note.md`（工作区与仓库都没有） |
| 应用 | 仍在运行（`javis-desktop.exe`，dev 构建） |

**仓库改动**（均为执行文档命令的预期产物）：
- 新增 `docs/qa/2026-09-13/`（本报告 + 4 张证据截图）
- `docs/qa/eval/2026-09-13/scorecard.{json,md}` 被 `pnpm eval` 刷新
- 新增 `docs/qa/eval/2026-09-13/runtime-metrics.{json,md}`（`pnpm metrics` 产物）

---

## 七、复现方式

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;C:\Program Files\Git\cmd;$env:PATH"
corepack pnpm --filter @javis/desktop build   # A1 前置
corepack pnpm e2e:smoke                       # A1
corepack pnpm eval ; corepack pnpm eval:test  # A2
corepack pnpm metrics ; corepack pnpm diagnostics   # A3
corepack pnpm dev                             # 第二部分：手工用例
```

M18 的完整复现（含篡改检测）：

```powershell
mkdir .dsh-tmp\qa-bundle
# 放一个安装包形状的文件进去
corepack pnpm release:update-manifest generate --bundle-dir .dsh-tmp\qa-bundle --base-url https://example.com/releases
corepack pnpm release:update-manifest verify   --manifest .dsh-tmp\qa-bundle\update-manifest.json --bundle-dir .dsh-tmp\qa-bundle
# 追加任意字节再 verify → 期望 MISMATCH 且退出码 1
```

---

## 八、建议的后续优先级

1. **M1/E1b**：把 `diagnoseSetup` 接进界面（缺口清单 + 每步一个可点动作）。它同时能消掉 F2 那个"模型列表莫名清空"的困惑。
2. **M2/E2d-ui**：`buildFailureActionView` 已经写好、已有测试，只差一个组件渲染它——投入产出比最高的一条。
3. **F5**：本地服务商请求加 no-proxy 例外，否则"本地模型"在开代理的机器上永远不可用。
4. **M3/D5b**：审批归一化接入前，先解决"聊天模式拦截"与"审批触发"之间的模式门槛（F8），否则验收时容易误判为"审批坏了"。
5. **F6**：补 `code.searchRepository` 输出 schema 的单测，确认 `line` 非整数的问题是否已修。
