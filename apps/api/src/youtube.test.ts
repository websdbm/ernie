import { setTimeout as delay } from 'node:timers/promises';
import { ContentSource } from '@ernie/protocol';
import type { ToolContext } from '@ernie/tools';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { guardianSettings } from './guardian.js';
import { clampVideoAnalysis, createYouTubeTool, VideoAnalysis, YOUTUBE_MODEL } from './youtube.js';
import {
  boundedText,
  normalizeYouTubeUrl,
  parseIsoDuration,
  parseYouTubeApiVideo,
  parseYouTubeMetadata,
  playerJson,
  type YouTubeMetadata,
  youtubeLinksIn,
} from './youtube-metadata.js';

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => {}) }));

const id = 'ZcrXU8cVOH0';
const url = `https://www.youtube.com/watch?v=${id}`;
const short = `https://youtube.com/shorts/${id}?si=tracking`;
const analysis = {
  status: 'analyzed',
  summary: 'Strisce di pollo impanate.',
  recipe: {
    title: 'MC Strips Fit',
    ingredients: ['400 g di petto di pollo', 'Paprika'],
    steps: ['Tagliare il pollo.'],
    time: null,
    servings: null,
  },
  evidence: [{ source: 'video', timestamp: '00:03', detail: '400 g di pollo' }],
  missing: ['Quantità della paprika non indicata.'],
};
const player = (overrides: Record<string, unknown> = {}) =>
  `<script>var ytInitialPlayerResponse = ${JSON.stringify({
    playabilityStatus: { status: 'OK' },
    videoDetails: {
      videoId: id,
      title: 'MC Strips Fit',
      author: 'Autore',
      lengthSeconds: '48',
      shortDescription: 'Ingredienti: 400 g pollo.\n00:03 Impasto\nhttps://example.org/fonte',
      ...overrides,
    },
    microformat: { playerMicroformatRenderer: { publishDate: '2026-10-19' } },
  })};</script>`;
const ctx = (userId = 'user-a'): ToolContext => ({
  userId,
  sessionId: 'session-a',
  requestId: 'request-a',
  scopes: [],
  run: {} as never,
});

function setup(
  options: {
    html?: string;
    captions?: Response;
    completions?: Response[];
    blockedDomains?: string[];
    /** false: oEmbed risponde 401 come per un video privato. */
    oembed?: boolean;
    /** Con la chiave della YouTube Data API: risposta di videos.list (null = 403, quota finita). */
    dataApi?: unknown;
  } = {},
) {
  const calls: Record<string, unknown>[] = [];
  const completions = [...(options.completions ?? [])];
  const fetchMock = vi.fn(async (target: string | URL | Request, init?: RequestInit) => {
    const address = String(target);
    if (address.startsWith('https://openrouter.ai/')) {
      calls.push(JSON.parse(String(init?.body)));
      return (
        completions.shift() ??
        new Response(
          JSON.stringify({
            id: 'gen-video',
            choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(analysis) } }],
            usage: { prompt_tokens: 4400, completion_tokens: 400, cost: 0.00232 },
          }),
        )
      );
    }
    expect(init?.redirect).toBe('error');
    if (address.startsWith('https://www.googleapis.com/youtube/v3/videos?')) {
      expect(address).toContain(`id=${id}`);
      expect(address).toContain('key=yt-key');
      return options.dataApi === null
        ? new Response('quotaExceeded', { status: 403 })
        : new Response(JSON.stringify(options.dataApi));
    }
    if (address.includes('/oembed?'))
      return options.oembed === false
        ? new Response('Unauthorized', { status: 401 })
        : new Response(JSON.stringify({ title: 'Titolo oEmbed', author_name: 'Canale' }));
    if (address.includes('/api/timedtext?'))
      return options.captions?.clone() ?? new Response('', { status: 404 });
    expect(address).toBe(url);
    return new Response(options.html ?? player());
  });
  const checkBudget = vi.fn(async () => {});
  const recorder = { record: vi.fn(async () => {}) };
  const tool = createYouTubeTool({
    apiKey: 'test-key',
    fetch: fetchMock as typeof fetch,
    checkBudget,
    recorder,
    ...(options.blockedDomains ? { blockedDomains: options.blockedDomains } : {}),
    ...(options.dataApi !== undefined ? { youtubeApiKey: 'yt-key' } : {}),
  });
  return { tool, calls, fetchMock, checkBudget, recorder };
}

