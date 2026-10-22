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
export interface SshTransport {
  generateKey():
    | Promise<{ privateKey: string; publicKey: string; fingerprint: string }>
    | { privateKey: string; publicKey: string; fingerprint: string };
  probe(server: SshServer): Promise<{ fingerprint: string }>;
  /** Implementations must enforce server.fingerprint and stop on AbortSignal; no automatic retries. */
  run(
    server: SshServer,
    privateKey: string,
    command: string,
    signal?: AbortSignal,
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
