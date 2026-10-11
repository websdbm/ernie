import { createHash } from 'node:crypto';

/**
 * Rilevatore di loop: la stessa chiamata (tool + argomenti) ripetuta troppe volte in un turno
 * interrompe la run. I tool di polling hanno una soglia più alta (03-revisione A.7).
 */
export class StuckDetector {
  private readonly counts = new Map<string, number>();
  private readonly pollingRe: RegExp;

  constructor(
    private readonly limit = 3,
    private readonly pollingLimit = 8,
    pollingPattern = /poll|status|wait|check/i,
  ) {
    this.pollingRe = pollingPattern;
  }

  check(toolId: string, args: unknown): 'ok' | 'stuck' {
    const key = `${toolId}:${createHash('sha256')
      .update(JSON.stringify(args ?? null))
      .digest('hex')
      .slice(0, 16)}`;
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    const limit = this.pollingRe.test(toolId) ? this.pollingLimit : this.limit;
    return n > limit ? 'stuck' : 'ok';
  }
}
