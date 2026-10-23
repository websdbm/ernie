import { randomUUID } from 'node:crypto';
import { type PoolClient, withUser } from '@ernie/db';
import {
  SshDiagnosticInput,
  SshImportInput,
  SshImportPreview,
  SshOperation,
  SshPlanInput,
  SshProvider,
  SshProviderCredentials,
  SshProviderInstance,
  SshServer,
  SshServerInput,
  SshSite,
  SshSiteInput,
  SshSnapshot,
} from '@ernie/protocol';
import { z } from 'zod';
import { decryptSecret, type EncryptedSecret, encryptSecret, parseMasterKey } from './crypto.js';
import { SshError, type SshServiceOptions, type SshTransportResult } from './types.js';

type ServerRow = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  provider: SshProvider | null;
  provider_instance_id: string | null;
  fingerprint: string | null;
  observed_fingerprint: string | null;
  revision: number;
  last_checked_at: Date | null;
  last_status: string | null;
  source: string | null;
  source_id: string | null;
  manual_fields: string[];
};
type SiteRow = {
  id: string;
  server_id: string;
  name: string;
  url: string;
  path: string;
  container: string;
  revision: number;
  source: string | null;
  source_id: string | null;
  manual_fields: string[];
};
type KeyRow = {
  private_secret: EncryptedSecret | null;
  public_key: string;
  fingerprint: string;
  version: number;
  created_at: Date;
  revoked_at: Date | null;
};
type ProviderRow = {
  provider: SshProvider;
  secret: EncryptedSecret | null;
  version: number;
  connected: boolean;
  last_checked_at: Date | null;
};
type Target = {
  server: SshServer;
  site: SshSite | null;
  siteRevision: number | null;
  keyVersion: number | null;
  keyFingerprint: string | null;
  provider: SshProvider | null;
  providerVersion: number | null;
};
type OperationRow = {
  id: string;
  server_id: string;
  plan: z.infer<typeof SshPlanInput>;
  target_snapshot: Target;
  generation: number;
  status: SshOperation['status'];
  created_at: Date;
  expires_at: Date;
  output: string | null;
};
const serverOf = (r: ServerRow): SshServer =>
  SshServer.parse({
    id: r.id,
    name: r.name,
    host: r.host,
    port: r.port,
    username: r.username,
    provider: r.provider,
    providerInstanceId: r.provider_instance_id,
    fingerprint: r.fingerprint,
    revision: r.revision,
    lastCheckedAt: r.last_checked_at?.toISOString() ?? null,
    lastStatus: r.last_status,
  });
const siteOf = (r: SiteRow): SshSite =>
  SshSite.parse({
    id: r.id,
    serverId: r.server_id,
    name: r.name,
    url: r.url,
    path: r.path,
    container: r.container,
  });
