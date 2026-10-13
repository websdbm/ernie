import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  type BrainEmbedder,
  type BrainService,
  type ChiSonoInput,
  createBrainIndex,
  createBrainService,
} from '@ernie/brain';
import type { AppConfig } from '@ernie/config';
import type { Pool } from '@ernie/db';
import { type ProfileStore, replaceProfileByUser, type UserProfile } from '@ernie/memory';
import type { Logger } from '@ernie/observability';
import type { BrainToolStore } from '@ernie/tools';

/** Scheda anagrafica → pagina «Chi sono» del second brain. */
export function chiSonoFromProfile(p: UserProfile): ChiSonoInput {
  return {
    fullName: p.fullName ?? null,
    preferredName: p.preferredName ?? null,
    birthDate: p.birthDate ?? null,
    gender: p.gender ?? null,
    city: p.city ?? null,
    occupation: p.occupation ?? null,
    family: p.family.map((m) => ({
      relation: m.relation,
      ...(m.name ? { name: m.name } : {}),
      ...(m.birthDate ? { birthDate: m.birthDate } : {}),
      ...(m.notes ? { notes: m.notes } : {}),
    })),
  };
}

export interface BrainRuntimeDeps {
  readonly config: AppConfig;
  readonly pool: Pool;
  readonly embedder: BrainEmbedder | null;
  readonly profiles: ProfileStore;
  readonly logger: Logger;
  /** La scheda sta nel prefisso dell'agente: se cambia da Obsidian si ricostruiscono gli agenti. */
  readonly onProfileChanged?: (userId: string) => void;
}

export interface BrainRuntime {
  readonly service: BrainService;
  readonly tools: BrainToolStore;
  /** Aggiorna «Chi sono» dalla scheda (dopo una modifica nell'app o dalla chat). */
  refreshChiSono(userId: string): Promise<void>;
  start(): void;
  stop(): void;
}

/**
 * Second brain sul server: un vault git per utente in `BRAIN_DIR`, remoto facoltativo per utente
 * (`BRAIN_REMOTES`), chiave di deploy passata in base64 e scritta all'avvio con permessi 600 (con Docker
 * rootless un file montato non sarebbe leggibile dal processo), sincronizzazione periodica con il remoto.
 */
export async function createBrainRuntime(deps: BrainRuntimeDeps): Promise<BrainRuntime> {
  const cfg = deps.config.brain;
  const dir = resolve(cfg.dir);
  await mkdir(dir, { recursive: true });
  let gitEnv: Record<string, string> | undefined;
  if (cfg.deployKeyB64) {
    const sshDir = join(dir, '.ssh');
    await mkdir(sshDir, { recursive: true, mode: 0o700 });
    const keyPath = join(sshDir, 'deploy_key');
    await writeFile(keyPath, Buffer.from(cfg.deployKeyB64, 'base64'), { mode: 0o600 });
    await chmod(keyPath, 0o600);
    gitEnv = {
      GIT_SSH_COMMAND: `ssh -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${join(sshDir, 'known_hosts')}`,
    };
  }
  const index = createBrainIndex(deps.pool, deps.embedder);
  const service = createBrainService({
    baseDir: dir,
    remotes: new Map(cfg.remotes),
    author: cfg.author,
    index,
    logger: deps.logger,
    ...(gitEnv ? { gitEnv } : {}),
    onChiSonoEdited: async (userId, fields) => {
      const current = await deps.profiles.get(userId);
      const { profile, changes } = replaceProfileByUser(
        current,
        {
          fields,
          family: current.family.map((m) => ({
            id: m.id,
            relation: m.relation,
            name: m.name ?? null,
            birthDate: m.birthDate ?? null,
            notes: m.notes ?? null,
          })),
        },
        new Date(),
      );
      await deps.profiles.save(userId, profile, changes, 'user');
      if (changes.length) {
        deps.logger.info(
          { userId, changes: changes.length },
          'scheda aggiornata da «Chi sono» in Obsidian',
        );
        deps.onProfileChanged?.(userId);
      }
    },
  });

  const refreshChiSono = async (userId: string) => {
    try {
      await service.writeChiSono(userId, chiSonoFromProfile(await deps.profiles.get(userId)));
    } catch (err) {
      deps.logger.warn(
        { userId, err: err instanceof Error ? err.message : String(err) },
        'second brain: «Chi sono» non aggiornata',
      );
    }
  };

  const tools: BrainToolStore = {
    async search(userId, q) {
      return (await service.search(userId, q)).map((h) => ({
        title: h.title,
        path: h.path,
        type: h.type,
        created: h.created,
        refersFrom: h.refersFrom,
        refersTo: h.refersTo,
        place: h.place,
        links: h.links,
        private: h.private,
        passage: h.passage,
      }));
    },
    async read(userId, ref) {
      const r = await service.read(userId, ref);
      if (!r) return null;
      const n = r.note;
      return {
        title: n.title,
        path: n.path,
        type: n.type,
        created: n.created,
        refersFrom: n.refersFrom ?? null,
        refersTo: n.refersTo ?? null,
        place: n.place ?? null,
        links: n.links,
        backlinks: r.backlinks,
        private: n.private,
        body: n.body,
      };
    },
    async write(userId, input) {
      return service.write(userId, input);
    },
  };

  let timer: NodeJS.Timeout | null = null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const [userId] of cfg.remotes) await refreshChiSono(userId);
      const out = await service.syncAll();
      const changed = out.filter((o) => o.changed > 0);
      if (changed.length) deps.logger.info({ sync: changed }, 'second brain sincronizzato');
    } finally {
      running = false;
    }
  };

  return {
    service,
    tools,
    refreshChiSono,
    start() {
      if (timer || cfg.syncIntervalSeconds === 0) return;
      setTimeout(() => void tick(), 5_000).unref();
      timer = setInterval(() => void tick(), cfg.syncIntervalSeconds * 1000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
