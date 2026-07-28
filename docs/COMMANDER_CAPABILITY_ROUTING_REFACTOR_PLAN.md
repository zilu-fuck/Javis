# Commander 能力路由改造方案

## 1. 结论

目标架构为：

```text
用户输入 + 可信运行时上下文
  -> 结构化意图识别
  -> 声明式能力目录
  -> 确定性约束求解
  -> 模型生成 DAG
  -> 编译器按已解析约束验收
  -> 执行器
```

这不是纯模型路由，也不是继续增加“关键词 -> Agent/Tool”的代码分支。

- 模型只描述用户想完成什么，不选择 Agent 或工具。
- Agent 和工具通过注册元数据声明自己能完成什么。
- 求解器根据实时注册表、权限、资源位置和运行时可用性绑定 Agent/Tool。
- 模型在绑定结果内生成 DAG 的步骤、依赖、上下文交接和成功标准。
- 编译器仍是执行前的强制边界，原生写入审批与路径保护不变。

现有 `commander-route-contract.ts` 保留为迁移期基线和回退，最终从主路径移除。

## 2. 当前问题

Javis 已经有三类注册信息，但它们尚未组成一个完整路由系统：

- `AgentRegistry`：列出 live Agent、允许工具、能力和模型要求。
- `ToolDescriptor`：描述工具所有者、能力、输入、权限和运行时约束。
- `RouteRegistry`：对预设 Workflow 进行评分和选择。

当前任意 Commander 请求的正向路由仍依赖：

- `agent-intent.ts` 中的自然语言正则；
- `commander-route-contract.ts` 中的 Agent/Tool 映射；
- `agent-capability.ts` 中按 Agent kind 写死的 role capability；
- 编译器重新读取 `userGoal` 并推导必需路由。

这带来四个问题：

1. 新增 Agent、工具或表达方式时需要修改 Core 路由代码。
2. 识别、路由、提示词和编译器可能产生不同结论。
3. Workspace 动态 Agent 虽然进入 live registry，却无法自然声明新的语义路由。
4. `createAgentRegistry()` 从静态 `initialToolDescriptors` 推导能力，不能完整反映 feature flag、MCP 或运行时禁用后的有效工具集。

## 3. 边界与非目标

### 本次改造包含

- 一个版本化的结构化意图协议；
- Agent/Tool 的声明式路由元数据；
- 从实时注册信息生成的不可变能力目录；
- 一个纯函数、可重复的约束求解器；
- Planner、Compiler、Repair Loop 的约束接入；
- 旧规则的影子比较、渐进迁移和删除条件。

### 本次改造不包含

- 不替换 DAG Executor。
- 不削弱 UI 或 Rust 的写入审批、路径、哈希和一次性消费保护。
- 不让模型直接输出 `agentKind` 或 `toolName` 作为意图识别结果。
- 不把现有 `RouteRegistry` 强行改成通用能力路由器；它继续负责显式 Workflow 路由。
- 不在第一阶段删除现有正则，必须先完成影子验证。

## 4. 目标数据模型

### 4.1 结构化意图

结构化意图描述任务语义，不包含执行者名称。

`IntentAction`、`IntentResource`、`IntentConcern`、routing effect、artifact 和 capability tag 等共享词表放在 `packages/tools/src/routing-metadata.ts`。Core 直接导入并在迁移期兼容 re-export，ToolDescriptor 不使用无约束的 `string[]`，也不会形成 Tools -> Core 反向依赖。

```ts
export type IntentAction =
  | "inspect"
  | "retrieve"
  | "analyze"
  | "transform"
  | "verify"
  | "modify"
  | "persist"
  | "execute"
  | "interact"
  | "schedule"
  | "recall"
  | "clarify";

export type IntentResource =
  | "workspace_code"
  | "workspace_file"
  | "local_document"
  | "local_machine"
  | "public_web"
  | "current_page"
  | "desktop_ui"
  | "image"
  | "task_memory"
  | "git"
  | "scheduler";

export type IntentConcern =
  | "architecture"
  | "language_quality"
  | "security"
  | "build_failure"
  | "tests"
  | "performance"
  | "refactor"
  | "documentation"
  | "trends";

export type ExpectedSideEffect =
  | "read_only"
  | "execute_process"
  | "persist_local"
  | "external_mutation"
  | "ui_input";

export type RoutingEffect =
  | "read"
  | "execute_process"
  | "persist_local"
  | "external_mutation"
  | "ui_input";

export type SensitiveEffect = Exclude<ExpectedSideEffect, "read_only">;

export interface EvidenceQuote {
  source: "user_goal" | "clarification_reply";
  /** 由运行时提供的用户消息 id，模型只能从输入列表复制。 */
  sourceMessageId: string;
  /** 必须逐字复制对应用户消息中的连续原文，不做改写或空白归一化。 */
  text: string;
}

export interface SourceEvidenceSpan extends EvidenceQuote {
  /** UTF-16 code-unit offsets, matching JavaScript String#slice. */
  start: number;
  end: number;
}

export interface GoalIntentClause {
  id: string;
  action: IntentAction;
  resource: IntentResource;
  concern?: IntentConcern;
  subject?: string;
  targetRef?: {
    source: "user_text" | "selected_workspace" | "attachment" | "current_page" | "task_memory";
    value?: string;
  };
  expectedArtifact?: string;
  sideEffect: ExpectedSideEffect;
  evidenceQuotes: EvidenceQuote[];
  confidence: number;
}

export interface IntentOrderingHint {
  beforeClauseId: string;
  afterClauseId: string;
  evidenceQuotes?: EvidenceQuote[];
}

export interface StructuredGoalIntentV1 {
  schemaVersion: "1";
  clauses: GoalIntentClause[];
  /** 非权威提示，只用于交叉验证；Solver 不以此建立硬依赖。 */
  orderingHints?: IntentOrderingHint[];
  unresolvedSlots: Array<{
    name: "target" | "workspace" | "attachment" | "url" | "output_path";
    reason: string;
  }>;
}

export interface TrustedRoutingContext {
  selectedWorkspacePath?: string;
  attachmentIds: string[];
  currentPageUrl?: string;
  hasResolvedTarget: boolean;
  requestedAgentKind?: string;
}

export interface LocalEffectAuthorization {
  allowedEffects: SensitiveEffect[];
  deniedEffects: SensitiveEffect[];
  allowEvidenceByEffect: Partial<Record<SensitiveEffect, SourceEvidenceSpan[]>>;
  denyEvidenceByEffect: Partial<Record<SensitiveEffect, SourceEvidenceSpan[]>>;
  readOnly: boolean;
  forbidDesktopInteraction: boolean;
  requestedOutputPath?: string;
}

export interface ValidatedGoalIntentV1 {
  schemaVersion: "1";
  clauses: Array<Omit<GoalIntentClause, "evidenceQuotes"> & {
    evidenceSpans: SourceEvidenceSpan[];
  }>;
  orderingHints: Array<Omit<IntentOrderingHint, "evidenceQuotes"> & {
    evidenceSpans: SourceEvidenceSpan[];
  }>;
  unresolvedSlots: StructuredGoalIntentV1["unresolvedSlots"];
  trustedContext: TrustedRoutingContext;
  effectAuthorization: LocalEffectAuthorization;
}
```

