import { act, render, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatComposer } from "./ChatComposer";
import { defaultWorkbenchLocale, zhCNWorkbenchLocale } from "../locale";

const labels = zhCNWorkbenchLocale.labels;

class FakeSpeechRecognition {
  static instances: FakeSpeechRecognition[] = [];
  static autoEndOnStop = true;

  continuous = false;
  interimResults = false;
  lang = "";
  maxAlternatives = 0;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onresult: ((event: { results: FakeSpeechRecognitionResultList }) => void) | null = null;
  onstart: (() => void) | null = null;

  constructor() {
    FakeSpeechRecognition.instances.push(this);
  }

  start() {
    this.onstart?.();
  }

  stop() {
    if (FakeSpeechRecognition.autoEndOnStop) {
      this.finish();
    }
  }

  abort() {
    this.finish();
  }

  emitResult(text: string) {
    this.onresult?.({ results: createSpeechResults(text) });
  }

  finish() {
    this.onend?.();
  }
}

interface FakeSpeechRecognitionResultList {
  readonly length: number;
  item(index: number): FakeSpeechRecognitionResult;
  [index: number]: FakeSpeechRecognitionResult;
}

interface FakeSpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): { transcript: string };
  [index: number]: { transcript: string };
}

function createSpeechResults(text: string): FakeSpeechRecognitionResultList {
  const result: FakeSpeechRecognitionResult = {
    0: { transcript: text },
    isFinal: true,
    length: 1,
    item(index: number) {
      return this[index];
    },
  };
  return {
    0: result,
    length: 1,
    item(index: number) {
      return this[index];
    },
  };
}

function installFakeSpeechRecognition() {
  FakeSpeechRecognition.instances = [];
  FakeSpeechRecognition.autoEndOnStop = true;
  Object.defineProperty(window, "webkitSpeechRecognition", {
    configurable: true,
    value: FakeSpeechRecognition,
  });
}

