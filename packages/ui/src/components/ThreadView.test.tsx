import { fireEvent, render, screen } from "@testing-library/react";
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
      status: "waiting_info",
      askUserQuestion: {
        id: "ask-1",
        question: "Need detail?",
        status: "pending",
      },
    });

    const { container } = renderThreadView(task);

    expect((container.querySelector("textarea") as HTMLTextAreaElement).disabled).toBe(true);
  });

  it("shows user-facing progress with per-source outcomes", () => {
    const task = createTask({
      taskProgress: {
        title: "热榜采集",
        status: "completed_with_warnings",
        currentAction: "正在基于已验证数据生成报告",
        completedItems: 2,
        totalItems: 3,
        items: [
          {
            id: "weibo",
            label: "微博",
            status: "completed",
            completedCount: 20,
            expectedCount: 20,
            sourceUrl: "https://example.com/weibo",
          },
          {
            id: "bilibili",
            label: "B站",
            status: "verifying",
            completedCount: 20,
            expectedCount: 20,
          },
          {
            id: "xiaohongshu",
            label: "小红书",
            status: "blocked",
            detail: "页面返回 300012 访问限制",
            completedCount: 0,
            expectedCount: 20,
          },
        ],
      },
    });

    const { container } = renderThreadView(task);

    expect(screen.getByRole("region", { name: "热榜采集: 部分完成" })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "任务完成度" }).getAttribute("aria-valuenow")).toBe("2");
    expect(screen.getByText("2/3 完成")).toBeTruthy();
    expect(screen.getByText("已验证")).toBeTruthy();
    expect(screen.getByText("验证中")).toBeTruthy();
    expect(screen.getByText("来源受限")).toBeTruthy();
    expect(screen.getByText("页面返回 300012 访问限制")).toBeTruthy();
    expect(screen.getByRole("link", { name: "查看来源" }).getAttribute("href")).toBe(
      "https://example.com/weibo",
    );
    expect(container.querySelectorAll(".javis-user-task-progress")).toHaveLength(1);
  });

  it("updates the progress card in place when the task snapshot changes", () => {
    const initialTask = createTask({
      conversationMessages: [{ role: "user", content: "收集两个来源" }],
      taskProgress: {
        title: "来源采集",
        status: "running",
        currentAction: "正在获取第二个来源",
        completedItems: 1,
        totalItems: 2,
        items: [
          { id: "source-a", label: "来源 A", status: "completed" },
          { id: "source-b", label: "来源 B", status: "running" },
        ],
      },
    });
    const view = renderThreadView(initialTask);

    expect(screen.getByText("1/2 完成")).toBeTruthy();
    expect(screen.getByText("正在获取第二个来源")).toBeTruthy();
    expect(view.container.querySelector(".javis-message.live-progress")).toBeNull();

    view.rerender(renderThreadViewElement({
      ...initialTask,
      taskProgress: {
        ...initialTask.taskProgress!,
        status: "completed",
        currentAction: "正在整理结果",
        completedItems: 2,
        items: initialTask.taskProgress!.items.map((item) => ({ ...item, status: "completed" })),
      },
    }));

    expect(screen.getByText("2/2 完成")).toBeTruthy();
    expect(screen.getByText("正在整理结果")).toBeTruthy();
    expect(screen.queryByText("正在获取第二个来源")).toBeNull();
    expect(view.container.querySelectorAll(".javis-user-task-progress")).toHaveLength(1);
  });

  it("reopens execution progress when a task id is retried after a terminal run", () => {
    const terminalTask = createTask({
      id: "task-retry-same-id",
      status: "failed",
      commanderMessage: "执行失败",
      conversationMessages: [
        { role: "user", content: "收集来源" },
        { role: "assistant", content: "执行失败" },
      ],
      plan: [{ id: "fetch-source", title: "获取来源", status: "failed" }],
      agents: [{
        id: "agent-page-agent",
        name: "Page Agent",
        role: "获取网页来源",
        status: "failed",
        task: "执行失败",
      }],
    });
    const view = renderThreadView(terminalTask);

    view.rerender(renderThreadViewElement({
      ...terminalTask,
      status: "running",
      commanderMessage: "正在执行",
      conversationMessages: [{ role: "user", content: "收集来源" }],
      plan: [{ id: "fetch-source", title: "获取来源", status: "running" }],
      agents: [{
        id: "agent-page-agent",
        name: "Page Agent",
        role: "获取网页来源",
        status: "running",
        task: "获取公开来源",
      }],
      taskProgress: {
        title: "来源采集",
        status: "running",
        completedItems: 0,
        totalItems: 1,
        items: [{ id: "fetch-source", label: "获取来源", status: "running" }],
      },
    }));

    expect(view.container.querySelector(".javis-execution-summary")).not.toBeNull();
    expect(view.container.textContent).toContain("执行进度");
    expect(view.container.textContent).toContain("获取来源");
    expect(view.container.querySelector(".javis-user-task-progress")).not.toBeNull();
  });

  it("hides superseded progress bubbles and keeps one final summary", () => {
    const task = createTask({
      id: "task-progress-1",
      status: "completed",
      conversationMessages: [
        { id: "user-1", role: "user", content: "采集三个来源" },
        { id: "progress-task-progress-1-started", role: "assistant", content: "我正在采集 3 个来源" },
        { id: "progress-task-progress-1-source-a-completed", role: "assistant", content: "来源 A 已获取 20 条" },
        { id: "progress-task-progress-1-final", role: "assistant", content: "已完成三个来源的数据采集。" },
      ],
      taskProgress: {
        title: "三个来源采集",
        status: "completed",
        completedItems: 3,
        totalItems: 3,
        items: [
          { id: "source-a", label: "来源 A", status: "completed", completedCount: 20, expectedCount: 20 },
          { id: "source-b", label: "来源 B", status: "completed", completedCount: 20, expectedCount: 20 },
          { id: "source-c", label: "来源 C", status: "completed", completedCount: 20, expectedCount: 20 },
        ],
      },
    });

    const { container } = renderThreadView(task);

    expect(screen.queryByText("我正在采集 3 个来源")).toBeNull();
    expect(screen.queryByText("来源 A 已获取 20 条")).toBeNull();
    expect(screen.getByText("已完成三个来源的数据采集。")).toBeTruthy();
    expect(container.querySelectorAll(".javis-user-task-progress")).toHaveLength(1);
    expect(container.querySelectorAll(".javis-message:not(.user)")).toHaveLength(1);
  });

  it.each(["completed", "failed", "cancelled"])(
    "collapses %s execution details after the final response",
    (status) => {
      const task = createTask({
        id: `task-terminal-${status}`,
        status,
        commanderMessage: "最终回复",
        conversationMessages: [
          { role: "user", content: "检查项目" },
          { role: "assistant", content: "正在读取项目" },
          { role: "assistant", content: "正在验证结果" },
          { role: "assistant", content: "最终回复" },
        ],
        plan: [{ id: "inspect", title: "检查项目文件", status }],
        agents: [{
          id: "agent-shell",
          name: "Shell Agent",
          role: "检查命令",
          status,
          task: "检查完成",
        }],
        logs: [{
          id: "inspect-call",
          kind: "tool",
          title: "tool_call.completed",
          detail: "shell.inspect completed.",
        }],
        documents: [{
          path: "E:/Javis/report.md",
          modifiedAt: "2026-07-20T00:00:00.000Z",
          sizeBytes: 120,
          heading: "检查报告",
          purpose: "记录检查结果",
        }],
        isStreaming: true,
        streamingText: "不应阻止终态收拢",
      });

      const { container } = renderThreadView(task);
      const toggle = container.querySelector<HTMLButtonElement>(
        ".javis-terminal-execution-details-toggle",
      );

      expect(container.textContent).toContain("最终回复");
      expect(container.textContent).not.toContain("正在读取项目");
      expect(container.textContent).not.toContain("正在验证结果");
      expect(toggle?.textContent).toContain("执行详情");
      expect(toggle?.getAttribute("aria-expanded")).toBe("false");
      expect(container.querySelector(".javis-tool-call-card")).toBeNull();
      expect(container.querySelector(".javis-artifact-card")).toBeNull();
      expect(container.querySelector(".javis-context-stats")).toBeNull();
      if (status === "failed") {
        expect(container.querySelector(".javis-recovery")).not.toBeNull();
      }

      fireEvent.click(toggle!);

      expect(toggle?.getAttribute("aria-expanded")).toBe("true");
      expect(container.textContent).toContain("检查项目文件");
      expect(container.querySelector(".javis-tool-call-card")).not.toBeNull();
      expect(container.querySelector(".javis-artifact-card")).not.toBeNull();
      expect(container.querySelector(".javis-context-stats")).not.toBeNull();
    },
  );

  it("opens persisted timeout messages in the detail inspector", () => {
    const onOpenDetail = vi.fn();
    const task = createTask({
      id: "task-timeout-1",
      status: "planning",
      conversationMessages: [
        { role: "user", content: "收集三个来源" },
        { role: "assistant", content: "commander.plan timed out after 90000ms." },
        { role: "user", content: "重试" },
      ],
      logs: [],
    });

    renderThreadView(task, onOpenDetail);
    fireEvent.click(screen.getByRole("button", { name: "查看超时详情" }));

    expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({
      title: "任务超时详情",
      kind: "Timeout",
      source: "runtime",
      content: expect.stringContaining("DAG 计划尚未生成"),
      metadata: expect.arrayContaining([
        { label: "阶段", value: "commander.plan" },
        { label: "超时上限", value: "90 s" },
        { label: "任务 ID", value: "task-timeout-1" },
      ]),
    }));
  });
});

function renderThreadView(task: WorkbenchTask, onOpenDetail = vi.fn()) {
  return render(renderThreadViewElement(task, onOpenDetail));
}

function renderThreadViewElement(task: WorkbenchTask, onOpenDetail = vi.fn()) {
  return (
    <ThreadView
      currentWorkspacePath="E:/Javis"
      draftGoal=""
      labels={zhCNWorkbenchLocale.labels}
      locale={zhCNWorkbenchLocale}
      recentWorkspacePaths={[]}
      task={task}
      onDraftGoalChange={vi.fn()}
      onOpenDetail={onOpenDetail}
      onSubmit={vi.fn()}
    />
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