约束：

- 意图 Schema 不提供 `agentKind`、`toolName` 字段。
- 模型只复制运行时提供的 `sourceMessageId` 和逐字 `EvidenceQuote.text`，不生成不可靠的数值 offset。Core 使用精确字符串反向索引，在对应用户消息中生成 `SourceEvidenceSpan`；未知 message id、source 类型不符、空 quote 或无法定位的 quote 使分类结果无效。
- 同一 quote 在一条消息中出现多次时，Core 保留全部合法位置，不要求模型猜测 occurrence；evidence span 不承担敏感副作用授权职责。
- clause 不要求模型声明执行依赖。`orderingHints` 只是可选语义提示；Core 验证 clause id 和无环性后记录诊断，真正的 obligation dependency 由 Solver 根据策略、artifact 和读写阶段确定。
- selected workspace、附件、当前页面和显式 Agent 选择放在 `TrustedRoutingContext`，由运行时或严格的本地原文解析产生，不属于模型输出。
- 低置信度不是自由猜测的理由；缺少关键目标时进入 `unresolvedSlots`。
- `StructuredGoalIntentV1` 是未授权提案；Solver、Planner 和 Compiler 只能接收 `ValidatedGoalIntentV1`。
- 本地拒绝项取并集并优先于所有允许项；敏感 effect 只有出现在 `allowedEffects` 且不在 `deniedEffects` 时才能进入 obligation。
- `readOnly: true` 等价于拒绝全部 SensitiveEffect；`forbidDesktopInteraction: true` 至少拒绝 `ui_input`，且不能被 Workflow 或 Agent profile 覆盖。
- 模型可以建议或遗漏 effect，但不能增加授权。本地扫描只有在用户原文存在明确证据且 action/resource 一致时才可补齐敏感 effect。
- `execute_process`、`persist_local`、`external_mutation`、`ui_input` 分开授权。资源类型负责区分文件、仓库、应用配置、网页和桌面，避免把测试进程误判成用户要求持久化文件。

### 4.2 路由 Artifact

`RoutingArtifact` 是路由期对现有 `SharedTaskContext` / `ArtifactEnvelope` 契约的引用，不引入第二套运行时存储：

```ts
export type RoutingArtifactType =
  | "workspace_inventory"
  | "repository_evidence"
  | "research_sources"
  | "ui_evidence"
  | "file_scan_results"
  | "diff_preview"
  | "verification_result";

export interface RoutingArtifact {
  type: RoutingArtifactType;
  /** 对应 CommanderDagStep.outputContextKey / inputContextKeys。 */
  contextKey: string;
  schemaVersion: number;
  /** 对应 ArtifactEnvelope.outputSchemaRef。 */
  outputSchemaRef?: string;
  sensitivity: "public" | "workspace" | "secret";
}
```

对齐规则：

- `type` 写入 `ArtifactEnvelope.type`，`contextKey` 必须与 DAG producer/consumer 使用的 SharedContext key 完全一致。
- Core 提供受信任映射：`workspace_inventory -> projectInspection`、`repository_evidence -> repoEvidence`、`research_sources -> researchSources`、`ui_evidence -> uiEvidence`、`file_scan_results -> fileScanResults`、`diff_preview -> diffPreview`、`verification_result -> verificationResult | verifierCheck`。Tool metadata 只能引用映射允许的组合。
- planner-visible artifact 必须映射到 `DEFAULT_CONTEXT_KEY_SCHEMAS` 中的已知 key，或提供可由 Core schema registry 解析的 `outputSchemaRef`；路由关键 artifact 不采用“未知 key 默认通过”的兼容行为。
- producer 的 `produces` 与 step 的 `outputContextKey`、`outputSchemaRef`、sensitivity 必须一致；consumer 的 `consumes` 必须由祖先 obligation 生产，且出现在 `inputContextKeys`。
- ToolDescriptor 的 `produces` 是可选产物目录；一次 obligation binding 必须选定至多一个，与现有单 `outputContextKey` step protocol 对齐。多产物流程拆成多个 obligation，不在首版扩展 Executor 协议。
- Compiler 静态校验 producer、consumer、schema 和 DAG 祖先关系；Executor 继续由 `writeStepArtifactOutput()` 创建 envelope，并在消费前执行现有 schema 校验。
- 首版使用上述有限类型；新增类型必须同时增加 SharedContext schema、producer/consumer contract test 和 trace redaction 规则。

### 4.3 Tool 路由元数据

在 `ToolDescriptor` 上增加类型化的 `routing` 字段。该类型放在 `packages/tools`，避免 Core/Tools 反向依赖。

```ts
export interface RoutingSemanticMatch {
  actions: IntentAction[];
  resources: IntentResource[];
  concerns?: IntentConcern[];
}

export interface ToolRoutingMetadata {
  visibility: "primary" | "supporting" | "internal";
  internalReason?: string;
  matches: RoutingSemanticMatch[];
  effects: RoutingEffect[];
  produces: RoutingArtifact[];
  consumes?: RoutingArtifact[];
  executionModes: Array<"direct_tool_call" | "react">;
  deterministicEvidence?: boolean;
}
```

语义：

- `primary` 可以独立满足一个意图 clause。
- `supporting` 只能补充已绑定的阶段，不能因为自己匹配宽泛词义而触发路由。
- `internal` 不暴露给 Planner，并且必须提供非空 `internalReason`；其 `matches`、effects 和 artifact 匹配字段应为空。
- `permissionLevel`、`requiredPlanIntent`、`inputSchema` 继续保留为安全和执行真相；`routing` 不能覆盖它们。
- 所有 planner-visible 工具最终必须有路由元数据，或者有明确的 `internal` 原因。
- 每个 `matches` 项是同一工具可完成的原子语义组合。Catalog 不得把一个工具的 action 与另一个工具的 resource 拼接成虚构候选。
- 一个 match 项中的 action/resource 组合必须全部真实成立；若工具只支持部分配对，拆成多个 match 项，Catalog 不猜测稀疏矩阵。

