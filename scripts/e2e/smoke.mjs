// Real-browser smoke test for the built desktop front-end.
//
// Why this exists: every other test in this repository runs in jsdom, which imports modules
// directly and never loads the production bundle. That gap was not theoretical — a chunking
// change passed all ~2,900 unit tests while the built app failed to mount in a real browser:
//
//   Cannot read properties of undefined (reading 'PureComponent')
//
// The window showed only "正在启动…" and no test noticed. This script closes that gap: it serves
// `apps/desktop/dist`, loads it in a real headless Chromium, and fails if the app does not
// render or if a non-Tauri error occurs.
//
// Tauri APIs are absent in a plain browser, so `invoke` failures are counted separately.
// Mixing them with render failures would hide a real crash inside expected noise.
//
// Usage:
//   node scripts/e2e/smoke.mjs [--out report.json] [--min-root-chars 1000] [--headful]
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const distDir = path.join(repoRoot, "apps/desktop/dist");
const sidecarRoot = path.join(repoRoot, "apps/desktop/src-tauri/sidecar/browser");

/**
 * The vendored Chromium.
 *
 * Playwright's own download for its expected revision is absent, so the installed
 * headless-shell is passed explicitly. Overridable for other machines and CI.
 */
const CHROMIUM_CANDIDATES = [
  process.env.JAVIS_E2E_CHROMIUM,
  "C:\\Users\\s1897\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1208\\chrome-headless-shell-win64\\chrome-headless-shell.exe",
].filter(Boolean);

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outFile = outIndex >= 0 ? args[outIndex + 1] : path.join(repoRoot, ".dsh-tmp/e2e-report.json");
const minIndex = args.indexOf("--min-root-chars");
// A mounted workbench renders thousands of characters; a shell stuck on "starting" renders a few.
const minRootChars = minIndex >= 0 ? Number(args[minIndex + 1]) : 1_000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

if (!fs.existsSync(path.join(distDir, "index.html"))) {
  console.error(`e2e: ${path.relative(repoRoot, distDir)}/index.html is missing.`);
  console.error("     Build the front-end first: corepack pnpm --filter @javis/desktop build");
  process.exit(1);
}

/** Serves the built app; unknown paths fall back to index.html like the Tauri shell does. */
function startServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    let filePath = path.join(distDir, decodeURIComponent(url.pathname));
    if (!filePath.startsWith(distDir)) {
      response.writeHead(403).end("forbidden");
      return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(distDir, "index.html");
    }
    const body = fs.readFileSync(filePath);
    response.writeHead(200, { "content-type": MIME[path.extname(filePath)] ?? "application/octet-stream" });
    response.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

const { server, port } = await startServer();
const baseUrl = `http://127.0.0.1:${port}/`;

const require = createRequire(path.join(sidecarRoot, "index.js"));
const { chromium } = require("playwright");

const report = {
  url: baseUrl,
  startedAt: new Date().toISOString(),
  consoleErrors: [],
  pageErrors: [],
  failedRequests: [],
  tauriRelatedFailures: 0,
  rendered: false,
  rootHtmlChars: 0,
  /** Thread-overflow probe numbers; populated after the app mounts. */
  layout: null,
  layoutFailures: [],
  durationMs: 0,
};

