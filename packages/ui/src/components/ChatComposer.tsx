import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type ChangeEvent,
  type FormEventHandler,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import type { WorkbenchFileEntry, WorkbenchLocale } from "../types";
import { WorkspaceContext } from "./WorkspaceContext";

interface ChatComposerPermissionControls {
  canRequestApproval: boolean;
  onRequestApproval?: () => void;
  pendingRequest?: {
    allowAlways?: boolean;
    onApprove: () => void;
    onAllowTask: () => void;
    onDeny: () => void;
  };
  showFullAccess?: boolean;
}

interface ChatComposerProps {
  actionsClassName: string;
  className: string;
  composeMode?: "chat" | "project";
  currentWorkspacePath: string;
  disabled?: boolean;
  draftGoal: string;
  isStreaming?: boolean;
  labels: WorkbenchLocale["labels"];
  permissionControls?: ChatComposerPermissionControls;
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

type VoiceInputState = "idle" | "recording" | "transcribing";

interface VoiceTranscriptInsertion {
  start: number;
  end: number;
  text: string;
}

interface JavisSpeechRecognitionAlternative {
  transcript: string;
}

interface JavisSpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): JavisSpeechRecognitionAlternative;
  [index: number]: JavisSpeechRecognitionAlternative;
}

interface JavisSpeechRecognitionResultList {
  readonly length: number;
  item(index: number): JavisSpeechRecognitionResult;
  [index: number]: JavisSpeechRecognitionResult;
}

interface JavisSpeechRecognitionResultEvent {
  results: JavisSpeechRecognitionResultList;
}

interface JavisSpeechRecognitionErrorEvent {
  error: string;
}

interface JavisSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onend: (() => void) | null;
  onerror: ((event: JavisSpeechRecognitionErrorEvent) => void) | null;
  onresult: ((event: JavisSpeechRecognitionResultEvent) => void) | null;
  onstart: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface JavisSpeechRecognitionConstructor {
  new (): JavisSpeechRecognition;
}

