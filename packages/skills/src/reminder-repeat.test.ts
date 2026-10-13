import { describe, expect, it } from 'vitest';
import { parseReminderCommand } from './reminder.js';
import { firstOccurrence, parseRepeat, repeatCron, repeatLabel } from './reminder-repeat.js';
import { localParts, zonedToUtc } from './zoned.js';

const TZ = 'Europe/Rome';
// Sabato 11 ottobre 2026, 15:00 a Roma.
const NOW = zonedToUtc(TZ, 2026, 10, 11, 15, 0);
const local = (d: Date) => {
  const p = localParts(d, TZ);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
};

describe('promemoria ricorrenti', () => {
  it('«ogni venerdì alle 9 di andare in palestra»', () => {
    const r = parseRepeat('ogni venerdì alle 9 di andare in palestra');
    expect(r).toMatchObject({ text: 'andare in palestra', assumed: [] });
    expect(r?.repeat).toEqual({ kind: 'weekly', weekdays: [5], hour: 9, minute: 0 });
    if (!r) return;
    expect(repeatLabel(r.repeat)).toBe('ogni venerdì alle 9');
    expect(repeatCron(r.repeat)).toBe('0 9 * * 5');
    expect(local(firstOccurrence(r.repeat, NOW, TZ))).toBe('2026-10-16 09:00');
  });

  it('più giorni, giorni feriali, ogni giorno, ogni sera, una volta al mese', () => {
    const two = parseRepeat('ogni lunedì e giovedì alle 18:30 di portare Giorgio a calcio');
    expect(two?.repeat).toEqual({ kind: 'weekly', weekdays: [1, 4], hour: 18, minute: 30 });
    expect(two && repeatLabel(two.repeat)).toBe('ogni lunedì e giovedì alle 18:30');
    const fer = parseRepeat('nei giorni feriali alle 7 e mezza di partire per il lavoro');
    expect(fer && repeatLabel(fer.repeat)).toBe('nei giorni feriali alle 7:30');
    expect(fer?.text).toBe('partire per il lavoro');
    const day = parseRepeat('ogni giorno alle 8 di prendere la pastiglia');
    expect(day?.repeat).toEqual({ kind: 'daily', hour: 8, minute: 0 });
    expect(day && local(firstOccurrence(day.repeat, NOW, TZ))).toBe('2026-10-12 08:00');
    const eve = parseRepeat('ogni sera di chiudere il gas');
    expect(eve).toMatchObject({ text: 'chiudere il gas', assumed: ['le 20 per «sera»'] });
    expect(eve?.repeat).toEqual({ kind: 'daily', hour: 20, minute: 0 });
    const month = parseRepeat("il 5 di ogni mese di pagare l'affitto");
    expect(month?.repeat).toEqual({ kind: 'monthly', day: 5, hour: 9, minute: 0 });
    expect(month?.assumed).toEqual(['le 9, perché non hai detto l’ora']);
    expect(month && repeatCron(month.repeat)).toBe('0 9 5 * *');
    expect(month && local(firstOccurrence(month.repeat, NOW, TZ))).toBe('2026-11-05 09:00');
  });

  it('le frasi non ricorrenti restano alla logica di sempre', () => {
    expect(parseRepeat('domani alle 9 di chiamare il dentista')).toBeNull();
    expect(parseRepeat('il 31 di ogni mese di fare il backup')).toBeNull(); // non tutti i mesi lo hanno
    const plan = parseReminderCommand(
      'Ricordami ogni venerdì alle 9 di andare in palestra',
      NOW,
      TZ,
    );
    expect(plan).toMatchObject({
      op: 'create',
      text: 'andare in palestra',
      repeat: { kind: 'weekly' },
    });
    if (plan?.op === 'create') expect(local(plan.at)).toBe('2026-10-16 09:00');
    expect(
      parseReminderCommand('ricordami domani alle 9 di chiamare il dentista', NOW, TZ),
    ).not.toHaveProperty('repeat');
  });
});