### 4.4 Agent 路由声明

`AgentRegistration` 增加声明式 role profile，替代 `ROLE_CAPABILITIES_BY_AGENT_KIND`。

```ts
export interface AgentRoutingProfile {
  plannerRole: "coordinator" | "specialist" | "verifier";
  roleCapabilities: AgentCapabilityTag[];
  matches: Array<RoutingSemanticMatch & {
    provides: AgentCapabilityTag[];
  }>;
}
```

注册校验规则：

- tool-backed capability 必须能由该 Agent 的 `allowedToolNames` 和实时 ToolDescriptor 推导出来。
- role-only capability 必须显式声明，不能按 `agentKind` 隐式补齐。
- 内置 Agent 可以声明受信任的 role capability。
- role/react obligation 必须先命中一个完整的 `AgentRoutingProfile.matches` 项，才检查该项 `provides` 与 `roleCapabilities`；profile match 是候选裁剪条件，不是排序提示，不能只凭宽泛 role capability 进入候选。
- 每个 match 的 `provides` 必须是该 profile `roleCapabilities` 的子集，注册时 fail-fast 校验，避免两套能力声明漂移。
- direct tool obligation 先由单个 `ToolRoutingMetadata.matches` 项独立匹配语义，再用 owner Agent、allowlist 和 live 状态过滤。Agent profile 的 `matches` 只能进一步收窄，不能替工具补齐缺失的 action/resource/effect。
- 首版不在磁盘 `WorkspaceAgentDefinition` 中增加 `routingProfile`。Workspace 动态 Agent 的 profile 完全由其 allowlisted 工具和有效 ToolDescriptor 合成，只能满足 tool-backed obligation，不能声明 role-only capability 或 concern match。
- Workspace profile 按工具逐项生成候选：一个 obligation 最多绑定一个 primary tool；不得把工具 A 的 action/capability 与工具 B 的 resource/effect 合并。额外工具只能通过独立 `SupportingGrant` 形成后续步骤，首版不求解单步多 primary-tool 组合。
- `workspace-loader.ts` 继续拒绝未知 routing 字段；注册时由 AgentRegistry/Catalog builder 生成受限 profile。以后若允许 Workspace 自定义 role match，必须单独提升 Workspace Definition schema version 并做安全评审，不属于本次迁移。
- Workspace Agent 不能覆盖内置 Agent、提高权限或声明没有工具/策略支撑的写能力。
- `createAgentRegistry()` 必须接收有效 ToolDescriptor snapshot，停止依赖静态 `initialToolDescriptors`。

### 4.5 RoutingCatalog

不新增另一个长期可变注册表。每次规划前，根据当前运行时状态构建不可变快照：

```ts
export interface RoutingCatalog {
  schemaVersion: "1";
  agents: readonly ResolvedAgentProvider[];
  tools: readonly ResolvedToolProvider[];
  policies: readonly RoutingPolicy[];
  fingerprint: string;
}

export function buildRoutingCatalog(input: {
  agentRegistry: AgentRegistry;
  availableTools: readonly ToolDescriptor[];
  supportedApprovalGatedTools: readonly string[];
}): RoutingCatalog;
```

这样 Planner、Compiler 和 Executor 使用的是同一批经过 feature flag、MCP 可用性、Agent allowlist 和审批处理能力过滤后的资源。

## 5. 结构化意图识别

### 5.1 分层识别

1. 运行时上下文提取：确定 selected workspace、附件、当前页面、已解析路径和任务记忆。
2. 本地安全扫描：从用户消息生成候选允许/拒绝证据；只负责授权边界，不选择 Agent。
3. Schema 约束的模型分类：输出 `StructuredGoalIntentV1`。
4. Core 的 `validateAndAuthorizeGoalIntent()` 反向定位 evidence quote，验证资源与本地副作用证据的一致性，将模型提案与本地授权按 deny-first 规则合并，输出 `ValidatedGoalIntentV1`。
5. 关键槽位不明确时生成 clarification obligation，不进入工具规划。

Core 只保存 Schema、Prompt、校验和纯函数。实际 `ModelProvider.complete()` 调用留在 `apps/desktop/src/`，符合现有包边界。

### 5.2 本地副作用授权扫描

本地扫描不能退化成一般路由关键词表。它使用一个小型、版本化、可审计的 `EffectAuthorizationRule` 注册表，只回答“用户是否明确允许或拒绝某类副作用”：

```ts
export interface EffectAuthorizationRule {
  id: string;
  locale: "en" | "zh-CN";
  effect: SensitiveEffect;
  decision: "allow" | "deny";
  /** 有边界的完整语言构式；禁止单个裸名词作为 allow 规则。 */
  patterns: readonly RegExp[];
  compatibleClauses: readonly Array<{
    actions: readonly IntentAction[];
    resources: readonly IntentResource[];
  }>;
}
```

规则和执行顺序：

1. 规则只来自受信任源码，按 `effect + decision + id` 稳定排序；Workspace、ToolDescriptor、Prompt 和模型输出不能注册或覆盖规则。
2. allow pattern 必须匹配完整动作构式和目标，例如“运行测试”“保存到 report.md”“点击提交”；`报告`、`文件`、`测试` 等裸词不能授权副作用。deny pattern 覆盖“不/不要/仅查看/别操作”等否定范围。
3. 扫描器输出命中的逐字 quote 和本地 span。deny 不依赖模型 clause 即可生效；allow 必须再与至少一个已验证 clause 的 action/resource 命中 `compatibleClauses`，否则不进入 `allowedEffects`。
4. 同一 effect 同时命中 allow/deny、否定范围不确定、目标缺失或 action/resource 不一致时，一律不授权；任务确实需要该 effect 时生成 unresolved slot 并澄清。
5. `execute_process`、`persist_local`、`external_mutation`、`ui_input` 使用互相独立的规则组。允许运行测试不能授权写文件，允许保存本地文件不能授权网页提交或桌面点击。
6. 模型仍输出 `sideEffect` 作为语义提案，但它既不能创建 allow evidence，也不能覆盖 deny；专用小模型最多可作为 shadow 诊断，不进入授权决策链。

