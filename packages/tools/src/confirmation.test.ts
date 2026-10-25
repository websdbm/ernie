import { randomUUID } from 'node:crypto';
import { ConfirmationPresentation, createEvent, decodeEvent, encodeEvent } from '@ernie/protocol';
import { describe, expect, it } from 'vitest';
import { confirmationPresentation, confirmationReason } from './confirmation.js';

describe('conferme leggibili', () => {
  it('mostra la ricetta intera, senza JSON, conservando ingredienti, ordine e quantità', () => {
    const steps = ['Taglia il tempeh.', 'Cuoci con le spezie e distribuisci nelle tortillas.'];
    const args = {
      title: 'Burritos con tempeh',
      ingredients: ['200 g di tempeh', '70 ml di salsa'],
      steps,
      servings: '2',
      category: 'Secondi',
      tags: ['vegetale'],
    };
    const p = confirmationPresentation('recipe_save', args);
    expect(ConfirmationPresentation.parse(p)).toEqual(p);
    expect(p.summary).toContain('Burritos con tempeh');
    expect(p.summary).toContain('verrà aggiornata');
    expect(p.confirmLabel).toBe('Salva ricetta');
    expect(p.details).toContainEqual({
      label: 'Ingredienti',
      value: '• 200 g di tempeh\n• 70 ml di salsa',
    });
    expect(p.details).toContainEqual({
      label: 'Preparazione',
      value: '1. Taglia il tempeh.\n2. Cuoci con le spezie e distribuisci nelle tortillas.',
    });
    expect(args.steps).toEqual(steps);
    const envelope = { sessionId: randomUUID(), correlationId: randomUUID(), seq: 1 };
    const e = createEvent(
      'tool.confirmation.requested',
      {
        approvalId: randomUUID(),
        toolCallId: 'r',
        toolId: 'recipe_save',
        expiresAt: new Date().toISOString(),
        presentation: p,
      },
      envelope,
    );
    expect(decodeEvent(encodeEvent(e))).toEqual(e);
    expect(() =>
      createEvent(
        'tool.confirmation.requested',
        {
          approvalId: randomUUID(),
          toolCallId: 'old',
          toolId: 'recipe_save',
          expiresAt: new Date().toISOString(),
          argsPreview: '{"title":"vecchia"}',
        },
        envelope,
      ),
    ).not.toThrow();
  });

  it('mantiene visibili gli effetti distruttivi e i dati inviati all’esterno', () => {
    const deletion = confirmationPresentation('recipe_delete', { recipe: 'Zuppa' });
    expect(deletion.destructive).toBe(true);
    expect(deletion.confirmLabel).toBe('Elimina ricetta');
    const search = confirmationPresentation('web_search', { query: 'testo privato da verificare' });
    expect(search.details).toContainEqual({
      label: 'Testo della ricerca',
      value: 'testo privato da verificare',
    });
    const reason = confirmationReason({
      kind: 'ask',
      reason: 'run contaminata',
      exfiltration: true,
    });
    expect(reason).toContain('servizio esterno');
    expect(reason).not.toMatch(/run|tool|Rule of Two|contaminata/);
  });

  it('traduce campi annidati, scelte e date senza mutare la richiesta', () => {
    const args = {
      text: 'Passeggiata',
      at: '2026-10-18T08:00:00Z',
      place: { label: 'Casa', on: 'leave', repeat: true },
      email: false,
    };
    const p = confirmationPresentation('reminder_create', args, 'Europe/Rome');
    expect(p.details.find((d) => d.label === 'Quando avvisarti')?.value).toContain('10:00');
    expect(p.details.find((d) => d.label === 'Luogo')?.value).toContain('Quando esci');
    expect(p.details.find((d) => d.label === 'Luogo')?.value).toContain('Ripeti: Sì');
    expect(args.at).toBe('2026-10-18T08:00:00Z');
  });

  it('mostra la ricorrenza di un promemoria con i giorni in parole', () => {
    const p = confirmationPresentation('reminder_create', {
      text: 'Palestra',
      repeat: { kind: 'weekly', weekdays: [4, 1], hour: 18, minute: 30 },
    });
    expect(p.details.find((d) => d.label === 'Ripeti')?.value).toBe(
      'ogni lunedì e giovedì alle 18:30',
    );
  });

  it('non taglia una scheda Brain ammessa e segnala esplicitamente anteprime oltre il limite', () => {
    const body = 'a'.repeat(60_000);
    const p = confirmationPresentation('brain_write', { title: 'Diario', mode: 'replace', body });
    expect(p.details.find((d) => d.label === 'Contenuto')?.value).toBe(body);
    expect(p.summary).toContain('Sostituisci');
    expect(p.incomplete).toBeUndefined();
    const huge = confirmationPresentation('unknown', { body: 'a'.repeat(100_000) });
    expect(ConfirmationPresentation.parse(huge).incomplete).toBe(true);
    expect(huge.details[0]?.value.length).toBe(65_000);
  });

  it('separa i motivi interni dalle spiegazioni per l’utente', () => {
    expect(
      confirmationReason({
        kind: 'ask',
        reason: 'run contaminata da contenuto non fidato (Rule of Two)',
      }),
    ).toBe('Prima di procedere, controlla i dati ricavati dai contenuti che ho letto.');
    expect(
      confirmationReason({ kind: 'ask', reason: 'conferma sempre richiesta per questo tool' }),
    ).toBe('Per questa azione è prevista la tua conferma.');
    expect(
      confirmationReason({ kind: 'ask', reason: 'azione con effetto esterno con rischio 0.92' }),
    ).not.toContain('0.92');
  });
});
