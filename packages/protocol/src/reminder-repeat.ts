import { z } from 'zod';

export interface ReminderRepeat {
  readonly kind: 'daily' | 'weekly' | 'monthly';
  /** 0 = domenica … 6 = sabato (solo weekly). */
  readonly weekdays?: readonly number[];
  /** Giorno del mese (solo monthly). */
  readonly day?: number;
  readonly hour: number;
  readonly minute: number;
}

const WEEKDAYS = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const hhmm = (h: number, m: number) => (m ? `${h}:${String(m).padStart(2, '0')}` : `${h}`);

/** «ogni venerdì alle 9», «ogni lunedì e giovedì alle 18:30», «ogni giorno alle 8», «il 5 di ogni mese alle 9». */
export function repeatLabel(r: ReminderRepeat): string {
  const at = `alle ${hhmm(r.hour, r.minute)}`;
  if (r.kind === 'daily') return `ogni giorno ${at}`;
  if (r.kind === 'monthly') return `il ${r.day} di ogni mese ${at}`;
  const days = [...(r.weekdays ?? [])].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d)))
    return `nei giorni feriali ${at}`;
  const names = days.map((d) => WEEKDAYS[d] ?? '');
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} e ${names.at(-1)}` : names[0];
  return `ogni ${list} ${at}`;
}

/** Contratto delle ricorrenze semplici: niente eccezioni implicite o date di fine. */
export const ReminderRepeatInput = z
  .object({
    kind: z.enum(['daily', 'weekly', 'monthly']),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    day: z.number().int().min(1).max(28).optional(),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.kind === 'weekly' ? !r.weekdays?.length || r.day !== undefined : r.weekdays !== undefined)
      ctx.addIssue({
        code: 'custom',
        message:
          'weekly richiede weekdays (0 domenica … 6 sabato), senza day; gli altri tipi non accettano weekdays',
      });
    if (r.kind === 'monthly' ? r.day === undefined : r.day !== undefined)
      ctx.addIssue({ code: 'custom', message: 'day è obbligatorio solo per monthly (1–28)' });
    if (r.weekdays && new Set(r.weekdays).size !== r.weekdays.length)
      ctx.addIssue({ code: 'custom', message: 'Giorni della settimana duplicati' });
  });
