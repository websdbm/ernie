import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  AutomationValidationError,
  createAutomationQueue,
  createAutomationRepository,
  dedupeKeys,
  enqueueRun,
  TriggerValidationError,
} from '@ernie/automations';
import { loadConfig } from '@ernie/config';
import { createPool } from '@ernie/db';
import { createLogger } from '@ernie/observability';
import { Redis } from 'ioredis';
import { AUTOMATION_PRESETS } from './automation-presets.js';

const KNOWN_TOOLS = [
  'get_time',
  'memory_search',
  'shopping_list_add',
  'shopping_list_remove',
  'shopping_list_get',
  'shopping_list_clear',
  'web_search',
  'web_fetch',
];

/**
 * Amministrazione delle automazioni (M6), con il ruolo applicativo e la RLS dell'utente indicato.
 *   admin:automations create  --user <uuid> (--preset weekly-recipes|daily-list | --file def.json)
 *   admin:automations list|notifications --user <uuid>
 *   admin:automations runs|run-now|enable|disable|remove --user <uuid> --id <uuid> [--payload '{"k":1}']
 */
async function main(): Promise<number> {
  const args = process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--'));
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      user: { type: 'string' },
      id: { type: 'string' },
      preset: { type: 'string' },
      file: { type: 'string' },
      payload: { type: 'string' },
      limit: { type: 'string', default: '20' },
    },
  });
  const command = positionals[0] ?? 'list';
  const config = loadConfig();
  const logger = createLogger({
    level: config.log.level,
    name: 'ernie-automations',
    pretty: config.env === 'development',
  });
  if (!values.user) {
    logger.error('--user obbligatorio');
    return 64;
  }
  const userId = values.user;
  const pool = createPool({
    connectionString: config.db.url,
    max: 2,
    applicationName: 'ernie-automations',
  });
  const repo = createAutomationRepository(pool);
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
  let redis: Redis | undefined;
  try {
    switch (command) {
      case 'create': {
        let def: unknown;
        if (values.preset) {
          def = AUTOMATION_PRESETS[values.preset];
          if (!def) {
            logger.error({ presets: Object.keys(AUTOMATION_PRESETS) }, 'preset sconosciuto');
            return 64;
          }
        } else if (values.file) {
          def = JSON.parse(await readFile(values.file, 'utf8'));
        } else {
          logger.error('--preset o --file obbligatorio');
          return 64;
        }
        out(
          await repo.create(userId, def, {
            knownTools: KNOWN_TOOLS,
            maxBudgetUsd: config.automations.maxRunBudgetUsd,
          }),
        );
        return 0;
      }
      case 'list':
        out(await repo.list(userId));
        return 0;
      case 'notifications':
        out(await repo.listNotifications(userId, false, Number(values.limit)));
        return 0;
      case 'runs':
      case 'run-now':
      case 'enable':
      case 'disable':
      case 'remove': {
        if (!values.id) {
          logger.error('--id obbligatorio');
          return 64;
        }
        if (command === 'runs') out(await repo.listRuns(userId, values.id, Number(values.limit)));
        else if (command === 'enable' || command === 'disable')
          out(await repo.setEnabled(userId, values.id, command === 'enable'));
        else if (command === 'remove') out({ removed: await repo.remove(userId, values.id) });
        else {
          const a = await repo.get(userId, values.id);
          if (!a) {
            logger.error('automazione inesistente');
            return 66;
          }
          redis = new Redis(config.redis.url, { maxRetriesPerRequest: null });
          const queue = createAutomationQueue(redis);
          const runId = crypto.randomUUID();
          const res = await enqueueRun(queue, {
            automationId: a.id,
            userId,
            scheduledAt: new Date().toISOString(),
            dedupeKey: dedupeKeys.manual(runId),
            triggerType: 'manual',
            ...(values.payload === undefined ? {} : { payload: JSON.parse(values.payload) }),
            depth: 0,
          });
          await queue.close();
          out(res);
        }
        return 0;
      }
      default:
        logger.error({ command }, 'comando sconosciuto');
        return 64;
    }
  } catch (err) {
    if (err instanceof AutomationValidationError || err instanceof TriggerValidationError) {
      logger.error({ err: err.message }, 'definizione non valida');
      return 65;
    }
    throw err;
  } finally {
    await pool.end();
    if (redis) await redis.quit();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    // biome-ignore lint/suspicious/noConsole: il logger può non essere inizializzato
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
