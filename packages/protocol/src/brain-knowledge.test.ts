import { describe, expect, it } from 'vitest';
import {
  BrainAgendaQuerySchema,
  BrainKnowledgeUpdateSchema,
  brainLocalDay,
} from './brain-knowledge.js';

describe('confine delle schede fattuali', () => {
  it('rifiuta date inesistenti, fusi inventati, ore e campi di notifica', () => {
    expect(
      BrainAgendaQuerySchema.safeParse({ date: '2026-02-30', timeZone: 'Europe/Rome' }).success,
    ).toBe(false);
    expect(
      BrainAgendaQuerySchema.safeParse({ date: '2026-10-21', timeZone: 'Roma/Italia' }).success,
    ).toBe(false);
    for (const patch of [{ startTime: '25:00' }, { days: [0] }, { notifications: true }]) {
      expect(
        BrainKnowledgeUpdateSchema.safeParse({ ref: 'Persone/Anna.md', routines: [patch] }).success,
      ).toBe(false);
    }
    expect(
      BrainKnowledgeUpdateSchema.safeParse({ ref: 'Anna', facts: [], routines: [] }).success,
    ).toBe(false);
  });

  it('mantiene esplicite le cancellazioni di singole date e i campi rimossi', () => {
    expect(
      BrainKnowledgeUpdateSchema.parse({
        ref: 'Persone/Anna.md',
        routines: [
          {
            id: 'sport',
            exceptions: [
              { date: '2026-10-21', status: 'cancelled' },
              { date: '2026-10-28', status: 'changed', homeTime: null },
            ],
          },
        ],
      }).routines?.[0],
    ).toEqual({
      id: 'sport',
      exceptions: [
        { date: '2026-10-21', status: 'cancelled' },
        { date: '2026-10-28', status: 'changed', homeTime: null },
      ],
    });
  });

  it('calcola oggi e domani nel fuso richiesto anche al cambio di ora', () => {
    const now = new Date('2026-10-24T23:30:00Z');
    expect(brainLocalDay('Europe/Rome', 0, now)).toBe('2026-10-25');
    expect(brainLocalDay('Europe/Rome', 1, now)).toBe('2026-10-26');
    expect(brainLocalDay('Pacific/Honolulu', 0, now)).toBe('2026-10-24');
    expect(brainLocalDay('Pacific/Honolulu', 1, now)).toBe('2026-10-25');
  });
});

describe('fact reliability wire compatibility', () => {
  it('accepts old writes and optional provenance, rejects writing server-owned history', () => {
    const old = { ref: 'Anna', facts: [{ label: 'Sport', value: 'Nuoto' }] };
    expect(BrainKnowledgeUpdateSchema.parse(old)).toEqual(old);
    const next = {
      ref: 'Anna',
      facts: [
        {
          label: 'Sport',
          value: 'Nuoto',
          status: 'uncertain',
          evidence: { kind: 'document', ref: 'https://example.org/sport', quote: 'Nuoto' },
          validFrom: '2026-10-01',
          validUntil: '2026-12-31',
        },
      ],
    };
    expect(BrainKnowledgeUpdateSchema.parse(next)).toEqual(next);
    expect(
      BrainKnowledgeUpdateSchema.safeParse({
        ref: 'Anna',
        facts: [{ ...old.facts[0], history: [] }],
      }).success,
    ).toBe(false);
    expect(
      BrainKnowledgeUpdateSchema.safeParse({
        ref: 'Anna',
        facts: [{ ...old.facts[0], status: 'model-confident' }],
      }).success,
    ).toBe(false);
  });
});
