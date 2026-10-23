import { createInsertSchema } from "drizzle-zod";
import { date, index, pgEnum, pgTable, text, uuid, boolean } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { runsTable } from "./runs";

export const taskPriorityEnum = pgEnum("task_priority", ["low", "medium", "high"]);

export const tasksTable = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runsTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  owner: text("owner").notNull().default("unassigned"),
  dueDate: date("due_date", { mode: "string" }),
  priority: taskPriorityEnum("priority").notNull().default("medium"),
  done: boolean("done").notNull().default(false),
}, (table) => [
  index("tasks_run_id_idx").on(table.runId),
]);

export const insertTaskSchema = createInsertSchema(tasksTable).omit({ id: true });
export type InsertTask = z.infer<typeof insertTaskSchema>;
export type Task = typeof tasksTable.$inferSelect;
