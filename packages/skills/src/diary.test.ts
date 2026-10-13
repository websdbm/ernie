import { describe, expect, it } from 'vitest';
import {
  type ActivitySummary,
  createDiarySkill,
  diaryWindow,
  formatDiary,
  parseDiaryRequest,
} from './diary.js';

const empty: ActivitySummary = {
  shoppingAdded: [],
  shoppingBought: [],
  recipes: [],
  documents: [],
  webSearches: [],
  webPages: [],
  remindersFired: [],
  remindersCreated: [],
  automations: [],
  memories: [],
  blocked: [],
  pendingApprovals: 0,
  llm: { calls: 0, costUsd: 0 },
};

describe('diario: riconoscimento', () => {
  it('capisce oggi, ieri e settimana; ignora il resto', () => {
    expect(parseDiaryRequest('cosa hai fatto oggi?')).toEqual({ range: 'today' });
    expect(parseDiaryRequest("Cos'hai fatto ieri")).toEqual({ range: 'yesterday' });
    expect(parseDiaryRequest('che cosa hai fatto per me questa settimana?')).toEqual({
      range: 'week',
    });
    expect(parseDiaryRequest('cosa hai fatto')).toEqual({ range: 'today' });
    expect(parseDiaryRequest('riepilogo di oggi')).toEqual({ range: 'today' });
    expect(parseDiaryRequest('riepilogo della settimana')).toEqual({ range: 'week' });
    expect(parseDiaryRequest('cosa hai fatto alla torta di mele?')).toBeNull();
    expect(parseDiaryRequest('cosa ho fatto ieri sera al cinema')).toBeNull();
  });

  it('finestre nel fuso dell’utente (mezzanotte di Roma, ora legale)', () => {
    const now = new Date('2026-10-13T07:30:00Z'); // 09:30 a Roma (CEST, +2)
    expect(diaryWindow('today', now, 'Europe/Rome').from.toISOString()).toBe(
      '2026-10-12T22:00:00.000Z',
    );
    const y = diaryWindow('yesterday', now, 'Europe/Rome');
    expect([y.from.toISOString(), y.to.toISOString()]).toEqual([
      '2026-10-11T22:00:00.000Z',
      '2026-10-12T22:00:00.000Z',
    ]);
    expect(diaryWindow('week', now, 'Europe/Rome').from.toISOString()).toBe(
      '2026-10-06T22:00:00.000Z',
    );
  });
});

describe('diario: testo', () => {
  it('elenca per voce con orari locali e spesa; nessuna invenzione', () => {
    const text = formatDiary(
      'today',
      {
        ...empty,
        shoppingAdded: [
          { name: 'latte', list: 'Spesa' },
          { name: 'pane', list: 'Spesa' },
          { name: 'panettone', list: 'Natale' },
        ],
        shoppingBought: [{ name: 'uova', list: 'Spesa' }],
        recipes: [
          { title: 'Carbonara', version: 1, created: true },
          { title: 'Ragù', version: 3, created: false },
        ],
        documents: [{ title: 'I Sumeri' }],
        webSearches: ['chi erano i Sumeri', 'Uruk città'],
        webPages: ['https://it.wikipedia.org/wiki/Uruk'],
        remindersFired: [{ text: 'chiamare il dentista', at: new Date('2026-10-13T15:00:00Z') }],
        remindersCreated: [
          { text: 'chiamarmi', at: new Date('2026-10-13T15:00:00Z'), forLabel: 'Giorgio' },
        ],
        automations: [
          { title: 'Lista della sera', status: 'succeeded', at: new Date('2026-10-13T16:00:00Z') },
        ],
        memories: ['Preferisce il tè al caffè'],
        blocked: [{ toolId: 'web_search', reason: 'non autorizzato (expired)' }],
        pendingApprovals: 1,
        proactive: ['family_reminder'],
        llm: { calls: 14, costUsd: 0.1234 },
      },
      'Europe/Rome',
    );
    expect(text).toContain('Oggi per te:');
    expect(text).toContain('- **Liste**: aggiunto latte, pane («Spesa»); panettone («Natale»)');
    expect(text).toContain('- **Spunte**: preso uova («Spesa»)');
    expect(text).toContain('salvata «Carbonara», aggiornata «Ragù» (v3)');
    expect(text).toContain(
      '- **Web**: 2 ricerche (chi erano i Sumeri, Uruk città), 1 pagina letta',
    );
    expect(text).toContain('«chiamare il dentista» alle 17:00');
    expect(text).toContain('«chiamarmi» per Giorgio (17:00)');
    expect(text).toContain('«Lista della sera» eseguita alle 18:00');
    expect(text).toContain('- **Ho imparato**: Preferisce il tè al caffè');
    expect(text).toContain('- **Fermato per sicurezza**: web_search');
    expect(text).toContain('- **Aspetta la tua conferma**: 1 azione');
    expect(text).toContain(
      '- **Di mia iniziativa**: ti ho scritto 1 volta (un promemoria da un familiare)',
    );
    expect(text).toContain('Spesa dei modelli: 0,12 $ (14 chiamate).');
  });

  it('giornata vuota o di sole chiacchiere', () => {
    expect(formatDiary('yesterday', empty, 'Europe/Rome')).toBe(
      'Ieri non ho fatto nulla per te: nessuna attività registrata.',
    );
    expect(
      formatDiary('today', { ...empty, llm: { calls: 3, costUsd: 0.004 } }, 'Europe/Rome'),
    ).toBe(
      'Oggi abbiamo solo chiacchierato: nessuna lista, ricetta, documento o promemoria. Spesa dei modelli: 0,004 $.',
    );
  });

  it('la skill interroga l’archivio sulla finestra giusta, senza modello', async () => {
    const calls: Array<[Date, Date]> = [];
    const skill = createDiarySkill(
      {
        summary: async (_u, from, to) => {
          calls.push([from, to]);
          return { ...empty, documents: [{ title: 'Fotosintesi' }] };
        },
      },
      'Europe/Rome',
      () => new Date('2026-10-13T07:30:00Z'),
    );
    const plan = skill.match('cosa hai fatto ieri?');
    const reply = await skill.run(plan, { userId: 'u', sessionId: null, requestId: 'r' });
    expect(reply.text).toContain('«Fotosintesi»');
    expect(reply.actions).toEqual(['diario:yesterday']);
    expect(calls[0]?.[0].toISOString()).toBe('2026-10-11T22:00:00.000Z');
  });
});
