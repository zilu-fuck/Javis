# Javis Agent Runtime 双内核方案

> 状态：修订版，实施前置条件已冻结，待代码实现
> 决策日期：2026-07-19
> 决策：Javis 保持唯一控制面；LangChain 负责通用 Agent 步骤；OpenCode 负责代码专项 Agent 步骤。

## 1. 决策摘要

Javis 不在 LangChain 和 OpenCode 之间选择一个框架接管整个系统。两者只作为同一个
`AgentRuntime` 边界后的互斥执行后端。第三方 Agent 内核只负责单步骤的 read/preview
模型-工具循环；Javis 仍是所有副作用、状态和结果的唯一控制面：

- LangChain 执行研究、文件、浏览器、调度、验证等通用模型-工具循环。
- OpenCode 执行仓库理解、代码检索、修改提案和代码分析等代码循环；构建、测试和重构
  在受控命令工具落地前只能产出命令或 patch proposal。
- Commander 规划、DAG 调度、SharedContext、ArtifactEnvelope、审批、Rust 原生安全校验、
  Verifier、任务事件和持久化继续由 Javis 负责。
- 确定性工具步骤直接由 Javis 调度，不为追求“统一”而额外进入任何 Agent 循环。
- `confirmed_write` / `dangerous` 永不进入 LangChain 或 OpenCode 的工具循环。Agent 只能
  产出 proposal/preview，随后由 Commander 生成独立的 Javis direct apply 步骤执行审批和
  写入。
- 同一步骤只能选择一个模型-工具后端。禁止 LangChain 包裹 OpenCode，也禁止 OpenCode
  再启动 LangChain Agent。当前 Computer Use 的 `javis_specialized` 循环是显式迁移例外，
  不得伪装成 direct、LangChain 或 OpenCode；Phase 3 必须决定迁入 LangChain 或继续作为
  受控 Javis 专用后端。

如果某个产品阶段必须只保留一个通用后端，默认保留 LangChain。OpenCode 的专项能力不因此
退回普通模型调用，而是作为 Code Agent 的独立后端继续存在。

## 2. 目标与非目标

### 2.1 目标

1. 让所有 Agent 步骤使用统一输入、结果、事件、用量和错误协议。
2. 让通用 Agent 和代码 Agent 各自使用更合适的执行内核。
3. 保留现有 DAG、SharedContext、ArtifactEnvelope、审批和 Rust 安全投资。
4. 消除 legacy 文本 JSON ReAct 决策链，并保留可控的迁移回退期。
5. 保证续问、失败调用、模型窗口、重规划和恢复场景的数据一致性。

### 2.2 非目标

- 不把 Commander DAG 迁移到 LangGraph 或 OpenCode 内部规划器。
- 不引入 Agent 点对点通信；Agent 仍通过 SharedContext 和步骤制品交接。
- 不允许 OpenCode 直接绕过 Javis 审批写盘、执行危险命令或修改 Git 远端。
- 不建立两套任务 checkpoint、审批记录或最终验证系统。
- 不在本方案中重写已有工具实现或 UI。

## 3. 当前状态

### 3.1 Javis 已有的控制面

当前主链已经覆盖：

- 用户输入、续问历史、附件、工作区和模型配置；
- Commander 计划生成、规范化、编译、修复和失败重规划；
- DAG 依赖、并行调度、超时、重试、背压和熔断；
- `StepResult`、SharedContext、schema 校验和 Handoff Report；
- ArtifactEnvelope 的 task/run/step/agent/tool provenance 与内容哈希；
- confirmed-write 审批、native approval binding、路径守卫和一次性消费；
- RuntimeEvent、WorkflowCheckpoint、TaskSnapshot 和 SQLite 任务历史；
- 显式 Verifier、隐式 provenance verifier 和 Commander 最终综合。

这些能力是系统的 source of truth，不属于任何第三方 Agent 内核。

### 3.2 LangChain 当前状态

LangChain 已通过 `AgentRuntime` 接入原生 Tool Call、流式事件、结构化输出、
`request_input` 和 Javis Tool Gateway，但仍处于受控灰度：

- 仅开放 `read` 和显式白名单内的 `preview`；
- 需要精确匹配已验证的 provider/model profile；
- legacy ReAct 仍是未命中灰度时的回退路径；
- live provider、打包重启和产品工作流验收尚未全部完成。

### 3.3 OpenCode 当前状态

OpenCode 目前不是 Javis 的 `AgentRuntime`。当前实现只在 Code Agent proposal 路径中运行
一次 `opencode run --format json`：

- `edit`、`bash`、`webfetch` 默认拒绝；
- 输出被解析为受限的 patch proposal；
- 实际写入仍由 Javis confirmed-write 和 Rust 原生校验执行；
- 带凭据的 DeepSeek/custom provider 某些路径会直接走 HTTP fallback，未经过 OpenCode；
- OpenCode 的会话、工具事件、取消、用量和错误尚未映射到统一 `AgentRuntime`。

因此，“OpenCode 成为代码专项内核”是目标状态，不是对当前实现的描述。

## 4. 最小必要数据流

