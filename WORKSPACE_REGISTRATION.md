# Workspace Registration Guide (for Javis Agents)

This document teaches you — the Javis Commander and Code Agent — how to help users
create, list, and manage custom workspaces.

## What Is a Workspace?

A workspace is a named bundle that adds a new sidebar entry to the Javis workbench.
It can optionally include custom agents, workflows, tool descriptors, and routing
rules. Once registered, the user clicks the sidebar icon to switch to that workspace.

Example: a "Writing Workbench" workspace adds a "✍️ 写作工作台" entry to the sidebar.
Clicking it opens the chat view pre-configured for writing tasks.

## Workspace Definition Schema

A workspace is defined by a JSON file with this shape:

```jsonc
{
  // ── Required identity fields ──
  "id": "writing-workbench",          // kebab-case, unique. Only [a-z0-9-] allowed.
  "title": "写作工作台",               // Display name in sidebar
  "icon": "✍️",                        // Single emoji or Unicode char
  "description": "写作辅助、大纲生成、字数统计",
  "viewType": "chat",                 // Which built-in view to render
  "version": "0.1.0",
  "enabled": true,

  // ── Sidebar placement ──
  "sidebarGroup": "custom",           // "primary" | "knowledge" | "custom"
  "sidebarOrder": 0,                  // Sort order within group (lower = higher)

  // ── Optional: custom agents ──
  "agents": [
    {
      "id": "agent-proofreader",
      "kind": "chinese-reviewer",
      "displayName": "Proofreader",
      "description": "Checks writing for grammar and style",
      "allowedToolNames": ["verifier.check"],
      "modelRequirements": {
        "prefersVision": false,
        "prefersCode": false,
        "minContextTokens": 8000
      },
      "systemPrompt": {
        "en": "You are a writing proofreader. Check grammar, style, and clarity.",
        "zhCN": "你是写作校对员。检查语法、风格和清晰度。"
      }
    }
  ],

  // ── Optional: custom workflows ──
  "workflows": [
    {
      "id": "writing-polish",
      "title": "Polish Writing",
      "triggerExamples": ["polish my article", "改进这篇文章", "润色"],
      "goal": "Improve the clarity and style of the user's writing.",
      "coordinatorAgentKind": "commander",
      "participatingAgentKinds": ["commander", "chinese-reviewer", "verifier"],
      "currentSupport": "partial",
      "safetyNotes": ["Read-only. Does not modify files without approval."],
      "steps": [
        {
          "id": "analyze-text",
          "title": "Analyze the text for issues",
          "agentKind": "commander",
          "input": "User's text and request",
          "output": "List of identified issues",
          "permissionLevel": "read",
          "dependsOn": [],
          "canRunInParallel": false
        },
        {
          "id": "polish-text",
          "title": "Apply polish suggestions",
          "agentKind": "chinese-reviewer",
          "input": "Original text and issue list",
          "output": "Polished text with change notes",
          "permissionLevel": "read",
          "dependsOn": ["analyze-text"],
          "canRunInParallel": false
        },
        {
          "id": "verify-polish",
          "title": "Verify polish quality",
          "agentKind": "verifier",
          "input": "Polished text and original",
          "output": "Quality assessment",
          "permissionLevel": "read",
          "dependsOn": ["polish-text"],
          "canRunInParallel": false
        }
      ]
    }
  ],

  // ── Optional: route matching ──
  "routes": [
    {
      "routeKind": "writing-polish",
      "workflowId": "writing-polish",
      "scoring": {
        "keywordPatterns": [
          { "pattern": "润色|polish|改进.*文|improve.*writing", "weight": 3, "signalName": "writing_polish" },
          { "pattern": "写作|writing|文章|article", "weight": 1, "signalName": "writing_context" }
        ],
        "threshold": 2
      }
    }
  ]
}
```

## Available Primitives

When building workspace definitions, you can use these built-in primitives:

### View Types
| viewType | Description |
|----------|-------------|
| `chat` | Main chat interface with task input, thread, and activity panels |
| `automated` | Scheduled / automated tasks view |
| `skills` | Skill marketplace |
| `apps` | Installed applications browser |
| `documents` | Document scanner and browser |
| `gallery` | Image gallery browser |
| `computer` | File system explorer |

### Agent Kinds
`commander` | `file` | `shell` | `browser` | `computer` | `scheduler` | `research` | `code` | `verifier` | `chinese-reviewer`

### Permission Levels
`read` | `preview` | `confirmed_write` | `dangerous`

### Tool Names (selected)
| Tool | Permission |
|------|-----------|
| `commander.plan` | read |
| `verifier.check` | read |
| `file.scanMarkdownDocuments` | read |
| `file.scanUserDocuments` | read |
| `file.classifyDocuments` | read |
| `file.listDirectory` | read |
| `shell.runReadOnlyCommand` | read |
| `code.inspectRepository` | preview |
| `code.proposeEdit` | preview |
| `code.applyProposedEdit` | confirmed_write |
| `web.search` | read |
| `web.fetchSource` | read |
| `project.inspect` | read |
| `computer.openPath` | read |
| `scheduler.createTask` | confirmed_write |
| `workspace.list` | read |
| `workspace.scaffold` | preview |
| `workspace.create` | confirmed_write |
| `workspace.delete` | confirmed_write |

### Sidebar Groups
| Group | Position | Has Section Header |
|-------|----------|-------------------|
| `primary` | Top | No |
| `knowledge` | Middle, under "Local Knowledge Base" | Yes |
| `custom` | Below knowledge, under "Plugins" | Yes |

