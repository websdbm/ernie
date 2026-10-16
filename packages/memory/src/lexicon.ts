import { type Pool, type PoolClient, withUser } from '@ernie/db';
import { z } from 'zod';

/**
 * Lessico imparato (richiesta dell'utente, 16 ott 2026): espressioni che la persona usa spesso, annotate dal
 * consolidamento della memoria nella stessa chiamata dei ricordi. Diventano attive dopo almeno tre batch in due
 * conversazioni diverse (così non si imparano errori di dettatura o battute dette una volta); Ernie le riusa quando
 * calzano. Acceso per tutti, spegnibile dall'utente (settings.learnLexicon) e, per un figlio, dal genitore
 * (guardianships.lexicon_off). Parolacce e insulti non si imparano mai.
 */

export const ExtractedExpression = z.object({
  term: z.string().min(1).max(60),
  meaning: z.string().max(160).nullable().optional(),
  example: z.string().max(200).nullable().optional(),
});
export type ExtractedExpression = z.infer<typeof ExtractedExpression>;

/** Soglie di attivazione: batch in cui compare e conversazioni diverse. */
export const LEXICON_MIN_SEEN = 3;
export const LEXICON_MIN_SESSIONS = 2;

export interface LexiconItem {
  readonly id: string;
  readonly term: string;
  readonly meaning: string;
  readonly example: string;
  readonly status: 'candidate' | 'active';
  readonly seenCount: number;
  readonly lastSeenAt: Date;
}

