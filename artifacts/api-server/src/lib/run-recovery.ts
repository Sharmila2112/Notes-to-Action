import { HEARTBEAT_MS } from "./run-lease";
import { recoverAbandonedRuns } from "./run-store";
import { logger } from "./logger";
import { createRecoveryMonitor, createRecoverySweep } from "./run-recovery-monitor";

// Startup recovery plus a periodic sweep also catches workers that disappear
// while another instance stays online. Never resumes work or invokes the model.
export async function startRunRecovery(): Promise<() => void> {
  const monitor = createRecoveryMonitor({
    emit: (level, record) => logger[level](record, "Extraction recovery health"),
  });
  const sweep = createRecoverySweep({ recover: recoverAbandonedRuns, monitor });
  await sweep();
  const timer = setInterval(() => { void sweep(); }, HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}
