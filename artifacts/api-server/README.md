# API operations

## Extraction recovery visibility

Recovery checks run on startup and every 15 seconds. They mark abandoned
extractions failed; they never invoke the model or automatically retry an
extraction.

Health summaries and threshold warnings are emitted **only in server logs**.
No new HTTP endpoint exposes them. `/api/healthz` remains the public liveness
response `{ "status": "ok" }`, not a detailed recovery-health endpoint.

Every recovery log includes the event name, health (`healthy`, `degraded`, or
`alert`), counters, thresholds, timestamps, and `scope: "process"`:

- `checks_total`: completed successful and failed recovery checks.
- `interrupted_runs_total`: abandoned runs successfully marked failed by this
  process. Includes expired execution leases and old pre-lease records.
- `interrupted_runs_last_check`: the number recovered by the latest check.
- `recovery_failures_total`, `consecutive_failures`, `skipped_checks_total`.
- `interrupted_runs_in_window` and `recovery_failures_in_window`: counts from
  checks completed within the last 15 minutes.
- `last_check_at`, `last_success_at`, and `last_failure_at`.

Recovery counts are recorded only **after** the recovery transaction commits.
An unsuccessful transaction increments the failure count, not interruption
counts. Concurrent sweep attempts are skipped, not counted as failures.

### Alert thresholds

`run_recovery_alert` is a warning when any of these thresholds is met:

| `alert_reasons` value | Threshold |
| --- | --- |
| `interruption_rate` | At least 3 interrupted runs in the window |
| `recovery_failure_rate` | At least 5 failed recovery checks in the window |
| `consecutive_recovery_failures` | At least 3 consecutive failed checks |

Warn immediately for a new reason and every 5 minutes while it persists,
rather than on every sweep. `run_recovery_alert_cleared` records when all
thresholds clear. Success resets the consecutive-failure streak but does not
erase recent failures. A single failed check is `degraded` even below alert
thresholds.

`run_recovery_summary` records healthy startup and then at least every 5 minutes
while checks continue (other recovery events include the same summary fields).
`run_recovery_interrupted` records successful recovery of one or more runs.
Each failed check emits `run_recovery_check_failed` at error level; the first
success after failures emits a restoration event unless it recovered runs,
in which case that interruption event shows the restored check state.

**Scope and retention:** counters and warning throttles are in-memory and reset
when this process restarts. They are not durable fleet-wide totals. Retain and
aggregate server logs across instances/restarts for historical rates. Sum
`interrupted_runs_last_check` only on `run_recovery_interrupted` events, not
repeated cumulative totals. No email, paging, or external notification service is configured by
these log warnings.

**Privacy:** monitoring accepts only numeric recovery outcomes. Logs contain no
note content, task text, run IDs, user IDs, execution tokens, raw exceptions,
SQL, or connection strings. Detailed data remains behind existing ownership
checks. Do not add error objects or user-derived labels to these records.

### Verification

`pnpm --filter @workspace/api-server test` includes deterministic monitoring
tests with a fake clock and recovery adapter. They cover threshold crossing,
cooldowns and clearing, periodic summaries, window expiry, streak resets,
overlapping sweeps, failed transactions, and privacy. No model calls are made.
