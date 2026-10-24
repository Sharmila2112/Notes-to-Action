import { performance } from "node:perf_hooks";
import { logger, type RunHistoryMetric } from "./logger";

export const RUN_HISTORY_MONITOR_WINDOW_MS = 5 * 60_000;
export const RUN_HISTORY_MONITOR_BUCKET_MS = 30_000;
export const RUN_HISTORY_ALERT_REMINDER_MS = 5 * 60_000;
export const RUN_HISTORY_ALERT_THRESHOLDS = {
  minimumRequests: 10,
  slowRequestMs: 500,
  slowRequestRate: 0.5,
} as const;

// Keep one partial bucket plus the ten full buckets covering the target window.
const WINDOW_BUCKET_COUNT = RUN_HISTORY_MONITOR_WINDOW_MS / RUN_HISTORY_MONITOR_BUCKET_MS + 1;
type RunHistoryAlertEvent = "run_history_latency_alert" | "run_history_latency_cleared";
type RunHistoryAlertMetrics = {
  scope: "process";
  window_ms: number;
  bucket_ms: number;
  request_count: number;
  slow_request_count: number;
  slow_request_rate: number;
  run_query_sample_count: number;
  run_query_avg_duration_ms: number | null;
  task_count_sample_count: number;
  task_count_avg_duration_ms: number | null;
  slow_threshold_ms: number;
  minimum_requests: number;
  slow_rate_threshold: number;
  reminder_interval_ms: number;
};
export type RunHistoryAlertRecord = RunHistoryAlertMetrics & {
  event: RunHistoryAlertEvent;
  reminder: boolean;
};
export type RunHistoryMonitor = ReturnType<typeof createRunHistoryMonitor>;

type StageAggregate = {
  sampleCount: number;
  averageDurationMs: number | null;
};

type RunHistoryBucket = {
  index: number;
  requests: number;
  slowRequests: number;
  runQuery: StageAggregate;
  taskCount: StageAggregate;
};

function addStageSample(stage: StageAggregate, durationMs: number | null): void {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return;
  stage.sampleCount += 1;
  const previousAverage = stage.averageDurationMs ?? 0;
  stage.averageDurationMs = previousAverage + (durationMs - previousAverage) / stage.sampleCount;
}

function mergeStage(target: StageAggregate, source: StageAggregate): void {
  if (source.sampleCount === 0 || source.averageDurationMs === null) return;
  if (target.sampleCount === 0 || target.averageDurationMs === null) {
    target.sampleCount = source.sampleCount;
    target.averageDurationMs = source.averageDurationMs;
    return;
  }

  const combinedCount = target.sampleCount + source.sampleCount;
  target.averageDurationMs += (source.averageDurationMs - target.averageDurationMs)
    * (source.sampleCount / combinedCount);
  target.sampleCount = combinedCount;
}

/**
 * Keep only fixed-window counts and online stage averages, not per-request
 * samples or user data.
 * Invalid query input is excluded because it does not reach the history queries.
 */
export function createRunHistoryMonitor(options: {
  emit: (level: "info" | "warn", record: RunHistoryAlertRecord) => void;
  now?: () => number;
}) {
  const now = options.now ?? (() => performance.now());
  let buckets: RunHistoryBucket[] = [];
  let isAlerting = false;
  let lastWarningAt: number | null = null;

  function snapshot(at: number): RunHistoryAlertMetrics {
    const currentIndex = Math.floor(at / RUN_HISTORY_MONITOR_BUCKET_MS);
    const firstIndex = currentIndex - WINDOW_BUCKET_COUNT + 1;
    buckets = buckets.filter((bucket) => bucket.index >= firstIndex && bucket.index <= currentIndex);
    let requests = 0;
    let slowRequests = 0;
    const runQuery: StageAggregate = { sampleCount: 0, averageDurationMs: null };
    const taskCount: StageAggregate = { sampleCount: 0, averageDurationMs: null };
    for (const bucket of buckets) {
      requests += bucket.requests;
      slowRequests += bucket.slowRequests;
      mergeStage(runQuery, bucket.runQuery);
      mergeStage(taskCount, bucket.taskCount);
    }
    return {
      scope: "process",
      window_ms: RUN_HISTORY_MONITOR_WINDOW_MS,
      bucket_ms: RUN_HISTORY_MONITOR_BUCKET_MS,
      request_count: requests,
      slow_request_count: slowRequests,
      slow_request_rate: requests ? Number((slowRequests / requests).toFixed(3)) : 0,
      run_query_sample_count: runQuery.sampleCount,
      run_query_avg_duration_ms: runQuery.averageDurationMs,
      task_count_sample_count: taskCount.sampleCount,
      task_count_avg_duration_ms: taskCount.averageDurationMs,
      slow_threshold_ms: RUN_HISTORY_ALERT_THRESHOLDS.slowRequestMs,
      minimum_requests: RUN_HISTORY_ALERT_THRESHOLDS.minimumRequests,
      slow_rate_threshold: RUN_HISTORY_ALERT_THRESHOLDS.slowRequestRate,
      reminder_interval_ms: RUN_HISTORY_ALERT_REMINDER_MS,
    };
  }

  function evaluate(at = now()) {
    const summary = snapshot(at);
    const meetsThreshold = summary.request_count >= RUN_HISTORY_ALERT_THRESHOLDS.minimumRequests
      && summary.slow_request_count / summary.request_count >= RUN_HISTORY_ALERT_THRESHOLDS.slowRequestRate;

    if (meetsThreshold && (
      !isAlerting || lastWarningAt === null || at - lastWarningAt >= RUN_HISTORY_ALERT_REMINDER_MS
    )) {
      options.emit("warn", {
        ...summary,
        event: "run_history_latency_alert",
        reminder: isAlerting,
      });
      lastWarningAt = at;
    } else if (!meetsThreshold && isAlerting) {
      options.emit("info", { ...summary, event: "run_history_latency_cleared", reminder: false });
      lastWarningAt = null;
    }
    isAlerting = meetsThreshold;
    return summary;
  }

  return {
    record(metric: RunHistoryMetric): void {
      const at = now();
      if (metric.outcome !== "invalid") {
        const index = Math.floor(at / RUN_HISTORY_MONITOR_BUCKET_MS);
        let bucket = buckets.find((sample) => sample.index === index);
        if (!bucket) {
          bucket = {
            index,
            requests: 0,
            slowRequests: 0,
            runQuery: { sampleCount: 0, averageDurationMs: null },
            taskCount: { sampleCount: 0, averageDurationMs: null },
          };
          buckets.push(bucket);
        }
        bucket.requests += 1;
        if (metric.duration_ms >= RUN_HISTORY_ALERT_THRESHOLDS.slowRequestMs) {
          bucket.slowRequests += 1;
        }
        addStageSample(bucket.runQuery, metric.run_query_duration_ms);
        addStageSample(bucket.taskCount, metric.task_count_duration_ms);
      }
      evaluate(at);
    },
    evaluate,
    getSummary: () => snapshot(now()),
  };
}

export const runHistoryMonitor = createRunHistoryMonitor({
  emit: (level, record) => logger[level](record, "Run history latency health"),
});

/** Re-evaluate the rolling window during quiet periods so expired alerts clear. */
export function startRunHistoryMonitoring(): () => void {
  const timer = setInterval(() => runHistoryMonitor.evaluate(), RUN_HISTORY_MONITOR_BUCKET_MS);
  timer.unref();
  return () => clearInterval(timer);
}
