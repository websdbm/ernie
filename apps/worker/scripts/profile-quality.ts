/**
 * Prova dell'estrazione della scheda anagrafica (13 ott 2026) con il modello leggero vero: frasi italiane
 * con dati detti, dedotti o assenti, poi fusione deterministica. Una chiamata per caso.
 * Uso: node --env-file=.env --import tsx --conditions=development apps/worker/scripts/profile-quality.ts
 */
import { loadConfig } from '@ernie/config';
import { createLlmExtractor, emptyProfile, mergeProfile, type UserProfile } from '@ernie/memory';
import { buildProfiles, createModelGateway } from '@ernie/model-gateway';
import { createLogger } from '@ernie/observability';

const config = loadConfig();
if (!config.providers.openrouterApiKey) throw new Error('OPENROUTER_API_KEY mancante');
const gateway = createModelGateway({
  openrouterApiKey: config.providers.openrouterApiKey,
  profiles: buildProfiles(config.llm.models),
});
let cost = 0;
const recorder = {
  record: async (r: { usage: { costReportedUsd?: number } }) => {
    cost += r.usage.costReportedUsd ?? 0;
  },
};
const extractor = createLlmExtractor(
  { gateway, recorder: recorder as never, logger: createLogger({ level: 'silent', name: 'p' }) },
  'demo-user',
  'demo-session',
);
const at = new Date('2026-10-13T10:00:00Z');

type Check = (p: UserProfile) => boolean;
const cases: Array<{ said: string; reply?: string; expect: Record<string, Check> }> = [
  {
    said: 'Mi chiamo Alessandro Grassi ma tutti mi chiamano Ale, chiamami così anche tu',
    expect: {
      nome: (p) => p.fullName === 'Alessandro Grassi',
      'come chiamarlo': (p) => p.preferredName === 'Ale',
    },
  },
  {
    said: 'sono nato il 3 maggio del 75 a Treviso, ma vivo a Padova da vent’anni',
    expect: {
      nascita: (p) => p.birthDate === '1975-05-03',
      città: (p) => /padova/i.test(p.city ?? ''),
    },
  },
  {
    said: 'mio figlio Giorgio ha 13 anni e mia moglie Laura fa l’insegnante',
    expect: {
      Giorgio: (p) => p.family.some((m) => m.name === 'Giorgio' && /figlio/i.test(m.relation)),
      Laura: (p) => p.family.some((m) => m.name === 'Laura' && /moglie/i.test(m.relation)),
      'età non è data': (p) => p.family.every((m) => !m.birthDate),
    },
  },
  {
    said: 'compio gli anni il 21 giugno, faccio lo sviluppatore web',
    expect: {
      'solo giorno e mese': (p) => p.birthDate === '--06-21',
      lavoro: (p) => /svilupp/i.test(p.occupation ?? ''),
    },
  },
  {
    said: 'che tempo fa domani a Venezia?',
    reply: 'Domani a Venezia sole e 22 gradi.',
    expect: { 'niente scheda': (p) => !p.city && !p.fullName && p.family.length === 0 },
  },
  {
    said: 'mio padre si chiama Franco e abbiamo un cane, Briciola',
    expect: {
      padre: (p) => p.family.some((m) => m.name === 'Franco' && /padre|papà/i.test(m.relation)),
      cane: (p) => p.family.some((m) => /briciola/i.test(m.name ?? '') && /cane/i.test(m.relation)),
    },
  },
];

let ok = 0;
let total = 0;
for (const c of cases) {
  const transcript = [
    { role: 'user', text: c.said, createdAt: at },
    { role: 'assistant', text: c.reply ?? 'Va bene!', createdAt: new Date(at.getTime() + 1000) },
  ];
  const extraction = await extractor(transcript, []);
  const profile = extraction.profile
    ? mergeProfile(emptyProfile(), extraction.profile, { source: 'conversation', at }).profile
    : emptyProfile();
  const results = Object.entries(c.expect).map(([name, check]) => [name, check(profile)] as const);
  for (const [, pass] of results) {
    total++;
    if (pass) ok++;
  }
  console.log(
    `${results.every(([, p]) => p) ? 'OK ' : 'NO '} «${c.said}» → ${results.map(([n, p]) => `${p ? '✓' : '✗'} ${n}`).join(', ')}`,
  );
  if (!results.every(([, p]) => p)) console.log('   estratto:', JSON.stringify(extraction.profile), '| fatti:', extraction.facts.map((f) => f.content));
}
console.log(`\n${ok}/${total} controlli; costo ${cost.toFixed(5)} $`);
