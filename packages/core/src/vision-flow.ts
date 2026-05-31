import type { CommanderTool, VerifierTool, VisionAnalyzeResult, VisionTool } from "@javis/tools";
import { createAgentStateTracker } from "./agent-state-tracker";
import { demoAgents } from "./agents";
import type { FlowController } from "./flow-controller";
import type { ID } from "./index";
import { appendLog } from "./snapshot-utils";
import { createEmptyTokenUsageSummary } from "./token-usage";
import { safeSynthesizeConclusion } from "./workflow-executor";
import { inferImagePath, inferVisionMode } from "./vision-utils";
export { isVisionGoal } from "./vision-utils";

interface VisionTaskOptions {
  controller: FlowController;
  visionTool: VisionTool;
  /** Optional — only populated when runVisionTask is called outside the Commander DAG path. */
  commanderTool?: CommanderTool;
  verifierTool?: VerifierTool;
  taskId: ID;
  userGoal: string;
}

export async function runVisionTask({
  controller,
  visionTool,
  commanderTool,
  verifierTool,
  taskId,
  userGoal,
}: VisionTaskOptions) {
  const agentTracker = createAgentStateTracker(
    demoAgents.filter((agent) => ["commander", "vision", "verifier"].includes(agent.kind)),
  );
  let snapshot = controller.getSnapshot();
  function emit(nextSnapshot: Parameters<FlowController["emit"]>[0]) {
    controller.emit(nextSnapshot);
    snapshot = controller.getSnapshot();
  }

  const plan = [
    { id: "step-parse-image", title: "Commander identifies the image target", assignedAgentKind: "commander" as const, status: "pending" as const },
    { id: "step-analyze-image", title: "Vision Agent analyzes image content", assignedAgentKind: "vision" as const, status: "pending" as const },
    { id: "step-verify-vision", title: "Verifier checks the vision result", assignedAgentKind: "verifier" as const, status: "pending" as const },
  ];

  agentTracker.setState("agent-commander", {
    status: "planning",
    task: "Identify image target",
    currentStepId: "step-parse-image",
  });
  agentTracker.setState("agent-vision", { status: "queued", task: "Waiting for image path" });
  agentTracker.setState("agent-verifier", { status: "queued", task: "Waiting for vision result" });

  emit({
    id: taskId,
    title: "Preparing image analysis",
    userGoal,
    status: "planning",
    commanderMessage: "Commander is locating the image path before handing it to Vision Agent.",
    plan,
    agents: agentTracker.getSnapshots(),
    tokenUsage: createEmptyTokenUsageSummary(),
    logs: [
      {
        id: `${taskId}-created`,
        kind: "event",
        title: "task.created",
        detail: "Desktop UI passed an image analysis goal to Core.",
      },
    ],
  });

  await controller.wait();

  let imagePath: string | undefined;
  try {
    imagePath = inferImagePath(userGoal);
    if (!imagePath) {
      throw new Error("Please provide an image path or data URL for Vision Agent.");
    }
    const mode = inferVisionMode(userGoal);

    agentTracker.setState("agent-commander", {
      status: "completed",
      task: "Image target identified",
    });
    const modeLabel =
      mode === "ocr" ? "Extracting visible text" :
      mode === "describe" ? "Describing image content" : "Analyzing image";
    const modeTitle =
      mode === "ocr" ? "Extracting image text" :
      mode === "describe" ? "Describing image" : "Analyzing image";
    const modeCommanderMessage =
      mode === "ocr" ? "Vision Agent is extracting visible text from the image." :
      mode === "describe" ? "Vision Agent is generating a description of the image." :
      "Vision Agent is analyzing the image with a vision-capable model.";
    const modeToolStarted =
      mode === "ocr" ? "vision.extractText started." :
      mode === "describe" ? "vision.describe started." : "vision.analyze started.";

    agentTracker.setState("agent-vision", {
      status: "running",
      task: modeLabel,
      currentStepId: "step-analyze-image",
    });

    emit({
      ...snapshot,
      status: "running",
      title: modeTitle,
      commanderMessage: modeCommanderMessage,
      plan: markVisionStep(snapshot.plan, "step-parse-image", "completed", "step-analyze-image", "running"),
      agents: agentTracker.getSnapshots(),
      logs: appendLog(snapshot, {
        id: `${taskId}-vision-started`,
        kind: "tool",
        title: "tool_call.started",
        detail: modeToolStarted,
      }),
    });

    const result = mode === "ocr"
      ? await visionTool.extractText({ imagePath })
      : mode === "describe"
        ? await visionTool.describe({ imagePath, detail: "detailed" })
        : await visionTool.analyze({ imagePath, question: userGoal });
    const message = mode === "ocr"
      ? (result as { text: string }).text || "No visible text was found."
      : mode === "describe"
        ? (result as { description: string }).description
        : (result as VisionAnalyzeResult).answer || (result as VisionAnalyzeResult).description;

    agentTracker.setState("agent-vision", {
      status: "completed",
      task: "Vision result produced",
    });

    // ── Verifier LLM check ──────────────────────────────────────────────
    const completedTitle =
      mode === "ocr" ? "Image text extracted" :
      mode === "describe" ? "Image described" : "Image analyzed";
    const completedDetail =
      mode === "ocr" ? "vision.extractText completed." :
      mode === "describe" ? "vision.describe completed." : "vision.analyze completed.";

    const verification = verifierTool ? await verifierTool.check({
      stepId: "step-verify-vision",
      successCriteria: "Vision Agent returned a non-empty analysis result that addresses the user's question.",
      evidence: [
        { kind: "log" as const, label: "Vision analysis result", data: result },
        { kind: "log" as const, label: "Image path", data: imagePath },
        { kind: "log" as const, label: "Analysis mode", data: mode },
      ],
    }).catch(() => undefined) : undefined;

    const verificationSummary = verification
      ? `${verification.status}: ${verification.summary}`
      : mode === "describe"
        ? "verified: Vision Agent returned an image description."
        : "verified: Vision Agent returned an image analysis result.";

    if (verification?.status === "fail") {
      agentTracker.setState("agent-verifier", {
        status: "failed",
        task: "Verification failed",
      });
      emit({
        ...snapshot,
        title: "Image analysis failed verification",
        status: "failed",
        commanderMessage: verification.detail || "Vision Agent result did not pass verification.",
        plan: markVisionStep(snapshot.plan, "step-analyze-image", "completed", "step-verify-vision", "failed"),
        agents: agentTracker.getSnapshots(),
        logs: appendLog(snapshot, {
          id: `${taskId}-vision-verification-failed`,
          kind: "verification",
          title: "verification.failed",
          detail: verification.detail,
        }),
        verificationSummary,
      });
      return;
    }

    agentTracker.setState("agent-verifier", {
      status: "completed",
      task: verification ? "Verified by LLM" : "Verified vision result",
    });

    // ── Commander synthesis ──────────────────────────────────────────────
    const synthesis = await safeSynthesizeConclusion(
      commanderTool,
      userGoal,
      "Image Analysis",
      { visionResult: result, verificationStatus: verification?.status, mode },
    );
    const finalMessage = synthesis?.message ?? message;

    emit({
      ...snapshot,
      title: completedTitle,
      status: "completed",
      commanderMessage: finalMessage,
      plan: markVisionStep(snapshot.plan, "step-analyze-image", "completed", "step-verify-vision", "completed"),
      agents: agentTracker.getSnapshots(),
      logs: appendLog(snapshot, {
        id: `${taskId}-vision-completed`,
        kind: "verification",
        title: "task.completed",
        detail: completedDetail,
      }),
      verificationSummary,
    });
  } catch (error) {
    const missingImageTarget = !imagePath;
    agentTracker.setState("agent-commander", {
      status: missingImageTarget ? "failed" : "completed",
      task: missingImageTarget ? "Image target missing" : "Image target identified",
    });
    agentTracker.setState("agent-vision", {
      status: missingImageTarget ? "cancelled" : "failed",
      task: missingImageTarget ? "No image target to analyze" : "Image analysis failed",
    });
    agentTracker.setState("agent-verifier", {
      status: "cancelled",
      task: "No vision result to verify",
    });
    emit({
      ...snapshot,
      title: "Image analysis failed",
      status: "failed",
      commanderMessage: "Vision Agent could not analyze the image.",
      plan: missingImageTarget
        ? markVisionStep(snapshot.plan, "step-parse-image", "failed", "step-analyze-image", "skipped")
        : markVisionStep(snapshot.plan, "step-analyze-image", "failed"),
      agents: agentTracker.getSnapshots(),
      logs: appendLog(snapshot, {
        id: `${taskId}-vision-failed`,
        kind: "tool",
        title: "task.failed",
        detail: error instanceof Error ? error.message : String(error),
      }),
    });
  }
}

function markVisionStep(
  plan: ReturnType<FlowController["getSnapshot"]>["plan"],
  firstStepId: string,
  firstStatus: "completed" | "failed",
  secondStepId?: string,
  secondStatus?: "running" | "completed" | "failed" | "skipped",
) {
  return plan.map((step) => {
    if (step.id === firstStepId) return { ...step, status: firstStatus };
    if (step.id === secondStepId && secondStatus) return { ...step, status: secondStatus };
    return step;
  });
}
