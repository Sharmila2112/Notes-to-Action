import type { ExtractedTask } from "./run-domain";
import { normalizeTask } from "./task-rules";

const genericAction = /^(?:sync|meet|meeting|lunch|discuss|talk|follow up|check in)\b/i;
const stopWords = new Set([
  "a", "an", "the", "and", "or", "to", "with", "for", "on", "of", "in", "about",
  "by", "at", "from", "due", "needs", "need", "she", "he", "they", "her", "his", "their",
  "sync", "meet", "meeting", "lunch", "discuss", "talk", "follow", "up", "check",
  "provide", "send", "give", "share", "deliver",
]);

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function topics(task: ExtractedTask): Set<string> {
  const ownerWords = new Set(words(task.owner));
  const withoutDates = task.title.replace(/\b\d{4}-\d{2}-\d{2}\b/g, "");
  return new Set(words(withoutDates).filter((word) => !stopWords.has(word) && !ownerWords.has(word)));
}

function overlap(a: Set<string>, b: Set<string>): number {
  return [...a].filter((word) => b.has(word)).length;
}

function action(title: string): string {
  if (genericAction.test(title)) return "conversation";
  if (/^(?:provide|send|give|share|deliver)\b/i.test(title)) return "provide";
  return words(title)[0] ?? "";
}

type LinkedContext = { background: Set<string>; detail: Set<string> };

function duplicates(a: ExtractedTask, b: ExtractedTask, contexts: LinkedContext[]): boolean {
  if (a.owner.toLowerCase() !== b.owner.toLowerCase()) return false;
  if (words(a.title).join(" ") === words(b.title).join(" ")) return true;
  const aTopics = topics(a);
  const bTopics = topics(b);
  const shared = overlap(aTopics, bTopics);
  const sameAction = action(a.title) === action(b.title);
  if (sameAction && shared >= 2 && shared / new Set([...aTopics, ...bTopics]).size >= 0.7) return true;
  // A generic discussion and its specific deliverable can be the same work.
  // Never merge unrelated work just because it has the same owner.
  if (a.owner.toLowerCase() === "unassigned" || genericAction.test(a.title) === genericAction.test(b.title)) return false;
  if (shared >= 2 && shared / Math.min(aTopics.size, bTopics.size) >= 0.7) return true;
  const background = genericAction.test(a.title) ? aTopics : bTopics;
  const detail = genericAction.test(a.title) ? bTopics : aTopics;
  return contexts.some((context) =>
    overlap(background, context.background) >= 2 && overlap(detail, context.detail) >= 2 &&
    overlap(background, context.background) / background.size >= 0.7 &&
    overlap(detail, context.detail) / detail.size >= 0.7,
  );
}

export function mergeDuplicateTasks(
  tasks: ExtractedTask[],
  referenceDate: string,
  source = "",
): ExtractedTask[] {
  // Only a short source line with a pronoun-linked second sentence is evidence
  // that a generic discussion refers to a differently worded deliverable.
  const contexts = source.split(/\r?\n/).filter((line) => line.length <= 300)
    .flatMap((line): LinkedContext[] => {
      const parts = line.split(/(?<=[.!?])\s+(?=(?:she|he|they)\b)/i);
      return parts.length === 2
        ? [{ background: new Set(words(parts[0])), detail: new Set(words(parts[1])) }]
        : [];
    });
  const result: ExtractedTask[] = [];
  for (const task of tasks) {
    const index = result.findIndex((existing) => duplicates(existing, task, contexts));
    if (index < 0) {
      result.push({ ...task });
      continue;
    }
    const existing = result[index];
    const specificity = (item: ExtractedTask) =>
      (genericAction.test(item.title) ? 0 : 1000) + topics(item).size * 10 + item.title.length / 1000;
    const preferred = specificity(task) > specificity(existing) ? task : existing;
    const dueDate = [existing.due_date, task.due_date].filter((date): date is string => date !== null).sort()[0] ?? null;
    result[index] = normalizeTask({ ...preferred, due_date: dueDate }, referenceDate);
  }
  return result;
}
