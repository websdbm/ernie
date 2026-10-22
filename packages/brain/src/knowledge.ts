import { createHash, randomUUID } from 'node:crypto';

export interface BrainFactEvidence {
  kind: 'user' | 'document' | 'calendar' | 'inference';
  ref: string;
  quote: string;
}
export interface BrainFactRevision {
  status?: 'unverified' | 'confirmed' | 'uncertain' | 'superseded' | undefined;
  evidence?: BrainFactEvidence | null | undefined;
  validFrom?: string | null | undefined;
  validUntil?: string | null | undefined;
  label: string;
  value: string;
  updatedAt: string;
}
export interface BrainFact extends BrainFactRevision {
  id: string;
  history?: BrainFactRevision[] | undefined;
}
export interface BrainRoutineException {
  date: string;
  status: 'cancelled' | 'changed';
  startTime?: string | null | undefined;
  endTime?: string | null | undefined;
  dropOffTime?: string | null | undefined;
  pickupTime?: string | null | undefined;
  homeTime?: string | null | undefined;
  place?: string | null | undefined;
  notes?: string | null | undefined;
}
export interface BrainRoutine {
  id: string;
  title: string;
  days: number[];
  timeZone: string;
  startTime: string | null;
  endTime: string | null;
  dropOffTime: string | null;
  pickupTime: string | null;
  homeTime: string | null;
  place: string | null;
  validFrom: string | null;
  validUntil: string | null;
  notes: string | null;
  updatedAt: string;
  exceptions: BrainRoutineException[];
}
export interface BrainKnowledge {
  version: 1;
  facts: BrainFact[];
  routines: BrainRoutine[];
}
export type BrainRoutineUpdate = { [K in keyof BrainRoutine]?: BrainRoutine[K] | undefined };
export interface KnowledgeUpdate {
  ref: string;
  facts?: Array<Omit<BrainFactRevision, 'updatedAt'> & { id?: string | undefined }> | undefined;
  routines?: BrainRoutineUpdate[] | undefined;
  removeFactIds?: string[] | undefined;
  removeRoutineIds?: string[] | undefined;
}
export interface BrainAgendaEntry {
  notePath: string;
  noteTitle: string;
  routineId: string;
  title: string;
  timeZone: string;
  status: 'planned' | 'cancelled';
  startTime: string | null;
  endTime: string | null;
  dropOffTime: string | null;
  pickupTime: string | null;
  homeTime: string | null;
  place: string | null;
  notes: string | null;
}
export interface BrainAgenda {
  date: string;
  timeZone: string;
  entries: BrainAgendaEntry[];
  subjects: Array<{ path: string; title: string }>;
}
export class BrainKnowledgeError extends Error {
  constructor(
    message: string,
    readonly code = 'invalid_knowledge',
    readonly statusCode = 400,
  ) {
    super(message);
  }
}
function fail(message: string): never {
  throw new BrainKnowledgeError(message);
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail('Oggetto non valido');
function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail('Campo non riconosciuto');
}
function text(value: unknown, label: string, max = 120): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32 && !['\t', '\n', '\r'].includes(char))
  )
    fail(`${label} non valido`);
  return value.trim().normalize('NFC');
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(`Elenco non valido (massimo ${max})`);
  return value;
}
export function knowledgeKey(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('it').replace(/\s+/gu, ' ').trim();
}
export function validKnowledgeDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value))
    fail('Data non valida: usare YYYY-MM-DD');
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    fail('Data inesistente');
  return value;
}
export function validKnowledgeTimeZone(value: unknown): string {
  const zone = text(value, 'Fuso orario', 80);
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone }).format(0);
  } catch {
    fail('Fuso orario non valido');
  }
  return zone;
}
const TIMES = ['dropOffTime', 'startTime', 'endTime', 'pickupTime', 'homeTime'] as const;
const OPTIONAL = [...TIMES, 'place', 'notes'] as const;
const ROUTINE_FIELDS = [
  'id',
  'title',
  'days',
  'timeZone',
  ...OPTIONAL,
  'validFrom',
  'validUntil',
  'updatedAt',
  'exceptions',
];
function time(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value))
    fail('Ora non valida: usare HH:mm');
  return value;
}
function optionalValue(key: (typeof OPTIONAL)[number], value: unknown): string | null {
  if (key === 'notes' && typeof value === 'string' && !value.trim()) return null;
  return TIMES.includes(key as (typeof TIMES)[number])
    ? time(value)
    : value === null
      ? null
      : text(value, key, key === 'notes' ? 2000 : 300);
}
function effectiveRoutine(base: BrainRoutine, change?: BrainRoutineException): BrainRoutine {
  const result = { ...base };
  for (const key of OPTIONAL) {
    const value = change?.[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}
function checkOrder(value: Pick<BrainRoutine, (typeof TIMES)[number]>) {
  let previous: string | null = null;
  for (const key of TIMES) {
    const next = value[key];
    if (next !== null) {
      if (previous !== null && next < previous)
        fail('Orari fuori ordine nella stessa giornata: chiarire eventuali turni notturni');
      previous = next;
    }
  }
}
function exception(value: unknown): BrainRoutineException {
  const row = object(value);
  keys(row, ['date', 'status', ...OPTIONAL]);
  const date = validKnowledgeDate(row.date);
  if (row.status !== 'cancelled' && row.status !== 'changed') fail('Stato eccezione non valido');
  const result: BrainRoutineException = { date, status: row.status };
  for (const key of OPTIONAL)
    if (row[key] !== undefined) result[key] = optionalValue(key, row[key]);
  return result;
}
function timestamp(value: unknown): string {
  const result = text(value, 'Data aggiornamento', 40);
  validKnowledgeDate(result.slice(0, 10));
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(result) || !Number.isFinite(Date.parse(result)))
    fail('Data aggiornamento non valida');
  return result;
}
function unique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) fail(`${label} duplicati`);
}
function routine(value: unknown): BrainRoutine {
  const row = object(value);
  keys(row, ROUTINE_FIELDS);
  const days = array(row.days, 7);
  if (!days.length) fail('Indicare almeno un giorno abituale');
  if (days.some((day) => typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 7))
    fail('Giorni non validi: lunedì=1, domenica=7');
  unique(days.map(String), 'Giorni');
  const result: BrainRoutine = {
    id: text(row.id, 'ID', 80),
    title: text(row.title, 'Titolo'),
    days: [...(days as number[])].sort((a, b) => a - b),
    timeZone: validKnowledgeTimeZone(row.timeZone),
    startTime: time(row.startTime),
    endTime: time(row.endTime),
    dropOffTime: time(row.dropOffTime),
    pickupTime: time(row.pickupTime),
    homeTime: time(row.homeTime),
    place: row.place === null ? null : text(row.place, 'Luogo', 300),
    notes: optionalValue('notes', row.notes),
    validFrom: row.validFrom === null ? null : validKnowledgeDate(row.validFrom),
    validUntil: row.validUntil === null ? null : validKnowledgeDate(row.validUntil),
    updatedAt: timestamp(row.updatedAt),
    exceptions: array(row.exceptions, 100)
      .map(exception)
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
  if (result.validFrom && result.validUntil && result.validFrom > result.validUntil)
    fail('Intervallo di validità invertito');
  checkOrder(result);
  unique(
    result.exceptions.map((item) => item.date),
    'Date eccezione',
  );
  for (const item of result.exceptions) {
    if (item.status === 'changed') checkOrder(effectiveRoutine(result, item));
    if (
      (result.validFrom && item.date < result.validFrom) ||
      (result.validUntil && item.date > result.validUntil)
    )
      fail('Eccezione fuori dalla validità della routine');
  }
  return result;
}
const FACT_RELIABILITY = ['status', 'evidence', 'validFrom', 'validUntil'] as const;
const FACT_REVISION_FIELDS = ['label', 'value', 'updatedAt', ...FACT_RELIABILITY];
function factRevision(value: unknown): BrainFactRevision {
  const row = object(value);
  keys(row, FACT_REVISION_FIELDS);
  const result: BrainFactRevision = {
    label: text(row.label, 'Etichetta', 120),
    value: text(row.value, 'Valore', 2000),
    updatedAt: timestamp(row.updatedAt),
  };
  if (row.status !== undefined) {
    if (!['unverified', 'confirmed', 'uncertain', 'superseded'].includes(String(row.status)))
      fail('Stato del fatto non valido');
    result.status = row.status as BrainFactRevision['status'];
  }
  if (row.evidence !== undefined) {
    if (row.evidence === null) result.evidence = null;
    else {
      const source = object(row.evidence);
      keys(source, ['kind', 'ref', 'quote']);
      if (!['user', 'document', 'calendar', 'inference'].includes(String(source.kind)))
        fail('Tipo di fonte non valido');
      result.evidence = {
        kind: source.kind as BrainFactEvidence['kind'],
        ref: text(source.ref, 'Riferimento fonte', 500),
        quote: text(source.quote, 'Citazione fonte', 2000),
      };
    }
  }
  for (const key of ['validFrom', 'validUntil'] as const)
    if (row[key] !== undefined)
      result[key] = row[key] === null ? null : validKnowledgeDate(row[key]);
  if (result.validFrom && result.validUntil && result.validFrom > result.validUntil)
    fail('Intervallo di validità del fatto invertito');
  if (result.status === 'confirmed' && (!result.evidence || result.evidence.kind === 'inference'))
    fail('Un fatto confermato richiede una fonte esplicita, non una deduzione');
  return result;
}

export function validateBrainKnowledge(value: unknown): BrainKnowledge {
  const row = object(value);
  keys(row, ['version', 'facts', 'routines']);
  if (row.version !== 1) fail('Versione knowledge non supportata');
  const facts = array(row.facts, 50).map((item): BrainFact => {
    const fact = object(item);
    keys(fact, ['id', ...FACT_REVISION_FIELDS, 'history']);
    const { id, history, ...revision } = fact;
    return {
      id: text(id, 'ID', 80),
      ...factRevision(revision),
      ...(history !== undefined ? { history: array(history, 100).map(factRevision) } : {}),
    };
  });
  const routines = array(row.routines, 30).map(routine);
  unique(
    facts.map((fact) => fact.id),
    'ID fatti',
  );
  unique(
    routines.map((item) => item.id),
    'ID routine',
  );
  return { version: 1, facts, routines };
}

/** Pure partial upsert. IDs/timestamps are server-owned; equal inputs retain both. */
export function applyKnowledgeUpdate(
  current: BrainKnowledge | undefined,
  input: KnowledgeUpdate,
  now = new Date().toISOString(),
): BrainKnowledge {
  const data = object(input);
  keys(data, ['ref', 'facts', 'routines', 'removeFactIds', 'removeRoutineIds']);
  text(data.ref, 'Riferimento', 300);
  if (
    ![data.facts, data.routines, data.removeFactIds, data.removeRoutineIds].some(
      (items) => Array.isArray(items) && items.length,
    )
  )
    fail('Indicare almeno una modifica');
  const before = current
    ? validateBrainKnowledge(current)
    : { version: 1 as const, facts: [], routines: [] };
  const result = structuredClone(before);
  const remove = (key: 'removeFactIds' | 'removeRoutineIds', max: number) =>
    data[key] === undefined ? [] : array(data[key], max).map((id) => text(id, 'ID', 80));
  const factRemovals = remove('removeFactIds', 50),
    routineRemovals = remove('removeRoutineIds', 30);
  result.facts = result.facts.filter((item) => !factRemovals.includes(item.id));
  result.routines = result.routines.filter((item) => !routineRemovals.includes(item.id));
  const seenFacts = new Set<string>(),
    seenRoutines = new Set<string>();
  for (const value of data.facts === undefined ? [] : array(data.facts, 50)) {
    const patch = object(value);
    keys(patch, ['id', 'label', 'value', ...FACT_RELIABILITY]);
    const label = text(patch.label, 'Etichetta', 120),
      content = text(patch.value, 'Valore', 2000);
    const id = patch.id === undefined ? undefined : text(patch.id, 'ID', 80);
    const candidates = result.facts.filter((item) =>
      id ? item.id === id : knowledgeKey(item.label) === knowledgeKey(label),
    );
    if (candidates.length > 1)
      throw new BrainKnowledgeError('Etichetta ambigua: usare ID', 'ambiguous_knowledge', 409);
    const previous = candidates[0];
    if (id && !previous) fail('ID fatto non trovato o già rimosso');
    const identity = previous?.id ?? `label:${knowledgeKey(label)}`;
    if (seenFacts.has(identity)) fail('Fatto ripetuto nello stesso aggiornamento');
    seenFacts.add(identity);
    // A changed value cannot inherit the old source or its confirmation.
    const changedContent = previous && (previous.label !== label || previous.value !== content);
    const metadata = Object.fromEntries(
      FACT_RELIABILITY.filter(
        (key) => patch[key] !== undefined || (!changedContent && previous?.[key] !== undefined),
      ).map((key) => [key, patch[key] !== undefined ? patch[key] : previous?.[key]]),
    );
    const revision = factRevision({
      label,
      value: content,
      updatedAt: previous?.updatedAt ?? now,
      ...metadata,
    });
    if (previous) {
      const { id: previousId, history, ...oldRevision } = previous;
      if (JSON.stringify(oldRevision) !== JSON.stringify(revision)) {
        if ((history?.length ?? 0) >= 100)
          fail('Storico del fatto pieno: conserva lo storico prima di altre modifiche');
        result.facts[result.facts.indexOf(previous)] = {
          id: previousId,
          ...revision,
          updatedAt: now,
          history: [...(history ?? []), oldRevision],
        };
      }
    } else result.facts.push({ id: randomUUID(), ...revision });
  }
  for (const value of data.routines === undefined ? [] : array(data.routines, 30)) {
    const patch = Object.fromEntries(
      Object.entries(object(value)).filter(([, field]) => field !== undefined),
    );
    keys(patch, ROUTINE_FIELDS);
    const id = patch.id === undefined ? undefined : text(patch.id, 'ID', 80);
    const title = patch.title === undefined ? undefined : text(patch.title, 'Titolo');
    const candidates = result.routines.filter((item) =>
      id ? item.id === id : title !== undefined && knowledgeKey(item.title) === knowledgeKey(title),
    );
    if (candidates.length > 1)
      throw new BrainKnowledgeError('Titolo routine ambiguo: usare ID', 'ambiguous_knowledge', 409);
    const previous = candidates[0];
    if (id && !previous) fail('ID routine non trovato o già rimosso');
    if (
      !previous &&
      (!title ||
        !Object.hasOwn(patch, 'days') ||
        !Object.hasOwn(patch, 'timeZone') ||
        !TIMES.some((key) => patch[key] !== undefined && patch[key] !== null))
    )
      fail('Nuova routine: servono titolo, giorni, fuso e almeno un orario');
    const identity = previous?.id ?? `title:${knowledgeKey(title ?? '')}`;
    if (seenRoutines.has(identity)) fail('Routine ripetuta nello stesso aggiornamento');
    seenRoutines.add(identity);
    const exceptions = new Map((previous?.exceptions ?? []).map((item) => [item.date, item]));
    if (patch.exceptions !== undefined) {
      const additions = array(patch.exceptions, 100).map(exception);
      unique(
        additions.map((item) => item.date),
        'Date eccezione',
      );
      for (const item of additions) exceptions.set(item.date, item);
    }
    const merged = routine({
      startTime: null,
      endTime: null,
      dropOffTime: null,
      pickupTime: null,
      homeTime: null,
      place: null,
      notes: null,
      validFrom: null,
      validUntil: null,
      ...previous,
      ...patch,
      id: previous?.id ?? randomUUID(),
      title: title ?? previous?.title,
      updatedAt: previous?.updatedAt ?? now,
      exceptions: [...exceptions.values()],
    });
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(merged)) merged.updatedAt = now;
      result.routines[result.routines.indexOf(previous)] = merged;
    } else result.routines.push(merged);
  }
  return validateBrainKnowledge(result);
}

