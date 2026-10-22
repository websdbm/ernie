import { type Pool, withUser } from '@ernie/db';
import { z } from 'zod';

/**
 * Scheda anagrafica dell'utente (richiesta dell'utente, 13 ott 2026): nome, come vuole essere chiamato, data di
 * nascita, genere, dove vive, lavoro, famiglia. Si riempie da sola mentre le informazioni emergono in chat (stessa
 * chiamata del consolidamento della memoria, nessun costo in più) e si corregge dall'app. Ha un ruolo privilegiato:
 * sta in cima al prefisso stabile e, in caso di contrasto, prevale sui fatti sparsi della memoria. Quello che
 * l'utente scrive nell'app non viene mai sovrascritto dalle conversazioni.
 */

export const PROFILE_FIELDS = [
  'fullName',
  'preferredName',
  'birthDate',
  'gender',
  'city',
  'occupation',
  'email',
] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

export const PROFILE_LIMITS: Record<ProfileField, number> = {
  fullName: 80,
  preferredName: 40,
  birthDate: 10,
  gender: 30,
  city: 60,
  occupation: 80,
  email: 120,
};

export const PROFILE_LABELS: Record<ProfileField, string> = {
  fullName: 'nome',
  preferredName: 'come vuole essere chiamato',
  birthDate: 'data di nascita',
  gender: 'genere',
  city: 'dove vive',
  occupation: 'lavoro',
  email: 'email',
};

export type ProfileSource = 'conversation' | 'user';

export const SourceMeta = z.object({
  source: z.enum(['conversation', 'user']),
  at: z.string(),
  /** Parole della persona da cui viene il dato (solo per quelli emersi in chat). */
  quote: z.string().max(200).optional(),
});
export type SourceMeta = z.infer<typeof SourceMeta>;

export const FamilyMember = z.object({
  id: z.string().min(1).max(40),
  name: z.string().max(60).optional(),
  relation: z.string().min(1).max(40),
  birthDate: z.string().max(10).optional(),
  notes: z.string().max(120).optional(),
  meta: SourceMeta,
});
export type FamilyMember = z.infer<typeof FamilyMember>;

/**
 * Luogo della persona (15 ott 2026): «casa», «lavoro», «palestra»… con indirizzo e posizione. Serve ai promemoria
 * geolocalizzati («ricordami … quando arrivo a casa»). L'indirizzo può arrivare dalla chat senza coordinate: le
 * aggiunge il telefono (geocodifica sul dispositivo) o l'utente sulla mappa.
 */
export const Place = z.object({
  id: z.string().min(1).max(40),
  label: z.string().min(1).max(40),
  address: z.string().max(160).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  /** Raggio della zona in metri (100–1000; senza: 150). */
  radius: z.number().int().min(50).max(2000).optional(),
  meta: SourceMeta,
});
export type Place = z.infer<typeof Place>;

export const PLACE_RADIUS_DEFAULT = 150;
export const MAX_PLACES = 10;

