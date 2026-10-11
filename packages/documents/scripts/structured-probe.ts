/** Sonda: structured output per classe di modello (light/standard) via Mastra Agent. */
import { buildProfiles, createModelGateway } from '@ernie/model-gateway';
import { Agent } from '@mastra/core/agent';
import { z } from 'zod';

const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('OPENROUTER_API_KEY mancante');
const ids = {
  light: process.env.MODEL_LIGHT ?? 'anthropic/claude-haiku-5.5',
  standard: process.env.MODEL_STANDARD ?? 'anthropic/claude-sonnet-5.5',
  heavy: process.env.MODEL_HEAVY ?? 'anthropic/claude-opus-5.5',
};
const gateway = createModelGateway({ openrouterApiKey: key, profiles: buildProfiles(ids) });
const Notes = z.object({ summary: z.string().max(300), keyPoints: z.array(z.string()).max(3) });
for (const cls of ['light', 'standard'] as const) {
  const resolved = gateway.resolve(cls, 'probe');
  const agent = new Agent({
    id: `probe-${cls}`,
    name: 'Sonda',
    instructions: 'Rispondi in italiano.',
    model: resolved.model,
  });
  const t0 = Date.now();
  try {
    const r = (await agent.generate(
      'Prendi appunti su: Roma fu fondata nel 753 a.C. sul Palatino; Romolo fu il primo re.',
      {
        structuredOutput: { schema: Notes, errorStrategy: 'strict' },
        modelSettings: { maxOutputTokens: 512, temperature: 0.2 },
      } as never,
    )) as unknown as Record<string, unknown>;
    console.log(
      cls,
      resolved.profile.modelId,
      `${Date.now() - t0} ms`,
      'keys:',
      Object.keys(r).join(','),
      'object:',
      JSON.stringify(r.object)?.slice(0, 200),
      'text:',
      String(r.text ?? '').slice(0, 120),
    );
  } catch (err) {
    console.log(
      cls,
      resolved.profile.modelId,
      'ERRORE',
      err instanceof Error ? err.message.slice(0, 300) : String(err),
    );
  }
}
