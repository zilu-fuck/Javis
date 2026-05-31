# Multi-Agent Orchestration Redesign — 2026-05-30

## Overview

Javis 当前的 "关键词 → 硬编码 Workflow" 路由架构无法处理开放式任务。本方案将其替换为
**"Commander 生成 DAG → 能力匹配 Agent → Agent 调工具 → 数据流入 SharedContext → Commander 汇总"**
的通用多 Agent 编排引擎。

### 动机

三个测试用例暴露了当前架构的限制：

| 任务 | 需要的能力 | 当前能做吗 |
|------|-----------|-----------|
| "去 github 上帮我找找跟 agent 搜索相关的 skill 或者 mcp" | search + browse + verify + synthesize | 部分（hardcoded research workflow） |
| "帮我找找这个图片出自哪里" | image_analyze + search + browse_upload + verify | ❌ 缺 Vision Agent + browser.upload |
| "基于 springboot 的电商平台，帮我找找相关文献" | search_provider + browse + verify + file_write | ❌ 缺 academic provider + file.writeText |

三个任务走上完全不同路径，但底层是同一种模式：**搜索 → 提取 → 验证 → 综合/写出**。
当前系统为每个模式写了独立的分支（`isResearchGoal()` → `runResearchSearchTask()` 等），
无法泛化。

---

## 1. 目标架构

```
用户: "去 github 帮我找 agent 搜索相关的 skill"
              │
              ▼
     ┌─────────────────┐
     │   Commander      │  LLM 理解意图，生成 DAG plan
     │   (planning)      │  { steps: [{id, capability, agent, dependsOn, input, output}] }
     └────────┬─────────┘
              │
              ▼
     ┌─────────────────┐
     │   DAG Executor   │  拓扑排序 → 并行就绪 steps → 按 capability 找 Agent → 调 tool
     │                  │  结果写入 SharedTaskContext
     └────────┬─────────┘
              │
    ┌─────────┼─────────┬─────────┬──────────┐
    ▼         ▼         ▼         ▼          ▼
┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐ ┌──────────┐
│Research│ │Browser│ │Verifier│ │ File  │ │Commander │
│web_   │ │browser│ │evidence│ │file_  │ │synthesis │
│search │ │_extract│ │_verify │ │write  │ │          │
└───────┘ └───────┘ └───────┘ └───────┘ └──────────┘
              │
              ▼
     ┌─────────────────┐
     │ SharedContext    │  { search: [...], extract: [...], verify: {...}, ... }
     │ (step间数据传递)  │
     └─────────────────┘
```

关键区别：
- **旧**：`isResearchGoal()` → 固定 `research-trending-topics` workflow → 硬编码 `stepKey === "search-trends"`
- **新**：Commander 输出 DAG → capability 匹配 → 通用执行器 → 不区分任务类型

---

## 2. 核心改动

### 2.1 Commander: 从关键词路由到结构化 DAG 输出

**当前** (`index.ts:634-721`)：
```
URL in user goal? → runResearchSourceTask
isReadCurrentProjectGoal? → runReadCurrentProjectWorkflow
isResearchGoal? → runResearchSearchTask
recommendedWorkflowIds? → runGenericWorkbenchWorkflow
isProjectInspectionGoal? → runProjectInspectionTask
isCodeReviewGoal? → runCodeReviewTask
isPdfOrganizationGoal? → runPdfOrganizationPreviewTask
isDocumentScanGoal? → runFileScanTask
fallback → runChatTask
```

一共 **9 个分支**。每加一种任务类型，就要加一个 `isXxxGoal()` + `runXxxTask()`。

**目标**：替换为 **1 个分支**：

```typescript
// 新: index.ts 的 start() 方法
start(userGoal) {
  // 1. Commander 生成 DAG plan
  const dag = await commanderTool.plan({
    userGoal,
    availableTools: getAllToolDescriptors(),  // 从 ToolDescriptor 动态读取
    sharedContext: context.snapshot(),
  });

  // 2. DAG executor 执行
  const result = await executeDagPlan(dag, {
    context,
    resolveAgent: (capability) => agentRegistry.findByCapabilities([capability]),
    resolveTool: (capability) => getToolByCapability(capability),
    onStepUpdate: (step, status) => emit(step),
  });

  // 3. Commander 汇总
  const conclusion = await commanderTool.synthesize({
    userGoal, evidence: context.snapshot(),
  });

  emit({ status: "completed", commanderMessage: conclusion });
}
```

#### Commander Plan JSON Schema

