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

/**
 * Keep only fixed-window request counts, not per-request samples or user data.
 * Invalid query input is excluded because it does not reach the history queries.
 */
export function createRunHistoryMonitor(options: {
  emit: (level: "info" | "warn", record: RunHistoryAlertRecord) => void;
  now?: () => number;
}) {
  const now = options.now ?? (() => performance.now());
  let buckets: Array<{ index: number; requests: number; slowRequests: number }> = [];
  let isAlerting = false;
  let lastWarningAt: number | null = null;

  function snapshot(at: number): RunHistoryAlertMetrics {
    const currentIndex = Math.floor(at / RUN_HISTORY_MONITOR_BUCKET_MS);
    const firstIndex = currentIndex - WINDOW_BUCKET_COUNT + 1;
    buckets = buckets.filter((bucket) => bucket.index >= firstIndex && bucket.index <= currentIndex);
    let requests = 0;
    let slowRequests = 0;
    for (const bucket of buckets) {
      requests += bucket.requests;
      slowRequests += bucket.slowRequests;
    }
    return {
      scope: "process",
      window_ms: RUN_HISTORY_MONITOR_WINDOW_MS,
      bucket_ms: RUN_HISTORY_MONITOR_BUCKET_MS,
      request_count: requests,
      slow_request_count: slowRequests,
      slow_request_rate: requests ? Number((slowRequests / requests).toFixed(3)) : 0,
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
          bucket = { index, requests: 0, slowRequests: 0 };
          buckets.push(bucket);
        }
        bucket.requests += 1;
        if (metric.duration_ms >= RUN_HISTORY_ALERT_THRESHOLDS.slowRequestMs) {
          bucket.slowRequests += 1;
        }
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
