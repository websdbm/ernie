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
const ready = Boolean(OWNER_URL && APP_PASSWORD);

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

  it('al caricamento legge solo ciò che sembra un referto', async () => {
    let calls = 0;
    const health = createHealthRuntime({
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
