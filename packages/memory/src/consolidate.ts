import { type Pool, withUser } from '@ernie/db';
import { type LlmCallRecorder, type ModelGateway, normalizeUsage } from '@ernie/model-gateway';
import type { Logger } from '@ernie/observability';
import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import type { MemoryRepository } from './repository.js';
import type { MemoryCategory } from './types.js';

/** Sottoinsieme dell'API Memory di Mastra usato dal consolidamento. */
export interface ThreadReader {
  recall(args: {
    threadId: string;
    resourceId?: string;
    perPage?: number | false;
    orderBy?: { field: 'createdAt'; direction: 'ASC' | 'DESC' };
  }): Promise<{ messages: unknown[] }>;
}

export interface ConsolidationDeps {
  readonly pool: Pool;
  readonly repo: MemoryRepository;
  readonly threads: ThreadReader;
  readonly gateway: ModelGateway;
  readonly recorder: LlmCallRecorder;
  readonly logger: Logger;
  /** Per i test: estrattore sostitutivo senza LLM. */
  readonly extractor?: Extractor;
}

export interface ConsolidationResult {
  readonly skipped: boolean;
  readonly read: number;
  readonly extracted: number;
  readonly inserted: number;
  readonly deduplicated: number;
  readonly superseded: number;
}

export const ExtractedFact = z.object({
  content: z.string().min(5).max(240),
  category: z.enum(['preference', 'fact', 'relationship', 'project', 'habit', 'other']),
  confidence: z.number().min(0).max(1),
  /** id di un ricordo esistente contraddetto da questo (dalla lista candidati), altrimenti null. */
  supersedes: z.string().nullable(),
});
export const Extraction = z.object({ facts: z.array(ExtractedFact).max(8) });
export type Extraction = z.infer<typeof Extraction>;

export interface TranscriptLine {
  readonly role: string;
  readonly text: string;
  readonly createdAt: Date;
}

export type Extractor = (
  transcript: readonly TranscriptLine[],
  candidates: ReadonlyArray<{ id: string; content: string }>,
) => Promise<Extraction>;

const EXTRACTION_INSTRUCTIONS = `Sei il modulo di memoria di un assistente personale. Dalla trascrizione estrai SOLO fatti stabili sulla persona:
preferenze, abitudini, relazioni, progetti, fatti personali durevoli. Ignora convenevoli, richieste occasionali, informazioni generali
non personali e tutto ciò che è già nei ricordi esistenti. Scrivi in italiano, terza persona ("Preferisce…", "Ha un figlio…"), max 200 caratteri per fatto.
Se un fatto contraddice un ricordo esistente, indica il suo id in "supersedes". Confidence: 0.9 se detto esplicitamente dalla persona, 0.6 se dedotto. Nessun fatto → lista vuota.`;

/** Estrae testo da un messaggio Mastra (formati diversi tra versioni), in modo difensivo. */
export function messageToLine(m: unknown): TranscriptLine | null {
  if (!m || typeof m !== 'object') return null;
  const r = m as Record<string, unknown>;
  const role = typeof r.role === 'string' ? r.role : 'unknown';
  const createdAt =
    r.createdAt instanceof Date ? r.createdAt : new Date(String(r.createdAt ?? Date.now()));
  const c = r.content;
  let text = '';
  if (typeof c === 'string') text = c;
  else if (c && typeof c === 'object') {
    const cc = c as Record<string, unknown>;
    if (typeof cc.content === 'string') text = cc.content;
    const parts = Array.isArray(cc.parts) ? cc.parts : [];
    const texts = parts
      .map((p) =>
        p && typeof p === 'object' && (p as { type?: string }).type === 'text'
          ? String((p as { text?: string }).text ?? '')
          : '',
      )
      .filter(Boolean);
    if (texts.length) text = texts.join(' ');
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text || (role !== 'user' && role !== 'assistant')) return null;
  return { role, text, createdAt };
}

