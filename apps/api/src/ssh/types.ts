import type { Pool } from '@ernie/db';
import type {
  SshProvider,
  SshProviderCredentials,
  SshProviderInstance,
  SshServer,
} from '@ernie/protocol';

export interface SshTransportResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}
/**
 * Rete raggiungibile dall'account: la tailnet (100.64.0.0/10, Tailscale) solo per il titolare (ruolo 'owner').
 * Senza indicazione vale la regola più stretta.
 */
export interface SshNetworkAccess {
  readonly tailnet: boolean;
}
/** Porte SSH ammesse: la 22 e le porte non privilegiate (1024–65535), dove stanno le porte SSH personalizzate. */
export const allowedSshPort = (port: number): boolean =>
  Number.isInteger(port) && (port === 22 || (port >= 1024 && port <= 65535));
export interface SshTransport {
  generateKey():
    | Promise<{ privateKey: string; publicKey: string; fingerprint: string }>
    | { privateKey: string; publicKey: string; fingerprint: string };
  probe(server: SshServer, access?: SshNetworkAccess): Promise<{ fingerprint: string }>;
  /**
   * Implementations must enforce server.fingerprint and stop on AbortSignal; no automatic retries.
   * Un rifiuto prima di aprire la connessione (porta, indirizzo, DNS) è un `SshError` con codice in
   * `SSH_NOT_STARTED`: in quel caso sul server non è partito nulla.
   */
  run(
    server: SshServer,
    privateKey: string,
    command: string,
    signal?: AbortSignal,
    access?: SshNetworkAccess,
  ): Promise<SshTransportResult>;
}
export interface SshProviderAdapter {
  list(credentials: SshProviderCredentials): Promise<SshProviderInstance[]>;
  reboot(credentials: SshProviderCredentials, instanceId: string): Promise<void>;
}
export interface SshServiceOptions {
  pool: Pool;
  masterKey: string | undefined;
  /** Effective current settings, including skill activation and kill switch. Fail closed. */
  canUse(userId: string): Promise<boolean>;
  /** Ruolo 'owner' dell'account, letto a ogni connessione: abilita la tailnet. Assente o in errore: no. */
  isOwner?(userId: string): Promise<boolean>;
  /** Limite per utente di sonde e diagnosi (predefinito 10 al minuto). */
  probeLimit?: { max: number; windowMs: number };
  transport: SshTransport;
  providers: Partial<Record<SshProvider, SshProviderAdapter>>;
  now?: () => Date;
}
export class SshError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}
/** Rifiuti del trasporto prima di qualunque connessione: nessun effetto remoto possibile. */
export const SSH_NOT_STARTED: ReadonlySet<string> = new Set([
  'port_not_allowed',
  'address_not_allowed',
  'dns_failed',
]);
