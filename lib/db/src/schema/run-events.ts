import { createInsertSchema } from "drizzle-zod";
import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { runsTable } from "./runs";

export const runStepEnum = pgEnum("run_step", [
  "receive_input",
  "create_run",
  "call_model",
  "parse_output",
  "save_tasks",
  "finish_run",
]);

export const runEventStatusEnum = pgEnum("run_event_status", [
  "started",
  "succeeded",
  "failed",
  "retrying",
]);

export const runEventsTable = pgTable(
  "run_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runsTable.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    step: runStepEnum("step").notNull(),
    status: runEventStatusEnum("status").notNull(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
    durationMs: integer("duration_ms").notNull().default(0),
    detail: text("detail").notNull(),
    attempt: integer("attempt").notNull().default(1),
  },
  (table) => ({
    runSequenceUnique: uniqueIndex("run_events_run_sequence_idx").on(
      table.runId,
      table.sequence,
    ),
    runIdIdx: index("run_events_run_id_idx").on(table.runId),
  }),
);

export const insertRunEventSchema = createInsertSchema(runEventsTable).omit({
  id: true,
  timestamp: true,
});
export type InsertRunEvent = z.infer<typeof insertRunEventSchema>;
export type RunEvent = typeof runEventsTable.$inferSelect;
