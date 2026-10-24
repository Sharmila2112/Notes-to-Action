import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRunHistoryMonitor,
  RUN_HISTORY_ALERT_REMINDER_MS,
  RUN_HISTORY_MONITOR_BUCKET_MS,
  RUN_HISTORY_MONITOR_WINDOW_MS,
  type RunHistoryAlertRecord,
} from "./run-history-monitor";
import type { RunHistoryMetric } from "./logger";

function metric(duration: number, outcome: RunHistoryMetric["outcome"] = "success"): RunHistoryMetric {
  return {
    event: "run_history_list",
    outcome,
    duration_ms: duration,
    duration_bucket: duration >= 500 ? "500ms_to_2s" : "under_100ms",
    run_query_duration_ms: null,
    task_count_duration_ms: null,
    page_size: 20,
    result_count: 20,
    result_count_bucket: "full_page",
    response_bytes: 2_000,
    response_size_bucket: "1kb_to_4kb",
    has_next_page: false,
  };
}

function harness() {
  let clock = 0;
  const logs: { level: "info" | "warn"; record: RunHistoryAlertRecord }[] = [];
  const monitor = createRunHistoryMonitor({
    now: () => clock,
    emit: (level, record) => { logs.push({ level, record }); },
  });
  return {
    monitor,
    logs,
    advance: (ms: number) => { clock += ms; },
    alerts: () => logs.filter(({ record }) => record.event === "run_history_latency_alert"),
  };
}

test("one slow history request does not alert; sustained slowness crosses the threshold and recovery clears it", () => {
  const h = harness();
  for (let index = 0; index < 9; index += 1) h.monitor.record(metric(100));
  h.monitor.record(metric(2_000));
  assert.equal(h.monitor.getSummary().request_count, 10);
  assert.equal(h.monitor.getSummary().slow_request_count, 1);
  assert.equal(h.alerts().length, 0, "A single slow response must not page operators");

  const privateMarkers = {
    inputText: "private-meeting-note",
    ownerUserId: "private-user-id",
    runId: "private-run-id",
    cursor: "private-cursor-token",
  };
  for (let index = 0; index < 7; index += 1) h.monitor.record(metric(600));
  h.monitor.record({
    ...metric(600, "error"),
    ...privateMarkers,
  } as RunHistoryMetric);

  assert.equal(h.alerts().length, 1);
  assert.equal(h.alerts()[0].level, "warn");
  assert.deepEqual(h.alerts()[0].record, {
    event: "run_history_latency_alert",
    reminder: false,
    scope: "process",
    window_ms: RUN_HISTORY_MONITOR_WINDOW_MS,
    bucket_ms: RUN_HISTORY_MONITOR_BUCKET_MS,
    request_count: 18,
    slow_request_count: 9,
    slow_request_rate: 0.5,
    slow_threshold_ms: 500,
    minimum_requests: 10,
    slow_rate_threshold: 0.5,
    reminder_interval_ms: RUN_HISTORY_ALERT_REMINDER_MS,
  });
  assert.ok(!JSON.stringify(h.logs).includes(JSON.stringify(privateMarkers)));
  for (const marker of Object.values(privateMarkers)) assert.ok(!JSON.stringify(h.logs).includes(marker));

  for (let index = 0; index < 4; index += 1) h.monitor.record(metric(100));
  assert.equal(h.monitor.getSummary().slow_request_rate, 0.409);
  assert.equal(h.logs.at(-1)!.level, "info");
  assert.equal(h.logs.at(-1)!.record.event, "run_history_latency_cleared");
  assert.equal(h.alerts().length, 1);
});

test("alerts are throttled, repeat only after the reminder interval, and clear when the window expires", () => {
  const h = harness();
  for (let index = 0; index < 10; index += 1) h.monitor.record(metric(500));
  assert.equal(h.alerts().length, 1);
  for (let index = 0; index < 20; index += 1) h.monitor.record(metric(1_000));
  assert.equal(h.alerts().length, 1, "Repeated slow requests do not create a warning per request");

  for (let bucket = 1; bucket <= 10; bucket += 1) {
    h.advance(RUN_HISTORY_MONITOR_BUCKET_MS);
    h.monitor.record(metric(800));
    h.monitor.record(metric(800));
  }
  assert.equal(h.alerts().length, 2);
  assert.equal(h.alerts()[0].record.reminder, false);
  assert.equal(h.alerts()[1].record.reminder, true);
  assert.equal(h.alerts()[1].record.request_count, 49);
  assert.equal(h.alerts()[1].record.slow_request_rate, 1);

  h.advance(RUN_HISTORY_MONITOR_WINDOW_MS + RUN_HISTORY_MONITOR_BUCKET_MS);
  const summary = h.monitor.evaluate();
  assert.equal(summary.request_count, 0);
  assert.equal(summary.slow_request_count, 0);
  assert.equal(h.logs.at(-1)!.record.event, "run_history_latency_cleared");
  assert.equal(h.logs.at(-1)!.level, "info");
});

test("invalid pagination requests do not distort the valid-request slow-rate threshold", () => {
  const h = harness();
  for (let index = 0; index < 50; index += 1) h.monitor.record(metric(8_000, "invalid"));
  assert.equal(h.monitor.getSummary().request_count, 0);
  assert.equal(h.alerts().length, 0);
  for (let index = 0; index < 10; index += 1) h.monitor.record(metric(600));
  assert.equal(h.monitor.getSummary().request_count, 10);
  assert.equal(h.alerts().length, 1);
});
