# Test

| Livello | Dove | Come gira |
|---|---|---|
| Unitari | `packages/*/src/**/*.test.ts`, `apps/*/src/**/*.test.ts` | `pnpm test` (sempre) |
| Integrazione | stessi file, blocchi `describe.skipIf(!DATABASE_URL)` | `pnpm test` con `DATABASE_URL` e `REDIS_URL` impostati (CI: servizi Postgres/Redis) |
| Smoke end-to-end | `tests/smoke.sh` | contro lo stack Docker (`docker compose up -d --wait api && tests/smoke.sh`) |

Dalla M3 in avanti qui vivranno anche i benchmark comparativi (routing intelligente vs modello fisso), come richiesto dal piano.

## Corpus qualità e tempi via WebSocket

`eval/quality-corpus.v1.json` contiene 16 casi sintetici italiani (18 turni): promemoria singoli/doppi, anticipo e scadenza, lista acquisti esplicita/ambigua con una o due liste, risposta alla scelta, replay, Todo con conservazione degli ID, Second Brain e ricette. Le date dei promemoria sono nel 2031; resta obbligatorio disabilitare le notifiche nello stack di prova. Modifiche sostanziali agli scenari richiedono una nuova versione del corpus.

Verifica locale, senza rete né modelli:

```sh
pnpm exec vitest run tests/eval/quality-runner.test.ts tests/eval/quality-ws.test.ts
pnpm exec tsc -b tests
```

L'esecuzione reale è seriale e richiede un adapter fixture locale attendibile. Non usa un account ordinario: `verify()` deve verificare sul server/DB il marker test, il run, la scadenza, l'identità autenticata, la soppressione notifiche e la disabilitazione dei tool pericolosi. Un HTTP 200 o una conferma testuale del modello non costituiscono successo. Il runner verifica il protocollo `@ernie/protocol` e confronta gli snapshot canonici letti via API/DB prima e dopo ogni turno, senza un giudice LLM.

Prima di eseguire, predisporre uno stack API/worker, database e Redis dedicati, senza SMTP/APNs; il runner da solo non può garantire l'isolamento server. L'adapter fornito in `apps/api/src/cli/quality-fixture.ts` richiede esplicitamente `EVAL_ISOLATED_STACK=1`, un database `ernie_perf_*`, Redis dedicato e tunnel locale. Configurare le variabili in un ambiente privato, senza stampare credenziali. `ERNIE_URL` e `ERNIE_API_KEY` sono obbligatorie; il comando non carica `.env` automaticamente.

Esempio dopo aver predisposto la fixture isolata (sostituire il percorso assoluto dell'adapter):

```sh
pnpm --filter @ernie/tests eval:quality \
  --fixture-module /percorso/ernie/apps/api/src/cli/quality-fixture.ts \
  --run-id quality-isolated-001 \
  --cases shopping-explicit,shopping-ambiguous-one,shopping-ambiguous-two,shopping-choice-then-write,shopping-request-replay,reminder-one,reminder-two-times,reminder-deadline,todo-add-preserve \
  --max-spend-usd 1 \
  --timeout-ms 60000 \
  --report /tmp/ernie-quality-report.json
```

Il campione è esplicito: massimo 20 casi, 40 turni totali, 600 caratteri per prompt, 90 secondi per turno e soglia di spesa tra 0 e 1 USD. `--max-spend-usd` interrompe l'avvio di nuovi turni quando il costo registrato raggiunge la soglia: **non è un tetto assoluto**, perché chiamate già avviate, ritardi di contabilizzazione e servizi non misurati possono superarlo. `spentUsd()` deve restituire il totale cumulativo registrato di tutti gli account fixture del run anche dopo la loro rimozione, includendo worker/router dove contabilizzati; eventuali embeddings o altri servizi non registrati restano esclusi. Il report dichiara questa copertura parziale.

L'adapter esporta `createFixtureDriver(config)` secondo `eval/quality-types.ts`. `prepare()` crea soltanto seed sintetici e attende le proiezioni necessarie; `snapshot()` restituisce gli oggetti canonici attivi; `cleanup()` attende/ferma solo i job fixture e rimuove solo quei dati; `close()` revoca gli account e libera connessioni anche dopo errori. Se l'inizializzazione della factory fallisce prima di restituire il driver, la factory stessa deve ripulire le risorse parziali. Il runner chiude sempre il WebSocket prima di `cleanup()`, anche dopo timeout o asserzioni fallite. La pulizia fallita viene indicata nel report e rende non riuscita l'esecuzione.

Il replay riusa il `correlationId` con un nuovo ID evento e una nuova sequenza. Anche `busy` viene ritentato con la stessa correlazione, al massimo tre volte. Gli aggiornamenti di una scheda con lo stesso `blockId` sostituiscono la scheda; schede identiche con ID diversi fanno fallire il controllo duplicati. Le conferme sono consentite solo per un elenco ristretto di tool del corpus, mai con «Consenti sempre». È una difesa aggiuntiva: un tool remoto potrebbe essere già iniziato quando il client lo osserva, quindi le restrizioni server sono indispensabili.

Il JSON finale, scritto atomicamente con permessi 0600, contiene versione corpus, ID scenario, esito di ogni controllo, nomi/esiti dei tool e tempi. Non include prompt, output, snapshot, credenziali o dettagli delle eccezioni. `firstResponseMs` misura dal messaggio utente al primo testo visibile, scheda o richiesta di conferma, escludendo gli eventi di avvio; `completedMs` arriva al completamento terminale valido e resta null per errori/timeout. Preparazione fixture, letture REST e cleanup non entrano in questi tempi. Il tempo di replay misura la consegna del replay, non una nuova inferenza.

`accuracy` riporta solo conteggi dei turni del campione; non stima l'affidabilità generale del sistema. Errori intermedi dei tool recuperati con successo sono separati in `execution.failedToolCalls`, mentre chiamate rimaste incomplete, output vuoto, risposta troncata, duplicati o stato finale errato impediscono il successo del turno. I controlli tollerano maiuscole/accenti e non confrontano la prosa libera parola per parola; non pretendono di misurare tutte le forme di allucinazione. Exit code 0: tutti i turni selezionati riusciti e cleanup completo; 1: esiti negativi/arresto; 2: avvio o scrittura report falliti.
