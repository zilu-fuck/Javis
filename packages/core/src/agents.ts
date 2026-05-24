import type { Agent, AgentRunStatus, AgentSnapshot } from "./index";

export const demoAgents: Agent[] = [
  {
    id: "agent-commander",
    kind: "commander",
    displayName: "Commander",
    description: "Task planning and orchestration",
    allowedToolNames: [],
  },
  {
    id: "agent-file",
    kind: "file",
    displayName: "File Agent",
    description: "Read-only local document scanning",
    allowedToolNames: ["file.scanMarkdownDocuments"],
  },
  {
    id: "agent-shell",
    kind: "shell",
    displayName: "Shell Agent",
    description: "Read-only command execution",
    allowedToolNames: ["shell.runReadOnlyCommand"],
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
  },
  {
    id: "agent-research",
    kind: "research",
    displayName: "Research Agent",
    description: "Public source collection",
    allowedToolNames: ["web.fetchSource"],
  },
  {
    id: "agent-verifier",
    kind: "verifier",
    displayName: "Verifier",
    description: "Evidence and completion checks",
    allowedToolNames: [],
  },
];

export function commanderSnapshot(status: AgentRunStatus, task: string): AgentSnapshot {
  return createAgentSnapshot(demoAgents[0], status, task);
}

export function fileSnapshot(status: AgentRunStatus, task: string): AgentSnapshot {
  return createAgentSnapshot(demoAgents[1], status, task);
}

export function shellSnapshot(status: AgentRunStatus, task: string): AgentSnapshot {
  return createAgentSnapshot(demoAgents[2], status, task);
}

export function codeSnapshot(status: AgentRunStatus, task: string): AgentSnapshot {
  return createAgentSnapshot(demoAgents[3], status, task);
}

export function researchSnapshot(status: AgentRunStatus, task: string): AgentSnapshot {
  return createAgentSnapshot(demoAgents[4], status, task);
}

export function verifierSnapshot(status: AgentRunStatus, task: string): AgentSnapshot {
  return createAgentSnapshot(demoAgents[5], status, task);
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