初始覆盖范围严格限定为四类现有敏感 effect 及其否定构式。每条 allow 规则必须带中英文正例、动词歧义反例、否定反例和跨 effect 反例；新增规则必须对应一个真实运行时需求，不允许为了提高分类召回率加入宽泛词分支。

`detectCommanderPlanIntents()` 在迁移期拆成 `scanLocalEffectAuthorization()` 与 legacy route adapter：前者保留必要的安全规则，后者在 Phase 6 删除。这样正则不会继续承担 Agent/Tool 路由职责。

### 5.3 失败策略

- `legacy`：只使用旧 route contract，不调用分类器。
- `shadow`：新分类器/solver 完整运行并记录比较结果，生产计划仍使用旧 route contract；分类失败不影响执行。
- `enforce`：生产计划使用新 contract。回滚窗口内，provider/timeout/parse 故障可进入 legacy fallback 并记录高优先级 trace；语义低置信度、授权冲突和 unresolved target 不允许 fallback，必须澄清。
- legacy 删除后：没有合法结构化意图时不得生成可执行工具 DAG；返回用户可理解的澄清或 unavailable 结果。
- 进程执行、持久化、外部修改和 UI 输入采用 fail-closed：模型识别不能代替本地显式意图证据。
- L1 闲聊不调用意图模型；只有 L2/L3 工具任务进入该流程。

### 5.4 Provider、超时和取消

- 分类器复用当前规划请求已经解析出的 Commander model profile，调用等价于 `providerFor("commander", false)`，不注入 Agent system prompt，也不单独进行第二次模型路由。
- 分类与随后 Planner 使用同一个不可变 model/profile snapshot，避免设置变更造成一次任务内漂移。
- 分类调用接入现有 task `AbortSignal`、provider timeout、usage observer、敏感字段脱敏和错误分类；分类 timeout 不得大于 Planner timeout。
- 最多一次初始调用和一次仅修复 JSON/Schema 的有界调用；第二次不得改变原始 goal 或本地授权。
- usage 以独立阶段 `intent_classification` 记账，trace 记录 provider/profile id、耗时、token、finish reason 和 fallback 原因，不记录密钥。

### 5.5 成本控制

结构化分类会增加一次串行模型调用，这是主要代价。控制方式：

- 使用短 Prompt、严格 JSON Schema 和较小输出上限；
- 只对工具任务分类；
- 记录分类耗时、token 和失败率，在影子阶段确定正式延迟预算；
- 不把意图识别和 DAG 生成合成一次调用，否则求解器无法在 Planner 前提供约束。

首版不缓存分类结果：正常任务只分类一次，任务内缓存收益不足；跨任务缓存又会因 workspace、附件、当前页面和能力目录变化产生陈旧语义或授权风险。Fingerprint 只用于一致性校验和 trace，影子数据证明存在重复且能定义可靠失效条件后再单独设计缓存。

### 5.6 澄清与重新规划闭环

澄清不是恢复旧 DAG，而是带版本的 continuation：

```ts
export interface ClarificationContinuationV1 {
  schemaVersion: "1";
  continuationId: string;
  taskId: string;
  userMessages: Array<{
    source: "user_goal" | "clarification_reply";
    sourceMessageId: string;
    text: string;
  }>;
  priorIntent: ValidatedGoalIntentV1;
  unresolvedSlots: StructuredGoalIntentV1["unresolvedSlots"];
  priorIntentFingerprint: string;
  priorCatalogFingerprint: string;
  issuedAt: string;
}
```

用户回复后的固定流程：

1. 校验 `taskId`、一次性 `continuationId`、有效期和 reply 的用户消息来源；拒绝跨任务或已消费 continuation。
2. 重新提取 selected workspace、附件、当前页面、显式 Agent 限制等可信上下文。
3. 将历史 `userMessages` 与本轮 reply 作为有唯一 message id 的用户字段，重新运行完整本地副作用扫描；不能沿用旧 `LocalEffectAuthorization`。
4. 重新调用意图分类器。`priorIntent` 与 unresolved slots 只作为非权威上下文帮助消歧，新的 quote 必须按 `sourceMessageId` 在对应 `user_goal` 或 `clarification_reply` 中反向定位。
5. 重新构建实时 RoutingCatalog，并从头求解；旧 intent、catalog、contract fingerprint 和授权全部失效。
6. 只有新结果 `ok: true` 才生成新 DAG 并走完整 Compiler；仍不明确则签发新的 continuation，能力缺失则报告 unavailable。

Continuation 保存在任务状态中，并按现有日志脱敏规则处理；不能把旧 plan step、binding 或 approval 带入新一轮，也不能让 repair loop 代替重新识别。

## 6. 确定性约束求解

### 6.1 输入和输出

```ts
export interface ResolvedRoutingContract {
  schemaVersion: "1";
  intentFingerprint: string;
  catalogFingerprint: string;
  obligations: RouteObligation[];
  supportingGrants: SupportingGrant[];
  warnings: RoutingDiagnostic[];
}

export type RoutingResolutionResult =
  | { ok: true; contract: ResolvedRoutingContract }
  | {
      ok: false;
      unavailable: UnavailableObligation[];
      diagnostics: RoutingDiagnostic[];
      nextAction: "clarify" | "report_unavailable";
    };

export interface RouteObligation {
  id: string;
  intentClauseId: string;
  requiredCapabilitiesAll: AgentCapabilityTag[];
  requiredCapabilitiesAny: AgentCapabilityTag[];
  requiredEffects: RoutingEffect[];
  binding: {
    agentKind: string;
    executionMode: "direct_tool_call" | "react" | "direct_response";
    exactToolName?: string;
    allowedToolNames?: string[];
    primaryCapability: AgentCapabilityTag;
  };
  dependsOn: string[];
  produces?: RoutingArtifact;
  consumes?: RoutingArtifact[];
}

export interface SupportingGrant {
  id: string;
  parentObligationId: string;
  action: IntentAction;
  resource: IntentResource;
  allowedEffects: RoutingEffect[];
  allowedAgentKinds: string[];
  allowedToolNames: string[];
  allowedCapabilities: AgentCapabilityTag[];
  maxSteps: number;
}

export interface WorkflowConstraint {
  workflowId: string;
  workflowVersion?: string;
  steps: Array<{
    id: string;
    agentKind: string;
    requiredCapabilities: AgentCapabilityTag[];
    permissionLevel: PermissionLevel;
    dependsOn: string[];
    expectedArtifact?: RoutingArtifact;
  }>;
}

export function solveRoutingContract(input: {
  intent: ValidatedGoalIntentV1;
  catalog: RoutingCatalog;
  workflowConstraint?: WorkflowConstraint;
}): RoutingResolutionResult;
```

