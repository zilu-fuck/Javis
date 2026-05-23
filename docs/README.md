# Javis 文档索引

这里集中放 Javis 的产品、架构、工程和安全文档。文档按“先定方向，再定接口，再定实现边界”的顺序组织。

## 已有文档

- [架构设计](ARCHITECTURE.md)：系统模块、Agent 分工、任务生命周期和里程碑。
- [技术栈决策](TECH_STACK.md)：TypeScript、React、Tauri、opencode 等技术选择。
- [桌面布局设计](UI_LAYOUT.md)：参考 Codex 的桌面工作台布局。

## 第一阶段补充文档

- [MVP 规格](MVP.md)：第一版要演示什么、如何验收、哪些暂不做。
- [核心契约](CORE_CONTRACTS.md)：Task、Agent、ToolCall、PermissionRequest 等核心类型和事件流。
- [权限与安全](PERMISSIONS.md)：文件、命令、浏览器、opencode 等能力的权限边界。
- [工程结构](PROJECT_STRUCTURE.md)：Tauri + React + TypeScript 的目录结构和依赖方向。

## 阅读顺序

1. 先读 [架构设计](ARCHITECTURE.md) 和 [技术栈决策](TECH_STACK.md)，理解项目方向。
2. 再读 [桌面布局设计](UI_LAYOUT.md)，理解第一版桌面体验。
3. 开始实现前读 [MVP 规格](MVP.md)、[核心契约](CORE_CONTRACTS.md)、[权限与安全](PERMISSIONS.md) 和 [工程结构](PROJECT_STRUCTURE.md)。
