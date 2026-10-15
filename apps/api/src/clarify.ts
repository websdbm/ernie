import { type Pool, withUser } from '@ernie/db';
import type { Clarification } from '@ernie/jev-router';
import type { ContentBlock } from '@ernie/protocol';

/**
 * Chiarimento interno, lato server (richiesta dell'utente, 15 ott 2026): quando scatta, la riga per la chat e la
 * traccia per la taratura. Il chiarimento vero (domande del modello leggero, risposte di Jev) sta in
 * packages/jev-router (clarify.ts) e packages/agent-core (clarify.ts).
 */

/**
 * Correzioni esplicite della risposta precedente, riconosciute senza modello: «no, intendevo…», «non hai capito»,
 * «non era questo», «volevo dire…», «ho detto…». Jev le riconosce anche quando sono dette in altro modo.
 */
export function isCorrection(text: string): boolean {
  const t = text
    .replace(/^\[voce\]\s*/u, '')
    .replace(/[‘’´`]/gu, "'")
    .trim()
    .toLowerCase();
  // «No, …» seguito da una correzione entro poche parole; oppure una correzione in apertura.
  const afterNo =
    /^(?:no|ma\s+no|macch[ée]|guarda\s+che|scusa|cio[èe])(?=[\s,.:;!?-]|$).{0,48}?\b(?:intendevo|volevo\s+dire|ho\s+detto|non\s+ho\s+detto|dicevo|non\s+hai\s+capito|non\s+era\s+(?:questo|quello|cos[iì])|non\s+è\s+quello)/u;
  const opening =
    /^(?:non\s+hai\s+capito|hai\s+capito\s+male|hai\s+frainteso|non\s+intendevo|non\s+era\s+(?:questo|quello)|intendevo)\b/u;
  return afterNo.test(t) || opening.test(t);
}

/** Riga «Ho inteso …» per la chat: solo le risposte sicure, e solo se ce ne sono. */
export function interpretationBlock(c: Clarification): ContentBlock | null {
  if (!c.resolved.length) return null;
  return {
    kind: 'interpretation',
    trigger: c.trigger,
    items: c.resolved.slice(0, 4).map((r) => ({
      about: r.about.slice(0, 60),
      meaning: r.meaning.slice(0, 120),
    })),
  };
}

export interface ClarificationRecord {
  readonly userId: string;
  readonly sessionId: string | null;
  readonly requestId: string;
  readonly message: string;
  readonly trigger: 'ambiguous' | 'correction' | 'skill';
  readonly ambiguity?: number | undefined;
  readonly correction?: number | undefined;
  readonly clarification?: Clarification | null;
  readonly latencyMs?: number;
  readonly error?: string;
  /** Controllo di un comando rapido: la skill, cosa avrebbe fatto, quanto era fedele secondo Jev. */
  readonly skill?: { readonly id: string; readonly planned: string; readonly faithful?: number };
  readonly costUsd?: number;
}

/** Una riga di interpretation_checks per ogni chiarimento tentato (anche fallito), per tarare le soglie. */
export function createClarificationRecorder(pool: Pool) {
  return {
    async record(r: ClarificationRecord): Promise<void> {
      const c = r.clarification ?? null;
      await withUser(pool, r.userId, (client) =>
        client.query(
          `INSERT INTO interpretation_checks
             (user_id, session_id, request_id, trigger, message, ambiguity, correction, questions, answers, resolved,
              cost_usd, latency_ms, error, skill_id, planned, faithful)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
          [
            r.userId,
            r.sessionId,
            r.requestId,
            r.trigger,
            r.message.slice(0, 4000),
            r.ambiguity ?? null,
            r.correction ?? null,
            JSON.stringify(c?.questions ?? []),
            JSON.stringify(c?.answers ?? []),
            c?.resolved.length ?? 0,
            c?.costUsd ?? r.costUsd ?? 0,
            c?.latencyMs ?? r.latencyMs ?? 0,
            r.error?.slice(0, 300) ?? null,
            r.skill?.id ?? null,
            r.skill?.planned.slice(0, 600) ?? null,
            r.skill?.faithful ?? null,
          ],
        ),
      );
    },
  };
}
export type ClarificationRecorder = ReturnType<typeof createClarificationRecorder>;
