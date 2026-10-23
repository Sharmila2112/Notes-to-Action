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
import {
  extractTasksFromLines,
  parseModelTasks,
  transitionRunStatus,
  type ExtractedTask,
} from "../lib/run-domain";

const router: IRouter = Router();
const MAX_INPUT_LENGTH = 10_000;
const MODEL_TIMEOUT_MS = 20_000;
const RETRY_DELAY_MS = 350;
const MODEL_NAME = "gpt-5.6-terra";

type Step = (typeof runEventsTable.step.enumValues)[number];
type EventStatus = (typeof runEventsTable.status.enumValues)[number];
type ApiRunRecord = Pick<
  Run,
  "id" | "inputText" | "status" | "startedAt" | "finishedAt" | "error"
>;

function shortDetail(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message.slice(0, 240);
}

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

async function finishRun(
  runId: string,
  finalStatus: "succeeded" | "failed",
  error: string | null = null,
): Promise<void> {
  const startedAt = Date.now();
  await writeEvent(runId, "finish_run", "started", "Finalizing the run status.");
  try {
    await updateRunStatus(runId, finalStatus, error);
    await writeEvent(
      runId,
      "finish_run",
      "succeeded",
      finalStatus === "succeeded"
        ? "Run completed successfully."
        : "Run marked failed; the original notes are retained.",
      Date.now() - startedAt,
    );
  } catch (cause) {
    await writeEvent(
      runId,
      "finish_run",
      "failed",
      `Could not finalize the run: ${shortDetail(cause)}`,
      Date.now() - startedAt,
    );
    throw cause;
  }
}

function modelPrompt(input: string, strict: boolean): string {
  return [
    strict
      ? "Return exactly one valid JSON object with a tasks array. Do not add markdown, prose, or code fences."
      : "Extract actionable tasks from the notes and return JSON only.",
    'Use this exact shape: {"tasks":[{"title":"...","owner":"person or unassigned","due_date":"YYYY-MM-DD or null","priority":"low|medium|high"}]}.',
    "Do not invent details. Use owner 'unassigned' and due_date null when absent. Each task must have a non-empty title and a valid priority.",
    "Meeting notes:",
    input,
  ].join("\n\n");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callModelWithRetry(
  runId: string,
  input: string,
  strict: boolean,
  simulateFailures: boolean,
  attemptState: { value: number; simulationChecked: boolean },
): Promise<string> {
  for (let localAttempt = 0; localAttempt < 2; localAttempt += 1) {
    const attempt = ++attemptState.value;
    const startedAt = Date.now();
    await writeEvent(
      runId,
      "call_model",
      "started",
      strict ? "Requesting a stricter JSON response from the model." : "Requesting task JSON from the model.",
      0,
      attempt,
    );
    try {
      if (simulateFailures && !attemptState.simulationChecked) {
        attemptState.simulationChecked = true;
        if (Math.random() < 0.5) {
          throw new Error("(demo mode) Simulated first-attempt model error.");
        }
      }

      const completion = await openai.chat.completions.create(
        {
          model: MODEL_NAME,
          max_completion_tokens: 8192,
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: modelPrompt(input, strict) }],
        },
        { signal: AbortSignal.timeout(MODEL_TIMEOUT_MS) },
      );
      const content = completion.choices[0]?.message?.content;
      if (!content) throw new Error("Model returned an empty response.");
      await writeEvent(
        runId,
        "call_model",
        "succeeded",
        "Model returned a JSON response.",
        Date.now() - startedAt,
        attempt,
      );
      return content;
    } catch (cause) {
      const detail = shortDetail(cause);
      await writeEvent(
        runId,
        "call_model",
        "failed",
        detail,
        Date.now() - startedAt,
        attempt,
      );
      if (localAttempt === 1) throw cause;

      await writeEvent(
        runId,
        "call_model",
        "retrying",
        detail.startsWith("(demo mode)")
          ? `(demo mode) Retrying once after the simulated model error.`
          : "Retrying once after the model call failed.",
        0,
        attempt + 1,
      );
      await delay(RETRY_DELAY_MS);
    }
  }
  throw new Error("Model call did not complete.");
}

