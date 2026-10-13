import type { ClassProfile, ModelGateway } from '@ernie/model-gateway';
import type { AssembledSoul } from '@ernie/soul';
import { Agent } from '@mastra/core/agent';
import type { Memory } from '@mastra/memory';
import { type CompactionOptions, createToolResultCompactor } from './compact.js';
import { createSessionSummaryProcessor, type LoadedSummary } from './session-summary.js';

type AgentTools = NonNullable<ConstructorParameters<typeof Agent>[0]['tools']>;

export interface CompanionAgentInput {
  readonly sessionId: string;
  readonly userId: string;
  readonly companionName: string;
  readonly soul: AssembledSoul;
  readonly modelClass: ClassProfile['modelClass'];
  readonly gateway: ModelGateway;
  readonly memory: Memory;
  /** Snapshot congelato della memoria (entra nel prefisso stabile, dopo il Soul). */
  readonly memorySnapshot?: string;
  /** Set di tool fisso per la sessione (il prefisso resta stabile). */
  readonly tools?: AgentTools;
  /** Compattazione dei risultati vecchi dei tool nel prompt (M9 A1); `false` la disattiva (misure A/B). */
  readonly compaction?: CompactionOptions | false;
  /** Riassunto della conversazione (ricerca 11, C1): sostituisce nel prompt i messaggi già riassunti. */
  readonly sessionSummary?: () => Promise<LoadedSummary | null>;
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
  const instructions = input.memorySnapshot
    ? `${input.soul.instructions}\n\n${input.memorySnapshot}`
    : input.soul.instructions;
  const agent = new Agent({
    id: `companion-${input.sessionId}`,
    name: input.companionName,
    instructions,
    model: resolved.model,
    memory: input.memory,
    ...(input.tools ? { tools: input.tools } : {}),
    inputProcessors: [
      ...(input.sessionSummary ? [createSessionSummaryProcessor(input.sessionSummary)] : []),
      ...(input.compaction === false ? [] : [createToolResultCompactor(input.compaction ?? {})]),
    ],
  });
  return {
    agent,
    profile: resolved.profile,
    provider: resolved.provider,
    prefixFingerprint: `${input.soul.fingerprint}:${resolved.profile.modelId}:${resolved.profile.reasoning}:${Object.keys(
      input.tools ?? {},
    )
      .sort()
      .join(',')}:${input.memorySnapshot?.length ?? 0}`,
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
