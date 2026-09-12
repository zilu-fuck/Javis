#!/usr/bin/env node
/**
 * Runtime metrics reporter (F2).
 *
 * Reads the *real* local runtime data — the task audit JSONL and the SQLite
 * database — and produces the north-star metrics that say whether the harness is
 * actually getting better: task success rate, latency percentiles, failure
 * taxonomy, per-tool failure rate, storage growth and token/cache usage.
 *
 * Read-only. Never mutates the database.
 *
 * Usage:
 *   node scripts/eval/report-runtime-metrics.mjs [--data-dir <dir>] [--json]
 * Default data dir: %APPDATA%/app.javis.desktop (override with JAVIS_DATA_DIR).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const dataDirFlagIndex = args.indexOf("--data-dir");
const dataDir = dataDirFlagIndex >= 0
  ? path.resolve(args[dataDirFlagIndex + 1])
  : process.env.JAVIS_DATA_DIR
    ?? path.join(os.homedir(), "AppData", "Roaming", "app.javis.desktop");
const jsonOnly = args.includes("--json");

const auditPath = path.join(dataDir, "task-audit.jsonl");
const dbPath = path.join(dataDir, "javis.db");

const report = {
  generatedAt: new Date().toISOString(),
  dataDir,
  inputs: {
    auditLog: fs.existsSync(auditPath) ? { path: auditPath, bytes: fs.statSync(auditPath).size } : null,
    database: fs.existsSync(dbPath) ? { path: dbPath, bytes: fs.statSync(dbPath).size } : null,
  },
  audit: null,
  storage: null,
  usage: null,
};

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index];
}

// ---------------------------------------------------------------- audit log
if (report.inputs.auditLog) {
  const lines = fs.readFileSync(auditPath, "utf8").split(/\r?\n/).filter((line) => line.trim());
  const byKind = new Map();
  const agentFailures = new Map();
  const toolFailures = new Map();
  const tasks = new Map();
  const byDay = new Map();

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const kind = entry.kind ?? "unknown";
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    const day = String(entry.recordedAt ?? "").slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);

    const record = entry.record ?? {};
    if (typeof record.taskId === "string") {
      const current = tasks.get(record.taskId) ?? {
        first: entry.recordedAt,
        last: entry.recordedAt,
        failed: false,
        cancelled: false,
        completed: false,
      };
      current.last = entry.recordedAt;
      if (record.status === "failed") current.failed = true;
      if (record.status === "cancelled") current.cancelled = true;
      if (record.status === "completed") current.completed = true;
      tasks.set(record.taskId, current);
    }
    if (kind === "agent_run_audit" && record.status === "failed") {
      const reason = String(record.task ?? "").replace(/\s+/g, " ").trim() || "<no reason>";
      agentFailures.set(reason, (agentFailures.get(reason) ?? 0) + 1);
    }
    if (kind === "tool_call_audit" && record.status === "failed") {
      const tool = record.toolName ?? "<unknown tool>";
      toolFailures.set(tool, (toolFailures.get(tool) ?? 0) + 1);
    }
  }

  const durations = [...tasks.values()]
    .map((task) => (Date.parse(task.last) - Date.parse(task.first)) / 1000)
    .filter((seconds) => Number.isFinite(seconds) && seconds >= 0)
    .sort((left, right) => left - right);

  const failedTasks = [...tasks.values()].filter((task) => task.failed).length;
  report.audit = {
    lines: lines.length,
    byKind: Object.fromEntries([...byKind.entries()].sort((a, b) => b[1] - a[1])),
    tasks: {
      observed: tasks.size,
      failed: failedTasks,
      failureRate: tasks.size === 0 ? 0 : Number((failedTasks / tasks.size).toFixed(4)),
      durationSeconds: {
        p50: Math.round(percentile(durations, 0.5)),
        p95: Math.round(percentile(durations, 0.95)),
        max: Math.round(durations[durations.length - 1] ?? 0),
      },
    },
    agentFailures: [...agentFailures.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
    toolFailures: [...toolFailures.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
    activityByDay: Object.fromEntries([...byDay.entries()].sort()),
  };
}

// ----------------------------------------------------------------- database
if (report.inputs.database) {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = (sql) => {
      try {
        return db.prepare(sql).all();
      } catch {
        return [];
      }
    };

    const taskHistory = rows(
      "SELECT status, COUNT(*) AS count FROM task_history GROUP BY status ORDER BY count DESC",
    );
    const tableSizes = rows(
      "SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 12",
    );
    const usage = rows(
      `SELECT COUNT(*) AS calls, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
              SUM(total_tokens) AS total_tokens, COUNT(DISTINCT task_id) AS tasks,
              COUNT(DISTINCT provider) AS providers
       FROM usage_observations`,
    );
    db.close();

    report.storage = {
      taskHistoryByStatus: Object.fromEntries(taskHistory.map((row) => [row.status, row.count])),
      largestTables: tableSizes.map((row) => ({
        table: row.name,
        megabytes: Number((row.bytes / 1048576).toFixed(1)),
      })),
    };
    report.usage = usage[0] ?? null;
  } catch (error) {
    report.storage = { error: error instanceof Error ? error.message : String(error) };
  }
}

// ------------------------------------------------------------------ output
if (jsonOnly) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const lines = [
    "# Runtime metrics",
    "",
    `- generated: ${report.generatedAt}`,
    `- data dir: \`${dataDir}\``,
  ];
  if (report.inputs.database) {
    lines.push(`- database: **${(report.inputs.database.bytes / 1048576).toFixed(1)} MB**`);
  }
  if (report.audit) {
    const { tasks, agentFailures, toolFailures, byKind } = report.audit;
    lines.push(
      "",
      "## Tasks",
      "",
      `- observed: **${tasks.observed}** · failed **${tasks.failed}** · failure rate **${(tasks.failureRate * 100).toFixed(1)}%**`,
      `- duration: p50 **${tasks.durationSeconds.p50}s** · p95 **${tasks.durationSeconds.p95}s** · max ${tasks.durationSeconds.max}s`,
      `- audit lines: ${report.audit.lines} (${Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join(", ")})`,
      "",
      "## Top agent failure reasons",
      "",
      ...(agentFailures.length === 0
        ? ["- none"]
        : agentFailures.map(([reason, count]) => `- ${count}× ${reason}`)),
      "",
      "## Top failing tools",
      "",
      ...(toolFailures.length === 0
        ? ["- none"]
        : toolFailures.map(([tool, count]) => `- ${count}× \`${tool}\``)),
    );
  }
  if (report.storage && !report.storage.error) {
    lines.push(
      "",
      "## Storage",
      "",
      `- task history: ${Object.entries(report.storage.taskHistoryByStatus).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`,
      "",
      "| table | MB |",
      "| --- | --- |",
      ...report.storage.largestTables.map((row) => `| ${row.table} | ${row.megabytes} |`),
    );
  }
  if (report.usage) {
    lines.push(
      "",
      "## Model usage observations",
      "",
      `- calls: ${report.usage.calls ?? 0} · tasks: ${report.usage.tasks ?? 0} · providers: ${report.usage.providers ?? 0}`,
      `- tokens: input ${report.usage.input_tokens ?? 0} · output ${report.usage.output_tokens ?? 0} · total ${report.usage.total_tokens ?? 0}`,
    );
  }
  if (report.storage?.error) {
    lines.push("", `> storage metrics unavailable: ${report.storage.error}`);
  }

  const date = new Date().toISOString().slice(0, 10);
  const dir = path.join(process.cwd(), "docs", "qa", "eval", date);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "runtime-metrics.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(dir, "runtime-metrics.md"), `${lines.join("\n")}\n`, "utf8");
  console.log(lines.join("\n"));
  console.log(`\nmetrics: report written to docs/qa/eval/${date}/runtime-metrics.{json,md}`);
}
