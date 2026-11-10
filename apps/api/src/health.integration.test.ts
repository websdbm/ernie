import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HealthExtraction } from '@ernie/agent-core';
import { createBrainIndex, createBrainService } from '@ernie/brain';
import { createPool, type Pool } from '@ernie/db';
import { createDocumentRepository } from '@ernie/documents';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHealthRuntime } from './health.js';

const OWNER_URL = process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_PASSWORD = process.env.APP_DB_PASSWORD;
const localTestDatabase = (() => {
  if (!OWNER_URL) return false;
  try {
    const url = new URL(OWNER_URL);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && /test/i.test(url.pathname);
  } catch {
    return false;
  }
})();
const ready = Boolean(localTestDatabase && APP_PASSWORD);

const silent = { info: () => {}, warn: () => {} };

const referto = (glicemia: string, got: string) => `LABORATORIO ANALISI CLINICHE
Esami ematochimici   Valori di riferimento
Glicemia ${glicemia} mg/dL 70-110
Colesterolo totale 190 mg/dL < 200
HDL 55 mg/dL > 40
Trigliceridi 120 mg/dL < 150
GOT ${got} U/L < 35
GPT 30 U/L < 45`;

describe.skipIf(!ready)('sezione salute (Postgres + vault, estrattore finto)', () => {
  let owner: Pool;
  let app: Pool;
  let dir: string;
  const user = randomUUID();
  const other = randomUUID();
  beforeAll(async () => {
    owner = createPool({ connectionString: OWNER_URL as string, max: 2 });
    const u = new URL(OWNER_URL as string);
    u.username = 'ernie_app';
    u.password = APP_PASSWORD as string;
    app = createPool({ connectionString: u.toString(), max: 4 });
    await owner.query(`INSERT INTO users (id, display_name) VALUES ($1, 'S'), ($2, 'T')`, [
      user,
      other,
    ]);
    dir = await mkdtemp(join(tmpdir(), 'ernie-health-'));
  });
  afterAll(async () => {
    await owner.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[user, other]]);
    await owner.end();
    await app.end();
    await rm(dir, { recursive: true, force: true });
  });

  it('due referti → valori, confronto, storico, avvisi una volta, note riservate nel vault; nessun accesso altrui', async () => {
    const extractions: Record<string, HealthExtraction> = {
      '2026-03-02': {
        isLabReport: true,
        takenOn: '2026-03-02',
        lab: 'Lab Rossi',
        kind: 'analisi del sangue',
        items: [
          { name: 'Glicemia', value: '98', unit: 'mg/dL', ref: '70-110' },
          { name: 'GOT', value: '22', unit: 'U/L', ref: '< 35' },
          { name: 'GPT', value: '30', unit: 'U/L', ref: '< 45' },
        ],
      },
      '2026-10-10': {
        isLabReport: true,
        takenOn: '2026-10-10',
        lab: 'Lab Rossi',
        kind: 'analisi del sangue',
        items: [
          { name: 'Glucosio', value: '118', unit: 'mg/dL', ref: '70 - 110' },
          { name: 'AST (GOT)', value: '24', unit: 'U/L', ref: '< 35' },
          { name: 'GPT', value: '29,5', unit: 'U/L', ref: '< 45' },
        ],
      },
    };
    const documents = createDocumentRepository(app);
    const brain = createBrainService({ baseDir: dir, index: createBrainIndex(app, null) });
    const health = createHealthRuntime({
      isEnabled: async () => true,
      pool: app,
      extractor: async (text) => {
        const key = text.includes('Glicemia 118') ? '2026-10-10' : '2026-03-02';
        return extractions[key] ?? null;
      },
      brain,
      documents,
      logger: silent,
    });

    const d1 = await documents.create(user, {
      title: 'Analisi marzo',
      source: 'pdf',
      pageTexts: [referto('98', '22')],
    });
    const d2 = await documents.create(user, {
      title: 'Analisi ottobre',
      source: 'pdf',
      pageTexts: [referto('118', '24')],
    });
    expect(await health.tools.importDocument(user, d1.id)).toMatchObject({
      ok: true,
      values: 3,
      outOfRange: [],
    });
    expect(await health.tools.importDocument(user, d2.id)).toMatchObject({
      ok: true,
      values: 3,
      outOfRange: ['Glicemia'],
    });
    expect(await health.tools.importDocument(user, d2.id)).toMatchObject({ ok: false });

    const overview = await health.tools.overview(user);
    expect(overview.reports.map((r) => r.takenOn)).toEqual(['2026-10-10', '2026-03-02']);
    expect(overview.parameters.map((p) => p.label)).toEqual(['ALT (GPT)', 'AST (GOT)', 'Glicemia']);

    const report = await health.tools.report(user, {});
    expect(report?.againstDate).toBe('2026-03-02');
    expect(report?.rows.find((r) => r.label === 'Glicemia')).toMatchObject({
      value: 118,
      flag: 'alto',
      previous: { value: 98, date: '2026-03-02' },
      trend: 'su',
    });
    expect(report?.rows.find((r) => r.label === 'ALT (GPT)')?.trend).toBe('stabile');

    const got = await health.tools.parameter(user, 'got');
    expect(got?.label).toBe('AST (GOT)');
    expect(got?.rows.map((r) => r.value)).toEqual([22, 24]);
    expect(await health.tools.parameter(user, 'ferritina')).toBeNull();

    const notices = await health.takeNotices(user);
    expect(notices).toContain('Ho letto il referto «Analisi ottobre»');
    expect(notices).toContain('Glicemia 118 mg/dL: alto (riferimento 70 - 110), prima 98.');
    expect(await health.takeNotices(user)).toBeNull();

    const note = await readFile(join(dir, user, 'Salute/Parametri/Glicemia.md'), 'utf8');
    expect(note).toContain('riservata: true');
    expect(note).toContain('| 10 ottobre 2026 | 118 ⬆️ | mg/dL | 70–110 |');
    const index = await readFile(join(dir, user, 'Salute/Salute.md'), 'utf8');
    expect(index).toContain('[[Analisi del sangue del 10 ottobre 2026]]');
    expect(index).toContain('[[Analisi del sangue del 2 marzo 2026]]');
    const hits = await brain.search(user, { query: 'glicemia' });
    expect(hits).toEqual([]);

    expect(await health.tools.overview(other)).toEqual({ reports: [], parameters: [] });
    expect(await health.tools.importDocument(other, d1.id)).toMatchObject({ ok: false });
  });

  it('skill spenta: nessuna lettura al caricamento e nessun avviso', async () => {
    let calls = 0;
    const health = createHealthRuntime({
      isEnabled: async () => false,
      pool: app,
      extractor: async () => {
        calls++;
        return null;
      },
      brain: null,
      documents: createDocumentRepository(app),
      logger: silent,
    });
    health.onDocumentCreated(user, randomUUID(), 'Analisi', [referto('118', '24')]);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(0);
    await owner.query(
      `INSERT INTO health_notices (user_id, text) VALUES ($1, 'avviso in sospeso')`,
      [user],
    );
    expect(await health.takeNotices(user)).toBeNull();
  });

  it('unknown/invalid dates stay null, remain readable by report id, and never replace the latest dated report or its notices', async () => {
    const isolated = randomUUID();
    await owner.query(
      `INSERT INTO users (id, display_name) VALUES ($1, 'Synthetic undated reports')`,
      [isolated],
    );
    try {
      const documents = createDocumentRepository(app);
      const health = createHealthRuntime({
        isEnabled: async () => true,
        pool: app,
        extractor: async (text) => ({
          isLabReport: true,
          takenOn:
            text === 'earlier'
              ? '2026-03-02'
              : text === 'recent'
                ? '2026-10-10'
                : text === 'invalid date'
                  ? '2026-02-30'
                  : null,
          kind: 'analisi',
          lab: 'Laboratorio sintetico',
          items: [
            {
              name: 'Glicemia',
              value: text === 'earlier' ? '90' : text === 'recent' ? '118' : '999',
              unit: 'mg/dL',
              ref: '70-110',
            },
          ],
        }),
        brain: createBrainService({ baseDir: dir, index: createBrainIndex(app, null) }),
        documents,
        logger: silent,
      });
      const ingest = async (label: string) => {
        const doc = await documents.create(isolated, {
          title: label,
          source: 'pdf',
          pageTexts: [label],
        });
        return health.tools.importDocument(isolated, doc.id);
      };
      expect(await ingest('unknown date')).toMatchObject({ ok: true, takenOn: null });
      expect(await health.tools.report(isolated, {})).toBeNull();
      const first = (await health.tools.overview(isolated)).reports[0];
      expect(first?.takenOn).toBeNull();
      if (!first) throw Error('Missing undated report');
      const undated = await health.tools.report(isolated, { reportId: first.id });
      expect(undated).toMatchObject({ takenOn: null, againstDate: null, rows: [{ value: 999 }] });
      expect(undated?.rows[0]).not.toHaveProperty('previous');
      expect(await health.tools.report(other, { reportId: first.id })).toBeNull();
      expect((await health.tools.parameter(isolated, 'Glicemia'))?.trend).toBeNull();

      await ingest('earlier');
      await ingest('recent');
      const before = await health.tools.report(isolated, {});
      expect(before).toMatchObject({ takenOn: '2026-10-10', againstDate: '2026-03-02' });
      expect(await ingest('invalid date')).toMatchObject({ ok: true, takenOn: null });
      const after = await health.tools.report(isolated, {});
      expect(after).toEqual(before);
      const datedNotices = await owner.query(
        `SELECT notified_at FROM health_notices WHERE report_id = $1`,
        [before?.id],
      );
      expect(datedNotices.rows.length).toBeGreaterThan(0);
      expect(datedNotices.rows.every((row) => row.notified_at === null)).toBe(true);
      const overview = await health.tools.overview(isolated);
      expect(overview.reports.map((report) => report.takenOn)).toEqual([
        '2026-10-10',
        '2026-03-02',
        null,
        null,
      ]);
      const series = await health.tools.parameter(isolated, 'Glicemia');
      expect(series?.rows.filter((row) => row.date === null).map((row) => row.value)).toEqual([
        999, 999,
      ]);
      expect(series?.trend).toBe('su');
      const explicitUnknown = await health.tools.report(isolated, {
        reportId: first.id,
        against: '2026-10-10',
      });
      expect(explicitUnknown?.againstDate).toBeNull();
      expect(explicitUnknown?.rows[0]).not.toHaveProperty('trend');
      const rows = await owner.query(
        `SELECT taken_on, note_path FROM health_reports WHERE user_id = $1 AND taken_on IS NULL`,
        [isolated],
      );
      expect(rows.rows).toHaveLength(2);
      expect(new Set(rows.rows.map((row) => row.note_path)).size).toBe(2);
      for (const row of rows.rows) {
        const body = await readFile(join(dir, isolated, row.note_path), 'utf8');
        expect(body).toContain('data non disponibile');
        expect(body).not.toContain('riguarda:');
      }
    } finally {
      await owner.query('DELETE FROM users WHERE id = $1', [isolated]);
    }
  });

  it('import notices retain qualitative and unreferenced values without asserting normality', async () => {
    const isolated = randomUUID();
    await owner.query(
      `INSERT INTO users (id, display_name) VALUES ($1, 'Synthetic missing references')`,
      [isolated],
    );
    try {
      const documents = createDocumentRepository(app);
      const health = createHealthRuntime({
        isEnabled: async () => true,
        pool: app,
        extractor: async () => ({
          isLabReport: true,
          takenOn: null,
          kind: 'analisi',
          lab: null,
          items: [
            { name: 'Glicemia', value: '90', unit: 'mg/dL', ref: '70-110' },
            { name: 'Ferritina', value: '20', unit: 'ng/mL', ref: null },
            { name: 'Parametro sintetico', value: '80', ref: 'adulti: 70-110; bambini: 60-100' },
            { name: 'Esito qualitativo sintetico', value: 'negativo', ref: null },
          ],
        }),
        brain: null,
        documents,
        logger: silent,
      });
      const doc = await documents.create(isolated, {
        title: 'Riferimenti parziali',
        source: 'pdf',
        pageTexts: ['Synthetic fixture'],
      });
      expect(await health.tools.importDocument(isolated, doc.id)).toMatchObject({
        ok: true,
        takenOn: null,
        values: 4,
      });
      const notices = await health.takeNotices(isolated);
      expect(notices).toContain('3 valori il confronto non è determinabile');
      expect(notices).not.toMatch(/tutti.*intervallo/i);
      const summary = (await health.tools.overview(isolated)).reports[0];
      if (!summary) throw Error('missing report');
      const report = await health.tools.report(isolated, { reportId: summary.id });
      expect(report?.rows).toHaveLength(4);
      expect(report?.rows.filter((row) => row.flag === 'n/d')).toHaveLength(3);
      expect(report?.rows.find((row) => row.valueText === 'negativo')).toBeDefined();
    } finally {
      await owner.query('DELETE FROM users WHERE id = $1', [isolated]);
    }
  });

  it('al caricamento legge solo ciò che sembra un referto', async () => {
    let calls = 0;
    const health = createHealthRuntime({
      isEnabled: async () => true,
      pool: app,
      extractor: async () => {
        calls++;
        return null;
      },
      brain: null,
      documents: createDocumentRepository(app),
      logger: silent,
    });
    health.onDocumentCreated(user, randomUUID(), 'Ricetta', [
      'Torta di mele: 200 g di farina, 3 uova.',
    ]);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(0);
  });
});
