import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type ChangeEvent,
  type FormEventHandler,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { WorkbenchFileEntry, WorkbenchLocale } from "../types";
import { WorkspaceContext } from "./WorkspaceContext";

interface ChatComposerProps {
  actionsClassName: string;
  className: string;
  composeMode?: "chat" | "project";
  currentWorkspacePath: string;
  disabled?: boolean;
  draftGoal: string;
  isStreaming?: boolean;
  labels: WorkbenchLocale["labels"];
  recentWorkspacePaths: string[];
  sendButtonClassName?: string;
  taskInputPlaceholder?: string;
  statusHint?: string;
  showWorkspaceContext?: boolean;
  userDocuments?: WorkbenchFileEntry[];
  contextControl?: ReactNode;
  onBrowseWorkspacePath?: () => void;
  onDeleteRecentWorkspacePath?: (path: string) => void;
  onDraftGoalChange: (nextGoal: string) => void;
  onSelectComposeMode?: (mode: "chat" | "project") => void;
  onStopTask?: () => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  /** Called instead of onSubmit when there are image attachments, with the raw File objects. */
  onSubmitWithAttachments?: (goal: string, attachments: File[]) => void;
  onUseWorkspacePath?: (path: string) => void;
  onWorkspacePathChange?: (path: string) => void;
}

interface ComposerAttachment {
  id: string;
  file: File;
  previewUrl?: string;
}

function escapeMentionPath(path: string): string {
  return path.replace(/\]/g, "\\]");
}

