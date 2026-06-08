import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { zhCNWorkbenchLocale } from "../locale";
import type { WorkbenchTask } from "../types";
import { ThreadView } from "./ThreadView";

describe("ThreadView", () => {
  it("does not disable the composer for an answered ask-user prompt", () => {
    const task = createTask({
      askUserQuestion: {
        id: "ask-1",
        question: "Need detail?",
        status: "answered",
        answer: "detail",
      },
    });

    const { container } = renderThreadView(task);

    expect((container.querySelector("textarea") as HTMLTextAreaElement).disabled).toBe(false);
  });

  it("disables the composer for a pending ask-user prompt", () => {
    const task = createTask({
      askUserQuestion: {
        id: "ask-1",
        question: "Need detail?",
        status: "pending",
      },
    });

    const { container } = renderThreadView(task);

    expect((container.querySelector("textarea") as HTMLTextAreaElement).disabled).toBe(true);
  });
});

function renderThreadView(task: WorkbenchTask) {
  return render(
    <ThreadView
      currentWorkspacePath="E:/Javis"
      draftGoal=""
      labels={zhCNWorkbenchLocale.labels}
      locale={zhCNWorkbenchLocale}
      recentWorkspacePaths={[]}
      task={task}
      onDraftGoalChange={vi.fn()}
      onSubmit={vi.fn()}
    />,
  );
}

function createTask(overrides: Partial<WorkbenchTask> = {}): WorkbenchTask {
  return {
    id: "task-1",
    title: "Task",
    userGoal: "Goal",
    status: "running",
    commanderMessage: "Working",
    plan: [],
    agents: [
      {
        id: "agent-commander",
        name: "Commander",
        role: "Coordinates work",
        status: "running",
        task: "Working",
      },
    ],
    logs: [],
    ...overrides,
  };
}