const startedAt = Date.now();
const browser = await chromium.launch({
  headless: !args.includes("--headful"),
  executablePath: CHROMIUM_CANDIDATES.find((candidate) => fs.existsSync(candidate)),
});

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (/__TAURI|invoke|ipc|tauri/i.test(text)) report.tauriRelatedFailures += 1;
    else report.consoleErrors.push(text.slice(0, 500));
  });
  page.on("pageerror", (error) => {
    const text = String(error?.message ?? error);
    if (/__TAURI|invoke|ipc|tauri/i.test(text)) report.tauriRelatedFailures += 1;
    else report.pageErrors.push(text.slice(0, 500));
  });
  page.on("requestfailed", (request) => {
    report.failedRequests.push(
      `${request.method()} ${request.url().slice(0, 160)} — ${request.failure()?.errorText ?? "failed"}`,
    );
  });

  await page.goto(baseUrl, { waitUntil: "load", timeout: 60_000 });
  // Let React mount and settle its first data requests.
  await page.waitForTimeout(3_000);

  const root = await page.evaluate(() => {
    const element = document.querySelector("#root") ?? document.body;
    return {
      rootHtmlChars: element.innerHTML.length,
      bodyText: (document.body?.innerText ?? "").slice(0, 4_000),
      title: document.title,
    };
  });

  report.rendered = root.rootHtmlChars >= minRootChars;
  report.rootHtmlChars = root.rootHtmlChars;
  report.title = root.title;
  report.bodyTextSample = root.bodyText.slice(0, 1_200);

  /**
   * Landmarks, not a character count.
   *
   * A blank page cannot satisfy these: each is a distinct piece of the workbench shell, so a
   * partially-mounted app (the failure mode that started this file) fails the gate instead of
   * passing on "some HTML exists".
   */
  const LANDMARKS = [
    { name: "sidebar-new-chat", text: "新建对话" },
    { name: "nav-settings", text: "设置" },
    { name: "composer-prompt", text: "聊点什么" },
  ];
  report.landmarks = [];
  for (const landmark of LANDMARKS) {
    const found = root.bodyText.includes(landmark.text) || await page.locator(`text=${landmark.text}`).count() > 0;
    report.landmarks.push({ ...landmark, found });
  }
  const missing = report.landmarks.filter((landmark) => !landmark.found).map((landmark) => landmark.name);
  report.missingLandmarks = missing;

  /**
   * Interactivity: the app must respond to a real click.
   *
   * A shell that renders but whose handlers never attached would pass a text-only check, so the
   * composer is clicked and the resulting focus is asserted.
   */
  try {
    const composer = page.locator("textarea, input[type='text'], [contenteditable='true']").first();
    await composer.click({ timeout: 5_000 });
    report.interactive = await composer.evaluate((element) => (
      element === document.activeElement
    ));
  } catch (error) {
    report.interactive = false;
    report.interactiveError = String(error?.message ?? error).slice(0, 300);
  }

  /**
   * Layout guard: the conversation thread must not scroll sideways.
   *
   * Why this is here: jsdom has no layout, so a grid child whose content cannot
   * shrink silently inflates `.javis-thread`'s scroll track. A `<span>` with
   * `white-space: nowrap` is enough — the thinking digest's one-line preview is
   * exactly that — and the thread then reports ~2.4x its viewport width in
   * content. The damage is not cosmetic: `justify-self: end` user bubbles are
   * laid out against the inflated track, so they land outside the viewport and a
   * finished conversation looks like the user's own messages disappeared.
   *
   * The fixture below mirrors what `ThreadView` renders (assistant message,
   * user bubble, execution panel, thinking digest), and the assertion is applied
   * to the real production stylesheet, not a copy.
   */
  report.layout = await page.evaluate(() => {
    const PREVIEW = "The user asks in Chinese: \"你会做些什么\" — what can you do. "
      + "I should answer directly, describing Javis capabilities: Commander Agent, "
      + "workbench, workspace, approval, proposal, dry run, confirmed write, patch, "
      + "diff, hunk, verifier, token, Agent terminology. I must not claim to run tools.";
    const host = document.createElement("div");
    host.setAttribute("data-e2e-probe", "layout");
    host.style.cssText = "width:1000px;height:240px;position:absolute;left:-10000px;top:0;";
    host.innerHTML = `
      <section class="javis-thread">
        <article class="javis-message"><div class="javis-message-body"><p>你好</p></div></article>
        <article class="javis-message user"><div class="javis-message-body"><p>你会做些什么</p></div></article>
        <div class="javis-execution-summary"><div style="padding:12px 14px">执行详情</div></div>
        <div class="javis-reasoning-digest"><button class="javis-reasoning-digest-toggle" type="button">
          <span class="javis-reasoning-label">思考过程 · commander</span>
          <span class="javis-reasoning-digest-preview"></span>
          <span class="javis-reasoning-digest-arrow">▸</span>
        </button></div>
      </section>`;
    document.body.appendChild(host);
    const thread = host.querySelector(".javis-thread");
    thread.querySelector(".javis-reasoning-digest-preview").textContent = PREVIEW;
    const bubble = host.querySelector(".javis-message.user");
    const box = bubble.getBoundingClientRect();
    const result = {
      clientWidth: thread.clientWidth,
      scrollWidth: thread.scrollWidth,
      overflowX: thread.scrollWidth - thread.clientWidth,
      // A right-aligned bubble that starts past the viewport is the visible symptom.
      userBubbleLeft: Math.round(box.left - thread.getBoundingClientRect().left),
      userBubbleRight: Math.round(box.right - thread.getBoundingClientRect().left),
    };
    host.remove();
    return result;
  });
  report.layoutFailures = [];
  if (report.layout.overflowX > 1) {
    report.layoutFailures.push(`thread scrolls horizontally by ${report.layout.overflowX}px`
      + ` (clientWidth=${report.layout.clientWidth}, scrollWidth=${report.layout.scrollWidth})`);
  }
  if (report.layout.userBubbleRight > report.layout.clientWidth) {
    report.layoutFailures.push(`right-aligned user bubble sits outside the viewport`
      + ` (right=${report.layout.userBubbleRight} > clientWidth=${report.layout.clientWidth})`);
  }

  const shot = path.join(repoRoot, ".dsh-tmp/e2e-smoke.png");
  await page.screenshot({ path: shot, fullPage: false });
  report.screenshot = shot;
} finally {
  await browser.close();
  server.close();
  report.durationMs = Date.now() - startedAt;
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), "utf8");

  console.log(`e2e: rendered=${report.rendered} rootHtmlChars=${report.rootHtmlChars} title="${report.title ?? ""}"`);
  console.log(`e2e: landmarks ${(report.landmarks ?? []).filter((l) => l.found).length}/${(report.landmarks ?? []).length}`
    + `  interactive=${report.interactive}`);
  console.log(`e2e: console errors=${report.consoleErrors.length} page errors=${report.pageErrors.length} `
    + `failed requests=${report.failedRequests.length} tauri-related=${report.tauriRelatedFailures}`);
  if (report.layout) {
    console.log(`e2e: thread layout overflowX=${report.layout.overflowX}px `
      + `userBubbleRight=${report.layout.userBubbleRight}/${report.layout.clientWidth}`);
  }
  for (const error of [...report.pageErrors, ...report.consoleErrors].slice(0, 6)) {
    console.log(`      ${error}`);
  }
  for (const failure of report.layoutFailures ?? []) {
    console.log(`      layout: ${failure}`);
  }
  if ((report.missingLandmarks ?? []).length > 0) {
    console.log(`      missing landmarks: ${report.missingLandmarks.join(", ")}`);
  }

  const failed = !report.rendered
    || report.pageErrors.length > 0
    || report.consoleErrors.length > 0
    || (report.missingLandmarks ?? []).length > 0
    || report.interactive !== true
    || (report.layoutFailures ?? []).length > 0;
  if (failed) {
    console.error("e2e: the built front-end did not render cleanly and interactively in a real browser.");
    process.exit(1);
  }
  console.log("e2e: the built front-end mounts and renders with no errors.");
}
