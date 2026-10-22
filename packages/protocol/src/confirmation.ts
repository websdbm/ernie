import { z } from 'zod';

/** Presentazione deterministica dell'azione; gli argomenti approvati restano quelli originali. */
export const ConfirmationPresentation = z.object({
  title: z.string().min(1).max(160),
  summary: z.string().min(1).max(600),
  confirmLabel: z.string().min(1).max(50),
  details: z.array(z.object({ label: z.string().max(80), value: z.string().max(65_000) })).max(32),
  destructive: z.boolean().optional(),
  incomplete: z.boolean().optional(),
});
export type ConfirmationPresentation = z.infer<typeof ConfirmationPresentation>;
