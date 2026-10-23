import { and, eq, inArray, max, or, sql } from "drizzle-orm";
import { db, runEventsTable, runsTable, tasksTable, type Run, type RunEvent, type RunStatus } from "@workspace/db";
import { transitionRunStatus } from "./run-domain";
import { shortDetail, type RunServiceDependencies } from "./run-service";
import { INTERRUPTION_MESSAGE, LEASE_SECONDS, RunLeaseLostError } from "./run-lease";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export const newLeaseExpiry = () => sql`clock_timestamp() + ${LEASE_SECONDS} * interval '1 second'`;
const activeStatus = inArray(runsTable.status, ["pending", "running"]);
const expiredLease = or(
  sql`${runsTable.leaseExpiresAt} <= clock_timestamp()`,
  // Pre-lease runs cannot have a live lease-aware worker. Give a rollout grace
  // period before retiring these historical pending/running records.
  and(
    sql`${runsTable.leaseExpiresAt} is null`,
    sql`${runsTable.startedAt} <= clock_timestamp() - ${LEASE_SECONDS} * interval '1 second'`,
  ),
);

async function appendEvent(
  tx: Transaction, runId: string, step: RunEvent["step"],
  status: RunEvent["status"], detail: string, durationMs = 0, attempt = 1,
) {
  // Every caller holds the run row lock, serializing event sequence allocation.
  const [last] = await tx.select({ sequence: max(runEventsTable.sequence) })
    .from(runEventsTable).where(eq(runEventsTable.runId, runId));
  await tx.insert(runEventsTable).values({
    runId, sequence: Number(last?.sequence ?? 0) + 1, step, status,
    detail: shortDetail(detail), durationMs: Math.max(0, Math.round(durationMs)), attempt,
  });
}

export function createRunStore(executionToken: string): Pick<
  RunServiceDependencies, "writeEvent" | "saveTasks"
> & { updateRunStatus(runId: string, status: RunStatus, error: string | null): Promise<Run> } {
  async function lockRun(tx: Transaction, runId: string, allowTerminal = false) {
    const [run] = await tx.select().from(runsTable)
      .where(eq(runsTable.id, runId)).for("update");
    if (!run || run.executionToken !== executionToken) throw new RunLeaseLostError();
    if (allowTerminal && (run.status === "failed" || run.status === "succeeded")) return run;
    const [active] = await tx.select({ id: runsTable.id }).from(runsTable).where(and(
      eq(runsTable.id, runId), activeStatus,
      sql`${runsTable.leaseExpiresAt} > clock_timestamp()`,
    ));
    if (!active) throw new RunLeaseLostError();
    return run;
  }

  return {
    writeEvent: (runId, step, status, detail, durationMs, attempt) =>
      db.transaction(async (tx) => {
        await lockRun(tx, runId, true);
        await appendEvent(tx, runId, step, status, detail, durationMs, attempt);
      }),
    updateRunStatus: (runId, next, error) => db.transaction(async (tx) => {
      const current = await lockRun(tx, runId);
      const status = transitionRunStatus(current.status, next);
      const terminal = status === "failed" || status === "succeeded";
      const [updated] = await tx.update(runsTable).set({
        status, error, finishedAt: terminal ? sql`clock_timestamp()` : null,
        leaseExpiresAt: terminal ? null : newLeaseExpiry(),
      }).where(eq(runsTable.id, runId)).returning();
      return updated;
    }),
    saveTasks: (runId, tasks) => db.transaction(async (tx) => {
      const run = await lockRun(tx, runId);
      if (run.status !== "running") throw new RunLeaseLostError();
      if (tasks.length) {
        await tx.insert(tasksTable).values(tasks.map((task) => ({
          runId, title: task.title, owner: task.owner,
          dueDate: task.due_date, priority: task.priority, done: false,
        })));
      }
    }),
  };
}

export async function renewRunLease(runId: string, executionToken: string): Promise<boolean> {
  const renewed = await db.update(runsTable).set({ leaseExpiresAt: newLeaseExpiry() })
    .where(and(
      eq(runsTable.id, runId), eq(runsTable.executionToken, executionToken),
      activeStatus, sql`${runsTable.leaseExpiresAt} > clock_timestamp()`,
    )).returning({ id: runsTable.id });
  return renewed.length === 1;
}

// Safe on every instance: row locks and an expiry recheck fence both other
// sweepers and stale workers. Status and its readable event commit together.
export async function recoverAbandonedRuns(): Promise<number> {
  return db.transaction(async (tx) => {
    const candidates = await tx.select({ id: runsTable.id }).from(runsTable)
      .where(and(activeStatus, expiredLease)).limit(100)
      .for("update", { skipLocked: true });
    let recovered = 0;
    for (const { id } of candidates) {
      const [failed] = await tx.update(runsTable).set({
        status: "failed", error: INTERRUPTION_MESSAGE, finishedAt: sql`clock_timestamp()`,
        executionToken: null, leaseExpiresAt: null,
      }).where(and(eq(runsTable.id, id), activeStatus, expiredLease)).returning({ id: runsTable.id });
      if (!failed) continue;
      await appendEvent(tx, id, "finish_run", "failed", INTERRUPTION_MESSAGE);
      recovered += 1;
    }
    return recovered;
  });
}
