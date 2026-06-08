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

  it("shows queue and stop buttons when streaming", () => {
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
    expect(buttonTexts).toContain("排队");
    expect(buttonTexts).toContain(labels.stopTask);
    expect(container.querySelector(".javis-composer-action-icon.icon-queue")).not.toBeNull();
    expect(container.querySelector(".javis-composer-action-icon.icon-stop")).not.toBeNull();
    expect(container.querySelector(".javis-composer-continuation-header")?.textContent)
      .toContain("继续");
    expect((container.querySelector("textarea") as HTMLTextAreaElement).placeholder)
      .toBe("要求后续变更");
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
    expect(buttonTexts).toContain(labels.send);
    expect(buttonTexts).not.toContain(labels.stopTask);
    expect(container.querySelector(".javis-composer-action-icon.icon-send")).not.toBeNull();
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
      (b) => b.textContent === labels.stopTask,
    );
    fireEvent.click(stopBtn!);
    expect(onStop).toHaveBeenCalled();
  });

  it("submits from the queue button while streaming", () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <ChatComposer
        actionsClassName="actions"
        className="composer"
        currentWorkspacePath="/tmp"
        draftGoal="Next question"
        isStreaming={true}
        labels={labels}
        recentWorkspacePaths={[]}
        onDraftGoalChange={vi.fn()}
        onStopTask={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    const queueBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "排队",
    );

    fireEvent.click(queueBtn!);

    expect(onSubmit).toHaveBeenCalled();
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

  it("inserts bracketed @mentions so paths with spaces stay intact", () => {
    const docs = [
      { name: "My File.pdf", path: "E:/Docs/My File.pdf", isDir: false, sizeBytes: 100, modifiedAt: "2026-01-01", extension: "pdf" },
    ];
    const onChange = vi.fn();
    const { container, rerender } = render(
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
    const textarea = container.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "Read @My" } });
    rerender(
      <ChatComposer
        actionsClassName="actions"
        className="composer"
        currentWorkspacePath="/tmp"
        draftGoal="Read @My"
        labels={labels}
        recentWorkspacePaths={[]}
        userDocuments={docs}
        onDraftGoalChange={onChange}
        onSubmit={vi.fn()}
      />,
    );
    const updatedTextarea = container.querySelector("textarea")!;
    updatedTextarea.setSelectionRange("Read @My".length, "Read @My".length);

    fireEvent.mouseDown(container.querySelector('[role="option"]')!);

    expect(onChange).toHaveBeenLastCalledWith("Read @[E:/Docs/My File.pdf] ");
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

  it("routes plan mode toggles through the controlled compose mode callback", () => {
    const onSelectComposeMode = vi.fn();
    const { container, rerender } = render(
      <ChatComposer
        actionsClassName="actions"
        className="composer"
        composeMode="chat"
        currentWorkspacePath="/tmp"
        draftGoal=""
        labels={labels}
        recentWorkspacePaths={[]}
        onDraftGoalChange={vi.fn()}
        onSelectComposeMode={onSelectComposeMode}
        onSubmit={vi.fn()}
      />,
    );
    const planButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes(labels.planMode),
    );
    fireEvent.click(planButton!);
    expect(onSelectComposeMode).toHaveBeenCalledWith("project");

    rerender(
      <ChatComposer
        actionsClassName="actions"
        className="composer"
        composeMode="project"
        currentWorkspacePath="/tmp"
        draftGoal=""
        labels={labels}
        recentWorkspacePaths={[]}
        onDraftGoalChange={vi.fn()}
        onSelectComposeMode={onSelectComposeMode}
        onSubmit={vi.fn()}
      />,
    );
    fireEvent.click(planButton!);
    expect(onSelectComposeMode).toHaveBeenCalledWith("chat");
  });

  it("shows a localized notice when image attachments exceed the limit", () => {
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
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const files = Array.from({ length: 6 }, (_, index) =>
      new File(["x"], `image-${index}.png`, { type: "image/png" }),
    );

    fireEvent.change(input, { target: { files } });

    expect(container.querySelector(".javis-composer-attachment-notice")?.textContent)
      .toContain("最多 5 张");
  });
});
