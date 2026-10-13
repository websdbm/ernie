/**
 * Prova end-to-end della skill «Documenti»: carica un testo (come farebbe il telefono dopo l'OCR),
 * poi invia un messaggio con l'allegato e stampa gli eventi del turno (schede document e schema comprese).
 *   ERNIE_API_KEY=ernie_... pnpm --filter @ernie/tests demo:document [file.txt] ["richiesta"]
 * Variabili: ERNIE_HTTP (default http://localhost:3000), ERNIE_URL (ws), ERNIE_SESSION_ID.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createEvent, decodeEvent, SequenceSource } from '@ernie/protocol';

const apiKey = process.env.ERNIE_API_KEY;
if (!apiKey) {
  console.error('ERNIE_API_KEY mancante');
  process.exit(2);
}
const http = process.env.ERNIE_HTTP ?? 'http://localhost:3000';
const url = process.env.ERNIE_URL ?? 'ws://localhost:3000/v1/ws';
const sessionId = process.env.ERNIE_SESSION_ID ?? randomUUID();
const file = process.argv[2];
const request = process.argv[3] ?? 'Riassumi questo documento per studiarlo e fammi lo schema.';
const text = file
  ? readFileSync(file, 'utf8')
  : [
      'La fotosintesi clorofilliana',
      'La fotosintesi è il processo con cui le piante, le alghe e alcuni batteri trasformano l’energia luminosa in energia chimica. Avviene nei cloroplasti, grazie alla clorofilla.',
      'Nella fase luminosa la luce scinde l’acqua (fotolisi) liberando ossigeno e producendo ATP e NADPH. Nella fase oscura, o ciclo di Calvin, l’anidride carbonica viene fissata e trasformata in glucosio.',
      'Scoperte principali: nel 1779 Jan Ingenhousz dimostrò che le piante producono ossigeno solo alla luce; nel 1950 Melvin Calvin descrisse il ciclo che porta il suo nome.',
    ].join('\n\n');
// Pagine: una ogni due paragrafi, per simulare la scansione.
const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim());
const pages: string[] = [];
for (let i = 0; i < paragraphs.length; i += 2) pages.push(paragraphs.slice(i, i + 2).join('\n\n'));

const res = await fetch(`${http}/v1/documents`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
  body: JSON.stringify({ source: 'scan', language: 'it', pages }),
});
if (!res.ok) {
  console.error('caricamento fallito', res.status, await res.text());
  process.exit(1);
}
const doc = (await res.json()) as { id: string; title: string; pages: number; chars: number };
console.error(`[documento ${doc.id}: «${doc.title}», ${doc.pages} pagine, ${doc.chars} caratteri]`);

const seq = new SequenceSource();
const ws = new WebSocket(url, {
  headers: { Authorization: `Bearer ${apiKey}` },
} as unknown as string[]);
const t0 = Date.now();
ws.addEventListener('open', () => {
  ws.send(
    JSON.stringify(
      createEvent(
        'session.start',
        { clientInfo: { platform: 'cli', appVersion: 'document' } },
        { sessionId, correlationId: randomUUID(), seq: seq.next() },
      ),
    ),
  );
});
ws.addEventListener('message', (m) => {
  const e = decodeEvent(String(m.data));
  if (e.type === 'session.started') {
    ws.send(
      JSON.stringify(
        createEvent(
          'user.message',
          { text: request, inputMode: 'text', attachments: [{ kind: 'document', id: doc.id }] },
          { sessionId, correlationId: randomUUID(), seq: seq.next() },
        ),
      ),
    );
    return;
  }
  if (e.type === 'assistant.text.delta') return;
  const payload = JSON.stringify(e.payload);
  console.log(
    `${((Date.now() - t0) / 1000).toFixed(1)}s ${e.type} ${payload.length > 1200 ? `${payload.slice(0, 1200)}…` : payload}`,
  );
  if (e.type === 'assistant.completed' || e.type === 'error') {
    // Alcuni blocchi (la scheda «Fonti») arrivano subito dopo la fine del turno.
    setTimeout(() => {
      ws.close();
      process.exit(e.type === 'error' ? 1 : 0);
    }, 2500);
  }
});
ws.addEventListener('error', (err) => {
  console.error('errore socket', err);
  process.exit(1);
});
setTimeout(() => {
  console.error('timeout');
  ws.close();
  process.exit(1);
}, 240_000);
