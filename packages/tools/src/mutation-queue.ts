import { ToolError } from './types.js';

/** Serialize actual writes per account, while unrelated accounts and reads remain independent.
 * A timed-out caller cannot release the lane before the underlying operation has settled.
 * Process-local: database revision checks and idempotency remain necessary across workers/replicas.
 */
export class AccountMutationQueue {
  private readonly accounts = new Map<string, { tail: Promise<void>; count: number }>();

  run<T>(userId: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const queue = this.accounts.get(userId) ?? { tail: Promise.resolve(), count: 0 };
    if (queue.count >= 32)
      return Promise.reject(
        new ToolError(
          'Troppe modifiche in attesa: attendi quelle in corso.',
          'mutation_queue_full',
          true,
        ),
      );
    queue.count++;
    const result = queue.tail.then(() => {
      if (signal?.aborted) throw new ToolError('annullato', 'aborted', false);
      return operation();
    });
    const settled = result.then(
      () => {},
      () => {},
    );
    queue.tail = settled;
    this.accounts.set(userId, queue);
    void settled.then(() => {
      queue.count--;
      if (queue.tail === settled) this.accounts.delete(userId);
    });
    return result;
  }
}
