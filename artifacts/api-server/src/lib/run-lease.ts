// Shared lease policy. Expiry is measured by PostgreSQL, never a server's clock.
export const LEASE_SECONDS = 300;
export const HEARTBEAT_MS = 15_000;
export const INTERRUPTION_MESSAGE =
  "Extraction was interrupted because its execution lease expired. Your original notes are retained. Use Retry to start a new extraction; no automatic retry was made.";

export class RunLeaseLostError extends Error {
  constructor() {
    super("This extraction no longer holds an active execution lease.");
    this.name = "RunLeaseLostError";
  }
}
