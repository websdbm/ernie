import { Memory } from '@mastra/memory';

export type { Memory };

import { PostgresStore } from '@mastra/pg';

export interface StorageOptions {
  readonly connectionString: string;
  /** false solo nella CLI di bootstrap eseguita dal proprietario del database. */
  readonly disableInit?: boolean;
  readonly max?: number;
}

/** Storage Mastra (thread/messaggi conversazionali). Le tabelle mastra_* sono create dalla CLI init-storage. */
export function createMastraStorage(opts: StorageOptions): PostgresStore {
  return new PostgresStore({
    id: 'ernie-storage',
    connectionString: opts.connectionString,
    disableInit: opts.disableInit ?? true,
    max: opts.max ?? 5,
  });
}

export interface MemoryOptions {
  /** Finestra conversazionale in messaggi (M2); dalla M4 budget in token e riassunti progressivi. */
  readonly lastMessages?: number;
}

/** Memoria conversazionale: thread = sessione, resource = utente. Niente recall semantico in M2. */
export function createConversationMemory(storage: PostgresStore, opts: MemoryOptions = {}): Memory {
  return new Memory({
    storage,
    options: {
      lastMessages: opts.lastMessages ?? 20,
      semanticRecall: false,
      workingMemory: { enabled: false },
      generateTitle: false,
    },
  });
}
