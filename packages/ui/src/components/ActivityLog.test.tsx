import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultWorkbenchLocale } from "../locale";
import type { WorkbenchTask } from "../types";
import { ActivityLog } from "./ActivityLog";

describe("ActivityLog", () => {
  afterEach(() => cleanup());

  it("uses explicit log agent ids when showing sub-agent activity", () => {
    render(
      <ActivityLog
        activityCount={1}
        isActivityOpen
        labels={defaultWorkbenchLocale.labels}
        locale={defaultWorkbenchLocale}
        onToggle={vi.fn()}
        task={createTask()}
      />,
    );

    expect(screen.getByText("File Agent")).toBeTruthy();
    expect(screen.getByText("Queued by Commander: Scan project documents")).toBeTruthy();
  });

  it("toggles the activity log when the bar is clicked while open", () => {
    const onToggle = vi.fn();
    const view = render(
      <ActivityLog
        activityCount={1}
        isActivityOpen
        labels={defaultWorkbenchLocale.labels}
        locale={defaultWorkbenchLocale}
        onToggle={onToggle}
        task={createTask()}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: /Activity log/i }));

    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

function createTask(): WorkbenchTask {
  return {
    id: "task-activity-agent",
    title: "Scan files",
    userGoal: "scan the project documents",
    status: "running",
    updatedAt: "2026-06-10T00:00:00.000Z",
    commanderMessage: "Commander dispatched: File Agent.",
    plan: [],
    agents: [],
    logs: [{
      id: "task-activity-agent-agent-file-queued",
      kind: "event",
      title: "agent.status",
      detail: "file: Queued by Commander: Scan project documents",
      userMessage: "Queued by Commander: Scan project documents",
      agentId: "agent-file",
    }],
  };
}
