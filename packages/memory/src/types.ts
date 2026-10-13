export type MemoryKind = 'semantic' | 'episodic' | 'procedural';
export type MemoryStatus = 'active' | 'superseded' | 'deleted' | 'disputed';
export type MemoryRetention = 'permanent' | 'durable' | 'ephemeral';
export type TemporalKind = 'state' | 'event' | 'plan';
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
  /** Ricerca 11, M1/M2: ritenzione, tipo temporale e gruppo di conflitto («in dubbio»). */
  readonly retention?: MemoryRetention | null;
  readonly temporalKind?: TemporalKind | null;
  readonly conflictGroup?: string | null;
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
  /** Fine della validità (fatti effimeri, stati chiusi). */
  readonly validTo?: Date | null;
  readonly retention?: MemoryRetention;
  readonly temporalKind?: TemporalKind;
  /** Stato iniziale: `disputed` con un gruppo di conflitto quando il giudice non ha prove sufficienti. */
  readonly status?: 'active' | 'disputed' | 'superseded';
  readonly conflictGroup?: string | null;
  /** Vettore già calcolato (il consolidamento lo calcola una volta per il giudice). */
  readonly embedding?: readonly number[] | null;
  /** Salta il controllo dei quasi-duplicati (già fatto a monte). */
  readonly skipNearDuplicate?: boolean;
}

/** Evento sulla memoria per l'audit e per l'avviso «ho aggiornato…» al turno successivo. */
export interface MemoryFactEvent {
  readonly id: string;
  readonly factId: string;
  readonly otherId: string | null;
  readonly event: 'superseded' | 'disputed' | 'reinforced' | 'closed';
  readonly oldText: string | null;
  readonly newText: string | null;
  readonly reasoning: string | null;
  readonly evidence: string | null;
  readonly createdAt: Date;
}

export interface SearchInput {
  readonly userId: string;
  readonly query: string;
  readonly kinds?: readonly MemoryKind[];
  readonly limit?: number;
  /** Candidati per ciascuna gamba (full-text e vettoriale) prima della fusione. */
  readonly candidates?: number;
}
