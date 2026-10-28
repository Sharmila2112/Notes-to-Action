import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { GetRunEventsResponse, GetRunResponse } from "@workspace/api-zod";
import { transitionRunStatus, type ExtractedTask, type RunStatus } from "./run-domain";
import { createRunService, type RunServiceDependencies } from "./run-service";

// A regression must never silently turn this suite into billable model calls.
const network = mock.method(globalThis, "fetch", async () => {
  throw new Error("Network access is forbidden in extraction service tests");
});
after(() => {
  const calls = network.mock.callCount();
  network.mock.restore();
  assert.equal(calls, 0, "Service tests must not make network requests");
});

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const INPUT = "  Meeting notes\n- Send recap\nTODO: Book room\nKeep this original spacing.  ";
const VALID = '{"tasks":[{"title":"Send recap","owner":"Lee","due_date":"2026-11-04","priority":"high"}]}';
const TIMEOUT = Symbol("timeout");
type Completion = Awaited<ReturnType<RunServiceDependencies["createCompletion"]>>;
type Outcome = string | Error | Completion | typeof TIMEOUT;
type StoredEvent = {
  id: string;
  run_id: string;
  sequence: number;
  step: Parameters<RunServiceDependencies["writeEvent"]>[1];
  status: Parameters<RunServiceDependencies["writeEvent"]>[2];
  timestamp: string;
  duration_ms: number;
  detail: string;
  attempt: number;
};

function harness(
  outcomes: Outcome[],
  options: { input?: string; roll?: number; status?: RunStatus; saveError?: Error; statusError?: Error } = {},
) {
  let clock = Date.UTC(2026, 9, 23);
  let randomCalls = 0;
  let status: RunStatus = options.status ?? "running";
  let error: string | null = null;
  let finishedAt: string | null = null;
  const events: StoredEvent[] = [];
  const tasks: ExtractedTask[] = [];
  const calls: { request: Parameters<RunServiceDependencies["createCompletion"]>[0]; signal: AbortSignal }[] = [];
  const sleeps: number[] = [];
  const timeouts: { ms: number; deadline: number; controller: AbortController }[] = [];
  const statuses: RunStatus[] = [];
  const errors: { error: unknown; message: string }[] = [];
  const startedAt = new Date(clock).toISOString();

  function advance(ms: number) {
    clock += ms;
    for (const timeout of timeouts) {
      if (timeout.deadline <= clock && !timeout.controller.signal.aborted) {
        timeout.controller.abort(new DOMException("Model request timed out", "TimeoutError"));
      }
    }
  }

  const service = createRunService({
    now: () => clock,
    random: () => { randomCalls += 1; return options.roll ?? 0.9; },
    sleep: async (ms) => { sleeps.push(ms); advance(ms); },
    timeoutSignal: (ms) => {
      const controller = new AbortController();
      timeouts.push({ ms, deadline: clock + ms, controller });
      return controller.signal;
    },
    createCompletion: async (request, { signal }) => {
      const outcome = outcomes[calls.length];
      calls.push({ request, signal });
      assert.notEqual(outcome, undefined, "Unexpected extra provider call");
      if (outcome === TIMEOUT) {
        const aborted = new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        advance(20_000);
        return aborted;
      }
      advance(7);
      if (outcome instanceof Error) throw outcome;
      return typeof outcome === "string"
        ? { choices: [{ message: { content: outcome } }] }
        : outcome as Completion;
    },
    writeEvent: async (runId, step, eventStatus, detail, duration = 0, attempt = 1) => {
      assert.equal(runId, RUN_ID);
      const sequence = events.length + 1;
      events.push({
        id: `eeeeeeee-eeee-4eee-8eee-${String(sequence).padStart(12, "0")}`,
        run_id: runId,
        sequence,
        step,
        status: eventStatus,
        timestamp: new Date(clock).toISOString(),
        duration_ms: Math.max(0, Math.round(duration)),
        detail,
        attempt,
      });
    },
    updateRunStatus: async (runId, next, message) => {
      assert.equal(runId, RUN_ID);
      if (options.statusError) throw options.statusError;
      status = transitionRunStatus(status, next);
      statuses.push(status);
      error = message;
      finishedAt = new Date(clock).toISOString();
    },
    saveTasks: async (runId, extracted) => {
      assert.equal(runId, RUN_ID);
      if (options.saveError) throw options.saveError;
      tasks.push(...structuredClone(extracted));
    },
    reportError: (cause, runId, message) => {
      assert.equal(runId, RUN_ID);
      errors.push({ error: cause, message });
    },
  });

  return {
    ...service, calls, sleeps, timeouts, events, statuses, errors,
    randomCalls: () => randomCalls,
    // Read snapshots through the same output schemas consumed by the UI.
    readRun: () => GetRunResponse.parse({
      id: RUN_ID,
      input_text: options.input ?? INPUT,
      status,
      started_at: startedAt,
      finished_at: finishedAt,
      error,
      tasks: tasks.map((task, index) => ({
        ...task, id: `dddddddd-dddd-4ddd-8ddd-${String(index + 1).padStart(12, "0")}`,
        run_id: RUN_ID, done: false,
      })),
    }),
    readEvents: () => GetRunEventsResponse.parse(structuredClone(events)),
  };
}

