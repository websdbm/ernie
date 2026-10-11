/** Sonda del riassuntore su un file di testo (pagine separate da righe vuote doppie), senza passare dal turno WS. */
import { readFileSync } from 'node:fs';
import { buildProfiles, createModelGateway } from '@ernie/model-gateway';
import { createSummarizer } from '../src/summarize.js';

const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('OPENROUTER_API_KEY mancante');
const file = process.argv[2];
if (!file) throw new Error('uso: summarize-probe <file.txt>');
const paragraphs = readFileSync(file, 'utf8')
  .split(/\n\s*\n/)
  .filter((p) => p.trim());
const pages: string[] = [];
for (let i = 0; i < paragraphs.length; i += 2) pages.push(paragraphs.slice(i, i + 2).join('\n\n'));
const gateway = createModelGateway({
  openrouterApiKey: key,
  profiles: buildProfiles({
    light: process.env.MODEL_LIGHT ?? 'anthropic/claude-haiku-5.5',
    standard: process.env.MODEL_STANDARD ?? 'anthropic/claude-sonnet-5.5',
    heavy: process.env.MODEL_HEAVY ?? 'anthropic/claude-opus-5.5',
  }),
});
const calls: Array<{ cls: string; ms: number; usage: unknown }> = [];
const summarizer = createSummarizer({
  gateway,
  recorder: {
    record: async (c) => {
      calls.push({ cls: c.modelClass ?? '?', ms: c.latencyMs, usage: c.usage });
    },
  },
  logger: {
    info: (o, m) => console.error('info', m, JSON.stringify(o)),
    warn: (o, m) => console.error('warn', m, JSON.stringify(o)),
    error: (o, m) => console.error('error', m, JSON.stringify(o)),
  },
});
const t0 = Date.now();
process.on('unhandledRejection', (err) => {
  const e = err as { message?: string; details?: Record<string, unknown>; cause?: unknown };
  console.log('ERRORE:', String(e.message).slice(0, 400));
  console.log(
    'details:',
    Object.keys(e.details ?? {}).join(','),
    'finishReason:',
    e.details?.finishReason,
    'value chars:',
    String(e.details?.value ?? '').length,
  );
  console.log('value tail:', String(e.details?.value ?? '').slice(-200));
  process.exit(1);
});
let r: Awaited<ReturnType<typeof summarizer.summarize>>;
try {
  r = await summarizer.summarize(
    { id: 'probe', title: 'Storia romana', pageTexts: pages },
    { userId: 'probe', sessionId: null, requestId: 'probe' },
  );
} catch (err) {
  const e = err as { message?: string; details?: Record<string, unknown> };
  console.log('ERRORE:', String(e.message).slice(0, 500));
  console.log(
    'details:',
    Object.keys(e.details ?? {}).join(','),
    'finishReason:',
    e.details?.finishReason,
    'value chars:',
    String(e.details?.value ?? '').length,
  );
  process.exit(1);
}
console.log(
  `pagine ${pages.length}, caratteri ${pages.reduce((n, p) => n + p.length, 0)}, ${((Date.now() - t0) / 1000).toFixed(1)} s, chiamate ${calls.length}:`,
  calls.map((c) => `${c.cls} ${c.ms} ms`).join(', '),
);
console.log('titolo:', r.title);
console.log('abstract:', r.products.abstract.slice(0, 300));
console.log(
  'punti:',
  r.products.keyPoints.length,
  'glossario:',
  r.products.glossary.length,
  'domande:',
  r.products.questions.length,
  'schema:',
  r.schema.type,
);