```typescript
interface CommanderDagPlan {
  title: string;
  reasoning: string;
  steps: CommanderDagStep[];
}

interface CommanderDagStep {
  id: string;                    // "search-github"
  title: string;                 // "Search GitHub for agent skills"
  capability: AgentCapabilityTag; // "web_search"
  agentKind: AgentKind;           // "research"
  dependsOn: string[];            // []
  input: string;                  // What this step needs (human-readable)
  expectedOutput: string;         // What this step produces
  inputContextKeys?: string[];    // SharedContext keys to read
  outputContextKey: string;       // SharedContext key to write
}
```

**Prompt 设计要求**：
- `response_format: json_object` 强制结构化输出
- Prompt 中包含可用工具清单（从 `ToolDescriptor` 动态生成，而非硬编码）
- 解析失败时 fallback 到 `runChatTask`，并记录审计日志

### 2.2 ToolDescriptor 扩展（替代独立 ToolRegistry）

不需要新建 ToolRegistry。扩展现有 `ToolDescriptor` 即可：

```typescript
// packages/tools/src/types.ts — 扩展已有接口
export interface ToolDescriptor {
  name: string;                             // 已有: "web.search"
  permissionLevel: PermissionLevel;          // 已有: "read"
  summary: string;                           // 已有: "Search public web sources..."
  // ── 新增字段 ──
  capabilityTags: AgentCapabilityTag[];      // ["web_search"]
  ownerAgentKinds: AgentKind[];              // ["research"]
  inputSchema?: Record<string, unknown>;     // JSON Schema for input validation
  outputSchema?: Record<string, unknown>;    // JSON Schema for output shape
}
```

**影响**：
- 删掉 `agent-capability.ts` 中的 `TOOL_TO_CAPABILITY` 查找表（能力标签从 descriptor 读取）
- `initialToolDescriptors` 变成工具的唯一注册中心
- Commander prompt 中可用工具清单从 descriptors 动态生成

### 2.3 Capability Dispatch 通用化

**当前** (`workflow-executor.ts:781-877`)：
```typescript
// 硬编码每个 stepKey
if (stepKey === "search-trends" && webTool?.searchWeb) { ... }
if (stepKey === "fetch-details" && webTool) { ... }
if (stepKey === "merge-trends") { ... }
// ... 17 个 if 分支
```

**目标**：通用 capability → tool 调度：

```typescript
async function executeCapabilityStep(
  step: CommanderDagStep,
  context: SharedTaskContext,
  tools: AllTools,
): Promise<StepOutput> {
  // 1. 从 ToolDescriptor 找到匹配 capability 的工具
  const descriptor = findToolByCapability(step.capability);
  if (!descriptor) throw new Error(`No tool for capability: ${step.capability}`);

  // 2. 解析 input（从 SharedContext 读取依赖步骤的输出）
  const input = resolveStepInput(step, context);

  // 3. 执行
  const output = await invokeTool(descriptor.name, input, tools);

  // 4. 写入 SharedContext
  context.set(step.outputContextKey, output);

  return output;
}
```

**迁移策略**：Phase 1 保留现有硬编码分支作为 fallback，新增 capability dispatch 路径。
当 Commander 产出的 step 带 `requiredCapabilities` 时走新路径，否则走旧分支。Phase 2 全量切换后删除旧分支。

### 2.4 SharedContext 协议化

**当前问题**：步骤间数据靠 `context.set("search", results)` → `contextSnapshot.search`，
字段名靠约定，无类型约束。

**方案**：在 DAG Step 中显式声明输入/输出 key：

```typescript
interface StepIO {
  inputContextKeys: string[];   // 从 SharedContext 读取哪些 key
  outputContextKey: string;     // 写入 SharedContext 的 key
}
```

执行器自动：
1. 从 `SharedContext` 读取 `inputContextKeys` 对应的值，注入到 tool input
2. Tool 执行完成后，将 output 存入 `outputContextKey`
3. 下游 step 的 `dependsOn` 隐式表示 "需要前驱 step 的 outputContextKey"

不需要 step 实现代码中手动操作 context——执行器自动处理数据流。

---

## 3. 新 Agent: Vision Agent

用于分析图片内容、提取文字（OCR）、描述视觉信息。

### 3.1 Agent 定义

