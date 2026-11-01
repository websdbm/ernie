# Backend — Programmi personali e scheda cronologica

1 novembre 2026. **Pubblicato su staging3**, API sana. Nessuna nuova build iOS: resta la 111.

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

Sorgenti **`19927308891c56408605b146cb07f3f9cd78c34a`**, pubblicati e SHA GitHub verificato prima del deploy.
API precedente: `f961ab0`, immagine
`sha256:0b968a3df7299121b050e799a0ac0375e793b762a202b19e2a9586e6287ee196`.
Backup del checkout e tag immagine eseguiti prima dell’aggiornamento da Git:
`/srv/staging3/backups/ernie-pre-todo-planning-20261101/checkout`,
`ernie-app:pre-todo-planning-20261101`. Checkout aggiornato al commit pubblicato, immagine costruita sul server,
ricreato **solo** `ernie-api-1` (`up -d --no-deps api`), senza migrazioni.
Immagine finale `sha256:51c18a1a7fb75e97d799fb60be77919d422bbc1200da599cf1758a08b221d741`,
avvio `2026-11-01T06:47:18.223733795Z`. Health pubblico `ok`, container `healthy`.
SHA-256 di index API, connessione WS e catalogo skill compilati identici ai moduli locali testati;
richiamo Todo presente e candidatura «programmino» verificata nel container.
Worker invariato: `sha256:a2bafb183c2cb8d1a1deac78b6b04b9b4105b821c639161bfba3c8a3e10af95e`,
avvio ancora `2026-10-27T06:14:49.531012183Z`. DB, Redis, configurazioni e migrazioni non modificati.
Il health espone ancora la versione preesistente `0.1.0-reminder-details-106`: non è il riferimento del codice.
Accesso SSH come root a staging3 `100.91.204.102` via Tailscale, peer verificato, nessuna chiave installata.
Il wrapper Docker da root cambia directory: Compose richiede `--project-directory` e file/override assoluti.
Nessuna chiave o credenziale recuperata/copiata per la prova; provider già configurato nel processo di test.
Log e hash privati: `~/Library/Caches/ernie-checks/todo-planning-20261101/` sul Mac dell’ufficio.
Ultima app resta la 111 disponibile su TestFlight. Nessuna modifica retroattiva al piano mattutino dell’utente.
Le risposte del modello restano probabilistiche: la prova positiva non garantisce ogni parafrasi futura.
