import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { createRunService, type RunServiceDependencies } from "./run-service";
import { HEARTBEAT_MS } from "./run-lease";

const network = mock.method(globalThis, "fetch", async () => {
  throw new Error("Lease service tests must never contact a model");
});
after(() => {
  const calls = network.mock.callCount();
  network.mock.restore();
  assert.equal(calls, 0);
});

function harness(renewLease: NonNullable<RunServiceDependencies["renewLease"]>) {
  let tick: () => void = () => {};
  let stopped = false;
  let providerCalls = 0;
  let saved = 0;
  const statuses: string[] = [];
  const events: string[] = [];
  let complete: (value: { choices: { message: { content: string } }[] }) => void = () => {};
  let started: () => void = () => {};
  const providerStarted = new Promise<void>((resolve) => { started = resolve; });
  let requestSignal: AbortSignal | undefined;
  const service = createRunService({
    renewLease,
    heartbeat: (callback, ms) => {
      assert.equal(ms, HEARTBEAT_MS);
      tick = callback;
      return () => { stopped = true; };
    },
    writeEvent: async (_id, step, status) => { events.push(`${step}:${status}`); },
    updateRunStatus: async (_id, status) => { statuses.push(status); },
    saveTasks: async () => { saved += 1; },
    createCompletion: async (_request, { signal }) => {
      requestSignal = signal;
      providerCalls += 1;
      started();
      return new Promise((resolve, reject) => {
        complete = resolve;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
    reportError: () => {},
    timeoutSignal: () => new AbortController().signal,
  });
  return {
    ...service, providerStarted, statuses, events,
    tick: () => tick(), stopped: () => stopped, calls: () => providerCalls,
    saved: () => saved, signal: () => requestSignal,
    complete: () => complete({ choices: [{ message: { content: '{"tasks":[]}' } }] }),
  };
}

test("a lost lease before execution makes zero model calls", async () => {
  const h = harness(async () => false);
  await h.processRun("run", "Original notes", false);
  assert.equal(h.calls(), 0);
  assert.equal(h.saved(), 0);
  assert.deepEqual(h.statuses, []);
  assert.deepEqual(h.events, []);
  assert(h.stopped());
});

for (const failure of ["lease expired", "database unavailable"]) {
  test(`${failure} during a model call aborts without a paid retry or late writes`, async () => {
    let renewals = 0;
    const h = harness(async () => {
      if (++renewals === 1) return true;
      if (failure === "database unavailable") throw new Error("Database unavailable");
      return false;
    });
    const processing = h.processRun("run", "Original notes", false);
    await h.providerStarted;
    h.tick();
    await processing;
    assert(h.signal()?.aborted);
    assert.equal(h.calls(), 1);
    assert.equal(h.saved(), 0);
    assert.deepEqual(h.statuses, []);
    assert.deepEqual(h.events, ["call_model:started"]);
    assert(h.stopped());
  });
}

test("healthy heartbeats preserve active processing and stop when work completes", async () => {
  let renewals = 0;
  let finishRenewal: (active: boolean) => void = () => {};
  const h = harness(async () => {
    renewals += 1;
    if (renewals === 1) return true;
    return new Promise<boolean>((resolve) => { finishRenewal = resolve; });
  });
  const processing = h.processRun("run", "Original notes", false);
  await h.providerStarted;
  h.tick();
  h.tick(); // Do not overlap a pending heartbeat.
  assert.equal(renewals, 2);
  finishRenewal(true);
  h.complete();
  await processing;
  assert.equal(h.calls(), 1);
  assert.equal(h.saved(), 1);
  assert.deepEqual(h.statuses, ["succeeded"]);
  assert(!h.signal()?.aborted);
  assert(h.stopped());
});