const VOICE_LONG_PRESS_DELAY_MS = 450;

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
  permissionControls,
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
  const [voiceInputState, setVoiceInputState] = useState<VoiceInputState>("idle");
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const draftGoalRef = useRef(draftGoal);
  const voiceRecognitionRef = useRef<JavisSpeechRecognition | null>(null);
  const voicePressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressSendClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceTranscriptRef = useRef("");
  const voiceTranscriptInsertionRef = useRef<VoiceTranscriptInsertion | null>(null);
  const voicePressStartedRef = useRef(false);
  const suppressSendClickRef = useRef(false);
  const manualVoiceStopRef = useRef(false);
  const isPlanMode = composeMode === "project";
  attachmentsRef.current = attachments;
  if (draftGoalRef.current !== draftGoal) {
    voiceTranscriptInsertionRef.current = adjustVoiceTranscriptInsertion(
      draftGoalRef.current,
      draftGoal,
      voiceTranscriptInsertionRef.current,
    );
    draftGoalRef.current = draftGoal;
  }

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

  useEffect(
    () => () => {
      clearVoicePressTimer();
      clearVoiceNoticeTimer();
      clearSuppressSendClickTimer();
      const recognition = voiceRecognitionRef.current;
      if (recognition) {
        recognition.onend = null;
        recognition.onerror = null;
        recognition.onresult = null;
        recognition.onstart = null;
        recognition.abort();
      }
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
    voiceTranscriptInsertionRef.current = adjustVoiceTranscriptInsertion(
      draftGoalRef.current,
      next,
      voiceTranscriptInsertionRef.current,
    );
    draftGoalRef.current = next;
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
    voiceTranscriptInsertionRef.current = adjustVoiceTranscriptInsertion(
      draftGoalRef.current,
      value,
      voiceTranscriptInsertionRef.current,
    );
    draftGoalRef.current = value;
    clearVoiceNotice();
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
    if (voiceInputState !== "idle") {
      return;
    }
    setMentionQuery(null);
    setMentionIndex(0);
    clearVoiceNotice();
    if (attachments.length > 0 && onSubmitWithAttachments) {
      const files = attachments.map((a) => a.file);
      setAttachments([]);
      setAttachmentNotice(null);
      onSubmitWithAttachments(draftGoal, files);
      return;
    }
    onSubmit(event);
  };

  function clearVoicePressTimer() {
    if (voicePressTimerRef.current) {
      clearTimeout(voicePressTimerRef.current);
      voicePressTimerRef.current = null;
    }
  }

  function clearVoiceNoticeTimer() {
    if (voiceNoticeTimerRef.current) {
      clearTimeout(voiceNoticeTimerRef.current);
      voiceNoticeTimerRef.current = null;
    }
  }

  function clearSuppressSendClickTimer() {
    if (suppressSendClickTimerRef.current) {
      clearTimeout(suppressSendClickTimerRef.current);
      suppressSendClickTimerRef.current = null;
    }
  }

  function suppressImmediateSendClick() {
    clearSuppressSendClickTimer();
    suppressSendClickRef.current = true;
    suppressSendClickTimerRef.current = setTimeout(() => {
      suppressSendClickRef.current = false;
      suppressSendClickTimerRef.current = null;
    }, 0);
  }

  function clearVoiceNotice() {
    clearVoiceNoticeTimer();
    setVoiceNotice(null);
  }

  function showVoiceNotice(message: string, autoClear = false) {
    clearVoiceNoticeTimer();
    setVoiceNotice(message);
    if (autoClear) {
      voiceNoticeTimerRef.current = setTimeout(() => {
        setVoiceNotice(null);
        voiceNoticeTimerRef.current = null;
      }, 4000);
    }
  }

  function getSpeechRecognitionConstructor(): JavisSpeechRecognitionConstructor | null {
    if (typeof window === "undefined") return null;
    const candidate = window as Window & {
      SpeechRecognition?: JavisSpeechRecognitionConstructor;
      webkitSpeechRecognition?: JavisSpeechRecognitionConstructor;
    };
    return candidate.SpeechRecognition ?? candidate.webkitSpeechRecognition ?? null;
  }

  function startVoiceInput() {
    if (disabled || isStreaming || voiceRecognitionRef.current) {
      return;
    }
    const SpeechRecognition = getSpeechRecognitionConstructor();
    if (!SpeechRecognition) {
      setVoiceInputState("idle");
      showVoiceNotice(voiceUnsupportedLabel(labels), true);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = voiceLanguage(labels);
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      setVoiceInputState("recording");
      showVoiceNotice(voiceListeningLabel(labels));
    };
    recognition.onresult = (event) => {
      const transcript = collectVoiceTranscript(event.results);
      const base = removePreviousVoiceTranscript(draftGoalRef.current, voiceTranscriptInsertionRef.current);
      voiceTranscriptRef.current = transcript;
      const nextInsertion = createVoiceTranscriptInsertion(base, transcript);
      voiceTranscriptInsertionRef.current = nextInsertion;
      if (transcript.trim()) {
        const nextDraft = mergeVoiceTranscript(base, transcript);
        draftGoalRef.current = nextDraft;
        onDraftGoalChange(nextDraft);
      } else if (base !== draftGoalRef.current) {
        draftGoalRef.current = base;
        onDraftGoalChange(base);
      }
    };
    recognition.onerror = (event) => {
      if (manualVoiceStopRef.current && event.error === "aborted") {
        return;
      }
      setVoiceInputState("idle");
      showVoiceNotice(voiceErrorLabel(labels, event.error), true);
    };
    recognition.onend = () => {
      voiceRecognitionRef.current = null;
      setVoiceInputState("idle");
      const transcript = voiceTranscriptRef.current.trim();
      if (transcript) {
        showVoiceNotice(voiceReadyLabel(labels), true);
      } else if (manualVoiceStopRef.current) {
        showVoiceNotice(voiceEmptyLabel(labels), true);
      }
      manualVoiceStopRef.current = false;
      requestAnimationFrame(() => textAreaRef.current?.focus());
    };

    voiceTranscriptRef.current = "";
    voiceTranscriptInsertionRef.current = null;
    manualVoiceStopRef.current = false;

    try {
      recognition.start();
      voiceRecognitionRef.current = recognition;
      setVoiceInputState("recording");
      showVoiceNotice(voiceListeningLabel(labels));
    } catch (error) {
      setVoiceInputState("idle");
      showVoiceNotice(voiceStartFailedLabel(labels, error), true);
    }
  }

  function stopVoiceInput() {
    clearVoicePressTimer();
    const recognition = voiceRecognitionRef.current;
    if (!recognition) {
      setVoiceInputState("idle");
      return;
    }
    manualVoiceStopRef.current = true;
    setVoiceInputState("transcribing");
    showVoiceNotice(voiceTranscribingLabel(labels));
    try {
      recognition.stop();
    } catch {
      recognition.abort();
      voiceRecognitionRef.current = null;
      setVoiceInputState("idle");
    }
  }

  function handleSendPointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || disabled || isStreaming) {
      return;
    }
    clearVoicePressTimer();
    voicePressStartedRef.current = false;
    voicePressTimerRef.current = setTimeout(() => {
      voicePressTimerRef.current = null;
      voicePressStartedRef.current = true;
      startVoiceInput();
    }, VOICE_LONG_PRESS_DELAY_MS);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handleSendPointerUp() {
    clearVoicePressTimer();
    if (voicePressStartedRef.current) {
      suppressImmediateSendClick();
      stopVoiceInput();
    }
    voicePressStartedRef.current = false;
  }

  function handleSendPointerCancel() {
    clearVoicePressTimer();
    if (voicePressStartedRef.current || voiceRecognitionRef.current) {
      stopVoiceInput();
    }
    voicePressStartedRef.current = false;
  }

  function handleSendClick(event: MouseEvent<HTMLButtonElement>) {
    if (suppressSendClickRef.current) {
      event.preventDefault();
      clearSuppressSendClickTimer();
      suppressSendClickRef.current = false;
      return;
    }
    if (voiceInputState !== "idle") {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  const composerClassName = isStreaming ? `${className} streaming` : className;
  const resolvedPlaceholder = isStreaming
    ? queuedInputPlaceholder(labels)
    : taskInputPlaceholder ?? labels.taskInputPlaceholder;
  const resolvedStatusHint = voiceNotice ?? statusHint;
  const sendIconClassName =
    voiceInputState === "idle"
      ? isStreaming ? "icon-queue" : "icon-send"
      : "icon-mic";
  const sendButtonStateClassName =
    voiceInputState === "recording"
      ? " voice-recording"
      : voiceInputState === "transcribing"
        ? " voice-transcribing"
        : "";

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
      {resolvedStatusHint ? (
        <p className="javis-composer-status-hint">{resolvedStatusHint}</p>
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
        {permissionControls ? (
          <div className="javis-permission-controls">
            {permissionControls.canRequestApproval && !permissionControls.pendingRequest ? (
              <button
                className="javis-permission-button javis-permission-request"
                disabled={disabled}
                onClick={() => permissionControls.onRequestApproval?.()}
                type="button"
              >
                {labels.requestApproval}
              </button>
            ) : null}
            {permissionControls.pendingRequest ? (
              <>
                <button
                  className="javis-permission-button javis-permission-approve"
                  onClick={() => permissionControls.pendingRequest?.onApprove()}
                  type="button"
                >
                  {labels.approveOnce}
                </button>
                {permissionControls.pendingRequest.allowAlways ? (
                  <button
                    className="javis-permission-button javis-permission-allow-task"
                    onClick={() => permissionControls.pendingRequest?.onAllowTask()}
                    type="button"
                  >
                    {labels.allowTask}
                  </button>
                ) : null}
                <button
                  className="javis-permission-button javis-permission-deny"
                  onClick={() => permissionControls.pendingRequest?.onDeny()}
                  type="button"
                >
                  {labels.denyPermission}
                </button>
              </>
            ) : null}
            {permissionControls.showFullAccess ? (
              <button
                className="javis-permission-button javis-permission-full-access"
                disabled
                type="button"
                title={labels.fullAccess}
              >
                {labels.fullAccess}
              </button>
            ) : null}
          </div>
        ) : null}
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
        <button
          aria-label={voiceInputState === "idle" ? voiceSendButtonLabel(labels, isStreaming) : voiceStopLabel(labels)}
          className={`${sendButtonClassName} javis-composer-send-action icon-only${sendButtonStateClassName}`}
          disabled={disabled || voiceInputState === "transcribing"}
          onClick={handleSendClick}
          onPointerCancel={handleSendPointerCancel}
          onPointerDown={handleSendPointerDown}
          onPointerLeave={() => {
            if (!voicePressStartedRef.current) clearVoicePressTimer();
          }}
          onPointerUp={handleSendPointerUp}
          title={voiceInputState === "idle" ? voiceSendButtonLabel(labels, isStreaming) : voiceStopLabel(labels)}
          type="button"
        >
          <span
            className={`javis-composer-action-icon ${sendIconClassName}`}
            aria-hidden="true"
          />
          <span className="javis-visually-hidden">
            {isStreaming ? queuedSendLabel(labels) : labels.send}
          </span>
        </button>
        {isStreaming ? (
          <button
            className={`${sendButtonClassName} javis-composer-stop-action icon-only`}
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

function voiceSendButtonLabel(labels: ChatComposerProps["labels"], isStreaming: boolean): string {
  if (isStreaming) {
    return queuedSendLabel(labels);
  }
  return labels.newChat === "New chat"
    ? "Send. Long press to dictate"
    : "\u53d1\u9001\u3002\u957f\u6309\u8bed\u97f3\u8f93\u5165";
}

function voiceStopLabel(labels: ChatComposerProps["labels"]): string {
  return labels.newChat === "New chat" ? "Release to stop recording" : "\u677e\u5f00\u505c\u6b62\u5f55\u97f3";
}

function voiceListeningLabel(labels: ChatComposerProps["labels"]): string {
  return labels.newChat === "New chat" ? "Listening..." : "\u6b63\u5728\u8046\u542c...";
}

function voiceTranscribingLabel(labels: ChatComposerProps["labels"]): string {
  return labels.newChat === "New chat" ? "Transcribing..." : "\u6b63\u5728\u8bc6\u522b...";
}

function voiceReadyLabel(labels: ChatComposerProps["labels"]): string {
  return labels.newChat === "New chat"
    ? "Transcription added. Click send when ready."
    : "\u5df2\u8bc6\u522b\u5230\u8f93\u5165\u6846\uff0c\u786e\u8ba4\u540e\u70b9\u51fb\u53d1\u9001\u3002";
}

function voiceEmptyLabel(labels: ChatComposerProps["labels"]): string {
  return labels.newChat === "New chat"
    ? "No speech was recognized."
    : "\u6ca1\u6709\u8bc6\u522b\u5230\u8bed\u97f3\u3002";
}

function voiceUnsupportedLabel(labels: ChatComposerProps["labels"]): string {
  return labels.newChat === "New chat"
    ? "Voice input is not supported in this WebView."
    : "\u5f53\u524d WebView \u4e0d\u652f\u6301\u8bed\u97f3\u8f93\u5165\u3002";
}

function voiceErrorLabel(labels: ChatComposerProps["labels"], error: string): string {
  if (labels.newChat === "New chat") {
    return error === "not-allowed"
      ? "Microphone permission was denied."
      : `Voice input failed: ${error}`;
  }
  return error === "not-allowed"
    ? "\u9ea6\u514b\u98ce\u6743\u9650\u88ab\u62d2\u7edd\u3002"
    : `\u8bed\u97f3\u8f93\u5165\u5931\u8d25\uff1a${error}`;
}

function voiceStartFailedLabel(labels: ChatComposerProps["labels"], error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "unknown");
  return labels.newChat === "New chat"
    ? `Could not start voice input: ${message}`
    : `\u65e0\u6cd5\u542f\u52a8\u8bed\u97f3\u8f93\u5165\uff1a${message}`;
}

function voiceLanguage(labels: ChatComposerProps["labels"]): string {
  return labels.newChat === "New chat" ? "en-US" : "zh-CN";
}

function collectVoiceTranscript(results: JavisSpeechRecognitionResultList): string {
  const parts: string[] = [];
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index] ?? results.item(index);
    const alternative = result?.[0] ?? result?.item(0);
    if (alternative?.transcript) {
      parts.push(alternative.transcript);
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function mergeVoiceTranscript(base: string, transcript: string): string {
  const cleanTranscript = transcript.trim();
  if (!cleanTranscript) return base;
  const cleanBase = base.trimEnd();
  if (!cleanBase) return cleanTranscript;
  return `${cleanBase} ${cleanTranscript}`;
}

function createVoiceTranscriptInsertion(base: string, transcript: string): VoiceTranscriptInsertion | null {
  const text = transcript.trim();
  if (!text) return null;
  const cleanBase = base.trimEnd();
  const start = cleanBase ? cleanBase.length + 1 : 0;
  return { start, end: start + text.length, text };
}

function removePreviousVoiceTranscript(
  currentDraft: string,
  previousInsertion: VoiceTranscriptInsertion | null,
): string {
  if (!previousInsertion) return currentDraft;
  const { start, end, text } = previousInsertion;
  if (start < 0 || end > currentDraft.length || start >= end) return currentDraft;
  if (currentDraft.slice(start, end) !== text) return currentDraft;
  const before = currentDraft.slice(0, start).trimEnd();
  const after = currentDraft.slice(end).trimStart();
  if (!before) return after;
  if (!after) return before;
  return /^[,.;:!?)\]\u3001\u3002\uff0c\uff1a\uff1b\uff01\uff1f]/u.test(after)
    ? `${before}${after}`
    : `${before} ${after}`;
}

function adjustVoiceTranscriptInsertion(
  previousDraft: string,
  nextDraft: string,
  insertion: VoiceTranscriptInsertion | null,
): VoiceTranscriptInsertion | null {
  if (!insertion) return null;
  if (previousDraft.slice(insertion.start, insertion.end) !== insertion.text) return null;

  let prefixLength = 0;
  const maxPrefixLength = Math.min(previousDraft.length, nextDraft.length);
  while (
    prefixLength < maxPrefixLength &&
    previousDraft[prefixLength] === nextDraft[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  const maxSuffixLength = maxPrefixLength - prefixLength;
  while (
    suffixLength < maxSuffixLength &&
    previousDraft[previousDraft.length - 1 - suffixLength] ===
      nextDraft[nextDraft.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const previousChangeStart = prefixLength;
  const previousChangeEnd = previousDraft.length - suffixLength;
  const nextChangeStart = prefixLength;
  const nextChangeEnd = nextDraft.length - suffixLength;

  if (previousChangeEnd <= insertion.start) {
    const delta = (nextChangeEnd - nextChangeStart) - (previousChangeEnd - previousChangeStart);
    const shifted = {
      ...insertion,
      start: insertion.start + delta,
      end: insertion.end + delta,
    };
    return nextDraft.slice(shifted.start, shifted.end) === shifted.text ? shifted : null;
  }

  if (previousChangeStart >= insertion.end) {
    return nextDraft.slice(insertion.start, insertion.end) === insertion.text ? insertion : null;
  }

  return null;
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
