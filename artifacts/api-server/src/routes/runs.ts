import { Router, type IRouter } from "express";
import { and, count, desc, eq, max } from "drizzle-orm";
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
  type RunStatus,
} from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "../lib/logger";
import { transitionRunStatus } from "../lib/run-domain";
import { createRunService, shortDetail } from "../lib/run-service";

const router: IRouter = Router();
const MAX_INPUT_LENGTH = 10_000;

type Step = (typeof runEventsTable.step.enumValues)[number];
type EventStatus = (typeof runEventsTable.status.enumValues)[number];
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

async function writeEvent(
  runId: string,
  step: Step,
  status: EventStatus,
  detail: string,
  durationMs = 0,
  attempt = 1,
): Promise<void> {
  const [lastEvent] = await db
    .select({ sequence: max(runEventsTable.sequence) })
    .from(runEventsTable)
    .where(eq(runEventsTable.runId, runId));

  await db.insert(runEventsTable).values({
    runId,
    sequence: Number(lastEvent?.sequence ?? 0) + 1,
    step,
    status,
    timestamp: new Date(),
    durationMs: Math.max(0, Math.round(durationMs)),
    detail: shortDetail(detail),
    attempt,
  });
}

async function updateRunStatus(
  runId: string,
  nextStatus: RunStatus,
  error: string | null,
): Promise<Run> {
  const [current] = await db
    .select()
    .from(runsTable)
    .where(eq(runsTable.id, runId))
    .limit(1);
  if (!current) throw new Error("Run not found while updating status");

  const status = transitionRunStatus(current.status, nextStatus);
  const [updated] = await db
    .update(runsTable)
    .set({
      status,
      error,
      finishedAt: status === "succeeded" || status === "failed" ? new Date() : null,
    })
    .where(and(eq(runsTable.id, runId), eq(runsTable.status, current.status)))
    .returning();
  if (!updated) throw new Error("Run status changed before this update completed");
  return updated;
}

const { finishRun, processRun } = createRunService({
  writeEvent,
  updateRunStatus,
  createCompletion: (request, options) => openai.chat.completions.create(request, options),
  reportError: (err, runId, message) => logger.error({ err, runId }, message),
  saveTasks: async (runId, tasks) => {
    await db.transaction(async (tx) => {
      if (tasks.length) {
        await tx.insert(tasksTable).values(
          tasks.map((task) => ({
            runId,
            title: task.title,
            owner: task.owner,
            dueDate: task.due_date,
            priority: task.priority,
            done: false,
          })),
        );
      }
    });
  },
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

  const [createdRun] = await db
    .insert(runsTable)
    .values({
      inputText,
      status: "pending",
      simulateFailures,
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
    .where(eq(runsTable.id, params.data.id))
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
    .where(eq(runsTable.id, params.data.id))
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
    .where(eq(tasksTable.id, params.data.id))
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

export default router;
