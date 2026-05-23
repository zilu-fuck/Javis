# 工程结构

## 目标

Javis 第一版采用 `TypeScript + React + Tauri`，工程结构服务于三个目标：

1. 桌面 UI 优先，先把可用工作台做出来。
2. Agent Core 和本地工具层分开，避免 UI 直接操作系统。
3. 为未来接入 MCP、LangGraph.js、opencode 留位置，但第一阶段不提前复杂化。

## 推荐目录结构

```text
Javis/
  apps/
    desktop/
      src/
        app/
        components/
        features/
        hooks/
        styles/
        main.tsx
      src-tauri/
        src/
        capabilities/
        Cargo.toml
        tauri.conf.json
      package.json
      vite.config.ts
      tsconfig.json

  packages/
    core/
      src/
        agents/
        models/
        tasks/
        runtime/
        verification/
        index.ts
      package.json
      tsconfig.json

    tools/
      src/
        file/
        shell/
        web/
        project/
        permissions/
        index.ts
      package.json
      tsconfig.json

    ui/
      src/
        layout/
        primitives/
        agent-graph/
        task-log/
        index.ts
      package.json
      tsconfig.json

  docs/
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  eslint.config.js
  prettier.config.cjs
```

说明：

- `apps/desktop/src-tauri` 是 Tauri 默认后端目录。文档中简称 `src-tauri`。
- 第一阶段可以只创建必要空目录，避免为了目录完整而写无用代码。
- 如果脚手架工具生成的路径略有不同，优先保持 Tauri 官方结构，再把包职责映射过去。

## 模块职责

### `apps/desktop`

桌面应用入口，负责用户能看到和操作的一切。

- React 工作台布局：Sidebar、Main Thread、Agent Inspector、Activity Log。
- 接收用户输入，展示任务状态、Agent 状态、工具日志和确认卡片。
- 调用 `packages/core` 发起任务。
- 通过 Tauri bridge 接收本地能力结果。
- 不直接实现 Agent 业务逻辑。
- 不直接执行文件、命令、网络等高风险能力。

### `apps/desktop/src-tauri`

Tauri/Rust 本地桥接层，负责系统边界。

- 文件系统、进程、窗口、应用启动等原生能力。
- Tauri command 定义。
- Tauri permission/capability 配置。
- 对危险能力做最低层限制。
- 不写 Commander、Agent、模型路由等业务逻辑。

### `packages/core`

Javis 的 Agent Runtime 和任务编排核心。

- `Commander`：理解目标、拆分任务、调度 Agent。
- `Model Router`：根据任务类型选择模型。
- `Agent Runtime`：执行 Agent 生命周期和状态流转。
- `Verifier`：检查任务是否完成。
- 核心类型：`Task`、`Agent`、`ToolCall`、`ModelProfile`、`VerificationResult`。
- 不直接调用 Tauri API，所有本地能力通过 `packages/tools`。

### `packages/tools`

统一工具层，给 Agent 提供可控能力。

- `File Tool`：搜索、读取、写入计划、移动计划。
- `Shell Tool`：命令执行、输出捕获、风险标记。
- `Web Tool`：搜索、网页读取、来源记录。
- `Project Tool`：识别项目类型、测试命令、配置文件。
- `Permission`：dry-run、确认请求、风险等级。
- 未来可接 MCP server/client。
- 未来可把 opencode 包成 `Code Tool`。

### `packages/ui`

可复用 UI 组件，不承载业务决策。

- 布局组件。
- 按钮、输入框、面板、标签、状态徽标等基础组件。
- Agent Graph 的只读展示组件。
- Task Log、Tool Call、Confirmation Card 等任务组件。
- 不直接调用模型、工具或 Tauri command。

## 依赖方向

保持单向依赖：

```text
apps/desktop -> packages/ui
apps/desktop -> packages/core -> packages/tools -> Tauri commands
```

规则：

- `packages/core` 可以依赖 `packages/tools` 的接口，但不要依赖 React。
- `packages/tools` 不依赖 `packages/core` 的运行时，只共享必要类型。
- `packages/ui` 不依赖 `packages/tools`，UI 通过 props 展示状态。
- `packages/ui` 不直接依赖 `packages/core`，需要的类型由 `apps/desktop` 适配后传入。
- `src-tauri` 不依赖 TypeScript 包，它只暴露安全的原生命令。
- 跨包共享类型优先放在 `packages/core`，如果后续变多，再拆 `packages/shared`。

