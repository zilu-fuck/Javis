# Javis 项目介绍

## 项目概述

Javis 是一个本地优先的桌面多 Agent 助手原型，基于 TypeScript、React、Tauri 和 Rust 构建。它的目标不是做一个黑箱式聊天工具，而是提供一个可见、可审计、可确认的任务工作台，让用户能够把研究、项目检查、文件整理和代码修改等任务交给 Agent，同时清楚看到每一步发生了什么。

项目当前围绕一条明确的任务闭环设计：

```text
用户目标 -> Commander 规划 -> Worker 工具执行 -> Verifier 验证 -> 桌面 UI 展示结果
```

Javis 强调本地文件和进程访问的安全边界。读取类任务可以直接执行并记录结果；涉及写入、移动文件或修改代码的高风险操作，需要先生成预览或 dry-run 计划，再等待用户在界面中明确批准。

## 项目定位

Javis 面向需要在本地项目中完成复杂工作的用户，尤其是开发者、研究型用户和需要处理本地资料的人。它希望解决三个核心问题：

1. 让 Agent 的工作过程可见，而不是只返回一个最终答案。
2. 让本地文件写入和命令执行受控，而不是把权限一次性全部交出去。
3. 让任务结果可验证，包括来源、执行记录、失败原因和后续恢复路径。

因此，Javis 更接近一个桌面工作台，而不是单纯的聊天窗口。它把计划、执行、确认、日志、Agent 状态和验证结果都放在同一个界面中。

## 核心能力

### 桌面工作台

Javis 已实现桌面端基础工作台，包括侧边栏、主任务线程、Agent 检查面板、活动日志、输入区和确认卡片。用户可以看到任务处于规划、运行、等待确认、验证、完成或失败等状态。

### 本地文件扫描

项目支持通过 Tauri 原生命令扫描工作区中的 Markdown 文档，并生成文档摘要。扫描结果会记录路径、修改时间、大小和用途说明，并由验证器检查结果字段是否完整。

### 项目检查

Javis 可以读取项目的 `package.json` 和锁文件，识别包管理器、推荐启动命令和检查命令，并运行允许列表中的只读检查。例如：

- `node --version`
- `pnpm --version`
- `git status --short`
- 项目中声明的 check/test 类脚本

这让用户可以快速了解一个项目如何启动、如何验证，以及当前仓库状态是否干净。

### 资料研究与报告

Javis 支持基于用户提供 URL 的资料收集和报告生成。Research Agent 会抓取公开来源，生成带来源依据的报告，并明确标记未知或未验证的信息。

搜索型研究能力已经接入 `github-cli` 和 Agent Chrome fallback 路径，但完整产品级 QA 仍在推进中。

### PDF 整理 dry-run

Javis 的 PDF 整理流程展示了项目的安全模型：

1. 扫描 `Downloads` 中的 PDF 文件。
2. 生成移动计划，列出源路径、目标路径、动作和冲突。
3. 在界面中展示确认卡片。
4. 用户批准后，才执行已批准计划中的移动操作。
5. 执行后报告成功、跳过和失败的文件。

该流程限制移动范围、文件类型和目标路径，并使用一次性 approval id 防止 dry-run 被篡改后继续执行。

### Code Agent 初步能力

项目已开始接入 opencode 支持的 Code Agent 流程。当前能力包括：

- 将代码审查类目标路由到 Code Agent scaffold。
- 列出变更文件。
- 展示 diff 预览。
- 运行只读验证，例如 `git diff --check`。
- 请求 opencode 生成 JSON patch proposal。
- 在用户批准后，通过 Javis 本地 confirmed-write 后端应用补丁。

这一能力仍属于产品完成阶段的重点工作。实时 provider 路径还需要进一步稳定，确保真实模型调用可以可靠返回可解析的 patch proposal。

## 架构设计

Javis 采用分层架构，核心原则是 UI、任务编排、工具契约和原生能力边界分离。

```text
apps/desktop -> packages/ui
apps/desktop -> packages/core -> packages/tools
apps/desktop -> src-tauri commands
```

### `apps/desktop`

负责 Tauri 桌面壳、React 应用挂载、原生命令注入和桌面构建配置。它把 Rust/Tauri 命令适配成 Core 所需的工具接口。

### `packages/core`

负责任务路由、计划生成、Agent 快照、权限流和验证摘要。当前已包含文档扫描、项目检查、研究报告、PDF dry-run 和 Code Agent scaffold 等核心流程。

### `packages/tools`

负责共享工具契约和纯 helper 逻辑。它不直接调用 Tauri 或 Node 进程 API，避免工具定义和具体执行环境耦合。

### `packages/ui`

