import { type Pool, withUser } from '@ernie/db';

export interface RepeatedProcedure {
  readonly sequence: readonly string[];
  readonly occurrences: number;
  readonly sampleRequests: readonly string[];
}

/**
 * Rilevamento deterministico delle procedure ripetute: la stessa sequenza di tool (per richiesta)
 * eseguita con successo almeno `minOccurrences` volte negli ultimi `days` giorni. Nessun LLM.
 */
export async function detectRepeatedProcedures(
  pool: Pool,
  userId: string,
  opts: { minOccurrences?: number; days?: number } = {},
): Promise<RepeatedProcedure[]> {
  const min = opts.minOccurrences ?? 3;
  const days = opts.days ?? 30;
  return withUser(pool, userId, async (client) => {
    const res = await client.query<{ sequence: string[]; occurrences: number; samples: string[] }>(
      `WITH per_request AS (
         SELECT request_id, array_agg(tool_id ORDER BY id) AS sequence
           FROM tool_calls
          WHERE user_id = $1 AND ok AND created_at > now() - ($3::int * interval '1 day')
          GROUP BY request_id
         HAVING count(*) >= 2
       ), episodes AS (
         SELECT provenance->>'requestId' AS request_id, content
           FROM memories WHERE user_id = $1 AND kind = 'episodic'
       )
       SELECT p.sequence, count(*)::int AS occurrences,
              (array_agg(substring(e.content from '«(.*?)»')))[1:3] AS samples
         FROM per_request p LEFT JOIN episodes e ON e.request_id = p.request_id
        GROUP BY p.sequence HAVING count(*) >= $2
        ORDER BY occurrences DESC LIMIT 10`,
      [userId, min, days],
    );
    return res.rows.map((r) => ({
      sequence: r.sequence,
      occurrences: r.occurrences,
      sampleRequests: (r.samples ?? []).filter((s): s is string => typeof s === 'string'),
    }));
  });
}

/** Proposta di skill guidata da una procedura ripetuta, generata da template (deterministica). */
export function buildProposalFromProcedure(p: RepeatedProcedure, key: string) {
  const steps = p.sequence.map((t, i) => `${i + 1}. usa \`${t}\``).join('\n');
  const examples = p.sampleRequests.length
    ? p.sampleRequests.map((s) => `- "${s}"`).join('\n')
    : '- (nessun esempio registrato)';
  return {
    key,
    title: `Procedura: ${p.sequence.join(' → ')}`,
    description: `Procedura ricorrente (${p.occurrences} volte) che usa ${p.sequence.join(', ')}.`,
    triggers: p.sampleRequests.slice(0, 3),
    allowedTools: [...new Set(p.sequence)],
    instructions: `Quando l'utente chiede qualcosa come:\n${examples}\n\nSegui questi passi nell'ordine, usando solo i tool indicati:\n${steps}\n\nRiassumi il risultato in una frase.`,
  };
}
