import { type Pool, withUser } from '@ernie/db';
import { isSystemNote } from '@ernie/memory';
import { SKILL_CATALOG } from '@ernie/skills';
import type { Relation, Supervisable } from './family.js';

/**
 * Controllo genitori (richiesta dell'utente, 14 ott 2026; migrazione 0030). Il genitore sceglie le skill che il
 * figlio può usare e può leggere le sue conversazioni; il figlio vede che l'account è seguito e quando il genitore
 * ha consultato le conversazioni. La supervisione nasce da un invito «con controllo genitori» accettato dal figlio
 * e la toglie solo il genitore. Dalla 0032 si possono seguire anche nonno e nonna, con le stesse regole, e le skill
 * si scelgono persona per persona già nell'invito.
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

/**
 * Skill proposte nell'invito, per parentela: punto di partenza che chi invita cambia persona per persona. Per ora
 * uguali (richiesta dell'utente: i nonni come il figlio), separate perché potranno divergere.
 */
export const DEFAULT_SKILLS: Readonly<Record<Supervisable, readonly string[]>> = {
  figlio: ['ricordami', 'shopping_list', 'documenti', 'messaggi', 'portami'],
  nonno: ['ricordami', 'shopping_list', 'documenti', 'messaggi', 'portami'],
  nonna: ['ricordami', 'shopping_list', 'documenti', 'messaggi', 'portami'],
};

const KNOWN = new Set<string>([
  ...SKILL_CATALOG.map((s) => s.id),
  ...GUARDIAN_EXTRAS.map((e) => e.id),
]);

/** Solo id noti, senza doppioni. */
export function cleanAllowed(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => KNOWN.has(id)))];
}

/** Catalogo per chi segue: skill del catalogo più la ricerca sul web, con lo stato concesso/negato. */
export function guardianCatalog(allowed: readonly string[]) {
  return [
    ...SKILL_CATALOG.map((s) => ({
      id: s.id,
      title: s.title,
      icon: s.icon,
      summary: s.summary,
      allowed: allowed.includes(s.id),
    })),
    ...GUARDIAN_EXTRAS.map((e) => ({
      id: e.id,
      title: e.title,
      icon: 'globe',
      summary: e.summary,
      allowed: allowed.includes(e.id),
    })),
  ];
}

/**
 * Impostazioni effettive di un figlio seguito: le skill non concesse diventano non disponibili (non le può
 * riaccendere) e i tool delle capacità extra non concesse finiscono in `guardianBlockedTools`. Mai salvate:
 * si calcolano a ogni lettura, così la scelta del genitore vale subito.
 */
export function guardianSettings(
  settings: Readonly<Record<string, unknown>>,
  allowed: readonly string[] | null,
  relation: Supervisable = 'figlio',
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
    guardianRelation: relation,
    ...(blocked.length ? { guardianBlockedTools: blocked } : {}),
  };
}

export interface ChildSummary {
  readonly childId: string;
  readonly label: string;
  /** Cosa è per chi lo segue (figlio, nonno, nonna); null se il collegamento manca. */
  readonly relation: Relation | null;
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
  /** Come `limitsFor`, più cosa è la persona per chi la segue (figlio, nonno, nonna). */
  supervisedAs(childId: string): Promise<{ allowed: string[]; relation: Supervisable } | null>;
  setAllowed(
    guardianId: string,
    childId: string,
    allowed: readonly string[],
  ): Promise<string[] | null>;
  release(guardianId: string, childId: string): Promise<boolean>;
  recordReview(guardianId: string, childId: string, sessionId: string | null): Promise<void>;
  /** Vista del figlio: chi lo segue (con l'etichetta che il figlio usa) e l'ultima consultazione. */
  supervision(childId: string): Promise<Supervision | null>;
  /** Stile scelto dal figlio e stato dell'apprendimento delle parole, per la pagina del genitore. */
  childStyle(
    guardianId: string,
    childId: string,
  ): Promise<{ style: string; learn: boolean; lexiconOff: boolean } | null>;
  /** Il genitore spegne (o riaccende) l'apprendimento delle parole del figlio. */
  setLexiconOff(guardianId: string, childId: string, off: boolean): Promise<boolean>;
}

export function createGuardianStore(pool: Pool): GuardianStore {
  const supervisedAs = async (childId: string) =>
    withUser(pool, childId, async (c) => {
      const r = await c.query<{ allowed_skills: string[]; relation: Supervisable }>(
        `SELECT allowed_skills, relation FROM guardianships WHERE child_id = $1 ORDER BY created_at`,
        [childId],
      );
      const head = r.rows[0];
      if (!head) return null;
      const rest = r.rows.slice(1).map((x) => x.allowed_skills);
      return {
        allowed: head.allowed_skills.filter((id) => rest.every((list) => list.includes(id))),
        relation: head.relation,
      };
    });
  return {
    async children(guardianId) {
      return withUser(pool, guardianId, async (c) => {
        const r = await c.query<{
          child_id: string;
          label: string | null;
          relation: Relation | null;
          allowed_skills: string[];
          created_at: Date;
          last_review: Date | null;
        }>(
          `SELECT g.child_id, l.label, g.relation, g.allowed_skills, g.created_at,
                  (SELECT max(at) FROM guardian_reviews v WHERE v.guardian_id = g.guardian_id AND v.child_id = g.child_id) AS last_review
             FROM guardianships g
             LEFT JOIN family_links l ON l.user_id = g.guardian_id AND l.other_user_id = g.child_id
            WHERE g.guardian_id = $1 ORDER BY g.created_at`,
          [guardianId],
        );
        return r.rows.map((x) => ({
          childId: x.child_id,
          label: x.label ?? 'Figlio',
          relation: x.relation,
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
      return (await supervisedAs(childId))?.allowed ?? null;
    },
    supervisedAs,
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
    async childStyle(guardianId, childId) {
      return withUser(pool, guardianId, async (c) => {
        const r = await c.query<{ o_style: string; o_learn: boolean }>(
          `SELECT o_style, o_learn FROM guardian_child_style($1)`,
          [childId],
        );
        const g = await c.query<{ lexicon_off: boolean }>(
          `SELECT lexicon_off FROM guardianships WHERE guardian_id = $1 AND child_id = $2`,
          [guardianId, childId],
        );
        const row = r.rows[0];
        const link = g.rows[0];
        if (!row || !link) return null;
        return { style: row.o_style, learn: row.o_learn, lexiconOff: link.lexicon_off };
      });
    },
    async setLexiconOff(guardianId, childId, off) {
      return withUser(pool, guardianId, async (c) => {
        const r = await c.query(
          `UPDATE guardianships SET lexicon_off = $3 WHERE guardian_id = $1 AND child_id = $2`,
          [guardianId, childId, off],
        );
        return (r.rowCount ?? 0) > 0;
      });
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
      if (part.type === 'text' && typeof part.text === 'string' && !isSystemNote(part.text))
        texts.push(part.text);
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
