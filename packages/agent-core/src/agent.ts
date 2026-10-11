import type { ClassProfile, ModelGateway } from '@ernie/model-gateway';
import type { AssembledSoul } from '@ernie/soul';
import { Agent } from '@mastra/core/agent';
import type { Memory } from '@mastra/memory';

export interface CompanionAgentInput {
  readonly sessionId: string;
  readonly userId: string;
  readonly companionName: string;
  readonly soul: AssembledSoul;
  readonly modelClass: ClassProfile['modelClass'];
  readonly gateway: ModelGateway;
  readonly memory: Memory;
}

export interface CompanionAgent {
  readonly agent: Agent;
  readonly profile: ClassProfile;
  readonly provider: string;
  /** Impronta di ciò che determina il prefisso di cache: Soul, modello, (M5) set di tool. */
  readonly prefixFingerprint: string;
}

/**
 * Un agente per sessione, con istruzioni, modello e tool fissi: è questo che rende stabile il prefisso.
 * Le parti variabili (memorie recuperate, orario, modalità vocale) viaggiano nel turno utente.
 */
export function createCompanionAgent(input: CompanionAgentInput): CompanionAgent {
  const resolved = input.gateway.resolve(input.modelClass, input.sessionId);
  const agent = new Agent({
    id: `companion-${input.sessionId}`,
    name: input.companionName,
    instructions: input.soul.instructions,
    model: resolved.model,
    memory: input.memory,
  });
  return {
    agent,
    profile: resolved.profile,
    provider: resolved.provider,
    prefixFingerprint: `${input.soul.fingerprint}:${resolved.profile.modelId}:${resolved.profile.reasoning}`,
  };
}

/** Cache degli agenti per sessione con scadenza per inattività. */
export class SessionAgentCache {
  private readonly entries = new Map<string, { agent: CompanionAgent; lastUsed: number }>();

  constructor(private readonly ttlMs = 30 * 60_000) {}

  get(sessionId: string): CompanionAgent | undefined {
    const e = this.entries.get(sessionId);
    if (!e) return undefined;
    e.lastUsed = Date.now();
    return e.agent;
  }

  set(sessionId: string, agent: CompanionAgent): void {
    this.entries.set(sessionId, { agent, lastUsed: Date.now() });
  }

  delete(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  evictIdle(now = Date.now()): number {
    let n = 0;
    for (const [id, e] of this.entries) {
      if (now - e.lastUsed > this.ttlMs) {
        this.entries.delete(id);
        n++;
      }
    }
    return n;
  }

  get size(): number {
    return this.entries.size;
  }
}
