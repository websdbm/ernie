import {
  ContentReaderAttempt,
  type ContentReaderId,
  type ContentReadersReport,
} from '@ernie/protocol';

export interface ContentReaderStore {
  read(userId: string, reader: ContentReaderId): Promise<string | null>;
  write(userId: string, reader: ContentReaderId, value: string): Promise<void>;
}
export interface ContentReaderDiagnostics {
  record(
    userId: string,
    reader: ContentReaderId,
    outcome: ContentReaderAttempt['outcome'],
    message: string,
    started: number,
  ): Promise<void>;
  report(userId: string): Promise<ContentReadersReport>;
}

/** Solo esiti tecnici dell'account: nessun URL, testo acquisito, cookie o errore grezzo del provider. */
export function createContentReaderDiagnostics(
  store: ContentReaderStore,
  config: { video: boolean },
  now: () => number = Date.now,
): ContentReaderDiagnostics {
  const readers = [
    {
      id: 'youtube_metadata',
      name: 'Metadati YouTube',
      configured: true,
      description: 'Titolo, autore, descrizione e durata. Alcuni dati possono essere mancanti.',
    },
    {
      id: 'youtube_captions',
      name: 'Sottotitoli YouTube',
      configured: true,
      description:
        'Testo pubblico dei sottotitoli per i riassunti. Non legge le scritte nei fotogrammi; quando non disponibile resta la lettura visiva.',
    },
    {
      id: 'youtube_video',
      name: 'Analisi visiva YouTube',
      configured: config.video,
      description:
        'Immagini e audio tramite il servizio AI configurato. Richiede credito e rispetta il limite di 20 minuti.',
    },
    {
      id: 'instagram',
      name: 'Instagram',
      configured: false,
      description:
        'La lettura completa dei Reel non è collegata. Nessun account Instagram viene acquisito automaticamente.',
    },
  ] as const;
  return {
    async record(userId, reader, outcome, message, started) {
      const at = now();
      const value = ContentReaderAttempt.parse({
        at: new Date(at).toISOString(),
        outcome,
        message: message.slice(0, 500),
        durationMs: Math.min(3_600_000, Math.max(0, Math.round(at - started))),
      });
      // La diagnostica è best effort: una scrittura fallita non ripete il contenuto né la chiamata AI.
      await store.write(userId, reader, JSON.stringify(value)).catch(() => {});
    },
    async report(userId) {
      return {
        updatedAt: new Date(now()).toISOString(),
        readers: await Promise.all(
          readers.map(async (reader) => {
            let lastAttempt: ContentReaderAttempt | null = null;
            try {
              const raw = await store.read(userId, reader.id);
              const parsed = raw ? ContentReaderAttempt.safeParse(JSON.parse(raw)) : null;
              if (parsed?.success && now() - Date.parse(parsed.data.at) < 86_400_000)
                lastAttempt = parsed.data;
            } catch {
              /* Esiti scaduti/corrotti o Redis non disponibile: nessuna falsa verifica. */
            }
            return { ...reader, lastAttempt };
          }),
        ),
      };
    },
  };
}

export function readerFailure(error: unknown): {
  outcome: ContentReaderAttempt['outcome'];
  message: string;
} {
  const code = (error as { code?: string })?.code;
  if (code === 'video_credits')
    return { outcome: 'credits', message: 'Credito del servizio video insufficiente.' };
  if (code === 'budget_exceeded' || (error as { name?: string })?.name === 'BudgetExceededError')
    return {
      outcome: 'budget',
      message: 'Limite di spesa raggiunto: nessuna nuova analisi avviata.',
    };
  if (code === 'video_busy' || code === 'rate_limited' || code === 'video_rate_limited')
    return {
      outcome: 'rate_limited',
      message: 'Limite temporaneo del servizio. Attendere prima di riprovare.',
    };
  if (code === 'video_service_error')
    return {
      outcome: 'error',
      message: 'Servizio di analisi video temporaneamente indisponibile.',
    };
  if (code === 'video_service_auth')
    return {
      outcome: 'blocked',
      message: 'Il servizio AI non ha accettato la configurazione di accesso.',
    };
  if (code === 'blocked_domain')
    return { outcome: 'blocked', message: 'Dominio non consentito dalle impostazioni.' };
  if (['video_unavailable', 'video_duration_unknown', 'video_too_long'].includes(code ?? ''))
    return {
      outcome: 'unavailable',
      message: 'Video non leggibile o fuori dai limiti di durata consentiti.',
    };
  return {
    outcome: 'error',
    message: 'Lettura non completata. Nessun contenuto mancante è stato ricostruito.',
  };
}
