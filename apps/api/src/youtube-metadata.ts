import { ToolError } from '@ernie/tools';

export function normalizeYouTubeUrl(raw: string): { id: string; url: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ToolError('Inserisci un link YouTube valido.', 'invalid_url');
  }
  const hosts = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'];
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.port)
    throw new ToolError('Inserisci un link YouTube pubblico.', 'invalid_url');
  const path = u.pathname.split('/').filter(Boolean);
  const id =
    u.hostname === 'youtu.be' && path.length === 1
      ? path[0]
      : hosts.includes(u.hostname) && u.pathname === '/watch'
        ? u.searchParams.get('v')
        : hosts.includes(u.hostname) &&
            path.length === 2 &&
            ['shorts', 'embed', 'live'].includes(path[0] ?? '')
          ? path[1]
          : null;
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id))
    throw new ToolError('Serve il link di un singolo video YouTube.', 'invalid_url');
  return { id, url: `https://www.youtube.com/watch?v=${id}` };
}

export function youtubeLinksIn(text: string): string[] {
  const links = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"«»]+/gi)) {
    try {
      links.add(normalizeYouTubeUrl(match[0].replace(/[).,;!?]+$/, '')).url);
    } catch {
      // Other links remain on the ordinary web path.
    }
    if (links.size === 4) break;
  }
  return [...links];
}

/** Read bounded text only. Never download the video or follow an arbitrary redirect. */
export async function boundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new Error('response too large');
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('response too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const str = (v: unknown, limit: number): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, limit) : null;

/** Balanced JSON extraction, without executing scripts from the page. */
export function playerJson(html: string): Obj {
  const match = /(?:var\s+)?ytInitialPlayerResponse\s*=\s*\{/.exec(html);
  if (!match) return {};
  const start = match.index + match[0].length - 1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try {
        return obj(JSON.parse(html.slice(start, i + 1)));
      } catch {
        return {};
      }
    }
  }
  return {};
}

export interface YouTubeMetadata {
  url: string;
  videoId: string;
  title: string | null;
  channel: string | null;
  description: string | null;
  durationSeconds: number | null;
  publishedAt: string | null;
  chapters: string[];
  links: string[];
  isLive: boolean;
  availability: 'public' | 'unavailable' | 'unknown';
  missing: string[];
}

/** Durata ISO 8601 della YouTube Data API («PT1H2M3S», «P1DT2H»), in secondi. */
export function parseIsoDuration(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!m) return null;
  const [d, h, min, sec] = m.slice(1).map((n) => Number(n ?? 0)) as [
    number,
    number,
    number,
    number,
  ];
  const total = d * 86_400 + h * 3_600 + min * 60 + sec;
  return total > 0 ? total : null;
}

/** Dati ufficiali di `videos.list` (YouTube Data API v3), non soggetti al controllo anti-bot della pagina. */
export interface YouTubeApiVideo {
  title: string | null;
  channel: string | null;
  description: string | null;
  durationSeconds: number | null;
  publishedAt: string | null;
  isLive: boolean;
  availability: 'public' | 'unavailable';
}

/** null se la risposta non è leggibile (si usano pagina e oEmbed); nessun elemento: video privato o inesistente. */
export function parseYouTubeApiVideo(json: unknown, videoId: string): YouTubeApiVideo | null {
  const root = obj(json);
  if (!Array.isArray(root.items)) return null;
  const item = obj(root.items.find((i) => obj(i).id === videoId));
  if (!item.id) {
    return {
      title: null,
      channel: null,
      description: null,
      durationSeconds: null,
      publishedAt: null,
      isLive: false,
      availability: 'unavailable',
    };
  }
  const snippet = obj(item.snippet);
  const status = obj(item.status);
  return {
    title: str(snippet.title, 200),
    channel: str(snippet.channelTitle, 160),
    description: str(snippet.description, 16_000),
    durationSeconds: parseIsoDuration(obj(item.contentDetails).duration),
    publishedAt: str(snippet.publishedAt, 10),
    isLive: snippet.liveBroadcastContent === 'live' || snippet.liveBroadcastContent === 'upcoming',
    // Come per la pagina: i video non in elenco non si leggono.
    availability:
      status.privacyStatus === 'public' && (status.uploadStatus ?? 'processed') === 'processed'
        ? 'public'
        : 'unavailable',
  };
}

