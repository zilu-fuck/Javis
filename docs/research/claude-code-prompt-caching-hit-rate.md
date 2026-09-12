# Claude Code / Anthropic API 如何提升 Prompt Cache 命中率 —— 调研报告

> 检索时间：本会话执行时
> 方法：web_search + web_fetch（含 r.jina.ai 文本代理绕过页面截断）
> 可信度分级：
> - **[一手]** = Anthropic 官方博客 / 官方文档原文
> - **[二手-实测]** = 第三方实测数据、用户抓包
> - **[二手-逆向]** = 第三方对 Claude Code 混淆 bundle 的逆向分析（有代码引用，但未经 Anthropic 确认）
> - **[未能证实]** = 检索后找不到一手来源，明确标注

---

## 0. 检索说明：主博客的可获取性

- 直接 `web_fetch https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything` **返回 HTTP 200 但正文被截断**，只拿到站点导航壳。这不是 404，是页面渲染方式导致的截断。
- **成功获取全文的方式**：`https://r.jina.ai/https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything` —— 拿到了完整正文（含 5 条 "Lessons learned" 与作者署名 Thariq Shihipar）。
- 另有一份**中文全译**（内容与英文原文一致，且在多处更详细，例如 `<system-reminder>` 的时间例子）：腾讯云开发者社区译文，其注明原始发布为 2026-03-22、作者 X 帖为 2026-02-20（<https://x.com/trq212/status/2024574133011673516>）。
- **重要提示**：下文所有引文均来自上述实际抓取到的文本，未做任何编造。凡是我抓不到一手来源的说法，都在 §7 单独列出。

**结论：主博客已完整获取，不需要依赖二手摘要。** 但有 1 项用户问题中的说法（"compaction 被限制为单次 pass"）在一手来源中**找不到**，见 §7。

---

## 1. `cache_control: {"type": "ephemeral"}` 的精确语义

来源：[platform.claude.com/docs/en/build-with-claude/prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)（旧地址 [docs.anthropic.com/en/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) 内容相同；`docs.claude.com/en/docs/build-with-claude/prompt-caching` 会 301 跳到 `platform.claude.com`）

### 1.1 两种启用方式

| 方式 | 用法 | 行为 |
|---|---|---|
| **Automatic caching** | 在 request body **顶层**加一个 `cache_control` 字段 | 系统自动把断点放在「最后一个可缓存 block」，并随对话增长**自动前移** |
| **Explicit cache breakpoints** | 把 `cache_control` 放在**单个 content block** 上 | 精确控制缓存边界 |

原文：

> "**Automatic caching**: Add a single `cache_control` field at the top level of your request. The system automatically applies the cache breakpoint to the last cacheable block and moves it forward as conversations grow."

> "Currently, 'ephemeral' is the only supported cache type, which by default has a 5-minute lifetime."

即 `{"type": "ephemeral"}` 是**唯一支持的 cache type**；扩展形态是加 `ttl`（`"5m"` / `"1h"`）。

### 1.2 断点上限：**4 个**（不是 5）

一手文档明确写 4：

> "**When to use multiple breakpoints**: You can define up to **4 cache breakpoints** if you want to…"

> "When used together, the automatic cache breakpoint uses one of the **4 available breakpoint slots**."

> "If **4 explicit block-level breakpoints** already exist, the API returns a **400 error** (no slots left for automatic caching)."

工具相关文档同样写 4：

> "Each marker still counts toward the request's limit of **four breakpoints**, so use one per turn."
> —— [tool-use-with-prompt-caching](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching)

**我没有找到任何 Anthropic 一手来源说 5。** 结论：**4**。（"5" 的说法在检索到的官方文档、官方博客中均无出处。）

**断点本身不额外计费**：

> "**Cache breakpoints themselves don't add any cost.** You are only charged for: Cache writes… Cache reads… Regular input tokens…"

### 1.3 缓存层级与 20-block lookback（非常关键的机制）

> "Cache prefixes are created in the following order: `tools`, `system`, then `messages`. This order forms a hierarchy where each level builds upon the previous ones."

三条核心原则（原文标题 "Three core principles"）：

1. **Cache writes happen only at your breakpoint.** 只有被 `cache_control` 标记的位置会写入一个 cache entry（到该 block 为止的累计前缀 hash）。
2. **Cache reads look backward for entries that prior requests wrote.** 命中失败时，系统**逐 block 向前回溯**，找"之前请求写过的" entry。
3. **The lookback window is 20 blocks.** 每个断点最多检查 20 个位置；Claude API 上「连续一串 `tool_use` block 算一个位置」，连续 `tool_result` 同理。

文档给出的**最常见错误**恰好就是用户关心的"动态内容放断点"：

> "**Common mistake: Breakpoint on content that changes every request** … The lookback **does not find stable content behind your breakpoint and cache it**. It finds entries that prior requests already wrote, and writes happen only at breakpoints. Move `cache_control` to block 5, the last block that stays the same across requests, and every subsequent request reads the cached prefix."

> "**Key takeaway:** Place `cache_control` on the last block whose prefix is identical across the requests you want to share a cache."

工具定义的断点位置（一手）：