describe('YouTube URLs and metadata', () => {
  it('normalizes Shorts, watch, mobile, embed and short links, without tracking or fragments', () => {
    for (const input of [
      short,
      url,
      `https://youtu.be/${id}?t=5`,
      `https://m.youtube.com/watch?v=${id}&list=abc`,
      `https://www.youtube.com/embed/${id}#t=5`,
    ]) {
      expect(normalizeYouTubeUrl(input)).toEqual({ id, url });
    }
    expect(youtubeLinksIn(`Leggi (${short}). Ecco ancora ${url}`)).toEqual([url]);
  });

  it('rejects URLs to other hosts, credentials, custom ports and non-video paths before fetching', () => {
    for (const input of [
      `https://youtube.com.evil.test/shorts/${id}`,
      `https://youtube.com@evil.test/watch?v=${id}`,
      `http://127.0.0.1/${id}`,
      `file:///watch?v=${id}`,
      `https://www.youtube.com:444/watch?v=${id}`,
      'https://www.youtube.com/playlist?list=abc',
      'https://youtu.be/bad',
    ]) {
      expect(() => normalizeYouTubeUrl(input)).toThrow();
    }
  });

  it('extracts full description, dates, duration, chapters and links without executing page scripts', () => {
    const m = parseYouTubeMetadata(
      short,
      player({
        shortDescription:
          'Testo "con } parentesi" e \\ escape.\n00:12 Preparazione\nhttps://example.org/ricetta',
      }),
    );
    expect(m).toMatchObject({
      url,
      title: 'MC Strips Fit',
      channel: 'Autore',
      durationSeconds: 48,
      publishedAt: '2026-10-19',
      availability: 'public',
      missing: [],
    });
    expect(m.chapters).toEqual(['00:12 Preparazione']);
    expect(m.links).toEqual(['https://example.org/ricetta']);
    expect(m.description).toContain('"con } parentesi"');
  });

  it('labels unavailable metadata rather than fabricating it from oEmbed or another video', () => {
    const m = parseYouTubeMetadata(url, player({ videoId: 'ABCDEFGHIJK' }), {
      title: 'oEmbed',
      author_name: 'Autore',
    });
    expect(m).toMatchObject({
      title: 'oEmbed',
      description: null,
      durationSeconds: null,
      // oEmbed risponde solo per video accessibili: la pagina illeggibile non basta a dire che non lo è.
      availability: 'public',
      missing: ['descrizione completa', 'durata'],
    });
    expect(parseYouTubeMetadata(url, player({ videoId: 'ABCDEFGHIJK' })).availability).toBe(
      'unknown',
    );
  });

  it('bounds network response size including responses without content-length', async () => {
    await expect(boundedText(new Response('too long'), 2)).rejects.toThrow('too large');
  });
});