export function parseYouTubeMetadata(
  url: string,
  html: string,
  oembed: unknown = {},
  api: YouTubeApiVideo | null = null,
): YouTubeMetadata {
  const normalized = normalizeYouTubeUrl(url);
  const player = playerJson(html);
  const details = obj(player.videoDetails);
  // A mismatched/corrupt page must never be attributed to the requested video.
  const correct = details.videoId === normalized.id;
  const d = correct ? details : {};
  const micro = correct ? obj(obj(player.microformat).playerMicroformatRenderer) : {};
  const embed = obj(oembed);
  const description = str(d.shortDescription, 16_000) ?? api?.description ?? null;
  const length = Number(d.lengthSeconds);
  const title = str(d.title, 200) ?? api?.title ?? str(embed.title, 200);
  const channel = str(d.author, 160) ?? api?.channel ?? str(embed.author_name, 160);
  const status = obj(player.playabilityStatus).status;
  const pageDuration = Number.isFinite(length) && length > 0 ? length : null;
  // L'API ufficiale, quando c'è, decide durata e disponibilità; la pagina resta la riserva.
  const durationSeconds = api?.durationSeconds ?? pageDuration;
  // Dal server YouTube risponde spesso col controllo anti-bot (LOGIN_REQUIRED, niente videoDetails), anche per video
  // pubblici (25 ott 2026, IP di Contabo). oEmbed invece risponde solo per video pubblici o non in elenco: se la pagina
  // non è leggibile ma oEmbed dà il titolo, il video è accessibile. Privati e inesistenti: oEmbed 401/400/404.
  const pageBlocked = !correct || status === 'LOGIN_REQUIRED';
  const embedOk = Boolean(str(embed.title, 200));
  return {
    url: normalized.url,
    videoId: normalized.id,
    title,
    channel,
    description,
    durationSeconds,
    publishedAt: str(micro.publishDate, 60) ?? api?.publishedAt ?? null,
    chapters: (description?.split('\n') ?? [])
      .filter((line) => /\b\d{1,2}:\d{2}(?::\d{2})?\b/.test(line))
      .slice(0, 30),
    links: [...new Set(description?.match(/https?:\/\/[^\s<>]+/g) ?? [])].slice(0, 20),
    isLive:
      api?.isLive === true ||
      d.isLive === true ||
      Boolean(obj(micro.liveBroadcastDetails).isLiveNow),
    availability: api
      ? api.availability
      : d.isPrivate === true || micro.isUnlisted === true
        ? 'unavailable'
        : (correct && status === 'OK') || (pageBlocked && embedOk)
          ? 'public'
          : 'unknown',
    missing: [
      ...(!title ? ['titolo'] : []),
      ...(!description ? ['descrizione completa'] : []),
      ...(!durationSeconds ? ['durata'] : []),
    ],
  };
}

export async function readYouTubeMetadata(
  url: string,
  doFetch: typeof fetch,
  signal: AbortSignal,
  youtubeApiKey?: string,
): Promise<YouTubeMetadata> {
  return (await readYouTubeSource(url, doFetch, signal, youtubeApiKey)).metadata;
}

/** Conserva la pagina solo per il recupero testuale: non entra nella cronologia o nell'output del tool. */
export async function readYouTubeSource(
  url: string,
  doFetch: typeof fetch,
  signal: AbortSignal,
  youtubeApiKey?: string,
): Promise<{ metadata: YouTubeMetadata; page: string }> {
  const { id, url: canonical } = normalizeYouTubeUrl(url);
  const read = async (target: string, max: number) =>
    boundedText(await doFetch(target, { signal, redirect: 'error' }), max);
  const [page, embed, data] = await Promise.allSettled([
    read(canonical, 4_000_000),
    read(`https://www.youtube.com/oembed?url=${encodeURIComponent(canonical)}&format=json`, 32_000),
    // La chiave va nella query (così vuole l'API): l'errore di boundedText riporta solo lo stato HTTP, mai l'URL.
    youtubeApiKey
      ? read(
          `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,status&id=${id}&key=${encodeURIComponent(youtubeApiKey)}`,
          200_000,
        )
      : Promise.reject(new Error('senza chiave')),
  ]);
  let api: YouTubeApiVideo | null = null;
  if (data.status === 'fulfilled') {
    try {
      api = parseYouTubeApiVideo(JSON.parse(data.value), id);
    } catch {
      // Quota finita o risposta illeggibile: restano pagina e oEmbed.
    }
  }
  let oembed: unknown = {};
  // boundedText rifiuta le risposte non 2xx: un oEmbed 401/404 (video privato o inesistente) resta vuoto.
  if (embed.status === 'fulfilled') {
    try {
      oembed = JSON.parse(embed.value);
    } catch {
      // Optional metadata: a failure must not prevent reading the video.
    }
  }
  const html = page.status === 'fulfilled' ? page.value : '';
  return { metadata: parseYouTubeMetadata(canonical, html, oembed, api), page: html };
}