> "Place `cache_control: {"type": "ephemeral"}` on the **last tool** in your `tools` array. This caches the entire tool-definitions prefix…"

### 1.4 最小可缓存前缀长度（per model）

一手文档 "Cache limitations" 完整列表（**注意：不止 1024/2048/4096 三档**）：

| 最小长度 | 模型 |
|---|---|
| **512 tokens** | Claude Fable 5.1、Mythos 5.1、Opus 5、Fable 5、Mythos 5 |
| **2,048 tokens** | Claude Mythos Preview、Claude Opus 4.7 |
| **4,096 tokens** | Claude Opus 4.6、Claude Opus 4.5 |
| **1,024 tokens** | Claude Opus 4.8、Sonnet 5、Sonnet 4.6、Sonnet 4.5、Opus 4.1(retired)、Opus 4(retired)、Sonnet 4(retired) |
| **4,096 tokens** | Claude Haiku 4.5 |
| **2,048 tokens** | Claude Haiku 3.5 (retired) |

> "Shorter prompts cannot be cached, even if marked with `cache_control`. Any requests to cache fewer than this number of tokens will be processed without caching, and **no error is returned**. To verify whether a prompt was cached, check the response usage fields: if both `cache_creation_input_tokens` and `cache_read_input_tokens` are 0, the prompt was not cached…"

> "For concurrent requests, note that a cache entry only becomes available **after the first response begins**."

### 1.5 TTL

- 默认 **5 分钟**：`"By default, the cache has a 5-minute lifetime. The cache is refreshed for no additional cost each time the cached content is used."`
- 生命周期**从请求开始计时**，不是从响应结束：
  > "The lifetime is measured from the **start of the request** that writes or reads the cache entry, not from the end of its response. Time spent generating a response counts against the lifetime: if a response takes 4 minutes to stream, a follow-up request that reuses the same cached prefix must start within about 1 minute of that response completing."
- **1 小时** TTL 可选：
  > "By default, automatic caching uses a 5-minute TTL. You can specify a 1-hour TTL **at 2x the base input token price**."
- **混合 TTL 约束**：长 TTL 必须排在短 TTL **之前**（`"Cache entries with longer TTL must appear before shorter TTLs"`），计费按 A/B/C 三个位置切分。
- **何时用 1h**：用于「比 5 分钟稀、比 1 小时密」的场景；并明确提到**提升 rate limit 利用率**：
  > "When you want to improve your rate limit utilization, because **cache hits are not deducted against your rate limit**."

### 1.6 缓存写 / 缓存读的定价倍率

一手文档 "Understanding cache breakpoint costs"：

> - "**Cache writes:** When new content is written to the cache (**25% more** than base input tokens for 5-minute TTL)"
> - "**Cache reads:** When cached content is used (**10% of base input token price**, or **2.5%** on Claude Fable 5.1 and Claude Mythos 5.1)"
> - "**Regular input tokens:** For any uncached content"

即倍率：**5m write = 1.25x，1h write = 2x，read = 0.1x（Fable 5.1 / Mythos 5.1 为 0.025x）**。

价格表节选（per MTok：base input / 5m write / 1h write / cache hit / output）：

| 模型 | Base input | 5m write | 1h write | Cache hit | Output |
|---|---|---|---|---|---|
| Claude Fable 5.1 | $10 | $12.50 | $20 | $0.25 ¹ | $50 |
| Claude Opus 5 / 4.8 / 4.7 / 4.6 / 4.5 | $5 | $6.25 | $10 | $0.50 | $25 |
| Claude Sonnet 5 | $2 | $2.50 | $4 | $0.20 | $10 |
| Claude Sonnet 4.6 / 4.5 | $3 | $3.75 | $6 | $0.30 | $15 |
| Claude Haiku 4.5 | $1 | $1.25 | $2 | $0.10 | $5 |

¹ "Cache hits and refreshes on Claude Fable 5.1 and Claude Mythos 5.1 are priced at 0.025x the base input price. All other models use the standard 0.1x multiplier."

### 1.7 能缓存 / 不能缓存

**能**：tools 定义、system 消息、用户与助手 turn 的 text block、用户 turn 的图片与文档、`tool_use` 与 `tool_result`。

**不能**：
- Thinking block 不能直接标 `cache_control`；但作为历史 assistant turn 的一部分可以**被连带缓存**，且读回时**计入 input tokens**。
- 子内容 block（如 citations）不能直接缓存，要缓存顶层 block。
- 空 text block 不能缓存。

### 1.8 失效矩阵（官方原表要点）

| 变更 | Tools cache | System cache | Messages cache |
|---|---|---|---|
| **工具定义**（名称/描述/参数） | ✘ | ✘ | ✘ |
| web search / citations 开关 | ✓ | ✘ | ✘ |
| speed（`fast` vs 标准） | ✓ | ✘ | ✘ |
| `tool_choice` | ✓ | ✓ | ✘ |
| 增删图片 | ✓ | ✓ | ✘ |
| thinking 参数 | 视模型 | 视模型 | ✘ |
| `output_config.effort` | 视模型 | 视模型 | ✘ |

Troubleshooting 里还列了两条"隐性杀手"：

> "Verify that the keys in your `tool_use` content blocks have **stable ordering** as some languages (for example, **Swift, Go**) randomize key order during JSON conversion, breaking caches"

