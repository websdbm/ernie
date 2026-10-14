import { describe, expect, it } from 'vitest';
import {
  authorizedSenders,
  cleanSubject,
  emailToNote,
  inboundToken,
  newInboxToken,
  normalizeEmails,
  parseInboundPayload,
} from './brain-inbound.js';
import { shareTitle } from './routes/brain.js';

const DOMAIN = 'brain.ernie.staging3.eklettica.it';

describe('inoltro email al second brain (B3)', () => {
  it('token dall’indirizzo: solo il nostro dominio, forma attesa, senza il suffisso +tag', () => {
    expect(inboundToken('abcdefgh2345@brain.ernie.staging3.eklettica.it', DOMAIN)).toBe(
      'abcdefgh2345',
    );
    expect(inboundToken('ABCDEFGH2345+casa@Brain.Ernie.Staging3.Eklettica.it', DOMAIN)).toBe(
      'abcdefgh2345',
    );
    expect(inboundToken('abcdefgh2345@eklettica.it', DOMAIN)).toBeNull();
    expect(inboundToken('x@brain.ernie.staging3.eklettica.it', DOMAIN)).toBeNull();
    expect(newInboxToken(() => 0)).toBe('aaaaaaaaaaaa');
    expect(newInboxToken()).toMatch(/^[a-z0-9]{12}$/);
  });

  it('oggetto ripulito dai prefissi di inoltro e risposta', () => {
    expect(cleanSubject('Fwd: I: Fattura caldaia')).toBe('Fattura caldaia');
    expect(cleanSubject('RE: re: ciao')).toBe('ciao');
    expect(cleanSubject('  ')).toBe('');
  });

  it('webhook di Brevo → messaggi con token, mittente, testo markdown e allegati; il resto si ignora', () => {
    const body = {
      items: [
        {
          MessageId: '<abc@mail>',
          From: { Name: 'Alessandro', Address: 'Grassi.Alessandro@gmail.com' },
          To: [{ Name: null, Address: 'abcdefgh2345@brain.ernie.staging3.eklettica.it' }],
          Recipients: ['abcdefgh2345@brain.ernie.staging3.eklettica.it'],
          Subject: 'Fwd: Preventivo caldaia',
          SentAtDate: '2026-10-14T09:30:00Z',
          ExtractedMarkdownMessage: 'Buongiorno, in allegato il **preventivo**.',
          RawTextBody: 'testo grezzo',
          Attachments: [
            { Name: 'preventivo.pdf', ContentType: 'application/pdf', ContentLength: 1 },
          ],
        },
        {
          From: { Address: 'x@y.it' },
          To: [{ Address: 'altro@altrodominio.it' }],
          Subject: 'non per noi',
          RawHtmlBody: '<p>ciao</p>',
        },
        {
          From: { Address: 'x@y.it' },
          To: [{ Address: 'zzzzzzzzzzzz@brain.ernie.staging3.eklettica.it' }],
          RawHtmlBody: '<p>Solo <b>HTML</b></p><p>seconda riga</p>',
        },
      ],
    };
    const msgs = parseInboundPayload(body, DOMAIN);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({
      messageId: '<abc@mail>',
      token: 'abcdefgh2345',
      from: 'grassi.alessandro@gmail.com',
      fromName: 'Alessandro',
      text: 'Buongiorno, in allegato il **preventivo**.',
      sentOn: '2026-10-14',
      attachments: ['preventivo.pdf'],
    });
    expect(msgs[1]?.text).toBe('Solo HTML\nseconda riga');
    expect(parseInboundPayload({}, DOMAIN)).toEqual([]);
    expect(parseInboundPayload(null, DOMAIN)).toEqual([]);

    const note = emailToNote(msgs[0] as NonNullable<(typeof msgs)[0]>);
    expect(note.title).toBe('Preventivo caldaia');
    expect(note.body).toContain('in allegato il **preventivo**');
    expect(note.body).toContain('Allegati (non scaricati): «preventivo.pdf»');
    expect(note.body).toContain('_Arrivata via email il 2026-10-14 da Alessandro._');
    expect(
      emailToNote(
        { ...(msgs[1] as NonNullable<(typeof msgs)[1]>), subject: '' },
        new Date('2026-10-14T10:00:00Z'),
      ).title,
    ).toBe('Email del 2026-10-14');
  });

  it('mittenti accettati: email della scheda più gli altri indirizzi, minuscoli e senza doppioni', () => {
    const s = authorizedSenders({
      email: ' Grassi.Alessandro@gmail.com ',
      extraEmails: ['A.Grassi@issm.it', 'a.grassi@issm.it', ' ', 42, 'senza-chiocciola'],
    });
    expect([...s]).toEqual(['grassi.alessandro@gmail.com', 'a.grassi@issm.it']);
    expect(authorizedSenders({}).size).toBe(0);
    expect(authorizedSenders({ email: '', extraEmails: 'x@y.it' }).size).toBe(0);
    expect(normalizeEmails(['B@c.it', 'b@c.it', 'a@b.it'])).toEqual(['b@c.it', 'a@b.it']);
    expect(normalizeEmails(null)).toEqual([]);
  });

  it('titolo di una condivisione: dato, poi pagina, poi sito, poi prima riga del testo', () => {
    expect(shareTitle({ url: 'https://www.esempio.it/a', title: ' Mio titolo ' }, 'Pagina')).toBe(
      'Mio titolo',
    );
    expect(shareTitle({ url: 'https://www.esempio.it/a' }, 'Titolo  della pagina')).toBe(
      'Titolo della pagina',
    );
    expect(shareTitle({ url: 'https://www.esempio.it/a' })).toBe('esempio.it');
    expect(shareTitle({ text: '\nPrima riga\nseconda' })).toBe('Prima riga');
    expect(shareTitle({ text: 'x'.repeat(100) })).toHaveLength(80);
    expect(shareTitle({ text: '   ' })).toBe('Appunto condiviso');
  });
});
