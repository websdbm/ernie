import { z } from 'zod';

/** Dettagli dell'impegno: distinti dal trigger geolocalizzato `place`. */
export const ReminderDetails = z.object({
  location: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .optional()
    .describe(
      'Sede: indirizzo o etichetta di un luogo salvato. Non è il trigger geolocalizzato place.',
    ),
  url: z
    .url()
    .max(2000)
    .refine((s) => /^https?:\/\//iu.test(s), 'Usa un link http o https')
    .optional(),
  notes: z.string().trim().min(1).max(4000).optional(),
});
export type ReminderDetails = z.infer<typeof ReminderDetails>;
/** Omettere conserva il valore; null cancella esplicitamente il campo. */
export const ReminderDetailsPatch = z.object({
  location: ReminderDetails.shape.location.unwrap().nullable().optional(),
  url: ReminderDetails.shape.url.unwrap().nullable().optional(),
  notes: ReminderDetails.shape.notes.unwrap().nullable().optional(),
});
export type ReminderDetailsPatch = z.infer<typeof ReminderDetailsPatch>;

/** Lettura tollerante dei metadati storici, senza propagare URL non apribili. */
export function reminderDetailsOf(value: unknown): ReminderDetails {
  const row = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const out: ReminderDetails = {};
  for (const field of ['location', 'url', 'notes'] as const) {
    const parsed = ReminderDetails.shape[field].safeParse(row[field]);
    if (parsed.success && parsed.data !== undefined) out[field] = parsed.data;
  }
  return out;
}
