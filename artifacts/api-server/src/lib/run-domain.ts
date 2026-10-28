import { calendarDate, isValidDateOnly, normalizeTask } from "./task-rules";
import { mergeDuplicateTasks } from "./task-dedup";

export const taskPriorities = ["low", "medium", "high"] as const;
export type TaskPriority = (typeof taskPriorities)[number];

export type ExtractedTask = {
  title: string;
  owner: string;
  due_date: string | null;
  priority: TaskPriority;
};

export type RunStatus = "pending" | "running" | "succeeded" | "failed";

const allowedTransitions: Record<RunStatus, readonly RunStatus[]> = {
  pending: ["running", "failed"],
  running: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
};

export function transitionRunStatus(
  current: RunStatus,
  next: RunStatus,
): RunStatus {
  if (!allowedTransitions[current].includes(next)) {
    throw new Error(`Invalid run status transition: ${current} -> ${next}`);
  }
  return next;
}

export function parseModelTasks(content: string, referenceDate = calendarDate(), input = ""): ExtractedTask[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(content);
  } catch {
    throw new Error("Model returned invalid JSON");
  }

  const rawTasks = Array.isArray(decoded)
    ? decoded
    : decoded && typeof decoded === "object" && "tasks" in decoded
      ? (decoded as { tasks: unknown }).tasks
      : null;
  if (!Array.isArray(rawTasks)) {
    throw new Error("Model JSON must be an array or an object containing a tasks array");
  }

  const tasks = rawTasks.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error(`Task ${index + 1} must be an object`);
    }
    const task = candidate as Record<string, unknown>;
    if (typeof task.title !== "string" || !task.title.trim()) {
      throw new Error(`Task ${index + 1} is missing a title`);
    }
    if (
      typeof task.priority !== "string" ||
      !taskPriorities.includes(task.priority as TaskPriority)
    ) {
      throw new Error(`Task ${index + 1} has an invalid priority`);
    }

    const owner =
      typeof task.owner === "string" && task.owner.trim()
        ? task.owner.trim()
        : "unassigned";
    const dueDate =
      typeof task.due_date === "string" && isValidDateOnly(task.due_date)
        ? task.due_date
        : null;

    return normalizeTask({
      title: task.title.trim(),
      owner,
      due_date: dueDate,
      priority: task.priority as TaskPriority,
    }, referenceDate);
  });
  return mergeDuplicateTasks(tasks, referenceDate, input);
}

export function extractTasksFromLines(input: string, referenceDate = calendarDate()): ExtractedTask[] {
  const taskPrefix = /^\s*(?:[-*]\s+|TODO\b(?:\s*[:—-]\s*|\s+)?|\[\s*\]\s*)/i;
  const tasks = input
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(taskPrefix);
      return match ? line.slice(match[0].length).trim() : "";
    })
    .filter(Boolean)
    .map((title) => normalizeTask({
      title,
      owner: "unassigned",
      due_date: null,
      priority: "low",
    }, referenceDate));
  return mergeDuplicateTasks(tasks, referenceDate, input);
}
