# Proma 项目学习笔记

仓库位置：`E:\Javis\study\Proma`

克隆来源：`https://github.com/ErlichLiu/Proma.git`

当前提交：`ae25a54 feat: 用本机默认 App 打开文件（预览面板 + 三点菜单） (#582)`

## 1. 项目定位

Proma 是一个本地优先的 AI 桌面应用。它不是单纯 Chat UI，而是把多模型 Chat、Agent 工作台、工作区、Skills、MCP、记忆、远程机器人和桌面能力整合在一个 Electron 客户端里。

核心产品判断：

- 简单问题走 Chat。
- 涉及本地文件、工具、长期上下文、多步骤交付的任务走 Agent。
- 数据默认落在 `~/.proma/`，以 JSON / JSONL 为主，不使用本地数据库。
- 每个 Agent 工作区有自己的 MCP、Skills、workspace-files。

## 2. 技术栈

- Monorepo：Bun workspaces。
- 桌面：Electron 39。
- 前端：React 18 + TypeScript。
- 状态：Jotai。
- 样式：Tailwind CSS + Radix UI。
- 富文本输入：TipTap。
- Markdown：react-markdown + Mermaid + KaTeX。
- 代码高亮：Shiki。
- Chat 模型适配：`@proma/core` Provider Adapter。
- Agent：`@anthropic-ai/claude-agent-sdk`。
- 打包：esbuild + Vite + electron-builder。

## 3. 顶层目录

```text
Proma/
├── apps/electron/        Electron 桌面应用主体
├── packages/shared/      共享类型、IPC 常量、配置、工具函数
├── packages/core/        AI Provider 适配器、SSE、Shiki
├── packages/ui/          共享 React UI 组件
├── docs/                 设计文档和截图
├── tutorial/             用户教程
├── release-notes/        版本说明
└── proma-thinking/       产品思考文档
```

文件规模快照：

- 总文件数：795。
- TypeScript：220 个 `.ts`。
- React：187 个 `.tsx`。
- 主要代码集中在 `apps/electron/`。

## 4. 运行和构建入口

根目录 `package.json` 提供 workspace 级命令：

```bash
bun install
bun run dev
bun run electron:build
bun run electron:start
bun run typecheck
bun test
```

Electron 子应用命令在 `apps/electron/package.json`：

```bash
bun run dev:vite
bun run dev:electron
bun run build:main
bun run build:preload
bun run build:renderer
bun run dist:fast
```

本机当前未检测到 `bun` 命令，且仓库刚克隆后没有 `node_modules`，所以这次没有运行测试或构建。

## 5. 最核心的架构链路

Proma 最重要的工程链路是：

```text
packages/shared 定义类型和 IPC 常量
  -> apps/electron/src/main/ipc.ts 注册 ipcMain handler
  -> apps/electron/src/preload/index.ts 暴露 window.electronAPI
  -> renderer 的 Jotai atoms / React components 调用 API
  -> main/lib 服务层执行业务逻辑
```

理解这个链路后，大部分功能都可以沿着“类型 -> IPC -> preload -> UI -> 服务”来读。

## 6. 主进程结构

入口文件：

- `apps/electron/src/main/index.ts`

入口职责：

- 设置 dev/prod 独立 userData。
- 注册单实例锁。
- 注册 `proma-file://` 本地文件协议。
- 创建主窗口、托盘、菜单、快捷键。
- 初始化 runtime、默认 skills、workspace watcher、chat tools watcher。
- 启动/停止 Feishu、DingTalk、WeChat bridge。
- 应用退出时停止 Chat 和 Agent 流。

主进程服务集中在：

- `apps/electron/src/main/lib/`

重要服务：

- `agent-orchestrator.ts`：Agent 编排核心。
- `agent-service.ts`：Agent IPC 薄包装和 EventBus 转发。
- `agent-session-manager.ts`：Agent 会话索引、JSONL 持久化、fork/rewind/search。
- `agent-workspace-manager.ts`：工作区、MCP、Skills、workspace-files。
- `agent-permission-service.ts`：权限请求、工具安全规则、用户审批。
- `chat-service.ts`：Chat 流式调用、工具调用循环、消息持久化。
- `conversation-manager.ts`：Chat 会话索引、JSONL 消息。
- `channel-manager.ts`：AI 渠道 CRUD、API Key 加密、连接测试、模型拉取。
- `storage-service.ts`：本地存储统计和清理。
- `config-paths.ts`：`~/.proma/` 下各类路径定义。
- `feishu-bridge.ts` / `dingtalk-bridge.ts` / `wechat-bridge.ts`：远程机器人桥接。

## 7. 渲染进程结构

入口文件：

- `apps/electron/src/renderer/main.tsx`
- `apps/electron/src/renderer/App.tsx`

`main.tsx` 做全局初始化：

