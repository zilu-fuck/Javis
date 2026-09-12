# 各大 Agent 如何提高缓存命中率 —— 调研报告

> 调研对象：DeepSeek Harness (DSH)、OpenAI Codex、Claude Code / Anthropic API、Aider / opencode / Cline / Roo Code / Cursor / Gemini CLI 等
> 调研方法：本地安装产物源码取证（`resources/runtime/node_modules/@deepseek-ai/*`）+ 官方文档原文 + 上游仓库源码/PR/issue + 第三方实测
> 可信度分级：**【本地源码】**= 本机安装的 DSH 产物原文｜**【一手文档】**= 厂商官方文档/博客原文｜**【上游源码】**= 开源仓库源码/PR/commit 原文｜**【二手]**= 第三方实测/逆向，未经官方确认

---

## 0. 一句话结论

所有 agent 提升缓存命中率的做法，本质上是同一条工程纪律的三种表现形式：

1. **只追加，不重写**（append-only）——历史只往后长，绝不修改已发送的字节；
2. **把稳定内容放前面、易变内容推到最后**——system prompt / 工具 schema / 参考资料在前，时间戳、当前问题、环境快照在后；
3. **让"前缀"成为可验证的不变量**——确定性序列化、字典序排序、哈希前缀包含检测、跨压缩/跨子代理复用的 cache key。

差别只在**控制权在谁手里**：DeepSeek 是服务端自动缓存（客户端只能"别破坏前缀"），Anthropic 需要客户端显式打 `cache_control` 断点，OpenAI 需要客户端提供稳定的 `prompt_cache_key` + 稳定前缀。

---

## 1. 原理：命中率到底由什么决定

### 1.1 前缀缓存 = KV 复用

Transformer 自回归推理时，prompt 中每个 token 都要计算 Key/Value 向量（prefill）。若本轮请求的前缀与上一轮**逐字节相同**，服务端可直接复用已算好的 KV，不再重算——这就是前缀缓存。命中只加速输入 prefill，**不影响输出**（输出仍受 temperature 等采样参数影响）。

推论：**缓存收益随会话长度线性放大**。一个 20 万 token 的会话，如果每轮都 miss，等于每轮都重新 prefill 20 万 token。

### 1.2 三个 provider 的三套规则（这是所有差异的源头）

| | DeepSeek | Anthropic | OpenAI |
|---|---|---|---|
| 开启方式 | **默认开启**，无需任何参数 | 需 `cache_control`（顶层自动 / block 级显式） | **默认开启**；GPT-5.6+ 支持显式断点，之前只有隐式 |
| 最小可缓存前缀 | **64 token 存储单元**；不足 64 token 不缓存 | 512 / 1024 / 2048 / 4096 token（按模型，见 §3.2） | GPT-5.6+ **1,024 可见 input token**；更早模型随 request settings 变化 |
| 命中判定粒度 | **必须完整匹配一个"缓存前缀单元"**，不是"前缀包含" | 最长匹配已写入的断点前缀（20 block lookback 窗口） | 从最长到最短比对 cache lookup boundaries |
| 客户端要控制的键 | 无（但必须保证字节稳定） | 断点位置（**上限 4 个**） | `prompt_cache_key`（<GPT-5.6 用于路由）+ 断点（GPT-5.6+） |
| 写入计费 | 无额外写入费 | 5m write **1.25×**，1h write **2×** | GPT-5.6+ write **1.25×**；更早模型无额外写入费 |
| 读取计费 | 约为 miss 的 **~10%** | **0.1×**（Fable 5.1/Mythos 5.1 为 0.025×） | **0.1×** |
| TTL | 数小时~数天，best-effort | 5 分钟（可 1 小时，2× 价格）；**从请求开始计时**，响应生成时间也算 | GPT-5.6+ `ttl: "30m"`（默认）；更早模型 `in_memory` 约 5–10 分钟 / `24h` 上限 24 小时 |
| 缓存位置 | 服务端磁盘（跨请求共享，无 session 概念） | 服务端，按组织隔离 | **单机 GPU-local**，跨机不共享，>15 req/min 可能被路由到别的机器 |

