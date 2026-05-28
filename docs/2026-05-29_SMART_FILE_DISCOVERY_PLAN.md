# Plan: 智能文件发现 + AI 分类标签系统

> 2026-05-29 | 基于三方审查（Claude + GLM-5 + Qwen 3.7）修正稿
>
> 修正项：scan_cache 增量 upsert、provider 封装、分类 cost 防护、drive 枚举、分类名约束、扫描进度机制

## Context

当前文件扫描存在两个核心问题：
1. **扫描不全** — 文档只扫 `~/Desktop/Documents/Downloads`，图库只加了 `~/Pictures`，上限 200，大量用户文件被遗漏
2. **分类硬编码** — UI 的筛选标签是占位符，AI 分类能力 (`classifyDocuments`) 虽已实现但从未接入 UI，结果也不持久化

目标：全盘智能扫描 + 手动触发 AI 分类 + 结果存 SQLite 复用 + 分类标签可用于筛选。

---

## 架构分层

```
Rust scan_all_user_files() ──→ local-knowledge.ts bridge
              │                    (不传扩展名，全量扫描，
              │                     进度通过 Tauri event 上报)
              ▼
      App.tsx 后台扫描 → SQLite file_scan_cache (replace + 陈旧清理)
              │
     ┌────────┴────────┐
     ▼                 ▼
  DocumentsView     GalleryView
  (前端按扩展名筛选)  (前端按扩展名筛选)
     │                 │
     └────────┬────────┘
              ▼
    用户点"AI 分类" → 确认对话框 → classifyDocuments()
              │           (显示文件数 + 预估 token)
              ▼
      SQLite file_classifications (INSERT OR REPLACE)
              │
     ┌────────┴────────┐
     ▼                 ▼
  DocumentsView     GalleryView
  category/tag 筛选  category/tag 筛选
```

---

## Step 1: Rust — 增强文件发现

**文件**: `apps/desktop/src-tauri/src/lib.rs`

### 1a. 扩展 SKIP_DIRS (~line 5332)

追加 Windows 系统目录和常见噪声目录：

```rust
// 新增
"Windows", "Program Files", "Program Files (x86)", "ProgramData",
"Recovery", "Boot", "EFI", "PerfLogs",
".npm", ".yarn", ".pnpm-store", ".nuget", ".gradle", ".m2",
".docker", ".vscode", ".idea", ".ssh", ".conda",
"Intel", "AMD", "NVIDIA", "MSOCache", "Temp", "tmp"
```

> **Windows 大小写**：`collect_files_inner` 中对 SKIP_DIRS 比较统一做 `to_lowercase()` 处理，`node_modules` 和 `Node_Modules` 均被跳过。
>
> **"Intel"/"AMD"/"NVIDIA" 误伤风险**：仅当目录位于系统盘根目录（如 `C:\Intel`）时跳过，不匹配深层的同名用户目录。

### 1b. `collect_files_inner` 加深度限制 (~line 5432)

- 签名加 `max_depth: usize` 和 `depth: usize` 参数
- `depth >= max_depth` 时停止递归
- `collect_files` 新增 `max_depth` 参数，默认 `usize::MAX`（保持现有命令行为不变）
- 只有 `scan_all_user_files` 传 `max_depth = 8`

### 1c. `list_mount_roots()` 替代 `enumerate_drives()`

**Windows**：用 `GetLogicalDriveStringsW` 一次性获取所有逻辑驱动器，再用 `GetDriveTypeW` 过滤：
- 跳过 `DRIVE_REMOVABLE`（U 盘未插入可能阻塞）
- 跳过 `DRIVE_NO_ROOT_DIR`（无介质的设备）
- 跳过 `DRIVE_REMOTE`（网络映射盘，慢且可能断开）

**非 Windows**：返回 `["/"]`。

### 1d. 新增 Tauri 命令

