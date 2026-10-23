import { createInsertSchema } from "drizzle-zod";
import { boolean, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const runStatusEnum = pgEnum("run_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
]);

export const runsTable = pgTable("runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  inputText: text("input_text").notNull(),
  status: runStatusEnum("status").notNull().default("pending"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  error: text("error"),
  simulateFailures: boolean("simulate_failures").notNull().default(false),
});

export const insertRunSchema = createInsertSchema(runsTable).omit({
  id: true,
  startedAt: true,
  finishedAt: true,
});
export type InsertRun = z.infer<typeof insertRunSchema>;
export type Run = typeof runsTable.$inferSelect;
export type RunStatus = Run["status"];
