// These metrics are process-local. Operator log aggregation provides history
// across restarts/instances; no note text, run IDs, or user IDs enter this API.
export const RECOVERY_WINDOW_MS = 15 * 60_000;
export const RECOVERY_SUMMARY_INTERVAL_MS = 5 * 60_000;
export const RECOVERY_ALERT_THRESHOLDS = {
  interruptions: 3,
  failures: 5,
  consecutiveFailures: 3,
} as const;

type AlertReason = "interruption_rate" | "recovery_failure_rate" | "consecutive_recovery_failures";
export type RecoveryHealthSummary = {
  scope: "process";
  health: "healthy" | "degraded" | "alert";
  monitor_started_at: string;
  window_ms: number;
  checks_total: number;
  interrupted_runs_total: number;
  interrupted_runs_last_check: number;
  recovery_failures_total: number;
  skipped_checks_total: number;
  interrupted_runs_in_window: number;
  recovery_failures_in_window: number;
  consecutive_failures: number;
  last_check_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  interruption_threshold: number;
  failure_threshold: number;
  consecutive_failure_threshold: number;
  alert_reasons: AlertReason[];
};
type RecoveryEvent =
  | "run_recovery_summary"
  | "run_recovery_interrupted"
  | "run_recovery_check_failed"
  | "run_recovery_check_restored"
  | "run_recovery_alert"
  | "run_recovery_alert_cleared";
export type RecoveryLogRecord = RecoveryHealthSummary & { event: RecoveryEvent };

export function createRecoveryMonitor(options: {
  emit: (level: "info" | "warn" | "error", record: RecoveryLogRecord) => void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  // At most one aggregate sample per non-overlapping 15-second sweep (not per
  // run). Quiet checks add no samples; entries expire after exactly 15 minutes.
  let samples: { at: number; interruptions: number; failures: number }[] = [];
  let checks = 0;
  let interruptions = 0;
  let lastRecovered = 0;
  let failures = 0;
  let skipped = 0;
  let consecutiveFailures = 0;
  let lastCheck: string | null = null;
  let lastSuccess: string | null = null;
  let lastFailure: string | null = null;
  let lastSummaryAt: number | null = null;
  let lastAlertAt: number | null = null;
  let lastAlertSignature = "";

  function summary(at = now()): RecoveryHealthSummary {
    const cutoff = at - RECOVERY_WINDOW_MS;
    samples = samples.filter((sample) => sample.at > cutoff);
    let recentInterruptions = 0;
    let recentFailures = 0;
    for (const sample of samples) {
      recentInterruptions += sample.interruptions;
      recentFailures += sample.failures;
    }
    const reasons: AlertReason[] = [];
    if (recentInterruptions >= RECOVERY_ALERT_THRESHOLDS.interruptions) reasons.push("interruption_rate");
    if (recentFailures >= RECOVERY_ALERT_THRESHOLDS.failures) reasons.push("recovery_failure_rate");
    if (consecutiveFailures >= RECOVERY_ALERT_THRESHOLDS.consecutiveFailures) reasons.push("consecutive_recovery_failures");
    return {
      scope: "process",
      health: reasons.length ? "alert" : consecutiveFailures ? "degraded" : "healthy",
      monitor_started_at: startedAt,
      window_ms: RECOVERY_WINDOW_MS,
      checks_total: checks,
      interrupted_runs_total: interruptions,
      interrupted_runs_last_check: lastRecovered,
      recovery_failures_total: failures,
      skipped_checks_total: skipped,
      interrupted_runs_in_window: recentInterruptions,
      recovery_failures_in_window: recentFailures,
      consecutive_failures: consecutiveFailures,
      last_check_at: lastCheck,
      last_success_at: lastSuccess,
      last_failure_at: lastFailure,
      interruption_threshold: RECOVERY_ALERT_THRESHOLDS.interruptions,
      failure_threshold: RECOVERY_ALERT_THRESHOLDS.failures,
      consecutive_failure_threshold: RECOVERY_ALERT_THRESHOLDS.consecutiveFailures,
      alert_reasons: reasons,
    };
  }

  function report(at: number, event?: RecoveryEvent) {
    const snapshot = summary(at);
    if (event || lastSummaryAt === null || at - lastSummaryAt >= RECOVERY_SUMMARY_INTERVAL_MS) {
      const name = event ?? "run_recovery_summary";
      options.emit(name === "run_recovery_check_failed" ? "error" : "info", { ...snapshot, event: name });
      lastSummaryAt = at;
    }
    const signature = snapshot.alert_reasons.join(",");
    const hasNewReason = snapshot.alert_reasons.some((reason) => !lastAlertSignature.split(",").includes(reason));
    if (signature && (
      hasNewReason || lastAlertAt === null ||
      at - lastAlertAt >= RECOVERY_SUMMARY_INTERVAL_MS
    )) {
      options.emit("warn", { ...snapshot, event: "run_recovery_alert" });
      lastAlertAt = at;
    } else if (!signature && lastAlertSignature) {
      options.emit("info", { ...snapshot, event: "run_recovery_alert_cleared" });
      lastAlertAt = null;
    }
    lastAlertSignature = signature;
  }

  function recordResult(recovered: number, failed: boolean) {
    const at = now();
    const timestamp = new Date(at).toISOString();
    const wasFailing = consecutiveFailures > 0;
    if (recovered || failed) samples.push({ at, interruptions: recovered, failures: Number(failed) });
    checks += 1;
    interruptions += recovered;
    lastRecovered = recovered;
    failures += Number(failed);
    consecutiveFailures = failed ? consecutiveFailures + 1 : 0;
    lastCheck = timestamp;
    if (failed) lastFailure = timestamp;
    else lastSuccess = timestamp;
    report(at, failed ? "run_recovery_check_failed"
      : recovered ? "run_recovery_interrupted"
      : wasFailing ? "run_recovery_check_restored" : undefined);
  }

  return {
    recordSuccess(recovered: number) {
      if (!Number.isSafeInteger(recovered) || recovered < 0) throw new Error("Invalid recovery count");
      recordResult(recovered, false);
    },
    // Deliberately accepts no error argument: raw DB errors can include query
    // parameters, note text, or connection details.
    recordFailure() { recordResult(0, true); },
    recordSkipped() { skipped += 1; report(now()); },
    getSummary: () => summary(),
  };
}

export function createRecoverySweep(options: {
  recover: () => Promise<number>;
  monitor: ReturnType<typeof createRecoveryMonitor>;
}) {
  let sweeping = false;
  return async function sweep(): Promise<void> {
    if (sweeping) {
      options.monitor.recordSkipped();
      return;
    }
    sweeping = true;
    try {
      // Counts only runs whose recovery transaction has successfully committed.
      const recovered = await options.recover();
      options.monitor.recordSuccess(recovered);
    } catch {
      options.monitor.recordFailure();
    } finally {
      sweeping = false;
    }
  };
}