afterEach(() => {
  vi.useRealTimers();
  FakeSpeechRecognition.autoEndOnStop = true;
  Reflect.deleteProperty(window, "webkitSpeechRecognition");
});

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

  it("submits when the send button is clicked normally", () => {
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

    fireEvent.click(container.querySelector(".javis-send-button")!);

    expect(onSubmit).toHaveBeenCalled();
  });

  it("long-presses the send button for voice input and requires a second click to send", () => {
    vi.useFakeTimers();
    installFakeSpeechRecognition();
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const { container } = render(
      <ChatComposer
        actionsClassName="actions"
        className="composer"
        currentWorkspacePath="/tmp"
        draftGoal=""
        labels={defaultWorkbenchLocale.labels}
        recentWorkspacePaths={[]}
        onDraftGoalChange={onChange}
        onSubmit={onSubmit}
      />,
    );
    const sendButton = container.querySelector(".javis-send-button")!;

    fireEvent.pointerDown(sendButton, { button: 0, pointerId: 1 });
    act(() => {
      vi.advanceTimersByTime(450);
    });

    const recognition = FakeSpeechRecognition.instances[0];
    expect(recognition).toBeTruthy();
    expect(container.querySelector(".javis-composer-action-icon.icon-mic")).not.toBeNull();
    recognition.emitResult("review the current diff");
    expect(onChange).toHaveBeenLastCalledWith("review the current diff");

    fireEvent.pointerUp(sendButton, { pointerId: 1 });
    fireEvent.click(sendButton);
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(sendButton);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("does not swallow the next real send click if release produced no click event", () => {
    vi.useFakeTimers();
    installFakeSpeechRecognition();
    FakeSpeechRecognition.autoEndOnStop = false;
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const { container } = render(
      <ChatComposer
        actionsClassName="actions"
        className="composer"
        currentWorkspacePath="/tmp"
        draftGoal=""
        labels={defaultWorkbenchLocale.labels}
        recentWorkspacePaths={[]}
        onDraftGoalChange={onChange}
        onSubmit={onSubmit}
      />,
    );
    const sendButton = container.querySelector(".javis-send-button")!;

    fireEvent.pointerDown(sendButton, { button: 0, pointerId: 1 });
    act(() => {
      vi.advanceTimersByTime(450);
    });
    const recognition = FakeSpeechRecognition.instances[0];
    recognition.emitResult("summarize this file");

    fireEvent.pointerUp(sendButton, { pointerId: 1 });
    act(() => {
      vi.runOnlyPendingTimers();
    });
    act(() => {
      recognition.finish();
    });

    fireEvent.click(sendButton);

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("preserves user edits while voice recognition updates the transcript", () => {
    vi.useFakeTimers();
    installFakeSpeechRecognition();
    const onChange = vi.fn();
    const { container, rerender } = render(
      <ChatComposer
        actionsClassName="actions"
        className="composer"
        currentWorkspacePath="/tmp"
        draftGoal="Start"
        labels={defaultWorkbenchLocale.labels}
        recentWorkspacePaths={[]}
        onDraftGoalChange={onChange}
        onSubmit={vi.fn()}
      />,
    );
    const sendButton = container.querySelector(".javis-send-button")!;

    fireEvent.pointerDown(sendButton, { button: 0, pointerId: 1 });
    act(() => {
      vi.advanceTimersByTime(450);
    });
    const recognition = FakeSpeechRecognition.instances[0];
    recognition.emitResult("first draft");
    expect(onChange).toHaveBeenLastCalledWith("Start first draft");

    rerender(
      <ChatComposer
        actionsClassName="actions"
        className="composer"
        currentWorkspacePath="/tmp"
        draftGoal="Start first draft and typed note"
        labels={defaultWorkbenchLocale.labels}
        recentWorkspacePaths={[]}
        onDraftGoalChange={onChange}
        onSubmit={vi.fn()}
      />,
    );
    recognition.emitResult("final words");

    expect(onChange).toHaveBeenLastCalledWith("Start and typed note final words");
  });

  it("keeps punctuation attached when replacing prior voice text", () => {
    vi.useFakeTimers();
    installFakeSpeechRecognition();
    const onChange = vi.fn();
    const { container, rerender } = render(
      <ChatComposer
        actionsClassName="actions"
        className="composer"
        currentWorkspacePath="/tmp"
        draftGoal="Start"
        labels={defaultWorkbenchLocale.labels}
        recentWorkspacePaths={[]}
        onDraftGoalChange={onChange}
        onSubmit={vi.fn()}
      />,
    );
    const sendButton = container.querySelector(".javis-send-button")!;

    fireEvent.pointerDown(sendButton, { button: 0, pointerId: 1 });
    act(() => {
      vi.advanceTimersByTime(450);
    });
    const recognition = FakeSpeechRecognition.instances[0];
    recognition.emitResult("first draft");
    expect(onChange).toHaveBeenLastCalledWith("Start first draft");

    rerender(
      <ChatComposer
        actionsClassName="actions"
        className="composer"
        currentWorkspacePath="/tmp"
        draftGoal="Start first draft, typed note"
        labels={defaultWorkbenchLocale.labels}
        recentWorkspacePaths={[]}
        onDraftGoalChange={onChange}
        onSubmit={vi.fn()}
      />,
    );
    recognition.emitResult("final words");

    expect(onChange).toHaveBeenLastCalledWith("Start, typed note final words");
  });

  it("keeps tracking prior voice text when the user edits before it", () => {
    vi.useFakeTimers();
    installFakeSpeechRecognition();
    const onChange = vi.fn();
    const { container, rerender } = render(
      <ChatComposer
        actionsClassName="actions"
        className="composer"
        currentWorkspacePath="/tmp"
        draftGoal="Start"
        labels={defaultWorkbenchLocale.labels}
        recentWorkspacePaths={[]}
        onDraftGoalChange={onChange}
        onSubmit={vi.fn()}
      />,
    );
    const sendButton = container.querySelector(".javis-send-button")!;

    fireEvent.pointerDown(sendButton, { button: 0, pointerId: 1 });
    act(() => {
      vi.advanceTimersByTime(450);
    });
    const recognition = FakeSpeechRecognition.instances[0];
    recognition.emitResult("first draft");
    expect(onChange).toHaveBeenLastCalledWith("Start first draft");

    rerender(
      <ChatComposer
        actionsClassName="actions"
        className="composer"
        currentWorkspacePath="/tmp"
        draftGoal="Note Start first draft"
        labels={defaultWorkbenchLocale.labels}
        recentWorkspacePaths={[]}
        onDraftGoalChange={onChange}
        onSubmit={vi.fn()}
      />,
    );
    recognition.emitResult("final words");

    expect(onChange).toHaveBeenLastCalledWith("Note Start final words");
  });

  it("does not remove matching user text when prior voice text was edited away", () => {
    vi.useFakeTimers();
    installFakeSpeechRecognition();
    const onChange = vi.fn();
    const { container, rerender } = render(
      <ChatComposer
        actionsClassName="actions"
        className="composer"
        currentWorkspacePath="/tmp"
        draftGoal="echo"
        labels={defaultWorkbenchLocale.labels}
        recentWorkspacePaths={[]}
        onDraftGoalChange={onChange}
        onSubmit={vi.fn()}
      />,
    );
    const sendButton = container.querySelector(".javis-send-button")!;

    fireEvent.pointerDown(sendButton, { button: 0, pointerId: 1 });
    act(() => {
      vi.advanceTimersByTime(450);
    });
    const recognition = FakeSpeechRecognition.instances[0];
    recognition.emitResult("echo");
    expect(onChange).toHaveBeenLastCalledWith("echo echo");

    rerender(
      <ChatComposer
        actionsClassName="actions"
        className="composer"
        currentWorkspacePath="/tmp"
        draftGoal="echo typed note"
        labels={defaultWorkbenchLocale.labels}
        recentWorkspacePaths={[]}
        onDraftGoalChange={onChange}
        onSubmit={vi.fn()}
      />,
    );
    recognition.emitResult("final words");

    expect(onChange).toHaveBeenLastCalledWith("echo typed note final words");
  });

  it("does not submit while voice input is still recording", () => {
    vi.useFakeTimers();
    installFakeSpeechRecognition();
    const onSubmit = vi.fn();
    const { container } = render(
      <ChatComposer
        actionsClassName="actions"
        className="composer"
        currentWorkspacePath="/tmp"
        draftGoal="existing text"
        labels={defaultWorkbenchLocale.labels}
        recentWorkspacePaths={[]}
        onDraftGoalChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    const sendButton = container.querySelector(".javis-send-button")!;
    const form = container.querySelector("form")!;

    fireEvent.pointerDown(sendButton, { button: 0, pointerId: 1 });
    act(() => {
      vi.advanceTimersByTime(450);
    });

    fireEvent.submit(form);
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.pointerUp(sendButton, { pointerId: 1 });
    fireEvent.click(sendButton);
    fireEvent.click(sendButton);

    expect(onSubmit).toHaveBeenCalledTimes(1);
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
    const stopBtn = container.querySelector(".javis-composer-stop-action");
    expect(stopBtn).not.toBeNull();
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
    const queueBtn = container.querySelector(".javis-composer-send-action");
    const stopBtn = container.querySelector(".javis-composer-stop-action");
    expect(queueBtn).not.toBeNull();
    expect(stopBtn).not.toBeNull();

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

  it("renders nothing when permissionControls is undefined", () => {
    const { container } = render(
      <ChatComposer
        actionsClassName="actions"
        className="composer"
        currentWorkspacePath="/tmp"
        draftGoal=""
        labels={defaultWorkbenchLocale.labels}
        recentWorkspacePaths={[]}
        onDraftGoalChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(container.querySelector(".javis-permission-controls")).toBeNull();
  });

  it("renders Request Approval when canRequestApproval is true", () => {
    const { container } = render(
      <ChatComposer
        actionsClassName="actions"
        className="composer"
        currentWorkspacePath="/tmp"
        draftGoal=""
        labels={defaultWorkbenchLocale.labels}
        permissionControls={{ canRequestApproval: true }}
        recentWorkspacePaths={[]}
        onDraftGoalChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(container.querySelector(".javis-permission-request")?.textContent)
      .toBe("Request approval");
  });

  it("renders approve/deny buttons when pendingRequest is set", () => {
    const onApprove = vi.fn();
    const onAllowTask = vi.fn();
    const onDeny = vi.fn();
    const { container } = render(
      <ChatComposer
        actionsClassName="actions"
        className="composer"
        currentWorkspacePath="/tmp"
        draftGoal=""
        labels={defaultWorkbenchLocale.labels}
        permissionControls={{
          canRequestApproval: false,
          pendingRequest: { allowAlways: true, onApprove, onAllowTask, onDeny },
        }}
        recentWorkspacePaths={[]}
        onDraftGoalChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(container.querySelector(".javis-permission-approve")?.textContent)
      .toBe("Approve");
    expect(container.querySelector(".javis-permission-allow-task")?.textContent)
      .toBe("Allow this task");
    expect(container.querySelector(".javis-permission-deny")?.textContent)
      .toBe("Deny");
    expect(container.querySelector(".javis-permission-request")).toBeNull();
  });

  it("hides Allow Task when allowAlways is false", () => {
    const { container } = render(
      <ChatComposer
        actionsClassName="actions"
        className="composer"
        currentWorkspacePath="/tmp"
        draftGoal=""
        labels={defaultWorkbenchLocale.labels}
        permissionControls={{
          canRequestApproval: false,
          pendingRequest: {
            allowAlways: false,
            onApprove: vi.fn(),
            onAllowTask: vi.fn(),
            onDeny: vi.fn(),
          },
        }}
        recentWorkspacePaths={[]}
        onDraftGoalChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(container.querySelector(".javis-permission-allow-task")).toBeNull();
  });

  it("full access button is always disabled", () => {
    const { container } = render(
      <ChatComposer
        actionsClassName="actions"
        className="composer"
        currentWorkspacePath="/tmp"
        draftGoal=""
        labels={defaultWorkbenchLocale.labels}
        permissionControls={{ canRequestApproval: false, showFullAccess: true }}
        recentWorkspacePaths={[]}
        onDraftGoalChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    const btn = container.querySelector(".javis-permission-full-access") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(true);
  });

  it("uses Chinese labels when zhCN locale is provided", () => {
    const { container } = render(
      <ChatComposer
        actionsClassName="actions"
        className="composer"
        currentWorkspacePath="/tmp"
        draftGoal=""
        labels={zhCNWorkbenchLocale.labels}
        permissionControls={{
          canRequestApproval: true,
          pendingRequest: {
            allowAlways: true,
            onApprove: vi.fn(),
            onAllowTask: vi.fn(),
            onDeny: vi.fn(),
          },
        }}
        recentWorkspacePaths={[]}
        onDraftGoalChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    // With pendingRequest set, Request Approval should be hidden;
    // check that Chinese labels appear on action buttons
    expect(container.querySelector(".javis-permission-approve")?.textContent)
      .toBe("批准本次");
    expect(container.querySelector(".javis-permission-allow-task")?.textContent)
      .toBe("允许本任务");
    expect(container.querySelector(".javis-permission-deny")?.textContent)
      .toBe("拒绝");
  });
});
