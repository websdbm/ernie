import { createHash } from 'node:crypto';
import { mergedIdentities } from './identities.js';
import { type BrainNote, bodyLinks, serializeNote } from './note.js';
import { isResourceType, isUnnamedPhotoPlace, resourceFromPath } from './resources.js';

/** Il modello può scegliere fonti e destinazioni, mai inventare o riscrivere un fatto. */
export interface BrainConnection {
  readonly source: string;
  readonly target: string;
  readonly quote: string;
}
export interface BrainReviewPlan {
  readonly connections: readonly BrainConnection[];
  readonly questions: ReadonlyArray<{
    target: string;
    sources: readonly string[];
    question: string;
  }>;
}
export interface BrainReviewNote {
  readonly path: string;
  readonly title: string;
  readonly type: string;
  readonly body: string;
  readonly place: string | null;
  readonly created: string;
}
export const EMPTY_REVIEW: BrainReviewPlan = { connections: [], questions: [] };
const TYPES = new Set(['persona', 'luogo', 'progetto', 'argomento']);
const BLOCK =
  /\n*<!-- ernie:consolidated ([a-f0-9]{64}) -->\n([\s\S]*?)\n<!-- \/ernie:consolidated -->/u;
export const contentHash = (s: string) => createHash('sha256').update(s).digest('hex');
export const normalized = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

export function managedContent(body: string): { base: string; edited: boolean } {
  const m = BLOCK.exec(body);
  if (!m) return { base: body, edited: body.includes('<!-- ernie:consolidated') };
  return { base: body.replace(BLOCK, '').trimEnd(), edited: contentHash(m[2] ?? '') !== m[1] };
}

