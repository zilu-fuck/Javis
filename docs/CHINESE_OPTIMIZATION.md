# Javis 中文输出优化方案

Last updated: 2026-05-26

> **Status**: Both Layer 1 and Layer 2 are now implemented. This document is
> retained as the original design reference. See `docs/2026-05-26_TASK_PLAN.md`
> for implementation details.

## 现状诊断

Javis 在中文本地化方面做了三件事，但都没触及核心问题：

| 层面 | 现状 | 问题 |
|---|---|---|
| UI 标签 | `zhCNWorkbenchLocale` 覆盖了 190+ 短语 | 只覆盖了 UI 骨架，不涉及 Agent 输出 |
| 硬编码消息 | `commanderMessage` 等字段混有中英文 | 散落在各流函数中，无统一策略 |
| opencode prompt | `create_opencode_proposal_prompt` 纯英文 | 模型收到的指令全是英文 |

**核心问题：open code 发给模型的 system prompt 和 task prompt 全是英文，模型自然不会用中文思考和输出。**

---

## 两层策略

```
Layer 1 (轻量，立即可做)         Layer 2 (深度，依赖 Fix 2/3)
┌─────────────────────────┐    ┌──────────────────────────┐
│ Prompt 模板中注入语言指令  │    │ Agent System Prompt 原生  │
│ + 模型选择偏向中文模型    │───→│ 中文编写                   │
│ + summary 字段中文化     │    │ + Commander 中文规划       │
│                         │    │ + Verifier 中文验证        │
│ 影响：Code Agent 提案    │    │ + 共享上下文中文化         │
│ 改动量：~50 行 Rust      │    │ 影响：全部 Agent           │
│                         │    │ 改动量：~300 行 TS         │
└─────────────────────────┘    └──────────────────────────┘
```

---

## Layer 1：Prompt 模板中文化（立即可做）

### 1.1 opencode prompt 注入语言指令

当前 `lib.rs:1279-1304`，open code 收到的 prompt 完全没有语言指示：

```rust
// 当前
fn create_opencode_proposal_prompt(request: &CodeProposeEditRequest) -> String {
    format!(
        r#"You are generating a patch proposal for Javis. Do not edit files..."#,
        // ...
    )
}
```

改为接收 locale 参数并生成对应的 prompt：

```rust
// apps/desktop/src-tauri/src/lib.rs

fn create_opencode_proposal_prompt(
    request: &CodeProposeEditRequest,
    locale: &str,  // "zh-CN" | "en"
) -> String {
    match locale {
        "zh-CN" => format!(
            r#"你是 Javis 的代码补丁生成器。不要修改任何文件。只返回一个 JSON 对象，不要包含 markdown 代码块或额外解释。

严格使用以下格式：
{{"summary":"一句话中文摘要","changedFiles":["相对路径"],"patch":"unified diff 文本"}}

规则：
- changedFiles 必须是已批准变更文件的非空子集。
- patch 必须是非空的 unified diff，只涉及 changedFiles 中的文件。
- patch 必须能应用到下方的当前 diff preview 上。
- 如果你无法生成安全的 unified diff，不要捏造文件或不安全的编辑。
- 你的 summary 字段必须用中文撰写。

用户目标：
{}

已批准的变更文件：
{}

当前 diff 预览：
{}"#,
            request.user_goal.trim(),
            request.changed_files.join("\n"),
            request.diff,
        ),
        _ => format!(/* 现有英文 prompt */),
    }
}
```

### 1.2 语言指令注入的三个关键点

不是简单翻译 prompt 就完了。有三个注入点：

**A. 角色定义** — "你是 Javis 的代码补丁生成器" 告诉模型它的身份和语言期望。

**B. 输出约束** — "你的 summary 字段必须用中文撰写" 明确要求输出中文。JSON 结构字段是固定的，但 `summary` 内容可以是指定语言。

**C. 思维链暗示** — 在 prompt 中暗示模型用中文推理。对于 DeepSeek-R1 等推理模型，这个特别重要。可以加上：

```
在生成 patch 之前，先用中文思考以下问题：
1. 用户的真实意图是什么？
2. 当前 diff 中有哪些关键变更？
3. 最小改动方案是什么？
```

但这会增加 token 消耗。建议作为可选增强，通过 feature flag 控制。

### 1.3 locale 如何传递到 Tauri command

在 `app-runtime.ts` 中，`proposeEdit` 调用时携带当前 locale：

```typescript
// apps/desktop/src/app-runtime.ts — proposeEdit 部分
proposeEdit: ({ userGoal, preview }) =>
  proposeCodeEditWithModelProvider(userGoal, preview, modelProvider, locale),
```

然后在 `CodeProposeEditRequest` 结构体中加一个 `locale` 字段：

```rust
// Rust 端对应的 struct 加字段
struct CodeProposeEditRequest {
    // ...existing fields
    locale: Option<String>,  // "zh-CN" or absent
}
```

