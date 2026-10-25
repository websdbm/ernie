import { type Pool, withUser } from '@ernie/db';
import { type TodoItem, TodoList } from '@ernie/protocol';
import { z } from 'zod';
import { defineTool, type ToolSpec } from '../types.js';

export const TodoSaveInput = TodoList.omit({ revision: true, updatedAt: true })
  .extend({ revision: z.number().int().min(1).optional() })
  .strict();
export type TodoSaveInput = z.input<typeof TodoSaveInput>;
type Snapshot = z.infer<typeof TodoSaveInput>;
export interface TodoConflictDetail {
  readonly code: string;
  readonly message: string;
  readonly itemIds?: string[];
  readonly slotIds?: string[];
  readonly listId?: string;
}
export class TodoValidationError extends Error {
  override readonly name: string = 'TodoValidationError';
  readonly statusCode: number;
  constructor(
    readonly code: string,
    message: string,
    readonly details: TodoConflictDetail[] = [],
    statusCode = 422,
  ) {
    super(message);
    this.statusCode = statusCode;
  }
}
export class TodoVersionConflictError extends TodoValidationError {
  override readonly name = 'TodoVersionConflictError';
  constructor() {
    super(
      'revision_conflict',
      'La lista è cambiata. Rileggila prima di salvare le modifiche.',
      [],
      409,
    );
  }
}
export interface TodoRepository {
  list(userId: string, filter?: { day?: string | undefined }): Promise<TodoList[]>;
  get(userId: string, id: string): Promise<TodoList | null>;
  save(userId: string, input: TodoSaveInput): Promise<TodoList>;
  history(userId: string, id: string): Promise<TodoList[]>;
}
export interface TodoRepositoryOptions {
  /** After commit, including idempotent retries: reconcile reminders using canonical IDs. */
  readonly onChanged?: (userId: string, list: TodoList) => Promise<void> | void;
}

function fail(code: string, message: string, itemIds?: string[], slotIds?: string[]): never {
  throw new TodoValidationError(code, message, [
    { code, message, ...(itemIds ? { itemIds } : {}), ...(slotIds ? { slotIds } : {}) },
  ]);
}
function dateInZone(at: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(at));
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
/** Scostamento scritto nell'orario ISO («+02:00»), null per «Z». */
function declaredOffset(at: string): string | null {
  const m = /([+-]\d{2}):?(\d{2})$/.exec(at);
  return m ? `${m[1]}:${m[2]}` : null;
}
/** Scostamento reale del fuso in quell'istante («+01:00» a Roma d'inverno). */
export function zoneOffset(at: string, timezone: string): string {
  const name =
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
      .formatToParts(new Date(at))
      .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-]\d{2}):?(\d{2})/.exec(name);
  return m ? `${m[1]}:${m[2]}` : '+00:00';
}
/**
 * Cambio dell'ora negli orari scritti dal MODELLO (revisione del 25 ott 2026): dopo il 25 ottobre «18:00+02:00» a Roma
 * è un'ora prima di quello che l'utente intende, e la sessione e il promemoria slittano. Si rifiuta solo questa
 * confusione (scostamento che il fuso ha pochi giorni prima o dopo, ma non in quell'istante); UTC esplicito e altri
 * scostamenti restano validi, e le liste salvate dall'app non passano di qui.
 */
