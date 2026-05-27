# 2026-05-28 Model Profile + AI 文件分类方案

## 目标

在已有 Model Profile 多模型配置基础上，增加 **AI 文件分类**能力：
- 本地扫描文件 → LLM 自动打标签和分类
- 不引入向量数据库，直接用 LLM 批量分类

## 架构总览

```
用户选择目录
     │
     ▼
local-knowledge.ts: scanUserDocuments()
     │  FileEntry[] (name, path, size, ext, date)
     ▼
local-knowledge.ts: classifyDocuments()
     │  发送 FileEntry[] + 分类 prompt → secondary slot LLM
     ▼
ClassifiedFile[] = { path, tags: string[], category: string, confidence: number }
     │
     ▼
UI: 按标签/分类展示文件，支持筛选
```

## 第一步：数据结构

### 新增类型（`local-knowledge.ts`）

```typescript
export interface ClassifiedFile extends FileEntry {
  tags: string[];          // e.g., ["invoice", "2024", "receipt"]
  category: string;        // e.g., "财务", "合同", "研究", "其他"
  confidence: number;      // 0-1
}
```

### 需要的标签体系

预定义分类 + 允许 LLM 自由添加标签：
- 预定义分类：`财务` `合同` `研究` `行政` `技术文档` `个人` `图片` `其他`
- 标签：LLM 自由发挥，如 `#发票` `#2024Q1` `#草稿`

## 第二步：分类 Prompt

```typescript
const CLASSIFY_PROMPT = `
You are a document classifier. Given a list of files, classify each one.

Predefined categories: 财务, 合同, 研究, 行政, 技术文档, 个人, 图片, 其他

For each file return:
- category: one of the predefined categories
- tags: 1-3 descriptive tags (inferred from filename/path)
- confidence: 0.0-1.0

Return ONLY a JSON array, no markdown or explanation.
`
```

## 第三步：Model Profile 调整

### 当前 Agent Slot 映射保持不变

```
commander       → primary    (deepseek-v4-pro, 主力推理)
code            → primary    (代码生成)
chinese-reviewer→ primary    (中文审校)
verifier        → secondary  (验证检查)
scheduler       → secondary  
research        → secondary  (研究搜索)
file            → secondary  (文件操作 + 分类)  ← 复用
shell           → secondary  
computer        → multimodal (视觉)
```

文件分类归到 `file` agent，继续用 `secondary` slot——轻量模型便宜快速，适合批量分类。

### 建议的 Profile 配置

| Slot | 推荐模型 | 用途 |
|------|---------|------|
| primary | `deepseek-v4-pro` | 复杂推理、代码、中文 |
| secondary | `deepseek-v4-flash` | 分类、验证、研究 |
| multimodal | `gpt-4o` | 图片分析 |

## 第四步：实现步骤

### Phase 1：分类核心（`local-knowledge.ts`）

- [ ] `classifyDocuments(files: FileEntry[], provider: ModelProvider): Promise<ClassifiedFile[]>`
- [ ] 构造 batch prompt（每批最多 50 个文件，超出分批处理）
- [ ] 解析 LLM 返回的 JSON → `ClassifiedFile[]`
- [ ] 单元测试

### Phase 2：app-runtime 接入

- [ ] `fileTool` 增加 `classifyDocuments` 方法
- [ ] 在工作流中增加分类步骤（扫描完成后自动分类）
- [ ] 分类结果存储在 task snapshot 中

### Phase 3：UI 展示

- [ ] Sidebar 显示分类统计（各分类文件数量）
- [ ] 文件列表支持按标签/分类筛选
- [ ] 分类中的 loading 状态（"正在分析 N 个文件..."）

## 第五步：不做的

- ❌ 向量数据库 / Embedding
- ❌ 文字提取（OCR、全文索引）
- ❌ 实时文件监控

这些留到中文 RAG 阶段或更后期再做。

## 预计工作量

| Phase | 估计时间 |
|-------|---------|
| Phase 1: 分类核心 | ~2h |
| Phase 2: runtime 接入 | ~1h |
| Phase 3: UI 展示 | ~1.5h |
| **合计** | **~4.5h** |
