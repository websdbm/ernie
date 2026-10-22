import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Vault del second brain: una cartella di file markdown sotto git, una per utente. Il repository locale c'è
 * sempre (cronologia e annullamento delle modifiche di Ernie); il remoto è facoltativo e per utente
 * (es. `git@github.com:websdbm/ernie-brain.git`, aperto anche con Obsidian). Tutte le operazioni su un vault
 * passano da una coda: niente due scritture git insieme.
 */
export interface VaultOptions {
  readonly dir: string;
  readonly remote?: string;
  /** Variabili per git (es. GIT_SSH_COMMAND con la chiave di deploy). */
  readonly env?: Readonly<Record<string, string>>;
  readonly author?: { readonly name: string; readonly email: string };
  readonly branch?: string;
}

export interface SyncResult {
  readonly changed: string[];
  readonly removed: string[];
  readonly conflict: boolean;
  readonly head: string | null;
  /** Autori dei commit arrivati con la sincronizzazione, per file. */
  readonly authors: Readonly<Record<string, readonly string[]>>;
}

export class VaultPathError extends Error {}
export class VaultChangedError extends Error {}

export class GitVault {
  private queue: Promise<unknown> = Promise.resolve();
  private ready: Promise<void> | null = null;
  readonly branch: string;

  constructor(private readonly opts: VaultOptions) {
    this.branch = opts.branch ?? 'main';
  }

  get dir(): string {
    return this.opts.dir;
  }

  get hasRemote(): boolean {
    return Boolean(this.opts.remote);
  }

  private git(args: string[], allowFail = false): Promise<{ stdout: string; stderr: string }> {
    const author = this.opts.author ?? { name: 'Ernie', email: 'ernie@localhost' };
    return run('git', args, {
      cwd: this.opts.dir,
      env: {
        ...process.env,
        ...this.opts.env,
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: author.name,
        GIT_COMMITTER_EMAIL: author.email,
        GIT_TERMINAL_PROMPT: '0',
      },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
    }).catch((err: unknown) => {
      if (allowFail) {
        const e = err as { stdout?: string; stderr?: string };
        return { stdout: e.stdout ?? '', stderr: e.stderr ?? String(err) };
      }
      throw err;
    });
  }

  /** Esegue `fn` in coda sul vault. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Prepara il vault una volta: clona il remoto se c'è, altrimenti crea un repository vuoto con un README. */
  ensure(): Promise<void> {
    this.ready ??= this.exclusive(async () => {
      const exists = await stat(join(this.opts.dir, '.git')).then(
        () => true,
        () => false,
      );
      if (exists) return;
      await mkdir(this.opts.dir, { recursive: true });
      if (this.opts.remote) {
        const cloned = await run('git', ['clone', this.opts.remote, this.opts.dir], {
          env: { ...process.env, ...this.opts.env, GIT_TERMINAL_PROMPT: '0' },
          timeout: 120_000,
        }).then(
          () => true,
          () => false,
        );
        if (cloned) {
          const head = await this.git(['rev-parse', '--verify', 'HEAD'], true);
          if (head.stdout.trim()) return;
          await this.git(['checkout', '-B', this.branch], true);
        } else {
          await this.git(['init', '-b', this.branch]);
          await this.git(['remote', 'add', 'origin', this.opts.remote]);
        }
      } else {
        await this.git(['init', '-b', this.branch]);
      }
      await writeFile(
        join(this.opts.dir, 'README.md'),
        '# Second brain\n\nNote di Ernie e tue, in markdown. Si apre con Obsidian.\n',
      );
      await this.git(['add', '-A']);
      await this.git(['commit', '-m', 'Ernie: inizio del second brain']);
      if (this.opts.remote) await this.git(['push', '-u', 'origin', this.branch], true);
    });
    return this.ready;
  }

