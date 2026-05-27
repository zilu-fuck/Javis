import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type ChangeEvent,
  type FormEventHandler,
  type KeyboardEvent,
} from "react";
import type { WorkbenchLocale } from "../types";
import { WorkspaceContext } from "./WorkspaceContext";

interface ChatComposerProps {
  actionsClassName: string;
  className: string;
  currentWorkspacePath: string;
  disabled?: boolean;
  draftGoal: string;
  isStreaming?: boolean;
  labels: WorkbenchLocale["labels"];
  recentWorkspacePaths: string[];
  sendButtonClassName?: string;
  onBrowseWorkspacePath?: () => void;
  onDeleteRecentWorkspacePath?: (path: string) => void;
  onDraftGoalChange: (nextGoal: string) => void;
  onStopTask?: () => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onUseWorkspacePath?: (path: string) => void;
  onWorkspacePathChange?: (path: string) => void;
}

interface ComposerAttachment {
  id: string;
  file: File;
  previewUrl?: string;
}

export function ChatComposer({
  actionsClassName,
  className,
  currentWorkspacePath,
  disabled = false,
  draftGoal,
  isStreaming = false,
  labels,
  recentWorkspacePaths,
  sendButtonClassName,
  onBrowseWorkspacePath,
  onDeleteRecentWorkspacePath,
  onDraftGoalChange,
  onStopTask,
  onSubmit,
  onUseWorkspacePath,
  onWorkspacePathChange,
}: ChatComposerProps) {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [isPlanMode, setPlanMode] = useState(false);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  attachmentsRef.current = attachments;

  useEffect(() => {
    const textarea = textAreaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 72), 220)}px`;
  }, [attachments.length, draftGoal]);

  useEffect(
    () => () => {
      attachmentsRef.current.forEach((attachment) => {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      });
    },
    [],
  );

  function addFiles(files: FileList | File[]) {
    const nextFiles = Array.from(files);
    if (nextFiles.length === 0) return;
    setAttachments((current) => [
      ...current,
      ...nextFiles.map((file) => ({
        id: `${file.name}-${file.size}-${file.lastModified}-${createAttachmentId()}`,
        file,
        previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
      })),
    ]);
  }

  function removeAttachment(id: string) {
    if (disabled) return;
    setAttachments((current) => {
      const attachment = current.find((item) => item.id === id);
      if (attachment?.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      return current.filter((item) => item.id !== id);
    });
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (disabled) return;
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    if (disabled) {
      event.currentTarget.value = "";
      return;
    }
    if (event.currentTarget.files) {
      addFiles(event.currentTarget.files);
    }
    event.currentTarget.value = "";
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const form = textAreaRef.current?.form;
      if (form) {
        form.requestSubmit();
      }
    }
  }

  const handleSubmit: FormEventHandler<HTMLFormElement> = (event) => {
    onSubmit(event);
  };

  return (
    <form className={className} onSubmit={handleSubmit}>
      {attachments.length > 0 ? (
        <div className="javis-composer-attachments" aria-label={labels.addedAttachments}>
          {attachments.map((attachment) => (
            <article className="javis-composer-attachment" key={attachment.id}>
              {attachment.previewUrl ? (
                <img alt={attachment.file.name} src={attachment.previewUrl} />
              ) : (
                <span className="javis-composer-file-icon">□</span>
              )}
              <span>{attachment.file.name}</span>
              <button
                aria-label={`${labels.removeAttachment}: ${attachment.file.name}`}
                disabled={disabled}
                onClick={() => removeAttachment(attachment.id)}
                type="button"
              >
                ×
              </button>
            </article>
          ))}
        </div>
      ) : null}
      <textarea
        aria-label={labels.taskInput}
        disabled={disabled}
        onChange={(event) => onDraftGoalChange(event.currentTarget.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder={labels.taskInputPlaceholder}
        ref={textAreaRef}
        rows={1}
        value={draftGoal}
      />
      <div className={actionsClassName}>
        <details className="javis-attach-menu">
          <summary
            aria-disabled={disabled}
            aria-label={labels.moreInputOptions}
            className="javis-attach-button"
            onClick={(event) => {
              if (disabled) event.preventDefault();
            }}
          >
            +
          </summary>
          <div className="javis-attach-popover">
            <button
              aria-pressed={isPlanMode}
              disabled={disabled}
              onClick={() => setPlanMode((current) => !current)}
              type="button"
            >
              <span>⌘</span>
              <span>{labels.planMode}</span>
              <span className={isPlanMode ? "javis-toggle on" : "javis-toggle"} />
            </button>
            <button
              disabled={disabled}
              onClick={() => fileInputRef.current?.click()}
              type="button"
            >
              <span>⇧</span>
              <span>{labels.addPhotosAndFiles}</span>
            </button>
            <button disabled type="button">
              <span>⌘</span>
              <span>{labels.plugins}</span>
              <span>›</span>
            </button>
          </div>
        </details>
        <input
          className="javis-hidden-file-input"
          disabled={disabled}
          multiple
          onChange={handleFileChange}
          ref={fileInputRef}
          type="file"
        />
        <WorkspaceContext
          currentWorkspacePath={currentWorkspacePath}
          labels={labels}
          onBrowseWorkspacePath={onBrowseWorkspacePath}
          onDeleteRecentWorkspacePath={onDeleteRecentWorkspacePath}
          onUseWorkspacePath={onUseWorkspacePath}
          onWorkspacePathChange={onWorkspacePathChange}
          recentWorkspacePaths={recentWorkspacePaths}
        />
        {isStreaming ? (
          <button
            className={sendButtonClassName}
            onClick={(event) => {
              event.preventDefault();
              onStopTask?.();
            }}
            type="button"
          >
            {labels.stopTask}
          </button>
        ) : (
          <button className={sendButtonClassName} disabled={disabled} type="submit">
            {labels.send}
          </button>
        )}
      </div>
    </form>
  );
}

function createAttachmentId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}