/** Forma per l'unicità: minuscolo, apostrofi dritti, spazi singoli, senza punteggiatura ai bordi. */
export function normalizeTerm(term: string): string {
  return term
    .replace(/[‘’´`]/gu, "'")
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^[\s"«»“”.,;:!?()-]+|[\s"«»“”.,;:!?()-]+$/gu, '')
    .toLowerCase();
}

// Rete di sicurezza oltre alle istruzioni dell'estrattore: radici volgari, insulti e bestemmie più comuni.
const VULGAR =
  /\b(?:cazz|minchi|stronz|vaffancul|fancul|merd|cogli[oa]n|puttan|troi[ae]|zoccol|mignott|fott|incul|sborr|pompin|figa\b|fighe\b|fica\b|culo\b|culi\b|cul[oa]ne|porc[oa]\s*(?:dio|madonna|giuda)|dio\s*(?:porco|cane|boia)|madonna\s*(?:puttana|troia|maiala)|frocio|froci\b|ricchion|negr[oaie]\b|terron|ritardat|mongolo|handicappat|bastard|deficient|imbecill|cretin|idiot|scem[oaie]\b|testa\s*di\s*cazzo|rompicogl|bocchin|segaiol)/iu;

export function isVulgar(term: string): boolean {
  return VULGAR.test(normalizeTerm(term));
}

/** Espressioni accettabili: non vuote, non volgari, non frasi intere (al massimo 5 parole). */
export function cleanExpressions(items: readonly ExtractedExpression[]): ExtractedExpression[] {
  const seen = new Set<string>();
  const out: ExtractedExpression[] = [];
  for (const it of items) {
    const key = normalizeTerm(it.term);
    if (!key || key.length > 60 || key.split(' ').length > 5) continue;
    if (isVulgar(key) || isVulgar(it.meaning ?? '') || seen.has(key)) continue;
    seen.add(key);
    out.push({
      term: it.term.trim().slice(0, 60),
      meaning: it.meaning ?? null,
      example: it.example ?? null,
    });
  }
  return out.slice(0, 6);
}

export interface LexiconStore {
  /** Apprendimento acceso per l'utente (impostazione propria e, per un figlio, scelta del genitore). */
  learningEnabled(userId: string): Promise<boolean>;
  /** Annota le espressioni di un batch; restituisce quante sono diventate attive ora. */
  learn(
    userId: string,
    sessionId: string | null,
    items: readonly ExtractedExpression[],
  ): Promise<{ recorded: number; activated: number }>;
  /** Espressioni attive, le più usate prima (per il prompt). */
  listActive(userId: string, limit?: number): Promise<LexiconItem[]>;
  /** Attive e in osservazione, per la pagina «Parole che Ernie ha imparato da te». */
  list(userId: string): Promise<LexiconItem[]>;
  /** Cancellata dall'utente: non torna più, nemmeno se la ripete. */
  remove(userId: string, id: string): Promise<boolean>;
  /** Lessico di un figlio letto dal genitore che lo segue (policy user_lexicon_guardian_read). */
  listForGuardian(guardianId: string, childId: string): Promise<LexiconItem[]>;
}

type Row = {
  id: string;
  term: string;
  meaning: string;
  example: string;
  status: 'candidate' | 'active';
  seen_count: number;
  last_seen_at: Date;
};
const toItem = (r: Row): LexiconItem => ({
  id: r.id,
  term: r.term,
  meaning: r.meaning,
  example: r.example,
  status: r.status,
  seenCount: r.seen_count,
  lastSeenAt: r.last_seen_at,
});
const COLUMNS = 'id, term, meaning, example, status, seen_count, last_seen_at';

export function createLexiconStore(pool: Pool): LexiconStore {
  const enabled = async (c: PoolClient, userId: string): Promise<boolean> => {
    const r = await c.query<{ own: boolean; parent_off: boolean }>(
      `SELECT COALESCE((settings->>'learnLexicon')::boolean, true) AS own,
              EXISTS (SELECT 1 FROM guardianships g WHERE g.child_id = $1 AND g.lexicon_off) AS parent_off
         FROM users WHERE id = $1`,
      [userId],
    );
    const row = r.rows[0];
    return Boolean(row?.own && !row.parent_off);
  };
  return {
    async learningEnabled(userId) {
      return withUser(pool, userId, (c) => enabled(c, userId));
    },

    async learn(userId, sessionId, items) {
      const clean = cleanExpressions(items);
      if (!clean.length) return { recorded: 0, activated: 0 };
      return withUser(pool, userId, async (c) => {
        if (!(await enabled(c, userId))) return { recorded: 0, activated: 0 };
        let recorded = 0;
        let activated = 0;
        for (const it of clean) {
          const r = await c.query<{ status: string; was: string | null }>(
            `WITH prev AS (SELECT status FROM user_lexicon WHERE user_id = $1 AND term_key = $3)
             INSERT INTO user_lexicon (user_id, term, term_key, meaning, example, last_session_id)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (user_id, term_key) DO UPDATE SET
               seen_count = user_lexicon.seen_count + 1,
               sessions = user_lexicon.sessions
                 + CASE WHEN user_lexicon.last_session_id IS DISTINCT FROM EXCLUDED.last_session_id THEN 1 ELSE 0 END,
               last_session_id = EXCLUDED.last_session_id,
               meaning = CASE WHEN user_lexicon.meaning = '' THEN EXCLUDED.meaning ELSE user_lexicon.meaning END,
               example = CASE WHEN EXCLUDED.example = '' THEN user_lexicon.example ELSE EXCLUDED.example END,
               last_seen_at = now(),
               status = CASE
                 WHEN user_lexicon.seen_count + 1 >= ${LEXICON_MIN_SEEN}
                  AND user_lexicon.sessions
                      + CASE WHEN user_lexicon.last_session_id IS DISTINCT FROM EXCLUDED.last_session_id THEN 1 ELSE 0 END
                      >= ${LEXICON_MIN_SESSIONS}
                 THEN 'active' ELSE user_lexicon.status END
             WHERE user_lexicon.status <> 'removed'
             RETURNING status, (SELECT status FROM prev) AS was`,
            [
              userId,
              it.term,
              normalizeTerm(it.term),
              (it.meaning ?? '').trim().slice(0, 160),
              (it.example ?? '').trim().slice(0, 200),
              sessionId,
            ],
          );
          const row = r.rows[0];
          if (!row) continue; // cancellata dall'utente: non si impara di nuovo
          recorded++;
          if (row.status === 'active' && row.was !== 'active') activated++;
        }
        return { recorded, activated };
      });
    },

    async listActive(userId, limit = 20) {
      return withUser(pool, userId, async (c) => {
        const r = await c.query<Row>(
          `SELECT ${COLUMNS} FROM user_lexicon WHERE user_id = $1 AND status = 'active'
            ORDER BY seen_count DESC, last_seen_at DESC LIMIT $2`,
          [userId, limit],
        );
        return r.rows.map(toItem);
      });
    },

    async list(userId) {
      return withUser(pool, userId, async (c) => {
        const r = await c.query<Row>(
          `SELECT ${COLUMNS} FROM user_lexicon WHERE user_id = $1 AND status <> 'removed'
            ORDER BY status = 'active' DESC, seen_count DESC, last_seen_at DESC LIMIT 100`,
          [userId],
        );
        return r.rows.map(toItem);
      });
    },

    async remove(userId, id) {
      return withUser(pool, userId, async (c) => {
        const r = await c.query(
          `UPDATE user_lexicon SET status = 'removed' WHERE id = $1 AND user_id = $2 AND status <> 'removed'`,
          [id, userId],
        );
        return (r.rowCount ?? 0) > 0;
      });
    },

    async listForGuardian(guardianId, childId) {
      return withUser(pool, guardianId, async (c) => {
        const r = await c.query<Row>(
          `SELECT ${COLUMNS} FROM user_lexicon WHERE user_id = $1 AND status <> 'removed'
            ORDER BY status = 'active' DESC, seen_count DESC, last_seen_at DESC LIMIT 100`,
          [childId],
        );
        return r.rows.map(toItem);
      });
    },
  };
}