Agent/Tool 名称可以出现在求解结果中，但只能由 RoutingCatalog 产生，不能来自意图模型中的自由文本。

### 6.2 求解步骤

对每个 intent clause：

1. 用声明式语义策略展开必须阶段，例如 project inventory、verification、persistence、final synthesis。
2. 对 role/react obligation，先用完整 `AgentRoutingProfile.matches` 做第一级裁剪，再校验 `provides`、role capability 和 effect；未命中 match 的 Agent 不进入候选。
3. 对 direct tool obligation，以单个 ToolDescriptor 的 `routing.matches` 为原子候选，再检查 owner Agent、allowlist、live 状态、required inputs、permission handler 和执行模式；禁止跨工具合成语义。
4. 应用 `LocalEffectAuthorization` 和其 deny-first 规则，再应用 workspace、attachment、current page 等可信资源约束。
5. 生成完整语义候选集后才应用 `requestedAgentKind`：它只能过滤已有候选，不能补入原本不匹配的 Agent。过滤为空时按缺少目标信息选择 clarify，否则返回 unavailable。
6. 按固定优先级排序并绑定；每个 obligation 首版只绑定一个 primary tool。
7. 没有合法候选时返回 `ok: false` 和 `unavailable`，不得调用 Planner，也不得用 Commander 或 Computer 代替；运行时只能澄清或向用户报告缺少的能力。
8. Solver 根据策略 stage、artifact producer/consumer 和副作用阶段建立 obligation 依赖；模型 `orderingHints` 只用于发现矛盾并产生 warning，不创建或覆盖 dependency edge。
9. 从同一 action/resource 下标记为 `supporting` 的工具生成有限 `SupportingGrant`；模型不能自行扩展候选，也不能把 supporting tool 合并成 primary binding。

所有 Computer Agent step 都必须追溯到 `desktop_ui`、`local_document` 或 `local_machine` resource。`computer.screenshot`、`computer.listWindows` 等只读工具也适用，不能作为 workspace/project obligation 的 supporting step。

### 6.3 固定排序规则

不使用难以解释的浮点权重，采用字典序优先级：

1. 满足全部硬约束；
2. action/resource/concern 精确匹配；
3. 使用更低权限等级；
4. 使用更少的额外能力和更窄的资源范围；
5. 优先 deterministic evidence 工具；
6. 最后按稳定的 Agent kind、Tool name 排序。

`requestedAgentKind` 是排序前的硬过滤器，不在排序表中。用户显式选择不适合当前语义的 Agent 时，系统解释不匹配并澄清或报告 unavailable，绝不把该 Agent 提升成候选。

相同 intent 和 catalog fingerprint 必须得到相同结果，注册顺序变化不能影响结果。

Fingerprint 规范：

- 复用 Core 现有 `computeContentHash()`，算法标识为 `sha256-canonical-json-v1`，输入外包一层 `fingerprintSchemaVersion: "routing-v1"`。
- 构建 hash 前，对 Agent、Tool、Policy、capability、effect 等集合语义数组去重并按稳定 id/name 排序；intent clause、workflow step 和 dependency 等顺序语义数组保持规范化后的顺序。
- legacy Agent alias、路径分隔符和空白在 hash 前规范化。Trusted context 使用 workspace/attachment 的稳定 id；只有求解确实依赖目标路径时才纳入规范化的 workspace-relative path。
- Fingerprint 仅用于 trace 和一致性判断，不是缓存键、授权或安全绑定。Planner/Compiler 必须传递并校验实际不可变 intent/contract 对象，不能只比较 hash。
- 跨阶段比较同时保留当前任务内的 canonical snapshot；hash 相同仍比较 canonical value，避免把碰撞当作相等。
- Trace 默认只持久化 fingerprint 和脱敏摘要，不持久化用于 hash 的完整 canonical context、绝对路径、完整 URL、evidence text 或附件内容。

### 6.4 声明式语义策略

少量跨阶段规则仍然需要保留，但规则只匹配结构化字段，不读取自然语言，也不直接写 Agent 或工具名称。DSL 固定为 selector、有限 stage、capability all/any、artifact、显式 dependency edge 和 deterministic-evidence 标志：

```ts
export interface RoutingPolicy {
  id: string;
  when: RoutingSemanticMatch;
  stages: Array<{
    id: string;
    capabilityAll?: AgentCapabilityTag[];
    capabilityAny?: AgentCapabilityTag[];
    produces?: RoutingArtifact;
    consumes?: RoutingArtifact[];
    deterministicEvidence?: boolean;
  }>;
  edges: Array<{ from: string; to: string }>;
}
```

示例：

```ts
{
  id: "workspace-project-understanding",
  when: {
    actions: ["inspect", "analyze"],
    resources: ["workspace_code"],
    concerns: ["architecture"],
  },
  stages: [
    { id: "inventory", capabilityAny: ["workspace_inspect"], deterministicEvidence: true },
    { id: "verify", capabilityAny: ["evidence_check"] },
    { id: "synthesize", capabilityAny: ["synthesis"] },
  ],
  edges: [
    { from: "inventory", to: "verify" },
    { from: "verify", to: "synthesize" },
  ],
}
```

这些策略负责业务不变量，不负责语言识别。DSL 禁止自定义函数、正则、浮点权重、Agent/Tool 名称、权限覆盖、任意脚本和 Workspace 自定义 policy。新增一个提供已有能力的 Agent/Tool 不需要修改策略；只有新的阶段或安全不变量无法由现有 policy 表达时才能扩展。

策略扩展必须同时满足：一个真实短提示回归场景、一个不应触发的负例、至少一个替代 provider/候选测试，以及 owner 审核；新增 DSL 操作符还必须证明至少有两个独立策略消费者。否则用现有 stage/capability/artifact/edge 组合表达。

### 6.5 RouteRegistry 与 Workflow 约束

`RouteRegistry` 命中不能绕过结构化意图、Catalog 或 Compiler。固定处理顺序为：

