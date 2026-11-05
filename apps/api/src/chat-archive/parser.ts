import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { localParts, zonedToUtc } from '@ernie/skills';
import {
  ChatArchiveError,
  type IncomingImport,
  type ParsedArchive,
  type ParsedMessage,
} from './types.js';

export const MAX_ARCHIVE_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_ARCHIVE_TEXT_BYTES = 16 * 1024 * 1024;
export const MAX_ARCHIVE_MESSAGES = 100_000;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const fail = (message: string): never => {
  throw new ChatArchiveError(400, 'invalid_archive', message);
};
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const b of bytes) crc = (crcTable[(crc ^ b) & 255] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Parse the central directory before inflating any data. Inflate only the sole TXT with native hard output limit. */
function textFromZip(data: Buffer): { text: string; filename: string; ignoredMedia: number } {
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65_557); i--) {
    if (data.readUInt32LE(i) === 0x06054b50 && i + 22 + data.readUInt16LE(i + 20) === data.length) {
      end = i;
      break;
    }
  }
  if (end < 0) return fail('Archivio ZIP non valido o incompleto.');
  if (data.readUInt16LE(end + 4) !== 0 || data.readUInt16LE(end + 6) !== 0)
    return fail('ZIP suddivisi su più volumi non supportati.');
  const count = data.readUInt16LE(end + 10),
    size = data.readUInt32LE(end + 12),
    offset = data.readUInt32LE(end + 16);
  if (!count || count > 200 || count !== data.readUInt16LE(end + 8) || offset + size > end)
    return fail('Lo ZIP contiene troppi elementi o una struttura non supportata.');
  let at = offset;
  let ignoredMedia = 0;
  const textEntries: Array<{
    filename: string;
    flags: number;
    method: number;
    compressed: number;
    expanded: number;
    crc: number;
    offset: number;
  }> = [];
  const names = new Set<string>();
  for (let i = 0; i < count; i++) {
    if (at + 46 > offset + size || data.readUInt32LE(at) !== 0x02014b50)
      return fail('Indice ZIP non valido.');
    const flags = data.readUInt16LE(at + 8),
      method = data.readUInt16LE(at + 10),
      compressed = data.readUInt32LE(at + 20),
      expanded = data.readUInt32LE(at + 24);
    const n = data.readUInt16LE(at + 28),
      extra = data.readUInt16LE(at + 30),
      comment = data.readUInt16LE(at + 32),
      local = data.readUInt32LE(at + 42);
    if (at + 46 + n + extra + comment > offset + size) return fail('Indice ZIP troncato.');
    let name: string;
    try {
      name = decoder.decode(data.subarray(at + 46, at + 46 + n));
    } catch {
      return fail('Nome file ZIP non valido.');
    }
    if (
      !name ||
      name.includes('\0') ||
      name.includes('\\') ||
      name.startsWith('/') ||
      /^[A-Za-z]:/u.test(name) ||
      name.split('/').some((p) => p === '..' || p === '.')
    )
      return fail('Lo ZIP contiene percorsi non sicuri.');
    if (names.has(name)) return fail('Lo ZIP contiene nomi file duplicati.');
    names.add(name);
    const unixMode = (data.readUInt32LE(at + 38) >>> 16) & 0xf000;
    if (
      flags & 1 ||
      unixMode === 0xa000 ||
      (method !== 0 && method !== 8) ||
      local >= offset ||
      compressed === 0xffffffff ||
      expanded === 0xffffffff
    )
      return fail('ZIP cifrati, collegamenti o compressioni non supportate.');
    if (/\.(?:zip|7z|rar|gz|tar)$/iu.test(name)) return fail('Archivi annidati non supportati.');
    if (!name.endsWith('/')) {
      if (/\.txt$/iu.test(name) && !name.startsWith('__MACOSX/')) {
        if (expanded > MAX_ARCHIVE_TEXT_BYTES)
          return fail('Il testo decompresso supera il limite di 16 MB.');
        textEntries.push({
          filename: name.split('/').pop() ?? name,
          flags,
          method,
          compressed,
          expanded,
          crc: data.readUInt32LE(at + 16),
          offset: local,
        });
      } else ignoredMedia++;
    }
    at += 46 + n + extra + comment;
  }
  if (at !== offset + size || textEntries.length !== 1)
    return fail('Importa uno ZIP con un solo file TXT di conversazione.');
  const entry = textEntries[0];
  if (!entry || entry.offset + 30 > offset || data.readUInt32LE(entry.offset) !== 0x04034b50)
    return fail('Contenuto ZIP non valido.');
  if (
    data.readUInt16LE(entry.offset + 6) !== entry.flags ||
    data.readUInt16LE(entry.offset + 8) !== entry.method
  )
    return fail('Intestazioni ZIP incoerenti.');
  const start =
    entry.offset + 30 + data.readUInt16LE(entry.offset + 26) + data.readUInt16LE(entry.offset + 28);
  if (start + entry.compressed > offset) return fail('Contenuto ZIP troncato.');
  const compressed = data.subarray(start, start + entry.compressed);
  let bytes: Buffer;
  try {
    bytes =
      entry.method === 0
        ? compressed
        : inflateRawSync(compressed, { maxOutputLength: MAX_ARCHIVE_TEXT_BYTES });
  } catch {
    return fail('Impossibile decomprimere il testo entro il limite di 16 MB.');
  }
  if (
    bytes.length !== entry.expanded ||
    bytes.length > MAX_ARCHIVE_TEXT_BYTES ||
    crc32(bytes) !== entry.crc
  )
    return fail('Dimensione o integrità del testo ZIP non valida.');
  try {
    return { text: decoder.decode(bytes), filename: entry.filename, ignoredMedia };
  } catch {
    return fail('Il testo deve essere in formato UTF-8.');
  }
}

