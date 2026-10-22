import { z } from 'zod';

/** Boundary schemas: the vault validates semantics again before committing a change. */
export const BrainDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T12:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Il giorno indicato non esiste.');
export const BrainTimeZone = z
  .string()
  .min(1)
  .max(80)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('it', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Fuso orario non valido.');
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const id = z.string().min(1).max(80);
const scheduleFields = {
  startTime: time.nullable(),
  endTime: time.nullable(),
  dropOffTime: time.nullable(),
  pickupTime: time.nullable(),
  homeTime: time.nullable(),
  place: z.string().trim().min(1).max(300).nullable(),
  notes: z.string().max(2000).nullable(),
};
export const BrainRoutineExceptionSchema = z
  .object({
    date: BrainDate,
    status: z.enum(['cancelled', 'changed']),
    startTime: time.nullable().optional(),
    endTime: time.nullable().optional(),
    dropOffTime: time.nullable().optional(),
    pickupTime: time.nullable().optional(),
    homeTime: time.nullable().optional(),
    place: scheduleFields.place.optional(),
    notes: scheduleFields.notes.optional(),
  })
  .strict();
const routineFields = {
  title: z.string().trim().min(1).max(120),
  days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  timeZone: BrainTimeZone,
  ...scheduleFields,
  validFrom: BrainDate.nullable(),
  validUntil: BrainDate.nullable(),
  exceptions: z.array(BrainRoutineExceptionSchema).max(100),
};
export const BrainRoutineSchema = z
  .object({ id, ...routineFields, updatedAt: z.string() })
  .strict();
export const BrainFactEvidenceSchema = z
  .object({
    kind: z.enum(['user', 'document', 'calendar', 'inference']),
    ref: z.string().trim().min(1).max(500),
    quote: z.string().trim().min(1).max(2000),
  })
  .strict();
const factReliabilityFields = {
  status: z.enum(['unverified', 'confirmed', 'uncertain', 'superseded']).optional(),
  evidence: BrainFactEvidenceSchema.nullable().optional(),
  validFrom: BrainDate.nullable().optional(),
  validUntil: BrainDate.nullable().optional(),
};
const factFields = {
  label: z.string().trim().min(1).max(120),
  value: z.string().trim().min(1).max(2000),
  updatedAt: z.string(),
  ...factReliabilityFields,
};
export const BrainFactSchema = z
  .object({
    id,
    ...factFields,
    history: z.array(z.object(factFields).strict()).max(100).optional(),
  })
  .strict();
export const BrainKnowledgeSchema = z
  .object({
    version: z.literal(1),
    facts: z.array(BrainFactSchema).max(50),
    routines: z.array(BrainRoutineSchema).max(30),
  })
  .strict();
export const BrainKnowledgeUpdateSchema = z
  .object({
    ref: z.string().trim().min(1).max(300),
    facts: z
      .array(BrainFactSchema.omit({ updatedAt: true, history: true }).extend({ id: id.optional() }))
      .max(50)
      .optional(),
    routines: z
      .array(
        z
          .object({ id, ...routineFields })
          .partial()
          .strict(),
      )
      .max(30)
      .optional(),
    removeFactIds: z.array(id).max(50).optional(),
    removeRoutineIds: z.array(id).max(30).optional(),
  })
  .strict()
  .refine(
    (value) =>
      [value.facts, value.routines, value.removeFactIds, value.removeRoutineIds].some(
        (items) => items && items.length > 0,
      ),
    'Indica almeno una modifica.',
  );
export const BrainAgendaQuerySchema = z
  .object({
    date: BrainDate,
    timeZone: BrainTimeZone,
    ref: z.string().trim().min(1).max(300).optional(),
  })
  .strict();
export const BrainAgendaSchema = z.object({
  date: BrainDate,
  timeZone: BrainTimeZone,
  subjects: z.array(z.object({ path: z.string(), title: z.string() })),
  entries: z.array(
    z.object({
      notePath: z.string(),
      noteTitle: z.string(),
      routineId: id,
      title: z.string(),
      timeZone: BrainTimeZone,
      status: z.enum(['planned', 'cancelled']),
      ...scheduleFields,
    }),
  ),
});
export type BrainKnowledgeUpdate = z.infer<typeof BrainKnowledgeUpdateSchema>;

/** Relative dates are resolved by code in the selected timezone, never guessed by a model. */
export function brainLocalDay(timeZone: string, offset = 0, now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value;
  const date = new Date(`${part('year')}-${part('month')}-${part('day')}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