```text
用户输入 / 续问
  -> TaskRuntime.start
     - taskId / workflowRunId / agentRunId / stepId / attempt
     - priorMessages
     - cumulative tokenUsage
     - workspace / model profile
  -> Commander.plan
  -> normalize + compile + repair CommanderDagPlan
  -> executeWorkflow
      -> 校验依赖和 inputContextKeys
      -> RuntimeRouter 选择 direct | langchain | opencode | javis_specialized（迁移期）
      -> 选中的单一 AgentRuntime 执行模型-工具循环
      -> Javis Tool Gateway 校验 owner / allowlist / permission / input schema
      -> read/preview 工具执行；副作用动作只返回 proposal
      -> 返回统一 StepResult
      -> 写入 ArtifactEnvelope + SharedContext
      -> 记录事件、用量和 checkpoint
      -> proposal 需要执行时，Commander 创建新的 Javis direct apply 步骤
      -> UI 审批 + Rust 校验后执行副作用
  -> 失败时 retry 或 Commander replan
  -> Verifier + provenance diagnostic
  -> Commander synthesis
  -> TaskSnapshot / task history
```

Agent 内核只拥有“单步骤内的模型-工具循环”。它不拥有任务生命周期、DAG、审批和最终结论。

## 5. 职责边界

| 层 | 唯一负责人 | 说明 |
| --- | --- | --- |
| 用户输入与续问 | Javis | 恢复历史、附件、累计用量和工作区 |
| 计划与重规划 | Javis Commander | 生成并编译 `CommanderDagPlan` |
| DAG 调度 | Javis Core | 依赖、并行、超时、重试、背压、熔断 |
| 通用步骤循环 | LangChain backend | 原生 Tool Call、通用结构化结果 |
| 代码步骤循环 | OpenCode backend | 仓库语境、代码分析、修改与验证策略 |
| 工具授权与分发 | Javis Tool Gateway | owner、allowlist、权限、schema、审计 |
| 本地写安全 | Javis UI + Rust | 可见审批、绑定哈希、路径守卫、一次性消费 |
| Agent 交接 | SharedContext + ArtifactEnvelope | schema、来源、哈希、敏感级别 |
| 最终验证与回答 | Javis Verifier + Commander | 证据检查、错误优先级、用户回答 |
| 事件和恢复 | Javis | RuntimeEvent、Checkpoint、TaskSnapshot、SQLite |

## 6. 后端路由规则

路由由编译后的 `executionMode`、唯一 `primaryCapability` 和权限共同决定，Agent kind 只
作为兼容性校验。编译器必须拒绝没有 primary capability 的 `react` 步骤、或同时包含
LangChain 与 OpenCode 能力的步骤；direct 和 `desktop_input` 不要求 primary capability。
顺序固定：

1. `direct_response` / `direct_tool_call` 直接进入 Javis executor，不启动 Agent runtime。
2. `confirmed_write` / `dangerous` 必须是 Javis direct apply 步骤；如果前一步是 Agent，
   只能消费其 proposal/preview，不能让 Agent 继续调用写工具。
3. `react` 步骤再按 `primaryCapability` 选择后端：代码能力到 OpenCode，其他 read/preview
   能力到 LangChain。
4. `desktop_input` 在 Computer Use 迁移完成前显式路由到 `javis_specialized`；它不能被
   记录为 direct、LangChain 或 OpenCode。
5. 迁移期仅允许在步骤启动前回退 legacy，并必须记录 `runtime_unavailable` 或具体回退原因。
   一旦产生模型或工具调用，禁止跨后端重放。Phase 4 删除 legacy 后，后端不可用必须
   返回 `runtime_unavailable`，交由 Commander 重规划或终止，不得 LangChain/OpenCode
   自动互换。

### 6.1 OpenCode 默认能力

- `code_search`
- `code_trace`
- `code_propose`
- `language_review`
- `security_review`
- `code_explore`
- `performance_analysis`
- `build_fix`、`test_run`、`refactor` 在受控 command/sandbox 工具完成前仅允许产出
  proposal，不允许实际执行命令。

默认 Agent kind：`code`、`language-reviewer`、`security-reviewer`、`build-fix`、
`test-runner`、`explorer`、`perf-analyzer`、`refactor`。

`code_apply`、Git 写操作和可能产生工作区副作用的测试/构建命令，仍必须通过 Javis 的权限与
沙箱执行路径。OpenCode 可以决定或提出动作，但不能成为最终写入授权者。实际的 apply
步骤必须是新的 Javis direct step。

### 6.2 LangChain 默认能力

| 能力 | LangChain 可做 | 副作用执行者 |
| --- | --- | --- |
| `file_scan`、`document_classify` | read/preview | Javis direct |
| `web_search`、`web_fetch`、`trend_fetch` | read/preview | Javis tool gateway |
| `memory_search`、`local_search`、`directory_list` | read/preview | Javis tool gateway |
| `browser_navigate`、`image_analyze`、`image_describe`、`image_ocr` | read/preview | Javis tool gateway |
| `doc_update`、`schedule_create`、`browser_interact`、`browser_test` | 只能提出 proposal | Javis approved apply |
| `evidence_check` | 不进入 Agent loop | Javis Verifier |