```typescript
{
  id: "agent-vision",
  kind: "vision",
  displayName: "Vision Agent",
  description: "Image analysis, visual content description, and OCR text extraction",
  allowedToolNames: [
    "vision.analyze",       // 通用图片分析（回答关于图片的问题）
    "vision.describe",       // 生成图片描述
    "vision.extractText",    // OCR 文字提取
  ],
  modelRequirements: {
    prefersVision: true,
    prefersCode: false,
    minContextTokens: 16000,
  },
  systemPrompt: {
    en: "You are the Vision Agent. Analyze images by describing visual content, identifying objects, text, and context. Answer questions about image content accurately and concisely. Never hallucinate details not visible in the image.",
    zhCN: "你是 Javis 的视觉代理。分析图片内容：描述视觉元素、识别物体和文字、判断图片背景和来源。准确简洁地回答问题，不编造图片中不存在的内容。",
  },
}
```

### 3.2 工具定义

```typescript
// types.ts — VisionTool 接口
export interface VisionAnalyzeRequest {
  imagePath: string;         // 本地图片路径
  question?: string;         // 关于图片的具体问题
}

export interface VisionAnalyzeResult {
  description: string;       // 图片描述
  objects: string[];         // 识别到的物体
  text?: string;             // 图片中的文字
  answer?: string;           // 对问题的回答
}

export interface VisionDescribeRequest {
  imagePath: string;
  detail?: "brief" | "detailed";
}

export interface VisionOcrRequest {
  imagePath: string;
  language?: string;         // "zh" | "en" | "auto"
}

export interface VisionOcrResult {
  text: string;
  confidence: number;
  blocks: Array<{
    text: string;
    boundingBox?: { x: number; y: number; w: number; h: number };
  }>;
}

export interface VisionTool {
  analyze(request: VisionAnalyzeRequest): Promise<VisionAnalyzeResult>;
  describe(request: VisionDescribeRequest): Promise<{ description: string }>;
  extractText(request: VisionOcrRequest): Promise<VisionOcrResult>;
}
```

### 3.3 工具描述符

```typescript
{
  name: "vision.analyze",
  permissionLevel: "read",
  summary: "Analyze an image and answer questions about its content.",
  capabilityTags: ["image_analyze"],
  ownerAgentKinds: ["vision"],
},
{
  name: "vision.describe",
  permissionLevel: "read",
  summary: "Generate a textual description of an image.",
  capabilityTags: ["image_describe"],
  ownerAgentKinds: ["vision"],
},
{
  name: "vision.extractText",
  permissionLevel: "read",
  summary: "Extract text from an image using OCR.",
  capabilityTags: ["image_ocr"],
  ownerAgentKinds: ["vision"],
},
```

### 3.4 能力标签

```typescript
// agent-capability.ts 新增
| "image_analyze"    // Analyze image content and answer visual questions
| "image_describe"   // Generate textual description of an image
| "image_ocr"        // Extract text from images via OCR
```

### 3.5 后端实现

Vision Agent 的三个工具都调用同一类 LLM——vision-capable model（如 GPT-4o、Claude Sonnet）。
在 Rust 后端，图片以 base64 编码通过 `complete_model_prompt` 的 multimodal 协议发送。

```
TypeScript (VisionTool) → invoke("complete_model_prompt", {images: [base64]}) → Rust SSE → LLM
```

这不需要新的 Rust 命令——现有的 `complete_model_prompt` 已经支持，只需要扩展
`ModelCompletionRequest` 增加 `images?: string[]`（base64-encoded）。

### 3.6 典型使用场景

```
用户: "帮我看看这张图片是哪里拍的"
  → Commander: vision.describe("详细描述场景特征") → research.web_search("根据描述搜索地点") → synthesis

用户: "这个截图的报错是什么意思"
  → Commander: vision.extractText(OCR提取) → code.inspectRepository → synthesis

用户: "帮我找找这张图片的出处"
  → Commander: vision.analyze("识别关键特征用于搜索") → browser.navigate(Google Images) → browser.upload → verify
```

---

## 4. 能力缺口分析

在动工之前，先盘点：如果 Commander 可以自由规划，系统能覆盖多少任务类型。

### 4.1 现有能力矩阵

| Agent | 工具数 | 代表能力 | 状态 |
|-------|--------|---------|------|
| Commander | 2 | planning, synthesis | ✅ |
| File | 5 | file_scan, document_classify, file_execute | ⚠️ 缺 file_write |
| Shell | 1 | shell_readonly | ✅ |
| Code | 4 | git_inspect, code_propose, code_apply, shell_readonly | ✅ |
| Research | 2 | web_search, web_fetch | ⚠️ provider 路由缺失 |
| Computer | 4 | directory_list, local_search, image_scan | ✅ |
| Scheduler | 3 | schedule_create/update/delete | ✅ |
| Verifier | 1 | evidence_check | ✅ |
| Browser | 7 | browser_navigate, browser_interact, browser_test | ⚠️ 缺 upload |
| Workspace | 4 | workspace_list/scaffold/create/delete | ✅ |
| Vision (新) | 3 | image_analyze, image_describe, image_ocr | ❌ 待实现 |