| 命令 | 说明 |
|------|------|
| `scan_all_user_files(extensions?, max_results?)` | 枚举所有磁盘，SKIP_DIRS 过滤，深度限制 8，默认上限 5000。通过 Tauri event `scan-all-files-progress` 上报进度 `{ current, total }`。支持 `AbortHandle` 取消 |
| `list_mount_roots()` | 返回可用挂载根列表（供 Sidebar 用） |
| `cancel_scan_all_files()` | 取消正在进行的全盘扫描 |

### 1e. 注册命令 (~line 5859)

在 `invoke_handler` 中追加 `scan_all_user_files`, `list_mount_roots`, `cancel_scan_all_files`。

---

## Step 2: SQLite 文件分类持久化

**新文件**: `apps/desktop/src/file-classification-persistence.ts`

### 2a. Migration 定义

```typescript
export const FILE_CLASSIFICATION_MIGRATIONS: DesktopDatabaseMigration[] = [
  {
    version: 1,
    sql: [
      `CREATE TABLE IF NOT EXISTS file_scan_cache (
        path TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        is_dir INTEGER NOT NULL DEFAULT 0,
        size_bytes INTEGER,
        modified_at TEXT,
        extension TEXT,
        scanned_at TEXT NOT NULL
      );`,
      `CREATE INDEX IF NOT EXISTS idx_file_scan_cache_ext
         ON file_scan_cache (extension);`,
      `CREATE TABLE IF NOT EXISTS file_classifications (
        file_path TEXT PRIMARY KEY NOT NULL,
        category TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL DEFAULT 0,
        classified_at TEXT NOT NULL,
        model_id TEXT
      );`,
      `CREATE INDEX IF NOT EXISTS idx_file_classifications_cat
         ON file_classifications (category);`,
    ],
  },
];
```

### 2b. `replaceScanCache` — 增量 upsert + 陈旧清理

```
1. const now = new Date().toISOString()
2. BEGIN TRANSACTION
3. INSERT OR REPLACE INTO file_scan_cache (...) VALUES (?, ..., now)
   全部行使用同一个 scanned_at = now
4. DELETE FROM file_scan_cache WHERE scanned_at < now
   清理本次未更新的旧记录（文件已删除/移动）
   file_classifications 中对应的分类结果保留（不级联删除）
5. COMMIT
```

> **命名修正**：原名 `upsertScanCache` 与实际行为（清空 + 重写）不符，改为 `replaceScanCache`。
>
> **防重入**：`scanning` 状态锁，`scanning === true` 时忽略新扫描请求，UI 按钮 disabled。

### 2c. Repository 接口

```typescript
interface FileClassificationRepository {
  // 扫描缓存
  replaceScanCache(files: FileEntry[]): Promise<void>;
  getScanCache(): Promise<ScanCacheEntry[]>;
  getUnclassifiedFiles(): Promise<FileEntry[]>;
  clearScanCache(): Promise<void>;

  // AI 分类
  upsertClassificationsBatch(classified: ClassifiedFile[]): Promise<void>;
  getCategoryStats(): Promise<{ category: string; count: number }[]>;

  // 清理
  cleanupOrphanClassifications(): Promise<void>;
}
```

### 2d. 关键查询

**getScanCache**（LEFT JOIN 获取分类信息）：

```sql
SELECT c.*, fc.category, fc.tags_json, fc.confidence
FROM file_scan_cache c
LEFT JOIN file_classifications fc ON c.path = fc.file_path
WHERE c.is_dir = 0
ORDER BY c.modified_at DESC
```

> Rust 端存储 path 时已 `canonicalize()` + `to_lowercase()`，两端路径格式一致，直接等值比较可走索引。无需 `LOWER()`。

**getUnclassifiedFiles**：

```sql
SELECT c.* FROM file_scan_cache c
LEFT JOIN file_classifications fc ON c.path = fc.file_path
WHERE fc.file_path IS NULL AND c.is_dir = 0
ORDER BY c.modified_at DESC
```

