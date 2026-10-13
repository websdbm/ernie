import {
  type CompanionAgent,
  createCompanionAgent,
  type Memory,
  SessionAgentCache,
} from '@ernie/agent-core';
import { buildMemorySnapshot, type MemoryRepository } from '@ernie/memory';
import type { ModelGateway } from '@ernie/model-gateway';
import type { Logger } from '@ernie/observability';
import {
  disabledToolIds,
  enabledSkillIds,
  type LearnedSkillRepository,
  type Skill,
  SkillRegistry,
} from '@ernie/skills';
import { assembleSoul, type SoulRepository } from '@ernie/soul';
import {
  buildSessionTools,
  type ExecutorDeps,
  type ToolContextRef,
  type ToolRegistry,
} from '@ernie/tools';
import type { AuthContext } from './auth.js';
import type { SessionRecord } from './sessions/store.js';

export interface CompanionFactoryDeps {
  readonly gateway: ModelGateway | null;
  readonly memory: Memory;
  readonly souls: SoulRepository;
  readonly logger: Logger;
  readonly cache?: SessionAgentCache;
  readonly memories?: MemoryRepository;
  readonly snapshotMaxChars?: number;
  /** Compattazione dei risultati vecchi dei tool nel prompt (M9 A1); `false` la disattiva. */
  readonly compaction?: { readonly minChars: number; readonly historyBudgetChars: number } | false;
  /** Riassunto della conversazione (ricerca 11 C1), letto a ogni turno dal processore dell'agente. */
  readonly sessionSummary?: (
    userId: string,
    sessionId: string,
  ) => Promise<{ text: string; coveredUntil: Date } | null>;
  readonly tools?: {
    readonly registry: ToolRegistry;
    readonly executor: ExecutorDeps;
    readonly categories: readonly string[];
    readonly core: readonly string[];
  };
  readonly skills?: {
    readonly builtin: readonly Skill[];
    readonly learned: LearnedSkillRepository;
  };
  /**
   * Impostazioni correnti dell'utente (users.settings). L'`AuthContext` di una connessione WS porta la foto
   * delle impostazioni al momento dell'accesso: gli interruttori delle skill cambiano a metà conversazione,
   * quindi registry e tool si basano su questo caricamento (cache 5 minuti, azzerata da `invalidateUser`).
   */
  readonly loadSettings?: (userId: string) => Promise<Readonly<Record<string, unknown>>>;
  /** Famiglia: persone collegate con etichetta, così l'agente sa chi è «Giorgio» e come mandargli un promemoria. */
  readonly family?: {
    list(userId: string): Promise<readonly { label: string; relation: string }[]>;
  };
}

/**
 * Un agente per sessione, costruito una volta: Soul (core dell'utente + context della sessione + policy),
 * snapshot della memoria, set di tool dal registry, classe di modello della sessione, memoria conversazionale.
 * Da qui in avanti il prefisso non cambia; il contesto dei tool cambia per turno tramite `setToolContext`.
 */
