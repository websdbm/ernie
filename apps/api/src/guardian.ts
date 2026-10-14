import { type Pool, withUser } from '@ernie/db';
import { SKILL_CATALOG } from '@ernie/skills';

/**
 * Controllo genitori (richiesta dell'utente, 14 ott 2026; migrazione 0030). Il genitore sceglie le skill che il
 * figlio può usare e può leggere le sue conversazioni; il figlio vede che l'account è seguito e quando il genitore
 * ha consultato le conversazioni. La supervisione nasce da un invito «con controllo genitori» accettato dal figlio
 * e la toglie solo il genitore.
 */

/** Capacità fuori catalogo che il genitore può concedere: la ricerca sul web (tool di uso generale). */
export const GUARDIAN_EXTRAS = [
  {
    id: 'web',
    title: 'Ricerca sul web',
    summary: 'Cerca su internet e legge le pagine.',
    tools: ['web_search', 'web_fetch'],
  },
] as const;

export const DEFAULT_CHILD_SKILLS = ['ricordami', 'shopping_list', 'documenti'] as const;

const KNOWN = new Set<string>([
  ...SKILL_CATALOG.map((s) => s.id),
  ...GUARDIAN_EXTRAS.map((e) => e.id),
]);

/** Solo id noti, senza doppioni. */
export function cleanAllowed(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => KNOWN.has(id)))];
}

/**
 * Impostazioni effettive di un figlio seguito: le skill non concesse diventano non disponibili (non le può
 * riaccendere) e i tool delle capacità extra non concesse finiscono in `guardianBlockedTools`. Mai salvate:
 * si calcolano a ogni lettura, così la scelta del genitore vale subito.
 */
export function guardianSettings(
  settings: Readonly<Record<string, unknown>>,
  allowed: readonly string[] | null,
): Record<string, unknown> {
  if (!allowed) return { ...settings };
  const ok = new Set(allowed);
  const available = { ...((settings.skillsAvailable ?? {}) as Record<string, unknown>) };
  for (const s of SKILL_CATALOG) if (!ok.has(s.id)) available[s.id] = false;
  const blocked = GUARDIAN_EXTRAS.filter((e) => !ok.has(e.id)).flatMap((e) => [...e.tools]);
  return {
    ...settings,
    skillsAvailable: available,
    guardianAllowed: [...ok],
    ...(blocked.length ? { guardianBlockedTools: blocked } : {}),
  };
}

export interface ChildSummary {
  readonly childId: string;
  readonly label: string;
  readonly allowed: string[];
  readonly since: Date;
  readonly lastReviewAt: Date | null;
}

export interface Supervision {
  readonly guardians: Array<{
    guardianId: string;
    label: string;
    since: Date;
    lastReviewAt: Date | null;
  }>;
  readonly allowed: string[];
}

export interface TranscriptMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly at: string;
  readonly voice: boolean;
  readonly tools: string[];
}

export interface GuardianStore {
  /** Figli seguiti da `guardianId`, con l'etichetta con cui il genitore li chiama. */
  children(guardianId: string): Promise<ChildSummary[]>;
  isGuardian(guardianId: string, childId: string): Promise<boolean>;
  /** Skill concesse a un figlio (intersezione se più genitori); null se l'account non è seguito. */
  limitsFor(childId: string): Promise<string[] | null>;
  setAllowed(
    guardianId: string,
    childId: string,
    allowed: readonly string[],
  ): Promise<string[] | null>;
  release(guardianId: string, childId: string): Promise<boolean>;
  recordReview(guardianId: string, childId: string, sessionId: string | null): Promise<void>;
  /** Vista del figlio: chi lo segue (con l'etichetta che il figlio usa) e l'ultima consultazione. */
  supervision(childId: string): Promise<Supervision | null>;
}

