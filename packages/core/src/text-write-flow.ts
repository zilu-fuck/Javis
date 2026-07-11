import type {
  FileTool,
  ModelUsage,
  PermissionRequest as ToolPermissionRequest,
  WebSearchResult,
  WebTool,
} from "@javis/tools";
import { createAgentStateTracker } from "./agent-state-tracker";
import { demoAgents } from "./agents";
import {
  createConfirmedWriteApproval,
  type PendingPermissionHandler,
} from "./confirmed-write";
import type { FlowController } from "./flow-controller";
import type { ID } from "./index";
import { appendLog } from "./snapshot-utils";
import { isTaskCancelledError, throwIfTaskAborted, withTaskTimeout } from "./task-wait";
import { addModelUsage, createEmptyTokenUsageSummary } from "./token-usage";

interface TextContentGenerationTool {
  complete(
    prompt: string,
    options?: { maxTokens?: number; temperature?: number; locale?: string },
  ): Promise<{ text: string; tokenUsage?: ModelUsage }>;
}

interface TextWriteFlowOptions {
  controller: FlowController;
  fileTool: FileTool;
  webTool?: WebTool;
  chatTool?: TextContentGenerationTool;
  taskId: ID;
  userGoal: string;
  signal?: AbortSignal;
  taskTimeoutMs?: number;
  setPendingPermissionHandler(
    requestId: string,
    handler: PendingPermissionHandler | undefined,
  ): void;
}

export function isTextWriteGoal(userGoal: string): boolean {
  // Require an explicit "save/write/export" action verb, not just a mention
  // of "markdown" or "file" in a question context.
  const hasWriteAction =
    /\b(write|save|export|create|generate)\b.*\b(file|md|markdown|notes?|document)\b/i.test(userGoal)
    || /\b(write|save|export)\s+(to|as|a|the)\b/i.test(userGoal)
    || /\u5199\u6210|\u4fdd\u5b58|\u5bfc\u51fa|\u751f\u6210/i.test(userGoal);
  const hasFileTarget =
    /\.md\b|markdown|\u6587\u4ef6|\u6587\u6863/i.test(userGoal);
  return hasWriteAction && hasFileTarget;
}

