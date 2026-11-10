import { describe, expect, it } from 'vitest';
import { habitChatIntent, habitLocalDate, parseHabitTeaching } from './chat.js';

describe('Abitudini insegnate in chat', () => {
  it('separa l’orario abituale e la deroga nello stesso messaggio', () => {
    expect(
      parseHabitTeaching(
        'Oggi rimango al lavoro fino alle 17:10 anche se di solito il mio orario prevede che esco alle 16:35. Oggi è una variazione.',
      ),
    ).toEqual({
      label: 'Uscita dal lavoro',
      usualTime: '16:35',
      exception: { time: '17:10', offset: 0 },
    });
    expect(habitChatIntent('Te lo dico per farti conoscere le mie abitudini', true)).toBe('teach');
  });

  it('accetta attività diverse, orari interi e un’eccezione con attività sottintesa', () => {
    expect(
      parseHabitTeaching(
        'Salva come abitudine che faccio palestra di solito alle 8, ma domani alle 9.30',
      ),
    ).toEqual({
      label: 'faccio palestra',
      usualTime: '08:00',
      exception: { time: '09:30', offset: 1 },
    });
    expect(
      parseHabitTeaching('Di solito esco dal lavoro alle 16:35, ma oggi esco alle 17:10'),
    ).toMatchObject({ label: 'Uscita dal lavoro' });
  });

  it('non assume che due attività diverse siano la stessa e conserva la richiesta esplicita di avviso', () => {
    expect(parseHabitTeaching('Oggi pranzo alle 13, di solito esco dal lavoro alle 17')).toBeNull();
    expect(parseHabitTeaching('Di solito lavoro alle 9 e alle 12')).toBeNull();
    expect(parseHabitTeaching('Di solito non lavoro alle 9')).toBeNull();
    expect(habitChatIntent('Ricordami di andare in palestra di solito alle 8', false)).toBeNull();
    expect(habitChatIntent('Salva le mie abitudini senza creare un promemoria', false)).toBe(
      'teach',
    );
    expect(habitChatIntent('Non salvare le mie abitudini', false)).toBe('decline');
  });

  it('calcola oggi nel fuso del dispositivo anche oltre la mezzanotte UTC locale', () => {
    const beforeMidnight = new Date('2026-11-10T22:59:00Z');
    expect(habitLocalDate(beforeMidnight, 'Europe/Rome')).toBe('2026-11-10');
    expect(habitLocalDate(beforeMidnight, 'Europe/Rome', 1)).toBe('2026-11-11');
    expect(habitLocalDate(new Date('2026-11-10T23:01:00Z'), 'Europe/Rome')).toBe('2026-11-11');
  });
});
