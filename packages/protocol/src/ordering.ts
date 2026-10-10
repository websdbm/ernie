/**
 * Utilità lato ricezione: deduplica per `id` e controllo di sequenza per `seq`.
 * Usate dal client iOS (porting in Swift) e dal server per gli eventi in ingresso.
 */

export class EventDeduper {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly capacity = 2048) {
    if (capacity < 1) throw new RangeError('capacity deve essere >= 1');
  }

  /** Restituisce `true` se l'id era già stato visto (duplicato), altrimenti lo registra. */
  isDuplicate(id: string): boolean {
    if (this.seen.has(id)) return true;
    this.seen.add(id);
    this.order.push(id);
    if (this.order.length > this.capacity) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return false;
  }

  get size(): number {
    return this.seen.size;
  }
}

export type SequenceVerdict =
  | { kind: 'ok' }
  | { kind: 'duplicate'; seq: number }
  | { kind: 'gap'; expected: number; received: number };

/** Verifica che i `seq` arrivino consecutivi; segnala duplicati e buchi (eventi persi). */
export class SequenceTracker {
  private next: number;

  constructor(start = 0) {
    this.next = start;
  }

  get expected(): number {
    return this.next;
  }

  check(seq: number): SequenceVerdict {
    if (seq < this.next) return { kind: 'duplicate', seq };
    if (seq > this.next) {
      const verdict: SequenceVerdict = { kind: 'gap', expected: this.next, received: seq };
      this.next = seq + 1;
      return verdict;
    }
    this.next = seq + 1;
    return { kind: 'ok' };
  }
}

/** Generatore monotono di numeri di sequenza per una direzione. */
export class SequenceSource {
  private current: number;

  constructor(start = 0) {
    this.current = start;
  }

  next(): number {
    return this.current++;
  }

  peek(): number {
    return this.current;
  }
}
