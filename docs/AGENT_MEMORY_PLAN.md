# Javis Agent Memory Plan

## 结论

Javis 的记忆功能不应该被设计成“聊天记录搜索”，而应该是一个**长期上下文压缩与召回系统**。

第一版建议保留现有 `user-profile-memory`，新增一套本地 `agent-memory`。前者继续服务用户画像、新聊天推荐和偏好入口；后者负责 Agent 的跨会话长期事实、项目上下文、会话摘要和受控检索。

总体方向采用 `study/openhanako` 的“会话摘要 + 长期事实 + 本地检索”思路，但按 Javis 的 workspace / session 结构重新设计。`study/Proma` 只借鉴工具接口形态；`study/TG-HELPER` 和 `study/AutoSci` 不作为当前核心记忆方案。

## 设计原则

### 1. 本地优先

第一版不依赖 MemOS Cloud 或其他云端记忆服务。记忆数据存放在本地 SQLite，便于调试、迁移、清空和审计。

### 2. 不引入向量模型

第一版不使用 embedding / vector DB。当前目标是先做可验证、可解释、可控的长期事实召回。

检索使用：

- 标签精确匹配
- `kind` / `scope` 过滤
- `keywords` / `normalized_fact`
- SQLite FTS5
- `LIKE` 兜底
- 重要度、置信度、最近更新时间排序

中文检索不能只押宝 FTS5。SQLite FTS5 默认 tokenizer 对中文不稳定，必须保留 tags、keywords、normalized text 和 LIKE 兜底。

### 3. 写入链路和检索链路分开

Agent 第一版只拥有只读检索工具 `search_memory`，不开放无限制 `add_memory`。

长期记忆写入只走后台受控管线：

```text
conversation messages
  -> rolling summary
  -> fact extractor
  -> dedupe / merge
  -> SQLite
```

后续如果需要让 Agent 主动提出记忆写入，也应该设计成 `propose_memory`，由后台管线审核、去重和合并，而不是直接永久写入。

### 4. 必须支持 scope

Javis 同时服务多个 workspace 和 session。长期记忆如果只有全局池，很容易在用户说“之前那个方案”时召回错工作区。

第一版所有长期事实必须带作用域，但不启用 `project` scope：

```ts
type MemoryScopeType = "global" | "workspace" | "session";
// future: "project"
```

```ts
scope_type: MemoryScopeType;
scope_id: string | null;
```

除非 Javis 已经有稳定、可持久化、跨重启不变的 `project_id`，否则不要让第一版逻辑依赖 project。`project` 只作为未来扩展保留，等 Javis 有明确 Project 模型后，再作为 workspace 下的更细粒度 scope 加进去。数据库字段仍用 `TEXT`，以后扩展不需要大迁移。

推荐 ID 规则：

- `global`：`scope_id = null`。
- `workspace`：使用 canonical workspace id，优先复用工作区注册 ID；如果没有注册 ID，使用规范化后的 workspace 路径哈希，不直接把完整路径暴露给模型。
- `session`：使用当前会话的稳定 `session_id`。
- `workspace_id` 与 `scope_type = "workspace"` 的 `scope_id` 必须使用同一套 canonical workspace id。

### 5. 记忆不是绝对事实

Prompt 中必须明确：

- 记忆只作为上下文线索，不是绝对事实。
- 当记忆和用户当前输入冲突时，以用户当前输入为准。
- 当用户模糊引用“之前”“上次”“刚才那个项目”时，优先检索记忆。
- 不要把临时执行步骤、调试过程、工具调用细节当成长期偏好。

## 现有能力

当前 Javis 已经有一层用户画像型记忆：

- `apps/desktop/src/user-profile-memory.ts`
- SQLite 表：`user_profile_memory`
- 主要用途：用户画像、历史工作主题、新聊天推荐
- 数据形态：单条 JSON 画像

它适合继续保留，不建议替换成通用长期记忆。

新增的 `agent-memory` 应该补齐：

- 会话 rolling summary
- 长期事实提取
- workspace / session 作用域
- 本地检索工具
- Prompt Builder 注入
- UI 中的开关、查看和清空

## 推荐架构

```text
Chat / Agent
  -> Prompt Builder
     - user-profile-memory 画像摘要
     - workspace 相关长期事实
     - recent session summary
     - search_memory 检索结果
  -> LLM Agent
     - 正常回答
     - 必要时调用 search_memory
  -> Memory Pipeline
     - rolling summary
     - fact extraction
     - dedupe / merge
     - confidence / importance scoring
  -> SQLite Local
     - user_profile_memory
     - agent_session_summaries
     - agent_memory_facts
     - agent_memory_facts_fts
```

