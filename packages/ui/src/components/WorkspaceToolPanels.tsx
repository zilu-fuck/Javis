import { useEffect, useRef, useState, type FormEvent, type SyntheticEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type {
  BrowserQuickResult,
  BrowserQuickRequest,
  ReviewQuickResult,
  TerminalQuickResult,
  WorkbenchAgentSessionContext,
  WorkbenchFileSearchResult,
  WorkbenchFileService,
  WorkbenchFileEntry,
  WorkbenchLocale,
  WorkbenchTerminalService,
  WorkbenchWorkspaceToolAction,
} from "../types";
import { isChineseLocale } from "../utils";
import { ChatComposer } from "./ChatComposer";

interface WorkspaceToolPanelsProps {
  tool: WorkbenchWorkspaceToolAction;
  session: WorkbenchAgentSessionContext;
  locale: WorkbenchLocale;
  labels: WorkbenchLocale["labels"];
  onClose?: () => void;
  onQuickActionBrowser?: (session: WorkbenchAgentSessionContext, request: string | BrowserQuickRequest) => Promise<BrowserQuickResult>;
  onQuickActionReview?: (session: WorkbenchAgentSessionContext) => Promise<ReviewQuickResult>;
  onQuickActionTerminal?: (session: WorkbenchAgentSessionContext, command: string) => Promise<TerminalQuickResult>;
  terminalService?: WorkbenchTerminalService;
  fileService?: WorkbenchFileService;
  computerEntries?: WorkbenchFileEntry[];
  computerPath?: string;
  onNavigateDirectory?: (path: string) => void;
  onOpenFile?: (path: string) => void;
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
          <p>{isChinese ? "请选择项目工作区" : "Select a project workspace"}</p>
          <span>{isChinese ? "文件、审查和终端需要绑定当前项目。" : "Files, review, and terminal need a workspace."}</span>
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
}: WorkspaceToolPanelsProps) {
  const isChinese = isChineseLocale(locale);
  const [filter, setFilter] = useState("");
  const [searchResults, setSearchResults] = useState<WorkbenchFileSearchResult[]>([]);
  const [serviceEntries, setServiceEntries] = useState<WorkbenchFileEntry[] | null>(null);
  const [servicePath, setServicePath] = useState(computerPath || session.workspaceRoot);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
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

  return (
    <div className="javis-tool-panel">
      <div className="javis-tool-panel-header">
        <button className="javis-tool-header-btn has-icon icon-folder" type="button">
          <span aria-hidden="true" />
          {isChinese ? "打开文件" : "Open File"}
        </button>
        <button
          aria-label={isChinese ? "新建文件" : "New file"}
          className="javis-tool-icon-btn icon-add"
          title={isChinese ? "新建文件" : "New file"}
          type="button"
        >
          <span aria-hidden="true" />
        </button>
      </div>
      <form onSubmit={handleSearch}>
        <input
          className="javis-tool-filter-input"
          onChange={(event) => setFilter(event.currentTarget.value)}
          placeholder={fileService ? (isChinese ? "筛选或 rg 搜索..." : "Filter or rg search...") : (isChinese ? "筛选文件..." : "Filter files...")}
          value={filter}
        />
      </form>
      <div className="javis-tool-files-path" title={computerPath}>
        {effectivePath || (isChinese ? "此电脑" : "This PC")}
      </div>
      {searchError ? <p className="javis-tool-error">{searchError}</p> : null}
      {searching ? <p>{isChinese ? "搜索中..." : "Searching..."}</p> : null}
      {searchResults.length > 0 ? (
        <ul className="javis-tool-files-list">
          {searchResults.map((result) => (
            <li key={`${result.path}:${result.line ?? 0}`}>
              <button className="javis-tool-file-entry file" onClick={() => onOpenFile?.(result.path)} type="button">
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
          <p>{isChinese ? "打开文件" : "Open file"}</p>
          <span>{isChinese ? "从工作区目录树中选择文件" : "Select a file from the workspace tree"}</span>
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
                <button className="javis-tool-file-entry file" onClick={() => onOpenFile?.(entry.path)} type="button">
                  {marker ? <span className="javis-tool-file-marker">{marker}</span> : null} {entry.name}
                </button>
              </li>
            );
          })}
          {!filtered && files.length > 60 ? (
            <li className="javis-tool-file-entry more">
              {isChinese ? `...还有 ${files.length - 60} 个文件` : `...${files.length - 60} more files`}
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}

function SideChatPanel({ labels, locale, session, onSideChatSend }: WorkspaceToolPanelsProps) {
  const isChinese = isChineseLocale(locale);
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
      setMessages((previous) => [...previous, { role: "assistant", text: isChinese ? "发送失败" : "Send failed" }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="javis-tool-panel sidechat-panel">
      <div className="javis-tool-panel-header sidechat-header">
        <strong>{isChinese ? "发起聊天" : "Start Chat"}</strong>
        <button
          aria-label={isChinese ? "新对话" : "New chat"}
          className="javis-tool-icon-btn icon-add"
          onClick={() => setMessages([])}
          title={isChinese ? "新对话" : "New chat"}
          type="button"
        >
          <span aria-hidden="true" />
        </button>
      </div>
      <div className="javis-tool-sidechat-messages">
        {messages.length === 0 ? (
          <div className="javis-tool-empty">
            <span className="javis-tool-empty-icon chat" aria-hidden="true" />
            <p>{isChinese ? "在右侧边栏发起独立对话" : "Start a side conversation"}</p>
          </div>
        ) : (
          messages.map((message, index) => (
            <div className={`javis-tool-sidechat-msg ${message.role}`} key={index}>
              <span className="javis-tool-sidechat-role">{message.role === "user" ? (isChinese ? "你" : "You") : "Javis"}</span>
              <p>{message.text}</p>
            </div>
          ))
        )}
        {loading ? <p className="javis-tool-sidechat-msg assistant">{isChinese ? "思考中..." : "Thinking..."}</p> : null}
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
        taskInputPlaceholder={isChinese ? "要求后续变更" : "Request follow-up changes"}
      />
    </div>
  );
}

function BrowserPanel({ locale, session, onQuickActionBrowser }: WorkspaceToolPanelsProps) {
  const isChinese = isChineseLocale(locale);
  const [url, setUrl] = useState("");
  const [loadingAction, setLoadingAction] = useState<BrowserQuickRequest["action"] | null>(null);
  const [result, setResult] = useState<BrowserQuickResult | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    ? (isChinese ? "同步中" : "Syncing")
    : loadingAction
      ? (isChinese ? "加载中" : "Loading")
      : result?.loadState || (result?.sidecarRunning ? "ready" : "idle");
  const iframeStatusText = iframeState === "loading"
    ? (isChinese ? "iframe 加载中" : "iframe loading")
    : iframeState === "loaded"
      ? (isChinese ? "iframe 已加载" : "iframe loaded")
      : iframeState === "error"
        ? (isChinese ? "iframe 加载失败" : "iframe failed")
        : (isChinese ? "按需加载" : "loads on demand");

  return (
    <div className="javis-tool-panel browser-panel">
      <form className="javis-tool-browser-nav" onSubmit={handleNavigate}>
        <button aria-label={isChinese ? "后退" : "Back"} className="icon-back" disabled={loading || !result?.canGoBack || !onQuickActionBrowser} onClick={() => void runBrowserAction("back")} title={isChinese ? "后退" : "Back"} type="button"><span aria-hidden="true" /></button>
        <button aria-label={isChinese ? "前进" : "Forward"} className="icon-forward" disabled={loading || !result?.canGoForward || !onQuickActionBrowser} onClick={() => void runBrowserAction("forward")} title={isChinese ? "前进" : "Forward"} type="button"><span aria-hidden="true" /></button>
        <button aria-label={isChinese ? "刷新" : "Refresh"} className="icon-refresh" disabled={loading || !displayUrl || !onQuickActionBrowser} onClick={handleRefresh} title={isChinese ? "刷新" : "Refresh"} type="button"><span aria-hidden="true" /></button>
        <input
          className="javis-tool-url-input"
          onChange={(event) => setUrl(event.currentTarget.value)}
          placeholder={isChinese ? "输入 URL" : "Enter URL"}
          value={url}
        />
        <button aria-label={isChinese ? "打开" : "Open"} className="icon-open" disabled={loading || !onQuickActionBrowser || !normalizeUrlInput(url)} type="submit">
          <span aria-hidden="true" />
        </button>
      </form>
      {error ? <p className="javis-tool-error">{error}</p> : null}
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
              <span>{isChinese ? "辅助 iframe 预览" : "Auxiliary iframe preview"}</span>
              <span>{iframeStatusText}</span>
            </summary>
            <p className="javis-tool-browser-preview-note">
              {isChinese ? "主浏览会话由 sidecar 控制；此处只用于快速目视预览，目标页面可能会拒绝嵌入。" : "The sidecar owns the browser session. This iframe is only a visual preview and may be blocked by the page."}
            </p>
            {iframeError ? <p className="javis-tool-error">{iframeError}</p> : null}
            {previewOpen && displayUrl ? (
              <iframe
                className="javis-tool-browser-frame"
                onError={() => {
                  setIframeState("error");
                  setIframeError(isChinese ? "iframe 无法加载此页面。" : "The iframe could not load this page.");
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
          <p>{isChinese ? "输入 URL 并打开" : "Enter URL and navigate"}</p>
        </div>
      ) : null}
    </div>
  );
}

function ReviewPanel({ locale, session, onQuickActionReview }: WorkspaceToolPanelsProps) {
  const isChinese = isChineseLocale(locale);
  const [statusFilter, setStatusFilter] = useState("unstaged");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ReviewQuickResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  async function handleRefresh() {
    if (!onQuickActionReview) return;
    setLoading(true);
    setError(null);
    try {
      setResult(await onQuickActionReview(session));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  const filteredFiles = filter
    ? (result?.changedFiles ?? []).filter((file) => file.toLowerCase().includes(filter.toLowerCase()))
    : (result?.changedFiles ?? []);

  return (
    <div className="javis-tool-panel">
      <div className="javis-tool-panel-header">
        <strong>{isChinese ? "审查" : "Review"}</strong>
        <div className="javis-tool-header-actions">
          <button aria-label={isChinese ? "刷新" : "Refresh"} className="javis-tool-icon-btn icon-refresh" onClick={handleRefresh} title={isChinese ? "刷新" : "Refresh"} type="button"><span aria-hidden="true" /></button>
          <button aria-label={isChinese ? "历史" : "History"} className="javis-tool-icon-btn icon-time" title={isChinese ? "历史" : "History"} type="button"><span aria-hidden="true" /></button>
          <button aria-label={isChinese ? "文件夹" : "Folder"} className="javis-tool-icon-btn icon-folder" title={isChinese ? "文件夹" : "Folder"} type="button"><span aria-hidden="true" /></button>
        </div>
      </div>
      <select className="javis-tool-select" onChange={(event) => setStatusFilter(event.currentTarget.value)} value={statusFilter}>
        <option value="unstaged">{isChinese ? "未暂存" : "Unstaged"}</option>
        <option value="staged">{isChinese ? "已暂存" : "Staged"}</option>
      </select>
      <div className="javis-tool-review-actions">
        <button className="javis-tool-action-btn primary" disabled title={isChinese ? "下一阶段接入权限确认" : "Pending permission flow"} type="button">
          {isChinese ? "提交或推送" : "Commit or Push"}
        </button>
        <button className="javis-tool-action-btn" disabled title={isChinese ? "下一阶段接入权限确认" : "Pending permission flow"} type="button">
          {isChinese ? "创建 Pull Request" : "Create Pull Request"}
        </button>
      </div>
      <input
        className="javis-tool-filter-input"
        onChange={(event) => setFilter(event.currentTarget.value)}
        placeholder={isChinese ? "筛选文件..." : "Filter files..."}
        value={filter}
      />
      {error ? <p className="javis-tool-error">{error}</p> : null}
      {!result && !loading ? (
        <button className="javis-tool-action-btn" onClick={handleRefresh} type="button">
          {isChinese ? "运行 git diff 审查" : "Run git diff review"}
        </button>
      ) : null}
      {loading ? <p>{isChinese ? "运行中..." : "Running..."}</p> : null}
      {result ? (
        <div className="javis-tool-review-result">
          <div className="javis-tool-review-summary">
            <span>{isChinese ? "已编辑" : "Edited"} {result.changedFiles.length} {isChinese ? "个文件" : "files"}</span>
            {result.diffStat ? <span className="javis-tool-review-stat">{result.diffStat.split("\n")[0]}</span> : null}
          </div>
          <ul className="javis-tool-review-files">
            {filteredFiles.length === 0 ? (
              <li className="javis-tool-file-entry">{isChinese ? "无匹配文件" : "No matching files"}</li>
            ) : (
              filteredFiles.map((file) => <li className="javis-tool-file-entry file" key={file}>{file}</li>)
            )}
          </ul>
          {result.diff ? <pre className="javis-tool-review-diff">{result.diff.slice(0, 4000)}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}

function TerminalPanel({ locale, session, terminalService, onQuickActionTerminal, computerPath }: WorkspaceToolPanelsProps) {
  const isChinese = isChineseLocale(locale);
  const cwd = session.workspaceRoot || computerPath || "";
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [command, setCommand] = useState("");
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<TerminalQuickResult[]>([]);
  const [terminalError, setTerminalError] = useState<string | null>(null);

  useEffect(() => {
    if (!terminalService || !terminalHostRef.current || terminalRef.current) {
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

    const requestedTerminalId = `term-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    terminalIdRef.current = requestedTerminalId;
    unsubscribe = terminalService.subscribe(requestedTerminalId, {
      onOutput: (data) => terminal.write(data),
      onExit: (exitCode) => terminal.writeln(`\r\n[process exited: ${exitCode ?? "unknown"}]`),
      onError: (message) => terminal.writeln(`\r\n[terminal error] ${message}`),
    });

    terminalService
      .create(session, Math.max(40, terminal.cols), Math.max(12, terminal.rows), requestedTerminalId)
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
        void terminalService.input(session, terminalId, data);
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
  }, [session.sessionId, session.workspaceRoot, terminalService]);

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
        {terminalError ? <p className="javis-tool-error">{terminalError}</p> : null}
        <div className="javis-tool-xterm" ref={terminalHostRef} />
      </div>
    );
  }

  return (
    <div className="javis-tool-panel terminal-panel">
      <div className="javis-tool-terminal-output">
        <pre className="javis-tool-terminal-banner">{isChinese
          ? `Windows PowerShell\n版权所有 (C) Microsoft Corporation。保留所有权利。\n\n安装最新的 PowerShell，了解新功能和改进！\nhttps://aka.ms/PSWindows`
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
        <button aria-label={isChinese ? "运行命令" : "Run command"} className="icon-open" disabled={running || !command.trim() || !onQuickActionTerminal} type="submit">
          <span aria-hidden="true" />
        </button>
      </form>
    </div>
  );
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