const normalize = (value: string) =>
  value
    .normalize('NFC')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, '')
    .replace(/\r\n?/gu, '\n');
export function messageFingerprint(
  m: Pick<ParsedMessage, 'localTimestamp' | 'senderKey' | 'type' | 'text'>,
): string {
  return hash(JSON.stringify([m.localTimestamp, m.senderKey, m.type, m.text]));
}
const header =
  /^[\ufeff\u200e\u200f\u202a-\u202e\u2066-\u2069]*\[?(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?\]?\s*(?:-\s*)?(.*)$/iu;
function stamp(match: RegExpExecArray, tz: string, monthFirst: boolean) {
  const a = Number(match[1]),
    b = Number(match[2]);
  const yearValue = Number(match[3]);
  const year = yearValue < 100 ? 2000 + yearValue : yearValue;
  const day = monthFirst ? b : a,
    month = monthFirst ? a : b;
  let hour = Number(match[4]);
  const minute = Number(match[5]),
    second = Number(match[6] ?? 0),
    ampm = match[7]?.toUpperCase();
  if (ampm && (hour < 1 || hour > 12)) return null;
  if (ampm) hour = (hour % 12) + (ampm === 'PM' ? 12 : 0);
  if (
    year < 1970 ||
    year > 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  )
    return null;
  const utc = zonedToUtc(tz, year, month, day, hour, minute);
  const back = localParts(utc, tz);
  if (
    back.year !== year ||
    back.month !== month ||
    back.day !== day ||
    back.hour !== hour ||
    back.minute !== minute
  )
    return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    at: new Date(utc.getTime() + second * 1000).toISOString(),
    localTimestamp: `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`,
  };
}

