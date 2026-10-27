import { describe, expect, it, vi } from 'vitest';
import {
  captionSummaryRequested,
  captionTracks,
  parseCaptions,
  readYouTubeCaptions,
  summaryRequested,
} from './youtube-captions.js';

const id = 'ZcrXU8cVOH0';
const base = `https://www.youtube.com/api/timedtext?v=${id}&lang=it`;
const words =
  'Una spiegazione completa del procedimento narrato, senza inventare contenuti visivi o informazioni non dette.';
const captions = JSON.stringify({
  events: [
    { tStartMs: 0, dDurationMs: 24_000, segs: [{ utf8: words }] },
    {
      tStartMs: 24_000,
      dDurationMs: 24_000,
      segs: [{ utf8: `Il secondo punto riguarda i dettagli e conclude il discorso. ${words}` }],
    },
  ],
});
const page = (tracks: unknown[], videoId = id) =>
  `var ytInitialPlayerResponse=${JSON.stringify({
    playabilityStatus: { status: 'OK' },
    videoDetails: { videoId },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } },
  })};`;

describe('sottotitoli pubblici e scopo della lettura', () => {
  it('usa solo riassunti espliciti, non URL, istruzioni visive o ingredienti', () => {
    expect(captionSummaryRequested('Fammi un sunto di https://youtu.be/ZcrXU8cVOH0')).toBe(true);
    for (const text of [
      undefined,
      'Estrai la ricetta',
      'https://youtube.com/watch?v=summary',
      'Riassumi le scritte e gli ingredienti',
      'Fammi una sintesi visiva',
      'Riassumi e guarda i grafici',
      'Non voglio un riassunto, voglio la ricetta completa',
      'Riassumi il video e salva la ricetta',
    ])
      expect(captionSummaryRequested(text)).toBe(false);
  });
  it('distingue un riassunto culinario dalle richieste miste o negate', () => {
    for (const text of ['Voglio un riassunto della ricetta', 'Dammi una sintesi della ricetta']) {
      expect(summaryRequested(text)).toBe(true);
      expect(captionSummaryRequested(text)).toBe(false);
    }
    for (const text of [
      'Non voglio un riassunto, voglio la ricetta completa',
      'Riassumi il video e salva la ricetta',
      'Fammi un riassunto e dammi la ricetta',
    ])
      expect(summaryRequested(text)).toBe(false);
  });
  it('limita URL, video e protocolli prima di fetch; preferisce italiano', () => {
    const tracks = captionTracks(
      page([
        { baseUrl: base, languageCode: 'en' },
        { baseUrl: base, languageCode: 'it', kind: 'asr' },
        ...[
          'http://www.youtube.com/api/timedtext',
          'https://evil.test/api/timedtext',
          'https://www.youtube.com/redirect',
          `https://www.youtube.com/api/timedtext?v=OTHERID1234`,
          `https://user:secret@www.youtube.com/api/timedtext?v=${id}`,
        ].map((baseUrl) => ({ baseUrl, languageCode: 'it' })),
      ]),
      id,
    );
    expect(tracks).toHaveLength(2);
    expect(tracks[0]).toMatchObject({ language: 'it', automatic: true });
    expect(new URL(tracks[0]?.url ?? 'https://invalid.test').searchParams.get('fmt')).toBe('json3');
    expect(captionTracks(page([{ baseUrl: base, languageCode: 'it' }], 'OTHERID1234'), id)).toEqual(
      [],
    );
  });
  it('conserva timestamp e rifiuta copertura parziale, durata ignota, input enorme', () => {
    expect(parseCaptions(captions, 48)).toContain('[00:24] Il secondo punto');
    expect(parseCaptions(captions, 120)).toBeNull();
    expect(parseCaptions(captions, Number.NaN)).toBeNull();
    expect(parseCaptions(captions, 1201)).toBeNull();
    expect(
      parseCaptions(
        JSON.stringify({
          events: [{ tStartMs: 0, dDurationMs: 48_000, segs: [{ utf8: 'x'.repeat(32_001) }] }],
        }),
        48,
      ),
    ).toBeNull();
  });
  it('nessuna richiesta senza tracce valide; blocchi e redirect non vengono aggirati', async () => {
    const fetcher = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response('', { status: 429 }),
    );
    const input = {
      page: page([]),
      videoId: id,
      durationSeconds: 48,
      fetch: fetcher as typeof fetch,
      signal: new AbortController().signal,
    };
    expect(await readYouTubeCaptions(input)).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      await readYouTubeCaptions({ ...input, page: page([{ baseUrl: base, languageCode: 'it' }]) }),
    ).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
  });
});