type Harness = ReturnType<typeof harness>;
const modelSuccess = (attempt: number) => [`call_model:started:${attempt}`, `call_model:succeeded:${attempt}`];
const modelRetry = (attempt: number) => [
  `call_model:started:${attempt}`, `call_model:failed:${attempt}`, `call_model:retrying:${attempt + 1}`,
];
const parseSuccess = (attempt: number) => [`parse_output:started:${attempt}`, `parse_output:succeeded:${attempt}`];
const invalidFirst = (nextModelAttempt: number) => [
  "parse_output:started:1", "parse_output:failed:1", `call_model:retrying:${nextModelAttempt}`,
];
const finish = ["finish_run:started:1", "finish_run:succeeded:1"];
const saved = ["save_tasks:started:1", "save_tasks:succeeded:1", ...finish];

function assertTrace(h: Harness, expected: string[]) {
  const events = h.readEvents();
  assert.deepEqual(events.map((event) => `${event.step}:${event.status}:${event.attempt}`), expected);
  assert.deepEqual(events.map((event) => event.sequence), expected.map((_, index) => index + 1));
  assert.ok(events.every((event) => event.run_id === RUN_ID && event.duration_ms >= 0));
  for (let index = 1; index < events.length; index += 1) {
    assert.ok(events[index].timestamp.getTime() >= events[index - 1].timestamp.getTime());
  }
}

function assertFailedAndReadable(h: Harness, message: string) {
  const run = h.readRun();
  assert.equal(run.id, RUN_ID);
  assert.equal(run.input_text, INPUT);
  assert.equal(run.status, "failed");
  assert.equal(run.error, message);
  assert.ok(run.finished_at);
  assert.deepEqual(run.tasks, []);
  assert.deepEqual(h.statuses, ["failed"]);
  assert.match(h.events.at(-1)!.detail, /original notes are retained/);
}

test("normal processing saves tasks and emits the diagram's complete ordered processing trace", async () => {
  const h = harness([VALID]);
  await h.processRun(RUN_ID, INPUT, false);
  assertTrace(h, [...modelSuccess(1), ...parseSuccess(1), ...saved]);
  const run = h.readRun();
  assert.equal(run.status, "succeeded");
  assert.equal(run.input_text, INPUT);
  assert.equal(run.error, null);
  assert.deepEqual(run.tasks.map(({ title, owner, due_date, priority, done }) => ({ title, owner, due_date, priority, done })), [
    { title: "Send recap", owner: "Lee", due_date: "2026-11-04", priority: "medium", done: false },
  ]);
  assert.deepEqual(h.statuses, ["succeeded"]);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.sleeps, []);
  assert.equal(h.randomCalls(), 0);
  assert.equal(h.calls[0].request.model, "gpt-5.6-terra");
  assert.deepEqual(h.calls[0].request.response_format, { type: "json_object" });
  assert.equal(h.events[1].duration_ms, 7);
});

