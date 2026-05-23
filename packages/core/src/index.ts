export type AgentStatus =
  | "idle"
  | "planning"
  | "running"
  | "waiting"
  | "verifying"
  | "done"
  | "failed";

export interface AgentSnapshot {
  id: string;
  name: string;
  role: string;
  status: AgentStatus;
  task: string;
}

export interface TaskLogEntry {
  id: string;
  kind: "plan" | "tool" | "permission" | "verification";
  title: string;
  detail: string;
}

export interface TaskSnapshot {
  id: string;
  title: string;
  userGoal: string;
  commanderMessage: string;
  agents: AgentSnapshot[];
  logs: TaskLogEntry[];
}

export function createInitialTaskSnapshot(): TaskSnapshot {
  return {
    id: "task-demo-001",
    title: "Javis desktop skeleton",
    userGoal: "搭建桌面工作台骨架",
    commanderMessage:
      "Commander 已创建初始任务线程。下一步会把真实任务生命周期接入这个工作台。",
    agents: [
      {
        id: "agent-commander",
        name: "Commander",
        role: "任务拆解与调度",
        status: "planning",
        task: "准备第一版桌面任务流",
      },
      {
        id: "agent-file",
        name: "File Agent",
        role: "本地文件工具",
        status: "idle",
        task: "等待只读文件扫描接入",
      },
      {
        id: "agent-verifier",
        name: "Verifier",
        role: "结果验证",
        status: "idle",
        task: "等待验证契约接入",
      },
    ],
    logs: [
      {
        id: "log-layout",
        kind: "plan",
        title: "Workbench ready",
        detail: "Sidebar、Main Thread、Agent Inspector 和 Activity Log 已就位。",
      },
      {
        id: "log-contracts",
        kind: "verification",
        title: "Contracts documented",
        detail: "核心契约和权限策略已写入 docs，等待落到 packages/core。",
      },
    ],
  };
}