1. `routeMessage()` 计算 L1/L2/L3 和可选 custom workflow match。
2. L2/L3 仍生成 `ValidatedGoalIntentV1`。
3. 命中的 `WorkbenchWorkflow` 被转换成 `WorkflowConstraint`：包含 workflow id/version、固定参与 Agent、每个 step 的能力、依赖、permission 和预期 artifact。
4. Solver 使用 RoutingCatalog 验证 workflow 中的 Agent/Tool 当前可用，再将 workflow step 转成 obligation。
5. 本地 effect authorization 和用户禁止约束优先于 WorkflowConstraint；Workflow 不能降低权限或扩大副作用。
6. Workflow obligation 与一般意图 obligation 去重后生成同一个 routing contract，并由同一个 Compiler 验收。
7. Workflow 所需能力不可用时返回明确 `unavailable`；不得静默回退到自由 DAG 或 Commander-only。

优先级为：本地安全拒绝 > 可信用户显式约束 > WorkflowConstraint 硬约束 > 通用 solver 偏好。Workspace 自定义 route 只决定 workflow 候选，不拥有安全授权能力。

## 7. Planner、Compiler 和 Repair Loop 接入

### Planner

只有 `RoutingResolutionResult.ok === true` 才调用 Planner；clarification/unavailable 在规划前终止。

Planner Prompt 接收：

- 已授权的 `ValidatedGoalIntentV1`；
- 已解析的 RouteObligation；
- 每个 obligation 的绑定 Agent、工具候选、依赖和产物，以及有限的 SupportingGrant；
- ToolDescriptor 派生的输入 Schema。

`CommanderDagStep` 增加 `routingBindingIds: string[]`。每个非 clarification step 必须引用一个 obligation 或 supporting grant；合并多个 obligation 的步骤列出全部 binding id。

Planner 仍负责：

- 将 obligation 组织成完整 DAG；
- 在已有 SupportingGrant 内增加必要步骤，且不超过 `maxSteps`；
- 生成 `toolInput`、context keys、success criteria 和用户可读标题；
- 合并可以安全合并的步骤。

Planner 不得：

- 替换已绑定的 Agent；
- 使用 obligation/supporting grant 之外的 Agent、工具、能力、资源或 effect；
- 删除必须阶段；

### Compiler

`compileCommanderPlan()` 不再接收 `userGoal` 并重新跑正则，而是接收同一次规划产生的 `ResolvedRoutingContract`。

通用校验项：

- 每个 obligation 至少由一个 DAG step 满足；
- 每个非 clarification step 的 `routingBindingIds` 都存在，且 step 完整满足对应 obligation/grant；不存在未绑定步骤；
- Agent、exact/allowed tool、primary capability、execution mode 一致；
- obligation dependency 在 DAG 中存在祖先关系；
- artifact producer/consumer 与 SharedContext 一致；
- DAG 不引入 contract 未授权的资源访问或副作用，包括只读 Computer step；
- unresolved intent 只能生成 Commander clarification step。

保留现有 DAG 结构、Tool input、context flow、权限和路径校验。

### Repair Loop

- Repair Prompt 同时获得 diagnostics 和不可变 routing contract。
- 可修复 Agent/Tool 字段只能在 obligation 的候选集合内变化。
- 非路由字段继续遵守“只修诊断字段”的现有保护。
- 修复不能重新识别用户意图；意图变化必须重新走完整规划流程。

## 8. 安全不变量

改造后以下规则不得由模型或路由元数据绕过：

1. 无本地可验证的持久化意图，不得出现 workspace/file write obligation。
2. 无明确 `desktop_ui`、`local_document` 或 `local_machine` intent，不得选择任何 Computer Agent step；UI input 还必须有独立 `ui_input` 授权。
3. `permissionLevel` 只能来自 ToolDescriptor，Agent profile 不能降低权限。
4. confirmed-write/dangerous 工具必须有 Core 显式处理器和 Rust 原生审批链。
5. 路径安全、workspace containment、symlink 和 stale hash 继续由原生层执行。
6. 当前页面内容、网页内容和工具输出不能改变 routing contract。
7. unavailable capability 必须暴露，不能静默替换成权限更大或资源不同的工具。

`scanLocalEffectAuthorization()` 是安全授权扫描器，不承担一般 Agent 路由职责；`detectCommanderPlanIntents()` 只在迁移期 legacy adapter 中保留并最终删除。

## 9. 分阶段迁移

### Phase 0：固定行为基线

- 冻结现有 32 条短提示场景及其负向用例。
- 为当前 route contract 增加序列化决策快照。
- 记录 Commander-only、Computer 误选、repair 次数、unavailable route 和规划耗时基线。

验证：现有聚焦测试结果不变，没有生产行为变化。

### Phase 1：协议与能力目录

- 新增 EvidenceQuote/SourceEvidenceSpan、StructuredGoalIntent、LocalEffectAuthorization、ValidatedGoalIntent、RoutingArtifact、ToolRoutingMetadata、AgentRoutingProfile 类型。
- 让 `createAgentRegistry()` 使用传入的有效 ToolDescriptor snapshot。
- 将 `ROLE_CAPABILITIES_BY_AGENT_KIND` 迁移到内置 Agent 声明。
- 实现 `buildRoutingCatalog()` 和注册一致性校验。
- 定义 canonical normalization 和 `computeContentHash()` fingerprint 输入。

验证：所有 live Agent/tool 能生成合法 catalog；artifact 能映射现有 SharedContext schema；打乱注册顺序后 fingerprint 和候选结果不变。

### Phase 2：补齐声明式元数据

- 按功能组迁移 ToolDescriptor：Code/File/Shell、Research/Page、Computer/Vision、Workspace/Scheduler/Git。
- 标记 primary、supporting、internal 工具。
- 为 Workspace 动态 Agent 增加“仅从 allowlisted 有效工具合成 profile”的注册校验和 Loader 集成测试；不扩展磁盘 Schema。

验证：每个 planner-visible 工具都有 routing metadata 或明确豁免；Agent/tool owner 和 allowlist 双向一致；Workspace Agent 不能注入 role-only routing metadata，不能跨工具拼接 match，每个 obligation 最多一个 primary tool。

### Phase 3：结构化意图服务

- Core 新增 Schema、分类 Prompt、quote 反向索引、版本化 effect authorization rules、validator 和 legacy adapter。
- Desktop 新增模型调用适配器，复用不可变 Commander profile snapshot，并接入现有 AbortSignal、timeout、usage 和错误分类。
- 先使用 `legacy | shadow | enforce` 三态配置中的 `shadow`。
- 模型分类结果仅记录，不影响现有路由。

验证：短提示、同义改写和负向提示得到稳定的 clause；模型不输出 offset 或强制 clause dependency；安全副作用与本地扫描冲突时 fail-closed。

### Phase 4：约束求解器影子运行