`doc_update`、`schedule_create` 和浏览器交互不能因为属于通用能力就绕过权限规则；它们
仍按 `preview -> confirmed_write` 拆成 proposal 和 Javis apply 两步。

Commander 的计划、修复和最终综合继续直接使用 Javis `CommanderTool`，不进入 LangChain
Agent 循环。

### 6.3 路由不变量

- 一个 `stepId + attempt` 只能产生一条确定的 backend routing observation。
- 路由记录必须包含 backend、agent kind、capability、permission level、provider/model 和原因。
- 不允许根据某次工具失败静默切换后端；需要切换时由 Commander 生成新的恢复步骤。
- direct、LangChain、OpenCode 以及临时 `javis_specialized` 路径必须生成相同格式的
  `StepResult`；只有最终规范化结果可以发布 ArtifactEnvelope。

### 6.4 路由请求和观测

路由器必须接收并持久化同一个 typed request：

```ts
interface AgentRouteRequest {
  taskId: string;
  workflowRunId: string;
  stepId: string;
  attempt: number;
  executionMode: "direct_response" | "direct_tool_call" | "react" | "desktop_input";
  primaryCapability?: string;
  agentKind: string;
  permissionLevel: "read" | "preview" | "confirmed_write" | "dangerous";
  provider?: string;
  model?: string;
  contextWindowTokens?: number;
}
```

`primaryCapability` 对 `react` 必填；provider/model 对会发生模型调用的步骤必填。纯确定性
direct tool 不得为了满足 schema 伪造 provider/model。

`AgentRuntimeRoutingObservation` 至少保存上述身份字段、最终 backend、选择原因和
`fallbackReason`。`runId` 不得再复用 routing observation id；运行身份必须区分
`workflowRunId`、`agentRunId`、`stepId`、`attempt` 和 `observationId`。

## 7. 统一步骤与结果协议

### 7.1 步骤输入

```ts
interface StepContract {
  instruction: string;
  hardConstraints: string[];
  preferences: string[];
  acceptanceCriteria: string[];
  outputSchemaRef?: string;
  primaryCapability?: string;
  artifactObligation: "required" | "optional" | "none";
  completionPolicy: {
    partial: "publish_and_continue" | "retain_and_replan" | "stop";
    blocked: "wait" | "replan";
    needsClarification: "ask_user" | "replan";
  };
}
```

当用户目标包含副作用时，Commander 必须生成两个独立 contract：proposal step 的接受标准
只描述“提案完整且可审批”，apply step 的接受标准才描述“写入完成”。不得让 proposal step
以 `completed` 冒充用户要求的最终写入已经完成。

迁移期缺少 `completionPolicy` 的旧计划使用保守默认值：`partial = stop`、`blocked = replan`、
`needsClarification = replan`；只有 Commander 明确生成 `ask_user` 或 `publish_and_continue`
时才改变默认行为。

缺少 `artifactObligation` 的旧步骤按是否声明 `outputContextKey` 推导：有 key 为 `required`，
否则为 `none`。provenance 校验所有实际发布的制品；只有已经满足依赖且 obligation 为
`required` 的步骤，缺少制品才构成输出失败。

运行时请求还必须携带：

- `taskId`、`workflowRunId`、`agentRunId`、`stepId`、attempt；
- `agentKind`、capability、permission level；
- `inputContextKeys` 对应的 ArtifactEnvelope payload 与来源摘要；
- 当前 provider/model profile 和实际 context window；
- AbortSignal、模型/工具超时和最大循环次数；
- 此步骤允许使用的工具描述符。

### 7.2 步骤结果

所有后端在 Javis adapter 边界返回：

```ts
interface StepResult<T = unknown> {
  status:
    | "completed"
    | "partial"
    | "blocked"
    | "needs_clarification"
    | "failed";
  output?: T;
  evidence: StepEvidence[];
  assumptions: string[];
  unresolvedQuestions: string[];
  unmetCriteria?: string[];
  requestedContextKeys?: string[];
  requestedAgentKind?: string;
  blockedReason?: {
    kind: "approval" | "environment" | "policy" | "external";
    resumable: boolean;
    retryable: boolean;
    detail: string;
    wakeCondition?: {
      event: "approval_resolved" | "context_available" | "retry_at" | "external_event";
      ref: string;
      retryAt?: string;
    };
  };
  error?: {
    code: string;
    message: string;
    phase: "model" | "tool" | "protocol" | "verification" | "runtime";
    retryable: boolean;
  };
}
```

状态语义：

| 状态 | 语义 | 调度行为 |
| --- | --- | --- |
| `completed` | 接受标准全部满足，或该步骤明确声明无输出 | 发布唯一最终制品，继续下游 |
| `partial` | 有可执行产出且 `unmetCriteria` 非空 | 按 `completionPolicy.partial` 继续、重规划或停止；不得无条件当完成 |
| `blocked` | 权限、环境或外部条件阻塞，且有 `blockedReason` | 按 policy 等待或重规划；不发布成功制品 |
| `needs_clarification` | 缺少用户或上游上下文，且给出 questions/keys | 按 policy ask-user 或重规划；不发布成功制品 |
| `failed` | 模型、工具、协议或验证失败，且有结构化 `error` | 按 retry policy 重试、重规划或失败终止 |

