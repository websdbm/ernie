# Build 125 — modifiche senza riproporre l’elenco

19 novembre 2026. Preparata, non pubblicata. API/iOS attivi: 124; worker: 122. Nessuna migrazione.

## Riscontro della prova su iPhone

Verifica in sola lettura: un promemoria di prova, due modifiche della sola sede riuscite, stesso id e
orari/preavviso invariati. Entrambe le conferme sono state approvate (dopo circa 26 e 8 secondi):
**la scadenza non è stata provata dall’utente**. Nessuna richiesta nuova lasciata scadere in quella prova.

Problema di presentazione confermato: ogni `reminder_list` usato internamente per identificare l’impegno
presentava anche l’elenco completo. L’aggiornamento successivo si fondeva con quell’elenco nello stesso
turno: ricomparivano anche i promemoria estranei. Il modello aggiungeva preamboli tecnici e riepiloghi.
La lettura del nuovo stato veniva inoltre attribuita erroneamente al successo di una precedente azione
scaduta: quello stato era stato corretto separatamente, dopo autorizzazione dell’utente.

## Correzione

- `reminder_list` è silenzioso per impostazione predefinita; `show:true` presenta l’elenco soltanto
  quando l’utente lo chiede. Schema e istruzioni distinguono lettura interna e richiesta di visualizzazione.
- `reminder_update` presenta solo l’impegno modificato e il nuovo campo opzionale `replacesId`.
  Il client aggiorna la scheda già presente, conservando posizione, messaggio e altri impegni; riconosce anche gli alias dopo una modifica nel widget. Niente
  nuova copia in fondo. Gestisce anche la riprogrammazione che cambia id, con alias nello store locale.
- Se la scheda non è più visibile (anche dopo `/clear`), il client mostra una sola scheda aggiornata.
  Un elenco richiesto esplicitamente resta un nuovo messaggio. Storia e aggiornamenti persistono.
- Conferme più basse: titolo/azione brevi, spiegazioni generiche e consenso permanente sotto Dettagli;
  avvertenze su condivisione esterna, motivi non standard e richieste incomplete restano visibili.
  Stato scaduto in una sola riga, senza paragrafo ripetuto; nessuna modifica ai consensi o alla policy.
- Istruzioni API per risposte operative brevi e senza ricopiare la scheda, preservando approfondimenti
  richiesti e dettagli di sicurezza. Non attribuire un dato corretto ad azioni precedentemente fallite.
  È una direttiva al modello, non un taglio del testo o un limite rigido: possono restare brevi preamboli.

## Verifiche

- **73 test backend**: protocollo compatibile, lettura silenziosa/visualizzazione esplicita, aggiornamento
  con vecchio/nuovo id, scadenze, policy/attacchi, orari/dettagli invariati e prefisso del companion.
- **39 test iOS**, build simulatore 125: applicazione degli eventi reali al ConversationStore con due
  impegni, nessuna nuova scheda per la modifica, `/clear`, persistenza, cambio id, temi e caratteri grandi.
  Risultati `/tmp/ernie-chat-reminder-flow-alias-20261119.xcresult`.
- Prova con Sonnet 5.5 reale su due richieste sintetiche: rettifica → un solo blocco di aggiornamento;
  richiesta elenco → blocco con due righe. Nuovo schema/descrizioni e strumenti simulati in memoria,
  nessun dato personale o modifica all’account. Risposte più brevi, con un breve preambolo ancora presente
  nella rettifica; non dichiarare garantita una frase unica. Artefatto privato sul server nel backup
  pre-124: `compact-125-llm-probe-final.json`.
- TypeScript/Biome e controllo diff. Controllo visivo delle conferme, dettagli accessibili ed espandibili.

## Rilascio

Necessari API e iOS 125 per aggiornare le schede nella posizione originale; client precedenti ignorano
il campo opzionale e restano compatibili. Worker invariato, schema SQL 0055, nessuna migrazione.
Sorgenti da pubblicare su GitHub prima dell’archiviazione per distribuzione. Aggiornare qui commit,
manifest di input e verifica archive/export. Pubblicazione ancora da autorizzare; nessun dato personale
modificato durante questa diagnosi. Il promemoria di prova resta nell’account finché l’utente lo annulla.
