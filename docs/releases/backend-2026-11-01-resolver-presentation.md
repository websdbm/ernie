# Backend — Presentazione comprensibile del resolver

1 novembre 2026. Correzione pronta, deploy in preparazione. App iOS invariata alla 113.

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