const CLOSE = '<!-- /ernie:knowledge -->';
const blockHash = (value: string) => createHash('sha256').update(value).digest('hex');
/** Edited generated sections are user content: refuse replacement rather than discard their edits. */
export function stripKnowledgeBody(body: string): string {
  const pattern =
    /<!-- ernie:knowledge ([a-f0-9]{64}) -->\n([\s\S]*?)\n<!-- \/ernie:knowledge -->\n{0,2}/gu;
  let found = false;
  const base = body.replace(pattern, (_match, hash: string, content: string) => {
    found = true;
    if (blockHash(content) !== hash)
      throw new BrainKnowledgeError(
        'La sezione strutturata è stata modificata nel testo: conservare le modifiche prima di aggiornarla',
        'knowledge_render_conflict',
        409,
      );
    return '';
  });
  if ((!found && body.includes('<!-- ernie:knowledge')) || base.includes('<!-- ernie:knowledge'))
    throw new BrainKnowledgeError(
      'Sezione knowledge incompleta nel testo',
      'knowledge_render_conflict',
      409,
    );
  return base;
}
const escapeMarkdown = (value: string) =>
  value.replace(/[\\`*_[\]<>]/gu, '\\$&').replace(/\r?\n/gu, ' ');
const DAY_LABELS = ['lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom'];
const TIME_LABELS = {
  startTime: 'Inizio',
  endTime: 'Fine',
  dropOffTime: 'Accompagnamento',
  pickupTime: 'Ritiro',
  homeTime: 'Rientro a casa previsto',
};
export function renderKnowledgeBody(body: string, knowledge: BrainKnowledge): string {
  const base = stripKnowledgeBody(body);
  if (!knowledge.facts.length && !knowledge.routines.length) return base;
  const lines: string[] = [];
  if (knowledge.facts.length) {
    lines.push('## Informazioni', '');
    for (const fact of knowledge.facts) {
      const status = {
        unverified: 'Da verificare',
        confirmed: 'Confermato da fonte',
        uncertain: 'Da chiarire',
        superseded: 'Superato',
      }[fact.status ?? 'unverified'];
      lines.push(`- **${escapeMarkdown(fact.label)}:** ${escapeMarkdown(fact.value)} — ${status}`);
      if (fact.validFrom || fact.validUntil)
        lines.push(
          `  - Validità: ${fact.validFrom ?? 'inizio non indicato'} → ${fact.validUntil ?? 'fine non indicata'}`,
        );
      if (fact.evidence)
        lines.push(
          `  - Fonte (${fact.evidence.kind}): ${escapeMarkdown(fact.evidence.ref)} — «${escapeMarkdown(fact.evidence.quote)}»`,
        );
      else lines.push('  - Fonte non registrata: non assumere che sia confermato.');
    }
    lines.push(
      'La validità va confrontata con la data richiesta. I fatti superati o fuori validità non descrivono il presente.',
    );
    lines.push('');
  }
  if (knowledge.routines.length) {
    lines.push('## Orari abituali', '');
    for (const item of knowledge.routines) {
      lines.push(
        `### ${escapeMarkdown(item.title)}`,
        '',
        `Giorni: ${item.days.map((day) => DAY_LABELS[day - 1]).join(', ') || 'nessun giorno abituale'} · Fuso: ${escapeMarkdown(item.timeZone)}`,
      );
      for (const key of TIMES) lines.push(`- ${TIME_LABELS[key]}: ${item[key] ?? 'non indicato'}`);
      if (item.place) lines.push(`- Luogo: ${escapeMarkdown(item.place)}`);
      if (item.validFrom || item.validUntil)
        lines.push(
          `- Validità: ${item.validFrom ?? 'inizio non indicato'} → ${item.validUntil ?? 'fine non indicata'}`,
        );
      if (item.notes) lines.push(`- Note: ${escapeMarkdown(item.notes)}`);
      for (const change of item.exceptions) {
        lines.push(
          `- ${change.date}: ${change.status === 'cancelled' ? 'annullata' : 'modificata'}${OPTIONAL.filter(
            (key) => Object.hasOwn(change, key),
          )
            .map(
              (key) =>
                `; ${key in TIME_LABELS ? TIME_LABELS[key as keyof typeof TIME_LABELS] : key === 'place' ? 'Luogo' : 'Note'}: ${change[key] === null ? 'non indicato' : escapeMarkdown(change[key] ?? '')}`,
            )
            .join('')}`,
        );
      }
      lines.push('');
    }
    lines.push('Il rientro è previsto; questi orari non indicano una posizione verificata.', '');
  }
  const content = lines.join('\n').trimEnd();
  const block = `<!-- ernie:knowledge ${blockHash(content)} -->\n${content}\n${CLOSE}\n`;
  const heading = /^(# [^\n]+\n)(?:\n)?/u.exec(base);
  return heading ? `${heading[0]}${block}\n${base.slice(heading[0].length)}` : `${block}\n${base}`;
}