export async function runTextWriteTask({
  controller,
  fileTool,
  webTool,
  chatTool,
  taskId,
  userGoal,
  signal,
  taskTimeoutMs,
  setPendingPermissionHandler,
}: TextWriteFlowOptions) {
  const agentTracker = createAgentStateTracker(
    demoAgents.filter((agent) => ["commander", "research", "file", "verifier"].includes(agent.kind)),
  );
  let snapshot = controller.getSnapshot();
  function emit(nextSnapshot: Parameters<FlowController["emit"]>[0]) {
    if (signal?.aborted) return;
    controller.emit(nextSnapshot);
    snapshot = controller.getSnapshot();
  }

  const plan = [
    { id: "step-prepare-text", title: "Commander prepares Markdown content", assignedAgentKind: "commander" as const, status: "pending" as const },
    { id: "step-preview-write", title: "File Agent creates a text write dry-run", assignedAgentKind: "file" as const, status: "pending" as const },
    { id: "step-confirm-write", title: "User reviews the confirmed-write permission card", assignedAgentKind: "commander" as const, status: "pending" as const },
    { id: "step-write-text", title: "File Agent writes the approved text file", assignedAgentKind: "file" as const, status: "pending" as const },
    { id: "step-verify-write", title: "Verifier confirms the write result", assignedAgentKind: "verifier" as const, status: "pending" as const },
  ];

  agentTracker.setState("agent-commander", {
    status: "planning",
    task: "Prepare text write workflow",
    currentStepId: "step-prepare-text",
  });
  agentTracker.setState("agent-file", { status: "queued", task: "Waiting for Markdown content" });
  agentTracker.setState("agent-verifier", { status: "queued", task: "Waiting for write result" });

  emit({
    id: taskId,
    title: "Preparing text file write",
    userGoal,
    status: "planning",
    commanderMessage:
      "Commander is preparing text content and will request confirmed-write approval before writing a file.",
    plan,
    agents: agentTracker.getSnapshots(),
    tokenUsage: createEmptyTokenUsageSummary(),
    logs: [
      {
        id: `${taskId}-created`,
        kind: "event",
        title: "task.created",
        detail: "Desktop UI passed the text file write goal to Core.",
      },
    ],
  });

  await controller.wait();
  if (signal?.aborted) return;

  let contentPrepared = false;
  let tokenUsage = createEmptyTokenUsageSummary();
  const recordModelCall = (usage?: ModelUsage) => {
    tokenUsage = addModelUsage(
      tokenUsage,
      "commander",
      usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    );
  };
  try {
    const targetPath = inferMarkdownTargetPath(userGoal);
    const sources = await withTaskTimeout(
      () => collectWriteSources(userGoal, webTool),
      { label: "Text write source collection", timeoutMs: taskTimeoutMs, signal },
    );
    const generated = await generateTextContent(
      userGoal,
      targetPath,
      sources,
      chatTool,
      recordModelCall,
      signal,
      taskTimeoutMs,
    );
    throwIfTaskAborted(signal, "Text write content generation");
    const content = generated.content;
    contentPrepared = true;

    agentTracker.setState("agent-commander", {
      status: "completed",
      task: "Markdown content prepared",
    });
    agentTracker.setState("agent-file", {
      status: "running",
      task: "Creating text write dry-run",
      currentStepId: "step-preview-write",
    });

    emit({
      ...snapshot,
      status: "running",
      title: "Previewing text file write",
      commanderMessage: `File Agent is preparing a dry-run for ${targetPath}. No file has been written.`,
      plan: markTextWriteStep(snapshot.plan, "step-prepare-text", "completed", "step-preview-write", "running"),
      agents: agentTracker.getSnapshots(),
      tokenUsage,
      sources,
      logs: appendLog(snapshot, {
        id: `${taskId}-preview-started`,
        kind: "tool",
        title: "tool_call.planned",
        detail: "file.planWriteText uses preview permission and does not modify local files.",
      }),
    });

    const writePlan = await withTaskTimeout(
      () => Promise.resolve(fileTool.planWriteText?.({ targetPath, content }, taskId)),
      { label: "file.planWriteText", timeoutMs: taskTimeoutMs, signal },
    );
    throwIfTaskAborted(signal, "Text write preview");
    if (!writePlan) {
      throw new Error("Text write preview tool is not available.");
    }

    const confirmedWriteApproval = createConfirmedWriteApproval({
      request: {
        id: `${taskId}-permission`,
        title: "Approve text file write",
        reason: "Writing text to a local file changes the filesystem, so Javis needs explicit approval.",
        dryRun: writePlan.dryRun,
      },
      setPendingPermissionHandler,
      onDenied(resolvedRequest) {
        if (signal?.aborted) return;
        emitDeniedTextWrite({ resolvedRequest, targetPath });
      },
      async onApproved(resolvedRequest) {
        if (signal?.aborted) return;
        await emitApprovedTextWrite({ resolvedRequest, targetPath, content, approvalId: writePlan.approvalId });
      },
    });
    const permissionRequest: ToolPermissionRequest = confirmedWriteApproval.permissionRequest;
    confirmedWriteApproval.listenForDecision();

    agentTracker.setState("agent-file", {
      status: "completed",
      task: "Dry-run ready",
    });
    agentTracker.setState("agent-commander", {
      status: "waiting_permission",
      task: "Waiting for write approval",
      currentStepId: "step-confirm-write",
    });

    emit({
      ...snapshot,
      status: "waiting_permission",
      title: "Text file write needs approval",
      commanderMessage:
        "Dry-run is ready. Review the target path and content size before approving or denying the write step.",
      plan: markTextWriteStep(snapshot.plan, "step-preview-write", "completed", "step-confirm-write", "running"),
      agents: agentTracker.getSnapshots(),
      permissionRequest,
      sources,
      logs: appendLog(snapshot, {
        id: `${taskId}-permission-requested`,
        kind: "permission",
        title: "permission.requested",
        detail: `${writePlan.action} ${writePlan.targetPath} requires confirmed_write approval.`,
      }),
    });
  } catch (error) {
    if (signal?.aborted || isTaskCancelledError(error)) return;
    agentTracker.setState("agent-commander", {
      status: contentPrepared ? "completed" : "failed",
      task: contentPrepared ? "Markdown content prepared" : "Text content generation failed",
    });
    agentTracker.setState("agent-file", {
      status: contentPrepared ? "failed" : "cancelled",
      task: contentPrepared ? "Text write preview failed" : "No generated content to preview",
    });
    agentTracker.setState("agent-verifier", {
      status: "cancelled",
      task: "No file write result to verify",
    });
    emit({
      ...snapshot,
      title: contentPrepared ? "Text file write preparation failed" : "Text content generation failed",
      status: "failed",
      commanderMessage: contentPrepared
        ? "Text file write preparation failed before any write approval was requested."
        : "Javis could not generate complete file content, so no write approval was requested and no file was written.",
      plan: markTextWriteStep(
        snapshot.plan,
        contentPrepared ? "step-preview-write" : "step-prepare-text",
        "failed",
      ),
      agents: agentTracker.getSnapshots(),
      tokenUsage,
      logs: appendLog(snapshot, {
        id: `${taskId}-failed`,
        kind: "verification",
        title: "task.failed",
        detail: error instanceof Error ? error.message : String(error),
      }),
    });
  }

  function emitDeniedTextWrite({
    resolvedRequest,
    targetPath,
  }: {
    resolvedRequest: ToolPermissionRequest;
    targetPath: string;
  }) {
    if (signal?.aborted) return;
    agentTracker.setState("agent-commander", {
      status: "completed",
      task: "Permission decision recorded",
    });
    agentTracker.setState("agent-file", {
      status: "completed",
      task: "No write operation executed",
    });
    agentTracker.setState("agent-verifier", {
      status: "completed",
      task: "Verified denial record",
    });

    emit({
      ...snapshot,
      title: "Text file write denied",
      status: "completed",
      commanderMessage: "Permission was denied. Javis did not write or modify any file.",
      plan: snapshot.plan.map((step) => ({
        ...step,
        status: step.id === "step-write-text" ? "skipped" : "completed",
      })),
      agents: agentTracker.getSnapshots(),
      permissionRequest: resolvedRequest,
      logs: appendLog(snapshot, {
        id: `${taskId}-permission-denied`,
        kind: "permission",
        title: "permission.resolved",
        detail: `User denied ${resolvedRequest.id}; ${targetPath} was not written.`,
      }),
      verificationSummary: "verified: permission denied; no write operation was executed.",
    });
  }

  async function emitApprovedTextWrite({
    resolvedRequest,
    targetPath,
    content,
    approvalId,
  }: {
    resolvedRequest: ToolPermissionRequest;
    targetPath: string;
    content: string;
    approvalId: string;
  }) {
    if (signal?.aborted) return;
    agentTracker.setState("agent-commander", {
      status: "completed",
      task: "Permission decision recorded",
    });
    agentTracker.setState("agent-file", {
      status: "running",
      task: "Writing approved text file",
      currentStepId: "step-write-text",
    });

    emit({
      ...snapshot,
      status: "running",
      commanderMessage: "Permission was approved. File Agent is writing only the approved text content.",
      plan: markTextWriteStep(snapshot.plan, "step-confirm-write", "completed", "step-write-text", "running"),
      agents: agentTracker.getSnapshots(),
      permissionRequest: resolvedRequest,
      logs: appendLog(snapshot, {
        id: `${taskId}-write-started`,
        kind: "tool",
        title: "tool_call.started",
        detail: `file.writeText started for ${targetPath}.`,
      }),
    });

    try {
      if (signal?.aborted) return;
      if (!fileTool.writeText) {
        throw new Error("Text write execution tool is not available.");
      }
      // Native writes are the commit point: once started they cannot be safely
      // cancelled, so await the real result and keep the UI aligned with disk.
      const result = await fileTool.writeText({ targetPath, content }, approvalId, taskId);
      agentTracker.setState("agent-file", {
        status: "completed",
        task: `Wrote ${result.byteCount} bytes`,
      });
      agentTracker.setState("agent-verifier", {
        status: "completed",
        task: "Verified write result",
      });

      emit({
        ...snapshot,
        title: "Text file written",
        status: "completed",
        commanderMessage: `File Agent wrote ${result.targetPath}.`,
        plan: markTextWriteStep(snapshot.plan, "step-write-text", "completed", "step-verify-write", "completed"),
        agents: agentTracker.getSnapshots(),
        permissionRequest: resolvedRequest,
        logs: appendLog(snapshot, {
          id: `${taskId}-write-completed`,
          kind: "verification",
          title: "task.completed",
          detail: `file.writeText ${result.action} wrote ${result.byteCount} byte(s) to ${result.targetPath}.`,
        }),
        verificationSummary: `verified: ${result.targetPath} was written after confirmed_write approval.`,
      });
    } catch (error) {
      if (signal?.aborted) return;
      agentTracker.setState("agent-commander", {
        status: "completed",
        task: "Permission decision recorded",
      });
      agentTracker.setState("agent-file", {
        status: "failed",
        task: "Approved text write failed",
      });
      agentTracker.setState("agent-verifier", {
        status: "cancelled",
        task: "No complete result to verify",
      });

      emit({
        ...snapshot,
        title: "Text file write failed",
        status: "failed",
        commanderMessage:
          "The approved write step failed. Verifier has no completed file write result to validate.",
        plan: markTextWriteStep(snapshot.plan, "step-write-text", "failed"),
        agents: agentTracker.getSnapshots(),
        permissionRequest: resolvedRequest,
        logs: appendLog(snapshot, {
          id: `${taskId}-write-failed`,
          kind: "tool",
          title: "task.failed",
          detail: error instanceof Error ? error.message : String(error),
        }),
      });
    }
  }
}

