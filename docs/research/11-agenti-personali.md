# 11 — Agenti personali e memoria: cinque gruppi di progetti a confronto

13 ott 2026. Richiesta dell'utente: trovare almeno tre progetti GitHub simili a Muffin, con buona popolarità, e studiarli per algoritmi e idee da portare in Ernie. Seguito di `10-muffin-agent.md`.

Metodo: clone superficiale di ogni repository in una cartella temporanea, **sola lettura** (nessun codice eseguito), un agente di studio per gruppo con lo stesso brief su cosa Ernie ha già. Ogni affermazione dei rapporti cita file e righe dei repository; qui riporto le sintesi e le verifiche fatte da me. Le idee sono nostre da reimplementare: nessun codice né prompt copiato.

## 1. Progetti studiati

| Progetto | Stelle | Licenza | Cosa è davvero |
|---|---|---|---|
| OpenClaw | 392k | MIT | Gateway TypeScript a processo unico, ~150 canali, stato in SQLite + Markdown per agente. Maturo su affidabilità; il multi-utente è dichiaratamente «non un confine di sicurezza». |
| Hermes Agent (Nous Research) | 253k | MIT | Python, un utente per profilo, cron, subagenti, terminale. Il «learning loop» è soprattutto prompt e contatori; il modello dialettico dell'utente (Honcho) è un plugin SaaS esterno. |
| Letta (ex MemGPT) | 25k | Apache-2.0 | Il server Python con blocchi e sleep-time è archiviato; il prodotto vivo (letta-code, TS) tiene la memoria in un repo git di Markdown e consolida con un subagente di «reflection». Buone idee, codice stratificato. |
| mem0 + Graphiti (Zep) | 67k + 32k | Apache-2.0 | mem0 OSS è ora «ADD-only» (il vecchio ADD/UPDATE/DELETE non è più chiamato; il grafo è solo nella versione a pagamento). Graphiti costruisce un grafo temporale con giudice delle contraddizioni, ma richiede Neo4j e 6–10 chiamate LLM per turno. |
| Khoj + nanobot | 38k + 49k | AGPL-3.0 / MIT | Khoj: «secondo cervello» Django/pgvector, isolamento solo via ORM, punto forte la research mode. nanobot: «ultra-leggero» solo di nome (~130k righe), ma con pochi meccanismi di orchestrazione eleganti. |