export function checkModelOffsets(input: TodoSaveInput): void {
  const tz = input.timezone;
  for (const item of input.items)
    for (const slot of item.slots ?? [])
      for (const at of [slot.startAt, slot.endAt]) {
        const declared = declaredOffset(at);
        if (!declared || declared === '+00:00') continue;
        const actual = zoneOffset(at, tz);
        if (declared === actual) continue;
        const t = Date.parse(at);
        const nearby = [-10, -5, -2, -1, 1, 2, 5, 10].map((d) =>
          zoneOffset(new Date(t + d * 86_400_000).toISOString(), tz),
        );
        if (!nearby.includes(declared)) continue;
        const wall = at.slice(0, at.length - (at.endsWith('Z') ? 1 : 6));
        const retry = `${wall}${actual}`;
        if (zoneOffset(retry, tz) !== actual)
          fail(
            'nonexistent_time',
            `L'orario ${wall.slice(11, 16)} del ${wall.slice(0, 10)} non esiste nel fuso ${tz} (cambio dell'ora): scegli un altro orario per «${item.title}».`,
            [item.id],
            [slot.id],
          );
        fail(
          'offset_mismatch',
          `L'orario ${at} di «${item.title}» ha lo scostamento ${declared}, ma quel giorno nel fuso ${tz} vale ${actual} (cambio dell'ora): riscrivilo come ${retry}.`,
          [item.id],
          [slot.id],
        );
      }
}
function graphCycles(items: TodoItem[], edges: (item: TodoItem) => string[], code: string): void {
  const byId = new Map(items.map((item) => [item.id, item]));
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) fail(code, 'La lista contiene un collegamento circolare.', [id]);
    if (visited.has(id)) return;
    visiting.add(id);
    const item = byId.get(id);
    if (item) for (const next of edges(item)) visit(next);
    visiting.delete(id);
    visited.add(id);
  };
  for (const item of items) visit(item.id);
}
type Occupied = { listId: string; item: TodoItem; slot: TodoItem['slots'][number] };
function occupied(list: Pick<TodoList, 'id' | 'items'>): Occupied[] {
  return list.items
    .filter((i) => i.status !== 'cancelled')
    .flatMap((item) => item.slots.map((slot) => ({ listId: list.id, item, slot })));
}