function markTextWriteStep(
  plan: ReturnType<FlowController["getSnapshot"]>["plan"],
  firstStepId: string | undefined,
  firstStatus: "completed" | "failed",
  secondStepId?: string,
  secondStatus?: "running" | "completed",
) {
  return plan.map((step) => {
    if (step.id === firstStepId) {
      return { ...step, status: firstStatus };
    }
    if (step.id === secondStepId && secondStatus) {
      return { ...step, status: secondStatus };
    }
    return step;
  });
}

async function collectWriteSources(
  userGoal: string,
  webTool?: WebTool,
): Promise<WebSearchResult[]> {
  if (!webTool?.searchWeb || !/search|research|latest|hot|trend|\u641c\u7d22|\u67e5|\u6700\u8fd1|\u70ed\u70b9/i.test(userGoal)) {
    return [];
  }
  return webTool.searchWeb({ query: stripTargetPath(userGoal), maxResults: 5 }).catch(() => []);
}

const TEXT_GENERATION_TOKENS_PER_CALL = 4096;
const MAX_TEXT_GENERATION_CALLS = 8;
const TEXT_GENERATION_CALL_BUFFER = 1;

interface RequestedLength {
  amount: number;
  unit: "characters" | "words";
}

async function generateTextContent(
  userGoal: string,
  targetPath: string,
  sources: WebSearchResult[],
  chatTool?: TextContentGenerationTool,
  recordModelCall: (usage?: ModelUsage) => void = () => undefined,
  signal?: AbortSignal,
  taskTimeoutMs?: number,
): Promise<{ content: string }> {
  if (!chatTool) {
    throw new Error("A configured text-generation model is required before a file write can be previewed.");
  }

  const requestedLength = inferRequestedLength(userGoal);
  const locale = /[\u3400-\u9fff]/u.test(userGoal) ? "zh-CN" : "en";
  const maxCalls = getTextGenerationCallLimit(requestedLength);
  const complete = async (prompt: string, temperature: number): Promise<string> => {
    let result: Awaited<ReturnType<TextContentGenerationTool["complete"]>>;
    let modelCallStarted = false;
    try {
      result = await withTaskTimeout(
        () => {
          modelCallStarted = true;
          return chatTool.complete(prompt, {
            maxTokens: TEXT_GENERATION_TOKENS_PER_CALL,
            temperature,
            locale,
          });
        },
        { label: "Text content generation", timeoutMs: taskTimeoutMs, signal },
      );
    } catch (error) {
      if (modelCallStarted) recordModelCall();
      throw error;
    }
    recordModelCall(result.tokenUsage);
    throwIfTaskAborted(signal, "Text content generation");
    return normalizeGeneratedContent(result.text);
  };

  let callCount = 1;
  let content = await complete(
    buildTextGenerationPrompt(userGoal, targetPath, sources, requestedLength),
    /novel|story|poem|\u5c0f\u8bf4|\u6545\u4e8b|\u8bd7/i.test(userGoal) ? 0.7 : 0.3,
  );

  while (
    requestedLength &&
    callCount < maxCalls &&
    measureGeneratedLength(content, requestedLength.unit) < requestedLength.amount
  ) {
    const currentLength = measureGeneratedLength(content, requestedLength.unit);
    const continuation = await complete(
      buildTextContinuationPrompt(
        userGoal,
        content,
        requestedLength.amount - currentLength,
        requestedLength.unit,
      ),
      0.7,
    );
    callCount += 1;
    if (!continuation) break;
    content = `${content.trimEnd()}\n\n${continuation}`;
  }

  validateGeneratedContent(content, requestedLength);
  return { content: `${content.trim()}\n` };
}

