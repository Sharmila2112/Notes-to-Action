import { Router, type IRouter, type RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import {
  CreateRunBody,
  CreateRunResponse,
  GetRunEventsParams,
  GetRunEventsResponse,
  GetRunParams,
  GetRunResponse,
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
import { logger } from "../lib/logger";
import { requireUser } from "../middlewares/require-user";
import { createRunService } from "../lib/run-service";
import { createRunStore, newLeaseExpiry, renewRunLease } from "../lib/run-store";

const MAX_INPUT_LENGTH = 10_000;

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

// Tests supply a trusted identity middleware; production always uses Clerk.
export function createRunsRouter(authenticate: RequestHandler = requireUser): IRouter {
const router: IRouter = Router();
router.use(authenticate);
router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  next();
});

router.get("/runs", async (req, res): Promise<void> => {
  const rows = await db
    .select({
      id: runsTable.id,
      inputText: runsTable.inputText,
      status: runsTable.status,
      startedAt: runsTable.startedAt,
      finishedAt: runsTable.finishedAt,
      error: runsTable.error,
      taskCount: count(tasksTable.id),
    })
    .from(runsTable)
    .leftJoin(tasksTable, eq(tasksTable.runId, runsTable.id))
    .where(eq(runsTable.ownerUserId, res.locals.userId))
    .groupBy(runsTable.id)
    .orderBy(desc(runsTable.startedAt));
  const response = rows.map((row) => ({
    ...toRunApi(row),
    task_count: row.taskCount,
  }));
  res.json(ListRunsResponse.parse(response));
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
  const tasks = await db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.runId, run.id))
    .orderBy(tasksTable.title);
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
  };
  res.json(GetRunResponse.parse(response));
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
