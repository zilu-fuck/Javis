import assert from "node:assert/strict";
import test from "node:test";
import { getBrowserLaunchCandidates, launchBrowser } from "./browser-launch.js";

test("prefers installed Windows browsers before Playwright Chromium", () => {
  assert.deepEqual(getBrowserLaunchCandidates("win32"), [
    { channel: "msedge", label: "Microsoft Edge" },
    { channel: "chrome", label: "Google Chrome" },
    { label: "Playwright Chromium" },
  ]);
});

test("falls back when an installed Windows browser is unavailable", async () => {
  const attempts: Array<{ headless: boolean; channel?: string }> = [];
  const result = await launchBrowser({
    async launch(options) {
      attempts.push(options);
      if (options.channel === "msedge") throw new Error("Edge unavailable");
      return options.channel ?? "bundled";
    },
  }, true, "win32");

  assert.equal(result, "chrome");
  assert.deepEqual(attempts, [
    { headless: true, channel: "msedge" },
    { headless: true, channel: "chrome" },
  ]);
});

test("reports every browser launch failure", async () => {
  await assert.rejects(
    launchBrowser({
      async launch(options) {
        throw new Error(`${options.channel ?? "bundled"} unavailable`);
      },
    }, true, "win32"),
    /Microsoft Edge: msedge unavailable; Google Chrome: chrome unavailable; Playwright Chromium: bundled unavailable/,
  );
});
