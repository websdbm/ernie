/** Sonda: una sola chiamata «appunti per pezzo» sulla classe light, con dettagli dell'errore. */
import { readFileSync } from 'node:fs';
import { buildProfiles, createModelGateway } from '@ernie/model-gateway';
import { Agent } from '@mastra/core/agent';
import { z } from 'zod';

const key = process.env.OPENROUTER_API_KEY ?? '';
const text = readFileSync(process.argv[2] ?? '', 'utf8').slice(0, 24_000);
const gateway = createModelGateway({ openrouterApiKey: key, profiles: buildProfiles({ light: 'anthropic/claude-haiku-5.5', standard: 'anthropic/claude-sonnet-5.5', heavy: 'anthropic/claude-opus-5.5' }) });
const ChunkNotes = z.object({ summary: z.string().max(1200), keyPoints: z.array(z.string().max(200)).max(8), entities: z.array(z.string().max(80)).max(15).default([]) });
const resolved = gateway.resolve('light', 'probe');
const agent = new Agent({ id: 'probe-light', name: 'Documenti', instructions: 'Sei un tutor. Rispondi in italiano, frasi brevi.', model: resolved.model });
for (const max of [Number(process.argv[3] ?? 4096)]) {
  const t0 = Date.now();
  try {
    const r = (await agent.generate(`Prendi appunti molto dettagliati: riassunto di almeno 40 frasi, 20 punti chiave, 40 termini.\n\n<<<TESTO\n${text}\nTESTO>>>`, {
      structuredOutput: { schema: ChunkNotes, errorStrategy: 'strict' },
      modelSettings: { maxOutputTokens: max, temperature: 0.2 },
    } as never)) as unknown as { object?: unknown; finishReason?: string; usage?: unknown; text?: string };
    console.log('OK', max, `${Date.now() - t0} ms`, 'finish:', r.finishReason, 'usage:', JSON.stringify(r.usage), 'obj:', JSON.stringify(r.object)?.length, 'chars');
  } catch (err) {
    const e = err as { message?: string; details?: Record<string, unknown> };
    console.log('ERRORE', max, `${Date.now() - t0} ms`, 'msg:', String(e.message).slice(0, 200));
    console.log('details keys:', Object.keys(e.details ?? {}).join(','), 'finishReason:', e.details?.finishReason, 'value chars:', String(e.details?.value ?? '').length);
    console.log('value tail:', String(e.details?.value ?? '').slice(-160));
  }
}