/** Etichetta di un luogo in forma breve e confrontabile: «Casa mia» → «casa», «il mio ufficio» → «ufficio». */
export function normalizePlaceLabel(label: string | null | undefined): string | undefined {
  if (typeof label !== 'string') return undefined;
  const t = label
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/^(?:(?:la|il|lo|i|le|gli)\s+|l['’]\s*)/u, '')
    .replace(/^(?:mia|mio|nostra|nostro)\s+/u, '')
    .replace(/\s+(?:mia|mio|nostra|nostro)$/u, '')
    .replace(/^(?:(?:la|il|lo)\s+|l['’]\s*)/u, '')
    .trim();
  if (!t || PLACEHOLDER.test(t)) return undefined;
  return t.slice(0, 40);
}

export const UserProfile = z.object({
  fullName: z.string().max(80).optional(),
  preferredName: z.string().max(40).optional(),
  birthDate: z.string().max(10).optional(),
  gender: z.string().max(30).optional(),
  city: z.string().max(60).optional(),
  occupation: z.string().max(80).optional(),
  /** Indirizzo per le email dei promemoria (unica fonte; le impostazioni la ricopiano). */
  email: z.string().max(120).optional(),
  family: z.array(FamilyMember).max(20).default([]),
  places: z.array(Place).max(MAX_PLACES).default([]),
  meta: z.record(z.string(), SourceMeta).default({}),
});
export type UserProfile = z.infer<typeof UserProfile>;

export const emptyProfile = (): UserProfile => ({ family: [], places: [], meta: {} });

/** Proposta di aggiornamento (dall'estrattore o dall'app): campi assenti o null = nessuna informazione. */
export interface ProfileUpdate {
  readonly fullName?: string | null | undefined;
  readonly preferredName?: string | null | undefined;
  readonly birthDate?: string | null | undefined;
  readonly gender?: string | null | undefined;
  readonly city?: string | null | undefined;
  readonly occupation?: string | null | undefined;
  readonly email?: string | null | undefined;
  readonly family?:
    | ReadonlyArray<{
        readonly name?: string | null | undefined;
        readonly relation?: string | null | undefined;
        readonly birthDate?: string | null | undefined;
        readonly notes?: string | null | undefined;
      }>
    | null
    | undefined;
  /** Luoghi detti in chat («casa mia è in via Roma 3»): etichetta e indirizzo, senza coordinate. */
  readonly places?:
    | ReadonlyArray<{
        readonly label?: string | null | undefined;
        readonly address?: string | null | undefined;
      }>
    | null
    | undefined;
}

export interface ProfileChange {
  readonly field: string;
  readonly before: string | null;
  readonly after: string | null;
  /** Detto in chat ma non applicato: il dato nella scheda l'ha scritto l'utente nell'app. Si chiede a lui. */
  readonly conflict?: true;
}

const PLACEHOLDER = /^(null|none|nessun[oa]?|sconosciut[oa]|non (lo )?so|n\/?a|-|\?)$/iu;

function clean(v: string | null | undefined, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.replace(/\s+/g, ' ').trim();
  if (!t || PLACEHOLDER.test(t)) return undefined;
  return t.length > max ? t.slice(0, max).trimEnd() : t;
}

/**
 * Data di nascita: `YYYY-MM-DD` (anno tra 1900 e oggi) oppure `--MM-DD` se l'anno non è noto
 * («compio gli anni il 3 maggio»). Qualunque altra forma viene scartata.
 */
export function normalizeBirthDate(
  v: string | null | undefined,
  now = new Date(),
): string | undefined {
  const t = typeof v === 'string' ? v.trim() : '';
  const full = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  const partial = /^--(\d{2})-(\d{2})$/.exec(t);
  const valid = (y: number, m: number, d: number) => {
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  };
  if (full) {
    const [y, m, d] = [Number(full[1]), Number(full[2]), Number(full[3])];
    if (y < 1900 || y > now.getUTCFullYear() || !valid(y, m, d)) return undefined;
    if (new Date(Date.UTC(y, m - 1, d)) > now) return undefined;
    return t;
  }
  if (partial) {
    const [m, d] = [Number(partial[1]), Number(partial[2])];
    return valid(2000, m, d) ? t : undefined;
  }
  return undefined;
}

/** Email valida in minuscolo, altrimenti undefined (un indirizzo sbagliato non deve finire nella scheda). */
export function normalizeEmail(v: string | null | undefined): string | undefined {
  const t =
    typeof v === 'string'
      ? v
          .trim()
          .toLowerCase()
          .replace(/^mailto:/, '')
      : '';
  return /^[^\s@<>(),;:]+@[^\s@<>(),;:]+\.[a-z]{2,}$/.test(t) && t.length <= 120 ? t : undefined;
}

function normalizeField(
  field: ProfileField,
  raw: string | null | undefined,
  now: Date,
): string | undefined {
  if (field === 'birthDate') return normalizeBirthDate(raw, now);
  if (field === 'email') return normalizeEmail(raw);
  return clean(raw, PROFILE_LIMITS[field]);
}

const fold = (s: string | undefined) =>
  (s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

const newId = () => Math.random().toString(36).slice(2, 10);

/** Un dato inserito dall'utente nell'app non si tocca dalle conversazioni. */
const lockedByUser = (meta: SourceMeta | undefined, source: ProfileSource) =>
  source === 'conversation' && meta?.source === 'user';

/** La data parziale (`--MM-DD`) non sostituisce una completa compatibile. */
function birthDateWins(before: string | undefined, after: string): boolean {
  if (!before) return true;
  if (after.startsWith('--') && !before.startsWith('--')) return before.slice(4) !== after.slice(1);
  return before !== after;
}

/**
 * Fonde una proposta nella scheda. Deterministico e puro: restituisce la scheda nuova e l'elenco dei cambiamenti.
 * Regole: i campi vuoti si riempiono; un dato detto in chat sostituisce uno detto in chat (la persona si è corretta);
 * niente sostituisce dalla chat un dato scritto dall'utente nell'app. Famiglia: si riconosce per nome (senza
 * accenti e maiuscole) o, senza nome, per relazione; dalla chat si aggiunge o si completa, mai si toglie.
 */
export function mergeProfile(
  current: UserProfile,
  update: ProfileUpdate,
  opts: { source: ProfileSource; at: Date; quote?: string; now?: Date },
): { profile: UserProfile; changes: ProfileChange[]; conflicts: ProfileChange[] } {
  const now = opts.now ?? opts.at;
  const meta: SourceMeta = {
    source: opts.source,
    at: opts.at.toISOString(),
    ...(opts.quote ? { quote: opts.quote.slice(0, 200) } : {}),
  };
  const next: UserProfile = {
    ...current,
    family: current.family.map((m) => ({ ...m })),
    places: current.places.map((p) => ({ ...p })),
    meta: { ...current.meta },
  };
  const changes: ProfileChange[] = [];
  const conflicts: ProfileChange[] = [];

  for (const proposal of update.places ?? []) {
    const label = normalizePlaceLabel(proposal.label);
    const address = clean(proposal.address, 160);
    if (!label || !address) continue;
    const existing = next.places.find((p) => p.label === label);
    if (existing && fold(existing.address) === fold(address)) continue;
    if (existing && lockedByUser(existing.meta, opts.source)) {
      conflicts.push({
        field: 'places',
        before: describePlace(existing),
        after: `${label}: ${address}`,
        conflict: true,
      });
      continue;
    }
    const before = existing ? describePlace(existing) : null;
    const place = upsertPlace(next, { label, address }, meta);
    if (place) changes.push({ field: 'places', before, after: describePlace(place) });
  }

  for (const field of PROFILE_FIELDS) {
    const raw = update[field];
    const value = normalizeField(field, raw, now);
    if (value === undefined) continue;
    const before = current[field];
    const differs =
      field === 'birthDate' ? birthDateWins(before, value) : fold(before) !== fold(value);
    if (!differs) continue;
    if (lockedByUser(current.meta[field], opts.source)) {
      conflicts.push({ field, before: before ?? null, after: value, conflict: true });
      continue;
    }
    next[field] = value;
    next.meta[field] = meta;
    changes.push({ field, before: before ?? null, after: value });
  }

  for (const proposal of update.family ?? []) {
    const name = clean(proposal.name, 60);
    const relation = clean(proposal.relation, 40);
    if (!relation && !name) continue;
    const birthDate = normalizeBirthDate(proposal.birthDate, now);
    const notes = clean(proposal.notes, 120);
    const existing = next.family.find((m) =>
      name ? fold(m.name) === fold(name) : !m.name && fold(m.relation) === fold(relation),
    );
    if (!existing) {
      if (!relation || next.family.length >= 20) continue;
      const member: FamilyMember = {
        id: newId(),
        relation,
        ...(name ? { name } : {}),
        ...(birthDate ? { birthDate } : {}),
        ...(notes ? { notes } : {}),
        meta,
      };
      next.family.push(member);
      changes.push({
        field: 'family',
        before: null,
        after: describeMember(member),
      });
      continue;
    }
    if (lockedByUser(existing.meta, opts.source)) continue;
    const before = describeMember(existing);
    let touched = false;
    if (relation && fold(existing.relation) !== fold(relation)) {
      existing.relation = relation;
      touched = true;
    }
    if (birthDate && birthDateWins(existing.birthDate, birthDate)) {
      existing.birthDate = birthDate;
      touched = true;
    }
    if (notes && fold(existing.notes) !== fold(notes)) {
      existing.notes = notes;
      touched = true;
    }
    if (touched) {
      existing.meta = meta;
      changes.push({ field: 'family', before, after: describeMember(existing) });
    }
  }
  return { profile: next, changes, conflicts };
}

/**
 * Scheda modificata dall'utente nell'app: sostituisce tutto (campi e famiglia), con provenienza «user»
 * solo per ciò che è cambiato; il resto conserva la provenienza che aveva.
 */
export function replaceProfileByUser(
  current: UserProfile,
  edited: {
    fields: Partial<Record<ProfileField, string | null | undefined>>;
    family: ReadonlyArray<{
      id?: string | undefined;
      name?: string | null | undefined;
      relation: string;
      birthDate?: string | null | undefined;
      notes?: string | null | undefined;
    }>;
    /** Assente (app vecchia): i luoghi restano com'erano. */
    places?:
      | ReadonlyArray<{
          id?: string | undefined;
          label: string;
          address?: string | null | undefined;
          lat?: number | null | undefined;
          lng?: number | null | undefined;
          radius?: number | null | undefined;
        }>
      | undefined;
  },
  at: Date,
): { profile: UserProfile; changes: ProfileChange[] } {
  const meta: SourceMeta = { source: 'user', at: at.toISOString() };
  const next: UserProfile = { family: [], places: [], meta: {} };
  const changes: ProfileChange[] = [];
  for (const field of PROFILE_FIELDS) {
    const value = normalizeField(field, edited.fields[field], at);
    const before = current[field];
    if (value) next[field] = value;
    const same = (before ?? '') === (value ?? '');
    const keptMeta = current.meta[field];
    if (same) {
      if (value && keptMeta) next.meta[field] = keptMeta;
    } else {
      if (value) next.meta[field] = meta;
      changes.push({ field, before: before ?? null, after: value ?? null });
    }
  }
  const byId = new Map(current.family.map((m) => [m.id, m]));
  for (const e of edited.family.slice(0, 20)) {
    const relation = clean(e.relation, 40);
    if (!relation) continue;
    const name = clean(e.name, 60);
    const birthDate = normalizeBirthDate(e.birthDate, at);
    const notes = clean(e.notes, 120);
    const old = e.id ? byId.get(e.id) : undefined;
    const draft = {
      id: old?.id ?? newId(),
      relation,
      ...(name ? { name } : {}),
      ...(birthDate ? { birthDate } : {}),
      ...(notes ? { notes } : {}),
    };
    const same =
      old &&
      old.relation === draft.relation &&
      old.name === draft.name &&
      old.birthDate === draft.birthDate &&
      old.notes === draft.notes;
    const member: FamilyMember = { ...draft, meta: same && old ? old.meta : meta };
    next.family.push(member);
    if (!same)
      changes.push({
        field: 'family',
        before: old ? describeMember(old) : null,
        after: describeMember(member),
      });
    if (old) byId.delete(old.id);
  }
  for (const removed of byId.values())
    changes.push({ field: 'family', before: describeMember(removed), after: null });
  if (!edited.places) next.places = current.places.map((p) => ({ ...p }));
  else {
    const placesById = new Map(current.places.map((p) => [p.id, p]));
    const seen = new Set<string>();
    for (const e of edited.places.slice(0, MAX_PLACES)) {
      const label = normalizePlaceLabel(e.label);
      if (!label || seen.has(label)) continue;
      seen.add(label);
      const old = e.id ? placesById.get(e.id) : undefined;
      const address = clean(e.address, 160);
      const coords =
        typeof e.lat === 'number' && typeof e.lng === 'number' && validCoords(e.lat, e.lng)
          ? { lat: e.lat, lng: e.lng }
          : {};
      const radius = typeof e.radius === 'number' ? clampRadius(e.radius) : undefined;
      const draft = {
        id: old?.id ?? newId(),
        label,
        ...(address ? { address } : {}),
        ...coords,
        ...(radius ? { radius } : {}),
      };
      const same =
        old &&
        old.label === draft.label &&
        old.address === draft.address &&
        old.lat === draft.lat &&
        old.lng === draft.lng &&
        old.radius === draft.radius;
      const place: Place = { ...draft, meta: same && old ? old.meta : meta };
      next.places.push(place);
      if (!same)
        changes.push({
          field: 'places',
          before: old ? describePlace(old) : null,
          after: describePlace(place),
        });
      if (old) placesById.delete(old.id);
    }
    for (const removed of placesById.values())
      changes.push({ field: 'places', before: describePlace(removed), after: null });
  }
  return { profile: next, changes };
}

const validCoords = (lat: number, lng: number) =>
  Number.isFinite(lat) &&
  Number.isFinite(lng) &&
  Math.abs(lat) <= 90 &&
  Math.abs(lng) <= 180 &&
  !(lat === 0 && lng === 0);

const clampRadius = (r: number) => Math.round(Math.min(1000, Math.max(100, r)));

/** Luogo per etichetta («casa», «Casa mia», «il lavoro»). */
export function findPlace(profile: UserProfile, label: string): Place | undefined {
  const wanted = normalizePlaceLabel(label);
  if (!wanted) return undefined;
  return (
    profile.places.find((p) => p.label === wanted) ??
    // «ufficio» e «lavoro» indicano di solito lo stesso posto.
    (wanted === 'ufficio' || wanted === 'lavoro'
      ? profile.places.find((p) => p.label === (wanted === 'ufficio' ? 'lavoro' : 'ufficio'))
      : undefined)
  );
}

/**
 * Crea o aggiorna un luogo con un indirizzo (dalla chat o dal tool `place_set`): un indirizzo nuovo cancella le
 * coordinate vecchie, che il telefono ricalcola. Modifica `profile` sul posto; null se i luoghi sono già al massimo.
 */
export function upsertPlace(
  profile: UserProfile,
  input: { label: string; address: string },
  meta: SourceMeta,
): Place | null {
  const label = normalizePlaceLabel(input.label);
  const address = clean(input.address, 160);
  if (!label || !address) return null;
  const i = profile.places.findIndex((p) => p.label === label);
  const old = i >= 0 ? profile.places[i] : undefined;
  if (!old && profile.places.length >= MAX_PLACES) return null;
  const place: Place = {
    id: old?.id ?? newId(),
    label,
    address,
    ...(old?.radius ? { radius: old.radius } : {}),
    meta,
  };
  if (i >= 0) profile.places[i] = place;
  else profile.places.push(place);
  return place;
}

/**
 * «Salva questo posto come palestra»: luogo con la posizione del telefono (senza indirizzo, o con quello detto). Se il
 * nome esiste già lo sposta qui. La zona tiene conto della precisione della posizione (almeno 150 m, al più 500).
 */
export function placeHere(
  profile: UserProfile,
  input: { label: string; lat: number; lng: number; accuracyM?: number | undefined },
  meta: SourceMeta,
): Place | null {
  const label = normalizePlaceLabel(input.label);
  if (!label || !validCoords(input.lat, input.lng)) return null;
  const i = profile.places.findIndex((p) => p.label === label);
  const old = i >= 0 ? profile.places[i] : undefined;
  if (!old && profile.places.length >= MAX_PLACES) return null;
  const fromAccuracy =
    input.accuracyM !== undefined && input.accuracyM > 100
      ? Math.min(500, Math.ceil((input.accuracyM * 1.5) / 50) * 50)
      : undefined;
  const radius = fromAccuracy ?? old?.radius;
  const place: Place = {
    id: old?.id ?? newId(),
    label,
    lat: input.lat,
    lng: input.lng,
    ...(radius ? { radius } : {}),
    meta,
  };
  if (i >= 0) profile.places[i] = place;
  else profile.places.push(place);
  return place;
}

/**
 * «Rinomina dentista in studio Rossi»: cambia il nome di un luogo (posizione e indirizzo restano). Errore se il luogo
 * non c'è o se il nome nuovo è già di un altro luogo.
 */
export function renamePlace(
  current: UserProfile,
  from: string,
  to: string,
  meta: SourceMeta,
):
  | { ok: true; profile: UserProfile; from: string; to: string; change: ProfileChange }
  | { ok: false; reason: 'missing' | 'taken' | 'invalid' } {
  const place = findPlace(current, from);
  const label = normalizePlaceLabel(to);
  if (!label) return { ok: false, reason: 'invalid' };
  if (!place) return { ok: false, reason: 'missing' };
  if (label === place.label) return { ok: false, reason: 'invalid' };
  if (current.places.some((p) => p.label === label && p.id !== place.id))
    return { ok: false, reason: 'taken' };
  const renamed: Place = { ...place, label, meta };
  return {
    ok: true,
    profile: { ...current, places: current.places.map((p) => (p.id === place.id ? renamed : p)) },
    from: place.label,
    to: label,
    change: { field: 'places', before: describePlace(place), after: describePlace(renamed) },
  };
}

/**
 * Coordinate trovate dal telefono per un indirizzo detto in chat (o corrette): la provenienza resta quella del luogo.
 * Nessun cambiamento se il luogo non c'è o le coordinate non sono valide.
 */
export function setPlaceCoordinates(
  current: UserProfile,
  id: string,
  coords: { lat: number; lng: number; address?: string | undefined },
): { profile: UserProfile; changes: ProfileChange[] } {
  const place = current.places.find((p) => p.id === id);
  if (!place || !validCoords(coords.lat, coords.lng)) return { profile: current, changes: [] };
  const address = clean(coords.address, 160) ?? place.address;
  const updated: Place = {
    ...place,
    lat: coords.lat,
    lng: coords.lng,
    ...(address ? { address } : {}),
  };
  const next: UserProfile = {
    ...current,
    places: current.places.map((p) => (p.id === id ? updated : p)),
  };
  return {
    profile: next,
    changes: [{ field: 'places', before: describePlace(place), after: describePlace(updated) }],
  };
}

/** «casa: via Roma 3, Treviso» (con «posizione da confermare» se mancano le coordinate). */
export function describePlace(p: Pick<Place, 'label' | 'address' | 'lat' | 'lng'>): string {
  const where =
    p.address ?? (p.lat !== undefined ? 'posizione sulla mappa' : 'indirizzo da indicare');
  return `${p.label}: ${where}`;
}

const MONTHS = [
  'gennaio',
  'febbraio',
  'marzo',
  'aprile',
  'maggio',
  'giugno',
  'luglio',
  'agosto',
  'settembre',
  'ottobre',
  'novembre',
  'dicembre',
];

/** «3 maggio 1975 (50 anni)» oppure «3 maggio» se l'anno non è noto. */
export function describeBirthDate(v: string, now = new Date()): string {
  const partial = v.startsWith('--');
  const [y, m, d] = partial
    ? [null, Number(v.slice(2, 4)), Number(v.slice(5, 7))]
    : [Number(v.slice(0, 4)), Number(v.slice(5, 7)), Number(v.slice(8, 10))];
  const day = `${d} ${MONTHS[m - 1] ?? ''}`.trim();
  if (y === null) return day;
  let age = now.getUTCFullYear() - y;
  const birthdayPassed =
    now.getUTCMonth() + 1 > m || (now.getUTCMonth() + 1 === m && now.getUTCDate() >= d);
  if (!birthdayPassed) age -= 1;
  return `${day} ${y} (${age} ${age === 1 ? 'anno' : 'anni'})`;
}

const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

/** «Nato», «Nata» o «Nato/a» dal genere dichiarato o dalla relazione (figlia, moglie, madre…). */
export function bornWord(hint: string | undefined): string {
  const h = fold(hint);
  if (
    /\b(donna|femmin|figlia|moglie|madre|mamma|sorella|nonna|compagna|zia|cugina|nipote femmina)\b/.test(
      h,
    )
  )
    return 'Nata';
  if (/\b(uomo|maschi|figlio|marito|padre|papa|fratello|nonno|compagno|zio|cugino)\b/.test(h))
    return 'Nato';
  return 'Nato/a';
}

export function describeMember(
  m: Pick<FamilyMember, 'name' | 'relation' | 'birthDate' | 'notes'>,
  now = new Date(),
): string {
  const born = `${bornWord(m.relation).toLowerCase()} il`;
  const extra = [
    m.birthDate ? `${born} ${describeBirthDate(m.birthDate, now)}` : null,
    m.notes ? lowerFirst(m.notes) : null,
  ]
    .filter(Boolean)
    .join(', ');
  const who = m.name ? `${m.name} (${m.relation})` : m.relation;
  return extra ? `${who}, ${extra}` : who;
}

/**
 * Testo della scheda per il prefisso stabile della sessione (cambia solo quando cambia la scheda; l'età al più
 * una volta al giorno). Vuoto se non c'è ancora nulla.
 */
export function renderProfile(
  profile: UserProfile,
  now = new Date(),
  audience: 'agent' | 'user' = 'agent',
): string {
  const lines: string[] = [];
  if (profile.fullName || profile.preferredName) {
    const name = profile.fullName ? `Nome: ${profile.fullName}` : 'Nome: non ancora noto';
    const call = profile.preferredName
      ? audience === 'agent'
        ? `; vuole essere chiamato «${profile.preferredName}»: usa questo nome quando ti rivolgi a questa persona`
        : ` (ti chiamo «${profile.preferredName}»)`
      : '';
    lines.push(`${name}${call}`);
  }
  if (profile.birthDate)
    lines.push(`${bornWord(profile.gender)} il ${describeBirthDate(profile.birthDate, now)}`);
  if (profile.gender) lines.push(`Genere: ${profile.gender}`);
  if (profile.city) lines.push(`Vive a: ${profile.city}`);
  if (profile.occupation) lines.push(`Lavoro: ${profile.occupation}`);
  if (profile.email) lines.push(`Email: ${profile.email}`);
  if (profile.family.length)
    lines.push(`Famiglia: ${profile.family.map((m) => describeMember(m, now)).join('; ')}`);
  if (profile.places.length)
    lines.push(`Luoghi: ${profile.places.map((p) => describePlace(p)).join('; ')}`);
  if (!lines.length) return '';
  if (audience === 'user') return lines.map((l) => `- ${l}`).join('\n');
  return [
    'Scheda dell’utente (dati anagrafici: in caso di contrasto prevalgono sulle memorie):',
    ...lines.map((l) => `- ${l}`),
  ].join('\n');
}

/** Riepilogo dei cambiamenti in una riga, per gli avvisi e per l'app. */
export function describeChange(c: ProfileChange): string {
  const label =
    c.field === 'family'
      ? 'famiglia'
      : c.field === 'places'
        ? 'luoghi'
        : (PROFILE_LABELS[c.field as ProfileField] ?? c.field);
  const show = (v: string | null) =>
    v && c.field === 'birthDate' ? describeBirthDate(v) : (v ?? '');
  if (c.conflict)
    return `${label}: in chat ha detto «${show(c.after)}», ma nella scheda c'è «${show(c.before)}» scritto da lui nell'app`;
  if (c.before && c.after) return `${label}: ${show(c.before)} → ${show(c.after)}`;
  if (c.after) return `${label}: ${show(c.after)}`;
  return `${label}: tolto ${show(c.before)}`;
}

// ---------- archivio ----------

export interface ProfileNotice {
  readonly id: string;
  readonly changes: ProfileChange[];
  readonly at: Date;
}

/** Unione già autorizzata nel Brain: identità esatte, mai somiglianze fra nomi. */
export function consolidateFamily(
  current: UserProfile,
  into: string,
  aliases: readonly string[],
): { profile: UserProfile; changes: ProfileChange[]; question: string | null } {
  const key = (s: string) => s.trim().toLocaleLowerCase('it');
  const names = new Set([into, ...aliases].map(key));
  const members = current.family.filter((m) => m.name && names.has(key(m.name)));
  const unchanged = (question: string | null = null) => ({
    profile: current,
    changes: [],
    question,
  });
  if (!members.length || (members.length === 1 && members[0]?.name === into)) return unchanged();
  const unique = (values: (string | undefined)[]) => [...new Set(values.filter(Boolean))];
  // Due persone con lo stesso nome nella scheda non sono automaticamente la stessa persona.
  if (
    new Set(members.map((m) => key(m.name ?? ''))).size !== members.length ||
    unique(members.map((m) => key(m.relation))).length > 1 ||
    unique(members.map((m) => m.birthDate)).length > 1
  )
    return unchanged(
      `Le schede unite in «${into}» hanno dati anagrafici discordanti: quali sono corretti?`,
    );
  const target = members.find((m) => key(m.name ?? '') === key(into)) ?? members[0];
  if (!target) return unchanged();
  const notes = unique(members.map((m) => m.notes)).join('; ');
  if (into.length > 60 || notes.length > 120)
    return unchanged(
      `Come vuoi sintetizzare i dati della scheda anagrafica di «${into}»? Le note complete restano nel Second Brain.`,
    );
  const merged: FamilyMember = {
    ...target,
    name: into,
    ...(members.find((m) => m.birthDate)?.birthDate
      ? { birthDate: members.find((m) => m.birthDate)?.birthDate }
      : {}),
    ...(notes ? { notes } : {}),
  };
  const ids = new Set(members.map((m) => m.id));
  return {
    profile: {
      ...current,
      family: current.family.flatMap((m) =>
        m.id === target.id ? [merged] : ids.has(m.id) ? [] : [m],
      ),
    },
    changes: [
      { field: 'family', before: JSON.stringify(members), after: JSON.stringify([merged]) },
    ],
    question: null,
  };
}

export interface ProfileStore {
  /** Operazione mirata sotto lock SQL: conserva campi concorrenti e cronologia. */
  consolidateFamily(
    userId: string,
    into: string,
    aliases: readonly string[],
  ): Promise<{ changed: boolean; question: string | null }>;

  get(userId: string): Promise<UserProfile>;
  /** Salva scheda e revisione nella stessa transazione; nessun cambiamento = nessuna scrittura. */
  save(
    userId: string,
    profile: UserProfile,
    changes: readonly ProfileChange[],
    source: ProfileSource,
  ): Promise<void>;
  /** Dati detti in chat che contrastano con quelli scritti dall'utente: solo un avviso, la scheda non cambia. */
  recordConflicts(userId: string, conflicts: readonly ProfileChange[]): Promise<void>;
  /** Cambiamenti emersi in chat non ancora comunicati all'utente. */
  pendingNotices(userId: string, limit?: number): Promise<ProfileNotice[]>;
  markNotified(userId: string, ids: readonly string[]): Promise<void>;
}

export function createProfileStore(pool: Pool): ProfileStore {
  return {
    async consolidateFamily(userId, into, aliases) {
      return withUser(pool, userId, async (c) => {
        const row = await c.query<{ data: unknown }>(
          'SELECT data FROM user_profiles WHERE user_id = $1 FOR UPDATE',
          [userId],
        );
        if (!row.rows[0]) return { changed: false, question: null };
        const result = consolidateFamily(UserProfile.parse(row.rows[0].data), into, aliases);
        if (result.changes.length) {
          await c.query(
            'UPDATE user_profiles SET data = $2, version = version + 1, updated_at = now() WHERE user_id = $1',
            [userId, JSON.stringify(result.profile)],
          );
          await c.query(
            "INSERT INTO user_profile_revisions (user_id, changes, source, notified_at) VALUES ($1, $2, 'user', now())",
            [userId, JSON.stringify(result.changes)],
          );
        }
        return { changed: result.changes.length > 0, question: result.question };
      });
    },
    async get(userId) {
      return withUser(pool, userId, async (c) => {
        const r = await c.query<{ data: unknown }>(
          `SELECT data FROM user_profiles WHERE user_id = $1`,
          [userId],
        );
        const parsed = UserProfile.safeParse(r.rows[0]?.data ?? {});
        return parsed.success ? parsed.data : emptyProfile();
      });
    },
    async save(userId, profile, changes, source) {
      if (!changes.length) return;
      const data = UserProfile.parse(profile);
      await withUser(pool, userId, async (c) => {
        await c.query(
          `INSERT INTO user_profiles (user_id, data) VALUES ($1, $2)
           ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, version = user_profiles.version + 1, updated_at = now()`,
          [userId, JSON.stringify(data)],
        );
        await c.query(
          `INSERT INTO user_profile_revisions (user_id, changes, source, notified_at)
           VALUES ($1, $2, $3, CASE WHEN $3 = 'user' THEN now() ELSE NULL END)`,
          [userId, JSON.stringify(changes), source],
        );
        // L'email della scheda è quella delle notifiche: le impostazioni la ricopiano (l'invio legge da lì).
        if (changes.some((ch) => ch.field === 'email'))
          await c.query(
            `UPDATE users SET settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('email', $2::text) WHERE id = $1`,
            [userId, data.email ?? ''],
          );
      });
    },
    async recordConflicts(userId, conflicts) {
      if (!conflicts.length) return;
      await withUser(pool, userId, (c) =>
        c.query(
          `INSERT INTO user_profile_revisions (user_id, changes, source) VALUES ($1, $2, 'conversation')`,
          [userId, JSON.stringify(conflicts)],
        ),
      );
    },
    async pendingNotices(userId, limit = 5) {
      return withUser(pool, userId, async (c) => {
        const r = await c.query<{ id: string; changes: ProfileChange[]; created_at: Date }>(
          `SELECT id::text, changes, created_at FROM user_profile_revisions
            WHERE notified_at IS NULL ORDER BY created_at LIMIT $1`,
          [limit],
        );
        return r.rows.map((row) => ({ id: row.id, changes: row.changes, at: row.created_at }));
      });
    },
    async markNotified(userId, ids) {
      if (!ids.length) return;
      await withUser(pool, userId, (c) =>
        c.query(
          `UPDATE user_profile_revisions SET notified_at = now() WHERE id = ANY($1::bigint[]) AND notified_at IS NULL`,
          [ids],
        ),
      );
    },
  };
}

/** In memoria, per i test. */
export function memoryProfileStore(): ProfileStore & {
  revisions: Array<{
    userId: string;
    changes: readonly ProfileChange[];
    source: ProfileSource;
    notified: boolean;
    id: string;
  }>;
} {
  const data = new Map<string, UserProfile>();
  const revisions: Array<{
    userId: string;
    changes: readonly ProfileChange[];
    source: ProfileSource;
    notified: boolean;
    id: string;
  }> = [];
  return {
    revisions,
    async consolidateFamily(userId, into, aliases) {
      const result = consolidateFamily(data.get(userId) ?? emptyProfile(), into, aliases);
      if (result.changes.length) {
        data.set(userId, UserProfile.parse(structuredClone(result.profile)));
        revisions.push({
          userId,
          changes: result.changes,
          source: 'user',
          notified: true,
          id: String(revisions.length + 1),
        });
      }
      return { changed: result.changes.length > 0, question: result.question };
    },
    async get(userId) {
      return structuredClone(data.get(userId) ?? emptyProfile());
    },
    async save(userId, profile, changes, source) {
      if (!changes.length) return;
      data.set(userId, UserProfile.parse(structuredClone(profile)));
      revisions.push({
        userId,
        changes,
        source,
        notified: source === 'user',
        id: String(revisions.length + 1),
      });
    },
    async recordConflicts(userId, conflicts) {
      if (!conflicts.length) return;
      revisions.push({
        userId,
        changes: conflicts,
        source: 'conversation',
        notified: false,
        id: String(revisions.length + 1),
      });
    },
    async pendingNotices(userId, limit = 5) {
      return revisions
        .filter((r) => r.userId === userId && !r.notified)
        .slice(0, limit)
        .map((r) => ({ id: r.id, changes: [...r.changes], at: new Date() }));
    },
    async markNotified(_userId, ids) {
      for (const r of revisions) if (ids.includes(r.id)) r.notified = true;
    },
  };
}

/** Avvisi dei cambiamenti emersi in chat, da riferire una volta, in breve, al turno successivo. */
export function formatProfileNotices(notices: readonly ProfileNotice[]): string {
  const all = notices.flatMap((n) => n.changes);
  const applied = all.filter((c) => !c.conflict).map((c) => `- ${describeChange(c)}`);
  const asked = all.filter((c) => c.conflict).map((c) => `- ${describeChange(c)}`);
  const parts: string[] = [];
  if (applied.length)
    parts.push(
      `Ho aggiornato la scheda dell'utente con quello che ha detto (diglielo in una riga, alla prima occasione, e che può correggerla in Impostazioni › La tua scheda):\n${applied.join('\n')}`,
    );
  if (asked.length)
    parts.push(
      `Non ho cambiato la scheda perché quei dati li ha scritti l'utente nell'app: chiedigli in una riga se vuole aggiornarla lui in Impostazioni › La tua scheda (non dire di averla aggiornata):\n${asked.join('\n')}`,
    );
  return parts.join('\n\n');
}
