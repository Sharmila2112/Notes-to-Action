import { HEARTBEAT_MS } from "./run-lease";
import { recoverAbandonedRuns } from "./run-store";
import { logger } from "./logger";

// Startup recovery plus a periodic sweep also catches workers that disappear
// while another instance stays online. Never resumes work or invokes the model.
export async function startRunRecovery(): Promise<() => void> {
  let sweeping = false;
  async function sweep() {
    if (sweeping) return;
    sweeping = true;
    try {
      const recovered = await recoverAbandonedRuns();
      if (recovered) logger.info({ recovered }, "Interrupted extractions marked failed");
    } catch (err) {
      logger.error({ err }, "Could not recover interrupted extractions; will check again");
    } finally {
      sweeping = false;
    }
  }
  await sweep();
  const timer = setInterval(() => { void sweep(); }, HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}
