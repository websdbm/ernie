import {
  type CompanionAgent,
  createCompanionAgent,
  type Memory,
  SessionAgentCache,
} from '@ernie/agent-core';
import { buildMemorySnapshot, createMemorySearchTool, type MemoryRepository } from '@ernie/memory';
import type { ModelGateway } from '@ernie/model-gateway';
import type { Logger } from '@ernie/observability';
import { assembleSoul, type SoulRepository } from '@ernie/soul';
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
}

/**
 * Un agente per sessione, costruito una volta: Soul (core dell'utente + context della sessione + policy),
 * classe di modello della sessione, memoria conversazionale. Da qui in avanti il prefisso non cambia.
 */
export function createCompanionFactory(deps: CompanionFactoryDeps) {
  const cache = deps.cache ?? new SessionAgentCache();
  return {
    cache,
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
      const companion = createCompanionAgent({
        sessionId: session.id,
        userId: auth.userId,
        companionName: auth.companionName,
        soul,
        modelClass: session.modelClass,
        gateway: deps.gateway,
        memory: deps.memory,
      });
      deps.logger.info(
        {
          sessionId: session.id,
          soul: soul.used,
          soulTokens: soul.tokenEstimate,
          model: companion.profile.modelId,
        },
        'agente di sessione creato',
      );
      cache.set(session.id, companion);
      return companion;
    },
  };
}