---

## Step 3: TypeScript Bridge 扩展

**文件**: `apps/desktop/src/local-knowledge.ts`

### 3a. 新增 invoke 包装

```typescript
export async function scanAllUserFiles(
  extensions?: string[],
  maxResults?: number,
  onProgress?: (current: number, total: number) => void,
): Promise<FileEntry[]> {
  const unlisten = await listen<{ current: number; total: number }>(
    "scan-all-files-progress",
    (event) => onProgress?.(event.payload.current, event.payload.total),
  );
  try {
    return await invoke<FileEntry[]>("scan_all_user_files", {
      extensions: extensions ?? null,
      maxResults: maxResults ?? null,
    });
  } finally {
    unlisten();  // 正常、取消、异常三种路径均确保清理
  }
}

export async function cancelScanAllFiles(): Promise<void> {
  return invoke("cancel_scan_all_files");
}
```

### 3b. `classifyDocuments` 加进度回调 + 取消 + 限流

签名改为：

```typescript
export async function classifyDocuments(
  files: ClassifiableInput[],
  provider: ModelProvider,
  options?: {
    onProgress?: (current: number, total: number, failed: number) => void;
    signal?: AbortSignal;
    maxConcurrentBatches?: number;  // 默认 2，限流
  },
): Promise<ClassifiedFile[]>
```

- 每批开始前检查 `signal?.aborted`，中止则抛出 `AbortError`
- 每批发送前等待信号量（`maxConcurrentBatches`），控制并发
- 每个 batch 外层 try/catch，失败批次 `console.warn` 跳过，`onProgress` 仍推进（含 `failed` 计数）
- 每批完成后调用 `onProgress(current, total, failed)`

### 3c. 分类 prompt 约束分类集

`classifyDocuments` 内部的 prompt 模板强制 LLM 从预定义集合中选择 category：

```
你必须从以下分类中选择：财务、合同、研究、行政、技术文档、个人、图片、其他。
对图片文件（jpg/png/heic 等），根据文件名推断内容类型和主题。
返回 JSON：{ category, tags: string[], confidence: number }
```

---

## Step 4: App.tsx 接入

**文件**: `apps/desktop/src/App.tsx`

### 4a. 新增 state

```typescript
const [scanning, setScanning] = useState(false);
const [scanProgress, setScanProgress] = useState<{ current: number; total: number } | null>(null);
const [classifying, setClassifying] = useState(false);
const [classifyProgress, setClassifyProgress] = useState<{ current: number; total: number; failed: number } | null>(null);
const [categoryStats, setCategoryStats] = useState<{ category: string; count: number }[]>([]);
const [mountRoots, setMountRoots] = useState<{ name: string; path: string }[]>([]);
const fileClassificationRepoRef = useRef<FileClassificationRepository | null>(null);
const classifyAbortRef = useRef<AbortController | null>(null);
```

### 4b. 数据库初始化

在 database init useEffect 中追加 `FILE_CLASSIFICATION_MIGRATIONS` 迁移 + 创建 repository。

### 4c. 扫描触发时机

- **App 启动后 2s**：后台静默执行 `scanAllUserFiles()` + `replaceScanCache()`（不阻塞 UI）
- **手动刷新**：DocumentsView / GalleryView 提供"刷新"按钮，`scanning` 期间 disabled
- **防重入**：`scanning === true` 时忽略新扫描请求

### 4d. 统一扫描 + 前端按扩展名分流

`scanAllUserFiles()`（不传扩展名）→ `replaceScanCache()` → 前端按扩展名分流：

