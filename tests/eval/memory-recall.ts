/**
 * Valutazione del recupero (recall@k) su un corpus italiano: full-text da solo, vettori da soli, ibrido RRF.
 * Embedder: OpenAI text-embedding-3-small (richiede OPENAI_API_KEY) oppure l'embedder finto (EVAL_EMBEDDER=fake).
 * Usa un utente temporaneo sul database (MIGRATIONS_DATABASE_URL + APP_DB_PASSWORD). Costo OpenAI: < 0,001 USD.
 *
 *   pnpm --filter @ernie/tests eval:memory [--write]
 */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createPool } from '@ernie/db';
import {
  createFakeEmbedder,
  createMemoryRepository,
  createOpenAIEmbedder,
  type MemoryHit,
} from '@ernie/memory';
import { createLogger } from '@ernie/observability';

const OWNER_URL = process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_PASSWORD = process.env.APP_DB_PASSWORD;
if (!OWNER_URL || !APP_PASSWORD) {
  console.error('servono MIGRATIONS_DATABASE_URL (o DATABASE_URL) e APP_DB_PASSWORD');
  process.exit(2);
}
const useFake = process.env.EVAL_EMBEDDER === 'fake' || !process.env.OPENAI_API_KEY;
const write = process.argv.includes('--write');

interface Dataset {
  facts: Array<{ id: string; category: string; content: string }>;
  queries: Array<{ q: string; expected: string[] }>;
}
const dataset = JSON.parse(
  await readFile(new URL('./memory-recall.json', import.meta.url), 'utf8'),
) as Dataset;

const appUrl = new URL(OWNER_URL);
appUrl.username = 'ernie_app';
appUrl.password = APP_PASSWORD;
const owner = createPool({ connectionString: OWNER_URL, max: 2 });
const app = createPool({ connectionString: appUrl.toString(), max: 3 });
const logger = createLogger({ level: 'silent', name: 'eval' });
const embedder = useFake
  ? createFakeEmbedder()
  : createOpenAIEmbedder(process.env.OPENAI_API_KEY as string);
const ftsWeight = process.env.EVAL_FTS_WEIGHT ? Number(process.env.EVAL_FTS_WEIGHT) : undefined;
const repo = createMemoryRepository(app, embedder, {
  logger,
  ...(ftsWeight !== undefined ? { ftsWeight } : {}),
});
const userId = randomUUID();
await owner.query(`INSERT INTO users (id, display_name) VALUES ($1, 'eval')`, [userId]);

const idByContent = new Map<string, string>();
try {
  for (const f of dataset.facts) {
    const r = await repo.remember({
      userId,
      kind: 'semantic',
      category: f.category as never,
      content: f.content,
      provenance: { source: 'user', trust: 1 },
      confidence: 0.9,
    });
    idByContent.set(r.record.content, f.id);
  }
  const K = [1, 3, 5];
  type Mode = 'fts' | 'vector' | 'hybrid';
  const modes: Mode[] = ['fts', 'vector', 'hybrid'];
  const recall: Record<Mode, Record<number, number>> = { fts: {}, vector: {}, hybrid: {} };
  const mrr: Record<Mode, number> = { fts: 0, vector: 0, hybrid: 0 };
  for (const mode of modes) {
    for (const k of K) recall[mode][k] = 0;
  }
  const pick = (hits: MemoryHit[], mode: Mode): string[] => {
    const filtered =
      mode === 'fts'
        ? hits
            .filter((h) => h.ftsRank !== null)
            .sort((a, b) => (a.ftsRank ?? 99) - (b.ftsRank ?? 99))
        : mode === 'vector'
          ? hits
              .filter((h) => h.vecRank !== null)
              .sort((a, b) => (a.vecRank ?? 99) - (b.vecRank ?? 99))
          : hits;
    return filtered.map((h) => idByContent.get(h.content) ?? '?');
  };
  const misses: string[] = [];
  for (const q of dataset.queries) {
    const hits = await repo.search({ userId, query: q.q, limit: 20, candidates: 20 });
    for (const mode of modes) {
      const ids = pick(hits, mode);
      for (const k of K) {
        const top = ids.slice(0, k);
        const found = q.expected.filter((e) => top.includes(e)).length / q.expected.length;
        recall[mode][k] = (recall[mode][k] ?? 0) + found / dataset.queries.length;
      }
      const firstIdx = ids.findIndex((id) => q.expected.includes(id));
      mrr[mode] += (firstIdx >= 0 ? 1 / (firstIdx + 1) : 0) / dataset.queries.length;
      if (mode === 'hybrid' && firstIdx > 2)
        misses.push(
          `- "${q.q}" → attesi ${q.expected.join(',')}, primi 3: ${ids.slice(0, 3).join(',')}`,
        );
    }
  }
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const report = `# Valutazione del recupero della memoria

Eseguita il ${new Date().toISOString().slice(0, 10)} su ${dataset.facts.length} fatti e ${dataset.queries.length} domande (\`tests/eval/memory-recall.json\`), embedder \`${embedder.model}\` (${embedder.dimensions} dim), full-text \`italian\`, fusione RRF k=60 (peso testo ${ftsWeight ?? 0.3}, vettori 1), 20 candidati per gamba.

| Modalità | recall@1 | recall@3 | recall@5 | MRR |
|---|---|---|---|---|
${modes.map((m) => `| ${m} | ${pct(recall[m][1] ?? 0)} | ${pct(recall[m][3] ?? 0)} | ${pct(recall[m][5] ?? 0)} | ${(mrr[m]).toFixed(3)} |`).join('\n')}

Domande in cui l'ibrido non porta un fatto atteso nei primi 3:
${misses.join('\n') || '- nessuna'}

Nota: corpus piccolo scritto da chi progetta il sistema; da ampliare con fatti reali consolidati (M9).
`;
  console.log(report);
  if (write) {
    await writeFile(
      new URL('../../docs/research/07-valutazione-memoria.md', import.meta.url),
      report,
    );
    console.log('scritto 07-valutazione-memoria.md');
  }
} finally {
  await owner.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await owner.end();
  await app.end();
}
