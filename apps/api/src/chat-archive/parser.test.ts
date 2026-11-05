import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { MAX_ARCHIVE_TEXT_BYTES, parseArchiveFile } from './parser.js';

const file = (text: string, filename = 'WhatsApp Chat con Scuola.txt') => ({
  filename,
  dataBase64: Buffer.from(text).toString('base64'),
  timeZone: 'Europe/Rome',
});
const sample =
  '[05/11/2026, 10:00:01] Anna: Ciao 🐻\nseconda riga: completa\n[05/11/2026, 10:01:00] Marco: Va bene\n[05/11/2026, 10:01:00] Marco: Va bene\n[05/11/2026, 10:02:00] Luca: <Media omessi>\n[05/11/2026, 10:03:00] I messaggi sono crittografati end-to-end.';

describe('WhatsApp text archive parser', () => {
  it('preserves multiline/raw/Unicode and distinguishes authors, system messages and repeated occurrences', () => {
    const parsed = parseArchiveFile(file(sample));
    expect(parsed.name).toBe('Scuola');
    expect(parsed.rawText).toBe(sample);
    expect(parsed.kind).toBe('group');
    expect(parsed.messages).toHaveLength(5);
    expect(parsed.participants).toEqual(['Anna', 'Marco', 'Luca']);
    expect(parsed.messages[0]).toMatchObject({
      sender: 'Anna',
      rawText: 'Ciao 🐻\nseconda riga: completa',
      text: 'Ciao 🐻\nseconda riga: completa',
      at: '2026-11-05T09:00:01.000Z',
      rawLineStart: 1,
      rawLineEnd: 2,
    });
    expect(parsed.messages[1]?.fingerprint).toBe(parsed.messages[2]?.fingerprint);
    expect(parsed.messages[3]?.type).toBe('media');
    expect(parsed.messages[4]?.type).toBe('system');
  });
  it('handles Android-style separators, English AM/PM/month-first, bidi marks and CRLF without changing raw', () => {
    const text =
      '\ufeff11/15/26, 1:30 PM - +39123456789: Meeting\r\nNext line\r\n11/15/26, 2:00 PM - Mia: Confirmed';
    const parsed = parseArchiveFile(file(text));
    expect(parsed.rawText).toBe(text);
    expect(parsed.messages[0]?.at).toBe('2026-11-15T12:30:00.000Z');
    expect(parsed.messages[0]?.rawText).toContain('\r\n');
    expect(parsed.messages[1]?.sender).toBe('Mia');
  });
  it('records unmatched and invalid-date lines instead of silently losing them', () => {
    const parsed = parseArchiveFile(
      file(
        'header not recognized\n[31/02/2026, 10:00] Anna: bad date\n[05/11/2026, 11:00] Anna: valid',
      ),
    );
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.unparsedLines).toHaveLength(2);
    expect(parsed.warnings.join(' ')).toContain('2 righe');
  });
  it('signals ambiguous dates and timezone assumption and rejects non-existing spring-forward time', () => {
    expect(parseArchiveFile(file('[05/11/26, 10:00] Anna: ciao')).warnings.join(' ')).toContain(
      'Date ambigue',
    );
    expect(() => parseArchiveFile(file('[29/03/2026, 02:30] Anna: ora inesistente'))).toThrow(
      'Non ho riconosciuto',
    );
  });
  it('accepts TXT in ZIP and ignores binary media without retaining them', () => {
    const data = zipSync({ '_chat.txt': strToU8(sample), 'IMG.jpg': new Uint8Array([1, 2, 3]) });
    const parsed = parseArchiveFile({
      ...file('', 'Scuola.zip'),
      dataBase64: Buffer.from(data).toString('base64'),
    });
    expect(parsed.name).toBe('Scuola');
    expect(parsed.rawText).toBe(sample);
    expect(parsed.warnings.join(' ')).toContain('1 allegati ignorati');
  });
  it('rejects dangerous paths, nested archives, multiple TXT and hard decompression limits', () => {
    for (const entries of [
      { '../_chat.txt': strToU8(sample) },
      { '_chat.txt': strToU8(sample), 'nested.zip': new Uint8Array([1]) },
      { 'a.txt': strToU8(sample), 'b.txt': strToU8(sample) },
    ]) {
      const data = zipSync(entries);
      expect(() =>
        parseArchiveFile({
          ...file('', 'bad.zip'),
          dataBase64: Buffer.from(data).toString('base64'),
        }),
      ).toThrow();
    }
    const bomb = zipSync({ '_chat.txt': new Uint8Array(MAX_ARCHIVE_TEXT_BYTES + 1) });
    expect(() =>
      parseArchiveFile({
        ...file('', 'large.zip'),
        dataBase64: Buffer.from(bomb).toString('base64'),
      }),
    ).toThrow('16 MB');
  });
  it('rejects corrupt integrity, invalid UTF8, unknown file extension and invalid timezone', () => {
    const data = Buffer.from(zipSync({ '_chat.txt': [strToU8(sample), { level: 0 }] }));
    data[40] = (data[40] ?? 0) ^ 0xff;
    expect(() =>
      parseArchiveFile({ ...file('', 'corrupt.zip'), dataBase64: data.toString('base64') }),
    ).toThrow();
    expect(() =>
      parseArchiveFile({ ...file(''), dataBase64: Buffer.from([0xff]).toString('base64') }),
    ).toThrow('UTF-8');
    expect(() => parseArchiveFile(file('x', 'x.pdf'))).toThrow();
    expect(() => parseArchiveFile({ ...file(sample), timeZone: 'invalid' })).toThrow();
  });
  it('validates a near-limit base64 file without recursive-regex stack overflow', () => {
    const text = '[05/11/2026, 10:00] Anna: ' + 'x'.repeat(7 * 1024 * 1024);
    const parsed = parseArchiveFile(file(text));
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]?.text.length).toBe(7 * 1024 * 1024);
  });
});
