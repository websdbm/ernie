import { z } from 'zod';
import { defineTool } from '../types.js';

/** Opens the protected UI without exposing clinical data to ordinary chat or its model. */
export function createHealthAccessTool() {
  return defineTool({
    id: 'health_open',
    version: '1',
    category: 'health',
    description:
      'Apri Salute per importare referti, consultarli o chiedere analisi nella sezione protetta. Non legge dati clinici nella chat principale.',
    risk: { readsPrivate: false, ingestsUntrusted: false, externalEffect: false, write: false },
    timeoutMs: 5_000,
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ opened: z.boolean() }),
    execute: async () => ({ opened: true }),
    present: () => ({
      kind: 'health_access' as const,
      title: 'Salute protetta',
      message:
        'Consulta i referti o chiedi un’analisi nella sezione Salute. Il consenso AI si gestisce al suo interno.',
    }),
  });
}