test("demo recovery persists corrected owners and date-based priorities, including strict JSON recovery", async () => {
  const input = [
    "Sync with Priya on the Q3 deck. She needs the revenue numbers by Friday.",
    "Ravi to book the client demo for next week, not sure if Tuesday or Thursday works.",
    "Follow up with legal about the vendor contract, maybe before the board call?",
    "- Update the onboarding doc with the new pricing tiers (owner TBD, due end of month)",
    "- Someone should check whether the staging server is still running the old build",
    "Lunch with Maya on Wed to talk about the hiring plan.",
  ].join("\n");
  const staleOutput = JSON.stringify({ tasks: [
    { title: "Provide Priya with the revenue numbers", owner: "unassigned", due_date: "2026-10-30", priority: "medium" },
    { title: "Meet with Maya to discuss the hiring plan", owner: "unassigned", due_date: "2026-10-28", priority: "medium" },
    { title: "Update onboarding", owner: "unassigned", due_date: "2026-10-31", priority: "medium" },
    { title: "Ravi to book the client demo", owner: "unassigned", due_date: null, priority: "medium" },
    { title: "Check staging", owner: "unassigned", due_date: null, priority: "medium" },
    { title: "Schedule review", owner: "unassigned", due_date: "2026-11-02", priority: "medium" },
  ] });
  for (const outcomes of [[staleOutput], ["not JSON", staleOutput]]) {
    const h = harness(outcomes, { input, roll: 0 });
    await h.processRun(RUN_ID, input, true, "2026-10-28");
    assert.equal(h.readRun().status, "succeeded");
    assert.deepEqual(h.readRun().tasks.map(({ owner, priority }) => ({ owner, priority })), [
      { owner: "Priya", priority: "high" },
      { owner: "Maya", priority: "high" },
      { owner: "unassigned", priority: "high" },
      { owner: "Ravi", priority: "low" },
      { owner: "unassigned", priority: "low" },
      { owner: "unassigned", priority: "medium" },
    ]);
    assert.ok(h.events.some((event) => event.step === "call_model" && event.status === "failed" && event.detail.startsWith("(demo mode)")));
    assert.ok(h.calls.every(({ request }) => /Today is 2026-10-28/.test(request.messages[0].content)));
    assert.ok(h.calls.every(({ request }) => /3 calendar days/.test(request.messages[0].content)));
  }
});

test("a provider error retries once after 350ms with the same prompt and a fresh timeout signal", async () => {
  const h = harness([new Error("Provider unavailable"), VALID]);
  await h.processRun(RUN_ID, INPUT, false);
  assertTrace(h, [...modelRetry(1), ...modelSuccess(2), ...parseSuccess(1), ...saved]);
  assert.deepEqual(h.sleeps, [350]);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[0].request, h.calls[1].request);
  assert.notEqual(h.calls[0].signal, h.calls[1].signal);
  assert.deepEqual(h.timeouts.map(({ ms }) => ms), [20_000, 20_000]);
  assert.equal(h.readRun().status, "succeeded");
});

test("an aborted 20-second request retries successfully without any wall-clock wait", async () => {
  const h = harness([TIMEOUT, VALID]);
  await h.processRun(RUN_ID, INPUT, false);
  assertTrace(h, [...modelRetry(1), ...modelSuccess(2), ...parseSuccess(1), ...saved]);
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.calls[1].signal.aborted, false);
  assert.equal(h.events[1].duration_ms, 20_000);
  assert.match(h.events[1].detail, /timed out/);
  assert.deepEqual(h.sleeps, [350]);
  assert.equal(h.readRun().status, "succeeded");
});

