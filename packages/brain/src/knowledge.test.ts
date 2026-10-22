import { describe, expect, it } from 'vitest';
import {
  applyKnowledgeUpdate,
  type BrainKnowledge,
  calculateBrainAgenda,
  type KnowledgeUpdate,
  renderKnowledgeBody,
  stripKnowledgeBody,
  validateBrainKnowledge,
  validKnowledgeDate,
  validKnowledgeTimeZone,
} from './knowledge.js';
import { parseNote, serializeNote, visibleNoteBody } from './note.js';

const now = '2026-10-21T10:00:00.000Z';
const later = '2026-10-22T10:00:00.000Z';
const school = () =>
  applyKnowledgeUpdate(
    undefined,
    {
      ref: 'Ada',
      facts: [{ label: 'Numero scarpe', value: '32' }],
      routines: [
        {
          title: 'Scuola',
          days: [5, 1, 3],
          timeZone: 'Europe/Rome',
          startTime: '08:30',
          endTime: '16:00',
          dropOffTime: '08:15',
          pickupTime: '16:10',
          homeTime: '16:40',
          place: 'Scuola delle Rose',
          notes: 'Ingresso nord',
        },
      ],
    },
    now,
  );
const note = (knowledge: BrainKnowledge) => ({ path: 'Persone/Ada.md', title: 'Ada', knowledge });
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing fixture');
  return value;
}

