# Backend — Risolutore comune orientato al riconoscimento

1 novembre 2026. **Pubblicato su staging3**, API sana. App iOS invariata alla 111.

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

Sorgenti **`115f8718fcbaa6dfbf10a5514ae06983bb6b9afc`**, SHA GitHub verificato prima del deploy da Git.
Backup del checkout e DDL della tabella in `/srv/staging3/backups/ernie-pre-request-resolver-20261101/`;
immagine precedente preservata come `ernie-app:pre-request-resolver-20261101` (`sha256:51c18a1a…`).

Primo build fallito: la maschera restrittiva del backup era rimasta sul checkout, generando 18 sorgenti
root 0600 illeggibili al client Docker rootless. Nessuna modifica al codice per risolvere il problema:
ripristinati proprietario staging3 e permessi Git dei soli file tracciati coinvolti. Secondo build pulito
riuscito; API precedente rimasta sana fino alla sostituzione. Per i prossimi deploy, maschera 077 solo sul
backup e 022 prima del checkout. Configurazioni e file non tracciati non modificati.

Il servizio temporaneo di migrazione ha verificato che pendesse solo 0049 e ha applicato soltanto quella
(48 precedenti già applicate), usando `runMigrations` senza cambiare ruoli/password o avviare init-storage.
Il vincolo dell’audit riletto ammette i tre vecchi tipi e `request`. Nessun dato di attività o lista modificato.
Ricreato solo `ernie-api-1`; immagine finale
`sha256:ea1ce1c27fbba5de5fec9a73e9d018982d662920dc8f242c98898bc9a9c8d377`,
avvio `2026-11-01T07:36:07.852967661Z`. Health pubblico `ok`, container `healthy`.
Nove hash SHA-256 dei moduli API/router/questioner/executor e della migrazione coincidono con i file locali
testati. Soglia 0,30 e schema obbligatorio verificati anche nel container appena avviato.
Worker ancora `sha256:a2bafb183c2cb8d1a1deac78b6b04b9b4105b821c639161bfba3c8a3e10af95e`,
avvio `2026-10-27T06:14:49.531012183Z`; Postgres e Redis ancora avviati il 18 ottobre.
Nessun riavvio VPS, worker o servizi dati; nessuna nuova build iOS, connessione provider o notifica.
Il campo versione del health resta quello preesistente della 106: il deploy è identificato da Git e immagine.
Accesso SSH come root a staging3 via Tailscale `100.91.204.102`, peer verificato, nessuna chiave trasferita.
Log e manifest privati: `~/Library/Caches/ernie-checks/request-resolver-20261101/` sul Mac dell’ufficio.
Il ripristino può riutilizzare l’immagine precedente lasciando il vincolo di audit ampliato, compatibile con
il codice precedente. Non serve cancellare le nuove righe diagnostiche per tornare alla vecchia API.
Il contratto generale di verifica dell’artefatto finale per tutte le skill e lo stato esplicito/versionato
delle proposte fra dispositivi restano estensioni successive. Questo incremento copre rilevazione, risoluzione,
escalation alla persona e guardia sulle azioni; non garantisce ogni possibile parafrasi o azione multipla.
