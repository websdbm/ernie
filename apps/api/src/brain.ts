import { chmod, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type BrainReviewer, selectReviewNotes } from '@ernie/agent-core';
import {
  type BrainEmbedder,
  type BrainReviewPlan,
  type BrainService,
  type ChiSonoInput,
  contentHash,
  createBrainIndex,
  createBrainService,
} from '@ernie/brain';
import type { AppConfig } from '@ernie/config';
import type { Pool } from '@ernie/db';
import { type ProfileStore, replaceProfileByUser, type UserProfile } from '@ernie/memory';
import type { Logger } from '@ernie/observability';
import type { BrainToolStore } from '@ernie/tools';
import { type BrainResourceSync, createBrainResourceSync } from './brain-resources.js';

/** Scheda anagrafica → pagina «Chi sono» del second brain. */
export function chiSonoFromProfile(p: UserProfile): ChiSonoInput {
  return {
    fullName: p.fullName ?? null,
    preferredName: p.preferredName ?? null,
    birthDate: p.birthDate ?? null,
    gender: p.gender ?? null,
    city: p.city ?? null,
    occupation: p.occupation ?? null,
    email: p.email ?? null,
    family: p.family.map((m) => ({
      relation: m.relation,
      ...(m.name ? { name: m.name } : {}),
      ...(m.birthDate ? { birthDate: m.birthDate } : {}),
      ...(m.notes ? { notes: m.notes } : {}),
    })),
    places: p.places.map((pl) => ({
      id: pl.id,
      label: pl.label,
      ...(pl.address ? { address: pl.address } : {}),
      ...(pl.lat !== undefined && pl.lng !== undefined ? { lat: pl.lat, lng: pl.lng } : {}),
    })),
  };
}

export interface BrainRuntimeDeps {
  readonly canUseResource?: (userId: string, kind: 'recipe' | 'media') => Promise<boolean>;
  readonly config: AppConfig;
  readonly pool: Pool;
  readonly embedder: BrainEmbedder | null;
  readonly profiles: ProfileStore;
  readonly logger: Logger;
  /** La scheda sta nel prefisso dell'agente: se cambia da Obsidian si ricostruiscono gli agenti. */
  readonly onProfileChanged?: (userId: string) => void;
  readonly reviewer?: BrainReviewer;
  /** Include interruttore, skill e controllo genitori; il modello rispetta inoltre il budget giornaliero. */
  readonly mayReconcile?: (userId: string) => Promise<boolean>;
  readonly checkBudget?: (userId: string) => Promise<void>;
}

export interface BrainRuntime {
  readonly resources: BrainResourceSync;
  readonly service: BrainService;
  readonly tools: BrainToolStore;
  /** Aggiorna «Chi sono» dalla scheda (dopo una modifica nell'app o dalla chat). */
  refreshChiSono(userId: string): Promise<void>;
  pendingReview(userId: string): Promise<string | null>;
  runMaintenance(): Promise<void>;
  heartbeat(): Promise<void>;
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
    ...(deps.canUseResource ? { canUseResource: deps.canUseResource } : {}),
    remotes: new Map(cfg.remotes),
    author: cfg.author,
    index,
    logger: deps.logger,
    ...(gitEnv ? { gitEnv } : {}),
    onNotesWritten: async (userId, paths) => {
      if (cfg.reviewIntervalSeconds === 0) return;
      if (deps.mayReconcile && !(await deps.mayReconcile(userId))) return;
      const state = await readState(userId);
      // Nessun modello e nessuna modifica dello stato/cursore della revisione giornaliera.
      const result = await service.reconcile(
        userId,
        { connections: [], questions: state.plan.questions },
        undefined,
        paths,
      );
      if (result.changed)
        deps.logger.info(
          { userId, pages: result.changed },
          'second brain: consolidata area aggiornata',
        );
    },
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

