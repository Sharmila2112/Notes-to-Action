import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { eq, inArray, sql } from "drizzle-orm";
import { db, pool, runsTable, runEventsTable, tasksTable, type RunStatus } from "@workspace/db";
import { createRunStore, newLeaseExpiry, recoverAbandonedRuns, renewRunLease } from "./run-store";
import { INTERRUPTION_MESSAGE, RunLeaseLostError } from "./run-lease";

// Persistence integration tests: no provider adapter is imported or invoked.
// Deadlines are moved in SQL; these tests never wait for real lease timeouts.
test("execution leases survive restarts and fence competing instances", async (t) => {
  const ids: string[] = [];
  const owner = `lease-test-${randomUUID()}`;
  const original = "  Original notes\n- Keep these notes exactly.  ";
  async function fixture(status: RunStatus = "running", legacy = false) {
    const token = randomUUID();
    const [run] = await db.insert(runsTable).values({
      ownerUserId: legacy ? null : owner, inputText: original, status,
      executionToken: legacy ? null : token,
      leaseExpiresAt: legacy ? null : newLeaseExpiry(),
    }).returning();
    ids.push(run.id);
    return { ...run, token };
  }
  async function expire(id: string) {
    await db.update(runsTable).set({
      leaseExpiresAt: sql`clock_timestamp() - interval '1 second'`,
    }).where(eq(runsTable.id, id));
  }
  async function read(id: string) {
    const [run] = await db.select().from(runsTable).where(eq(runsTable.id, id));
    return run;
  }

  try {
    await t.test("a restarted instance retires abandoned work once, without changing notes or ownership", async () => {
      const run = await fixture();
      const oldWorker = createRunStore(run.token);
      await oldWorker.writeEvent(run.id, "call_model", "started", "Model request started.");
      await expire(run.id); // Simulates no heartbeat after process termination.
      await Promise.all([recoverAbandonedRuns(), recoverAbandonedRuns()]);
      const failed = await read(run.id);
      assert.equal(failed.status, "failed");
      assert.equal(failed.error, INTERRUPTION_MESSAGE);
      assert.equal(failed.inputText, original);
      assert.equal(failed.ownerUserId, owner);
      assert(failed.finishedAt);
      assert.equal(failed.executionToken, null);
      const events = await db.select().from(runEventsTable)
        .where(eq(runEventsTable.runId, run.id)).orderBy(runEventsTable.sequence);
      assert.deepEqual(events.map((e) => e.sequence), [1, 2]);
      assert.equal(events[1].step, "finish_run");
      assert.equal(events[1].status, "failed");
      assert.equal(events[1].detail, INTERRUPTION_MESSAGE);
      await recoverAbandonedRuns();
      assert.deepEqual(await read(run.id), failed);
      assert.equal(await renewRunLease(run.id, run.token), false);
      await assert.rejects(oldWorker.updateRunStatus(run.id, "succeeded", null), RunLeaseLostError);
      await assert.rejects(oldWorker.saveTasks(run.id, [{
        title: "Late result", owner: "unassigned", due_date: null, priority: "medium",
      }]), RunLeaseLostError);
      await assert.rejects(oldWorker.writeEvent(run.id, "call_model", "succeeded", "Late event"), RunLeaseLostError);
      assert.deepEqual(await db.select().from(tasksTable).where(eq(tasksTable.runId, run.id)), []);
    });

    await t.test("healthy work on another instance survives startup and repeated sweeps regardless of age", async () => {
      const run = await fixture();
      await db.update(runsTable).set({
        startedAt: sql`clock_timestamp() - interval '1 day'`,
        leaseExpiresAt: sql`clock_timestamp() + interval '10 seconds'`,
      }).where(eq(runsTable.id, run.id));
      const before = await read(run.id);
      assert.equal(await renewRunLease(run.id, randomUUID()), false);
      assert.equal(await renewRunLease(run.id, run.token), true);
      const renewed = await read(run.id);
      assert(renewed.leaseExpiresAt! > before.leaseExpiresAt!);
      await Promise.all([recoverAbandonedRuns(), recoverAbandonedRuns()]);
      assert.equal((await read(run.id)).status, "running");
      assert.equal((await read(run.id)).error, null);
      await createRunStore(run.token).updateRunStatus(run.id, "succeeded", null);
      await recoverAbandonedRuns();
      assert.equal((await read(run.id)).status, "succeeded");
    });

    await t.test("expired leases cannot revive, even before the next sweep", async () => {
      const run = await fixture();
      await expire(run.id);
      assert.equal(await renewRunLease(run.id, run.token), false);
      const worker = createRunStore(run.token);
      await assert.rejects(worker.writeEvent(run.id, "call_model", "started", "No new call"), RunLeaseLostError);
      await assert.rejects(worker.updateRunStatus(run.id, "succeeded", null), RunLeaseLostError);
      await assert.rejects(worker.saveTasks(run.id, []), RunLeaseLostError);
      await recoverAbandonedRuns();
      assert.equal((await read(run.id)).status, "failed");
    });

    await t.test("recovery skips a row locked by a renewing worker and rechecks its new deadline", async () => {
      const run = await fixture();
      await expire(run.id);
      await db.transaction(async (tx) => {
        await tx.select().from(runsTable).where(eq(runsTable.id, run.id)).for("update");
        await recoverAbandonedRuns();
        assert.equal((await read(run.id)).status, "running");
        // Represent a renewal which obtained the row before a competing sweep.
        await tx.update(runsTable).set({ leaseExpiresAt: newLeaseExpiry() })
          .where(eq(runsTable.id, run.id));
      });
      await recoverAbandonedRuns();
      assert.equal((await read(run.id)).status, "running");
    });

    await t.test("pending crashes and pre-lease runs recover while recent legacy runs get a grace period", async () => {
      const pending = await fixture("pending");
      const oldLegacy = await fixture("running", true);
      const recentLegacy = await fixture("pending", true);
      await expire(pending.id);
      await db.update(runsTable).set({
        startedAt: sql`clock_timestamp() - interval '1 hour'`,
      }).where(eq(runsTable.id, oldLegacy.id));
      await recoverAbandonedRuns();
      assert.equal((await read(pending.id)).status, "failed");
      const legacy = await read(oldLegacy.id);
      assert.equal(legacy.status, "failed");
      assert.equal(legacy.ownerUserId, null);
      assert.equal(legacy.inputText, original);
      assert.equal((await read(recentLegacy.id)).status, "pending");
    });

    await t.test("terminal outcomes are never changed by recovery", async () => {
      for (const status of ["succeeded", "failed"] as const) {
        const run = await fixture(status);
        await expire(run.id);
        const before = await read(run.id);
        await recoverAbandonedRuns();
        assert.deepEqual(await read(run.id), before);
      }
    });
  } finally {
    await db.delete(runsTable).where(inArray(runsTable.id, ids));
    await pool.end();
  }
});