### 1.4 利用 DeepSeek 中文优势

`lib.rs:1101-1107` 已有 DeepSeek fallback 逻辑：

```rust
fn should_fallback_to_openai_compatible(request: &CodeProposeEditRequest) -> bool {
    let provider_id = /*...*/;
    has_credentials && (provider_id == "deepseek" || ...)
}
```

DeepSeek 模型对中文有天然优势。在 prompt 中加上中文指令后，DeepSeek 输出质量会显著高于同等英文 prompt 驱动的模型。

建议：当 `locale == "zh-CN"` 且 provider 是 opencode 默认模型（非 DeepSeek）时，考虑是否优先路由到 DeepSeek。这个决策要权衡延迟和中文质量。作为保守的第一步，可以先在配置中让用户选择"中文优化模型"。

---

## Layer 2：Agent System Prompt 原生中文（多 Agent 场景）

这部分依赖 `MULTI_AGENT_FIX_PLAN.md` 中的 Fix 2（Commander LLM）和 Fix 3（Agent system prompt）。一旦 Agent 有了 system prompt，中文优化就不再是"翻译英文 prompt"，而是"用中文写 prompt"。

### 2.1 Agent 级 system prompt 双语方案

```typescript
// packages/core/src/agents.ts

export interface AgentPromptSet {
  en: string;
  zhCN: string;
}

export interface Agent {
  // ...existing fields
  systemPrompt: AgentPromptSet;
}

export const demoAgents: Agent[] = [
  {
    id: "agent-commander",
    kind: "commander",
    displayName: "Commander",
    description: "Task planning and orchestration",
    allowedToolNames: ["commander.plan"],
    systemPrompt: {
      en: `You are the Commander. Your job is to analyze the user's goal
and decompose it into concrete steps...`,
      zhCN: `你是 Javis 的指挥官（Commander）。你的职责是分析用户目标，
将其分解为可执行的步骤序列。

对于每个步骤，你需要指定：
1. 最适合执行的 Agent 类型（file / shell / code / research / computer / scheduler）
2. 步骤标题（中文）
3. 成功标准（中文）

输出格式为 JSON：
{
  "title": "任务标题（中文）",
  "reasoning": "你的分析过程（中文）",
  "steps": [
    {
      "id": "step-xxx",
      "title": "步骤标题（中文）",
      "assignedAgentKind": "file",
      "successCriteria": "成功标准（中文）"
    }
  ]
}

注意：
- 你自己不执行任何步骤，只负责规划。
- 如果用户目标模糊，在 reasoning 中指出需要澄清的地方。
- 优先安排只读步骤，写入步骤必须排在最后并标记为需要用户确认。`,
    },
  },
  {
    id: "agent-code",
    kind: "code",
    // ...
    systemPrompt: {
      en: `You are the Code Agent...`,
      zhCN: `你是 Javis 的代码代理（Code Agent）。你负责检查 git 仓库、
审查代码差异、生成补丁提案。

核心规则：
- 永远先执行只读检查（git diff --check）再提案。
- 提案的 summary 字段必须用中文撰写。
- 绝不跳过用户确认直接修改文件。
- 如果你不确定改动是否安全，在 summary 中明确指出风险。`,
    },
  },
  {
    id: "agent-verifier",
    kind: "verifier",
    // ...
    systemPrompt: {
      en: `You are the Verifier...`,
      zhCN: `你是 Javis 的验证器（Verifier）。你的职责是逐项检查每个步骤的输出
是否满足成功标准。

对于每项检查，你必须给出明确的判定：
- PASS：证据充分，满足成功标准
- WARN：有小问题但不影响整体
- FAIL：证据缺失或不满足标准

输出格式为 JSON：
{
  "status": "verified" | "unverified" | "failed",
  "summary": "验证总结（中文）",
  "evidence": [
    {
      "kind": "file" | "command" | "source" | "log",
      "label": "检查项（中文）",
      "result": "pass" | "warn" | "fail",
      "detail": "详细说明（中文）"
    }
  ]
}

注意：
- 要具体指出什么证据缺失或什么问题。
- 不要模糊地说"可能有问题"，给出明确的判定理由。`,
    },
  },
  // ...其余 Agent 同理
];
```

### 2.2 System Prompt 选择逻辑

在运行时根据 locale 选择对应语言的 prompt：

```typescript
// packages/core/src/agent-prompt.ts

export function getSystemPrompt(agent: Agent, locale: string): string {
  return locale.startsWith("zh") ? agent.systemPrompt.zhCN : agent.systemPrompt.en;
}
```

### 2.3 为什么"写中文 prompt"优于"翻译英文 prompt"

直接翻译英文 prompt 会带来三个问题：

