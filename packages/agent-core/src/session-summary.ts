/**
 * Riassunto della conversazione nel prompt (ricerca 11, C1). Processore Mastra `processInput`: toglie dalla
 * cronologia caricata dalla memoria i messaggi già riassunti e mette il riassunto come messaggio di sistema
 * con etichetta, subito dopo le istruzioni. Il riassunto lo prepara il worker (pacchetto memory); qui si
 * legge soltanto, una query per turno. I messaggi restano salvati: cambia solo ciò che vede il modello.
 */
import type { Processor } from '@mastra/core/processors';

export interface LoadedSummary {
  readonly text: string;
  readonly coveredUntil: Date;
}

export const SESSION_SUMMARY_TAG = 'ernie-session-summary';

type InputProcessor = Processor & { processInput: NonNullable<Processor['processInput']> };

export function createSessionSummaryProcessor(
  load: () => Promise<LoadedSummary | null>,
  onApplied?: (info: { removed: number }) => void,
): InputProcessor {
  return {
    id: 'ernie-session-summary',
    name: 'Riassunto della conversazione',
    async processInput({ messageList }) {
      let s: LoadedSummary | null = null;
      try {
        s = await load();
      } catch {
        return messageList; // senza riassunto si lavora con la sola finestra: mai un turno fallito per questo
      }
      if (!s) return messageList;
      const cutoff = s.coveredUntil.getTime();
      const old = messageList.get.remembered
        .db()
        .filter((m) => new Date(m.createdAt).getTime() <= cutoff)
        .map((m) => m.id);
      if (old.length) messageList.removeByIds(old);
      messageList.addSystem(s.text, SESSION_SUMMARY_TAG);
      onApplied?.({ removed: old.length });
      return messageList;
    },
  };
}
