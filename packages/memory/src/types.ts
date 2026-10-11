export type MemoryKind = 'semantic' | 'episodic' | 'procedural';
export type MemoryStatus = 'active' | 'superseded' | 'deleted';
export type MemoryCategory =
  | 'preference'
  | 'fact'
  | 'relationship'
  | 'project'
  | 'habit'
  | 'outcome'
  | 'error'
  | 'other';

export interface Provenance {
  readonly source: 'user' | 'assistant' | 'tool' | 'web' | 'system';
  /** 0..1: contenuti esterni hanno trust basso e contano come gamba non fidata al recupero. */
  readonly trust: number;
  readonly sessionId?: string;
  readonly requestId?: string;
  readonly url?: string;
  readonly note?: string;
}

export interface MemoryRecord {
  readonly id: string;
  readonly userId: string;
  readonly kind: MemoryKind;
  readonly category: MemoryCategory | null;
  readonly content: string;
  readonly tags: readonly string[];
  readonly provenance: Provenance;
  readonly confidence: number;
  readonly status: MemoryStatus;
  readonly validFrom: Date;
  readonly validTo: Date | null;
  readonly episodeId: string | null;
  readonly supersedesId: string | null;
  readonly seenCount: number;
  readonly lastSeenAt: Date;
  readonly createdAt: Date;
}

export interface MemoryHit extends MemoryRecord {
  readonly score: number;
  readonly ftsRank: number | null;
  readonly vecRank: number | null;
}

export interface RememberInput {
  readonly userId: string;
  readonly kind: MemoryKind;
  readonly category?: MemoryCategory;
  readonly content: string;
  readonly tags?: readonly string[];
  readonly provenance: Provenance;
  readonly confidence?: number;
  readonly episodeId?: string | null;
  /** Il nuovo ricordo sostituisce questo (contraddizione risolta per versioning, non per cancellazione). */
  readonly supersedesId?: string | null;
  readonly validFrom?: Date;
}

export interface SearchInput {
  readonly userId: string;
  readonly query: string;
  readonly kinds?: readonly MemoryKind[];
  readonly limit?: number;
  /** Candidati per ciascuna gamba (full-text e vettoriale) prima della fusione. */
  readonly candidates?: number;
}