function buildTextGenerationPrompt(
  userGoal: string,
  targetPath: string,
  sources: WebSearchResult[],
  requestedLength?: RequestedLength,
): string {
  const sourceText = sources.length > 0
    ? sources.map((source, index) => [
        `[${index + 1}] ${source.title || source.url}`,
        source.url,
        source.excerpt ?? "",
      ].filter(Boolean).join("\n")).join("\n\n")
    : "No external sources were collected.";
  const lengthInstruction = requestedLength
    ? `The complete document must contain at least ${requestedLength.amount} ${requestedLength.unit}.`
    : "Use the length and level of detail requested by the user.";

  return [
    "You are generating the complete contents of a local Markdown file for the user.",
    "Return ONLY the final file contents. Do not use an outer code fence.",
    "Do not mention execution, approval, file paths, prompts, or internal process.",
    "Do not repeat the request as a placeholder. Fully perform the requested writing task.",
    "Write in the same language as the user's request unless the request says otherwise.",
    lengthInstruction,
    `Target file: ${targetPath}`,
    `User request: ${userGoal}`,
    `Available sources:\n${sourceText}`,
  ].join("\n\n");
}

function buildTextContinuationPrompt(
  userGoal: string,
  content: string,
  remaining: number,
  unit: RequestedLength["unit"],
): string {
  return [
    "Continue the document below from exactly where it ends.",
    `Add at least ${remaining} more ${unit} so the original request is complete.`,
    "Return ONLY new continuation text. Do not repeat the title, earlier sections, or these instructions.",
    `Original request: ${userGoal}`,
    `Current ending:\n${content.slice(-4000)}`,
  ].join("\n\n");
}

