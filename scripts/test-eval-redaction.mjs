/**
 * Tests for the diagnostics-bundle redaction rules (F3).
 *
 * A shared diagnostics bundle must never carry an API key, the home path or the
 * hostname, so these rules are pinned here rather than left to review.
 *
 * Run: node --test scripts/test-eval-redaction.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { redact, redactString } from "./eval/lib/redaction.mjs";

const HOME = "C:\\Users\\tester";
const HOST = "TEST-HOST";

test("redacts API-key shaped tokens", () => {
  const samples = [
    "sk-test-fixture-not-a-real-key",
    "api-key-0123456789abcdefghijklmnop",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
    "token_0123456789abcdefghijklmnopqrst",
  ];
  for (const sample of samples) {
    const redacted = redactString(sample, HOME, HOST);
    assert.ok(
      redacted.includes("[redacted-secret]"),
      `expected redaction for ${sample}, got ${redacted}`,
    );
    assert.ok(!/\b(?:sk|pk|api|key|token|bearer)[-_a-z0-9]{0,8}[-_a-z0-9]{16,}\b/iu.test(redacted));
  }
});

test("redacts the home path in both separators and the hostname", () => {
  const windows = redactString(`failed to read ${HOME}\\AppData\\Roaming\\javis.db`, HOME, HOST);
  assert.equal(windows, "failed to read %USERPROFILE%\\AppData\\Roaming\\javis.db");
  const posix = redactString("failed to read C:/Users/tester/AppData/Roaming/javis.db", HOME, HOST);
  assert.ok(posix.includes("%USERPROFILE%"));
  assert.equal(redactString(`host ${HOST} reporting`, HOME, HOST), "host %HOSTNAME% reporting");
});

test("redacts secret-named object keys whatever their value shape", () => {
  const redacted = redact(
    {
      apiKey: "anything at all",
      nested: { value: { secret: 42 }, token: null },
      safe: "keep me",
      list: [{ password: "hunter2" }],
    },
    0,
    HOME,
    HOST,
  );
  assert.equal(redacted.apiKey, "[redacted-key]");
  assert.equal(redacted.nested.value.secret, "[redacted-key]");
  assert.equal(redacted.nested.token, "[redacted-key]");
  assert.equal(redacted.safe, "keep me");
  assert.equal(redacted.list[0].password, "[redacted-key]");
});

test("keeps ordinary diagnostic values intact", () => {
  const redacted = redact({ taskId: "task-1789226288412", status: "failed", count: 3, ok: true });
  assert.deepEqual(redacted, { taskId: "task-1789226288412", status: "failed", count: 3, ok: true });
});

test("does not leak a secret embedded in a longer message", () => {
  const redacted = redact({
    detail: "model.call.failed provider=deepseek key=sk-test-fixture-not-a-real-key status=401",
  }, 0, HOME, HOST);
  assert.ok(!redacted.detail.includes("sk-test-fixture-not-a-real-key"));
  assert.ok(redacted.detail.includes("status=401"));
});

test("bounds recursion instead of throwing on deep structures", () => {
  let deep = { value: "leaf" };
  for (let index = 0; index < 30; index += 1) {
    deep = { nested: deep };
  }
  const redacted = redact(deep, 0, HOME, HOST);
  assert.ok(JSON.stringify(redacted).includes("[truncated-depth]"));
});
