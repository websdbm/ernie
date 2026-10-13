/**
 * Demo da terminale: una sessione testuale con Ernie via WebSocket (protocollo v1).
 *   ERNIE_API_KEY=ernie_... pnpm --filter @ernie/tests demo:chat "ciao, chi sei?"
 * Variabili: ERNIE_URL (default ws://localhost:3000/v1/ws), ERNIE_SESSION_ID (per riprendere una sessione), ERNIE_DEVICE="lat,lon,Luogo",
 * ERNIE_DEMO_APPROVE=approve|deny per rispondere alle richieste di conferma dei tool.
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
// Posizione simulata del telefono (protocollo v1.10): ERNIE_DEVICE="45.44,10.99,Verona".
const deviceRaw = process.env.ERNIE_DEVICE?.split(',');
const device =
  deviceRaw && deviceRaw.length >= 2
    ? {
        timezone: 'Europe/Rome',
        location: {
          latitude: Number(deviceRaw[0]),
          longitude: Number(deviceRaw[1]),
          ...(deviceRaw[2] ? { place: deviceRaw.slice(2).join(',').trim() } : {}),
          at: new Date().toISOString(),
        },
      }
    : undefined;
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
              { text, ...(device ? { device } : {}) },
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
        // L'espressione dell'avatar arriva subito dopo la fine del turno: si aspetta un attimo prima di chiudere.
        setTimeout(() => {
          ws.close();
          resolve();
        }, 1_500);
        break;
      case 'avatar.emotion':
        console.error(`[avatar.emotion ${JSON.stringify(e.payload)}]`);
        break;
      case 'tool.started':
        console.error(`[tool ${e.payload.toolId}] ${e.payload.argsPreview ?? ''}`);
        break;
      case 'tool.completed':
        console.error(
          `[tool ${e.payload.toolId} ${e.payload.ok ? 'ok' : 'errore'} ${e.payload.durationMs}ms] ${e.payload.error ?? e.payload.resultPreview ?? ''}`,
        );
        break;
      case 'tool.confirmation.requested': {
        const decision =
          process.env.ERNIE_DEMO_APPROVE === 'approve'
            ? 'approve'
            : process.env.ERNIE_DEMO_APPROVE === 'deny'
              ? 'deny'
              : null;
        console.error(
          `[conferma richiesta per ${e.payload.toolId}: ${e.payload.reason ?? ''}] → ${decision ?? 'nessuna risposta'}`,
        );
        if (decision) {
          ws.send(
            JSON.stringify(
              createEvent(
                'tool.confirmation.respond',
                { approvalId: e.payload.approvalId, decision },
                { sessionId, correlationId: e.correlationId, seq: seq.next() },
              ),
            ),
          );
        }
        break;
      }
      case 'assistant.block':
        process.stdout.write(
          `\n[scheda ${e.payload.block.kind}] ${JSON.stringify(e.payload.block).slice(0, 400)}\n`,
        );
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
