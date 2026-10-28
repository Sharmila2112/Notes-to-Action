import type { RunEvent } from "@workspace/db";
import { HEARTBEAT_MS, RunLeaseLostError } from "./run-lease";
import { calendarDate } from "./task-rules";
import {
  extractTasksFromLines,
  parseModelTasks,
  type ExtractedTask,
  type RunStatus,
} from "./run-domain";

type ModelRequest = {
  model: string;
  max_completion_tokens: number;
  response_format: { type: "json_object" };
  messages: { role: "user"; content: string }[];
};

export type RunServiceDependencies = {
  writeEvent(
    runId: string,
    step: RunEvent["step"],
    status: RunEvent["status"],
    detail: string,
    durationMs?: number,
    attempt?: number,
  ): Promise<void>;
  updateRunStatus(runId: string, status: RunStatus, error: string | null): Promise<unknown>;
  saveTasks(runId: string, tasks: ExtractedTask[]): Promise<void>;
  createCompletion(
    request: ModelRequest,
    options: { signal: AbortSignal },
  ): Promise<{ choices: { message: { content?: string | null } }[] }>;
  reportError(error: unknown, runId: string, message: string): void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutSignal?: (ms: number) => AbortSignal;
  renewLease?: (runId: string) => Promise<boolean>;
  heartbeat?: (tick: () => void, intervalMs: number) => () => void;
};

export function shortDetail(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message.slice(0, 240);
}

function modelPrompt(input: string, strict: boolean, referenceDate: string): string {
  return [
    strict
      ? "Return exactly one valid JSON object with a tasks array. Do not add markdown, prose, or code fences."
      : "Extract actionable tasks from the notes and return JSON only.",
    'Use this exact shape: {"tasks":[{"title":"...","owner":"person or unassigned","due_date":"YYYY-MM-DD or null","priority":"low|medium|high"}]}.',
    "Do not invent details. Use owner 'unassigned' and due_date null when absent. Each task must have a non-empty title and a valid priority.",
    `Today is ${referenceDate}. Resolve relative deadlines against this calendar date, not your training date. A bare weekday means the upcoming occurrence (including today); 'end of month' means the last date of this month. If a deadline is ambiguous or tentative, use null.`,
    "Ownership rule: use the person named in the action, including its recipient or meeting participant, and preserve that name in the task title. 'Provide Priya with the revenue numbers' has owner Priya; 'Meet with Maya to discuss the hiring plan' has owner Maya. 'Ravi to book the demo' has owner Ravi. Do not treat email addresses as deadlines or owners. Use unassigned only when no person can be identified.",
    "Priority rule: HIGH (high) for dated tasks due within 3 calendar days of today, including today, the third day, and overdue tasks; MEDIUM (medium) for dated tasks further out; LOW (low) when due_date is null. Never default everything to medium.",
    "Merge duplicate descriptions of the same work into ONE task, retaining the more specific/actionable title and earliest non-null due date. A generic sync/discussion and the concrete deliverable it describes are one task, not two. For example, 'Sync with Priya on the Q3 deck. She needs the revenue numbers by Friday' means one task, 'Provide Priya with the revenue numbers for the Q3 deck', owned by Priya and due Friday. Do not merge distinct deliverables just because they share an owner.",
    "Meeting notes:",
    input,
  ].join("\n\n");
}

