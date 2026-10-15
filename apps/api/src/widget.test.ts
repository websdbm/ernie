import type { Automation, AutomationRun } from '@ernie/automations';
import type { Reminder } from '@ernie/skills';
import { describe, expect, it } from 'vitest';
import { buildWidgetSummary } from './widget.js';

const now = new Date('2026-10-15T13:00:00Z');

const automation = (over: Partial<Automation>): Automation =>
  ({
    id: 'a',
    userId: 'u',
    key: 'k',
    title: 'Automazione',
    kind: 'guided',
    trigger: { type: 'cron', pattern: '0 8 * * 6' },
    timezone: 'Europe/Rome',
    notifyPolicy: 'always',
    check: null,
    enabled: true,
    pausedReason: null,
    ...over,
  }) as Automation;

const reminder = (over: Partial<Reminder>): Reminder =>
  ({ id: 'r', text: 'Promemoria', at: now, status: 'scheduled', ...over }) as Reminder;

describe('riepilogo per il widget', () => {
  it('impegni in ordine, automazioni senza i promemoria, ultima attività, stato', () => {
    const s = buildWidgetSummary({
      now,
      settings: { killSwitch: false, proactive: true },
      reminders: [
        reminder({
          id: 'r2',
          text: 'Dentista',
          at: new Date('2026-10-15T16:00:00Z'),
          eventAt: new Date('2026-10-15T17:00:00Z'),
        }),
        reminder({ id: 'r1', text: 'Chiamare Fabio', at: new Date('2026-10-15T14:00:00Z') }),
        reminder({
          id: 'r3',
          text: 'Per Giorgio',
          at: new Date('2026-10-15T15:00:00Z'),
          for: 'Giorgio',
        }),
        reminder({ id: 'r4', text: 'Vecchio', at: new Date('2026-10-15T12:00:00Z') }),
      ],
      automations: [
        automation({ id: 'p', key: 'promemoria_x', title: 'Promemoria: x' }),
        automation({
          id: 's',
          title: 'Prezzo dei voli',
          notifyPolicy: 'if_condition',
          trigger: { type: 'cron', pattern: '0 * * * *' },
        }),
        automation({ id: 'w', title: 'Spesa del sabato' }),
        automation({ id: 'off', title: 'Spenta', enabled: false }),
        automation({
          id: 'past',
          title: 'Già fatta',
          trigger: { type: 'once', at: '2026-10-14T10:00:00Z' },
        }),
        automation({
          id: 'hook',
          title: 'Webhook',
          trigger: { type: 'webhook' },
          pausedReason: 'errori',
        }),
      ],
      runs: [
        {
          automationId: 'p',
          status: 'succeeded',
          scheduledAt: now,
          startedAt: now,
          finishedAt: now,
        } as AutomationRun,
        {
          automationId: 's',
          status: 'succeeded',
          scheduledAt: new Date('2026-10-15T12:00:00Z'),
          startedAt: null,
          finishedAt: new Date('2026-10-15T12:00:05Z'),
          outcome: { summary: '', silent: true },
        } as AutomationRun,
      ],
      unread: 2,
    });
    expect(s.status).toEqual({ paused: false, proactive: true, unread: 2 });
    expect(s.reminders.map((r) => r.text)).toEqual(['Chiamare Fabio', 'Dentista']);
    expect(s.reminders[1]?.eventAt).toBe('2026-10-15T17:00:00.000Z');
    expect(s.automations.map((a) => [a.title, a.kind, a.nextAt ?? null, a.paused])).toEqual([
      ['Prezzo dei voli', 'sentinella', '2026-10-15T14:00:00.000Z', false],
      ['Spesa del sabato', 'automazione', '2026-10-17T06:00:00.000Z', false],
      ['Webhook', 'automazione', null, true],
    ]);
    expect(s.activity).toEqual({
      title: 'Prezzo dei voli',
      status: 'succeeded',
      at: '2026-10-15T12:00:05.000Z',
      quiet: true,
    });
    expect(s.counts).toEqual({ reminders: 2, automations: 3 });
  });

  it('interruttore di emergenza e niente attività', () => {
    const s = buildWidgetSummary({
      now,
      settings: { killSwitch: true },
      reminders: [],
      automations: [],
      runs: [],
      unread: 0,
    });
    expect(s.status.paused).toBe(true);
    expect(s.activity).toBeUndefined();
    expect(s.reminders).toEqual([]);
    expect(s.family).toBeUndefined();
  });

  it('ultimo messaggio in famiglia, con il nome che gli do e se ha una foto', () => {
    const s = buildWidgetSummary({
      now,
      settings: {},
      reminders: [],
      automations: [],
      runs: [],
      unread: 0,
      family: {
        id: 'm1',
        direction: 'in',
        otherUserId: 'u2',
        label: 'papo',
        text: 'La cena è pronta',
        image: { width: 800, height: 600 },
        replyTo: null,
        at: new Date('2026-10-15T12:59:00Z'),
        readAt: null,
        urgent: true,
        acknowledgedAt: null,
      },
    });
    expect(s.family).toEqual({
      id: 'm1',
      direction: 'in',
      label: 'papo',
      text: 'La cena è pronta',
      image: true,
      at: '2026-10-15T12:59:00.000Z',
      urgent: true,
    });
  });
});
