import { describe, expect, it } from 'vitest';
import {
  decideProactive,
  type GateState,
  type ProactiveCandidate,
  quietUntil,
  quietWindow,
} from './proactive.js';

const cand = (over: Partial<ProactiveCandidate> = {}): ProactiveCandidate => ({
  userId: 'u',
  kind: 'approval_expiring',
  dedupeKey: 'approval_expiring:1',
  title: 't',
  body: 'b',
  evidence: { source: 'user', refs: ['tool_approvals:1'] },
  ...over,
});

// 12:00 a Roma (CEST): fuori dalle ore di quiete predefinite.
const noon = new Date('2026-10-13T10:00:00Z');
const state = (over: Partial<GateState> = {}): GateState => ({
  now: noon,
  timezone: 'Europe/Rome',
  settings: {},
  sentToday: 0,
  lastSentAt: null,
  ...over,
});

describe('gate della proattività: regole', () => {
  it('di giorno, sotto il tetto e con evidenza dell’utente: consegna', () => {
    expect(decideProactive(cand(), state())).toEqual({ verdict: 'send' });
    expect(
      decideProactive(
        cand({ kind: 'family_reminder', evidence: { source: 'family', refs: [] } }),
        state(),
      ),
    ).toEqual({ verdict: 'send' });
  });

  it('insieme chiuso, niente contenuti non fidati, niente evidenze esterne, interruttore', () => {
    expect(decideProactive(cand({ kind: 'gone_quiet' as never }), state())).toEqual({
      verdict: 'drop',
      reason: 'motivo non ammesso',
    });
    expect(decideProactive(cand({ tainted: true }), state()).verdict).toBe('drop');
    expect(
      decideProactive(cand({ evidence: { source: 'web' as never, refs: [] } }), state()).verdict,
    ).toBe('drop');
    expect(decideProactive(cand(), state({ settings: { proactive: false } }))).toEqual({
      verdict: 'drop',
      reason: 'messaggi spontanei spenti',
    });
  });

  it('ore di quiete: si rimanda alla fine (a cavallo della mezzanotte, nel fuso dell’utente)', () => {
    const late = new Date('2026-10-13T21:30:00Z'); // 23:30 a Roma
    const v = decideProactive(cand(), state({ now: late }));
    expect(v).toEqual({
      verdict: 'defer',
      until: new Date('2026-10-14T05:30:00Z'), // 07:30 a Roma del giorno dopo
      reason: 'ore di quiete',
    });
    const early = new Date('2026-10-14T04:00:00Z'); // 06:00 a Roma
    expect(quietUntil(early, 'Europe/Rome', quietWindow({}))?.toISOString()).toBe(
      '2026-10-14T05:30:00.000Z',
    );
    // Finestra personalizzata diurna e disattivata.
    expect(
      quietUntil(
        noon,
        'Europe/Rome',
        quietWindow({ quietHours: { start: '11:00', end: '13:00' } }),
      )?.toISOString(),
    ).toBe('2026-10-13T11:00:00.000Z');
    expect(quietWindow({ quietHours: null })).toBeNull();
    expect(decideProactive(cand(), state({ now: late, settings: { quietHours: null } }))).toEqual({
      verdict: 'send',
    });
  });

  it('tetto giornaliero (predefinito 4, personalizzabile) e intervallo minimo di 45 minuti', () => {
    expect(decideProactive(cand(), state({ sentToday: 4 }))).toEqual({
      verdict: 'drop',
      reason: 'tetto giornaliero (4) raggiunto',
    });
    expect(
      decideProactive(cand(), state({ sentToday: 1, settings: { proactiveDailyCap: 1 } })).verdict,
    ).toBe('drop');
    expect(decideProactive(cand(), state({ settings: { proactiveDailyCap: 0 } })).verdict).toBe(
      'drop',
    );
    const v = decideProactive(
      cand(),
      state({ lastSentAt: new Date(noon.getTime() - 10 * 60_000) }),
    );
    expect(v).toEqual({
      verdict: 'defer',
      until: new Date(noon.getTime() + 35 * 60_000),
      reason: 'intervallo minimo tra due messaggi',
    });
  });
});