> "Use [cache diagnostics](https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics) to have the API compare consecutive requests and report which part of the prompt diverged"

---

## 2. 主博客《Lessons from building Claude Code: Prompt caching is everything》要点

来源（全文经 r.jina.ai 获取）：<https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything>

### 2.1 总体立场

> "At Claude Code, we build our entire harness around prompt caching. A high prompt cache hit rate decreases costs and helps us create more generous rate limits for our subscription plans, so we **run alerts on our prompt cache hit rate and declare SEVs if they're too low**."

> "Prompt caching works by **prefix matching**—the API caches everything from the start of the request up to each `cache_control` breakpoint."

### 2.2 提示词分层顺序（哪些部分绝不能变）

> "The best way to do this is **static content first, dynamic content last**. For Claude Code this looks like:
> 1. **Static system prompt** & Tools (**globally cached**)
> 2. **CLAUDE.md** (cached within a project)
> 3. **Session context** (cached within a session)
> 4. **Conversation messages**"

> "This way we maximize how many sessions share cache hits."

### 2.3 缓存失效原因（他们自己踩过的坑，原文点名）

> "But this approach can be surprisingly fragile. We've broken this ordering before for a variety of reasons, including:
> - putting an **in-depth timestamp in the static system prompt**,
> - **shuffling tool order definitions non-deterministically**, and
> - **updating parameters of tools** (e.g., what agents the Agent tool can call)."

### 2.4 如何处理"看起来是动态"的东西（时间/日期、文件状态、git 状态）

> "**Use messages for updates** … There may be times when the information you put in your prompt becomes out of date, for example **if you have the time or if the user changes a file**. It may be tempting to update the prompt, but that would result in a cache miss and could end up being quite expensive for the user.
> Consider if you can pass in this information via messages in the agent's next turn instead. In Claude Code, we add a **`<system-reminder>` tag in the next user message or tool result** with the updated information for the model, which helps preserve the cache."

> "**Use messages instead of system prompt changes**. You may be tempted to edit the system prompt to do things like entering plan mode, **changing the date**, etc. but it would actually be better to insert these into messages during the conversation."

