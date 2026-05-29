import { render, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatComposer } from "./ChatComposer";
import { zhCNWorkbenchLocale } from "../locale";

const labels = zhCNWorkbenchLocale.labels;

describe("ChatComposer", () => {
  it("renders a textarea with the current draft goal", () => {
    const { container } = render(
      <ChatComposer
        actionsClassName="actions"
        className="composer"
        currentWorkspacePath="/tmp"
        draftGoal="Inspect project"
        labels={labels}
        recentWorkspacePaths={[]}
        onDraftGoalChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe("Inspect project");
  });

  it("calls onDraftGoalChange when the user types", () => {
    const onChange = vi.fn();
    const { container } = render(
      <ChatComposer
        actionsClassName="actions"
        className="composer"
        currentWorkspacePath="/tmp"
        draftGoal=""
        labels={labels}
        recentWorkspacePaths={[]}
        onDraftGoalChange={onChange}
        onSubmit={vi.fn()}
      />,
    );
    fireEvent.change(container.querySelector("textarea")!, {
      target: { value: "Review code changes" },
    });
    expect(onChange).toHaveBeenCalledWith("Review code changes");
  });

  it("calls onSubmit when pressing Enter in the textarea", () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <ChatComposer
        actionsClassName="actions"
        className="composer"
        currentWorkspacePath="/tmp"
        draftGoal="Hello"
        labels={labels}
        recentWorkspacePaths={[]}
        onDraftGoalChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.keyDown(container.querySelector("textarea")!, {
      key: "Enter",
      shiftKey: false,
    });
    expect(onSubmit).toHaveBeenCalled();
  });

  it("does not call onSubmit on Shift+Enter", () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <ChatComposer
        actionsClassName="actions"
        className="composer"
        currentWorkspacePath="/tmp"
        draftGoal="Hello"
        labels={labels}
        recentWorkspacePaths={[]}
        onDraftGoalChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.keyDown(container.querySelector("textarea")!, {
      key: "Enter",
      shiftKey: true,
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows stop button instead of send when streaming", () => {
    const { container } = render(
      <ChatComposer
        actionsClassName="actions"
        className="composer"
        currentWorkspacePath="/tmp"
        draftGoal="Hello"
        isStreaming={true}
        labels={labels}
        recentWorkspacePaths={[]}
        onDraftGoalChange={vi.fn()}
        onStopTask={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    const buttons = container.querySelectorAll("button");
    const buttonTexts = Array.from(buttons).map((b) => b.textContent);
    expect(buttonTexts).toContain("停止");
    expect(buttonTexts).not.toContain("发送");
  });

  it("shows send button when not streaming", () => {
    const { container } = render(
      <ChatComposer
        actionsClassName="actions"
        className="composer"
        currentWorkspacePath="/tmp"
        draftGoal="Hello"
        isStreaming={false}
        labels={labels}
        recentWorkspacePaths={[]}
        onDraftGoalChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    const buttons = container.querySelectorAll("button");
    const buttonTexts = Array.from(buttons).map((b) => b.textContent);
    expect(buttonTexts).toContain("发送");
    expect(buttonTexts).not.toContain("停止");
  });

  it("calls onStopTask when stop button is clicked", () => {
    const onStop = vi.fn();
    const { container } = render(
      <ChatComposer
        actionsClassName="actions"
        className="composer"
        currentWorkspacePath="/tmp"
        draftGoal="Hello"
        isStreaming={true}
        labels={labels}
        recentWorkspacePaths={[]}
        onDraftGoalChange={vi.fn()}
        onStopTask={onStop}
        onSubmit={vi.fn()}
      />,
    );
    const stopBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "停止",
    );
    fireEvent.click(stopBtn!);
    expect(onStop).toHaveBeenCalled();
  });

  it("marks textarea as disabled when disabled prop is set", () => {
    const { container } = render(
      <ChatComposer
        actionsClassName="actions"
        className="composer"
        currentWorkspacePath="/tmp"
        disabled={true}
        draftGoal="Hello"
        labels={labels}
        recentWorkspacePaths={[]}
        onDraftGoalChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect((container.querySelector("textarea") as HTMLTextAreaElement).disabled).toBe(true);
  });

  it("shows @mention dropdown when user types @ and documents match", () => {
    const docs = [
      { name: "README.md", path: "E:/Javis/README.md", isDir: false, sizeBytes: 100, modifiedAt: "2026-01-01", extension: "md" },
    ];
    const onChange = vi.fn();
    const { container } = render(
      <ChatComposer
        actionsClassName="actions"
        className="composer"
        currentWorkspacePath="/tmp"
        draftGoal=""
        labels={labels}
        recentWorkspacePaths={[]}
        userDocuments={docs}
        onDraftGoalChange={onChange}
        onSubmit={vi.fn()}
      />,
    );
    // Trigger the @mention detection by simulating user typing @README
    const textarea = container.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "Find @README" } });
    expect(onChange).toHaveBeenCalledWith("Find @README");
    // The mention dropdown should now be visible
    expect(container.querySelector('[role="listbox"]')).toBeTruthy();
  });

  it("renders the attachment menu details element", () => {
    const { container } = render(
      <ChatComposer
        actionsClassName="actions"
        className="composer"
        currentWorkspacePath="/tmp"
        draftGoal=""
        labels={labels}
        recentWorkspacePaths={[]}
        onDraftGoalChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(container.querySelector("details")).toBeTruthy();
  });
});