function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success)
    throw new SshError('invalid_input', 'I dati della richiesta SSH non sono validi.');
  return r.data;
}
const idOf = (value: string) => parse(z.uuid(), value).toLowerCase();
export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function checkedPath(path: string): string {
  if (
    !path.startsWith('/') ||
    [...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new SshError(
      'site_path_required',
      'Indica un percorso WordPress assoluto valido per il sito.',
    );
  return path;
}
function checkedSiteUrl(value: string): void {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    [...url.searchParams.keys()].some((key) =>
      /^(?:token|access_token|api_key|password|secret|authorization)$/i.test(key),
    )
  )
    throw new SshError('secret_in_url', 'Il sito deve avere un URL senza credenziali o token.');
}
/** WP plan commands are argument strings, not a second shell script. */
export function wordpressCommand(site: SshSite, args: string): string {
  checkedPath(site.path);
  if (site.container && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(site.container))
    throw new SshError(
      'invalid_container',
      'Indica un nome container Docker valido, senza opzioni.',
    );
  if (!args.trim() || /[\n\r;|&`$<>\\]/.test(args))
    throw new SshError(
      'invalid_wp_command',
      'Indica soltanto gli argomenti WP-CLI, senza pipe, redirezioni o altri comandi shell.',
    );
  const unquote = (v: string) => v.replace(/^(['"])(.*)\1$/, '$2');
  const words = (args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map(unquote);
  if (
    words.length === 0 ||
    words.some(
      (w) =>
        w.startsWith('--path') ||
        w === '--ssh' ||
        w.startsWith('--ssh=') ||
        w === '--http' ||
        w.startsWith('--http='),
    )
  )
    throw new SshError('invalid_wp_command', 'Il bersaglio WP-CLI è fissato dal sito selezionato.');
  const command = `wp --path=${shellQuote(site.path)} ${words.map(shellQuote).join(' ')}`;
  return site.container ? `docker exec ${shellQuote(site.container)} ${command}` : command;
}
export function diagnosticCommand(
  input: z.infer<typeof SshDiagnosticInput>,
  site: SshSite | null,
): string {
  switch (input.check) {
    case 'overview':
      return 'uname -sr; uptime; id';
    case 'disk':
      return 'df -hP; df -iP';
    case 'services':
      return 'systemctl --no-pager --plain list-units --type=service --state=running,failed';
    case 'logs':
      return 'journalctl --no-pager -n 80 --output=short-iso';
    case 'docker':
      return "docker ps --format '{{.ID}} {{.Names}} {{.Status}}'; docker system df";
    case 'wordpress':
      if (!site) throw new SshError('site_required', 'Seleziona il sito WordPress da controllare.');
      return wordpressCommand(site, 'core version');
  }
}
export function sanitizeSshOutput(value: string, secrets: string[] = []): string {
  let text = value;
  for (const secret of secrets)
    if (secret.length >= 4) text = text.replaceAll(secret, '[SEGRETO RIMOSSO]');
  return text
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      '[CHIAVE PRIVATA RIMOSSA]',
    )
    .replace(
      /\b((?:[\w.-]*)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|client[_-]?secret|authorization|secret)(?:[\w.-]*)["']?\s*[:=]\s*)(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[SEGRETO RIMOSSO]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9_.~+/-]+=*/gi, 'Bearer [SEGRETO RIMOSSO]')
    .replace(
      /\b((?:postgres(?:ql)?|mysql|redis|https?):\/\/)[^\s/@]+:[^\s/@]+@/gi,
      '$1[CREDENZIALI RIMOSSE]@',
    )
    .slice(0, 20_000);
}
function safePlanText(value: string): void {
  if (
    /-----BEGIN [^-]*PRIVATE KEY|\bBearer\s+\S+|\b[\w.-]*(?:password|passwd|token|secret|api[_-]?key|client[_-]?secret|authorization)[\w.-]*["']?\s*[:=]/i.test(
      value,
    )
  )
    throw new SshError(
      'secret_in_plan',
      'Non inserire credenziali nel piano o nei comandi. Usa i collegamenti protetti.',
    );
}
export function canonicalImportSource(source: string): string {
  const url = new URL(source);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw new SshError(
      'invalid_source',
      'La fonte deve essere un indirizzo HTTP/HTTPS senza credenziali.',
    );
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString();
}

export function createSshService(opts: SshServiceOptions) {
  const master = parseMasterKey(opts.masterKey),
    now = opts.now ?? (() => new Date());
  const active = new Map<string, { userId: string; controller: AbortController }>();
  const guard = async (userId: string) => {
    let yes = false;
    try {
      yes = await opts.canUse(userId);
    } catch {
      /* deny */
    }
    if (!yes)
      throw new SshError('skill_disabled', 'La skill SSH è disattivata per questo account.', 403);
  };
  const needMaster = () => {
    if (!master)
      throw new SshError('not_configured', 'La cifratura SSH non è configurata sul backend.', 503);
    return master;
  };
  const lock = async <T>(userId: string, fn: (c: PoolClient) => Promise<T>, check = true) =>
    withUser(opts.pool, userId, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`ssh:${userId}`]);
      if (check) await guard(userId);
      await c.query('INSERT INTO ssh_account_state(user_id) VALUES($1) ON CONFLICT DO NOTHING', [
        userId,
      ]);
      return fn(c);
    });
  const audit = async (
    c: PoolClient,
    u: string,
    action: string,
    metadata: Record<string, unknown> = {},
  ) => {
    await c.query('INSERT INTO ssh_audit_events(user_id,action,metadata) VALUES($1,$2,$3::jsonb)', [
      u,
      action,
      JSON.stringify(metadata),
    ]);
  };
  const server = async (c: PoolClient, u: string, id: string) => {
    const r = (
      await c.query<ServerRow>('SELECT * FROM ssh_servers WHERE user_id=$1 AND id=$2', [
        u,
        idOf(id),
      ])
    ).rows[0];
    if (!r) throw new SshError('not_found', 'Server non trovato.', 404);
    return r;
  };
  const site = async (c: PoolClient, u: string, id: string, serverId?: string) => {
    const r = (
      await c.query<SiteRow>('SELECT * FROM ssh_sites WHERE user_id=$1 AND id=$2', [u, idOf(id)])
    ).rows[0];
    if (!r || (serverId && r.server_id !== idOf(serverId)))
      throw new SshError('not_found', 'Sito non trovato per questo server.', 404);
    return r;
  };
  const key = async (c: PoolClient, u: string) => {
    const r = (
      await c.query<KeyRow>('SELECT * FROM ssh_keys WHERE user_id=$1 AND revoked_at IS NULL', [u])
    ).rows[0];
    if (!r?.private_secret)
      throw new SshError(
        'key_required',
        'Genera e installa la chiave pubblica dell’account sul server.',
        409,
      );
    return r;
  };
  const credential = async (c: PoolClient, u: string, p: SshProvider) => {
    const r = (
      await c.query<ProviderRow>(
        'SELECT * FROM ssh_provider_credentials WHERE user_id=$1 AND provider=$2 AND connected',
        [u, p],
      )
    ).rows[0];
    if (!r?.secret)
      throw new SshError(
        'provider_required',
        'Collega prima le credenziali del provider per questo account.',
        409,
      );
    return r;
  };
  const decodeCredential = (u: string, r: ProviderRow) =>
    parse(
      SshProviderCredentials,
      JSON.parse(
        decryptSecret(needMaster(), u, `provider:${r.provider}`, r.secret as EncryptedSecret),
      ),
    );
  const adapter = (p: SshProvider) => {
    const a = opts.providers[p];
    if (!a)
      throw new SshError(
        'provider_unavailable',
        'Il collegamento a questo provider non è disponibile.',
        503,
      );
    return a;
  };
  const recoverExpired = async (c: PoolClient, u: string) => {
    await c.query(
      "UPDATE ssh_operations SET status='uncertain',finished_at=now(),output='Esecuzione precedente interrotta o scaduta: verifica lo stato remoto. Non verrà ripetuta.' WHERE user_id=$1 AND status='running' AND expires_at<=$2",
      [u, now()],
    );
  };
  const publicOperation = (r: OperationRow): SshOperation =>
    SshOperation.parse({
      ...r.plan,
      id: r.id,
      serverName: r.target_snapshot.server.name,
      host: r.target_snapshot.server.host,
      status:
        r.status === 'pending' && r.expires_at.getTime() <= now().getTime() ? 'expired' : r.status,
      createdAt: r.created_at.toISOString(),
      expiresAt: r.expires_at.toISOString(),
      output: r.output,
    });
  const operationRow = async (c: PoolClient, u: string, id: string) => {
    const r = (
      await c.query<OperationRow>('SELECT * FROM ssh_operations WHERE user_id=$1 AND id=$2', [
        u,
        idOf(id),
      ])
    ).rows[0];
    if (!r) throw new SshError('not_found', 'Operazione non trovata.', 404);
    return r;
  };
  const invalidateRows = async (c: PoolClient, u: string, reason: string, serverId?: string) => {
    await c.query(
      "UPDATE ssh_operations SET status=CASE WHEN status='running' THEN 'uncertain' ELSE 'rejected' END,output=$2,finished_at=now() WHERE user_id=$1 AND status IN ('pending','running') AND ($3::uuid IS NULL OR server_id=$3)",
      [u, reason, serverId ?? null],
    );
  };
  const abortUser = (u: string) => {
    for (const run of active.values()) if (run.userId === u) run.controller.abort();
  };
  const currentTarget = async (
    c: PoolClient,
    u: string,
    input: z.infer<typeof SshPlanInput>,
  ): Promise<Target> => {
    const s = await server(c, u, input.serverId),
      si = input.siteId ? await site(c, u, input.siteId, s.id) : null;
    const targetServer = { ...serverOf(s), lastCheckedAt: null, lastStatus: null };
    if (input.kind === 'provider_reboot') {
      if (!s.provider || !s.provider_instance_id)
        throw new SshError(
          'provider_mapping_required',
          'Associa esplicitamente server e istanza del provider prima del riavvio.',
          409,
        );
      const p = await credential(c, u, s.provider);
      adapter(s.provider);
      return {
        server: targetServer,
        site: si ? siteOf(si) : null,
        siteRevision: si?.revision ?? null,
        keyVersion: null,
        keyFingerprint: null,
        provider: s.provider,
        providerVersion: p.version,
      };
    }
    if (!s.fingerprint)
      throw new SshError(
        'host_untrusted',
        'Verifica e conferma l’impronta del server prima di collegarti.',
        409,
      );
    const k = await key(c, u);
    needMaster();
    if (input.kind === 'wp_cli' && !si)
      throw new SshError('site_required', 'Seleziona il sito WordPress dell’intervento.');
    return {
      server: targetServer,
      site: si ? siteOf(si) : null,
      siteRevision: si?.revision ?? null,
      keyVersion: k.version,
      keyFingerprint: k.fingerprint,
      provider: null,
      providerVersion: null,
    };
  };
  const targetStillCurrent = async (c: PoolClient, u: string, r: OperationRow) => {
    const generation = (
      await c.query<{ generation: number }>(
        'SELECT generation FROM ssh_account_state WHERE user_id=$1',
        [u],
      )
    ).rows[0]?.generation;
    if (generation !== r.generation) return false;
    const signature = (t: Target) =>
      JSON.stringify([
        t.server.id,
        t.server.revision,
        t.server.host,
        t.server.port,
        t.server.username,
        t.server.fingerprint,
        t.server.provider,
        t.server.providerInstanceId,
        t.site?.id ?? null,
        t.site?.serverId ?? null,
        t.site?.path ?? null,
        t.site?.container ?? null,
        t.siteRevision,
        t.keyVersion,
        t.keyFingerprint,
        t.provider,
        t.providerVersion,
      ]);
    try {
      return signature(await currentTarget(c, u, r.plan)) === signature(r.target_snapshot);
    } catch {
      return false;
    }
  };
  const started = <T>(promise: Promise<T>): Promise<T> => {
    void promise.catch(() => {});
    return promise;
  };
  const resultText = (r: SshTransportResult, secrets: string[] = []) => {
    const output = sanitizeSshOutput(
      `Codice uscita: ${r.exitCode}\n${r.stdout}\n${r.stderr}${r.truncated ? '\n[Output troncato]' : ''}`,
      secrets,
    );
    return output.length > 9000 ? `${output.slice(0, 9000)}\n[Output della fase troncato]` : output;
  };

  const service = {
    async snapshot(u: string): Promise<SshSnapshot> {
      await guard(u);
      const data = await withUser(opts.pool, u, async (c) => {
        await recoverExpired(c, u);
        const k = (
          await c.query<Pick<KeyRow, 'public_key' | 'fingerprint' | 'created_at'>>(
            'SELECT public_key,fingerprint,created_at FROM ssh_keys WHERE user_id=$1 AND revoked_at IS NULL',
            [u],
          )
        ).rows[0];
        const servers = (
          await c.query<ServerRow>('SELECT * FROM ssh_servers WHERE user_id=$1 ORDER BY name,id', [
            u,
          ])
        ).rows.map(serverOf);
        const sites = (
          await c.query<SiteRow>('SELECT * FROM ssh_sites WHERE user_id=$1 ORDER BY name,id', [u])
        ).rows.map(siteOf);
        const providers = (
          await c.query<Pick<ProviderRow, 'provider' | 'connected' | 'last_checked_at'>>(
            'SELECT provider,connected,last_checked_at FROM ssh_provider_credentials WHERE user_id=$1 ORDER BY provider',
            [u],
          )
        ).rows.map((p) => ({
          provider: p.provider,
          connected: p.connected,
          lastCheckedAt: p.last_checked_at?.toISOString() ?? null,
        }));
        const operations = (
          await c.query<OperationRow>(
            'SELECT * FROM ssh_operations WHERE user_id=$1 ORDER BY created_at DESC,id LIMIT 100',
            [u],
          )
        ).rows.map(publicOperation);
        return SshSnapshot.parse({
          configured: master !== null,
          key: k
            ? {
                publicKey: k.public_key,
                fingerprint: k.fingerprint,
                createdAt: k.created_at.toISOString(),
              }
            : null,
          servers,
          sites,
          providers,
          operations,
        });
      });
      await guard(u);
      return data;
    },
    async invalidate(u: string): Promise<void> {
      await lock(
        u,
        async (c) => {
          await c.query('UPDATE ssh_account_state SET generation=generation+1 WHERE user_id=$1', [
            u,
          ]);
          await invalidateRows(
            c,
            u,
            'Skill disattivata: il piano precedente non è più autorizzato.',
          );
          await audit(c, u, 'invalidate');
        },
        false,
      );
      abortUser(u);
    },
    async keyGenerate(u: string, rotate = false): Promise<SshSnapshot> {
      await guard(u);
      const encryption = needMaster();
      let changed = false;
      await lock(u, async (c) => {
        const existing = (await c.query<KeyRow>('SELECT * FROM ssh_keys WHERE user_id=$1', [u]))
          .rows[0];
        if (existing && !existing.revoked_at && !rotate) return;
        const generated = await opts.transport.generateKey();
        await guard(u);
        if (!generated.privateKey || !generated.publicKey || !generated.fingerprint)
          throw new SshError(
            'key_generation_failed',
            'Generazione della chiave non riuscita.',
            503,
          );
        await c.query(
          `INSERT INTO ssh_keys(user_id,private_secret,public_key,fingerprint) VALUES($1,$2::jsonb,$3,$4) ON CONFLICT(user_id) DO UPDATE SET private_secret=EXCLUDED.private_secret,public_key=EXCLUDED.public_key,fingerprint=EXCLUDED.fingerprint,version=ssh_keys.version+1,created_at=now(),revoked_at=NULL`,
          [
            u,
            JSON.stringify(encryptSecret(encryption, u, 'ssh-private', generated.privateKey)),
            generated.publicKey,
            generated.fingerprint,
          ],
        );
        await c.query('UPDATE ssh_account_state SET generation=generation+1 WHERE user_id=$1', [u]);
        await c.query(
          "UPDATE ssh_servers SET last_status='key_install_required',last_checked_at=NULL WHERE user_id=$1",
          [u],
        );
        await invalidateRows(
          c,
          u,
          'Chiave cambiata: prepara un nuovo piano e installa la nuova pubblica.',
        );
        await audit(c, u, 'key_generate', { fingerprint: generated.fingerprint });
        changed = true;
      });
      if (changed) abortUser(u);
      return service.snapshot(u);
    },
    async keyRevoke(u: string): Promise<SshSnapshot> {
      await lock(u, async (c) => {
        await c.query(
          'UPDATE ssh_keys SET private_secret=NULL,revoked_at=now(),version=version+1 WHERE user_id=$1',
          [u],
        );
        await c.query('UPDATE ssh_account_state SET generation=generation+1 WHERE user_id=$1', [u]);
        await c.query(
          "UPDATE ssh_servers SET last_status='key_revoked',last_checked_at=NULL WHERE user_id=$1",
          [u],
        );
        await invalidateRows(c, u, 'Chiave revocata: nessun comando successivo è autorizzato.');
        await audit(c, u, 'key_revoke');
      });
      abortUser(u);
      return service.snapshot(u);
    },
    async serverSave(u: string, input: z.input<typeof SshServerInput>): Promise<SshSnapshot> {
      const value = parse(SshServerInput, input),
        id = value.id ? idOf(value.id) : randomUUID();
      await lock(u, async (c) => {
        const old = value.id ? await server(c, u, id) : null;
        await c.query(
          `INSERT INTO ssh_servers(user_id,id,name,host,port,username,provider,provider_instance_id,manual_fields) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(user_id,id) DO UPDATE SET name=EXCLUDED.name,host=EXCLUDED.host,port=EXCLUDED.port,username=EXCLUDED.username,provider=EXCLUDED.provider,provider_instance_id=EXCLUDED.provider_instance_id,fingerprint=CASE WHEN ssh_servers.host=EXCLUDED.host AND ssh_servers.port=EXCLUDED.port THEN ssh_servers.fingerprint ELSE NULL END,observed_fingerprint=NULL,revision=ssh_servers.revision+1,manual_fields=EXCLUDED.manual_fields`,
          [
            u,
            id,
            value.name,
            value.host,
            value.port,
            value.username,
            value.provider,
            value.providerInstanceId,
            ['name', 'host', 'port', 'username', 'provider', 'providerInstanceId'],
          ],
        );
        if (old) await invalidateRows(c, u, 'Server modificato: approva un nuovo piano.', id);
        await audit(c, u, 'server_save', { serverId: id });
      });
      return service.snapshot(u);
    },
    async siteSave(u: string, input: z.input<typeof SshSiteInput>): Promise<SshSnapshot> {
      const value = parse(SshSiteInput, input),
        id = value.id ? idOf(value.id) : randomUUID();
      checkedSiteUrl(value.url);
      if (value.path) checkedPath(value.path);
      await lock(u, async (c) => {
        await server(c, u, value.serverId);
        const old = value.id ? await site(c, u, id) : null;
        await c.query(
          `INSERT INTO ssh_sites(user_id,id,server_id,name,url,path,container,manual_fields) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(user_id,id) DO UPDATE SET server_id=EXCLUDED.server_id,name=EXCLUDED.name,url=EXCLUDED.url,path=EXCLUDED.path,container=EXCLUDED.container,revision=ssh_sites.revision+1,manual_fields=EXCLUDED.manual_fields`,
          [
            u,
            id,
            idOf(value.serverId),
            value.name,
            value.url,
            value.path,
            value.container,
            ['serverId', 'name', 'url', 'path', 'container'],
          ],
        );
        if (old)
          await invalidateRows(
            c,
            u,
            'Configurazione sito modificata: approva un nuovo piano.',
            old.server_id,
          );
        await audit(c, u, 'site_save', { siteId: id });
      });
      return service.snapshot(u);
    },
    async hostProbe(u: string, id: string): Promise<{ fingerprint: string }> {
      await guard(u);
      const target = await withUser(opts.pool, u, async (c) => serverOf(await server(c, u, id)));
      let fingerprint: string;
      try {
        fingerprint = (await opts.transport.probe(target)).fingerprint;
      } catch {
        throw new SshError(
          'probe_failed',
          'Impossibile leggere l’impronta host. Controlla host, porta e rete.',
          502,
        );
      }
      if (!fingerprint || fingerprint.length > 512)
        throw new SshError('probe_failed', 'Il server non ha restituito un’impronta valida.', 502);
      await lock(u, async (c) => {
        const current = await server(c, u, id);
        if (current.revision !== target.revision)
          throw new SshError('target_changed', 'Il server è cambiato: ripeti la verifica.', 409);
        await c.query(
          'UPDATE ssh_servers SET observed_fingerprint=$3,last_checked_at=now(),last_status=$4 WHERE user_id=$1 AND id=$2',
          [
            u,
            current.id,
            fingerprint,
            current.fingerprint && current.fingerprint !== fingerprint
              ? 'host_key_changed'
              : 'host_probed',
          ],
        );
        await audit(c, u, 'host_probe', { serverId: current.id, fingerprint });
      });
      return { fingerprint };
    },
    async hostTrust(u: string, id: string, fingerprint: string): Promise<SshSnapshot> {
      await lock(u, async (c) => {
        const target = await server(c, u, id);
        if (!fingerprint || target.observed_fingerprint !== fingerprint)
          throw new SshError(
            'fingerprint_mismatch',
            'L’impronta non coincide con l’ultima rilevazione. Verificala prima di confermare.',
            409,
          );
        await c.query(
          'UPDATE ssh_servers SET fingerprint=$3,revision=revision+1,last_status=$4 WHERE user_id=$1 AND id=$2',
          [u, target.id, fingerprint, 'host_trusted'],
        );
        await invalidateRows(c, u, 'Impronta aggiornata: approva un nuovo piano.', target.id);
        await audit(c, u, 'host_trust', { serverId: target.id, fingerprint });
      });
      return service.snapshot(u);
    },
    async diagnose(
      u: string,
      input: z.input<typeof SshDiagnosticInput>,
      signal?: AbortSignal,
    ): Promise<{ output: string }> {
      const value = parse(SshDiagnosticInput, input),
        runId = randomUUID(),
        controller = new AbortController();
      await guard(u);
      signal?.throwIfAborted();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      active.set(runId, { userId: u, controller });
      try {
        const dispatched = await lock(u, async (c) => {
          const s = serverOf(await server(c, u, value.serverId));
          if (!s.fingerprint)
            throw new SshError(
              'host_untrusted',
              'Conferma l’impronta del server prima della diagnosi.',
              409,
            );
          const si = value.siteId ? siteOf(await site(c, u, value.siteId, s.id)) : null,
            k = await key(c, u),
            privateKey = decryptSecret(
              needMaster(),
              u,
              'ssh-private',
              k.private_secret as EncryptedSecret,
            );
          const command = diagnosticCommand(value, si);
          await audit(c, u, 'diagnose', { serverId: s.id, check: value.check });
          controller.signal.throwIfAborted();
          return {
            pending: started(opts.transport.run(s, privateKey, command, controller.signal)),
            privateKey,
          };
        });
        const result = await dispatched.pending;
        await guard(u);
        const output = resultText(result, [dispatched.privateKey]);
        await lock(u, async (c) => {
          await c.query(
            'UPDATE ssh_servers SET last_checked_at=now(),last_status=$3 WHERE user_id=$1 AND id=$2',
            [u, idOf(value.serverId), `${value.check}: ${result.exitCode === 0 ? 'ok' : 'failed'}`],
          );
        });
        return { output };
      } catch (error) {
        if (error instanceof SshError) throw error;
        throw new SshError(
          'diagnosis_failed',
          'Diagnosi interrotta o collegamento SSH non riuscito. Nessuna modifica è stata richiesta.',
          502,
        );
      } finally {
        signal?.removeEventListener('abort', abort);
        active.delete(runId);
      }
    },
    async providerSave(u: string, provider: SshProvider, input: unknown): Promise<SshSnapshot> {
      const p = parse(SshProvider, provider),
        value = parse(SshProviderCredentials, input);
      if (value.provider !== p)
        throw new SshError(
          'invalid_provider',
          'Le credenziali non appartengono al provider selezionato.',
        );
      await guard(u);
      needMaster();
      try {
        parse(z.array(SshProviderInstance), await adapter(p).list(value));
      } catch (error) {
        if (error instanceof SshError) throw error;
        throw new SshError(
          'provider_auth_failed',
          'Credenziali provider non verificate. Controlla accesso API e autorizzazioni.',
          502,
        );
      }
      await lock(u, async (c) => {
        await c.query(
          `INSERT INTO ssh_provider_credentials(user_id,provider,secret,last_checked_at) VALUES($1,$2,$3::jsonb,now()) ON CONFLICT(user_id,provider) DO UPDATE SET secret=EXCLUDED.secret,connected=true,version=ssh_provider_credentials.version+1,last_checked_at=now()`,
          [
            u,
            p,
            JSON.stringify(encryptSecret(needMaster(), u, `provider:${p}`, JSON.stringify(value))),
          ],
        );
        await c.query(
          "UPDATE ssh_operations SET status='rejected',output='Credenziali provider cambiate: prepara un nuovo piano.' WHERE user_id=$1 AND status='pending' AND target_snapshot->>'provider'=$2",
          [u, p],
        );
        await audit(c, u, 'provider_connect', { provider: p });
      });
      return service.snapshot(u);
    },
    async providerDisconnect(u: string, provider: SshProvider): Promise<SshSnapshot> {
      const p = parse(SshProvider, provider);
      await lock(u, async (c) => {
        await c.query(
          'UPDATE ssh_provider_credentials SET secret=NULL,connected=false,version=version+1 WHERE user_id=$1 AND provider=$2',
          [u, p],
        );
        await c.query(
          "UPDATE ssh_operations SET status=CASE WHEN status='running' THEN 'uncertain' ELSE 'rejected' END,output='Provider scollegato: operazione non più autorizzata.' WHERE user_id=$1 AND status IN ('pending','running') AND target_snapshot->>'provider'=$2",
          [u, p],
        );
        await audit(c, u, 'provider_disconnect', { provider: p });
      });
      abortUser(u);
      return service.snapshot(u);
    },
    async providerInstances(
      u: string,
      provider: SshProvider,
    ): Promise<{ instances: SshProviderInstance[] }> {
      const p = parse(SshProvider, provider);
      await guard(u);
      const value = await withUser(opts.pool, u, async (c) =>
        decodeCredential(u, await credential(c, u, p)),
      );
      try {
        const instances = parse(z.array(SshProviderInstance), await adapter(p).list(value));
        await guard(u);
        return { instances };
      } catch (error) {
        if (error instanceof SshError) throw error;
        throw new SshError(
          'provider_list_failed',
          'Impossibile leggere le istanze del provider.',
          502,
        );
      }
    },
    async importPreview(
      u: string,
      input: z.input<typeof SshImportInput>,
    ): Promise<z.infer<typeof SshImportPreview>> {
      const value = parse(SshImportInput, input);
      return lock(u, async (c) => await importInventory(c, u, value, false));
    },
    async importApply(u: string, input: z.input<typeof SshImportInput>): Promise<SshSnapshot> {
      const value = parse(SshImportInput, input);
      await lock(u, async (c) => {
        await importInventory(c, u, value, true);
        await audit(c, u, 'import_apply', {
          source: canonicalImportSource(value.source),
          servers: value.servers.length,
          sites: value.sites.length,
        });
      });
      return service.snapshot(u);
    },
    async plan(u: string, input: z.input<typeof SshPlanInput>): Promise<SshOperation> {
      const value = parse(SshPlanInput, input);
      value.serverId = idOf(value.serverId);
      if (value.siteId) value.siteId = idOf(value.siteId);
      for (const text of [
        value.command,
        value.verificationCommand,
        value.backup,
        value.rollback,
        value.reason,
        value.title,
      ])
        safePlanText(text);
      if (value.kind !== 'provider_reboot' && (!value.command || !value.verificationCommand))
        throw new SshError(
          'verification_required',
          'Il piano deve includere comando e verifica del risultato.',
        );
      if (value.kind === 'provider_reboot' && (value.command || value.verificationCommand))
        throw new SshError('invalid_reboot_plan', 'Il riavvio provider non esegue comandi SSH.');
      const result = await lock(u, async (c) => {
        const target = await currentTarget(c, u, value);
        if (value.kind === 'wp_cli') {
          wordpressCommand(target.site as SshSite, value.command);
          wordpressCommand(target.site as SshSite, value.verificationCommand);
        }
        const generation = (
          await c.query<{ generation: number }>(
            'SELECT generation FROM ssh_account_state WHERE user_id=$1',
            [u],
          )
        ).rows[0]?.generation as number;
        const identical = (
          await c.query<OperationRow>(
            "SELECT * FROM ssh_operations WHERE user_id=$1 AND status='pending' AND plan=$2::jsonb AND target_snapshot=$3::jsonb AND generation=$4 AND expires_at>$5 ORDER BY created_at LIMIT 1",
            [u, JSON.stringify(value), JSON.stringify(target), generation, now()],
          )
        ).rows[0];
        if (identical) return publicOperation(identical);
        const created = now(),
          expires = new Date(created.getTime() + 30 * 60_000),
          id = randomUUID();
        const row = (
          await c.query<OperationRow>(
            `INSERT INTO ssh_operations(user_id,id,server_id,plan,target_snapshot,generation,status,created_at,expires_at) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,'pending',$7,$8) RETURNING *`,
            [
              u,
              id,
              target.server.id,
              JSON.stringify(value),
              JSON.stringify(target),
              generation,
              created,
              expires,
            ],
          )
        ).rows[0] as OperationRow;
        await audit(c, u, 'plan', {
          operationId: id,
          serverId: target.server.id,
          kind: value.kind,
        });
        return publicOperation(row);
      });
      return result;
    },
    async operation(u: string, id: string): Promise<SshOperation> {
      await guard(u);
      return withUser(opts.pool, u, async (c) => {
        await recoverExpired(c, u);
        return publicOperation(await operationRow(c, u, id));
      });
    },
    async reject(u: string, id: string): Promise<SshOperation> {
      return lock(u, async (c) => {
        const r = await operationRow(c, u, id);
        if (r.status === 'pending')
          await c.query(
            "UPDATE ssh_operations SET status='rejected',finished_at=now(),output='Piano rifiutato dall’utente.' WHERE user_id=$1 AND id=$2 AND status='pending'",
            [u, r.id],
          );
        await audit(c, u, 'reject', { operationId: r.id });
        return publicOperation(await operationRow(c, u, id));
      });
    },
    async approve(u: string, id: string): Promise<SshOperation> {
      const claimed = await lock(u, async (c) => {
        await recoverExpired(c, u);
        const r = await operationRow(c, u, id);
        if (r.status !== 'pending') return { row: r, execute: false };
        if (r.expires_at.getTime() <= now().getTime()) {
          await c.query(
            "UPDATE ssh_operations SET status='expired',output='Piano scaduto: preparane uno nuovo.' WHERE user_id=$1 AND id=$2",
            [u, r.id],
          );
          return { row: await operationRow(c, u, id), execute: false };
        }
        if (!(await targetStillCurrent(c, u, r))) {
          await c.query(
            "UPDATE ssh_operations SET status='rejected',output='Bersaglio o autorizzazioni cambiati: serve un nuovo piano.' WHERE user_id=$1 AND id=$2",
            [u, r.id],
          );
          return { row: await operationRow(c, u, id), execute: false };
        }
        await c.query(
          "UPDATE ssh_operations SET status='running',started_at=now() WHERE user_id=$1 AND id=$2 AND status='pending'",
          [u, r.id],
        );
        await audit(c, u, 'approve', { operationId: r.id });
        return { row: { ...r, status: 'running' as const }, execute: true };
      });
      if (!claimed.execute) return publicOperation(claimed.row);
      const r = claimed.row,
        controller = new AbortController();
      active.set(r.id, { userId: u, controller });
      let status: SshOperation['status'] = 'uncertain',
        output =
          'Esecuzione interrotta: verifica lo stato remoto prima di proporre un nuovo intervento.',
        effectStarted = false;
      try {
        const dispatch = async (command: string) => {
          const dispatchResult = await lock(u, async (c) => {
            const current = await operationRow(c, u, r.id);
            if (
              current.status !== 'running' ||
              !(await targetStillCurrent(c, u, current)) ||
              controller.signal.aborted
            )
              throw new SshError(
                'authorization_changed',
                'Autorizzazione cambiata durante l’intervento.',
                409,
              );
            const k = await key(c, u),
              privateKey = decryptSecret(
                needMaster(),
                u,
                'ssh-private',
                k.private_secret as EncryptedSecret,
              );
            effectStarted = true;
            return {
              pending: started(
                opts.transport.run(
                  current.target_snapshot.server,
                  privateKey,
                  command,
                  controller.signal,
                ),
              ),
              privateKey,
            };
          });
          const result = await dispatchResult.pending;
          await guard(u);
          return { result, text: resultText(result, [dispatchResult.privateKey]) };
        };
        if (r.plan.kind === 'provider_reboot') {
          const dispatchResult = await lock(u, async (c) => {
            const current = await operationRow(c, u, r.id);
            if (
              current.status !== 'running' ||
              !(await targetStillCurrent(c, u, current)) ||
              controller.signal.aborted
            )
              throw new SshError('authorization_changed', 'Autorizzazione cambiata.', 409);
            const p = current.target_snapshot.provider as SshProvider,
              credentials = decodeCredential(u, await credential(c, u, p)),
              api = adapter(p),
              instance = current.target_snapshot.server.providerInstanceId as string;
            const instances = parse(z.array(SshProviderInstance), await api.list(credentials));
            await guard(u);
            if (!instances.some((i) => i.id === instance))
              throw new SshError(
                'provider_mapping_changed',
                'L’istanza associata non è più disponibile in questo account provider.',
                409,
              );
            if (controller.signal.aborted)
              throw new SshError('authorization_changed', 'Autorizzazione cambiata.', 409);
            effectStarted = true;
            return { pending: started(api.reboot(credentials, instance)) };
          });
          await dispatchResult.pending;
          await guard(u);
          status = 'succeeded';
          output =
            'Richiesta di riavvio accettata dal provider. Il ripristino del server deve essere verificato separatamente.';
        } else {
          const main = await dispatch(
            r.plan.kind === 'wp_cli'
              ? wordpressCommand(r.target_snapshot.site as SshSite, r.plan.command)
              : r.plan.command,
          );
          output = `Esecuzione\n${main.text}`;
          if (main.result.exitCode !== 0) status = 'failed';
          else {
            const verification = await dispatch(
              r.plan.kind === 'wp_cli'
                ? wordpressCommand(r.target_snapshot.site as SshSite, r.plan.verificationCommand)
                : r.plan.verificationCommand,
            );
            output += `\nVerifica\n${verification.text}`;
            status = verification.result.exitCode === 0 ? 'succeeded' : 'failed';
          }
        }
      } catch {
        if (!effectStarted) {
          status = 'failed';
          output =
            'Intervento non avviato: autorizzazioni, bersaglio o collegamento provider non più validi. Prepara un nuovo piano.';
        } /* Never persist adapter exceptions: they may include credentials. Uncertain is never retried. */
      } finally {
        active.delete(r.id);
      }
      await withUser(opts.pool, u, async (c) => {
        await c.query(
          "UPDATE ssh_operations SET status=$3,output=$4,finished_at=now() WHERE user_id=$1 AND id=$2 AND status='running'",
          [u, r.id, status, sanitizeSshOutput(output)],
        );
        await audit(c, u, 'operation_finish', { operationId: r.id, status });
      });
      return withUser(opts.pool, u, async (c) => publicOperation(await operationRow(c, u, r.id)));
    },
  };

  async function importInventory(
    c: PoolClient,
    u: string,
    value: z.infer<typeof SshImportInput>,
    apply: boolean,
  ): Promise<z.infer<typeof SshImportPreview>> {
    const source = canonicalImportSource(value.source),
      serverIds = new Set<string>(),
      siteIds = new Set<string>();
    for (const s of value.servers) {
      if (serverIds.has(s.sourceId))
        throw new SshError('duplicate_source_id', 'La fonte contiene due server con lo stesso ID.');
      serverIds.add(s.sourceId);
    }
    for (const s of value.sites) {
      if (siteIds.has(s.sourceId))
        throw new SshError('duplicate_source_id', 'La fonte contiene due siti con lo stesso ID.');
      siteIds.add(s.sourceId);
      if (s.path) checkedPath(s.path);
      checkedSiteUrl(s.url);
    }
    const oldServers = (
      await c.query<ServerRow>('SELECT * FROM ssh_servers WHERE user_id=$1 AND source=$2', [
        u,
        source,
      ])
    ).rows;
    const oldSites = (
      await c.query<SiteRow>('SELECT * FROM ssh_sites WHERE user_id=$1 AND source=$2', [u, source])
    ).rows;
    const serverMap = new Map(oldServers.map((s) => [s.source_id as string, s.id]));
    for (const s of value.servers)
      if (!serverMap.has(s.sourceId)) serverMap.set(s.sourceId, randomUUID());
    for (const s of value.sites)
      if (!serverMap.has(s.serverSourceId))
        throw new SshError(
          'unknown_server_reference',
          `Il sito «${s.name}» fa riferimento a un server assente dalla fonte di questo account.`,
        );
    const result = {
      serversNew: 0,
      serversUpdated: 0,
      sitesNew: 0,
      sitesUpdated: 0,
      missing: [] as string[],
    };
    for (const s of value.servers) {
      const old = oldServers.find((r) => r.source_id === s.sourceId),
        id = serverMap.get(s.sourceId) as string;
      old ? result.serversUpdated++ : result.serversNew++;
      const keep = <T>(field: string, fresh: T, previous: T): T =>
        old?.manual_fields.includes(field) ? previous : fresh;
      const name = old ? keep('name', s.name, old.name) : s.name,
        host = old ? keep('host', s.host, old.host) : s.host,
        port = old ? keep('port', s.port, old.port) : s.port,
        username = old ? keep('username', s.username, old.username) : s.username;
      const provider = old
          ? keep('provider', s.provider ?? old.provider, old.provider)
          : s.provider,
        instance = old
          ? keep(
              'providerInstanceId',
              s.providerInstanceId ?? old.provider_instance_id,
              old.provider_instance_id,
            )
          : s.providerInstanceId;
      if (provider && !instance) result.missing.push(`Associa l’istanza provider per «${name}».`);
      if (apply) {
        await c.query(
          `INSERT INTO ssh_servers(user_id,id,name,host,port,username,provider,provider_instance_id,source,source_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(user_id,id) DO UPDATE SET name=EXCLUDED.name,host=EXCLUDED.host,port=EXCLUDED.port,username=EXCLUDED.username,provider=EXCLUDED.provider,provider_instance_id=EXCLUDED.provider_instance_id,fingerprint=CASE WHEN ssh_servers.host=EXCLUDED.host AND ssh_servers.port=EXCLUDED.port THEN ssh_servers.fingerprint ELSE NULL END,observed_fingerprint=CASE WHEN ssh_servers.host=EXCLUDED.host AND ssh_servers.port=EXCLUDED.port THEN ssh_servers.observed_fingerprint ELSE NULL END,revision=ssh_servers.revision+1`,
          [u, id, name, host, port, username, provider, instance, source, s.sourceId],
        );
        if (old) await invalidateRows(c, u, 'Inventario aggiornato: prepara un nuovo piano.', id);
      }
    }
    for (const s of value.sites) {
      const old = oldSites.find((r) => r.source_id === s.sourceId),
        id = old?.id ?? randomUUID();
      old ? result.sitesUpdated++ : result.sitesNew++;
      const keep = <T>(field: string, fresh: T, previous: T): T =>
        old?.manual_fields.includes(field) ? previous : fresh;
      const serverId = old
        ? keep('serverId', serverMap.get(s.serverSourceId) as string, old.server_id)
        : (serverMap.get(s.serverSourceId) as string);
      const name = old ? keep('name', s.name, old.name) : s.name,
        url = old ? keep('url', s.url, old.url) : s.url,
        path = old ? (s.path ? keep('path', s.path, old.path) : old.path) : s.path,
        container = old
          ? s.container
            ? keep('container', s.container, old.container)
            : old.container
          : s.container;
      if (!path) result.missing.push(`Completa il percorso WordPress di «${name}».`);
      if (apply) {
        await c.query(
          `INSERT INTO ssh_sites(user_id,id,server_id,name,url,path,container,source,source_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(user_id,id) DO UPDATE SET server_id=EXCLUDED.server_id,name=EXCLUDED.name,url=EXCLUDED.url,path=EXCLUDED.path,container=EXCLUDED.container,revision=ssh_sites.revision+1`,
          [u, id, serverId, name, url, path, container, source, s.sourceId],
        );
        if (old)
          await invalidateRows(
            c,
            u,
            'Inventario sito aggiornato: prepara un nuovo piano.',
            old.server_id,
          );
      }
    }
    return SshImportPreview.parse(result);
  }
  return service;
}
export type SshService = ReturnType<typeof createSshService>;
