import assert from "node:assert/strict";
import test from "node:test";
import { extractTasksFromLines, parseModelTasks, type ExtractedTask } from "./run-domain";

const today = "2026-10-28";
const source = "Sync with Priya on the Q3 deck. She needs the revenue numbers by Friday.";
const sync: ExtractedTask = {
  title: "Sync with Priya on the Q3 deck", owner: "Priya", due_date: "2026-10-29", priority: "medium",
};
const provide: ExtractedTask = {
  title: "Provide Priya with the revenue numbers", owner: "unassigned", due_date: "2026-10-30", priority: "medium",
};

test("semantic duplicate keeps the specific title and earliest date, independent of response order", () => {
  for (const tasks of [[sync, provide], [provide, sync]]) {
    assert.deepEqual(parseModelTasks(JSON.stringify({ tasks }), today, source), [{
      title: provide.title, owner: "Priya", due_date: "2026-10-29", priority: "high",
    }]);
  }
});

test("duplicate merging preserves a known date over null and recalculates priority", () => {
  const tasks = [{ ...sync, due_date: null }, { ...provide, due_date: "2026-11-04" }];
  assert.deepEqual(parseModelTasks(JSON.stringify(tasks), today, source), [{
    title: provide.title, owner: "Priya", due_date: "2026-11-04", priority: "medium",
  }]);
});

test("duplicates with the same topic merge without source context; distinct deliverables stay separate", () => {
  const tasks = [
    { ...sync, title: "Sync with Priya on the revenue numbers" },
    provide,
    { ...provide, title: "Send Priya the revenue numbers" },
    { ...provide, title: "Provide Priya with the hiring plan" },
    { ...provide, title: "Provide Maya with the revenue numbers" },
    { ...provide, title: "Review the revenue numbers", owner: "Priya" },
  ];
  const parsed = parseModelTasks(JSON.stringify(tasks), today);
  assert.equal(parsed.length, 4);
  assert.ok(parsed.some((task) => /hiring plan/.test(task.title)));
  assert.ok(parsed.some((task) => task.owner === "Maya"));
  assert.ok(parsed.some((task) => /^Review/.test(task.title)));
});

test("shared owner alone and unrelated work on one source line never imply duplicate work", () => {
  assert.equal(parseModelTasks(JSON.stringify([sync, provide]), today,
    "Sync with Priya on the Q3 deck. Separately provide Priya with the revenue numbers.",
  ).length, 2);
  assert.equal(parseModelTasks(JSON.stringify([sync, provide]), today).length, 2);
});

test("fallback deduplicates repeated task lines and retains the earliest date", () => {
  const tasks = extractTasksFromLines([
    "- Send Priya the revenue numbers by 2026-10-30",
    "TODO: Send Priya the revenue numbers by 2026-10-30",
    "- Send Priya the revenue numbers by 2026-10-31",
    "- Send Maya the hiring plan",
  ].join("\n"), today);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].due_date, "2026-10-30");
  assert.equal(tasks[0].priority, "high");
});
