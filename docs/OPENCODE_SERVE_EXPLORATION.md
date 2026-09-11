# OpenCode serve 会话接口可行性探索

> 探索日期：2026-08-13
> 范围：`AGENT_RUNTIME_DUAL_KERNEL_PLAN.md` §10.1 的 OpenCode 会话 adapter 前置验证
> 结论：**可行**。`opencode serve` + `run --attach` 提供结构化、可流式、可取消的会话接口，可以作为 `OpenCodeAgentRuntime` 会话 adapter 的传输层。当前 one-shot `run --format json` 保持为兼容路径。

## 1. 验证环境

- 二进制：`opencode-windows-x64@1.18.3`（`node_modules/.pnpm/opencode-windows-x64@1.18.3/.../opencode.exe`）
- `opencode serve --pure --port 40291 --print-logs`：启动 headless HTTP 服务 + Web UI
- 客户端：`opencode run --attach http://127.0.0.1:40291 <prompt> --format json`

## 2. 已验证能力

### 2.1 会话生命周期（REST）

| 操作 | 请求 | 结果 |
| --- | --- | --- |
| 列表 | `GET /session` | 会话数组，每项含 `id`、`directory`、`tokens{input,output,reasoning,cache}`、`cost`、`model{id,providerID}`、`version`、`time` |
| 创建 | `POST /session` `{"directory":"E:/Javis","title":"..."}` | 返回完整会话对象（含新 `id`） |
| 删除 | `DELETE /session/:id` | 会话删除（测试会话已清理） |
| 发送消息 | `POST /session/:id/message` `{"parts":[{"type":"text","text":"..."}]}` | 同步返回 assistant message：`info{role,modelID,providerID,cost,tokens,finish}` + `parts[]`（step-start/text/step-finish） |
| 流式参数 | `?stream=true` | **未产生 SSE**（该版本返回完整 JSON；流式需走 `run --attach`） |

### 2.2 流式事件（`run --attach`）★ 关键发现

```
opencode run --attach http://127.0.0.1:40291 "reply PONG" --format json
```

输出为 **NDJSON 流式事件**（每行一个事件），事件类型：

- `step_start`：`{type, timestamp, sessionID, part{id, messageID, sessionID, type:"step-start"}}`
- `text`：`{type:"text", part{type:"text", text, time{start,end}}}`
- `step_finish`：`{type:"step_finish", part{reason, tokens{total,input,output,reasoning,cache}, cost}}`

事件携带完整 `sessionID`、`tokens`（usage）和 `cost`——这正是统一 `AgentRuntime` 事件/用量协议需要的字段，无需二次解析。

### 2.3 取消与进程回收

- 启动长任务（2000 词 essay）后在第 6 秒 kill `run` 客户端进程
- serve 侧会话 `output` 停留在 0 tokens、`updated` 不再变化 → **取消信号传播到 serve，生成中止**
- 无残留生成进程；serve 本身持续可用

### 2.4 配置与隔离

- serve 读取全局 opencode 配置（provider/model 来自用户已配置的 profile，本次实测 `deepseek-v4-flash` via `opencode-go`）
- `run` 可传 `--model provider/model` 覆盖（与 one-shot 路径一致）
- 注意：serve 的会话数据写入 opencode 全局数据目录（`GET /session` 能列出用户历史会话）——Javis 接入时需按 workspace/任务隔离，避免污染

## 3. 与当前 one-shot 路径的对比

| 维度 | 当前 `run --format json`（兼容路径） | `serve` + `run --attach`（目标路径） |
| --- | --- | --- |
| 事件 | 无（阻塞单结果） | NDJSON 流式（step_start/text/step_finish） |
| 取消 | 无（进程跑到 timeout） | kill 客户端 → serve 侧中止 |
| usage | 仅 proposal 内 tokenUsage | 结构化 tokens + cost 全程可用 |
| 会话 | 无 | 完整会话对象（可跨消息延续） |
| 进程 | 每次 spawn | 常驻 serve + attach |

## 4. adapter 落点建议（后续实施，非本次范围）

1. Rust 侧管理 `opencode serve` 子进程（复用 browser sidecar 模式：stdout 握手 + JSONL 协议 + 崩溃重启）
2. `run --attach` 事件循环：NDJSON 行 → `AgentEvent`（tool 事件经窄 bridge；usage 事件直接映射）
3. 取消：abort 客户端进程 + serve 侧会话状态确认（§2.3 已验证传播）
4. 配置隔离：serve 启动时注入 `OPENCODE_CONFIG_CONTENT`（沿用 one-shot 的配置注入方式），避免读取用户全局配置
5. 会话清理：任务结束后 `DELETE /session/:id`，避免污染全局数据

## 5. 风险与限制

- `?stream=true` 不产生 SSE——流式只通过 `run --attach`（限制面窄但足够）
- serve 复用全局会话数据目录——需要按任务隔离 + 清理
- 版本耦合：接口形状随 opencode-ai 版本变化，需在升级时回归验证
- 首个请求冷启动延迟（provider 配置加载）
