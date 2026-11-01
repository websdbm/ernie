# Backend — Programmi personali e scheda cronologica

1 novembre 2026. **In preparazione, non ancora pubblicato su staging3**. Nessuna nuova build iOS.

## Problema verificato

L’utente aveva chiesto un programma di quattro attività entro le 8:30; Ernie aveva descritto le fasce
in prosa e risposto ancora solo in testo al successivo «Ok». Lettura mirata dei due turni, decisioni del
router, chiamate del modello e liste: Jev aveva scelto `ricordami`, Todo mancava fra le candidate mostrate,
e la categoria `todo` non era fra le opzioni del router. Claude Opus aveva concluso entrambi i turni
senza chiamare strumenti; nessuna lista salvata quel giorno. Non era un difetto del renderer iOS.
Non si versionano ID utente/sessione o contenuti privati dei log.

## Correzione

- Descrizione ed esempi Todo includono richieste colloquiali come «programmino veloce» e un’ora libera.
- Jev vede anche la categoria Todo, già presente fra i tool core dell’agente: nessun nuovo permesso.
- Se il router non seleziona una procedura guidata, la skill Todo attiva fornisce un richiamo semantico
  al flusso di pianificazione. Nessun parser regex degli orari, stato nuovo o esecuzione deterministica.
  Non si applica agli allegati, ai video o sopra un’altra procedura guidata; skill spenta = niente richiamo.
- La proposta confermata con «Ok» deve diventare una scheda tramite `todo_save` quando i dettagli sono
  sufficienti; non una seconda conferma in prosa. Lettura di data, giornata esistente, revision e ID;
  `mode scheduled`, giorno e slot per la timeline. I conflitti non diventano salvataggi dichiarati.
- Restano i chiarimenti essenziali, una domanda per volta; niente durate/tragitti inventati, salvataggi
  per mere richieste di consiglio o avvisi aggiunti senza richiesta. `reminderMinutes null` per default.

## Verifiche

- Regressione del WS riprodotta sul codice pubblicato precedente: il nuovo test fallisce senza il richiamo.
- 84 test verdi: WS (53), catalogo skill (9), validazione Todo (12), router Jev (10).
- TypeScript `tsc -b` e Biome sui sei file modificati: verdi.
- Prova reale con il modello heavy configurato, `anthropic/claude-opus-5.5`, strumenti Todo reali,
  validazione snapshot reale e repository esclusivamente in memoria. Non usa database, account o notifiche.
  Primo turno con durate ignote: `get_time`, `todo_lists`, `present_choices`, nessun salvataggio.
  Riproduzione della proposta già confermata: `get_time`, `todo_lists`, `todo_save`; una scheda `todo_list`,
  `mode scheduled`, quattro task e quattro slot, nessun avviso. Costo stimato della prova: USD 0,0710134.
  La prova verifica il modello e gli strumenti isolati; l’iniezione nel WS è coperta dal test deterministico.
- Script ripetibile: `tests/manual/todo-morning-smoke.mjs`, opt-in `RUN_TODO_MORNING_SMOKE=1`.
  Usa chiavi già configurate, senza stamparle; data sintetica fissa e URL DB/Redis inutilizzabili.
  Il richiamo aggiornato è stato fornito al processo di prova nel container, senza sostituire file applicativi.

## Distribuzione e limiti

Sorgenti da pubblicare prima del deploy. API precedente: `f961ab0`, immagine
`sha256:0b968a3df7299121b050e799a0ac0375e793b762a202b19e2a9586e6287ee196`.
Previsti backup del checkout e tag immagine prima dell’aggiornamento da Git, solo API, senza migrazioni.
Ultima app resta la 111 disponibile su TestFlight. Nessuna modifica retroattiva al piano mattutino dell’utente.
Le risposte del modello restano probabilistiche: la prova positiva non garantisce ogni parafrasi futura.
