import { useEffect, useRef, useState, type FormEvent, type SyntheticEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type {
  BrowserQuickResult,
  BrowserQuickRequest,
  GitCommitExecutionQuickResult,
  GitCommitPlanQuickResult,
  GitCommentPullRequestExecutionQuickResult,
  GitCommentPullRequestPlanQuickResult,
  GitCreatePullRequestExecutionQuickResult,
  GitCreatePullRequestPlanQuickResult,
  GitPushExecutionQuickResult,
  GitPushPlanQuickResult,
  GitStageExecutionQuickResult,
  GitStagePlanQuickResult,
  ReviewQuickResult,
  TerminalQuickResult,
  WorkbenchAgentSessionContext,
  WorkbenchFileSearchResult,
  WorkbenchFileService,
  WorkbenchFileEntry,
  WorkbenchLocale,
  WorkbenchTerminalPlanResult,
  WorkbenchTerminalService,
  WorkbenchWorkspaceToolAction,
  WorkbenchDetailItem,
  WorkbenchBrowserWriteApprovalPreview,
} from "../types";
import { createFileDetailItem, createPathDetailItem } from "../detail-items";
import { isChineseLocale } from "../utils";
import { ChatComposer } from "./ChatComposer";

interface WorkspaceToolPanelsProps {
  tool: WorkbenchWorkspaceToolAction;
  session: WorkbenchAgentSessionContext;
  locale: WorkbenchLocale;
  labels: WorkbenchLocale["labels"];
  onClose?: () => void;
  onQuickActionBrowser?: (session: WorkbenchAgentSessionContext, request: string | BrowserQuickRequest) => Promise<BrowserQuickResult>;
  pendingBrowserWriteApproval?: WorkbenchBrowserWriteApprovalPreview | null;
  onApproveBrowserWrite?: (session: WorkbenchAgentSessionContext, approvalId: string) => Promise<void>;
  onDenyBrowserWrite?: (session: WorkbenchAgentSessionContext, approvalId: string) => Promise<void>;
  onQuickActionReview?: (session: WorkbenchAgentSessionContext) => Promise<ReviewQuickResult>;
  onQuickActionGitPushPlan?: (session: WorkbenchAgentSessionContext) => Promise<GitPushPlanQuickResult>;
  onQuickActionGitPushExecute?: (session: WorkbenchAgentSessionContext, approvalId: string) => Promise<GitPushExecutionQuickResult>;
  onQuickActionGitPushCancel?: (session: WorkbenchAgentSessionContext, approvalId: string) => Promise<void>;
  onQuickActionGitStagePlan?: (session: WorkbenchAgentSessionContext, paths: string[]) => Promise<GitStagePlanQuickResult>;
  onQuickActionGitStageExecute?: (session: WorkbenchAgentSessionContext, approvalId: string, paths: string[]) => Promise<GitStageExecutionQuickResult>;
  onQuickActionGitStageCancel?: (session: WorkbenchAgentSessionContext, approvalId: string) => Promise<void>;
  onQuickActionGitCommitPlan?: (session: WorkbenchAgentSessionContext, message: string) => Promise<GitCommitPlanQuickResult>;
  onQuickActionGitCommitExecute?: (session: WorkbenchAgentSessionContext, approvalId: string, message: string) => Promise<GitCommitExecutionQuickResult>;
  onQuickActionGitCommitCancel?: (session: WorkbenchAgentSessionContext, approvalId: string) => Promise<void>;
  onQuickActionGitCreatePullRequestPlan?: (
    session: WorkbenchAgentSessionContext,
    request: { title: string; body?: string; baseBranch: string; draft?: boolean },
  ) => Promise<GitCreatePullRequestPlanQuickResult>;
  onQuickActionGitCreatePullRequestExecute?: (
    session: WorkbenchAgentSessionContext,
    approvalId: string,
    request: { title: string; body?: string; baseBranch: string; draft?: boolean },
  ) => Promise<GitCreatePullRequestExecutionQuickResult>;
  onQuickActionGitCreatePullRequestCancel?: (session: WorkbenchAgentSessionContext, approvalId: string) => Promise<void>;
  onQuickActionGitCommentPullRequestPlan?: (
    session: WorkbenchAgentSessionContext,
    request: { pullRequest: string; body: string },
  ) => Promise<GitCommentPullRequestPlanQuickResult>;
  onQuickActionGitCommentPullRequestExecute?: (
    session: WorkbenchAgentSessionContext,
    approvalId: string,
    request: { pullRequest: string; body: string },
  ) => Promise<GitCommentPullRequestExecutionQuickResult>;
  onQuickActionGitCommentPullRequestCancel?: (session: WorkbenchAgentSessionContext, approvalId: string) => Promise<void>;
  onQuickActionTerminal?: (session: WorkbenchAgentSessionContext, command: string) => Promise<TerminalQuickResult>;
  terminalService?: WorkbenchTerminalService;
  fileService?: WorkbenchFileService;
  computerEntries?: WorkbenchFileEntry[];
  computerPath?: string;
  onNavigateDirectory?: (path: string) => void;
  onOpenFile?: (path: string) => void;
  onOpenDetail?: (detail: WorkbenchDetailItem) => void;
  onSideChatSend?: (session: WorkbenchAgentSessionContext, message: string) => Promise<string>;
}

export function WorkspaceToolPanels(props: WorkspaceToolPanelsProps) {
  const requiresWorkspace = props.tool === "files" || props.tool === "review" || props.tool === "terminal";
  if (requiresWorkspace && !props.session.workspaceRoot) {
    const isChinese = isChineseLocale(props.locale);
    return (
      <div className="javis-tool-panel">
        <div className="javis-tool-empty">
          <span className="javis-tool-empty-icon file" aria-hidden="true" />
          <p>{isChinese ? "\u8bf7\u9009\u62e9\u9879\u76ee\u5de5\u4f5c\u533a" : "Select a project workspace"}</p>
          <span>{isChinese ? "\u6587\u4ef6\u3001\u5ba1\u67e5\u548c\u7ec8\u7aef\u9700\u8981\u7ed1\u5b9a\u5f53\u524d\u9879\u76ee\u3002" : "Files, review, and terminal need a workspace."}</span>
        </div>
      </div>
    );
  }

  switch (props.tool) {
    case "files": return <FilesPanel {...props} />;
    case "sideChat": return <SideChatPanel {...props} />;
    case "browser": return <BrowserPanel {...props} />;
    case "review": return <ReviewPanel {...props} />;
    case "terminal": return <TerminalPanel {...props} />;
    default: return null;
  }
}

function FilesPanel({
  locale,
  session,
  fileService,
  computerEntries = [],
  computerPath = "",
  onNavigateDirectory,
  onOpenFile,
  onOpenDetail,
}: WorkspaceToolPanelsProps) {
  const isChinese = isChineseLocale(locale);
  const [filter, setFilter] = useState("");
  const [searchResults, setSearchResults] = useState<WorkbenchFileSearchResult[]>([]);
  const [serviceEntries, setServiceEntries] = useState<WorkbenchFileEntry[] | null>(null);
  const [servicePath, setServicePath] = useState(computerPath || session.workspaceRoot);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const effectiveEntries = serviceEntries ?? computerEntries;
  const effectivePath = servicePath || computerPath || session.workspaceRoot;
  const dirs = effectiveEntries.filter((entry) => entry.isDir);
  const files = effectiveEntries.filter((entry) => !entry.isDir);
  const filtered = filter
    ? [...dirs, ...files].filter((entry) => entry.name.toLowerCase().includes(filter.toLowerCase()))
    : null;

  useEffect(() => {
    if (!fileService?.watchStart || !fileService.watchStop || !session.workspaceRoot) {
      return;
    }
    let active = true;
    fileService.watchStart(session).catch((err) => {
      if (active) {
        setSearchError(err instanceof Error ? err.message : String(err));
      }
    });
    return () => {
      active = false;
      void fileService.watchStop?.(session);
    };
  }, [fileService, session.sessionId, session.workspaceRoot]);

  useEffect(() => {
    if (!fileService || !session.workspaceRoot) {
      return;
    }
    let active = true;
    const load = (path = servicePath || session.workspaceRoot) => {
      fileService
        .list(session, path)
        .then((entries) => {
          if (active) {
            setServiceEntries(entries);
            setServicePath(path);
          }
        })
        .catch((err) => {
          if (active) {
            setSearchError(err instanceof Error ? err.message : String(err));
          }
        });
    };
    load();
    const unsubscribe = fileService.subscribeChanged?.(session, () => load(servicePath || session.workspaceRoot));
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [fileService, session.sessionId, session.workspaceRoot, servicePath]);

  function handleNavigate(path: string) {
    if (fileService) {
      setServicePath(path);
      setServiceEntries(null);
      fileService
        .list(session, path)
        .then((entries) => setServiceEntries(entries))
        .catch((err) => setSearchError(err instanceof Error ? err.message : String(err)));
      return;
    }
    onNavigateDirectory?.(path);
  }

  async function handleSearch(event: FormEvent) {
    event.preventDefault();
    const query = filter.trim();
    if (!fileService || !query) return;
    setSearching(true);
    setSearchError(null);
    try {
      setSearchResults(await fileService.search(session, query));
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  }

  function selectEntry(entry: WorkbenchFileEntry) {
    setSelectedPath(entry.path);
    onOpenDetail?.(createFileDetailItem(entry, {
      kindLabel: entry.isDir
        ? ("Folder")
        : ("Workspace file"),
      locale,
    }));
  }

  function selectSearchResult(result: WorkbenchFileSearchResult) {
    setSelectedPath(result.path);
    onOpenDetail?.(createPathDetailItem(result.path, {
      kindLabel: "Search result",
      line: result.line,
      locale,
      preview: result.preview,
    }));
  }

  return (
    <div className="javis-tool-panel">
      <div className="javis-tool-panel-header">
        <button className="javis-tool-header-btn has-icon icon-folder" type="button">
          <span aria-hidden="true" />
          {isChinese ? "\u6253\u5f00\u6587\u4ef6" : "Open File"}
        </button>
        <button
          aria-label={isChinese ? "\u65b0\u5efa\u6587\u4ef6" : "New file"}
          className="javis-tool-icon-btn icon-add"
          title={isChinese ? "\u65b0\u5efa\u6587\u4ef6" : "New file"}
          type="button"
        >
          <span aria-hidden="true" />
        </button>
      </div>
      <form onSubmit={handleSearch}>
        <input
          className="javis-tool-filter-input"
          onChange={(event) => setFilter(event.currentTarget.value)}
          placeholder={fileService ? (isChinese ? "\u7b5b\u9009\u6216 rg \u641c\u7d22..." : "Filter or rg search...") : (isChinese ? "\u7b5b\u9009\u6587\u4ef6..." : "Filter files...")}
          value={filter}
        />
      </form>
      <div className="javis-tool-files-path" title={computerPath}>
        {effectivePath || (isChinese ? "\u6b64\u7535\u8111" : "This PC")}
      </div>
      {searchError ? <p className="javis-tool-error">{searchError}</p> : null}
      {searching ? <p>{isChinese ? "\u641c\u7d22\u4e2d..." : "Searching..."}</p> : null}
      {searchResults.length > 0 ? (
        <ul className="javis-tool-files-list">
          {searchResults.map((result) => (
            <li key={`${result.path}:${result.line ?? 0}`}>
              <button
                className={`javis-tool-file-entry file${selectedPath === result.path ? " selected" : ""}`}
                onClick={() => selectSearchResult(result)}
                onDoubleClick={() => onOpenFile?.(result.path)}
                type="button"
              >
                <span className="javis-tool-file-marker">{result.line ?? "rg"}</span> {result.path}
              </button>
              {result.preview ? <p className="javis-tool-search-preview">{result.preview}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {effectiveEntries.length === 0 ? (
        <div className="javis-tool-empty">
          <span className="javis-tool-empty-icon file" aria-hidden="true" />
          <p>{isChinese ? "\u6253\u5f00\u6587\u4ef6" : "Open file"}</p>
          <span>{isChinese ? "\u4ece\u5de5\u4f5c\u533a\u76ee\u5f55\u6811\u4e2d\u9009\u62e9\u6587\u4ef6" : "Select a file from the workspace tree"}</span>
        </div>
      ) : (
        <ul className="javis-tool-files-list">
          {(onNavigateDirectory || fileService) && effectivePath ? (
            <li>
              <button
                className="javis-tool-file-entry dir parent"
                onClick={() => handleNavigate(getParentPath(effectivePath))}
                type="button"
              >
                ..
              </button>
            </li>
          ) : null}
          {(filtered ?? dirs).map((entry) => (
            <li key={entry.path}>
              <button className="javis-tool-file-entry dir" onClick={() => handleNavigate(entry.path)} type="button">
                <span className="javis-tool-file-marker">{">"}</span> {entry.name}
              </button>
            </li>
          ))}
          {(filtered ?? files).slice(0, 60).map((entry) => {
            const marker = entry.name.endsWith(".md") ? "M" : entry.name.endsWith(".json") ? "{}" : entry.name.startsWith(".") ? "*" : "";
            return (
              <li key={entry.path}>
                <button
                  className={`javis-tool-file-entry file${selectedPath === entry.path ? " selected" : ""}`}
                  onClick={() => selectEntry(entry)}
                  onDoubleClick={() => onOpenFile?.(entry.path)}
                  type="button"
                >
                  {marker ? <span className="javis-tool-file-marker">{marker}</span> : null} {entry.name}
                </button>
              </li>
            );
          })}
          {!filtered && files.length > 60 ? (
            <li className="javis-tool-file-entry more">
              {isChinese ? `...\u8fd8\u6709 ${files.length - 60} \u4e2a\u6587\u4ef6` : `...${files.length - 60} more files`}
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}

function SideChatPanel({ labels, session, onSideChatSend }: WorkspaceToolPanelsProps) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<Array<{ role: "user" | "assistant"; text: string }>>([]);

  async function handleSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = input.trim();
    if (!onSideChatSend || !message) return;

    setInput("");
    setMessages((previous) => [...previous, { role: "user", text: message }]);
    setLoading(true);
    try {
      const reply = await onSideChatSend(session, message);
      setMessages((previous) => [...previous, { role: "assistant", text: reply }]);
    } catch {
      setMessages((previous) => [...previous, { role: "assistant", text: "Send failed" }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="javis-tool-panel sidechat-panel">
      <div className="javis-tool-panel-header sidechat-header">
        <strong>{"Start Chat"}</strong>
        <button
          aria-label={"New chat"}
          className="javis-tool-icon-btn icon-add"
          onClick={() => setMessages([])}
          title={"New chat"}
          type="button"
        >
          <span aria-hidden="true" />
        </button>
      </div>
      <div className="javis-tool-sidechat-messages">
        {messages.length === 0 ? (
          <div className="javis-tool-empty">
            <span className="javis-tool-empty-icon chat" aria-hidden="true" />
            <p>{"Start a side conversation"}</p>
          </div>
        ) : (
          messages.map((message, index) => (
            <div className={`javis-tool-sidechat-msg ${message.role}`} key={index}>
              <span className="javis-tool-sidechat-role">{message.role === "user" ? ("You") : "Javis"}</span>
              <p>{message.text}</p>
            </div>
          ))
        )}
        {loading ? <p className="javis-tool-sidechat-msg assistant">{"Thinking..."}</p> : null}
      </div>
      <ChatComposer
        actionsClassName="javis-composer-actions javis-tool-sidechat-actions"
        className="javis-composer javis-tool-sidechat-composer"
        currentWorkspacePath={session.workspaceRoot}
        disabled={loading || !onSideChatSend}
        draftGoal={input}
        labels={labels}
        onDraftGoalChange={setInput}
        onSubmit={handleSend}
        recentWorkspacePaths={[]}
        showWorkspaceContext={false}
        taskInputPlaceholder={"Request follow-up changes"}
      />
    </div>
  );
}

function BrowserPanel({
  locale,
  session,
  onQuickActionBrowser,
  pendingBrowserWriteApproval,
  onApproveBrowserWrite,
  onDenyBrowserWrite,
}: WorkspaceToolPanelsProps) {
  const isChinese = isChineseLocale(locale);
  const [url, setUrl] = useState("");
  const [loadingAction, setLoadingAction] = useState<BrowserQuickRequest["action"] | null>(null);
  const [result, setResult] = useState<BrowserQuickResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [browserApprovalLoading, setBrowserApprovalLoading] = useState<"approve" | "deny" | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [iframeState, setIframeState] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [iframeError, setIframeError] = useState<string | null>(null);
  const displayUrl = result?.url || normalizeUrlInput(url);
  const loading = loadingAction !== null;

  useEffect(() => {
    if (!onQuickActionBrowser) return;
    let active = true;
    setLoadingAction("status");
    onQuickActionBrowser(session, { action: "status" })
      .then((nextResult) => {
        if (!active) return;
        if (nextResult.sidecarRunning && nextResult.url) {
          setResult(nextResult);
          setUrl(nextResult.url);
        }
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (active) {
          setLoadingAction(null);
        }
      });
    return () => {
      active = false;
    };
  }, [onQuickActionBrowser, session.sessionId]);

  useEffect(() => {
    setPreviewOpen(false);
    setIframeState("idle");
    setIframeError(null);
  }, [result?.url]);

  async function runBrowserAction(action: BrowserQuickRequest["action"], nextUrl?: string) {
    if (!onQuickActionBrowser) return;

    setLoadingAction(action);
    setError(null);
    try {
      const nextResult = await onQuickActionBrowser(session, { action, url: nextUrl });
      setResult(nextResult);
      if (nextResult.url) {
        setUrl(nextResult.url);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingAction(null);
    }
  }

  async function handleNavigate(event: FormEvent) {
    event.preventDefault();
    const nextUrl = normalizeUrlInput(url);
    if (!nextUrl) return;
    await runBrowserAction("navigate", nextUrl);
  }

  async function handleBrowserWriteDecision(decision: "approve" | "deny") {
    if (!pendingBrowserWriteApproval) return;
    const handler = decision === "approve" ? onApproveBrowserWrite : onDenyBrowserWrite;
    if (!handler) return;
    setBrowserApprovalLoading(decision);
    setError(null);
    try {
      await handler(session, pendingBrowserWriteApproval.approvalId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBrowserApprovalLoading(null);
    }
  }

  function handleRefresh() {
    const nextUrl = result?.url || normalizeUrlInput(url);
    if (!nextUrl) return;
    void runBrowserAction(result?.url ? "refresh" : "navigate", nextUrl);
  }

  function handlePreviewToggle(event: SyntheticEvent<HTMLDetailsElement>) {
    const open = event.currentTarget.open;
    setPreviewOpen(open);
    if (open && displayUrl) {
      setIframeState("loading");
      setIframeError(null);
    }
  }

  const statusText = loadingAction === "status"
    ? ("Syncing")
    : loadingAction
      ? ("Loading")
      : result?.loadState || (result?.sidecarRunning ? "ready" : "idle");
  const iframeStatusText = iframeState === "loading"
    ? ("iframe loading")
    : iframeState === "loaded"
      ? ("iframe loaded")
      : iframeState === "error"
        ? ("iframe failed")
        : ("loads on demand");

  return (
    <div className="javis-tool-panel browser-panel">
      <form className="javis-tool-browser-nav" onSubmit={handleNavigate}>
        <button aria-label={isChinese ? "\u540e\u9000" : "Back"} className="icon-back" disabled={loading || !result?.canGoBack || !onQuickActionBrowser} onClick={() => void runBrowserAction("back")} title={isChinese ? "\u540e\u9000" : "Back"} type="button"><span aria-hidden="true" /></button>
        <button aria-label={isChinese ? "\u524d\u8fdb" : "Forward"} className="icon-forward" disabled={loading || !result?.canGoForward || !onQuickActionBrowser} onClick={() => void runBrowserAction("forward")} title={isChinese ? "\u524d\u8fdb" : "Forward"} type="button"><span aria-hidden="true" /></button>
        <button aria-label={isChinese ? "\u5237\u65b0" : "Refresh"} className="icon-refresh" disabled={loading || !displayUrl || !onQuickActionBrowser} onClick={handleRefresh} title={isChinese ? "\u5237\u65b0" : "Refresh"} type="button"><span aria-hidden="true" /></button>
        <input
          className="javis-tool-url-input"
          onChange={(event) => setUrl(event.currentTarget.value)}
          placeholder={isChinese ? "\u8f93\u5165 URL" : "Enter URL"}
          value={url}
        />
        <button aria-label={isChinese ? "\u6253\u5f00" : "Open"} className="icon-open" disabled={loading || !onQuickActionBrowser || !normalizeUrlInput(url)} type="submit">
          <span aria-hidden="true" />
        </button>
      </form>
      {error ? <p className="javis-tool-error">{error}</p> : null}
      {pendingBrowserWriteApproval ? (
        <div className="javis-terminal-approval-card javis-browser-approval-card">
          <strong>{isChinese ? "\u5ba1\u6279\u6d4f\u89c8\u5668\u5199\u64cd\u4f5c" : "Approve browser write"}</strong>
          <span>{browserWriteApprovalSummary(pendingBrowserWriteApproval, isChinese)}</span>
          <span>{isChinese ? "\u4f1a\u8bdd" : "Session"} {pendingBrowserWriteApproval.sessionId}</span>
          <span>hash {pendingBrowserWriteApproval.previewHash}</span>
          <button
            disabled={browserApprovalLoading !== null || !onApproveBrowserWrite}
            onClick={() => void handleBrowserWriteDecision("approve")}
            type="button"
          >
            {browserApprovalLoading === "approve" ? (isChinese ? "\u6267\u884c\u4e2d..." : "Executing...") : (isChinese ? "\u5ba1\u6279\u5e76\u6267\u884c" : "Approve and execute")}
          </button>
          <button
            disabled={browserApprovalLoading !== null || !onDenyBrowserWrite}
            onClick={() => void handleBrowserWriteDecision("deny")}
            type="button"
          >
            {browserApprovalLoading === "deny" ? (isChinese ? "\u62d2\u7edd\u4e2d..." : "Denying...") : (isChinese ? "\u62d2\u7edd" : "Deny")}
          </button>
        </div>
      ) : null}
      {loading && !result ? <p className="javis-tool-browser-inline-status">{statusText}</p> : null}
      {result ? (
        <div className="javis-tool-browser-surface">
          <div className="javis-tool-browser-status">
            <span>{result.title || displayUrl}</span>
            <span>{statusText}</span>
          </div>
          {result.screenshotDataUrl ? (
            <img alt={result.title ?? "Preview"} className="javis-tool-browser-shot" src={result.screenshotDataUrl} />
          ) : null}
          {result.content ? (
            <pre className="javis-tool-browser-content">{result.content.slice(0, 2000)}</pre>
          ) : null}
          <details className="javis-tool-browser-fallback" onToggle={handlePreviewToggle} open={previewOpen}>
            <summary>
              <span>{isChinese ? "\u8f85\u52a9 iframe \u9884\u89c8" : "Auxiliary iframe preview"}</span>
              <span>{iframeStatusText}</span>
            </summary>
            <p className="javis-tool-browser-preview-note">
              {isChinese ? "\u6d4f\u89c8\u5668\u4f1a\u8bdd\u7531 sidecar \u63a5\u7ba1\u3002\u8fd9\u91cc\u7684 iframe \u53ea\u4f5c\u89c6\u89c9\u9884\u89c8\uff0c\u53ef\u80fd\u4f1a\u88ab\u9875\u9762\u963b\u6b62\u3002" : "The sidecar owns the browser session. This iframe is only a visual preview and may be blocked by the page."}
            </p>
            {iframeError ? <p className="javis-tool-error">{iframeError}</p> : null}
            {previewOpen && displayUrl ? (
              <iframe
                className="javis-tool-browser-frame"
                onError={() => {
                  setIframeState("error");
                  setIframeError("The iframe could not load this page.");
                }}
                onLoad={() => setIframeState("loaded")}
                sandbox="allow-forms allow-popups allow-scripts"
                src={displayUrl}
                title={result.title ?? displayUrl}
              />
            ) : null}
          </details>
        </div>
      ) : !loading && !error ? (
        <div className="javis-tool-empty">
          <span className="javis-tool-empty-icon browser" aria-hidden="true" />
          <p>{isChinese ? "\u8f93\u5165 URL \u5e76\u5bfc\u822a" : "Enter URL and navigate"}</p>
        </div>
      ) : null}
    </div>
  );
}

function ReviewPanel({
  session,
  onQuickActionReview,
  onQuickActionGitPushPlan,
  onQuickActionGitPushExecute,
  onQuickActionGitPushCancel,
  onQuickActionGitStagePlan,
  onQuickActionGitStageExecute,
  onQuickActionGitStageCancel,
  onQuickActionGitCommitPlan,
  onQuickActionGitCommitExecute,
  onQuickActionGitCommitCancel,
  onQuickActionGitCreatePullRequestPlan,
  onQuickActionGitCreatePullRequestExecute,
  onQuickActionGitCreatePullRequestCancel,
  onQuickActionGitCommentPullRequestPlan,
  onQuickActionGitCommentPullRequestExecute,
  onQuickActionGitCommentPullRequestCancel,
}: WorkspaceToolPanelsProps) {
  const [statusFilter, setStatusFilter] = useState("unstaged");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ReviewQuickResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [pushPlan, setPushPlan] = useState<GitPushPlanQuickResult | null>(null);
  const [pushResult, setPushResult] = useState<GitPushExecutionQuickResult | null>(null);
  const [pushLoading, setPushLoading] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [selectedStageFiles, setSelectedStageFiles] = useState<Set<string>>(() => new Set());
  const [stagePlan, setStagePlan] = useState<GitStagePlanQuickResult | null>(null);
  const [stageResult, setStageResult] = useState<GitStageExecutionQuickResult | null>(null);
  const [stageLoading, setStageLoading] = useState(false);
  const [stageError, setStageError] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [commitPlan, setCommitPlan] = useState<GitCommitPlanQuickResult | null>(null);
  const [commitResult, setCommitResult] = useState<GitCommitExecutionQuickResult | null>(null);
  const [commitLoading, setCommitLoading] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [pullRequestTitle, setPullRequestTitle] = useState("");
  const [pullRequestBody, setPullRequestBody] = useState("");
  const [pullRequestBaseBranch, setPullRequestBaseBranch] = useState("main");
  const [pullRequestDraft, setPullRequestDraft] = useState(true);
  const [pullRequestPlan, setPullRequestPlan] = useState<GitCreatePullRequestPlanQuickResult | null>(null);
  const [pullRequestResult, setPullRequestResult] = useState<GitCreatePullRequestExecutionQuickResult | null>(null);
  const [pullRequestLoading, setPullRequestLoading] = useState(false);
  const [pullRequestError, setPullRequestError] = useState<string | null>(null);
  const [pullRequestCommentTarget, setPullRequestCommentTarget] = useState("");
  const [pullRequestCommentBody, setPullRequestCommentBody] = useState("");
  const [pullRequestCommentPlan, setPullRequestCommentPlan] = useState<GitCommentPullRequestPlanQuickResult | null>(null);
  const [pullRequestCommentResult, setPullRequestCommentResult] = useState<GitCommentPullRequestExecutionQuickResult | null>(null);
  const [pullRequestCommentLoading, setPullRequestCommentLoading] = useState(false);
  const [pullRequestCommentError, setPullRequestCommentError] = useState<string | null>(null);

  async function handleRefresh() {
    if (!onQuickActionReview) return;
    setLoading(true);
    setError(null);
    setPushError(null);
    setPushPlan(null);
    setStageError(null);
    setStagePlan(null);
    setCommitError(null);
    setCommitPlan(null);
    setPullRequestError(null);
    setPullRequestPlan(null);
    setPullRequestCommentError(null);
    setPullRequestCommentPlan(null);
    try {
      setResult(await onQuickActionReview(session));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setSelectedStageFiles(new Set(result?.changedFiles ?? []));
  }, [result?.changedFiles]);

  useEffect(() => {
    if (pullRequestCommentTarget.trim()) return;
    const firstPullRequest = result?.pullRequests?.pullRequests[0];
    if (firstPullRequest) {
      setPullRequestCommentTarget(String(firstPullRequest.number));
    }
  }, [pullRequestCommentTarget, result?.pullRequests?.pullRequests]);

  async function handlePreparePush() {
    if (!onQuickActionGitPushPlan) return;
    setPushLoading(true);
    setPushError(null);
    setPushResult(null);
    try {
      const plan = await onQuickActionGitPushPlan(session);
      setPushPlan(plan);
      setResult((current) => current ? { ...current, pushPreview: plan.preview } : current);
    } catch (err) {
      setPushError(err instanceof Error ? err.message : String(err));
    } finally {
      setPushLoading(false);
    }
  }

  async function handleExecutePush() {
    if (!pushPlan || !onQuickActionGitPushExecute) return;
    setPushLoading(true);
    setPushError(null);
    try {
      const execution = await onQuickActionGitPushExecute(session, pushPlan.approvalId);
      setPushResult(execution);
      setPushPlan(null);
      if (onQuickActionReview) {
        setResult(await onQuickActionReview(session));
      }
    } catch (err) {
      setPushError(err instanceof Error ? err.message : String(err));
    } finally {
      setPushLoading(false);
    }
  }

  async function handleCancelPush() {
    if (!pushPlan) return;
    const approvalId = pushPlan.approvalId;
    setPushLoading(true);
    setPushError(null);
    try {
      await onQuickActionGitPushCancel?.(session, approvalId);
      setPushPlan(null);
    } catch (err) {
      setPushError(err instanceof Error ? err.message : String(err));
    } finally {
      setPushLoading(false);
    }
  }

  function handleToggleStageFile(file: string) {
    setSelectedStageFiles((current) => {
      const next = new Set(current);
      if (next.has(file)) {
        next.delete(file);
      } else {
        next.add(file);
      }
      return next;
    });
  }

  async function handlePrepareStage() {
    if (!onQuickActionGitStagePlan) return;
    const paths = [...selectedStageFiles];
    setStageLoading(true);
    setStageError(null);
    setStageResult(null);
    try {
      const plan = await onQuickActionGitStagePlan(session, paths);
      setStagePlan(plan);
    } catch (err) {
      setStageError(err instanceof Error ? err.message : String(err));
    } finally {
      setStageLoading(false);
    }
  }

  async function handleExecuteStage() {
    if (!stagePlan || !onQuickActionGitStageExecute) return;
    const paths = stagePlan.preview.files.map((file) => file.path);
    setStageLoading(true);
    setStageError(null);
    try {
      const execution = await onQuickActionGitStageExecute(session, stagePlan.approvalId, paths);
      setStageResult(execution);
      setStagePlan(null);
      if (onQuickActionReview) {
        setResult(await onQuickActionReview(session));
      }
    } catch (err) {
      setStageError(err instanceof Error ? err.message : String(err));
    } finally {
      setStageLoading(false);
    }
  }

  async function handleCancelStage() {
    if (!stagePlan) return;
    const approvalId = stagePlan.approvalId;
    setStageLoading(true);
    setStageError(null);
    try {
      await onQuickActionGitStageCancel?.(session, approvalId);
      setStagePlan(null);
    } catch (err) {
      setStageError(err instanceof Error ? err.message : String(err));
    } finally {
      setStageLoading(false);
    }
  }

  async function handlePrepareCommit() {
    if (!onQuickActionGitCommitPlan) return;
    setCommitLoading(true);
    setCommitError(null);
    setCommitResult(null);
    try {
      const plan = await onQuickActionGitCommitPlan(session, commitMessage);
      setCommitPlan(plan);
    } catch (err) {
      setCommitError(err instanceof Error ? err.message : String(err));
    } finally {
      setCommitLoading(false);
    }
  }

  async function handleExecuteCommit() {
    if (!commitPlan || !onQuickActionGitCommitExecute) return;
    setCommitLoading(true);
    setCommitError(null);
    try {
      const execution = await onQuickActionGitCommitExecute(
        session,
        commitPlan.approvalId,
        commitPlan.preview.message,
      );
      setCommitResult(execution);
      setCommitPlan(null);
      setCommitMessage("");
      if (onQuickActionReview) {
        setResult(await onQuickActionReview(session));
      }
    } catch (err) {
      setCommitError(err instanceof Error ? err.message : String(err));
    } finally {
      setCommitLoading(false);
    }
  }

  async function handleCancelCommit() {
    if (!commitPlan) return;
    const approvalId = commitPlan.approvalId;
    setCommitLoading(true);
    setCommitError(null);
    try {
      await onQuickActionGitCommitCancel?.(session, approvalId);
      setCommitPlan(null);
    } catch (err) {
      setCommitError(err instanceof Error ? err.message : String(err));
    } finally {
      setCommitLoading(false);
    }
  }

  async function handlePreparePullRequest() {
    if (!onQuickActionGitCreatePullRequestPlan) return;
    const request = {
      title: pullRequestTitle.trim(),
      body: pullRequestBody.trim(),
      baseBranch: pullRequestBaseBranch.trim(),
      draft: pullRequestDraft,
    };
    setPullRequestLoading(true);
    setPullRequestError(null);
    setPullRequestResult(null);
    try {
      const plan = await onQuickActionGitCreatePullRequestPlan(session, request);
      setPullRequestPlan(plan);
    } catch (err) {
      setPullRequestError(err instanceof Error ? err.message : String(err));
    } finally {
      setPullRequestLoading(false);
    }
  }

  async function handleExecutePullRequest() {
    if (!pullRequestPlan || !onQuickActionGitCreatePullRequestExecute) return;
    const request = {
      title: pullRequestPlan.preview.title,
      body: pullRequestPlan.preview.body,
      baseBranch: pullRequestPlan.preview.baseBranch,
      draft: pullRequestPlan.preview.draft,
    };
    setPullRequestLoading(true);
    setPullRequestError(null);
    try {
      const execution = await onQuickActionGitCreatePullRequestExecute(
        session,
        pullRequestPlan.approvalId,
        request,
      );
      setPullRequestResult(execution);
      setPullRequestPlan(null);
      if (onQuickActionReview) {
        setResult(await onQuickActionReview(session));
      }
    } catch (err) {
      setPullRequestError(err instanceof Error ? err.message : String(err));
    } finally {
      setPullRequestLoading(false);
    }
  }

  async function handleCancelPullRequest() {
    if (!pullRequestPlan) return;
    const approvalId = pullRequestPlan.approvalId;
    setPullRequestLoading(true);
    setPullRequestError(null);
    try {
      await onQuickActionGitCreatePullRequestCancel?.(session, approvalId);
      setPullRequestPlan(null);
    } catch (err) {
      setPullRequestError(err instanceof Error ? err.message : String(err));
    } finally {
      setPullRequestLoading(false);
    }
  }

  async function handlePreparePullRequestComment() {
    if (!onQuickActionGitCommentPullRequestPlan) return;
    const request = {
      pullRequest: pullRequestCommentTarget.trim(),
      body: pullRequestCommentBody.trim(),
    };
    setPullRequestCommentLoading(true);
    setPullRequestCommentError(null);
    setPullRequestCommentResult(null);
    try {
      const plan = await onQuickActionGitCommentPullRequestPlan(session, request);
      setPullRequestCommentPlan(plan);
    } catch (err) {
      setPullRequestCommentError(err instanceof Error ? err.message : String(err));
    } finally {
      setPullRequestCommentLoading(false);
    }
  }

  async function handleExecutePullRequestComment() {
    if (!pullRequestCommentPlan || !onQuickActionGitCommentPullRequestExecute) return;
    const request = {
      pullRequest: pullRequestCommentPlan.preview.pullRequest,
      body: pullRequestCommentPlan.preview.body,
    };
    setPullRequestCommentLoading(true);
    setPullRequestCommentError(null);
    try {
      const execution = await onQuickActionGitCommentPullRequestExecute(
        session,
        pullRequestCommentPlan.approvalId,
        request,
      );
      setPullRequestCommentResult(execution);
      setPullRequestCommentPlan(null);
      setPullRequestCommentBody("");
      if (onQuickActionReview) {
        setResult(await onQuickActionReview(session));
      }
    } catch (err) {
      setPullRequestCommentError(err instanceof Error ? err.message : String(err));
    } finally {
      setPullRequestCommentLoading(false);
    }
  }

  async function handleCancelPullRequestComment() {
    if (!pullRequestCommentPlan) return;
    const approvalId = pullRequestCommentPlan.approvalId;
    setPullRequestCommentLoading(true);
    setPullRequestCommentError(null);
    try {
      await onQuickActionGitCommentPullRequestCancel?.(session, approvalId);
      setPullRequestCommentPlan(null);
    } catch (err) {
      setPullRequestCommentError(err instanceof Error ? err.message : String(err));
    } finally {
      setPullRequestCommentLoading(false);
    }
  }

  const filteredFiles = filter
    ? (result?.changedFiles ?? []).filter((file) => file.toLowerCase().includes(filter.toLowerCase()))
    : (result?.changedFiles ?? []);
  const primaryRemote = result?.remotes?.find((remote) => remote.name === result.upstreamRemote) ?? result?.remotes?.[0];
  const syncLabel = result && (typeof result.ahead === "number" || typeof result.behind === "number")
    ? `+${result.ahead ?? 0}/-${result.behind ?? 0}`
    : "";
  const pullRequests = result?.pullRequests;
  const pushPreview = pushPlan?.preview ?? result?.pushPreview;
  const protectedPushBranch = pushPreview ? isProtectedGitPushBranch(pushPreview.branch) : false;
  const canPreparePush = Boolean(
    pushPreview &&
    onQuickActionGitPushPlan &&
    onQuickActionGitPushExecute &&
    pushPreview.ahead > 0 &&
    pushPreview.behind === 0 &&
    !protectedPushBranch,
  );
  const canPrepareStage = Boolean(
    result &&
    selectedStageFiles.size > 0 &&
    onQuickActionGitStagePlan &&
    onQuickActionGitStageExecute,
  );
  const canPrepareCommit = Boolean(
    result &&
    result.changedFiles.length > 0 &&
    commitMessage.trim() &&
    onQuickActionGitCommitPlan &&
    onQuickActionGitCommitExecute,
  );
  const canPreparePullRequest = Boolean(
    result &&
    pullRequestTitle.trim() &&
    pullRequestBaseBranch.trim() &&
    onQuickActionGitCreatePullRequestPlan &&
    onQuickActionGitCreatePullRequestExecute,
  );
  const canPreparePullRequestComment = Boolean(
    result &&
    pullRequestCommentTarget.trim() &&
    pullRequestCommentBody.trim() &&
    onQuickActionGitCommentPullRequestPlan &&
    onQuickActionGitCommentPullRequestExecute,
  );

  return (
    <div className="javis-tool-panel">
      <div className="javis-tool-panel-header">
        <strong>{"Review"}</strong>
        <div className="javis-tool-header-actions">
          <button aria-label={"Refresh"} className="javis-tool-icon-btn icon-refresh" onClick={handleRefresh} title={"Refresh"} type="button"><span aria-hidden="true" /></button>
          <button aria-label={"History"} className="javis-tool-icon-btn icon-time" title={"History"} type="button"><span aria-hidden="true" /></button>
          <button aria-label={"Folder"} className="javis-tool-icon-btn icon-folder" title={"Folder"} type="button"><span aria-hidden="true" /></button>
        </div>
      </div>
      <select className="javis-tool-select" onChange={(event) => setStatusFilter(event.currentTarget.value)} value={statusFilter}>
        <option value="unstaged">{"Unstaged"}</option>
        <option value="staged">{"Staged"}</option>
      </select>
      <div className="javis-tool-review-actions">
        <button
          className="javis-tool-action-btn primary"
          disabled={!canPreparePush || pushLoading}
          onClick={handlePreparePush}
          title={pushPreview ? ("Prepare a push approval for the current preview") : ("No pushable local commits")}
          type="button"
        >
          {pushLoading && !pushPlan ? ("Preparing...") : ("Prepare push")}
        </button>
        <input
          className="javis-tool-filter-input"
          disabled={pullRequestLoading || Boolean(pullRequestPlan)}
          onChange={(event) => setPullRequestTitle(event.currentTarget.value)}
          placeholder={"PR title"}
          value={pullRequestTitle}
        />
        <input
          className="javis-tool-filter-input"
          disabled={pullRequestLoading || Boolean(pullRequestPlan)}
          onChange={(event) => setPullRequestBaseBranch(event.currentTarget.value)}
          placeholder={"Base branch"}
          value={pullRequestBaseBranch}
        />
        <label className="javis-tool-inline-toggle">
          <input
            checked={pullRequestDraft}
            disabled={pullRequestLoading || Boolean(pullRequestPlan)}
            onChange={(event) => setPullRequestDraft(event.currentTarget.checked)}
            type="checkbox"
          />
          <span>Draft</span>
        </label>
        <button
          className="javis-tool-action-btn"
          disabled={!canPreparePullRequest || pullRequestLoading || Boolean(pullRequestPlan)}
          onClick={handlePreparePullRequest}
          title={"Prepare a draft pull request approval"}
          type="button"
        >
          {pullRequestLoading && !pullRequestPlan ? ("Preparing...") : ("Prepare PR")}
        </button>
      </div>
      <input
        className="javis-tool-filter-input"
        disabled={pullRequestLoading || Boolean(pullRequestPlan)}
        onChange={(event) => setPullRequestBody(event.currentTarget.value)}
        placeholder={"PR body (optional)"}
        value={pullRequestBody}
      />
      <div className="javis-tool-review-actions">
        <input
          className="javis-tool-filter-input"
          disabled={pullRequestCommentLoading || Boolean(pullRequestCommentPlan)}
          onChange={(event) => setPullRequestCommentTarget(event.currentTarget.value)}
          placeholder="PR number, URL, or branch"
          value={pullRequestCommentTarget}
        />
        <button
          className="javis-tool-action-btn"
          disabled={!canPreparePullRequestComment || pullRequestCommentLoading || Boolean(pullRequestCommentPlan)}
          onClick={handlePreparePullRequestComment}
          title="Prepare a pull request comment approval"
          type="button"
        >
          {pullRequestCommentLoading && !pullRequestCommentPlan ? "Preparing..." : "Prepare PR comment"}
        </button>
      </div>
      <textarea
        className="javis-tool-filter-input"
        disabled={pullRequestCommentLoading || Boolean(pullRequestCommentPlan)}
        onChange={(event) => setPullRequestCommentBody(event.currentTarget.value)}
        placeholder="PR comment"
        rows={3}
        value={pullRequestCommentBody}
      />
      <div className="javis-tool-review-actions">
        <button
          className="javis-tool-action-btn primary"
          disabled={!canPrepareStage || stageLoading || Boolean(stagePlan)}
          onClick={handlePrepareStage}
          title={"Prepare a stage approval for the selected files"}
          type="button"
        >
          {stageLoading && !stagePlan ? ("Preparing...") : ("Prepare stage")}
        </button>
        <input
          className="javis-tool-filter-input"
          disabled={commitLoading || Boolean(commitPlan)}
          onChange={(event) => setCommitMessage(event.currentTarget.value)}
          placeholder={"Commit message"}
          value={commitMessage}
        />
        <button
          className="javis-tool-action-btn primary"
          disabled={!canPrepareCommit || commitLoading || Boolean(commitPlan)}
          onClick={handlePrepareCommit}
          title={"Prepare a commit approval for the current changes"}
          type="button"
        >
          {commitLoading && !commitPlan ? ("Preparing...") : ("Prepare commit")}
        </button>
      </div>
      <input
        className="javis-tool-filter-input"
        onChange={(event) => setFilter(event.currentTarget.value)}
        placeholder={"Filter files..."}
        value={filter}
      />
      {error ? <p className="javis-tool-error">{error}</p> : null}
      {!result && !loading ? (
        <button className="javis-tool-action-btn" onClick={handleRefresh} type="button">
          {"Run git diff review"}
        </button>
      ) : null}
      {loading ? <p>{"Running..."}</p> : null}
      {result ? (
        <div className="javis-tool-review-result">
          <div className="javis-tool-review-summary">
            {result.branch ? <span>Branch {result.branch}</span> : null}
            {result.upstream ? <span>Upstream {result.upstream}{syncLabel ? ` ${syncLabel}` : ""}</span> : null}
            {primaryRemote ? <span>Remote {primaryRemote.name}: {primaryRemote.pushUrl ?? primaryRemote.fetchUrl ?? "-"}</span> : null}
            {pullRequests ? <span>PRs {pullRequests.unavailableReason ? "unavailable" : pullRequests.pullRequests.length}</span> : null}
            {pushPreview ? <span>Push preview {pushPreview.ahead} commit(s) to {pushPreview.upstream}</span> : null}
            <span>{"Edited"} {result.changedFiles.length} {"files"}</span>
            {result.diffStat ? <span className="javis-tool-review-stat">{result.diffStat.split("\n")[0]}</span> : null}
          </div>
          {pullRequests ? (
            <div className="javis-tool-review-prs">
              <strong>Pull Requests</strong>
              {pullRequests.unavailableReason ? (
                <span>{pullRequests.unavailableReason}</span>
              ) : pullRequests.pullRequests.length === 0 ? (
                <span>{"No open pull requests"}</span>
              ) : (
                <ul>
                  {pullRequests.pullRequests.map((pullRequest) => (
                    <li key={pullRequest.url}>
                      <a href={pullRequest.url} rel="noreferrer" target="_blank">
                        #{pullRequest.number} {pullRequest.title}
                      </a>
                      <span>{pullRequest.state}{pullRequest.author ? ` by ${pullRequest.author}` : ""}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
          {pushPreview ? <p className="javis-tool-review-summary">{pushPreview.dryRun.riskSummary}</p> : null}
          {pushError ? <p className="javis-tool-error">{pushError}</p> : null}
          {pushResult ? (
            <p className="javis-tool-review-success">
              {"Pushed"} {pushResult.commitCount} {"commit(s) to"} {pushResult.upstream}
            </p>
          ) : null}
          {pushPlan ? (
            <div className="javis-tool-review-approval">
              <strong>{"Pending Push Approval"}</strong>
              <span>{pushPlan.preview.branch} -&gt; {pushPlan.preview.upstream}</span>
              <span>{pushPlan.preview.commits.length} {"commit(s)"}</span>
              <div className="javis-tool-review-actions">
                <button className="javis-tool-action-btn primary" disabled={pushLoading} onClick={handleExecutePush} type="button">
                  {pushLoading ? ("Pushing...") : ("Approve and push")}
                </button>
                <button className="javis-tool-action-btn" disabled={pushLoading} onClick={handleCancelPush} type="button">
                  {"Cancel"}
                </button>
              </div>
            </div>
          ) : null}
          {pullRequestError ? <p className="javis-tool-error">{pullRequestError}</p> : null}
          {pullRequestResult ? (
            <p className="javis-tool-review-success">
              {"Created PR: "}
              <a href={pullRequestResult.url} rel="noreferrer" target="_blank">{pullRequestResult.title}</a>
            </p>
          ) : null}
          {pullRequestPlan ? (
            <div className="javis-tool-review-approval">
              <strong>{"Pending PR Approval"}</strong>
              <span>{pullRequestPlan.preview.headBranch} -&gt; {pullRequestPlan.preview.baseBranch}</span>
              <span>{pullRequestPlan.preview.title}</span>
              <p className="javis-tool-review-summary">{pullRequestPlan.preview.dryRun.riskSummary}</p>
              <div className="javis-tool-review-actions">
                <button className="javis-tool-action-btn primary" disabled={pullRequestLoading} onClick={handleExecutePullRequest} type="button">
                  {pullRequestLoading ? ("Creating...") : ("Approve and create PR")}
                </button>
                <button className="javis-tool-action-btn" disabled={pullRequestLoading} onClick={handleCancelPullRequest} type="button">
                  {"Cancel"}
                </button>
              </div>
            </div>
          ) : null}
          {pullRequestCommentError ? <p className="javis-tool-error">{pullRequestCommentError}</p> : null}
          {pullRequestCommentResult ? (
            <p className="javis-tool-review-success">
              Posted PR comment on {pullRequestCommentResult.pullRequest}
            </p>
          ) : null}
          {pullRequestCommentPlan ? (
            <div className="javis-tool-review-approval">
              <strong>Pending PR Comment Approval</strong>
              <span>Target {pullRequestCommentPlan.preview.pullRequest}</span>
              <p className="javis-tool-review-summary">{pullRequestCommentPlan.preview.dryRun.riskSummary}</p>
              <div className="javis-tool-review-actions">
                <button className="javis-tool-action-btn primary" disabled={pullRequestCommentLoading} onClick={handleExecutePullRequestComment} type="button">
                  {pullRequestCommentLoading ? "Posting..." : "Approve and post comment"}
                </button>
                <button className="javis-tool-action-btn" disabled={pullRequestCommentLoading} onClick={handleCancelPullRequestComment} type="button">
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
          {stageError ? <p className="javis-tool-error">{stageError}</p> : null}
          {stageResult ? (
            <p className="javis-tool-review-success">
              {"Staged"} {stageResult.fileCount} {"file(s)"}
            </p>
          ) : null}
          {stagePlan ? (
            <div className="javis-tool-review-approval">
              <strong>{"Pending Stage Approval"}</strong>
              <span>{stagePlan.preview.files.length} {"file(s)"}</span>
              <p className="javis-tool-review-summary">{stagePlan.preview.dryRun.riskSummary}</p>
              <div className="javis-tool-review-actions">
                <button className="javis-tool-action-btn primary" disabled={stageLoading} onClick={handleExecuteStage} type="button">
                  {stageLoading ? ("Staging...") : ("Approve and stage")}
                </button>
                <button className="javis-tool-action-btn" disabled={stageLoading} onClick={handleCancelStage} type="button">
                  {"Cancel"}
                </button>
              </div>
            </div>
          ) : null}
          {commitError ? <p className="javis-tool-error">{commitError}</p> : null}
          {commitResult ? (
            <p className="javis-tool-review-success">
              {"Committed"} {commitResult.fileCount} {"file(s):"} {commitResult.subject}
            </p>
          ) : null}
          {commitPlan ? (
            <div className="javis-tool-review-approval">
              <strong>{"Pending Commit Approval"}</strong>
              <span>{commitPlan.preview.message}</span>
              <span>{commitPlan.preview.files.length} {"file(s)"}</span>
              <p className="javis-tool-review-summary">{commitPlan.preview.dryRun.riskSummary}</p>
              <div className="javis-tool-review-actions">
                <button className="javis-tool-action-btn primary" disabled={commitLoading} onClick={handleExecuteCommit} type="button">
                  {commitLoading ? ("Committing...") : ("Approve and commit")}
                </button>
                <button className="javis-tool-action-btn" disabled={commitLoading} onClick={handleCancelCommit} type="button">
                  {"Cancel"}
                </button>
              </div>
            </div>
          ) : null}
          <ul className="javis-tool-review-files">
            {filteredFiles.length === 0 ? (
              <li className="javis-tool-file-entry">{"No matching files"}</li>
            ) : (
              filteredFiles.map((file) => (
                <li className="javis-tool-file-entry file" key={file}>
                  {onQuickActionGitStagePlan ? (
                    <label>
                      <input
                        checked={selectedStageFiles.has(file)}
                        disabled={stageLoading || Boolean(stagePlan)}
                        onChange={() => handleToggleStageFile(file)}
                        type="checkbox"
                      />
                      <span>{file}</span>
                    </label>
                  ) : file}
                </li>
              ))
            )}
          </ul>
          {result.diff ? <pre className="javis-tool-review-diff">{result.diff.slice(0, 4000)}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}

function isProtectedGitPushBranch(branch: string): boolean {
  const normalized = branch.trim().toLowerCase();
  return normalized === "main" || normalized === "master" || normalized === "trunk" || normalized.startsWith("release/");
}

function TerminalPanel({ locale, session, terminalService, onQuickActionTerminal, computerPath }: WorkspaceToolPanelsProps) {
  const isChinese = isChineseLocale(locale);
  const cwd = session.workspaceRoot || computerPath || "";
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [terminalCreateApproved, setTerminalCreateApproved] = useState(false);
  const [terminalCreatePlan, setTerminalCreatePlan] = useState<WorkbenchTerminalPlanResult | null>(null);
  const [terminalCreatePlanning, setTerminalCreatePlanning] = useState(false);
  const [pendingTerminalInput, setPendingTerminalInput] = useState<TerminalInputApprovalPreview | null>(null);
  const [pendingTerminalInputPlan, setPendingTerminalInputPlan] = useState<WorkbenchTerminalPlanResult | null>(null);
  const [terminalInputPlanning, setTerminalInputPlanning] = useState(false);
  const [terminalInputApproving, setTerminalInputApproving] = useState(false);
  const [command, setCommand] = useState("");
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<TerminalQuickResult[]>([]);
  const [terminalError, setTerminalError] = useState<string | null>(null);

  useEffect(() => {
    setTerminalCreateApproved(false);
    setTerminalCreatePlan(null);
    setPendingTerminalInput(null);
    setPendingTerminalInputPlan(null);
  }, [session.sessionId, session.workspaceRoot]);

  function ensureTerminalId() {
    if (!terminalIdRef.current) {
      terminalIdRef.current = `term-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    return terminalIdRef.current;
  }

  useEffect(() => {
    if (!terminalService?.planCreate || terminalCreateApproved || terminalCreatePlan || terminalCreatePlanning) {
      return;
    }
    let disposed = false;
    const requestedTerminalId = ensureTerminalId();
    setTerminalCreatePlanning(true);
    setTerminalError(null);
    terminalService
      .planCreate(session, requestedTerminalId)
      .then((plan) => {
        if (!disposed) setTerminalCreatePlan(plan);
      })
      .catch((err) => {
        if (!disposed) setTerminalError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!disposed) setTerminalCreatePlanning(false);
      });
    return () => {
      disposed = true;
    };
  }, [
    session.sessionId,
    session.workspaceRoot,
    terminalCreateApproved,
    terminalCreatePlan,
    terminalService,
  ]);

  useEffect(() => {
    if (!terminalCreateApproved || !terminalService || !terminalHostRef.current || terminalRef.current) {
      return;
    }

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: "Cascadia Mono, Consolas, monospace",
      fontSize: 12,
      theme: { background: "#0f1413", foreground: "#dbe7e1" },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalHostRef.current);
    fitAddon.fit();
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    let unsubscribe: (() => void) | undefined;
    let disposed = false;

    const requestedTerminalId = ensureTerminalId();
    unsubscribe = terminalService.subscribe(requestedTerminalId, {
      onOutput: (data) => terminal.write(data),
      onExit: (exitCode) => terminal.writeln(`\r\n[process exited: ${exitCode ?? "unknown"}]`),
      onError: (message) => terminal.writeln(`\r\n[terminal error] ${message}`),
    });

    const createTerminal = terminalCreatePlan && terminalService.executeCreate
      ? terminalService.executeCreate(
          session,
          terminalCreatePlan,
          Math.max(40, terminal.cols),
          Math.max(12, terminal.rows),
          requestedTerminalId,
        )
      : terminalService.create(session, Math.max(40, terminal.cols), Math.max(12, terminal.rows), requestedTerminalId);
    createTerminal
      .then((created) => {
        if (disposed) return;
        terminalIdRef.current = created.terminalId;
        terminal.writeln(`Javis terminal: ${created.shell}`);
        terminal.writeln(`cwd: ${created.cwd}`);
      })
      .catch((err) => setTerminalError(err instanceof Error ? err.message : String(err)));

    const dataDisposable = terminal.onData((data) => {
      const terminalId = terminalIdRef.current;
      if (terminalId) {
        setPendingTerminalInput((current) => mergeTerminalInputApproval(current, terminalId, data));
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      const terminalId = terminalIdRef.current;
      if (terminalId) {
        void terminalService.resize(terminalId, terminal.cols, terminal.rows);
      }
    });
    resizeObserver.observe(terminalHostRef.current);

    return () => {
      disposed = true;
      const terminalId = terminalIdRef.current;
      unsubscribe?.();
      dataDisposable.dispose();
      resizeObserver.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      terminalIdRef.current = null;
      if (terminalId) {
        void terminalService.kill(terminalId);
      }
    };
  }, [session.sessionId, session.workspaceRoot, terminalCreateApproved, terminalCreatePlan, terminalService]);

  useEffect(() => {
    if (!terminalService?.planInput || !pendingTerminalInput) {
      setPendingTerminalInputPlan(null);
      return;
    }
    let disposed = false;
    const preview = pendingTerminalInput;
    setPendingTerminalInputPlan(null);
    setTerminalInputPlanning(true);
    setTerminalError(null);
    terminalService
      .planInput(session, preview.terminalId, preview.data)
      .then((plan) => {
        if (!disposed) setPendingTerminalInputPlan(plan);
      })
      .catch((err) => {
        if (!disposed) setTerminalError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!disposed) setTerminalInputPlanning(false);
      });
    return () => {
      disposed = true;
    };
  }, [pendingTerminalInput, session.sessionId, session.taskId, terminalService]);

  async function approvePendingTerminalInput() {
    if (!terminalService || !pendingTerminalInput) return;
    const preview = pendingTerminalInput;
    setTerminalInputApproving(true);
    setTerminalError(null);
    try {
      if (pendingTerminalInputPlan && terminalService.executeInput) {
        await terminalService.executeInput(session, pendingTerminalInputPlan, preview.terminalId, preview.data);
      } else {
        await terminalService.input(session, preview.terminalId, preview.data);
      }
      setPendingTerminalInput((current) => current === preview ? null : current);
      setPendingTerminalInputPlan(null);
    } catch (err) {
      setTerminalError(err instanceof Error ? err.message : String(err));
    } finally {
      setTerminalInputApproving(false);
    }
  }

  async function handleRun(event: FormEvent) {
    event.preventDefault();
    const nextCommand = command.trim();
    if (!onQuickActionTerminal || !nextCommand) return;

    setRunning(true);
    try {
      const result = await onQuickActionTerminal(session, nextCommand);
      setHistory((previous) => [...previous, result]);
      setCommand("");
    } catch {
      setHistory((previous) => [...previous, { command: nextCommand, stdout: "", stderr: "Command failed", exitCode: 1, cwd }]);
    } finally {
      setRunning(false);
    }
  }

  if (terminalService) {
    return (
      <div className="javis-tool-panel terminal-panel">
        {!terminalCreateApproved ? (
          <div className="javis-tool-review-approval">
            <strong>{isChinese ? "\u542f\u52a8\u4ea4\u4e92\u5f0f\u7ec8\u7aef" : "Start interactive terminal"}</strong>
            <span>{isChinese ? "\u8fd9\u4f1a\u521b\u5efa\u4e00\u4e2a\u53ef\u5199\u5165\u7684\u672c\u5730 shell \u4f1a\u8bdd\u3002" : "This will create a writable local shell session."}</span>
            {terminalCreatePlan ? (
              <>
                <span>approval {terminalCreatePlan.approvalId}</span>
                <span>hash {terminalCreatePlan.previewHash}</span>
              </>
            ) : terminalService.planCreate ? (
              <span>{terminalCreatePlanning ? (isChinese ? "\u751f\u6210\u5ba1\u6279\u9884\u89c8..." : "Preparing approval preview...") : (isChinese ? "\u5ba1\u6279\u9884\u89c8\u4e0d\u53ef\u7528" : "Approval preview unavailable")}</span>
            ) : null}
            <button
              disabled={Boolean(terminalService.planCreate && !terminalCreatePlan)}
              onClick={() => setTerminalCreateApproved(true)}
              type="button"
            >
              {isChinese ? "\u5ba1\u6279\u5e76\u542f\u52a8" : "Approve and start"}
            </button>
          </div>
        ) : null}
        {terminalError ? <p className="javis-tool-error">{terminalError}</p> : null}
        {pendingTerminalInput ? (
          <div className="javis-tool-review-approval">
            <strong>{isChinese ? "\u5ba1\u6279\u7ec8\u7aef\u8f93\u5165" : "Approve terminal input"}</strong>
            <span>{pendingTerminalInput.byteCount} byte(s) · hash {pendingTerminalInput.hash}</span>
            <span>{pendingTerminalInput.sendsEnter ? (isChinese ? "\u5305\u542b Enter" : "includes Enter") : (isChinese ? "\u4e0d\u5305\u542b Enter" : "no Enter")}</span>
            {pendingTerminalInputPlan ? (
              <>
                <span>approval {pendingTerminalInputPlan.approvalId}</span>
                <span>native hash {pendingTerminalInputPlan.previewHash}</span>
              </>
            ) : terminalService.planInput ? (
              <span>{terminalInputPlanning ? (isChinese ? "\u751f\u6210\u5ba1\u6279\u9884\u89c8..." : "Preparing approval preview...") : (isChinese ? "\u5ba1\u6279\u9884\u89c8\u4e0d\u53ef\u7528" : "Approval preview unavailable")}</span>
            ) : null}
            <button
              disabled={terminalInputApproving || Boolean(terminalService.planInput && !pendingTerminalInputPlan)}
              onClick={() => void approvePendingTerminalInput()}
              type="button"
            >
              {terminalInputApproving ? (isChinese ? "\u53d1\u9001\u4e2d..." : "Sending...") : (isChinese ? "\u5ba1\u6279\u5e76\u53d1\u9001" : "Approve and send")}
            </button>
            <button disabled={terminalInputApproving} onClick={() => setPendingTerminalInput(null)} type="button">
              {isChinese ? "\u53d6\u6d88" : "Cancel"}
            </button>
          </div>
        ) : null}
        <div className="javis-tool-xterm" ref={terminalCreateApproved ? terminalHostRef : undefined} />
      </div>
    );
  }

  return (
    <div className="javis-tool-panel terminal-panel">
      <div className="javis-tool-terminal-output">
        <pre className="javis-tool-terminal-banner">{isChinese
          ? `Windows PowerShell\n闂傚倸鍊烽懗鍓佸垝椤栫偑鈧啴宕ㄧ€涙ê浜辨繝鐢靛Т閸嬪棝鎮炴禒瀣厱妞ゆ劗濮撮崝姘辩磼閻橆喖鍔﹂柡灞界Х椤т線鏌涢幘璺烘瀻妞?(C) Microsoft Corporation闂傚倸鍊风欢姘焽瑜嶈灋婵°倕鎳庣壕鐟邦渻鐎ｎ亜顒㈢€规洖寮堕幈銊ノ熼崹顔惧帿闂佺顑傞弲婊呮崲濞戙垹骞㈡俊顖氭惈椤苯顪冮妶蹇曠ɑ闁绘搫绻濆濠氭晸閻樻煡鍞跺┑鐘茬仛閸旀牗鏅ュ┑鐘垫暩閸嬬喖宕㈣閹囧箻瀹曞洦娈惧┑顔筋焾濞夋盯鎮″鈧獮鏍偓娑櫳戠亸顓灻瑰鍕姢閼挎劙鏌涢妷锝呭闁稿婀闂傚倷娴囬褍霉閻戣棄绠犻柟鎯у殺閸ヮ剙绠柛鎾崇仢椤︽壆鎹㈠┑瀣倞鐟滃秹鎮靛鈧娲焻閻愯尪瀚板褍顕埀顒侇問閸ｎ噣宕滈悢鑲╁祦鐎广儱顦介弫濠囨煟閿濆懏婀版繛?PowerShell闂傚倸鍊烽悞锔锯偓绗涘懐鐭欓柟瀵稿仧闂勫嫰鏌￠崘銊モ偓鑺ユ叏閹惰姤鐓ユ繛鎴灻顏堟煕閻樺弶顥㈤柡灞诲妼閳规垿宕卞鍡橈紒闂備胶绮幐鎾磻閹剧粯鈷掑ù锝呮啞閸熺偞鎱ㄦ繝鍌ょ吋鐎规洑鍗冲鎾閻樻妲繝娈垮枟閵囨盯宕戦幘鍨涘亾鐟欏嫭澶勫ù婊呭仦缁傛帡鏁冮崒娑樷偓閿嬨亜閹哄秶鍔嶉柣锔芥濮婃椽宕崟鍨㈤梺鍝勬噺缁挸鐣峰鈧幊锟犲Χ閸♀晜缍楅梻浣侯攰濞夋盯宕楅崳鍍紅ps://aka.ms/PSWindows`
          : `Windows PowerShell\nCopyright (C) Microsoft Corporation. All rights reserved.\n\nInstall the latest PowerShell for new features and improvements!\nhttps://aka.ms/PSWindows`}</pre>
        {history.map((entry, index) => (
          <div key={index}>
            <div className="javis-tool-terminal-cmd">PS {entry.cwd || cwd}&gt; {entry.command}</div>
            {entry.stdout ? <pre className="javis-tool-terminal-out">{entry.stdout}</pre> : null}
            {entry.stderr ? <pre className="javis-tool-terminal-err">{entry.stderr}</pre> : null}
          </div>
        ))}
        {history.length === 0 ? <div className="javis-tool-terminal-cmd">PS {cwd}&gt;</div> : null}
      </div>
      <form className="javis-tool-terminal-bar" onSubmit={handleRun}>
        <span className="javis-tool-terminal-prompt">PS {cwd}&gt;</span>
        <input
          autoFocus
          disabled={running || !onQuickActionTerminal}
          onChange={(event) => setCommand(event.currentTarget.value)}
          spellCheck={false}
          value={command}
        />
        <button aria-label={"Run command"} className="icon-open" disabled={running || !command.trim() || !onQuickActionTerminal} type="submit">
          <span aria-hidden="true" />
        </button>
      </form>
    </div>
  );
}

interface TerminalInputApprovalPreview {
  terminalId: string;
  data: string;
  byteCount: number;
  hash: string;
  sendsEnter: boolean;
}

function mergeTerminalInputApproval(
  current: TerminalInputApprovalPreview | null,
  terminalId: string,
  data: string,
): TerminalInputApprovalPreview {
  const mergedData = current?.terminalId === terminalId ? `${current.data}${data}` : data;
  return {
    terminalId,
    data: mergedData,
    byteCount: new TextEncoder().encode(mergedData).length,
    hash: createTerminalInputHash(mergedData),
    sendsEnter: /[\r\n]$/.test(mergedData),
  };
}

function createTerminalInputHash(value: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function getParentPath(path: string): string {
  const normalized = path.replace(/[/\\]+$/, "");
  const parts = normalized.split(/[/\\]/).filter(Boolean);
  parts.pop();
  if (parts.length === 0) return path.slice(0, 3);
  if (parts.length === 1 && /^[A-Z]:$/i.test(parts[0])) return `${parts[0]}\\`;
  return parts.join("\\");
}

function normalizeUrlInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(trimmed)) return `http://${trimmed}`;
  if (/^https?:/i.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return "";
  return `https://${trimmed}`;
}

function browserWriteApprovalSummary(
  approval: WorkbenchBrowserWriteApprovalPreview,
  isChinese: boolean,
): string {
  const selector = approval.selector ? ` ${approval.selector}` : "";
  if (approval.action === "click") {
    return isChinese ? `闂傚倸鍊烽懗鍓佸垝椤栫偛绀夋俊銈呮噹缁犵娀鏌熼幑鎰靛殭闁?{selector || "濠电姷顣槐鏇㈠磻閹达箑纾规俊銈呮噹閺嬩線鎮归崶褎鈻曢柣鎺曟闇夐柛蹇撳悑缂嶆垹绱掗埀顒勫磼閻愬鍘遍梺瑙勬緲閸氣偓缂併劏濮ら妵?}` : `Click${selector || " page element"}`;
  }
  if (approval.action === "type") {
    return isChinese ? `闂傚倷绀侀幖顐λ囬鐐村亱濠电姴娲ょ粻浼存煙闂傚顦﹂柣?${approval.byteCount ?? 0} byte(s)` : `Type ${approval.byteCount ?? 0} byte(s)`;
  }
  if (approval.action === "evaluate") {
    return isChinese ? `闂傚倸鍊风粈浣革耿闁秵鍋￠柟鎯版楠炪垽鏌嶉崫鍕偓褰掑级缁嬪簱鏀介柨娑樺娴滃ジ鏌涙繝鍐炬疁鐎殿噮鍋嗛幏鐘差啅椤旀儳濮哄┑鐐差嚟閸樠囨偤閵娾晛鍚归柛銉ｅ妽閸欏繑鎱ㄥΔ鈧Λ妤呯嵁濡ゅ懏鐓?${approval.byteCount ?? 0} byte(s)` : `Evaluate page script ${approval.byteCount ?? 0} byte(s)`;
  }
  if (approval.action === "runTest") {
    const count = approval.scriptByteCount ?? approval.byteCount ?? 0;
    return isChinese ? `闂傚倷绀侀幖顐λ囬锕€鐤炬繝濠傜墕缁€澶嬫叏濡炶浜鹃梺闈涙缁舵岸鐛€ｎ亶鐔嗘繝闈涚墱閺€鎵磼閻樺磭鈽夋い顐ｇ箞瀹曟鎳栭埡鍐冾剟姊婚崒娆戠獢婵炶壈宕靛濠冪節濮橆剛顦悗骞垮劚濞层劑鎯岄崼銉﹀€甸梻鍫熺⊕閸熺偤鎮?${count} byte(s)` : `Run browser test ${count} byte(s)`;
  }
  return approval.toolName;
}
