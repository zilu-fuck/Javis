/**
 * Bounded, in-process record of tool *output* repairs (A4b).
 *
 * `repairToolSchemaValue` keeps a mistyped field from failing a whole task, but a
 * repair that nobody can see is indistinguishable from silent data loss. This log
 * makes every repair queryable and countable — the numerator of the "repair rate"
 * metric — and the executor also mirrors it into SharedTaskContext so it travels
 * with the task artifacts.
 *
 * Bounded on purpose: a runaway stream of repairs must not grow memory, and the
 * oldest entries are the least interesting.
 */
export interface ToolOutputRepairRecord {
  toolName: string;
  taskId?: string;
  stepId?: string;
  /** One note per coercion or dropped array item, as produced by the repair pass. */
  repairs: string[];
  recordedAt: string;
}

export const MAX_TOOL_OUTPUT_REPAIR_RECORDS = 200;

/** SharedTaskContext key carrying the per-task repair notes. */
export const TOOL_OUTPUT_REPAIRS_CONTEXT_KEY = "toolOutputRepairs";

/** Cap on the per-task notes mirrored into SharedTaskContext. */
export const MAX_CONTEXT_TOOL_OUTPUT_REPAIRS = 20;

const records: ToolOutputRepairRecord[] = [];

export function recordToolOutputRepair(
  record: Omit<ToolOutputRepairRecord, "recordedAt"> & { recordedAt?: string },
): ToolOutputRepairRecord {
  const entry: ToolOutputRepairRecord = {
    toolName: record.toolName,
    ...(record.taskId ? { taskId: record.taskId } : {}),
    ...(record.stepId ? { stepId: record.stepId } : {}),
    repairs: [...record.repairs],
    recordedAt: record.recordedAt ?? new Date().toISOString(),
  };
  records.push(entry);
  while (records.length > MAX_TOOL_OUTPUT_REPAIR_RECORDS) {
    records.shift();
  }
  return entry;
}

export function listToolOutputRepairs(filter?: { taskId?: string; toolName?: string }): ToolOutputRepairRecord[] {
  return records.filter((record) =>
    (filter?.taskId === undefined || record.taskId === filter.taskId)
    && (filter?.toolName === undefined || record.toolName === filter.toolName));
}

export interface ToolOutputRepairSummary {
  /** Total recorded repair events (not individual notes). */
  total: number;
  /** Total individual repairs, including dropped array items. */
  totalNotes: number;
  byTool: Record<string, number>;
  lastRecordedAt?: string;
}

export function summarizeToolOutputRepairs(): ToolOutputRepairSummary {
  const byTool: Record<string, number> = {};
  let totalNotes = 0;
  for (const record of records) {
    byTool[record.toolName] = (byTool[record.toolName] ?? 0) + 1;
    totalNotes += record.repairs.length;
  }
  const last = records[records.length - 1];
  return {
    total: records.length,
    totalNotes,
    byTool,
    ...(last ? { lastRecordedAt: last.recordedAt } : {}),
  };
}

export function resetToolOutputRepairs(): void {
  records.length = 0;
}

/**
 * Appends repair notes to the SharedTaskContext accumulator used by artifacts.
 * Returns the new accumulator value.
 */
export function appendContextToolOutputRepairs(
  context: { get<T>(key: string): T | undefined; set<T>(key: string, value: T): void },
  entry: { stepId?: string; toolName: string; repairs: string[] },
): Array<{ stepId?: string; toolName: string; repairs: string[] }> {
  const current = context.get<Array<{ stepId?: string; toolName: string; repairs: string[] }>>(
    TOOL_OUTPUT_REPAIRS_CONTEXT_KEY,
  ) ?? [];
  const next = [...current, entry].slice(-MAX_CONTEXT_TOOL_OUTPUT_REPAIRS);
  context.set(TOOL_OUTPUT_REPAIRS_CONTEXT_KEY, next);
  return next;
}