describe('knowledge partial updates and factual validation', () => {
  it('assigns IDs/timestamps, normalizes days and preserves omitted fields and unrelated records', () => {
    const first = school(),
      routine = must(first.routines[0]);
    const next = applyKnowledgeUpdate(
      first,
      {
        ref: 'Ada',
        facts: [{ label: 'Sport', value: 'Nuoto' }],
        routines: [{ id: routine.id, pickupTime: '16:20' }],
      },
      later,
    );
    expect(next.facts).toHaveLength(2);
    expect(next.facts[0]).toEqual(first.facts[0]);
    expect(next.routines[0]).toEqual({ ...routine, pickupTime: '16:20', updatedAt: later });
    expect(next.routines[0]?.days).toEqual([1, 3, 5]);
    expect(first.routines[0]?.pickupTime).toBe('16:10');
    expect(next.routines[0]?.id).toMatch(/^[a-f0-9-]{36}$/u);
  });
  it('upserts exact normalized labels/titles, stays idempotent and never accepts a client timestamp', () => {
    const first = school();
    const changed = applyKnowledgeUpdate(
      first,
      {
        ref: 'Ada',
        facts: [{ label: 'Numero scarpe', value: '33' }],
        routines: [{ title: 'Scuola', notes: 'Ingresso est', updatedAt: '1999-01-01T00:00:00Z' }],
      },
      later,
    );
    expect(changed.facts[0]?.id).toBe(first.facts[0]?.id);
    expect(changed.routines[0]?.id).toBe(first.routines[0]?.id);
    expect(changed.routines[0]?.updatedAt).toBe(later);
    expect(
      applyKnowledgeUpdate(
        changed,
        {
          ref: 'Ada',
          facts: [{ label: 'Numero scarpe', value: '33' }],
          routines: [{ title: 'Scuola', notes: 'Ingresso est' }],
        },
        '2026-10-23T10:00:00Z',
      ),
    ).toEqual(changed);
  });
  it('rejects ambiguous names, unknown IDs, excessive lists and partial creation', () => {
    const first = school(),
      duplicate = { ...must(first.routines[0]), id: 'other' };
    const ambiguous = { ...first, routines: [...first.routines, duplicate] };
    expect(() =>
      applyKnowledgeUpdate(ambiguous, {
        ref: 'Ada',
        routines: [{ title: 'SCUOLA', notes: 'nuovo' }],
      }),
    ).toThrow('ambiguo');
    expect(() =>
      applyKnowledgeUpdate(first, { ref: 'Ada', routines: [{ id: 'missing', notes: 'nuovo' }] }),
    ).toThrow('ID');
    expect(() =>
      applyKnowledgeUpdate(first, {
        ref: 'Ada',
        routines: [{ title: 'Danza', startTime: '17:00' }],
      }),
    ).toThrow('Nuova routine');
    expect(() =>
      applyKnowledgeUpdate(first, {
        ref: 'Ada',
        facts: Array.from({ length: 51 }, (_, i) => ({ label: `f${i}`, value: 'v' })),
      }),
    ).toThrow('massimo 50');
  });
  it('merges exceptions by date and preserves explicit null, removals are repeatable', () => {
    const first = school();
    const id = must(first.routines[0]).id;
    const second = applyKnowledgeUpdate(
      first,
      {
        ref: 'Ada',
        routines: [
          {
            id,
            exceptions: [
              { date: '2026-10-23', status: 'changed', pickupTime: null },
              { date: '2026-10-25', status: 'changed', startTime: '09:00' },
            ],
          },
        ],
      },
      later,
    );
    const third = applyKnowledgeUpdate(
      second,
      { ref: 'Ada', routines: [{ id, exceptions: [{ date: '2026-10-23', status: 'cancelled' }] }] },
      later,
    );
    expect(third.routines[0]?.exceptions).toEqual([
      { date: '2026-10-23', status: 'cancelled' },
      { date: '2026-10-25', status: 'changed', startTime: '09:00' },
    ]);
    expect(second.routines[0]?.exceptions[0]?.pickupTime).toBeNull();
    const remove = { ref: 'Ada', removeFactIds: [must(first.facts[0]).id], removeRoutineIds: [id] };
    expect(applyKnowledgeUpdate(first, remove)).toEqual({ version: 1, facts: [], routines: [] });
    expect(applyKnowledgeUpdate(applyKnowledgeUpdate(first, remove), remove)).toEqual({
      version: 1,
      facts: [],
      routines: [],
    });
  });
  it.each(['2026-02-29', '2026-04-31', '2026-13-01', '2026-1-01', 'not-a-date'])(
    'rejects nonexistent or malformed date %s',
    (date) => {
      expect(() => validKnowledgeDate(date)).toThrow();
    },
  );
  it('accepts leap day and IANA timezone, rejects impossible times, dates, timezone and overnight order', () => {
    expect(validKnowledgeDate('2028-02-29')).toBe('2028-02-29');
    expect(validKnowledgeTimeZone('Europe/Rome')).toBe('Europe/Rome');
    expect(() => validKnowledgeTimeZone('Europe/Imaginary')).toThrow();
    for (const patch of [
      { startTime: '24:00' },
      { endTime: '07:00' },
      { days: [] },
      { days: [0] },
      { days: [1, 1] },
      { validFrom: '2026-12-02', validUntil: '2026-12-01' },
      { exceptions: [{ date: '2026-10-23', status: 'changed', endTime: '07:00' }] },
    ]) {
      const known = school();
      expect(() =>
        applyKnowledgeUpdate(known, {
          ref: 'Ada',
          routines: [{ id: must(known.routines[0]).id, ...patch }],
        } as KnowledgeUpdate),
      ).toThrow();
    }
    const first = school();
    expect(() =>
      applyKnowledgeUpdate(first, {
        ref: 'Ada',
        routines: [{ id: must(first.routines[0]).id, startTime: '17:00' }],
      }),
    ).toThrow('fuori ordine');
  });
  it('does not invent missing hours and validates changed exceptions against inherited hours', () => {
    const first = applyKnowledgeUpdate(
      undefined,
      {
        ref: 'Ada',
        routines: [{ title: 'Biblioteca', days: [1], timeZone: 'UTC', pickupTime: '17:30' }],
      },
      now,
    );
    expect(first.routines[0]).toMatchObject({
      startTime: null,
      endTime: null,
      dropOffTime: null,
      homeTime: null,
    });
    expect(() =>
      applyKnowledgeUpdate(first, {
        ref: 'Ada',
        routines: [
          {
            title: 'Biblioteca',
            exceptions: [{ date: '2026-10-26', status: 'changed', homeTime: '17:00' }],
          },
        ],
      }),
    ).toThrow('fuori ordine');
  });
});

