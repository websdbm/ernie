import { parseArgs } from 'node:util';
import { loadConfig } from '@ernie/config';
import { createPool } from '@ernie/db';
import { createLogger } from '@ernie/observability';
import {
  buildProposalFromProcedure,
  createLearnedSkillRepository,
  detectRepeatedProcedures,
} from '@ernie/skills';
import {
  createShoppingTools,
  createStubShoppingRepository,
  getTimeTool,
  ToolRegistry,
} from '@ernie/tools';

/**
 * Amministrazione delle skill apprese (ciclo proposta → test → approvazione → attivazione).
 *   node apps/api/dist/cli/skills.js detect  --user <uuid>
 *   node apps/api/dist/cli/skills.js propose --user <uuid> --index 0 --key <chiave>
 *   node apps/api/dist/cli/skills.js test|approve|activate|reject --user <uuid> --id <uuid> [--by owner]
 *   node apps/api/dist/cli/skills.js list    --user <uuid> [--status active]
 */
async function main(): Promise<number> {
  const args = process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--'));
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      user: { type: 'string' },
      id: { type: 'string' },
      index: { type: 'string' },
      key: { type: 'string' },
      by: { type: 'string', default: 'owner' },
      status: { type: 'string' },
    },
  });
  const command = positionals[0] ?? 'list';
  const config = loadConfig();
  const logger = createLogger({
    level: config.log.level,
    name: 'ernie-skills',
    pretty: config.env === 'development',
  });
  if (!values.user) {
    logger.error('--user obbligatorio');
    return 64;
  }
  const pool = createPool({
    connectionString: config.db.migrationsUrl,
    max: 2,
    applicationName: 'ernie-skills',
  });
  // Il registry serve alla validazione dei tool consentiti: stesso catalogo dell'API (senza i tool web se manca la chiave).
  const tools = new ToolRegistry().register(getTimeTool);
  for (const t of createShoppingTools(createStubShoppingRepository())) tools.register(t);
  const repo = createLearnedSkillRepository(pool, tools);
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
  try {
    switch (command) {
      case 'detect':
        out(await detectRepeatedProcedures(pool, values.user));
        return 0;
      case 'propose': {
        const procedures = await detectRepeatedProcedures(pool, values.user);
        const p = procedures[Number(values.index ?? 0)];
        if (!p) {
          logger.error("nessuna procedura con quell'indice");
          return 1;
        }
        const key = values.key ?? `proc_${p.sequence.join('_')}`.slice(0, 60);
        out(
          await repo.propose({
            userId: values.user,
            createdBy: `cli:${values.by}`,
            ...buildProposalFromProcedure(p, key),
          }),
        );
        return 0;
      }
      case 'test':
      case 'approve':
      case 'activate':
      case 'reject': {
        if (!values.id) {
          logger.error('--id obbligatorio');
          return 64;
        }
        if (command === 'test') out(await repo.test(values.user, values.id));
        else if (command === 'approve')
          out(
            await repo.approve(
              values.user,
              values.id,
              values.by ?? 'owner',
              (values.by ?? 'owner') === 'owner',
            ),
          );
        else if (command === 'activate') out(await repo.activate(values.user, values.id));
        else {
          await repo.reject(values.user, values.id);
          out({ rejected: values.id });
        }
        return 0;
      }
      default:
        out(await repo.list(values.user, values.status as never));
        return 0;
    }
  } catch (err) {
    logger.error({ err }, 'comando fallito');
    return 1;
  } finally {
    await pool.end();
  }
}

process.exitCode = await main();
