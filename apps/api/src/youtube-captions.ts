import { boundedText, playerJson } from './youtube-metadata.js';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
export type CaptionResult =
  | { ok: true; text: string; language: string; automatic: boolean }
  | { ok: false; reason: 'unavailable' | 'blocked' | 'rate_limited' | 'error'; message: string };

const requestText = (message: string | undefined) =>
  (message ?? '').replace(/https?:\/\/\S+/gi, '').toLowerCase();
const summaryWord = /\b(riassum\w*|riassunto|sunto|sintesi|sintetizz\w*|summary|summarize)\b/u;
export function summaryRequested(message: string | undefined): boolean {
  const text = requestText(message);
  return (
    summaryWord.test(text) &&
    !/\bnon\b[^.!?]{0,60}\b(riassum\w*|riassunto|sunto|sintesi|sintetizz\w*)\b/u.test(text) &&
    !/\b(ingredient\w*|dosi|passagg\w*)\b/u.test(text) &&
    !/\b(estrai|salva\w*|ricava|memorizz\w*)\b[^.!?]{0,60}\bricett\w*\b/u.test(text) &&
    !/\b(voglio|dammi|mostrami)\s+(?:anche\s+)?(?:(?:la|una|questa)\s+)?ricett\w*\b/u.test(text) &&
    !/\bricetta\s+completa\b/u.test(text)
  );
}

/** Riassunti culinari o visivi conservano i fotogrammi, anche se non richiedono una scheda ricetta. */
export function captionSummaryRequested(message: string | undefined): boolean {
  const text = requestText(message);
  return (
    summaryRequested(message) &&
    !/\b(ricett\w*|estrai|fotogramm\w*|immagin\w*|scen\w*|scritte|schermo|slide|grafici|guarda|visiv\w*)\b/u.test(
      text,
    )
  );
}

export function captionTracks(
  page: string,
  videoId: string,
): Array<{ url: string; language: string; automatic: boolean }> {
  const player = playerJson(page);
  if (obj(player.videoDetails).videoId !== videoId || obj(player.playabilityStatus).status !== 'OK')
    return [];
  const tracks = obj(obj(player.captions).playerCaptionsTracklistRenderer).captionTracks;
  if (!Array.isArray(tracks)) return [];
  return tracks
    .slice(0, 50)
    .flatMap((v) => {
      const t = obj(v);
      if (
        typeof t.baseUrl !== 'string' ||
        t.baseUrl.length > 8000 ||
        typeof t.languageCode !== 'string'
      )
        return [];
      try {
        const url = new URL(t.baseUrl);
        if (
          url.protocol !== 'https:' ||
          !['www.youtube.com', 'youtube.com'].includes(url.hostname) ||
          url.username ||
          url.password ||
          url.port ||
          url.pathname !== '/api/timedtext' ||
          url.searchParams.get('v') !== videoId
        )
          return [];
        url.searchParams.set('fmt', 'json3');
        return [
          { url: url.href, language: t.languageCode.slice(0, 35), automatic: t.kind === 'asr' },
        ];
      } catch {
        return [];
      }
    })
    .sort((a, b) => {
      const rank = (t: typeof a) =>
        (t.language.startsWith('it') ? 0 : t.language.startsWith('en') ? 2 : 4) +
        (t.automatic ? 1 : 0);
      return rank(a) - rank(b);
    });
}

/** JSON3 pubblico, mai HTML eseguito. Rifiuta testo troppo lungo e copertura manifestamente parziale. */
export function parseCaptions(raw: string, durationSeconds: number): string | null {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 1200)
    return null;
  const data = obj(JSON.parse(raw));
  if (!Array.isArray(data.events) || data.events.length > 20_000) return null;
  const lines: string[] = [];
  let first = Infinity;
  let last = 0;
  let previous = '';
  let length = 0;
  for (const entry of data.events) {
    const e = obj(entry);
    if (!Array.isArray(e.segs)) continue;
    const start = Number(e.tStartMs),
      duration = Number(e.dDurationMs);
    if (!Number.isFinite(start) || !Number.isFinite(duration) || start < 0 || duration < 0)
      continue;
    const text = e.segs
      .map((s) => (typeof obj(s).utf8 === 'string' ? obj(s).utf8 : ''))
      .join('')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: rimuove esplicitamente i controlli C0 dal testo esterno
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    first = Math.min(first, start / 1000);
    last = Math.max(last, (start + duration) / 1000);
    if (text === previous) continue;
    previous = text;
    length += text.length;
    if (length > 32_000) return null;
    const seconds = Math.floor(start / 1000);
    lines.push(
      `[${Math.floor(seconds / 60)
        .toString()
        .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}] ${text}`,
    );
  }
  if (length < 80 || first > 15 || last < durationSeconds * 0.9 || last > durationSeconds + 30)
    return null;
  return lines.join('\n');
}

export async function readYouTubeCaptions(input: {
  page: string;
  videoId: string;
  durationSeconds: number | null;
  fetch: typeof fetch;
  signal: AbortSignal;
}): Promise<CaptionResult> {
  const unavailable: CaptionResult = {
    ok: false,
    reason: 'unavailable',
    message: 'Sottotitoli completi non disponibili: resta la lettura visiva.',
  };
  if (input.durationSeconds === null) return unavailable;
  const tracks = captionTracks(input.page, input.videoId);
  // Un solo tentativo entro il budget: niente raffiche su lingue/profili alternativi.
  const track = tracks[0];
  if (!track) return unavailable;
  try {
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(5000)]);
    const response = await input.fetch(track.url, { signal, redirect: 'error' });
    if (response.status === 429)
      return {
        ok: false,
        reason: 'rate_limited',
        message:
          'YouTube limita il recupero dei sottotitoli. Nessun altro tentativo su questo canale.',
      };
    if ([401, 403].includes(response.status))
      return {
        ok: false,
        reason: 'blocked',
        message: 'YouTube non ha consentito la lettura dei sottotitoli.',
      };
    const text = parseCaptions(await boundedText(response, 500_000), input.durationSeconds);
    return text
      ? { ok: true, text, language: track.language, automatic: track.automatic }
      : unavailable;
  } catch {
    input.signal.throwIfAborted();
    return {
      ok: false,
      reason: 'error',
      message: 'Sottotitoli non leggibili in questo momento: resta la lettura visiva.',
    };
  }
}
