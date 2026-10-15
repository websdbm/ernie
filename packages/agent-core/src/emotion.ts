/**
 * Espressività dell'avatar (M10): un'emozione dedotta dal turno con regole, senza chiamare modelli.
 * Il vocabolario è chiuso (`avatar.emotion` nel protocollo). Dal 15 ott 2026 l'orso ha un secondo foglio
 * (richiesta dell'utente: «più variabilità, occhiali da sole ed espressione feroce»): occhiali da sole, feroce,
 * risata, imbarazzo, confusione, entusiasmo, sonno. Nel dubbio nessuna emozione: l'orso resta neutro.
 * Ordine: esito del turno → stato d'animo dell'utente (empatia prima di tutto) → tono della risposta.
 */
export type AvatarEmotion =
  | 'happy'
  | 'sad'
  | 'surprised'
  | 'playful'
  | 'love'
  | 'cool'
  | 'fierce'
  | 'proud'
  | 'laughing'
  | 'embarrassed'
  | 'confused'
  | 'excited'
  | 'determined'
  | 'worried'
  | 'sleep';

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

const USER_WORRIED =
  /\b(?:sono|mi\s+sento|sto)\s+(?:(?:proprio|molto|davvero|cos[iì]|tanto|un\s+po['’]?)\s+)?(?:preoccupat[oa]|in\s+ansia|agitat[oa])\b|\bho\s+paura\b|\bche\s+ansia\b|😰|😟/iu;
const USER_SAD =
  /\b(?:sono|mi\s+sento|sto)\s+(?:(?:proprio|molto|davvero|cos[iì]|tanto|un\s+po['’]?)\s+)?(?:triste|gi[uù]|male|stanc[oa]|stressat[oa]|abbattut[oa]|solo|sola)\b|\bche\s+brutta\s+giornata\b|\b(?:è|e')\s+mort[oa]\b|\bmi\s+manca\b|\bho\s+litigato\b|\bnon\s+ce\s+la\s+faccio\b/iu;
const USER_ANGRY =
  /\b(?:sono|mi\s+sento)\s+(?:(?:molto|proprio|davvero)\s+)?(?:arrabbiat[oa]|furios[oa]|incazzat[oa]|nervos[oa])\b|\bche\s+rabbia\b|\bnon\s+lo\s+sopporto\b|😡|🤬/iu;
const USER_HYPE =
  /\b(?:grr+|ruggisci|ruggito|feroce|spacca(?:re)?|carica|andiamo|forza\s+ernie|let['’]?s\s+go|tiriamo\s+fuori\s+le\s+unghie)\b|💪|🔥|😤|🐻/iu;
const USER_LOVE = /\bti\s+voglio\s+bene\b|\bti\s+adoro\b|❤️|😍|🥰/u;
const USER_COOL =
  /\b(?:sei\s+(?:un|il)\s+(?:mito|grande|genio|boss|top|campione)|sei\s+(?:fortissim[oa]|troppo\s+forte|un\s+figo)|occhiali\s+da\s+sole|stiloso|fighissimo)\b|😎/iu;
const USER_PROUD = /\b(?:bravo|brava|bravissim[oa]|ottimo\s+lavoro|ben\s+fatto|complimenti)\b|👏/iu;
const USER_THANKS = /\b(?:grazie|grazie\s+mille|perfetto|fantastico|ottimo|benissimo)\b|👍|🙏/iu;
const USER_BIG_LAUGH = /\ba?h(?:ah){2,}\b|\bahah\b|😂|🤣/iu;
const USER_LAUGH =
  /\b(?:a?h(?:ah){1,}|ih(?:ih)+|lol|scherzo|scherzavo|battuta|barzelletta)\b|😆|😜/iu;
const USER_EXCITED =
  /\b(?:che\s+bello|evviva|yay|non\s+vedo\s+l['’]ora|finalmente|s[iì]{3,})\b|🎉|🥳|🤩/iu;
const USER_SURPRISE = /\b(?:wow|incredibile|pazzesco|non\s+ci\s+credo|ma\s+dai|davvero\s*\?)/iu;
const USER_SLEEPY =
  /\b(?:buonanotte|vado\s+a\s+(?:dormire|letto|nanna)|ho\s+sonno|che\s+sonno)\b|😴|🥱/iu;
const REPLY_DONE =
  /\b(?:ho\s+aggiunto|aggiunt[oi]\s+alla\s+lista|ho\s+salvato|ricetta\s+salvata|promemoria\s+(?:impostato|messo|fissato)|ti\s+ricorder[oò]|ho\s+creato|fatto[!,.:]|ecco\s+(?:il|la|lo|i|le|gli)\b)/iu;
const REPLY_OOPS =
  /\b(?:ops|oops|errore\s+mio|hai\s+ragione,?\s+(?:ho\s+sbagliato|mi\s+sono\s+sbagliat[oa]|scusa))\b/iu;
const REPLY_CONFUSED =
  /\b(?:non\s+ho\s+capito|non\s+sono\s+sicur[oa]\s+di\s+aver\s+capito|cosa\s+intendi|intendi\s+dire|puoi\s+ripetere|puoi\s+spiegarmi\s+meglio)\b/iu;
const REPLY_SORRY =
  /\b(?:mi\s+dispiace|purtroppo|non\s+sono\s+riuscit[oa]|non\s+posso|non\s+riesco)\b/iu;
const DONE_ACTIONS =
  /^(?:add|create|save|check|reminder|ricordami|promemoria|set_place|rename_place)/i;

/** Varietà senza caso: la stessa risposta dà sempre la stessa espressione (test ripetibili). */
function pick<T>(options: readonly T[], seed: string): T {
  let h = 0;
  for (const ch of seed) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return options[h % options.length] as T;
}

export function inferEmotion(i: EmotionInput): EmotionSignal | null {
  if (i.outcome === 'cancelled') return null;
  if (i.outcome !== 'completed') return { name: 'sad', intensity: 0.5, durationMs: 4_000 };
  const user = i.userText;
  if (USER_WORRIED.test(user)) return { name: 'worried', intensity: 0.7, durationMs: 6_000 };
  if (USER_SAD.test(user)) return { name: 'sad', intensity: 0.7, durationMs: 7_000 };
  // L'utente arrabbiato: Ernie è serio e dalla sua parte, non feroce con lui.
  if (USER_ANGRY.test(user)) return { name: 'determined', intensity: 0.7, durationMs: 5_000 };
  if (USER_LOVE.test(user)) return { name: 'love', intensity: 0.9, durationMs: 6_000 };
  if (USER_HYPE.test(user)) return { name: 'fierce', intensity: 0.9, durationMs: 5_000 };
  if (USER_COOL.test(user)) return { name: 'cool', intensity: 0.9, durationMs: 6_000 };
  if (USER_BIG_LAUGH.test(user)) return { name: 'laughing', intensity: 0.9, durationMs: 5_000 };
  if (USER_LAUGH.test(user)) return { name: 'playful', intensity: 0.8, durationMs: 5_000 };
  if (USER_SLEEPY.test(user)) return { name: 'sleep', intensity: 0.6, durationMs: 6_000 };
  if (USER_PROUD.test(user)) return { name: 'proud', intensity: 0.8, durationMs: 5_000 };
  if (USER_EXCITED.test(user)) return { name: 'excited', intensity: 0.8, durationMs: 5_000 };
  if (USER_THANKS.test(user)) return { name: 'happy', intensity: 0.8, durationMs: 5_000 };
  if (USER_SURPRISE.test(user)) return { name: 'surprised', intensity: 0.7, durationMs: 4_000 };
  if (REPLY_OOPS.test(i.replyText))
    return { name: 'embarrassed', intensity: 0.6, durationMs: 4_000 };
  if (REPLY_CONFUSED.test(i.replyText))
    return { name: 'confused', intensity: 0.6, durationMs: 4_000 };
  if (REPLY_SORRY.test(i.replyText)) return { name: 'sad', intensity: 0.4, durationMs: 4_000 };
  if (i.actions?.some((a) => DONE_ACTIONS.test(a)) || REPLY_DONE.test(i.replyText))
    // Lavoro fatto: di solito contento, a volte fiero o con gli occhiali da sole.
    return {
      name: pick<AvatarEmotion>(['happy', 'happy', 'happy', 'cool', 'proud'], i.replyText),
      intensity: 0.5,
      durationMs: 4_000,
    };
  return null;
}