export function createCompanionFactory(deps: CompanionFactoryDeps) {
  const cache = deps.cache ?? new SessionAgentCache();
  const toolContexts = new Map<string, ToolContextRef>();
  const skillCache = new Map<string, { registry: SkillRegistry; at: number }>();
  const settingsCache = new Map<
    string,
    { settings: Readonly<Record<string, unknown>>; at: number }
  >();
  const sessionsByUser = new Map<string, Set<string>>();
  const TTL_MS = 5 * 60_000;

  /** Impostazioni correnti: dal caricatore (se c'è) con cache, altrimenti la foto dell'AuthContext. */
  const currentSettings = async (
    auth: Pick<AuthContext, 'userId' | 'settings'>,
  ): Promise<Readonly<Record<string, unknown>>> => {
    if (!deps.loadSettings) return auth.settings;
    const hit = settingsCache.get(auth.userId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.settings;
    try {
      const settings = await deps.loadSettings(auth.userId);
      settingsCache.set(auth.userId, { settings, at: Date.now() });
      return settings;
    } catch (err) {
      deps.logger.warn(
        { err, userId: auth.userId },
        'impostazioni non caricate: uso quelle della sessione',
      );
      return auth.settings;
    }
  };

  return {
    cache,
    /** Imposta (o azzera) il contesto dei tool per il turno corrente della sessione. */
    setToolContext(sessionId: string, ctx: ToolContextRef['current']): void {
      const ref = toolContexts.get(sessionId);
      if (ref) ref.current = ctx;
    },
    invalidate(sessionId: string): void {
      cache.delete(sessionId);
      toolContexts.delete(sessionId);
    },
    /**
     * Dopo un cambio di skill: via registry e impostazioni in cache e gli agenti delle sessioni dell'utente,
     * che al turno successivo vengono ricostruiti con i tool aggiornati. La conversazione resta: la memoria
     * è legata alla sessione, non all'istanza dell'agente.
     */
    invalidateUser(userId: string): void {
      skillCache.delete(userId);
      settingsCache.delete(userId);
      for (const sessionId of sessionsByUser.get(userId) ?? []) {
        cache.delete(sessionId);
        toolContexts.delete(sessionId);
      }
      sessionsByUser.delete(userId);
    },
    /** Registry delle skill per utente: integrate + apprese attive, filtrate dagli interruttori (cache 5 minuti). */
    async skillsFor(auth: Pick<AuthContext, 'userId' | 'settings'>): Promise<SkillRegistry> {
      const hit = skillCache.get(auth.userId);
      if (hit && Date.now() - hit.at < TTL_MS) return hit.registry;
      const all = new SkillRegistry();
      for (const s of deps.skills?.builtin ?? []) all.register(s);
      if (deps.skills)
        for (const s of await deps.skills.learned.loadActiveGuided(auth.userId)) all.register(s);
      const enabled = enabledSkillIds(await currentSettings(auth));
      // Le skill apprese non stanno nel catalogo: restano attive.
      const keep = new Set([
        ...enabled,
        ...all
          .list()
          .filter((s) => !isCatalogSkill(s.id))
          .map((s) => s.id),
      ]);
      const registry = all.only(keep);
      skillCache.set(auth.userId, { registry, at: Date.now() });
      return registry;
    },
    async getCompanion(auth: AuthContext, session: SessionRecord): Promise<CompanionAgent | null> {
      if (!deps.gateway) return null;
      const cached = cache.get(session.id);
      if (cached) return cached;
      const souls = await deps.souls.loadForUser(auth.userId);
      const soul = assembleSoul({
        souls,
        contextTags: session.contextTags,
        companionName: auth.companionName,
      });

      let memorySnapshot: string | undefined;
      if (deps.memories) {
        const snap = buildMemorySnapshot(await deps.memories.listActiveSemantic(auth.userId), {
          maxChars: deps.snapshotMaxChars ?? 2000,
        });
        memorySnapshot = snap.text || undefined;
      }
      if (deps.family) {
        const links = await deps.family.list(auth.userId);
        if (links.length) {
          const line = `Persone collegate (Famiglia): ${links.map((l) => `${l.label} (${l.relation})`).join(', ')}. Per un promemoria a una di loro l'utente dice «ricorda a <nome> di …» (skill Ricordami, senza modello).`;
          memorySnapshot = memorySnapshot ? `${memorySnapshot}\n\n${line}` : line;
        }
      }

      // Set di tool stabile per sessione dal registry (categorie abilitate + nucleo), con contesto per turno.
      let tools: Parameters<typeof createCompanionAgent>[0]['tools'];
      if (deps.tools) {
        const ctxRef: ToolContextRef = { current: null };
        const off = disabledToolIds(await currentSettings(auth));
        const specs = deps.tools.registry
          .select({
            categories: deps.tools.categories,
            scopes: auth.scopes,
            core: deps.tools.core,
          })
          .filter((t) => !off.has(t.id));
        tools = buildSessionTools(specs, deps.tools.executor, ctxRef);
        toolContexts.set(session.id, ctxRef);
      }

      const companion = createCompanionAgent({
        sessionId: session.id,
        userId: auth.userId,
        companionName: auth.companionName,
        soul,
        modelClass: session.modelClass,
        gateway: deps.gateway,
        memory: deps.memory,
        ...(memorySnapshot ? { memorySnapshot } : {}),
        ...(tools ? { tools } : {}),
        ...(deps.sessionSummary
          ? {
              sessionSummary: () =>
                deps.sessionSummary?.(auth.userId, session.id) ?? Promise.resolve(null),
            }
          : {}),
        compaction:
          deps.compaction === false
            ? false
            : {
                ...(deps.compaction ?? {}),
                onCompacted: (s) =>
                  deps.logger.info({ sessionId: session.id, ...s }, 'contesto compattato'),
              },
      });
      deps.logger.info(
        {
          sessionId: session.id,
          soul: soul.used,
          soulTokens: soul.tokenEstimate,
          model: companion.profile.modelId,
          snapshotChars: memorySnapshot?.length ?? 0,
          tools: Object.keys(tools ?? {}),
        },
        'agente di sessione creato',
      );
      cache.set(session.id, companion);
      const sessions = sessionsByUser.get(auth.userId) ?? new Set<string>();
      sessions.add(session.id);
      sessionsByUser.set(auth.userId, sessions);
      return companion;
    },
  };
}

import { SKILL_CATALOG } from '@ernie/skills';

const isCatalogSkill = (id: string): boolean => SKILL_CATALOG.some((s) => s.id === id);
