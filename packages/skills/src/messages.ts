import type { ContentBlock } from '@ernie/protocol';
import { UnknownPersonError } from './reminder.js';
import type { DeterministicSkill, SkillReply } from './types.js';

/**
 * Skill «Messaggi» (richiesta dell'utente, 15 ott 2026): messaggi brevi alle persone collegate in Famiglia, senza
 * modello quando la frase è chiara: «scrivi a Giorgio che la cena è pronta», «manda un messaggio a papà: arrivo»,
 * «rispondi a papà: ok». Il messaggio compare nella chat di chi lo riceve con un fumetto suo e una notifica sul
 * telefono; chi riceve può rispondere dal fumetto. Le foto si mandano dall'app (pulsante «+» o «Rispondi»).
 */
export interface FamilyMessageSender {
  /** Manda il messaggio alla persona con quell'etichetta; UnknownPersonError se non c'è. */
  send(
    userId: string,
    input: { toLabel: string; text: string },
  ): Promise<{ label: string; block: ContentBlock }>;
}

export type MessagePlan =
  | { op: 'send'; who: string; text: string }
  | { op: 'ask_text'; who: string };

const clean = (s: string) =>
  s
    .replace(/^[«"“'‘]+|[»"”'’]+$/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

const capital = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

const WHO = "(?<who>[\\p{L}][\\p{L}'’]*(?:\\s+[\\p{L}][\\p{L}'’]*)?)";

/** Riconosce l'invio di un messaggio a un familiare; null se la frase non è di questo tipo. */
export function parseMessageCommand(input: string): MessagePlan | null {
  const t = input
    .replace(/[‘’´`]/gu, "'")
    .trim()
    .replace(/^\[voce\]\s*/u, '');
  const withText = [
    new RegExp(
      `^(?:manda|invia|mandagli|mandale|scrivi|scrivigli|scrivile)\\s+(?:un\\s+)?(?:messaggio|messaggino|sms)?\\s*(?:a|per|al|alla|allo)\\s+${WHO}\\s*(?::|,|\\s+che\\s|\\s+dicendo(?:gli|le)?\\s+che\\s)\\s*(?<text>.+)$`,
      'iu',
    ),
    new RegExp(`^(?:messaggio|un\\s+messaggio)\\s+(?:a|per)\\s+${WHO}\\s*:\\s*(?<text>.+)$`, 'iu'),
    new RegExp(`^rispondi\\s+(?:a|al|alla)\\s+${WHO}\\s*(?::|,|\\s+che\\s)\\s*(?<text>.+)$`, 'iu'),
    // «Di' a Giorgio che …»: il testo dopo «che». Con «di …» (infinito) decide il modello, che lo riscrive.
    new RegExp(`^(?:di'|dì|di|dici)\\s+(?:a|al|alla)\\s+${WHO}\\s+che\\s+(?<text>.+)$`, 'iu'),
  ];
  for (const re of withText) {
    const m = re.exec(t);
    const who = m?.groups?.who?.trim();
    const text = clean(m?.groups?.text ?? '');
    if (who && text) return { op: 'send', who, text: capital(text.replace(/[.]+$/u, '').trim()) };
  }
  const bare = new RegExp(
    `^(?:manda|invia|scrivi)\\s+(?:un\\s+)?(?:messaggio|messaggino)\\s+(?:a|per|al|alla)\\s+${WHO}[.!]?$`,
    'iu',
  ).exec(t);
  if (bare?.groups?.who) return { op: 'ask_text', who: bare.groups.who.trim() };
  return null;
}

/** Risposta a «cosa gli scrivo?»: il messaggio successivo è il testo (se non è un altro comando). */
export function messageFollowUp(awaiting: unknown, input: string): MessagePlan | null {
  const a = awaiting as { kind?: unknown; who?: unknown } | null;
  if (a?.kind !== 'message' || typeof a.who !== 'string') return null;
  const text = clean(input.replace(/^\[voce\]\s*/u, ''));
  if (!text || text.length > 2000 || /^(?:annulla|lascia\s+stare|niente|no)\b/iu.test(text))
    return null;
  return { op: 'send', who: a.who, text: capital(text) };
}

export function createMessagesSkill(sender: FamilyMessageSender | null): DeterministicSkill {
  return {
    id: 'messaggi',
    kind: 'deterministic',
    category: 'family',
    description:
      'Messaggi alle persone collegate in Famiglia: «scrivi a Giorgio che la cena è pronta», «manda un messaggio a papà: arrivo», «rispondi a papà: ok». Arrivano nella sua chat con una notifica; le foto si mandano dall’app.',
    examples: [
      'scrivi a Giorgio che la cena è pronta',
      'manda un messaggio a papà: arrivo tra dieci minuti',
      'rispondi a papà: ok',
    ],
    match: (text) => parseMessageCommand(text),
    followUp: (awaiting, text) => messageFollowUp(awaiting, text),
    run: async (plan, ctx): Promise<SkillReply> => {
      const p = plan as MessagePlan;
      if (p.op === 'ask_text')
        return {
          text: `Cosa scrivo a ${p.who}? Dimmi il messaggio e glielo mando. Per una foto usa il pulsante «+» › «Messaggio a un familiare».`,
          actions: [],
          awaiting: { kind: 'message', who: p.who },
        };
      if (!sender)
        return { text: 'I messaggi non sono disponibili in questo contesto.', actions: [] };
      try {
        const sent = await sender.send(ctx.userId, { toLabel: p.who, text: p.text });
        return {
          text: `✉️ Mandato a ${sent.label}.`,
          actions: [`message:${sent.label}`],
          blocks: [sent.block],
        };
      } catch (err) {
        if (err instanceof UnknownPersonError && err.suggestion) {
          // Nome quasi uguale a uno collegato: si propone con un tocco, senza mandare da soli.
          const fixed = `Scrivi a ${err.suggestion} che ${p.text.charAt(0).toLowerCase()}${p.text.slice(1)}`;
          return {
            text: `Non trovo «${err.label}» in Famiglia: intendevi ${err.suggestion}?`,
            actions: [],
            blocks: [
              {
                kind: 'choices',
                question: `Mandare il messaggio a ${err.suggestion}?`,
                options: [
                  { id: '1', label: fixed.slice(0, 80) },
                  { id: '2', label: 'No, lascia stare' },
                ],
              },
            ],
          };
        }
        if (err instanceof UnknownPersonError)
          return {
            text: `Non conosco nessun «${err.label}» in Famiglia. Collega la sua installazione da Impostazioni › Famiglia (con un codice d'invito) e riprova.`,
            actions: [],
          };
        throw err;
      }
    },
  };
}
