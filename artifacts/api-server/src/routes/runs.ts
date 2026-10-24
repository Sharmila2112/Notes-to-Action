import { Router, type IRouter, type RequestHandler, type Response } from "express";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import {
  CreateRunBody,
  CreateRunResponse,
  GetRunEventsParams,
  GetRunEventsResponse,
  GetRunParams,
  GetRunResponse,
  GetRunTasksParams,
  GetRunTasksResponse,
  ListRunsQueryParams,
  ListRunsResponse,
  UpdateTaskBody,
  UpdateTaskParams,
  UpdateTaskResponse,
} from "@workspace/api-zod";
import {
  db,
  runEventsTable,
  runsTable,
  tasksTable,
  type Run,
} from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import { logger, logRunHistoryMetric, type RunHistoryMetricSink } from "../lib/logger";
import { runHistoryMonitor, type RunHistoryMonitor } from "../lib/run-history-monitor";
import { requireUser } from "../middlewares/require-user";
import { createRunService } from "../lib/run-service";
import { createRunStore, newLeaseExpiry, renewRunLease } from "../lib/run-store";
import { decodeHistoryCursor, encodeHistoryCursor } from "../lib/run-history-cursor";

const MAX_INPUT_LENGTH = 10_000;
const RUN_DETAIL_TASK_PAGE_SIZE = 100;

type ApiRunRecord = Pick<
  Run,
  "id" | "inputText" | "status" | "startedAt" | "finishedAt" | "error"
>;

function toRunApi(run: ApiRunRecord) {
  return {
    id: run.id,
    input_text: run.inputText,
    status: run.status,
    started_at: run.startedAt.toISOString(),
    finished_at: run.finishedAt?.toISOString() ?? null,
    error: run.error,
  };
}

function responseBytes(res: Response, body: unknown): number {
  const contentLength = res.getHeader("content-length");
  const measured = typeof contentLength === "number" ? contentLength
    : typeof contentLength === "string" ? Number(contentLength) : NaN;
  if (Number.isSafeInteger(measured) && measured >= 0) return measured;
  return Buffer.byteLength(JSON.stringify(body) ?? "", "utf8");
}

// Tests supply a trusted identity middleware; production always uses Clerk.
export function createRunsRouter(
  authenticate: RequestHandler = requireUser,
  runHistoryMetricSink?: RunHistoryMetricSink,
  historyMonitor: Pick<RunHistoryMonitor, "record"> = runHistoryMonitor,
): IRouter {
const router: IRouter = Router();
router.use(authenticate);
router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  next();
});