- Theme。
- Agent 设置。
- 通知。
- UI 偏好。
- Markdown 字号。
- 全局 Chat listener。
- 全局 Agent listener。
- 各种 IPC 状态同步。

主界面布局：

- `components/app-shell/AppShell.tsx`

布局是三栏：

```text
LeftSidebar | MainArea(TabBar + TabContent) | RightSidePanel
```

Tab 内容分发在：

- `components/tabs/TabContent.tsx`

它根据 tab 类型渲染：

- Chat：`components/chat/ChatView.tsx`
- Agent：`components/agent/AgentView.tsx`
- Scratch：`components/scratch-pad/ScratchPadView.tsx`

## 8. 状态管理

Proma 明确使用 Jotai。

核心 atoms：

- `atoms/chat-atoms.ts`：渠道、对话、流式状态、上下文长度、附件、草稿。
- `atoms/agent-atoms.ts`：Agent 会话、工作区、流式状态、工具活动、权限请求、文件面板、diff 状态。
- `atoms/tab-atoms.ts`：多标签页。
- `atoms/theme.ts`：主题模式。
- `atoms/notifications.ts`：桌面通知。
- `atoms/preview-atoms.ts`：文件预览面板。
- `atoms/chat-tool-atoms.ts`：Chat 工具状态。

两个关键全局监听器：

- `hooks/useGlobalChatListeners.ts`
- `hooks/useGlobalAgentListeners.ts`

它们在应用顶层挂载，避免切换页面时丢失流式事件、权限请求或后台任务状态。

## 9. Chat 流程

核心文件：

- `apps/electron/src/main/lib/chat-service.ts`
- `packages/core/src/providers/`

发送消息流程：

1. UI 调用 `window.electronAPI.sendMessage()`。
2. preload 通过 `ipcRenderer.invoke(CHAT_IPC_CHANNELS.SEND_MESSAGE)` 进入主进程。
3. `chat-service.ts` 查找渠道并解密 API Key。
4. 从 `conversation-manager.ts` 读取历史消息。
5. 把用户消息追加到 JSONL。
6. 根据上下文分隔线和轮数裁剪历史。
7. 文档附件转成 `<file>` 文本块，图片附件转 base64。
8. `@proma/core` 根据 provider 选择 adapter。
9. `streamSSE()` 读取流式响应。
10. 如模型触发工具调用，执行 `chat-tool-executor.ts`，再把 tool result 续接给模型。
11. 完成后保存 assistant 消息，向 renderer 发 `STREAM_COMPLETE`。

Provider Adapter 支持：

- Anthropic 协议。
- OpenAI 兼容协议。
- Google Gemini。
- DeepSeek、Kimi、MiniMax 等通过 Anthropic 或 OpenAI 兼容分支复用。

## 10. Agent 流程

核心文件：

- `apps/electron/src/main/lib/agent-service.ts`
- `apps/electron/src/main/lib/agent-orchestrator.ts`
- `apps/electron/src/main/lib/adapters/claude-agent-adapter.ts`

发送 Agent 消息流程：

1. UI 调用 `window.electronAPI.sendAgentMessage()`。
2. `agent-service.ts` 注册 sessionId 到 webContents 的映射。
3. 业务交给 `AgentOrchestrator.sendMessage()`。
4. Orchestrator 做并发保护、环境检查、渠道检查、API Key 解密。
5. 构造 SDK 环境变量，清理宿主 `ANTHROPIC_*` 干扰。
6. 确定工作区 cwd：通常是 `~/.proma/agent-workspaces/{slug}/{sessionId}`。
7. 加载工作区 MCP、记忆 MCP、生图 MCP、自定义 MCP。
8. 生成动态 prompt，注入工作区、Skills、MCP、引用会话等上下文。
9. 根据权限模式创建 `canUseTool` 回调。
10. 调用 Claude Agent SDK adapter 的 `query()`。
11. 逐条接收 SDKMessage，写入 JSONL，并通过 EventBus 推给 renderer。
12. 处理自动标题、重试、thinking signature recovery、session resume、plan mode、ask user、权限审批。

Agent 权限模式：

- `bypassPermissions`：尽量自动放行。
- `auto`：安全工具自动放行，危险操作走审批。
- `plan`：只允许调研/计划，写操作等到计划审批后再执行。

## 11. 数据存储模型

Proma 不使用本地数据库。README 描述的存储结构大致是：

```text
~/.proma/
├── channels.json
├── conversations.json
├── conversations/{conversation-id}.jsonl
├── agent-sessions.json
├── agent-sessions/{session-id}.jsonl
├── agent-workspaces/{workspace-slug}/
│   ├── workspace-files/
│   ├── mcp.json
│   └── skills/
├── attachments/
├── user-profile.json
├── settings.json
└── sdk-config/
```

特点：

- 索引用 JSON。
- 消息流用 JSONL append-only。
- API Key 通过 Electron `safeStorage` 加密。
- Skills/MCP 按工作区隔离。
- Agent session cwd 与 workspace-files 分离。