describe('deterministic agenda with explicit absences and timezone', () => {
  it('keeps subjects on an empty day, never interprets empty entries as at home', () => {
    const result = calculateBrainAgenda([note(school())], {
      date: '2026-10-22',
      timeZone: 'Europe/Rome',
    });
    expect(result.entries).toEqual([]);
    expect(result.subjects).toEqual([{ path: 'Persone/Ada.md', title: 'Ada' }]);
  });
  it('shows cancelled routines and adds changed dates outside usual weekdays', () => {
    const first = school();
    const next = applyKnowledgeUpdate(first, {
      ref: 'Ada',
      routines: [
        {
          title: 'Scuola',
          exceptions: [
            { date: '2026-10-23', status: 'cancelled' },
            { date: '2026-10-25', status: 'changed', pickupTime: null },
          ],
        },
      ],
    });
    expect(
      calculateBrainAgenda([note(next)], { date: '2026-10-23', timeZone: 'Europe/Rome' }).entries[0]
        ?.status,
    ).toBe('cancelled');
    expect(
      calculateBrainAgenda([note(next)], { date: '2026-10-25', timeZone: 'Europe/Rome' })
        .entries[0],
    ).toMatchObject({ status: 'planned', pickupTime: null, homeTime: '16:40' });
  });
  it('uses inclusive validity, sorts by first known time, and keeps each routine timezone', () => {
    const first = applyKnowledgeUpdate(undefined, {
      ref: 'Ada',
      routines: [
        {
          title: 'Danza',
          days: [3],
          timeZone: 'America/New_York',
          startTime: '15:00',
          validFrom: '2026-10-21',
          validUntil: '2026-10-21',
        },
        { title: 'Scuola', days: [3], timeZone: 'Europe/Rome', startTime: '08:30' },
      ],
    });
    const today = calculateBrainAgenda([note(first)], {
      date: '2026-10-21',
      timeZone: 'Europe/Rome',
    });
    expect(today.entries.map((item) => item.title)).toEqual(['Scuola', 'Danza']);
    expect(today.entries[1]?.timeZone).toBe('America/New_York');
    expect(
      calculateBrainAgenda([note(first)], {
        date: '2026-10-28',
        timeZone: 'Europe/Rome',
      }).entries.map((item) => item.title),
    ).toEqual(['Scuola']);
  });
});