// No provider or database is loaded here. Production and tests supply adapters.
export function createRunService(deps: RunServiceDependencies) {
  const { writeEvent, updateRunStatus, saveTasks, createCompletion, reportError } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutSignal = deps.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));
  const heartbeat = deps.heartbeat ?? ((tick, intervalMs) => {
    const timer = setInterval(tick, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  });
  const leaseAbort = new AbortController();
  let leaseLost = false;
  function assertLease() {
    if (leaseLost) throw new RunLeaseLostError();
  }

  async function finishRun(
    runId: string,
    finalStatus: "succeeded" | "failed",
    error: string | null = null,
  ): Promise<void> {
    const startedAt = now();
    await writeEvent(runId, "finish_run", "started", "Finalizing the run status.");
    try {
      await updateRunStatus(runId, finalStatus, error);
      await writeEvent(
        runId, "finish_run", "succeeded",
        finalStatus === "succeeded"
          ? "Run completed successfully."
          : "Run marked failed; the original notes are retained.",
        now() - startedAt,
      );
    } catch (cause) {
      await writeEvent(
        runId, "finish_run", "failed",
        `Could not finalize the run: ${shortDetail(cause)}`,
        now() - startedAt,
      );
      throw cause;
    }
  }

  async function callModelWithRetry(
    runId: string,
    input: string,
    strict: boolean,
    simulateFailures: boolean,
    attemptState: { value: number; simulationChecked: boolean },
    referenceDate: string,
  ): Promise<string> {
    for (let localAttempt = 0; localAttempt < 2; localAttempt += 1) {
      assertLease();
      const attempt = ++attemptState.value;
      const startedAt = now();
      await writeEvent(
        runId, "call_model", "started",
        strict ? "Requesting a stricter JSON response from the model." : "Requesting task JSON from the model.",
        0, attempt,
      );
      try {
        if (simulateFailures && !attemptState.simulationChecked) {
          attemptState.simulationChecked = true;
          throw new Error("(demo mode) Simulated first-attempt model error.");
        }
        const completion = await createCompletion(
          {
            model: "gpt-5.6-terra",
            max_completion_tokens: 8192,
            response_format: { type: "json_object" },
            messages: [{ role: "user", content: modelPrompt(input, strict, referenceDate) }],
          },
          { signal: AbortSignal.any([timeoutSignal(20_000), leaseAbort.signal]) },
        );
        const content = completion.choices[0]?.message?.content;
        if (!content) throw new Error("Model returned an empty response.");
        await writeEvent(
          runId, "call_model", "succeeded", "Model returned a JSON response.",
          now() - startedAt, attempt,
        );
        return content;
      } catch (cause) {
        if (cause instanceof RunLeaseLostError || leaseLost) throw new RunLeaseLostError();
        const detail = shortDetail(cause);
        await writeEvent(runId, "call_model", "failed", detail, now() - startedAt, attempt);
        if (localAttempt === 1) throw cause;
        await writeEvent(
          runId, "call_model", "retrying",
          detail.startsWith("(demo mode)")
            ? "(demo mode) Retrying once after the simulated model error."
            : "Retrying once after the model call failed.",
          0, attempt + 1,
        );
        await sleep(350);
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
    referenceDate: string,
  ): Promise<ExtractedTask[]> {
    const firstStartedAt = now();
    await writeEvent(runId, "parse_output", "started", "Parsing and validating model task JSON.", 0, 1);
    try {
      const tasks = parseModelTasks(initialContent, referenceDate, input);
      await writeEvent(runId, "parse_output", "succeeded", `Found ${tasks.length} valid tasks.`, now() - firstStartedAt, 1);
      return tasks;
    } catch (firstError) {
      await writeEvent(runId, "parse_output", "failed", shortDetail(firstError), now() - firstStartedAt, 1);
      await writeEvent(
        runId, "call_model", "retrying",
        "Retrying once with a stricter JSON prompt after invalid output.", 0, attemptState.value + 1,
      );
      const strictContent = await callModelWithRetry(runId, input, true, simulateFailures, attemptState, referenceDate);
      const secondStartedAt = now();
      await writeEvent(runId, "parse_output", "started", "Validating the stricter model response.", 0, 2);
      try {
        const tasks = parseModelTasks(strictContent, referenceDate, input);
        await writeEvent(
          runId, "parse_output", "succeeded",
          `Strict response contained ${tasks.length} valid tasks.`, now() - secondStartedAt, 2,
        );
        return tasks;
      } catch (secondError) {
        await writeEvent(runId, "parse_output", "failed", shortDetail(secondError), now() - secondStartedAt, 2);
        await writeEvent(
          runId, "parse_output", "retrying",
          "Using the line-based fallback after two invalid model responses.", 0, 3,
        );
        const tasks = extractTasksFromLines(input, referenceDate);
        await writeEvent(
          runId, "parse_output", "succeeded",
          `Fallback extracted ${tasks.length} task${tasks.length === 1 ? "" : "s"} from matching lines.`, 0, 3,
        );
        return tasks;
      }
    }
  }

  async function processRun(runId: string, input: string, simulateFailures: boolean, referenceDate = calendarDate(now())): Promise<void> {
    let renewing = false;
    const renew = async () => {
      if (!deps.renewLease) return;
      if (!await deps.renewLease(runId)) throw new RunLeaseLostError();
    };
    const stopHeartbeat = deps.renewLease ? heartbeat(() => {
      if (renewing || leaseLost) return;
      renewing = true;
      void renew().catch((cause) => {
        leaseLost = true;
        leaseAbort.abort(new RunLeaseLostError());
        reportError(cause, runId, "Extraction stopped after losing its execution lease");
      }).finally(() => { renewing = false; });
    }, HEARTBEAT_MS) : () => {};
    try {
      await renew();
      assertLease();
      const attemptState = { value: 0, simulationChecked: false };
      const content = await callModelWithRetry(runId, input, false, simulateFailures, attemptState, referenceDate);
      const tasks = await parseTasksWithRecovery(runId, input, content, simulateFailures, attemptState, referenceDate);
      assertLease();
      const saveStartedAt = now();
      await writeEvent(runId, "save_tasks", "started", "Saving extracted tasks.");
      try {
        await saveTasks(runId, tasks);
        await writeEvent(
          runId, "save_tasks", "succeeded",
          `Saved ${tasks.length} task${tasks.length === 1 ? "" : "s"}.`, now() - saveStartedAt,
        );
      } catch (cause) {
        await writeEvent(
          runId, "save_tasks", "failed", `Could not save tasks: ${shortDetail(cause)}`, now() - saveStartedAt,
        );
        throw cause;
      }
      await finishRun(runId, "succeeded");
    } catch (cause) {
      // The recovery transaction owns terminal status after lease loss. Never
      // retry the provider or write late results over that terminal failure.
      if (cause instanceof RunLeaseLostError || leaseLost) return;
      const message = shortDetail(cause);
      reportError(cause, runId, "Task extraction run failed");
      try {
        await finishRun(runId, "failed", message);
      } catch (finishError) {
        reportError(finishError, runId, "Could not mark failed run as terminal");
      }
    } finally {
      stopHeartbeat();
    }
  }

  return { processRun, finishRun };
}
