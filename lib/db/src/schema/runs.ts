import { createInsertSchema } from "drizzle-zod";
import { boolean, index, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const runStatusEnum = pgEnum("run_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
]);

export const runsTable = pgTable("runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Null only for legacy shared runs, which are never exposed to visitors.
  ownerUserId: text("owner_user_id"),
  inputText: text("input_text").notNull(),
  status: runStatusEnum("status").notNull().default("pending"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  error: text("error"),
  simulateFailures: boolean("simulate_failures").notNull().default(false),
  executionToken: uuid("execution_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
}, (table) => [
  index("runs_owner_user_id_idx").on(table.ownerUserId),
  index("runs_owner_started_id_idx").on(table.ownerUserId, table.startedAt, table.id),
  index("runs_status_lease_idx").on(table.status, table.leaseExpiresAt),
]);

export const insertRunSchema = createInsertSchema(runsTable).omit({
  id: true,
  startedAt: true,
  finishedAt: true,
});
export type InsertRun = z.infer<typeof insertRunSchema>;
export type Run = typeof runsTable.$inferSelect;
export type RunStatus = Run["status"];
