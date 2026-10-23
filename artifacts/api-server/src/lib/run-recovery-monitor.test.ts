import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import {
  createRecoveryMonitor,
  createRecoverySweep,
  RECOVERY_SUMMARY_INTERVAL_MS,
  RECOVERY_WINDOW_MS,
  type RecoveryLogRecord,
} from "./run-recovery-monitor";

const network = mock.method(globalThis, "fetch", async () => {
  throw new Error("Recovery monitoring tests must not access the network");
});
after(() => {
  const calls = network.mock.callCount();
  network.mock.restore();
  assert.equal(calls, 0);
});

function harness() {
  let clock = Date.UTC(2026, 9, 23, 12);
  const logs: { level: string; record: RecoveryLogRecord }[] = [];
  const monitor = createRecoveryMonitor({
    now: () => clock,
    emit: (level, record) => { logs.push({ level, record }); },
  });
  return {
    monitor, logs,
    advance: (ms: number) => { clock += ms; },
    alerts: () => logs.filter(({ record }) => record.event === "run_recovery_alert"),
  };
}

test("quiet recovery emits startup and five-minute summaries, not a log on every sweep", () => {
  const h = harness();
  h.monitor.recordSuccess(0);
  assert.equal(h.logs.length, 1);
  assert.equal(h.logs[0].record.event, "run_recovery_summary");
  assert.equal(h.logs[0].level, "info");
  for (let check = 0; check < 19; check += 1) {
    h.advance(15_000);
    h.monitor.recordSuccess(0);
  }
  assert.equal(h.logs.length, 1);
  h.advance(15_000);
  h.monitor.recordSuccess(0);
  assert.equal(h.logs.length, 2);
  const summary = h.monitor.getSummary();
  assert.equal(summary.health, "healthy");
  assert.equal(summary.scope, "process");
  assert.equal(summary.checks_total, 21);
  assert.equal(summary.interrupted_runs_total, 0);
  assert.equal(summary.recovery_failures_total, 0);
  assert.equal(summary.last_check_at, summary.last_success_at);
  assert.equal(summary.last_failure_at, null);
});

test("three interruptions alert, warnings are throttled, and rolling counts clear independently of totals", () => {
  const h = harness();
  h.monitor.recordSuccess(2);
  assert.equal(h.alerts().length, 0);
  h.advance(15_000);
  h.monitor.recordSuccess(1);
  assert.equal(h.alerts().length, 1);
  assert.equal(h.alerts()[0].level, "warn");
  assert.deepEqual(h.alerts()[0].record.alert_reasons, ["interruption_rate"]);
  assert.equal(h.monitor.getSummary().interrupted_runs_in_window, 3);
  h.monitor.recordSuccess(1);
  assert.equal(h.alerts().length, 1, "Do not warn again on every sweep");
  h.advance(RECOVERY_SUMMARY_INTERVAL_MS);
  h.monitor.recordSuccess(0);
  assert.equal(h.alerts().length, 2, "Sustained alerts get five-minute reminders");
  h.advance(RECOVERY_WINDOW_MS);
  h.monitor.recordSuccess(0);
  assert.equal(h.monitor.getSummary().health, "healthy");
  assert.equal(h.monitor.getSummary().interrupted_runs_in_window, 0);
  assert.equal(h.monitor.getSummary().interrupted_runs_total, 4);
  assert.equal(h.logs.at(-1)!.record.event, "run_recovery_alert_cleared");
});

test("three consecutive failures alert and a successful check resets the streak", () => {
  const h = harness();
  h.monitor.recordFailure();
  assert.equal(h.monitor.getSummary().health, "degraded");
  assert.equal(h.logs[0].level, "error");
  h.monitor.recordFailure();
  assert.equal(h.alerts().length, 0);
  h.monitor.recordFailure();
  assert.equal(h.alerts().length, 1);
  assert.deepEqual(h.alerts()[0].record.alert_reasons, ["consecutive_recovery_failures"]);
  const failed = h.monitor.getSummary();
  assert.equal(failed.checks_total, 3);
  assert.equal(failed.recovery_failures_total, 3);
  assert.equal(failed.last_success_at, null);
  assert.ok(failed.last_failure_at);
  h.monitor.recordSuccess(0);
  const restored = h.monitor.getSummary();
  assert.equal(restored.consecutive_failures, 0);
  assert.equal(restored.recovery_failures_in_window, 3);
  assert.equal(restored.health, "healthy");
  assert.ok(h.logs.some(({ record }) => record.event === "run_recovery_check_restored"));
  assert.equal(h.logs.at(-1)!.record.event, "run_recovery_alert_cleared");
});

test("five intermittent failures alert even when successful checks break every streak", () => {
  const h = harness();
  for (let index = 0; index < 5; index += 1) {
    h.monitor.recordFailure();
    h.monitor.recordSuccess(0);
    h.advance(15_000);
  }
  const summary = h.monitor.getSummary();
  assert.equal(summary.health, "alert");
  assert.equal(summary.consecutive_failures, 0);
  assert.equal(summary.checks_total, 10);
  assert.equal(summary.recovery_failures_in_window, 5);
  assert.deepEqual(summary.alert_reasons, ["recovery_failure_rate"]);
  h.advance(RECOVERY_WINDOW_MS);
  h.monitor.recordSuccess(0);
  assert.equal(h.monitor.getSummary().recovery_failures_in_window, 0);
  assert.equal(h.monitor.getSummary().recovery_failures_total, 5);
  assert.equal(h.monitor.getSummary().health, "healthy");
});

