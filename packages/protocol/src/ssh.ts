import { z } from 'zod';

const Text = z.string().trim().min(1).max(200);
export const SshProvider = z.enum(['vultr', 'contabo']);
export type SshProvider = z.infer<typeof SshProvider>;
export const SshServerInput = z
  .object({
    id: z.uuid().optional(),
    name: Text,
    host: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(/^[a-zA-Z0-9:.-]+$/),
    port: z.number().int().min(1).max(65535).default(22),
    username: z
      .string()
      .trim()
      .regex(/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/)
      .default('root'),
    provider: SshProvider.nullable().default(null),
    providerInstanceId: z
      .string()
      .trim()
      .max(100)
      .regex(/^[a-zA-Z0-9-]*$/)
      .nullable()
      .default(null),
  })
  .strict();
export const SshServer = SshServerInput.required().extend({
  fingerprint: z.string().nullable(),
  revision: z.number().int(),
  lastCheckedAt: z.string().nullable(),
  lastStatus: z.string().nullable(),
});
export type SshServer = z.infer<typeof SshServer>;
export const SshSiteInput = z
  .object({
    id: z.uuid().optional(),
    serverId: z.uuid(),
    name: Text,
    url: z.url().refine((v) => /^https?:\/\//.test(v), 'URL HTTP o HTTPS richiesto'),
    path: z.string().trim().max(500).default(''),
    container: z
      .string()
      .trim()
      .max(100)
      .regex(/^[a-zA-Z0-9_.-]*$/)
      .default(''),
  })
  .strict();
export const SshSite = SshSiteInput.required();
export type SshSite = z.infer<typeof SshSite>;
export const SshKeyInfo = z.object({
  publicKey: z.string(),
  fingerprint: z.string(),
  createdAt: z.string(),
});
export const SshProviderInfo = z.object({
  provider: SshProvider,
  connected: z.boolean(),
  lastCheckedAt: z.string().nullable(),
});
export const SshProviderCredentials = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('vultr'), apiKey: z.string().trim().min(10).max(2000) }).strict(),
  z
    .object({
      provider: z.literal('contabo'),
      clientId: Text,
      clientSecret: z.string().min(1).max(2000),
      username: z.email(),
      password: z.string().min(1).max(2000),
    })
    .strict(),
]);
export type SshProviderCredentials = z.infer<typeof SshProviderCredentials>;
export const SshProviderInstance = z.object({
  id: z.string(),
  name: z.string(),
  ip: z.string(),
  status: z.string(),
});
export type SshProviderInstance = z.infer<typeof SshProviderInstance>;
export const SshDiagnosticInput = z
  .object({
    serverId: z.uuid(),
    check: z.enum(['overview', 'disk', 'services', 'logs', 'docker', 'wordpress']),
    siteId: z.uuid().optional(),
  })
  .strict();
const planText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine(
      (value) =>
        !/-----BEGIN [^-]*PRIVATE KEY|\b(?:password|api[_-]?key|client[_-]?secret|authorization)\s*[:=]|\bBearer\s+\S+/i.test(
          value,
        ),
      'Non inserire credenziali nei piani: usa i collegamenti protetti.',
    );
export const SshPlanInput = z
  .object({
    serverId: z.uuid(),
    kind: z.enum(['ssh', 'wp_cli', 'provider_reboot']),
    title: planText(200).refine((v) => v.length > 0),
    reason: planText(2000).refine((v) => v.length > 0),
    command: planText(4000).default(''),
    verificationCommand: planText(4000).default(''),
    backup: planText(2000).refine((v) => v.length > 0),
    rollback: planText(2000).refine((v) => v.length > 0),
    siteId: z.uuid().optional(),
  })
  .strict();
export const SshOperation = SshPlanInput.extend({
  id: z.uuid(),
  serverName: z.string(),
  host: z.string(),
  status: z.enum(['pending', 'running', 'succeeded', 'failed', 'uncertain', 'rejected', 'expired']),
  createdAt: z.string(),
  expiresAt: z.string(),
  output: z.string().nullable(),
});
export type SshOperation = z.infer<typeof SshOperation>;
export const SshSnapshot = z.object({
  configured: z.boolean(),
  key: SshKeyInfo.nullable(),
  servers: z.array(SshServer),
  sites: z.array(SshSite),
  providers: z.array(SshProviderInfo),
  operations: z.array(SshOperation),
});
export type SshSnapshot = z.infer<typeof SshSnapshot>;
export const SshImportInput = z
  .object({
    source: z.url().max(500),
    servers: z.array(SshServerInput.omit({ id: true }).extend({ sourceId: Text })).max(2000),
    sites: z
      .array(
        SshSiteInput.omit({ id: true, serverId: true }).extend({
          sourceId: Text,
          serverSourceId: Text,
        }),
      )
      .max(10000),
  })
  .strict();
export const SshImportPreview = z.object({
  serversNew: z.number(),
  serversUpdated: z.number(),
  sitesNew: z.number(),
  sitesUpdated: z.number(),
  missing: z.array(z.string()),
});
