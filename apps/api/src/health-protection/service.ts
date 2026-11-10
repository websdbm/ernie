import type { HealthAnswerer, HealthExtractor } from '@ernie/agent-core';
import { canonicalParameter, type HealthValue, isoDay, toHealthValue, trendOf } from '@ernie/brain';
import { type Pool, type PoolClient, withUser } from '@ernie/db';
import { enabledSkillIds } from '@ernie/skills';
import type { HealthToolRow } from '@ernie/tools';
import { z } from 'zod';
import type { Supervisable } from '../family.js';
import { guardianSettings } from '../guardian.js';
import { dedupeValues } from '../health.js';
import {
  createHealthConsentStore,
  HEALTH_AI_CONSENT_TEXT,
  HEALTH_AI_POLICY_VERSION,
} from './consent.js';
import type { HealthCipher } from './crypto.js';
import {
  createEncryptedHealthSourceStore,
  HealthSourceInput,
  lockHealthSource,
} from './sources.js';
import { createEncryptedHealthStore } from './store.js';

export class HealthVaultError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const missing = () => new HealthVaultError(404, 'not_found', 'Elemento Salute non trovato.');
const unavailable = () =>
  new HealthVaultError(
    503,
    'health_unavailable',
    'Archivio Salute temporaneamente non disponibile.',
  );
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
const Identifier = z.uuid().transform((id) => id.toLowerCase());
export const HealthAskInput = z
  .object({
    question: z.string().trim().min(1).max(4_000),
    reportIds: z.array(Identifier).max(10).optional(),
    sourceIds: z.array(Identifier).max(5).optional(),
  })
  .strict();
export const HealthExportInput = z
  .object({ sourceId: Identifier.optional(), reportId: Identifier.optional() })
  .strict()
  .refine((v) => Boolean(v.sourceId) !== Boolean(v.reportId));

/** Same transaction/connection as the consent guard. Guardian changes cannot race a result write. */
export async function healthSkillEnabled(userId: string, client: PoolClient): Promise<boolean> {
  const user = await client.query<{ settings: Record<string, unknown> }>(
    'SELECT settings FROM users WHERE id=$1',
    [userId],
  );
  const guardians = await client.query<{ allowed_skills: string[]; relation: Supervisable }>(
    'SELECT allowed_skills,relation FROM guardianships WHERE child_id=$1 ORDER BY created_at FOR SHARE',
    [userId],
  );
  const first = guardians.rows[0];
  const allowed = first
    ? first.allowed_skills.filter((skill) =>
        guardians.rows.every((g) => g.allowed_skills.includes(skill)),
      )
    : null;
  const settings = guardianSettings(user.rows[0]?.settings ?? {}, allowed, first?.relation);
  return settings.killSwitch !== true && enabledSkillIds(settings).has('salute');
}

export interface HealthVaultOptions {
  pool: Pool;
  cipher: HealthCipher | null;
  extractor: HealthExtractor | null;
  answerer: HealthAnswerer | null;
  checkBudget(userId: string): Promise<unknown>;
}

