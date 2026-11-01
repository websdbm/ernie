# Backend — Presentazione comprensibile del resolver

1 novembre 2026. **Pubblicato su staging3**, API sana. App iOS invariata alla 113.

La riga «Ho inteso» dopo il salvataggio di un luogo conteneva esempi della descrizione del Second Brain,
anziché un chiarimento utile alla persona. Il resolver trasformava la scelta della capacità nella sua
intera descrizione di catalogo e la inseriva fra i significati del messaggio. Non era una domanda.

Ora il controllo ordinario `request` rimane interno: nessuna riga di interpretazione dopo la risposta.
La scelta della capacità continua a indirizzare il modello e le azioni, separata dai significati semantici;
risposte e confidenze restano nell’audit. Corretto anche l’abbinamento per indice fra domanda e risposta:
due domande sullo stesso testo non si scambiano più il tipo o il significato.
Le vere incertezze continuano a produrre una domanda esplicita con pulsanti, prima di eseguire.
Per le capacità integrate i pulsanti usano il titolo breve del catalogo. Ambiguità e correzioni esplicite
conservano le interpretazioni di riferimenti reali, come «lui = Giorgio». Nessun cambio di soglie o permessi.

**96 test verdi** in cinque suite (chiarimento API, connessione WS, chiarimento Jev, router e policy dei tool).
Due test di regressione hanno fallito sul codice precedente: descrizione di catalogo nella riga e scambio
di significato con «about» uguale. TypeScript e Biome verdi. Test senza nuovi turni LLM o dati di account reali.
Nessuna modifica a posizioni salvate, cronologia esistente, provider o notifiche. Le vecchie righe già
salvate sul telefono rimangono nello storico; la correzione riguarda le risposte successive.

## Pubblicazione verificata

Sorgenti **`660de62f39e440353fa7b11a805b2dd57653128c`**, SHA GitHub verificato prima del deploy da Git.
Backup protetto del checkout: `/srv/staging3/backups/ernie-pre-resolver-presentation-20261101/checkout`.
Immagine precedente conservata come `ernie-app:pre-resolver-presentation-20261101` (`sha256:ea1ce1c2…`).
Maschera 077 limitata al backup e 022 prima del checkout; file di configurazione e override identici alla copia.

Ricreata la sola API, avvio `2026-11-01T16:55:47.988812772Z`, immagine
`sha256:c78b004565e0c5d2884718edcc104438cfa8d27b4e1970066d71e07ff95debbe`.
Health pubblico `ok`, container `healthy`. Tre moduli compilati (`clarify` API, connessione WS, `clarify` Jev)
identici per SHA-256 al codice locale testato. Prova sui moduli nel nuovo container, senza LLM, account o DB:
scelta `second_brain` preservata, risposta semantica corretta con «about» identico, nessuna riga `interpretation`.
Worker immagine/avvio invariati dal 27 ottobre; Postgres e Redis invariati dal 18 ottobre.
Nessuna migrazione, riavvio VPS o intervento su altri progetti. Il campo versione del health è ancora quello
preesistente della 106: identificare la pubblicazione da sorgenti, immagine e hash, non da quel campo.
Evidenze locali: `~/Library/Caches/ernie-checks/resolver-presentation-20261101/`.