结果不变量：

- `completed` 必须通过 `outputSchemaRef` 和 `acceptanceCriteria` 校验；`partial` 必须
  说明未满足项；`blocked` 必须说明阻塞类型；`failed` 必须保留主错误。
- `partial` 只有在 policy 明确为 `publish_and_continue` 时才能满足下游依赖；其他情况
 只能作为 checkpoint/重规划输入。
- `blocked`、`needs_clarification` 和 `failed` 不得把临时 output 写成成功 ArtifactEnvelope。
- `blockedReason.kind = "approval"` 只对 Javis `direct` / `javis_specialized` 步骤合法；
  LangChain/OpenCode 遇到写需求必须结束为 proposal `completed` 或 policy `blocked`，不能在
  原 Agent run 内等待审批。
- `evidence` 只保存有限大小、脱敏后的引用或制品 ID；原始 stdout、响应正文和大对象放在
  受控 Artifact 存储，不直接塞入事件或 `StepResult`。provider 原始响应正文永不持久化，
  只保留 response shape、长度和 hash；工具 stdout 在没有受控存储时只能截断并脱敏。

backend runner 内部先生成 candidate result；Javis `AgentRuntime` adapter 持有注入的 schema
validator 和 acceptance evaluator，并在 resolve `AgentRunResult` 前规范化为最终 `stepResult`。
workflow executor 只调度、持久化和发布，不得二次改变业务状态。每个 criterion 产生 `pass`、
`fail` 或 `unverifiable` 及 evidence refs；全部 pass 才能是 `completed`，有可用产出但存在
fail/unverifiable 才能是 `partial`，schema/protocol 无法判断时是 `failed`。

调度器按以下持久化转换执行：

| StepResult | scheduler state | checkpoint/wake 行为 |
| --- | --- | --- |
| `completed` | `completed` | 发布制品并解锁下游 |
| `partial` + `publish_and_continue` | `completed`（标记 partial） | 发布 partial 制品并解锁下游 |
| `partial` + `retain_and_replan` | `waiting` | 只保存为 replan evidence，不发布到下游，等待新计划 |
| `partial` + `stop` | `failed`（业务结论 partial） | 保存结果并结束任务 |
| `blocked` + `wait` | `waiting` | 必须有 `wakeCondition`；外部事件/审批由 Javis 唤醒 |
| `blocked` + `replan` | `waiting` | Commander 生成恢复步骤 |
| `needs_clarification` + `ask_user` | `waiting` | 保存问题和 requested keys，用户或上游输入唤醒 |
| `needs_clarification` + `replan` | `waiting` | Commander 生成补上下文步骤 |
| `failed` | `failed` 或 `waiting` | 依据 retryable、次数和 replan policy 决定 |

`blockedReason` 在 `wait` 时必须包含可验证的 `wakeCondition`（事件类型、引用和可选
`retryAt`）；`resumable = false` 时只能 `replan` 或终止，不能 wait。

取消是运行传输终态，不应伪装为业务 `StepResult`。目标 `AgentRunResult` 应区分：

```ts
type AgentRunResult =
  | { termination: "returned"; stepResult: StepResult; usage?: AgentTokenUsage; metrics: AgentRuntimeRunMetrics }
  | { termination: "cancelled"; reason: string; usage?: AgentTokenUsage; metrics: AgentRuntimeRunMetrics };
```

`AgentRunResult` 是传输终态，业务状态只存在于 `stepResult.status`。adapter 必须直接返回
五态 `StepResult`，不得再由 workflow executor 压缩为 `completed/failed/request_input` 三态。
迁移期可以保留旧字段，但只能在 adapter 边界转换一次。

## 8. 通用 AgentRuntime 接口

`packages/core` 只定义 Javis 自有类型，不暴露 LangChain 或 OpenCode 类型：

```text
AgentRuntime
  run(definition, request) -> AgentRunHandle

AgentRunHandle
  events: AsyncIterable<AgentEvent>
  result: Promise<AgentRunResult>
  cancel(): void
```

Agent runtime 和 workflow execution backend 分开建模：

```ts
type AgentRuntimeBackend = "legacy" | "langchain" | "opencode";
type WorkflowExecutionBackend =
  | "direct"
  | AgentRuntimeBackend
  | "javis_specialized"
  | "unavailable";
```

统一事件至少包括：

- run started/completed/failed/cancelled；
- model started/delta/completed；
- tool requested/started/completed/failed；
- context requested；
- policy blocked；
- usage updated；
- backend diagnostic。

UI approval 是 Javis direct apply 的工作流事件，不是第三方 `AgentRuntime` 事件。

事件中不得包含 API key、完整认证头、未脱敏响应正文或无限制 stdout/stderr。
每个模型和工具调用事件必须携带稳定的 `callId`、`stepId` 和 `attempt`，以支持重放去重。

`outputSchemaRef` 必须由 Javis schema registry 解析为实际 schema。Javis runtime adapter 负责
结构校验和 acceptance evaluation；workflow executor 只消费最终 `StepResult`。任何后端都不能
只把 schema ref 或接受标准拼进自然语言提示词后自行宣称完成。

## 9. LangChain 后端要求

