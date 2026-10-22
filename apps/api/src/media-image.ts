import { spawn } from 'node:child_process';
import { MediaError } from './media.js';

export function jpegSize(data: Buffer): { width: number; height: number } {
  if (
    data.length < 16 ||
    data.readUInt16BE(0) !== 0xffd8 ||
    data.readUInt16BE(data.length - 2) !== 0xffd9
  )
    throw new MediaError(400, 'invalid_image', 'La foto non è un JPEG valido.');
  let offset = 2;
  while (offset + 4 < data.length) {
    if (data[offset++] !== 0xff) break;
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++] ?? 0;
    if (marker === 0xda || marker === 0xd9) break;
    if (offset + 2 > data.length) break;
    const size = data.readUInt16BE(offset);
    if (size < 2 || offset + size > data.length) break;
    if ([0xc0, 0xc1, 0xc2].includes(marker) && size >= 8) {
      const height = data.readUInt16BE(offset + 3),
        width = data.readUInt16BE(offset + 5);
      if (width < 1 || height < 1 || width > 3200 || height > 3200)
        throw new MediaError(
          413,
          'image_dimensions',
          'La foto deve avere un lato massimo di 3200 pixel.',
        );
      return { width, height };
    }
    offset += size;
  }
  throw new MediaError(400, 'invalid_image', 'Non riesco a leggere questa foto.');
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
