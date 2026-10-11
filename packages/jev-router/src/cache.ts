import { createHash } from 'node:crypto';
import type { RouteDecision } from './schema.js';

/** Cache esatta delle decisioni: chiave = hash di testo normalizzato + impronta del contesto. Nessuna cache semantica. */
export interface DecisionCache {
  get(key: string): Promise<RouteDecision | undefined>;
  set(key: string, decision: RouteDecision, ttlSeconds: number): Promise<void>;
}

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function decisionCacheKey(text: string, contextFingerprint: string): string {
  return createHash('sha256')
    .update(`${normalizeText(text)}\u0000${contextFingerprint}`)
    .digest('hex')
    .slice(0, 32);
}

export function createMemoryDecisionCache(
  now = () => Date.now(),
): DecisionCache & { size: number } {
  const map = new Map<string, { decision: RouteDecision; expiresAt: number }>();
  return {
    get size() {
      return map.size;
    },
    async get(key) {
      const e = map.get(key);
      if (!e) return undefined;
      if (e.expiresAt <= now()) {
        map.delete(key);
        return undefined;
      }
      return e.decision;
    },
    async set(key, decision, ttlSeconds) {
      map.set(key, { decision, expiresAt: now() + ttlSeconds * 1000 });
    },
  };
}

/** Adapter per un client Redis minimale (ioredis-compatibile). */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
}

export function createRedisDecisionCache(
  redis: RedisLike,
  prefix = 'ernie:router:decision:',
): DecisionCache {
  return {
    async get(key) {
      const raw = await redis.get(prefix + key);
      if (!raw) return undefined;
      try {
        return JSON.parse(raw) as RouteDecision;
      } catch {
        return undefined;
      }
    },
    async set(key, decision, ttlSeconds) {
      await redis.set(prefix + key, JSON.stringify(decision), 'EX', ttlSeconds);
    },
  };
}