## 数据模型

### agent_session_summaries

保存会话级摘要。摘要用于后续事实提取，也可以作为 Prompt Builder 的近期上下文。

```sql
CREATE TABLE agent_session_summaries (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  session_id TEXT NOT NULL,
  workspace_id TEXT,
  summary TEXT NOT NULL,
  important_points TEXT,
  open_threads TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

字段说明：

- `summary`：当前会话压缩摘要。
- `important_points`：JSON 字符串，保存长期有价值的要点。
- `open_threads`：JSON 字符串，保存尚未完成或可延续的上下文。
- `workspace_id`：用于工作区隔离和召回。

### agent_memory_facts

保存长期事实。事实应该是短句、原子化、可复用，而不是聊天记录原文。

```sql
CREATE TABLE agent_memory_facts (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  fact TEXT NOT NULL,
  normalized_fact TEXT,
  kind TEXT NOT NULL,
  tags_json TEXT,
  keywords_json TEXT,
  search_text TEXT,
  scope_type TEXT NOT NULL DEFAULT 'global',
  scope_id TEXT,
  source_session_id TEXT,
  source_message_ids TEXT,
  confidence REAL DEFAULT 0.8,
  importance INTEGER DEFAULT 3,
  status TEXT DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_accessed_at INTEGER,
  access_count INTEGER DEFAULT 0,
  expires_at INTEGER
);
```

推荐 `kind`：

```ts
type AgentMemoryFactKind =
  | "user_preference"
  | "workspace_context"
  | "product_decision"
  | "technical_constraint"
  | "design_principle"
  | "workflow"
  | "personal_note"
  | "other";
```

推荐 `status`：

```ts
type AgentMemoryFactStatus = "active" | "archived";
```

`expires_at` 用于短期有效但仍值得暂存的事实，例如“用户今天正在调试某个问题”。这类信息不应该永久污染上下文。

`tags_json`、`keywords_json` 和 `source_message_ids` 存 JSON 字符串，只用于结构化读写。`search_text` 存面向检索的归一化文本，建议由 `fact + normalized_fact + tags + keywords` 拼成，并对中英文都做轻量规范化。中文关键词不要依赖空格分词，应该额外把 LLM 提取的短关键词写入 `keywords_json` 和 `search_text`。

`source_message_ids` 只供内部调试和审计视图使用，不注入 prompt、不进入 tool audit、不默认导出，普通 UI 默认不显示。用户删除单条记忆时，主表 hard delete 后对应 source link 也必须消失。

### agent_memory_facts_fts

FTS 表用于辅助全文检索。因为 `agent_memory_facts` 使用自增 `rowid`，FTS5 content rowid 可以稳定映射。

```sql
CREATE VIRTUAL TABLE agent_memory_facts_fts USING fts5(
  fact,
  normalized_fact,
  search_text,
  content='agent_memory_facts',
  content_rowid='rowid'
);
```

建议通过 trigger 同步：

```sql
CREATE TRIGGER agent_memory_facts_ai
AFTER INSERT ON agent_memory_facts BEGIN
  INSERT INTO agent_memory_facts_fts(rowid, fact, normalized_fact, search_text)
  VALUES (new.rowid, new.fact, new.normalized_fact, new.search_text);
END;

CREATE TRIGGER agent_memory_facts_ad
AFTER DELETE ON agent_memory_facts BEGIN
  INSERT INTO agent_memory_facts_fts(agent_memory_facts_fts, rowid, fact, normalized_fact, search_text)
  VALUES ('delete', old.rowid, old.fact, old.normalized_fact, old.search_text);
END;

CREATE TRIGGER agent_memory_facts_au
AFTER UPDATE ON agent_memory_facts BEGIN
  INSERT INTO agent_memory_facts_fts(agent_memory_facts_fts, rowid, fact, normalized_fact, search_text)
  VALUES ('delete', old.rowid, old.fact, old.normalized_fact, old.search_text);
  INSERT INTO agent_memory_facts_fts(rowid, fact, normalized_fact, search_text)
  VALUES (new.rowid, new.fact, new.normalized_fact, new.search_text);
