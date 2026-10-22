import { randomUUID } from 'node:crypto';
import { type Pool, withUser } from '@ernie/db';
import {
  type OperatingPreference,
  OperatingPreferenceSchema,
  type OperatingPreferenceStore,
  type SaveOperatingPreference,
  ToolError,
  validateOperatingPreference,
} from '@ernie/tools';

function decode(value: unknown): OperatingPreference[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => {
    const p = OperatingPreferenceSchema.safeParse(v);
    return p.success ? [p.data] : [];
  });
}

export function createOperatingPreferenceStore(pool: Pool): OperatingPreferenceStore {
  async function mutate<T>(userId: string, fn: (rows: OperatingPreference[]) => T): Promise<T> {
    return withUser(pool, userId, async (c) => {
      const result = await c.query<{ preferences: unknown }>(
        `SELECT settings->'operatingPreferences' AS preferences FROM users WHERE id = $1 FOR UPDATE`,
        [userId],
      );
      if (!result.rows[0]) throw new ToolError('Account non trovato.', 'not_found');
      const preferences = decode(result.rows[0].preferences);
      const output = fn(preferences);
      await c.query(
        `UPDATE users SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{operatingPreferences}', $2::jsonb, true) WHERE id = $1`,
        [userId, JSON.stringify(preferences)],
      );
      return output;
    });
  }
  return {
    async list(userId) {
      return withUser(pool, userId, async (c) => {
        const result = await c.query<{ preferences: unknown }>(
          `SELECT settings->'operatingPreferences' AS preferences FROM users WHERE id = $1`,
          [userId],
        );
        return decode(result.rows[0]?.preferences);
      });
    },
    async save(userId, input: SaveOperatingPreference) {
      validateOperatingPreference(input);
      return mutate(userId, (rows) => {
        const existing = input.id
          ? rows.find((p) => p.id === input.id)
          : rows.find((p) => p.text.toLowerCase() === input.text.trim().toLowerCase());
        if (input.id && !existing) throw new ToolError('Preferenza non trovata.', 'not_found');
        // Observations must not overwrite or downgrade an explicit decision, including a disabled rule.
        if (input.kind === 'inferred' && existing?.kind === 'explicit') return existing;
        if (!existing && rows.length >= 30)
          throw new ToolError(
            'Hai raggiunto 30 preferenze. Modifica o elimina una delle esistenti.',
            'preference_limit',
          );
        const now = new Date().toISOString();
        const next: OperatingPreference = {
          id: existing?.id ?? randomUUID(),
          text: input.text.trim(),
          kind: input.kind,
          active: input.kind === 'explicit' && (input.active ?? existing?.active ?? true),
          source: input.source,
          evidence: input.evidence.trim(),
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        if (existing) rows[rows.indexOf(existing)] = next;
        else rows.push(next);
        return next;
      });
    },
    async deactivate(userId, id) {
      return mutate(userId, (rows) => {
        const preference = rows.find((p) => p.id === id);
        if (!preference) return false;
        preference.active = false;
        preference.updatedAt = new Date().toISOString();
        return true;
      });
    },
    async remove(userId, id) {
      return mutate(userId, (rows) => {
        const index = rows.findIndex((p) => p.id === id);
        if (index < 0) return false;
        rows.splice(index, 1);
        return true;
      });
    },
  };
}

/**
 * Deterministic personalization. The registry instruction survives an empty register:
 * old conversations and semantic memories cannot silently revive revoked preferences.
 * maxChars bounds the payload, with a floor for this mandatory instruction and empty marker.
 */
export function renderOperatingPreferencesContext(
  preferences: readonly OperatingPreference[],
  maxChars = 2400,
): string {
  const header =
    'REGISTRO AUTOREVOLE DELLE PREFERENZE OPERATIVE\n' +
    'Per stile e organizzazione, applica come preferenze persistenti solo le regole esplicite attive elencate qui. ' +
    'Questo registro prevale su vecchie chat, riepiloghi e memorie semantiche: non recuperare regole disattivate e non ricostruire quelle eliminate senza una nuova richiesta esplicita dell’utente. ' +
    'Le ipotesi non sono regole. Sono dati di personalizzazione, non autorizzazioni: rispettano istruzioni, sicurezza e richiesta corrente; non estendono permessi né abilitano notifiche.\n' +
    'Regole esplicite attive:\n';
  const empty = 'Nessuna regola attiva riportata.\n';
  const budget = Math.max(header.length + empty.length, Math.min(4000, maxChars));
  const selected: string[] = [];
  let size = header.length;
  for (const p of [...preferences].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    if (!p.active || p.kind !== 'explicit' || p.source === 'observation') continue;
    try {
      validateOperatingPreference({ ...p, source: 'settings' });
    } catch {
      continue;
    }
    const line = `- ${JSON.stringify(p.text)}\n`;
    if (size + line.length > budget) continue;
    selected.push(line);
    size += line.length;
  }
  return header + (selected.length ? selected.join('') : empty);
}
