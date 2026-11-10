// biome-ignore-all lint/suspicious/noConsole: CLI emits only fixed status and aggregate counts.
import { createPool } from '@ernie/db';
import { isPrivateHealthDocument } from '../health-protection/classification.js';
import { healthCipherFromEnvironment } from '../health-protection/config.js';
import { createHealthMigration } from '../health-protection/migration.js';

/** Run in maintenance after backup + migrations 52/53. Defaults to a read-only inventory.
 * Never prints clinical values, account identifiers, paths, keys or the input fingerprints.
 * External vault/history/transcript copies require a separate reviewed procedure; this CLI fails closed.
 */
async function main() {
  const apply = process.argv.includes('--apply');
  if (apply && !process.argv.includes('--writers-stopped')) throw new Error('maintenance_required');
  if (!process.env.MIGRATIONS_DATABASE_URL || !process.env.DATABASE_URL)
    throw new Error('database_required');
  const admin = createPool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });
  const app = createPool({ connectionString: process.env.DATABASE_URL });
  const cipher = healthCipherFromEnvironment(process.env.HEALTH_ENCRYPTION_KEYS);
  try {
    const users = await admin.query<{ user_id: string }>(
      `SELECT user_id FROM health_reports WHERE kind <> '[protected]' UNION SELECT user_id FROM health_values UNION SELECT user_id FROM health_notices UNION SELECT user_id FROM brain_notes WHERE note_type='salute' OR path LIKE 'Salute/%' OR path='Salute.md'`,
    );
    const docs = await admin.query<{ id: string; user_id: string; title: string; body: string }>(
      `SELECT id,user_id,title,body FROM documents WHERE status <> 'deleted'`,
    );
    const media = await admin.query<{
      id: string;
      user_id: string;
      title: string;
      ocr_text: string;
      description: string;
    }>(`SELECT id,user_id,title,ocr_text,description FROM media_items`);
    const clinicalDocs = docs.rows.filter((d) => isPrivateHealthDocument(d.body, d.title));
    const clinicalMedia = media.rows.filter((d) =>
      isPrivateHealthDocument(`${d.ocr_text}\n${d.description}`, d.title),
    );
    const linked = await admin.query<{ document_id: string }>(
      'SELECT document_id FROM health_reports WHERE document_id IS NOT NULL',
    );
    const linkedIds = new Set(linked.rows.map((r) => r.document_id));
    const unlinkedDocuments = clinicalDocs.filter((d) => !linkedIds.has(d.id)).length;
    const counts = {
      accounts: users.rowCount,
      clinicalDocuments: clinicalDocs.length,
      clinicalMedia: clinicalMedia.length,
      unlinkedDocuments,
    };
    if (apply && !cipher) throw new Error('key_required');
    const migration = cipher ? createHealthMigration(app, cipher) : null;
    const plans = [];
    if (migration)
      for (const u of users.rows)
        plans.push({ user: u.user_id, review: await migration.dryRun(u.user_id) });
    const requiresReview =
      unlinkedDocuments > 0 ||
      clinicalMedia.length > 0 ||
      users.rows.length !== plans.length ||
      plans.some(
        (p) =>
          p.review.blockers.length ||
          p.review.copies.brainNotes ||
          p.review.copies.brainChunks ||
          p.review.copies.sessions ||
          p.review.copies.mediaCandidates,
      );
    if (apply && requiresReview) {
      console.log(
        JSON.stringify({ mode: 'apply', counts, status: 'external_review_required', applied: 0 }),
      );
      return 2;
    }
    let applied = 0;
    if (apply && migration)
      for (const p of plans) {
        await migration.apply(p.user, p.review.fingerprint);
        applied++;
      }
    console.log(
      JSON.stringify({
        mode: apply ? 'apply' : 'audit',
        counts,
        status: requiresReview ? 'external_review_required' : 'ready',
        applied,
        consentsEnabled: 0,
      }),
    );
    return requiresReview ? 2 : 0;
  } finally {
    cipher?.destroy();
    await Promise.all([admin.end(), app.end()]);
  }
}
try {
  process.exitCode = await main();
} catch {
  console.error(
    'Migrazione Salute non completata. Verificare configurazione, backup, manutenzione e inventario protetto; nessun dettaglio sensibile nei log.',
  );
  process.exitCode = 1;
}
