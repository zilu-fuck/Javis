import { describe, expect, it, vi } from "vitest";
import { createFileScanTaskRuntime } from "./index";

describe("TaskRuntime preflight failures", () => {
  it("fails before routing or calling model and file tools", () => {
    const scanMarkdownDocuments = vi.fn(async () => []);
    const complete = vi.fn(async () => ({ text: "must not be returned" }));
    const onTaskStarted = vi.fn();
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: { scanMarkdownDocuments },
      chatTool: { complete },
      onTaskStarted,
    });

    runtime.start("总结 @missing.md", {
      mode: "chat",
      taskId: "task-document-preflight",
      preflightError: "Failed to read referenced file missing.md: access denied",
    });

    const snapshot = runtime.getSnapshot();
    expect(snapshot).toMatchObject({
      id: "task-document-preflight",
      title: "文档读取失败",
      status: "failed",
      userFacingError: "引用的本地文档无法读取，已停止本轮回答；请检查路径和访问权限后重试。",
    });
    expect(snapshot.logs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: "context.preflight.failed",
        detail: "Failed to read referenced file missing.md: access denied",
      }),
    ]));
    expect(snapshot.conversationMessages).toEqual([
      { role: "user", content: "总结 @missing.md" },
      {
        role: "assistant",
        content: "引用的本地文档无法读取，已停止本轮回答；请检查路径和访问权限后重试。",
      },
    ]);
    expect(onTaskStarted).toHaveBeenCalledWith("task-document-preflight");
    expect(complete).not.toHaveBeenCalled();
    expect(scanMarkdownDocuments).not.toHaveBeenCalled();

    runtime.dispose();
  });
});
