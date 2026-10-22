import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { normalizeSpeechAudio } from './speech-audio.js';

const available = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const ffmpeg = (args: string[], input?: Buffer) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], {
    input,
    timeout: 10_000,
    maxBuffer: 4_000_000,
  });
function fixture(amplitude: number, seconds = 2) {
  const pcm = Buffer.alloc(44_100 * seconds * 4);
  for (let i = 0; i < pcm.length / 4; i++) {
    // Alternanza di sillabe deboli e forti, con armoniche: non solo picco costante.
    const envelope = i % 22050 < 11025 ? 0.35 : 1;
    const wave =
      Math.sin((2 * Math.PI * 170 * i) / 44100) + 0.25 * Math.sin((2 * Math.PI * 510 * i) / 44100);
    pcm.writeFloatLE(amplitude * envelope * wave, i * 4);
  }
  return ffmpeg(
    [
      '-f',
      'f32le',
      '-ar',
      '44100',
      '-ac',
      '1',
      '-i',
      'pipe:0',
      '-c:a',
      'libmp3lame',
      '-f',
      'mp3',
      'pipe:1',
    ],
    pcm,
  );
}
function levels(mp3: Buffer) {
  const pcm = ffmpeg(
    ['-f', 'mp3', '-i', 'pipe:0', '-f', 'f32le', '-ar', '44100', '-ac', '1', 'pipe:1'],
    mp3,
  );
  let energy = 0,
    peak = 0;
  for (let i = 0; i < pcm.length; i += 4) {
    const x = pcm.readFloatLE(i);
    energy += x * x;
    peak = Math.max(peak, Math.abs(x));
  }
  return { db: 10 * Math.log10(energy / (pcm.length / 4)), peak, seconds: pcm.length / 4 / 44100 };
}

describe.skipIf(!available)('speech audio with real FFmpeg', () => {
  it('raises quiet speech, controls loud peaks and preserves the complete duration', async () => {
    for (const amplitude of [0.06, 0.8]) {
      const input = fixture(amplitude),
        before = levels(input);
      const output = await normalizeSpeechAudio(input),
        after = levels(output);
      expect(after.peak).toBeLessThan(0.98);
      expect(after.db).toBeGreaterThan(-16);
      expect(after.db).toBeLessThan(-11);
      expect(Math.abs(after.seconds - before.seconds)).toBeLessThan(0.1);
      if (amplitude === 0.06) expect(after.db - before.db).toBeGreaterThan(8);
    }
  });
  it('does not amplify silence or drop a short utterance', async () => {
    const silence = fixture(0);
    expect(await normalizeSpeechAudio(silence)).toEqual(silence);
    const short = fixture(0.1, 0.15);
    const result = levels(await normalizeSpeechAudio(short));
    expect(result.seconds).toBeGreaterThanOrEqual(0.15);
    expect(result.peak).toBeLessThan(0.98);
  });
  it('rejects malformed, oversized and cancelled audio and releases the processor', async () => {
    await expect(normalizeSpeechAudio(Buffer.from('invalid'))).rejects.toThrow();
    await expect(normalizeSpeechAudio(Buffer.alloc(4_000_001))).rejects.toThrow();
    await expect(normalizeSpeechAudio(fixture(0.1), AbortSignal.abort())).rejects.toThrow();
    expect((await normalizeSpeechAudio(fixture(0.1))).length).toBeGreaterThan(64);
  });
});