test("new alert reasons warn immediately and a cleared threshold can alert again", () => {
  const h = harness();
  h.monitor.recordSuccess(3);
  h.monitor.recordFailure();
  h.monitor.recordFailure();
  h.monitor.recordFailure();
  assert.equal(h.alerts().length, 2);
  assert.deepEqual(h.alerts()[1].record.alert_reasons, ["interruption_rate", "consecutive_recovery_failures"]);
  h.monitor.recordSuccess(0);
  assert.equal(h.alerts().length, 2, "Clearing one reason must not re-warn about an unchanged reason");
  h.advance(RECOVERY_WINDOW_MS);
  h.monitor.recordSuccess(0);
  assert.equal(h.monitor.getSummary().health, "healthy");
  h.monitor.recordSuccess(3);
  assert.equal(h.alerts().length, 3);
});

test("rolling window expiry preserves process totals and does not expire unaligned samples early", () => {
  const h = harness();
  h.monitor.recordSuccess(1);
  h.advance(60_000);
  h.monitor.recordSuccess(2);
  h.advance(RECOVERY_WINDOW_MS - 60_000);
  assert.equal(h.monitor.getSummary().interrupted_runs_in_window, 2);
  h.advance(60_000);
  assert.equal(h.monitor.getSummary().interrupted_runs_in_window, 0);
  assert.equal(h.monitor.getSummary().interrupted_runs_total, 3);
  h.advance(59_000);
  h.monitor.recordSuccess(3);
  h.advance(RECOVERY_WINDOW_MS - 1);
  assert.equal(h.monitor.getSummary().interrupted_runs_in_window, 3);
  h.advance(1);
  assert.equal(h.monitor.getSummary().interrupted_runs_in_window, 0);
});

test("independent monitors explicitly start fresh rather than pretending to be durable fleet totals", () => {
  const first = harness();
  first.monitor.recordSuccess(3);
  first.monitor.recordFailure();
  const second = harness();
  second.monitor.recordSuccess(0);
  assert.equal(first.monitor.getSummary().interrupted_runs_total, 3);
  assert.equal(second.monitor.getSummary().interrupted_runs_total, 0);
  assert.equal(second.monitor.getSummary().recovery_failures_total, 0);
  assert.equal(second.monitor.getSummary().scope, "process");
});

test("failed recovery logs only allowlisted metrics, never thrown error messages, SQL, notes, or identifiers", async () => {
  const h = harness();
  const privateMarker = "private-test-note-marker";
  const failure = Object.assign(new Error(`SQL failed with notes ${privateMarker}`), {
    query: privateMarker, runId: privateMarker, userId: privateMarker,
    parameters: [privateMarker], cause: { connectionString: privateMarker },
  });
  const sweep = createRecoverySweep({ monitor: h.monitor, recover: async () => { throw failure; } });
  await sweep();
  const allowed = [...Object.keys(h.monitor.getSummary()), "event"].sort();
  for (const { record } of h.logs) {
    assert.deepEqual(Object.keys(record).sort(), allowed);
  }
  assert.ok(!JSON.stringify(h.logs).includes(privateMarker));
  assert.ok(!JSON.stringify(h.logs).includes("SQL failed"));
  assert.equal(h.logs[0].record.event, "run_recovery_check_failed");
  assert.equal(h.monitor.getSummary().recovery_failures_total, 1);
});

test("overlapping sweeps are skipped and only committed recovery counts become interruptions", async () => {
  const h = harness();
  let resolve: (count: number) => void = () => {};
  let calls = 0;
  const sweep = createRecoverySweep({
    monitor: h.monitor,
    recover: async () => {
      calls += 1;
      return calls === 1 ? new Promise<number>((done) => { resolve = done; }) : 1;
    },
  });
  const pending = sweep();
  await sweep();
  assert.equal(calls, 1);
  assert.equal(h.monitor.getSummary().checks_total, 0);
  assert.equal(h.monitor.getSummary().skipped_checks_total, 1);
  assert.equal(h.monitor.getSummary().interrupted_runs_total, 0);
  resolve(2);
  await pending;
  await sweep();
  assert.equal(calls, 2);
  assert.equal(h.monitor.getSummary().checks_total, 2);
  assert.equal(h.monitor.getSummary().interrupted_runs_total, 3);
  assert.equal(h.monitor.getSummary().interrupted_runs_last_check, 1);
});

test("a rejected transaction increments failures but not interruptions and permits the next scheduled check", async () => {
  const h = harness();
  let calls = 0;
  const sweep = createRecoverySweep({
    monitor: h.monitor,
    recover: async () => {
      calls += 1;
      if (calls === 1) throw new Error("Transaction rolled back");
      return 2;
    },
  });
  await sweep();
  assert.equal(calls, 1, "The monitor must not add automatic recovery or model retries");
  assert.equal(h.monitor.getSummary().recovery_failures_total, 1);
  assert.equal(h.monitor.getSummary().interrupted_runs_total, 0);
  await sweep();
  assert.equal(h.monitor.getSummary().checks_total, 2);
  assert.equal(h.monitor.getSummary().interrupted_runs_total, 2);
  assert.equal(h.monitor.getSummary().consecutive_failures, 0);
});

test("invalid recovery counts become failed checks rather than corrupting operational totals", async () => {
  const h = harness();
  for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
    await createRecoverySweep({ monitor: h.monitor, recover: async () => value })();
  }
  assert.equal(h.monitor.getSummary().recovery_failures_total, 4);
  assert.equal(h.monitor.getSummary().interrupted_runs_total, 0);
  assert.throws(() => h.monitor.recordSuccess(-1), /Invalid recovery count/);
});