### 4.2 能力缺口优先级

| 缺口 | 影响范围 | 优先级 | 工作量 |
|------|---------|--------|--------|
| Commander JSON Schema + DAG dispatch 通用化 | 所有任务的规划+执行 | **P0** | 3-4 天 |
| SharedContext 协议 (input/output keys) | 多 step 任务的数据流 | **P0** | 1 天 |
| `file.writeText` + 权限链路 | 文献整理、报告保存、代码生成 | **P0** | 1-2 天 |
| `web_search` provider 路由 | 学术、新闻、热点搜索 | **P1** | 1 天 |
| `browser.upload` | 以图搜图、文件上传 | **P1** | 0.5 天 |
| Vision Agent (analyze/describe/OCR) | 图片分析类任务 | **P1** | 1-2 天 |
| `browser.extractLinks` / `browser.followCandidateLinks` | 深度网页研究 | **P2** | 1 天 |
| Academic search provider (Semantic Scholar) | 学术文献搜索 | **P2** | 1-2 天 |

### 4.3 三个测试用例的覆盖率

| 测试用例 | 当前 (hardcoded) | 方案实施后 |
|---------|-----------------|-----------|
| GitHub 搜 Skill/MCP | 60%（research workflow 够用但不灵活） | 100% |
| 图片溯源 | 0%（缺 Vision + upload） | 100%（Vision analyze → search → browser upload → verify → synthesize） |
| 学术文献搜索 | 30%（能搜网页但无法过滤学术来源） | 100%（provider 路由 + file.writeText 写出） |

---

## 5. 实施路线图

### Phase 1: 引擎核心（1 周）

目标：Commander 生成的 DAG 能被执行器正确调度。

| 步骤 | 内容 | 文件 |
|------|------|------|
| 1.1 | 扩展 `ToolDescriptor` 接口（+capabilityTags, +ownerAgentKinds, +schema） | `tools/src/types.ts`, `descriptors.ts` |
| 1.2 | Commander plan prompt 改为 JSON Schema + `response_format: json_object` | `app-runtime.ts` |
| 1.3 | 通用 capability dispatch 执行器（`executeCapabilityStep`） | `workflow-executor.ts` |
| 1.4 | SharedContext 协议（`inputContextKeys` / `outputContextKey`） | `shared-context.ts` |
| 1.5 | `index.ts` 的 `start()` 从 9 分支简化为 Commander DAG → execute → synthesize | `index.ts` |
| 1.6 | 删除 `TOOL_TO_CAPABILITY` 查找表，改为从 ToolDescriptor 读取 | `agent-capability.ts` |

**验收**：用任务 1（GitHub Skill 搜索）端到端跑通：Commander 产 DAG → Research 搜索 → Browser 提取 → Verifier → Commander 汇总。不限定关键词。

### Phase 2: 写能力补齐（2-3 天）

目标：Agent 能落盘产出物。

| 步骤 | 内容 | 文件 |
|------|------|------|
| 2.1 | Rust `write_text_file` 命令（参照 `pdf.rs` confirmed-write 模式） | `src-tauri/src/file.rs` (新) |
| 2.2 | `FileTool` 接口扩展 `writeText` + ToolDescriptor | `tools/src/types.ts`, `descriptors.ts` |
| 2.3 | `app-runtime.ts` 接线：dry-run → 审批卡 → execute | `app-runtime.ts` |
| 2.4 | 审批 UI 卡片（InspectorPanel 新增写文件审批） | `InspectorPanel.tsx` |

**验收**："把搜索结果保存到 results.md" —— 审批卡出现 → 确认 → 文件落盘 → 路径可验证。

### Phase 3: Vision Agent + Browser 增强（2-3 天）

目标：图片相关任务可用。

