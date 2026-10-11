/**
 * Ascolta gli eventi di una sessione per N secondi (default 90) senza inviare messaggi: serve a vedere
 * arrivare `automation.run.updated` mentre un'automazione gira nel worker.
 *   ERNIE_API_KEY=ernie_... pnpm --filter @ernie/tests demo:listen [secondi]
 * Variabili: ERNIE_URL (default ws://localhost:3000/v1/ws), ERNIE_SESSION_ID.
 */
import { randomUUID } from 'node:crypto';
import { createEvent, decodeEvent, SequenceSource } from '@ernie/protocol';

const apiKey = process.env.ERNIE_API_KEY;
if (!apiKey) {
  console.error('ERNIE_API_KEY mancante');
  process.exit(2);
}
const url = process.env.ERNIE_URL ?? 'ws://localhost:3000/v1/ws';
const sessionId = process.env.ERNIE_SESSION_ID ?? randomUUID();
const seconds = Number(process.argv[2] ?? '90');
const seq = new SequenceSource();

const ws = new WebSocket(url, {
  headers: { Authorization: `Bearer ${apiKey}` },
} as unknown as string[]);
ws.addEventListener('open', () => {
  ws.send(
    JSON.stringify(
      createEvent(
        'session.start',
        { clientInfo: { platform: 'cli', appVersion: 'listen' } },
        { sessionId, correlationId: randomUUID(), seq: seq.next() },
      ),
    ),
  );
});
ws.addEventListener('message', (m) => {
  const e = decodeEvent(String(m.data));
  if (e.type === 'session.started')
    console.error(`[sessione ${sessionId} avviata: in ascolto per ${seconds} s]`);
  console.log(`${new Date().toISOString()} ${e.type} seq=${e.seq} ${JSON.stringify(e.payload)}`);
});
ws.addEventListener('error', (e) => {
  console.error('errore socket', e);
  process.exit(1);
});
setTimeout(() => {
  ws.close();
  process.exit(0);
}, seconds * 1000);