  const queues = new Map<string, Promise<unknown>>();
  const locked = <T>(userId: string, fn: () => Promise<T>): Promise<T> => {
    const next = (queues.get(userId) ?? Promise.resolve()).then(fn, fn);
    queues.set(userId, next);
    void next
      .finally(() => {
        if (queues.get(userId) === next) queues.delete(userId);
      })
      .catch(() => undefined);
    return next;
  };
  const identityQuestions = new Map<string, string[]>();
  const refreshUnlocked = async (userId: string) => {
    const identities = await service.identities(userId);
    const questions: string[] = [];
    for (const identity of identities) {
      if (identity.type !== 'persona') continue;
      const result = await deps.profiles.consolidateFamily(
        userId,
        identity.title,
        identity.aliases
          .filter((a) => a.title.toLocaleLowerCase('it') !== identity.title.toLocaleLowerCase('it'))
          .map((a) => a.title),
      );
      if (result.question) {
        questions.push(result.question);
        continue;
      }
      if (result.changed) deps.onProfileChanged?.(userId);
      // Una fonte ricreata da un vecchio client si riunisce solo con la prova persistente della fusione.
      const existing: string[] = [];
      for (const alias of identity.aliases) {
        const source = await service.read(userId, alias.path);
        if (
          source &&
          !source.note.private &&
          source.note.type === identity.type &&
          source.note.title === alias.title
        )
          existing.push(alias.path);
      }
      if (existing.length) await service.merge(userId, { into: identity.title, notes: existing });
    }
    identityQuestions.set(userId, questions);
    // Anche con dati discordanti non rigenerare gli alias già uniti: prima chiedere chiarimento.
    const profile = chiSonoFromProfile(await deps.profiles.get(userId));
    const aliases = new Set(
      identities
        .filter((n) => n.type === 'persona')
        .flatMap((n) =>
          n.aliases
            .filter((a) => a.title.toLocaleLowerCase('it') !== n.title.toLocaleLowerCase('it'))
            .map((a) => a.title.toLocaleLowerCase('it')),
        ),
    );
    await service.writeChiSono(userId, {
      ...profile,
      family: profile.family.filter((m) => !m.name || !aliases.has(m.name.toLocaleLowerCase('it'))),
    });
  };
  const refreshChiSono = (userId: string) =>
    locked(userId, () => refreshUnlocked(userId)).catch((err: unknown) => {
      deps.logger.warn(
        { userId, err: err instanceof Error ? err.message : String(err) },
        'second brain: «Chi sono» non aggiornata',
      );
    });

