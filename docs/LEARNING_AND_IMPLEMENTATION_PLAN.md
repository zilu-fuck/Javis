# Javis 学习与落地路线

最后更新：2026-05-24

这份文档把 Javis 下一阶段需要学习的外部项目和官方机制，整理成可执行的实现路线。目标不是把 LangGraph、Temporal、Aider、LiteLLM 或 AI SDK 全部引入项目，而是学习其中与 Javis 匹配的机制，再用最小实现落到当前仓库。

## 基本假设

- Javis 继续保持桌面优先、本地优先。
- Core 负责任务状态、路由、权限策略和验证策略。
- Tauri/Rust 是本地文件写入和进程执行的最终安全边界。
- 外部项目优先作为设计参考。引入新依赖前，需要单独做取舍说明。
- 下一阶段先稳住安全、审批和恢复，再扩展模型路由和 UI 表现。

## 当前符合度评估

当前项目方向与本路线一致，但还没有达到本文档定义的下一阶段目标。

| 领域 | 当前状态 | 与路线差距 |
| --- | --- | --- |
| confirmed-write 审批 | Core 已有 pending -> approved/denied/expired/cancelled 状态 helper，PDF flow 有一次性 native approval id，Code Patch apply 已通过 UI confirmed-write。Desktop 已新增 durable approval record 存储模型，并为 PDF restore 增加 native approval rehydration hook。 | packaged-app 跨重启 QA 尚未覆盖，durable approval 还没有迁移到 Code Patch，也还没有共享 native guard。 |
| Code Patch proposal | opencode 只负责 proposal，Javis 已验证 patch hash、changed files、workspace 内路径，并通过 native `git apply` 写入。 | proposal 仍是 `changedFiles + patch` 形态，还没有 `baseGitHead`、文件 before hash、hunk 结构、apply 前 dry-run 校验和 stale file hash 拒绝。 |
| Rust/native guard | PDF 和 Code Patch 都在 Rust 层做关键路径校验，PDF approval 具有一次性消费语义。 | approval/path/hash 校验仍分散在具体命令附近，尚未抽成所有 confirmed-write 命令共用的 guard。 |
| 模型配置与密钥 | 桌面端能配置 provider/model/apiKey/baseUrl，并将配置传给 opencode/兼容 provider。 | API key 仍保存在 browser local storage，不符合 hardened secret storage 目标。 |
| QA 证据 | 已有 packaged-app fixture QA 覆盖 Code Agent proposal deny 和 approve/apply，研究和工作区重启也有证据。 | live DeepSeek provider smoke 需要在 fallback hardening 后用临时凭据重跑；durable approval 跨重启 QA 尚未建立。 |

因此，后续不应该先扩展更多 Agent 能力，而应该按下面的实施顺序补齐审批、proposal 和 native guard 三条安全主线。

## 已读官方资料