Osservazione generale: la nostra base (Postgres con RLS, taint di run, approvazioni legate agli argomenti, estrazione dei fatti solo dalle parole dell'utente) è **più robusta** di tutti e cinque sulla sicurezza della memoria e sulla separazione tra membri della famiglia. Il nostro ritardo è altrove: cosa succede quando la conversazione si allunga, come la memoria si riorganizza nel tempo, come si evita di disturbare inutilmente.

## 2. Dove convergono (segnale forte: più progetti, stessa soluzione)

**C1 — Compattazione della conversazione con riassunto strutturato** (Letta, Hermes, OpenClaw, nanobot). È il buco più grande di Ernie: oggi la finestra è di 20 messaggi e ciò che esce si perde, salvo i fatti estratti. Tutti fanno la stessa cosa:
- soglia con **isteresi** (a 0,8–0,9 della finestra, o a N messaggi, si scende a una frazione), così il prefisso dei messaggi cambia una volta ogni molti turni e non a ogni turno: vantaggio anche per la cache del prompt (lo stesso principio della nostra compattazione dei risultati dei tool);
- riassunto **ricorsivo** (il precedente viene aggiornato, non rifatto) a **sezioni fisse**: decisioni, richieste aperte, impegni, vincoli, identificatori esatti, stato corrente; nel nostro dominio anche preferenze emerse e date;
- **identificatori verificati dal codice** (OpenClaw estrae con espressioni regolari URL, numeri, date e controlla che compaiano nel riassunto; se no ritenta, poi ripiega su un riassunto deterministico);
- azioni già compiute riscritte **al passato con data** (Hermes), per non rieseguirle; l'**ultimo messaggio dell'utente vince** sul riassunto;
- messaggi dell'utente tenuti **parola per parola** entro un budget (Hermes 24.000 caratteri) e indizi per ritrovare il dettaglio con la ricerca;
- generazione **asincrona** con il modello leggero e fallback sincrono al limite duro.
Rischio comune: un'iniezione dentro un risultato di tool sopravvive nel riassunto. Da noi: riassumere solo testo di utente e assistente, oppure marcare il riassunto come contaminato e non promuoverlo mai a fatto.

**C2 — Revisione dopo il turno, in un fork che riusa la cache** (Hermes, OpenClaw, Letta, nanobot). Dopo N turni o N iterazioni di tool, a risposta consegnata, parte un «fork» con lo stesso system prompt e gli stessi tool (cache calda, Hermes dichiara −26 % di costo), strumenti limitati a lettura + proposta, **al massimo una modifica**, obbligo di rileggere prima di modificare, cancellazione se arriva un nuovo turno dell'utente. Il segnale più prezioso sono le **correzioni dell'utente** («troppo lungo», «non così»), che aggiornano la skill che governa quel compito. Elenco esplicito di **cosa non imparare**: guasti dell'ambiente, frasi negative sui tool («X non funziona»), errori transitori, casi singoli, tentativi falliti spacciati per procedura. Da noi entra nel ciclo proposta → approvazione delle learned skill che esiste già; vietato su run contaminate; per Giorgio approva il genitore.

**C3 — Consolidamento della memoria in background con watermark e annullamento per passata** (Letta, nanobot, Graphiti). Un job che parte alla compattazione o ogni N turni (o di notte), legge dal watermark, produce **operazioni strutturate** (fondi, sostituisci, archivia, riscrivi la sezione profilo) validate dal codice e non testo libero; il watermark avanza solo se la passata termina; ogni passata ha un id e si annulla in blocco. Graphiti aggiunge il riassunto «accoda e comprimi» (si accodano i fatti nuovi, il modello interviene solo oltre 2.000 caratteri).

**C4 — Esito silenzioso e gate di notifica per le automazioni** (nanobot, Khoj, OpenClaw, Hermes). Oggi ogni run riuscito notifica. Tutti separano «ho controllato» da «devo avvisarti»:
- una decisione strutturata a fine run (`{notifica, motivo}` o `{esito: nessun_cambiamento|progresso|fatto|bloccato|serve_attenzione}`) e un marcatore di silenzio (Hermes `[SILENT]`): l'esito si salva comunque;
- l'esito silenzioso viene letto **una volta** dal turno successivo dell'utente come contesto interno (OpenClaw), così Ernie sa cosa ha controllato senza aver disturbato;
- dedup dello stesso testo nelle 24 ore e freno alle raffiche di eventi.
Rende possibili le «sentinelle»: «avvisami quando esce la versione 2.0» diventa un controllo quotidiano che scrive solo quando la condizione è vera. Il risultato passa poi dal nostro gate della proattività.

**C5 — Controllo economico prima del modello** (Hermes, OpenClaw). Una fonte economica (pagina, valore) viene ridotta a un hash o a uno stato di ≤16 KB: se non cambia, nessuna chiamata al modello; se cambia, il diff entra nel prompt; un errore della fonte conta come errore, mai come cambiamento. OpenClaw lascia anche che il job proponga quando ricontrollare, entro un minimo e un massimo. Da noi: **insieme chiuso di predicati tipizzati** (pagina cambiata, evento tra N minuti, meteo cambiato) valutati nel worker, mai script dell'utente.

**C6 — Guardrail dei loop con avviso prima dello stop** (Hermes, OpenClaw, Khoj). Noi interrompiamo al primo «loop rilevato». Loro prima avvisano il modello (stesso errore ripetuto 2 volte → avviso, 5 → stop; stesso tool che fallisce 3/8; nessun progresso 2/5; cicli fino a periodo 4), così può correggersi; lo stop rigido resta per i run senza persona presente. Khoj scrive anche le **quote nelle descrizioni dei tool** (al massimo 3 ricerche web per domanda), visibili al modello.

**C7 — Revisioni della memoria e delle skill con annullamento** (Letta, mem0, Hermes, nanobot). Tabella append-only con attore (utente, estrattore, consolidatore, revisione), motivo, episodi di origine, testo prima e dopo; sopra si costruisce «annulla l'ultima modifica» nella skill «Ricordi». Per le skill: diff e rollback per versione.

**C8 — Ciclo di vita delle skill** (Hermes, OpenClaw). Parte deterministica, senza modello: attiva → poco usata dopo 14 giorni → archiviata dopo 30, mai cancellata; protette le skill fissate e quelle usate da un'automazione; al primo avvio si registra la data e si aspetta un intervallo invece di agire.

## 3. Memoria: algoritmi specifici

**M1 — Giudice delle contraddizioni con validità temporale** (Graphiti, adattato). È il nostro B1 rimasto aperto. Proposta:
1. l'estrattore restituisce già `valid_from`, `valid_to` e il tipo (`stato`, `evento`, `piano`) rispetto alla data del turno, senza chiamate in più; correttivo italiano per i piani («andrò», «ho intenzione di», «entro venerdì»): la scadenza non diventa fine validità;
2. il giudice parte solo se esiste un fatto attivo vicino ma non identico. **Misura fatta oggi** con `text-embedding-3-small` su coppie italiane fatto/smentita:

   | Coppia | Coseno |
   |---|---|
   | gli piace la pizza ⟷ non gli piace più la pizza | 0,828 |
   | preferisce il tè ⟷ non beve più tè, preferisce il caffè | 0,809 |
   | insegnante a Milano ⟷ insegnante a Torino | 0,802 |
   | verifica venerdì ⟷ verifica spostata a lunedì | 0,812 |
   | è vegetariano ⟷ non è più vegetariano | 0,706 |
   | ha un cane, Fido ⟷ il cane Fido è morto | 0,647 |
   | va in palestra ⟷ ha smesso di andare in palestra | 0,592 |
   | gli piace la pizza ⟷ gli piace molto la pizza (parafrasi) | 0,977 |

   Le smentite stanno tra 0,59 e 0,83: la nostra deduplica a 0,92 **non** le fonde (il rapporto su mem0 ipotizzava il contrario; per l'italiano non è così), e fonde correttamente la parafrasi. Il giudice deve quindi guardare i candidati da **0,55** in su, o con un'entità in comune;
3. una chiamata al modello leggero con output strutturato: per ogni candidato prima il ragionamento, poi la relazione (`duplicato`, `precisa`, `contraddice`, `compatibile`), la citazione dell'utente come prova e la fiducia; regola chiave da Graphiti: c'è contraddizione solo se i due fatti non possono essere veri insieme **e** c'è un'evidenza esplicita di fine o sostituzione; la recenza da sola non basta; il predefinito è `compatibile`;
4. l'applicazione è **deterministica in TypeScript**, sulle date: il vecchio fatto si chiude alla data d'inizio del nuovo; se il nuovo è più vecchio nasce già chiuso; con fiducia bassa o date mancanti i due fatti **coesistono** in stato `in_dubbio` e Ernie chiede conferma; ogni sostituzione produce un avviso al turno dopo («ho aggiornato: …»); mai ritirare in silenzio;
5. il recupero esclude per default i fatti scaduti; `memory_search` può chiedere anche la storia.
Costo stimato: ~1.500 token in ingresso per chiamata, nel 20–30 % dei turni: centesimi al mese.

**M2 — Classi di ritenzione** (nanobot). L'estrattore etichetta i fatti come permanenti, durevoli, effimeri o correzioni. Per Giorgio i fatti effimeri sono proprio quelli utili («verifica di storia venerdì»): con una fine validità calcolata escono da soli dallo snapshot. Si integra con M1.

**M3 — Snapshot a sezioni con budget, indice dei temi e metadati** (Letta). Lo snapshot congelato diventa sezioni (profilo, preferenze, famiglia, progetti in corso, regole) ciascuna con il suo budget; poche righe di indice dei temi non caricati con una descrizione, così il modello sa quando chiamare `memory_search`; metadati (numero di fatti, categorie, ultima conversazione). Quando una sezione sfora si **consolida** invece di troncare (Hermes).

**M4 — Prefisso congelato e aggiornamenti accodati** (OpenClaw). Oggi un fatto nuovo o un «dimentica che…» invalida il prefisso in cache (lo ricostruiamo). OpenClaw fissa il prompt per serie (fino a compattazione, reset o cambio modello) e accoda un messaggio «aggiornamento della memoria» con le sole sezioni cambiate; data e ora stanno nel turno, non nel prefisso. Va limitata la crescita del delta e forzato il riavvio oltre una soglia.

**M5 — Ritocchi al recupero**: MMR (λ 0,7) per non restituire ricordi quasi uguali e decadimento temporale con emivita di 30 giorni sugli episodi (OpenClaw); recupero automatico saltato per messaggi banali come «ok», «grazie» (Hermes); promozione nello snapshot solo dei ricordi richiamati da almeno 3 query diverse (OpenClaw); entità leggere su Postgres come terza lista nella fusione RRF (Graphiti: nome esatto, poi MinHash, solo i casi ambigui al modello; per l'italiano con `unaccent`).

**M6 — Archiviazione testuale per intervalli** (Letta). Quando si consolidano episodi o si riassume, il modello indica solo gli indici del tratto e una breve nota; il codice salva il testo originale. Il modello annota, ma non può fabbricare l'evidenza.

## 4. Idee singole di valore

**S1 — Promemoria a evento** (OpenClaw, «standing intents»). «Quando si parla della gita, ricordami il modulo»: riga con parole chiave in full-text, ambito per utente, ciclo di vita in attesa → armato → scattato → fatto/scaduto; ogni messaggio in arrivo fa un confronto full-text **senza modello**; freni strutturali (attesa di 24 ore, al massimo 3 attivazioni, scadenza 90 giorni, al massimo 3 promemoria iniettati per turno). Nota: il confronto semantico descritto nella loro documentazione non esiste nel codice. Da noi: tabella con RLS e `tsvector('italian')`, controllata accanto alle skill deterministiche; un promemoria verso un altro account solo tramite la Famiglia.

**S2 — Documenti a pezzi con ancora di pagina e citazioni verificate** (Khoj, solo l'idea: è AGPL). Pezzi di ~256 parole con il titolo della sezione in testa, ancora alla pagina, sincronizzazione per hash (embedding solo dei pezzi nuovi), citazioni strutturate con id validati dal server; la scheda nell'app apre la pagina fotografata. «Interrogami solo sul capitolo 3» diventa l'ambito della conversazione. Per la scuola è il salto di qualità. Il loro ranking è più debole del nostro: si prende la pipeline, non la ricerca.

**S3 — Ricerca nelle conversazioni passate** (Hermes). Tool `conversation_search` su Postgres (full-text italiano, RLS), con le sessioni nate dalle automazioni in fondo ma non escluse; solo il primo risultato caricato per intero. Complementa C1, `memory_search` e il diario.

**S4 — Rinvio a sessione occupata e iniezione tra gli step** (nanobot, Khoj). Un'automazione legata a una sessione aspetta che il turno in corso finisca; i messaggi arrivati durante un turno entrano in una coda iniettata tra uno step del modello e il successivo, invece di aspettare la fine. Con la voce conta. Costo medio (ordine dei messaggi, concorrenza).

**S5 — Quote per membro della famiglia** sulle modalità costose (Khoj): ad esempio N ricerche approfondite al giorno per l'account del minore.

## 5. Da non copiare

- **La memoria modificata dal modello durante il turno** (Letta `core_memory_*`, Hermes «sii attivo, quasi ogni sessione produce un aggiornamento»): rende persistente un'iniezione; Letta stessa toglie questi strumenti quando attiva il consolidamento in background. Per noi «niente da salvare» resta la risposta predefinita.
- **Memoria su file Markdown e git** (OpenClaw, nanobot, letta-code): un utente, niente RLS, pulizie a espressioni regolari. Postgres con la provenienza in colonna è meglio.
- **Script e payload eseguiti senza supervisione** e **heartbeat a testo libero con tutti i tool** (OpenClaw, nanobot): in conflitto con il gate a motivi chiusi, inaccettabile con un minore in casa.
- **«Approvazione intelligente» come autorità** (Hermes): al massimo un pre-filtro che manda i dubbi a una persona.
- **mem0 «ADD-only»** (accumula, estrae anche dall'assistente, dedup solo esatta) e **la pipeline completa di Graphiti** (grafo esterno, 6–10 chiamate per turno: con Haiku 5.5 circa 2,8 $ al mese da sola).
- **Honcho** e simili: un servizio esterno a cui andrebbero dati di famiglia.
- **Benchmark**: i numeri di mem0 (LoCoMo 92,5, LongMemEval 94,4) misurano la versione a pagamento con ottimizzazioni proprietarie e 200 ricordi per domanda; nessuno dei progetti è valutato in italiano. Restano valide le nostre misure (recall@5 ≈ 95 % sul corpus italiano).

## 6. Proposta di piano (da decidere con l'utente)

| Id | Idea | Valore | Costo | Dove in Ernie |
|---|---|---|---|---|
| C1 | Compattazione con riassunto strutturato e isteresi | alto | medio | agent-core (processore Mastra), worker |
| M1 + M2 | Giudice delle contraddizioni, validità temporale, fatti effimeri | alto | medio | memory (estrattore, consolidamento), migrazione |
| C4 + C5 | Esito silenzioso, sentinelle, controllo economico prima del modello | alto | basso | automations, proactive |
| S1 | Promemoria a evento | alto | basso | skills, migrazione |
| S2 | Documenti a pezzi con pagina e citazioni | alto (scuola) | medio | documents, iOS |
| C6 | Avviso prima dello stop nei loop, quote nei tool | medio | basso | agent-core, tools |
| C7 | Revisioni della memoria con «annulla» | medio | basso | memory, skill «Ricordi» |
| M3 + M4 | Snapshot a sezioni, prefisso congelato con aggiornamenti accodati | medio | basso/medio | agent-core, memory |
| C2 + C8 | Revisione dopo il turno, ciclo di vita delle skill | medio | medio | skills, worker |
| S3 | Ricerca nelle conversazioni passate | medio | basso | tools, Postgres |
| S4 | Rinvio a sessione occupata, iniezione tra gli step | medio (voce) | medio | api/ws, worker |
| M5, M6, S5 | MMR e decadimento, archivio testuale, quote per membro | basso/medio | basso | memory, automations |

Ordine consigliato: C1 (chiude il buco della finestra a 20 messaggi), M1+M2 (la memoria smette di accumulare e impara le scadenze), C4+C5 (automazioni che non disturbano e non spendono a vuoto), S1, poi S2 per la scuola.

## 7. Licenze

OpenClaw, Hermes Agent e nanobot sono MIT; Letta, mem0 e Graphiti Apache-2.0 (nessuno ha un file NOTICE); Khoj è AGPL-3.0 (solo idee). Reimplementare algoritmi, soglie e architetture non comporta obblighi. Se un giorno adattassimo codice o testo dei prompt di un progetto MIT o Apache, servirebbero licenza, copyright e indicazione delle modifiche in un file `THIRD_PARTY_NOTICES`; la scelta è riscrivere tutto in italiano con parole nostre.