中文全译版在此处补了一个具体例子：`例如"现在已经是周三了"`（[腾讯云译文](https://cloud.tencent.com.cn/developer/article/2701696)）。

关于 **git status / 文件状态**：博客正文没有单列 git status，但官方 Claude Code 文档说明会话启动时会带一个 git status 快照，且**文件内容只在被读入 context 时才进入**，之后修改文件不会回溯改写历史里的读取结果，而是**追加 `<system-reminder>` 通知文件已变更**（见 §6.2）。

### 2.5 "不要中途换模型"

> "**Don't change models mid-session**. Prompt caches are unique to models and this can make the math of prompt caching quite unintuitive.
> For example, if you're 100k tokens into a conversation with Opus and want to ask a question that is fairly easy to answer, it would actually be **more expensive to switch to Haiku than to have Opus answer**, because we would need to rebuild the prompt cache for Haiku.
> If you need to switch models, the best way to do it is with **subagents**; … you could deploy a subagent that prompts Opus to prepare a 'hand-off' message to another model on the task that it needs to get done. We do this often with the Claude Code's **Explore agents, which use Haiku**."

### 2.6 "不要中途改工具集"

> "**Never add or remove tools mid-session**. Changing the tool set in the middle of a conversation is **one of the most common ways people break prompt caching**… because **tools are part of the cached prefix**, adding or removing a tool invalidates the cache for the entire conversation."

**Plan Mode 的绕法（用工具表达状态，而不是换工具集）**：

> "Instead, we keep **all tools in the request at all times** and use **EnterPlanMode and ExitPlanMode as tools themselves**. When the user toggles Plan Mode on, the agent gets a **system message** explaining that it's in Plan Mode… The tool definitions never change."

**Tool search 的绕法（defer 而不是 remove）**：

> "Our solution: **`defer_loading`**. Instead of removing tools, we send **lightweight stubs** (just the tool name, with `defer_loading: true`) that the model can 'discover' via tool search when needed… This keeps the **cached prefix stable** because the same stubs are always present in the same order."

API 侧对应文档确认这不会破坏前缀：
> "Deferred tools are **not included in the system-prompt prefix**… the definition is **appended inline as a `tool_reference` block in the conversation history**. The prefix is untouched, so prompt caching is preserved."

### 2.7 断点具体放在哪里

博客本身只说了「**从请求开头一直缓存到每个 `cache_control` 断点**」+ 四层分层，**没有**逐条写出"断点放在 system prompt 末尾 / tools 之后 / compaction 历史前后"。这些具体位置来自另外三处**一手**文档：

| 位置 | 一手出处 | 原文 |
|---|---|---|
| tools 数组之后（标在最后一个 tool 上） | tool-use-with-prompt-caching | "Place `cache_control: {"type": "ephemeral"}` on the **last tool** in your `tools` array." |
| system prompt 末尾 | compaction 文档 | "To maximize cache hit rates, add a **`cache_control` breakpoint at the end of your system prompt**. This keeps the system prompt cached separately from the conversation…" |
| compaction 产生的 summary block 上 | compaction 文档 | "You can add a `cache_control` breakpoint **on compaction blocks** to cache the summarized content." |

Claude Code 自身的请求分层（一手 CC 文档，见 §4）是：**system prompt 层（核心指令 + 工具定义）→ project context 层（CLAUDE.md / auto memory / unscoped rules）→ conversation 层**。

---

## 3. Claude Code 的自动 compaction 与缓存的交互

### 3.1 compaction 是什么、会做什么

一手 [code.claude.com/docs/en/prompt-caching](https://code.claude.com/docs/en/prompt-caching) 的 "Compacting the conversation"：

> "Compaction replaces your message history with a summary. **By design, this invalidates the conversation layer**, since the next request has a new, shorter history that doesn't share a prefix with the old one. **Claude Code reuses the system prompt layer** unless the conversation was resumed while keeping a system prompt that would otherwise have changed… It **reloads project context from disk**, which cache-hits only if CLAUDE.md and memory are unchanged since the session started."

### 3.2 compaction 本身就是一次 cache read（**已被一手文档证实**）

> "To produce the summary, Claude Code sends a **separate request with the same system prompt, tools, and history as your conversation, plus a summarization instruction appended as a final user message**. While the cache is warm, that request **reads your prefix from the cache**, so a mid-session `/compact` costs **a fraction of what the context size suggests** and spends most of its time generating the summary."

> "After a break longer than the cache lifetime, there is **no cache left to read**, so the summarization request **reprocesses the full history as uncached input**. This is why `/compact` costs the most when you **resume an old session**. In both the warm and cold cases, the turn after compaction rebuilds the conversation cache for only the much shorter summary, so that turn is not the slow part."

博客原文（cache-safe forking）与之一致：

> "When we run compaction, we use the **exact same system prompt, user context, system context, and tool definitions** as the parent conversation. We **prepend the parent's conversation messages**, then **append the compaction prompt as a new user message at the end**.
> From the API's perspective, this request looks nearly identical to the parent's last request—same prefix, same tools, same history—so the cached prefix is reused. The only new tokens are the compaction prompt itself.
> This does mean however that we need to save a **'compaction buffer'** so that we have enough room in the context window to include the compact message and the summary output tokens."

**compaction prompt 的内容**（一手 API 文档 [compaction](https://platform.claude.com/docs/en/build-with-claude/compaction)）：

> "The default summarization prompt varies by model. Each default instructs Claude to **write a summary inside `<summary></summary>` tags** with the information needed to continue the task in a future context window."

Claude Code 侧补充（[context-window](https://code.claude.com/docs/en/context-window)）：

> "As of v2.1.198, the summarization request **inherits your session's extended thinking configuration**… Thinking affects only how the summary is produced; your session settings are unchanged afterward."

用户可自定义：`/compact Focus on code samples and API usage`（[costs 文档](https://code.claude.com/docs/en/costs)）。

### 3.3 "cap compaction to a single pass" —— **未能证实**

我在一手来源中**找不到**"compaction 被限制为单次 pass"的说法。相反，API 文档明说服务端 compaction 可能**在一次请求内发生多次**：

> "When using server tools (such as web search), the compaction trigger is checked at the start of each sampling iteration. **Compaction might occur multiple times within a single request** depending on your trigger threshold and the amount of output generated."
> —— [compaction 文档](https://platform.claude.com/docs/en/build-with-claude/compaction)

一手来源中**最接近**"单次"的表述是：Claude Code 的 compaction 是**一次**带相同前缀的摘要请求（§3.2 引文）。因此"单 pass"更可能是对"一次 cache-safe fork 摘要调用"的转述，而非官方的硬性上限。**请勿把它当作 Anthropic 的官方设计约束引用。**

### 3.4 用几个 cache breakpoint

- **API 层面的硬上限 = 4**（§1.2，一手）。
- **Claude Code 实际用几个**：Anthropic **没有官方公开**。第三方逆向分析 [rz0718](https://rz0718.github.io/articles/2026/04/15/Claude-Code-Caching.html) 给出的是 **4 个**（**[二手-逆向]**）：

| 断点 | 内容 | 变化频率 |
|---|---|---|
| bp1 | tool definitions（标在最后一个 tool 上） | 仅当 MCP server 配置变化 |
| bp2 | 静态 system prompt（跨 org 全局缓存） | 仅 Claude Code 版本升级 |
| bp3 | 动态 system prompt（CLAUDE.md、项目元数据、git status、env） | 会话内稳定 |
| bp4 | 当前对话的滚动锚点 | 每轮移动 |

同一来源还给出了 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 这个内部常量名（**[二手-逆向]**，未经官方确认）。

另有一份**用户抓包实测**（[anthropics/claude-code#76606](https://github.com/anthropics/claude-code/issues/76606)）报出了 captured request body 里的真实断点分布 —— **[二手-实测]**：

```
system[1]         -> ephemeral 1h
system[2]         -> ephemeral 1h
msg[18] block[4]  -> ephemeral 1h    <- the only one in the entire messages array
```

> "**There is exactly ONE `cache_control` breakpoint in the messages array**… So there is nothing to fall back to. A mutation at message 3 and a mutation at message 93 are identically catastrophic."

这与 §1.3 的 20-block lookback 机制互补：messages 数组只放 1 个滚动断点，靠回溯窗口兜底；一旦历史中段被改写，就整体失守。

---

## 4. `cache_creation_input_tokens` / `cache_read_input_tokens` 遥测，以及 Claude Code 如何呈现

### 4.1 API 响应字段（一手）

> "Monitor cache performance using these API response fields, within `usage` in the response (or **`message_start` event if streaming**):
> - `cache_creation_input_tokens`: Number of tokens written to the cache when creating a new entry.
> - `cache_read_input_tokens`: Number of tokens retrieved from the cache for this request.
> - `input_tokens`: Number of input tokens which were not read from or used to create a cache (**that is, tokens after the last cache breakpoint**)."

1h TTL 时还会有细分对象：

> "Note that the current `cache_creation_input_tokens` field equals the sum of the values in the `cache_creation` object."

即 `usage.cache_creation.ephemeral_5m_input_tokens` 与 `usage.cache_creation.ephemeral_1h_input_tokens`。服务端工具（web search 等）会自动在工具结果前插一个 **5 分钟 TTL** 的断点，因此即使用户全用 1h，也会看到 `ephemeral_5m_input_tokens` 写入。

### 4.2 Claude Code 的呈现方式（一手 CC 文档）

| 渠道 | 内容 | 一手原文 |
|---|---|---|
| statusline | `current_usage` 对象 | "`cache_creation_input_tokens`: Tokens written to the cache on this turn, billed at the cache write rate" / "`cache_read_input_tokens`: Tokens served from cache on this turn, billed at **roughly 10% of the standard input rate**" |
| `/usage`（Session block） | `Prompt cache (main)` 行：命中率、miss 次数、当前 warm/cold | "After the main conversation's first API response, Claude Code also adds a `Prompt cache (main)` line to the Session block, summarizing the session's prompt cache use: the request count, **the share of input tokens served from cache**, cache misses, and whether the cache is warm right now."（需 v2.1.251+） |
| `/usage` miss 归因 | `likely cause: tool definitions changed` | "When Claude Code can identify a likely cause for the last miss, the line names it too, for example `likely cause: tool definitions changed`."（需 v2.1.260+） |
| `/usage` 的 miss 判定阈值 | `>5%` 且 `≥2,000` tokens | "Claude Code counts a request as a miss when the request **re-processed more than 5% and at least 2,000 tokens** of what it could have read from cache." |
| `/usage` expected rebuilds | compaction / 清理旧 tool result 不算 miss | "when Claude Code has itself just rewritten the conversation, by compaction or by clearing old tool results from context, it counts the same kind of miss as an **expected rebuild** instead." |
| statusline 结构化 | `prompt_cache` 对象 | "A status line script can read the same numbers from the `prompt_cache` object." |
| CLI 验证 TTL | `claude -p "hello" --output-format json` | "read `usage.cache_creation` in the result. Claude Code reports one-hour cache writes under `ephemeral_1h_input_tokens` and five-minute cache writes under `ephemeral_5m_input_tokens`." |
| OpenTelemetry | 按用户/会话导出 cache read & creation tokens | "For visibility across an organization, the OpenTelemetry exporter reports cache read and creation tokens per user and session." |

### 4.3 `/cost` 与 "cache read"

- 一手 CC 文档在 [costs](https://code.claude.com/docs/en/costs) 页里，把这一行记在 **`/usage`** 下（"#### Prompt cache statistics … adds a `Prompt cache (main)` line to the Session block"）。
- **第三方实测**文章 [DevelopersIO: Claude Code v2.1.250 → v2.1.251](https://dev.classmethod.jp/en/articles/20260829-cc-updates-v2-1-251/) 记录 v2.1.251 changelog 的措辞是 **`/cost`**，并给出实际输出样例 —— **[二手-实测]**：

```
Prompt cache (main):   11 requests · 90% of input tokens from cache · no misses · warm (1h TTL, last activity 31s ago)
```

同一篇还记录 changelog 条目为「hit ratio, miss count, re-cached token count, warm/cold」+ 供 statusline 使用的 `prompt_cache` 对象。该文作者也指出：`tokens re-cached` 在"no misses"时未显示。

> **表述建议**：说"`/usage`（部分版本/文档写作 `/cost`）的 Session block 会显示 `Prompt cache (main)` 行"最安全。

### 4.4 另有的内部信号

- 用户抓包显示会话 JSONL 里有 `message.diagnostics.cache_miss_reason`，值形如 `messages_changed`（[#76606](https://github.com/anthropics/claude-code/issues/76606)）—— **[二手-实测]**。
- 第三方逆向称存在专用可观测子系统 `services/api/promptCacheBreakDetection.ts` 与 `tengu_prompt_cache_break` 分析事件 —— **[二手-逆向]**（见 §7）。

---

## 5. 量化声明

### 5.1 "成本最高降 90%、延迟最高降 85%" —— **一手原文确认**

来源：[claude.com/blog/prompt-caching](https://claude.com/blog/prompt-caching)（原发布/公告：2024-12-17；页面元数据日期 2025-08-14）

> "…With prompt caching, customers can provide Claude with more background knowledge and example outputs—all while **reducing costs by up to 90% and latency by up to 85% for long prompts**."

同页给出的实测表格（**注意：这三个案例都不到 85%**，85% 是"up to"）：

| 用例 | 无缓存 TTFT | 有缓存 TTFT | 延迟降幅 | 成本降幅 |
|---|---|---|---|---|
| Chat with a book（100,000 token cached prompt） | 11.5s | 2.4s | **-79%** | **-90%** |
| Many-shot prompting（10,000 token prompt） | 1.6s | 1.1s | **-31%** | **-86%** |
| Multi-turn conversation（10 轮 + 长 system prompt） | ~10s | ~2.5s | **-75%** | **-53%** |

同页的定价表述（与今天文档一致）：

> "Writing to the cache costs **25% more** than our base input token price for any given model, while using cached content is significantly cheaper, costing only **10% of the base input token price**."

### 5.2 "典型 Claude Code 会话中缓存 vs 未缓存 token 的比例" —— **官方没有给数字**

- 一手 CC 博客只给出**运维立场**，没有给比例：
  > "we run alerts on our prompt cache hit rate and declare SEVs if they're too low" + "A few percentage points of cache miss rate can dramatically affect cost and latency."
- 一手 CC 文档只给**定性判据**：
  > "`cache_creation_input_tokens`: Tokens written to the cache on this turn… `cache_read_input_tokens`: Tokens served from cache on this turn… **A high read-to-creation ratio means caching is working well.**"

**所有具体比例都来自二手来源，引用时必须标注：**

| 数字 | 来源 | 性质 |
|---|---|---|
| `/cost` 实测行：`90% of input tokens from cache`（11 requests、1h TTL） | [DevelopersIO 实测](https://dev.classmethod.jp/en/articles/20260829-cc-updates-v2-1-251/) | [二手-实测] 单会话样本 |
| 第 10 轮示例：33,000 / 35,400 = **93%** 命中率（约 35.4k 总 token） | [rz0718](https://rz0718.github.io/articles/2026/04/15/Claude-Code-Caching.html) | [二手-逆向] **构造的示例，非实测均值** |
| "long sessions can sustain **80–90%** cache hit rates" | 同上 | [二手-逆向] |
| "my overall cache hit rate is **95%**"，并按会话时长给出 83%/91%/95%/96%/96% + 平均成本表 | [anipotts/coding-agent-tips](https://github.com/anipotts/coding-agent-tips/blob/v2.1.0/docs/tips/prompt-caching.md) | [二手-个人经验] 无方法论，**可靠性最低** |

> 结论：**"典型会话缓存比例"没有权威数字。** 若必须引用，用官方 `/cost` 行的实测样例（90%）最稳妥，并注明是单样本。

### 5.3 其他有价值的量化点

- **1h 缓存命中不计入 rate limit**（一手）："cache hits are not deducted against your rate limit"。
- **长上下文会话的 token 反直觉现象**（一手 CC costs 文档）：
  > "**Long context**: Claude Code sends your full conversation with every request… With prompt caching, Claude Code re-reads that history at the cached token rate, so **a one-line question in a session that has been open all day still draws usage for the whole conversation**."
- **背景 token 成本**：`"These background processes consume a small amount of tokens (typically under $0.04 per session)"`（一手）。
- **Claude Code 人均成本**（一手）：`"the average cost is around $13 per developer per active day and $150-250 per developer per month"`。
- 用户抓包的成本量级（**[二手-实测]**）：单次 mid-history 改写导致 `cache_read` 从 125,948 崩到残余、整段以 1h 写入倍率重写，**约 $2.75**；另有 5 次重建共 1,431,014 `cache_creation` tokens。

---

## 6. 反模式清单

### 6.1 Anthropic 官方**明确点名**的反模式

**来自 CC 博客（原文点名）：**
1. 把**精细时间戳**放进静态 system prompt。
2. **非确定性打乱 tool 定义顺序**。
3. **修改工具参数**（例：Agent tool 能调用哪些 agents）。
4. **会话中途添加或删除 tools** —— "one of the most common ways people break prompt caching"。
5. **会话中途切换模型** —— cache 按模型隔离。
6. 用**改 system prompt** 的方式做 plan mode / 改日期 —— 应该用 messages。
7. fork 类操作**不共享父请求前缀**（compaction / summarization / skill execution）。

**来自 API prompt caching 文档：**
8. **把断点放在每次请求都变的 block 上**（时间戳 + 用户消息）→ 回溯找不到先前写入，`"You pay for a fresh cache write on every request and never get a read."`
9. 超过 **20-block lookback 窗口** 而不加第二个断点。
10. 修改 **tool definitions**（名称/描述/参数）→ 整条 cache 全失效。
11. 切换 web search / citations / speed / `tool_choice` / 图片 / thinking 参数 / `output_config.effort`。
12. `tool_use` block 的 **JSON key 顺序不稳定**（Swift、Go 会随机化）。
13. 缓存前缀**不满足最小 token 数**（静默不缓存、不报错）。

**来自 CC 文档 "Actions that invalidate the cache"（一手，最完整的清单）：**
14. Switching models
15. Changing effort level
16. Turning on fast mode
17. **Connecting or disconnecting an MCP server**（在工具"加载进前缀"模式下）
18. Enabling or disabling a plugin（当该插件提供 MCP server 且工具未 defer 时）
19. **Denying an entire tool**（bare tool name / `Bash(*)` / `"*"` 这类 deny 规则会把工具从 context 里整个移除）
20. Compacting the conversation（by design）
21. **Accumulating many images**（超限后批量剔除最旧图片 → 从最早那张图所在消息起重算）
22. Upgrading Claude Code（system prompt / tool 定义通常变化 → 重启后第一轮重建）

**对照：官方列为"不破坏缓存"的行为（同样重要）**
- 编辑仓库里的文件（`"Instead, Claude Code appends a `<system-reminder>` noting the file changed"`）
- **会话中途编辑 CLAUDE.md**（不失效，但**也不生效**，下次 `/clear`、`/compact` 或重启才加载）
- 切换 permission mode（`opusplan` 例外 —— 那是换模型）
- 切换 output style / 调用 skills 与 commands（以 message 形式追加）
- `/recap`（追加而非替换历史）
- **`/rewind`**（截断回早期 turn，命中当时的 cache entry）
- 生成 subagent（父前缀不受影响）

### 6.2 关于用户点名的四个反模式，逐条核对

| 用户列出的反模式 | 官方是否点名 | 证据 |
|---|---|---|
| **加时间戳** | ✅ 是 | 博客原文 "putting an in-depth timestamp in the static system prompt"；API 文档 "Common mistake: Breakpoint on content that changes every request"（时间戳在 block 6）；逆向来源补充 CC 会对日期字符串做 memoize（**[二手-逆向]**） |
| **会话中途切换 MCP 工具** | ✅ 是 | CC 文档 §"Connecting or disconnecting an MCP server"；博客 "Never add or remove tools mid-session"。默认 defer 时安全，`alwaysLoad` / 不支持 tool search 时不安全 |
| **改写更早的消息** | ⚠️ **官方没有作为"反模式"逐条列出**，但语义上必然破坏缓存 | 一手语义："a change anywhere in the prefix recomputes everything after it" + "any change anywhere in the prefix invalidates everything after it"。实测层面由用户抓包证实：CC 自身会把历史里的 `<system-reminder>` hook block **重新塑形（拆成独立消息 / 合并进邻居 / 差一个换行）**，导致中段历史被改写、整段缓存重建（[#76606](https://github.com/anthropics/claude-code/issues/76606)，**[二手-实测]**）。注意 `/rewind` 是官方认可的 cache-safe 截断，与"改写历史"不同 |
| **重排工具顺序** | ✅ 是 | 博客 "shuffling tool order definitions non-deterministically"；API 文档要求 tool 顺序稳定（含 `tool_use` 的 JSON key 顺序） |

### 6.3 官方给出的正向设计模式（可迁移到自家 agent）

从 CC 博客 "Lessons learned" 原文：
1. **"Prompt caching is a prefix match."** 任何前缀内的改动都会使其后全部失效 —— 围绕这个约束设计整个系统。
2. **"Use messages instead of system prompt changes."**
3. **"Don't change tools or models mid-conversation."** 用工具表达状态转移；defer 而不是 remove。
4. **"Monitor your cache hit rate like you monitor uptime."** —— 对 cache break 告警并当事故处理。
5. **"Fork operations need to share the parent's prefix."**

外加一手工程博客的可迁移做法：
- **`max_tokens: 0` 预热缓存**（pre-warming），把 system prompt / tool 定义先写进缓存，消掉首次交互的 cache-miss 延迟；断点必须放在与后续请求共享的最后一个 block 上（[prompt caching 文档 §Pre-warming](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)）。
- **context compaction 要保真**：`"we recommend carefully tuning your prompt on complex agent traces. Start by maximizing recall… then iterate to improve precision"`（[Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)）。
- **工具返回要省 token**：Claude Code 默认限制工具响应为 **25,000 tokens**（[Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)）。

---

## 7. 未能证实 / 存疑的说法清单（重要）

| # | 说法 | 状态 |
|---|---|---|
| 1 | **"最多 5 个 cache breakpoint"** | ❌ **一手文档明确是 4**。未找到任何官方来源支持 5。 |
| 2 | **"compaction 被限制为单次 pass"** | ❌ **未能证实**。API 文档反而说服务端 compaction 在单请求内可能发生多次。最接近的官方表述是"Claude Code 用一次共享前缀的摘要请求"。**不要当作官方约束引用。** |
| 3 | **"典型 Claude Code 会话缓存/未缓存 token 比例"** | ⚠️ 官方无数字。只有定性判据 + 二手单样本（90%）。 |
| 4 | **CC 具体用 4 个断点（bp1 tools / bp2 静态 system / bp3 动态 system / bp4 滚动对话）** | ⚠️ 来自 [rz0718](https://rz0718.github.io/articles/2026/04/15/Claude-Code-Caching.html) 的逆向分析，**未经 Anthropic 确认**。官方只说上限 4，未公开 CC 实际用几个。 |
| 5 | **`cache_control` 支持 `scope: "global" | "org"`** | ⚠️ 官方公开文档只描述 `type: "ephemeral"` + `ttl`。`scope` 及 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`、`getCacheControl()`、`should1hCacheTTL()` 等均来自第三方逆向书 [Harness Engineering 第 13 章](https://zhanghandong.github.io/harness-engineering-from-cc-to-ai-coding/en/part4/ch13.html)（有文件名与行号引用，可信度中等，但属 **[二手-逆向]**）。**生产实现不要依赖未公开字段。** |
| 6 | **"~90% 的 cache break 发生在服务端"** | ⚠️ 出自上述逆向书引用的 CC 源码注释（`promptCacheBreakDetection.ts`）。**[二手-逆向]**，非官方发布。 |
| 7 | **`tengu_prompt_cache_break` 事件、双阈值 `>5% 且 >2000 tokens` 的 break 判定** | ⚠️ 同上，**[二手-逆向]**。巧合的是 CC 公开文档里 `/usage` 的 miss 阈值也是 "more than 5% and at least 2,000 tokens"，可交叉印证。 |
| 8 | **"1h TTL 是 CC 在订阅计划下的主对话默认值"** | ✅ 一手 CC 文档确认：`"Unless you choose a TTL yourself, Claude Code requests the one-hour TTL only on a Claude subscription within your plan's included usage."`（API key / 云厂商默认 5 分钟） |
| 9 | **模型名（Opus 5 / Fable 5.1 / Sonnet 5 / Mythos 5.1）** | 本报告中的模型名、价格、最小长度表均为**抓取当时官方文档的原样内容**。若你的部署面向更早的模型谱系（Opus 4.5 = 4096、Sonnet 4.5 = 1024、Haiku 3.5 = 2048），倍率与层级语义完全一致，只有模型清单不同。 |

---

## 证据与来源

### 一手：Anthropic 官方博客
1. **Lessons from building Claude Code: Prompt caching is everything** — <https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything>
   （直连截断；全文经 <https://r.jina.ai/https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything> 获取。作者 Thariq Shihipar）
2. **Prompt caching with Claude**（"up to 90% / up to 85%" 与三行实测表出处）— <https://claude.com/blog/prompt-caching>
3. **Effective context engineering for AI agents** — <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
4. **Writing effective tools for AI agents—using AI agents** — <https://www.anthropic.com/engineering/writing-tools-for-agents>

### 一手：Anthropic 官方文档
5. **Prompt caching（API）** — <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>
   等价旧地址：<https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching>
   （`docs.claude.com/en/docs/build-with-claude/prompt-caching` 会 301 到 platform.claude.com）
6. **Compaction（API）** — <https://platform.claude.com/docs/en/build-with-claude/compaction>
7. **Tool use with prompt caching** — <https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching>
8. **Cache diagnostics (beta)** — <https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics>
9. **How Claude Code uses prompt caching** — <https://code.claude.com/docs/en/prompt-caching>
10. **Manage costs effectively / Prompt cache statistics** — <https://code.claude.com/docs/en/costs>
11. **Explore the context window（compaction 后什么被保留）** — <https://code.claude.com/docs/en/context-window>

### 二手：翻译与实测
12. **腾讯云开发者社区中文全译**《构建 Claude Code 的经验：Prompt Caching 是一切》— <https://cloud.tencent.com.cn/developer/article/2701696>
    （原文作者 X 帖：<https://x.com/trq212/status/2024574133011673516>）
13. **DevelopersIO：Claude Code v2.1.250 → v2.1.251**（`/cost` 的 `Prompt cache (main)` 实际输出）— <https://dev.classmethod.jp/en/articles/20260829-cc-updates-v2-1-251/>
14. **anthropics/claude-code#76606** —— Prompt cache invalidated by rewrites of messages in long sessions（中段改写、messages 数组仅 1 个断点、抓包数据）— <https://github.com/anthropics/claude-code/issues/76606>
15. **anthropics/claude-code#70459** —— Auto-compaction 两个成本 bug（cache-safe fork 失效、`cache_read` 仅剩 system prompt）— <https://github.com/anthropics/claude-code/issues/70459>
16. **anthropics/claude-code#58103** —— Feature request: user-configurable cache breakpoint hierarchy — <https://github.com/anthropics/claude-code/issues/58103>
17. **anipotts/coding-agent-tips：prompt-caching 技巧**（命中率 95% 等个人数据，可靠性低）— <https://github.com/anipotts/coding-agent-tips/blob/v2.1.0/docs/tips/prompt-caching.md>

### 二手：逆向分析（明确未经官方确认）
18. **rz0718 —— How Claude Code Design Prompt Caching**（4 断点布局、bp1–bp4、80–90% 命中率）— <https://rz0718.github.io/articles/2026/04/15/Claude-Code-Caching.html>
19. **Harness Engineering: From Claude Code Internals to AI Coding Best Practices**
    - 第 13 章 Cache Architecture and Breakpoint Design（三种 cache scope、`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`、TTL latching、beta header latching）— <https://zhanghandong.github.io/harness-engineering-from-cc-to-ai-coding/en/part4/ch13.html>
    - 第 14 章 Cache Break Detection System（两阶段检测、双阈值、"~90% 的 break 在服务端"、`tengu_prompt_cache_break`）— <https://zhanghandong.github.io/harness-engineering-from-cc-to-ai-coding/en/part4/ch14.html>