function inferRequestedLength(userGoal: string): RequestedLength | undefined {
  const match = userGoal.match(/(\d[\d,]{0,6})\s*(?:\u4e2a)?(\u5b57|\u6c49\u5b57|characters?|words?)/i);
  if (!match) return undefined;
  const amount = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  return {
    amount,
    unit: /words?/i.test(match[2]) ? "words" : "characters",
  };
}

function getTextGenerationCallLimit(requestedLength?: RequestedLength): number {
  if (!requestedLength) return 1;
  const multiplier = requestedLength.unit === "words" ? 1.8 : 1.5;
  return Math.min(
    MAX_TEXT_GENERATION_CALLS,
    Math.max(
      1,
      Math.ceil((requestedLength.amount * multiplier) / TEXT_GENERATION_TOKENS_PER_CALL) +
        TEXT_GENERATION_CALL_BUFFER,
    ),
  );
}

function normalizeGeneratedContent(content: string): string {
  return content
    .trim()
    .replace(/^```(?:markdown|md)?\s*\r?\n/i, "")
    .replace(/\r?\n```\s*$/i, "")
    .trim();
}

function validateGeneratedContent(content: string, requestedLength?: RequestedLength): void {
  if (!content.trim()) {
    throw new Error("The text-generation model returned empty file content.");
  }
  if (/Generated from request:/i.test(content) && /## Notes/i.test(content)) {
    throw new Error("The text-generation model returned a placeholder instead of complete file content.");
  }
  if (!requestedLength) return;
  const actualLength = measureGeneratedLength(content, requestedLength.unit);
  if (actualLength < requestedLength.amount) {
    throw new Error(
      `Generated content is incomplete: requested at least ${requestedLength.amount} ${requestedLength.unit}, received ${actualLength}.`,
    );
  }
}

function measureGeneratedLength(content: string, unit: RequestedLength["unit"]): number {
  if (unit === "words") {
    return content.match(/[\p{L}\p{N}]+(?:['\u2019-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
  }
  return content.replace(/\s/gu, "").length;
}

function inferMarkdownTargetPath(userGoal: string): string {
  const quotedPath = userGoal.match(/["'`]([^"'`]+\.md)["'`]/i)?.[1];
  if (quotedPath) return quotedPath.trim();
  const path = userGoal.match(/([A-Za-z]:[\\/][^\s"'`]+\.md|(?:\.{1,2}[\\/])?[^\s"'`]+\.md)/i)?.[1];
  return path?.trim() || "javis-output.md";
}

function stripTargetPath(userGoal: string): string {
  return userGoal.replace(/["'`]?([A-Za-z]:[\\/][^\s"'`]+\.md|(?:\.{1,2}[\\/])?[^\s"'`]+\.md)["'`]?/gi, "").trim();
}
