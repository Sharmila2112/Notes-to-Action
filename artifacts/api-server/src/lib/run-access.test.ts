import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import express from "express";
import { clerkMiddleware } from "@clerk/express";
import { and, eq, inArray } from "drizzle-orm";
import { db, pool, runEventsTable, runsTable, tasksTable } from "@workspace/db";
import { createRunsRouter } from "../routes/runs";
import { requireUser } from "../middlewares/require-user";

test("run and task access is isolated by authenticated owner", async () => {
  const userA = `access-test-a-${randomUUID()}`;
  const userB = `access-test-b-${randomUUID()}`;
  const ids: string[] = [];
  const app = express();
  app.use(express.json());
  app.use(clerkMiddleware());
  // Only this in-process test app accepts a test identity header. The real
  // server uses the default requireUser middleware and never trusts headers.
  app.use("/api", createRunsRouter((req, res, next) => {
    const identity = req.header("x-test-user");
    if (!identity) {
      requireUser(req, res, next);
      return;
    }
    res.locals.userId = identity;
    next();
  }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api`;
  const request = (path: string, user?: string, method = "GET", body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(user ? { "x-test-user": user } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  try {
    for (const ownerUserId of [userA, userB, null]) {
      const [run] = await db.insert(runsTable).values({
        ownerUserId, inputText: `Private ${ownerUserId ?? "legacy"} notes`, status: "succeeded",
      }).returning();
      ids.push(run.id);
      await db.insert(runEventsTable).values({
        runId: run.id, sequence: 1, step: "receive_input",
        status: "succeeded", detail: "Private event",
      });
      await db.insert(tasksTable).values({
        runId: run.id, title: "Private task", owner: "Meeting assignee, not account owner",
        priority: "medium",
      });
    }
    const [runA, runB, legacy] = ids;
    const [taskA] = await db.select().from(tasksTable).where(eq(tasksTable.runId, runA));
    for (const [path, method, body] of [
      ["/runs", "GET"], ["/runs", "POST", { input_text: "", simulate_failures: false }],
      [`/runs/${runA}`, "GET"], [`/runs/${runA}/events`, "GET"],
      [`/tasks/${taskA.id}`, "PATCH", { done: true }],
    ] as const) {
      assert.equal((await request(path, undefined, method, body)).status, 401);
    }
    // A forged public ownership header cannot create an authenticated session.
    const forged = await fetch(`${base}/runs`, { headers: { "x-user-id": userA } });
    assert.equal(forged.status, 401);
    for (const [user, ownRun, otherRun] of [[userA, runA, runB], [userB, runB, runA]]) {
      const listResponse = await request("/runs", user);
      assert.equal(listResponse.headers.get("cache-control"), "private, no-store");
      const list = await listResponse.json() as { id: string }[];
      assert.deepEqual(list.map((run) => run.id), [ownRun]);
      assert.equal((await request(`/runs/${ownRun}`, user)).status, 200);
      const events = await request(`/runs/${ownRun}/events`, user);
      assert.equal(events.status, 200);
      assert.equal((await events.json() as unknown[]).length, 1);
      for (const forbidden of [otherRun, legacy, randomUUID()]) {
        assert.equal((await request(`/runs/${forbidden}`, user)).status, 404);
        assert.equal((await request(`/runs/${forbidden}/events`, user)).status, 404);
      }
    }
    assert.equal((await request(`/tasks/${taskA.id}`, userB, "PATCH", { done: true })).status, 404);
    const [unchanged] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskA.id));
    assert.equal(unchanged.done, false);
    const updated = await request(`/tasks/${taskA.id}`, userA, "PATCH", { done: true });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json() as { done: boolean }).done, true);
    const [legacyTask] = await db.select().from(tasksTable).where(eq(tasksTable.runId, legacy));
    assert.equal((await request(`/tasks/${legacyTask.id}`, userA, "PATCH", { done: true })).status, 404);
    assert.equal((await request(`/tasks/${randomUUID()}`, userA, "PATCH", { done: true })).status, 404);

    // Invalid notes exercise creation and ownership without spending model credits.
    const created = await request("/runs", userA, "POST", {
      input_text: "", simulate_failures: false, owner_user_id: userB, ownerUserId: userB,
    });
    assert.equal(created.status, 202);
    const createdRun = await created.json() as { id: string; status: string };
    ids.push(createdRun.id);
    assert.equal(createdRun.status, "failed");
    const [stored] = await db.select().from(runsTable).where(and(
      eq(runsTable.id, createdRun.id), eq(runsTable.ownerUserId, userA),
    ));
    assert(stored);
    assert.equal((await request(`/runs/${createdRun.id}`, userB)).status, 404);
    assert.equal((await request(`/runs/${createdRun.id}/events`, userB)).status, 404);
  } finally {
    await db.delete(runsTable).where(inArray(runsTable.id, ids));
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await pool.end();
  }
});
