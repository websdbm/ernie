import type { ClarifyInput, ClarifyQuestion, Questioner } from '@ernie/jev-router';
import {
  callCostUsd,
  type LlmCallRecorder,
  type ModelGateway,
  normalizeUsage,
} from '@ernie/model-gateway';
import { Agent } from '@mastra/core/agent';
import { z } from 'zod';

/**
 * Chi fa le domande nel chiarimento interno (richiesta dell'utente, 15 ott 2026): il modello leggero legge il
 * messaggio e gli ultimi scambi e scrive fino a quattro domande chiuse sui punti che si possono intendere in modi
 * diversi, con le interpretazioni possibili prese dal contesto. Le risposte le dà Jev (packages/jev-router).
 */
const Questions = z.object({
  questions: z
    .array(
      z.object({
        about: z.string().min(1).max(60),
        question: z.string().min(3).max(200),
        options: z.array(z.string().min(1).max(100)).min(2).max(4),
      }),
    )
    .max(3),
});

export const CLARIFY_INSTRUCTIONS = `Controlli l'interpretazione dei messaggi che l'utente manda al suo assistente personale, prima che l'assistente risponda. Non rispondi all'utente: scrivi solo domande chiuse sul testo.

Individua al massimo 3 punti del messaggio che si possono intendere in modi diversi:
- pronomi o riferimenti senza un referente certo («lui», «lei», «lì», «quello», «la solita cosa»);
- nomi o parole che sembrano errori di dettatura o di battitura (es. «Jeff» detto al posto di «Jev», «papi» al posto di «papo»): confrontali con le persone, i luoghi e gli argomenti noti;
- date, orari o luoghi che possono indicare cose diverse («venerdì», «a casa», «da lui»);
- una richiesta che ha due letture (fare una cosa o spiegarla, a chi è rivolta).

Per ogni punto: «about» è il pezzo di testo così come l'ha scritto l'utente; «question» una domanda di poche parole; «options» da 2 a 3 interpretazioni brevi (poche parole), concrete e diverse fra loro, prese dal contesto (persone note, luoghi, argomenti degli ultimi scambi), scritte come risposta diretta («Giorgio», «Jev, il router decisionale»). Non aggiungere l'opzione «non si sa»: c'è già.
Se il messaggio è chiaro, restituisci nessuna domanda. Non chiedere dettagli che servono solo a eseguire la richiesta quando il testo non è ambiguo.`;

export function questionerPrompt(input: ClarifyInput): string {
  return [
    input.trigger === 'correction'
      ? "Situazione: l'utente sta correggendo la risposta precedente dell'assistente. Chiediti cosa intendeva davvero nella richiesta corretta."
      : 'Situazione: il messaggio sembra poco chiaro.',
    input.inputMode === 'voice'
      ? 'Il messaggio è dettato: la trascrizione può storpiare nomi e parole.'
      : '',
    `Persone note: ${input.people.join(', ') || 'nessuna'}.`,
    `Luoghi noti: ${input.places.join(', ') || 'nessuno'}.`,
    '',
    'Ultimi scambi:',
    ...(input.recentTurns.length ? input.recentTurns.slice(-6) : ['(nessuno)']),
    '',
    `Messaggio dell'utente: «${input.message.slice(0, 1500)}»`,
  ]
    .filter((l, i, all) => l !== '' || all[i - 1] !== '')
    .join('\n');
}

export interface ClarifyQuestionerDeps {
  readonly gateway: ModelGateway;
  readonly recorder: LlmCallRecorder;
}

/** Un questioner per turno: usa il modello leggero e registra la chiamata come parte dell'instradamento. */
export function createClarifyQuestioner(
  deps: ClarifyQuestionerDeps,
  ctx: { userId: string; sessionId: string | null; requestId: string },
): Questioner {
  const resolved = deps.gateway.resolve('light', `clarify-${ctx.userId}`);
  const agent = new Agent({
    id: `clarify-${ctx.userId}`,
    name: 'Chiarimento',
    instructions: CLARIFY_INSTRUCTIONS,
    model: resolved.model,
  });
  return async (input) => {
    const t0 = Date.now();
    const result = await agent.generate(questionerPrompt(input), {
      structuredOutput: {
        schema: Questions,
        errorStrategy: 'fallback',
        fallbackValue: { questions: [] },
      },
      // Niente ragionamento: domande brevi, servono in fretta (misurato il 15 ott 2026: 2,4–6 s con ~250 token).
      modelSettings: { maxOutputTokens: 450 },
      providerOptions: {
        anthropic: { thinking: { type: 'disabled' } },
        openrouter: { reasoning: { enabled: false } },
      },
    } as never);
    const r = result as unknown as {
      object?: z.infer<typeof Questions>;
      usage?: unknown;
      providerMetadata?: unknown;
      response?: { id?: string };
    };
    const usage = normalizeUsage(r.usage, r.providerMetadata);
    await deps.recorder.record({
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      requestId: ctx.requestId,
      stepIndex: 0,
      purpose: 'router',
      provider: resolved.provider,
      model: resolved.profile.modelId,
      modelClass: 'light',
      generationId: r.response?.id ?? null,
      usage,
      ttftMs: null,
      latencyMs: Date.now() - t0,
      finishReason: 'stop',
    });
    const parsed = Questions.safeParse(r.object);
    const questions: ClarifyQuestion[] = parsed.success ? parsed.data.questions : [];
    return { questions, costUsd: callCostUsd(usage, resolved.profile.modelId) };
  };
}
