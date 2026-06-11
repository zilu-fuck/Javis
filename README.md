# Javis

## 中文

Javis 是一个桌面优先的多 Agent 助手原型，基于 TypeScript、React 和 Tauri 构建。项目关注一个可见、可审计的任务循环：

```text
用户目标 -> Commander 计划 -> worker 工具 -> verifier 校验 -> 桌面 UI 结果
```

当前项目目标是做成一个完整可用的桌面产品。已经验证过的 MVP workbench 是基础，不是终点。Javis 保持 local-first，并且对文件系统写入采取保守策略：高风险操作必须先生成 dry-run 计划，并等待用户明确批准后才能执行。

### 当前状态

已实现的基础能力：

- 桌面 workbench 布局，包括侧边栏、主会话、Agent inspector、活动记录和确认区域。
- 只读 Markdown 文档扫描，支持摘要和验证。
- 项目检查能力，可检测 package scripts、推荐启动/检查命令，并运行 allowlist 内的只读检查。
- 基于 URL 的研究资料收集，输出带来源的报告，并明确标注未知或未验证的信息。
- `Downloads` PDF 整理 dry-run、确认卡片、批准后的移动执行、冲突跳过和执行验证。

当前产品就绪缺口：

- Search-backed research 已通过 `github-cli` 和 Agent Chrome fallback 接入，但产品 QA 证据仍不完整。
- Code Agent / opencode 尚未集成。
- 已完成、失败和取消的任务历史会在本地保存，并支持侧边栏恢复和删除；更完整的持久化 QA 仍需补齐。
- Workspace 选择和最近 workspace 恢复已经实现；更广的持久化 QA、发布签名/版本管理、写工具权限强制执行仍需加固。
- Core runtime 正在拆分为更聚焦的模块。Agent definitions、plans、route detection 和 research report helpers 已抽出；主 runtime flow 仍在 `packages/core/src/index.ts` 中。

更多信息见 [Product Readiness](docs/PRODUCT_READINESS.md) 和 [MVP Status](docs/MVP_STATUS.md)。

### 环境要求

- Node.js 和 pnpm
- Rust toolchain
- Windows 是当前 Tauri 桌面构建的主要目标平台

### 快速开始

安装依赖：

```sh
pnpm install
```

运行 Tauri 桌面应用：

```sh
pnpm dev
```

运行仅前端的 Vite 预览：

```sh
pnpm --filter @javis/desktop dev
```

### 验证

运行完整本地检查：

```sh
pnpm check
```

单项检查：

```sh
pnpm typecheck
pnpm --filter @javis/desktop build
pnpm rust:check
pnpm rust:test
```

### 仓库结构

```text
apps/desktop          Tauri + React 桌面外壳
packages/core         任务 runtime、计划、Agent 状态和验证
packages/tools        工具契约和共享工具结果类型
packages/ui           可复用的 workbench UI 组件
docs                  产品、架构、安全和状态文档
```

### 安全模型

Javis 将预览动作和写入动作分开：

- `read`：可以立即执行，并且必须记录结果。
- `preview`：创建计划或 dry-run，不改变本地状态。
- `confirmed_write`：需要当前明确的权限请求。
- `dangerous`：首个版本默认拒绝。

PDF 整理流程展示了这个模型：它会先列出源路径和目标路径，标记冲突，等待批准，然后只移动已批准 dry-run 计划中的文件。

### 文档

- [文档索引](docs/README.md)
- [开发指南](docs/DEVELOPMENT.md)
- [故障排查](docs/TROUBLESHOOTING.md)
- [产品就绪状态](docs/PRODUCT_READINESS.md)
- [MVP 状态](docs/MVP_STATUS.md)
- [安全模型](docs/SECURITY_MODEL.md)
- [手动 QA 清单](docs/QA_CHECKLIST.md)
- [发布指南](docs/RELEASE.md)
- [路线图](docs/ROADMAP.md)
- [贡献指南](CONTRIBUTING.md)

## English

Javis is a desktop-first multi-agent assistant prototype built with TypeScript, React, and Tauri. The project focuses on a visible, auditable task loop:

```text
user goal -> Commander plan -> worker tools -> verifier -> desktop UI result
```

The current project goal is a complete usable desktop product. The verified MVP workbench is the foundation, not the finish line. Javis remains local-first and conservative around filesystem writes: high-risk actions must create a dry-run plan and wait for explicit user approval before execution.

### Current Status

Implemented foundation:

- Desktop workbench layout with sidebar, main thread, agent inspector, and activity / confirmations area.
- Read-only Markdown document scan with summaries and verification.
- Project inspection that detects package scripts, recommends start/check commands, and runs allowlisted read-only checks.
- URL-based research collection with a source-backed report and explicit unknown/unverified notes.
- PDF organization dry-run for `Downloads`, confirmation cards, approved move execution, conflict skipping, and execution verification.

Current product-readiness gaps:

- Search-backed research is wired through `github-cli` and Agent Chrome fallback; product QA evidence is still incomplete.
- Code Agent / opencode is not integrated yet.
- Completed, failed, and cancelled task history is stored locally with sidebar restore and deletion; broader persistence QA is still needed.
- Workspace selection and recent workspace restore are implemented; broader persistence QA, release signing/versioning, and write-tool permission enforcement still need hardening.
- Core runtime is being split into focused modules. Agent definitions, plans, route detection, and research report helpers have been extracted; the main runtime flow still lives in `packages/core/src/index.ts`.

See [Product Readiness](docs/PRODUCT_READINESS.md) for the current target and [MVP Status](docs/MVP_STATUS.md) for the completed baseline acceptance matrix.

### Requirements

- Node.js and pnpm
- Rust toolchain
- Windows is the primary target for the current Tauri desktop build

### Quick Start

Install dependencies:

```sh
pnpm install
```

Run the Tauri desktop app:

```sh
pnpm dev
```

Run a frontend-only Vite preview:

```sh
pnpm --filter @javis/desktop dev
```

### Verification

Run the full local check:

```sh
pnpm check
```

Individual checks:

```sh
pnpm typecheck
pnpm --filter @javis/desktop build
pnpm rust:check
pnpm rust:test
```

### Repository Layout

```text
apps/desktop          Tauri + React desktop shell
packages/core         task runtime, planning, agent state, verification
packages/tools        tool contracts and shared tool result types
packages/ui           reusable workbench UI components
docs                  product, architecture, security, and status docs
```

### Safety Model

Javis separates preview actions from writes:

- `read`: may execute immediately and must log results.
- `preview`: creates a plan or dry-run without changing local state.
- `confirmed_write`: requires an explicit current permission request.
- `dangerous`: rejected by default for the first version.

The PDF organization flow demonstrates this model: it first lists source and target paths, marks conflicts, waits for approval, then moves only the files in the approved dry-run plan.

### Documentation

- [Documentation Index](docs/README.md)
- [Development Guide](docs/DEVELOPMENT.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Product Readiness](docs/PRODUCT_READINESS.md)
- [MVP Status](docs/MVP_STATUS.md)
- [Security Model](docs/SECURITY_MODEL.md)
- [Manual QA Checklist](docs/QA_CHECKLIST.md)
- [Release Guide](docs/RELEASE.md)
- [Roadmap](docs/ROADMAP.md)
- [Contributing](CONTRIBUTING.md)