/** Deterministic WhatsApp text parser. Raw file and raw message bodies remain byte-for-byte decoded originals. */
export function parseArchiveFile(
  input: Pick<IncomingImport, 'filename' | 'dataBase64' | 'timeZone'>,
): ParsedArchive {
  if (
    !input.filename ||
    input.filename.length > 240 ||
    !input.timeZone ||
    input.timeZone.length > 80
  )
    return fail('Nome file o fuso orario non validi.');
  try {
    new Intl.DateTimeFormat('it', { timeZone: input.timeZone }).format();
  } catch {
    return fail('Fuso orario non valido.');
  }
  if (
    input.dataBase64.length > Math.ceil(MAX_ARCHIVE_UPLOAD_BYTES / 3) * 4 ||
    input.dataBase64.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/u.test(input.dataBase64) ||
    (input.dataBase64.includes('=') &&
      (input.dataBase64.indexOf('=') < input.dataBase64.length - 2 ||
        !/={1,2}$/u.test(input.dataBase64)))
  )
    return fail('File non valido o superiore a 8 MB.');
  const bytes = Buffer.from(input.dataBase64, 'base64');
  if (!bytes.length || bytes.length > MAX_ARCHIVE_UPLOAD_BYTES)
    return fail('File vuoto o superiore a 8 MB.');
  let rawText: string,
    filename = input.filename,
    ignoredMedia = 0;
  if (/\.zip$/iu.test(filename)) ({ text: rawText, filename, ignoredMedia } = textFromZip(bytes));
  else if (/\.txt$/iu.test(filename)) {
    try {
      rawText = decoder.decode(bytes);
    } catch {
      return fail('Il testo deve essere in formato UTF-8.');
    }
  } else return fail('Scegli un file TXT o ZIP esportato da WhatsApp.');
  const lines = rawText.split('\n');
  const matches = lines.map((line) => header.exec(line.replace(/\r$/u, '')));
  const headers = matches.filter((m): m is RegExpExecArray => m !== null);
  const monthFirst =
    headers.some((m) => Number(m[2]) > 12) && !headers.some((m) => Number(m[1]) > 12);
  const warnings: string[] = [
    `Date interpretate nel fuso ${input.timeZone}; il file non indica necessariamente il fuso originale.`,
  ];
  if (monthFirst) warnings.push('Formato date mese/giorno riconosciuto.');
  else if (headers.length && headers.every((m) => Number(m[1]) <= 12 && Number(m[2]) <= 12))
    warnings.push('Date ambigue: assunto giorno/mese. Controlla il periodo prima di importare.');
  if (ignoredMedia)
    warnings.push(`${ignoredMedia} allegati ignorati: sono importati solo i testi.`);
  const messages: ParsedMessage[] = [],
    unparsedLines: ParsedArchive['unparsedLines'] = [];
  let current: { match: RegExpExecArray; line: number; body: string[] } | null = null;
  const flush = (lineEnd: number) => {
    if (!current) return;
    const timestamp = stamp(current.match, input.timeZone, monthFirst);
    if (!timestamp) {
      for (let i = current.line; i <= lineEnd; i++)
        unparsedLines.push({ line: i + 1, text: lines[i] ?? '' });
      current = null;
      return;
    }
    const content = current.body.join('\n');
    const senderMatch = /^([^:\n]{1,200}): (.*)$/su.exec(content);
    const sender = senderMatch ? normalize(senderMatch[1] ?? '').trim() : null;
    const raw = senderMatch ? content.slice((senderMatch[1]?.length ?? 0) + 2) : content;
    const text = normalize(raw).trim();
    const type = !sender
      ? 'system'
      : /(?:<.*(?:omess|omitt|allegat|attached).*?>|\b(?:immagine|video|audio|sticker|documento|image|video|audio|sticker|document) (?:omess[oa]|omitted)\b|\(file allegato\)|\(attached file\))/iu.test(
            text,
          )
        ? 'media'
        : 'text';
    const message = {
      ...timestamp,
      sender,
      senderKey: sender?.normalize('NFC') ?? null,
      rawText: raw,
      text,
      type,
      position: messages.length,
      rawLineStart: current.line + 1,
      rawLineEnd: lineEnd + 1,
    } as ParsedMessage;
    message.fingerprint = messageFingerprint(message);
    messages.push(message);
    current = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const match = matches[i];
    if (match) {
      flush(i - 1);
      if (messages.length >= MAX_ARCHIVE_MESSAGES)
        return fail('La conversazione supera 100.000 messaggi.');
      current = {
        match,
        line: i,
        body: [(match[8] ?? '') + ((lines[i] ?? '').endsWith('\r') ? '\r' : '')],
      };
    } else if (current) current.body.push(lines[i] ?? '');
    else if ((lines[i] ?? '').trim()) unparsedLines.push({ line: i + 1, text: lines[i] ?? '' });
  }
  flush(lines.length - 1);
  if (!messages.length)
    return fail('Non ho riconosciuto messaggi WhatsApp nel file. Nessun dato importato.');
  const participants = [...new Set(messages.flatMap((m) => (m.sender ? [m.sender] : [])))];
  if (unparsedLines.length)
    warnings.push(
      `${unparsedLines.length} righe non riconosciute, conservate nell’importazione originale.`,
    );
  const name = filename
    .replace(/\.txt$/iu, '')
    .replace(/^(?:WhatsApp Chat (?:with|con)|Chat WhatsApp (?:con|di))\s*[-–:]?\s*/iu, '')
    .replace(/^_chat$/iu, input.filename.replace(/\.zip$/iu, ''));
  return {
    filename: input.filename,
    fileHash: hash(bytes),
    textHash: hash(rawText),
    rawText,
    name: name.slice(0, 160) || 'Conversazione importata',
    kind: participants.length > 2 ? 'group' : 'direct',
    timeZone: input.timeZone,
    messages,
    participants,
    warnings,
    unparsedLines,
  };
}
