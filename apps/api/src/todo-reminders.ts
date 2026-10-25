import { createHash, randomUUID } from 'node:crypto';
import { type AutomationQueue, dedupeKeys, enqueueRun } from '@ernie/automations';
import { type Pool, withUser } from '@ernie/db';
import { type TodoItem, TodoList } from '@ernie/protocol';
import { leadQuantity, REMINDER_FIRE_PREFIX } from '@ernie/skills';

export interface TodoReminder {
  slotId: string;
  taskId: string;
  title: string;
  at: string;
  eventAt: string;
  signature: string;
}

/** No model calls: a reminder is derived from an explicit pending occurrence. */
export function desiredTodoReminders(list: TodoList): TodoReminder[] {
  if (list.mode !== 'scheduled') return [];
  const byId = new Map(list.items.map((item) => [item.id, item]));
  const active = (item: TodoItem): boolean => {
    const seen = new Set<string>();
    let cursor: TodoItem | undefined = item;
    while (cursor && !seen.has(cursor.id)) {
      if (cursor.status !== 'pending') return false;
      seen.add(cursor.id);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    return true;
  };
  return list.items
    .filter((item) => item.kind === 'task' && active(item))
    .flatMap((item) =>
      item.slots
        .filter((slot) => slot.reminderMinutes !== null)
        .map((slot) => {
          const at = new Date(
            Date.parse(slot.startAt) - (slot.reminderMinutes ?? 0) * 60_000,
          ).toISOString();
          const eventAt = new Date(slot.startAt).toISOString();
          const parent = item.parentId ? byId.get(item.parentId)?.title : undefined;
          const title = parent ? `${parent}: ${item.title}` : item.title;
          const signature = createHash('sha256')
            .update(JSON.stringify([item.id, slot.id, title, at, eventAt, list.timezone]))
            .digest('hex');
          return { slotId: slot.id, taskId: item.id, title, at, eventAt, signature };
        }),
    );
}

interface Options {
  pool: Pool;
  queue: AutomationQueue;
  onChanged?: (userId: string, list: TodoList) => Promise<void>;
  onError?: (error: unknown) => void;
  now?: () => number;
}

/**
 * The list and its notifications are reconciled under the latest row lock. The revision
 * is a durable outbox marker: a crash after saving is recovered by drain(). Automation
 * rows commit together; the existing worker scheduler recovers a failed queue enqueue.
 */
export function createTodoReminderSync(options: Options) {
  const sync = async (userId: string, listId: string): Promise<void> => {
    const result = await withUser(options.pool, userId, async (client) => {
      const result = await client.query<{
        id: string;
        name: string;
        mode: string;
        day: string | null;
        timezone: string;
        revision: number;
        items: unknown;
        updated_at: Date;
        reminder_revision: number;
      }>(
        `SELECT id,name,mode,day::text,timezone,revision,items,updated_at,reminder_revision
          FROM todo_lists WHERE user_id=$1 AND id=$2 FOR UPDATE`,
        [userId, listId],
      );
      const row = result.rows[0];
      if (!row || row.reminder_revision === row.revision) return null;
      const list = TodoList.parse({ ...row, updatedAt: row.updated_at.toISOString() });
      const desired = desiredTodoReminders(list);
      const signatures = new Set(desired.map((reminder) => reminder.signature));
      const existing = await client.query<{ id: string; meta: { todoSignature?: string } }>(
        `SELECT id,meta FROM automations WHERE user_id=$1 AND enabled
         AND meta->>'todoListId'=$2`,
        [userId, listId],
      );
      const keep = new Map<string, string>();
      for (const entry of existing.rows) {
        const signature = entry.meta.todoSignature;
        if (signature && signatures.has(signature) && !keep.has(signature))
          keep.set(signature, entry.id);
        else
          await client.query(
            'UPDATE automations SET enabled=false,updated_at=now() WHERE user_id=$1 AND id=$2',
            [userId, entry.id],
          );
      }
      const jobs: Array<{ id: string; at: string }> = [];
      for (const reminder of desired) {
        // A new reminder in the past must never be silently moved or fired immediately.
        if (Date.parse(reminder.at) <= Date.now()) continue;
        const known = keep.get(reminder.signature);
        if (known) {
          jobs.push({ id: known, at: reminder.at });
          continue;
        }
        const id = randomUUID();
        const lead = Date.parse(reminder.eventAt) - Date.parse(reminder.at);
        const input = `${REMINDER_FIRE_PREFIX}${lead > 0 ? `[tra ${leadQuantity(lead)}] ` : ''}${reminder.title}`;
        await client.query(
          `INSERT INTO automations (id,user_id,key,title,kind,trigger,timezone,action,budget_usd,catch_up,jitter_s,notify,enabled,meta)
           VALUES($1,$2,$3,$4,'deterministic',$5,$6,$7,0,'latest',0,true,true,$8)`,
          [
            id,
            userId,
            `promemoria_todo_${id.replaceAll('-', '')}`,
            `Promemoria: ${reminder.title}`.slice(0, 120),
            JSON.stringify({ type: 'once', at: reminder.at }),
            list.timezone,
            JSON.stringify({ type: 'skill', skillId: 'ricordami', input }),
            JSON.stringify({
              todoListId: listId,
              todoTaskId: reminder.taskId,
              todoSlotId: reminder.slotId,
              todoSignature: reminder.signature,
              eventAt: reminder.eventAt,
            }),
          ],
        );
        jobs.push({ id, at: reminder.at });
      }
      await client.query(
        'UPDATE todo_lists SET reminder_revision=revision WHERE user_id=$1 AND id=$2',
        [userId, listId],
      );
      return { list, jobs };
    });
    if (!result) return;
    for (const job of result.jobs) {
      await enqueueRun(
        options.queue,
        {
          automationId: job.id,
          userId,
          scheduledAt: job.at,
          dedupeKey: dedupeKeys.once(new Date(job.at)),
          triggerType: 'once',
          depth: 0,
        },
        Math.max(0, Date.parse(job.at) - Date.now()),
      );
    }
    await options.onChanged?.(userId, result.list);
  };
  let draining = false;
  // Liste che falliscono nel recupero: attesa crescente (1 min … 1 h), così non occupano sempre i primi 100 posti.
  const failing = new Map<string, { failures: number; until: number }>();
  const now = options.now ?? Date.now;
  return {
    sync,
    async drain(): Promise<void> {
      if (draining) return;
      draining = true;
      try {
        const t = now();
        const waiting = [...failing].filter(([, f]) => f.until > t).map(([id]) => id);
        const pending = await options.pool.query<{ user_id: string; id: string }>(
          'SELECT * FROM todo_pending_reminders($1::uuid[])',
          [waiting.slice(0, 1000)],
        );
        for (const row of pending.rows) {
          try {
            await sync(row.user_id, row.id);
            failing.delete(row.id);
          } catch (error) {
            const failures = (failing.get(row.id)?.failures ?? 0) + 1;
            if (failing.size < 10_000 || failing.has(row.id))
              failing.set(row.id, {
                failures,
                until: now() + Math.min(3_600_000, 60_000 * 2 ** (failures - 1)),
              });
            options.onError?.(error);
          }
        }
      } finally {
        draining = false;
      }
    },
  };
}