export function createGuardianStore(pool: Pool): GuardianStore {
  return {
    async children(guardianId) {
      return withUser(pool, guardianId, async (c) => {
        const r = await c.query<{
          child_id: string;
          label: string | null;
          allowed_skills: string[];
          created_at: Date;
          last_review: Date | null;
        }>(
          `SELECT g.child_id, l.label, g.allowed_skills, g.created_at,
                  (SELECT max(at) FROM guardian_reviews v WHERE v.guardian_id = g.guardian_id AND v.child_id = g.child_id) AS last_review
             FROM guardianships g
             LEFT JOIN family_links l ON l.user_id = g.guardian_id AND l.other_user_id = g.child_id
            WHERE g.guardian_id = $1 ORDER BY g.created_at`,
          [guardianId],
        );
        return r.rows.map((x) => ({
          childId: x.child_id,
          label: x.label ?? 'Figlio',
          allowed: x.allowed_skills,
          since: x.created_at,
          lastReviewAt: x.last_review,
        }));
      });
    },
    async isGuardian(guardianId, childId) {
      return withUser(pool, guardianId, async (c) => {
        const r = await c.query(
          `SELECT 1 FROM guardianships WHERE guardian_id = $1 AND child_id = $2`,
          [guardianId, childId],
        );
        return (r.rowCount ?? 0) > 0;
      });
    },
    async limitsFor(childId) {
      return withUser(pool, childId, async (c) => {
        const r = await c.query<{ allowed_skills: string[] }>(
          `SELECT allowed_skills FROM guardianships WHERE child_id = $1`,
          [childId],
        );
        if (!r.rows.length) return null;
        const [first, ...rest] = r.rows.map((x) => x.allowed_skills);
        return (first ?? []).filter((id) => rest.every((list) => list.includes(id)));
      });
    },
    async setAllowed(guardianId, childId, allowed) {
      const clean = cleanAllowed(allowed);
      return withUser(pool, guardianId, async (c) => {
        const r = await c.query<{ allowed_skills: string[] }>(
          `UPDATE guardianships SET allowed_skills = $3 WHERE guardian_id = $1 AND child_id = $2 RETURNING allowed_skills`,
          [guardianId, childId, clean],
        );
        return r.rows[0]?.allowed_skills ?? null;
      });
    },
    async release(guardianId, childId) {
      return withUser(pool, guardianId, async (c) => {
        const r = await c.query(
          `DELETE FROM guardianships WHERE guardian_id = $1 AND child_id = $2`,
          [guardianId, childId],
        );
        return (r.rowCount ?? 0) > 0;
      });
    },
    async recordReview(guardianId, childId, sessionId) {
      await withUser(pool, guardianId, (c) =>
        c.query(
          `INSERT INTO guardian_reviews (guardian_id, child_id, session_id) VALUES ($1, $2, $3)`,
          [guardianId, childId, sessionId],
        ),
      );
    },
    async supervision(childId) {
      return withUser(pool, childId, async (c) => {
        const r = await c.query<{
          guardian_id: string;
          label: string | null;
          allowed_skills: string[];
          created_at: Date;
          last_review: Date | null;
        }>(
          `SELECT g.guardian_id, l.label, g.allowed_skills, g.created_at,
                  (SELECT max(at) FROM guardian_reviews v WHERE v.guardian_id = g.guardian_id AND v.child_id = g.child_id) AS last_review
             FROM guardianships g
             LEFT JOIN family_links l ON l.user_id = g.child_id AND l.other_user_id = g.guardian_id
            WHERE g.child_id = $1 ORDER BY g.created_at`,
          [childId],
        );
        if (!r.rows.length) return null;
        const [first, ...rest] = r.rows.map((x) => x.allowed_skills);
        return {
          guardians: r.rows.map((x) => ({
            guardianId: x.guardian_id,
            label: x.label ?? 'Genitore',
            since: x.created_at,
            lastReviewAt: x.last_review,
          })),
          allowed: (first ?? []).filter((id) => rest.every((list) => list.includes(id))),
        };
      });
    },
  };
}

/**
 * Messaggio salvato da Mastra → riga del registro per il genitore: testo dell'utente (senza il segno «[voce]»),
 * testo della risposta e strumenti usati. A differenza della memoria, qui si tiene tutto.
 */
export function toTranscriptMessage(m: unknown): TranscriptMessage | null {
  if (!m || typeof m !== 'object') return null;
  const r = m as Record<string, unknown>;
  const role = r.role === 'user' || r.role === 'assistant' ? r.role : null;
  if (!role) return null;
  const at = r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt ?? '');
  const c = r.content;
  const texts: string[] = [];
  const tools: string[] = [];
  if (typeof c === 'string') texts.push(c);
  else if (c && typeof c === 'object') {
    const cc = c as Record<string, unknown>;
    const parts = Array.isArray(cc.parts) ? cc.parts : [];
    for (const p of parts) {
      if (!p || typeof p !== 'object') continue;
      const part = p as Record<string, unknown>;
      if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text);
      const inv = part.toolInvocation as { toolName?: unknown } | undefined;
      if (part.type === 'tool-invocation' && typeof inv?.toolName === 'string')
        tools.push(inv.toolName);
      else if (
        typeof part.type === 'string' &&
        part.type.startsWith('tool-') &&
        part.type !== 'tool-invocation'
      )
        tools.push(part.type.slice(5));
    }
    if (!texts.length && typeof cc.content === 'string') texts.push(cc.content);
  }
  let text = texts.join('\n').trim();
  const voice = role === 'user' && text.startsWith('[voce] ');
  if (voice) text = text.slice(7);
  if (!text && !tools.length) return null;
  return { role, text, at, voice, tools: [...new Set(tools)] };
}
