import type { ProjectTool, ShellTool } from "@javis/tools";
import { demoAgents } from "./agents";
import { createAgentStateTracker } from "./agent-state-tracker";
import type { FlowController } from "./file-scan-flow";
import type { ID } from "./index";
import { createProjectInspectionPlan, markStep } from "./plans";
import { createRecommendedCommandRequest } from "./routing";
import { appendLog } from "./snapshot-utils";
import { createEmptyTokenUsageSummary } from "./token-usage";

export async function runProjectInspectionTask(
  controller: FlowController,
  taskId: ID,
  userGoal: string,
  activeShellTool: ShellTool,
  activeProjectTool: ProjectTool,
) {
  const plan = createProjectInspectionPlan();
  const agentTracker = createAgentStateTracker(
    demoAgents.filter((agent) => ["commander", "file", "shell", "verifier"].includes(agent.kind)),
  );
  let snapshot = controller.getSnapshot();
  function emit(nextSnapshot: Parameters<FlowController["emit"]>[0]) {
    controller.emit(nextSnapshot);
    snapshot = controller.getSnapshot();
  }

  agentTracker.setState("agent-commander", {
    status: "planning",
    task: "Create project inspection plan",
    currentStepId: "step-inspect-project",
  });
  agentTracker.setState("agent-file", {
    status: "queued",
    task: "No file scan needed",
  });
  agentTracker.setState("agent-shell", {
    status: "queued",
    task: "Waiting for project inspection",
  });
  agentTracker.setState("agent-verifier", {
    status: "queued",
    task: "Waiting for command results",
  });

  emit({
    id: taskId,
    title: "Inspecting project environment",
    userGoal,
    status: "planning",
    commanderMessage:
      "Commander identified a project inspection task and prepared read-only Shell Tool calls.",
    plan,
    agents: agentTracker.getSnapshots(),
    tokenUsage: createEmptyTokenUsageSummary(),
    logs: [
      {
        id: `${taskId}-created`,
        kind: "event",
        title: "task.created",
        detail: "Desktop UI passed the project inspection goal to Core.",
      },
    ],
  });

  await controller.wait();

  agentTracker.setState("agent-commander", {
    status: "completed",
    task: "Plan submitted",
  });
  agentTracker.setState("agent-shell", {
    status: "running",
    task: "Inspecting package scripts",
    currentStepId: "step-inspect-project",
  });

  emit({
    ...snapshot,
    status: "running",
    commanderMessage: "Project Tool is reading package scripts before Shell Agent checks versions.",
    plan: markStep(snapshot.plan, "step-inspect-project", "running"),
    agents: agentTracker.getSnapshots(),
    logs: appendLog(snapshot, {
      id: `${taskId}-project-started`,
      kind: "tool",
      title: "tool_call.planned",
      detail: "project.inspect reads package.json scripts with read permission.",
    }),
  });

  try {
    const project = await activeProjectTool.inspectProject();
    const recommendedTestCommand = createRecommendedCommandRequest(project.recommendedTestCommand);
    const commandRequests = [
      {
        program: "node",
        args: ["--version"],
        workspacePath: null,
      },
      {
        program: "pnpm",
        args: ["--version"],
        workspacePath: null,
      },
      {
        program: "git",
        args: ["status", "--short"],
        workspacePath: null,
      },
      ...(recommendedTestCommand ? [recommendedTestCommand] : []),
    ];

    agentTracker.setState("agent-shell", {
      status: "running",
      task: "Running node/pnpm/git read-only checks",
      currentStepId: "step-read-env",
    });

    emit({
      ...snapshot,
      commanderMessage:
        "Project Tool found scripts and recommended commands. Shell Agent is running allowlisted checks.",
      plan: markStep(snapshot.plan, "step-inspect-project", "completed", "step-read-env", "running"),
      agents: agentTracker.getSnapshots(),
      project,
      logs: appendLog(snapshot, {
        id: `${taskId}-project-done`,
        kind: "tool",
        title: "tool_call.updated",
        detail: `project.inspect found ${project.scripts.length} package script(s).`,
      }),
    });

    const commands = await Promise.all(
      commandRequests.map((request) => activeShellTool.runReadOnlyCommand(request)),
    );

    agentTracker.setState("agent-commander", {
      status: "completed",
      task: "Waiting for verification",
    });
    agentTracker.setState("agent-shell", {
      status: "completed",
      task: "Read-only commands completed",
    });
    agentTracker.setState("agent-verifier", {
      status: "verifying",
      task: "Checking exit codes",
      currentStepId: "step-verify-env",
    });

    emit({
      ...snapshot,
      title: "Verifying project environment",
      status: "verifying",
      commanderMessage: "Verifier is checking command exit codes and output summaries.",
      plan: markStep(snapshot.plan, "step-read-env", "completed", "step-verify-env", "running"),
      agents: agentTracker.getSnapshots(),
      commands,
      project: snapshot.project,
      logs: [
        ...appendLog(snapshot, {
          id: `${taskId}-commands-done`,
          kind: "tool",
          title: "tool_call.updated",
          detail: `Shell Tool completed ${commands.length} read-only commands.`,
        }),
        ...commands.map((command, index) => ({
          id: `${taskId}-command-${index}`,
          kind: "tool" as const,
          title: command.command,
          detail: `exit=${command.exitCode ?? "unknown"} stdout=${command.stdout || "(empty)"}`,
        })),
      ],
    });

    await controller.wait();

    const passingCount = commands.filter((command) => command.exitCode === 0).length;
    const verificationStatus = passingCount === commands.length ? "completed" : "failed";
    agentTracker.setState("agent-commander", {
      status: "completed",
      task: "Task finished",
    });
    agentTracker.setState("agent-shell", {
      status: "completed",
      task: "Read-only command checks completed",
    });
    agentTracker.setState("agent-verifier", {
      status: verificationStatus === "completed" ? "completed" : "failed",
      task: `${passingCount}/${commands.length} commands passed`,
    });

    emit({
      ...snapshot,
      title:
        verificationStatus === "completed"
          ? "Project environment inspected"
          : "Project environment check failed",
      status: verificationStatus,
      commanderMessage:
        verificationStatus === "completed"
          ? "Project inspection completed through the Tauri desktop process and a read-only command allowlist."
          : "Project inspection finished, but Verifier found a failing command.",
      plan:
        verificationStatus === "completed"
          ? snapshot.plan.map((step) => ({ ...step, status: "completed" }))
          : markStep(snapshot.plan, "step-verify-env", "failed"),
      agents: agentTracker.getSnapshots(),
      project: snapshot.project,
      logs: appendLog(snapshot, {
        id: `${taskId}-done`,
        kind: "verification",
        title:
          verificationStatus === "completed" ? "task.completed" : "verification.failed",
        detail: `Verifier checked ${passingCount}/${commands.length} command results.`,
      }),
      verificationSummary: `${verificationStatus === "completed" ? "verified" : "failed"}: ${passingCount}/${commands.length} read-only commands exited successfully. Start: ${project.recommendedStartCommand ?? "not found"}. Test/check: ${project.recommendedTestCommand ?? "not found"}.`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    agentTracker.setState("agent-commander", {
      status: "completed",
      task: "Plan submitted",
    });
    agentTracker.setState("agent-shell", {
      status: "failed",
      task: "Read-only command failed",
    });
    agentTracker.setState("agent-verifier", {
      status: "cancelled",
      task: "No result to verify",
    });

    emit({
      ...snapshot,
      title: "Project inspection failed",
      status: "failed",
      commanderMessage:
        "Shell Agent inspection failed. The task stopped without running any write operation.",
      plan: markStep(snapshot.plan, "step-read-env", "failed"),
      agents: agentTracker.getSnapshots(),
      logs: appendLog(snapshot, {
        id: `${taskId}-failed`,
        kind: "tool",
        title: "task.failed",
        detail: message,
      }),
    });
  }
}
