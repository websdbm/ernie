/**
 * Demo da terminale: una sessione testuale con Ernie via WebSocket (protocollo v1).
 *   ERNIE_API_KEY=ernie_... pnpm --filter @ernie/tests demo:chat "ciao, chi sei?"
 * Variabili: ERNIE_URL (default ws://localhost:3000/v1/ws), ERNIE_SESSION_ID (per riprendere una sessione).
 */
import { randomUUID } from 'node:crypto';
import { createEvent, decodeEvent, isUserVisible, SequenceSource } from '@ernie/protocol';

const apiKey = process.env.ERNIE_API_KEY;
if (!apiKey) {
  console.error('ERNIE_API_KEY mancante');
  process.exit(2);
}
const url = process.env.ERNIE_URL ?? 'ws://localhost:3000/v1/ws';
const sessionId = process.env.ERNIE_SESSION_ID ?? randomUUID();
const text = process.argv.slice(2).join(' ') || 'Ciao! Presentati in una frase.';
const seq = new SequenceSource();
let streamed = false;

const ws = new WebSocket(url, {
  headers: { Authorization: `Bearer ${apiKey}` },
} as unknown as string[]);
const done = new Promise<void>((resolve) => {
  ws.addEventListener('open', () => {
    const corr = randomUUID();
    ws.send(
      JSON.stringify(
        createEvent(
          'session.start',
          { clientInfo: { platform: 'cli', appVersion: 'demo' } },
          { sessionId, correlationId: corr, seq: seq.next() },
        ),
      ),
    );
  });
  ws.addEventListener('message', (m) => {
    const e = decodeEvent(String(m.data));
    switch (e.type) {
      case 'session.started':
        console.error(`[sessione ${sessionId} avviata, seq=${e.seq}]`);
        ws.send(
          JSON.stringify(
            createEvent(
              'user.message',
              { text },
              { sessionId, correlationId: randomUUID(), seq: seq.next() },
            ),
          ),
        );
        break;
      case 'assistant.text.delta':
        streamed = true;
        process.stdout.write(e.payload.delta);
        break;
      case 'assistant.text.completed':
        if (!streamed) process.stdout.write(e.payload.text);
        break;
      case 'assistant.completed':
        process.stdout.write('\n');
        console.error(`[completato: ${JSON.stringify(e.payload.usage)}]`);
        ws.close();
        resolve();
        break;
      case 'error':
        console.error(`[errore ${e.payload.code}] ${e.payload.message}`);
        ws.close();
        resolve();
        break;
      default:
        if (!isUserVisible(e)) console.error(`[${e.type}]`);
    }
  });
  ws.addEventListener('error', (err) => {
    console.error('[ws error]', err);
    resolve();
  });
});
await done;