## 12. Skills 和 MCP

工作区能力由 `agent-workspace-manager.ts` 管理：

- 创建/删除/重排工作区。
- 读取/保存 `mcp.json`。
- 扫描 `skills/`。
- 复制默认 skills。
- 从其他工作区导入 Skill。
- 读写 Skill 文件树。
- 维护 workspace attached directories/files。

Agent 运行时，Orchestrator 会把启用的 MCP server 组装进 SDK query options，并把 workspace plugin path 传给 SDK。

## 13. 打包重点

`@anthropic-ai/claude-agent-sdk` 被 esbuild 标记为 external，因为它带平台 native binary。

相关位置：

- `apps/electron/package.json`
- `apps/electron/electron-builder.yml`
- `apps/electron/src/main/lib/agent-orchestrator.ts`

打包时要确保：

- 主进程 build 保持 `--external:@anthropic-ai/claude-agent-sdk`。
- `optionalDependencies` 包含目标平台 SDK 子包。
- electron-builder files 包含 SDK 主包和平台子包。

## 14. 测试现状

仓库里能看到的测试较少，集中在：

- `packages/shared/src/utils/capabilities-diff.test.ts`
- `apps/electron/src/renderer/lib/markdown-rich-text.test.ts`
- `apps/electron/src/renderer/lib/dock-badge-count.test.ts`

测试框架是 Bun 内置测试：`import { test, expect, describe } from 'bun:test'`。

## 15. 建议学习路线

第一轮：跑通产品和结构。

1. 读 `README.en.md` 和 `tutorial/tutorial.md`，建立产品概念。
2. 读根 `package.json` 和 `apps/electron/package.json`，理解怎么启动、构建、打包。
3. 读 `apps/electron/src/main/index.ts`，理解 Electron 生命周期。
4. 读 `apps/electron/src/preload/index.ts`，理解暴露给前端的 API 面。

第二轮：掌握 IPC 和数据流。

1. 从 `packages/shared/src/types/chat.ts` 和 `agent.ts` 看类型与 IPC 常量。
2. 对照 `apps/electron/src/main/ipc.ts` 看 handler 注册。
3. 对照 `preload/index.ts` 看 `window.electronAPI`。
4. 在 renderer 里搜某个 API 调用，串起 UI -> preload -> main -> service。

第三轮：读 Chat。

1. `chat-service.ts`
2. `conversation-manager.ts`
3. `packages/core/src/providers/types.ts`
4. `packages/core/src/providers/sse-reader.ts`
5. `openai-adapter.ts` / `anthropic-adapter.ts` / `google-adapter.ts`

第四轮：读 Agent。

1. `agent-service.ts`
2. `agent-orchestrator.ts`
3. `adapters/claude-agent-adapter.ts`
4. `agent-session-manager.ts`
5. `agent-permission-service.ts`
6. `agent-workspace-manager.ts`
7. `hooks/useGlobalAgentListeners.ts`
8. `components/agent/AgentView.tsx`

第五轮：读 UI 和状态。

1. `App.tsx`
2. `AppShell.tsx`
3. `TabContent.tsx`
4. `chat-atoms.ts`
5. `agent-atoms.ts`
6. `ChatView.tsx`
7. `AgentView.tsx`

第六轮：读扩展能力。

1. 远程机器人：`feishu-bridge.ts`、`dingtalk-bridge.ts`、`wechat-bridge.ts`
2. 记忆：`memory-service.ts`、`memos-client.ts`
3. 文档解析：`document-parser.ts`
4. Proactive 设计：`docs/proactive-scheduler-monitor-design.md`

## 16. 改代码时的项目规则

项目自己的 AGENTS.md 里有几个重要约束：

- 使用 Bun，不混用 npm/pnpm lockfile。
- 状态管理统一用 Jotai。
- 本地存储优先，配置文件优先，不引入本地数据库。
- TypeScript 不使用 `any`，对象结构优先 `interface`。
- 注释和日志优先中文。
- 新增 IPC 要同步更新 shared 类型、main handler、preload bridge、renderer 调用。
- 行为变化需要 bump 相关包 patch version。
- 尽量补聚焦测试，尤其是 shared logic、IPC contract、持久化格式。

## 17. 当前学习结论

Proma 的复杂度主要不在 UI，而在“流式 Agent 工作流 + 本地持久化 + 权限审批 + 工作区能力注入”。如果要快速切入贡献，最稳的入口是小范围功能：

- 修 shared 工具函数和测试。
- 修 Chat 渲染或 markdown/rich-text。
- 修设置页表单。
- 增加某个 provider 的模型拉取逻辑。

如果要理解项目核心价值，就从 Agent 编排开始。`agent-orchestrator.ts` 是这套系统的心脏，`useGlobalAgentListeners.ts` 是前端保持后台任务连续性的关键。
