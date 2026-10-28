import assert from "node:assert/strict";
import test from "node:test";
import {
  extractTasksFromLines,
  parseModelTasks,
  transitionRunStatus,
} from "./run-domain.ts";

test("task validator normalizes optional fields and rejects missing titles or invalid priorities", () => {
  assert.deepEqual(
    parseModelTasks(
      JSON.stringify([
        {
          title: "  Send recap  ",
          owner: "  Lee ",
          due_date: "2026-11-04",
          priority: "high",
        },
        { title: "Book room", priority: "medium", due_date: "not-a-date" },
      ]), "2026-10-28",
    ),
    [
      {
        title: "Send recap",
        owner: "Lee",
        due_date: "2026-11-04",
        priority: "medium",
      },
      {
        title: "Book room",
        owner: "unassigned",
        due_date: null,
        priority: "low",
      },
    ],
  );
  assert.throws(() => parseModelTasks('[{"title":"","priority":"low"}]'), /missing a title/);
  assert.throws(
    () => parseModelTasks('[{"title":"Ship it","priority":"urgent"}]'),
    /invalid priority/,
  );
  assert.throws(() => parseModelTasks("not json"), /invalid JSON/);
});

test("line fallback extracts only the supported task prefixes", () => {
  assert.deepEqual(
    extractTasksFromLines(
      "Discuss launch\n- Send recap\n* Confirm owner\nTODO: Book room\n[ ] Share deck\n[done] Ignore",
    ).map((task) => task.title),
    ["Send recap", "Confirm owner", "Book room", "Share deck"],
  );
});

test("parse enforces named participants and date-based priorities as of October 28", () => {
  const tasks = parseModelTasks(JSON.stringify({ tasks: [
    { title: "Provide Priya with the revenue numbers", owner: "unassigned", due_date: "2026-10-30", priority: "medium" },
    { title: "Meet with Maya to discuss the hiring plan", owner: "", due_date: "2026-10-28", priority: "medium" },
    { title: "Update onboarding", owner: "unassigned", due_date: "2026-10-31", priority: "medium" },
    { title: "Ravi to book the client demo", owner: "unassigned", due_date: "2026-11-01", priority: "high" },
    { title: "Follow up with legal", owner: "unassigned", due_date: null, priority: "medium" },
    { title: "Check staging", owner: "unassigned", due_date: "2026-02-30", priority: "high" },
    { title: "Overdue recap", owner: "Lee", due_date: "2026-10-27", priority: "low" },
  ] }), "2026-10-28");
  assert.deepEqual(tasks.map(({ owner, priority }) => ({ owner, priority })), [
    { owner: "Priya", priority: "high" },
    { owner: "Maya", priority: "high" },
    { owner: "unassigned", priority: "high" },
    { owner: "Ravi", priority: "medium" },
    { owner: "unassigned", priority: "low" },
    { owner: "unassigned", priority: "low" },
    { owner: "Lee", priority: "high" },
  ]);
});

test("fallback applies the same owner and priority rules and does not invent ambiguous deadlines", () => {
  const tasks = extractTasksFromLines([
    "- Provide Priya with the revenue numbers by Friday",
    "TODO: Meet with Maya on Wed to discuss the hiring plan",
    "[ ] Update onboarding, due end of month",
    "- Ravi to book the demo on 2026-11-02",
    "- Send the recap",
    "- Meet with Maya next week, not sure if Tuesday or Thursday works",
  ].join("\n"), "2026-10-28");
  assert.deepEqual(tasks.map(({ owner, due_date, priority }) => ({ owner, due_date, priority })), [
    { owner: "Priya", due_date: "2026-10-30", priority: "high" },
    { owner: "Maya", due_date: "2026-10-28", priority: "high" },
    { owner: "unassigned", due_date: "2026-10-31", priority: "high" },
    { owner: "Ravi", due_date: "2026-11-02", priority: "medium" },
    { owner: "unassigned", due_date: null, priority: "low" },
    { owner: "Maya", due_date: null, priority: "low" },
  ]);
  assert.throws(() => parseModelTasks('[{"title":"Recap","priority":"low"}]', "2026-02-30"), /reference date/);
});

test("run status transitions allow pending/running completion and reject terminal changes", () => {
  assert.equal(transitionRunStatus("pending", "running"), "running");
  assert.equal(transitionRunStatus("pending", "failed"), "failed");
  assert.equal(transitionRunStatus("running", "succeeded"), "succeeded");
  assert.equal(transitionRunStatus("running", "failed"), "failed");
  assert.throws(() => transitionRunStatus("pending", "succeeded"), /Invalid run status/);
  assert.throws(() => transitionRunStatus("succeeded", "running"), /Invalid run status/);
  assert.throws(() => transitionRunStatus("failed", "succeeded"), /Invalid run status/);
});