router.get("/runs", async (req, res): Promise<void> => {
  const startedAt = performance.now();
  let pageSize = 0;
  let metricRecorded = false;
  const recordMetric = (
    outcome: "success" | "invalid" | "error",
    resultCount: number,
    responseBytes: number | null,
    hasNextPage: boolean,
  ) => {
    metricRecorded = true;
    logRunHistoryMetric({
      outcome,
      durationMs: performance.now() - startedAt,
      pageSize,
      resultCount,
      responseBytes,
      hasNextPage,
    }, (record) => {
      if (runHistoryMetricSink) runHistoryMetricSink(record);
      else logger.info(record, "Run history request");
      historyMonitor.record(record);
    });
  };
  const rejectPagination = (message: string) => {
    const body = { error: message };
    res.status(400).json(body);
    recordMetric(
      "invalid",
      0,
      responseBytes(res, body),
      false,
    );
  };

  try {
    if (
      (req.query.limit !== undefined && typeof req.query.limit !== "string") ||
      (req.query.cursor !== undefined && typeof req.query.cursor !== "string")
    ) {
      rejectPagination("Invalid history pagination.");
      return;
    }
    const query = ListRunsQueryParams.safeParse(req.query);
    if (!query.success) {
      rejectPagination("Invalid history pagination.");
      return;
    }
    pageSize = query.data.limit ?? 20;
    let cursor: ReturnType<typeof decodeHistoryCursor> | undefined;
    try {
      if (query.data.cursor) cursor = decodeHistoryCursor(query.data.cursor);
    } catch {
      rejectPagination("Invalid history cursor. Refresh your history and try again.");
      return;
    }
    const limit = pageSize;
    const rows = await db
      .select({
        id: runsTable.id,
        inputPreview: sql<string>`left(${runsTable.inputText}, 200)`,
        status: runsTable.status,
        startedAt: runsTable.startedAt,
        finishedAt: runsTable.finishedAt,
        // JS Date loses microseconds. Keep the exact DB timestamp for the cursor.
        cursorAt: sql<string>`to_char(${runsTable.startedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(runsTable)
      .where(and(
        eq(runsTable.ownerUserId, res.locals.userId),
        cursor ? sql`(${runsTable.startedAt}, ${runsTable.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : undefined,
      ))
      .orderBy(desc(runsTable.startedAt), desc(runsTable.id))
      .limit(limit + 1);
    const visible = rows.slice(0, limit);
    // Count tasks only for the bounded, owner-scoped page, not the entire history.
    const counts = visible.length ? await db
      .select({ runId: tasksTable.runId, taskCount: count() })
      .from(tasksTable).where(inArray(tasksTable.runId, visible.map((row) => row.id)))
      .groupBy(tasksTable.runId) : [];
    const countById = new Map(counts.map((row) => [row.runId, row.taskCount]));
    const last = visible.at(-1);
    const response = ListRunsResponse.parse({
      items: visible.map((row) => ({
        id: row.id,
        input_preview: row.inputPreview,
        status: row.status,
        started_at: row.startedAt.toISOString(),
        finished_at: row.finishedAt?.toISOString() ?? null,
        task_count: countById.get(row.id) ?? 0,
      })),
      next_cursor: rows.length > limit && last ? encodeHistoryCursor(last.cursorAt, last.id) : null,
    });
    res.json(response);
    recordMetric(
      "success",
      visible.length,
      responseBytes(res, response),
      rows.length > limit,
    );
  } catch (error) {
    if (!metricRecorded) recordMetric("error", 0, null, false);
    throw error;
  }
});

router.post("/runs", async (req, res): Promise<void> => {
  const rawBody: unknown = req.body;
  const rawRecord =
    rawBody && typeof rawBody === "object"
      ? (rawBody as Record<string, unknown>)
      : {};
  const inputText =
    typeof rawRecord.input_text === "string" ? rawRecord.input_text : "";
  const simulateFailures = rawRecord.simulate_failures === true;
  const executionToken = randomUUID();
  const store = createRunStore(executionToken);
  const { writeEvent, updateRunStatus } = store;
  const { finishRun, processRun } = createRunService({
    ...store,
    renewLease: (runId) => renewRunLease(runId, executionToken),
    createCompletion: (request, options) => openai.chat.completions.create(request, options),
    reportError: (err, runId, message) => logger.error({ err, runId }, message),
  });

  const [createdRun] = await db
    .insert(runsTable)
    .values({
      ownerUserId: res.locals.userId,
      inputText,
      status: "pending",
      simulateFailures,
      executionToken,
      leaseExpiresAt: newLeaseExpiry(),
    })
    .returning();

  const receiveStartedAt = Date.now();
  await writeEvent(
    createdRun.id,
    "receive_input",
    "started",
    "Received notes; validating the input.",
  );

  const parsedBody = CreateRunBody.safeParse(rawBody);
  let validationError: string | null = null;
  if (!parsedBody.success) {
    validationError = "Provide notes and a Simulate failures setting.";
  } else if (!parsedBody.data.input_text.trim()) {
    validationError = "Add some notes before extracting tasks.";
  } else if (parsedBody.data.input_text.length > MAX_INPUT_LENGTH) {
    validationError = "Notes must be 10,000 characters or fewer.";
  }

  if (validationError) {
    await writeEvent(
      createdRun.id,
      "receive_input",
      "failed",
      validationError,
      Date.now() - receiveStartedAt,
    );
    await finishRun(createdRun.id, "failed", validationError);
    const [failedRun] = await db
      .select()
      .from(runsTable)
      .where(eq(runsTable.id, createdRun.id))
      .limit(1);
    res
      .status(202)
      .json(CreateRunResponse.parse({ ...toRunApi(failedRun), tasks: [] }));
    return;
  }

  if (!parsedBody.success) {
    throw new Error("Invalid extraction request.");
  }

  const validated = parsedBody.data;
  await writeEvent(
    createdRun.id,
    "receive_input",
    "succeeded",
    `Accepted ${validated.input_text.length} characters of notes.`,
    Date.now() - receiveStartedAt,
  );

  const createStartedAt = Date.now();
  await writeEvent(
    createdRun.id,
    "create_run",
    "started",
    "Changing the run from pending to running.",
  );
  const runningRun = await updateRunStatus(createdRun.id, "running", null);
  await writeEvent(
    createdRun.id,
    "create_run",
    "succeeded",
    "Run record is active.",
    Date.now() - createStartedAt,
  );

  res
    .status(202)
    .json(CreateRunResponse.parse({ ...toRunApi(runningRun), tasks: [] }));
  setTimeout(() => {
    void processRun(
      createdRun.id,
      validated.input_text,
      validated.simulate_failures,
    );
  }, 0);
});

router.get("/runs/:id", async (req, res): Promise<void> => {
  const params = GetRunParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [run] = await db
    .select()
    .from(runsTable)
    .where(and(eq(runsTable.id, params.data.id), eq(runsTable.ownerUserId, res.locals.userId)))
    .limit(1);
  if (!run) {
    res.status(404).json({ error: "Run not found." });
    return;
  }
  const taskRows = await db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.runId, run.id))
    .orderBy(asc(tasksTable.title), asc(tasksTable.id))
    .limit(RUN_DETAIL_TASK_PAGE_SIZE + 1);
  const hasMoreTasks = taskRows.length > RUN_DETAIL_TASK_PAGE_SIZE;
  const tasks = taskRows.slice(0, RUN_DETAIL_TASK_PAGE_SIZE);
  let taskCount = tasks.length;
  if (hasMoreTasks) {
    const [total] = await db
      .select({ total: count() })
      .from(tasksTable)
      .where(eq(tasksTable.runId, run.id));
    taskCount = total?.total ?? tasks.length;
  }
  const response = {
    ...toRunApi(run),
    tasks: tasks.map((task) => ({
      id: task.id,
      run_id: task.runId,
      title: task.title,
      owner: task.owner,
      due_date: task.dueDate,
      priority: task.priority,
      done: task.done,
    })),
    task_count: taskCount,
    next_tasks_cursor: hasMoreTasks ? tasks.at(-1)?.id ?? null : null,
  };
  res.json(GetRunResponse.parse(response));
});