来源：DeepSeek [上下文硬盘缓存](https://api-docs.deepseek.com/zh-cn/guides/kv_cache/)；Anthropic [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)；OpenAI [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching.md)。

### 1.3 一个反直觉的关键点

**"共享前缀" ≠ "命中缓存"**。这条在 DeepSeek 和 OpenAI 上都成立，原因却不同：

- **DeepSeek**：缓存是"缓存前缀单元"（cache prefix unit）的集合，必须**完整命中某个单元**。官方例二：第一轮 `A+B`、第二轮 `A+C` 都 miss，但系统识别出公共前缀 `A` 并单独落盘，于是**第三轮** `A+D` 才命中。所以"前两轮都没命中"并不代表优化失败——公共前缀检测需要至少两轮才能物化。
- **OpenAI**：写入只发生在断点处，读取只回溯断点。官方 gotcha 原文：断点若落在每次都变的 block 上，"You pay for a fresh cache write on every request and never get a read."
- **Anthropic**：write 只在断点发生，read 会向前回溯，但**lookback 窗口只有 20 个 block**；若一轮对话新增超过 20 个 block，上一个断点的 entry 就滑出窗口，再也读不到——必须预先在更靠前的位置也放一个断点。

---

## 2. DSH（DeepSeek Harness）是怎么做的

这是本轮调研唯一能拿到**本机安装产物源码**的对象，所以证据最硬。以下路径均相对于本机
`F:\myDeepseek\dsh-desktop\dist\win-unpacked\resources\runtime\node_modules\@deepseek-ai\`。

### 2.1 DSH 的定位：服务端自动缓存 → 客户端只能"不破坏前缀"

DeepSeek 侧**没有任何 cache key、没有 cache_control、没有 retention 参数**。DSH 的 deepseek 适配器在请求里不携带任何缓存控制字段，缓存命中完全依赖"服务端自动 + 客户端字节稳定"。所以 DSH 的所有缓存工程都集中在**前缀确定性**上，而不是"打标记"。

DSH 的 deepseek 适配器把 wire 计量映射成交叉不相交（DISJOINT）的 harness 计数（**【本地源码】** `dsh-llm-deepseek/lib/index.js:1146-1163`）：

```js
// Map wire usage fields. DeepSeek's `prompt_tokens` INCLUDES cache hits
// (`prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens`,
// ...); the harness TokenUsage convention is DISJOINT counts, so cache
// reads are subtracted out of `inputTokens`.
const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
...
inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
...cacheRead !== void 0 ? { cacheReadTokens: cacheRead } : {},
```

注意 `prompt_tokens_details?.cached_tokens` **优先于** `prompt_cache_hit_tokens`——这是为兼容 OpenAI 形态的网关。

### 2.2 手段一：system prompt 的确定性拼接（order 升序 + 唯一 complete 段）

**【本地源码】** `dsh-system-prompt/lib/index.js`：

- L331：`const sectionDefinitions = [...sectionByName.values()].sort(comparePromptSections);` —— 段按 `order` 升序拼接，同 order 用码点序，保证跨机器一致。
- L333：`if (completeSections.length > 1) throw ... "multiple complete prompt sections are active"` —— 最多一个 `complete: true` 段，避免歧义渲染。
- `orderTools(tools, toolOrder, knownNames)`（L82-100）：
  - `if (toolOrder === void 0) return tools.sort(compareToolNames);` —— **未配置时回退到码点字典序**（不是 locale 序，避免 ICU/locale 漂移）。
  - 显式 `toolOrder` 时，未列名的工具在锚点位置按字典序插入。
  - `compareToolNames` 用 `a.name < b.name ? -1 : a.name > b.name ? 1 : 0`（纯码点比较）。

意义：**工具顺序是前缀里最脆弱的一段**（工具数组序列化紧跟在 system 之后）。DSH 用"默认字典序 + 可配置锚点"把顺序变成确定函数，而不是注册顺序的副产物。

### 2.3 手段二：in-history 系统提示更新（关键创新，等价于 Anthropic 的 mid-conversation system message）

这是 DSH 最值得抄的一条。普通实现里，system prompt 一变，就把 surface node 0 重写——**从第一个 token 起前缀全废**。DSH 给路由声明 `systemPromptUpdate: 'in-history'` 后，改为**把变化后的 prompt 追加到已缓存历史之后**。

**【本地源码】** `dsh-llm-deepseek/README.md:49`：

> An entry may declare `systemPromptUpdate: in-history` when its endpoint reads the latest `system` message at any position of `messages` as the complete effective system prompt; ... the agent loop then **appends a changed prompt after the cached history instead of rewriting the leading system message**. The default `deepseek-flash` entry declares this mode; other models require an explicit `models` declaration.

**【本地源码】** `dsh-system-prompt/README.md`（KV Cache effect 段）：

> Without `systemPromptUpdate`, non-empty prompt text is consolidated at the first system node through logged per-node replacements, so **a head rewrite loses prefix reuse from its first changed token**; when the prepared call declares `systemPromptUpdate: 'in-history'`, the agent loop appends a non-empty changed prompt **after the cached history** inside a continuing request series, so the prefix through that history stays reusable.

概念上这与 Anthropic 文档里的 mid-conversation system message 完全同构（**【一手文档】** Anthropic：在 Opus 4.5+/Sonnet 4.6+ 上可以"Append a `{"role": "system"}` message to `messages` instead of editing the top-level `system` field, so the cached prefix stays unchanged"）。Codex 侧对应的是"environment context 只在首轮注入一次，之后变化以 append 形式追加"。

### 2.4 手段三：wire 序列化确定性 + 请求头折叠冻结

**【本地源码】** `dsh-llm-deepseek/lib/index.js:117` 的 `serializeMessages` 把 harness message 按角色**确定性映射**：system→单条 system；assistant→单条 assistant（含 tool-call）；user→文本 user + 每条 tool-result 各一条 role=tool；空文本与 `(no output)` 都有明确分支。`serializeRequest` 先压入 system，再追加序列化后的 messages，保证 wire 顺序与 harness 顺序一一对应。

**【本地源码】** `dsh-session/lib/types/request-header.js`：

- L28 `sameSchema(a,b) => JSON.stringify(a) === JSON.stringify(b)`
- L37-44 `headerEquals` 要求**工具数组按顺序逐项相等**：`at.length === bt.length && at.every((tool,i) => sameSchema(tool, bt[i]))`
- L55 `foldRequestHeader(events, from)` 遍历日志取最后一条 `request/header` 的规范化结果

**【本地源码】** `dsh-llm/lib/index.js:98` `deepFreeze` + `agent-loop/lib/invariant.js:15` 要求 loop 构建的请求必须已冻结、且 `JSON.stringify(options.messages)` 与 `session.deriveMessages()` 重建结果一致，否则直接 fail。

意义：**"日志里能重建的请求"和"实际发出去的请求"必须字节一致**。这是把"确定性"从不变量变成运行时断言的做法——任何非确定性漂移都会 fail-fast，而不是悄悄变成 cache miss。

### 2.5 手段四：compaction 回放 warm prefix（而不是另起一套总结 prompt）

大多数实现的 compaction 会用一个**独立的总结专用 system prompt**——这等于丢弃已经热了的 KV cache。DSH 反过来：总结调用**逐字回放**会话自己的 system + tools + 被遮蔽区消息，只把总结指令作为**最后一条 user message** 追加。

**【本地源码】** `dsh-compaction-basic/lib/index.js:261` 注释：

> ... user message so the provider's warm prefix cache is reused.

**【本地源码】** `dsh-compaction-basic/README.md:107`（Design philosophy）：

> **Summarization reuses the provider's warm prefix.** Replaying the system prompt held by the `system/message` at surface node 0, the last routed request's tools, and the shadowed-region messages **byte-for-byte** makes the auxiliary call a genuine prefix of the conversation, so **only the trailing instruction and the summary output are uncached**.

同一 README 的 KV Cache effect 段（L231）还明确指出代价边界：

> Routing the summarizer to a different provider/model, or compacting a non-head range, **forgoes this reuse**.

而 compaction 的代价也被如实标注（L178）：

> **Replacing rather than append-only.** Each checkpoint **invalidates reuse from the first replaced history token**; the unchanged request prefix before that range remains reusable.

对比：Codex 的**远程** compaction 特意透传了同一个 `prompt_cache_key`（【上游源码/PR】#21249），但**本地** compaction 因为没带 tools 导致前缀永不匹配（【上游源码/issue】#37305）。两边踩的是同一个坑的不同侧面。

### 2.6 手段五：工具输出截断/裁剪（把"体积"和"稳定性"一起解决）

- **spill 策略**（**【本地源码】** `dsh-spill-policy/README.md`）：超过 `maxInlineBytes` 的纯文本工具结果 → 变成有界 head/tail 预览 + locator，全文落 spill 文件，模型可再取。
- **compaction pruner**（**【本地源码】** `dsh-compaction-tool-result-pruner/README.md`）：仅在 compaction 触发时，把超预算文本换成"head + middle pruned 标记 + tail"，**不发起模型调用**，可能因此免掉一次总结调用。原始结果仍留在 session log 中可精确重放。
- **output-retention**（**【本地源码】** `dsh-output-retention/README.md`）：`ItemRetainer` / `TextRetainer` 提供有界窗口 + 精确省略计数 + 统一 omission footer。

注意 pruner 的 KV 代价：它是**重写历史**，所以同样"从第一个被替换的 token 起失效"。DSH 把它作为**最后手段**（仅在压力超阈值时才做），而不是每轮都做。

### 2.7 手段六：子代理 fork 复用父会话前缀

**【本地源码】** `dsh-subagent-fork-in-process/README.md`：fork 子代理用父会话**已完成的轮次**做种子；seed 边界是"父的最后完成轮"，进行中的轮不包含；`fork` 与 `spawn` 的差别只在 session seed。

因为子代理的历史是父历史的**真前缀扩展**，理论上可以直接复用父已写入的服务端缓存。对比 Codex：【上游源码/PR】#17248 专门让 forked agent **继承**父的 prompt cache key，同时明确 `resume` **不继承**（"resume must not opportunistically inherit cache state from a live parent"）。

### 2.8 手段七：preset / 路由隔离，避免跨会话互相污染

**【本地源码】** `dsh-agent-presets/README.md:164`：

> Prefix-stable for the life of an agent: a composition is installed once, before the agent is published and therefore before its first request, and is never re-read while the agent runs. Choosing a different preset for a new session establishes a different prefix for that session alone and **cannot invalidate reuse for any session already running**.

**【本地源码】** `dsh-session-persistence/README.md:140`：

> Persistence does not mutate live request prefixes. A resumed loop can reuse provider cache **only when its reconstructed history, current envelope, and model route match**; crash-repair results append without rewriting earlier history.

### 2.9 手段八：已知的"缓存破坏因素"被逐条记录在文档里

DSH 每个包的 README 都有专门的 **KV Cache effect** 小节（这本身就是一个很好的工程实践——把缓存影响写进包契约）。明确列出的破坏源：

| 破坏源 | 出处（**【本地源码】**） |
|---|---|
| 执行世界路径变化重写历史图片描述文本 | `dsh-llm-deepseek/README.md:163` |
| 图片上传刷新导致 `file_id` 变化 / Files→base64 回退 | 同上 |
| reasoning passback 每个 reasoned turn 都追加 | 同上 |
| tool schema 变更（从第一个改变的 schema token 起失效） | `dsh-system-prompt/README.md:163` |
| persona 前缀变更（可能改变最靠前的部分） | `dsh-system-prompt/README.md:149` |
| 路由（provider/model）变更 | `dsh-llm-pi-ai/README.md:205` |
| compaction / surface replacement | `dsh-compaction-basic/README.md:178` |
| 越界的 image offload 替换为占位文本 | `dsh-llm-pi-ai/README.md:189` |

### 2.10 DSH 的缓存可观测性

**【本地源码】** `dsh-client-ui-chat/lib/client.js`：

- L2630 `"stats.cacheHit": "缓存命中 {percent}%"`、L2705 `"message.turnUsage.cacheHit": "缓存命中"`
- L3492 `const cacheHit = usage.cacheReadTokens === void 0 ? null : formatCacheHitPercent(usage.cacheReadTokens, usage.totalTokens - usage.outputTokens, 1)`
- L3942 `return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;`（压力口径）
- L4034：状态栏 pill 同时显示总量与 `cacheHitText`

即 DSH 把 **cache hit 百分比**做成了会话状态栏与每条消息 usage 明细的一等公民（`dsh-token-meter` 负责聚合，见 `dsh-token-meter/lib/index.js:343-365, 596`）。这点比 Codex 更"面向用户"——Codex 的 TUI 反而刻意显示 `non_cached_input() + output_tokens` 作为主数字。

---

## 3. 主流实现的做法对照

### 3.1 OpenAI Codex

**【上游源码】** 关键事实：

- 请求字段：`ResponsesApiRequest` 含 `prompt_cache_key`，**不含** `prompt_cache_retention` / `prompt_cache_options` / `prompt_cache_breakpoint`（`codex-rs/codex-api/src/common.rs`）。
- `prompt_cache_key` 的三段逻辑（`codex-rs/core/src/client.rs`）：
  ```rust
  if let Some(k) = &self.prompt_cache_key_override { return k.clone(); }
  if let SessionSource::Internal(source) = &self.state.session_source
      && let Some(parent_thread_id) = responses_metadata.parent_thread_id
  { return format!("{source}:{parent_thread_id}"); }
  responses_metadata.session_id.clone()
  ```
- `store: false` + 全量 `input` 数组（无状态链式），HTTP 路径 `previous_response_id: None`；只有 WebSocket v2 的**同一 turn 内增量**才复用连接与增量 payload。
- **缓存不变式有专门测试文件** `codex-rs/core/tests/suite/prompt_caching.rs`：
  - `prefixes_context_and_instructions_once_and_consistently_across_requests`：第 2 次请求 `input[..input1.len()]` 与第 1 次**逐字节相等**，只追加新 user message；
  - `send_user_turn_with_no_changes_does_not_send_environment_context`：设置没变就**不追加**新的 env 块；
  - 设置变化时，把变化（如 `<model_switch>`）**追加在既有前缀之后**，而不是重写前面的块；
  - `overrides_turn_context_but_keeps_cached_prefix_and_key_constant`：断言 `prompt_cache_key` 不因 override 而变。
  - 对 `instructions` 比较前先做 CRLF→LF 归一化——说明换行符抖动是真实存在的坑。
- **主动清理易变字段**：非 prefixed item id 一律 `set_id(None)`；非 OpenAI provider 清 `internal_chat_message_metadata_passthrough` 与 `encrypted_function_args`；非允许 host 清 tool result metadata。
- **子代理**：同 agent tree 共享 root thread 的 session_id（`AgentControl` 注释"session_id is equal to the root thread's ID"）；Guardian 有独立稳定 key `guardian:{parent_thread_id}`（commit c95eb3d）；forked agent 继承 key（PR #17248），**resume 不继承**。
- **裁剪方向**：遇到 context 超限时 `history.remove_first_item();`，源码注释："Trim from the beginning to preserve cache (prefix-based) and keep recent messages intact."——**从头删以保住前缀**。

**【上游源码/issue】** 两个真实事故：

1. #37305（仍 open）：本地 compaction 的 `Prompt` 用 `..Default::default()`，`tools` 为空，而普通轮通过 `step_context.tool_router` 带完整 tools。tools 在渲染中位于 input 之前 → 整个 input 无法命中。作者实测：普通轮 96–99% 命中，压缩请求 **0%**，未缓存 input 增加约 **+70%**；打补丁后压缩请求 65–88% 命中。
2. #25604（仍 open）：Codex 从不发送 `prompt_cache_retention`，长上下文在 Azure 等后端被驱逐，`cached_input_tokens` 归零。

**【一手文档】** 官方量化：多轮 agent 部署报告 **>90%** token 命中率，单轮 judge **~70%**（文档注明"illustrates a possible outcome"）；GPT-5.6+ 一次写入 + 九次全读的成本是 2.15×，而完全不缓存读十次是 10×。

### 3.2 Anthropic Claude Code

**【一手文档】** 与缓存直接相关的硬规则：

- 断点**上限 4 个**（三处独立表述 + 工具文档一处；没有任何官方来源说 5）。
- 层级与失效方向：`tools` → `system` → `messages`，**高层变更连带失效低层**。工具定义一变，整个缓存全废。
- **lookback 窗口 = 20 个 block**；连续一串 `tool_use` 或 `tool_use_result` 算 1 个位置。
- 经典错误原文："If the timestamp differs, the prefix hash at block 6 differs. The lookback walks through blocks 5, 4, 3, 2, and 1, but the system never wrote an entry at any of those positions. **No cache hit. You pay for a fresh cache write on every request and never get a read.**"——修复方式是把 `cache_control` 移到"跨请求保持一致的最后一个 block"。
- TTL **从请求开始计时**，响应生成时间也算在内；5 分钟默认，1h 为 2× 价格；1h 缓存命中**不计入 rate limit**。
- 最小可缓存长度按模型分档：512 / 1024 / 2048 / 4096。不足**静默不缓存、不报错**——只能靠 `cache_creation_input_tokens` 与 `cache_read_input_tokens` 是否同时为 0 判定。
- mid-conversation system message：在 Opus 4.5+/Sonnet 4.6+ 上追加 `{"role":"system"}` 到 `messages`，可以**不改 top-level system 字段而新增指令**，缓存不失效（与 DSH 的 in-history 同构）。

**【一手博客】** *Lessons from building Claude Code: Prompt caching is everything*（Thariq Shihipar）的核心内容：

- 分层顺序：**① 静态 system prompt & tools（全局缓存）→ ② CLAUDE.md（项目内缓存）→ ③ session context（会话内缓存）→ ④ 对话消息**。
- 他们自己破坏过这个顺序的三种原因：把**精细时间戳**放进静态 system prompt；**非确定性打乱工具定义顺序**；**修改工具参数**（例如 Agent 工具能调用哪些 agent）。
- 动态信息不写 system prompt，而是以 `<system-reminder>` 追加到**下一条 user message 或 tool result**。
- **绝不中途换模型**：cache 按模型隔离；100k token 的 Opus 会话切到 Haiku **反而更贵**；要换就用 subagent。
- **绝不中途增删工具**：plan mode 用 `EnterPlanMode`/`ExitPlanMode` **作为工具**表达状态，工具定义永不改变；MCP 用 `defer_loading: true` 的轻量 stub（只含工具名）替代移除，stub 顺序固定。
- 五条 Lessons：① 前缀匹配，任何改动使其后全失效；② 用 messages 而非改 system prompt；③ 不中途换工具/模型；④ **像监控 uptime 一样监控命中率**（"We alert on cache breaks and treat them as incidents"）；⑤ **fork 必须共享父前缀**。
- **compaction 本身是 cache read**（一手）："a separate request with the same system prompt, tools, and history as your conversation, plus a summarization instruction appended as a final user message. While the cache is warm, that request **reads your prefix from the cache**."
- fork 的正确做法（cache-safe forking）：用**完全相同**的 system prompt / user context / system context / tool definitions，把父对话 messages 前置、compaction prompt 作为**新的 user message 追加在末尾**。

**【一手文档】** Claude Code 的命中率可观测性做得最细：`/usage` 的 Session block 有 `Prompt cache (main)` 行，显示请求数、命中占比、miss 数、warm/cold，并给出 `likely cause: tool definitions changed` 之类的**归因**。miss 判定阈值：重新处理了 **>5% 且 ≥2,000 tokens**；compaction / 清理旧 tool result 算 **expected rebuild** 而非 miss。

**【一手文档】** 量化：官方博客 [Prompt caching with Claude](https://claude.com/blog/prompt-caching) 给出"最高降成本 90%、最高降延迟 85%"，但同页实测表三个案例分别是延迟 -79% / -31% / -75%、成本 -90% / -86% / -53%——**85% 是 "up to"**。典型会话的缓存占比官方**没有**给数字。

> 更详细的 Claude Code 报告（含逐条引文、存疑清单）见同目录 `claude-code-prompt-caching-hit-rate.md`。

### 3.3 Gemini / 其他 provider 的一手口径

**【一手文档】** Gemini [Context caching](https://ai.google.dev/gemini-api/docs/caching)：隐式缓存对 Gemini 2.5+ **默认开启**，有状态（`previous_interaction_id`）与无状态模式都支持；最小 token 数 2,048（2.5 Flash/Pro）或 4,096（3.x 系列）。官方给的两条提升建议只有两句，但正是全部要义：

> - Platzieren Sie große und häufig verwendete Inhalte **am Anfang** Ihrer Eingabeaufforderung.（把大块且高频使用的内容放在**开头**）
> - Senden Sie Anfragen mit **ähnlichem Präfix in kurzer Zeit**.（在**短时间窗口内**发送前缀相似的请求）

命中数通过 `usage.total_cached_tokens` 读取。显式缓存（手工建 `cachedContent` 句柄）只在 generateContent API 支持，Interactions API 只支持隐式。

### 3.4 汇总对照表

> 仓库现状提示（2026 年多处迁移，旧路径会 404）：opencode `sst/opencode` → **`anomalyco/opencode`**（默认分支 `dev`）；Goose `block/goose` → **`aaif-goose/goose`**；`OpenHands/OpenHands` 现在只是前端，agent/LLM 在 **`OpenHands/software-agent-sdk`**；Cline 已改 monorepo（`apps/vscode` + `sdk/packages/*`）。

| Agent | 缓存机制利用方式 | 提升命中率的核心手段 | 显式缓存控制 | 证据强度 |
|---|---|---|---|---|
| **DSH** | DeepSeek 服务端自动；不发送任何缓存参数 | system 段 order 升序 + 工具码点字典序 + 请求头冻结断言 + **in-history 提示追加** + compaction 逐字回放 warm prefix + fork 父前缀 | 无（靠字节稳定） | **强**（本机产物源码 + 包 README KV Cache 契约） |
| **Codex** | OpenAI 隐式 + 稳定 `prompt_cache_key = session_id` | env context 只首轮注入后 append-only；清理易变 item id/metadata；压缩透传同一 key；从头裁剪保前缀 | `prompt_cache_key`（无 retention/断点） | **强**（上游源码 + 官方 PR + 测试断言） |
| **Claude Code** | Anthropic 显式 `cache_control` + 自动 | 静态分层顺序；动态信息走 `<system-reminder>`；工具集永不变（plan mode 当工具、MCP defer stub）；不改模型；fork 共享父前缀 | `cache_control`（4 断点、5m/1h TTL） | **强**（官方博客全文 + 官方文档 + `/usage` 归因） |
| **Goose** | **把缓存语义提升为按 (provider, model) 声明的类型系统**；OpenAI 侧无 cache key（全仓 grep 零命中） | `ExplicitBreakpoints(4)` / `ImplicitTolerant` / `ImplicitStrict` / `Uncached`，未知默认 `ImplicitStrict`；断点打 system + 末 tool + 末两条 user；**20-block lookback 二级锚点**；**拒绝按 role 锚定**；cwd 走 header；**每轮 turn-context 冻结成 byte-identical 块**；一次性调用主动不写缓存；**独有 `prefix_invariance.rs` 前缀不变性回归测试** | 是（4 断点 + 5m/1h TTL） | **强**（上游源码，设计最系统；无实测数字） |
| **OpenHands** | `prompt_cache_key` + 会话亲和 header + `prompt_cache_retention`（默认 `24h`，按模型过滤） | **`CacheTier.STATIC` / `DYNAMIC` 一等建模**（静态 system 与动态 context 拆成两个 content block）；**`DateTimeSection` 强制排在动态层最后**；子代理继承父 `prompt_cache_key`；**显式排除 Gemini（注释给出 ~6-14x cost）**；缓存过小自动降级重试 | 是（cache key + retention + cache_control） | **强**（上游源码 + 官方博客数字，但数字属"压缩"非"缓存"） |
| **opencode** | 六种方言显式断点（anthropic / openrouter / bedrock `cachePoint` / openaiCompatible / copilot / alibaba）；OpenAI 系 implicit | 前 2 system + 末 2 非 system；V2 `auto` = 末 tool + 末 system + 最新 user；**`promptCacheKey = sessionID`**；gateway `caching:"auto"`；可配 TTL | 是 | **强**（源码 + 2 issue/2 PR 的生产 token 数字） |
| **Aider** | Anthropic 显式（`--cache-prompts` + 逐模型 `cache_control: true`）；DeepSeek implicit（`caches_by_default`） | 固定 chunk 顺序（system→examples→readonly→repo→done→chat_files→cur→reminder）；3 断点；**per-turn reminder 放最尾**；repomap 全排序；**TTL 保活 ping（5min−5s ×N，只重放 `cacheable_messages()`）**；子 coder 禁保活 | 是（3 断点） | 强（源码 + 官方文档） |
| **Cline** | 声明式 `routing.promptCache.format = "anthropic-cache-control" \| "bedrock-cache-point"`（+ legacy `anthropic-automatic`） | 断点只打**最后一条 user 消息的最后一个 text part**；请求级 `cache_control` 覆盖 tools+system；Bedrock `cachePoint`；**非 Anthropic 通道加 filler 空格保持 multipart**；`stickySession` 注入 | 是 | 强（源码） |
| **Roo Code** | Anthropic 显式（仅 Claude 分支加缓存） | system 1 断点 + 末两条 user 消息 = **3 断点**；prompt-caching beta 头；`filterNonAnthropicBlocks` 清 reasoning/thoughtSignature | 是 | 强（源码，单文件） |
| **Continue** | Anthropic 显式（`promptCaching` 开关 + 4 档策略 `none / systemOnly / systemAndTools / optimized`） | `MAX_CACHING_MESSAGES = 4`；槽位分配 `system=1 + 末 tool=1 + 末两条 user=2 = 4`；**tool_use 块强制排末尾**；无签名 thinking 直接丢弃；OpenRouter / Bedrock / Vertex 各自适配 | 是 | 中强（源码；命中率 >0.3/>0.5/>0.9 只是 **live 测试阈值**） |
| **Zed agent** | Anthropic **混合模式**：静态前缀显式 **1h TTL** + 顶层自动缓存管短 TTL 尾部；另有服务端 compaction beta | 长 TTL 必须排在前缀更靠前位置（tools→system→messages）；**每轮只给最新消息滚动打标**（有测试断言）；开关默认关；压缩走后缀重写或 provider 原生 `context_management` | 是（5m/1h 混合） | 强（provider + agent 双侧源码） |
| **Gemini CLI** | **仅 implicit**，完全不创建 `cachedContent` | `systemInstruction` + `tools` 固定最前；会话内 append-only；**重试 nudge 追加到末尾而非改 `systemInstruction`，注释原文"preserves the prefix cache"** | 否 | 强（源码 + 官方文档） |
| **Cursor** | 依赖 provider 缓存（Anthropic 显式 write / OpenAI implicit） | 官方只确认"把 prompt 拼成 cache-friendly"、**"让对话早期保持稳定"**、fork chat 命中、**跨 chat 也能命中**；**明确不做 keepalive** | 是（内部，细节未公开） | 中（官方论坛员工回复） |
| **Windsurf / Devin** | provider 显式 write/read 双轨计价 | Adaptive **把 caching 纳入路由决策**；Devin **只在 compaction 窗口换模型**（"反正要 miss"）；sidekick 与主模型**各自持久缓存**；子代理不继承对话 | 是（计价层可见） | 中（官方文档/博客） |
| **GitHub Copilot Chat** | Anthropic 显式 `cache_control`（预算硬编码 4）+ OpenAI `prompt_cache_key = conversationId:family` + `prompt_cache_retention: "24h"`；**客户端已开源**（`microsoft/vscode-copilot-chat`），服务端 CAPI 闭源 | 断点打 global context / 当前 user 消息 / 每轮末 tool result / 无 tool call 的 assistant 消息；**tools+system 只用剩余槽位、绝不驱逐消息级断点**；**deferred 工具排到前缀之后**；**缓存感知路由（只在首轮与 compaction 后换模型）**；压缩摘要文本**冻结** | 是 | **强**（开源客户端源码 + 官方博客实测数字） |
| **Amp** | 依赖 provider 缓存（不透明） | 官方只称**典型线程 >90% token 是 cache read**；短线程可减少 cache-window miss；子代理不继承 | 未验证 | 中低（官方 news 单点） |

### 3.5 这些实现里最值得单独记住的六条

**① GitHub Copilot Chat：断点槽位的"不驱逐"规则**（**【上游源码】** `microsoft/vscode-copilot-chat`，客户端已开源、服务端 CAPI 闭源）。它把 `maxCacheBreakpoints = 4` 硬编码，并用 prompt-tsx 的 `<cacheBreakpoint type={CacheType} />` 在 prompt 里声明断点，再由协议适配器落地（Anthropic 走 `cache_control`，OpenAI Responses 走 `body.prompt_cache_key = \`${conversationId}:${endpoint.family}\``）。槽位分配注释原文（`messagesApi.ts`）非常值得抄：

> Optionally adds `cache_control` to the tools and system prefix when there are **spare slots** available… The last non-deferred tool is marked first if possible, and the last system block is marked only while slots remain. **Message-level cache breakpoints are never evicted because they already implicitly cache the tools+system prefix (Anthropic cache hierarchy: tools → system → messages) and cover more content.**

它还有两条别家少见的做法：**把易变工具移出前缀**（"Split tools into non-deferred and deferred up front… This ensures the `cache_control` breakpoint on the last non-deferred tool caches the **maximum stable prefix**"，deferred 工具排到 context window 末尾）；**缓存感知路由**（官方博客："routing at natural cache boundaries: on the first turn, when there is no cache to lose, and after compaction, when … the prompt prefix resets. Between those points, the selected model stays in place so the cache can keep building."）。压缩摘要的 transcript hint 也被**冻结进摘要文本**，注释理由："so it is frozen at compaction time and never changes on subsequent renders (**preserving Anthropic prompt cache stability**)"。

**② Goose 的"缓存语义类型系统"**（**【上游源码】** `crates/goose-provider-types/src/cache_semantics.rs`）：

```rust
ExplicitBreakpoints { max_breakpoints: usize }  // 调用方打标记；复用要求标记字节精确匹配
ImplicitTolerant   // 隐式复用"最长匹配的已存前缀"
ImplicitStrict     // 只在前缀从开头逐字节重现时才延长
Uncached           // 无已知 prompt cache
```

注释点睛："Prompt-cache semantics declared per (provider, model), **instead of implied by whichever format module a request flows through**"，且**未知组合默认 `ImplicitStrict`**（对任何缓存都安全）。另有三个别家没做的细节：
- `LOOKBACK_BLOCKS = 20` 常量 + **在尾部锚点往回约 20 个 content block 处放第二个锚点**，注释："even when one iteration appends many blocks (e.g. parallel tool calls)"。
- **明确拒绝按 role 锚定**：在 OpenAI 风格 envelope 上，tool 结果是 `role:"tool"`、tool call 挂在 `role:"assistant"`，所以"anchoring by role would pin both message breakpoints to the last human turn and **re-bill the growing agentic tail on every iteration**"。
- 不可打点内容的显式判定：Anthropic 拒绝在**空文本**（空 tool result 会序列化成 `content: ""`）和 thinking block 上打 `cache_control`。

**③ 唯一把"前缀不变性"写成自动化回归测试的两家**（这是把缓存正确性工程化的关键）：
- **Goose** `crates/goose-provider-types/tests/prefix_invariance.rs`，文件头即不变量："Across the consecutive requests of a session, the **cache-relevant bytes a provider has already seen must never change**." 对 anthropic / openrouter / databricks 跑 `explicit_violations()`（tools、system、到最后一个断点的消息必须逐字节复现），对 openai chat / responses 跑 `strict_violations()`（请求 N 必须是请求 N+1 的逐项前缀）。含两个**种子反例**测试：`seeded_regression_volatile_bytes_in_cached_prefix_are_caught`（时间戳进缓存前缀必须被抓出）、`seeded_regression_relocated_tail_is_caught`（把 turn-context 块搬到尾部必须被抓出）。
- **OpenHands** `tests/sdk/llm/test_prompt_caching_cross_conversation.py`，文件头："For prompt caching to work across conversations, the system message must be **identical for all conversations** regardless of per-conversation context."

**④ OpenHands 的"静态/动态分层 + 易变数据强制最后"**（**【上游源码】** `software-agent-sdk`）：`CacheTier.STATIC` / `CacheTier.DYNAMIC` 是一等建模；`agent/agent.py` 注释："The dynamic_context is included as a **second content block in the system message (without a cache marker)** to enable **cross-conversation prompt caching of the static system prompt**."；动态层内的顺序（`context/prompts/presets.py`）为 repo 上下文 → memory → skills → 自定义 suffix → secrets → **datetime**，注释：

> `# DateTimeSection is intentionally last: it is the only per-conversation volatile value, so the stable dynamic content stays a cache-friendly prefix.`

它还有一条**反直觉的显式排除**（`llm/utils/model_features.py`）：`# Do NOT add Gemini: explicit cache_control markers freeze its cache at the static prefix and disable Google's implicit caching on the growing body (~6-14x cost).`

**⑤ Gemini CLI 的"nudge 追加尾部"**（**【上游源码】** `geminiChat.ts` 注释原文）：

> The nudge message is appended to the contents array (**end of conversation**) rather than modifying `systemInstruction`. **This preserves the prefix cache** and ensures the nudge is directly observed by the model at the end of the context window.

但它自己也有**反例**：`utils/environmentContext.ts` 把 `Today's date is …`、OS、临时目录、**整棵目录树**拼成 `<session_context>` 作为**第一条 user 消息**注入——日期与目录树进了前缀最前面。同一个代码库里"做对的注释"和"做反的实现"并存，正好说明这条纪律需要**逐处审计**而不是靠原则声明。

**⑥ Zed 的"混合 TTL 分层" + "compaction 原位内联"**（**【上游源码】**）：
- `AnthropicPromptCacheMode { Disabled, Legacy, #[default] Automatic }`。`Automatic` 的做法是：**tools + system 打显式 1h TTL 断点，同时用顶层 `cache_control`（省略 ttl → 默认短 TTL）覆盖会话尾部**。注释原文："Anthropic requires that **longer TTLs appear earlier in the prefix**, and the prefix order is tools → system → messages, so long-TTL tools/system before a short-TTL conversation breakpoint is a valid mix."，尾部那条的理由是"Omitting ttl uses the default (short) TTL, **which refreshes for free on every cache hit** — ideal for the rapidly-changing conversation suffix."
- compaction 有两条路径：**摘要式**（summary 在请求里序列化为 `cache: false` → 前缀被改写，不保前缀）与 **provider 原生**（`CompactionInfo::ProviderNative` → `context_management`），后者把 compaction 作为**对话内内容块 verbatim 回传**（"Opaque metadata from a prior compaction that must be round-tripped **verbatim** for Anthropic to recognize the block."）。

### 3.6 生产级实测数字（本轮调研能拿到的全部硬数字）

| 来源 | 数字 | 性质 |
|---|---|---|
| **GitHub Copilot Chat**（VS Code 工程博客 2026-06-17） | **"For agentic workloads… it now sits at around 94%"**（Anthropic agentic 工作负载的 cache hit rate）；cached token 最多便宜 **10×**；`prompt_cache_retention: "24h"` 后命中率的**相对**提升：GPT-5.4 `+10%/+137%/+679%/+919%`（对应 10-20 / 20-30 / 30-40 / 40-60 分钟空闲间隔，原文说明 `+919%` = 命中率是原来的 10.19 倍）；工具延迟加载 A/B：P50 每轮总 token `-9.81%`(GPT-5.4) / `-8.61%`(GPT-5.5)、P50 TTFT `-6.88%/-7.34%`，Anthropic 侧每轮 prompt token p50 `-11.30%` | **官方实测，本轮最强数字** |
| opencode #43507 | 断点落在"每轮重建的插件状态消息"上时，连续 4 次请求 cache read **恒定 300,150**，cache write 9,796 → 15,382 → 18,805 → 25,074 = **69,057 token 白写**（读价约为写价 1/10）。结论："问题在位置不在内容" | 生产 issue，强 |
| opencode #39009 | 某会话 181 次请求、29.2M input tokens、**0 缓存**、$149；"At cache-read rates that's roughly **$23**" | 生产 issue，强 |
| opencode PR #39008 | 加 cache_control 后 read 仍 0 且成本从 $0.0161/turn 升到 $0.0267/turn；**再叠加确定性 skill 排序后** read 21,384、**$0.00216/turn ≈ 省 92%**（该 PR 自述"AI 协助撰写，数字真实但请自行复核"且未 merge） | 生产 PR，中 |
| Codex #37305 | 普通轮命中 96–99%，本地压缩请求 **0%**，未缓存 input **+70%**；打补丁后压缩 65–88% | 用户实测，中 |
| Amp 官方 news | "in a typical Amp thread, **over 90% of tokens are cache reads**" | 官方声明 |
| OpenHands 官方博客 | "**Up to 2x per-turn API cost reduction**"、平均每轮成本"settles into less than half"，SWE-bench Verified 子集 54% vs baseline 53%——**注意这是"压缩"带来的收益，不是命中率** | 官方，口径需区分 |
| BitFun | 单次 SWE-Bench-Pro run 平均 KV-cache 命中率 **98.67%**（自述"单次工程信号，非基准结论"） | 第三方博客，弱 |
| Continue live 测试 | `expect(hitRate).toBeGreaterThan(0.3 / 0.5 / 0.9)` | **live 测试阈值，不是生产数字** |
| Gemini CLI 夹具 | `cachedContentTokenCount` 8,126/10,491、12,204/12,779、6,082/7,969 | 仓库集成测试夹具，**不是 SLA** |
| Cursor 官方博客 | 自研模型 self-summary 复用 KV cache：compaction 误差 −50%、token 1/5（摘要 ~1,000 token vs baseline >5,000） | 官方声明 |

**公开程度整体极低**：**Aider / Cline / Roo / Continue / Goose / Zed 至今没有任何官方命中率或缓存专属节省率数字**；公开命中率的第一家是 GitHub Copilot Chat（~94%）。

### 3.7 Cursor 官方（员工身份回复）给出的"用户侧可引用"结论

**【二手/官方论坛】** Cursor Community Support Engineer 原话：

- 机制归属："we build the prompt in a cache-friendly way and hand it to the underlying model provider … and **the provider's own cache is what decides whether you get a cache hit or a full re-seed**."、"**Anthropic is the only provider that has an explicit "cache write"**."
- TTL："**Anthropic 默认约 5 分钟的滑动窗口**：每次命中都会延长"；空闲超过 ~5 分钟 → **full re-seed（并产生新的 cache write）**。
- **四类破坏操作**："provider caches require an **exact token-prefix match**, so things like **switching models mid-thread, editing an earlier message, or toggling tools/rules** will re-seed the cache even well inside the 5-minute window. **The biggest wins for cache hits usually come from keeping the early part of the conversation stable**, not from watching the clock."
- **不做保活**："We don't do anything special to keep the cache warm!"
- **fork / 跨 chat 命中**：fork chat 只要缓存没过期就命中；"Prompt caching works across chats within a time window … even a 'new chat' can still hit a cached prefix from a recent session"。
- **`/summarize` 不保前缀**："the model context is rebuilt: system prompt + that summary as a hidden message. Everything else, including tool results and older messages, is removed."

**Devin 的"把 cache miss 当架构约束"**也值得单列（**【一手博客】** Cognition）："It avoids costly cache misses when routing between models."、"**We accomplish this by switching the model during context compaction, which would trigger a cache miss anyway** … effectively getting model switching 'for free'."、以及 sidekick 场景"**both the main model and sidekick model maintain their own persistent, cached contexts**"。注意其 39%/60%/54% 是 **harness 总成本**，不是缓存收益，引用时务必区分。

### 3.8 跨产品的八条已验证结论

1. **没有一家自建 KV cache**：全部交给 provider，自己只控制"前缀怎么拼、什么时候必须重拼"。Cursor 说得最直白。
2. **断点位置高度收敛为 3–4 个**：`system`（或末 tool）一个 + `最新 user` / `末两条 user` 一个；差异只在"尾部锚点要不要往前补一个"——**只有 Goose 显式做了 20-block lookback 二级锚点**。
3. **最容易踩的五个坑**：① 断点落在**每轮重建的尾部消息**上（opencode：read 恒定、69k token 白写）；② **按 role 选锚点**在 agentic 循环里会把断点钉死在最后一条人类消息上，于是每轮重复计费（Goose 注释）；③ **结构性 miss**（Copilot：新 turn 开始时上一条消息必然"从当前 user 消息下方移到上方"）；④ **缓存过小**触发 provider 静默不缓存或报错（OpenHands 自动降级、**Vertex ≥4096**；Gemini 4096/2048）；⑤ **在不可打点内容上打标**（空 tool result 序列化成 `content: ""`、thinking block、deferred 工具都不能打 `cache_control`）。
4. **"把易变数据移出/后置"做对与做反在同一个代码库里并存**：做对的是 Aider（reminder 最尾）、Goose（cwd 走 header、turn-context 每轮冻结成 byte-identical 块）、Zed（长 TTL 更靠前）、OpenHands（`DateTimeSection` 强制最后）、Gemini CLI 的 nudge 追加、Copilot（deferred 工具移出前缀）；做反的是 Gemini CLI 自己的 `<session_context>`（日期 + 整棵目录树进第一条 user 消息）。**同一个代码库里"做对的注释"和"做反的实现"并存，说明这条纪律必须逐处审计，而不是靠原则声明。**
5. **compaction 与缓存有三种态度**：**重写前缀**（opencode 序列化成字符串、Gemini CLI 摘要 + 尾部 30%、Cursor 官方明说 rebuild、Goose 的 `compact_messages()` 把全部原消息标为 agent-invisible、Continue、OpenHands "condensation destroys the prompt cache"）、**原位内联**（Zed 用 provider-native compaction 块 verbatim 回传）、**主动利用**（Devin 专门挑 compaction 这个"反正要 miss"的窗口换模型）。**只有 Zed / Devin 在 compaction 层面显式照顾了前缀。**
6. **子代理缓存继承**：明确**做**的是 OpenHands（`prompt_cache_key = parent.state.id`，注释称 "cache-shard sharing"）、Codex（fork 继承 key）、DSH（fork 用父已完成轮做种子）；明确**不做**的是 Gemini CLI（子代理独立 system prompt + 环境上下文）、Devin / Amp；Goose 只做 TTL clamp，未见共享 cache key（未验证）。
7. **"把缓存正确性工程化"只有两家做到了**：
   - **Goose** 有**唯一的前缀不变性自动化回归测试**（`prefix_invariance.rs`，含"时间戳进前缀"与"尾部块被搬走"两个种子反例）；
   - **Copilot 与 Goose** 是唯一在源码里明确写出 Anthropic `tools → system → messages` 层级顺序并据此决定"哪些断点可以牺牲"的两家——Copilot 的规则是"**消息级断点永不驱逐，因为消息断点已隐含缓存了 tools+system 前缀且覆盖更多内容**"。
8. **可观测性梯度**：wire 字段人人都有 → 归一化计数（DSH / Cline / Continue）→ 聚合展示（DSH 状态栏、Claude Code `/usage` 含 miss 归因）→ **官方公布命中率**（只有 Copilot ~94%）。**多数产品既不公开机制也不公开命中率**——这本身就是"命中率是核心竞争力"的信号。

### 3.9 两个"结构性 miss"，必须提前接受

1. **新 turn 开始时必然 miss 一次**（**【上游源码】** Copilot `cacheBreakpoints.ts` 注释原文）："There will always be a cache miss when a new turn starts because the previous messages **move from below the current user message with extra context to above it**."——这不是 bug，是"断点跟随最新 user 消息"的必然代价。
2. **压缩必然打断前缀**（**【一手文档】** OpenHands condenser README）："**condensation destroys the prompt cache**, but doing so regularly keeps the cost of rebuilding the prompt cache low."——即"频繁小幅压缩"优于"很久不动然后一次性大压缩"。

---

## 4. 反模式清单（按"证据强度"分级）

### 4.1 官方明确点名的（引用时可直接用）

1. **在静态 system prompt 里放精细时间戳**（Anthropic 官方博客点名）。
2. **非确定性打乱工具顺序 / 修改工具参数**（Anthropic 官方博客点名）。
3. **中途增删工具**——包括间接发生的情况：MCP server 断连重连、插件开关、bare tool name 的 deny 规则把工具整个移出 context（Anthropic 官方）。
4. **中途换模型**（Anthropic 官方；cache 按模型隔离）。
5. **把断点放在"每次请求都变"的 block 上**（Anthropic 官方文档；DeepSeek 与 OpenAI 语义上同理）。
6. **改写更早的消息 / 压缩历史**：OpenAI 官方明说 compaction 会使"the first request after compaction may reuse less of the previous cache"；DeepSeek 官方语义上"必须完整匹配缓存前缀单元"。Anthropic 官方未把"改写较早消息"逐条列为反模式，但语义上必然破坏。
7. **压缩请求本身改变了前缀**：Codex 的 #37305 就是活例（压缩不带 tools → 0% 命中）。
8. **让共享前缀落在最小可缓存长度之下**：OpenAI 官方给了 break-even 公式（`L = M(r + (w-r)/N)`）；一个 102 token 的前缀在 1024 的阈值下**永远**不划算，一个 221 token 的前缀在 10 次复用后扩展到 1024 就开始划算。
9. **`tool_use` / `tool_result` 的 JSON key 顺序不稳定**（Swift/Go 的 map 顺序随机化是经典来源）。

### 4.2 语义上必然破坏、但官方未逐条列出的

- 历史消息的任何**就地修改**（哪怕只差一个换行）：Anthropic 侧有强实测证据——Claude Code 自己会把历史里的 hook reminder block 重新塑形，导致中段历史变异、整段重建（第三方抓包单次约 $2.75）。
- **图片表示形式变化**：DSH 明确记录"Files→base64 回退会改变图片表示，从第一个受影响的 token 起失效"。
- **reasoning / thinking 回传策略不一致**：DSH 说"reasoning passback appends on every reasoned turn"；Anthropic 有一整张表描述 thinking block 对缓存的影响。
- **跨 provider 或跨 region**：OpenAI 缓存是单机 GPU-local；DeepSeek 是服务端磁盘。跨机/跨区必然 miss。

### 4.3 好消息：这些**不**破坏缓存

- 编辑仓库文件（Claude Code 只是追加 `<system-reminder>`）。
- 切成不同 permission mode / output style（`opusplan` 例外，那实际是换模型）。
- 调用 skills / custom commands、`/recap`、起 subagent。
- 会话**恢复**（resume）：只要重建的历史 + 当前 envelope + 路由一致，DSH 与 Codex 都能复用。

---

## 5. 可观测性：怎么证明"命中率被提高了"

没有度量就没有优化。四家的做法梯度：

| 层级 | 字段 / 展示 | 谁在做 |
|---|---|---|
| wire 原始 | `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`（DeepSeek）；`cache_creation_input_tokens` / `cache_read_input_tokens`（Anthropic）；`usage.input_tokens_details.cached_tokens` / `cache_write_tokens`（OpenAI） | 全部 provider |
| 归一化 | DSH 的 DISJOINT `cacheReadTokens` / `cacheWriteTokens`（`inputTokens` 只含未命中）；Anthropic 文档明确 `input_tokens` 是"最后一个断点之后"的未缓存 token | DSH、Claude Code、Cline |
| 聚合展示 | DSH 状态栏 `缓存命中 {percent}%` + 每条消息 usage 明细；Claude Code `/usage` → `Prompt cache (main)` 行 + **miss 归因**（"likely cause: tool definitions changed"）+ warm/cold | DSH、Claude Code |
| 告警 | Anthropic："We alert on cache breaks and treat them as incidents." | Claude Code 团队内部 |
| 刻意不展示 | Codex TUI 用 `non_cached_input() + output_tokens` 作主数字 | Codex |

推荐的三个必测指标：
1. **token 命中率** = `cached_tokens / total_input_tokens`（按 session / 天 / user 聚合）。
2. **前缀断裂次数**（prefix breaks）——比命中率更早发现问题。实现方式：对每轮 wire payload 的完整 messages 列表做稳定序列化 + SHA-256，比较 `hash(prefix.slice(0, lastLen)) === lastHash`（opencode 的扩展 `pi-deepseek-cache` 就是这么做的）。
3. **刷新/写入浪费** = 写入了但从未被读回的 token 数（cache_write 增长而 cache_read 不涨 = 断点打错位置）。

---

## 6. 对 Javis 的落地建议

先给现状（**【本地源码】** E:\Javis 全仓 grep）：`cached_tokens` / `cacheReadTokens` / `prompt_cache` / `cache_control` **在所有 TS 与 Rust 源码中零命中**。也就是说 Javis 目前在 provider 层**完全没有缓存控制，也没有缓存计量**。这意味着前两项是纯增量收益、无回归风险。

按性价比排序：

### P0 — 计量先行（1 天级）
1. 在 provider 层解析三种方言的缓存字段，归一化成 `cacheReadTokens` / `cacheWriteTokens` / `uncachedInputTokens`（DISJOINT 口径，参考 DSH 的 `mapUsage` 减法：`inputTokens = prompt_tokens - cacheRead`，并让 `prompt_tokens_details.cached_tokens` 优先于 `prompt_cache_hit_tokens`）。
2. 落库到任务历史表（新增列），UI 显示每轮与整个会话的命中率。**先有数字，再谈优化。**

### P0 — 前缀不变性回归测试（这是本轮调研里"最该抄"的一条，1–2 天级）
3. 新增一个测试文件，把不变量直接写成断言（模型参考 Goose 的 `prefix_invariance.rs`）：
   - 文件头不变量：**"Across the consecutive requests of a session, the cache-relevant bytes a provider has already seen must never change."**
   - 对显式断点类 provider：tools、system、到最后一个断点的消息必须逐字节复现；
   - 对隐式类 provider：请求 N 必须是请求 N+1 的**逐项前缀**；
   - 两个**种子反例**必须被抓出：时间戳进了缓存前缀、把 turn-context 块从原位搬到尾部。
   这个测试的价值在于：它把"缓存纪律"从口头约定变成 CI 门禁，之后任何人在 system/工具段里加时间戳都会立刻红的。

### P0 — 前缀确定性审计（1–2 天级）
4. 审计并固化 prompt 装配顺序：system 段（含 AGENTS.md/CLAUDE.md 注入）→ 工具 schema → 历史。任何在 system 或工具段里注入**时间戳、会话 id、随机 id、当前时间**的地方，一律移到末尾或改走"追加式 user 消息"（参考 OpenHands 把 `DateTimeSection` 强制排在动态层最后，以及 Gemini CLI 把 nudge 追加到会话末尾的注释）。
5. 工具 schema 序列化改为**确定性**：默认按工具名码点字典序排序（不要依赖注册顺序，也不要用 locale 比较），并要求 schema 的 JSON key 顺序固定（对对象键做排序后再序列化）。
6. 加运行时断言（参考 DSH 的 `agent-loop/invariant`）：实际发出去的 messages 必须能从持久化日志精确重建，否则 fail。

### P1 — 历史只追加 + 压缩保前缀（3–5 天级）
7. 确保历史只 append；agent 重试、修复、错误回填都走**追加**而不是重写早前消息。
8. **compaction 必须回放 warm prefix**：总结调用的 system + tools + 被遮蔽区消息要与上一轮路由请求逐字节相同，只把总结指令作为最后一条 user 消息追加；并且**总结请求要带同一份 tools**（Codex #37305 的反例）。
9. 压缩后的历史替换策略：优先"从头部裁剪 + 保留近期窗口"，而不是重排；记录并展示"本次压缩打断了多少 token 的前缀复用"。**接受"压缩必然打断前缀"这个事实，但让压缩更频繁、更小步**（OpenHands："condensation destroys the prompt cache, but doing so regularly keeps the cost of rebuilding the prompt cache low"）。
10. 如果走 Anthropic 路线：断点放在"跨请求保持一致的最后一个 block"，并注意 **4 个上限**与 **20 block lookback**（长回合要在更靠前位置预先放第二个锚点，参考 Goose 的 `LOOKBACK_BLOCKS = 20`）。**槽位分配抄 Copilot 的规则**：优先给 tools/system 打标，但**绝不为 tools/system 驱逐消息级断点**（消息断点已隐含缓存 tools+system 且覆盖更多内容）。如果走 OpenAI 路线：`prompt_cache_key` 必须**每会话稳定**，且 **fork 继承、resume 不继承**；长空闲场景考虑 `prompt_cache_retention`。

### P2 — 结构性优化（1–2 周级）
11. **in-history 提示更新**：新增/变更的 system 级指令（如 goal 变化、mode 切换）以"追加到历史之后"的方式表达，而不是重写头部 system 消息——直接决定长会话的命中率上限。
12. **静态/动态分层建模**（抄 OpenHands）：把 system prompt 拆成 `STATIC`（跨会话可复用）与 `DYNAMIC`（会话内可复用）两个 content block，只给静态块打缓存标记，让静态前缀能跨会话复用。
13. **子代理 fork 共享父前缀**：fork 型子任务用父会话已完成轮次做种子，并复用父的 cache key / `prompt_cache_key`（OpenHands 的做法是 `prompt_cache_key = parent.state.id`）。
14. **把易变工具移出前缀**：工具数量多时，用"延迟加载 / 工具搜索"把不常用工具排到 context 末尾，让 tools 段的稳定前缀最大化（Copilot 与 OpenAI 官方文档都推荐这条，并给出了 P50 token / TTFT 的 A/B 数字）。
15. **工具输出有界化**：超长工具结果落 spill 文件 + 模型只看到有界 head/tail 预览（DSH `dsh-spill-policy` 的形态），从根上减少需要压缩的次数。
16. **命中率告警**：把"前缀断裂"当事件处理，而不是当指标看。参考 Anthropic 的 miss 判定（重新处理 >5% 且 ≥2000 tokens 才算真 miss，compaction 算 expected rebuild）。
17. **缓存过小的自动降级**：捕获 provider "cache too small" 类错误后自动**无缓存重试**，而不是让请求失败（OpenHands 的做法；Vertex ≥4096、Gemini 4096/2048）。

### 一条容易忽略的账
在 **Anthropic / GPT-5.6+** 这类**写入收费**的 provider 上，低频复用（同一前缀复用不到 2 次）**打了断点反而更贵**：写入 1.25× + 一次读 0.1× = 1.35×，而完全不复用是 2×——只有当复用次数足够时才划算。OpenAI 官方给了 break-even 公式。所以"给所有东西都打断点"是错的，**要按复用频率分层**：稳定 system + 工具打一个断点，易变的尾部不打。

---

## 7. 证据与来源

### 本地源码（**强证据**，本机安装产物）
- `resources/runtime/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js:1146-1163`（DISJOINT 计量）、`:117`（`serializeMessages`）、`:241`（`serializeRequest`）
- `.../dsh-llm-deepseek/README.md:49,125,159,163`（in-history 模式、缓存计量、KV Cache effect）
- `.../dsh-system-prompt/lib/index.js:82,84,88,100,331,333`（orderTools / compareToolNames / 段排序 / complete 唯一）
- `.../dsh-system-prompt/README.md:135,149,163`（渲染顺序与 KV Cache effect）
- `.../dsh-session/lib/types/request-header.js:17,28,37,44,55`（canonicalHeader / sameSchema / headerEquals / foldRequestHeader）
- `.../dsh-agent-loop/README.md:93,119,121,158`（request/header 折叠、prompt admission、KV Cache effect）
- `.../dsh-compaction-basic/lib/index.js:220,261,285`（COMPACTION_INSTRUCTION、warm prefix 注释、逐字回放）
- `.../dsh-compaction-basic/README.md:107,112,118,178,231`（Design philosophy / 触发 / 机制 / KV Cache effect）
- `.../dsh-compaction-tool-result-pruner/README.md`、`.../dsh-spill-policy/README.md`、`.../dsh-output-retention/README.md`
- `.../dsh-subagent-fork-in-process/README.md`（seed 边界）
- `.../dsh-agent-presets/README.md:164`、`.../dsh-session-persistence/README.md:140`
- `.../dsh-client-ui-chat/lib/client.js:2630,3492,3942,4034`（命中率展示）
- `.../dsh-token-meter/lib/index.js:343-365,389,596`（DISJOINT 桶与压力口径）

### 官方文档/博客（**一手**）
- DeepSeek：[上下文硬盘缓存](https://api-docs.deepseek.com/zh-cn/guides/kv_cache/)（三种落盘时机、缓存前缀单元、64 token 单元、best-effort、两个 usage 字段）
- OpenAI：[Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching.md)（断点/最小长度/TTL/路由与 `prompt_cache_key`/代价公式/gotchas）
- Anthropic：[Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)（4 断点、lookback、最小长度、失效矩阵、pricing）
- Anthropic：[Lessons from building Claude Code: Prompt caching is everything](https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything)
- Anthropic：[Prompt caching with Claude](https://claude.com/blog/prompt-caching)（90%/85% 出处与实测表）
- Anthropic：[How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching)、[Manage costs](https://code.claude.com/docs/en/costs)
- Google：[Gemini Context caching](https://ai.google.dev/gemini-api/docs/caching)
- 第三方审计：[OnlyTerp/prompt-cache-skills — audits/codex-cli.md](https://github.com/OnlyTerp/prompt-cache-skills/blob/main/audits/codex-cli.md)（该审计以 codex 某个 pinned commit 为准，main 上 `prompt_cache_key` 已演进，勿直接引用其结论）

### 上游仓库源码 / PR / issue（**强证据**，openai/codex）
- `codex-rs/core/src/client.rs`、`codex-rs/codex-api/src/common.rs`、`codex-rs/core/src/compact.rs`、`codex-rs/protocol/src/protocol.rs`
- `codex-rs/core/tests/suite/prompt_caching.rs`、`codex-rs/core/tests/suite/compact_remote.rs`
- [PR #21249 Propagate cache key and service tiers in compact](https://github.com/openai/codex/pull/21249)
- [PR #17248 Inherit forked agent prompt cache keys](https://github.com/openai/codex/pull/17248)
- [commit c95eb3d Stabilize Guardian client cache key handling](https://github.com/openai/codex/commit/c95eb3d07bd7af4977d70bddfcaac925755da4c8)
- [#37305 Local compaction request omits tool specs](https://github.com/openai/codex/issues/37305)、[#25604](https://github.com/openai/codex/issues/25604)、[#18130](https://github.com/openai/codex/issues/18130)

### 社区实现与实测（**二手**，交叉验证用）
- [ruanbw/pi-deepseek-cache](https://github.com/ruanbw/pi-deepseek-cache)（前缀守卫 / 稳定工具排序 / 前缀包含哈希检测 / 命中率遥测；其 [前缀缓存原理文档](https://raw.githubusercontent.com/ruanbw/pi-deepseek-cache/main/docs/prefix-cache-principle.md) 中的 DSH 符号已用本机产物交叉验证为真实存在）
- [DeepSeek V4 Pro is cheap. Your agent harness can still waste the cache](https://dev.to/bobleer/deepseek-v4-pro-is-cheap-your-agent-harness-can-still-waste-the-cache-1inb)（单次 SWE-Bench-Pro run 平均 KV-cache 命中率 **98.67%**；单 run 工程信号，非基准结论）

### 其他 agent 的上游源码（**强证据**，由并行子调研取证；仓库路径为 2026 年迁移后地址）
- **Aider**：`aider/coders/chat_chunks.py`、`aider/coders/base_coder.py`、`aider/repomap.py`、`aider/models.py`、`aider/resources/model-settings.yml`；官方文档 [usage/caching](https://aider.chat/docs/usage/caching.html)
- **opencode**（`anomalyco/opencode`，分支 `dev`）：`packages/opencode/src/provider/transform.ts`、`packages/llm/src/cache-policy.ts`；[issue #43507](https://github.com/anomalyco/opencode/issues/43507)、[issue #39009](https://github.com/anomalyco/opencode/issues/39009)、[PR #43510](https://github.com/anomalyco/opencode/pull/43510)、[PR #39008](https://github.com/anomalyco/opencode/pull/39008)
- **Cline**：`sdk/packages/llms/src/providers/routing/{anthropic-compatible,bedrock-cache-point,utils}.ts`、`.../providers/ai-sdk.ts`
- **Roo Code**：`src/api/providers/anthropic.ts`
- **Continue**：`packages/openai-adapters/src/apis/{AnthropicCachingStrategies,AnthropicUtils,OpenRouterCaching}.ts`、`.../test/anthropic-caching*.live.test.ts`、`core/llm/llms/Anthropic.ts`
- **Goose**（`aaif-goose/goose`）：`crates/goose-provider-types/src/cache_semantics.rs`、`.../src/formats/anthropic.rs`、`.../tests/prefix_invariance.rs`、`crates/goose/src/{agents/moim.rs,session_context.rs,model_config.rs,context_mgmt/mod.rs}`；官方 provider 文档
- **Zed**：`crates/anthropic/src/{anthropic.rs,completion.rs}`、`crates/agent/src/{tests/mod.rs,thread.rs}`
- **OpenHands**（`OpenHands/software-agent-sdk`）：`openhands-sdk/openhands/sdk/llm/llm.py`、`.../llm/options/{common,chat_options}.py`、`.../llm/utils/model_features.py`、`.../context/prompts/{presets,registry}.py`、`.../context/condenser/README.md`、`.../tests/sdk/llm/test_prompt_caching_cross_conversation.py`、`openhands-tools/openhands/tools/task/manager.py`；[官方博客](https://www.openhands.dev/blog/openhands-context-condensensation-for-more-efficient-ai-agents)
- **Gemini CLI**：`packages/core/src/core/{geminiChat.ts,contentGenerator.ts}`、`.../utils/environmentContext.ts`、`.../context/chatCompressionService.ts`、`.../agents/local-executor.ts`、`docs/cli/token-caching.md`；[PR #18258](https://github.com/google-gemini/gemini-cli/pull/18258)、[PR #28934](https://github.com/google-gemini/gemini-cli/pull/28934)
- **Copilot Chat**（`microsoft/vscode-copilot-chat`）：`src/extension/intents/node/cacheBreakpoints.ts`、`src/platform/endpoint/node/{messagesApi.ts,responsesApi.ts}`、`src/extension/prompts/node/agent/{agentPrompt.tsx,summarizedConversationHistory.tsx}`；[VS Code 工程博客 2026-06-17](https://code.visualstudio.com/blogs/2026/06/17/improving-token-efficiency-in-github-copilot)、[GitHub 博客](https://github.blog/ai-and-ml/github-copilot/getting-more-from-each-token-how-copilot-improves-context-handling-and-model-routing/)
- **Cursor**（官方论坛员工回复）：[Understanding Write Cache](https://forum.cursor.com/t/understanding-write-cache/156915)、[Cache read token](https://forum.cursor.com/t/cache-read-token/153794)、[How does summarize actually work](https://forum.cursor.com/t/how-does-summarize-actually-work/167893/5)；[self-summarization 博客](https://cursor.com/blog/self-summarization)
- **Windsurf / Devin / Amp**：[Adaptive](https://docs.devin.ai/desktop/adaptive)、[Models/pricing](https://docs.devin.ai/desktop/models)、[Devin Fusion](https://cognition.com/blog/devin-fusion)、[Amp news](https://ampcode.com/news/fable-5.1)

---

## 附：一页速记卡

```
提升命中率 = 让前缀尽可能长地"逐字节稳定"

做：
  ✅ 稳定内容前置（system → tools → 参考资料），易变内容后置（时间戳/当前问题/环境）
  ✅ 历史只追加，绝不重写（重试/修复/报错回填都走追加）
  ✅ 工具 schema 确定性排序 + JSON key 稳定
  ✅ 压缩/总结请求回放同一份 system + tools（否则整段重算）
  ✅ 跨压缩、跨 fork 复用 cache key；resume 则按重建一致性判断
  ✅ 提示词更新走"追加到历史之后"，不重写头部 system
  ✅ 度量命中率 + 前缀断裂次数，把 cache break 当事件
  ✅ 断点槽位优先给 tools/system，但绝不为它们驱逐消息级断点（Copilot 规则）
  ✅ 写一个"前缀不变性"回归测试当 CI 门禁（Goose 的 prefix_invariance.rs）

不做：
  ❌ 在 system prompt 里放时间戳/会话 id/随机 id
  ❌ 中途增删工具、换模型、改工具参数
  ❌ 改写已发送的历史消息（哪怕只差一个换行）
  ❌ 把断点放在每次都变的内容上（只有写、没有读）
  ❌ 按 message role 选锚点（agentic 循环里会钉死在最后一条人类消息）
  ❌ 在空文本 / thinking block / deferred 工具上打 cache_control
  ❌ 对低频复用的内容也打断点（写入收费的 provider 上反而更贵）
  ❌ 让共享前缀低于 provider 的最小可缓存长度
```

### 三家最值得直接抄的实现（如果只抄三样）

| 抄什么 | 抄谁 | 为什么 |
|---|---|---|
| **前缀不变性回归测试** | Goose `prefix_invariance.rs` | 唯一把缓存纪律变成 CI 门禁的实现，含两个种子反例 |
| **断点槽位的"不驱逐"规则 + 静态/动态分层** | Copilot Chat / OpenHands | Copilot 说清"消息断点已隐含缓存 tools+system，永不驱逐"；OpenHands 把 `STATIC`/`DYNAMIC` 做成一等建模并让 `DateTimeSection` 强制最后 |
| **in-history 提示更新 + compaction 逐字回放** | DSH | 唯一同时解决"提示词变更"和"压缩"两个前缀杀手，且代价边界写在文档里 |