1. 继续使用 `langchain/browser` 和 Javis `AgentModelGateway`。
2. 工具必须由 Javis Tool Gateway 提供，禁止绕开 gateway 直接调用桌面实现。
3. provider 必须支持原生 Tool Call；不得退回文本 JSON 模拟 tool call。
4. `request_input` 映射为 `needs_clarification`。
5. provider structured output 可用时使用 provider strategy，否则使用受控 tool strategy。
6. 第一阶段保持 `parallelToolCalls: false`，直到有序多工具制品语义完成设计。
7. 不启用独立 LangGraph checkpoint；任务恢复继续以 Javis checkpoint 为准。
8. 每次工具调用只产生 observation/evidence，不直接写步骤的最终 output context key；只有
   adapter 返回的最终 `StepResult` 可以由 workflow executor 发布制品。

## 10. OpenCode 后端要求

### 10.1 接入形态

OpenCode 必须实现独立的 `OpenCodeAgentRuntime` adapter。目标接入应使用 OpenCode 提供的
结构化、可取消、可持续读取事件的会话接口。OpenCode 会话传输和 Javis 工具桥是两个独立
边界：前者可在 ACP、server 或 SDK 中通过 POC 选择，后者必须始终由 Javis Tool Gateway
控制。POC 必须验证：

- 创建和关闭单步骤会话；
- 流式文本、工具调用、用量和最终状态；
- AbortSignal 取消和子进程回收；
- 通过受控桥接调用 Javis 工具；
- provider/model 和会话级配置隔离。

runtime 不在会话内等待写审批。遇到缺少上下文时返回 `needs_clarification` 并结束；遇到
权限或环境阻塞时返回 `blocked` 并结束。Javis 根据 checkpoint 创建新 attempt 或独立 direct
apply step。Phase 1 不承诺跨应用重启恢复 OpenCode 内部会话；中断后只能重试无副作用的
read/preview step。

现有一次性 `opencode run --format json` 仅作为 proposal 兼容路径，不是目标通用 adapter。

### 10.2 工具边界

- 默认拒绝 OpenCode 内建 `edit`、宽泛 `bash` 和不受控网络工具。
- 所有 OpenCode 工具调用必须通过窄 bridge 暴露本步骤允许的 Javis 工具；不得将
  OpenCode 内建工具作为旁路。ACP/session transport 与 MCP/tool bridge 不得混为同一授权层。
- bridge 必须把 canonical tool name、tool-call id、task/run/step、agent kind 原样带回 Javis。
- Javis 为每个 step attempt 签发短期 capability token；token 绑定 task/run/step/attempt、
  tool allowlist、permission、工作区和过期时间。Gateway 在每次调用时重新判权，并按
  tool-call id 拒绝重放。
- 只读仓库访问必须受工作区 containment 和沙箱约束。
- patch 只能作为 preview/proposal 返回；应用 patch 仍走 Javis confirmed-write。
- 测试、构建和 Git 动作必须使用现有 shell/git/sandbox policy，不继承 OpenCode 的宽权限。
- sandbox、bridge 或身份绑定不可用时必须 fail closed。取消、超时或结束后必须撤销 token、
  关闭会话并回收子进程。

### 10.3 输出转换

OpenCode adapter 必须把其事件和最终状态转换成统一协议：

- 成功且满足 acceptance criteria -> `completed`；
- 有 patch、诊断或测试结果但未全部完成 -> `partial`；
- 缺少运行环境、外部条件或工具被策略阻止 -> `blocked`；需要写审批的 proposal 已完成时，
  当前 Agent 步骤返回 `completed`，由后续 Javis apply 步骤负责等待审批；
- 缺少用户决策或上游制品 -> `needs_clarification`；
- provider 空响应、协议错误、进程异常、工具失败且不可恢复 -> `failed`。

不能仅凭 OpenCode 进程退出码 0 判定步骤完成；必须验证结构化结果、证据和接受标准。

### 10.4 OpenCode Phase 1 工具面

Phase 1 只开放仓库只读搜索、调用链追踪、受限文件读取和 patch proposal。`build_fix`、
`test_run`、`refactor` 在以下条件全部完成前不得宣称可执行：

OpenCode runtime 不得获准调用现有 `code.proposeEdit`，因为该 canonical tool 当前会再次启动
`opencode run`，形成 OpenCode 嵌套 OpenCode。runtime 的 patch proposal 必须直接来自
`OpenCodeAgentRuntime` 最终 `StepResult`。现有 one-shot proposal tool 只属于 legacy 兼容路径，
在 Phase 2 退役或重命名，并从 OpenCode bridge allowlist 永久排除。

1. 存在 canonical Javis tool descriptor，而不是 OpenCode 内建 bash/edit。
2. 命令被分类为只读或进入独立审批步骤，并由 Rust/sandbox 最终校验。
3. 工具输出能作为有限大小的 evidence/artifact 被持久化。
4. 取消、超时、重启和重复事件不会重复执行副作用。

## 11. 权限与安全

权限仍使用：

```text
read -> preview -> confirmed_write -> dangerous
```

共同规则：

