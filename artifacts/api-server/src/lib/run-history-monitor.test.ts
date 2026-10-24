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

function metric(
  duration: number,
  outcome: RunHistoryMetric["outcome"] = "success",
  runQueryDuration: number | null = null,
  taskCountDuration: number | null = null,
): RunHistoryMetric {
  return {
    event: "run_history_list",
    outcome,
    duration_ms: duration,
    duration_bucket: duration >= 500 ? "500ms_to_2s" : "under_100ms",
    run_query_duration_ms: runQueryDuration,
    task_count_duration_ms: taskCountDuration,
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
  for (let index = 0; index < 9; index += 1) h.monitor.record(metric(100, "success", 10, 20));
  h.monitor.record(metric(2_000, "success", 50, 200));
  assert.equal(h.monitor.getSummary().request_count, 10);
  assert.equal(h.monitor.getSummary().slow_request_count, 1);
  assert.equal(h.monitor.getSummary().slow_run_query_sample_count, 1);
  assert.equal(h.monitor.getSummary().slow_run_query_avg_duration_ms, 50);
  assert.equal(h.monitor.getSummary().slow_task_count_sample_count, 1);
  assert.equal(h.monitor.getSummary().slow_task_count_avg_duration_ms, 200);
  assert.equal(h.alerts().length, 0, "A single slow response must not page operators");

  const privateMarkers = {
    inputText: "private-meeting-note",
    ownerUserId: "private-user-id",
    runId: "private-run-id",
    cursor: "private-cursor-token",
  };
  for (let index = 0; index < 7; index += 1) h.monitor.record(metric(600, "success", 50, 200));
  h.monitor.record({
    ...metric(600, "error", 50, 200),
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
    run_query_sample_count: 18,
    run_query_avg_duration_ms: 30,
    task_count_sample_count: 18,
    task_count_avg_duration_ms: 110,
    slow_run_query_sample_count: 9,
    slow_run_query_avg_duration_ms: 50,
    slow_task_count_sample_count: 9,
    slow_task_count_avg_duration_ms: 200,
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
  assert.equal(h.logs.at(-1)!.record.run_query_sample_count, 18);
  assert.equal(h.logs.at(-1)!.record.run_query_avg_duration_ms, 30);
  assert.equal(h.logs.at(-1)!.record.task_count_sample_count, 18);
  assert.equal(h.logs.at(-1)!.record.task_count_avg_duration_ms, 110);
  assert.equal(h.logs.at(-1)!.record.slow_run_query_sample_count, 9);
  assert.equal(h.logs.at(-1)!.record.slow_run_query_avg_duration_ms, 50);
  assert.equal(h.logs.at(-1)!.record.slow_task_count_sample_count, 9);
  assert.equal(h.logs.at(-1)!.record.slow_task_count_avg_duration_ms, 200);
  assert.equal(h.alerts().length, 1);
});

test("alerts are throttled, repeat only after the reminder interval, and clear when the window expires", () => {
  const h = harness();
  for (let index = 0; index < 10; index += 1) h.monitor.record(metric(500, "success", 25, 75));
  assert.equal(h.alerts().length, 1);
  for (let index = 0; index < 20; index += 1) h.monitor.record(metric(1_000, "success", 25, 75));
  assert.equal(h.alerts().length, 1, "Repeated slow requests do not create a warning per request");

  for (let bucket = 1; bucket <= 10; bucket += 1) {
    h.advance(RUN_HISTORY_MONITOR_BUCKET_MS);
    h.monitor.record(metric(800, "success", 25, 75));
    h.monitor.record(metric(800, "success", 25, 75));
  }
  assert.equal(h.alerts().length, 2);
  assert.equal(h.alerts()[0].record.reminder, false);
  assert.equal(h.alerts()[1].record.reminder, true);
  assert.equal(h.alerts()[1].record.request_count, 49);
  assert.equal(h.alerts()[1].record.slow_request_rate, 1);
  assert.equal(h.alerts()[1].record.run_query_sample_count, 49);
  assert.equal(h.alerts()[1].record.run_query_avg_duration_ms, 25);
  assert.equal(h.alerts()[1].record.task_count_sample_count, 49);
  assert.equal(h.alerts()[1].record.task_count_avg_duration_ms, 75);
  assert.equal(h.alerts()[1].record.slow_run_query_sample_count, 49);
  assert.equal(h.alerts()[1].record.slow_run_query_avg_duration_ms, 25);
  assert.equal(h.alerts()[1].record.slow_task_count_sample_count, 49);
  assert.equal(h.alerts()[1].record.slow_task_count_avg_duration_ms, 75);

  h.advance(RUN_HISTORY_MONITOR_WINDOW_MS + RUN_HISTORY_MONITOR_BUCKET_MS);
  const summary = h.monitor.evaluate();
  assert.equal(summary.request_count, 0);
  assert.equal(summary.slow_request_count, 0);
  assert.equal(summary.run_query_sample_count, 0);
  assert.equal(summary.run_query_avg_duration_ms, null);
  assert.equal(summary.task_count_sample_count, 0);
  assert.equal(summary.task_count_avg_duration_ms, null);
  assert.equal(summary.slow_run_query_sample_count, 0);
  assert.equal(summary.slow_run_query_avg_duration_ms, null);
  assert.equal(summary.slow_task_count_sample_count, 0);
  assert.equal(summary.slow_task_count_avg_duration_ms, null);
  assert.equal(h.logs.at(-1)!.record.event, "run_history_latency_cleared");
  assert.equal(h.logs.at(-1)!.level, "info");
});

test("stage averages combine bucket summaries with the correct sample weights", () => {
  const h = harness();
  for (let index = 0; index < 10; index += 1) {
    h.monitor.record(metric(600, "success", 10, 100));
  }
  assert.equal(h.alerts().length, 1);

  h.advance(RUN_HISTORY_MONITOR_BUCKET_MS);
  h.monitor.record(metric(700, "success", 50, 300));

  const summary = h.monitor.getSummary();
  assert.equal(summary.run_query_sample_count, 11);
  assert.equal(summary.run_query_avg_duration_ms, 150 / 11);
  assert.equal(summary.task_count_sample_count, 11);
  assert.equal(summary.task_count_avg_duration_ms, 1_300 / 11);
  assert.equal(summary.slow_run_query_sample_count, 11);
  assert.equal(summary.slow_run_query_avg_duration_ms, 150 / 11);
  assert.equal(summary.slow_task_count_sample_count, 11);
  assert.equal(summary.slow_task_count_avg_duration_ms, 1_300 / 11);
  assert.equal(h.alerts().length, 1, "Stage aggregation does not change alert throttling");
});

test("expired buckets stop contributing stage averages while newer samples remain", () => {
  const h = harness();
  for (let index = 0; index < 10; index += 1) {
    h.monitor.record(metric(600, "success", 10, 100));
  }

  h.advance(RUN_HISTORY_MONITOR_BUCKET_MS * 2);
  for (let index = 0; index < 4; index += 1) {
    h.monitor.record(metric(600, "success", 50, 300));
  }

  h.advance(RUN_HISTORY_MONITOR_BUCKET_MS * 9);
  h.monitor.evaluate();

  const cleared = h.logs.at(-1)!.record;
  assert.equal(cleared.event, "run_history_latency_cleared");
  assert.equal(cleared.request_count, 4);
  assert.equal(cleared.run_query_sample_count, 4);
  assert.equal(cleared.run_query_avg_duration_ms, 50);
  assert.equal(cleared.task_count_sample_count, 4);
  assert.equal(cleared.task_count_avg_duration_ms, 300);
  assert.equal(cleared.slow_run_query_sample_count, 4);
  assert.equal(cleared.slow_run_query_avg_duration_ms, 50);
  assert.equal(cleared.slow_task_count_sample_count, 4);
  assert.equal(cleared.slow_task_count_avg_duration_ms, 300);
});

test("missing stage timings are not counted as zero or allowed to change alert thresholds", () => {
  const h = harness();
  for (let index = 0; index < 4; index += 1) {
    h.monitor.record(metric(600, "success", 40, null));
  }
  for (let index = 0; index < 3; index += 1) {
    h.monitor.record(metric(600, "success", null, 150));
  }
  for (let index = 0; index < 3; index += 1) {
    h.monitor.record(metric(600, "success", null, null));
  }

  const warning = h.alerts()[0].record;
  assert.equal(warning.request_count, 10);
  assert.equal(warning.slow_request_count, 10);
  assert.equal(warning.run_query_sample_count, 4);
  assert.equal(warning.run_query_avg_duration_ms, 40);
  assert.equal(warning.task_count_sample_count, 3);
  assert.equal(warning.task_count_avg_duration_ms, 150);
  assert.equal(warning.slow_run_query_sample_count, 4);
  assert.equal(warning.slow_run_query_avg_duration_ms, 40);
  assert.equal(warning.slow_task_count_sample_count, 3);
  assert.equal(warning.slow_task_count_avg_duration_ms, 150);

  for (let index = 0; index < 11; index += 1) h.monitor.record(metric(100));
  const cleared = h.logs.at(-1)!.record;
  assert.equal(cleared.event, "run_history_latency_cleared");
  assert.equal(cleared.request_count, 21);
  assert.equal(cleared.slow_request_count, 10);
  assert.equal(cleared.run_query_sample_count, 4);
  assert.equal(cleared.run_query_avg_duration_ms, 40);
  assert.equal(cleared.task_count_sample_count, 3);
  assert.equal(cleared.task_count_avg_duration_ms, 150);
  assert.equal(cleared.slow_run_query_sample_count, 4);
  assert.equal(cleared.slow_run_query_avg_duration_ms, 40);
  assert.equal(cleared.slow_task_count_sample_count, 3);
  assert.equal(cleared.slow_task_count_avg_duration_ms, 150);

  const unmeasured = harness();
  for (let index = 0; index < 10; index += 1) unmeasured.monitor.record(metric(600));
  const unmeasuredWarning = unmeasured.alerts()[0].record;
  assert.equal(unmeasuredWarning.request_count, 10);
  assert.equal(unmeasuredWarning.run_query_sample_count, 0);
  assert.equal(unmeasuredWarning.run_query_avg_duration_ms, null);
  assert.equal(unmeasuredWarning.task_count_sample_count, 0);
  assert.equal(unmeasuredWarning.task_count_avg_duration_ms, null);
  assert.equal(unmeasuredWarning.slow_run_query_sample_count, 0);
  assert.equal(unmeasuredWarning.slow_run_query_avg_duration_ms, null);
  assert.equal(unmeasuredWarning.slow_task_count_sample_count, 0);
  assert.equal(unmeasuredWarning.slow_task_count_avg_duration_ms, null);

  for (let index = 0; index < 11; index += 1) unmeasured.monitor.record(metric(100));
  const unmeasuredCleared = unmeasured.logs.at(-1)!.record;
  assert.equal(unmeasuredCleared.event, "run_history_latency_cleared");
  assert.equal(unmeasuredCleared.run_query_sample_count, 0);
  assert.equal(unmeasuredCleared.run_query_avg_duration_ms, null);
  assert.equal(unmeasuredCleared.task_count_sample_count, 0);
  assert.equal(unmeasuredCleared.task_count_avg_duration_ms, null);
  assert.equal(unmeasuredCleared.slow_run_query_sample_count, 0);
  assert.equal(unmeasuredCleared.slow_run_query_avg_duration_ms, null);
  assert.equal(unmeasuredCleared.slow_task_count_sample_count, 0);
  assert.equal(unmeasuredCleared.slow_task_count_avg_duration_ms, null);
});

test("invalid pagination requests do not distort the valid-request slow-rate threshold", () => {
  const h = harness();
  for (let index = 0; index < 50; index += 1) h.monitor.record(metric(8_000, "invalid"));
  assert.equal(h.monitor.getSummary().request_count, 0);
  assert.equal(h.monitor.getSummary().run_query_sample_count, 0);
  assert.equal(h.monitor.getSummary().task_count_sample_count, 0);
  assert.equal(h.alerts().length, 0);
  for (let index = 0; index < 10; index += 1) h.monitor.record(metric(600));
  assert.equal(h.monitor.getSummary().request_count, 10);
  assert.equal(h.alerts().length, 1);
});
