# Pi Agent vs OpenCode 对比分析

最后更新：2026-05-26

## 背景

在 Code Agent live QA 遇到 ureq TLS 问题后，提出了是否应将底层从 opencode 换为 Pi Agent 的问题。本文档记录分析结论和参考信息。

## 结论：不换

**Javis 的问题不是 opencode 的问题，是 ureq 的 TLS 配置问题。**

当前的 Code Agent proposal 路径已经修好——有 API 凭证时直接走 HTTP API，完全跳过 opencode CLI：

```rust
// lib.rs — propose_code_edit_with_opencode
if should_fallback_to_openai_compatible(&request) {
    let output = run_openai_compatible_proposal_request(&request, &prompt)?;
    return parse_code_proposal_from_text_for_request(
        &canonical_workspace, &output, &request,
    );
}
// opencode 路径只在没有 API 凭证时才会走到（极少情况）
```

Python 测试已验证 HTTP API 连通正常（HTTP 200 + 有效 JSON proposal）。问题出在 `ureq`（Rust HTTP 客户端）在 Windows release 构建中的 TLS 证书链。

**修复方向**：`ureq` → `reqwest`（带 `native-tls` feature），或给 `ureq` 配置 Windows 根证书。

---

## 架构对比

### opencode

| 维度 | 说明 |
|------|------|
| 定位 | CLI 编码助手，开箱即用 |
| 接口 | CLI 子进程（`opencode run`）+ 环境变量配置 |
| 输出 | NDJSON 事件流（`step_start / text / step_finish`） |
| 优势 | 内置 LSP、MCP、多 provider 支持 |
| 在 Javis 中的角色 | 仅用于 proposal 生成（已被 HTTP API 替代） |

### Pi Agent

| 维度 | 说明 |
|------|------|
| 定位 | 可编程 Agent **平台**，最小核心 + 无限扩展 |
| 架构 | 三层：`pi-ai`（LLM 抽象）→ `pi-agent-core`（ReAct 运行时）→ `pi-coding-agent`（SDK） |
| 接口 | TypeScript SDK（`createAgentSession()`），同进程运行 |
| Hook 系统 | 25+ 类型化事件，7 个类别 |
| 扩展模型 | npm/git 包生态，Skills / Rules / Commands 兼容 Claude Code 目录 |
| 典型用例 | 构建自定义自动化工作流、多 Agent 团队协作 |

---

## 为什么不适合换

### 1. 架构定位冲突

Pi Agent 是一个**通用 Agent 框架**——有自己的 ReAct 循环、工具系统、会话管理、hook 事件系统。

Javis **本身就是一个 Agent 框架**（Commander → Agent → Verifier → 权限 → 验证）。

把 Pi Agent 嵌入 Javis 相当于在 Agent 框架里再塞一个 Agent 框架，架构上叠床架屋：

```
Javis 的 Commander 规划
    → Javis 的 Code Agent 执行
        → Pi Agent 的 ReAct 循环  ← 多余的一层
            → Pi Agent 的工具调用  ← 与 Javis 的工具系统重复
    → Javis 的 Verifier 验证
```

### 2. Javis 的需求非常窄

Javis 只需要 Code Agent 做一件事：**生成结构化 JSON proposal**（summary + changedFiles + unified diff patch）。

当前方案（直接 HTTP API 调用 + JSON response parsing）是最简实现，不需要：
- ReAct 循环（Javis 有自己的步骤规划）
- 工具调用（proposal 生成不需要读写文件）
- 会话管理（每次 proposal 是独立请求）
- Hook 事件系统（Javis 有 `TaskEventBus`）

### 3. Pi Agent 的 overhead

- 引入 Pi Agent SDK 意味着引入 `pi-ai` + `pi-agent-core` + `pi-coding-agent` 三个包
- Pi Agent 的 ReAct 循环会产生额外的 token 消耗（每次 proposal 多一轮 think→act→observe）
- Pi Agent 的 system prompt（~1000 tokens）会叠加到 Javis 已有的术语表前缀上
- 维护复杂度增加：需要管理 Pi Agent 的版本更新、配置、兼容性

---

## Pi Agent 值得借鉴的设计

虽然不是替换方案，但 Pi Agent 有几个设计思想对 Javis 的未来演进有参考价值：

### 1. Hook 系统（可参考但当前不需要）

Pi Agent 的 hook 事件分类：
- `input` — 拦截、转换、重定向用户输入
- `before_agent_start` — 每轮动态注入 system prompt
- `tool_execution_start/update/end` — 工具执行全生命周期
- `before_tool_call` / `after_tool_call` — 可阻断/终止

Javis 当前只有 permission 拦截点。如果未来需要更细粒度的 Agent 行为控制，可以参考 Pi 的 hook 分类。

### 2. 分层 System Prompt（部分已实现）

Pi 的 S1-S11 分层 prompt 架构：

| 层级 | 内容 | Javis 对应 |
|------|------|-----------|
| S1 | 运行环境 | `terminology.ts`（术语表注入） |
| S2 | 平台信息 | 不需要（桌面应用） |
| S4 | 项目信息 | `projectTool.inspectProject()` |
| S5 | 核心人设 + 行为约束 | `agents.ts`（bilingual system prompts） |
| S8 | Skills 注册表 | `initialToolDescriptors` + `skillEntries` |

Javis 的术语表注入已经是分层 prompt 的思路，可以按需扩展。

### 3. TypeScript SDK 模式（远期参考）

如果 Javis 未来要支持第三方插件/扩展，Pi 的 `createAgentSession()` 工厂模式值得参考：

```typescript
// Pi Agent 的插件模式（Javis 远期可参考）
const session = await createAgentSession({
  tools: [...builtInTools, ...customTools],
  hooks: [...],
  skills: [...discoveredSkills],
});
```

Javis 当前已有工具描述符（`initialToolDescriptors`）和 MCP 配置（`mcp-config.ts`），这是插件化的基础。

---

## 当前 Code Agent 路径

```
用户目标
  → Commander 规划（LLM 生成步骤计划）
  → Code Agent 检查仓库 diff（git status + git diff）
  → 用户审批预览卡（read-only 确认）
  → HTTP API 生成 proposal JSON（DeepSeek / OpenAI 兼容 API）
  → 用户 confirmed-write 审批
  → Rust native guard 验证（hash + 路径 + 一次性消费 + 文件内容 hash）
  → git apply + git diff --check 验证
```

安全约束：
- 所有写入必须经过 confirmed-write 审批 + native guard
- proposal hash 必须在 approve 和 apply 之间不变
- 变更文件必须在审批范围内
- 文件内容不能在审批后变化
- Git HEAD 必须在 proposal 和 apply 之间不变

---

## 参考资料

- [Pi vs OpenCode 全面对比](https://github.com/disler/pi-vs-claude-code/blob/main/PI_VS_OPEN_CODE.md)
- [Pi Agent SDK 三层架构解析](https://blog.csdn.net/zlt501962603/article/details/160445536)
- [Pi Agent 多 Agent 扩展 (pi-engteam)](https://github.com/sartoris-digital/pi-engteam)
- [Pi Agent 核心运行时 (pi-agent-core)](https://deepwiki.com/badlogic/pi-mono/3-pi-agent-core:-agent-framework)