1. `read` 可以在 agent runtime 内执行，但仍需 owner、allowlist、schema 和范围校验。
2. `preview` 只能产生计划、dry-run、diff、截图或 proposal，不得产生持久副作用。
3. `confirmed_write` 必须显示 UI 审批卡并绑定 task、tool、preview hash 和作用域。
4. Rust 在执行前重新校验绑定、路径、当前状态和一次性消费。
5. `dangerous` 默认拒绝，除非已有独立设计和原生安全实现。
6. LangChain 或 OpenCode 的权限配置只是第一道约束，不能替代 Rust 最终强制层。

## 12. 用量、模型与上下文窗口

用量是与输出并列的数据流，不能只在成功返回时记录：

- 续问使用历史任务的 `tokenUsage` 作为初始累计值，不得在 planning 时归零。
- 每次模型调用一旦获得 usage，无论最终成功、空响应、工具失败或重规划，都必须累加。
- LangChain 从 `AgentModelGateway` usage 事件累计。
- OpenCode 从结构化事件或最终会话统计累计；缺少 usage 时明确标记 unavailable，不填 0 冒充。
- `model`、`provider`、`contextWindowTokens` 必须来自本次实际调用的 profile。
- 不同 Agent、provider 或 model 的上下文窗口不能共享缓存值。
- checkpoint、TaskSnapshot 和 task history 必须保存同一份累计结果。

所有后端先归一化为幂等的调用级观测：

```ts
interface UsageObservation {
  callId: string;
  revision: number;
  final: boolean;
  taskId: string;
  workflowRunId: string;
  stepId: string;
  attempt: number;
  backend: "direct" | "legacy" | "langchain" | "opencode" | "javis_specialized";
  provider: string;
  model: string;
  contextWindowTokens?: number;
  availability: "reported" | "unavailable";
  semantics: "cumulative_for_call";
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}
```

- 每个模型调用只有一条 canonical record。stream usage、失败前的最后 usage 和 final usage 以
  相同 `callId`、单调递增 `revision` upsert；任务总量始终对每个 call 的最新记录求和。
- provider 给 delta 时，adapter 先在 call record 内累计；provider 给累计快照时直接替换较旧
  revision。final usage 是校正/封口，不是新的增量，因此不会重复计数。
- `unavailable` 是未知值，不得转换成 0。
- Commander plan/replan/synthesis 和其他 Javis direct 模型调用同样必须产生 observation；使用
  稳定虚拟 step ID（如 `commander.plan`）和真实 attempt，backend 记录为 `direct`。
- 持久化 schema 必须同时保存调用观测和按 backend/provider/model 分桶的 summary；旧的单一
  `contextWindowTokens` 只能作为 UI 兼容摘要，不能作为下一次调用的模型窗口来源。
- 续问从历史 task usage 原子恢复后再进入 planning，不能用新 run 的空累计覆盖任务累计。
- backend 枚举、routing metrics、checkpoint、task history 和 sanitizer 必须在接入 OpenCode
  前完成 schema version 升级和旧记录迁移。

回归必须覆盖：

1. 同一任务续问不清零；
2. 失败调用不漏记；
3. 实际上下文窗口不串模型。

## 13. 错误模型与诊断优先级

### 13.1 主错误优先

步骤执行产生的原始错误是主错误。任务错误状态必须使用一次赋值的 `primaryFailure` 和
追加式 `diagnostics`：

```ts
interface WorkflowFailureState {
  rootFailures: Array<{
    code: string;
    message: string;
    phase: string;
    stepId?: string;
    attempt?: number;
    backend?: WorkflowExecutionBackend;
    callId?: string;
    priority: number;
    planOrder: number;
  }>;
  primaryFailure: {
    code: string;
    message: string;
    phase: string;
    stepId?: string;
    attempt?: number;
    backend?: WorkflowExecutionBackend;
    callId?: string;
  };
  diagnostics: Array<{
    source:
      | "approval"
      | "handoff"
      | "verifier"
      | "provenance"
      | "persistence"
      | "runtime"
      | "provider"
      | "tool"
      | "backend";
    code: string;
    message: string;
  }>;
}
```

并行步骤失败时先追加 `rootFailures`，再按固定 failure priority、DAG plan order、stepId 和
attempt 选择 `primaryFailure`；不能按事件到达顺序决定主错误。`primaryFailure` 选定后不可被
verifier、provenance、handoff 或持久化错误替换；这些检查只能追加 diagnostic。

优先级：

```text
step/runtime/provider/tool root failure
  > approval or handoff failure that directly caused the step failure
  > verifier failure
  > provenance secondary diagnostic
  > persistence/telemetry diagnostic
```

失败或 abandoned 的步骤不应再因缺少“成功 ArtifactEnvelope”而产生一个覆盖根因的
provenance 顶层错误。
隐式 provenance verifier 必须接收 `publishedStepIds`、`artifactObligation` 和执行状态：
只验证实际发布的制品；对 blocked、needs_clarification、failed、未发布的 partial 以及
`artifactObligation = none` 的步骤不要求成功 ArtifactEnvelope。已经选出的 `primaryFailure`
仍是任务结论，verifier 只能补充诊断。

### 13.2 DeepSeek 空响应

DeepSeek 或其他 provider 返回空 final content 时必须：

