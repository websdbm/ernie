/**
 * Espressività dell'avatar (M10): un'emozione dedotta dal turno con regole, senza chiamare modelli.
 * Il vocabolario è chiuso (`avatar.emotion` nel protocollo) e l'orso in pixel art ha un fotogramma per
 * felice, sorpreso, triste e occhiolino. Nel dubbio nessuna emozione: l'orso resta neutro.
 * Ordine: esito del turno → stato d'animo dell'utente (empatia prima di tutto) → tono della risposta.
 */
export type AvatarEmotion = 'happy' | 'sad' | 'surprised' | 'playful' | 'love';

export interface EmotionInput {
  readonly userText: string;
  readonly replyText: string;
  readonly outcome: 'completed' | 'error' | 'cancelled' | 'loop';
  /** Azioni eseguite dalle skill deterministiche (es. `add:latte`, `diario:today`). */
  readonly actions?: readonly string[];
}

export interface EmotionSignal {
  readonly name: AvatarEmotion;
  readonly intensity: number;
  /** Quanto resta visibile dopo che Ernie ha finito di parlare. */
  readonly durationMs: number;
}

const USER_SAD =
  /\b(?:sono|mi\s+sento|sto)\s+(?:(?:proprio|molto|davvero|cos[iì]|tanto|un\s+po['’]?)\s+)?(?:triste|gi[uù]|male|stanc[oa]|preoccupat[oa]|stressat[oa]|abbattut[oa]|solo|sola)\b|\bche\s+brutta\s+giornata\b|\b(?:è|e')\s+mort[oa]\b|\bho\s+paura\b|\bmi\s+manca\b|\bho\s+litigato\b|\bnon\s+ce\s+la\s+faccio\b/iu;
const USER_LOVE = /\bti\s+voglio\s+bene\b|\bti\s+adoro\b|❤️|😍|🥰/u;
const USER_THANKS =
  /\b(?:grazie|grazie\s+mille|bravo|brava|bravissim[oa]|perfetto|fantastico|ottimo|benissimo|sei\s+(?:un|il)\s+(?:mito|grande|genio))\b|👍|🙏/iu;
const USER_LAUGH =
  /\b(?:a?h(?:ah){1,}|ih(?:ih)+|lol|scherzo|scherzavo|battuta|barzelletta)\b|😂|🤣|😆|😜/iu;
const USER_SURPRISE = /\b(?:wow|incredibile|pazzesco|non\s+ci\s+credo|ma\s+dai|davvero\s*\?)/iu;
const REPLY_DONE =
  /\b(?:ho\s+aggiunto|aggiunt[oi]\s+alla\s+lista|ho\s+salvato|ricetta\s+salvata|promemoria\s+(?:impostato|messo|fissato)|ti\s+ricorder[oò]|ho\s+creato|fatto[!,.]|ecco\s+(?:il|la|lo|i|le|gli)\b)/iu;
const REPLY_SORRY =
  /\b(?:mi\s+dispiace|purtroppo|non\s+sono\s+riuscit[oa]|non\s+posso|non\s+riesco)\b/iu;
const DONE_ACTIONS = /^(?:add|create|save|check|reminder|ricordami|promemoria)/i;

export function inferEmotion(i: EmotionInput): EmotionSignal | null {
  if (i.outcome === 'cancelled') return null;
  if (i.outcome !== 'completed') return { name: 'sad', intensity: 0.5, durationMs: 4_000 };
  const user = i.userText;
  if (USER_SAD.test(user)) return { name: 'sad', intensity: 0.7, durationMs: 7_000 };
  if (USER_LOVE.test(user)) return { name: 'love', intensity: 0.9, durationMs: 6_000 };
  if (USER_LAUGH.test(user)) return { name: 'playful', intensity: 0.8, durationMs: 5_000 };
  if (USER_THANKS.test(user)) return { name: 'happy', intensity: 0.8, durationMs: 5_000 };
  if (USER_SURPRISE.test(user)) return { name: 'surprised', intensity: 0.7, durationMs: 4_000 };
  if (REPLY_SORRY.test(i.replyText)) return { name: 'sad', intensity: 0.4, durationMs: 4_000 };
  if (i.actions?.some((a) => DONE_ACTIONS.test(a)) || REPLY_DONE.test(i.replyText))
    return { name: 'happy', intensity: 0.5, durationMs: 4_000 };
  return null;
}