describe('canonical Markdown and Obsidian preservation', () => {
  it('round-trips knowledge/unknown frontmatter and renders one readable section before history', () => {
    const original = parseNote(
      'Persone/Ada.md',
      '---\ntipo: persona\ncustom: "preservare"\n---\n# Ada\n\nTesto originale.\n\n### 2026-01-01\n\nStorico.',
    );
    const text = serializeNote({ ...original, knowledge: school() });
    const read = parseNote(original.path, text);
    expect(read.knowledge).toEqual(validateBrainKnowledge(read.knowledge));
    expect(read.extra).toEqual(['custom: "preservare"']);
    expect(serializeNote(read)).toBe(text);
    expect(text.match(/## Orari abituali/gu)).toHaveLength(1);
    expect(read.body.indexOf('## Informazioni')).toBeLessThan(
      read.body.indexOf('Testo originale.'),
    );
    expect(stripKnowledgeBody(read.body)).toBe(original.body);
    expect(visibleNoteBody(read.body)).not.toContain('<!--');
    expect(visibleNoteBody(read.body)).toContain('Rientro a casa previsto: 16:40');
  });
  it('preserves user whitespace and unsupported multiline frontmatter without stripping its parent key', () => {
    for (const body of ['# Ada\nText', '# Ada\n\n\nText', '\nTesto\n\n', 'Testo']) {
      expect(stripKnowledgeBody(renderKnowledgeBody(body, school()))).toBe(body);
    }
    const parsed = parseNote(
      'Persone/Ada.md',
      '---\nknowledge:\n  version: 2\n  nested: keep\ncustom: value\n---\nManuale',
    );
    expect(parsed.knowledge).toBeUndefined();
    expect(serializeNote(parsed)).toContain(
      'knowledge:\n  version: 2\n  nested: keep\ncustom: value',
    );
  });

  it('keeps malformed/unknown knowledge losslessly and rejects replacing an edited generated section', () => {
    const raw = '---\nknowledge: {"version":9,"unknown":"keep me"}\n---\n# Ada';
    const parsed = parseNote('Persone/Ada.md', raw);
    expect(parsed.knowledge).toBeUndefined();
    expect(serializeNote(parsed)).toContain('knowledge: {"version":9,"unknown":"keep me"}');
    const body = renderKnowledgeBody('# Ada\n\nManuale', school());
    expect(() => renderKnowledgeBody(body.replace('32', '33'), school())).toThrow('modificata');
    expect(() => renderKnowledgeBody('<!-- ernie:knowledge broken -->\nManuale', school())).toThrow(
      'incompleta',
    );
  });
});

describe('factual provenance, validity and retained revisions', () => {
  it('reads legacy facts without silently confirming or rewriting them', () => {
    const original = school();
    expect(validateBrainKnowledge(original)).toEqual(original);
    expect(original.facts[0]?.status).toBeUndefined();
    expect(renderKnowledgeBody('', original)).toContain('Da verificare');
  });
  it('preserves the previous source on change and never inherits its confirmation', () => {
    const evidence = { kind: 'user' as const, ref: 'chat:s:r', quote: 'Ada porta il 32' };
    const original = applyKnowledgeUpdate(
      undefined,
      {
        ref: 'Ada',
        facts: [
          { label: 'Scarpe', value: '32', status: 'confirmed', evidence, validUntil: '2026-10-21' },
        ],
      },
      now,
    );
    const next = applyKnowledgeUpdate(
      original,
      { ref: 'Ada', facts: [{ label: 'Scarpe', value: '33' }] },
      later,
    );
    expect(next.facts[0]).toMatchObject({
      value: '33',
      history: [
        original.facts[0] && {
          label: 'Scarpe',
          value: '32',
          status: 'confirmed',
          evidence,
          validUntil: '2026-10-21',
          updatedAt: now,
        },
      ],
    });
    expect(next.facts[0]?.evidence).toBeUndefined();
    expect(next.facts[0]?.status).toBeUndefined();
    expect(next.facts[0]?.validUntil).toBeUndefined();
    expect(
      applyKnowledgeUpdate(next, { ref: 'Ada', facts: [{ label: 'Scarpe', value: '33' }] }, later),
    ).toEqual(next);
    const note = parseNote(
      'Persone/Ada.md',
      serializeNote({
        ...parseNote('Persone/Ada.md', '# Ada\n\nStorico originale'),
        knowledge: next,
      }),
    );
    expect(note.knowledge).toEqual(next);
    expect(note.body).toContain('Storico originale');
  });
  it('requires explicit evidence, rejects inference as confirmed and invalid date ranges', () => {
    for (const metadata of [
      { status: 'confirmed' },
      {
        status: 'confirmed',
        evidence: { kind: 'inference', ref: 'modello', quote: 'Penso abiti qui' },
      },
      { validFrom: '2026-10-22', validUntil: '2026-10-21' },
      { validUntil: '2026-02-30' },
    ])
      expect(() =>
        applyKnowledgeUpdate(undefined, {
          ref: 'Ada',
          facts: [{ label: 'Casa', value: 'Roma', ...metadata }],
        } as KnowledgeUpdate),
      ).toThrow();
  });
  it('retains provenance on metadata-only changes and makes superseded visible', () => {
    const original = applyKnowledgeUpdate(
      undefined,
      {
        ref: 'Ada',
        facts: [
          {
            label: 'Casa',
            value: 'Roma',
            status: 'uncertain',
            evidence: { kind: 'inference', ref: 'nota', quote: 'I genitori vivono a Roma' },
          },
        ],
      },
      now,
    );
    const next = applyKnowledgeUpdate(
      original,
      { ref: 'Ada', facts: [{ label: 'Casa', value: 'Roma', status: 'superseded' }] },
      later,
    );
    expect(next.facts[0]?.evidence).toEqual(original.facts[0]?.evidence);
    expect(next.facts[0]?.history).toHaveLength(1);
    expect(renderKnowledgeBody('', next)).toContain('Superato');
    expect(next.routines).toEqual([]);
  });
});
