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
