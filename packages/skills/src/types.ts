export interface SkillRunContext {
  readonly userId: string;
  readonly sessionId: string | null;
  readonly requestId: string;
}

export interface SkillReply {
  readonly text: string;
  /** Operazioni eseguite (per l'episodio e l'audit). */
  readonly actions: readonly string[];
}

/** Skill deterministica: riconosce la richiesta con regole e la esegue senza modelli. */
export interface DeterministicSkill {
  readonly id: string;
  readonly kind: 'deterministic';
  readonly category: string;
  readonly description: string;
  /** Esempi di frasi che la attivano (per Jev e per la documentazione). */
  readonly examples: readonly string[];
  /** Restituisce un piano eseguibile se la frase è riconosciuta, altrimenti null. */
  readonly match: (text: string) => unknown | null;
  readonly run: (plan: unknown, ctx: SkillRunContext) => Promise<SkillReply>;
}

/** Skill guidata: istruzioni in markdown + tool consentiti; eseguita dal modello della sessione. */
export interface GuidedSkill {
  readonly id: string;
  readonly kind: 'guided';
  readonly category: string;
  readonly description: string;
  readonly examples: readonly string[];
  readonly allowedTools: readonly string[];
  readonly instructions: string;
  readonly riskClass: 'low' | 'high';
}

export type Skill = DeterministicSkill | GuidedSkill;