- 实现纯函数 solver 和 RoutingTrace。
- 实现有限 RoutingPolicy DSL、Agent/Tool 两级候选裁剪、单 primary-tool 绑定和 artifact dependency 推导。
- 同时运行旧 route contract 与新 solver，比较 obligation、Agent、Tool 和 unavailable 结果。
- 对差异分类：旧规则缺陷、意图识别缺陷、metadata 缺失、solver 缺陷。

验证：所有安全关键场景无未解释差异；受信任的内存测试 Agent 能通过 role metadata 被选中，Workspace 测试 Agent 只能通过 allowed tool metadata 被选中。

### Phase 5：Planner/Compiler 强制接入

- Planner Prompt 注入 ValidatedGoalIntent 和 ResolvedRoutingContract。
- 在 LLM raw/normalized plan schema 增加 `routingBindingIds`，并迁移模板、normalizer 和 trace。
- Compiler 从通用 obligation 校验替换 `requiredAgentRoutes`。
- Repair Loop 使用相同 contract。
- RouteRegistry 命中的 Workflow 先转换为 WorkflowConstraint，再进入同一 solver/compiler。
- 接入 `ClarificationContinuationV1`，用户补充后从意图识别和本地授权开始完整重跑，不恢复旧 plan/binding/approval。
- 按 Agent/工具组逐步启用 `enforce`，保留 legacy fallback 开关。

验证：Commander-only、无关 Agent 替代、Computer 越界、未授权写入全部在编译前失败。

### Phase 6：删除主路径硬编码

- `inferCommanderRouteRequirements()` 降级为只读兼容 adapter，随后删除。
- 将 `inferSpecialistAgentHints()` 中的 Agent 选择迁移完毕；仅保留确有必要的本地安全/目标解析逻辑。
- Compiler 不再接收原始 `userGoal` 做 Agent/Tool 推导。
- 更新 AGENTS.md 和现有 Compiler 文档。

删除条件：影子期无未处理安全差异，聚焦场景与真实执行测试全部通过，且可通过单一开关回滚一个发布周期。

## 10. 测试方案

### Schema 与识别

- classifier 输出中不能出现 Agent/Tool 选择字段。
- classifier 只输出逐字 `EvidenceQuote`，不能输出 `start/end`；Core 反向生成的 UTF-16 span 必须满足对应 source message 的 `slice(start, end) === text`。
- quote 不存在、被模型改写、为空时分类失败；重复文本保留全部位置，emoji 和多轮 clarification source 有专门用例。
- clause 不强制输出 `dependsOn`；合法/冲突的 `orderingHints` 只产生交叉验证结果，不改变 Solver 推导的依赖。
- selected workspace、attachment、current page 只能来自可信上下文。
- 缺少“那个文件”的目标时生成 unresolved target。
- “报告 bug”不产生 persist；“写一份报告.md”产生 persist。
- 否定约束如“不要改文件”“不要操作桌面”被保留。
- 本地 deny 覆盖模型 allow；模型建议敏感 effect 但本地没有授权时被拒绝。
- 本地扫描明确授权而模型漏标时，只能按 action/resource 一致性规则补齐。
- 四类敏感 effect 的每条 allow 规则都有中英文正例、动词歧义反例、否定反例和跨 effect 反例；裸名词永不授权。
- classifier provider timeout、cancel、invalid JSON 和一次 repair 后失败分别覆盖 legacy/shadow/enforce 行为。
- clarification reply 校验 continuation 后重新扫描和分类；旧 authorization/contract/approval 不得复用，跨 task 或重复 continuation 被拒绝。

### Catalog 与注册

- 每个 live Agent 的 role/tool capabilities 可解释。
- 每个 planner-visible ToolDescriptor 有 routing metadata。
- owner Agent 必须允许该工具，允许的工具必须存在有效 descriptor。
- Workspace Agent 不能声明未由 allowlisted tool 支撑的写能力。
- role obligation 未命中 Agent `matches` 时，即使 role capability 相同也不能进入候选；direct tool 候选不能借 Agent profile 补齐语义。
- `RoutingArtifact` 的 context key/schema/sensitivity 与 SharedContext、ArtifactEnvelope 一致，未知路由关键 schema fail-closed。
- runtime disabled/MCP unavailable 工具不会进入 catalog。
- canonical catalog 在注册顺序变化后产生相同 SHA-256 fingerprint；敏感 context 不进入持久化 trace。

### Solver

- 相同输入重复求解结果相同。
- 打乱 Agent/Tool 注册顺序结果相同。
- 同等能力优先低权限、窄资源、deterministic evidence 工具。
- public web 不选择 Computer；workspace inspection 不选择 Computer。
- desktop UI intent 才允许 Computer UI 工具；local document/local machine intent 只能使用对应资源的 Computer 工具。
- route unavailable 时不退化为 Commander-only。
- 新增一个支持现有语义的测试 Agent/Tool 时，只改注册数据即可进入候选。
- `requestedAgentKind` 只能过滤语义候选；指定 Computer 不能让非 desktop/local-machine clause 获得 Computer 候选。
- Workspace 工具 A 的 action 与工具 B 的 resource 不能合成候选；一个 obligation 不能绑定多个 primary tool。
- dependency 由 policy stage、artifact 和 effect phase 稳定推导；模型 ordering hint 不得覆盖硬依赖。
- supporting grant 不能跨 action/resource/effect，且不能超过 `maxSteps`。
- Policy DSL 拒绝 Agent/Tool 名称、权限覆盖、权重、自定义函数和 Workspace 自定义规则。
- custom Workflow 转成 obligations 后仍受 effect authorization、Catalog availability 和相同排序规则约束。

### Planner 与 Compiler

- 32 条真实短提示继续覆盖全部默认 Agent。
- 测试从固定 Agent 断言逐步转为“意图 clause + obligation + 合法 binding”断言；安全关键 exact route 继续精确断言。
- Planner 省略 obligation、换 Agent、换权限或破坏依赖时编译失败。
- 非 clarification step 缺少、伪造或错用 `routingBindingIds` 时编译失败。
- artifact 的 producer key/schema/sensitivity、consumer input key 或祖先关系不一致时编译失败。
- 只读但未绑定的 `computer.screenshot` supporting step 编译失败。
- Repair 只能在 contract 允许的候选内调整。
- recovery plan 继续校验 existing steps 和 SharedContext producer。

### Runtime 与原生安全