export function createHealthVaultService(opts: HealthVaultOptions) {
  const consent = createHealthConsentStore(opts.pool, healthSkillEnabled);
  const store = opts.cipher ? createEncryptedHealthStore(opts.pool, opts.cipher) : null;
  const sources = opts.cipher ? createEncryptedHealthSourceStore(opts.pool, opts.cipher) : null;
  const running = new Set<string>();
  const requireVault = () => {
    if (!store || !sources || !opts.cipher) throw unavailable();
    return { store, sources, cipher: opts.cipher };
  };

  const migrationState = async (userId: string): Promise<'ready' | 'pending'> =>
    withUser(opts.pool, userId, async (c) => {
      const rows = await c.query<{ remaining: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM health_reports r WHERE NOT (r.kind='[protected]' AND r.taken_on IS NULL AND r.lab IS NULL AND r.document_id IS NULL AND r.note_path IS NULL AND EXISTS (SELECT 1 FROM health_secure_reports s WHERE s.user_id=r.user_id AND s.id=r.id)))
        OR EXISTS(SELECT 1 FROM health_values)
        OR EXISTS(SELECT 1 FROM health_notices)
        OR EXISTS(SELECT 1 FROM brain_notes WHERE note_type='salute' OR path LIKE 'Salute/%' OR path='Salute.md') AS remaining`,
      );
      return rows.rows[0]?.remaining ? 'pending' : 'ready';
    });
  const ready = async (userId: string) => {
    const vault = requireVault();
    if ((await migrationState(userId)) !== 'ready')
      throw new HealthVaultError(
        409,
        'health_migration_pending',
        'Il tuo archivio Salute deve completare la migrazione protetta. I dati esistenti sono conservati.',
      );
    return vault;
  };
  const report = async (userId: string, id: string) => {
    const { store } = await ready(userId);
    const current = await store.report(userId, Identifier.parse(id));
    if (!current) throw missing();
    const previous = current.takenOn
      ? (await store.reports(userId, 2_000)).find(
          (r) => r.takenOn && r.takenOn < (current.takenOn as string),
        )
      : undefined;
    const prevValues = previous ? await store.reportValues(userId, previous.id) : [];
    const prev = new Map(prevValues.map((v) => [`${v.parameter}|${v.unit ?? ''}`, v]));
    const rows: HealthToolRow[] = (await store.reportValues(userId, id)).map((v) => {
      const p = prev.get(`${v.parameter}|${v.unit ?? ''}`);
      const comparison =
        p?.value !== null && p?.value !== undefined && v.value !== null && previous?.takenOn
          ? {
              previous: { value: p.value, date: previous.takenOn },
              trend:
                Math.abs(v.value - p.value) <= Math.abs(p.value) * 0.03
                  ? ('stabile' as const)
                  : v.value > p.value
                    ? ('su' as const)
                    : ('giu' as const),
            }
          : {};
      return {
        label: v.label,
        value: v.value,
        valueText: v.valueText,
        unit: v.unit,
        refLow: v.refLow,
        refHigh: v.refHigh,
        refText: v.refText,
        flag: v.flag,
        ...comparison,
      };
    });
    return {
      id: current.id,
      takenOn: current.takenOn,
      lab: current.lab,
      kind: current.kind,
      againstDate: previous?.takenOn ?? null,
      rows,
    };
  };
  const busy = async <T>(userId: string, work: () => Promise<T>) => {
    if (running.has(userId) || running.size >= 16)
      throw new HealthVaultError(
        429,
        'health_busy',
        'Un’elaborazione Salute è già in corso. Attendi oppure revoca il consenso per interromperla.',
      );
    running.add(userId);
    try {
      return await work();
    } finally {
      running.delete(userId);
    }
  };
  const sourceReportId = (userId: string, id: string) =>
    withUser(
      opts.pool,
      userId,
      async (c) =>
        (
          await c.query<{ id: string }>(
            'SELECT id FROM health_secure_reports WHERE source_document_id=$1',
            [id],
          )
        ).rows[0]?.id ?? null,
    );

  return {
    consent,
    async capabilities(userId: string) {
      const skillEnabled = await withUser(opts.pool, userId, (c) => healthSkillEnabled(userId, c));
      return {
        available: Boolean(store && sources),
        encryptionReady: Boolean(opts.cipher),
        skillEnabled,
        policyVersion: HEALTH_AI_POLICY_VERSION,
        policyText: HEALTH_AI_CONSENT_TEXT,
        consent: await consent.get(userId),
        migration: { state: await migrationState(userId) },
      };
    },
    async sources(userId: string) {
      return (await ready(userId)).sources.list(userId, 2_000);
    },
    async source(userId: string, id: string) {
      const s = await (await ready(userId)).sources.get(userId, Identifier.parse(id));
      if (!s) throw missing();
      return s;
    },
    async attachment(userId: string, id: string, attachmentId: string) {
      const value = await (await ready(userId)).sources.attachment(
        userId,
        Identifier.parse(id),
        Identifier.parse(attachmentId),
      );
      if (!value) throw missing();
      return value;
    },
    async upload(userId: string, input: unknown) {
      return (await ready(userId)).sources.save(userId, HealthSourceInput.parse(input));
    },
    async remove(userId: string, id: string) {
      if (!(await (await ready(userId)).sources.remove(userId, Identifier.parse(id))))
        throw missing();
    },
    async reports(userId: string) {
      return (await ready(userId)).store.reports(userId, 2_000);
    },
    report,
    async parameter(userId: string, name: string) {
      const { store } = await ready(userId);
      const known = await store.parameters(userId);
      const canon = canonicalParameter(name).key;
      const hit = known.find((p) => p.parameter === canon || fold(p.label) === fold(name));
      if (!hit) return null;
      const points = await store.series(userId, hit.parameter);
      return {
        label: hit.label,
        rows: points.map(
          (p): HealthToolRow => ({
            label: hit.label,
            date: p.date,
            value: p.value,
            valueText: p.valueText,
            unit: p.unit,
            refLow: p.refLow,
            refHigh: p.refHigh,
            refText: null,
            flag: p.flag,
          }),
        ),
        trend: trendOf(points),
      };
    },
    async analyze(userId: string, sourceId: string, signal?: AbortSignal) {
      const { sources, store, cipher } = await ready(userId);
      const id = Identifier.parse(sourceId);
      // Repeating a completed request never repeats the model call, even if the previous response was lost.
      const existing = await sourceReportId(userId, id);
      if (existing) {
        const r = await store.report(userId, existing);
        if (r) return { reportId: r.id, values: r.values, outOfRange: r.outOfRange };
      }
      return busy(userId, async () => {
        const ticket = await consent.acquire(userId);
        return consent.run(ticket, async (revoked) => {
          const combined = AbortSignal.any([revoked, signal ?? new AbortController().signal]);
          const source = await sources.get(userId, id);
          if (!source) throw missing();
          const text = source.pages.join('\n\n');
          if (text.length > 40_000)
            throw new HealthVaultError(
              422,
              'health_analysis_too_large',
              'Il documento è conservato per intero. Per analizzarlo, importa una sezione di massimo 40.000 caratteri.',
            );
          if (!opts.extractor) throw unavailable();
          await opts.checkBudget(userId);
          await consent.check(ticket);
          combined.throwIfAborted();
          const extraction = await opts.extractor(text, {
            userId,
            documentTitle: source.title,
            signal: combined,
          });
          await consent.check(ticket);
          combined.throwIfAborted();
          if (!extraction?.isLabReport)
            throw new HealthVaultError(
              422,
              'health_no_values',
              'Non ho trovato valori di laboratorio da strutturare. Il documento è conservato: puoi consultarlo o fare una domanda nella sezione Salute.',
            );
          const values = dedupeValues(
            extraction.items.map(toHealthValue).filter((v): v is HealthValue => v !== null),
          );
          if (!values.length)
            throw new HealthVaultError(
              422,
              'health_no_values',
              'Nessun valore interpretabile trovato; il documento originale è conservato.',
            );
          const writer = createEncryptedHealthStore(opts.pool, cipher, {
            guardWrite: async (uid, c) => {
              await consent.guardWrite(ticket, uid, c);
              combined.throwIfAborted();
              await lockHealthSource(c, uid, id);
              await consent.guardWrite(ticket, uid, c);
              combined.throwIfAborted();
            },
          });
          const reportId = await writer.saveReport(
            userId,
            {
              documentId: id,
              takenOn: isoDay(extraction.takenOn) ?? null,
              lab: extraction.lab?.trim().slice(0, 120) || null,
              kind: extraction.kind?.trim().slice(0, 60) || 'Referto',
            },
            values,
          );
          const saved = reportId ?? (await sourceReportId(userId, id));
          if (!saved) throw unavailable();
          return {
            reportId: saved,
            values: values.length,
            outOfRange: values.filter((v) => v.flag === 'alto' || v.flag === 'basso').length,
          };
        });
      });
    },
    async export(userId: string, input: unknown) {
      const body = HealthExportInput.parse(input);
      const { sources } = await ready(userId);
      let payload: unknown;
      if (body.reportId)
        payload = {
          version: 1,
          exportedAt: new Date().toISOString(),
          report: await report(userId, body.reportId),
        };
      else {
        const source = await sources.get(userId, body.sourceId as string);
        if (!source) throw missing();
        const attachments = [];
        for (const a of source.attachments)
          attachments.push(await sources.attachment(userId, source.id, a.id));
        payload = {
          version: 1,
          exportedAt: new Date().toISOString(),
          source: { ...source, attachments },
        };
      }
      return {
        filename: 'salute-ernie.json',
        mimeType: 'application/json',
        dataBase64: Buffer.from(JSON.stringify(payload, null, 2)).toString('base64'),
      };
    },
    async ask(userId: string, input: unknown, signal?: AbortSignal) {
      const body = HealthAskInput.parse(input);
      const { sources, store } = await ready(userId);
      return busy(userId, async () => {
        const ticket = await consent.acquire(userId);
        return consent.run(ticket, async (revoked) => {
          if (!opts.answerer) throw unavailable();
          const combined = AbortSignal.any([revoked, signal ?? new AbortController().signal]);
          const selected =
            body.reportIds ??
            (body.sourceIds?.length ? [] : (await store.reports(userId, 10)).map((r) => r.id));
          const selectedSources =
            body.sourceIds ??
            (selected.length ? [] : (await sources.list(userId, 3)).map((s) => s.id));
          if (!selected.length && !selectedSources.length)
            throw new HealthVaultError(
              422,
              'health_empty',
              'Carica un documento in Salute prima di fare una domanda sui tuoi referti.',
            );
          const context: unknown[] = [];
          const refs: { id: string; title: string }[] = [];
          for (const id of [...new Set(selected)]) {
            const r = await report(userId, id);
            context.push(r);
            refs.push({ id, title: `${r.kind}${r.takenOn ? ` · ${r.takenOn}` : ''}` });
          }
          for (const id of [...new Set(selectedSources)]) {
            const source = await sources.get(userId, id);
            if (!source) throw missing();
            context.push({ id, title: source.title, pages: source.pages });
            refs.push({ id, title: source.title });
          }
          const text = JSON.stringify(context);
          if (text.length > 60_000)
            throw new HealthVaultError(
              422,
              'health_context_too_large',
              'Seleziona meno referti per analizzarli senza tagliare informazioni.',
            );
          await opts.checkBudget(userId);
          await consent.check(ticket);
          combined.throwIfAborted();
          const result = await opts.answerer({
            userId,
            question: body.question,
            context: text,
            signal: combined,
          });
          await consent.check(ticket);
          combined.throwIfAborted();
          for (const id of selected) if (!(await store.report(userId, id))) throw missing();
          for (const id of selectedSources) if (!(await sources.get(userId, id))) throw missing();
          return { ...result, sources: refs };
        });
      });
    },
  };
}
export type HealthVaultService = ReturnType<typeof createHealthVaultService>;