export function createLlmExtractor(
  deps: Pick<ConsolidationDeps, 'gateway' | 'recorder' | 'logger'>,
  userId: string,
  sessionId: string | null,
): Extractor {
  const resolved = deps.gateway.resolve('light', `memory-${userId}`);
  const agent = new Agent({
    id: `memory-extractor-${userId}`,
    name: 'Memoria',
    instructions: EXTRACTION_INSTRUCTIONS,
    model: resolved.model,
  });
  return async (transcript, candidates) => {
    const prompt = [
      'Ricordi esistenti (id → contenuto):',
      ...(candidates.length ? candidates.map((c) => `- ${c.id} → ${c.content}`) : ['- nessuno']),
      '',
      'Trascrizione:',
      ...transcript.map(
        (l) => `${l.role === 'user' ? 'utente' : 'assistente'}: ${l.text.slice(0, 400)}`,
      ),
    ].join('\n');
    const t0 = Date.now();
    const result = await agent.generate(prompt, {
      structuredOutput: {
        schema: Extraction,
        errorStrategy: 'fallback',
        fallbackValue: { facts: [] },
      },
      modelSettings: { maxOutputTokens: 1_024 },
    } as never);
    const r = result as unknown as {
      object?: Extraction;
      usage?: unknown;
      providerMetadata?: unknown;
      response?: { id?: string };
    };
    const usage = normalizeUsage(r.usage, r.providerMetadata);
    await deps.recorder.record({
      userId,
      sessionId,
      requestId: `memory:${sessionId ?? 'na'}:${t0}`,
      stepIndex: 0,
      purpose: 'memory',
      provider: resolved.provider,
      model: resolved.profile.modelId,
      modelClass: 'light',
      generationId: r.response?.id ?? null,
      usage,
      ttftMs: null,
      latencyMs: Date.now() - t0,
      finishReason: 'stop',
    });
    const parsed = Extraction.safeParse(r.object);
    return parsed.success ? parsed.data : { facts: [] };
  };
}

/**
 * Consolidamento asincrono di un thread: legge i messaggi nuovi dal cursore, estrae fatti con il modello
 * `light` (una sola chiamata per batch), deduplica e risolve le contraddizioni per supersessione.
 */
export async function consolidateThread(
  deps: ConsolidationDeps,
  job: { userId: string; threadId: string; sessionId: string | null },
): Promise<ConsolidationResult> {
  const { userId, threadId } = job;
  const cursor = await withUser(deps.pool, userId, async (c) => {
    const r = await c.query<{ last_message_at: Date | null }>(
      `SELECT last_message_at FROM memory_cursors WHERE thread_id = $1`,
      [threadId],
    );
    return r.rows[0]?.last_message_at ?? null;
  });

  const { messages } = await deps.threads.recall({
    threadId,
    resourceId: userId,
    perPage: false,
    orderBy: { field: 'createdAt', direction: 'ASC' },
  });
  const lines = messages
    .map(messageToLine)
    .filter((l): l is TranscriptLine => l !== null)
    .filter((l) => !cursor || l.createdAt > cursor);
  const batch = lines.slice(-24);
  const userLines = batch.filter((l) => l.role === 'user');
  if (userLines.length === 0)
    return {
      skipped: true,
      read: lines.length,
      extracted: 0,
      inserted: 0,
      deduplicated: 0,
      superseded: 0,
    };

  const candidates = await deps.repo.search({
    userId,
    query: userLines
      .map((l) => l.text)
      .join(' ')
      .slice(0, 1_000),
    kinds: ['semantic'],
    limit: 8,
  });
  const extractor = deps.extractor ?? createLlmExtractor(deps, userId, job.sessionId);
  const extraction = await extractor(
    batch,
    candidates.map((c) => ({ id: c.id, content: c.content })),
  );

  let inserted = 0;
  let deduplicated = 0;
  let superseded = 0;
  const candidateIds = new Set(candidates.map((c) => c.id));
  for (const f of extraction.facts) {
    const supersedesId = f.supersedes && candidateIds.has(f.supersedes) ? f.supersedes : null;
    const res = await deps.repo.remember({
      userId,
      kind: 'semantic',
      category: f.category as MemoryCategory,
      content: f.content,
      provenance: {
        source: 'assistant',
        trust: 0.8,
        ...(job.sessionId ? { sessionId: job.sessionId } : {}),
        note: 'consolidamento',
      },
      confidence: f.confidence,
      supersedesId,
    });
    if (res.deduplicated) deduplicated++;
    else inserted++;
    if (res.superseded) superseded++;
  }

  const last = batch.at(-1)?.createdAt ?? new Date();
  await withUser(deps.pool, userId, (c) =>
    c.query(
      `INSERT INTO memory_cursors (thread_id, user_id, last_message_at, processed) VALUES ($1, $2, $3, $4)
       ON CONFLICT (thread_id) DO UPDATE SET last_message_at = EXCLUDED.last_message_at, processed = memory_cursors.processed + EXCLUDED.processed, updated_at = now()`,
      [threadId, userId, last, batch.length],
    ),
  );
  deps.logger.info(
    {
      threadId,
      read: lines.length,
      extracted: extraction.facts.length,
      inserted,
      deduplicated,
      superseded,
    },
    'consolidamento memoria',
  );
  return {
    skipped: false,
    read: lines.length,
    extracted: extraction.facts.length,
    inserted,
    deduplicated,
    superseded,
  };
}
