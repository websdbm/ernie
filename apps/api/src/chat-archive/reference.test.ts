import { describe, expect, it, vi } from 'vitest';
import { resolveArchiveReference } from './reference.js';
import type { Archive, ChatArchiveRepository } from './types.js';

const row = (id: string, name: string, summary = '') =>
  ({ id, name, summary, tags: [], category: null }) as unknown as Archive;
const repo = (rows: Archive[], total = rows.length) =>
  ({
    list: vi.fn(async () => ({ archives: rows, total })),
    retrieve: vi.fn(),
    get: vi.fn(),
  }) as unknown as ChatArchiveRepository;
describe('reference archivi, solo metadati', () => {
  it('seleziona soltanto un titolo esplicito univoco, senza leggere contenuti', async () => {
    const r = repo([row('a', 'Giorgio'), row('b', 'Sport')]);
    expect(
      (await resolveArchiveReference(r, 'utente', 'Nella chat con Giorgio cosa abbiamo deciso?'))
        .selectedArchiveId,
    ).toBe('a');
    expect(r.list).toHaveBeenCalledWith('utente', { offset: 0, limit: 100 });
    expect(r.retrieve).not.toHaveBeenCalled();
    expect(r.get).not.toHaveBeenCalled();
  });
  it('omonimi e riferimenti per argomento producono una scelta, non un archivio indovinato', async () => {
    expect(
      (
        await resolveArchiveReference(
          repo([row('a', 'Giorgio'), row('b', 'Giorgio')]),
          'u',
          'cerca nella chat Giorgio',
        )
      ).selectedArchiveId,
    ).toBeNull();
    const result = await resolveArchiveReference(
      repo([row('a', 'Famiglia'), row('b', 'Cucina', 'ricette muffin')]),
      'u',
      'cerca nella chat delle ricette',
    );
    expect(result.archives[0]?.id).toBe('b');
    expect(result.selectedArchiveId).toBeNull();
  });
  it('non autoseleziona quando il catalogo eccede il limite di scansione', async () => {
    const r = repo(
      Array.from({ length: 100 }, (_, i) => row(String(i), i === 0 ? 'Cucina' : `Altro ${i}`)),
      2000,
    );
    expect((await resolveArchiveReference(r, 'u', 'chat Cucina')).selectedArchiveId).toBeNull();
  });
});
