import type {
  FileTool,
  ModelUsage,
  PermissionRequest as ToolPermissionRequest,
  TextFileWritePlan,
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
import type { ChatTool, ID } from "./index";
import { appendLog, appendTaskLogEntry } from "./snapshot-utils";
import type { TaskEventBus } from "./task-event-bus";
import { isTaskCancelledError, throwIfTaskAborted, withTaskTimeout } from "./task-wait";
import { addModelUsage, createEmptyTokenUsageSummary } from "./token-usage";

interface TextWriteFlowOptions {
  controller: FlowController;
  eventBus?: TaskEventBus;
  fileTool: FileTool;
  webTool?: WebTool;
  chatTool?: ChatTool;
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
  eventBus,
  fileTool,
  webTool,
  chatTool,
  taskId,
  userGoal,
  signal,
  taskTimeoutMs,
  setPendingPermissionHandler,
}: TextWriteFlowOptions) {
  const isChinese = /[\u3400-\u9fff]/u.test(userGoal);
  const tr = (english: string, chinese: string) => isChinese ? chinese : english;
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
    { id: "step-prepare-text", title: tr("Commander prepares Markdown content", "指挥官准备 Markdown 正文"), assignedAgentKind: "commander" as const, status: "pending" as const },
    { id: "step-preview-write", title: tr("File Agent creates a text write dry-run", "文件代理创建文本写入预览"), assignedAgentKind: "file" as const, status: "pending" as const },
    { id: "step-confirm-write", title: tr("User reviews the confirmed-write permission card", "用户审核确认写入授权卡片"), assignedAgentKind: "commander" as const, status: "pending" as const },
    { id: "step-write-text", title: tr("File Agent writes the approved text file", "文件代理写入已批准的文本文件"), assignedAgentKind: "file" as const, status: "pending" as const },
    { id: "step-verify-write", title: tr("Verifier confirms the write result", "验证器确认写入结果"), assignedAgentKind: "verifier" as const, status: "pending" as const },
  ];

  agentTracker.setState("agent-commander", {
    status: "planning",
    task: tr("Prepare text write workflow", "准备文本写入流程"),
    currentStepId: "step-prepare-text",
  });
  agentTracker.setState("agent-file", { status: "queued", task: tr("Waiting for Markdown content", "等待 Markdown 正文") });
  agentTracker.setState("agent-verifier", { status: "queued", task: tr("Waiting for write result", "等待写入结果") });

  emit({
    id: taskId,
    title: tr("Preparing text file write", "正在准备文本文件写入"),
    userGoal,
    status: "planning",
    commanderMessage: tr(
      "Commander is preparing text content and will request confirmed-write approval before writing a file.",
      "指挥官正在准备文本内容，写入文件前会请求确认写入授权。",
    ),
    plan,
    agents: agentTracker.getSnapshots(),
    tokenUsage: createEmptyTokenUsageSummary(),
    logs: [
      {
        id: `${taskId}-created`,
        kind: "event",
        title: "task.created",
        detail: "Desktop UI passed the text file write goal to Core.",
        userMessage: tr("Preparing the text file task.", "正在准备文本文件任务。"),
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
    const inferredTarget = inferMarkdownTarget(userGoal);
    let targetPath = inferredTarget.path;
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
      eventBus,
      taskId,
      signal,
      taskTimeoutMs,
    );
    throwIfTaskAborted(signal, "Text write content generation");
    const content = generated.content;
    if (!inferredTarget.explicit) {
      targetPath = inferMarkdownTargetFromContent(content) ?? targetPath;
    }
    contentPrepared = true;

    agentTracker.setState("agent-commander", {
      status: "completed",
      task: tr("Markdown content prepared", "Markdown 正文已准备"),
    });
    agentTracker.setState("agent-file", {
      status: "running",
      task: tr("Creating text write dry-run", "正在创建文本写入预览"),
      currentStepId: "step-preview-write",
    });

    emit({
      ...snapshot,
      status: "running",
      title: tr("Previewing text file write", "正在预览文本文件写入"),
      commanderMessage: tr(
        `File Agent is preparing a dry-run for ${targetPath}. No file has been written.`,
        `文件代理正在为 ${targetPath} 创建写入预览，尚未写入文件。`,
      ),
      plan: markTextWriteStep(snapshot.plan, "step-prepare-text", "completed", "step-preview-write", "running"),
      agents: agentTracker.getSnapshots(),
      tokenUsage,
      sources,
      logs: appendLog(snapshot, {
        id: `${taskId}-preview-started`,
        kind: "tool",
        title: "tool_call.planned",
        detail: "file.planWriteText uses preview permission and does not modify local files.",
        userMessage: tr("Preparing a safe file write preview.", "正在生成安全的文件写入预览。"),
      }),
    });

    const preview = await planTextWriteWithAvailableTarget({
      fileTool,
      targetPath,
      content,
      taskId,
      allowConflictRename: !inferredTarget.explicit,
      signal,
      taskTimeoutMs,
    });
    targetPath = preview.targetPath;
    const writePlan = preview.plan;

    const confirmedWriteApproval = createConfirmedWriteApproval({
      request: {
        id: `${taskId}-permission`,
        title: tr("Approve text file write", "批准文本文件写入"),
        reason: tr(
          "Writing text to a local file changes the filesystem, so Javis needs explicit approval.",
          "将文本写入本地文件会更改文件系统，因此 Javis 需要你的明确授权。",
        ),
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
      task: tr("Dry-run ready", "写入预览已就绪"),
    });
    agentTracker.setState("agent-commander", {
      status: "waiting_permission",
      task: tr("Waiting for write approval", "等待写入授权"),
      currentStepId: "step-confirm-write",
    });

    emit({
      ...snapshot,
      status: "waiting_permission",
      title: tr("Text file write needs approval", "文本文件写入需要授权"),
      commanderMessage: tr(
        "Dry-run is ready. Review the target path and content size before approving or denying the write step.",
        "写入预览已就绪。请检查目标路径和内容大小，然后批准或拒绝写入。",
      ),
      plan: markTextWriteStep(snapshot.plan, "step-preview-write", "completed", "step-confirm-write", "running"),
      agents: agentTracker.getSnapshots(),
      permissionRequest,
      sources,
      logs: appendTaskLogEntry(
        appendLog(snapshot, {
          id: `${taskId}-preview-completed`,
          kind: "tool",
          title: "tool_call.completed",
          detail: `file.planWriteText completed for ${writePlan.targetPath}.`,
          userMessage: tr("File write preview is ready.", "文件写入预览已就绪。"),
        }),
        {
          id: `${taskId}-permission-requested`,
          kind: "permission",
          title: "permission.requested",
          detail: `${writePlan.action} ${writePlan.targetPath} requires confirmed_write approval.`,
          userMessage: tr("Waiting for confirmed-write approval.", "正在等待确认写入授权。"),
        },
      ),
    });
  } catch (error) {
    if (signal?.aborted || isTaskCancelledError(error)) return;
    agentTracker.setState("agent-commander", {
      status: contentPrepared ? "completed" : "failed",
      task: contentPrepared
        ? tr("Markdown content prepared", "Markdown 正文已准备")
        : tr("Text content generation failed", "文本内容生成失败"),
    });
    agentTracker.setState("agent-file", {
      status: contentPrepared ? "failed" : "cancelled",
      task: contentPrepared
        ? tr("Text write preview failed", "文本写入预览失败")
        : tr("No generated content to preview", "没有可预览的生成内容"),
    });
    agentTracker.setState("agent-verifier", {
      status: "cancelled",
      task: tr("No file write result to verify", "没有可验证的文件写入结果"),
    });
    emit({
      ...snapshot,
      title: contentPrepared
        ? tr("Text file write preparation failed", "文本文件写入准备失败")
        : tr("Text content generation failed", "文本内容生成失败"),
      status: "failed",
      commanderMessage: contentPrepared
        ? tr(
            "Text file write preparation failed before any write approval was requested.",
            "文本文件写入准备失败，尚未请求写入授权。",
          )
        : tr(
            "Javis could not generate complete file content, so no write approval was requested and no file was written.",
            "Javis 未能生成完整的文件内容，因此没有请求写入授权，也没有写入任何文件。",
          ),
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
        userMessage: tr("Text file task failed.", "文本文件任务失败。"),
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
      task: tr("Permission decision recorded", "授权决定已记录"),
    });
    agentTracker.setState("agent-file", {
      status: "completed",
      task: tr("No write operation executed", "未执行写入操作"),
    });
    agentTracker.setState("agent-verifier", {
      status: "completed",
      task: tr("Verified denial record", "已验证拒绝记录"),
    });

    emit({
      ...snapshot,
      title: tr("Text file write denied", "文本文件写入已拒绝"),
      status: "completed",
      commanderMessage: tr(
        "Permission was denied. Javis did not write or modify any file.",
        "你已拒绝授权，Javis 没有写入或修改任何文件。",
      ),
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
        userMessage: tr("Write permission was denied; no file was changed.", "写入授权已拒绝，没有文件被更改。"),
      }),
      verificationSummary: tr(
        "verified: permission denied; no write operation was executed.",
        "已验证：授权被拒绝，未执行写入操作。",
      ),
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
      task: tr("Permission decision recorded", "授权决定已记录"),
    });
    agentTracker.setState("agent-file", {
      status: "running",
      task: tr("Writing approved text file", "正在写入已批准的文本文件"),
      currentStepId: "step-write-text",
    });

    emit({
      ...snapshot,
      status: "running",
      commanderMessage: tr(
        "Permission was approved. File Agent is writing only the approved text content.",
        "授权已批准，文件代理正在写入已批准的文本内容。",
      ),
      plan: markTextWriteStep(snapshot.plan, "step-confirm-write", "completed", "step-write-text", "running"),
      agents: agentTracker.getSnapshots(),
      permissionRequest: resolvedRequest,
      logs: appendLog(snapshot, {
        id: `${taskId}-write-started`,
        kind: "tool",
        title: "tool_call.started",
        detail: `file.writeText started for ${targetPath}.`,
        userMessage: tr("Writing the approved text file.", "正在写入已批准的文本文件。"),
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
        task: tr(`Wrote ${result.byteCount} bytes`, `已写入 ${result.byteCount} 字节`),
      });
      agentTracker.setState("agent-verifier", {
        status: "completed",
        task: tr("Verified write result", "已验证写入结果"),
      });

      emit({
        ...snapshot,
        title: tr("Text file written", "文本文件已写入"),
        status: "completed",
        commanderMessage: tr(
          `File Agent wrote ${result.targetPath}.`,
          `文件代理已将内容写入 ${result.targetPath}。`,
        ),
        plan: markTextWriteStep(snapshot.plan, "step-write-text", "completed", "step-verify-write", "completed"),
        agents: agentTracker.getSnapshots(),
        documents: [{
          path: result.targetPath,
          modifiedAt: new Date().toISOString(),
          sizeBytes: result.byteCount,
          heading: extractMarkdownHeading(content),
          excerpt: content.slice(0, 280).trim(),
          purpose: tr("Generated from the user's text file request.", "根据用户的文本文件请求生成。"),
        }],
        permissionRequest: resolvedRequest,
        logs: appendLog(snapshot, {
          id: `${taskId}-write-completed`,
          kind: "verification",
          title: "task.completed",
          detail: `file.writeText ${result.action} wrote ${result.byteCount} byte(s) to ${result.targetPath}.`,
          userMessage: tr("Text file written successfully.", "文本文件已成功写入。"),
        }),
        verificationSummary: tr(
          `verified: ${result.targetPath} was written after confirmed_write approval.`,
          `已验证：${result.targetPath} 已在确认写入授权后完成写入。`,
        ),
      });
    } catch (error) {
      if (signal?.aborted) return;
      agentTracker.setState("agent-commander", {
        status: "completed",
        task: tr("Permission decision recorded", "授权决定已记录"),
      });
      agentTracker.setState("agent-file", {
        status: "failed",
        task: tr("Approved text write failed", "已批准的文本写入失败"),
      });
      agentTracker.setState("agent-verifier", {
        status: "cancelled",
        task: tr("No complete result to verify", "没有可验证的完整结果"),
      });

      emit({
        ...snapshot,
        title: tr("Text file write failed", "文本文件写入失败"),
        status: "failed",
        commanderMessage: tr(
          "The approved write step failed. Verifier has no completed file write result to validate.",
          "已批准的写入步骤失败，验证器没有可验证的完整文件写入结果。",
        ),
        plan: markTextWriteStep(snapshot.plan, "step-write-text", "failed"),
        agents: agentTracker.getSnapshots(),
        permissionRequest: resolvedRequest,
        logs: appendLog(snapshot, {
          id: `${taskId}-write-failed`,
          kind: "tool",
          title: "task.failed",
          detail: error instanceof Error ? error.message : String(error),
          userMessage: tr("The approved text file write failed.", "已批准的文本文件写入失败。"),
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

const MAX_TEXT_GENERATION_CALLS = 8;
const MAX_AUTO_TARGET_ATTEMPTS = 100;
const TEXT_TARGET_EXISTS_ERROR =
  "Text write target already exists; overwriting is not supported in v1.";

interface RequestedLength {
  amount: number;
  unit: "characters" | "words";
}

interface GeneratedTextCall {
  content: string;
  truncated: boolean;
}

async function planTextWriteWithAvailableTarget({
  fileTool,
  targetPath,
  content,
  taskId,
  allowConflictRename,
  signal,
  taskTimeoutMs,
}: {
  fileTool: FileTool;
  targetPath: string;
  content: string;
  taskId: ID;
  allowConflictRename: boolean;
  signal?: AbortSignal;
  taskTimeoutMs?: number;
}): Promise<{ plan: TextFileWritePlan; targetPath: string }> {
  if (!fileTool.planWriteText) {
    throw new Error("Text write preview tool is not available.");
  }
  const attemptCount = allowConflictRename ? MAX_AUTO_TARGET_ATTEMPTS : 1;
  for (let attempt = 0; attempt < attemptCount; attempt += 1) {
    const candidatePath = attempt === 0
      ? targetPath
      : appendMarkdownTargetSuffix(targetPath, attempt + 1);
    try {
      const plan = await withTaskTimeout(
        () => fileTool.planWriteText!({ targetPath: candidatePath, content }, taskId),
        { label: "file.planWriteText", timeoutMs: taskTimeoutMs, signal },
      );
      throwIfTaskAborted(signal, "Text write preview");
      return { plan, targetPath: candidatePath };
    } catch (error) {
      if (
        !allowConflictRename ||
        attempt === attemptCount - 1 ||
        !isExistingTextTargetError(error)
      ) {
        throw error;
      }
    }
  }
  throw new Error("No available text write target could be planned.");
}

function isExistingTextTargetError(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.includes(TEXT_TARGET_EXISTS_ERROR);
}

function appendMarkdownTargetSuffix(targetPath: string, suffix: number): string {
  const match = targetPath.match(/^(.*)(\.md)$/i);
  return match ? `${match[1]}-${suffix}${match[2]}` : `${targetPath}-${suffix}`;
}

async function generateTextContent(
  userGoal: string,
  targetPath: string,
  sources: WebSearchResult[],
  chatTool?: ChatTool,
  recordModelCall: (usage?: ModelUsage) => void = () => undefined,
  eventBus?: TaskEventBus,
  taskId?: ID,
  signal?: AbortSignal,
  taskTimeoutMs?: number,
): Promise<{ content: string }> {
  if (!chatTool) {
    throw new Error("A configured text-generation model is required before a file write can be previewed.");
  }

  const requestedLength = inferRequestedLength(userGoal);
  const locale = /[\u3400-\u9fff]/u.test(userGoal) ? "zh-CN" : "en";
  const complete = async (prompt: string, temperature: number): Promise<GeneratedTextCall> => {
    if (chatTool.stream && eventBus && taskId) {
      let streamedText = "";
      let tokenUsage: ModelUsage | undefined;
      let finishReason: string | undefined;
      let modelCallRecorded = false;
      eventBus.emit({ kind: "agent.chunk_start", taskId, agentKind: "commander" });
      try {
        await withTaskTimeout(
          async () => {
            for await (const chunk of chatTool.stream!(prompt, {
              useMaxOutputTokens: true,
              temperature,
              locale,
              timeoutMs: taskTimeoutMs,
              onUsage: (usage) => {
                tokenUsage = usage;
              },
              onFinish: (reason) => {
                finishReason = reason;
              },
            })) {
              throwIfTaskAborted(signal, "Text content generation");
              streamedText += chunk.text;
              eventBus.emit({
                kind: "agent.chunk",
                taskId,
                agentKind: "commander",
                text: chunk.text,
              });
              await new Promise<void>((resolve) => setTimeout(resolve, 0));
            }
          },
          { label: "Text content generation", timeoutMs: taskTimeoutMs, signal },
        );
        recordModelCall(tokenUsage);
        modelCallRecorded = true;
        eventBus.emit({
          kind: "agent.chunk_end",
          taskId,
          agentKind: "commander",
          fullText: streamedText,
        });
        return {
          content: normalizeGeneratedContent(streamedText),
          truncated: isTruncatedTextGeneration(finishReason),
        };
      } catch (error) {
        if (!modelCallRecorded) {
          recordModelCall(tokenUsage);
        }
        eventBus.emit({
          kind: "agent.chunk_end",
          taskId,
          agentKind: "commander",
          fullText: streamedText,
          error: error instanceof Error ? error.message : String(error),
        });
        throwIfTaskAborted(signal, "Text content generation");
      }
    }

    let result: Awaited<ReturnType<ChatTool["complete"]>>;
    let modelCallStarted = false;
    try {
      result = await withTaskTimeout(
        () => {
          modelCallStarted = true;
          return chatTool.complete(prompt, {
            useMaxOutputTokens: true,
            temperature,
            locale,
            timeoutMs: taskTimeoutMs,
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
    return {
      content: normalizeGeneratedContent(result.text),
      truncated: isTruncatedTextGeneration(result.finishReason),
    };
  };

  let callCount = 1;
  const initialCall = await complete(
    buildTextGenerationPrompt(userGoal, targetPath, sources, requestedLength),
    /novel|story|poem|\u5c0f\u8bf4|\u6545\u4e8b|\u8bd7/i.test(userGoal) ? 0.7 : 0.3,
  );
  let content = initialCall.content;
  let lastCallTruncated = initialCall.truncated;

  while (
    callCount < MAX_TEXT_GENERATION_CALLS &&
    (
      lastCallTruncated ||
      Boolean(
        requestedLength &&
        measureGeneratedLength(content, requestedLength.unit) < requestedLength.amount,
      )
    )
  ) {
    const currentLength = requestedLength
      ? measureGeneratedLength(content, requestedLength.unit)
      : 0;
    const continuation = await complete(
      buildTextContinuationPrompt(
        userGoal,
        content,
        requestedLength
          ? {
              amount: Math.max(1, requestedLength.amount - currentLength),
              unit: requestedLength.unit,
            }
          : undefined,
      ),
      0.7,
    );
    callCount += 1;
    lastCallTruncated = continuation.truncated;
    if (!continuation.content) break;
    content = `${content.trimEnd()}\n\n${continuation.content}`;
  }

  if (lastCallTruncated) {
    throw new Error(
      `Text content generation remained truncated after ${callCount} model call(s).`,
    );
  }

  validateGeneratedContent(content, requestedLength);
  return { content: `${content.trim()}\n` };
}

function isTruncatedTextGeneration(finishReason?: string): boolean {
  if (!finishReason) return false;
  return /^(?:length|max[_ -]?(?:tokens|output(?:[_ -]?tokens)?))$/iu.test(finishReason.trim());
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
  remaining?: RequestedLength,
): string {
  return [
    "Continue the document below from exactly where it ends.",
    remaining
      ? `Add at least ${remaining.amount} more ${remaining.unit} so the original request is complete.`
      : "Finish the document completely without introducing an arbitrary length target.",
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

function inferMarkdownTarget(userGoal: string): { path: string; explicit: boolean } {
  const quotedPath = userGoal.match(/["'`]([^"'`]+\.md)["'`]/i)?.[1];
  if (quotedPath) return { path: quotedPath.trim(), explicit: true };
  const namedPath = userGoal.match(
    /(?:\u4fdd\u5b58\u4e3a?|\u6587\u4ef6\u540d(?:\u4e3a|\u662f)?|\u547d\u540d\u4e3a)\s*([^\\/\s"'`\uff0c,\u3002\uff1b;]+\.md)/iu,
  )?.[1];
  if (namedPath) return { path: namedPath.trim(), explicit: true };
  const path = userGoal.match(/([A-Za-z]:[\\/][^\s"'`]+\.md|(?:\.{1,2}[\\/])?[^\s"'`]+\.md)/i)?.[1];
  return path
    ? { path: path.trim(), explicit: true }
    : { path: inferMarkdownTargetFromGoal(userGoal), explicit: false };
}

function inferMarkdownTargetFromContent(content: string): string | undefined {
  const heading = extractMarkdownHeading(content);
  return heading ? buildMarkdownTarget(heading) : undefined;
}

function extractMarkdownHeading(content: string): string | undefined {
  return content.match(/^\s*#\s+(.+?)\s*#*\s*(?:\r?\n|$)/u)?.[1];
}

function inferMarkdownTargetFromGoal(userGoal: string): string {
  const summarizedGoal = stripTargetPath(userGoal)
    .replace(/\d[\d,]{0,6}\s*(?:\u4e2a)?(?:\u5b57|\u6c49\u5b57|characters?|words?)(?:\u5de6\u53f3|\u4e0a\u4e0b|\u4ee5\u4e0a|\u4ee5\u5185)?/giu, " ")
    .replace(/\b(?:please|write|create|generate|save|export|as|to|a|an|the|markdown|md|file|document)\b/giu, " ")
    .replace(/(?:\u8bf7|\u5e2e\u6211|\u5199\u4e00(?:\u7bc7|\u4efd|\u4e2a)?|\u521b\u4f5c|\u751f\u6210|\u521b\u5efa|\u4fdd\u5b58\u4e3a?|\u5bfc\u51fa\u4e3a?|markdown|md|\u6587\u4ef6|\u6587\u6863)/giu, " ");
  return buildMarkdownTarget(summarizedGoal) ?? "untitled-document.md";
}

function buildMarkdownTarget(value: string): string | undefined {
  const normalized = value
    .normalize("NFKC")
    .replace(/\.md$/iu, "")
    .replace(/[`*_~\[\](){}<>:"/\\|?*\u0000-\u001f]/gu, " ")
    .replace(/[.,;!\u3002\uff0c\uff1b\uff01\uff1f\u3001\uff1a]+/gu, " ")
    .trim()
    .replace(/\s+/gu, "-")
    .replace(/^[.\-_]+|[.\-_]+$/gu, "")
    .toLocaleLowerCase();
  if (!normalized) return undefined;
  const basename = Array.from(normalized).slice(0, 64).join("").replace(/[.\-_]+$/gu, "");
  if (!basename) return undefined;
  const windowsReservedName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(basename);
  return `${windowsReservedName ? `document-${basename}` : basename}.md`;
}

function stripTargetPath(userGoal: string): string {
  return userGoal.replace(/["'`]?([A-Za-z]:[\\/][^\s"'`]+\.md|(?:\.{1,2}[\\/])?[^\s"'`]+\.md)["'`]?/gi, "").trim();
}
