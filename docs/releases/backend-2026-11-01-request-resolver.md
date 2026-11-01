# Backend — Risolutore comune orientato al riconoscimento

1 novembre 2026. **In preparazione, non ancora pubblicato**. App iOS invariata alla 111.

## Comportamento

Preferenza esplicita dell’utente: qualche falso positivo di analisi è preferibile a una richiesta ignorata.
La chiamata iniziale a Jev riceve un segnale `operational_intent` in più e tutte le capacità attive del
registry dell’account, non soltanto le cinque candidate lessicali. Un punteggio da **0,30** avvia il
risolutore anche con bassa ambiguità. Valore mancante o router non disponibile: la richiesta resta da
analizzare, mai da eseguire automaticamente. È una soglia iniziale di prodotto, non una misura calibrata
della probabilità reale di errore.

Il modello leggero formula una domanda sulla funzione e fino a due domande interpretative. La domanda
sulla capacità è obbligatoria nello schema e le alternative sono enum degli ID attivi, più `none`.
Jev risponde in un solo batch, con alternativa «non determinabile»; soglia di risoluzione **almeno 0,80**.
La capacità verificata corregge la procedura iniziale, guidata o deterministica. Una scelta SSH porta
comunque al modello heavy e ai controlli esistenti. Competenze spente e diario privato non entrano nel catalogo.

Dubbi residui: viene emessa una sola domanda con i pulsanti già supportati dall’app, senza avviare il
modello esecutivo. Richiesta e domanda sono conservate nel thread prima di mostrare le scelte, così il
modello può riprendere il contesto dopo il tap. La risposta libera resta possibile. L’esito `none` toglie
la procedura ipotizzata e imposta un blocco server: scritture ed effetti esterni vengono negati anche se
il modello prova a invocarli. Le letture restano sottoposte alla policy abituale; nessun nuovo permesso.

I percorsi deterministici già riconosciuti conservano i controlli esistenti; gli allegati e YouTube
mantengono la lettura prima della scelta della funzione. Chiarimento e chiamate ai provider rispettano
annullamento e timeout. Il contesto della cache include storia recente e catalogo: due «Ok» riferiti a
proposte o capacità diverse non riusano la medesima decisione.

Una sola iterazione LLM leggero + Jev per ogni controllo, non un dialogo interno ricorsivo. Errori e
schema invalido non costituiscono autorizzazione: il modello principale riceve la richiesta originale
con un avviso di verifica. Durate, tragitti, preferenze e consenso mancanti restano da chiedere alla persona.
Gli importi della chiamata Jev interna vengono registrati in `llm_calls`/usage ledger, senza ricaricare
il costo del modello leggero, che ha già la propria registrazione. I turni chiusi con una domanda riportano
anche consumo interno nel riepilogo invece di dichiarare zero chiamate/costo.

## Verifiche

- **105 test verdi** in otto suite: router, chiarimento, schema questioner, WS, interpretazione, companion,
  catalogo e executor. Regressione del segnale operativo debole: rossa con il codice precedente, verde con il nuovo.
- TypeScript `tsc -b` verde; Biome senza errori, due warning preesistenti nei vecchi helper di `executor.test.ts`.
- Controlli per capacità fuori dalle prime cinque candidate, funzioni inesistenti/spente, confidenza bassa,
  annullamento, cache e contesto, risposta `none` e blocco effettivo di scritture/effetti esterni.
- Prova reale su nove frasi sintetiche con 11 capacità: **5/5** richieste operative rilevate e **0/4** falsi
  positivi sulle frasi di controllo; tutte risposte Jev reali, nessun fallback contato come successo.
  Richieste informali, spesa, promemoria e «Ok» dopo una proposta. Campione piccolo: non è una garanzia di recall
  sul traffico reale. Router osservato circa 0,2–0,7 s per caso; resolver LLM→Jev circa **2,764 s** nel campione.
- Una ripetizione con schema libero aveva restituito nessuna domanda utile, fallendo il test: è stata corretta
  con la domanda sulla capacità obbligatoria e gli enum attivi. La prova finale con tale schema è positiva:
  `todo`, nessun dubbio residuo. Stima del costo totale della prova finale: **USD 0,001835313**.
- Migrazione 0049 eseguita su tabella TEMP isolata, `search_path=pg_temp`, transazione con rollback: vecchi
  valori e nuovo `request` ammessi, valore invalido rifiutato. Nessuna tabella applicativa modificata dalla prova.
- Script ripetibile `tests/manual/request-resolver-smoke.mjs`, opt-in esplicito. Moduli nuovi compilati provati
  in una cartella temporanea del container, poi rimossa; nessun file applicativo sostituito, DB o account usato.

## Distribuzione e limiti

Sorgenti da pubblicare prima del deploy. Migrazione 0049 amplia solo il vincolo dei tipi di audit di
`interpretation_checks`. Previsti backup checkout/immagine e DDL della tabella, applicazione della sola nuova
migrazione e aggiornamento API. Worker e configurazioni invariati; nessuna nuova build iOS o notifica.
Il contratto generale di verifica dell’artefatto finale per tutte le skill e lo stato esplicito/versionato
delle proposte fra dispositivi restano estensioni successive. Questo incremento copre rilevazione, risoluzione,
escalation alla persona e guardia sulle azioni; non garantisce ogni possibile parafrasi o azione multipla.
