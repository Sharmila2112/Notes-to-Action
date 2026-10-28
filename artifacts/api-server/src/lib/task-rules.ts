import type { ExtractedTask, TaskPriority } from "./run-domain";

export function calendarDate(now = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

export function isValidDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

const dayMs = 86_400_000;
const weekdays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const notPeople = /^(?:I|We|Someone|Anyone|Unassigned|Unknown|TBD|Owner|Legal|Finance|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Wed|Thu|Fri|Sat|Sun|Today|Tomorrow|January|February|March|April|May|June|July|August|September|October|November|December)$/i;
const name = String.raw`(\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+){0,2})`;
const personPatterns = [
  new RegExp(String.raw`\b(?:[Pp]rovide|[Gg]ive|[Ss]end)\s+${name}\s+(?:with|the|a|an)\b`, "u"),
  new RegExp(String.raw`\b(?:with|to|for)\s+${name}\b`, "u"),
  new RegExp(String.raw`^${name}\s+to\b`, "u"),
  new RegExp(String.raw`\bowner\s*[:=]\s*${name}\b`, "iu"),
];

function namedOwner(title: string): string | null {
  for (const pattern of personPatterns) {
    const person = title.match(pattern)?.[1];
    if (person && !notPeople.test(person)) return person;
  }
  return null;
}

function dateInTitle(title: string, referenceDate: string): string | null {
  const explicit = title.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
  if (explicit && isValidDateOnly(explicit)) return explicit;
  const reference = new Date(`${referenceDate}T00:00:00Z`);
  if (/\b(?:end of (?:the )?month|month[- ]end)\b/i.test(title)) {
    return new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  }
  if (/\btoday\b/i.test(title)) return referenceDate;
  if (/\btomorrow\b/i.test(title)) return new Date(+reference + dayMs).toISOString().slice(0, 10);
  const matches = [...title.matchAll(/\b(next\s+)?(sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)\b/gi)];
  // Multiple possible days are not a commitment to a deadline.
  if (matches.length !== 1 || /\b(?:maybe|not sure|or)\b/i.test(title)) return null;
  const target = weekdays.indexOf(matches[0][2].slice(0, 3).toLowerCase());
  let offset = (target - reference.getUTCDay() + 7) % 7;
  if (matches[0][1]) offset = offset === 0 ? 7 : offset;
  return new Date(+reference + offset * dayMs).toISOString().slice(0, 10);
}

export function priorityForDate(dueDate: string | null, referenceDate: string): TaskPriority {
  if (!dueDate) return "low";
  // Overdue work is also urgent; date-only arithmetic avoids timezone/DST shifts.
  const days = (Date.parse(`${dueDate}T00:00:00Z`) - Date.parse(`${referenceDate}T00:00:00Z`)) / dayMs;
  return days <= 3 ? "high" : "medium";
}

export function normalizeTask(
  task: ExtractedTask,
  referenceDate: string,
): ExtractedTask {
  if (!isValidDateOnly(referenceDate)) throw new Error("Invalid extraction reference date");
  const dueDate = task.due_date ?? dateInTitle(task.title, referenceDate);
  return {
    ...task,
    owner: namedOwner(task.title) ?? task.owner,
    due_date: dueDate,
    priority: priorityForDate(dueDate, referenceDate),
  };
}
