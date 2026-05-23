# Javis 架构设计

## 设计目标

Javis 的核心是一个桌面优先的多模型、多 Agent 协作系统。系统应该能根据任务类型选择合适模型，把复杂目标拆成多个子任务，再交给不同 Agent 执行，最后由独立验证环节检查结果。

它不是一个单模型聊天壳，也不是一个只会调用工具的脚本集合。它应当具备：

- 图形化 Agent 编排和状态展示能力。
- 任务规划能力。
- 多模型路由能力。
- 多 Agent 协作能力。
- 本地工具调用能力。
- 结果验证能力。
- 权限控制能力。

## 技术路线

第一版技术栈：

```text
TypeScript + React + Tauri
```

职责划分：

- React：桌面 UI、Agent 图形化、聊天区、任务日志、确认弹窗。
- TypeScript：Agent Runtime、模型路由、任务编排、工具抽象、状态管理。
- Tauri：桌面壳、本地文件权限、系统命令、安全边界、原生能力桥接。
- Rust：只承担 Tauri 后端和必要的本地高权限能力，不作为 Agent 主语言。

## 总体结构

```text
User
  |
  v
Javis Desktop UI (React)
  |
  v
Javis Core (TypeScript)
  |
  +--> Commander Agent
  |
  +--> Model Router
  |
  +--> Task Planner
  |
  +--> Worker Agents
  |      |
  |      +--> File Agent
  |      +--> Browser Agent
  |      +--> Shell Agent
  |      +--> Code Agent
  |      +--> Research Agent
  |
  +--> Verifier Agent
  |
  +--> Tool Layer
  |      |
  |      +--> Tauri Commands
  |      +--> MCP Tools
  |      +--> opencode Backend
  |
  v
Result / Report / Confirmation
```

## 关键模块

### Desktop UI

Desktop UI 是第一版主入口，不是后补功能。

职责：

- 提供聊天输入。
- 参考 Codex 的工作台式布局，把对话、上下文、任务过程和工具输出分区展示。
- 展示 Agent 图形化节点和运行状态。
- 展示任务步骤、工具调用、日志和结果。
- 展示 dry-run 和用户确认项。
- 支持用户中止任务。

第一版 UI 不追求复杂视觉效果，但必须让用户清楚看到 Javis 正在做什么。具体布局见 [桌面布局设计](UI_LAYOUT.md)。

### Commander Agent

Commander 是主控 Agent，负责理解用户目标和协调任务。

职责：

- 判断用户意图。
- 拆分任务。
- 选择合适的 Worker Agent。
- 调用 Model Router 选择模型。
- 汇总 Worker 结果。
- 判断是否需要用户确认。
- 决定是否进入重试、降级或结束流程。

Commander 不应该直接承担所有执行工作，否则系统会退化成单 Agent。

### Model Router

Model Router 负责为不同任务选择不同模型。

可路由维度：

- 规划模型：擅长拆解复杂任务。
- 代码模型：擅长阅读、修改和解释代码。
- 长上下文模型：擅长处理大量文件和长文档。
- 快速模型：用于低成本分类、摘要和格式化。
- 视觉模型：用于截图、图片、界面状态理解。
- 本地模型：用于隐私敏感任务。

第一版可以先用规则路由，不急着引入复杂的自动评估系统。

### Worker Agents

Worker Agent 负责执行具体子任务。每个 Worker 只需要做好一类事情。

第一批 Worker：

- File Agent：文件搜索、读取、摘要、移动计划、重命名计划。
- Browser Agent：打开网页、搜索资料、提取页面内容。
- Shell Agent：执行命令、解释命令结果、处理失败日志。
- Code Agent：阅读代码、提出修改、运行测试、解释错误。
- Research Agent：多来源资料搜集、交叉验证、生成报告。

后续可扩展：

- App Agent：操作常用桌面应用。
- Memory Agent：管理本地记忆和偏好。
- Calendar Agent：处理日程和提醒。
- Device Agent：跨设备控制。

### Verifier Agent

Verifier 是独立验证环节，负责检查任务是否真的完成。

验证方式：

- 文件任务：检查文件是否存在、路径是否正确、内容是否符合要求。
- 命令任务：检查退出码、关键日志和输出产物。
- 研究任务：检查来源是否可访问，结论是否有来源支撑。
- 代码任务：检查测试是否运行，错误是否被解释。
- 高风险任务：检查是否已经获得用户确认。

Verifier 不负责执行主要任务，只负责判断结果可信度。

### Tool Layer

工具层为 Agent 提供稳定能力。