- [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/human-in-the-loop)：动态 `interrupt()` 暂停、基于 checkpoint 的恢复、`thread_id`、可序列化 payload 和恢复注意事项。
- [LangChain human-in-the-loop middleware](https://docs.langchain.com/oss/python/langchain/human-in-the-loop)：对高风险工具调用进行 approve/edit/reject 的人工确认模式。
- [Temporal TypeScript message passing](https://docs.temporal.io/develop/typescript/workflows/message-passing)：Queries、Signals、Updates、validators 和 workflow wait condition。
- [Temporal overview](https://docs.temporal.io/)：durable execution，以及崩溃或基础设施失败后的恢复模型。
- [Aider edit formats](https://aider.chat/docs/more/edit-formats.html)：whole-file、search/replace diff、fenced diff 和 simplified unified diff 等编辑格式。
- [Aider linting and testing](https://aider.chat/docs/usage/lint-test.html)：修改后运行 lint/test，并把失败结果反馈给修复循环。
- [Tauri capabilities](https://v2.tauri.app/security/capabilities/)：按 window/webview 限制前端可用权限的安全边界。
- [Tauri filesystem plugin permissions](https://v2.tauri.app/plugin/file-system/)：危险文件系统命令默认阻止，以及 scoped allow 规则。
- [Tauri Stronghold](https://v2.tauri.app/plugin/stronghold/)：基于 Stronghold 引擎和插件权限的密钥/secret 存储方式。
- [AI SDK tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)：schema 校验工具、tool approval request 和 tool call id。
- [LiteLLM routing](https://docs.litellm.ai/docs/routing)：模型别名、负载均衡、fallback、retry 和 timeout。

## 优先级

### 1. 持久化 confirmed-write 审批流

这是第一优先级，因为未来所有高风险能力都依赖它：PDF 整理、代码补丁应用、setup/install 操作，以及任何未来的 shell/browser 写入类动作。

需要学习什么：

- 从 LangGraph 学“可恢复 interrupt”的形状：用可序列化 payload 暂停、持久化任务状态、通过稳定 task/thread id 恢复。
- 从 Temporal 学“外部信号进入持久工作流”的模型：用户批准应该像一个外部 decision event，而不是临时前端状态。

官方文档里的关键提醒：

- LangGraph 恢复时会重新进入被 interrupt 的节点。因此 Javis 的审批节点之前必须保持幂等，或者已经把结果持久化。不要在可恢复审批点之前执行不可重放的副作用。

Javis 的设计目标：

```text
TaskRequested
  -> PlanCreated
  -> PreviewCreated
  -> ApprovalRequested
  -> ApprovalGranted | ApprovalDenied | ApprovalExpired
  -> WriteStarted
  -> WriteCompleted | WriteFailed
  -> VerificationCompleted
```

实现方向：

- 在 Core 或 desktop persistence 层增加 durable task event 记录。
- 把审批 payload 存成可序列化记录：
  - `approvalId`
  - `taskId`
  - `workspacePath`
  - `permissionLevel`
  - `toolName`
  - `previewHash`
  - `expiresAt`
  - `status`
  - `decision`
- UI 确认卡片从持久化 approval record 派生，而不是依赖一次性内存状态。
- 通过 `taskId` 和 `approvalId` 恢复执行。
- 拒绝和过期决策也要保存成审计证据。

验收标准：

- 桌面应用在 pending approval 时重启，确认卡片仍能恢复。
- 重启后批准，任务能从持久化 preview 继续执行。
- 重启后拒绝，不执行写入，任务历史中能看到拒绝证据。
- 使用过期或 `previewHash` 不匹配的 approval，原生命令必须拒绝。

### 2. Code Patch proposal 与确认执行

这是第二优先级，因为 Code Agent 是当前产品完成度的关键阻塞点，而代码写入比只读项目检查风险更高。

需要学习什么：

- 从 Aider 学“模型编辑必须收敛到少数明确格式，并在应用前验证”的思路。
- 从 AI SDK 的 tool approval 学两阶段结构：模型提出 tool/action，应用收集确认，然后执行或把拒绝上下文反馈回去。

Javis 的设计目标：

```ts
type CodePatchProposal = {
  proposalId: string;
  taskId: string;
  workspacePath: string;
  baseGitHead?: string;
  files: Array<{
    path: string;
    beforeHash: string;
    afterHash?: string;
    hunks: Array<{
      oldStart: number;
      oldLines: number;
      newStart: number;
      newLines: number;
      diff: string;
    }>;
  }>;
  verificationPlan: string[];
};
```

实现方向：

- opencode 继续只负责 proposal，不直接写文件。
- 模型输出先归一化成 Javis 内部 patch 格式，再展示给 UI。
- 弹出确认前先验证：
  - 路径必须在选中的 workspace 内。
  - 不能触碰 ignored/sensitive 路径。
  - 文件 hash 必须匹配 proposal 的 base。
  - patch 必须能 dry-run 干净应用。
- UI 展示 diff preview。
- 用户批准后，只能通过 confirmed-write 路径和 Rust/native guard 执行。
- 应用后运行聚焦验证，例如 `git diff --check`，以及可用的项目 check 命令。

验收标准：

- 格式错误的 proposal 在出现确认卡片前被拒绝。
- 触碰 workspace 外路径的 proposal 被拒绝。
- 基于过期文件 hash 的 proposal 被拒绝。
- 用户拒绝时不写入任何文件。
- 用户批准后，实际应用内容必须和展示的 diff 一致。
- 验证失败时，UI 展示失败结果，不隐藏已经应用的 diff。

### 3. 可复用 Tauri/Rust 权限守卫

这是第三优先级，因为前端负责让风险可见，Rust 才是本地副作用的最后闸门。

需要学习什么：

- 从 Tauri capabilities 学如何按窗口或 webview 降低前端 IPC 暴露面。
- 从 Tauri filesystem permissions 学默认拒绝和 scoped allow 的文件系统权限模型。
- 从 Stronghold 学把 API key 从 browser local storage 迁移到专用 secret store 的应用级模式。

Javis 的设计目标：

```text
native command
  -> parse request
  -> permission guard
  -> path/scope guard
  -> dry-run hash guard
  -> operation-specific validation
  -> execute
  -> verification summary
```

实现方向：

- 抽出 Rust 共享 helper：
  - `require_approval(approval_id, task_id, tool_name, preview_hash)`
  - `require_workspace_path(path, workspace_root)`
  - `require_downloads_path(path)`，供现有 PDF flow 使用
  - `require_file_extension(path, allowed_extensions)`
  - `require_current_file_hash(path, expected_hash)`
- 命令特有业务规则仍留在具体命令附近，但通用 approval/path/hash 校验进入共享 helper。
- Tauri capability 文件保持窄权限。不要为了省事给前端 broad filesystem write。
- API/model key 迁移出 local storage 单独作为一个里程碑处理，候选方向是 Stronghold 或 OS credential integration。

验收标准：

- Rust 测试覆盖 missing approval、wrong task id、wrong tool、expired approval、stale preview hash、path traversal、symlink escape、wrong extension 和 stale file hash。
- 即使前端 UI 状态被篡改，没有合法 approval 的 write command 也必须失败。
- 现有 PDF organization 测试继续通过。

## 第二阶段工作

这些方向很有价值，但应该等写入安全路径稳定后再推进。

### 模型路由

参考 LiteLLM 和 AI SDK，在 Javis 中设计一个小型 TypeScript `ModelRouter` 接口：

```ts
type ModelRole = "planner" | "researcher" | "coder" | "verifier";

type ModelRouter = {
  complete(role: ModelRole, request: ModelRequest): Promise<ModelResponse>;
  stream(role: ModelRole, request: ModelRequest): AsyncIterable<ModelChunk>;
};
```

它应该在 confirmed-write 和 Code Patch 稳定后再落地。多模型路由会扩大 provider 失败和格式漂移的影响面，不能早于审批和验证闭环。

### 可观测 Agent UI

参考 trace 类 UI，把当前 activity log 演进成结构化 task trace：

```text
Task
  Plan
  Tool Call
  Approval
  Write
  Verification
```

先设计可序列化的 `TaskTraceNode` 数据模型，再改视觉组件。UI 应该渲染 Core 事件，而不是维护一套平行状态。

## 近期里程碑

### Milestone A：Durable Approval Records

范围：

- 定义 approval record/event types，先不要引入通用 workflow engine。（已完成初版 `javis.approvalRecords.v1`）
- 在 desktop persistence 层保存 pending/resolved approvals。（PDF pending/resolved 初版已接入）
- 记录 `approvalId`、`taskId`、`toolName`、`workspacePath`、`permissionLevel`、`previewHash`、`expiresAt`、`status`、`decision` 和可序列化 dry-run。
- 用 PDF organization 作为第一条迁移路径：pending approval 重启后恢复确认卡片，approve/deny 都写回 approval record。（实现已接入，packaged approve/deny restart QA 已通过）
- 增加 expiry 和 stale preview rejection。（PDF expired restart QA 已通过；stale preview native rejection 已有 Rust 覆盖）
- 保持现有 resolved permission audit 能进入任务历史，但 pending approval 不再只存在于内存。

成功标准：

- Pending approval 能跨应用重启保留。（PDF approve/deny path 已通过 packaged QA）
- 重启后 approve/deny 都能工作。（PDF approve/deny path 已通过）
- 过期或过时 approval 无法执行。（PDF expired restart QA 已通过；stale preview native rejection 已有 Rust 覆盖）
- 现有 PDF flow 继续通过。
- 增加 packaged-app QA：在 PDF permission card 出现后关闭应用，重启后恢复卡片并完成 approve/deny。

### Milestone B：Code Patch Confirmed-Write

范围：

- 定义 `CodePatchProposal`。
- 将 opencode 输出校验并转换成内部格式。
- 增加 patch dry-run validation。
- 展示 diff confirmation。
- 将 Code Patch approval 接入 Milestone A 的 durable approval record。（pending/resolved 审计初版已接入；restart restore/apply 仍待共享 guard 后开放）
- 只通过 confirmed-write 应用补丁，并在 native apply 前校验 proposal id、preview hash、workspace、approved files 和当前文件 hash。（approval id 已传入 native apply，proposal patch hash 已校验；one-shot/current file hash 待补）

成功标准：

- 无效 proposal fail closed。
- Deny 不写入。（现有 fixture QA 已覆盖，durable resolved 记录已接入）
- Approve 只应用展示过的 patch。（现有 fixture QA 已覆盖，durable resolved 记录已接入，native patch hash 校验已补）
- 验证输出写入任务历史。
- 应用前工作区文件变化导致 hash 过期时，native apply 拒绝执行。

### Milestone C：Native Guard Refactor

范围：

- 抽出 Rust approval/path/hash guards。（Code Patch native apply 已要求 approval id 并校验 proposal patch hash）
- 把 PDF organization 和 code patch apply 迁移到共享 guard。（Code Patch proposal/apply 已先迁入共享 relative path/approved-set guard）
- 扩展 Rust 安全测试。

成功标准：

- 所有 write-capable commands 都使用共享 guard。（进行中：Code Patch path guard 已共享，PDF/native approval state 仍待迁移）
- 现有行为保持不变。
- 新增 negative tests 在修复前失败，修复后通过。

### Milestone D：Secret Storage Migration

范围：

- 将 `javis.modelSettings.v1` 中的 API key 拆出 local storage。
- local storage 只保留 provider、model、baseUrl 和 key reference。
- 通过 Stronghold 或 OS credential integration 保存实际 secret。
- Tauri proposal command 按 key reference 读取 secret，只在单次 provider 请求中使用。

成功标准：

- 任务历史、日志、截图和 local storage 都不包含 API key 明文。
- 删除模型配置时同步删除对应 secret。
- 旧 localStorage 配置有一次性迁移或清理策略。

## 本轮明确不做

- 不因为官方文档有用，就直接引入 LangGraph、Temporal、LiteLLM 或 AI SDK。
- 不在 approval event model 被 PDF 和 code patch 验证前，先做通用 workflow engine。
- 不通过 broad Tauri filesystem write 权限绕过自定义 Rust command guard。
- 不在 Core 输出稳定 task trace 之前重做整个 UI。
- 不把新的 secret 存进 local storage。

## 推荐第一步

从 Milestone A 开始，用现有 PDF organization flow 作为试验场。它已经具备 dry-run、确认卡片、approval id、native execution 和 verification summary，是验证持久审批流的最小闭环。

当 PDF approval 能跨重启恢复，并且 stale approval 能 fail closed 后，再把同一套机制复用到 Code Patch proposal。

## 实施 Review 清单

每完成一个小模块后，按下面顺序 review：

- 是否把未完成能力写成了已完成能力。
- 是否仍然满足“opencode 只 proposal，不直接写文件”。
- 是否所有 write-capable command 都有 UI confirmed-write 和 Rust/native guard 双层保护。
- 是否有测试覆盖 deny、expired、stale hash、path escape 和重复 approval。
- 是否有 QA 证据证明 packaged app 行为，而不只是单元测试。
- 是否有密钥扫描，确认 API key 没进入文档、日志、截图或提交。