/** Validate a complete snapshot, never infer times or recipe steps. Simple mode removes timing only. */
export function validateTodoSnapshot(input: TodoSaveInput, others: TodoList[] = []): Snapshot {
  const parsed = TodoSaveInput.safeParse(input);
  if (!parsed.success)
    throw new TodoValidationError(
      'invalid_body',
      'La lista contiene dati non validi.',
      parsed.error.issues.map((i) => ({
        code: 'invalid_body',
        message: `${i.path.join('.')}: ${i.message}`,
      })),
      400,
    );
  const value = parsed.data;
  value.id = value.id.toLowerCase();
  value.items = value.items.map((item) => ({
    ...item,
    id: item.id.toLowerCase(),
    parentId: item.parentId?.toLowerCase() ?? null,
    dependsOn: item.dependsOn.map((dependency) => ({
      ...dependency,
      taskId: dependency.taskId.toLowerCase(),
    })),
    slots: item.slots.map((slot) => ({ ...slot, id: slot.id.toLowerCase() })),
  }));
  if (value.mode === 'simple') {
    value.day = null;
    value.items = value.items.map((item) => ({ ...item, slots: [] }));
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: value.timezone });
  } catch {
    fail('invalid_timezone', 'Scegli un fuso orario IANA valido, per esempio Europe/Rome.');
  }
  if (value.day !== null) {
    const date = new Date(`${value.day}T12:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.day)
      fail('invalid_day', 'Il giorno indicato non esiste.');
  }
  if (value.mode === 'scheduled' && !value.day)
    fail('day_required', 'Per organizzare una giornata scegli il giorno.');
  const byId = new Map<string, TodoItem>();
  const slotIds = new Set<string>();
  for (const item of value.items) {
    if (item.kind === 'group' && item.status !== 'pending')
      fail('group_status', 'Un gruppo è un contenitore: completa o annulla le singole attività.', [
        item.id,
      ]);
    if (byId.has(item.id))
      fail('duplicate_item', 'Ogni attività deve avere un identificativo unico.', [item.id]);
    byId.set(item.id, item);
  }
  for (const item of value.items) {
    if (item.parentId) {
      const parent = byId.get(item.parentId);
      if (parent?.kind !== 'group')
        fail('invalid_parent', 'Un’attività può appartenere soltanto a un gruppo esistente.', [
          item.id,
          item.parentId,
        ]);
    }
    if (
      item.kind === 'group' &&
      (item.slots.length || item.dependsOn.length || item.minimumMinutes !== null)
    )
      fail(
        'group_constraint',
        'Orari, dipendenze e durata minima appartengono alle attività del gruppo.',
        [item.id],
      );
    const targets = new Set<string>();
    for (const dependency of item.dependsOn) {
      const target = byId.get(dependency.taskId);
      if (target?.kind !== 'task' || targets.has(target.id))
        fail(
          'invalid_dependency',
          'Una dipendenza deve indicare un’altra attività esistente, una sola volta.',
          [item.id, dependency.taskId],
        );
      targets.add(target.id);
    }
    if (!item.splittable && item.slots.length > 1)
      fail('not_splittable', `«${item.title}» non può essere divisa in più sessioni.`, [item.id]);
    let total = 0;
    for (const slot of item.slots) {
      if (slotIds.has(slot.id))
        fail(
          'duplicate_slot',
          'Ogni sessione deve avere un identificativo unico.',
          [item.id],
          [slot.id],
        );
      slotIds.add(slot.id);
      const start = Date.parse(slot.startAt),
        end = Date.parse(slot.endAt);
      if (end <= start)
        fail(
          'invalid_interval',
          `La fine di «${item.title}» deve essere successiva all’inizio.`,
          [item.id],
          [slot.id],
        );
      if (
        dateInZone(slot.startAt, value.timezone) !== value.day ||
        dateInZone(slot.endAt, value.timezone) !== value.day
      )
        fail(
          'day_mismatch',
          `La sessione di «${item.title}» non appartiene al giorno nel fuso scelto.`,
          [item.id],
          [slot.id],
        );
      total += (end - start) / 60_000;
    }
    if (
      item.status !== 'cancelled' &&
      item.slots.length &&
      item.minimumMinutes !== null &&
      total < item.minimumMinutes
    )
      fail(
        'minimum_duration',
        `«${item.title}» richiede almeno ${item.minimumMinutes} minuti complessivi.`,
        [item.id],
      );
  }
  graphCycles(value.items, (i) => (i.parentId ? [i.parentId] : []), 'parent_cycle');
  graphCycles(value.items, (i) => i.dependsOn.map((d) => d.taskId), 'dependency_cycle');
  for (const item of value.items) {
    if (item.status === 'cancelled' || !item.slots.length) continue;
    const start = Math.min(...item.slots.map((s) => Date.parse(s.startAt)));
    for (const dependency of item.dependsOn) {
      const target = byId.get(dependency.taskId) as TodoItem;
      if (target.status === 'cancelled')
        fail('dependency_cancelled', `«${item.title}» dipende da un’attività annullata.`, [
          item.id,
          target.id,
        ]);
      if (!target.slots.length) {
        if (target.status === 'done' && dependency.lagMinutes === 0) continue;
        fail(
          'dependency_unscheduled',
          `Assegna un orario a «${target.title}» prima di pianificare «${item.title}».`,
          [item.id, target.id],
        );
      }
      const end = Math.max(...target.slots.map((s) => Date.parse(s.endAt)));
      if (start < end + dependency.lagMinutes * 60_000)
        fail(
          'dependency_lag',
          `«${item.title}» deve iniziare dopo «${target.title}»${dependency.lagMinutes ? ` e un’attesa di ${dependency.lagMinutes} minuti` : ''}.`,
          [item.id, target.id],
        );
    }
  }
  const own = occupied(value),
    external = others
      .filter((l) => l.id !== value.id && l.mode === 'scheduled' && l.day === value.day)
      .flatMap(occupied);
  for (let i = 0; i < own.length; i++) {
    const a = own[i] as Occupied;
    for (const b of [...own.slice(i + 1), ...external]) {
      if (
        Date.parse(a.slot.startAt) < Date.parse(b.slot.endAt) &&
        Date.parse(b.slot.startAt) < Date.parse(a.slot.endAt)
      )
        throw new TodoValidationError(
          'schedule_conflict',
          `«${a.item.title}» si sovrappone a «${b.item.title}».`,
          [
            {
              code: 'overlap',
              message: `Sposta una delle due attività: «${a.item.title}» e «${b.item.title}».`,
              itemIds: [a.item.id, b.item.id],
              slotIds: [a.slot.id, b.slot.id],
              listId: b.listId,
            },
          ],
          409,
        );
    }
  }
  return value;
}

interface Row {
  id: string;
  name: string;
  mode: 'simple' | 'scheduled';
  day: string | null;
  timezone: string;
  revision: number;
  items: TodoItem[];
  updated_at: Date | string;
}
const COLS = 'id, name, mode, day::text, timezone, revision, items, updated_at';
const fromRow = (r: Row): TodoList =>
  TodoList.parse({ ...r, updatedAt: new Date(r.updated_at).toISOString() });
const snapshotOf = (v: Pick<TodoList, 'id' | 'name' | 'mode' | 'day' | 'timezone' | 'items'>) => ({
  id: v.id,
  name: v.name,
  mode: v.mode,
  day: v.day,
  timezone: v.timezone,
  items: v.items,
});

export function createTodoRepository(
  pool: Pool,
  options: TodoRepositoryOptions = {},
): TodoRepository {
  return {
    async list(userId, filter = {}) {
      return withUser(pool, userId, async (c) =>
        (
          await c.query<Row>(
            `SELECT ${COLS} FROM todo_lists WHERE user_id=$1 AND ($2::date IS NULL OR day=$2::date) ORDER BY updated_at DESC, id`,
            [userId, filter.day ?? null],
          )
        ).rows.map(fromRow),
      );
    },
    async get(userId, id) {
      return withUser(pool, userId, async (c) => {
        const r = (
          await c.query<Row>(`SELECT ${COLS} FROM todo_lists WHERE user_id=$1 AND id=$2`, [
            userId,
            id,
          ])
        ).rows[0];
        return r ? fromRow(r) : null;
      });
    },
    async history(userId, id) {
      return withUser(pool, userId, async (c) =>
        (
          await c.query<{ snapshot: TodoList }>(
            'SELECT snapshot FROM todo_list_revisions WHERE user_id=$1 AND list_id=$2 ORDER BY revision',
            [userId, id],
          )
        ).rows.map((r) => TodoList.parse(r.snapshot)),
      );
    },
    async save(userId, input) {
      const value = validateTodoSnapshot(input);
      const saved = await withUser(pool, userId, async (c) => {
        // Serializes owner writes, including simultaneous creates and cross-list schedule validation.
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`todo:${userId}`]);
        const rows = (
          await c.query<Row>(`SELECT ${COLS} FROM todo_lists WHERE user_id=$1 FOR UPDATE`, [userId])
        ).rows.map(fromRow);
        const current = rows.find((r) => r.id === value.id);
        const same =
          current && JSON.stringify(snapshotOf(current)) === JSON.stringify(snapshotOf(value));
        if (
          current &&
          same &&
          (value.revision === undefined ||
            value.revision === current.revision ||
            value.revision === current.revision - 1)
        )
          return current;
        if (current ? value.revision !== current.revision : value.revision !== undefined)
          throw new TodoVersionConflictError();
        validateTodoSnapshot(value, rows);
        const existingDay =
          value.mode === 'scheduled' &&
          rows.find((r) => r.id !== value.id && r.mode === 'scheduled' && r.day === value.day);
        if (existingDay)
          throw new TodoValidationError(
            'day_list_exists',
            'Esiste già una lista per questa giornata. Aprila e conserva le attività presenti.',
            [
              {
                code: 'day_list_exists',
                message: 'Usa la giornata già esistente.',
                listId: existingDay.id,
              },
            ],
            409,
          );
        const revision = (current?.revision ?? 0) + 1;
        const row = (
          await c.query<Row>(
            `INSERT INTO todo_lists(user_id,id,name,mode,day,timezone,revision,items)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
          ON CONFLICT(user_id,id) DO UPDATE SET name=EXCLUDED.name,mode=EXCLUDED.mode,day=EXCLUDED.day,timezone=EXCLUDED.timezone,revision=EXCLUDED.revision,items=EXCLUDED.items,updated_at=now()
          RETURNING ${COLS}`,
            [
              userId,
              value.id,
              value.name,
              value.mode,
              value.day,
              value.timezone,
              revision,
              JSON.stringify(value.items),
            ],
          )
        ).rows[0];
        if (!row) throw new Error('Salvataggio lista non riuscito');
        const result = fromRow(row);
        await c.query(
          'INSERT INTO todo_list_revisions(user_id,list_id,revision,snapshot) VALUES($1,$2,$3,$4::jsonb)',
          [userId, result.id, result.revision, JSON.stringify(result)],
        );
        return result;
      });
      await options.onChanged?.(userId, saved);
      return saved;
    },
  };
}

export interface TodoToolsOptions {
  readonly canUse?: (userId: string) => Promise<boolean>;
}
const TodoFailure = z.object({
  error: z.string(),
  reason: z.string(),
  details: z.array(
    z.object({
      code: z.string(),
      message: z.string(),
      itemIds: z.array(z.string()).optional(),
      slotIds: z.array(z.string()).optional(),
      listId: z.string().optional(),
    }),
  ),
});
export function createTodoTools(repo: TodoRepository, options: TodoToolsOptions = {}): ToolSpec[] {
  const guard = async (userId: string) => {
    let enabled = false;
    try {
      enabled = (await options.canUse?.(userId)) === true;
    } catch {
      /* Fail closed. */
    }
    if (!enabled)
      throw new TodoValidationError(
        'skill_disabled',
        'La funzione Todo non è attiva per questo account.',
        [],
        403,
      );
  };
  const call = async <T>(
    userId: string,
    execute: () => Promise<T>,
  ): Promise<T | z.infer<typeof TodoFailure>> => {
    try {
      await guard(userId);
      return await execute();
    } catch (error) {
      if (error instanceof TodoValidationError)
        return { error: error.code, reason: error.message, details: error.details };
      throw error;
    }
  };
  const risk = { readsPrivate: true, ingestsUntrusted: false, externalEffect: false, write: false };
  return [
    defineTool({
      id: 'todo_lists',
      version: '1.0.0',
      category: 'todo',
      description:
        'Elenca le liste Todo dell’utente. Prima di pianificare oggi leggi la giornata esistente: non sostituire o perdere attività.',
      risk,
      requiredScopes: ['chat'],
      inputSchema: z.object({
        day: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      }),
      outputSchema: z.union([z.object({ lists: z.array(TodoList) }), TodoFailure]),
      execute: async (input, ctx) =>
        call(ctx.userId, async () => ({ lists: await repo.list(ctx.userId, input) })),
    }),
    defineTool({
      id: 'todo_get',
      version: '1.0.0',
      category: 'todo',
      description:
        'Legge una lista Todo completa e la revisione corrente, mantenendo gli identificativi canonici delle attività.',
      risk,
      requiredScopes: ['chat'],
      inputSchema: z.object({ id: z.uuid() }),
      outputSchema: z.union([z.object({ list: TodoList.nullable() }), TodoFailure]),
      execute: async (input, ctx) =>
        call(ctx.userId, async () => ({ list: await repo.get(ctx.userId, input.id) })),
      present: (_input, output) =>
        'list' in output && output.list ? { kind: 'todo_list', list: output.list } : null,
    }),
    defineTool({
      id: 'todo_save',
      version: '1.0.0',
      category: 'todo',
      description:
        'Salva l’intera lista Todo. Leggi SEMPRE prima la lista esistente e conserva attività, identificativi, gerarchia e completamenti non modificati dall’utente. Usa revision corrente per aggiornare, omettila per creare con id stabile. Gli orari devono essere dichiarati o proposte accettate, mai inventati. Le attese sono lag delle dipendenze, non sessioni occupate. simple rimuove orari e promemoria conservando le attività. Un conflitto non modifica nulla: rileggi e chiedi la correzione.',
      risk: { ...risk, write: true },
      requiredScopes: ['chat'],
      inputSchema: TodoSaveInput,
      outputSchema: z.union([z.object({ list: TodoList }), TodoFailure]),
      execute: async (input, ctx) =>
        call(ctx.userId, async () => {
          checkModelOffsets(input);
          return { list: await repo.save(ctx.userId, input) };
        }),
      present: (_input, output) =>
        'list' in output ? { kind: 'todo_list', list: output.list } : null,
    }),
  ];
}
