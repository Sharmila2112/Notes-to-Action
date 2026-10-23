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
      ]),
    ),
    [
      {
        title: "Send recap",
        owner: "Lee",
        due_date: "2026-11-04",
        priority: "high",
      },
      {
        title: "Book room",
        owner: "unassigned",
        due_date: null,
        priority: "medium",
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

test("run status transitions allow pending/running completion and reject terminal changes", () => {
  assert.equal(transitionRunStatus("pending", "running"), "running");
  assert.equal(transitionRunStatus("pending", "failed"), "failed");
  assert.equal(transitionRunStatus("running", "succeeded"), "succeeded");
  assert.equal(transitionRunStatus("running", "failed"), "failed");
  assert.throws(() => transitionRunStatus("pending", "succeeded"), /Invalid run status/);
  assert.throws(() => transitionRunStatus("succeeded", "running"), /Invalid run status/);
  assert.throws(() => transitionRunStatus("failed", "succeeded"), /Invalid run status/);
});