END;
```

### memory_injection_logs

第一版必须做最小注入审计，否则记忆污染很难 debug。审计日志只记录 ID 和元信息，不复制完整 prompt，也不复制记忆正文。

```sql
CREATE TABLE memory_injection_logs (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  session_id TEXT NOT NULL,
  message_id TEXT,
  workspace_id TEXT,
  injection_type TEXT NOT NULL,
  memory_fact_ids TEXT,
  query_hash TEXT,
  query_terms TEXT,
  query_length INTEGER,
  scope_type TEXT,
  scope_id TEXT,
  prompt_section TEXT,
  score_summary TEXT,
  created_at INTEGER NOT NULL
);
```

推荐 `injection_type`：

```ts
type MemoryInjectionType =
  | "user_profile"
  | "workspace_memory"
  | "recent_summary"
  | "retrieved_memory";
```

字段说明：

- `memory_fact_ids`：JSON 数组，只存被注入或召回的 fact id。
- `query_hash`：检索 query 的不可逆 HMAC，可为空。使用 app-local salt / secret，不能使用裸 SHA 这类可枚举哈希。
- `query_terms`：JSON 数组，只存提取后的短关键词，不存用户原始输入。
- `query_length`：原始 query 长度，用于调试检索行为。
- `score_summary`：JSON 字符串，只存分数、原因、排序信号等元信息，不存事实正文。
- `prompt_section`：例如 `User Profile`、`Workspace Memory`、`Recent Session Summary`、`Retrieved Memory`。

当前 Javis 的 migration runner 以单条 SQL 执行每个 migration。实现时必须把 `CREATE TABLE`、`CREATE VIRTUAL TABLE`、每个 `CREATE TRIGGER`、每个 `CREATE INDEX` 拆成独立 migration ID，不能把上面的多条 SQL 直接塞进一个 migration。

用户主动删除或清空记忆属于隐私操作，必须 hard delete，不允许只设置 `status = "deleted"` 软删除。hard delete 必须同步清理：

- `agent_memory_facts` 主表记录
- `agent_memory_facts_fts` FTS 记录
- `agent_session_summaries` 中对应范围的摘要
- `memory_injection_logs` 中可关联到相关记忆的记录

如果要保留统计，只能保留不可逆计数和时间戳，例如 `deleted_fact_count`、`last_memory_cleared_at`，不能保留 fact、summary、tags、query 里的隐私正文。

第一版只要发生 hard delete，就删除相关 injection logs，不保留对已删除记忆的引用。删除单条记忆时，也要删除或脱敏引用该 `memory_fact_id` 的日志；为了实现简单，第一版推荐直接删除相关日志。

清空记忆的边界必须向用户说明：默认只删除 memory subsystem 的事实、摘要、FTS 和注入审计，不删除原始会话历史、任务历史或工具日志。如果用户需要“清空记忆并删除来源记录”，应作为单独的更强隐私操作设计，不能和普通清空混在一起。

## 写入规则

长期记忆应该写入：

- 用户稳定偏好
- 长期项目背景
- 已确认的产品决策
- 重要技术约束
- 设计原则
- 反复出现的问题
- 工作流习惯
- 用户明确要求“记住”的内容

长期记忆不应该写入：

- 一次性命令
- 临时 debug 步骤
- 模型猜测
- 尚未确认的方案
- 错误日志原文
- 完整隐私内容
- 长篇聊天记录
- 工具调用细节

记忆系统不是日志仓库，而是可复用上下文压缩器。

## 检索设计

### 工具输入

```ts
type SearchMemoryInput = {
  query: string;
  tags?: string[];
  kind?: AgentMemoryFactKind[];
  scopeType?: "global" | "workspace" | "session";
  scopeId?: string;
  limit?: number;
};
```

### 工具输出

```ts
type SearchMemoryResult = {
  id: string;
  fact: string;
  kind: AgentMemoryFactKind;
  tags: string[];
  confidence: number;
  importance: number;
  updatedAt: number;
  sourceSessionId?: string;
};
```

### 搜索顺序

```text
1. 过滤 status = active
2. 过滤 expires_at 为空或未过期
3. scope 匹配
4. kind 匹配
5. tags / keywords 匹配
6. FTS5 检索
7. LIKE 兜底
8. 合并去重
9. 按综合分排序
```

### 排序信号

```text
score =
  keyword_match
  + tag_match
  + scope_match
  + importance
  + recency
  + confidence
  + access_frequency