router.get("/runs/:id/tasks/:cursor", async (req, res): Promise<void> => {
  const params = GetRunTasksParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid task page cursor." });
    return;
  }
  const [run] = await db
    .select({ id: runsTable.id })
    .from(runsTable)
    .where(and(eq(runsTable.id, params.data.id), eq(runsTable.ownerUserId, res.locals.userId)))
    .limit(1);
  if (!run) {
    res.status(404).json({ error: "Run not found." });
    return;
  }

  const cursor = params.data.cursor;
  let afterTask: { id: string; title: string } | undefined;
  if (cursor !== "start") {
    [afterTask] = await db
      .select({ id: tasksTable.id, title: tasksTable.title })
      .from(tasksTable)
      .where(and(eq(tasksTable.id, cursor), eq(tasksTable.runId, run.id)))
      .limit(1);
    if (!afterTask) {
      res.status(400).json({ error: "Invalid task page cursor." });
      return;
    }
  }
  const where = afterTask
    ? and(
      eq(tasksTable.runId, run.id),
      sql`(${tasksTable.title}, ${tasksTable.id}) > (${afterTask.title}, ${afterTask.id})`,
    )
    : eq(tasksTable.runId, run.id);
  const rows = await db
    .select()
    .from(tasksTable)
    .where(where)
    .orderBy(asc(tasksTable.title), asc(tasksTable.id))
    .limit(RUN_DETAIL_TASK_PAGE_SIZE + 1);
  const items = rows.slice(0, RUN_DETAIL_TASK_PAGE_SIZE).map((task) => ({
    id: task.id,
    run_id: task.runId,
    title: task.title,
    owner: task.owner,
    due_date: task.dueDate,
    priority: task.priority,
    done: task.done,
  }));
  const response = {
    items,
    next_cursor: rows.length > RUN_DETAIL_TASK_PAGE_SIZE ? items.at(-1)?.id ?? null : null,
  };
  res.json(GetRunTasksResponse.parse(response));
});

router.get("/runs/:id/events", async (req, res): Promise<void> => {
  const params = GetRunEventsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [run] = await db
    .select({ id: runsTable.id })
    .from(runsTable)
    .where(and(eq(runsTable.id, params.data.id), eq(runsTable.ownerUserId, res.locals.userId)))
    .limit(1);
  if (!run) {
    res.status(404).json({ error: "Run not found." });
    return;
  }

  const events = await db
    .select()
    .from(runEventsTable)
    .where(eq(runEventsTable.runId, run.id))
    .orderBy(runEventsTable.sequence);
  const response = events.map((event) => ({
    id: event.id,
    run_id: event.runId,
    sequence: event.sequence,
    step: event.step,
    status: event.status,
    timestamp: event.timestamp.toISOString(),
    duration_ms: event.durationMs,
    detail: event.detail,
    attempt: event.attempt,
  }));
  res.json(GetRunEventsResponse.parse(response));
});

router.patch("/tasks/:id", async (req, res): Promise<void> => {
  const params = UpdateTaskParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpdateTaskBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [task] = await db
    .update(tasksTable)
    .set({ done: body.data.done })
    .where(and(
      eq(tasksTable.id, params.data.id),
      inArray(tasksTable.runId, db.select({ id: runsTable.id }).from(runsTable)
        .where(eq(runsTable.ownerUserId, res.locals.userId))),
    ))
    .returning();
  if (!task) {
    res.status(404).json({ error: "Task not found." });
    return;
  }
  res.json(
    UpdateTaskResponse.parse({
      id: task.id,
      run_id: task.runId,
      title: task.title,
      owner: task.owner,
      due_date: task.dueDate,
      priority: task.priority,
      done: task.done,
    }),
  );
});

return router;
}

export default createRunsRouter();