export function calculateBrainAgenda(
  notes: ReadonlyArray<{ path: string; title: string; knowledge?: BrainKnowledge }>,
  input: { date: string; timeZone: string },
): BrainAgenda {
  const date = validKnowledgeDate(input.date),
    timeZone = validKnowledgeTimeZone(input.timeZone);
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
  const entries: BrainAgendaEntry[] = [];
  const subjects = notes
    .filter((note) => note.knowledge?.routines.length)
    .map((note) => ({ path: note.path, title: note.title }));
  for (const note of notes)
    for (const item of note.knowledge?.routines ?? []) {
      if ((item.validFrom && date < item.validFrom) || (item.validUntil && date > item.validUntil))
        continue;
      const change = item.exceptions.find((entry) => entry.date === date);
      if (!change && !item.days.includes(weekday)) continue;
      const effective = effectiveRoutine(item, change);
      entries.push({
        notePath: note.path,
        noteTitle: note.title,
        routineId: item.id,
        title: item.title,
        timeZone: item.timeZone,
        status: change?.status === 'cancelled' ? 'cancelled' : 'planned',
        startTime: effective.startTime,
        endTime: effective.endTime,
        dropOffTime: effective.dropOffTime,
        pickupTime: effective.pickupTime,
        homeTime: effective.homeTime,
        place: effective.place,
        notes: effective.notes,
      });
    }
  const firstTime = (entry: BrainAgendaEntry) =>
    TIMES.map((key) => entry[key])
      .filter((value): value is string => value !== null)
      .sort()[0] ?? '99:99';
  entries.sort(
    (a, b) =>
      firstTime(a).localeCompare(firstTime(b)) ||
      a.noteTitle.localeCompare(b.noteTitle, 'it') ||
      a.title.localeCompare(b.title, 'it') ||
      a.routineId.localeCompare(b.routineId),
  );
  subjects.sort((a, b) => a.title.localeCompare(b.title, 'it') || a.path.localeCompare(b.path));
  return { date, timeZone, entries, subjects };
}