export function ChatComposer({
  actionsClassName,
  className,
  composeMode = "chat",
  currentWorkspacePath,
  disabled = false,
  draftGoal,
  isStreaming = false,
  labels,
  recentWorkspacePaths,
  sendButtonClassName = "javis-send-button",
  taskInputPlaceholder,
  statusHint,
  showWorkspaceContext = true,
  userDocuments,
  contextControl,
  onBrowseWorkspacePath,
  onDeleteRecentWorkspacePath,
  onDraftGoalChange,
  onSelectComposeMode,
  onStopTask,
  onSubmit,
  onSubmitWithAttachments,
  onUseWorkspacePath,
  onWorkspacePathChange,
}: ChatComposerProps) {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const isPlanMode = composeMode === "project";
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
    setAttachments((current) => {
      const currentImageCount = current.filter((item) => item.file.type.startsWith("image/")).length;
      const remainingImageSlots = Math.max(0, 5 - currentImageCount);
      const acceptedFiles: File[] = [];
      let acceptedImageCount = 0;
      let skippedImageCount = 0;
      let skippedUnsupportedCount = 0;
      for (const file of nextFiles) {
        if (!file.type.startsWith("image/")) {
          skippedUnsupportedCount += 1;
          continue;
        }
        if (acceptedImageCount < remainingImageSlots) {
          acceptedFiles.push(file);
          acceptedImageCount += 1;
        } else {
          skippedImageCount += 1;
        }
      }
      const isChinese = labels.newChat !== "New chat";
      setAttachmentNotice(
        [
          skippedImageCount > 0
            ? formatAttachmentLimitNotice(
                currentImageCount + acceptedImageCount,
                skippedImageCount,
                isChinese,
              )
            : null,
          skippedUnsupportedCount > 0
            ? formatUnsupportedAttachmentNotice(skippedUnsupportedCount, isChinese)
            : null,
        ].filter(Boolean).join(" ") || null,
      );
      return [
        ...current,
        ...acceptedFiles.map((file) => ({
        id: `${file.name}-${file.size}-${file.lastModified}-${createAttachmentId()}`,
        file,
        previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
        })),
      ];
    });
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
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const target = event.currentTarget;
    if (!target) return;
    if (disabled) {
      target.value = "";
      return;
    }
    if (target.files) {
      addFiles(target.files);
    }
    target.value = "";
  }

  // @mention detection
  const mentionMatches = mentionQuery !== null && userDocuments
    ? userDocuments
        .filter((doc) =>
          doc.name.toLowerCase().includes(mentionQuery.toLowerCase()) ||
          doc.path.toLowerCase().includes(mentionQuery.toLowerCase()),
        )
        .slice(0, 8)
    : [];

  function resolveMentionQuery(value: string, cursorPos: number): string | null {
    const beforeCursor = value.slice(0, cursorPos);
    const atIndex = beforeCursor.lastIndexOf("@");
    if (atIndex === -1) return null;
    const query = beforeCursor.slice(atIndex + 1);
    // Only trigger if @ is followed by 0+ word chars (no spaces)
    if (/\s/.test(query)) return null;
    return query;
  }

  function insertMention(doc: WorkbenchFileEntry) {
    const textarea = textAreaRef.current;
    if (!textarea) return;
    const value = draftGoal;
    const cursorPos = textarea.selectionStart;
    const beforeCursor = value.slice(0, cursorPos);
    const atIndex = beforeCursor.lastIndexOf("@");
    if (atIndex === -1) return;
    const before = value.slice(0, atIndex);
    const after = value.slice(cursorPos);
    const mention = `@[${escapeMentionPath(doc.path)}] `;
    const next = before + mention + after;
    onDraftGoalChange(next);
    setMentionQuery(null);
    setMentionIndex(0);
    // Set cursor after the inserted mention
    requestAnimationFrame(() => {
      textarea.selectionStart = textarea.selectionEnd = (before + mention).length;
      textarea.focus();
    });
  }

  function handleChangeWithMention(event: ChangeEvent<HTMLTextAreaElement>) {
    const target = event.currentTarget;
    if (!target) return;
    const value = target.value;
    onDraftGoalChange(value);
    const query = resolveMentionQuery(value, target.selectionStart);
    setMentionQuery(query);
    setMentionIndex(0);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionMatches.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionIndex((i) => Math.min(i + 1, mentionMatches.length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        insertMention(mentionMatches[mentionIndex]);
        return;
      }
      if (event.key === "Escape") {
        setMentionQuery(null);
        setMentionIndex(0);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const form = textAreaRef.current?.form;
      if (form) {
        form.requestSubmit();
      }
    }
  }

  const handleSubmit: FormEventHandler<HTMLFormElement> = (event) => {
    event.preventDefault();
    setMentionQuery(null);
    setMentionIndex(0);
    if (attachments.length > 0 && onSubmitWithAttachments) {
      const files = attachments.map((a) => a.file);
      setAttachments([]);
      setAttachmentNotice(null);
      onSubmitWithAttachments(draftGoal, files);
      return;
    }
    onSubmit(event);
  };

  const composerClassName = isStreaming ? `${className} streaming` : className;
  const resolvedPlaceholder = isStreaming
    ? queuedInputPlaceholder(labels)
    : taskInputPlaceholder ?? labels.taskInputPlaceholder;

  return (
    <form className={composerClassName} onSubmit={handleSubmit}>
      {isStreaming ? (
        <div className="javis-composer-continuation-header">
          <span className="javis-composer-continuation-title">
            <span className="javis-continuation-icon icon-continue" aria-hidden="true" />
            {continuationLabel(labels)}
          </span>
          <span className="javis-composer-continuation-actions">
            <button type="button">
              <span className="javis-continuation-icon icon-guide" aria-hidden="true" />
              {guideLabel(labels)}
            </button>
            <button type="button" aria-label={deleteQueuedDraftLabel(labels)}>
              <span className="javis-continuation-icon icon-trash" aria-hidden="true" />
            </button>
            <button type="button" aria-label={moreActionsLabel(labels)}>
              <span className="javis-continuation-icon icon-more" aria-hidden="true" />
            </button>
          </span>
        </div>
      ) : null}
      {attachments.length > 0 ? (
        <div className="javis-composer-attachments" aria-label={labels.addedAttachments}>
          {attachments.map((attachment) => (
            <article className="javis-composer-attachment" key={attachment.id}>
              {attachment.previewUrl ? (
                <img alt={attachment.file.name} src={attachment.previewUrl} />
              ) : (
                <span className="javis-composer-file-icon">FILE</span>
              )}
              <span>{attachment.file.name}</span>
              <button
                aria-label={`${labels.removeAttachment}: ${attachment.file.name}`}
                disabled={disabled}
                onClick={() => removeAttachment(attachment.id)}
                type="button"
              >
                x
              </button>
            </article>
          ))}
        </div>
      ) : null}
      {attachmentNotice ? (
        <p className="javis-composer-attachment-notice">{attachmentNotice}</p>
      ) : null}
      {statusHint ? (
        <p className="javis-composer-status-hint">{statusHint}</p>
      ) : null}
      {mentionMatches.length > 0 ? (
        <ul className="javis-mention-dropdown" role="listbox">
          {mentionMatches.map((doc, index) => (
            <li
              key={doc.path}
              className={index === mentionIndex ? "javis-mention-active" : ""}
              role="option"
              aria-selected={index === mentionIndex}
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(doc);
              }}
            >
              <span className="javis-mention-name">{doc.name}</span>
              <span className="javis-mention-path">{doc.path}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <textarea
        aria-label={labels.taskInput}
        disabled={disabled}
        onChange={handleChangeWithMention}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder={resolvedPlaceholder}
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
            <span className="javis-composer-action-icon icon-add" aria-hidden="true" />
          </summary>
          <div className="javis-attach-popover">
            <button
              aria-pressed={isPlanMode}
              disabled={disabled || !onSelectComposeMode}
              onClick={() => onSelectComposeMode?.(isPlanMode ? "chat" : "project")}
              type="button"
            >
              <span aria-hidden="true">PLAN</span>
              <span>{labels.planMode}</span>
              <span className={isPlanMode ? "javis-toggle on" : "javis-toggle"} />
            </button>
            <button
              disabled={disabled}
              onClick={() => fileInputRef.current?.click()}
              type="button"
            >
              <span aria-hidden="true">ATTACH</span>
              <span>{labels.addPhotosAndFiles}</span>
            </button>
            <button disabled type="button">
              <span aria-hidden="true">PLUGIN</span>
              <span>{labels.plugins}</span>
              <span aria-hidden="true">...</span>
            </button>
          </div>
        </details>
        <input
          accept="image/*"
          className="javis-hidden-file-input"
          disabled={disabled}
          multiple
          onChange={handleFileChange}
          ref={fileInputRef}
          type="file"
        />
        {showWorkspaceContext ? (
          <WorkspaceContext
            currentWorkspacePath={currentWorkspacePath}
            labels={labels}
            onBrowseWorkspacePath={onBrowseWorkspacePath}
            onDeleteRecentWorkspacePath={onDeleteRecentWorkspacePath}
            onUseWorkspacePath={onUseWorkspacePath}
            onWorkspacePathChange={onWorkspacePathChange}
            recentWorkspacePaths={recentWorkspacePaths}
          />
        ) : null}
        {contextControl}
        <button className={`${sendButtonClassName} icon-only`} disabled={disabled} type="submit">
          <span
            className={`javis-composer-action-icon ${isStreaming ? "icon-queue" : "icon-send"}`}
            aria-hidden="true"
          />
          <span className="javis-visually-hidden">
            {isStreaming ? queuedSendLabel(labels) : labels.send}
          </span>
        </button>
        {isStreaming ? (
          <button
            className={`${sendButtonClassName} icon-only`}
            onClick={(event) => {
              event.preventDefault();
              onStopTask?.();
            }}
            type="button"
          >
            <span className="javis-composer-action-icon icon-stop" aria-hidden="true" />
            <span className="javis-visually-hidden">{labels.stopTask}</span>
          </button>
        ) : null}
      </div>
    </form>
  );
}

function queuedSendLabel(labels: ChatComposerProps["labels"]): string {
  return labels.newChat === "New chat" ? "Queue" : "\u6392\u961f";
}

function continuationLabel(labels: ChatComposerProps["labels"]): string {
  return labels.newChat === "New chat" ? "Continue" : "\u7ee7\u7eed";
}

function queuedInputPlaceholder(labels: ChatComposerProps["labels"]): string {
  return labels.newChat === "New chat" ? "Request follow-up changes" : "\u8981\u6c42\u540e\u7eed\u53d8\u66f4";
}

function guideLabel(labels: ChatComposerProps["labels"]): string {
  return labels.newChat === "New chat" ? "Guide" : "\u5f15\u5bfc";
}

function deleteQueuedDraftLabel(labels: ChatComposerProps["labels"]): string {
  return labels.newChat === "New chat" ? "Clear queued draft" : "\u6e05\u9664\u6392\u961f\u8349\u7a3f";
}

function moreActionsLabel(labels: ChatComposerProps["labels"]): string {
  return labels.newChat === "New chat" ? "More actions" : "\u66f4\u591a\u64cd\u4f5c";
}

function formatAttachmentLimitNotice(selectedCount: number, skippedCount: number, isChinese: boolean): string {
  return isChinese
    ? `\u5df2\u9009\u62e9 ${selectedCount} \u5f20\u56fe\u7247\uff0c\u6700\u591a 5 \u5f20\uff1b${skippedCount} \u5f20\u8d85\u51fa\u9650\u5236\uff0c\u672a\u6dfb\u52a0\u3002`
    : `Selected ${selectedCount} image(s), max 5. ${skippedCount} extra image(s) were not added.`;
}

function formatUnsupportedAttachmentNotice(skippedCount: number, isChinese: boolean): string {
  return isChinese
    ? `${skippedCount} \u4e2a\u975e\u56fe\u7247\u9644\u4ef6\u672a\u6dfb\u52a0\u3002`
    : `${skippedCount} non-image attachment(s) were not added.`;
}

function createAttachmentId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}
