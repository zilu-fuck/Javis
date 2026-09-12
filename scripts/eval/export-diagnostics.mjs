#!/usr/bin/env node
/**
 * Diagnostics export (F3).
 *
 * Builds a redacted support bundle from the local runtime so a user can share
 * "why did this fail" without leaking keys, prompts or the home path:
 *
 *   <out>/javis-diagnostics-<timestamp>/summary.md
 *                                            /diagnostics.json
 *                                            /audit-tail.jsonl
 *
 * Read-only. Redaction is applied to every value before it is written.
 *
 * Usage: node scripts/eval/export-diagnostics.mjs [--data-dir <dir>] [--out <dir>] [--tail <n>]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const dataDir = path.resolve(
  flag("--data-dir", process.env.JAVIS_DATA_DIR
    ?? path.join(os.homedir(), "AppData", "Roaming", "app.javis.desktop")),
);
const tailCount = Number(flag("--tail", "300"));
const outRoot = path.resolve(flag("--out", path.join(repoRoot, "docs", "qa", "diagnostics")));

// --------------------------------------------------------------- redaction
import { redact, redactString } from "./lib/redaction.mjs";

// ------------------------------------------------------------------ collect
const diagnostics = {
  generatedAt: new Date().toISOString(),
  app: {
    name: "javis",
    version: JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version,
  },
  environment: {
    platform: `${os.platform()}-${os.arch()}`,
    osRelease: os.release(),
    node: process.version,
    totalMemoryMb: Math.round(os.totalmem() / 1048576),
  },
  dataDir,
  inputs: {},
  storage: null,
  audit: null,
};

for (const file of ["task-audit.jsonl", "javis.db", "task-session.jsonl"]) {
  const full = path.join(dataDir, file);
  if (fs.existsSync(full)) {
    diagnostics.inputs[file] = { bytes: fs.statSync(full).size };
  }
}

if (fs.existsSync(path.join(dataDir, "javis.db"))) {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(dataDir, "javis.db"), { readOnly: true });
    const rows = (sql) => {
      try {
        return db.prepare(sql).all();
      } catch {
        return [];
      }
    };
    diagnostics.storage = {
      largestTables: rows(
        "SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 12",
      ).map((row) => ({ table: row.name, megabytes: Number((row.bytes / 1048576).toFixed(2)) })),
      counts: Object.fromEntries(
        ["task_history", "task_session_log", "workflow_checkpoints", "runtime_events", "approval_records", "usage_observations"]
          .map((table) => {
            const row = rows(`SELECT COUNT(*) AS count FROM ${table}`)[0];
            return [table, row?.count ?? null];
          }),
      ),
    };
    db.close();
  } catch (error) {
    diagnostics.storage = { error: error instanceof Error ? error.message : String(error) };
  }
}

const auditTail = [];
const auditPath = path.join(dataDir, "task-audit.jsonl");
if (fs.existsSync(auditPath)) {
  const lines = fs.readFileSync(auditPath, "utf8").split(/\r?\n/).filter((line) => line.trim());
  for (const line of lines.slice(-tailCount)) {
    try {
      auditTail.push(redact(JSON.parse(line)));
    } catch {
      auditTail.push({ unparsable: redactString(line.slice(0, 400)) });
    }
  }
  diagnostics.audit = { totalLines: lines.length, exportedLines: auditTail.length };
}

// ------------------------------------------------------------------- output
const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
const outDir = path.join(outRoot, `javis-diagnostics-${stamp}`);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "diagnostics.json"), `${JSON.stringify(diagnostics, null, 2)}\n`, "utf8");
fs.writeFileSync(
  path.join(outDir, "audit-tail.jsonl"),
  `${auditTail.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  "utf8",
);

const summary = [
  "# Javis diagnostics bundle",
  "",
  `- generated: ${diagnostics.generatedAt}`,
  `- version: ${diagnostics.app.version}`,
  `- environment: ${diagnostics.environment.platform} · node ${diagnostics.environment.node} · ${diagnostics.environment.totalMemoryMb} MB RAM`,
  `- data dir: \`${diagnostics.dataDir.replace(os.homedir(), "%USERPROFILE%")}\``,
  "",
  "## Inputs",
  "",
  ...Object.entries(diagnostics.inputs).map(([file, meta]) => `- ${file}: ${(meta.bytes / 1048576).toFixed(2)} MB`),
  "",
  "## Storage",
  "",
  ...(diagnostics.storage?.error
    ? [`- unavailable: ${diagnostics.storage.error}`]
    : [
        ...Object.entries(diagnostics.storage?.counts ?? {}).map(([table, count]) => `- ${table}: ${count} rows`),
        "",
        "| table | MB |",
        "| --- | --- |",
        ...(diagnostics.storage?.largestTables ?? []).map((row) => `| ${row.table} | ${row.megabytes} |`),
      ]),
  "",
  "## Audit log",
  "",
  `- exported ${diagnostics.audit?.exportedLines ?? 0} of ${diagnostics.audit?.totalLines ?? 0} lines (secrets, keys and the home path redacted)`,
  "",
].join("\n");
fs.writeFileSync(path.join(outDir, "summary.md"), summary, "utf8");

console.log(summary);
console.log(`diagnostics: bundle written to ${outDir}`);
