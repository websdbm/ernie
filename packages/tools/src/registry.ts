import type { ToolSpec } from './types.js';

const ID_RE = /^[a-z][a-z0-9_]{1,63}$/;

export interface SelectOptions {
  /** Categorie abilitate per la sessione (set stabile). */
  readonly categories: readonly string[];
  /** Scope dell'utente: i tool con scope mancanti non vengono nemmeno proposti al modello. */
  readonly scopes: readonly string[];
  /** Tool sempre presenti a prescindere dalla categoria. */
  readonly core?: readonly string[];
}

/** Catalogo dei tool: il modello riceve solo gli schemi dei tool pertinenti, mai l'intero catalogo. */
export class ToolRegistry {
  private readonly specs = new Map<string, ToolSpec>();

  register(spec: ToolSpec): this {
    if (!ID_RE.test(spec.id)) throw new Error(`id tool non valido: ${spec.id}`);
    if (this.specs.has(spec.id)) throw new Error(`tool già registrato: ${spec.id}`);
    this.specs.set(spec.id, spec);
    return this;
  }

  get(id: string): ToolSpec | undefined {
    return this.specs.get(id);
  }

  list(): ToolSpec[] {
    return [...this.specs.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  categories(): string[] {
    return [...new Set(this.list().map((s) => s.category))].sort();
  }

  select(opts: SelectOptions): ToolSpec[] {
    const cats = new Set(opts.categories);
    const core = new Set(opts.core ?? []);
    return this.list().filter((s) => {
      if (!(cats.has(s.category) || core.has(s.id))) return false;
      return (s.requiredScopes ?? []).every((scope) => opts.scopes.includes(scope));
    });
  }
}
