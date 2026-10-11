import { parseArgs } from 'node:util';
import { loadConfig } from '@ernie/config';
import { createPool, withUser } from '@ernie/db';
import { createLogger } from '@ernie/observability';
import { createSoulRepository } from '@ernie/soul';
import { generateApiKey } from '../auth.js';

/**
 * Crea un utente (companion personale) e la sua prima chiave API. Strumento di amministrazione:
 * usa il ruolo proprietario (MIGRATIONS_DATABASE_URL) perché la RLS impedisce a un utente di crearne altri.
 *
 *   node apps/api/dist/cli/create-user.js --name "Alessandro" --companion Ernie --role owner --locale it-IT
 */
async function main(): Promise<number> {
  // pnpm inoltra il separatore `--` allo script: lo ignoriamo.
  const args = process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--'));
  const { values } = parseArgs({
    args,
    options: {
      name: { type: 'string' },
      companion: { type: 'string', default: 'Ernie' },
      role: { type: 'string', default: 'member' },
      locale: { type: 'string', default: 'it-IT' },
      label: { type: 'string', default: 'default' },
    },
  });
  const config = loadConfig();
  const logger = createLogger({
    level: config.log.level,
    name: 'ernie-admin',
    pretty: config.env === 'development',
  });
  if (!values.name) {
    logger.error('--name obbligatorio');
    return 64;
  }
  if (values.role !== 'owner' && values.role !== 'member') {
    logger.error('--role deve essere owner o member');
    return 64;
  }
  const pool = createPool({
    connectionString: config.db.migrationsUrl,
    max: 2,
    applicationName: 'ernie-admin',
  });
  try {
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (display_name, locale, role, companion_name) VALUES ($1, $2, $3, $4) RETURNING id`,
      [values.name, values.locale, values.role, values.companion],
    );
    const userId = user.rows[0]?.id;
    if (!userId) throw new Error('creazione utente fallita');
    const { key, hash } = generateApiKey();
    await withUser(pool, userId, (client) =>
      client.query(
        `INSERT INTO api_keys (user_id, label, key_hash, scopes) VALUES ($1, $2, $3, $4)`,
        [userId, values.label, hash, ['chat']],
      ),
    );
    const cloned = await createSoulRepository(pool).cloneDefaultsForUser(
      userId,
      `admin:${values.name}`,
    );
    logger.info(
      { userId, role: values.role, companion: values.companion, soulsCloned: cloned },
      'utente creato',
    );
    // La chiave viene mostrata una sola volta, su stdout, mai nei log strutturati.
    process.stdout.write(`\nUSER_ID=${userId}\nAPI_KEY=${key}\n\n`);
    return 0;
  } catch (err) {
    logger.error({ err }, 'creazione utente fallita');
    return 1;
  } finally {
    await pool.end();
  }
}

process.exitCode = await main();
