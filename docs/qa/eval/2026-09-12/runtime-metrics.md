# Runtime metrics

- generated: 2026-09-12T18:47:55.042Z
- data dir: `C:\Users\s1897\AppData\Roaming\app.javis.desktop`
- database: **464.6 MB**

## Tasks

- observed: **216** · failed **100** · failure rate **46.3%**
- duration: p50 **19s** · p95 **500s** · max 548790s
- audit lines: 3149 (agent_run_audit=2420, tool_call_audit=687, sandbox_process=42)

## Top agent failure reasons

- 28× Some steps failed
- 13× 模型请求失败
- 12× Patch application failed
- 12× Post-apply verification unavailable
- 12× Task ended before assigned work completed
- 5× Image target missing
- 5× commander.plan timed out after 90000ms.
- 3× Could not read model API key secret: 系统找不到指定的文件。 (os error 2)
- 3× Commander plan has no capability-tagged steps. The plan must include at least one step with a capability or requiredCapabilities field.
- 3× Model response did not contain a JSON object.
- 3× Failed: trend.fetchHotList Browser and registered-adapter attempts failed; Page Agent fallback required. browser: bilibili:browser:generic-search HTTP 200: Browser page did not expose structured bilibili trend items.; adapter: Trend hot list fetch failed for all configured providers.
- 2× Patch proposal unavailable
- 2× Patch proposal failed
- 2× API 密钥无效或已过期，请在设置中更新密钥。
- 2× Task failed before assigned work completed

## Top failing tools

- 58× `code.searchRepository`
- 11× `shell.runReadOnlyCommand`
- 7× `file.scanMarkdownDocuments`
- 7× `code.inspectRepository`
- 5× `commander.plan`
- 5× `file.writeText`
- 3× `code.inspectWorkspace`
- 1× `computer.screenshot`
- 1× `file.planWriteText`

## Storage

- task history: failed=3, completed=1

| table | MB |
| --- | --- |
| task_session_log | 397.2 |
| workflow_checkpoints | 59.5 |
| runtime_events | 1.7 |
| idx_task_session_log_task_id | 1.4 |
| file_scan_cache | 0.9 |
| file_classifications | 0.7 |
| sqlite_autoindex_file_scan_cache_1 | 0.6 |
| sqlite_autoindex_file_classifications_1 | 0.6 |
| sqlite_autoindex_runtime_events_1 | 0.1 |
| tool_call_audit | 0.1 |
| sqlite_autoindex_runtime_events_2 | 0.1 |
| idx_runtime_events_run_sequence | 0.1 |

## Model usage observations

- calls: 2 · tasks: 2 · providers: 1
- tokens: input 8410 · output 1165 · total 9575
