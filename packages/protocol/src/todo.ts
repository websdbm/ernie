import { z } from 'zod';

/** One identity for a task in both the hierarchy and the day's timeline. */
export const TodoSlot = z.object({
  id: z.uuid(),
  startAt: z.iso.datetime({ offset: true }),
  endAt: z.iso.datetime({ offset: true }),
  fixed: z.boolean().default(false),
  reminderMinutes: z.number().int().min(0).max(1440).nullable().default(null),
});
export type TodoSlot = z.infer<typeof TodoSlot>;

export const TodoItem = z.object({
  id: z.uuid(),
  parentId: z.uuid().nullable().default(null),
  title: z.string().trim().min(1).max(160),
  notes: z.string().max(2000).default(''),
  kind: z.enum(['group', 'task']).default('task'),
  status: z.enum(['pending', 'done', 'cancelled']).default('pending'),
  position: z.number().int().min(0).default(0),
  estimatedMinutes: z.number().int().min(1).max(1440).nullable().default(null),
  minimumMinutes: z.number().int().min(1).max(1440).nullable().default(null),
  splittable: z.boolean().default(false),
  dependsOn: z
    .array(
      z.object({ taskId: z.uuid(), lagMinutes: z.number().int().min(0).max(10080).default(0) }),
    )
    .max(30)
    .default([]),
  slots: z.array(TodoSlot).max(20).default([]),
});
export type TodoItem = z.infer<typeof TodoItem>;

export const TodoList = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(100),
  mode: z.enum(['simple', 'scheduled']),
  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  timezone: z.string().min(1).max(80),
  revision: z.number().int().min(1),
  items: z.array(TodoItem).max(300),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type TodoList = z.infer<typeof TodoList>;

export const TodoListBlock = z.object({ kind: z.literal('todo_list'), list: TodoList });
export type TodoListBlock = z.infer<typeof TodoListBlock>;
