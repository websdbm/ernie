import { z } from 'zod';

export const ContentReaderId = z.enum([
  'youtube_metadata',
  'youtube_captions',
  'youtube_video',
  'instagram',
]);
export type ContentReaderId = z.infer<typeof ContentReaderId>;
export const ContentReaderOutcome = z.enum([
  'success',
  'unavailable',
  'blocked',
  'rate_limited',
  'credits',
  'budget',
  'error',
]);
export const ContentReaderAttempt = z.object({
  at: z.iso.datetime(),
  outcome: ContentReaderOutcome,
  message: z.string().max(500),
  durationMs: z.number().int().min(0).max(3_600_000),
});
export type ContentReaderAttempt = z.infer<typeof ContentReaderAttempt>;
export const ContentReadersReport = z.object({
  readers: z.array(
    z.object({
      id: ContentReaderId,
      name: z.string(),
      configured: z.boolean(),
      description: z.string(),
      lastAttempt: ContentReaderAttempt.nullable(),
    }),
  ),
  updatedAt: z.iso.datetime(),
});
export type ContentReadersReport = z.infer<typeof ContentReadersReport>;

/** Provenienza del contenuto: le modalità dichiarano cosa è stato effettivamente letto. */
export const ContentSource = z.object({
  platform: z.enum(['youtube', 'instagram', 'web']),
  url: z.url(),
  title: z.string().nullable(),
  author: z.string().nullable(),
  method: z.enum(['video', 'captions', 'page', 'metadata']),
  retrievedAt: z.iso.datetime(),
  language: z.string().nullable(),
  coverage: z.array(z.enum(['metadata', 'description', 'captions', 'audio', 'frames'])),
  limitations: z.array(z.string().max(500)).max(10),
});
export type ContentSource = z.infer<typeof ContentSource>;
