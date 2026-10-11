import type { DeterministicSkill, GuidedSkill, Skill } from './types.js';

export interface SkillMatch {
  readonly skill: DeterministicSkill;
  readonly plan: unknown;
}

/** Registry delle skill: integrate (codice) e apprese (guidate, caricate dal database per utente). */
export class SkillRegistry {
  private readonly skills = new Map<string, Skill>();

  register(skill: Skill): this {
    this.skills.set(skill.id, skill);
    return this;
  }

  get(id: string): Skill | undefined {
    return this.skills.get(id);
  }

  list(): Skill[] {
    return [...this.skills.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Copia del registry con le sole skill indicate (interruttori per utente). */
  only(ids: ReadonlySet<string>): SkillRegistry {
    const r = new SkillRegistry();
    for (const s of this.list()) if (ids.has(s.id)) r.register(s);
    return r;
  }

  /** Prima skill deterministica che riconosce la frase: nessun modello coinvolto. */
  match(text: string): SkillMatch | null {
    for (const s of this.list()) {
      if (s.kind !== 'deterministic') continue;
      const plan = s.match(text);
      if (plan !== null && plan !== undefined) return { skill: s, plan };
    }
    return null;
  }

  /** Candidate per Jev: fino a `max` skill, ordinate per sovrapposizione lessicale con descrizione ed esempi. */
  candidates(text: string, max = 5): string[] {
    const words = new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 2),
    );
    const scored = this.list().map((s) => {
      const bag = new Set(
        `${s.description} ${s.examples.join(' ')}`.toLowerCase().split(/[^\p{L}\p{N}]+/u),
      );
      let score = 0;
      for (const w of words) if (bag.has(w)) score++;
      return { id: s.id, score };
    });
    return scored
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, max)
      .map((x) => x.id);
  }

  guided(id: string): GuidedSkill | undefined {
    const s = this.skills.get(id);
    return s?.kind === 'guided' ? s : undefined;
  }
}