for (const [name, outcomes, message] of [
  ["provider errors", [new Error("first failure"), new Error("Provider unavailable")], "Provider unavailable"],
  ["timeouts", [TIMEOUT, TIMEOUT], "Model request timed out"],
] as const) {
  test(`two ${name} stop retries, mark failed, and preserve readable original input and events`, async () => {
    const h = harness([...outcomes]);
    await h.processRun(RUN_ID, INPUT, false);
    assertTrace(h, [
      ...modelRetry(1), "call_model:started:2", "call_model:failed:2", ...finish,
    ]);
    assertFailedAndReadable(h, message);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.sleeps, [350]);
    assert.equal(h.errors.length, 1);
    assert.ok(!h.events.some((event) => event.step === "parse_output" || event.step === "save_tasks"));
  });
}

for (const empty of [
  { choices: [] },
  { choices: [{ message: { content: null } }] },
  { choices: [{ message: { content: "" } }] },
]) {
  test(`an empty provider response (${JSON.stringify(empty)}) is a model-call error and is retried`, async () => {
    const h = harness([empty, VALID]);
    await h.processRun(RUN_ID, INPUT, false);
    assertTrace(h, [...modelRetry(1), ...modelSuccess(2), ...parseSuccess(1), ...saved]);
    assert.equal(h.events[1].detail, "Model returned an empty response.");
    assert.equal(h.calls.length, 2);
    assert.equal(h.readRun().status, "succeeded");
  });
}

test("demo mode fails inside the call path once, prefixes its details, and never simulates again on strict retry", async () => {
  const h = harness(["invalid json", VALID], { roll: 0 });
  await h.processRun(RUN_ID, INPUT, true);
  assertTrace(h, [
    ...modelRetry(1), ...modelSuccess(2), ...invalidFirst(3),
    ...modelSuccess(3), ...parseSuccess(2), ...saved,
  ]);
  assert.equal(h.randomCalls(), 1);
  assert.equal(h.calls.length, 2, "The injected first attempt must not call the provider");
  assert.ok(h.events.slice(1, 3).every((event) => event.detail.startsWith("(demo mode)")));
  assert.equal(h.readRun().status, "succeeded");
});

test("demo mode's 0.5 boundary does not fail, and disabled demo mode never samples randomness", async () => {
  for (const [enabled, roll, expectedSamples] of [[true, 0.5, 1], [false, 0, 0]] as const) {
    const h = harness([VALID], { roll });
    await h.processRun(RUN_ID, INPUT, enabled);
    assertTrace(h, [...modelSuccess(1), ...parseSuccess(1), ...saved]);
    assert.equal(h.calls.length, 1);
    assert.equal(h.randomCalls(), expectedSamples);
    assert.ok(h.events.every((event) => !event.detail.includes("(demo mode)")));
  }
});

test("invalid JSON retries with a stricter prompt while keeping the original notes intact", async () => {
  const h = harness(["```not JSON```", VALID]);
  await h.processRun(RUN_ID, INPUT, false);
  assertTrace(h, [
    ...modelSuccess(1), ...invalidFirst(2), ...modelSuccess(2), ...parseSuccess(2), ...saved,
  ]);
  assert.match(h.calls[0].request.messages[0].content, /^Extract actionable tasks/);
  assert.match(h.calls[1].request.messages[0].content, /^Return exactly one valid JSON object/);
  assert.ok(h.calls.every(({ request }) => request.messages[0].content.endsWith(INPUT)));
  assert.equal(h.readRun().status, "succeeded");
  assert.deepEqual(h.sleeps, [], "A stricter prompt is not a transport-error backoff");
});

test("transport retries and stricter JSON retries keep globally increasing model attempt numbers", async () => {
  const h = harness([new Error("initial error"), "invalid", new Error("strict error"), VALID]);
  await h.processRun(RUN_ID, INPUT, false);
  assertTrace(h, [
    ...modelRetry(1), ...modelSuccess(2), ...invalidFirst(3),
    ...modelRetry(3), ...modelSuccess(4), ...parseSuccess(2), ...saved,
  ]);
  assert.deepEqual(h.sleeps, [350, 350]);
  assert.deepEqual(h.events.filter((event) => event.step === "call_model" && event.status === "retrying").map((event) => event.attempt), [2, 3, 4]);
  assert.equal(h.readRun().status, "succeeded");
});

