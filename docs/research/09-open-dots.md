# 09 — Open Dots (Anil-matcha/open-dots): analisi e valutazione per Ernie

Data: 11 ottobre 2026. Metodo: clone in sola lettura (`git clone --depth 50`, nessun codice eseguito), lettura di README, manifest, migrazioni, servizi e test; metriche da `gh api`. Verifiche a campione dei fatti citati (licenza, hook permessi, scheduler) ripetute a mano.

## 1. Stato reale del progetto

- **Prototipo di 13 giorni**: primo commit con codice il 29 settembre 2026, 38 commit, 4 autori (uno principale, un contributore esterno molto attivo). Il repository GitHub esiste dal 2023 ed è stato riutilizzato: restano 50 occorrenze del nome precedente «Vadoo» (titolo della pagina web, chiave `localStorage`, utenza Postgres, nome del progetto compose).
- **Popolarità alta, maturità bassa**: 5.706 stelle e 686 fork, ma nessuna release, nessuna CI, nessuna cartella `docs/` (è in `.gitignore`), README che lo dichiara «early prototype».
- **Licenza: assente.** La descrizione dice «MIT-licensed», ma nel repository non c'è alcun file LICENSE e l'API GitHub riporta `license: null`. Finché non viene aggiunta, **il codice non è riutilizzabile**; si possono riprendere le idee, non le righe.
- Stack: Python ≥ 3.14 (FastAPI, SQLAlchemy 2 async, Alembic, APScheduler solo per il calcolo delle date, python-telegram-bot), Next.js 16 per la web UI, Postgres 17. Nessun Dockerfile applicativo: il compose contiene solo Postgres.

## 2. Come funziona davvero

| Funzione dichiarata | Realizzazione effettiva |
|---|---|
| Esecuzione agenti via Claude Code | La **CLI** `claude -p … --output-format json` lanciata come comando shell dentro una sandbox remota; output letto in polling; nessun SDK, nessuno streaming; un solo «provider» in una mappa. |
| Sandbox isolate | **Servizio SaaS Boat** (`boat-sdk`), una sandbox **per utente** riusata tra i task, TTL 30 min, nessun limite di CPU, RAM o rete nel codice, nessuna pulizia automatica. |
| Autorizzazioni | Hook HTTP `PermissionRequest` di Claude Code scritto in `.claude/settings.json` della sandbox; il backend classifica il tool in bucket (read / create / publish / system, con un classificatore dei comandi git), cerca una regola per utente (tool → connettore → bucket), altrimenti crea una richiesta, avvisa su Telegram e **blocca la chiamata in polling sul DB fino a 110 s, poi nega**. «Allow always» salva una regola persistente. |
| GitHub | Nessuna API: `gh auth login --web` pilotato con **tmux ed espressioni regolari**; il file `hosts.yml` viene cifrato e reiniettato nella sandbox a ogni task. Stesso meccanismo per il login OAuth di Claude Code. |
| Automazioni | Tre cicli `asyncio` da 30 s: schedule scadute prese con `FOR UPDATE SKIP LOCKED`, vincolo `UNIQUE(schedule_id, scheduled_for)` contro i doppioni, misfire oltre 15 min saltato, **pausa automatica dopo 3 fallimenti consecutivi** o subito su errori di autenticazione, notifica unica con claim su `reported_at`. |
| Persistenza | 7 tabelle (sandbox, credenziali, task, codici di collegamento, schedule, regole, richieste). Nessuna tabella utenti: `user_id` è una stringa scelta dal client. |
| Credenziali | File dei CLI cifrati con Fernet/MultiFernet (rotazione chiavi da env), decifrati in chiaro nella sandbox a ogni task; sincronizzazione del token rinnovato confrontando `expiresAt`. |
| Web e Telegram | Web senza autenticazione (identità in `localStorage`), polling ogni 3 s; bot Telegram in long polling con stato in memoria. |
| Memoria | **Nessuna memoria propria**: solo `--session-id`/`--resume` della CLI, che dipende dai file di sessione dentro la sandbox. |
| Consumo di token | **Nessun controllo**: niente budget, modello, `--max-turns`, cache o compattazione. |

