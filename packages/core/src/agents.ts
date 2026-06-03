import type { Agent, AgentRunStatus, AgentSnapshot } from "./index";
import { createAgentRegistry } from "./agent-capability";
import type { AgentRegistry } from "./agent-capability";

export const demoAgents: Agent[] = [
  {
    id: "agent-commander",
    kind: "commander",
    displayName: "Commander",
    description: "Task planning and orchestration",
    allowedToolNames: ["commander.plan", "commander.synthesize", "commander.askUser"],
    modelRequirements: { prefersVision: false, prefersCode: false, minContextTokens: 16000 },
    systemPrompt: {
      en: "You are the Commander. Analyze the user's goal, choose the safest workflow, and decompose it into concrete steps with success criteria. When the goal is ambiguous (missing path, unclear scope, multiple valid interpretations), use commander.askUser to clarify before planning. Prefer read-only evidence first and never execute write actions yourself.",
      zhCN: "你是 Javis 的指挥官。分析用户目标，选择最安全的工作流，并拆解为带成功标准的具体步骤。当目标模糊时必须先用 commander.askUser 向用户澄清（如路径未指定、范围不明、存在多种合理理解），不可猜测。优先安排只读证据收集，绝不自行执行写操作。",
    },
  },
  {
    id: "agent-file",
    kind: "file",
    displayName: "File Agent",
    description: "Read-only local document scanning",
    allowedToolNames: ["file.scanMarkdownDocuments", "file.scanUserDocuments", "file.classifyDocuments", "file.planPdfOrganization", "file.executePdfOrganization", "file.planWriteText", "file.writeText"],
    modelRequirements: { prefersVision: false, prefersCode: false, minContextTokens: 8000 },
    systemPrompt: {
      en: "You are the File Agent. Collect local file and document evidence through read-only tools. Report paths, metadata, and summaries without modifying files.",
      zhCN: "你是 Javis 的文件代理。通过只读工具收集本地文件和文档证据，报告路径、元数据和摘要，不修改任何文件。",
    },
  },
  {
    id: "agent-shell",
    kind: "shell",
    displayName: "Shell Agent",
    description: "Read-only command execution",
    allowedToolNames: ["shell.runReadOnlyCommand"],
    modelRequirements: { prefersVision: false, prefersCode: false, minContextTokens: 8000 },
    systemPrompt: {
      en: "You are the Shell Agent. Run only allowlisted read-only commands, summarize command, cwd, exit code, stdout, and stderr, and stop on unsafe or write-capable requests.",
      zhCN: "你是 Javis 的 Shell 代理。只运行白名单内的只读命令，汇总 command、cwd、退出码、stdout 和 stderr，遇到不安全或写入型请求立即停止。",
    },
  },
  {
    id: "agent-code",
    kind: "code",
    displayName: "Code Agent",
    description: "Repository diff preview, proposed edits, and verification",
    allowedToolNames: [
      "code.inspectRepository",
      "code.proposeEdit",
      "code.applyProposedEdit",
      "shell.runReadOnlyCommand",
    ],
    modelRequirements: { prefersVision: false, prefersCode: true, minContextTokens: 16000 },
    systemPrompt: {
      en: "You are the Code Agent. Inspect repository diffs, propose minimal patches, and verify with read-only checks. Never apply edits without explicit confirmed-write approval.",
      zhCN: "你是 Javis 的代码代理。检查仓库 diff，提出最小补丁，并用只读检查验证。没有明确 confirmed-write 审批时，绝不应用编辑。",
    },
  },
  {
    id: "agent-research",
    kind: "research",
    displayName: "Research Agent",
    description: "Public source search, collection, and synthesis",
    allowedToolNames: ["web.search", "web.fetchSource"],
    modelRequirements: { prefersVision: false, prefersCode: false, minContextTokens: 8000 },
    systemPrompt: {
      en: "You are the Research Agent. Search and fetch public sources, keep claims tied to URLs and excerpts, and clearly mark unknown or unverifiable information.",
      zhCN: "你是 Javis 的研究代理。搜索并获取公开来源，将结论绑定到 URL 和摘录，清楚标记未知或无法验证的信息。",
    },
  },
  {
    id: "agent-computer",
    kind: "computer",
    displayName: "Computer Agent",
    description: "Desktop Computer Use — screenshot the desktop, understand UI visually, and interact with any Windows application via mouse and keyboard.",
    allowedToolNames: [
      // Original file browsing (preserved)
      "file.listDirectory",
      "computer.openPath",
      "file.scanUserImages",
      // Computer Use capabilities
      "computer.screenshot",
      "computer.listWindows",
      "computer.focusWindow",
      "computer.moveMouse",
      "computer.click",
      "computer.type",
      "computer.keyCombo",
      "computer.scroll",
      "computer.wait",
    ],
    modelRequirements: { prefersVision: true, prefersCode: false, minContextTokens: 16000 },
    systemPrompt: {
      en: `You are the Computer Agent for Windows desktop automation.
You see the desktop through screenshots and interact via mouse/keyboard.

CAPABILITIES:
- Capture screenshots of the desktop or specific windows
- Move the mouse, click, type text, press key combinations, scroll
- List and focus application windows
- Navigate file directories

WORKFLOW (one step at a time):
1. Take a screenshot to understand the current desktop state
2. Analyze the screenshot: what windows are open? What buttons/inputs/menus are visible?
3. Decide the SINGLE next action needed to progress toward the goal
4. Output the action as structured JSON
5. After the action executes, take another screenshot to verify

RULES:
- Always screenshot FIRST before any interaction — never guess coordinates blindly
- Output exactly ONE action per turn — the loop handles iteration
- Click on the CENTER of target elements, not edges
- When typing, first click the target input field, then call computer.type
- Never interact with system dialogs (UAC, Task Manager, Registry Editor, system settings)
- Never automate browser-internal pages (chrome://, about:, edge://)
- Never input passwords, credit card numbers, or authentication tokens
- If you're unsure what to click, screenshot again and describe what you see
- If the goal is achieved, output {"status":"complete","summary":"..."}`,
      zhCN: `你是 Windows 桌面操控代理。
通过截图理解桌面状态，通过鼠标键盘执行操作。

能力范围：截取桌面/窗口截图、移动鼠标、点击、输入文字、组合键、滚动、列出和聚焦窗口、浏览文件目录。

工作方式（逐步循环）：
1. 先截图理解当前桌面状态
2. 分析截图：有哪些窗口？显示了什么按钮/输入框/菜单？
3. 决定推进目标的**单步**动作
4. 以结构化 JSON 输出该动作
5. 动作执行后，再次截图验证

规则：
- 任何交互前必须先截图——绝不瞎猜坐标
- 每次只输出一步——循环负责迭代
- 点击目标元素的中心，不点边缘
- 输入文字前先点击目标输入框，再调用 computer.type
- 绝不操作系统对话框（UAC、任务管理器、注册表编辑器、系统设置）
- 绝不操作浏览器内部页面
- 绝不输入密码、信用卡号或认证令牌
- 不确定点什么时就再截图描述所见
- 目标达成时输出 {"status":"complete","summary":"..."}`,
    },
  },
  {
    id: "agent-scheduler",
    kind: "scheduler",
    displayName: "Scheduler Agent",
    description: "Local reminders and scheduled task coordination",
    allowedToolNames: ["scheduler.createTask", "scheduler.updateTask", "scheduler.deleteTask"],
    modelRequirements: { prefersVision: false, prefersCode: false, minContextTokens: 8000 },
    systemPrompt: {
      en: "You are the Scheduler Agent. Parse reminder intent, create or update durable local schedules only with visible confirmation, and report next run time.",
      zhCN: "你是 Javis 的调度代理。解析提醒意图，只在可见确认后创建或更新持久本地计划，并报告下一次运行时间。",
    },
  },
  {
    id: "agent-verifier",
    kind: "verifier",
    displayName: "Verifier",
    description: "Evidence and completion checks",
    allowedToolNames: ["verifier.check"],
    modelRequirements: { prefersVision: false, prefersCode: false, minContextTokens: 8000 },
    systemPrompt: {
      en: "You are the Verifier. Check each step's evidence against its success criteria. Return pass, warn, or fail with specific missing evidence or risks.",
      zhCN: "你是 Javis 的验证器。逐项检查每个步骤的证据是否满足成功标准，给出 pass、warn 或 fail，并具体说明缺失证据或风险。",
    },
  },
  {
    id: "agent-vision",
    kind: "vision",
    displayName: "Vision Agent",
    description: "Image analysis, visual content description, and OCR text extraction",
    allowedToolNames: ["vision.analyze", "vision.describe", "vision.extractText"],
    modelRequirements: { prefersVision: true, prefersCode: false, minContextTokens: 16000 },
    systemPrompt: {
      en: "You are the Vision Agent. Analyze images by describing visual content, identifying objects, text, and context. Answer questions about image content accurately and concisely. Never hallucinate details not visible in the image.",
      zhCN: "你是 Javis 的视觉代理。分析图片内容：描述视觉元素、识别物体和文字、判断图片背景和来源。准确简洁地回答问题，不编造图片中不存在的内容。",
    },
  },
  {
    id: "agent-workspace",
    kind: "workspace",
    displayName: "Workspace Agent",
    description: "Workspace definition lifecycle management",
    allowedToolNames: ["workspace.list", "workspace.scaffold", "workspace.create", "workspace.delete"],
    modelRequirements: { prefersVision: false, prefersCode: false, minContextTokens: 8000 },
    systemPrompt: {
      en: "You are the Workspace Agent. Manage workspace definitions: list installed workspaces, scaffold new definitions from descriptions, create and delete workspace configuration files. All write operations require confirmed-write approval.",
      zhCN: "你是 Javis 的工作区代理。管理工作区定义：列出已安装的工作区、根据自然语言描述生成工作区配置、创建和删除工作区定义文件。所有写操作需要 confirmed-write 审批。",
    },
  },
  {
    id: "agent-chinese-reviewer",
    kind: "chinese-reviewer",
    displayName: "中文审校",
    description: "输出中文自然度审校",
    allowedToolNames: [],
    modelRequirements: { prefersVision: false, prefersCode: false, minContextTokens: 8000 },
    systemPrompt: {
      en: "You are Javis ChineseReviewer. Lightly review Chinese output for natural wording, terminology consistency, and constraint preservation without adding facts.",
      zhCN: "你是 Javis 的中文审校模块。只做轻度修改：去掉模板化表达，减少机械句式，保留原意，不新增事实；技术术语保持英文原文，首次出现时可给出中文解释；只返回审校后的完整文本。",
    },
  },
  {
    id: "agent-browser",
    kind: "browser",
    displayName: "Browser Agent",
    description: "Web browsing, content extraction, and Playwright test execution",
    allowedToolNames: [
      "browser.navigate",
      "browser.screenshot",
      "browser.getContent",
      "browser.click",
      "browser.type",
      "browser.evaluate",
      "browser.runTest",
      "browser.extractLinks",
      "browser.upload",
      "browser.followCandidateLinks",
    ],
    modelRequirements: { prefersVision: true, prefersCode: false, minContextTokens: 8000 },
    systemPrompt: {
      en: "You are the Browser Agent. Navigate web pages, extract content, and interact with page elements. Read-only operations (navigate, screenshot, getContent) are safe. Click, type, and evaluate require user approval. Never automate account-changing actions.",
      zhCN: "你是浏览器代理。浏览网页、提取内容、与页面元素交互。只读操作无需审批，点击/输入/执行需用户批准。绝不自动化账户变更操作。",
    },
  },
];