| 步骤 | 内容 | 文件 |
|------|------|------|
| 3.1 | Vision Agent 定义 + 工具描述符 + 能力标签 | `agents.ts`, `descriptors.ts`, `agent-capability.ts` |
| 3.2 | `ModelCompletionRequest` 扩展 `images` 字段（base64） | `lib.rs`, `model-provider.ts` |
| 3.3 | Vision Tool 实现（analyze/describe/extractText → LLM vision API） | `app-runtime.ts` |
| 3.4 | Browser Agent `upload` 工具 | `browser.rs`, sidecar |
| 3.5 | Browser Agent `extractLinks` + `followCandidateLinks` | `browser.rs`, sidecar |

**验收**："帮我看看这张图片出自哪里" → Vision analyze → search → browser upload（Google Images）→ verify → synthesis。完整链路打通。

### Phase 4: 搜索 Provider 路由 + 清理（1-2 天）

目标：搜索精准度提升，旧代码清理。

| 步骤 | 内容 | 文件 |
|------|------|------|
| 4.1 | `web_search` provider 路由（代码→GitHub, 学术→Semantic Scholar, 通用→Web） | `web.rs`, `web.ts` |
| 4.2 | 删除旧硬编码分支（`isResearchGoal`, `isCodeReviewGoal` 等 9 个分支） | `index.ts` |
| 4.3 | 删除旧 workflow 中的硬编码 stepKey dispatch | `workflow-executor.ts` |
| 4.4 | 端到端测试覆盖 3 个场景 | `index.test.ts`, `workflow-executor.test.ts` |

---

## 6. 风险与缓解

| 风险 | 概率 | 缓解 |
|------|------|------|
| Commander 产出的 DAG 无法解析 | 中 | JSON Schema 强约束 + `response_format: json_object` + 解析失败 fallback chat + 审计日志 |
| Commander 引用了不存在的 capability | 中 | Plan 验证层：检查每个 step.capability 是否在 ToolDescriptor 中存在，缺失时提前报错 |
| DAG step 间数据格式不兼容 | 中 | SharedContext 协议在 step 定义时声明 input/output schema，执行前校验 |
| 性能退化（LLM plan 比硬编码慢） | 低 | Commander plan 是单次 LLM 调用，原来也是 LLM 调用，总调用量不变甚至减少 |
| 向后兼容 | — | Phase 1-3 保留旧分支作为 fallback，Phase 4 完成验证后删除 |

---

## 7. 成功标准

1. **DAG 泛化**：一句话任务被 Commander 拆成多步 DAG，不区分 "热搜"、"文献"、"图片" 等类别
2. **Agent 分工可见**：UI 中能看到多个 Agent 状态变化（queued → running → completed），不是只有 Commander 在跑
3. **数据流完整**：步骤间数据通过 SharedContext 传递，不丢信息
4. **失败可定位**：某 step 失败时，用户看到的是 "Research Agent: search 返回空结果"，而不是 Commander 编造的结论
5. **产物可写**：任务要求 "保存到文件" 时，经过审批流程后文件确实落盘

---

## 8. 附录：修复后的完整 Agent 矩阵（含 Vision）

| Agent | 工具数 | 能力标签 | 上下文 | Vision | Code |
|-------|--------|---------|--------|--------|------|
| Commander | 2 | planning, synthesis | 16K | ✗ | ✗ |
| File | 5 → 6 (+writeText) | file_scan, document_classify, file_preview, file_execute, file_write | 8K | ✗ | ✗ |
| Shell | 1 | shell_readonly | 8K | ✗ | ✗ |
| Code | 4 | git_inspect, code_propose, code_apply, shell_readonly | 16K | ✗ | ✓ |
| Research | 2 | web_search, web_fetch | 8K | ✗ | ✗ |
| Computer | 4 | directory_list, image_scan, file_open, local_search | 8K | ✗ | ✗ |
| Scheduler | 3 | schedule_create/update/delete | 8K | ✗ | ✗ |
| Verifier | 1 | evidence_check, plan_verification | 8K | ✗ | ✗ |
| Browser | 7 → 10 (+upload, extractLinks, followLinks) | browser_navigate, browser_interact, browser_test, browser_upload | 8K | ✓ | ✗ |
| Workspace | 4 | workspace_list/scaffold/create/delete | 8K | ✗ | ✗ |
| **Vision (新)** | 3 | image_analyze, image_describe, image_ocr | 16K | ✓ | ✗ |
| Chinese Reviewer | 0 (待改为管道) | language_review | 8K | ✗ | ✗ |

**共计 12 个 Agent**（新增 Vision，Chinese Reviewer 待 Phase 3 改为管道）。

---

*设计日期：2026-05-30 | 基于 AGENT_OPTIMIZATION_ANALYSIS.md 的问题分析和三个测试用例的缺口分析*
