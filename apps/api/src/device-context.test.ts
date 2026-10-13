import { describe, expect, it } from 'vitest';
import { formatDeviceContext } from './device-context.js';

const now = new Date('2026-10-13T11:07:00Z');

describe('contesto del telefono', () => {
  it('ora locale nel fuso del telefono e posizione arrotondata con il luogo', () => {
    const out = formatDeviceContext(
      {
        timezone: 'Europe/Rome',
        location: {
          latitude: 45.40642,
          longitude: 11.87676,
          accuracyM: 65,
          place: 'Padova, Veneto, Italia',
          at: '2026-10-13T11:02:00Z',
        },
      },
      now,
    );
    expect(out).toContain('martedì 13 ottobre 2026');
    expect(out).toContain('13:07');
    expect(out).toContain(
      'Posizione attuale dal telefono: Padova, Veneto, Italia (45.41, 11.88; precisione circa 100 m; rilevata 5 minuti fa)',
    );
    expect(out).not.toContain('45.40642');
  });

  it('fuso diverso (in viaggio), posizione vecchia segnalata, troppo vecchia esclusa', () => {
    const ny = formatDeviceContext({ timezone: 'America/New_York' }, now);
    expect(ny).toContain('07:07');
    const stale = formatDeviceContext(
      { location: { latitude: 45, longitude: 12, at: '2026-10-13T06:00:00Z' } },
      now,
    );
    expect(stale).toContain('Ultima posizione nota dal telefono: 45.00, 12.00; rilevata 5 ore fa.');
    expect(
      formatDeviceContext(
        { location: { latitude: 45, longitude: 12, at: '2026-10-11T06:00:00Z' } },
        now,
      ),
    ).toBeNull();
  });

  it('niente contesto o fuso inventato: nessun blocco', () => {
    expect(formatDeviceContext(undefined, now)).toBeNull();
    expect(formatDeviceContext({ timezone: 'Marte/Olympus' }, now)).toBeNull();
  });
});