for (const [name, input, expectedTitles] of [
  ["matching task lines", INPUT, ["Send recap", "Book room"]],
  ["no matching task lines", "Discussion only. No tasks here.", []],
] as const) {
  test(`two invalid responses record fallback, save ${name}, and complete successfully`, async () => {
    const h = harness(["not JSON", '{"tasks":[{"title":"","priority":"urgent"}]}'], { input });
    await h.processRun(RUN_ID, input, false);
    assertTrace(h, [
      ...modelSuccess(1), ...invalidFirst(2), ...modelSuccess(2),
      "parse_output:started:2", "parse_output:failed:2", "parse_output:retrying:3",
      "parse_output:succeeded:3", ...saved,
    ]);
    assert.equal(h.calls.length, 2, "Fallback must not make a third model request");
    const fallback = h.events.filter((event) => event.step === "parse_output" && event.attempt === 3);
    assert.match(fallback[0].detail, /line-based fallback/);
    assert.match(fallback[1].detail, new RegExp(`Fallback extracted ${expectedTitles.length} task`));
    const run = h.readRun();
    assert.equal(run.status, "succeeded");
    assert.equal(run.input_text, input);
    assert.equal(run.error, null);
    assert.deepEqual(run.tasks.map((task) => task.title), expectedTitles);
    assert.ok(run.tasks.every((task) => task.owner === "unassigned" && task.due_date === null && task.priority === "low"));
  });
}

test("exhausted stricter-request transport errors fail the run rather than claiming a parsed fallback", async () => {
  const h = harness(["invalid", new Error("strict error"), new Error("strict unavailable")]);
  await h.processRun(RUN_ID, INPUT, false);
  assertTrace(h, [
    ...modelSuccess(1), ...invalidFirst(2), ...modelRetry(2),
    "call_model:started:3", "call_model:failed:3", ...finish,
  ]);
  assertFailedAndReadable(h, "strict unavailable");
  assert.equal(h.calls.length, 3);
  assert.ok(!h.events.some((event) => event.detail.includes("line-based fallback")));
});

test("a task save failure is recorded and does not spend another model attempt", async () => {
  const h = harness([VALID], { saveError: new Error("Storage unavailable") });
  await h.processRun(RUN_ID, INPUT, false);
  assertTrace(h, [
    ...modelSuccess(1), ...parseSuccess(1), "save_tasks:started:1", "save_tasks:failed:1", ...finish,
  ]);
  assertFailedAndReadable(h, "Storage unavailable");
  assert.equal(h.calls.length, 1);
  assert.match(h.events.find((event) => event.step === "save_tasks" && event.status === "failed")!.detail, /Could not save tasks/);
});

test("finishing an invalid pending run preserves its input without invoking the provider", async () => {
  const h = harness([], { status: "pending" });
  await h.finishRun(RUN_ID, "failed", "Input was rejected");
  assertTrace(h, finish);
  assertFailedAndReadable(h, "Input was rejected");
  assert.equal(h.calls.length, 0);
});

test("status-storage failure records failed finalization and reports the terminal-write failure", async () => {
  const h = harness([new Error("provider error"), new Error("provider error")], {
    statusError: new Error("Status storage unavailable"),
  });
  await h.processRun(RUN_ID, INPUT, false);
  assertTrace(h, [
    ...modelRetry(1), "call_model:started:2", "call_model:failed:2",
    "finish_run:started:1", "finish_run:failed:1",
  ]);
  assert.equal(h.errors.length, 2);
  assert.equal(h.errors[1].message, "Could not mark failed run as terminal");
  assert.equal(h.readRun().input_text, INPUT);
  assert.equal(h.readRun().status, "running", "A failed write must not claim a stored terminal state");
});