Sicurezza: API REST senza autenticazione né autorizzazione per utente (chiunque raggiunga l'API può creare task, rispondere alle richieste di permesso, cancellare sandbox); endpoint di debug che eseguono comandi arbitrari; un solo Bearer statico per l'hook, esposto su URL pubblico; codice OAuth incollato dall'utente interpolato in un comando tmux senza quoting. Test: 50 funzioni pytest su permessi, classificatore git, cron, lock e errori di lancio; nessuna CI che li esegua.

## 3. Confronto con Ernie

Ernie ha già, e in forma più solida, ciò che Open Dots non ha: memoria persistente con embedding e consolidamento, Soul per utente, skill deterministiche e guidate con interruttori, registry di tool con policy engine (deny → ask → allow), taint delle sorgenti non fidate, approvazioni interattive e differite, automazioni con BullMQ, idempotenza e budget per run, registrazione dei costi per chiamata, routing dei modelli, protocollo WebSocket con streaming e ripresa, autenticazione a chiave con RLS, client iOS. Open Dots è invece centrato su un caso che Ernie non copre: **far eseguire compiti di programmazione a Claude Code dentro una sandbox, con l'identità GitHub dell'utente**.

## 4. Cosa conviene fare

**Riutilizzare come idea (riscritto in TypeScript, nessuna riga copiata):**

1. **Regole di autorizzazione persistenti per utente** con granularità tool → connettore → categoria e «Consenti sempre» alla stessa granularità della richiesta. Oggi le approvazioni di Ernie sono monouso; una regola salvata evita di richiedere la conferma a ogni turno per la stessa azione. Sforzo: mezza giornata (tabella `tool_rules`, controllo nel policy engine prima dell'ask, voce «Consenti sempre» nella scheda di conferma dell'app, revoca nelle impostazioni).
2. **Pausa automatica delle automazioni** dopo N fallimenti consecutivi o su errori che richiedono l'utente (credenziali scadute), con motivo visibile e ripresa manuale; tolleranza di misfire esplicita. Sforzo: mezza giornata nel runner e nella scheda notifiche.
3. **Classificatore dei comandi shell/git in bucket di rischio** (lettura, creazione, pubblicazione; nei comandi composti vince il verbo più rischioso). Serve solo quando Ernie avrà un tool shell o una skill «sviluppatore»: da tenere in nota per quel momento.
4. **Telegram come secondo canale** di sola conversazione testuale quando l'app non è a portata di mano: in Ernie sarebbe un client del protocollo esistente (stessa sessione, stesse schede ridotte a testo). Spike di una giornata, da decidere in M9/M11.

**Adattare, se mai servirà la delega di compiti di programmazione:** usare il **Claude Agent SDK** (non la CLI con tmux) con il policy engine di Ernie collegato come hook `PermissionRequest`, sandbox Docker per task con limiti di risorse e rete, credenziali iniettate per la durata del task. Il formato di risposta dell'hook (`hookSpecificOutput.decision.behavior`) è l'unico dettaglio tecnico da riprendere.

**Non prendere:** la sandbox Boat (SaaS a pagamento, nessun isolamento per task), l'API senza autenticazione, il polling al posto dello streaming, il login OAuth via tmux, l'assenza di memoria e di controllo dei costi, la toolchain Python 3.14 + Next 16.

## 5. Conclusione

Open Dots è una buona dimostrazione di un'idea precisa (Claude Code in sandbox con approvazioni via Telegram), ma è un prototipo di due settimane senza licenza, senza autenticazione e con dipendenze esterne a pagamento. Per Ernie non c'è nulla da importare come componente; ci sono tre pattern da adottare in proprio (regole «consenti sempre», pausa automatica delle automazioni, classificatore di rischio dei comandi) e un canale Telegram da valutare. La delega di compiti di programmazione resta fuori dal perimetro attuale di Ernie; se entrerà, la strada è l'Agent SDK con il nostro policy engine, non questo codice.