## 命名约定

- 包名：`@javis/core`、`@javis/tools`、`@javis/ui`。
- React 组件：`PascalCase`，例如 `AgentInspector.tsx`。
- hooks：`use` 开头，例如 `useTaskRun.ts`。
- TypeScript 文件：普通模块用 `kebab-case.ts`，组件文件用 `PascalCase.tsx`。
- Agent 类或工厂：`FileAgent`、`ResearchAgent`、`createCommander`。
- Tool 类或工厂：`FileTool`、`ShellTool`、`createFileTool`。
- 类型命名：`TaskRun`、`AgentStatus`、`PermissionRequest`。
- 测试文件：`*.test.ts` 或 `*.test.tsx`。

## 配置文件建议

根目录：

- `package.json`：统一 scripts。
- `pnpm-workspace.yaml`：管理 workspace。
- `tsconfig.base.json`：统一 TS 编译规则。
- `eslint.config.js`：统一 lint 规则。
- `prettier.config.cjs`：统一格式化规则。

`apps/desktop`：

- `vite.config.ts`：React/Vite 构建。
- `tsconfig.json`：继承根配置。
- `src-tauri/tauri.conf.json`：Tauri 应用配置。
- `src-tauri/capabilities/*.json`：Tauri 权限配置。

每个 package：

- `package.json`：包名、入口、测试脚本。
- `tsconfig.json`：继承根配置，限制输出范围。

建议脚本：

```json
{
  "scripts": {
    "dev": "pnpm --filter @javis/desktop tauri dev",
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "lint": "pnpm -r lint",
    "typecheck": "pnpm -r typecheck"
  }
}
```

## 测试策略

第一阶段只做必要测试，不追求测试框架大全。

- `packages/core`：重点单测任务拆分、Agent 状态流转、Verifier 判断。
- `packages/tools`：重点单测权限分级、dry-run 结果、命令风险判断。
- `packages/ui`：只测关键组件渲染和确认卡片交互。
- `apps/desktop`：先做手动冒烟测试，后续再引入端到端测试。
- `src-tauri`：第一阶段以少量 Rust 单测和手动验证为主。

建议工具：

- TypeScript 单测：`Vitest`。
- React 组件测试：`@testing-library/react`。
- 端到端测试：暂缓，等主流程稳定后再加 Playwright。

每个核心任务至少要能回答三件事：

1. 输入是什么。
2. 预期状态流转是什么。
3. 如何证明任务完成或失败。

## 第一阶段脚手架步骤

1. 初始化 Git 和包管理。
   - 验证：`git status` 正常，`pnpm -v` 可用。

2. 创建 Tauri + React + TypeScript 桌面应用。
   - 建议路径：`apps/desktop`。
   - 验证：`pnpm dev` 能启动空桌面窗口。

3. 创建 workspace 包。
   - `packages/core`
   - `packages/tools`
   - `packages/ui`
   - 验证：各包能被 `apps/desktop` import。

4. 建立基础类型。
   - `Task`
   - `Agent`
   - `AgentStatus`
   - `ToolCall`
   - `PermissionRequest`
   - `VerificationResult`
   - 验证：`pnpm typecheck` 通过。

5. 做 Codex 风格主界面骨架。
   - Sidebar
   - Main Thread
   - Agent Inspector
   - Activity Log
   - 验证：桌面窗口中四个区域稳定显示。

6. 接入最小任务闭环。
   - 用户输入目标。
   - Commander 生成一条任务记录。
   - UI 展示任务状态和日志。
   - 验证：无需真实模型也能跑通 mock task。

7. 接入第一个只读工具。
   - 优先选择目录扫描或文件搜索。
   - 验证：只读任务能显示真实文件路径和执行日志。

## 暂不引入

第一阶段先不引入这些复杂设施：

- 插件市场。
- 多仓库发布流程。
- 复杂 monorepo 构建缓存。
- 分布式 Agent Runtime。
- A2A。
- 完整 MCP 工具市场。
- LangGraph.js 深度工作流。
- 向量数据库。
- 多窗口系统。
- 自动更新系统。
- 复杂主题系统。

这些能力都可以后续加入，但不应该影响第一版把桌面 UI、Agent 状态、工具调用和权限确认跑通。
