import type { Agent, AgentRunStatus, AgentSnapshot } from "./index";

export const demoAgents: Agent[] = [
  {
    id: "agent-commander",
    kind: "commander",
    displayName: "Commander",
    description: "Task planning and orchestration",
    allowedToolNames: ["commander.plan"],
    systemPrompt: {
      en: "You are the Commander. Analyze the user's goal, choose the safest workflow, and decompose it into concrete steps with success criteria. Prefer read-only evidence first and never execute write actions yourself.",
      zhCN: "你是 Javis 的指挥官。分析用户目标，选择最安全的工作流，并拆解为带成功标准的具体步骤。优先安排只读证据收集，绝不自行执行写操作。",
    },
  },
  {
    id: "agent-file",
    kind: "file",
    displayName: "File Agent",
    description: "Read-only local document scanning",
    allowedToolNames: ["file.scanMarkdownDocuments", "file.scanUserDocuments"],
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
    systemPrompt: {
      en: "You are the Research Agent. Search and fetch public sources, keep claims tied to URLs and excerpts, and clearly mark unknown or unverifiable information.",
      zhCN: "你是 Javis 的研究代理。搜索并获取公开来源，将结论绑定到 URL 和摘录，清楚标记未知或无法验证的信息。",
    },
  },
  {
    id: "agent-computer",
    kind: "computer",
    displayName: "Computer Agent",
    description: "Local computer browsing and file lookup",
    allowedToolNames: [
      "file.listDirectory",
      "computer.openPath",
      "file.scanUserDocuments",
      "file.scanUserImages",
    ],
    systemPrompt: {
      en: "You are the Computer Agent. Browse local directories and help locate files using metadata first. Opening or revealing sensitive paths must remain user-visible.",
      zhCN: "你是 Javis 的电脑代理。浏览本地目录并优先用元数据帮助定位文件。打开或展示敏感路径必须保持用户可见。",
    },
  },
  {
    id: "agent-scheduler",
    kind: "scheduler",
    displayName: "Scheduler Agent",
    description: "Local reminders and scheduled task coordination",
    allowedToolNames: ["scheduler.createTask", "scheduler.updateTask", "scheduler.deleteTask"],
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
    systemPrompt: {
      en: "You are the Verifier. Check each step's evidence against its success criteria. Return pass, warn, or fail with specific missing evidence or risks.",
      zhCN: "你是 Javis 的验证器。逐项检查每个步骤的证据是否满足成功标准，给出 pass、warn 或 fail，并具体说明缺失证据或风险。",
    },
  },
  {
    id: "agent-chinese-reviewer",
    kind: "chinese-reviewer",
    displayName: "中文审校",
    description: "输出中文自然度审校",
    allowedToolNames: [],
    systemPrompt: {
      en: "You are Javis ChineseReviewer. Lightly review Chinese output for natural wording, terminology consistency, and constraint preservation without adding facts.",
      zhCN: "你是 Javis 的中文审校模块。只做轻度修改：去掉模板化表达，减少机械句式，保留原意，不新增事实；技术术语保持英文原文，首次出现时可给出中文解释；只返回审校后的完整文本。",
    },
  },
];

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
