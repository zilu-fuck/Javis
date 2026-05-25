import { describe, expect, it } from "vitest";
import { createAgentStateTracker } from "./agent-state-tracker";
import { demoAgents } from "./agents";

describe("createAgentStateTracker", () => {
  it("creates queued snapshots for every agent", () => {
    const tracker = createAgentStateTracker(demoAgents);

    const snapshots = tracker.getSnapshots();

    expect(snapshots.map((snapshot) => snapshot.id)).toEqual(demoAgents.map((agent) => agent.id));
    expect(snapshots.every((snapshot) => snapshot.status === "queued")).toBe(true);
    expect(snapshots.every((snapshot) => snapshot.task === "Waiting")).toBe(true);
  });

  it("updates one agent without mutating other agent states", () => {
    const tracker = createAgentStateTracker(demoAgents);

    tracker.setState("agent-code", {
      status: "running",
      task: "Inspecting repository diff",
      currentStepId: "analyze-code",
      startedAt: "2026-05-25T00:00:00.000Z",
    });

    expect(tracker.getState("agent-code")).toEqual({
      agentId: "agent-code",
      status: "running",
      task: "Inspecting repository diff",
      currentStepId: "analyze-code",
      startedAt: "2026-05-25T00:00:00.000Z",
    });
    expect(tracker.getSnapshots().find((snapshot) => snapshot.id === "agent-code")).toEqual({
      id: "agent-code",
      name: "Code Agent",
      role: "Repository diff preview, proposed edits, and verification",
      status: "running",
      task: "Inspecting repository diff",
    });
    expect(tracker.getSnapshots().find((snapshot) => snapshot.id === "agent-file")?.status).toBe("queued");
  });

  it("resets all agent states", () => {
    const tracker = createAgentStateTracker(demoAgents, "Idle");

    tracker.setState("agent-file", {
      status: "completed",
      task: "Scanned documents",
    });
    tracker.reset();

    expect(tracker.getState("agent-file")).toEqual({
      agentId: "agent-file",
      status: "queued",
      task: "Idle",
    });
  });

  it("rejects unknown agent ids", () => {
    const tracker = createAgentStateTracker(demoAgents);

    expect(() => tracker.setState("agent-missing", { status: "running" })).toThrow(
      "Unknown agent state",
    );
  });
});
