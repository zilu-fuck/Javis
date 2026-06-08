import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import * as readline from "node:readline";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as dns from "node:dns/promises";
import * as net from "node:net";
import { execFile } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Request {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

interface ResponseOk {
  id: string;
  result: unknown;
}

interface ResponseErr {
  id: string;
  error: { code: number; message: string };
}

// ---------------------------------------------------------------------------
// Browser singleton
// ---------------------------------------------------------------------------

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let userDataDir: string | null = null;
let requestPolicy = { allowLocalhost: false };
let navigationHistory: string[] = [];
let navigationIndex = -1;

async function ensureBrowser(headless = true): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  // Detect stale browser (e.g. process crashed, disconnected).
  if (browser && !browser.isConnected()) {
    browser = null;
    context = null;
    page = null;
  }

  if (browser && context && page) {
    return { browser, context, page };
  }

  userDataDir = path.join(os.tmpdir(), `javis-browser-${Date.now()}`);
  fs.mkdirSync(userDataDir, { recursive: true });

  browser = await chromium.launch({ headless });
  context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.route("**/*", async (route) => {
    const allowed = await isBrowserRequestAllowed(route.request().url(), requestPolicy.allowLocalhost);
    if (!allowed) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  page = await context.newPage();

  return { browser, context, page };
}

function setRequestPolicy(allowLocalhost: boolean): void {
  requestPolicy = { allowLocalhost };
}

function recordNavigation(url: string): void {
  if (!url || url === "about:blank") return;
  if (navigationHistory[navigationIndex] === url) return;
  navigationHistory = navigationHistory.slice(0, navigationIndex + 1);
  navigationHistory.push(url);
  navigationIndex = navigationHistory.length - 1;
}

async function currentPageStatus(loadState = "idle", status: number | null = null): Promise<Record<string, unknown>> {
  if (!browser || !browser.isConnected() || !page) {
    return {
      sidecarRunning: false,
      url: "",
      title: "",
      status,
      loadState: "idle",
      canGoBack: false,
      canGoForward: false,
    };
  }

  return {
    sidecarRunning: true,
    url: page.url(),
    title: await page.title(),
    status,
    loadState,
    canGoBack: navigationIndex > 0,
    canGoForward: navigationIndex >= 0 && navigationIndex < navigationHistory.length - 1,
  };
}

async function isBrowserRequestAllowed(rawUrl: string, allowLocalhost: boolean): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (["about:", "blob:", "data:"].includes(parsed.protocol)) {
    return true;
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
    return false;
  }
  if (parsed.username || parsed.password) {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  if (!host) return false;
  if (isPrivateHost(host)) {
    return allowLocalhost && isLocalhost(host);
  }
  if (allowLocalhost && isLocalhost(host)) {
    return true;
  }
  if (net.isIP(host) !== 0) {
    return !isPrivateIp(host);
  }

  try {
    const addresses = await dns.lookup(host, { all: true });
    return addresses.length > 0 && addresses.every((entry) => !isPrivateIp(entry.address));
  } catch {
    return false;
  }
}

function isLocalhost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function isPrivateHost(host: string): boolean {
  if (isLocalhost(host)) return true;
  if (host === "metadata.google.internal" || host === "metadata") return true;
  return net.isIP(host) !== 0 && isPrivateIp(host);
}

function isPrivateIp(address: string): boolean {
  if (net.isIPv4(address)) {
    const parts = address.split(".").map((part) => Number(part));
    const a = parts[0] ?? -1;
    const b = parts[1] ?? -1;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a === 169 && b === 254 ||
      a === 172 && b >= 16 && b <= 31 ||
      a === 192 && b === 168 ||
      a === 100 && b >= 64 && b <= 127 ||
      a === 224 ||
      a >= 240
    );
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fe80:") ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("ff")
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

function ok(id: string, result: unknown): ResponseOk {
  return { id, result };
}

function err(id: string, code: number, message: string): ResponseErr {
  return { id, error: { code, message } };
}

function write(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// ---------------------------------------------------------------------------
// Method handlers
// ---------------------------------------------------------------------------

async function handleNavigate(params: Record<string, unknown> | undefined): Promise<unknown> {
  const { page } = await ensureBrowser();
  const url = String(params?.url ?? "");
  const waitForSelector = params?.waitForSelector ? String(params.waitForSelector) : undefined;
  const timeoutMs = params?.timeoutMs ? Number(params.timeoutMs) : 30_000;
  setRequestPolicy(params?.allowLocalhost === true);

  const response = await page.goto(url, { waitUntil: "load", timeout: timeoutMs });

  if (waitForSelector) {
    await page.waitForSelector(waitForSelector, { timeout: timeoutMs });
  }

  recordNavigation(page.url());
  return currentPageStatus("load", response?.status() ?? null);
}

async function handleStatus(): Promise<unknown> {
  return currentPageStatus();
}

async function handleRefresh(params: Record<string, unknown> | undefined): Promise<unknown> {
  const { page } = await ensureBrowser();
  const timeoutMs = params?.timeoutMs ? Number(params.timeoutMs) : 30_000;
  setRequestPolicy(params?.allowLocalhost === true);

  const response = await page.reload({ waitUntil: "load", timeout: timeoutMs });
  recordNavigation(page.url());
  return currentPageStatus("load", response?.status() ?? null);
}

async function handleGoBack(params: Record<string, unknown> | undefined): Promise<unknown> {
  const { page } = await ensureBrowser();
  const timeoutMs = params?.timeoutMs ? Number(params.timeoutMs) : 30_000;
  setRequestPolicy(params?.allowLocalhost === true);

  if (navigationIndex <= 0) {
    return currentPageStatus("idle");
  }

  const response = await page.goBack({ waitUntil: "load", timeout: timeoutMs });
  navigationIndex = Math.max(0, navigationIndex - 1);
  if (response === null && navigationHistory[navigationIndex]) {
    await page.goto(navigationHistory[navigationIndex], { waitUntil: "load", timeout: timeoutMs });
  }
  return currentPageStatus("load", response?.status() ?? null);
}

async function handleGoForward(params: Record<string, unknown> | undefined): Promise<unknown> {
  const { page } = await ensureBrowser();
  const timeoutMs = params?.timeoutMs ? Number(params.timeoutMs) : 30_000;
  setRequestPolicy(params?.allowLocalhost === true);

  if (navigationIndex < 0 || navigationIndex >= navigationHistory.length - 1) {
    return currentPageStatus("idle");
  }

  const response = await page.goForward({ waitUntil: "load", timeout: timeoutMs });
  navigationIndex = Math.min(navigationHistory.length - 1, navigationIndex + 1);
  if (response === null && navigationHistory[navigationIndex]) {
    await page.goto(navigationHistory[navigationIndex], { waitUntil: "load", timeout: timeoutMs });
  }
  return currentPageStatus("load", response?.status() ?? null);
}

async function handleScreenshot(params: Record<string, unknown> | undefined): Promise<unknown> {
  const { page } = await ensureBrowser();
  const selector = params?.selector ? String(params.selector) : undefined;
  const fullPage = params?.fullPage === true;
  const format = (params?.format as "png" | "jpeg") ?? "png";
  const quality = params?.quality ? Number(params.quality) : undefined;

  let buffer: Buffer;
  if (selector) {
    const el = await page.$(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);
    buffer = await el.screenshot({ type: format, quality: format === "jpeg" ? quality : undefined });
  } else {
    buffer = await page.screenshot({ type: format, fullPage, quality: format === "jpeg" ? quality : undefined });
  }

  const mime = format === "jpeg" ? "image/jpeg" : "image/png";
  const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;

  const viewport = page.viewportSize();
  return {
    dataUrl,
    width: viewport?.width ?? 0,
    height: viewport?.height ?? 0,
    url: page.url(),
  };
}

async function handleGetContent(params: Record<string, unknown> | undefined): Promise<unknown> {
  const { page } = await ensureBrowser();
  const selector = params?.selector ? String(params.selector) : undefined;
  const format = (params?.format as "text" | "html" | "markdown") ?? "text";
  const maxLength = params?.maxLength ? Number(params.maxLength) : undefined;

  if (format === "markdown") {
    throw new Error("Markdown format is not supported natively. Use 'text' or 'html' instead.");
  }

  let content: string;

  if (selector) {
    const el = await page.$(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);
    content = format === "html" ? await el.innerHTML() : await el.innerText();
  } else {
    content = format === "html" ? await page.content() : await page.innerText("body");
  }

  if (maxLength && content.length > maxLength) {
    content = content.slice(0, maxLength);
  }

  return {
    content,
    url: page.url(),
    title: await page.title(),
  };
}

async function handleExtractLinks(params: Record<string, unknown> | undefined): Promise<unknown> {
  const { page } = await ensureBrowser();
  const selector = params?.selector ? String(params.selector) : "a[href]";
  const maxResults = Math.max(1, Math.min(params?.maxResults ? Number(params.maxResults) : 50, 200));

  const links = await page.$$eval(
    selector,
    (elements: Element[], max: number) =>
      elements.slice(0, max).map((el) => {
        const anchor = el as HTMLAnchorElement;
        return {
          href: anchor.href || "",
          text: (anchor.textContent || "").trim().slice(0, 200),
          tag: anchor.tagName?.toLowerCase(),
          rel: anchor.rel || "",
        };
      }),
    maxResults,
  );

  return { links, count: links.length, url: page.url() };
}

async function handleClick(params: Record<string, unknown> | undefined): Promise<unknown> {
  const { page } = await ensureBrowser();
  const selector = String(params?.selector ?? "");
  if (!selector) throw new Error("selector is required");

  const button = (params?.button as "left" | "right" | "middle") ?? "left";
  const clickCount = params?.clickCount ? Number(params.clickCount) : 1;
  const timeoutMs = params?.timeoutMs ? Number(params.timeoutMs) : 30_000;

  await page.click(selector, { button, clickCount, timeout: timeoutMs });

  return {
    selector,
    clicked: true,
    newUrl: page.url(),
  };
}

async function handleType(params: Record<string, unknown> | undefined): Promise<unknown> {
  const { page } = await ensureBrowser();
  const selector = String(params?.selector ?? "");
  const text = String(params?.text ?? "");
  if (!selector) throw new Error("selector is required");

  const delay = params?.delay ? Number(params.delay) : undefined;
  const clearBefore = params?.clearBefore === true;
  const pressEnter = params?.pressEnter === true;

  if (clearBefore) {
    await page.fill(selector, "");
  }

  await page.type(selector, text, { delay });

  if (pressEnter) {
    await page.press(selector, "Enter");
  }

  const value = await page.$eval(selector, (el: HTMLInputElement) => el.value);

  return { selector, typed: true, value };
}

async function handleEvaluate(params: Record<string, unknown> | undefined): Promise<unknown> {
  const { page } = await ensureBrowser();
  const expression = String(params?.expression ?? "");
  if (!expression) throw new Error("expression is required");

  const result = await page.evaluate((expr: string) => {
    try {
      return { result: String(eval(expr)), type: "success" as const };
    } catch (e) {
      return { result: String(e), type: "error" as const };
    }
  }, expression);

  return result;
}

async function handleRunTest(params: Record<string, unknown> | undefined): Promise<unknown> {
  const script = String(params?.script ?? "");
  const testFile = params?.testFile ? String(params.testFile) : undefined;
  const timeoutMs = params?.timeoutMs ? Number(params.timeoutMs) : 60_000;

  let filePath: string;
  let cleanup = false;

  if (testFile) {
    filePath = testFile;
  } else {
    filePath = path.join(os.tmpdir(), `javis-test-${Date.now()}.spec.ts`);
    fs.writeFileSync(filePath, script, "utf-8");
    cleanup = true;
  }

  const start = Date.now();

  return new Promise((resolve, reject) => {
    const child = execFile(
      "npx",
      ["playwright", "test", filePath],
      { timeout: timeoutMs },
      (error, stdout, stderr) => {
        const duration = Date.now() - start;
        if (cleanup) {
          try { fs.unlinkSync(filePath); } catch { /* ignore */ }
        }
        if (error && !error.killed) {
          // Non-zero exit is normal for failing tests
          resolve({
            passed: false,
            exitCode: error.code ?? 1,
            stdout,
            stderr,
            duration,
          });
        } else if (error?.killed) {
          resolve({
            passed: false,
            exitCode: -1,
            stdout,
            stderr: stderr + "\n[timeout]",
            duration,
          });
        } else {
          resolve({
            passed: true,
            exitCode: 0,
            stdout,
            stderr,
            duration,
          });
        }
      },
    );
  });
}

async function handleClose(): Promise<unknown> {
  if (browser) {
    await browser.close();
  }
  browser = null;
  context = null;
  page = null;
  navigationHistory = [];
  navigationIndex = -1;

  if (userDataDir) {
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    userDataDir = null;
  }

  return { closed: true };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

async function dispatch(req: Request): Promise<void> {
  const { id, method, params } = req;

  try {
    let result: unknown;

    switch (method) {
      case "navigate":
        result = await handleNavigate(params);
        break;
      case "status":
        result = await handleStatus();
        break;
      case "refresh":
        result = await handleRefresh(params);
        break;
      case "goBack":
        result = await handleGoBack(params);
        break;
      case "goForward":
        result = await handleGoForward(params);
        break;
      case "screenshot":
        result = await handleScreenshot(params);
        break;
      case "getContent":
        result = await handleGetContent(params);
        break;
      case "extractLinks":
        result = await handleExtractLinks(params);
        break;
      case "click":
        result = await handleClick(params);
        break;
      case "type":
        result = await handleType(params);
        break;
      case "evaluate":
        result = await handleEvaluate(params);
        break;
      case "runTest":
        result = await handleRunTest(params);
        break;
      case "close":
        result = await handleClose();
        break;
      default:
        write(err(id, -32601, `Method not found: ${method}`));
        return;
    }

    write(ok(id, result));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    write(err(id, -32000, message));
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(): Promise<void> {
  await handleClose();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGHUP", shutdown);

// ---------------------------------------------------------------------------
// Main — JSONL over stdin/stdout
// ---------------------------------------------------------------------------

const rl = readline.createInterface({ input: process.stdin, terminal: false });

// Send readiness signal
write({ id: "ready", result: { status: "ready" } });

rl.on("line", async (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let req: Request;
  try {
    req = JSON.parse(trimmed) as Request;
  } catch {
    write(err("", -32700, "Parse error: invalid JSON"));
    return;
  }

  if (!req.id || !req.method) {
    write(err(req?.id ?? "", -32600, "Invalid request: missing id or method"));
    return;
  }

  await dispatch(req);
});

rl.on("close", shutdown);
