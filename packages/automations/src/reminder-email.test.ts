import { describe, expect, it } from 'vitest';
import { reminderEmailHtml, reminderEmailSubject, reminderEmailText } from './reminder-email.js';
import { reminderEmailChoice } from './runner.js';

const input = {
  title: 'Fatturare alla pizzeria <romana> 900 €',
  when: 'lunedì 2 novembre 2026 alle 09:00',
  spoken: 'il due novembre di fatturare alla pizzeria romana 900 euro',
  createdOn: '13 ottobre 2026',
  repeat: 'ogni lunedì alle 9',
  bearUrl: 'https://ernie.example/static/ernie-bear.png',
};

describe('email del promemoria', () => {
  it('HTML con orso, titolo protetto e tutti i riferimenti; testo semplice equivalente', () => {
    const html = reminderEmailHtml(input);
    expect(html).toContain('<img src="https://ernie.example/static/ernie-bear.png"');
    expect(html).toContain('Fatturare alla pizzeria &lt;romana&gt; 900 €');
    expect(html).not.toContain('<romana>');
    for (const s of [
      'lunedì 2 novembre 2026 alle 09:00',
      'ogni lunedì alle 9',
      '13 ottobre 2026',
      'il due novembre di fatturare',
    ])
      expect(html).toContain(s);
    expect(reminderEmailSubject({ ...input, from: 'papà' })).toBe(
      '⏰ Promemoria da papà: Fatturare alla pizzeria <romana> 900 €',
    );
    const text = reminderEmailText(input);
    expect(text).toContain('Quando: lunedì 2 novembre 2026 alle 09:00');
    expect(text).toContain(
      'Detto così: «il due novembre di fatturare alla pizzeria romana 900 euro»',
    );
  });

  it('canale email: scelta sulla scheda, altrimenti impostazione generale', () => {
    expect(reminderEmailChoice({ channels: { email: true } })).toBe(true);
    expect(reminderEmailChoice({ channels: { email: false, alarm: true } })).toBe(false);
    expect(reminderEmailChoice({ channels: { alarm: true } })).toBeUndefined();
    expect(reminderEmailChoice({})).toBeUndefined();
  });
});

it('mostra luogo, link completo e note con escaping HTML', () => {
  const details = {
    title: 'Workshop',
    when: 'domani',
    location: 'Sala <A>',
    url: 'https://meet.example.test/a?token=x&lang=it',
    notes: 'Portare <script>\nSeconda riga',
  };
  const html = reminderEmailHtml(details),
    text = reminderEmailText(details);
  expect(text).toContain(details.url);
  expect(html).toContain('href="https://meet.example.test/a?token=x&amp;lang=it"');
  expect(html).toContain('Sala &lt;A&gt;');
  expect(html).toContain('Portare &lt;script&gt;<br>Seconda riga');
  expect(html).not.toContain('<script>');
});