```typescript
const DOC_EXTENSIONS = [
  "docx", "doc", "txt", "pdf", "xlsx", "xls", "csv",
  "pptx", "ppt", "md", "rtf", "odt",
];
const IMAGE_EXTENSIONS = [
  "jpg", "jpeg", "png", "gif", "bmp", "webp", "svg",
  "ico", "heic", "raw", "cr2", "nef", "tiff",
];

const DOC_EXT_SET = new Set(DOC_EXTENSIONS);
const IMAGE_EXT_SET = new Set(IMAGE_EXTENSIONS);
```

传给 JavisWorkbench 的 `userDocuments` 和 `userImages` 分别从同一个 scanCache 中按扩展名过滤。

> **建议**：`DOC_EXTENSIONS` / `IMAGE_EXTENSIONS` 后续迁移到 `packages/core/` 常量。

### 4e. `app-runtime.ts` — 内部封装分类调用

**不暴露 `getProviderForAgent`**。改为在 `app-runtime.ts` 的 `createAppRuntime` 返回值中新增方法：

```typescript
classifyWithFileAgent: async (
  files: ClassifiableInput[],
  options?: {
    onProgress?: (current: number, total: number, failed: number) => void;
    signal?: AbortSignal;
  },
): Promise<ClassifiedFile[]> => {
  const provider = providerFor("file");
  return classifyDocuments(files, provider, {
    ...options,
    maxConcurrentBatches: 2,
  });
}
```

这保持了 tool 抽象层闭合——App.tsx 不接触 provider 对象。

### 4f. `handleClassifyDocuments` — 确认 + 分类 + 持久化

```
1. 如果 classifying → 忽略
2. 从 repository 取 unclassifiedFiles.length → 弹出确认：
   "将分类 N 个文件（约 n 批），预估消耗 ~X tokens（约 $Y）"
   // X = promptOverhead(800) * batchCount + avgFileNameLen(40) * N
   //     + maxOutputTokens(2000) * batchCount
   // Y = modelPricing(provider) * X / 1000
3. 用户确认 → setClassifying(true)，创建 AbortController
4. 调用 classifyWithFileAgent(files, { onProgress, signal })
5. 每批完成：upsertClassificationsBatch(batch) + 更新 categoryStats
6. 全部完成 / 取消 / 出错 → setClassifying(false)
7. 取消后已完成的分类保留（不回滚）
```

### 4g. `handleCancelClassify`

```typescript
function handleCancelClassify() {
  classifyAbortRef.current?.abort();
  // classifyDocuments 中 AbortError → 停止后续批次
  // 已完成的批次已写入 SQLite，不回滚
}
```

### 4h. 盘符获取

App.tsx 在 database init 后调一次 `listMountRoots()` 存 `mountRoots` state，传给 Sidebar。

### 4i. 传递新 props 到 JavisWorkbench

| prop | 类型 |
|------|------|
| `scanning` | `boolean` |
| `scanProgress` | `{ current: number; total: number } \| null` |
| `onRefreshScan` | `() => void` |
| `onClassifyDocuments` | `() => void` |
| `onCancelClassify` | `() => void` |
| `classifying` | `boolean` |
| `classifyProgress` | `{ current: number; total: number; failed: number } \| null` |
| `categoryStats` | `{ category: string; count: number }[]` |
| `mountRoots` | `{ name: string; path: string }[]` |
| `userDocuments` | `WorkbenchFileEntry[]`（从 scanCache 按 DOC_EXTENSIONS 过滤） |
| `userImages` | `WorkbenchFileEntry[]`（从 scanCache 按 IMAGE_EXTENSIONS 过滤） |

---

## Step 5: UI 组件

### 5a. `packages/ui/src/types.ts`

- `WorkbenchFileEntry` 加 `category?`, `tags?`, `confidence?`
- `JavisWorkbenchProps` 加 Step 4i 的全部新 props

### 5b. `packages/ui/src/locale.ts`

`WorkbenchLocale.labels` 加 `categoryLabels` 映射（8 个预定义分类）：

