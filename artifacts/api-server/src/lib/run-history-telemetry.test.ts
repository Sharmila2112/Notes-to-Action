import assert from "node:assert/strict";
import { test } from "node:test";
import { logRunHistoryMetric, type RunHistoryMetric } from "./logger";

test("history telemetry keeps useful timing and size buckets while stripping private fields", () => {
  const privateMarkers = {
    inputText: "private-note-content-telemetry-test",
    ownerUserId: "private-owner-identifier",
    runId: "private-run-identifier",
    cursor: "private-next-page-token",
  };
  const records: RunHistoryMetric[] = [];
  logRunHistoryMetric({
    outcome: "success",
    durationMs: 2_500.6,
    pageSize: 50,
    resultCount: 50,
    responseBytes: 17_000,
    hasNextPage: true,
    ...privateMarkers,
  } as Parameters<typeof logRunHistoryMetric>[0], (record) => { records.push(record); });

  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    event: "run_history_list",
    outcome: "success",
    duration_ms: 2_501,
    duration_bucket: "2s_or_more",
    page_size: 50,
    result_count: 50,
    result_count_bucket: "full_page",
    response_bytes: 17_000,
    response_size_bucket: "16kb_to_64kb",
    has_next_page: true,
  });
  const output = JSON.stringify(records);
  for (const marker of Object.values(privateMarkers)) assert.ok(!output.includes(marker));
});

test("history telemetry uses fixed labels for empty pages, invalid inputs, and unavailable measurements", () => {
  const records: RunHistoryMetric[] = [];
  logRunHistoryMetric({
    outcome: "invalid",
    durationMs: 12.3,
    pageSize: 0,
    resultCount: 0,
    responseBytes: null,
    hasNextPage: false,
  }, (record) => { records.push(record); });
  logRunHistoryMetric({
    outcome: "success",
    durationMs: 450,
    pageSize: 20,
    resultCount: 0,
    responseBytes: 512,
    hasNextPage: false,
  }, (record) => { records.push(record); });
  logRunHistoryMetric({
    outcome: "error",
    durationMs: 2_100,
    pageSize: 50,
    resultCount: 0,
    responseBytes: null,
    hasNextPage: false,
  }, (record) => { records.push(record); });

  assert.equal(records[0].outcome, "invalid");
  assert.equal(records[0].result_count_bucket, "not_applicable");
  assert.equal(records[0].response_size_bucket, "not_measured");
  assert.equal(records[0].duration_bucket, "under_100ms");
  assert.equal(records[1].result_count_bucket, "empty");
  assert.equal(records[1].response_size_bucket, "under_1kb");
  assert.equal(records[1].duration_bucket, "100ms_to_500ms");
  assert.equal(records[2].outcome, "error");
  assert.equal(records[2].result_count_bucket, "not_applicable");
  assert.equal(records[2].response_size_bucket, "not_measured");
  assert.equal(records[2].duration_bucket, "2s_or_more");
});
