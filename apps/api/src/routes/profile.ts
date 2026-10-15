import {
  describeChange,
  PLACE_RADIUS_DEFAULT,
  PROFILE_FIELDS,
  type ProfileStore,
  replaceProfileByUser,
  setPlaceCoordinates,
  type UserProfile,
} from '@ernie/memory';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthContext, Authenticator } from '../auth.js';
import { createAuthHook } from '../ws/plugin.js';

export interface ProfileRoutesOptions {
  readonly authenticator: Authenticator;
  readonly allowedOrigins: readonly string[];
  readonly profiles: ProfileStore;
  /** Persone collegate in Ernie (Famiglia), mostrate nella scheda ma gestite in Impostazioni › Famiglia. */
  readonly linked?: (userId: string) => Promise<readonly { label: string; relation: string }[]>;
  /** La scheda sta nel prefisso dell'agente: dopo una modifica si ricostruiscono gli agenti di sessione. */
  readonly onChanged?: (userId: string) => void;
  /** Luoghi trovati nelle note del second brain (cartella Luoghi). */
  readonly placeSuggestions?: (userId: string) => Promise<
    ReadonlyArray<{
      label: string;
      title: string;
      address?: string;
      lat?: number;
      lng?: number;
    }>
  >;
}

function requireAuth(req: FastifyRequest): AuthContext {
  const a = req.auth;
  if (!a)
    throw Object.assign(new Error('non autenticato'), { statusCode: 401, code: 'unauthorized' });
  return a;
}

const text = (max: number) => z.string().max(max).nullable().optional();
const PutBody = z
  .object({
    fullName: text(80),
    preferredName: text(40),
    birthDate: text(10),
    gender: text(30),
    city: text(60),
    occupation: text(80),
    family: z
      .array(
        z.object({
          id: z.string().max(40).optional(),
          name: text(60),
          relation: z.string().min(1).max(40),
          birthDate: text(10),
          notes: text(120),
        }),
      )
      .max(20)
      .default([]),
    /** Luoghi (15 ott 2026): assenti dalle app vecchie, che così non li cancellano. */
    places: z
      .array(
        z.object({
          id: z.string().max(40).optional(),
          label: z.string().min(1).max(40),
          address: text(160),
          lat: z.number().min(-90).max(90).nullable().optional(),
          lng: z.number().min(-180).max(180).nullable().optional(),
          radius: z.number().min(50).max(2000).nullable().optional(),
        }),
      )
      .max(10)
      .optional(),
  })
  .strict();

const CoordsBody = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    address: z.string().max(160).optional(),
  })
  .strict();

/** Vista per l'app: campi, famiglia e da dove viene ciascun dato (chat o app, con data e parole dette). */
function view(p: UserProfile) {
  const fields = Object.fromEntries(PROFILE_FIELDS.map((f) => [f, p[f] ?? null]));
  return {
    ...fields,
    family: p.family.map((m) => ({
      id: m.id,
      name: m.name ?? null,
      relation: m.relation,
      birthDate: m.birthDate ?? null,
      notes: m.notes ?? null,
      source: m.meta.source,
      at: m.meta.at,
    })),
    places: p.places.map((pl) => ({
      id: pl.id,
      label: pl.label,
      address: pl.address ?? null,
      lat: pl.lat ?? null,
      lng: pl.lng ?? null,
      radius: pl.radius ?? PLACE_RADIUS_DEFAULT,
      source: pl.meta.source,
      at: pl.meta.at,
    })),
    sources: Object.fromEntries(
      Object.entries(p.meta).map(([k, m]) => [
        k,
        { source: m.source, at: m.at, quote: m.quote ?? null },
      ]),
    ),
  };
}

/** Scheda anagrafica (13 ott 2026): `GET /v1/profile`, `PUT /v1/profile` (sostituzione intera dall'app). */
export async function profileRoutes(
  app: FastifyInstance,
  opts: ProfileRoutesOptions,
): Promise<void> {
  if (!app.hasRequestDecorator('auth')) app.decorateRequest('auth', null);
  await app.register(async (api) => {
    api.addHook('preValidation', createAuthHook(opts.authenticator, opts.allowedOrigins));

    api.get('/v1/profile', async (req) => {
      const { userId } = requireAuth(req);
      const [profile, linked] = await Promise.all([
        opts.profiles.get(userId),
        opts.linked ? opts.linked(userId) : Promise.resolve([]),
      ]);
      return { profile: view(profile), linked };
    });

    api.put('/v1/profile', async (req, reply) => {
      const { userId } = requireAuth(req);
      const b = PutBody.safeParse(req.body);
      if (!b.success)
        return reply.code(400).send({
          error: 'invalid_body',
          message: b.error.issues[0]?.message ?? 'scheda non valida',
        });
      const { family, places, ...fields } = b.data;
      const current = await opts.profiles.get(userId);
      const { profile, changes } = replaceProfileByUser(
        current,
        { fields, family, ...(places ? { places } : {}) },
        new Date(),
      );
      await opts.profiles.save(userId, profile, changes, 'user');
      if (changes.length) opts.onChanged?.(userId);
      return { profile: view(profile), changes: changes.map(describeChange) };
    });

    // Luoghi del second brain non ancora nella scheda: l'app li propone sotto «Luoghi».
    api.get('/v1/profile/place-suggestions', async (req) => {
      const { userId } = requireAuth(req);
      if (!opts.placeSuggestions) return { suggestions: [] };
      const [profile, all] = await Promise.all([
        opts.profiles.get(userId),
        opts.placeSuggestions(userId).catch(() => []),
      ]);
      const taken = new Set(profile.places.map((p) => p.label));
      return { suggestions: all.filter((s) => !taken.has(s.label)).slice(0, 10) };
    });

    // Coordinate trovate dal telefono per un indirizzo detto in chat (geocodifica sul dispositivo).
    api.patch('/v1/profile/places/:id', async (req, reply) => {
      const { userId } = requireAuth(req);
      const id = (req.params as { id: string }).id;
      const b = CoordsBody.safeParse(req.body);
      if (!b.success)
        return reply.code(400).send({ error: 'invalid_body', message: 'attesi lat e lng' });
      const current = await opts.profiles.get(userId);
      const { profile, changes } = setPlaceCoordinates(current, id, b.data);
      if (!changes.length)
        return reply.code(404).send({ error: 'not_found', message: 'luogo inesistente' });
      await opts.profiles.save(userId, profile, changes, 'user');
      opts.onChanged?.(userId);
      return { profile: view(profile) };
    });
  });
}