/** Le riservate e le pagine generate non entrano MAI nella revisione automatica né nel modello. */
export function reviewable(n: BrainNote): boolean {
  return (
    !n.private &&
    !isResourceType(n.type) &&
    !resourceFromPath(n.path) &&
    n.type !== 'chi-sono' &&
    n.type !== 'salute' &&
    !n.path.startsWith('Salute/') &&
    // Luoghi creati da una foto e non ancora rinominati: solo una posizione, niente da riordinare.
    !isUnnamedPhotoPlace(n) &&
    !managedContent(n.body).edited
  );
}
export function reviewNotes(notes: readonly BrainNote[]): BrainReviewNote[] {
  return notes.filter(reviewable).map((n) => ({
    path: n.path,
    title: n.title,
    type: n.type,
    body: managedContent(n.body).base,
    place: n.place ?? null,
    created: n.created,
  }));
}
export function reviewFingerprint(notes: readonly BrainNote[]): string {
  return contentHash(
    JSON.stringify(
      notes
        .map((n) => ({
          ...n,
          body: managedContent(n.body).base,
          // I link prodotti dalle citazioni non devono innescare un'altra revisione del modello.
          links: n.links.filter((l) => !bodyLinks(n.body.match(BLOCK)?.[2] ?? '').includes(l)),
        }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    ),
  );
}

const mention = (text: string, name: string) =>
  ` ${normalized(text)} `.includes(` ${normalized(name)} `);

/** Collegamenti certi: wikilink espliciti e nomi completi nei titoli, senza costo LLM. */
export function explicitConnections(
  notes: readonly BrainNote[],
  focus?: ReadonlySet<string>,
): BrainConnection[] {
  const eligible = notes.filter(reviewable);
  const out: BrainConnection[] = [];
  for (const source of eligible) {
    const body = managedContent(source.body).base;
    const links = new Set(bodyLinks(body).map(normalized));
    // Mantiene anche collegamenti espliciti del frontmatter, escludendo quelli del blocco generato.
    const generated = new Set(bodyLinks(source.body.match(BLOCK)?.[2] ?? '').map(normalized));
    for (const l of source.links) if (!generated.has(normalized(l))) links.add(normalized(l));
    for (const target of eligible) {
      if (focus && !focus.has(source.path) && !focus.has(target.path)) continue;
      if (source.path === target.path || !TYPES.has(target.type)) continue;
      if (eligible.filter((n) => normalized(n.title) === normalized(target.title)).length !== 1)
        continue;
      const names = [target.title, ...mergedIdentities(target).map((a) => a.title)];
      const namedPerson =
        target.type === 'persona' &&
        names.some(
          (name) =>
            name.length >= 3 &&
            mention(source.title, name) &&
            eligible.filter((n) =>
              [n.title, ...mergedIdentities(n).map((a) => a.title)].some(
                (t) => normalized(t) === normalized(name),
              ),
            ).length === 1,
        );

      if (
        ![target.title, target.path, target.path.replace(/\.md$/iu, '')].some((ref) =>
          links.has(normalized(ref)),
        ) &&
        !namedPerson
      )
        continue;
      // Una pagina-segnaposto non è un fatto. Per luoghi della scheda la prima riga contiene l'indirizzo.
      const paragraphs = body
        .replace(/<!--[\s\S]*?-->/gu, '')
        .split(/\n\s*\n/u)
        .map((p) => p.trim())
        .filter(
          (p) =>
            p &&
            !p.startsWith('#') &&
            !p.startsWith('Pagina creata da Ernie:') &&
            !p.startsWith('Con Ernie:') &&
            !p.startsWith('_Generata'),
        );
      const quote =
        paragraphs.find((p) => source.type === 'luogo' || mention(p, target.title)) ??
        paragraphs[0];
      if (quote && quote.length <= 1600)
        out.push({ source: source.path, target: target.path, quote });
    }
  }
  return out;
}

export interface ReconciliationChanges {
  readonly files: ReadonlyArray<{ path: string; content: string }>;
  readonly questions: readonly string[];
  readonly connections: number;
}

/** Fonde per fonte e citazione; nessun originale viene eliminato e nessuna frase viene fabbricata. */
export function reconcileNotes(
  notes: readonly BrainNote[],
  plan: BrainReviewPlan = EMPTY_REVIEW,
  focus?: ReadonlySet<string>,
): ReconciliationChanges {
  const eligible = new Map(notes.filter(reviewable).map((n) => [n.path, n]));
  const pending = new Map<string, string[]>();
  const questions: string[] = [];
  for (const q of plan.questions.slice(0, 20)) {
    const target = eligible.get(q.target);
    const sources = q.sources.map((p) => eligible.get(p));
    if (!target || !sources.length || sources.some((s) => !s) || !q.question.trim()) continue;
    pending.set(q.target, [...(pending.get(q.target) ?? []), ...q.sources]);
    questions.push(`Su «${target.title}»: ${q.question.slice(0, 400)}`);
  }
  const grouped = new Map<string, Map<string, BrainConnection>>();
  const isPending = (c: BrainConnection) =>
    pending.get(c.target)?.includes(c.source) || pending.get(c.source)?.includes(c.target);
  // Un dubbio sospende nuove associazioni in entrambe le direzioni. Conserva una
  // citazione già presente solo se è ancora identica a una fonte accessibile.
  const explicit = explicitConnections(notes, focus);
  const affected = new Set(focus);
  for (const c of explicit) affected.add(c.target);
  const retained: BrainConnection[] = [];
  for (const target of eligible.values()) {
    const section = target.body.match(BLOCK)?.[2] ?? '';
    for (const m of section.matchAll(
      /^### \[\[([^\n|]+)\|[^\n]+\]\] · [^\n]+\n\n((?:>[^\n]*(?:\n|$))+)/gmu,
    )) {
      const c = {
        source: m[1] ?? '',
        target: target.path,
        quote: (m[2] ?? '')
          .trimEnd()
          .split('\n')
          .map((line) => line.replace(/^> ?/u, ''))
          .join('\n'),
      };
      if (focus?.has(c.source)) affected.add(c.target);
      // La passata locale conserva anche le associazioni semantiche già verificate.
      const expanded =
        focus &&
        !isPending(c) &&
        explicit.some(
          (e) => e.source === c.source && e.target === c.target && e.quote.includes(c.quote),
        );
      if ((focus || isPending(c)) && !expanded) retained.push(c);
    }
  }
  const planned = plan.connections
    .slice(0, 500)
    .filter((c) => !focus || focus.has(c.source) || focus.has(c.target));
  for (const c of planned) affected.add(c.target);
  for (const c of [...explicit, ...planned, ...retained]) {
    const source = eligible.get(c.source);
    const target = eligible.get(c.target);
    if (!source || !target || source.path === target.path || !TYPES.has(target.type)) continue;
    if (isPending(c) && !retained.includes(c)) continue;
    const quote = c.quote.trim();
    if (
      quote.length < 4 ||
      quote.length > 1600 ||
      !managedContent(source.body).base.includes(quote)
    )
      continue;
    // Nessuna promozione della fonte: la citazione resta un dato citato e datato, anche se viene da un PDF.
    const items = grouped.get(c.target) ?? new Map<string, BrainConnection>();
    items.set(`${c.source}:${contentHash(quote)}`, { ...c, quote });
    grouped.set(c.target, items);
  }
  const files: Array<{ path: string; content: string }> = [];
  let count = 0;
  for (const n of notes) {
    if (focus && !affected.has(n.path)) continue;
    if (isResourceType(n.type) || resourceFromPath(n.path)) continue;
    if (n.private || n.type === 'chi-sono' || n.type === 'salute' || n.path.startsWith('Salute/'))
      continue;
    const old = managedContent(n.body);
    if (old.edited) {
      // La modifica manuale è autorevole: non riproporre un riallineamento automatico.
      continue;
    }
    const items = [...(grouped.get(n.path)?.values() ?? [])]
      .sort((a, b) => a.source.localeCompare(b.source) || a.quote.localeCompare(b.quote))
      .slice(0, 25);
    const lines: string[] = [];
    for (const c of items) {
      const source = eligible.get(c.source);
      if (!source) continue;
      // Percorso completo: non confonde omonimi e resta un link valido per Obsidian e l'app.
      const ref = source.path;
      lines.push(
        `### [[${ref}|${source.title}]] · ${source.refersFrom ?? source.created.slice(0, 10)}\n\n${c.quote
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n')}`,
      );
    }
    count += items.length;
    const section = lines.length ? `## Informazioni collegate\n\n${lines.join('\n\n')}` : '';
    const body = section
      ? `${old.base}\n\n<!-- ernie:consolidated ${contentHash(section)} -->\n${section}\n<!-- /ernie:consolidated -->`
      : old.base;
    if (body === n.body) continue;
    const generatedLinks = new Set(bodyLinks(n.body.match(BLOCK)?.[2] ?? ''));
    const links = [
      ...new Set([...n.links.filter((l) => !generatedLinks.has(l)), ...bodyLinks(body)]),
    ];
    files.push({ path: n.path, content: serializeNote({ ...n, body, links }) });
  }
  return { files, questions: [...new Set(questions)], connections: count };
}