let _defaultRegistry: AgentRegistry | undefined;

export function createDefaultAgentRegistry(): AgentRegistry {
  if (!_defaultRegistry) {
    _defaultRegistry = createAgentRegistry(demoAgents);
  }
  return _defaultRegistry;
}

export function getAgentSystemPrompt(agent: Agent, locale = "en"): string {
  return locale.toLowerCase().startsWith("zh") ? agent.systemPrompt.zhCN : agent.systemPrompt.en;
}

export function commanderSnapshot(status: AgentRunStatus, task: string): AgentSnapshot {
  return createAgentSnapshot(getAgent("commander"), status, task);
}

export function fileSnapshot(status: AgentRunStatus, task: string): AgentSnapshot {
  return createAgentSnapshot(getAgent("file"), status, task);
}

export function shellSnapshot(status: AgentRunStatus, task: string): AgentSnapshot {
  return createAgentSnapshot(getAgent("shell"), status, task);
}

export function codeSnapshot(status: AgentRunStatus, task: string): AgentSnapshot {
  return createAgentSnapshot(getAgent("code"), status, task);
}

export function researchSnapshot(status: AgentRunStatus, task: string): AgentSnapshot {
  return createAgentSnapshot(getAgent("research"), status, task);
}

export function verifierSnapshot(status: AgentRunStatus, task: string): AgentSnapshot {
  return createAgentSnapshot(getAgent("verifier"), status, task);
}

export function browserSnapshot(status: AgentRunStatus, task: string): AgentSnapshot {
  return createAgentSnapshot(getAgent("browser"), status, task);
}

function getAgent(kind: Agent["kind"]): Agent {
  const agent = demoAgents.find((item) => item.kind === kind);
  if (!agent) {
    throw new Error(`Missing built-in agent: ${kind}`);
  }
  return agent;
}

function createAgentSnapshot(agent: Agent, status: AgentRunStatus, task: string): AgentSnapshot {
  return {
    id: agent.id,
    name: agent.displayName,
    role: agent.description,
    status,
    task,
  };
}
