import { eq } from "drizzle-orm";
import { db, runEventsTable, runsTable, tasksTable } from "@workspace/db";
import { logger } from "./lib/logger";

const exampleRunId = "f349ee12-f1f2-4ac6-8677-7615042b6480";
const finishedAt = new Date();
const startedAt = new Date(finishedAt.getTime() - 1_850);

async function seed(): Promise<void> {
  const [existing] = await db
    .select({ id: runsTable.id })
    .from(runsTable)
    .where(eq(runsTable.id, exampleRunId))
    .limit(1);
  if (existing) {
    logger.info("Example Notes to Action run is already seeded");
    return;
  }

  const inputText =
    "Project sync\n- Maya to send the revised timeline by Friday\nTODO: schedule a customer review\n[ ] Jordan to share the launch checklist";

  await db.transaction(async (tx) => {
    await tx.insert(runsTable).values({
      id: exampleRunId,
      inputText,
      status: "succeeded",
      startedAt,
      finishedAt,
      simulateFailures: false,
    });
    await tx.insert(tasksTable).values([
      {
        runId: exampleRunId,
        title: "Send the revised timeline",
        owner: "Maya",
        dueDate: null,
        priority: "high",
        done: false,
      },
      {
        runId: exampleRunId,
        title: "Schedule a customer review",
        owner: "unassigned",
        dueDate: null,
        priority: "medium",
        done: false,
      },
      {
        runId: exampleRunId,
        title: "Share the launch checklist",
        owner: "Jordan",
        dueDate: null,
        priority: "medium",
        done: false,
      },
    ]);

    const stepEvents = [
      ["receive_input", `Accepted ${inputText.length} characters of notes.`, 3],
      ["create_run", "Run record is active.", 2],
      ["call_model", "Model returned a JSON response.", 1_520],
      ["parse_output", "Found 3 valid tasks.", 7],
      ["save_tasks", "Saved 3 tasks.", 18],
      ["finish_run", "Run completed successfully.", 5],
    ] as const;
    let sequence = 0;
    let eventTime = startedAt.getTime();
    for (const [step, detail, durationMs] of stepEvents) {
      await tx.insert(runEventsTable).values({
        runId: exampleRunId,
        sequence: ++sequence,
        step,
        status: "started",
        timestamp: new Date(eventTime),
        durationMs: 0,
        detail: `Started ${step}.`,
        attempt: 1,
      });
      eventTime += durationMs;
      await tx.insert(runEventsTable).values({
        runId: exampleRunId,
        sequence: ++sequence,
        step,
        status: "succeeded",
        timestamp: new Date(eventTime),
        durationMs,
        detail,
        attempt: 1,
      });
      eventTime += 1;
    }
  });
  logger.info({ runId: exampleRunId }, "Seeded example Notes to Action run");
}

seed()
  .catch((error) => {
    logger.error({ err: error }, "Could not seed Notes to Action example data");
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$client.end();
  });
