/**
 * Redaction helpers for diagnostics bundles (F3).
 *
 * Kept in a plain module so the behaviour is unit-testable without running the
 * CLI: a diagnostics bundle is the one artifact a user is asked to share, so the
 * redaction rules need their own tests.
 */
import os from "node:os";

const SECRET_PATTERNS = [
  /\b(?:sk|pk|api|key|token|bearer)[-_a-z0-9]{0,8}[-_a-z0-9]{16,}\b/giu,
  /\b[A-Za-z0-9_-]{32,}\b(?=[^A-Za-z0-9_-]|$)/gu,
];

const SECRET_KEY_PATTERN = /api[-_]?key|secret|token|password|credential/iu;

export function redactString(value, home = os.homedir(), hostname = os.hostname()) {
  if (typeof value !== "string") return value;
  let redacted = value;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "[redacted-secret]");
  }
  if (home) {
    redacted = redacted.split(home).join("%USERPROFILE%");
    redacted = redacted.split(home.replace(/\\/gu, "/")).join("%USERPROFILE%");
  }
  if (hostname) {
    redacted = redacted.split(hostname).join("%HOSTNAME%");
  }
  return redacted;
}

export function redact(value, depth = 0, home = os.homedir(), hostname = os.hostname()) {
  if (depth > 12) return "[truncated-depth]";
  if (typeof value === "string") return redactString(value, home, hostname);
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, home, hostname));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        out[key] = "[redacted-key]";
        continue;
      }
      out[key] = redact(item, depth + 1, home, hostname);
    }
    return out;
  }
  return value;
}
