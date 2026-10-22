import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type RunOptions, runQuality, validateSelection } from './quality-runner.js';
import type { CreateFixtureDriver, QualityCorpus } from './quality-types.js';
import { createWebSocketTransport } from './quality-ws.js';

/** No implicit .env loading or default endpoint: live runs must select their own isolated fixture. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const allowed = new Set([
    '--cases',
    '--max-spend-usd',
    '--fixture-module',
    '--report',
    '--run-id',
    '--timeout-ms',
  ]);
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key || !allowed.has(key) || parsed.has(key) || !value || value.startsWith('--'))
      throw new Error('invalid_arguments');
    parsed.set(key, value);
  }
  const required = (name: string): string => {
    const value = parsed.get(name);
    if (!value) throw new Error('missing_arguments');
    return value;
  };
  const options: RunOptions = {
    runId: parsed.get('--run-id') ?? randomUUID(),
    wsUrl: process.env.ERNIE_URL ?? '',
    apiKey: process.env.ERNIE_API_KEY ?? '',
    caseIds: required('--cases')
      .split(',')
      .map((id) => id.trim()),
    maxSpendUsd: Number(required('--max-spend-usd')),
    timeoutMs: Number(parsed.get('--timeout-ms') ?? '60000'),
  };
  const fixtureModule = resolve(required('--fixture-module'));
  const reportPath = resolve(required('--report'));
  const corpus = JSON.parse(
    await readFile(new URL('./quality-corpus.v1.json', import.meta.url), 'utf8'),
  ) as QualityCorpus;
  validateSelection(corpus, options);
  // Fail before initializing fixture credentials if the report directory is unavailable.
  await mkdir(dirname(reportPath), { recursive: true });
  const module = (await import(pathToFileURL(fixtureModule).href)) as {
    createFixtureDriver?: CreateFixtureDriver;
  };
  if (typeof module.createFixtureDriver !== 'function') throw new Error('invalid_fixture_module');
  const driver = await module.createFixtureDriver(options);
  const report = await runQuality(corpus, options, driver, createWebSocketTransport());
  const temporary = `${reportPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, reportPath);
  console.log(
    JSON.stringify({
      report: reportPath,
      ...report.accuracy,
      aborted: report.aborted,
      cleanup: report.cleanup.every((result) => result.ok) && report.fixtureClosed,
    }),
  );
  if (
    report.aborted ||
    report.accuracy.failedTurns ||
    !report.accuracy.evaluatedTurns ||
    !report.fixtureClosed ||
    report.cleanup.some((result) => !result.ok)
  )
    process.exitCode = 1;
}

main().catch(() => {
  // Adapter errors can contain connection strings or model text. Never print their messages/stacks.
  console.error(
    'Quality evaluation could not start or write its report. Check explicit arguments, fixture configuration and report permissions. No error payload was logged.',
  );
  process.exitCode = 2;
});