async function parseTasksWithRecovery(
  runId: string,
  input: string,
  initialContent: string,
  simulateFailures: boolean,
  attemptState: { value: number; simulationChecked: boolean },
): Promise<ExtractedTask[]> {
  const firstStartedAt = Date.now();
  await writeEvent(
    runId,
    "parse_output",
    "started",
    "Parsing and validating model task JSON.",
    0,
    1,
  );

  try {
    const tasks = parseModelTasks(initialContent);
    await writeEvent(
      runId,
      "parse_output",
      "succeeded",
      `Found ${tasks.length} valid tasks.`,
      Date.now() - firstStartedAt,
      1,
    );
    return tasks;
  } catch (firstError) {
    await writeEvent(
      runId,
      "parse_output",
      "failed",
      shortDetail(firstError),
      Date.now() - firstStartedAt,
      1,
    );
    await writeEvent(
      runId,
      "call_model",
      "retrying",
      "Retrying once with a stricter JSON prompt after invalid output.",
      0,
      2,
    );

    const strictContent = await callModelWithRetry(
      runId,
      input,
      true,
      simulateFailures,
      attemptState,
    );
    const secondStartedAt = Date.now();
    await writeEvent(
      runId,
      "parse_output",
      "started",
      "Validating the stricter model response.",
      0,
      2,
    );
    try {
      const tasks = parseModelTasks(strictContent);
      await writeEvent(
        runId,
        "parse_output",
        "succeeded",
        `Strict response contained ${tasks.length} valid tasks.`,
        Date.now() - secondStartedAt,
        2,
      );
      return tasks;
    } catch (secondError) {
      await writeEvent(
        runId,
        "parse_output",
        "failed",
        shortDetail(secondError),
        Date.now() - secondStartedAt,
        2,
      );
      await writeEvent(
        runId,
        "parse_output",
        "retrying",
        "Using the line-based fallback after two invalid model responses.",
        0,
        3,
      );
      const tasks = extractTasksFromLines(input);
      await writeEvent(
        runId,
        "parse_output",
        "succeeded",
        `Fallback extracted ${tasks.length} task${tasks.length === 1 ? "" : "s"} from matching lines.`,
        0,
        3,
      );
      return tasks;
    }
  }
}

async function processRun(
  runId: string,
  input: string,
  simulateFailures: boolean,
): Promise<void> {
  try {
    const attemptState = { value: 0, simulationChecked: false };
    const initialContent = await callModelWithRetry(
      runId,
      input,
      false,
      simulateFailures,
      attemptState,
    );
    const tasks = await parseTasksWithRecovery(
      runId,
      input,
      initialContent,
      simulateFailures,
      attemptState,
    );

    const saveStartedAt = Date.now();
    await writeEvent(runId, "save_tasks", "started", "Saving extracted tasks.");
    try {
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
      await writeEvent(
        runId,
        "save_tasks",
        "succeeded",
        `Saved ${tasks.length} task${tasks.length === 1 ? "" : "s"}.`,
        Date.now() - saveStartedAt,
      );
    } catch (cause) {
      await writeEvent(
        runId,
        "save_tasks",
        "failed",
        `Could not save tasks: ${shortDetail(cause)}`,
        Date.now() - saveStartedAt,
      );
      throw cause;
    }

    await finishRun(runId, "succeeded");
  } catch (cause) {
    const message = shortDetail(cause);
    logger.error({ err: cause, runId }, "Task extraction run failed");
    try {
      await finishRun(runId, "failed", message);
    } catch (finishError) {
      logger.error({ err: finishError, runId }, "Could not mark failed run as terminal");
    }
  }
}

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