- 分类为明确的 provider response failure；
- 保留 provider、model、endpoint host、finish reason 和安全的 response shape；
- response shape 至少记录 choices 数量、message keys、content 类型/长度、
  `reasoning_content` 是否存在、tool calls 数量和 usage 是否存在；
- 不记录 API key 或完整响应正文；
- 如果执行一次受控重试，两次调用的 usage 都必须累计；
- 最终失败信息必须保持为空响应根因，不能被 provenance verifier 覆盖。

空响应诊断必须作为脱敏 `backend diagnostic` 绑定到对应 `callId` 和 `primaryFailure`，而不是
拼进 provenance 错误字符串。受控重试必须产生新的 call ID；两次调用分别计量和去重。

### 13.3 OpenCode 错误

OpenCode 错误至少区分：

- runtime unavailable；
- session/configuration failure；
- provider/model failure；
- empty final result；
- tool bridge failure；
- permission blocked；
- process exit/timeout/cancelled；
- invalid structured result。

stderr 和事件摘要必须限长、脱敏，并保留阶段信息，避免只显示“OpenCode failed”。

## 14. 制品、验证与恢复

- 每个最终可交接输出必须写入唯一的 ArtifactEnvelope，绑定 task/run/workflow/step/attempt/
  agent/agentRun/tool/executionBackend/routingObservation。
- Agent tool observation、流式片段和中间诊断只写 observation/evidence，不拥有步骤的最终
  output context key；最终 owner 固定为规范化 adapter（`agent.langchain`、`agent.opencode`
  或明确的 Javis direct tool）。
- Javis apply 制品必须记录 `derivedFromArtifactId`、`derivedFromContentHash` 和
  `approvalBindingId`，形成 proposal -> approved apply 的可追踪链。
- `StepResult.evidence` 引用制品、命令、来源、日志或截图，不复制无限制原始内容。
- 下游步骤运行前继续执行 input context schema 校验。
- `partial` 只有在 `completionPolicy.partial = publish_and_continue` 时才能进入下游
  SharedContext；其他 partial 只作为重规划输入，并保留未满足项和未决问题。
- 失败步骤的临时输出不得伪装成成功制品；有价值的失败证据只保存在 StepResult/诊断中。
- Javis checkpoint 是唯一任务恢复真相源。后端内部会话标识不能作为跨重启恢复凭据；可以
  作为脱敏诊断引用保存。
- 恢复时不得重跑已完成步骤、重复工具副作用或复用已消费审批。read/preview runtime 中断
  后只能以新 attempt 重试；apply 步骤必须依赖新的审批绑定。
- checkpoint 必须保存 `waitingStepId`、`waitingAttempt`、`waitingReason`、完整
  `blockedReason`/wake condition、clarification questions/requested keys、partial publication
  policy、failed/root step IDs、`primaryFailure` 和 usage observation 去重状态，不保存 API key
  或长期 session token。

## 15. 实施阶段

### Phase 0：冻结协议并修复共同缺陷

- 将 `opencode` 加入 backend 类型、路由指标和持久化白名单。
- 统一 direct、LangChain、OpenCode 和 `javis_specialized` adapter 输出到完整 `StepResult`，
  并为五态结果实现调度矩阵和 schema/acceptance evaluator。
- 冻结 `executionMode -> primaryCapability -> permission -> backend` 路由契约，补齐
  observation identity 和旧 checkpoint/history 的 schema migration。
- 删除 Rust `code.proposeEdit` 内部的 credentialed DeepSeek/custom HTTP fallback；所有 backend
  必须在 step attempt 启动前由 router 唯一选择，工具内部不得再切换模型执行内核。
- 修复续问用量清零、失败调用漏记和上下文窗口串模型。
- 修复 DeepSeek 空响应诊断和受控重试。
- 修复 provenance 覆盖原始错误。

验收：三条用量回归、空响应根因和 provenance 错误优先级测试全部通过。

### Phase 1：OpenCode runtime POC

- 在 `code_search` 或 `code_explore` 只读步骤接入 `OpenCodeAgentRuntime`。
- 验证会话、事件、取消、用量、工具 bridge 和进程清理。
- 禁用 OpenCode 直接写入；只允许工作区只读工具和 patch proposal。
- 与当前 Code Agent 同输入对比结果、事件、用量和错误。

验收：真实仓库只读步骤通过，取消后无遗留进程，工作区无修改。

### Phase 2：代码专项迁移

- 迁移 `code_propose`；只有受控 command/sandbox tool 验收后才迁移 `build_fix`、`test_run`、
  `refactor` 的实际执行。
- proposal 输出统一为 StepResult + ArtifactEnvelope。
- patch apply、Git 和有副作用命令继续走现有 Javis 审批路径。

验收：proposal deny 不改文件；approve 只应用绑定 patch；测试/构建证据可追踪。

### Phase 3：LangChain 通用 Agent 放量

- 按已验证 provider/model profile 扩大通用 `read` / `preview` 路由。
- 完成研究、文件、浏览器、调度、验证 Agent 的真实闭环验收。
- 保持写操作在 Javis 专用路径。

验收：通用产品工作流、流式 Tool Call、request_input、restart/resume 全部通过。

