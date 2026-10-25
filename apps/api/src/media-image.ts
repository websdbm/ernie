import { spawn } from 'node:child_process';
import { MediaError } from './media.js';

export const MAX_IMAGE_SIDE = 3200;
/** Marker SOF (inizio fotogramma): C0–CF esclusi DHT (C4), JPG (C8) e DAC (CC). */
const isSof = (marker: number) =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

export function jpegSize(data: Buffer): { width: number; height: number } {
  if (
    data.length < 16 ||
    data.readUInt16BE(0) !== 0xffd8 ||
    data.readUInt16BE(data.length - 2) !== 0xffd9
  )
    throw new MediaError(400, 'invalid_image', 'La foto non è un JPEG valido.');
  let offset = 2;
  let size: { width: number; height: number } | null = null;
  // Si leggono tutti i segmenti fino ai dati (SOS): un secondo SOF, con dimensioni diverse da quelle controllate,
  // potrebbe far decodificare a ffmpeg un fotogramma oltre i limiti di pixel.
  while (offset + 4 < data.length) {
    if (data[offset++] !== 0xff) break;
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++] ?? 0;
    if (marker === 0xda || marker === 0xd9) break;
    if (offset + 2 > data.length) break;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) break;
    if (isSof(marker)) {
      // Solo baseline, esteso e progressivo (Huffman) con un'intestazione completa; un secondo SOF è rifiutato.
      if (size || ![0xc0, 0xc1, 0xc2].includes(marker) || length < 8)
        throw new MediaError(400, 'invalid_image', 'Non riesco a leggere questa foto.');
      const height = data.readUInt16BE(offset + 3),
        width = data.readUInt16BE(offset + 5);
      if (width < 1 || height < 1 || width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE)
        throw new MediaError(
          413,
          'image_dimensions',
          'La foto deve avere un lato massimo di 3200 pixel.',
        );
      size = { width, height };
    }
    offset += length;
  }
  if (!size) throw new MediaError(400, 'invalid_image', 'Non riesco a leggere questa foto.');
  return size;
}
let active = 0;
/** Decoder locale limitato a JPEG e pipe; niente URL, shell o file temporanei. */
export async function mediaThumbnail(data: Buffer) {
  const size = jpegSize(data);
  if (active >= 4)
    throw new MediaError(503, 'media_busy', 'Sto elaborando altre immagini. Riprova tra poco.');
  active++;
  try {
    const thumbnail = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-threads',
          '1',
          '-filter_threads',
          '1',
          '-protocol_whitelist',
          'pipe',
          '-f',
          'image2pipe',
          '-c:v',
          'mjpeg',
          // Secondo limite, nel decoder: nessun fotogramma oltre 3200×3200 anche se l'intestazione mente.
          '-max_pixels',
          String(MAX_IMAGE_SIDE * MAX_IMAGE_SIDE),
          '-i',
          'pipe:0',
          '-frames:v',
          '1',
          '-vf',
          "scale=w='min(600,iw)':h='min(600,ih)':force_original_aspect_ratio=decrease",
          '-map_metadata',
          '-1',
          '-q:v',
          '4',
          '-c:v',
          'mjpeg',
          '-f',
          'image2pipe',
          'pipe:1',
        ],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          signal: AbortSignal.timeout(8_000),
          killSignal: 'SIGKILL',
        },
      );
      let failed = false,
        bytes = 0;
      const chunks: Buffer[] = [];
      child.on('error', () => {
        failed = true;
      });
      child.stdin.on('error', () => {});
      child.stderr.resume();
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 400_000) {
          failed = true;
          child.kill('SIGKILL');
        } else chunks.push(chunk);
      });
      child.on('close', (code) => {
        if (failed || code !== 0 || bytes < 16)
          reject(new MediaError(400, 'invalid_image', 'Non riesco a leggere questa foto.'));
        else resolve(Buffer.concat(chunks));
      });
      child.stdin.end(data);
    });
    jpegSize(thumbnail);
    return { ...size, thumbnail };
  } finally {
    active--;
  }
}