  const resources = createBrainResourceSync({
    pool: deps.pool,
    brain: service,
    logger: deps.logger,
    ...(deps.canUseResource ? { canUse: deps.canUseResource } : {}),
  });
  const tools: BrainToolStore = {
    async search(userId, q) {
      await resources.afterChange(userId);
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
      await resources.afterChange(userId);
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
        knowledge: n.knowledge ?? null,
      };
    },
    async updateKnowledge(userId, input) {
      return locked(userId, async () => {
        const result = await service.updateKnowledge(userId, input);
        return {
          path: result.note.path,
          title: result.note.title,
          knowledge: result.note.knowledge,
        };
      });
    },
    async agenda(userId, input) {
      return service.agenda(userId, input);
    },
    async write(userId, input) {
      return locked(userId, () => service.write(userId, input));
    },
    async merge(userId, input) {
      return locked(userId, async () => {
        const result = await service.merge(userId, input);
        // Il commit Git registra già l'unione: se SQL fallisce il prossimo heartbeat la recupera.
        await refreshUnlocked(userId);
        return result;
      });
    },
  };

  let timer: NodeJS.Timeout | null = null;
  let startupTimer: NodeJS.Timeout | null = null;
  let running = false;
  type ReviewState = {
    attemptedAt: number;
    consolidationAttemptedAt?: number;
    fingerprint: string;
    cursor: number;
    versions: Record<string, string>;
    questionsFingerprint: string;
    reviewedAt?: number;
    failures?: number;
    trigger?: string;
    completedAt?: number;
    changed?: number;
    plan: BrainReviewPlan;
    questions: readonly string[];
  };
  const stateDir = join(dir, '.review');
  const statePath = (userId: string) => {
    if (!/^[0-9a-f-]{36}$/iu.test(userId)) throw new Error('utente non valido');
    return join(stateDir, `${userId}.json`);
  };
  const readState = async (userId: string): Promise<ReviewState> => {
    try {
      const s = JSON.parse(await readFile(statePath(userId), 'utf8')) as ReviewState;
      if (
        typeof s.attemptedAt !== 'number' ||
        typeof s.fingerprint !== 'string' ||
        !Array.isArray(s.plan?.connections) ||
        !Array.isArray(s.plan?.questions) ||
        !Array.isArray(s.questions)
      )
        throw new Error('stato non valido');
      return {
        ...s,
        cursor: s.cursor ?? 0,
        versions: s.versions ?? {},
        questionsFingerprint: s.questionsFingerprint ?? '',
      };
    } catch {
      return {
        attemptedAt: 0,
        fingerprint: '',
        cursor: 0,
        versions: {},
        questionsFingerprint: '',
        plan: { connections: [], questions: [] },
        questions: [],
      };
    }
  };
  const saveState = async (userId: string, s: ReviewState) => {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const path = statePath(userId);
    await writeFile(`${path}.tmp`, JSON.stringify(s), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  };
  let lastTick = 0;
  const tick = async (trigger = 'manual') => {
    if (running) return;
    running = true;
    lastTick = Date.now();
    try {
      // Prima le modifiche dell'utente da Obsidian, poi la scheda: non sovrascrivere campi non ancora letti.
      await resources.drain();
      const out = await service.syncAll();
      const changed = out.filter((o) => o.changed > 0);
      if (changed.length) deps.logger.info({ sync: changed }, 'second brain sincronizzato');
      const local = (await readdir(dir, { withFileTypes: true }))
        .filter((d) => d.isDirectory() && /^[0-9a-f-]{36}$/iu.test(d.name))
        .map((d) => d.name);
      const users = new Set([...local, ...cfg.remotes.map(([id]) => id)]);
      for (const userId of users) {
        try {
          if (deps.mayReconcile && !(await deps.mayReconcile(userId))) continue;
          if (cfg.reviewIntervalSeconds === 0) continue;
          let state = await readState(userId);
          const intervalMs = Math.max(86_400, cfg.reviewIntervalSeconds) * 1000;
          // Comprende lo stato precedente al limite giornaliero: un deploy non azzera l'attesa.
          const lastRun = Math.max(
            state.consolidationAttemptedAt ?? 0,
            state.attemptedAt,
            state.completedAt ?? 0,
          );
          if (Date.now() - lastRun < intervalMs) continue;
          // Prenota l'intera passata prima di SQL, Git o modello. Anche un errore consuma il giro giornaliero.
          state = { ...state, consolidationAttemptedAt: Date.now() };
          await saveState(userId, state);
          await locked(userId, async () => {
            await refreshUnlocked(userId);
            if (cfg.reviewIntervalSeconds !== 0 && (await service.consolidateDuplicates(userId)))
              await refreshUnlocked(userId);
          });
          const snapshot = await service.reviewSnapshot(userId);
          const versions = Object.fromEntries(
            snapshot.notes.map((n) => [n.path, contentHash(JSON.stringify(n))]),
          );
          const unchanged = (path: string) =>
            Boolean(versions[path]) && state.versions[path] === versions[path];
          // Una citazione ancora presente non basta se nel frattempo è cambiata l'identità della destinazione.
          state = {
            ...state,
            plan: {
              connections: state.plan.connections.filter(
                (c) => unchanged(c.source) && unchanged(c.target),
              ),
              questions: state.plan.questions.filter(
                (q) => unchanged(q.target) && q.sources.every(unchanged),
              ),
            },
          };
          if (
            deps.reviewer &&
            snapshot.notes.some((note) => state.versions[note.path] !== versions[note.path])
          ) {
            // Persistito prima della chiamata: anche timeout e riavvio rispettano il limite di frequenza.
            state = { ...state, attemptedAt: Date.now() };
            await saveState(userId, state);
            try {
              await deps.checkBudget?.(userId);
              const batch = selectReviewNotes(snapshot.notes, state.cursor);
              const plan = await deps.reviewer(batch, userId);
              if (!plan) throw new Error('revisione senza esito valido');
              if (plan) {
                const paths = new Set(batch.map((n) => n.path));
                state = {
                  ...state,
                  cursor: state.cursor + 1,
                  reviewedAt: Date.now(),
                  failures: 0,
                  versions: {
                    ...state.versions,
                    ...Object.fromEntries(batch.map((n) => [n.path, versions[n.path] ?? ''])),
                  },
                  plan: {
                    connections: [
                      ...state.plan.connections.filter(
                        (c) => !paths.has(c.source) || !paths.has(c.target),
                      ),
                      ...plan.connections,
                    ].slice(-500),
                    questions: [
                      ...state.plan.questions.filter(
                        (q) => !paths.has(q.target) || q.sources.some((p) => !paths.has(p)),
                      ),
                      ...plan.questions,
                    ].slice(-20),
                  },
                  fingerprint: snapshot.fingerprint,
                };
              }
            } catch (err) {
              state = { ...state, failures: (state.failures ?? 0) + 1 };
              deps.logger.warn(
                { userId, err: err instanceof Error ? err.message : String(err) },
                'revisione semantica rinviata',
              );
            }
          }
          // Collegamenti certi nella passata giornaliera; quelli semantici sono riusati solo finché le citazioni esistono.
          const result = await service.reconcile(userId, state.plan, snapshot.fingerprint);
          if (result.stale) continue;
          state = {
            ...state,
            questions: [
              ...new Set([...(identityQuestions.get(userId) ?? []), ...result.questions]),
            ],
            questionsFingerprint: snapshot.fingerprint,
            completedAt: Date.now(),
            trigger,
            changed: result.changed,
          };
          await saveState(userId, state);
          if (result.changed)
            deps.logger.info(
              { userId, pages: result.changed, doubts: result.questions.length },
              'second brain consolidato',
            );
        } catch (err) {
          deps.logger.warn(
            { userId, err: err instanceof Error ? err.message : String(err) },
            'riordino second brain rinviato',
          );
        }
      }
    } catch (err) {
      deps.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'manutenzione second brain fallita',
      );
    } finally {
      running = false;
    }
  };

  return {
    resources,
    service,
    tools,
    refreshChiSono,
    runMaintenance: () => tick(),
    async heartbeat() {
      await resources.drain();
      if (cfg.syncIntervalSeconds === 0 || Date.now() - lastTick < cfg.syncIntervalSeconds * 1000)
        return;
      await tick('heartbeat');
    },
    async pendingReview(userId) {
      if (
        cfg.reviewIntervalSeconds === 0 ||
        (deps.mayReconcile && !(await deps.mayReconcile(userId)))
      )
        return null;
      const state = await readState(userId);
      if (!state.questions.length) return null;
      const snapshot = await service.reviewSnapshot(userId);
      if (state.questionsFingerprint !== snapshot.fingerprint) return null;
      return state.questions[0] ?? null;
    },
    start() {
      if (timer || cfg.syncIntervalSeconds === 0) return;
      startupTimer = setTimeout(() => void tick('startup'), 5_000);
      startupTimer.unref();
      // Fallback se un battito pub/sub viene perso o il worker non è disponibile.
      timer = setInterval(
        () => {
          if (Date.now() - lastTick >= cfg.syncIntervalSeconds * 1000) void tick('fallback');
        },
        Math.max(60, cfg.syncIntervalSeconds * 2) * 1000,
      );
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      if (startupTimer) clearTimeout(startupTimer);
      timer = null;
    },
  };
}