第一版工具：

- File Tool：列目录、搜索、读取、写入、移动、复制。
- Shell Tool：执行命令、捕获输出、限制危险命令。
- Web Tool：搜索、打开页面、提取文本、保存来源。
- Project Tool：识别项目类型、运行测试、读取配置。
- Code Tool：通过 opencode 执行代码阅读、修改建议和项目操作。

工具层必须区分安全等级：

- Read：只读操作，可直接执行。
- Preview：生成计划，不改动系统。
- Confirmed Write：需要用户确认后执行。
- Dangerous：默认禁止或要求更强确认。

## 任务生命周期

```text
1. 用户在桌面 UI 输入目标
2. Commander 识别任务类型和风险等级
3. Task Planner 生成步骤和成功标准
4. Model Router 为每个步骤选择模型
5. Worker Agents 执行子任务
6. Tool Layer 调用本地能力
7. UI 实时展示 Agent 状态和执行日志
8. Verifier 检查结果
9. Commander 汇总输出
10. 必要时请求用户确认或继续迭代
```

## 示例任务

### 本地文件任务

用户：

```text
帮我整理 Downloads 里的 PDF
```

流程：

1. File Agent 扫描 Downloads。
2. File Agent 根据文件名和内容生成分类。
3. Commander 生成整理计划。
4. Verifier 检查计划是否覆盖目标文件。
5. UI 展示 dry-run。
6. 用户确认后 File Agent 执行移动。
7. Verifier 检查移动结果。

### 研究任务

用户：

```text
搜集 MiniMax Mavis 和腾讯 Marvis 的信息，整理成报告
```

流程：

1. Research Agent 搜索公开资料。
2. Browser Agent 打开官方和可信媒体来源。
3. Research Agent 提取要点。
4. Verifier 检查结论是否有来源支撑。
5. Commander 输出报告。

### 代码任务

用户：

```text
帮我修复这个项目的测试失败
```

流程：

1. Project Tool 识别项目类型。
2. Shell Agent 运行测试。
3. Code Agent 调用 opencode 后端阅读失败日志和相关代码。
4. Code Agent 提出最小修改。
5. Shell Agent 重新运行测试。
6. Verifier 检查测试结果。

## 记忆设计

Javis 的记忆应当本地保存，并分层管理。

建议记忆类型：

- User Preference：用户偏好，例如语言、常用目录、确认习惯。
- Project Memory：项目路径、技术栈、常用命令。
- Task History：执行过的任务、结果、失败原因。
- Tool Permission：用户允许或拒绝过的工具能力。

第一版可以使用 SQLite 或本地 JSON 文件。不要一开始就设计复杂的向量数据库。

## 权限与安全

Javis 必须让用户知道它将要做什么。

默认规则：

- 只读操作可以直接执行。
- 写文件前要说明将写入什么。
- 移动、删除、覆盖、批量改名必须先 dry-run。
- 执行命令前要判断风险。
- 涉及隐私文件时优先使用本地模型。
- 用户可以中止正在执行的任务。

## 第一阶段里程碑

### Milestone 1：桌面骨架

目标：

- 建立 Tauri + React + TypeScript 项目。
- 实现参考 Codex 的桌面工作台布局。
- 实现聊天入口、Agent 状态面板和任务日志区域。

验证：

- 应用能在 Windows 上启动。
- 用户能输入一个目标。
- UI 能展示一条任务记录。
- UI 能同时展示对话、Agent 状态和任务日志。

### Milestone 2：核心接口

目标：

- 定义 Task、Agent、Tool、Model、VerificationResult。
- 实现一个只读 File Agent。
- 实现最小 Commander。

验证：

- 用户能请求扫描某个目录。
- 系统能列出执行步骤。
- 系统能输出任务结果。

### Milestone 3：多 Agent 协作

目标：

- 实现至少 File Agent、Shell Agent、Research Agent。
- 实现简单 Model Router。
- UI 能展示多个 Agent 的状态。

验证：

- 一个任务能拆给多个 Agent。
- 每个 Agent 的输出能被 Commander 汇总。

### Milestone 4：Verifier

目标：

- 引入独立验证环节。
- 为文件、命令、研究任务增加基础验证。

验证：

- 任务失败时能说清失败原因。
- 任务成功时能给出证据。

### Milestone 5：权限确认

目标：

- 为写入、移动、删除、命令执行增加风险等级。
- 实现 dry-run。
- UI 能展示批准、拒绝和中止按钮。

验证：

- 高风险操作不会静默执行。
- 用户能看到将要发生的改动。