1. **语气生硬** — "You are the Commander" 直译成 "你是指挥官" 缺少中文语境下的自然感。"你是 Javis 的指挥官" 加入了项目名和自我认知。
2. **约束遗漏** — 英文 prompt 中隐含的约束（如 "Do not invent files"）在翻译时可能被软化。中文 prompt 需要用中文思维重新表达这些约束："不要捏造文件" > "Do not invent files"。
3. **示例不匹配** — 英文 prompt 中的例子是英文场景。中文 prompt 应该用中文场景的示例。

---

## 跨 Agent 中文一致性

### 3.1 共享上下文的中文键名

在 `MULTI_AGENT_FIX_PLAN.md` Fix 7 的共享上下文中，使用中文键名：

```typescript
// File Agent 写入
context.set("文件扫描结果", { documents, count: documents.length });
context.set("扫描摘要", `找到 ${documents.length} 个 Markdown 文档`);

// Code Agent 读取
const scanResult = context.get("文件扫描结果");
const summary = context.get("扫描摘要");
```

或者使用枚举常量同时支持中英文：

```typescript
// packages/core/src/shared-context-keys.ts
export const CTX_KEYS = {
  FILE_SCAN: { en: "fileScan", zh: "文件扫描结果" },
  PROJECT_INSPECTION: { en: "projectInspection", zh: "项目检查结果" },
  CODE_REVIEW: { en: "codeReview", zh: "代码审查结果" },
  RESEARCH_SOURCES: { en: "researchSources", zh: "研究来源" },
} as const;

export function ctxKey(key: typeof CTX_KEYS[keyof typeof CTX_KEYS], locale: string): string {
  return locale.startsWith("zh") ? key.zh : key.en;
}
```

### 3.2 Agent 间通信的"语言契约"

不管哪个 Agent 写共享上下文，**summary 类字段统一使用用户语言**。这需要在架构层面约定：

| 字段类型 | 语言规则 |
|---|---|
| 文件路径、命令名、工具名 | 保持原样（技术标识符） |
| summary、reasoning、message | 使用当前 locale 语言 |
| JSON 结构键名 | 保持英文（方便解析） |
| 日志 detail | 使用当前 locale 语言 |

### 3.3 Commander → Agent 的中文指令链

当 Commander 用中文产出了规划后，它发给子 Agent 的指令也是中文的。这会形成一个自然的"中文思维链"：

```
用户输入（中文）
  → Commander 分析（中文）
    → "需要先扫描项目文件，再检查代码变更。"
  → File Agent 收到指令（中文）
    → "请扫描 E:\Javis 下的所有 Markdown 文档"
    → 输出 summary（中文）
  → Code Agent 收到上下文（中文）
    → "基于已有的 15 个文档，检查当前 git diff"
    → 输出补丁提案（summary 中文）
  → Verifier 验证（中文）
    → "文档扫描：PASS，15/15 个文档字段完整"
    → "代码审查：PASS，diff --check 退出码 0"
```

所有中间输出在 UI 日志中都是一致的中文，用户体验连贯。

---

## opencode 自身的语言行为

opencode 有自己的内部 system prompt。`--format json` 模式会限制输出格式，但不会限制语言。需要注意：

1. **opencode 的思考过程** — 如果未来启用了 opencode 的 verbose/thinking 模式，其内部思考可能是英文的。这是 opencode 自身的行为，不应强行改变。但用户可见的最终输出应该由我们的 prompt 控制。

2. **opencode 的权限错误** — opencode 被拒绝执行某操作时的错误信息是英文的。这些不是发给模型的，是 opencode 自身产生的。如果需要在 UI 中展示，可以在 `lib.rs` 中做简单的错误信息中文化映射。

3. **opencode 版本升级** — opencode 自身的 system prompt 可能在版本间变化。应该在集成测试中验证中文 prompt 在不同 opencode 版本下的行为一致性。

---

## 实施优先级

| 优先级 | 改动 | 影响范围 | 工作量 |
|---|---|---|---|
| P0 | Layer 1.1：opencode prompt 中文化 | Code Agent 提案输出 | ~30 行 Rust |
| P0 | Layer 1.2：locale 参数传递链路 | app-runtime.ts + lib.rs | ~20 行 TS + Rust |
| P1 | Layer 2.1：Agent system prompt 双语 | 全部 Agent（依赖 Fix 3） | ~200 行 TS |
| P1 | Layer 2.2：prompt 选择逻辑 | agent-prompt.ts | ~30 行 TS |
| P2 | Layer 3.1：共享上下文中文键名 | 全部流函数 | ~50 行 TS |
| P2 | Layer 1.4：DeepSeek 中文优先路由 | lib.rs | ~20 行 Rust |
| P3 | opencode 错误信息中文化 | lib.rs | ~30 行 Rust |

P0 可以在 1-2 小时内完成，立刻让 Code Agent 提案输出中文 summary。
P1 依赖 `MULTI_AGENT_FIX_PLAN.md` 的 Fix 2/3，是让多 Agent 协作全程中文的关键。
