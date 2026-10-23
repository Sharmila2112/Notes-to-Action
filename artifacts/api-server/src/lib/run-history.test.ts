import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import express from "express";
import { clerkMiddleware } from "@clerk/express";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { GetRunResponse, ListRunsResponse } from "@workspace/api-zod";
import { db, pool, runsTable, tasksTable } from "@workspace/db";
import { createRunsRouter } from "../routes/runs";
import { requireUser } from "../middlewares/require-user";
import { encodeHistoryCursor } from "./run-history-cursor";

test("history pages are bounded, precise, private, and stable while newer runs arrive or anchors disappear", async (t) => {
  const owner = `history-test-${randomUUID()}`;
  const otherOwner = `history-other-${randomUUID()}`;
  const ids: string[] = [];
  const secretTail = "NOT-FOR-HISTORY-PAYLOAD";
  const notes = "🙂".repeat(230) + secretTail;
  const app = express();
  app.use(clerkMiddleware());
  // Trusted identity injection is local to this test app, never production.
  app.use("/api", createRunsRouter((req, res, next) => {
    const user = req.header("x-test-user");
    if (!user) { requireUser(req, res, next); return; }
    res.locals.userId = user;
    next();
  }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api`;
  const request = (suffix = "", user: string | null = owner) =>
    fetch(`${base}/runs${suffix}`, { headers: user ? { "x-test-user": user } : {} });
  const page = async (suffix = "", user = owner) => {
    const response = await request(suffix, user);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const raw = await response.json();
    assert.ok(!JSON.stringify(raw).includes(secretTail));
    assert.ok(!JSON.stringify(raw).includes('"input_text"'));
    assert.ok(!JSON.stringify(raw).includes('"owner_user_id"'));
    return ListRunsResponse.parse(raw);
  };

  try {
    const created = await db.insert(runsTable).values(Array.from({ length: 55 }, (_, index) => ({
      ownerUserId: owner, inputText: notes, status: "succeeded" as const,
      // Ties plus sub-millisecond differences catch cursor truncation bugs.
      startedAt: sql`'2026-10-23T12:00:00Z'::timestamptz + ${index % 3} * interval '1 microsecond'`,
    }))).returning({ id: runsTable.id });
    ids.push(...created.map((row) => row.id));
    const other = await db.insert(runsTable).values([otherOwner, otherOwner, otherOwner, null].map((ownerUserId) => ({
      ownerUserId, inputText: "Other account or unowned legacy notes", status: "succeeded" as const,
      startedAt: new Date("2026-10-22T12:00:00Z"),
    }))).returning({ id: runsTable.id });
    ids.push(...other.map((row) => row.id));
    const expected = (await db.select({ id: runsTable.id }).from(runsTable)
      .where(eq(runsTable.ownerUserId, owner))
      .orderBy(desc(runsTable.startedAt), desc(runsTable.id))).map((row) => row.id);
    await db.insert(tasksTable).values([0, 1].map((index) => ({
      runId: expected[0], title: `Task ${index}`, priority: "medium" as const,
    })));
    const first = await page();

    await t.test("default and maximum page sizes, short Unicode previews, and bounded task counts", async () => {
      assert.equal(first.items.length, 20);
      assert.deepEqual(first.items.map((row) => row.id), expected.slice(0, 20));
      assert.ok(first.next_cursor);
      assert.equal(first.items[0].task_count, 2);
      assert.ok(first.items.slice(1).every((row) => row.task_count === 0));
      assert.ok(first.items.every((row) => Array.from(row.input_preview).length === 200));
      const maximum = await page("?limit=50");
      assert.equal(maximum.items.length, 50);
      assert.ok(maximum.next_cursor);
      const detail = await fetch(`${base}/runs/${expected[0]}`, { headers: { "x-test-user": owner } });
      assert.equal(GetRunResponse.parse(await detail.json()).input_text, notes, "Detail still exposes full notes only to their owner");
    });

    await t.test("all pages visit equal timestamps and microsecond boundaries exactly once", async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const next = await page(`?limit=7${cursor ? `&cursor=${cursor}` : ""}`);
        assert.ok(next.items.length <= 7);
        seen.push(...next.items.map((row) => row.id));
        cursor = next.next_cursor;
        assert.ok(++pages < 20, "Pagination must terminate");
      } while (cursor);
      assert.deepEqual(seen, expected);
      assert.equal(new Set(seen).size, expected.length);
    });

    await t.test("invalid input fails closed, unauthenticated requests stay private, and empty history has no cursor", async () => {
      for (const suffix of [
        "?limit=0", "?limit=51", "?limit=-1", "?limit=1.5", "?limit=no",
        "?limit=2&limit=3", "?cursor=", "?cursor=no-json", `?cursor=${"a".repeat(257)}`,
        `?cursor=${encodeHistoryCursor("2026-02-30T12:00:00.000000Z", randomUUID())}`,
        "?cursor=one&cursor=two",
      ]) assert.equal((await request(suffix)).status, 400, suffix);
      assert.equal((await request("", null)).status, 401);
      assert.equal((await request("?limit=invalid", null)).status, 401);
      const empty = await page("", `new-owner-${randomUUID()}`);
      assert.deepEqual(empty, { items: [], next_cursor: null });
    });

    await t.test("cursor and forged ownership inputs cannot expose another account or legacy data", async () => {
      const theirs = await page(`?cursor=${first.next_cursor}&owner_user_id=${owner}`, otherOwner);
      assert.equal(theirs.items.length, 3);
      assert.ok(theirs.items.every((row) => other.slice(0, 3).some((item) => item.id === row.id)));
      assert.equal(theirs.next_cursor, null);
    });

    await t.test("large histories keep responses and database work bounded and use seeking indexes", async () => {
      assert.notEqual(process.env.NODE_ENV, "production", "Scale fixtures must never run in production");
      const owners = Array.from({ length: 6 }, () => `history-scale-${randomUUID()}`);
      const fixtureNote = `${"N".repeat(9_000)}${secretTail}`;
      const runCount = 2_400;
      const tasksPerRun = 12;
      const fixtureStartedAt = Date.parse("2026-01-01T00:00:00Z");

      try {
        const insertedRuns = await db.insert(runsTable).values(Array.from({ length: runCount }, (_, index) => ({
          ownerUserId: owners[index % owners.length],
          inputText: fixtureNote,
          status: "succeeded" as const,
          startedAt: new Date(fixtureStartedAt + index * 1_000),
        }))).returning({ id: runsTable.id, ownerUserId: runsTable.ownerUserId });

        const fixtureTasks = insertedRuns.flatMap((run) =>
          Array.from({ length: tasksPerRun }, (_, index) => ({
            runId: run.id,
            title: `Scale fixture task ${index + 1}`,
            priority: "medium" as const,
          })),
        );
        for (let offset = 0; offset < fixtureTasks.length; offset += 5_000) {
          await db.insert(tasksTable).values(fixtureTasks.slice(offset, offset + 5_000));
        }

        const scaleOwner = owners[0];
        const expectedIds = (await db.select({ id: runsTable.id }).from(runsTable)
          .where(eq(runsTable.ownerUserId, scaleOwner))
          .orderBy(desc(runsTable.startedAt), desc(runsTable.id))).map((row) => row.id);
        assert.equal(expectedIds.length, runCount / owners.length);
        const deepOffset = 320;
        const [anchor] = await db.select({
          id: runsTable.id,
          cursorAt: sql<string>`to_char(${runsTable.startedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        }).from(runsTable)
          .where(eq(runsTable.ownerUserId, scaleOwner))
          .orderBy(desc(runsTable.startedAt), desc(runsTable.id))
          .offset(deepOffset)
          .limit(1);
        assert.ok(anchor);
        const cursor = encodeHistoryCursor(anchor.cursorAt, anchor.id);

        const capturedQueries: Array<{ text: string; values: unknown[] }> = [];
        const hookedPool = pool as unknown as { query: (...args: any[]) => any };
        const hadOwnQuery = Object.hasOwn(pool, "query");
        const originalQuery = hookedPool.query;
        hookedPool.query = (...args: any[]) => {
          const config = args[0];
          const text = typeof config === "string" ? config : config.text;
          const values = Array.isArray(args[1]) ? args[1] : config.values ?? [];
          capturedQueries.push({ text, values });
          return originalQuery.apply(pool, args);
        };

        let responseText = "";
        try {
          const response = await request(`?limit=50&cursor=${cursor}`, scaleOwner);
          assert.equal(response.status, 200);
          assert.equal(response.headers.get("cache-control"), "private, no-store");
          responseText = await response.text();
        } finally {
          if (hadOwnQuery) hookedPool.query = originalQuery;
          else delete (hookedPool as unknown as { query?: (...args: any[]) => any }).query;
        }

        assert.ok(Buffer.byteLength(responseText!, "utf8") < 20_000, "A 50-run page must not return full notes or task records");
        assert.ok(!responseText!.includes(secretTail), "Long-note fixture suffix must not appear in history responses");
        const rawPage: unknown = JSON.parse(responseText!);
        assert.ok(!JSON.stringify(rawPage).includes('"input_text"'));
        const scalePage = ListRunsResponse.parse(rawPage);
        assert.equal(scalePage.items.length, 50);
        assert.deepEqual(scalePage.items.map((row) => row.id), expectedIds.slice(deepOffset + 1, deepOffset + 51));
        assert.ok(scalePage.items.every((row) => row.task_count === tasksPerRun));
        assert.ok(scalePage.next_cursor);

        assert.equal(capturedQueries.length, 2, "History listing must issue only the run page query and its page-scoped task count");
        const [listQuery, taskCountQuery] = capturedQueries;
        const normalizedListSql = listQuery.text.replaceAll('"', "").toLowerCase();
        const normalizedTaskSql = taskCountQuery.text.replaceAll('"', "").toLowerCase();
        assert.match(normalizedListSql, /left\([^)]*input_text[^)]*,\s*200\)/);
        assert.match(normalizedListSql, /owner_user_id/);
        assert.match(normalizedListSql, /limit\s+\$\d+/);
        assert.doesNotMatch(normalizedListSql, /select\s+\*/);
        assert.ok(listQuery.values.includes(51), "The run query may fetch only one extra row to detect another page");
        assert.match(normalizedTaskSql, /from\s+tasks/);
        assert.match(normalizedTaskSql, /run_id\s+in\s*\(/);
        assert.match(normalizedTaskSql, /count\(\*\)/);
        assert.match(normalizedTaskSql, /group by\s+tasks?\.?run_id|group by\s+run_id/);
        assert.doesNotMatch(normalizedTaskSql, /join\s+runs/);
        assert.equal(taskCountQuery.values.length, 50, "Task counts must be restricted to the visible page IDs");

        await pool.query("ANALYZE runs");
        await pool.query("ANALYZE tasks");
        const runPlan = await pool.query(
          `EXPLAIN (FORMAT JSON)
           SELECT id FROM runs
           WHERE owner_user_id = $1
             AND (started_at, id) < ($2::timestamptz, $3::uuid)
           ORDER BY started_at DESC, id DESC
           LIMIT 51`,
          [scaleOwner, anchor.cursorAt, anchor.id],
        );
        const taskPlan = await pool.query(
          `EXPLAIN (FORMAT JSON)
           SELECT run_id, count(*) FROM tasks
           WHERE run_id = ANY($1::uuid[])
           GROUP BY run_id`,
          [scalePage.items.map((row) => row.id)],
        );
        assert.match(JSON.stringify(runPlan.rows[0]["QUERY PLAN"]), /runs_owner_started_id_idx/);
        assert.match(JSON.stringify(taskPlan.rows[0]["QUERY PLAN"]), /tasks_run_id_idx/);

        const runIndex = await pool.query(
          "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1 AND indexname = $2",
          ["runs", "runs_owner_started_id_idx"],
        );
        const taskIndex = await pool.query(
          "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1 AND indexname = $2",
          ["tasks", "tasks_run_id_idx"],
        );
        assert.equal(runIndex.rowCount, 1);
        assert.match(runIndex.rows[0].indexdef, /\(owner_user_id, started_at, id\)/);
        assert.equal(taskIndex.rowCount, 1);
        assert.match(taskIndex.rows[0].indexdef, /\(run_id\)/);
      } finally {
        await db.delete(runsTable).where(inArray(runsTable.ownerUserId, owners));
      }
    });

    await t.test("newer inserts do not shift older pages and deleting the cursor anchor does not break pagination", async () => {
      const [newer] = await db.insert(runsTable).values({
        ownerUserId: owner, inputText: notes, status: "pending",
        startedAt: new Date("2026-10-23T13:00:00Z"),
      }).returning({ id: runsTable.id });
      ids.push(newer.id);
      const remaining = await page(`?limit=50&cursor=${first.next_cursor}`);
      assert.deepEqual(remaining.items.map((row) => row.id), expected.slice(20));
      assert.equal(remaining.next_cursor, null);
      assert.equal((await page()).items[0].id, newer.id);
      await db.delete(runsTable).where(eq(runsTable.id, first.items.at(-1)!.id));
      const afterDelete = await page(`?limit=50&cursor=${first.next_cursor}`);
      assert.deepEqual(afterDelete.items.map((row) => row.id), expected.slice(20));
    });
  } finally {
    await db.delete(runsTable).where(inArray(runsTable.id, ids));
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    await pool.end();
  }
});