### Phase 4：删除 legacy ReAct

- 静态引用门禁不再出现生产 `runAgentReActLoop`、ReAct decision prompt 和 JSON parser。
- 停止产生 legacy 路由和指标，但保留 legacy backend 枚举、历史 checkpoint/task history 的
  reader 和迁移解析器，确保旧任务可读；迁移开关只对新任务关闭。
- 保留 Javis direct、LangChain、OpenCode 三类正式路径；Computer Use 在迁移完成前必须
  明确标记为 `javis_specialized`，不能隐式保留第三套循环。

验收：完整 `pnpm check`、产品 QA、Computer Use QA、打包重启 QA 和 live provider QA 通过。

## 16. 必须通过的验收矩阵

| 场景 | 预期 backend | 核心断言 |
| --- | --- | --- |
| 微博热搜收集 | LangChain | 工具闭环、来源证据、Verifier 可消费 |
| 文件扫描和分类 | LangChain | schema 正确、无未授权写入 |
| 缺少上游上下文 | LangChain | `needs_clarification`，触发 replan/ask-user |
| 仓库代码检索 | OpenCode | 只读、可取消、事件与用量完整 |
| 代码修改提案 | OpenCode | 只产出 preview/proposal，不直接写盘 |
| 用户拒绝 patch | Javis approval | 文件、Git HEAD、审批状态保持安全 |
| 用户批准 patch | Javis + Rust | 只应用绑定文件和哈希，一次性消费 |
| 构建或测试 proposal | OpenCode | 只返回命令/证据提案，不执行副作用 |
| 构建或测试执行失败 | Javis sandbox | 返回证据和主错误，不被 verifier 覆盖 |
| DeepSeek 空响应 | 任一实际调用方 | 受控重试、两次 usage、保留 response shape 根因 |
| 同任务继续追问 | Javis | 历史用量累计，不归零 |
| 切换 Agent 模型 | Javis | context window 使用实际 profile，不串模型 |
| stream + final 重复 usage | Javis | 同一 call ID 只累计一次 |
| `partial` 默认策略 | Javis scheduler | 未明确允许时不满足下游依赖 |
| runtime 初始化失败 | Javis router | 不跨 LangChain/OpenCode 自动回退 |
| 步骤失败且无制品 | Javis verifier | 保留 primary failure，provenance 仅为诊断 |
| Computer Use | `javis_specialized` 或 LangChain | 路由明确，不伪装成 direct |
| 应用重启恢复 | Javis | 已完成步骤不重放，审批不重复消费 |

## 17. 完成定义

本方案完成必须同时满足：

1. 每个模型驱动步骤能明确回答“为什么路由到这个后端”。
2. 同一步骤不存在双重 Agent 循环或双重工具执行。
3. 两个后端都只通过 Javis 协议向上层暴露结果和事件。
4. OpenCode 已实际执行只读/preview 代码步骤；任何执行型代码动作都有独立 Javis 工具和
   审批边界，不被 HTTP fallback 冒充 OpenCode。
5. LangChain 已通过通用产品工作流的 live provider 和 restart 验收。
6. 所有写操作继续通过 UI 审批和 Rust 原生强制层。
7. 用量、错误、制品来源和 checkpoint 在成功、失败、续问、重规划和恢复路径中一致。
8. legacy ReAct 从生产引用中删除，Computer Use 的专用路径被显式迁移或登记。

## 18. 与现有文档的关系

- 本文收敛并更新 `LANGCHAIN_AGENT_RUNTIME_MIGRATION_FEASIBILITY.md` 的最终目标：
  LangChain 不再被定义为所有 Agent 的唯一最终后端，而是通用 Agent 后端。
- 本文保留 `ARCHITECTURE.md` 将 OpenCode 作为可扩展代码 Agent kernel 的方向，但把其作用域
  收紧到代码专项步骤。
- `CORE_CONTRACTS.md` 中 proposal-only OpenCode 是当前安全实现；Phase 2 完成后应更新为
  OpenCode AgentRuntime + Javis approved apply。
- `AGENT_RUNTIME_DURABILITY_PLAN.md` 和 ADR 0001 的 checkpoint、审批及 Rust 写边界保持不变。
- `PI_AGENT_VS_OPENCODE_ANALYSIS.md` 记录的是 proposal-only 阶段决策，不再代表目标双内核架构。

## 19. 代码落点

预计只在现有边界内扩展：

- `packages/core/src/agent-runtime/contracts.ts`
- `packages/core/src/step-protocol.ts`
- `packages/core/src/workflow-executor.ts`
- `apps/desktop/src/agent-runtime/create-agent-runtime.ts`
- `apps/desktop/src/agent-runtime/langchain/`
- `apps/desktop/src/agent-runtime/opencode/`（新增）
- `apps/desktop/src-tauri/src/code.rs` 或独立 OpenCode runtime module
- RuntimeEvent、WorkflowCheckpoint、TaskSnapshot 的 backend/usage/diagnostic 字段

实现时继续遵守包边界：Core 只含纯类型和调度逻辑；ModelProvider、Tauri invoke、OpenCode
进程和本地 I/O 留在 Desktop/Rust。