```typescript
categoryLabels: {
  财务: "Finance",
  合同: "Contracts",
  研究: "Research",
  行政: "Administrative",
  技术文档: "Technical Documents",
  个人: "Personal",
  图片: "Images",
  其他: "Other",
}
```

显示分类名时：`locale.labels.categoryLabels[category] ?? locale.labels.categoryLabels["其他"]`。由于 prompt 约束了分类集，理论上不会出现未知分类。

### 5c. `packages/ui/src/components/DocumentsView.tsx`

- 新 props: `scanning`, `scanProgress`, `onRefreshScan`, `onClassifyDocuments`, `onCancelClassify`, `classifying`, `classifyProgress`, `categoryStats`
- 刷新按钮（`scanning` 时 disabled + 显示 spinner）
- `classifying` 时 "AI 分类" 按钮变为 "取消" 按钮。GalleryView 同理（两个视图共享 `classifying` 状态，任一视图触发分类后，两侧按钮都变为"取消"，任一取消均中止）
- 分类中显示进度条 + 失败计数（`X/Y 完成, Z 失败`）
- 替换 `FILTER_CHIPS` 为动态 category tabs（来自 `categoryStats`，用 locale 翻译）
- 表格增加 category badge + tags 列
- 活跃 tab 按 category 筛选
- **空状态**：0 文件时显示"未扫描到文件，点击刷新重新扫描"

### 5d. `packages/ui/src/components/GalleryView.tsx`

- 新 props 同 DocumentsView
- 占位 tabs 替换为动态 category tabs
- "AI 分类" 按钮（`classifying` 时变为 "取消"，与 DocumentsView 共享 handler）
- GalleryItem 显示 category badge + tags

### 5e. `packages/ui/src/JavisWorkbench.tsx`

- 透传新 props 到 DocumentsView 和 GalleryView

### 5f. `packages/ui/src/components/Sidebar.tsx`

- 文档子项改为动态 category 列表（来自 `categoryStats`，用 locale 翻译）
- 图库子项同理
- computer 子项改为从 `mountRoots` 动态获取挂载根列表
- 新 props: `categoryStats?`, `mountRoots?`

### 5g. CSS

- 进度条、category badge、tag 样式
- 扫描中 / 分类中状态指示器

---

## 执行顺序 + 时间预估

| # | 步骤 | 文件 | 预估 |
|---|------|------|:--:|
| 1 | SKIP_DIRS + 深度限制 + 大小写 | `lib.rs` | 1.5h |
| 2 | `list_mount_roots` + `scan_all_user_files` + 进度 event + cancel | `lib.rs` | 2h |
| 3 | SQLite schema + repository + 测试 | `file-classification-persistence.ts` | 2h |
| 4 | Bridge `scanAllUserFiles` + `classifyDocuments` 改造 | `local-knowledge.ts` | 1.5h |
| 5 | `classifyWithFileAgent` 封装 | `app-runtime.ts` | 0.5h |
| 6 | State + 数据库初始化 + 扫描调度 + `handleClassifyDocuments`（全文最复杂步骤：5 useEffect、6 state、AbortController 生命周期、event 监听、SQLite 迁移、props 拆分） | `App.tsx` | 4-5h |
| 7 | Types 扩展 | `types.ts` | 0.5h |
| 8 | Locale 分类名映射 | `locale.ts` | 0.5h |
| 9 | DocumentsView 改造 | `DocumentsView.tsx` | 2h |
| 10 | GalleryView 改造 | `GalleryView.tsx` | 1.5h |
| 11 | Sidebar 动态分类 + 动态挂载根 | `Sidebar.tsx` | 1h |
| 12 | JavisWorkbench props 透传 | `JavisWorkbench.tsx` | 0.5h |
| 13 | CSS 样式 | `*.css` | 1h |
| **合计** | | | **~19-20h（约 2.5-3 天）** |

---

## 测试计划

### Rust 测试 (`lib.rs` `#[cfg(test)]` 模块)