负责可复用的 React 工作台组件。UI 组件通过 props 接收数据和回调，不直接调用 Tauri 命令或工具。

### `apps/desktop/src-tauri`

负责原生文件系统、进程和 HTTP 桥接命令，并在 Rust 层执行低层安全检查。

## 技术栈

| 层级 | 技术 | 职责 |
| --- | --- | --- |
| 桌面 UI | React、TypeScript、Vite | 工作台界面、任务输入、状态展示、确认操作 |
| Core Runtime | TypeScript | 路由、计划、Agent 状态、权限流、验证摘要 |
| Tool Contracts | TypeScript | 文件、Shell、Web、项目、权限和报告类型 |
| Native Bridge | Tauri、Rust | 文件系统访问、进程检查、HTTP fetch、安全边界 |
| Code Proposal Backend | opencode CLI | 生成 patch proposal，实际写入仍由 Javis 审批执行 |
| 测试 | Vitest、Cargo test | TypeScript 行为测试和 Rust 原生命令安全测试 |

## 当前状态

Javis 已完成可验证 MVP 基线，并正在向完整可用桌面产品推进。

已实现的基础能力包括：

- 桌面工作台布局和任务状态展示。
- Markdown 文档扫描和摘要。
- 项目检查与允许列表命令执行。
- URL 来源收集和带来源报告。
- PDF 整理 dry-run、确认、执行和验证。
- 本地任务历史的初步保存、恢复和删除。
- 工作区选择和最近工作区恢复。
- Code Agent 的初步 Core/UI scaffold 与 opencode proposal 路径。

仍需完善的产品级能力包括：

- Code Agent 真实 provider 路径的稳定 QA。
- API key 从 local storage 迁移到操作系统凭据存储。
- 更完整的任务历史持久化和迁移验证。
- 将 confirmed-write 权限模型推广到所有写入类工具。
- 更完整的失败恢复和替代路径。
- 签名、版本化、可回滚的发布流程。

## 安全模型

Javis 将工具操作分为几个权限等级：

| 等级 | 含义 |
| --- | --- |
| `read` | 只读操作，可以立即执行并记录结果 |
| `preview` | 生成计划或 dry-run，不改变本地状态 |
| `confirmed_write` | 必须有当前任务中的显式批准 |
| `dangerous` | 第一版默认拒绝 |

这种模型的重点是让用户先看到将要发生的事，再决定是否允许执行。高风险操作必须有 UI 中的确认记录，也必须有原生层的审批状态检查。

## 本地运行

项目使用 pnpm workspace 管理。

安装依赖：

```sh
pnpm install
```

运行 Tauri 桌面应用：

```sh
pnpm dev
```

运行前端 Vite 预览：

```sh
pnpm --filter @javis/desktop dev
```

执行完整本地检查：

```sh
pnpm check
```

常用单项检查：

```sh
pnpm typecheck
pnpm --filter @javis/desktop build
pnpm rust:check
pnpm rust:test
```

## 仓库结构

```text
apps/desktop          Tauri + React 桌面应用
packages/core         任务运行时、编排、权限流和验证
packages/tools        工具契约和共享 helper
packages/ui           可复用工作台 UI 组件
docs                  产品、架构、安全、QA 和开发文档
```

## 适用场景

Javis 当前适合以下场景：

- 快速理解一个本地项目的结构、启动方式和检查方式。
- 扫描并总结工作区中的 Markdown 文档。
- 基于公开 URL 收集资料并生成有来源依据的报告。
- 对本地文件整理类任务先生成预览，再确认执行。
- 在明确审批边界下探索代码修改 Agent 的工作流。

它暂时不适合把完整文件系统写入权限交给 Agent 自主处理，也不应被当作已经完成安全加固的生产级自动化平台。

## 路线图概览

项目下一阶段重点是从已验证 MVP 走向完整产品可用：

1. 稳定 opencode-backed Code Agent 的真实 provider proposal/apply 流程。
2. 强化本地持久化，包括任务历史、重启恢复和未来迁移。
3. 将 confirmed-write 权限模型推广到所有写入类工具。
4. 扩展完整产品工作流 QA，而不只覆盖 MVP 场景。
5. 完善发布签名、版本记录和回滚说明。

## 总结

Javis 的核心价值是把 Agent 的能力放进一个可观察、可批准、可验证的本地桌面环境中。它一方面追求多 Agent 协作带来的效率，另一方面又保留对本地文件、命令和写入操作的明确控制。

当前项目已经具备清晰的 MVP 基础和较完整的工程边界。后续工作的重点不在于堆叠更多功能，而在于把 Code Agent、持久化、权限模型和发布流程打磨到可以支撑日常使用的稳定程度。
