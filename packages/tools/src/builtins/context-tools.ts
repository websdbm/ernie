import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  BrainAgendaSchema,
  BrainDate,
  BrainTimeZone,
  brainLocalDay,
  TodoItem,
  TodoList,
} from '@ernie/protocol';
import { z } from 'zod';
import { defineTool, type ToolContext, ToolError, type ToolSpec } from '../types.js';
import type { BrainToolStore } from './brain.js';
import type { ReminderToolStore } from './reminders.js';
import type { ShoppingListRepository } from './shopping.js';
import {
  checkModelOffsets,
  type TodoRepository,
  TodoSaveInput,
  validateTodoSnapshot,
} from './todo.js';

const Domain = z.enum(['todo', 'shopping', 'reminders', 'brain', 'ssh']);
type Domain = z.infer<typeof Domain>;
const TargetKind = z.enum(['todo', 'shopping', 'person', 'place', 'site']);
const Target = z.object({
  id: z.string(),
  kind: TargetKind,
  title: z.string(),
  detail: z.string(),
  reason: z.string(),
});
const Coverage = z.object({
  source: z.string(),
  status: z.enum(['available', 'disabled', 'unavailable', 'partial']),
  note: z.string(),
});
const risk = { readsPrivate: true, ingestsUntrusted: true, externalEffect: false, write: false };
const fold = (value: string) =>
  value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

