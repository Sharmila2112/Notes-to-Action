import type { RunEvent } from "@workspace/db";
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
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutSignal?: (ms: number) => AbortSignal;
};

export function shortDetail(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message.slice(0, 240);
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

// No provider or database is loaded here. Production and tests supply adapters.
export function createRunService(deps: RunServiceDependencies) {
  const { writeEvent, updateRunStatus, saveTasks, createCompletion, reportError } = deps;
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutSignal = deps.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));

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
  ): Promise<string> {
    for (let localAttempt = 0; localAttempt < 2; localAttempt += 1) {
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
          if (random() < 0.5) {
            throw new Error("(demo mode) Simulated first-attempt model error.");
          }
        }
        const completion = await createCompletion(
          {
            model: "gpt-5.6-terra",
            max_completion_tokens: 8192,
            response_format: { type: "json_object" },
            messages: [{ role: "user", content: modelPrompt(input, strict) }],
          },
          { signal: timeoutSignal(20_000) },
        );
        const content = completion.choices[0]?.message?.content;
        if (!content) throw new Error("Model returned an empty response.");
        await writeEvent(
          runId, "call_model", "succeeded", "Model returned a JSON response.",
          now() - startedAt, attempt,
        );
        return content;
      } catch (cause) {
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
  ): Promise<ExtractedTask[]> {
    const firstStartedAt = now();
    await writeEvent(runId, "parse_output", "started", "Parsing and validating model task JSON.", 0, 1);
    try {
      const tasks = parseModelTasks(initialContent);
      await writeEvent(runId, "parse_output", "succeeded", `Found ${tasks.length} valid tasks.`, now() - firstStartedAt, 1);
      return tasks;
    } catch (firstError) {
      await writeEvent(runId, "parse_output", "failed", shortDetail(firstError), now() - firstStartedAt, 1);
      await writeEvent(
        runId, "call_model", "retrying",
        "Retrying once with a stricter JSON prompt after invalid output.", 0, attemptState.value + 1,
      );
      const strictContent = await callModelWithRetry(runId, input, true, simulateFailures, attemptState);
      const secondStartedAt = now();
      await writeEvent(runId, "parse_output", "started", "Validating the stricter model response.", 0, 2);
      try {
        const tasks = parseModelTasks(strictContent);
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
        const tasks = extractTasksFromLines(input);
        await writeEvent(
          runId, "parse_output", "succeeded",
          `Fallback extracted ${tasks.length} task${tasks.length === 1 ? "" : "s"} from matching lines.`, 0, 3,
        );
        return tasks;
      }
    }
  }

  async function processRun(runId: string, input: string, simulateFailures: boolean): Promise<void> {
    try {
      const attemptState = { value: 0, simulationChecked: false };
      const content = await callModelWithRetry(runId, input, false, simulateFailures, attemptState);
      const tasks = await parseTasksWithRecovery(runId, input, content, simulateFailures, attemptState);
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
      const message = shortDetail(cause);
      reportError(cause, runId, "Task extraction run failed");
      try {
        await finishRun(runId, "failed", message);
      } catch (finishError) {
        reportError(finishError, runId, "Could not mark failed run as terminal");
      }
    }
  }

  return { processRun, finishRun };
}