  /** Percorso relativo sicuro (dentro il vault, solo .md, niente .git). */
  resolve(path: string): string {
    const rel = normalize(path).replace(/^([/\\])+/, '');
    if (!rel.toLowerCase().endsWith('.md')) throw new VaultPathError('solo file .md');
    const abs = join(this.opts.dir, rel);
    const back = relative(this.opts.dir, abs);
    if (back.startsWith('..') || back.split(sep).some((part) => part.toLowerCase() === '.git'))
      throw new VaultPathError('percorso fuori dal vault');
    return abs;
  }

  /** Un remoto Git può contenere symlink: il controllo lessicale da solo non confina I/O nel vault. */
  private async safePath(path: string): Promise<string> {
    const abs = this.resolve(path);
    let current = this.opts.dir;
    for (const part of relative(this.opts.dir, abs).split(sep)) {
      current = join(current, part);
      const info = await lstat(current).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return null;
        throw err;
      });
      if (info?.isSymbolicLink())
        throw new VaultPathError('link simbolico non consentito nel vault');
    }
    return abs;
  }

  async read(path: string): Promise<string | null> {
    await this.ensure();
    return readFile(await this.safePath(path), 'utf8').catch(() => null);
  }

  async exists(path: string): Promise<boolean> {
    return (await this.read(path)) !== null;
  }

  /** Elenco dei file .md (percorsi relativi). */
  async list(): Promise<string[]> {
    await this.ensure();
    const out: string[] = [];
    const walk = async (d: string) => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
        const abs = join(d, e.name);
        if (e.isDirectory()) await walk(abs);
        else if (e.name.toLowerCase().endsWith('.md'))
          out.push(relative(this.opts.dir, abs).split(sep).join('/'));
      }
    };
    await walk(this.opts.dir);
    return out.filter((p) => p !== 'README.md').sort();
  }

  /** Scrive (o toglie, con `content` null) dei file e fa un commit; con il remoto, sincronizza e spinge. */
  async commit(
    files: ReadonlyArray<{ path: string; content: string | null }>,
    message: string,
    expected?: ReadonlyMap<string, string | null>,
  ): Promise<string | null> {
    await this.ensure();
    return this.exclusive(async () => {
      return this.commitUnlocked(files, message, expected);
    });
  }

  /** Read-modify-write under the same queue as commit/sync; callback must not call commit itself. */
  async mutate<T>(
    change: () => Promise<{
      files: ReadonlyArray<{ path: string; content: string | null }>;
      message: string;
      result: T;
    }>,
  ): Promise<T> {
    await this.ensure();
    return this.exclusive(async () => {
      const update = await change();
      if (update.files.length) await this.commitUnlocked(update.files, update.message);
      return update.result;
    });
  }

  private async commitUnlocked(
    files: ReadonlyArray<{ path: string; content: string | null }>,
    message: string,
    expected?: ReadonlyMap<string, string | null>,
  ): Promise<string | null> {
    // Valida tutti i percorsi prima di modificare il primo file.
    const targets = await Promise.all(files.map((f) => this.safePath(f.path)));
    // La revisione può impiegare un modello: nessuna scrittura se nel frattempo cambia una fonte.
    for (const [path, before] of expected ?? []) {
      const current = await readFile(await this.safePath(path), 'utf8').catch(() => null);
      if (current !== before) throw new VaultChangedError('fonti cambiate durante la revisione');
    }
    for (const [index, f] of files.entries()) {
      const abs = targets[index];
      if (!abs) throw new VaultPathError('percorso mancante');
      if (f.content === null) await rm(abs, { force: true });
      else {
        await mkdir(dirname(abs), { recursive: true });
        // I lettori non devono vedere un file troncato durante la scrittura.
        const temp = join(dirname(abs), `.ernie-${randomUUID()}.tmp`);
        try {
          await writeFile(temp, f.content, { flag: 'wx' });
          await rename(temp, abs);
        } finally {
          await rm(temp, { force: true });
        }
      }
    }
    const paths = files.map((f) => f.path);
    await this.git(['add', '-A', '--', ...paths]);
    const status = await this.git(['status', '--porcelain', '--', ...paths]);
    if (!status.stdout.trim()) return this.headUnlocked(); // niente di nuovo da salvare
    await this.git(['commit', '-m', message.slice(0, 200), '--', ...paths]);
    if (this.opts.remote) await this.pushUnlocked();
    return this.headUnlocked();
  }

  private async headUnlocked(): Promise<string | null> {
    const r = await this.git(['rev-parse', 'HEAD'], true);
    return r.stdout.trim() || null;
  }

  head(): Promise<string | null> {
    return this.exclusive(() => this.headUnlocked());
  }

  private async pushUnlocked(): Promise<void> {
    const pushed = await this.git(['push', 'origin', this.branch], true);
    if (!/rejected|error|fatal/i.test(pushed.stderr)) return;
    // Il remoto è avanti (modifiche da Obsidian): si integra e si riprova una volta.
    await this.pullUnlocked();
    await this.git(['push', 'origin', this.branch], true);
  }

  /**
   * Integra il remoto. Prima prova a riapplicare le modifiche di Ernie sopra quelle remote; se c'è un conflitto,
   * vince la versione remota (quella scritta dall'utente in Obsidian) e le modifiche di Ernie restano nella
   * cronologia.
   */
  private async pullUnlocked(): Promise<{ conflict: boolean }> {
    const fetched = await this.git(['fetch', 'origin', this.branch], true);
    if (/fatal|error/i.test(fetched.stderr) && !/couldn't find remote ref/i.test(fetched.stderr))
      throw new Error(`git fetch: ${fetched.stderr.slice(0, 300)}`);
    const remoteHead = await this.git(['rev-parse', '--verify', `origin/${this.branch}`], true);
    if (!remoteHead.stdout.trim()) return { conflict: false };
    const rebased = await this.git(['rebase', `origin/${this.branch}`], true);
    if (!/conflict|error|fatal|could not/i.test(rebased.stderr)) return { conflict: false };
    await this.git(['rebase', '--abort'], true);
    await this.git(['merge', '-X', 'theirs', '--no-edit', `origin/${this.branch}`], true);
    return { conflict: true };
  }

  /** Sincronizza con il remoto e dice quali file sono cambiati (per reindicizzarli). */
  async sync(): Promise<SyncResult> {
    await this.ensure();
    return this.exclusive(async () => {
      const before = await this.headUnlocked();
      if (!this.opts.remote)
        return { changed: [], removed: [], conflict: false, head: before, authors: {} };
      const { conflict } = await this.pullUnlocked();
      await this.git(['push', 'origin', this.branch], true);
      const after = await this.headUnlocked();
      if (!before || !after || before === after)
        return { changed: [], removed: [], conflict, head: after, authors: {} };
      const diff = await this.git(['diff', '--name-status', before, after]);
      const changed: string[] = [];
      const removed: string[] = [];
      for (const line of diff.stdout.split('\n')) {
        const [status, a, b] = line.split('\t');
        if (!status || !a) continue;
        if (status.startsWith('R') && b) {
          removed.push(a);
          changed.push(b);
        } else if (status === 'D') removed.push(a);
        else changed.push(a);
      }
      const md = (p: string) => p.toLowerCase().endsWith('.md') && p !== 'README.md';
      const authors: Record<string, string[]> = {};
      for (const p of changed.filter(md)) {
        const log = await this.git(['log', '--format=%an', `${before}..${after}`, '--', p], true);
        authors[p] = [
          ...new Set(
            log.stdout
              .split('\n')
              .map((a) => a.trim())
              .filter(Boolean),
          ),
        ];
      }
      return {
        changed: changed.filter(md),
        removed: removed.filter(md),
        conflict,
        head: after,
        authors,
      };
    });
  }

  /** Autore dell'ultimo commit che ha toccato il file («Ernie» o la persona da Obsidian). */
  async lastAuthor(path: string): Promise<string | null> {
    await this.ensure();
    return this.exclusive(async () => {
      const r = await this.git(['log', '-1', '--format=%an', '--', path], true);
      return r.stdout.trim() || null;
    });
  }
}