export interface ContextToolsDeps {
  /** Effective permissions, including kill switch and guardian. Checked before and after every read. */
  canUse(userId: string, domain: Domain): Promise<boolean>;
  todo: TodoRepository;
  shopping: ShoppingListRepository;
  reminders: Pick<ReminderToolStore, 'list'>;
  brain: Pick<BrainToolStore, 'agenda' | 'search'>;
  sites(userId: string): Promise<readonly { id: string; domain: string; serverName: string }[]>;
  now?: () => Date;
}

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
};
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const snapshot = (list: TodoList | TodoSaveInput) => ({
  id: list.id,
  name: list.name,
  mode: list.mode,
  day: list.day,
  timezone: list.timezone,
  items: list.items,
});
// Do not partial() a create schema with defaults: Zod would reset omitted fields in a patch.
const ItemChanges = z
  .object({
    title: TodoItem.shape.title,
    parentId: TodoItem.shape.parentId.removeDefault(),
    notes: TodoItem.shape.notes.removeDefault(),
    kind: TodoItem.shape.kind.removeDefault(),
    status: TodoItem.shape.status.removeDefault(),
    position: TodoItem.shape.position.removeDefault(),
    estimatedMinutes: TodoItem.shape.estimatedMinutes.removeDefault(),
    minimumMinutes: TodoItem.shape.minimumMinutes.removeDefault(),
    splittable: TodoItem.shape.splittable.removeDefault(),
    dependsOn: TodoItem.shape.dependsOn.removeDefault(),
    slots: TodoItem.shape.slots.removeDefault(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Indica una modifica.');
const Patch = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    mode: z.enum(['simple', 'scheduled']).optional(),
    day: BrainDate.nullable().optional(),
    timezone: BrainTimeZone.optional(),
    items: z
      .array(z.object({ id: z.uuid(), changes: ItemChanges }).strict())
      .max(50)
      .optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.name !== undefined ||
      v.mode !== undefined ||
      v.day !== undefined ||
      v.timezone !== undefined ||
      !!v.items?.length,
    'Indica una modifica.',
  );
const ChangeInput = z
  .object({
    kind: z.literal('todo'),
    id: z.uuid(),
    revision: z.number().int().positive(),
    patch: Patch,
  })
  .strict();
const Proof = z
  .object({
    before: z.string().regex(/^[a-f0-9]{64}$/),
    after: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.iso.datetime(),
    signature: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
type Change = z.infer<typeof ChangeInput>;

type Difference = { field: string; before: unknown; after: unknown };
/** Bound the serialized result before the generic executor; keep proof and coverage intact. */
function previewDifferences(differences: Difference[]) {
  let shortenedValues = 0;
  const changes: Difference[] = [];
  for (const difference of differences) {
    let shortened = 0;
    const compact = (value: unknown): unknown => {
      const serialized = JSON.stringify(value) ?? 'null';
      if (serialized.length <= 300) return value;
      shortened++;
      return { excerpt: serialized.slice(0, 300), characters: serialized.length, truncated: true };
    };
    const candidate = {
      field: difference.field,
      before: compact(difference.before),
      after: compact(difference.after),
    };
    if (changes.length >= 20 || JSON.stringify([...changes, candidate]).length > 6_000) break;
    changes.push(candidate);
    shortenedValues += shortened;
  }
  const omittedChanges = differences.length - changes.length;
  return {
    changes,
    coverage: {
      totalChanges: differences.length,
      shownChanges: changes.length,
      omittedChanges,
      shortenedValues,
      truncated: omittedChanges > 0 || shortenedValues > 0,
      note:
        omittedChanges > 0 || shortenedValues > 0
          ? 'Anteprima abbreviata: non presentarla come completa. La prova riguarda tutta la patch inviata. Per esaminare i dettagli prepara patch più piccole; per i testi originali rileggi la lista.'
          : 'Tutte le differenze sono mostrate integralmente.',
    },
  };
}

function patchTodo(current: TodoList, input: Change): TodoSaveInput {
  const ids = new Set<string>();
  for (const item of input.patch.items ?? []) {
    if (ids.has(item.id) || !current.items.some((existing) => existing.id === item.id))
      throw new ToolError('Attività mancante o ripetuta: rileggi la lista.', 'invalid_target');
    ids.add(item.id);
  }
  const { items, ...fields } = input.patch;
  return validateTodoSnapshot(
    TodoSaveInput.parse({
      ...snapshot(current),
      ...fields,
      revision: input.revision,
      items: current.items.map((item) =>
        TodoItem.parse({
          ...item,
          ...Object.fromEntries(
            Object.entries(items?.find((patch) => patch.id === item.id)?.changes ?? {}).filter(
              ([, value]) => value !== undefined,
            ),
          ),
        }),
      ),
    }),
  );
}

/** Bounded, deterministic aggregation and changes. No implicit diary/archive/private Brain access. */
export function createContextTools(deps: ContextToolsDeps): ToolSpec[] {
  const now = deps.now ?? (() => new Date());
  // Ephemeral proof: a restart requires a fresh preview. It never grants permission or replaces approval.
  const secret = randomBytes(32);
  const allowed = async (ctx: ToolContext, domain: Domain) => {
    if (ctx.signal?.aborted) return false;
    const access = await deps.canUse(ctx.userId, domain).catch(() => false);
    return access && !ctx.signal?.aborted;
  };
  const guard = async (ctx: ToolContext, domain: Domain) => {
    const access = await allowed(ctx, domain);
    if (ctx.signal?.aborted) throw new ToolError('Operazione annullata.', 'aborted');
    if (!access)
      throw new ToolError('Funzione non disponibile per questo account.', 'skill_disabled');
  };
  const sign = (ctx: ToolContext, input: Change, proof: Omit<z.infer<typeof Proof>, 'signature'>) =>
    createHmac('sha256', secret)
      .update(canonical({ user: ctx.userId, session: ctx.sessionId, input, proof }))
      .digest('hex');
  const read = async <T>(ctx: ToolContext, domain: Domain, fn: () => Promise<T>) => {
    await guard(ctx, domain);
    const result = await fn();
    await guard(ctx, domain);
    return result;
  };
  return [
    defineTool({
      id: 'day_snapshot',
      version: '1',
      category: 'context',
      requiredScopes: ['chat'],
      risk,
      timeoutMs: 15_000,
      maxResultChars: 24_000,
      description:
        'Legge in parallelo Todo, prossimi promemoria e routine Brain di un giorno. Date today/tomorrow nel fuso del telefono. Espone copertura e fonti: non legge il calendario iOS dal vivo, diario o chat archiviate, non certifica disponibilità, non deduplica impegni solo perché hanno lo stesso titolo. Usa prima di proporre una timeline.',
      inputSchema: z
        .object({
          date: z.union([BrainDate, z.enum(['today', 'tomorrow'])]).default('today'),
          timeZone: BrainTimeZone.optional(),
        })
        .strict(),
      outputSchema: z.object({
        date: BrainDate,
        timeZone: BrainTimeZone,
        readAt: z.iso.datetime(),
        coverage: z.array(Coverage),
        lists: z.array(z.object({ id: z.string(), title: z.string(), revision: z.number() })),
        tasks: z.array(
          z.object({
            id: z.string(),
            listId: z.string(),
            title: z.string(),
            status: z.string(),
            slots: TodoItem.shape.slots,
          }),
        ),
        reminders: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            alertAt: z.string(),
            eventAt: z.string().nullable(),
            for: z.string().nullable(),
          }),
        ),
        routines: BrainAgendaSchema.shape.entries,
      }),
      execute: async (input, ctx) => {
        const timeZone = BrainTimeZone.parse(input.timeZone ?? ctx.device?.timezone ?? 'UTC');
        const date =
          input.date === 'today' || input.date === 'tomorrow'
            ? brainLocalDay(timeZone, input.date === 'tomorrow' ? 1 : 0, now())
            : input.date;
        const coverage: z.infer<typeof Coverage>[] = [
          {
            source: 'calendar',
            status: 'unavailable',
            note: 'Calendario iOS non letto dal vivo: solo dati già salvati in Ernie. Non dedurre disponibilità dai vuoti.',
          },
        ];
        const collect = async <T>(
          domain: Domain,
          note: string,
          fn: () => Promise<T>,
          fallback: T,
        ): Promise<T> => {
          if (!(await allowed(ctx, domain))) {
            coverage.push({
              source: domain,
              status: 'disabled',
              note: 'Skill spenta o accesso non disponibile.',
            });
            return fallback;
          }
          try {
            const result = await read(ctx, domain, fn);
            coverage.push({ source: domain, status: 'partial', note });
            return result;
          } catch {
            coverage.push({
              source: domain,
              status: 'unavailable',
              note: 'Lettura non riuscita. Non interpretare come assenza di impegni.',
            });
            return fallback;
          }
        };
        let [todos, reminders, agenda] = await Promise.all([
          collect(
            'todo',
            'Liste associate al giorno richiesto; le liste senza giorno sono escluse.',
            () => deps.todo.list(ctx.userId, { day: date }),
            [],
          ),
          collect(
            'reminders',
            'Solo prossimi avvisi attivi; passati e ricorrenze successive alla prossima non inclusi. Avviso non equivale a durata dell’impegno.',
            () => deps.reminders.list(ctx.userId),
            [],
          ),
          collect(
            'brain',
            'Routine già salvate con eccezioni; programmi, non posizione reale. Note riservate escluse.',
            async () =>
              deps.brain.agenda
                ? BrainAgendaSchema.parse(
                    await deps.brain.agenda(ctx.userId, { date, timeZone, includePrivate: false }),
                  ).entries
                : Promise.reject(new Error('unavailable')),
            [],
          ),
        ]);
        // A different source may finish later: discard earlier results after a revocation meanwhile.
        const access = await Promise.all(
          ['todo', 'reminders', 'brain'].map((domain) => allowed(ctx, domain as Domain)),
        );
        if (!access[0]) todos = [];
        if (!access[1]) reminders = [];
        if (!access[2]) agenda = [];
        for (const [index, domain] of ['todo', 'reminders', 'brain'].entries()) {
          if (!access[index]) {
            const item = coverage.find((c) => c.source === domain);
            if (item) {
              item.status = 'disabled';
              item.note = 'Accesso non più disponibile. Dati esclusi.';
            }
          }
        }
        const tasks = todos.flatMap((list) =>
          list.items.map((item) => ({
            id: item.id,
            listId: list.id,
            title: item.title,
            status: item.status,
            slots: item.slots,
          })),
        );
        const dayReminders = [
          ...new Map(
            reminders
              .filter(
                (r) =>
                  r.at &&
                  [r.at, r.eventAt].some((at) => at && brainLocalDay(timeZone, 0, at) === date),
              )
              .map((r) => [r.id, r]),
          ).values(),
        ];
        if (tasks.length > 100 || dayReminders.length > 100 || agenda.length > 100)
          coverage.push({
            source: 'result',
            status: 'partial',
            note: 'Risultato limitato a 100 elementi per sezione: approfondisci con i tool della sezione.',
          });
        return {
          date,
          timeZone,
          readAt: now().toISOString(),
          coverage: coverage.sort((a, b) => a.source.localeCompare(b.source)),
          lists: todos
            .slice(0, 100)
            .map((l) => ({ id: l.id, title: l.name, revision: l.revision })),
          tasks: tasks.slice(0, 100),
          reminders: dayReminders.slice(0, 100).flatMap((r) =>
            r.at
              ? [
                  {
                    id: r.id,
                    title: r.text,
                    alertAt: r.at.toISOString(),
                    eventAt: r.eventAt?.toISOString() ?? null,
                    for: r.for ?? null,
                  },
                ]
              : [],
          ),
          routines: agenda.slice(0, 100),
        };
      },
      untrustedSource: () => 'Dati e routine salvati nelle sezioni autorizzate',
    }),
    defineTool({
      id: 'resolve_target',
      version: '1',
      category: 'context',
      requiredScopes: ['chat'],
      risk,
      timeoutMs: 15_000,
      description:
        'Trova l’oggetto inteso tra liste Todo/spesa, persone/luoghi Brain o siti SSH autorizzati. Restituisce ID canonici e candidati. Solo nome esatto univoco è resolved; suggerimenti e omonimi richiedono present_choices. Non crea o unisce nulla e non legge diario o archivi chat.',
      inputSchema: z
        .object({
          kind: TargetKind,
          query: z.string().trim().min(1).max(160),
          limit: z.number().int().min(1).max(8).default(5),
        })
        .strict(),
      outputSchema: z.object({
        status: z.enum(['resolved', 'choose', 'none']),
        candidates: z.array(Target),
        limited: z.boolean(),
      }),
      execute: async (input, ctx) => {
        if (input.kind === 'site' && ctx.modelClass !== 'heavy')
          throw new ToolError(
            'Per consultare i siti della skill SSH serve il modello avanzato.',
            'advanced_model_required',
          );
        const domain: Domain =
          input.kind === 'person' || input.kind === 'place'
            ? 'brain'
            : input.kind === 'site'
              ? 'ssh'
              : input.kind;
        const candidates = await read(ctx, domain, async () => {
          if (input.kind === 'todo')
            return (await deps.todo.list(ctx.userId)).map((l) => ({
              id: l.id,
              title: l.name,
              detail: `${l.mode === 'scheduled' ? 'Timeline' : 'Lista'}${l.day ? ` · ${l.day}` : ''}`,
            }));
          if (input.kind === 'shopping')
            return (await deps.shopping.lists(ctx.userId))
              .filter((l) => l.status === 'active')
              .map((l) => ({ id: l.id, title: l.name, detail: `${l.open} da prendere` }));
          if (input.kind === 'site')
            return (await deps.sites(ctx.userId)).map((s) => ({
              id: s.id,
              title: s.domain,
              detail: s.serverName,
            }));
          return (
            await deps.brain.search(ctx.userId, {
              query: input.query,
              type: input.kind === 'person' ? 'persona' : 'luogo',
              includePrivate: false,
              limit: 20,
            })
          )
            .filter((n) => !n.private)
            .map((n) => ({ id: n.path, title: n.title, detail: n.place ?? n.type }));
        });
        const query = fold(input.query);
        const ranked = candidates
          .map((c) => {
            const title = fold(c.title);
            const exact = title === query;
            const words = query.split(' ').filter((s) => s.length > 2);
            const score = exact
              ? 100
              : words.filter((word) => title.split(' ').includes(word)).length;
            return {
              ...c,
              kind: input.kind,
              reason: exact
                ? 'Nome esatto'
                : score > 0
                  ? 'Parole del nome corrispondenti'
                  : 'Alternativa esistente',
              score,
            };
          })
          .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
        const exact = ranked.filter((c) => c.score === 100);
        const found = exact.length
          ? exact
          : ranked.some((c) => c.score > 0)
            ? ranked.filter((c) => c.score > 0)
            : ranked;
        const truncatedCatalog =
          (input.kind === 'person' || input.kind === 'place') && candidates.length >= 20;
        return {
          status:
            exact.length === 1 && !truncatedCatalog
              ? ('resolved' as const)
              : found.length
                ? ('choose' as const)
                : ('none' as const),
          candidates: found.slice(0, input.limit).map(({ score: _, ...c }) => c),
          limited:
            found.length > input.limit ||
            ((input.kind === 'person' || input.kind === 'place') && candidates.length >= 20),
        };
      },
      untrustedSource: () => 'Catalogo personale autorizzato',
    }),
    defineTool({
      id: 'change_preview',
      version: '1',
      category: 'todo',
      requiredScopes: ['chat'],
      risk: { ...risk, ingestsUntrusted: false },
      timeoutMs: 10_000,
      maxResultChars: 8_000,
      description:
        'Prepara una modifica limitata a una lista Todo già letta: nome, modalità, giorno o campi di attività esistenti. Conserva tutto il resto, verifica conflitti e restituisce differenze e prova valida 10 minuti per change_apply. Nessuna scrittura. Per aggiunte usa todo_save con ID stabili.',
      inputSchema: ChangeInput,
      outputSchema: z.object({
        changes: z.array(z.object({ field: z.string(), before: z.unknown(), after: z.unknown() })),
        proof: Proof,
        unchanged: z.boolean(),
        coverage: z.object({
          totalChanges: z.number().int(),
          shownChanges: z.number().int(),
          omittedChanges: z.number().int(),
          shortenedValues: z.number().int(),
          truncated: z.boolean(),
          note: z.string(),
        }),
      }),
      execute: async (input, ctx) => {
        const current = await read(ctx, 'todo', () => deps.todo.get(ctx.userId, input.id));
        if (!current) throw new ToolError('Lista non trovata.', 'not_found');
        if (current.revision !== input.revision)
          throw new ToolError('La lista è cambiata: rileggila.', 'revision_conflict');
        const next = patchTodo(current, input);
        checkModelOffsets(next);
        validateTodoSnapshot(next, await read(ctx, 'todo', () => deps.todo.list(ctx.userId)));
        const changes: { field: string; before: unknown; after: unknown }[] = [];
        for (const field of ['name', 'mode', 'day', 'timezone'] as const)
          if (current[field] !== next[field])
            changes.push({ field, before: current[field], after: next[field] });
        for (const item of next.items) {
          const previous = current.items.find((i) => i.id === item.id);
          if (!previous) throw new ToolError('Attività non trovata.', 'invalid_target');
          for (const field of Object.keys(item) as (keyof typeof item)[])
            if (canonical(previous[field]) !== canonical(item[field]))
              changes.push({
                field: `${item.title}.${field}`,
                before: previous[field],
                after: item[field],
              });
        }
        const proof = {
          before: digest(snapshot(current)),
          after: digest(snapshot(next)),
          expiresAt: new Date(now().getTime() + 600_000).toISOString(),
        };
        return {
          ...previewDifferences(changes),
          proof: { ...proof, signature: sign(ctx, input, proof) },
          unchanged: changes.length === 0,
        };
      },
    }),
    defineTool({
      id: 'change_apply',
      version: '1',
      category: 'todo',
      requiredScopes: ['chat'],
      risk: { ...risk, ingestsUntrusted: false, write: true },
      timeoutMs: 15_000,
      description:
        'Applica esattamente la patch e la prova di change_preview nella stessa conversazione. Rispetta permessi e approvazioni, verifica revisione e stato, non sovrascrive cambiamenti concorrenti. La ripetizione della stessa operazione già applicata non crea nuove modifiche. Dopo scadenza/ripartenza richiede nuova anteprima.',
      inputSchema: ChangeInput.extend({ proof: Proof }),
      outputSchema: z.object({
        list: TodoList,
        alreadyApplied: z.boolean(),
        verified: z.literal(true),
      }),
      execute: async ({ proof, ...input }, ctx) => {
        await guard(ctx, 'todo');
        const { signature, ...unsigned } = proof;
        const expected = sign(ctx, input, unsigned);
        if (
          Date.parse(proof.expiresAt) <= now().getTime() ||
          !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))
        )
          throw new ToolError(
            'Anteprima scaduta o diversa: prepara una nuova anteprima.',
            'invalid_preview',
          );
        const current = await read(ctx, 'todo', () => deps.todo.get(ctx.userId, input.id));
        if (!current) throw new ToolError('Lista non trovata.', 'not_found');
        if (
          (current.revision === input.revision + 1 || current.revision === input.revision) &&
          digest(snapshot(current)) === proof.after
        )
          return { list: current, alreadyApplied: true, verified: true as const };
        if (current.revision !== input.revision || digest(snapshot(current)) !== proof.before)
          throw new ToolError(
            'La lista è cambiata: rileggila e prepara una nuova anteprima.',
            'revision_conflict',
          );
        const next = patchTodo(current, input);
        if (digest(snapshot(next)) !== proof.after)
          throw new ToolError('Anteprima non corrispondente.', 'invalid_preview');
        checkModelOffsets(next);
        await guard(ctx, 'todo');
        await deps.todo.save(ctx.userId, next);
        const saved = await read(ctx, 'todo', () => deps.todo.get(ctx.userId, input.id));
        if (!saved || digest(snapshot(saved)) !== proof.after)
          throw new ToolError(
            'Il salvataggio è stato avviato ma lo stato è cambiato: rileggi la lista senza ripetere la modifica.',
            'verification_conflict',
          );
        return { list: saved, alreadyApplied: false, verified: true as const };
      },
      present: (_input, output) => ({ kind: 'todo_list', list: output.list }),
    }),
    defineTool({
      id: 'check_result',
      version: '1',
      category: 'todo',
      requiredScopes: ['chat'],
      risk: { ...risk, ingestsUntrusted: false },
      timeoutMs: 10_000,
      description:
        'Rilegge una lista Todo salvata e verifica nome, modalità, revisione minima e campi di attività richieste. Distingue verified/partial/missing. Non basta il titolo per dire che una timeline è stata creata; verifica mode scheduled e slots. Non effettua modifiche.',
      inputSchema: z
        .object({
          kind: z.literal('todo'),
          id: z.uuid(),
          minimumRevision: z.number().int().positive().optional(),
          expected: Patch,
        })
        .strict(),
      outputSchema: z.object({
        status: z.enum(['verified', 'partial', 'missing']),
        revision: z.number().nullable(),
        mismatches: z.array(z.string()),
        checkedAt: z.iso.datetime(),
      }),
      execute: async (input, ctx) => {
        const list = await read(ctx, 'todo', () => deps.todo.get(ctx.userId, input.id));
        const mismatches: string[] = [];
        if (list) {
          if (input.minimumRevision && list.revision < input.minimumRevision)
            mismatches.push('revision');
          for (const field of ['name', 'mode', 'day', 'timezone'] as const)
            if (input.expected[field] !== undefined && input.expected[field] !== list[field])
              mismatches.push(field);
          for (const patch of input.expected.items ?? []) {
            const item = list.items.find((i) => i.id === patch.id);
            if (!item) mismatches.push(`item:${patch.id}`);
            else
              for (const [field, value] of Object.entries(patch.changes))
                if (canonical(item[field as keyof typeof item]) !== canonical(value))
                  mismatches.push(`item:${patch.id}.${field}`);
          }
        }
        return {
          status: !list
            ? ('missing' as const)
            : mismatches.length
              ? ('partial' as const)
              : ('verified' as const),
          revision: list?.revision ?? null,
          mismatches,
          checkedAt: now().toISOString(),
        };
      },
    }),
  ];
}