## How to Create a Workspace

### Method 1: Scaffold with LLM (Recommended)

Use the `workspace.scaffold` tool to generate a definition from a natural language
description. This is the fastest path.

**Steps:**
1. Call `workspace.scaffold` with the user's description in English or Chinese
2. The tool calls the configured model to generate a complete workspace JSON
3. Show the generated JSON to the user as a preview
4. After user approval, call `workspace.create` with the JSON
5. The workspace appears in the sidebar immediately

**Example prompt for scaffold:**
```
User request: 帮我创建一个写作工作台，要能辅助写作、生成大纲、统计字数
```

The LLM will generate a definition with `id: "writing-workbench"`, appropriate
agents, and route patterns matching "写作", "大纲", "字数".

### Method 2: Write Manually

For precise control, construct the JSON directly.

**Steps:**
1. Decide on `id` (kebab-case), `title`, `icon`, `description`
2. Choose `viewType` (usually `"chat"`)
3. Set `sidebarGroup` and `sidebarOrder`
4. Optionally add agents, workflows, routes
5. Call `workspace.create` with the completed JSON

### Method 3: Start from an Existing Workspace

1. Call `workspace.list` to see installed workspaces
2. Ask the user which one to use as a template
3. Modify the fields and save with a new `id` via `workspace.create`

## Managing Workspaces

| Action | Tool | Permission |
|--------|------|-----------|
| List all workspaces | `workspace.list` | read |
| Generate a definition | `workspace.scaffold` | preview |
| Save a new workspace | `workspace.create` | confirmed_write |
| Remove a workspace | `workspace.delete` | confirmed_write |

`workspace.delete` takes only the `workspaceId` (the `id` field from the definition).

## Examples

### Minimal "Coding Workbench"

```json
{
  "id": "coding-workbench",
  "title": "Coding Workbench",
  "icon": "💻",
  "description": "Code review and project inspection",
  "viewType": "chat",
  "sidebarGroup": "custom",
  "sidebarOrder": 0,
  "version": "0.1.0",
  "enabled": true
}
```

### "Research Assistant" with Custom Route

```json
{
  "id": "research-assistant",
  "title": "Research Assistant",
  "icon": "🔍",
  "description": "Deep research with source tracking",
  "viewType": "chat",
  "sidebarGroup": "custom",
  "sidebarOrder": 1,
  "version": "0.1.0",
  "enabled": true,
  "routes": [
    {
      "routeKind": "deep-research",
      "workflowId": "research-trending-topics",
      "scoring": {
        "keywordPatterns": [
          { "pattern": "深度研究|deep research|深入调查", "weight": 3, "signalName": "deep_research" },
          { "pattern": "调研|调查|investigate", "weight": 2, "signalName": "investigate" }
        ],
        "threshold": 2
      }
    }
  ]
}
```

### "Daily Planner" with Custom Agent

```json
{
  "id": "daily-planner",
  "title": "Daily Planner",
  "icon": "📅",
  "description": "Plan your day and track tasks",
  "viewType": "chat",
  "sidebarGroup": "primary",
  "sidebarOrder": 3,
  "version": "0.1.0",
  "enabled": true,
  "agents": [
    {
      "id": "agent-planner",
      "kind": "commander",
      "displayName": "Planner",
      "description": "Breaks down daily goals into time-boxed tasks",
      "allowedToolNames": ["commander.plan", "scheduler.createTask"],
      "systemPrompt": {
        "en": "You are a daily planner. Break the user's goals into time-boxed tasks. Suggest realistic schedules.",
        "zhCN": "你是每日规划师。将用户目标拆分为有时间限制的任务，建议合理的日程安排。"
      }
    }
  ],
  "routes": [
    {
      "routeKind": "daily-plan",
      "workflowId": "daily-reminder",
      "scoring": {
        "keywordPatterns": [
          { "pattern": "规划.*今天|plan.*day|今日计划|日程", "weight": 3, "signalName": "daily_plan" }
        ],
        "threshold": 2
      }
    }
  ]
}
```

## Rules and Constraints

1. **id must be kebab-case** — only lowercase letters, digits, and hyphens. No spaces, underscores, or other characters. This is enforced by the Rust backend for security.
2. **icon should be a single character** — one emoji or one Unicode symbol.
3. **viewType must be an existing built-in view** — `"chat"` is the most common choice.
4. **agents can only use registered tool names** — check the tool table above for valid names.
5. **workflow steps with `canRunInParallel: true`** must not depend on each other via `dependsOn`.
6. **routes use JavaScript regex syntax** — but stored as strings in JSON. Escape backslashes: `"\\b"` not `"\b"`.
7. **`confirmed_write` steps** will require user approval at runtime. Keep most steps `read` or `preview`.
8. **Workspace definitions are stored on disk** at `{app_data}/workspaces/{id}.workspace.json`. The app loads them on startup.

## Troubleshooting

| Problem | Likely Cause | Fix |
|---------|-------------|-----|
| Workspace doesn't appear | `enabled: false` or JSON parse error | Check `enabled: true`, validate JSON |
| Sidebar icon wrong | `icon` is multi-character | Use a single emoji/char |
| Route doesn't match | `threshold` too high or regex invalid | Lower threshold, test regex |
| Agent doesn't respond | `allowedToolNames` has invalid tool | Check tool name table |
| Scaffold fails | Model returned non-JSON output | Retry with clearer description |
