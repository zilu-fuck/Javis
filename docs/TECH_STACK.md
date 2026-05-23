# 技术栈决策

## 结论

Javis 第一版采用：

```text
TypeScript + React + Tauri
```

具体拆分：

- TypeScript：主业务语言，负责 Agent Runtime、模型路由、状态管理和工具抽象。
- React：桌面 UI，负责聊天界面、Agent 图形画布、任务日志、确认交互。
- Tauri：桌面容器，负责跨平台打包、本地文件权限、系统命令和原生能力桥接。
- Rust：Tauri 后端语言，只处理需要原生能力或安全边界的部分。

## 为什么这样选

### 桌面 UI 是主体验

Javis 的重点不是命令行，而是图形化 Agent：

- 用户要看到多个 Agent 如何协作。
- 用户要看到任务步骤和当前进度。
- 用户要批准、拒绝或中止高风险动作。
- 用户要能从日志回看 Javis 做过什么。

React 生态更适合快速做这类复杂交互。后续可以接入 React Flow 或类似 node-based UI 库来实现 Agent 图形画布。

### TypeScript 适合 Agent 应用

TypeScript 适合承担 Javis Core：

- 类型系统足够表达 Task、Agent、Tool、Model、VerificationResult。
- 前后端可以共享类型。
- AI SDK、LangGraph.js、opencode SDK、MCP TypeScript SDK 等生态衔接顺。
- 和 React/Tauri 的开发链路自然。

### Tauri 适合本地优先

Javis 会碰到文件、命令、应用启动和系统权限。Tauri 的优势是：

- 应用体积较轻。
- 权限边界清楚。
- 前端用 Web 技术，后端可用 Rust 接原生能力。
- 适合做本地优先的桌面应用。

## 技术分层

```text
apps/desktop
  React UI
  Agent Graph
  Task Timeline
  Confirmation UI

packages/core
  Commander
  Model Router
  Agent Runtime
  Verifier
  Shared Types

packages/tools
  File Tool
  Shell Tool
  Web Tool
  Project Tool
  MCP Adapter

apps/desktop/src-tauri
  Tauri Commands
  File System Bridge
  Process Bridge
  Permission Boundary
```

## 依赖方向

依赖应保持单向：

```text
Desktop App -> UI Components
Desktop App -> Core -> Tools -> Tauri Commands
```

规则：

- UI 不直接操作系统能力。
- UI 组件只接收 props 和事件回调，不直接依赖 Core 或 Tools。
- Agent 不直接调用 Tauri API，必须通过 Tool Layer。
- Tool Layer 负责权限分级和 dry-run。
- Tauri 后端只做原生桥接，不放 Agent 业务逻辑。

## opencode 的位置

opencode 不作为 Javis 的整体底层，而作为 Code Agent 的后端能力。

原因：

- opencode 擅长代码项目理解、编辑、命令执行和开发环境上下文。
- Javis 的范围更大，还包括文件、研究、浏览器、桌面应用和权限系统。
- 把 opencode 封装成 Code Tool，可以保留它的优势，也不会让整个系统被 coding agent 场景限制。

建议位置：

```text
Code Agent -> Code Tool -> opencode SDK / opencode server
```

## 暂缓引入

第一版先不急着引入：

- 复杂工作流引擎。
- 插件市场。
- 分布式 Agent。
- A2A。
- 向量数据库。

这些都可以后续加，但不应该妨碍第一版跑通桌面闭环。

## 可后续评估

后续可以按需要评估：

- LangGraph.js：当任务状态和重试流程复杂时引入。
- MCP：当工具数量增加时作为标准工具协议。
- React Flow：当 Agent 图形画布从状态展示升级为可编辑编排时引入。
- SQLite：当任务历史和本地记忆需要稳定持久化时引入。
- Python sidecar：当特定 AI、数据处理或本地模型能力更适合 Python 时再接入。