describe('YouTube reader', () => {
  it('returns a non-recipe as a valid summary with a canonical source card, without saving', async () => {
    const summary = {
      status: 'analyzed',
      summary: 'L’autore spiega come osservare il cielo notturno lontano dalle luci della città.',
      recipe: null,
      evidence: [{ source: 'video', timestamp: '00:12', detail: 'Osservazione delle stelle.' }],
      missing: [],
    };
    const s = setup({
      completions: [
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(summary) } }],
          }),
        ),
      ],
    });
    const result = (await s.tool.execute({ url: short }, ctx())) as {
      metadata: YouTubeMetadata;
      analysis: z.infer<typeof VideoAnalysis>;
      notice: string;
    };
    expect(result.analysis).toEqual(summary);
    expect(s.tool.present?.({ url: short }, result)).toMatchObject({
      kind: 'web_results',
      results: [{ url, snippet: summary.summary }],
    });
    expect(result.notice).toContain('NON è un errore');
    expect(result.notice).toContain('hereAndNow=false');
    expect(s.tool.risk.write).toBe(false);
  });

  it('never presents an unavailable video as an approfondimento', async () => {
    const s = setup({
      completions: [
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: JSON.stringify({ ...analysis, status: 'unavailable', recipe: null }),
                },
              },
            ],
          }),
        ),
      ],
    });
    const result = await s.tool.execute({ url }, ctx());
    expect(s.tool.present?.({ url }, result)).toBeNull();
  });

  it('blocks the new web tool in supervised accounts without web capability', () => {
    expect(guardianSettings({}, ['ricette']).guardianBlockedTools).toContain('youtube_read');
    expect(guardianSettings({}, ['ricette', 'web']).guardianBlockedTools ?? []).not.toContain(
      'youtube_read',
    );
  });
  it('uses actual video input with metadata, AI Studio only, structured data and recorded cost', async () => {
    const s = setup();
    const output = (await s.tool.execute({ url: short }, ctx())) as {
      metadata: YouTubeMetadata;
      analysis: z.infer<typeof VideoAnalysis>;
    };
    expect(output.analysis).toEqual(analysis);
    expect(output.metadata.durationSeconds).toBe(48);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]).toMatchObject({
      model: YOUTUBE_MODEL,
      provider: { only: ['google-ai-studio'], allow_fallbacks: false },
      max_tokens: 4000,
      response_format: { type: 'json_schema' },
    });
    const messages = s.calls[0]?.messages as { role: string; content: unknown }[];
    expect(messages[1]?.content).toEqual([
      { type: 'video_url', video_url: { url } },
      { type: 'text', text: expect.stringContaining('Ingredienti: 400 g pollo') },
    ]);
    expect(JSON.stringify(messages)).not.toContain('session-a');
    expect(s.recorder.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-a',
        purpose: 'skill',
        model: YOUTUBE_MODEL,
        generationId: 'gen-video',
        usage: expect.objectContaining({ costReportedUsd: 0.00232, inputTokens: 4400 }),
      }),
    );
    expect(s.tool.risk).toMatchObject({ ingestsUntrusted: true, egress: true, write: false });
    expect((output as { notice?: string }).notice).toContain('La scheda ha già il pulsante Salva');
    expect((output as { notice?: string }).notice).not.toContain(
      'Salvare questo approfondimento nel Second Brain?',
    );
    expect(s.tool.untrustedSource?.({ url: short }, output)).toBe(`youtube:${id}`);
    expect(() => VideoAnalysis.parse(analysis)).not.toThrow();
  });

  it('reuses a recent result within the account, never across accounts, and still checks budget', async () => {
    const s = setup();
    await s.tool.execute({ url: short }, ctx());
    const budgets = s.checkBudget.mock.calls.length;
    await s.tool.execute({ url }, ctx());
    expect(s.calls).toHaveLength(1);
    expect(s.checkBudget.mock.calls.length).toBe(budgets + 1);
    await s.tool.execute({ url }, ctx('user-b'));
    expect(s.calls).toHaveLength(2);
  });

  it('refuses instead of analyzing without limits when the page is blocked or the duration is unknown', async () => {
    for (const html of [
      '<html>Sign in</html>',
      player({ lengthSeconds: '0' }),
      // Pagina leggibile ma non riproducibile (es. accesso richiesto): non si invia il video al modello.
      player().replace('"status":"OK"', '"status":"LOGIN_REQUIRED"'),
    ]) {
      // oEmbed 401: video privato o non accessibile.
      const s = setup({ html, oembed: false });
      await expect(s.tool.execute({ url }, ctx())).rejects.toMatchObject({
        code: expect.stringMatching(/^video_(duration_unknown|unavailable)$/),
      });
      expect(s.calls).toHaveLength(0);
    }
    const blocked = setup({ html: '<html>Sign in</html>', oembed: false });
    await expect(blocked.tool.execute({ url }, ctx())).rejects.toMatchObject({
      code: 'video_unavailable',
    });
    const unknown = setup({ html: player({ lengthSeconds: '0' }) });
    await expect(unknown.tool.execute({ url }, ctx())).rejects.toMatchObject({
      code: 'video_duration_unknown',
    });
  });

  it('with the anti-bot page and oEmbed available, analyzes a Short but not a video of unknown length', async () => {
    // 25 ott 2026: dal server YouTube risponde «Melde dich an, damit wir sehen, dass du kein Bot bist».
    const botPage =
      '<script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"LOGIN_REQUIRED"}};</script>';
    const watch = setup({ html: botPage });
    await expect(watch.tool.execute({ url }, ctx())).rejects.toMatchObject({
      code: 'video_duration_unknown',
    });
    expect(watch.calls).toHaveLength(0);
    const shortVideo = setup({ html: botPage });
    const out = (await shortVideo.tool.execute({ url: short }, ctx())) as {
      metadata: { availability: string; durationSeconds: number | null; title: string | null };
    };
    expect(out.metadata).toMatchObject({
      availability: 'public',
      durationSeconds: null,
      title: 'Titolo oEmbed',
    });
    expect(shortVideo.calls).toHaveLength(1);
  });

  it('with the YouTube Data API uses the official duration and status even when the page is blocked', async () => {
    const botPage =
      '<script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"LOGIN_REQUIRED"}};</script>';
    const item = (over: Record<string, unknown> = {}) => ({
      items: [
        {
          id,
          snippet: {
            title: 'Ricetta dal canale',
            channelTitle: 'Canale',
            description: 'Ingredienti: lenticchie.\n00:10 Cottura',
            publishedAt: '2026-10-19T10:00:00Z',
            liveBroadcastContent: 'none',
          },
          contentDetails: { duration: 'PT9M5S' },
          status: { privacyStatus: 'public', uploadStatus: 'processed' },
          ...over,
        },
      ],
    });
    const ok = setup({ html: botPage, dataApi: item() });
    const out = (await ok.tool.execute({ url }, ctx())) as {
      metadata: {
        durationSeconds: number;
        availability: string;
        title: string;
        chapters: string[];
      };
    };
    expect(out.metadata).toMatchObject({
      durationSeconds: 545,
      availability: 'public',
      title: 'Ricetta dal canale',
      chapters: ['00:10 Cottura'],
    });
    expect(ok.calls).toHaveLength(1);

    const long = setup({
      html: botPage,
      dataApi: item({ contentDetails: { duration: 'PT1H2M' } }),
    });
    await expect(long.tool.execute({ url }, ctx())).rejects.toMatchObject({
      code: 'video_too_long',
    });
    // Privato o inesistente: videos.list non restituisce elementi, anche se oEmbed rispondesse.
    for (const dataApi of [{ items: [] }, item({ status: { privacyStatus: 'unlisted' } })]) {
      const hidden = setup({ html: player(), dataApi });
      await expect(hidden.tool.execute({ url }, ctx())).rejects.toMatchObject({
        code: 'video_unavailable',
      });
      expect(hidden.calls).toHaveLength(0);
    }
    // Quota finita: si torna alla pagina, qui leggibile.
    const quota = setup({ dataApi: null });
    await expect(quota.tool.execute({ url }, ctx())).resolves.toMatchObject({
      metadata: { durationSeconds: 48 },
    });
  });

  it('parses ISO 8601 durations of the Data API', () => {
    expect(parseIsoDuration('PT44S')).toBe(44);
    expect(parseIsoDuration('PT1H2M3S')).toBe(3723);
    expect(parseIsoDuration('P1DT1M')).toBe(86_460);
    expect(parseIsoDuration('P0D')).toBeNull();
    expect(parseIsoDuration('44')).toBeNull();
    expect(parseYouTubeApiVideo({ error: {} }, id)).toBeNull();
  });

  it('does not send content anywhere on denied domains, exceeded budget or pre-aborted calls', async () => {
    const denied = setup({ blockedDomains: ['youtube.com'] });
    await expect(denied.tool.execute({ url: short }, ctx())).rejects.toMatchObject({
      code: 'blocked_domain',
    });
    expect(denied.fetchMock).not.toHaveBeenCalled();
    const budget = setup();
    budget.checkBudget.mockRejectedValueOnce(new Error('budget'));
    await expect(budget.tool.execute({ url }, ctx())).rejects.toThrow('budget');
    expect(budget.fetchMock).not.toHaveBeenCalled();
    const cancelled = setup();
    await expect(
      cancelled.tool.execute({ url }, { ...ctx(), signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(cancelled.fetchMock).not.toHaveBeenCalled();
  });

  it('does not analyze known long videos, live streams or private videos', async () => {
    for (const fields of [{ lengthSeconds: '1201' }, { isLive: true }, { isPrivate: true }]) {
      const s = setup({ html: player(fields) });
      await expect(s.tool.execute({ url }, ctx())).rejects.toThrow();
      expect(s.calls).toHaveLength(0);
    }
  });

  it('retries one transient failure, but never repeats a paid malformed or truncated response', async () => {
    const s = setup({ completions: [new Response('upstream unavailable', { status: 503 })] });
    await s.tool.execute({ url }, ctx());
    expect(s.calls).toHaveLength(2);
    expect(s.recorder.record).toHaveBeenCalledTimes(1);
    for (const content of ['not json', '{"status":"analyzed"}']) {
      const broken = setup({
        completions: [
          new Response(
            JSON.stringify({
              choices: [{ finish_reason: 'stop', message: { content } }],
              usage: { cost: 0.001 },
            }),
          ),
        ],
      });
      await expect(broken.tool.execute({ url }, ctx())).rejects.toMatchObject({
        code: 'video_bad_response',
      });
      expect(broken.calls).toHaveLength(1);
      expect(broken.recorder.record).toHaveBeenCalledWith(
        expect.objectContaining({ usage: expect.objectContaining({ costReportedUsd: 0.001 }) }),
      );
    }
  });

  it('retries a transient DNS error once and records the successful paid call', async () => {
    const s = setup();
    const original = s.fetchMock.getMockImplementation();
    if (!original) throw new Error('missing mock implementation');
    let failed = false;
    s.fetchMock.mockImplementation(async (target, init) => {
      if (String(target).includes('openrouter.ai') && !failed) {
        failed = true;
        throw new TypeError('fetch failed', { cause: { code: 'EAI_AGAIN' } });
      }
      return original(target, init);
    });
    await s.tool.execute({ url }, ctx());
    expect(s.calls).toHaveLength(1);
    expect(s.recorder.record).toHaveBeenCalledTimes(1);
  });
});

describe('YouTube: limiti temporanei di OpenRouter', () => {
  it.each([
    [429, 'video_rate_limited'],
    [503, 'video_service_error'],
    [401, 'video_service_auth'],
  ] as const)(
    'classifica HTTP %s come errore del servizio, senza attribuirlo al contenuto',
    async (status, code) => {
      const s = setup({
        completions: [new Response('{}', { status }), new Response('{}', { status })],
      });
      await expect(s.tool.execute({ url }, ctx())).rejects.toMatchObject({ code });
      expect(s.calls.length).toBeLessThanOrEqual(2);
    },
  );
  it('attende il retry del provider e recupera il video senza segnalare credito esaurito', async () => {
    const s = setup({
      completions: [
        new Response(
          JSON.stringify({
            error: {
              code: 402,
              metadata: {
                reason: 'in_flight_budget_exhausted',
                headers: { 'Retry-After': '120' },
              },
            },
          }),
          { status: 402 },
        ),
      ],
    });
    await expect(s.tool.execute({ url }, ctx())).resolves.toHaveProperty(
      'analysis.status',
      'analyzed',
    );
    expect(s.calls).toHaveLength(2);
    expect(delay).toHaveBeenCalledWith(
      120_000,
      undefined,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(s.recorder.record).toHaveBeenCalledTimes(1);
  });
  it('distingue il credito insufficiente dal limite di richieste e non ripete rifiuti permanenti', async () => {
    const s = setup({
      completions: [
        new Response(JSON.stringify({ error: { code: 402, message: 'Insufficient credits' } }), {
          status: 402,
        }),
      ],
    });
    await expect(s.tool.execute({ url }, ctx())).rejects.toMatchObject({ code: 'video_credits' });
    expect(s.calls).toHaveLength(1);
  });
});

describe('YouTube: risposta del modello oltre i limiti (25 ott 2026)', () => {
  it('accorcia i campi che sforano invece di scartare la ricetta', () => {
    const raw = {
      status: 'analyzed',
      summary: 'Chips di lenticchie croccanti.',
      recipe: {
        title: 'Chips di lenticchie',
        ingredients: ['200 g di lenticchie rosse', 'x'.repeat(200)],
        steps: Array.from({ length: 25 }, (_, i) => `Passo ${i + 1}`),
        time: 'Cottura: 20 minuti in forno a 200 °C; il tempo totale non è indicato nel video',
        servings: null,
      },
      evidence: [
        { source: 'video', timestamp: '00:00:05.250', detail: 'Le lenticchie vengono frullate.' },
      ],
      missing: ['tempo totale'],
    };
    expect(VideoAnalysis.safeParse(raw).success).toBe(false);
    const ok = VideoAnalysis.parse(clampVideoAnalysis(raw));
    expect(ok.recipe?.time).toContain('Cottura: 20 minuti');
    expect(ok.recipe?.steps).toHaveLength(20);
    expect(ok.recipe?.ingredients[1]).toHaveLength(120);
    expect(ok.evidence[0]?.timestamp).toHaveLength(12);
  });
});

const readResult = (value: unknown) =>
  z.object({ source: ContentSource, analysis: VideoAnalysis, notice: z.string() }).parse(value);
const captionData = JSON.stringify({
  events: [
    {
      tStartMs: 0,
      dDurationMs: 48_000,
      segs: [
        {
          utf8: 'Il narratore spiega come organizzare le attività della giornata. Individuare gli impegni fissi, poi inserire le attività flessibili senza sovrapposizioni.',
        },
      ],
    },
  ],
});
const validCaptionPage = `<script>var ytInitialPlayerResponse = ${JSON.stringify({
  ...playerJson(player()),
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        { baseUrl: `https://www.youtube.com/api/timedtext?v=${id}&lang=it`, languageCode: 'it' },
      ],
    },
  },
})};</script>`;
function textCompletion() {
  return new Response(
    JSON.stringify({
      id: 'caption-generation',
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              status: 'analyzed',
              summary: 'Organizzare impegni fissi e attività flessibili.',
              recipe: null,
              evidence: [
                {
                  source: 'captions',
                  timestamp: '00:00',
                  detail: 'Individuare gli impegni fissi.',
                },
              ],
              missing: ['Immagini non analizzate.'],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 500, completion_tokens: 100, cost: 0.0004 },
    }),
  );
}
describe('riassunti economici senza perdere la lettura visiva', () => {
  it('testo soltanto per un riassunto richiesto, fonte dichiarata e consumo registrato', async () => {
    const s = setup({
      html: validCaptionPage,
      captions: new Response(captionData),
      completions: [textCompletion()],
    });
    const result = await s.tool
      .execute({ url, mode: 'summary' }, { ...ctx(), userMessage: `Fammi un riassunto di ${url}` })
      .then(readResult);
    expect(result.source).toMatchObject({ method: 'captions', language: 'it' });
    expect(result.source.coverage).not.toContain('frames');
    expect(JSON.stringify(s.calls[0])).not.toContain('video_url');
    expect(result.notice).toContain('non affermare di avere visto immagini');
    expect(result.notice).not.toContain('non contiene una ricetta');
    expect(s.recorder.record).toHaveBeenCalledOnce();
  });
  it('mode suggerito dal modello non basta a togliere le immagini a una ricetta', async () => {
    const s = setup({ html: validCaptionPage, captions: new Response(captionData) });
    const result = await s.tool
      .execute(
        { url, mode: 'summary' },
        { ...ctx(), userMessage: 'Estrai gli ingredienti e la ricetta' },
      )
      .then(readResult);
    expect(result.source.method).toBe('video');
    expect(JSON.stringify(s.calls[0])).toContain('video_url');
    expect(result.analysis.recipe?.ingredients).toContain('400 g di petto di pollo');
    expect(s.fetchMock.mock.calls.some(([u]) => String(u).includes('/api/timedtext'))).toBe(false);
  });
  it.each([
    'Non voglio un riassunto, voglio la ricetta completa',
    'Riassumi il video e salva la ricetta',
  ])('una richiesta mista o negata conserva la ricetta: %s', async (userMessage) => {
    const s = setup({ html: validCaptionPage, captions: new Response(captionData) });
    const result = await s.tool
      .execute({ url, mode: 'summary' }, { ...ctx(), userMessage })
      .then(readResult);
    expect(result.source.method).toBe('video');
    expect(result.analysis.recipe?.ingredients).toContain('400 g di petto di pollo');
    expect(s.fetchMock.mock.calls.some(([u]) => String(u).includes('/api/timedtext'))).toBe(false);
  });
  it('un riassunto culinario usa il video e una cache distinta dai sottotitoli', async () => {
    const s = setup({
      html: validCaptionPage,
      captions: new Response(captionData),
      completions: [textCompletion()],
    });
    await s.tool.execute({ url, mode: 'summary' }, { ...ctx(), userMessage: 'Riassumi il video' });
    const result = await s.tool
      .execute(
        { url, mode: 'summary' },
        { ...ctx(), userMessage: 'Voglio un riassunto della ricetta' },
      )
      .then(readResult);
    expect(s.calls).toHaveLength(2);
    expect(result.source.method).toBe('video');
    expect(result.analysis.recipe).toBeNull();
    expect(result.notice).not.toContain('non contiene una ricetta');
  });
  it('cache separata per scopo e utente; sottotitoli non riusati come ricetta vista', async () => {
    const s = setup({
      html: validCaptionPage,
      captions: new Response(captionData),
      completions: [textCompletion()],
    });
    const summaryCtx = { ...ctx(), userMessage: 'Riassumi questo video' };
    await s.tool.execute({ url, mode: 'summary' }, summaryCtx);
    await s.tool.execute({ url, mode: 'summary' }, summaryCtx);
    const recipe = await s.tool.execute({ url }, ctx()).then(readResult);
    expect(recipe.source.method).toBe('video');
    expect(s.calls).toHaveLength(2);
    await s.tool.execute({ url }, ctx('user-b'));
    expect(s.calls).toHaveLength(3);
  });
  it('sottotitoli mancanti ripiegano sul video senza nuova API o doppia analisi', async () => {
    const s = setup();
    const result = await s.tool
      .execute({ url, mode: 'summary' }, { ...ctx(), userMessage: 'Riassumi questo video' })
      .then(readResult);
    expect(result.source.method).toBe('video');
    expect(result.analysis.recipe).toBeNull();
    expect(s.calls).toHaveLength(1);
    expect(JSON.stringify(s.calls[0])).toContain('video_url');
  });
});