```

中文查询应优先利用 `tags`、`keywords`、`normalized_fact` 和 `LIKE`，FTS5 只作为增强项。

## 工具接入

`search_memory` 不只是 Prompt 文案里的能力，还必须接入 Javis 现有工具系统。第一版建议把它设计为只读工具，不需要写权限审批，但仍然需要工具审计。

接入点：

- 在工具 descriptor 列表中注册 `memory.search` 或 `search_memory`，命名需要和现有工具命名规范保持一致。
- 在对应 Agent 的 `allowedToolNames` 中加入该工具；如果只允许部分 Agent 回忆，需要明确 owner agent。
- 在工具 executor 中调用本地 `searchMemory()`，不要绕过统一工具执行路径。
- 工具结果进入现有 tool call audit，但只能记录 query hash、短关键词、scope、result count、result ids、elapsed time 和 status。
- `memory.search` 的 tool audit 不得写入 fact 正文、summary 正文、完整 query、完整 prompt 或包含记忆正文的 output summary。
- Prompt Builder 只负责说明何时使用记忆；工具可见性、执行、审计由 runtime/tool 层处理。

第一版建议只有只读工具：

```ts
type SearchMemoryToolInput = SearchMemoryInput;
```

后续如果要让 Agent 主动提出写入，使用受控工具：

```ts
type ProposeMemoryInput = {
  fact: string;
  kind: AgentMemoryFactKind;
  tags?: string[];
  scopeType?: MemoryScopeType;
  scopeId?: string;
  reason: string;
};
```

`propose_memory` 只能写入待审核队列，不能直接写入 `agent_memory_facts`。

## Prompt 注入

每次构建 Agent prompt 时不要粗暴塞入所有记忆。建议分四块，严格控制数量。

```text
[User Profile]
来自 user-profile-memory，最多 5 条。

[Workspace Memory]
当前 workspace 相关长期事实，最多 8 条。

[Recent Session Summary]
当前或最近会话 rolling summary，最多 1-2 段。

