import type {
  FileTool,
  VerifierTool,
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
import { DEFAULT_TASK_TIMEOUT_MS, isTaskCancelledError, isTaskStallError, TaskTimeoutError, throwIfTaskAborted, withStallWatchdog, withTaskTimeout } from "./task-wait";
import { addModelUsage, createEmptyTokenUsageSummary } from "./token-usage";
import { decideTextWriteContract } from "./text-write-contract";
import { verifyTextWriteArtifact } from "./text-write-verification";

interface TextWriteFlowOptions {
  controller: FlowController;
  eventBus?: TaskEventBus;
  fileTool: FileTool;
  webTool?: WebTool;
  verifierTool?: VerifierTool;
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

/**
 * Goals that *ask about* creating something rather than *instructing* Javis to
 * write a file. These must not open a confirmed-write flow.
 */
const TEXT_WRITE_QUESTION_PATTERN =
  /^\s*(?:如何|怎么|怎样|为什么|什么是|请问|能否|可不可以|是不是)|[?？]\s*$|\b(?:how (?:do|can|would|should) i|how to|what is|why (?:is|does)|can you explain)\b/iu;

/** Goals whose intent is to review/analyse existing material, not produce a file. */
const TEXT_WRITE_REVIEW_PATTERN =
  /评审|审查|检查一下|排查|分析一下|解释|总结一下|回顾|复盘|\b(?:review|explain|analy[sz]e|summari[sz]e|inspect)\b/iu;

/** An explicit write destination: "保存到 X" / "save to X" / any file extension. */
const TEXT_WRITE_EXPLICIT_DESTINATION =
  /(?:保存到|保存为|写入到|写到|导出到|输出到|生成到)|(?:\bsave|\bwrite|\bexport)\s+(?:it\s+|this\s+|the\s+\w+\s+)?(?:to|into|as)\b|\.[a-z0-9]{1,5}\b/iu;

export function isTextWriteGoal(userGoal: string): boolean {
  // Require an explicit write/create action plus a concrete file/page target.
  // Mentions of "file" in a pure question are not enough.
  const hasWriteAction =
    /\b(write|save|export|create|generate|build)\b/i.test(userGoal)
    || /写成|保存|导出|生成|创建|新建|做一个|做一份|写一个|写一份/i.test(userGoal);
  const hasFileTarget =
    /\.(md|txt|html?|css|js|ts|tsx|jsx|json|docx|pdf)\b/i.test(userGoal)
    || /\bHTML\b/i.test(userGoal)
    // Bilingual target nouns: an English goal must classify like its Chinese twin.
    || /文件|文档|页面|网页|脚本|笔记|报告|\b(?:file|document|docs?|page|web ?page|script|notes?|report|markdown)\b/i.test(userGoal);
  if (!hasWriteAction || !hasFileTarget) {
    return false;
  }
  // A goal that names where to write is unambiguous, whatever its grammar.
  if (TEXT_WRITE_EXPLICIT_DESTINATION.test(userGoal)) {
    return true;
  }
  // Otherwise a question ("如何创建一个 HTML 页面？") or a review request
  // ("做一个页面设计评审") is asking about the artifact, not ordering a write.
  return !(TEXT_WRITE_QUESTION_PATTERN.test(userGoal) || TEXT_WRITE_REVIEW_PATTERN.test(userGoal));
}

export async function runTextWriteTask({
  controller,
  eventBus,
  fileTool,
  webTool,
  verifierTool,
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

  let contentPrepared = false;
  let tokenUsage = createEmptyTokenUsageSummary();
  // One ledger line per model call, so "what did the AI actually do" is readable
  // without reading the provider's raw traffic. Deliberately references nothing
  // declared later in this function: the decision call passes through here before
  // the contract (and therefore the format) exists.
  const modelCallLog: string[] = [];
  const recordModelCall = (purpose: string, usage?: ModelUsage) => {
    const resolved = usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    tokenUsage = addModelUsage(tokenUsage, "commander", resolved);
    const total = resolved.totalTokens ?? (resolved.inputTokens ?? 0) + (resolved.outputTokens ?? 0);
    modelCallLog.push(`${purpose} tokens=${total}`);
  };

  const baseFormat = inferTextArtifactFormat(userGoal);
  const baseTarget = resolveTextWriteTarget(userGoal, baseFormat);
  // The Commander decides what to produce before anything else happens. The whole
  // point is that the artifact is decided, not inferred: the regex path that used
  // to run here is what turned an HTML request into a `.md` file.
  emit({
    ...snapshot,
    status: "planning",
    title: tr("Commander is deciding the artifact", "指挥官正在确认产物形态"),
    commanderMessage: tr(
      `Commander is deciding what to produce for: ${userGoal}`,
      `指挥官先确认这次要产出什么：${userGoal}`,
    ),
  });
  const contract = await decideTextWriteContract({
    decisionInput: {
      userGoal,
      fallbackTargetPath: baseTarget.path,
    },
    chatTool,
    locale: isChinese ? "zh-CN" : "en",
    timeoutMs: taskTimeoutMs,
    signal,
    onUsage: (usage) => recordModelCall("artifact-contract", usage),
  });
  // Cancellation must return rather than throw: this flow is started
  // fire-and-forget, so an escaping error here becomes an unhandled rejection.
  if (signal?.aborted) return;
  const artifactFormat = contract.format;
  // The model's one-line justification is the only readable part of "why this
  // artifact": reasoning tokens are live-only, so surface it here and keep it in
  // the durable contract log instead of parsing it and dropping it.
  const contractSummary = tr(
    `Commander decided: ${artifactFormat.label} file "${contract.targetPath}"${contract.source === "fallback" ? " (decided by rule, not by the model)" : ""}.${contract.reasoning ? ` ${contract.reasoning}` : ""}`,
    `指挥官判定：产出 ${artifactFormat.label} 文件「${contract.targetPath}」${contract.source === "fallback" ? "（由规则兜底，非模型决策）" : ""}。${contract.reasoning ?? ""}`,
  );

  const plan = [
    { id: "step-prepare-text", title: tr(`Commander decides the artifact and prepares ${artifactFormat.label} content`, `指挥官确认产物并准备 ${artifactFormat.label} 正文`), assignedAgentKind: "commander" as const, status: "pending" as const },
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
  agentTracker.setState("agent-file", { status: "queued", task: tr(`Waiting for ${artifactFormat.label} content`, `等待 ${artifactFormat.label} 正文`) });
  agentTracker.setState("agent-verifier", { status: "queued", task: tr("Waiting for write result", "等待写入结果") });

  emit({
    id: taskId,
    title: tr("Preparing text file write", "正在准备文本文件写入"),
    userGoal,
    status: "planning",
    commanderMessage: tr(
      `${contractSummary} Commander is preparing the content and will request confirmed-write approval before writing the file.`,
      `${contractSummary} 指挥官正在准备正文，写入文件前会请求确认写入授权。`,
    ),
    plan,
    agents: agentTracker.getSnapshots(),
    tokenUsage,
    logs: [
      {
        id: `${taskId}-created`,
        kind: "event",
        title: "task.created",
        detail: "Desktop UI passed the text file write goal to Core.",
        userMessage: tr("Preparing the text file task.", "正在准备文本文件任务。"),
      },
      {
        id: `${taskId}-contract`,
        kind: "event",
        title: "text_write.contract",
        detail: `contract source=${contract.source} format=${artifactFormat.extension} target=${contract.targetPath} requirements=${contract.requirements.length}${contract.reasoning ? ` reasoning=${contract.reasoning}` : ""}${contract.fallbackReason ? ` reason=${contract.fallbackReason}` : ""}`,
        userMessage: contractSummary,
      },
    ],
  });

  await controller.wait();
  if (signal?.aborted) return;

  try {
    const inferredTarget = resolveTextWriteTarget(userGoal, artifactFormat);
    // A decided contract owns the file name; only undecided contracts may be
    // renamed from the generated content.
    const decidedTarget = contract.source === "commander";
    let targetPath = decidedTarget ? contract.targetPath : inferredTarget.path;
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
      artifactFormat,
      contract.requirements,
    );
    throwIfTaskAborted(signal, "Text write content generation");
    const content = generated.content;
    if (!decidedTarget && !inferredTarget.explicit) {
      targetPath = inferTargetFromContent(content, artifactFormat) ?? targetPath;
    }
    contentPrepared = true;

    agentTracker.setState("agent-commander", {
      status: "completed",
      task: tr(`${artifactFormat.label} content prepared`, `${artifactFormat.label} 正文已准备`),
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
        toolName: "file.writeText",
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
        ? tr(`${artifactFormat.label} content prepared`, `${artifactFormat.label} 正文已准备`)
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
      // Verification must be earned: deterministic boundaries first, then the
      // verifier agent's tool. Nothing is claimed on the write call alone.
      const verification = await verifyTextWriteArtifact({
        tr,
        content,
        format: artifactFormat,
        targetPath: result.targetPath,
        byteCount: result.byteCount,
        requirements: contract.requirements,
        ...(verifierTool ? { verifierTool } : {}),
        taskId,
      });
      const verified = verification.status === "pass";
      const verificationMessage = `${verification.summary} ${verification.detail}`.trim();
      const verificationLabel = verified
        ? tr("verified", "已验证")
        : verification.status === "unavailable"
          ? tr("not independently verified", "未独立验证")
          : verification.status === "warn"
            ? tr("verified with warnings", "验证有保留")
            : tr("verification failed", "验证未通过");
      agentTracker.setState("agent-verifier", {
        status: verification.status === "fail" ? "failed" : "completed",
        task: verificationMessage.slice(0, 200),
      });

      emit({
        ...snapshot,
        title: verification.status === "fail"
          ? tr("Text file written but verification failed", "文件已写入但校验未通过")
          : tr("Text file written", "文本文件已写入"),
        status: verification.status === "fail" ? "failed" : "completed",
        commanderMessage: tr(
          `File Agent wrote ${result.targetPath}. ${verificationMessage}`,
          `文件代理已将内容写入 ${result.targetPath}。${verificationMessage}`,
        ),
        plan: markTextWriteStep(
          snapshot.plan,
          "step-write-text",
          "completed",
          "step-verify-write",
          verification.status === "fail" ? "failed" : "completed",
        ),
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
        logs: [
          ...appendLog(snapshot, {
          id: `${taskId}-write-completed`,
          kind: "verification",
          title: verified ? "task.verification_passed" : "task.verification_reported",
          detail: [
            `file.writeText ${result.action} wrote ${result.byteCount} byte(s) to ${result.targetPath}.`,
            `verification=${verification.status}`,
            `boundaries=${verification.boundaries.ok ? "ok" : verification.boundaries.failures.join("; ")}`,
          ].join(" "),
          userMessage: tr(
            verified ? "Text file written and verified." : "Text file written; verification result recorded.",
            verified ? "文本文件已写入并通过验证。" : "文本文件已写入，验证结论已记录。",
          ),
          }),
          ...modelCallLog.map((line, index) => ({
            id: `${taskId}-model-call-${index}`,
            kind: "event" as const,
            title: "agent.model_call",
            detail: line,
            userMessage: line,
          })),
        ],
        verificationSummary: `${verificationLabel}：${result.targetPath} —— ${verificationMessage}`,
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
  secondStatus?: "running" | "completed" | "failed",
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
  /**
   * Set when the generation was cut short (stall or timeout) but produced enough
   * text to be worth keeping instead of failing the whole task.
   */
  partial?: boolean;
}

/**
 * How long a text generation may produce nothing before it is considered hung.
 * Production saw tasks idle for hours with no progress at all.
 */
export const TEXT_GENERATION_STALL_TIMEOUT_MS = 60_000;

/** Minimum characters for interrupted output to be worth keeping. */
const TEXT_GENERATION_MIN_USABLE_CHARS = 200;

/**
 * Generation budget for the text-write flow.
 *
 * The generic task timeout (default 90s, 180s in the observed failure) is sized
 * for tool calls, not for writing a document. Long-form generation gets at least
 * five minutes, scaled by the requested length when the goal states one.
 */
export function resolveGenerationTimeoutMs(
  taskTimeoutMs: number | undefined,
  requestedLength?: RequestedLength,
): number {
  const base = typeof taskTimeoutMs === "number" && Number.isFinite(taskTimeoutMs)
    ? taskTimeoutMs
    : DEFAULT_TASK_TIMEOUT_MS;
  const scale = requestedLength === undefined
    ? 1
    : requestedLength.unit === "words"
      ? Math.max(1, requestedLength.amount / 500)
      : Math.max(1, requestedLength.amount / 1_000);
  return Math.min(Math.round(Math.max(base * 2, base + 180_000) * scale), 900_000);
}

export function hasUsablePartialContent(content: string): boolean {
  return content.trim().length >= TEXT_GENERATION_MIN_USABLE_CHARS;
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
      : appendTextTargetSuffix(targetPath, attempt + 1);
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

/** Adds the retry suffix before the extension, so every format keeps a valid name. */
export function appendTextTargetSuffix(targetPath: string, suffix: number): string {
  const match = targetPath.match(/^(.*?)(\.[A-Za-z0-9]+)$/);
  return match ? `${match[1]}-${suffix}${match[2]}` : `${targetPath}-${suffix}`;
}

async function generateTextContent(
  userGoal: string,
  targetPath: string,
  sources: WebSearchResult[],
  chatTool: ChatTool | undefined,
  recordModelCall: (purpose: string, usage?: ModelUsage) => void,
  eventBus: TaskEventBus | undefined,
  taskId: ID | undefined,
  signal: AbortSignal | undefined,
  taskTimeoutMs: number | undefined,
  format: TextArtifactFormat,
  requirements: readonly string[] = [],
): Promise<{ content: string }> {
  if (!chatTool) {
    throw new Error("A configured text-generation model is required before a file write can be previewed.");
  }

  const requestedLength = inferRequestedLength(userGoal);
  const locale = /[\u3400-\u9fff]/u.test(userGoal) ? "zh-CN" : "en";
  const generationTimeoutMs = resolveGenerationTimeoutMs(taskTimeoutMs, requestedLength);
  const complete = async (prompt: string, temperature: number, purpose: string): Promise<GeneratedTextCall> => {
    if (chatTool.stream && eventBus && taskId) {
      let streamedText = "";
      let tokenUsage: ModelUsage | undefined;
      let finishReason: string | undefined;
      let modelCallRecorded = false;
      let interruptedBy: "stall" | "timeout" | undefined;
      eventBus.emit({ kind: "agent.chunk_start", taskId, agentKind: "commander" });
      try {
        // Two guards, deliberately different:
        //  * the stall watchdog fails a generation that has gone quiet, which is
        //    what a hung provider looks like (production saw tasks idle for hours);
        //  * the outer timeout bounds the whole attempt generously, because long
        //    documents legitimately stream for minutes.
        await withTaskTimeout(
          () => withStallWatchdog(
            async (reportProgress) => {
              for await (const chunk of chatTool.stream!(prompt, {
                useMaxOutputTokens: true,
                temperature,
                locale,
                timeoutMs: generationTimeoutMs,
                onUsage: (usage) => {
                  tokenUsage = usage;
                },
                onFinish: (reason) => {
                  finishReason = reason;
                },
              })) {
                throwIfTaskAborted(signal, "Text content generation");
                streamedText += chunk.text;
                reportProgress();
                eventBus.emit({
                  kind: "agent.chunk",
                  taskId,
                  agentKind: "commander",
                  text: chunk.text,
                });
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
              }
            },
            {
              label: "Text content generation",
              stallMs: TEXT_GENERATION_STALL_TIMEOUT_MS,
              signal,
              onStall: () => {
                interruptedBy = "stall";
              },
            },
          ),
          {
            label: "Text content generation",
            timeoutMs: generationTimeoutMs,
            signal,
            onTimeout: () => {
              interruptedBy = "timeout";
            },
          },
        );
        recordModelCall(purpose, tokenUsage);
        modelCallRecorded = true;
        eventBus.emit({
          kind: "agent.chunk_end",
          taskId,
          agentKind: "commander",
          fullText: streamedText,
        });
        return {
          content: normalizeGeneratedContent(streamedText, format),
          truncated: isTruncatedTextGeneration(finishReason),
        };
      } catch (error) {
        if (!modelCallRecorded) {
          recordModelCall(purpose, tokenUsage);
        }
        eventBus.emit({
          kind: "agent.chunk_end",
          taskId,
          agentKind: "commander",
          fullText: streamedText,
          error: error instanceof Error ? error.message : String(error),
        });
        throwIfTaskAborted(signal, "Text content generation");
        // A stalled or timed-out generation that already produced a usable amount
        // of text is kept instead of failing the whole task. Production failed a
        // task at exactly the 180s mark and threw away the generated document.
        const partial = normalizeGeneratedContent(streamedText, format);
        const interrupted = interruptedBy !== undefined || isTaskStallError(error) || error instanceof TaskTimeoutError;
        if (interrupted && hasUsablePartialContent(partial)) {
          return { content: partial, truncated: true, partial: true };
        }
        throw error;
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
      if (modelCallStarted) recordModelCall(purpose);
      throw error;
    }
    recordModelCall(purpose, result.tokenUsage);
    throwIfTaskAborted(signal, "Text content generation");
    return {
      content: normalizeGeneratedContent(result.text, format),
      truncated: isTruncatedTextGeneration(result.finishReason),
    };
  };

  let callCount = 1;
  const initialCall = await complete(
    buildTextGenerationPrompt(userGoal, targetPath, sources, format, requestedLength, requirements),
    /novel|story|poem|\u5c0f\u8bf4|\u6545\u4e8b|\u8bd7/i.test(userGoal) ? 0.7 : 0.3,
    "content-generation",
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
      "content-continuation",
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

export function buildTextGenerationPrompt(
  userGoal: string,
  targetPath: string,
  sources: WebSearchResult[],
  format: TextArtifactFormat,
  requestedLength?: RequestedLength,
  requirements: readonly string[] = [],
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
  // Markdown needs no shape hint; other formats do. A model left to its own
  // devices wraps a page in prose and a fence (observed: an HTML request came
  // back as a Chinese sentence plus an ```html block, despite the instruction
  // below telling it not to fence).
  const formatInstruction = format.markdown
    ? []
    : [
        `The file must be a complete, standalone ${format.label} document that starts at its first character and ends at its last.`,
        "Do not add commentary, an introduction, or a surrounding code fence.",
        ...(format.extension === ".html" || format.extension === ".htm"
          ? ["Start with <!DOCTYPE html> and end with </html>."]
          : []),
      ];
  // Requirements the Commander decided are binding on the artifact, not advice.
  const requirementInstruction = requirements.length > 0
    ? `Requirements decided for this artifact:${requirements.map((entry) => `\n- ${entry}`).join("")}`
    : undefined;

  return [
    `You are generating the complete contents of a local ${format.label} file for the user.`,
    "Return ONLY the final file contents. Do not use an outer code fence.",
    "Do not mention execution, approval, file paths, prompts, or internal process.",
    "Do not repeat the request as a placeholder. Fully perform the requested writing task.",
    "Write in the same language as the user's request unless the request says otherwise.",
    lengthInstruction,
    ...formatInstruction,
    ...(requirementInstruction ? [requirementInstruction] : []),
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

/**
 * A concrete text artifact this flow can produce. The format drives the target
 * extension, the generation prompt, and how the model's output is cleaned up.
 *
 * The flow used to be Markdown-only: an HTML request was slugged into a `.md`
 * target and the model was told to write Markdown, so the artifact could never
 * match the request no matter how well the writing went.
 */
export interface TextArtifactFormat {
  /** Canonical lowercase extension including the dot, e.g. ".html". */
  extension: string;
  /** Human-facing label used in prompts and status copy, e.g. "HTML". */
  label: string;
  /** Outer-fence languages the model may wrap this payload in. */
  fenceLanguages: string[];
  /**
   * Markdown documents may legitimately contain fenced blocks, so cleanup for
   * this family stays conservative: outer fence only, no boundary trimming.
   */
  markdown: boolean;
}

interface TextArtifactFormatSpec extends TextArtifactFormat {
  /** Lowercase tokens that name this format inside a goal. */
  tokens: readonly string[];
}

/** A goal that names no format keeps the original Markdown behavior. */
export const DEFAULT_TEXT_ARTIFACT_FORMAT: TextArtifactFormat = {
  extension: ".md",
  label: "Markdown",
  fenceLanguages: ["markdown", "md"],
  markdown: true,
};

const TEXT_ARTIFACT_FORMAT_SPECS: readonly TextArtifactFormatSpec[] = [
  { ...DEFAULT_TEXT_ARTIFACT_FORMAT, tokens: ["markdown", "md"] },
  { extension: ".html", label: "HTML", fenceLanguages: ["html", "htm"], markdown: false, tokens: ["html", "html5"] },
  { extension: ".htm", label: "HTML", fenceLanguages: ["html", "htm"], markdown: false, tokens: ["htm"] },
  { extension: ".css", label: "CSS", fenceLanguages: ["css"], markdown: false, tokens: ["css"] },
  { extension: ".js", label: "JavaScript", fenceLanguages: ["js", "javascript"], markdown: false, tokens: ["javascript", "js"] },
  { extension: ".mjs", label: "JavaScript", fenceLanguages: ["js", "javascript"], markdown: false, tokens: ["mjs"] },
  { extension: ".json", label: "JSON", fenceLanguages: ["json"], markdown: false, tokens: ["json"] },
  { extension: ".svg", label: "SVG", fenceLanguages: ["svg", "xml"], markdown: false, tokens: ["svg"] },
  { extension: ".txt", label: "text", fenceLanguages: [], markdown: false, tokens: ["txt"] },
];

/** Nouns that mark the preceding token as the artifact being requested. */
const TEXT_ARTIFACT_NOUN_PATTERN =
  "文件|文档|页面|网页|脚本|代码|表单|动画|file|document|page|script|code|form|animation";

/**
 * Nouns that mark the preceding token as the *topic* rather than the artifact:
 * "写一份 JS 教程" asks for a document about JS, not a `.js` file. Over-detecting
 * a format is worse than falling back to Markdown, because the payload would
 * then be prose stored under a code extension.
 */
const TEXT_ARTIFACT_TOPIC_PATTERN =
  "教程|指南|说明|介绍|入门|笔记|总结|分析|对比|清单|规范|约定|标准|最佳实践|原理|机制|陷阱|面试|区别|tutorial|guide|introduction|cheatsheet";

/** Verbs that request an artifact ("创建一个 HTML" / "create an HTML file"). */
const TEXT_ARTIFACT_CREATE_VERB_PATTERN =
  "创建|新建|生成|制作|写|做|输出|导出|保存为?|create|generate|make|write|build|produce";

const TEXT_ARTIFACT_MEASURE_WORD_PATTERN = "一个|一份|一张|一首|个|份|a|an|one";

/** Longest first, so `html5` wins over `html` and `markdown` over `md`. */
function buildTokenAlternation(tokens: readonly string[]): string {
  return [...new Set(tokens)].sort((left, right) => right.length - left.length).join("|");
}

const TEXT_ARTIFACT_KEYWORD_ALTERNATION = buildTokenAlternation(
  TEXT_ARTIFACT_FORMAT_SPECS.flatMap((spec) => [...spec.tokens]),
);

const TEXT_ARTIFACT_EXTENSION_ALTERNATION = buildTokenAlternation(
  TEXT_ARTIFACT_FORMAT_SPECS.map((spec) => spec.extension.replace(/^\./u, "")),
);

const TEXT_ARTIFACT_FORMAT_BY_TOKEN = new Map<string, TextArtifactFormatSpec>(
  TEXT_ARTIFACT_FORMAT_SPECS.flatMap((spec) => spec.tokens.map((token) => [token, spec] as const)),
);

/**
 * Infers the artifact format a goal asks for. The first explicit signal wins, so
 * "创建一个 HTML，内容是 SVG 动画" resolves to HTML rather than SVG.
 */
export function inferTextArtifactFormat(userGoal: string): TextArtifactFormat {
  const spec = inferTextArtifactFormatSpec(userGoal);
  if (!spec) return DEFAULT_TEXT_ARTIFACT_FORMAT;
  return {
    extension: spec.extension,
    label: spec.label,
    fenceLanguages: [...spec.fenceLanguages],
    markdown: spec.markdown,
  };
}

/**
 * Resolves a format token reported by the model (e.g. "html") to a supported
 * format. Returns undefined for anything outside the supported set, so a model
 * cannot invent an extension the write path has no rules for.
 */
export function resolveTextArtifactFormatToken(token: string): TextArtifactFormat | undefined {
  const spec = TEXT_ARTIFACT_FORMAT_BY_TOKEN.get(token.trim().toLowerCase());
  if (!spec) return undefined;
  return {
    extension: spec.extension,
    label: spec.label,
    fenceLanguages: [...spec.fenceLanguages],
    markdown: spec.markdown,
  };
}

/** Every extension the flow can produce, for prompts and validation. */
export function listTextArtifactExtensions(): string[] {
  return TEXT_ARTIFACT_FORMAT_SPECS.map((spec) => spec.extension);
}

function inferTextArtifactFormatSpec(userGoal: string): TextArtifactFormatSpec | undefined {
  // An explicit file name is the strongest signal: "report.json", "保存为 a.html".
  const explicitPath = inferExplicitTargetPath(userGoal);
  if (explicitPath) {
    const extension = explicitPath.match(new RegExp(`\\.(${TEXT_ARTIFACT_EXTENSION_ALTERNATION})$`, "iu"))?.[1];
    const spec = extension
      ? TEXT_ARTIFACT_FORMAT_SPECS.find((candidate) => candidate.extension === `.${extension.toLowerCase()}`)
      : undefined;
    if (spec) return spec;
  }

  const candidates: Array<{ index: number; spec: TextArtifactFormatSpec }> = [];
  const nounPattern = new RegExp(
    `(?<token>${TEXT_ARTIFACT_KEYWORD_ALTERNATION})\\b[\\s、,，:：]*(?:${TEXT_ARTIFACT_NOUN_PATTERN})`,
    "giu",
  );
  for (const found of userGoal.matchAll(nounPattern)) {
    const spec = TEXT_ARTIFACT_FORMAT_BY_TOKEN.get(found.groups?.token?.toLowerCase() ?? "");
    if (spec) candidates.push({ index: found.index ?? 0, spec });
  }
  const verbPattern = new RegExp(
    `(?:${TEXT_ARTIFACT_CREATE_VERB_PATTERN})\\s*(?:${TEXT_ARTIFACT_MEASURE_WORD_PATTERN})?\\s*(?<token>${TEXT_ARTIFACT_KEYWORD_ALTERNATION})\\b`,
    "giu",
  );
  for (const found of userGoal.matchAll(verbPattern)) {
    const spec = TEXT_ARTIFACT_FORMAT_BY_TOKEN.get(found.groups?.token?.toLowerCase() ?? "");
    if (!spec) continue;
    const after = userGoal.slice((found.index ?? 0) + found[0].length);
    if (new RegExp(`^[\\s、,，:：]*(?:${TEXT_ARTIFACT_TOPIC_PATTERN})`, "iu").test(after)) continue;
    candidates.push({ index: found.index ?? 0, spec });
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((left, right) => left.index - right.index);
  return candidates[0].spec;
}

export function normalizeGeneratedContent(
  content: string,
  format: TextArtifactFormat = DEFAULT_TEXT_ARTIFACT_FORMAT,
): string {
  const trimmed = content.trim();
  if (format.markdown) {
    // Only a fence that wraps the whole payload is unwrapped. Stripping the
    // closing fence unconditionally used to eat the last fence of a markdown
    // document that legitimately ends with a code block.
    const withoutOpeningFence = trimmed.replace(/^```(?:markdown|md)?\s*\r?\n/i, "");
    if (withoutOpeningFence === trimmed) return trimmed;
    return withoutOpeningFence.replace(/\r?\n```\s*$/i, "").trim();
  }
  const unfenced = unwrapOuterFence(trimmed, format);
  const bounded = format.extension === ".html" || format.extension === ".htm"
    ? trimToHtmlDocument(unfenced)
    : unfenced;
  return bounded.trim();
}

/**
 * Removes the code fence a model added around a payload that has no legitimate
 * use for one. The fence must open with an empty or matching language and close
 * before the end of the output; a prose introduction before it and a short
 * closing remark after it are dropped, because neither belongs in the artifact.
 */
function unwrapOuterFence(content: string, format: TextArtifactFormat): string {
  const opening = content.match(/^[\s\S]*?```([A-Za-z0-9.+#_-]*)[ \t]*\r?\n/u);
  if (!opening) return content;
  const language = opening[1].toLowerCase();
  if (language !== "" && !format.fenceLanguages.includes(language)) return content;
  const body = content.slice(opening[0].length);
  const closing = body.match(/\r?\n[ \t]*```([ \t]*[\s\S]*)$/u);
  if (!closing) return content;
  const tail = closing[1].trim();
  // A fenced payload that still contains a fence, or a long markup-bearing tail,
  // is not a simple wrapper; leaving it untouched beats guessing.
  if (tail.length > 160 || tail.includes("<") || tail.includes("```")) return content;
  return body.slice(0, closing.index);
}

/** Cuts an HTML payload down to its document boundaries, dropping surrounding prose. */
function trimToHtmlDocument(content: string): string {
  const lower = content.toLowerCase();
  const doctypeStart = lower.indexOf("<!doctype");
  const htmlStart = lower.search(/<html[\s>]/u);
  const start = doctypeStart >= 0 ? doctypeStart : htmlStart;
  let result = start > 0 ? content.slice(start) : content;
  const end = result.toLowerCase().lastIndexOf("</html>");
  if (end >= 0) result = result.slice(0, end + "</html>".length);
  return result;
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

export interface TextWriteTarget {
  /** Workspace-relative target path; never slugged when the goal named a file. */
  path: string;
  /** True when the goal itself named the destination file. */
  explicit: boolean;
  /** Artifact format inferred from the goal. */
  format: TextArtifactFormat;
}

/**
 * Resolves both the write target and the artifact format. The format decides the
 * extension, so an HTML request can no longer land in a `.md` file.
 */
export function resolveTextWriteTarget(
  userGoal: string,
  format: TextArtifactFormat = inferTextArtifactFormat(userGoal),
): TextWriteTarget {
  const explicitPath = inferExplicitTargetPath(userGoal);
  if (explicitPath) {
    return { path: explicitPath, explicit: true, format };
  }
  return { path: inferTargetFromGoal(userGoal, format), explicit: false, format };
}

/**
 * Explicit destinations are honoured for every supported text extension, not just
 * `.md` — "保存为 report.html" used to be slugged into a `.md` name instead.
 */
function inferExplicitTargetPath(userGoal: string): string | undefined {
  const quotedPath = userGoal.match(
    new RegExp(String.raw`["'\x60]([^"'\x60]+\.(?:${TEXT_ARTIFACT_EXTENSION_ALTERNATION}))["'\x60]`, "iu"),
  )?.[1];
  if (quotedPath) return quotedPath.trim();
  const namedPath = userGoal.match(
    new RegExp(
      String.raw`(?:保存为?|文件名(?:为|是)?|命名为)\s*([^\\/\s"'\x60，,。；;]+\.(?:${TEXT_ARTIFACT_EXTENSION_ALTERNATION}))`,
      "iu",
    ),
  )?.[1];
  if (namedPath) return namedPath.trim();
  const path = userGoal.match(
    new RegExp(
      String.raw`([A-Za-z]:[\\/][^\s"'\x60]+\.(?:${TEXT_ARTIFACT_EXTENSION_ALTERNATION})|(?:\.{1,2}[\\/])?[^\s"'\x60]+\.(?:${TEXT_ARTIFACT_EXTENSION_ALTERNATION}))`,
      "iu",
    ),
  )?.[1];
  return path?.trim();
}

/**
 * Derives a name from the first heading of the generated content. Markdown only:
 * other formats have no heading convention, and a stray `#` in their payload must
 * not rename the file.
 */
function inferTargetFromContent(content: string, format: TextArtifactFormat): string | undefined {
  if (!format.markdown) return undefined;
  const heading = extractMarkdownHeading(content);
  return heading ? buildTextTarget(heading, format) : undefined;
}

function extractMarkdownHeading(content: string): string | undefined {
  return content.match(/^\s*#\s+(.+?)\s*#*\s*(?:\r?\n|$)/u)?.[1];
}

function inferTargetFromGoal(userGoal: string, format: TextArtifactFormat): string {
  const summarizedGoal = stripTargetPath(userGoal)
    .replace(/\d[\d,]{0,6}\s*(?:\u4e2a)?(?:\u5b57|\u6c49\u5b57|characters?|words?)(?:\u5de6\u53f3|\u4e0a\u4e0b|\u4ee5\u4e0a|\u4ee5\u5185)?/giu, " ")
    .replace(/\b(?:please|write|create|generate|save|export|as|to|a|an|the|markdown|md|file|document)\b/giu, " ")
    .replace(/(?:\u8bf7|\u5e2e\u6211|\u5199\u4e00(?:\u7bc7|\u4efd|\u4e2a)?|\u521b\u4f5c|\u751f\u6210|\u521b\u5efa|\u4fdd\u5b58\u4e3a?|\u5bfc\u51fa\u4e3a?|markdown|md|\u6587\u4ef6|\u6587\u6863)/giu, " ");
  return buildTextTarget(summarizedGoal, format) ?? `untitled-document${format.extension}`;
}

function buildTextTarget(value: string, format: TextArtifactFormat): string | undefined {
  const normalized = value
    .normalize("NFKC")
    .replace(new RegExp(String.raw`\.(?:${TEXT_ARTIFACT_EXTENSION_ALTERNATION})$`, "iu"), "")
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
  return `${windowsReservedName ? `document-${basename}` : basename}${format.extension}`;
}

function stripTargetPath(userGoal: string): string {
  return userGoal
    .replace(
      new RegExp(
        String.raw`["'\x60]?([A-Za-z]:[\\/][^\s"'\x60]+\.(?:${TEXT_ARTIFACT_EXTENSION_ALTERNATION})|(?:\.{1,2}[\\/])?[^\s"'\x60]+\.(?:${TEXT_ARTIFACT_EXTENSION_ALTERNATION}))["'\x60]?`,
        "giu",
      ),
      "",
    )
    .trim();
}
