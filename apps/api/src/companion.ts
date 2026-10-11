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
    /** Invalida le cache dell'utente (dopo un cambio di skill): registry e agenti delle sue sessioni. */
    invalidateUser(userId: string): void {
      skillCache.delete(userId);
    },
    /** Registry delle skill per utente: integrate + apprese attive, filtrate dagli interruttori (cache 5 minuti). */
    async skillsFor(auth: Pick<AuthContext, 'userId' | 'settings'>): Promise<SkillRegistry> {
      const hit = skillCache.get(auth.userId);
      if (hit && Date.now() - hit.at < 5 * 60_000) return hit.registry;
      const all = new SkillRegistry();
      for (const s of deps.skills?.builtin ?? []) all.register(s);
      if (deps.skills)
        for (const s of await deps.skills.learned.loadActiveGuided(auth.userId)) all.register(s);
      const enabled = enabledSkillIds(auth.settings);
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

      // Set di tool stabile per sessione dal registry (categorie abilitate + nucleo), con contesto per turno.
      let tools: Parameters<typeof createCompanionAgent>[0]['tools'];
      if (deps.tools) {
        const ctxRef: ToolContextRef = { current: null };
        const off = disabledToolIds(auth.settings);
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
      return companion;
    },
  };
}

import { SKILL_CATALOG } from '@ernie/skills';

const isCatalogSkill = (id: string): boolean => SKILL_CATALOG.some((s) => s.id === id);
