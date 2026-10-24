import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});

export type RunHistoryMetricInput = {
  outcome: "success" | "invalid" | "error";
  durationMs: number;
  runQueryDurationMs: number | null;
  taskCountDurationMs: number | null;
  pageSize: number;
  resultCount: number;
  responseBytes: number | null;
  hasNextPage: boolean;
};

export type RunHistoryMetric = {
  event: "run_history_list";
  outcome: RunHistoryMetricInput["outcome"];
  duration_ms: number;
  duration_bucket: "under_100ms" | "100ms_to_500ms" | "500ms_to_2s" | "2s_or_more";
  run_query_duration_ms: number | null;
  task_count_duration_ms: number | null;
  page_size: number;
  result_count: number;
  result_count_bucket: "not_applicable" | "empty" | "partial_page" | "full_page";
  response_bytes: number | null;
  response_size_bucket: "not_measured" | "under_1kb" | "1kb_to_4kb" | "4kb_to_16kb" | "16kb_to_64kb" | "64kb_or_more";
  has_next_page: boolean;
};

export type RunHistoryMetricSink = (record: RunHistoryMetric) => void;

/**
 * Emit only fixed labels and summary measurements. Never pass request,
 * database, or note objects here: no owner, run, cursor, or note value belongs
 * in history telemetry.
 */
export function logRunHistoryMetric(
  input: RunHistoryMetricInput,
  sink: RunHistoryMetricSink = (record) => logger.info(record, "Run history request"),
): void {
  const durationMs = Number.isFinite(input.durationMs) ? Math.max(0, Math.round(input.durationMs)) : 0;
  const runQueryDurationMs = input.runQueryDurationMs !== null && Number.isFinite(input.runQueryDurationMs)
    ? Math.max(0, Math.round(input.runQueryDurationMs))
    : null;
  const taskCountDurationMs = input.taskCountDurationMs !== null && Number.isFinite(input.taskCountDurationMs)
    ? Math.max(0, Math.round(input.taskCountDurationMs))
    : null;
  const resultCount = Number.isInteger(input.resultCount) ? Math.max(0, Math.min(50, input.resultCount)) : 0;
  const pageSize = Number.isInteger(input.pageSize) ? Math.max(0, Math.min(50, input.pageSize)) : 0;
  const responseBytes = input.responseBytes !== null && Number.isInteger(input.responseBytes)
    ? Math.max(0, input.responseBytes)
    : null;

  const record: RunHistoryMetric = {
    event: "run_history_list",
    outcome: input.outcome,
    duration_ms: durationMs,
    duration_bucket: durationMs < 100 ? "under_100ms"
      : durationMs < 500 ? "100ms_to_500ms"
        : durationMs < 2_000 ? "500ms_to_2s" : "2s_or_more",
    run_query_duration_ms: runQueryDurationMs,
    task_count_duration_ms: taskCountDurationMs,
    page_size: pageSize,
    result_count: resultCount,
    result_count_bucket: input.outcome !== "success" ? "not_applicable"
      : resultCount === 0 ? "empty"
        : resultCount >= pageSize ? "full_page" : "partial_page",
    response_bytes: responseBytes,
    response_size_bucket: responseBytes === null ? "not_measured"
      : responseBytes < 1_024 ? "under_1kb"
        : responseBytes < 4_096 ? "1kb_to_4kb"
          : responseBytes < 16_384 ? "4kb_to_16kb"
            : responseBytes < 65_536 ? "16kb_to_64kb" : "64kb_or_more",
    has_next_page: input.hasNextPage,
  };
  sink(record);
}
