/** Identita stabile: cambiare il titolo non duplica la pagina e gli omonimi restano distinti. */
export interface BrainResource {
  readonly kind: 'recipe' | 'media';
  readonly id: string;
}
const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PATH = new RegExp(`^(Ricette|Immagini)/(${ID})\\.md$`, 'u');
export function resourcePath(resource: BrainResource): string {
  if (!new RegExp(`^${ID}$`, 'u').test(resource.id)) throw new Error('Risorsa non valida');
  return `${resource.kind === 'recipe' ? 'Ricette' : 'Immagini'}/${resource.id}.md`;
}
export function resourceFromPath(path: string): BrainResource | null {
  const m = PATH.exec(path);
  return m?.[2] ? { kind: m[1] === 'Ricette' ? 'recipe' : 'media', id: m[2] } : null;
}
export function isResourceType(type: string): boolean {
  return type === 'ricetta' || type === 'immagine';
}
export function managedResourceError(): Error {
  return Object.assign(
    new Error('Questo elemento si aggiorna dalla sua scheda in Ricette o Media.'),
    {
      statusCode: 403,
      code: 'managed_resource',
    },
  );
}
/** Titolo dei luoghi creati dalla posizione di una foto, finché l'utente non dà loro un nome. */
export const PHOTO_PLACE_PREFIX = 'Luogo fotografato';
/**
 * Luogo nato da una foto e non ancora rinominato: contiene solo la posizione di scatto, quindi non va al revisore e
 * si può rimuovere quando non resta nessuna foto collegata. Vale anche per i vecchi titoli con le coordinate.
 */
export function isUnnamedPhotoPlace(n: {
  readonly type: string;
  readonly title: string;
  readonly source?: string | undefined;
}): boolean {
  return n.type === 'luogo' && n.source === 'foto' && n.title.startsWith(PHOTO_PLACE_PREFIX);
}