| 测试 | 说明 |
|------|------|
| `test_skip_dirs_case_insensitive` | `Node_Modules` 和 `node_modules` 均被跳过 |
| `test_max_depth_limit` | depth=3 时不递归超过 3 层 |
| `test_list_mount_roots_non_empty` | Windows 返回 ≥1 个盘符，非 Windows 返回 `["/"]` |
| `test_scan_all_user_files_respects_max_results` | max_results=10 时最多返回 10 条 |
| `test_collect_files_default_depth` | 默认 `usize::MAX` 不影响现有行为 |

### TypeScript 测试

| 文件 | 测试内容 |
|------|---------|
| `file-classification-persistence.test.ts` | `replaceScanCache` 增量写入 + 旧记录清理；`getUnclassifiedFiles` 准确区分已/未分类；`upsertClassificationsBatch` 批量写入 + 覆盖更新；`cleanupOrphanClassifications` 清理无对应 scan_cache 的分类 |
| `local-knowledge.test.ts`（追加） | `classifyDocuments` 进度回调调用次数；`AbortSignal` 中止后抛 `AbortError`；逐批错误不阻断后续批次；`maxConcurrentBatches` 限流 |

---

## 错误状态 UI 设计

| 状态 | DocumentsView | GalleryView |
|------|:---:|:---:|
| 扫描中 | 刷新按钮 spinner + "正在扫描 N 个文件..." | 同左 |
| 扫描失败 | toast "扫描失败：<原因>" + 保留上次缓存数据 | 同左 |
| 扫描结果 0 文件 | "未发现文件，点击刷新重新扫描" | "未发现图片，点击刷新重新扫描" |
| 分类中 | 进度条 + 失败计数 + 取消按钮 | 分类按钮 disabled（显示"分类中..."） |
| 分类失败（全部批次） | toast "分类失败，请重试" | 同左 |
| SQLite 写入失败 | toast "保存失败：<原因>"，内存数据仍可用 | 同左 |

---

## 已知限制 & 后续优化

- **增量扫描**：当前方案每次刷新是全量扫描 + replace。5000 文件量级下可接受（几秒），后续可优化为比较 `modified_at` 增量更新。
- **图库缩略图**：GalleryItem 仍是首字母占位符，真实缩略图需要 Rust 端生成 base64 预览或 Tauri asset 协议。
- **分类结果过期**：文件被删除/移动后 `file_classifications` 变成孤儿数据，`cleanupOrphanClassifications` 可定期清理。
- **分类成本**：5000 文件 ÷ 50/批 = 100 次 LLM 调用，确认对话框 + `maxConcurrentBatches=2` 限流缓解。后续可加"仅分类未分类文件"增量策略。
- **分类并发防护**：`classifying` 状态锁 + 双视图按钮互斥已覆盖，不出现重复调用。

---

## 验证

```bash
pnpm check           # typecheck + vitest + rust check + rust test
pnpm dev             # 启动后等待 2s 后台扫描完成
```

手动验证：

| # | 操作 | 预期 |
|---|------|------|
| 1 | 切到文档视图 | 全盘扫描结果（不限于 Desktop/Documents/Downloads） |
| 2 | 切到图库视图 | 全盘图片结果（含 heic/raw/cr2/nef/tiff） |
| 3 | 点击"AI 分类" | 弹出确认对话框（文件数 + 预估 tokens） |
| 4 | 确认分类 | 进度条推进 → category badge + tags 出现在表格 |
| 5 | 分类中点击"取消" | 停止后续批次，已完成分类保留 |
| 6 | 点击 category tab | 筛选对应分类文件 |
| 7 | 侧栏"此电脑" | 显示实际盘符/挂载根（非硬编码 C: D:） |
| 8 | 重启应用 | 扫描结果 + 分类结果均保留（SQLite 持久化） |
| 9 | 0 文件环境 | DocumentsView 显示空状态，不报错 |