[Retrieved Memory]
根据当前用户输入检索到的事实，最多 5 条。
```

推荐规则：

```text
Memory may be incomplete or outdated.
Use memory as context, not as unquestionable truth.
When memory conflicts with the user's latest message, follow the latest message.
If the user refers to previous work ambiguously, call search_memory before answering.
Do not expose raw memory IDs unless needed for debugging.
Do not treat temporary execution steps as long-term user preferences.
```

中文版本：

```text
记忆只作为上下文线索，不是绝对事实。
当记忆与用户当前输入冲突时，以用户当前输入为准。
当用户提到“之前那个方案”“上次的问题”“刚才说的项目”时，优先检索记忆。
不要暴露原始记忆 ID，除非用户正在调试记忆系统。
不要把临时执行步骤当成长期偏好。
```

## 实现阶段

### Phase 1: 数据库和基础 API

先做本地存储和只读检索，不接自动写入。

范围：

- 新增 migration，每个 table / FTS / trigger / index 使用独立 migration ID
- 新增 `agent_session_summaries`
- 新增 `agent_memory_facts`
- 新增 `agent_memory_facts_fts`
- 新增 `memory_injection_logs`
- 实现 facts CRUD
- 实现 summary CRUD
- 实现 injection log 写入和按范围删除
- 实现 `searchMemory()`
- 实现 clear all / clear workspace
- 实现 canonical workspace id 生成和 scope 过滤

验收：

- 能写入事实
- 能按关键词查回
- 能按标签查回
- 能按 workspace 查回
- 能过滤过期事实
- 能清空全部记忆
- 能清空当前 workspace 记忆
- 能写入最小注入审计日志，且日志不复制记忆正文

### Phase 2: 轻量 UI 和用户控制面

自动写入长期记忆之前，必须先有用户可见、可停、可清空的控制面。

范围：

- 记忆总开关
- 当前事实数量
- 最近更新时间
- 清空全部记忆
- 清空当前 workspace 记忆
- 查看最近记忆
- 在设置中说明记忆本地存储、不依赖云记忆

验收：

- 关闭记忆后，Prompt 不注入 agent-memory，后台管线不写入新 facts。
- 清空全部记忆会 hard delete facts，并清理 FTS。
- 清空全部记忆会删除全部 `memory_injection_logs`。
- 清空当前 workspace 只删除该 workspace scope 的 facts、summaries 和 injection logs。
- UI 能看到最近写入的事实，便于发现记忆污染。

### Phase 3: Prompt Builder 接入只读记忆

先验证“读记忆”是否有价值，再做自动写入。

范围：

- 注入 user-profile-memory 摘要
- 注入 workspace/session facts
- 注入已有最近会话摘要；如果 Phase 4 尚未产生 summary，则该块为空
- 注册并暴露只读 `search_memory` 工具
- 增加记忆使用规则
- 写入 `memory_injection_logs`：注入了哪些块、多少条、来自哪些 scope、使用了什么 query hash / query terms 和 score summary

验收：

- 用户说“之前 Javis 记忆方案”时，Agent 能查到对应事实。
- 当前 workspace 内的事实优先于其他 workspace。
- 记忆与用户当前输入冲突时，Agent 以用户当前输入为准。
- 工具调用经过统一 executor 和 tool audit。
- 注入审计只记录 fact id、scope、query hash、短关键词、分数元信息和时间，不复制完整 prompt、完整 query 或事实正文。

### Phase 4: rolling summary

范围：

- 每 N 轮更新一次 summary
- 会话结束或切换时更新 summary
- summary 只保留长期有价值内容
- summary 存入 `agent_session_summaries`

验收：

- 长对话结束后摘要稳定、简洁。
- 不记录无意义过程。
- 不记录工具调用流水账。
- 能按 session / workspace 读取最近摘要。

### Phase 5: 事实提取与合并

范围：

- 从 summary 提取 facts
- LLM 输出严格 JSON
- 去重旧事实
- 合并更新旧事实
- 更新 `confidence` / `importance`
- 过滤临时内容
- 给短期事实设置 `expires_at`

推荐输出格式：

```json
{
  "facts": [
    {
      "fact": "用户希望 Javis 的记忆功能本地优先，不依赖云端记忆。",
      "kind": "design_principle",
      "tags": ["Javis", "memory", "local-first"],
      "scope_type": "workspace",
      "confidence": 0.95,
      "importance": 5
    }
  ]
}
```

验收：

- 不重复写入语义相同事实。
- 新事实能合并旧事实。
- 临时 debug 内容不会进入长期事实。
- 已过期事实不会进入 Prompt 注入。
- 记忆总开关关闭时不会运行自动写入管线。

### Phase 6: 管理能力增强

在基础控制面之后，再考虑更细的管理能力。

范围：

- 编辑单条记忆
- 导出记忆
- 按会话禁用记忆
- 记忆审计日志
- 手动批准 `propose_memory`

验收：

- 用户能修正错误记忆。
- 用户能导出本地记忆。
- 用户能查看哪些记忆曾被注入 Prompt 或被工具召回。

## 不建议第一版做的事

- 不接 MemOS Cloud 作为主记忆底座。
- 不引入向量模型。
- 不直接搬 `TG-HELPER` 的 Python 记忆类。
- 不把 AutoSci 的 wiki/graph 当成用户长期记忆核心。
- 不开放无限制 `add_memory`。
- 不把聊天记录全文当记忆。
- 不把 Agent 的错误推理写入长期事实。

## 和 study 项目的关系

### openhanako

最值得借鉴。

可借鉴：

- rolling summary
- facts 数据库
- 标签 + FTS5 检索
- `search_memory` 工具
- 后台记忆管线

需要改造：

- 加入 workspace / session scope，project scope 只作为未来扩展保留
- 改成 Javis 的 TypeScript / Tauri / SQLite 栈
- 增强中文检索兜底
- 与现有 `user-profile-memory` 共存

### Proma

只借鉴工具接口形态。

可借鉴：

- `recall_memory`
- 记忆工具的描述方式和 Prompt 使用说明
- Prompt 中如何提示 Agent 使用记忆

不建议照搬：

- MemOS Cloud 作为主后端
- Agent 直接写长期记忆

### TG-HELPER

不适合作为当前核心方案。

原因：

- Python 栈，与 Javis 当前实现不贴
- 有可选向量库，第一版不需要
- 更像独立助手的记忆类，而不是 Javis 的 workspace-aware Agent memory

### AutoSci

适合未来做项目知识库，不适合作为个人长期记忆核心。

可借鉴：

- wiki / graph 的项目知识组织方式
- workspace knowledge base

不建议第一版引入：

- 大规模 wiki/graph 架构
- 研究项目专用流程

## 成功标准

第一版完成后，Javis 应该具备：

- 能本地保存 Agent 长期事实。
- 能按当前 workspace / session 优先召回事实。
- 能在用户模糊引用过去内容时通过 `search_memory` 找到相关上下文。
- 能把长期事实注入 prompt，但不污染上下文。
- 能清空、查看、禁用记忆。
- 不依赖云记忆服务。
- 不依赖向量模型。
- 不让 Agent 随意永久写记忆。
- 自动写入长期事实之前，已经具备记忆开关、查看和清空能力。
- 具备最小记忆注入审计，且审计日志只存 ID 和元信息，不复制完整 prompt 或记忆正文。
- `memory.search` 的 tool audit 不保存 fact、summary、完整 query 或完整 prompt 原文。

## 一句话定义

Javis 的记忆不是聊天记录搜索，而是**长期上下文压缩与召回系统**。
