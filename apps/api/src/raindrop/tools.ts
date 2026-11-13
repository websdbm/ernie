import { defineTool, type ToolSpec } from '@ernie/tools';
import { z } from 'zod';
import { Id, McpRead, RaindropError, Save, Search } from './provider.js';
import type { RaindropService } from './service.js';

export function createRaindropTools(service: RaindropService): ToolSpec[] {
  const readRisk = {
    readsPrivate: true,
    ingestsUntrusted: true,
    externalEffect: false,
    write: false,
  };
  const safe = async (call: () => Promise<unknown>) => {
    try {
      return await call();
    } catch (e) {
      return {
        error: e instanceof RaindropError ? e.code : 'raindrop_unavailable',
        reason: e instanceof RaindropError ? e.message : 'Richiesta Raindrop non completata.',
      };
    }
  };
  return [
    defineTool({
      id: 'raindrop_search',
      version: '1.0.0',
      category: 'raindrop',
      description:
        'Cerca i segnalibri dell’account Raindrop collegato con filtri e ricerca REST. query accetta i filtri Raindrop (tag, data, parole); collectionId 0 tutte, -1 non organizzati. Risultati paginati con link, estratto e note: non equivalgono al testo integrale. Per ricerca semantica/testo completo usa gli strumenti MCP di sola lettura dopo raindrop_read_tools. Nessuna importazione nel Second Brain.',
      risk: { ...readRisk, egress: true },
      requiredScopes: ['chat'],
      inputSchema: Search,
      outputSchema: z.unknown(),
      execute: (i, c) => safe(() => service.search(c.userId, i, c.signal)),
      untrustedSource: () => 'raindrop:library',
    }),
    defineTool({
      id: 'raindrop_get',
      version: '1.0.0',
      category: 'raindrop',
      description:
        'Legge metadati, note ed evidenziazioni di un segnalibro Raindrop per ID dell’account corrente. L’estratto non è il testo completo. Cita sempre il link; per il contenuto completo usa raindrop_read_tools e raindrop_read.',
      risk: readRisk,
      requiredScopes: ['chat'],
      inputSchema: z.object({ id: Id }).strict(),
      outputSchema: z.unknown(),
      execute: (i, c) => safe(() => service.get(c.userId, i.id, c.signal)),
      untrustedSource: () => 'raindrop:bookmark',
    }),
    defineTool({
      id: 'raindrop_collections',
      version: '1.0.0',
      category: 'raindrop',
      description:
        'Trova raccolte Raindrop per nome/percorso con query, oppure elencale per pagine usando offset e nextOffset. Restituisce gerarchia, percorso e ID. Non inventare ID; per omonimi fai scegliere il percorso all’utente. total e matches distinguono totale e risultati filtrati.',
      risk: readRisk,
      requiredScopes: ['chat'],
      inputSchema: z
        .object({
          query: z.string().trim().max(160).default(''),
          offset: z.number().int().min(0).max(2000).default(0),
          limit: z.number().int().min(1).max(20).default(10),
        })
        .strict(),
      outputSchema: z.unknown(),
      execute: (i, c) =>
        safe(async () => {
          const all = await service.collections(c.userId, c.signal);
          const byId = new Map(all.map((v) => [v.id, v]));
          const path = (id: number) => {
            const seen = new Set<number>();
            const names: string[] = [];
            let next: number | null = id;
            while (next !== null && !seen.has(next) && names.length < 15) {
              seen.add(next);
              const value = byId.get(next);
              if (!value) break;
              names.unshift(value.title);
              next = value.parentId;
            }
            return names.join(' / ').slice(0, 1000);
          };
          const query = i.query.toLocaleLowerCase('it');
          const matches = all
            .map((v) => ({ ...v, path: path(v.id) }))
            .filter((v) => !query || v.path.toLocaleLowerCase('it').includes(query));
          const items = matches.slice(i.offset, i.offset + i.limit);
          return {
            total: all.length,
            matches: matches.length,
            items,
            nextOffset: i.offset + items.length < matches.length ? i.offset + items.length : null,
          };
        }),
      untrustedSource: () => 'raindrop:collections',
    }),
    defineTool({
      id: 'raindrop_read_tools',
      version: '1.0.0',
      category: 'raindrop',
      description:
        'Legge gli schemi correnti delle sole funzioni MCP ufficiali find_bookmarks, fetch_bookmark_content, find_highlights. Chiamalo prima di raindrop_read e usa esattamente gli argomenti documentati. La ricerca semantica/testuale completa può richiedere Pro; un errore non prova che il contenuto sia vuoto.',
      risk: readRisk,
      requiredScopes: ['chat'],
      inputSchema: z.object({}).strict(),
      outputSchema: z.unknown(),
      timeoutMs: 60_000,
      execute: (_i, c) => safe(() => service.readTools(c.userId, c.signal)),
      untrustedSource: () => 'raindrop:read-schemas',
    }),
    defineTool({
      id: 'raindrop_read',
      version: '1.0.0',
      category: 'raindrop',
      description:
        'Esegue una sola funzione MCP Raindrop di LETTURA (ricerca semantica, testo completo, evidenziazioni). Leggi prima raindrop_read_tools per lo schema effettivo; arguments è l’oggetto conforme, senza token. Non può modificare la libreria. Non inventare contenuti mancanti; cita i link ottenuti.',
      risk: { ...readRisk, egress: true },
      requiredScopes: ['chat'],
      inputSchema: McpRead,
      outputSchema: z.unknown(),
      timeoutMs: 75_000,
      maxResultChars: 32_000,
      execute: (i, c) => safe(() => service.read(c.userId, i, c.signal)),
      untrustedSource: () => 'raindrop:content',
    }),
    defineTool({
      id: 'raindrop_save',
      version: '1.0.0',
      category: 'raindrop',
      description:
        'Salva UN link nella libreria Raindrop solo su richiesta dell’utente. Leggi le raccolte per l’ID; -1 salva tra i non organizzati. Non importa nel Second Brain, non elimina né modifica raccolte. In caso di esito incerto cerca il link prima di proporre un nuovo tentativo; non ripetere automaticamente.',
      risk: {
        readsPrivate: true,
        ingestsUntrusted: true,
        externalEffect: true,
        write: true,
        egress: true,
      },
      requiredScopes: ['chat'],
      inputSchema: Save,
      outputSchema: z.unknown(),
      oncePerTurn: true,
      retry: { attempts: 1, backoffMs: 0 },
      execute: (i, c) => safe(() => service.save(c.userId, i, c.signal)),
      untrustedSource: () => 'raindrop:saved-bookmark',
    }),
  ];
}
