import { spawn } from 'node:child_process';

const COMPRESSOR = 'acompressor=threshold=0.125:ratio=3:attack=10:release=150:makeup=1';
const MAX_BYTES = 4_000_000;
let active = 0;

/** Solo pipe: nessun audio su disco, nessuna shell, nessun protocollo di rete nel decoder. */
async function processAudio(input: Buffer, args: string[], signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<{ audio: Buffer; log: string }>((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-nostdin',
        '-nostats',
        '-threads',
        '1',
        '-filter_threads',
        '1',
        '-protocol_whitelist',
        'pipe',
        '-f',
        'mp3',
        '-i',
        'pipe:0',
        '-map',
        '0:a:0',
        '-vn',
        '-sn',
        '-dn',
        ...args,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], signal, killSignal: 'SIGKILL' },
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    let log = '';
    let failure: Error | undefined;
    child.on('error', () => {
      failure = new Error('Elaborazione audio non disponibile');
    });
    child.stdin.on('error', () => {
      /* La chiusura del processo determina l'esito. */
    });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) {
        failure = new Error('Audio elaborato troppo lungo');
        child.kill('SIGKILL');
      } else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // Il log non viene mai persistito o esposto; conserva solo la coda delle statistiche.
      log = (log + chunk.toString()).slice(-16_384);
    });
    child.on('close', (code) => {
      if (failure || code !== 0 || signal.aborted)
        reject(failure ?? new Error('Elaborazione audio interrotta'));
      else resolve({ audio: Buffer.concat(chunks), log });
    });
    child.stdin.end(input);
  });
}

/** Livella ogni frase e limita i picchi, senza cambiare tono/velocità o il volume di sistema. */
export async function normalizeSpeechAudio(input: Buffer, signal?: AbortSignal): Promise<Buffer> {
  if (input.length > MAX_BYTES || active >= 4) throw new Error('Elaborazione audio occupata');
  const abort = AbortSignal.any([
    signal ?? new AbortController().signal,
    AbortSignal.timeout(8_000),
  ]);
  active++;
  try {
    const measured = await processAudio(
      input,
      ['-af', `${COMPRESSOR},volumedetect`, '-f', 'null', '-'],
      abort,
    );
    const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(measured.log);
    const mean = match ? Number(match[1]) : Number.NaN;
    if (!Number.isFinite(mean)) throw new Error('Livello audio non misurabile');
    // Non trasformare silenzio/rumore quasi impercettibile in un soffio amplificato.
    if (mean < -55) return input;
    const gain = Math.min(18, Math.max(-24, -12 - mean));
    const result = await processAudio(
      input,
      [
        '-af',
        `${COMPRESSOR},volume=${gain.toFixed(2)}dB,aresample=176400,alimiter=limit=0.84:level=false:attack=5:release=80:latency=true`,
        '-ar',
        '44100',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '128k',
        '-map_metadata',
        '-1',
        '-f',
        'mp3',
        'pipe:1',
      ],
      abort,
    );
    if (result.audio.length < 64) throw new Error('Audio elaborato vuoto');
    return result.audio;
  } finally {
    active--;
  }
}
