export interface ScheduledTask {
  id: string;
  name: string;
  goal: string;
  workspacePath: string;
  schedule: ScheduleSpec;
  enabled: boolean;
  lastRunAt?: string;
  lastRunStartedAt?: string;
  nextRunAt: string;
  createdAt: string;
  source: "agent" | "user";
}

export interface ScheduleSpec {
  type: "interval" | "daily" | "weekly" | "once";
  value: string;
}

export interface PendingScheduledTask {
  name: string;
  goal: string;
  workspacePath: string;
  schedule: ScheduleSpec;
}

interface ScheduledTaskEnvelope {
  version: 1;
  tasks: ScheduledTask[];
}

const STORAGE_KEY = "javis.scheduledTasks.v1";

export function loadScheduledTasks(storage: Storage): ScheduledTask[] {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const envelope: ScheduledTaskEnvelope = JSON.parse(raw);
    if (envelope.version !== 1 || !Array.isArray(envelope.tasks)) return [];
    return envelope.tasks;
  } catch {
    return [];
  }
}

export function saveScheduledTasks(
  storage: Storage,
  tasks: ScheduledTask[],
): ScheduledTask[] {
  const envelope: ScheduledTaskEnvelope = { version: 1, tasks };
  storage.setItem(STORAGE_KEY, JSON.stringify(envelope));
  return tasks;
}

export function createScheduledTask(
  pending: PendingScheduledTask,
  source: "agent" | "user",
): ScheduledTask {
  const now = new Date().toISOString();
  return {
    id: `st-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: pending.name,
    goal: pending.goal,
    workspacePath: pending.workspacePath,
    schedule: pending.schedule,
    enabled: true,
    nextRunAt: computeNextRun(pending.schedule, now) ?? now,
    createdAt: now,
    source,
  };
}

export function computeNextRun(
  schedule: ScheduleSpec,
  fromIso: string,
): string | null {
  const from = new Date(fromIso);
  switch (schedule.type) {
    case "once":
      {
        const next = new Date(schedule.value);
        if (Number.isNaN(next.getTime()) || next <= from) return null;
        return next.toISOString();
      }
    case "interval": {
      const ms = Number(schedule.value);
      if (!Number.isFinite(ms) || ms <= 0) return null;
      return new Date(from.getTime() + ms).toISOString();
    }
    case "daily": {
      const [hh, mm] = schedule.value.split(":").map(Number);
      const next = new Date(from);
      next.setHours(hh, mm, 0, 0);
      if (next <= from) next.setDate(next.getDate() + 1);
      return next.toISOString();
    }
    case "weekly": {
      const parts = schedule.value.split(" ");
      const dayMap: Record<string, number> = {
        Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
      };
      const targetDay = dayMap[parts[0]] ?? 1;
      const [hh, mm] = (parts[1] ?? "09:00").split(":").map(Number);
      const next = new Date(from);
      next.setHours(hh, mm, 0, 0);
      const currentDay = next.getDay();
      let daysAhead = targetDay - currentDay;
      if (daysAhead < 0 || (daysAhead === 0 && next <= from)) daysAhead += 7;
      next.setDate(next.getDate() + daysAhead);
      return next.toISOString();
    }
    default:
      return null;
  }
}

export function isDue(task: ScheduledTask, now: Date): boolean {
  if (!task.enabled) return false;
  if (task.lastRunStartedAt) return false;
  return new Date(task.nextRunAt) <= now;
}

export function clearStaleGuards(tasks: ScheduledTask[]): ScheduledTask[] {
  return tasks.map((t) => ({ ...t, lastRunStartedAt: undefined }));
}

export function formatSchedule(spec: ScheduleSpec): string {
  switch (spec.type) {
    case "interval": {
      const ms = Number(spec.value);
      const mins = Math.round(ms / 60000);
      return mins >= 60
        ? `Every ${Math.round(mins / 60)}h`
        : `Every ${mins}min`;
    }
    case "daily":
      return `Daily at ${spec.value}`;
    case "weekly": {
      const parts = spec.value.split(" ");
      return `Weekly ${parts[0]} ${parts[1] ?? ""}`.trim();
    }
    case "once":
      return `Once: ${new Date(spec.value).toLocaleString()}`;
    default:
      return spec.type;
  }
}