- 每类副作用至少保留一个真实运行时测试：read、workspace process、workspace write、external write、desktop input。
- Workspace/File/Git/Computer 的审批拒绝、错误 task id、stale hash、one-shot 和 symlink 测试保持通过。
- 本改造不以 Planner/Compiler 测试替代 Rust 安全测试。

## 11. 可观测性与发布指标

在 `PlanGenerationTrace` 增加：

- intent schema version、脱敏 clause 摘要和 unresolved slots；默认不写入 subject、target value 或 evidence text；
- effect authorization 结果及 evidence offset/count，不写入 evidence 原文；
- intent/catalog/contract fingerprint、fingerprint schema version 和 hash algorithm；
- solver obligations、候选、绑定和淘汰原因；
- legacy/new route comparison；
- classifier/solver latency 和 token；
- fallback 原因。

发布前重点观察：

- 非闲聊任务的 Commander-only 比例；
- 非 desktop_ui 意图选择 Computer 的比例；
- intent parse/fallback/clarification 比例；
- `MISSING_REQUIRED_*` 与 repair 次数；
- unavailable route 比例；
- 规划总延迟变化。

日志继续执行现有敏感信息脱敏，不持久化未授权的原始输入、附件内容或秘密字段。

## 12. 预计文件边界

新增：

```text
packages/tools/src/routing-metadata.ts
packages/core/src/planning/commander-intent.ts
packages/core/src/planning/commander-routing-catalog.ts
packages/core/src/planning/commander-route-solver.ts
apps/desktop/src/commander-intent-provider.ts
```

主要修改：

```text
packages/tools/src/types.ts
packages/tools/src/descriptors.ts
packages/tools/src/plan-schema.ts
packages/core/src/agent-capability.ts
packages/core/src/agents.ts
packages/core/src/local-router.ts
packages/core/src/commander-plan-schema.ts
packages/core/src/shared-context.ts
packages/core/src/planning/schema.ts
packages/core/src/planning/plan-generation-trace.ts
packages/core/src/planning/commander-plan-compiler.ts
packages/core/src/planning/commander-plan-validator.ts
packages/core/src/planning/commander-plan-repair.ts
apps/desktop/src/app-runtime.ts
apps/desktop/src/workspace-loader.ts
```

对应测试文件与上述模块同批修改，尤其包括 workspace loader、route/workflow constraint、plan schema mirror、trace redaction 和 runtime classifier failure-mode 测试。Workspace Definition 磁盘 Schema 在首版保持不变。

`RouteRegistry` 和 `WorkflowRegistry` 保持现有职责，只在显式 Workflow 命中时向结构化意图提供可信 workflow constraint。

## 13. 风险与取舍

### 额外模型调用

优点是意图与规划解耦，缺点是增加串行延迟和 token。不能为了省一次调用而让 Planner 同时决定意图和路由，否则无法在生成 DAG 前进行确定性求解。

### 元数据漂移

声明式不代表自动正确。必须用 catalog coverage 和 owner/allowlist contract tests 阻止漂移。

### 能力粒度

能力过粗会让错误 Agent 都成为候选，过细会复制工具名。新增 capability 前必须证明至少存在两个消费者，或它代表明确的安全/业务不变量。

### 模型误分类

模型只影响语义 clause，不拥有授权权力。低置信度进入澄清；写入和桌面输入继续由本地规则确认。

### 本地授权规则漏识别

完整动作构式会牺牲部分召回率，但漏识别只会 fail-closed 并触发澄清，不会放大权限。通过版本化规则、真实短提示正反例和 effect 间隔离控制维护成本，不能用宽泛裸词换取召回率。

### Artifact 与 continuation 漂移

RoutingArtifact 必须绑定现有 SharedContext schema；新增 key/type 未注册时编译失败。Continuation 绑定 task、唯一消息 id 和一次性 id，每轮废弃旧授权与 contract，避免澄清重放或上下文陈旧。

### 动态 Agent

动态 Agent 应能参与已有能力竞争，但不能自行扩展安全语义。新的 IntentAction、Resource 或 effect 仍需受信任代码和测试引入。

## 14. 完成标准

改造完成需要同时满足：

1. 对已有 IntentAction/Resource，新增 read-only Agent/Tool 路由只需注册 metadata 和测试，不修改 solver。
2. 默认 19 个 live Agent 和所有 planner-visible 工具都有可验证的能力声明。
3. 同一 validated intent/catalog/workflow constraint 输入产生稳定 routing contract 和 fingerprint。
4. 每个 DAG step 都绑定 obligation 或 supporting grant；非 desktop/local-machine 请求不会选择任何 Computer Agent step，项目理解固定获得 workspace inventory evidence。
5. 敏感 effect 必须通过 `LocalEffectAuthorization`；本地 deny 始终覆盖模型提案和 Workflow。
6. Workspace Agent 只能通过有效 allowlisted tools 获得 tool-backed routing，不接受磁盘 role metadata。
7. Planner、Compiler、Repair 和 custom Workflow 使用同一个 routing contract，不再分别推导或旁路。
8. classifier timeout/cancel/parse/provider 故障在三种 routing mode 下都有确定行为和 trace。
9. legacy route contract 从强制主路径移除，并保留一个发布周期的可回滚模式。
10. 聚焦单元、真实短提示、运行时审批和 Rust 安全测试全部通过。
11. 模型只输出可反向定位的原文 quote，不输出 offset 或强制 clause dependency；依赖由 policy、artifact 和 effect phase 确定性推导。
12. Agent `matches` 是 role 候选的硬门，direct tool 由单个 descriptor 原子匹配；`requestedAgentKind` 只能过滤，不能扩张候选。
13. RoutingArtifact 的 type/key/schema/sensitivity 与 SharedContext/ArtifactEnvelope 一致，producer/consumer 不一致时 Compiler fail-closed。
14. Workspace Agent 的每个 obligation 至多一个 primary tool，不能跨工具合成能力；额外工具只能经有限 SupportingGrant 使用。
15. clarification reply 必须通过一次性 continuation 完整重跑意图识别、授权、Catalog、Solver 和 Compiler，不复用旧 plan、binding 或 approval。
16. RoutingPolicy 只能使用有限 selector/stage/capability/artifact/edge DSL，不含 Agent/Tool 名称、权限覆盖、权重、自定义代码或 Workspace 注入。

## 15. 推荐实施顺序

先完成 Phase 0-2，不改变生产路由；再完成 Phase 3-4 的影子数据。只有影子差异被解释并修正后，才进入 Phase 5 强制接入。不要直接删除当前规则，也不要一次性把全部 Agent 切换到新求解器。
