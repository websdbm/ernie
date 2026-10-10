# Struttura fondamentale degli agenti AI moderni — stato dell'arte 2023 → ottobre 2026

*Ricerca bibliografica per il progetto Ernie (agente personale persistente). Redatta il 10 ottobre 2026. Ambito: loop agentico, context engineering, memoria, tool/MCP, routing, costi, framework di riferimento. Esclusi (coperti da altro report): sicurezza, skill auto-apprese, automazioni, osservabilità, valutazione, voce, protocolli client-server.*

**Convenzioni.** I riferimenti tra parentesi quadre rimandano alla bibliografia numerata (§5). Affidabilità: **Primaria** = paper, specifica, documentazione ufficiale, codice o blog tecnico del vendor sul proprio sistema (i benchmark dei vendor restano *auto-dichiarati*); **Secondaria** = resoconti di terzi; **Opinione** = argomentazioni o posizioni. I numeri sono riportati solo se presenti nella fonte. Molte fonti 2026 sono preprint non ancora peer-reviewed: dove conta, è segnalato. "Consolidato" indica convergenza di più fonti primarie indipendenti; "emergente" indica proposte recenti, isolate o contestate.

## 1. Sommario esecutivo

Principi architetturali più solidi emersi dalla letteratura:

1. **Semplicità prima.** Codice deterministico e singole chiamate LLM prima del loop agentico; aggiungere complessità solo se migliora in modo misurabile i risultati [1, 2].
2. **Harness proprio e sottile.** Gli agenti di produzione usano loop scritti a mano, non framework generici, con limiti hard di passi, costo e tempo e rilevamento dei loop [2, 3].
3. **Il contesto è una risorsa scarsa.** Il degrado con la lunghezza (context rot) colpisce tutti i modelli testati, anche ben prima del limite nominale [4, 5, 6].
4. **Cache-first.** Prefisso stabile, contesto append-only, serializzazione deterministica: il caching riduce i costi API del 41–80% nei task agentici [7, 8, 9].
5. **Compressione a gradini e ripristinabile.** Prima cancellare o mascherare gli output vecchi dei tool, poi riassumere; tenere handle per recuperare i dati [10, 11, 7].
6. **Just-in-time e progressive disclosure** per tool, skill e memoria: indici leggeri sempre presenti, dettagli caricati su richiesta [4, 12, 13].
7. **Pochi tool consolidati e tipizzati**, con output conciso, paginazione ed errori azionabili; il resto differito dietro un tool di ricerca [14, 15, 16].
8. **MCP 2026-07-28 è stateless.** Stato tramite handle espliciti, Streamable HTTP; Sampling, Roots e Logging sono deprecati [17, 18].
9. **Memoria a livelli.** Blocco limitato sempre in contesto (snapshot per sessione), log grezzo ricercabile, fatti con validità temporale e provenienza [19, 20, 21].
10. **Retrieval ibrido.** Full-text/BM25 e vettori fusi con RRF (k=60), con chunk arricchiti da contesto [22, 23, 24].
11. **Consolidamento asincrono** della memoria fuori dal percorso critico (sleep-time, observer/reflector) [25, 26].
12. **Le contraddizioni si invalidano, non si cancellano** (archi bi-temporali) [21, 27].
13. **Routing gerarchico.** Codice → decision model tipizzato → modello piccolo → modello frontier; con cascate e router appresi i costi scendono molto su benchmark pubblici [1, 28, 29].
14. **Subagenti per isolare il contesto**, non come team paralleli su compiti sequenziali, dove degradano fino al −70% [30, 31, 32].
15. **Misurare costo e accuratezza insieme** (cost-of-pass). I benchmark di memoria auto-dichiarati non sono confrontabili tra vendor [33, 34, 35].

**Tendenze emergenti, non ancora consolidate.** Sono proposte recenti con evidenze limitate o contestate:
- memoria come file versionati con git, al posto dei DB [36];
- observational memory al posto del retrieval [26];
- memoria solo-ADD, con i conflitti risolti in lettura [37];
- decision model non generativi come router e gate [28];
- tool come codice in sandbox [38];
- keepalive della prompt cache [39];
- verify-on-stop e stop-guard nei loop [2].

## 2. Analisi per ambito

### 2.1 Anatomia dell'agent loop

#### Sintesi

**Consolidato.** Un agente è un LLM che usa tool in un ciclo e a ogni passo verifica il "ground truth" dell'ambiente [1, 4]. Il ciclo canonico è "gather context → take action → verify work → repeat" [40]. Nel 2026 si chiama **harness** tutto ciò che non è il modello: loop, tool, contesto, stato, sicurezza ("Agent = Model + Harness") [41]. Uno studio sul codice di undici harness di produzione (Claude Code, Codex CLI, Gemini CLI, OpenHands, Aider, Hermes, OpenClaw e altri) mostra che **nessuno importa un framework agentico generico**. Sono loop asincroni scritti a mano, e la loro sofisticazione non predice i risultati nei benchmark. Il minimo funzionante è un `while` con un template, un tool, una lista di messaggi e due limiti, uno di costo e uno di passi [2]. Anthropic distingue i **workflow** (percorsi di codice predefiniti) dagli **agenti** (l'LLM dirige il proprio processo) e consiglia di aggiungere complessità solo se migliora i risultati in modo dimostrabile [1].

#### Pattern e pratiche

- **Pattern di composizione** [1]:
  - prompt chaining;
  - routing (domande facili a modelli piccoli);
  - parallelizzazione (sectioning/voting);
  - orchestrator-workers;
  - evaluator-optimizer;
  - agente autonomo.

  L'OpenAI Agents SDK distingue gli agenti usati come tool (pattern "manager") dagli handoff, in cui il controllo passa a un altro agente [42].
- **ReAct e "pianifica poi esegui".**
  - ReAct alterna ragionamento e azioni. Su ALFWorld/WebShop supera di 34 e 10 punti i metodi di imitation/RL [43].
  - ReWOO separa ragionamento e osservazioni: "5x token efficiency" e +4% su HotpotQA [44].
  - LLMCompiler pianifica un DAG di chiamate parallele: fino a 3.7x di latenza in meno, 6.7x di costo in meno e +~9% di accuratezza rispetto a ReAct [45].
  - Reflexion (memoria episodica di auto-riflessioni) è l'antenato dell'evaluator-optimizer [46].
  - In produzione la pianificazione si è ridotta a un **file di piano/todo** riscritto dall'agente per tenere gli obiettivi in coda al contesto [7, 41].
  - Per il lavoro che dura molte finestre, Anthropic usa un agente "initializer" più sessioni incrementali che lasciano artefatti strutturati: una lista di feature in JSON, che i modelli sovrascrivono meno del Markdown; un file di progresso; commit git; uno script di avvio. I fallimenti tipici sono il voler fare tutto subito e il dichiarare vittoria prima del tempo [47].
- **Limiti e loop detection.**
  - Default dei framework: Vercel AI SDK si ferma a 20 passi, con condizioni di stop custom anche sul costo [48]; LangGraph usa `recursion_limit`, 1000 super-step dalla 1.0.6 [49].
  - Lo StuckDetector di OpenHands rileva quattro schemi: coppie azione-osservazione ripetute (≥4), errori ripetuti (≥3), monologhi (≥3) e ping-pong (≥6). Le soglie fisse fermavano anche il polling legittimo e sono diventate configurabili [3].
  - Gemini CLI abortisce dopo 5 chiamate o 10 chunk identici e fa un auto-controllo LLM dopo 30 turni.
  - Hermes fa l'hash di tool più argomenti ordinati e ha un budget di 90 iterazioni.
  - Pattern emergente: **verify-on-stop**, che non accetta una risposta finale se il codice è cambiato senza verifica [2].
- **Interruzione e cancellazione.**
  - Claude Code lega l'`AbortController` di ogni subagente a quello del padre; Pi usa code di "steering" per inserire messaggi durante l'esecuzione [2].
  - In LangGraph il nodo interrotto **riparte dall'inizio** al resume, quindi gli effetti collaterali vanno resi idempotenti [49].
  - L'esecuzione durevole (Temporal + OpenAI Agents SDK) rende ritentabili e riprendibili chiamate LLM e tool [50]. Anthropic riprende dal punto di errore con checkpoint [30].
- **Tool paralleli.**
  - Nel sistema di ricerca di Anthropic, subagenti paralleli, ognuno con 3+ tool in parallelo, riducono il tempo "fino al 90%" [30].
  - Negli harness vige la concorrenza solo per operazioni sicure: tool unsafe di default in Claude Code, mutazioni di file serializzate in Gemini CLI e Pi [2].
- **Subagenti.**
  - Il vantaggio principale è l'**isolamento del contesto**: un subagente spende decine di migliaia di token e ne restituisce 1.000–2.000 [4]. In Claude Code ha prompt, tool e permessi propri [51].
  - Numeri di Anthropic: il sistema multi-agente supera il singolo agente Opus 4 del 90.2% sull'eval interna di ricerca; i token spiegano l'80% della varianza su BrowseComp; il multi-agente consuma ~15x i token di una chat, un singolo agente ~4x [30].

#### Controversie e trade-off

- **Multi-agente.**
  - Cognition sostiene che subagenti paralleli prendono decisioni implicite in conflitto e preferisce un agente lineare con compressione della storia [31].
  - Anthropic ammette che il multi-agente è inadatto con molto contesto condiviso e per la maggior parte del coding [30].
  - Uno studio controllato di Google e MIT (260 configurazioni) misura, rispetto al singolo agente, da +80.8% su compiti decomponibili a −70.0% sulla pianificazione sequenziale [32].
  - MAST cataloga 14 modi di fallimento dei sistemi multi-agente su 1.600+ tracce [52].
- **Framework o codice proprio.** Anthropic consiglia le API dirette [1]; nessun harness di produzione usa framework [2]; 12-Factor Agents (opinione) predica "own your control flow" [53].
- **Soglie di loop detection.** Se rigide fermano il polling legittimo, se lasche sprecano token. Nessuna fonte offre una taratura validata.

#### Implicazioni pratiche per un agente personale persistente a basso consumo di token

- Partire dal workflow: la maggior parte delle richieste si risolve con codice o con una singola chiamata LLM + tool. Il loop aperto va riservato ai task con un numero di passi imprevedibile [1].
- Ogni turno ha limiti hard di passi, token e tempo, più uno stuck detector su hash di (tool, argomenti, esito) con soglie per tool di polling [3, 2].
- I tool con effetti collaterali sono idempotenti e riprendibili da checkpoint, così i job BullMQ si possono ritentare senza duplicare invii [49, 50].
- I task che durano più sessioni hanno uno stato strutturato (JSON) e un log di progresso letti all'avvio [47].
- Subagenti solo per isolare il contesto, con output di 1–2k token. Parallelismo solo per tool read-only [4, 32, 2].
- La cancellazione si propaga dal client (barge-in vocale) a tutto l'albero di chiamate tramite AbortSignal gerarchico [2].

### 2.2 Context engineering

#### Sintesi

**Consolidato.** Il context engineering consiste nel curare, a ogni chiamata, il minimo insieme di token ad alto segnale [4]. Il motivo è il **context rot**, il calo graduale del richiamo man mano che l'input cresce [4].
- Chroma lo ha misurato su 18 modelli: su LongMemEval tutti rendono di più con il prompt focalizzato (~300 token) che con quello completo (~113k), e i distrattori simili alla risposta peggiorano i risultati [5].
- In NoLiMa, 11 modelli su 13 dichiarati ≥128K scendono sotto il 50% del proprio baseline già a 32K token, quando domanda e risposta non condividono parole [6].
- Il "lost in the middle" è noto dal 2023 [54].

Lo studio sugli harness conclude che le tecniche di compaction sono ormai convergenti e che **la memoria persistente è la nuova frontiera** [2].

#### Pattern e pratiche

- **Il contesto come vista compilata.** Google ADK ricostruisce il working context a ogni chiamata da tre fonti durevoli: sessione (log di eventi), memoria e artifact. Lo assembla con processori nominati e ordinati e tiene separati storage e presentazione, con uno scope minimo di default [55]. LangChain riassume le strategie in quattro verbi: write, select, compress, isolate [56].
- **Prefisso stabile = cache.**
  - Manus chiama il KV-cache hit rate "la metrica più importante". Con un rapporto input/output di ~100:1, i token in cache costavano 0.30 contro 3 USD/MTok su Claude Sonnet [7].
  - Regole condivise da Manus, Google, OpenAI e Anthropic: prefisso immutabile (niente timestamp in testa), contesto append-only, JSON deterministico, contenuto dinamico in coda [7, 55, 57, 9].
  - L'unica valutazione sistematica (500+ sessioni, tre provider) misura −41–80% di costo e −13–31% di time-to-first-token. Il caching "ingenuo" dell'intero contesto può però aumentare la latenza: conviene mettere in cache solo il system prompt o escludere i risultati dinamici dei tool [8].
  - Cambiare le definizioni dei tool invalida tutta la cache [9]. Per questo Manus maschera i tool invece di rimuoverli [7], OpenAI suggerisce `allowed_tools` [57] e MCP 2026-07-28 chiede un ordine deterministico di `tools/list` [17]. Un ordine non deterministico dei tool MCP causava cache miss in Codex [58].
- **Compressione a gradini.**
  - Si parte dal *clearing* dei risultati vecchi dei tool, la forma più leggera [4]. Anthropic lo fa lato server: trigger di default a 100k token, conserva gli ultimi 3 tool use, e `clear_at_least` evita di invalidare la cache per pochi token [11].
  - Poi vengono il masking e il riassunto LLM.
  - Soglie osservate negli harness:
    - Claude Code compatta vicino alla finestra (buffer di 13k) e reidrata fino a 5 file;
    - Gemini CLI compatta oltre il 50% e conserva verbatim il 30% più recente;
    - Hermes compatta al 50%, con riassunto ≤12K e una sessione figlia [2].
  - Le API offrono compaction server-side: OpenAI con `compact_threshold` o `/responses/compact` (item cifrato, opaco) [59], Anthropic con `compact_20260112` [11].
- **Just-in-time e progressive disclosure.**
  - L'agente tiene identificatori leggeri (path, link, query) e carica i dati a runtime. Claude Code combina `CLAUDE.md` caricato in anticipo con glob/grep al bisogno [4].
  - Le Agent Skills caricano solo nome e descrizione; il corpo e i file collegati arrivano su richiesta [12].
  - Nessuno degli 11 harness usa vector RAG come retrieval primario del codice [2].
  - La compressione deve essere **ripristinabile**: si toglie la pagina ma si tiene l'URL; l'output completo del tool va su file e in contesto restano testa e coda [7, 41].
- **System prompt all'"altitudine giusta".** Né regole if-else fragili né indicazioni vaghe. Si parte da un prompt minimo e lo si estende in base ai fallimenti osservati, con pochi esempi canonici [4]. Negli harness la policy si sta spostando dal prompt alla configurazione [2].
- **Separare identità, istruzioni e memoria.**
  - Hermes inietta `MEMORY.md` (≤2.200 caratteri) e `USER.md` (≤1.375) come **snapshot congelato per sessione**, così le scritture a metà sessione non rompono la cache [2].
  - ADK separa le istruzioni statiche dalla sessione e dalla memoria [55].

#### Controversie e trade-off

- **Riassunto LLM o masking?**
  - JetBrains (SWE-agent, 5 configurazioni): mascherare le osservazioni vecchie dimezza il costo e uguaglia il riassunto LLM; un ibrido risparmia un altro 7–11% [10].
  - ACON: linee guida di compressione ottimizzate sui fallimenti tagliano i picchi del 26–54% e fanno guadagnare fino al 46% ai modelli piccoli [60].
  - Cognition: un buon compressore è difficile da costruire [31].
- **Compaction o caching?** Ogni compaction crea un nuovo prefisso e azzera la cache [57]. Lo stesso vale per il clearing, da cui `clear_at_least` [11].
- **Keepalive.** Un preprint a singolo autore stima che "pingare" il prefisso durante le pause riduca il costo post-pausa fino a 12.5x. Con TTL di 5 minuti l'intervallo ottimale è ~4 minuti, e il break-even arriva a ~46 minuti di inattività (Anthropic) [39].

#### Implicazioni pratiche per un agente personale persistente a basso consumo di token

- Ordinare la richiesta per stabilità decrescente:
  1. tool in ordine deterministico;
  2. identità e istruzioni statiche;
  3. snapshot di memoria per sessione;
  4. riassunto di sessione;
  5. turni recenti;
  6. messaggio corrente.

  Data e ora vanno in coda [7, 55, 2].
- Il cache hit rate è un KPI. Con `session_id` OpenRouter mantiene lo sticky routing verso lo stesso provider; la stickiness scade dopo 10 minuti di inattività [61].
- Ordine di compressione: clearing o masking degli output vecchi, poi riassunto con un modello piccolo, infine reset con note persistenti [10, 11].
- I payload grandi vanno in Postgres; in contesto restano un handle e un estratto [7, 55].
- Per conversazioni vocali con pause lunghe, valutare il TTL di 1h o un keepalive dopo un calcolo di break-even [9, 39].

### 2.3 Architetture di memoria

#### Sintesi

La tassonomia di riferimento è CoALA. Distingue working memory (le variabili del ciclo corrente), memoria episodica (esperienze), semantica (conoscenza) e procedurale (pesi e codice/prompt) [62]. Le survey 2025–2026 la raffinano con gli assi forme/funzioni/dinamiche [63] e con sei operazioni: consolidamento, aggiornamento, indicizzazione, oblio, retrieval, condensazione [64]. Nella pratica la mappa è semplice: semantica = fatti e profilo; episodica = thread passati; procedurale = prompt, skill, `CLAUDE.md` [65, 66].

**Consolidato (ott. 2026): un'architettura a livelli.**
1. Un blocco piccolo, limitato e sempre in contesto.
2. Una storia grezza, lossless e ricercabile.
3. Fatti estratti con tempo e provenienza.
4. Consolidamento in background.

**Aperto:** come implementare il livello 3. Le opzioni sono un DB vettoriale, un grafo temporale, file versionati o compressione osservazionale.

#### Sistemi e meccanismi

- **MemGPT → Letta.**
  - MemGPT gestisce un "contesto virtuale" alla maniera di un sistema operativo: contesto principale (istruzioni, working context modificabile via funzioni, coda FIFO con riassunto ricorsivo) e contesto esterno (recall e archival storage). Avvisa al ~70% della finestra e a pieno espelle il ~50% dei messaggi [19].
  - Letta ne ha ricavato i **memory block**: label, descrizione, valore e limite in caratteri, condivisibili tra agenti [67].
  - *Sleep-time compute*: pre-calcolare in background riduce di ~5x il compute a test-time a pari accuratezza e di 2.5x il costo per query nei casi multi-query [25]. In prodotto diventa uno sleep-time agent che modifica la memoria in modo asincrono [68].
  - Nel 2026 Letta è passata a **file versionati con git** (MemFS, "Context Repositories", deframmentazione verso 15–25 file) e ha dismesso i tool di memoria server-side [69, 36].
- **Generative Agents.**
  - Retrieval = recency (decadimento 0.995/ora) + importanza (LLM, 1–10) + rilevanza (coseno).
  - La **riflessione** scatta quando l'importanza cumulata supera 150 e produce insight che citano i record d'origine.
  - Senza riflessione la credibilità cala (TrueSkill 29.89 → 26.88) [70].
- **A-MEM.** Note Zettelkasten con link creati da un LLM e "memory evolution". Dichiara ~1.200 token per operazione contro 16.900 dei baseline [71]. Con le metriche di Mem0 risulta però il sistema più debole (48.38 J) [27].
- **Mem0.**
  - Paper 2025: estrazione dei fatti (messaggi + riassunto + ultimi 10), poi aggiornamento con una scelta LLM ADD/UPDATE/DELETE/NOOP sui 10 ricordi più simili. Mem0g marca gli archi obsoleti come invalidi invece di cancellarli [27].
  - Risultati LoCoMo (J, categoria adversarial esclusa):

    | Sistema | J |
    |---|---|
    | full-context | 72.90 |
    | Mem0g | 68.44 |
    | Mem0 | 66.88 |
    | Zep | 65.99 |
    | LangMem | 58.10 |
    | OpenAI | 52.90 |


    Mem0 ha p95 di 1.44 s contro 17.12 s e usa 1.764 contro 26.031 token per query [27].
  - L'algoritmo v3 (2026) estrae **solo con ADD**: i conflitti coesistono e il retrieval ibrido (semantico + keyword + entità) privilegia i fatti recenti. I punteggi dichiarati non coincidono tra pagine dello stesso vendor (LoCoMo 92.5 vs 91.6; LongMemEval 94.4 vs 93.4). Su BEAM-10M le categorie più deboli sono contraddizioni (32.5) e ragionamento temporale (16.3) [72, 37].
- **Zep / Graphiti.**
  - Grafo temporale con episodi grezzi, entità/fatti e community, e **archi bi-temporali** (validità ed ingestione): in caso di contraddizione il vecchio arco viene invalidato, non cancellato. Retrieval con coseno + BM25 + BFS e rerank (RRF, MMR, cross-encoder) [21].
  - LongMemEval_S con gpt-4o: 60.2% → 71.2%, latenza 28.9 → 2.58 s, contesto 115k → 1.6k token. Peggiora sulle domande single-session-assistant (94.6 → 80.4) [21].
  - Graphiti collega ogni fatto ai suoi episodi e non usa LLM a query time [73].
- **Hermes Agent.**
  - `MEMORY.md` (2.200 caratteri) e `USER.md` (1.375) entrano come snapshot congelato e sono curati dall'agente con add/replace/remove.
  - Non c'è auto-compaction: oltre il limite il tool dà errore e l'agente deve consolidare.
  - Rifiuta i duplicati e scansiona le scritture.
  - La session search usa SQLite FTS5 (~20 ms, senza LLM; il README dice il contrario) [20, 74, 75].
- **Mastra Memory.**
  - *Working memory*: template Markdown o schema Zod con deep merge, scope resource o thread, merge atomici solo su Postgres.
  - *Semantic recall*: `topK` + `messageRange`, disattivo di default [76].
  - *Observational memory*: un Observer trasforma i messaggi in osservazioni datate e prioritarie, un Reflector le fonde. Il contesto è append-only, quindi cacheabile, con compressione ~3–6x sul testo. Soglie di default: 30k token per osservare, 40k per riflettere.
  - LongMemEval_S dichiarato: 84.23% con gpt-4o (oracle 82.4%) e 94.87% con gpt-5-mini, con Observer/Reflector su gemini-2.5-flash. Mastra non pubblica LoCoMo [26, 76].
- **Anthropic.**
  - Il memory tool è client-side e lavora su file `/memories` che l'applicazione può mappare su DB [77].
  - Al lancio: +39% con memory tool + context editing, +29% con il solo context editing, −84% di token in un'eval da 100 turni [78].
  - Claude Code usa `CLAUDE.md` gerarchico più auto memory (indice `MEMORY.md`, prime 200 righe o 25KB, più un file per argomento) [66].
- **Altri sistemi.**
  - **Hindsight** è il più vicino a uno stack Postgres: HNSW pgvector + BM25 (GIN) + grafo + filtro temporale, fusi con RRF e rerank cross-encoder. LongMemEval 83.6% con un modello open da 20B [24].
  - MemOS aggiunge metadati di provenienza e TTL [79].
  - MIRIX usa sei tipi di memoria [80].
  - Memory-R1 addestra un memory manager con RL [81].

#### Retrieval

- **RRF.** Il punteggio è Σ 1/(k + rank) con k=60 [22]. Lo usano Graphiti, Hindsight, Mem0 v3 e l'esempio ufficiale pgvector, che fonde i top-20 vettoriali con i top-20 full-text [21, 24, 72, 82].
- **HNSW in pgvector.** Default m=16, ef_construction=64, ef_search=40 [82]. Attenzione: `ts_rank` non è BM25; per un vero BM25 serve un'estensione come pg_textsearch [83].
- **Contextual Retrieval.** Prefissare ogni chunk con 50–100 token di contesto riduce i fallimenti top-20 del 35% (solo embedding), del 49% (+BM25) e del 67% (+rerank). Sotto ~200k token di knowledge base conviene mettere tutto nel prompt [23].
- **Granularità.** LongMemEval: memorizzare per round ed espandere le chiavi con fatti estratti dà +9.4% di recall e +5.4% di QA [84].

#### Igiene della memoria

- **Dedup:** entity resolution LLM (Graphiti), rifiuto dei duplicati (Hermes), deframmentazione (Letta) [21, 20, 69].
- **Consolidamento asincrono:** sleep-time, "dreaming" Letta, Reflector Mastra, review in staging Hermes [25, 85, 26, 74].
- **Contraddizioni.** Tre strategie: invalidare (Graphiti, Mem0g), sovrascrivere (Mem0 v2, Hermes), conservare tutto e ordinare per recenza (Mem0 v3) [21, 27, 37].
- **Provenienza:** link fatto→episodio, metadati MemOS, riflessioni con fonti [73, 79, 70].
- **Oblio.**
  - MemoryBank usa una curva di Ebbinghaus "altamente semplificata" [86]; Anthropic suggerisce di far scadere i file non usati [77].
  - Nessun oblio è validato empiricamente.
  - La memoria è anche superficie d'attacco: AgentPoison supera l'80% di successo con <0.1% di dati avvelenati (tema del collega) [87].

#### Controversie e trade-off

- **Disputa Mem0–Zep.**
  - Mem0 dà Zep a 65.99 [27]. Zep accusa errori di configurazione e dichiara 75.14 [88].
  - Nella issue pubblica Zep ammette un errore su un precedente "84%" [89].
  - Un agente Letta con solo grep e file, su gpt-4o-mini, fa 74.0 [90].
  - Nel paper Mem0 il full-context batte tutti su LoCoMo; su LongMemEval vince invece la memoria [27, 21, 26].
- **Benchmark inaffidabili.**
  - Il rilascio pubblico di LoCoMo ha 10 conversazioni da ~16–26k token, che entrano tutte nel contesto [91, 88].
  - Un audit stima errato il 6.4% delle risposte di riferimento e trova giudici che accettano il 62.81% di risposte sbagliate [35].
  - I punteggi dipendono dal modello lettore/giudice: Zep va da ~80% (gpt-4o-mini) a 94.7% (gpt-5.4) [92].
  - Benchmark più robusti: LongMemEval (5 abilità, varianti S/M) [84], BEAM (10M token) [93], MemoryAgentBench (oblio selettivo) [94].
- **File o DB?** Letta, Anthropic, Claude Code e Hermes convergono sui file curati dall'agente, e nessun harness usa embedding come memoria primaria [2, 36]. Le prove però vengono soprattutto da LoCoMo. A scala di anni serve comunque un indice [93, 24].

#### Implicazioni pratiche per un agente personale persistente a basso consumo di token

- Quattro livelli in Postgres [20, 21, 82]:
  1. profilo e note limitati (1–3k caratteri) come snapshot per sessione;
  2. log grezzo con FTS;
  3. tabella fatti con `valid_from/valid_to/created_at/expired_at`, FK all'episodio e confidenza;
  4. HNSW su fatti e riassunti.
- Retrieval ibrido in SQL: top-20 + top-20, RRF con k=60, rerank solo se serve, chunk con prefisso contestuale generato da un modello piccolo [82, 22, 23].
- Recall **come tool** e non come iniezione a ogni turno: un blocco stabile con ricerca on-demand preserva la cache [26, 55].
- Estrazione dopo la risposta; dedup, contraddizioni e riflessioni in job notturni via Batch API [25, 70, 95].
- Le contraddizioni si invalidano, non si cancellano, per poter rispondere a domande temporali [21].
- Valutare su LongMemEval S/M e su domande personali di aggiornamento, non su LoCoMo. Misurare anche token per query e p95 [84, 35, 27].

### 2.4 Tool design e registry

#### Sintesi

**Consolidato.** Un tool è un contratto tra software deterministico e un agente non deterministico, e va progettato per l'agente, non come semplice wrapper di un'API [14]. A scala emergono due problemi:
- **peso delle definizioni**: 5 server MCP con 58 tool costano ~55K token prima ancora di iniziare; Anthropic ne ha visti 134K internamente [15];
- **accuratezza di selezione**, che degrada oltre 30–50 tool [13].

La risposta comune è il **caricamento differito**, adottato da Claude Code, Codex (BM25) e altri harness [2].

#### Pattern e pratiche

- **Progettazione** [14, 96]:
  - pochi tool che consolidano un flusso (`schedule_event`, `search_contacts` invece di `list_contacts`), oppure un parametro `action`;
  - namespacing per servizio;
  - identificatori leggibili;
  - `response_format` concise/detailed (72 contro 206 token nell'esempio);
  - paginazione e troncamento: Claude Code limita i risultati a 25.000 token;
  - errori specifici e azionabili;
  - poka-yoke, come i path assoluti [1];
  - iterazione guidata da eval su task realistici con set held-out [14].
- **Schemi tipizzati.**
  - Lo *strict tool use* garantisce input conformi allo schema tramite grammar-constrained sampling [16].
  - MCP 2026-07-28 adotta JSON Schema 2020-12 e `structuredContent` libero, che va validato lato client [17, 97].
  - Gli `input_examples` (1–5 per tool) portano l'accuratezza su parametri complessi da 72% a 90%, al costo di ~20–200 token per esempio [15, 96].
- **Tool search.**
  - Con `defer_loading` le definizioni restano fuori dal contesto finché non vengono cercate (regex, BM25 o embedding custom): fino a 5 risultati, 10.000 tool differiti per richiesta. Non toccano il prefisso, quindi la cache resta valida [13].
  - Risultati dichiarati: ~77K → ~8.7K token ("85%"; i numeri implicano ~89%). Accuratezza MCP 49 → 74% (Opus 4) e 79.5 → 88.1% (Opus 4.5) [15].
  - Va usato oltre ~10 tool o 10K token di definizioni, tenendo caricati i 3–5 tool più usati [13].
  - Evidenza indipendente: RAG-MCP dimezza i token del prompt e porta la selezione da 13.62% a 43.13% [98].
- **Tool come codice.** L'agente scrive codice che orchestra i tool e riporta solo il risultato. Anthropic dichiara −37% di token medi [15] e ~150K → ~2K token in un esempio con server MCP esposti come API TypeScript [38]. Il prezzo è una sandbox sicura [38].
- **MCP oggi: revisione 2026-07-28** [99, 18, 17].
  - **Core stateless.** Spariscono handshake `initialize` e `Mcp-Session-Id`; versione e capability viaggiano in `_meta` di ogni richiesta; arriva `server/discover`. Lo stato passa per **handle espliciti** negli argomenti dei tool.
  - **Multi Round-Trip Requests** al posto di sampling/elicitation/roots server-initiated.
  - Tasks come estensione, `subscriptions/listen`, header `Mcp-Method`/`Mcp-Name` per i gateway, `ttlMs`/`cacheScope` sulle liste.
  - **Deprecati**: Roots, Sampling, Logging, HTTP+SSE e Dynamic Client Registration (sostituita dai Client ID Metadata Documents), con finestra minima di 12 mesi.
  - Auth: OAuth 2.1, introdotto nel 2025-03-26 insieme a Streamable HTTP e alle tool annotation [100], ora con validazione `iss` (RFC 9207).
  - Adozione: gli SDK Tier 1 sono vicini al mezzo miliardo di download/mese [18].
  - Le annotation vanno considerate non affidabili salvo da server fidati; la spec raccomanda human-in-the-loop, timeout e audit log [97].
- **Idempotenza, timeout, retry.** Mancano studi specifici. Le norme vengono da:
  - spec MCP: timeout lato client, rate limit lato server, handle con TTL dichiarato ed errori espliciti per handle scaduti [97];
  - framework: nodi rieseguiti al resume [49];
  - esecuzione durevole [50].

#### Controversie e trade-off

- **Descrizioni brevi o ricche?** Anthropic chiede almeno 3–4 frasi per tool e lo definisce "di gran lunga il fattore più importante" [96], ma ogni token si paga a ogni richiesta. Il compromesso documentato: descrizioni ricche + `defer_loading` + cache [13].
- **MCP, skill o codice?** `SKILL.md` è adottato da 9 harness su 11, MCP da 8 su 11 [2]. Il code mode risparmia token ma sposta il rischio sulla sandbox [38].
- **MCP stateless** scala meglio, ma lascia al modello il compito di portarsi dietro gli handle [18, 97].

#### Implicazioni pratiche per un agente personale persistente a basso consumo di token

- Registry tipizzato (Zod → JSON Schema 2020-12) con namespacing, ordine deterministico e strict mode [16, 17].
- 3–5 tool core sempre caricati (memoria, ricerca, calendario); il resto dietro un tool di ricerca su Postgres FTS/embedding [13, 98].
- Output conciso di default, paginazione, handle per il dettaglio e un tetto di token per risultato [14].
- Tool con effetti collaterali: chiave di idempotenza, timeout, retry con backoff solo se idempotenti, errori restituiti con `isError` [97].
- Per catene di 3+ chiamate dipendenti o aggregazioni grandi, valutare l'esecuzione programmatica in sandbox [15].
- Allinearsi a MCP 2026-07-28 ed evitare le feature deprecate [17].

### 2.5 Routing e selezione del modello

#### Sintesi

Il routing sceglie, per ogni richiesta, il modello o il percorso di codice che basta. Si distinguono due approcci [101]:
- **routing**: una sola decisione;
- **cascading**: si parte dal modello piccolo e si sale se la qualità stimata non basta.

Nel 2025–2026 il routing è entrato nei prodotti:
- GPT-5 è un sistema unificato con un router in tempo reale che decide in base a tipo di conversazione, complessità, tool necessari e intento esplicito dell'utente [102];
- l'Auto Router di OpenRouter classifica la richiesta in ~30 tipi di task e ordina i modelli per quota di spesa della community negli ultimi 7 giorni, senza sovrapprezzo [103].

A settembre 2026 è nata una nuova categoria, i **decision model non generativi**.

#### Pattern e pratiche

- **Evidenze accademiche (consolidate, su benchmark pubblici).**
  - FrugalGPT: pari a GPT-4 con fino al 98% di costo in meno [104].
  - Hybrid LLM: fino al 40% di chiamate in meno al modello grande senza perdita di qualità [105].
  - RouteLLM (router su dati di preferenza: matrix factorization, BERT, LLM): −85% di costo su MT Bench, −45% su MMLU e −35% su GSM8K a ~95% della qualità di GPT-4 [29, 106].
  - RouterBench: oltre 405k esiti di inferenza [107].
  - Arch-Router (1.5B): mappa le query su policy in linguaggio naturale modificabili senza riaddestramento (+7.71% dichiarato dagli autori) [108].
- **Jev (TypeSafe), rilasciato a settembre 2026.** Riceve uno `state` testuale più domande tipizzate e restituisce **solo** risposte tipizzate con probabilità, senza prosa [28, 109]. Primitive:
  - **choice**: un'opzione da un insieme fisso, con le probabilità di ciascuna;
  - **noul**: la probabilità che una proposizione sì/no sia vera;
  - **score**: una posizione su una scala ordinata (max 10 livelli).

  Dettagli d'uso:
  - Endpoint OpenRouter `POST /api/alpha/decisions` (`typesafe/jev-1.13`), **in alpha**; la route chat restituisce 400 [109].
  - 0.042 USD per milione di token di input, output gratuito; una chiamata da 447 token costa ~0.0000188 USD [28].
  - Usi indicati: triage, classificazione, gating di azioni rischiose (noul prima di un tool distruttivo), verifica di bozze, ranking.
  - Sconsigliato per prosa, immagini e logica deterministica; date e soglie vanno calcolate in codice.
  - Limiti: nessuna motivazione delle risposte, probabilità variabili tra chiamate (0.79 → 0.84), calibrazione valida solo in aggregato, modello proprietario senza paper [28].
- **Evidenze indipendenti su Jev (preliminari).**
  - Valutazione arXiv su 37 dataset: batte Qwen3.8-27B in 27 e Gemma-4-E4B in tutti; probabilità ben calibrate; soglie tarate portano il micro-F1 su UNFAIR-ToS da 0.50 a 0.75; 346k richieste per meno di 10 USD; latenza non misurata [110].
  - jev-bench (72 esempi, una sola run) [111]:

    | Modello | Accuratezza | p50 | USD per 1.000 decisioni |
    |---|---|---|---|
    | Jev | 94.4% | ~185 ms | ~0.02 |
    | Haiku 4.5 | 91.7% | ~1.2 s | ~0.82 |
    | Opus 5 | 98.6% | ~2.6 s | ~6.40 |

- **Lo spettro delle opzioni.** Dalla più economica alla più costosa:
  1. regole deterministiche;
  2. classificatori leggeri (RouteLLM);
  3. decision model tipizzati (Jev);
  4. piccoli LLM-router (Arch-Router);
  5. LLM frontier con prompt di routing.

  Anthropic presenta il routing come workflow di base [1]; 12-Factor Agents sostiene che il control flow va tenuto in codice [53].
- **Cache delle decisioni.** Non esiste letteratura specifica; la più vicina è quella sulla semantic cache, che ne mostra i rischi:
  - GPTCache produce molti falsi hit, e MeanCache dichiara +25% di F-score [112];
  - le chiavi per similarità sono attaccabili, con dirottamenti all'86% [113].

  OpenRouter applica sticky routing per preservare la prompt cache [61].

#### Controversie e trade-off

- **Claim del vendor contro misure indipendenti.** TypeSafe dichiara "193.6x Faster, 444.6x Cheaper" su workload non specificati [114]; le misure di terzi riportano ~0.2 s di mediana [111].
- **Limite di contesto di Jev.** 32k su OpenRouter contro 64k totali dichiarati da TypeSafe [109, 28].
- **Trasferibilità dei router.** I guadagni sono misurati su benchmark pubblici; la survey 2026 segnala che i router si trasferiscono male a pool e distribuzioni nuove [101].
- **Routing contro caching.** Cambiare modello a metà conversazione azzera la cache del prefisso [9, 61].

#### Implicazioni pratiche per un agente personale persistente a basso consumo di token

- Per ogni punto decisionale, in quest'ordine: codice deterministico → decision model tipizzato → modello piccolo → frontier [28, 1].
- Uso delle primitive:
  - **choice** per intento e percorso;
  - **noul** con bande act/review/escalate per il gating di azioni esterne o distruttive;
  - **score** per complessità e urgenza, per scegliere il modello [28].
- Tarare le soglie su qualche centinaio di esempi propri e prevedere un fallback, perché l'endpoint è alpha [28, 109].
- Scegliere il modello a inizio sessione e cambiarlo di rado. I task ancillari vanno in chiamate separate a modelli piccoli [9, 61].
- Mettere in cache solo decisioni su input normalizzati ed esatti, con TTL; niente cache semantica su decisioni che autorizzano azioni [112, 113].

### 2.6 Ottimizzazione di token e costi

#### Sintesi

Negli agenti domina il costo dell'**input ripetuto**. Senza cache il volume inviato cresce in modo quadratico con la conversazione [58], e Manus misura un rapporto input/output di ~100:1 [7]. Un agente usa ~4x i token di una chat, un sistema multi-agente ~15x [30]. "AI Agents That Matter" ha reso standard la valutazione congiunta di costo e accuratezza: ottimizzare la sola accuratezza produce agenti inutilmente costosi [33].

#### Tecniche misurate

| Tecnica | Risultato riportato | Fonte |
|---|---|---|
| Prompt caching in task agentici | −41–80% costo, −13–31% TTFT | [8] |
| Prezzi cache Anthropic | write 1.25x (5 min) / 2x (1 h); read 0.1x (0.05x Opus/Sonnet 5.5); minimo 512–4.096 token | [9] |
| Prezzi cache OpenAI | read 0.1x, write 1.25x (GPT-5.6+); TTL ≥30 min; minimo 1.024 token | [57] |
| Observation masking | costo dimezzato a parità di solve rate; ibrido −7/−11% | [10] |
| Compressione ottimizzata (ACON) | −26–54% token di picco | [60] |
| Tool search | ~77K → ~8.7K token di contesto | [15] |
| Programmatic tool calling | −37% token medi | [15] |
| MCP come codice | ~150K → ~2K token (esempio) | [38] |
| Output conciso dei tool | 72 vs 206 token | [14] |
| LLMLingua-2 | compressione 2–5x, latenza 1.6–2.9x inferiore | [115] |
| RouteLLM | −85% costo su MT Bench a ~95% di qualità | [29] |
| FrugalGPT | fino a −98% (benchmark 2023) | [104] |
| Batch API Anthropic | −50% input e output, entro 24 h | [95] |
| Cache keepalive | costo post-pausa fino a 12.5x inferiore (preprint) | [39] |
| Efficient Agents (GAIA) | 96.7% delle prestazioni, 0.398 → 0.228 USD/task | [34] |
| Decision model (Jev) | ~0.02 vs ~0.82 USD per 1.000 decisioni (72 esempi) | [111] |

#### Effort, modelli piccoli, batch

- **Effort.**
  - I modelli di ragionamento sovra-ragionano sui task banali: per "2+3" i modelli o1-like spendono in media ~1.953% di token in più [116].
  - Il parametro `effort` di Anthropic (low → max) agisce su **tutti** i token di output: testo, tool call e thinking. A effort basso il modello fa meno chiamate, più terse; `low` è indicato per i subagenti [117].
  - Cambiare effort a livello di richiesta invalida la cache; il cambio per-messaggio (beta) la preserva [117, 9]. OpenAI offre `configuration_update` per lo stesso scopo [57].
- **Modelli piccoli.**
  - NVIDIA sostiene (position paper) che la maggior parte delle invocazioni agentiche sono compiti ripetitivi adatti a modelli piccoli, in sistemi eterogenei [118].
  - Esempi concreti: ACON distilla il compressore [60]; la compaction può usare un modello diverso dal principale [11].
- **Batch.**
  - Consolidamento, ri-embedding e riassunti periodici sono adatti alle Batch API (−50%) [95].
  - Nei batch Anthropic i cache hit tra righe non sono garantiti; meglio un prefisso condiviso con TTL di 1 h [61].

#### Controversie e trade-off

- **Il risparmio della cache dipende dalla disciplina del prefisso.** Il caching ingenuo può peggiorare la latenza [8], e compaction o cambio di modello lo azzerano [57].
- **Benchmark contro conversazioni reali.** I risparmi di cascate e router sono misurati su benchmark accademici; nelle conversazioni personali la qualità percepita è soggettiva [108].
- **Costi reali in evoluzione.** Claude Code riporta ~13 USD per sviluppatore per giorno attivo in ambito enterprise (una versione precedente diceva ~6). Il dato non è trasferibile a un assistente personale [119].

#### Implicazioni pratiche per un agente personale persistente a basso consumo di token

- Budget per turno in **token di input non in cache**, monitorati con `cache_read`/`cache_creation` [9, 57].
- Effort minimo di default, alzato solo su segnale del router, possibilmente per-messaggio [117].
- Un modello piccolo dedicato per riassunti, estrazione di memoria e classificazioni [118, 60].
- Manutenzione della memoria in job BullMQ notturni via Batch API [95].
- Misurare il cost-of-pass per feature, cioè il costo per task riuscito [34, 33].

### 2.7 Framework e progetti di riferimento

#### Sintesi

I framework convergono su un nucleo comune: loop con limite di passi, subagenti o handoff, human-in-the-loop con sospensione e ripresa, sessioni, client MCP, streaming. Si differenziano su tre assi:
- **astrazione**: dal toolkit (Vercel AI SDK) al runtime durevole a grafo (LangGraph, ADK 2.0, workflow Mastra);
- **memoria integrata**: assente (AI SDK), solo sessioni (OpenAI SDK) o ricca (Mastra, Letta, CrewAI, Hermes, OpenClaw);
- **legame con un vendor**: il Claude Agent SDK funziona con Claude, ADK è orientato a Gemini/GCP.

Gli harness di produzione non usano framework [2]. I **personal agent self-hosted** (Hermes, OpenClaw) sono i più vicini al caso Ernie, ma hanno problemi di sicurezza documentati. Dettagli e versioni sono nella tabella del §3.

#### Profili

- **Mastra (TS).** Il più vicino allo stack di Ernie [120, 121, 122, 76].
  - Loop agente con `maxSteps`; supervisor che delegano a subagenti come tool.
  - Workflow a grafo con `suspend/resume` tipizzati e snapshot persistiti che sopravvivono ai deploy.
  - **Processors** per step: `TokenLimiter`, `ToolCallFilter`, `ToolSearchProcessor`, guardrail.
  - Memoria a tre meccanismi (§2.3). MCPClient/Server sulla rev. 2026-07-28. 22 adapter di storage, Postgres consigliato in produzione.
  - 1.0 il 20/01/2026 (300k+ download npm settimanali, utenti dichiarati tra cui Replit e PayPal).
  - Apache-2.0, tranne le cartelle `ee/` sotto licenza enterprise.
  - Debolezze: il semantic recall aggiunge latenza a ogni chiamata; un test di terzi (opinione) trova documentazione in ritardo sul codice [123].
- **LangGraph / LangChain v1.** [124, 125, 49]
  - Runtime a grafo di basso livello; `create_agent` più middleware (HITL, summarization, todo, subagenti, retry).
  - Checkpointer per thread e Store cross-thread con ricerca semantica; esecuzione durevole.
  - `interrupt()` riesegue il nodo al resume.
  - 1.0 il 22/10/2025 con stabilità promessa fino alla 2.0. MIT.
- **OpenAI Agents SDK.** [42]
  - Runner loop con `max_turns`=10, handoff come tool `transfer_to_*`.
  - Guardrail di input solo sul primo agente, di output solo sull'ultimo.
  - Sessioni (anche con compaction), nessuno store semantico; durable via Temporal, DBOS, Restate, Dapr.
  - Ancora 0.x. MIT.
- **Google ADK.** [126, 127]
  - Cinque linguaggi; la 2.0 (GA Python 19/05/2026) è un Workflow Runtime a grafo con HITL e retry.
  - Stato con scope `user:`, `app:`, `temp:`; Memory Bank; compaction e context caching configurabili.
  - Google dichiara ~50% di token e ~20% di latenza in meno per un workflow rispetto a un agente libero, su API simulate.
  - Apache-2.0.
- **Claude Agent SDK.** [128]
  - Loop di Claude Code; `maxTurns` e `maxBudgetUsd` **senza limite di default**.
  - Tool read-only in parallelo; subagenti isolati (profondità 3, concorrenza 20); hook che non consumano contesto.
  - Sei modalità di permesso, tra cui `bypassPermissions`, dove le regole deny restano valide.
  - Compaction automatica; sessioni JSONL locali.
  - Licenza ambigua; solo modelli Claude.
- **Letta.** [85, 36]
  - Pioniera dei memory block e dello sleep-time. Nel 2026 è passata a `letta-code` con MemFS su git e "dreaming", deprecando l'SDK V1 e il formato `.af`.
  - Apache-2.0. Debolezza: forte instabilità della piattaforma.
- **CrewAI.** [129, 123]
  - Crews a ruoli e Flows event-driven con persistenza.
  - `max_iter`=20; memoria unificata su LanceDB; MCP solo per i tool.
  - MIT. Installazione pesante (opinione).
- **Pydantic AI.** [130]
  - Loop tipizzato con `UsageLimits`. La v2 (giugno 2026) introduce le "capabilities" con `defer_loading`, compaction server-side e steering a metà esecuzione.
  - Durable via Temporal, DBOS, Prefect. MIT.
- **Vercel AI SDK.** [131, 48]
  - `ToolLoopAgent` (20 passi) con `prepareStep`; la v7 aggiunge `WorkflowAgent` durevole e un `HarnessAgent` sperimentale.
  - **Nessuna memoria né storage integrati.** Apache-2.0.
- **Hermes Agent.** [75, 20, 2]
  - Gateway multi-canale, subagenti, cron, sette sandbox.
  - Memoria a due file limitati con snapshot congelato e FTS5.
  - Skill auto-scritte, con l'approvazione delle scritture disattivata di default.
  - Budget di 90 iterazioni.
  - MIT. Limiti documentati: i fatti salvati diventano visibili solo dalla sessione successiva; i modelli deboli "dicono" di salvare senza chiamare il tool.
- **OpenClaw.** [132, 133]
  - Gateway locale, canali di chat, nodi per voce e camera.
  - Workspace di file iniettati: `AGENTS.md`, `SOUL.md`, `USER.md` (≤4.000 caratteri), `MEMORY.md`, log giornalieri; cap di 20k caratteri per file e 60k totali.
  - **Heartbeat** ogni 30 minuti.
  - Ricerca ibrida: chunk da 400 token, FTS5 BM25 + sqlite-vec, recenza, MMR, flush prima della compaction.
  - MIT. La documentazione definisce la prompt injection "irrisolta"; CVE-2026-25253 (CVSS 8.8); skill malevole su ClawHub secondo ricercatori terzi.

#### Controversie e trade-off

- **Numeri del vendor incoerenti.** Adozione e benchmark vengono dai vendor e a volte non tornano tra pagine: stelle Mastra 19.8k vs 28.7k; download Vercel "20M mensili" vs "16M settimanali" [121, 131].
- **Limiti di passi di default.** LangGraph documenta 1000 dalla 1.0.6, molte fonti secondarie dicono ancora 25 [49]; OpenAI usa 10, Vercel 20, Claude Agent SDK nessuno [42, 48, 128].
- **Framework o harness proprio.** I framework accelerano, ma le astrazioni oscurano prompt e risposte [1, 2].
- **Personal agent.** Hermes e OpenClaw mostrano il pattern "file di memoria + gateway + heartbeat/cron + skill", con superfici d'attacco rilevanti [75, 132, 133].

#### Implicazioni pratiche per un agente personale persistente a basso consumo di token

- Usare le primitive Mastra (PostgresStore/PgVector, workflow suspend/resume, processors, MCP), ma **possedere** l'assemblaggio del prompt dove serve un controllo fine della cache [120, 2].
- Prendere dai personal agent i pattern a basso costo: profilo e note limitati con snapshot (Hermes), heartbeat/cron con `activeHours` invece di loop sempre attivi, ricerca ibrida con chunk piccoli e MMR (OpenClaw) [20, 132].
- Impostare sempre `maxSteps` e un budget espliciti [128].
- Usare workflow persistiti per i task in attesa dell'utente [120, 124].
- Evitare le feature in deprecazione (`.af` di Letta, Sampling/Roots di MCP, agenti workflow ADK in TS) [85, 17, 126].

## 3. Tabella comparativa dei framework

Dati letti dalle fonti primarie il 10/10/2026 (stelle e versioni cambiano rapidamente); "n.v." = non verificato. Fonti per riga: Mastra [120, 121, 122, 76]; LangGraph [124, 125, 49]; OpenAI Agents SDK [42]; Google ADK [126]; Claude Agent SDK [128]; Letta [85]; CrewAI [129]; Pydantic AI [130]; Vercel AI SDK [131, 48]; Hermes [75, 20]; OpenClaw [132, 133].

| Framework | Loop / orchestrazione | Memoria | Tool / MCP | Streaming | Storage | Maturità | Licenza | Note |
|---|---|---|---|---|---|---|---|---|
| **Mastra** (TS) | Agent loop con `maxSteps`; supervisor + subagenti; workflow a grafo con suspend/resume persistiti; processors per step | `lastMessages` (10), working memory (template/schema, scope resource), semantic recall, observational memory | `createTool` (Zod); MCPClient + MCPServer (stdio, Streamable HTTP, rev. 2026-07-28); ToolSearchProcessor | Sì (`.stream()`) | 22 adapter (Postgres, libSQL, MongoDB, Redis, …); PgVector + altri vector store; store composito per dominio | 1.0 20/01/2026; core 1.75.0; ~28.7k★ | Apache-2.0 (+ `ee/` enterprise) | OM 84.23% (gpt-4o) / 94.87% (gpt-5-mini) su LongMemEval_S, dato del vendor |
| **LangGraph / LangChain v1** (Py/JS) | StateGraph; `recursion_limit` (1000 dalla 1.0.6 secondo i docs); `interrupt`/`Command`; `create_agent` + middleware | Checkpointer per thread + Store cross-thread con ricerca semantica | Tool LangChain; MCP n.v. nelle fonti lette | 7 modalità di stream | Postgres, SQLite, Redis, MongoDB, Oracle | 1.0 22/10/2025; 1.2.x; ~43k★ | MIT | Esecuzione durevole; basso livello |
| **OpenAI Agents SDK** (Py/TS) | Runner loop; `max_turns`=10; handoff; guardrail; HITL con `RunState` | Sessioni (anche con compaction via Responses API); nessuno store semantico | Function tool (Pydantic); MCP (stdio, SSE, Streamable HTTP); tool ospitati | `run_streamed` | SQLite, Redis, SQLAlchemy, MongoDB, Dapr, Conversations API | 0.23.1 (02/10/2026), JS 0.20; ~30k★ | MIT | Ancora 0.x; durable via Temporal/DBOS/Restate/Dapr |
| **Google ADK** (5 linguaggi) | LlmAgent + agenti workflow; 2.0 Workflow Runtime a grafo (nodi), HITL, retry | Session/State con scope `user:`/`app:`/`temp:`; MemoryService (Memory Bank); compaction; context caching | Function, OpenAPI, MCP (client + server); A2A | SSE + bidirezionale Live (sperim.) | SQLite/Postgres/MySQL/MariaDB, Vertex | 1.0 20/05/2025; 2.0 GA Py 19/05/2026; 2.11.0; ~21.8k★ | Apache-2.0 | Orientato a Gemini/GCP (opinione) |
| **Claude Agent SDK** (TS/Py) | Loop di Claude Code; `maxTurns`/`maxBudgetUsd` senza limite di default; subagenti (prof. 3, conc. 20); hook; 6 modalità di permesso | CLAUDE.md, skill, compaction automatica; sessioni JSONL con resume/fork | Tool built-in ricchi; MCP in-process (Zod); tool search attivo di default | Iteratore di messaggi + delta parziali | JSONL locale; SessionStore (esempi S3/Redis/PG) | Rinominato 29/09/2025; npm 0.3.x | Ambigua (Commercial ToS vs MIT) | Solo modelli Claude |
| **Letta** | Agenti stateful; subagenti in background; "dreaming" | Memory block + archival (V1, in deprecazione); MemFS su git | MCP in V1; Agent SDK n.v. | Sì (V1) | Letta Cloud / locale; git | letta ~25k★; letta-code ~3.6k★ | Apache-2.0 | V1 deprecata; `.af` rimosso da Letta Code |
| **CrewAI** (Py) | Crews a ruoli + Flows event-driven; `max_iter`=20; persistenza e ripresa Flow | Memoria unificata (LanceDB, scope gerarchici, recall assistito da LLM) | Campo `mcps` / MCPServerAdapter (solo tool) | `stream=True` sui Flow | LanceDB, SQLite | 1.15.x; ~59.5k★ | MIT | Installazione pesante (opinione) |
| **Pydantic AI** (Py) | Loop tipizzato; grafo `iter()`; `UsageLimits`; v2 "capabilities" e steering | `message_history`; StepPersistence; Memory del Harness (0.x) | Tool Pydantic; MCP; `defer_loading` | `run_stream(_events)`, AG-UI | SQLite, MongoDB, file; Postgres per Memory | v2 23/06/2026; 2.55.0; ~20.5k★ | MIT | Durable via Temporal/DBOS/Prefect |
| **Vercel AI SDK** (TS) | `ToolLoopAgent` (stop a 20 passi), `prepareStep`; v7 `WorkflowAgent` durevole; `HarnessAgent` sperim. | Nessuna integrata (provider esterni o tool) | `@ai-sdk/mcp` (HTTP, SSE, stdio, OAuth); MCP Apps sperim. | `streamText`, hook UI | A carico dell'app | v7 25/06/2026; `ai` 7.0.x; ~27k★ | Apache-2.0 | Toolkit, non runtime completo |
| **Hermes Agent** (Py) | TUI + gateway multi-canale; subagenti; cron; budget 90 iterazioni | `MEMORY.md` 2.200 / `USER.md` 1.375 caratteri, snapshot congelato; session search FTS5; provider esterni | Client MCP; skill `SKILL.md` auto-scritte | Streaming nella TUI | Markdown + SQLite | v0.21.6 (08/10/2026); ~252k★ | MIT | Approvazione scritture skill disattivata di default |
| **OpenClaw** (TS) | Gateway + canali + nodi; heartbeat (30 min); file di workspace iniettati | `MEMORY.md` + log giornalieri; ricerca ibrida BM25 + vettori + MMR; flush prima della compaction | MCP (stdio, SSE, HTTP); skill via ClawHub | n.v. | Markdown + SQLite per agente (FTS5, sqlite-vec) | 2026.9.9; ~391k★ | MIT | CVE-2026-25253; skill malevole su ClawHub |

## 4. Lacune e domande aperte della letteratura

**Mancano studi su agenti personali di lunga durata.** I benchmark di memoria sono sintetici o brevi. LoCoMo ha 10 conversazioni pubbliche che entrano nel contesto; LongMemEval_S misura soprattutto la gestione della finestra; BEAM (fino a 10M token) è recente [91, 35, 93]. Non esistono studi longitudinali pubblici su un assistente usato per mesi da una persona reale.

**La valutazione della memoria non è standardizzata.** Lettore, giudice, profondità di retrieval e categorie incluse cambiano da paper a paper; la disputa Mem0–Zep e le discrepanze interne di Mem0 v3 lo mostrano [88, 89, 72]. Un audit stima errato il 6.4% delle risposte di riferimento di LoCoMo e trova giudici troppo permissivi [35].

**Non c'è un oblio validato.** Le proposte (Ebbinghaus, decadimento per recenza, TTL) sono euristiche; nessun sistema di produzione dimostra un forgetting che migliori l'accuratezza senza perdite [86, 70, 79].

**Riconciliare in scrittura o in lettura?** Mem0 è passato a una memoria solo-ADD, Graphiti invalida in scrittura; manca un confronto indipendente sulle domande di aggiornamento della conoscenza [37, 21].

**File o database?** La convergenza su memoria-come-file (Letta, Anthropic, Claude Code, Hermes) poggia su evidenze limitate, soprattutto LoCoMo, e su casi d'uso di coding [90, 36, 2]. Per memorie personali di anni il trade-off non è misurato.

**Caching, compaction e routing non sono ottimizzati insieme.** Ognuno è studiato da solo; la loro interazione (una compaction o un cambio di modello azzerano la cache) è documentata solo in modo qualitativo, salvo un preprint sul keepalive [8, 39, 57].

**Interruzione e cancellazione sono poco studiate.** Barge-in, steering a metà esecuzione e propagazione dell'abort appaiono solo come dettagli implementativi negli studi sugli harness [2]. Mancano benchmark su loop detection e soglie di stop: le soglie in uso sono empiriche e producono falsi positivi [3].

**Idempotenza e retry negli agenti** non hanno letteratura specifica: le indicazioni vengono da specifiche (timeout raccomandati in MCP), framework (nodi rieseguiti al resume) e dalla prassi dei sistemi distribuiti [97, 49, 50].

**I decision model non generativi sono troppo nuovi.** Le evidenze su Jev risalgono a 2–4 settimane fa: un abstract arXiv, un benchmark da 72 esempi, materiale del distributore e del vendor. La calibrazione è dibattuta, l'endpoint è alpha e non esistono pesi né paper tecnico [110, 111, 109, 114].

**I router si trasferiscono male.** I guadagni di RouteLLM e FrugalGPT sono misurati su benchmark accademici; non è chiaro quanto reggano su conversazioni personali, dove la qualità percepita è soggettiva [101, 108].

**Il multi-agente resta conteso.** I risultati dipendono dal task (da +80.8% a −70.0%) e i dati favorevoli più citati vengono da valutazioni interne dei vendor [32, 30, 31].

**Molte fonti sono preprint e materiale vendor.** Una quota rilevante delle fonti 2026 (harness study, keepalive, Jev, Hindsight, gran parte dei benchmark di memoria) non è peer-reviewed o è prodotta da chi vende il sistema valutato.

## 5. Bibliografia

Formato: titolo — autori/organizzazione — data — URL — tipo — affidabilità. Le date "consultata ott 2026" indicano pagine di documentazione senza data di pubblicazione, lette il 10/10/2026.

1. **Building effective agents** — E. Schluntz, B. Zhang — Anthropic — 19 dic 2024 (pagina aggiornata nel 2025-26) — https://www.anthropic.com/engineering/building-effective-agents — blog vendor — Primaria
2. **Harness Engineering: Anatomy, Architecture, and Evolution of Coding Agents — A Source-Code Study of Eleven Systems** — P. Barbaste, T. Darrigol, G. Vu, T. Wiltberger — 15 lug 2026 — https://arxiv.org/abs/2609.00006 — paper (preprint) — Primaria (preprint non peer-reviewed)
3. **Agent Stuck Detector (documentazione) + issue #762** — OpenHands — consultata ott 2026 — https://docs.openhands.dev/sdk/guides/agent-stuck-detector — docs — Primaria
4. **Effective context engineering for AI agents** — Anthropic Applied AI team — 29 set 2025 — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents — blog vendor — Primaria
5. **Context Rot: How Increasing Input Tokens Impacts LLM Performance** — K. Hong, A. Troynikov, J. Huber — Chroma — 14 lug 2025 — https://www.trychroma.com/research/context-rot — technical report — Primaria
6. **NoLiMa: Long-Context Evaluation Beyond Literal Matching** — A. Modarressi et al. — feb 2025 (ICML 2025) — https://arxiv.org/abs/2502.05167 — paper — Primaria
7. **Context Engineering for AI Agents: Lessons from Building Manus** — Y. 'Peak' Ji — Manus — 18 lug 2025 — https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus — blog vendor — Primaria (esperienza di produzione, non peer-reviewed)
8. **Don't Break the Cache: An Evaluation of Prompt Caching for Long-Horizon Agentic Tasks** — E. Lumer et al. — gen 2026 — https://arxiv.org/abs/2601.06007 — paper (preprint) — Primaria
9. **Prompt caching (documentazione)** — Anthropic — Claude Platform docs — consultata ott 2026 — https://platform.claude.com/docs/en/build-with-claude/prompt-caching — docs — Primaria
10. **The Complexity Trap: Simple Observation Masking Is as Efficient as LLM Summarization for Agent Context Management** — T. Lindenbauer et al. (JetBrains Research) — ago 2025 (NeurIPS DL4C 2025) — https://arxiv.org/abs/2508.21433 — paper — Primaria
11. **Context editing (documentazione)** — Anthropic — Claude Platform docs — consultata ott 2026 — https://platform.claude.com/docs/en/build-with-claude/context-editing — docs — Primaria
12. **Equipping agents for the real world with Agent Skills** — Anthropic — ott 2025 — https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills — blog vendor — Primaria
13. **Tool search tool (documentazione)** — Anthropic — Claude Platform docs — consultata ott 2026 — https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool — docs — Primaria
14. **Writing effective tools for agents — with agents** — Anthropic — 11 set 2025 — https://www.anthropic.com/engineering/writing-tools-for-agents — blog vendor — Primaria
15. **Introducing advanced tool use on the Claude Developer Platform** — Anthropic — 24 nov 2025 — https://www.anthropic.com/engineering/advanced-tool-use — blog vendor — Primaria
16. **Strict tool use (documentazione)** — Anthropic — Claude Platform docs — consultata ott 2026 — https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use — docs — Primaria
17. **MCP Specification 2026-07-28 — Key Changes** — MCP maintainers — 28 lug 2026 — https://modelcontextprotocol.io/specification/2026-07-28/changelog — specifica — Primaria
18. **The 2026-07-28 Specification** — D. Soria Parra, D. Delimarsky — MCP blog — 28 lug 2026 — https://blog.modelcontextprotocol.io/posts/2026-07-28/ — blog ufficiale — Primaria
19. **MemGPT: Towards LLMs as Operating Systems** — C. Packer et al. — ott 2023 (v2 feb 2024) — https://arxiv.org/abs/2310.08560 — paper — Primaria
20. **Hermes Agent — Memory (documentazione)** — Nous Research — consultata ott 2026 — https://hermes-agent.nousresearch.com/docs/user-guide/features/memory — docs — Primaria
21. **Zep: A Temporal Knowledge Graph Architecture for Agent Memory** — P. Rasmussen, P. Paliychuk, T. Beauvais, J. Ryan, D. Chalef — 20 gen 2025 — https://arxiv.org/abs/2501.13956 — paper — Primaria (benchmark auto-dichiarati)
22. **Reciprocal Rank Fusion Outperforms Condorcet and Individual Rank Learning Methods** — G. V. Cormack, C. L. A. Clarke, S. Büttcher — SIGIR 2009 — https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf — paper — Primaria
23. **Introducing Contextual Retrieval** — Anthropic — 19 set 2024 — https://www.anthropic.com/news/contextual-retrieval — blog vendor — Primaria
24. **Hindsight is 20/20: Building Agent Memory that Retains, Recalls, and Reflects** — C. Latimer et al. — 14 dic 2025 — https://arxiv.org/abs/2512.12818 — paper (preprint) — Primaria
25. **Sleep-time Compute: Beyond Inference Scaling at Test-time** — K. Lin, C. Snell, Y. Wang, C. Packer, S. Wooders, I. Stoica, J. Gonzalez — 17 apr 2025 — https://arxiv.org/abs/2504.13171 — paper — Primaria
26. **Observational Memory: 95% on LongMemEval** — T. Barnes — Mastra — 9 feb 2026 — https://mastra.ai/research/observational-memory — research blog vendor — Primaria (vendor, benchmark auto-dichiarati)
27. **Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory** — P. Chhikara et al. — 28 apr 2025 — https://arxiv.org/abs/2504.19413 — paper — Primaria (benchmark auto-dichiarati)
28. **What Is Jev? TypeSafe's Decision Model Explained for Developers** — K. Rogers — OpenRouter — 21 set 2026 (agg. 24 set) — https://openrouter.ai/blog/insights/what-is-jev/ — blog piattaforma — Primaria/Secondaria (piattaforma distributrice)
29. **RouteLLM: An Open-Source Framework for Cost-Effective LLM Routing** — LMSYS (I. Ong et al.) — 1 lug 2024 — https://lmsys.org/blog/2024-07-01-routellm/ — blog accademico — Primaria
30. **How we built our multi-agent research system** — Anthropic — 13 giu 2025 — https://www.anthropic.com/engineering/multi-agent-research-system — blog vendor — Primaria
31. **Don't Build Multi-Agents** — W. Yan — Cognition — 12 giu 2025 — https://cognition.com/blog/dont-build-multi-agents — blog vendor — Opinione (vendor)
32. **Towards a Science of Scaling Agent Systems** — Y. Kim et al. (Google Research, Google DeepMind, MIT) — dic 2025 (v3 apr 2026) — https://arxiv.org/abs/2512.08296 — paper — Primaria
33. **AI Agents That Matter** — S. Kapoor, B. Stroebl, Z. S. Siegel, N. Nadgir, A. Narayanan — lug 2024 — https://arxiv.org/abs/2407.01502 — paper — Primaria
34. **Efficient Agents: Building Effective Agents While Reducing Cost** — N. Wang et al. (OPPO) — lug 2025 — https://arxiv.org/abs/2508.02694 — paper (work in progress) — Primaria
35. **We audited LoCoMo: 6.4% of the answer key is wrong…** — Penfield Labs — apr 2026 — https://dev.to/penfieldlabs/we-audited-locomo-64-of-the-answer-key-is-wrong-and-the-judge-accepts-up-to-63-of-intentionally-33lg — blog terzi — Secondaria/Opinione
36. **Letta's Next Phase** — Letta — 16 mar 2026 — https://www.letta.com/blog/our-next-phase/ — blog vendor — Primaria (vendor)
37. **Platform: Migrating to the New Memory Algorithm (v2 → v3)** — Mem0 — consultata ott 2026 — https://docs.mem0.ai/migration/platform-v2-to-v3 — docs — Primaria
38. **Code execution with MCP: building more efficient agents** — Anthropic — 4 nov 2025 — https://www.anthropic.com/engineering/code-execution-with-mcp — blog vendor — Primaria
39. **Keeping the Cache Warm Pays: Keepalive Economics for Agentic Workloads** — M. Khailo — lug 2026 — https://arxiv.org/abs/2607.19214 — paper (preprint, 5 pagine) — Primaria (non replicato)
40. **Building agents with the Claude Agent SDK** — Anthropic — 29 set 2025 — https://claude.com/blog/building-agents-with-the-claude-agent-sdk — blog vendor — Primaria
41. **The Anatomy of an Agent Harness** — V. Trivedy — LangChain — 10 mar 2026 — https://www.langchain.com/blog/the-anatomy-of-an-agent-harness — blog vendor — Opinione/Primaria
42. **OpenAI Agents SDK — docs (Running agents, Sessions, Guardrails, Handoffs), run_config.py, repo** — OpenAI — consultata ott 2026 (v0.23.1, 2 ott 2026) — https://openai.github.io/openai-agents-python/ ; https://github.com/openai/openai-agents-python — docs/repo — Primaria
43. **ReAct: Synergizing Reasoning and Acting in Language Models** — S. Yao et al. — ott 2022 (ICLR 2023) — https://arxiv.org/abs/2210.03629 — paper — Primaria
44. **ReWOO: Decoupling Reasoning from Observations for Efficient Augmented Language Models** — B. Xu et al. — 23 mag 2023 — https://arxiv.org/abs/2305.18323 — paper — Primaria
45. **An LLM Compiler for Parallel Function Calling** — S. Kim et al. — dic 2023 (ICML 2024) — https://arxiv.org/abs/2312.04511 — paper — Primaria
46. **Reflexion: Language Agents with Verbal Reinforcement Learning** — N. Shinn et al. — mar 2023 — https://arxiv.org/abs/2303.11366 — paper — Primaria
47. **Effective harnesses for long-running agents** — Anthropic — 26 nov 2025 — https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents — blog vendor — Primaria
48. **Loop Control (documentazione AI SDK)** — Vercel — consultata ott 2026 — https://ai-sdk.dev/docs/agents/loop-control — docs — Primaria
49. **Graph API (documentazione LangGraph)** — LangChain — consultata ott 2026 — https://docs.langchain.com/oss/python/langgraph/graph-api — docs — Primaria
50. **Production-ready agents with the OpenAI Agents SDK + Temporal** — Temporal — 30 lug 2025 — https://temporal.io/blog/announcing-openai-agents-sdk-integration — blog vendor — Primaria (vendor)
51. **Claude Code — Subagents (documentazione)** — Anthropic — consultata ott 2026 — https://code.claude.com/docs/en/sub-agents — docs — Primaria (dettaglio su Haiku per Explore: Secondaria)
52. **Why Do Multi-Agent LLM Systems Fail?** — M. Cemri et al. — mar 2025 (v3 ott 2025) — https://arxiv.org/abs/2503.13657 — paper — Primaria
53. **12-Factor Agents** — D. Horthy — HumanLayer — 2025 — https://github.com/humanlayer/12-factor-agents — repo/manifesto — Opinione
54. **Lost in the Middle: How Language Models Use Long Contexts** — N. F. Liu et al. — lug 2023 (TACL) — https://arxiv.org/abs/2307.03172 — paper — Primaria
55. **Architecting efficient context-aware multi-agent framework for production** — H. Lin — Google Developers Blog — 4 dic 2025 — https://developers.googleblog.com/architecting-efficient-context-aware-multi-agent-framework-for-production/ — blog vendor — Primaria
56. **Context Engineering (for agents)** — LangChain — 2 lug 2025 — https://www.langchain.com/blog/context-engineering-for-agents — blog vendor — Secondaria (letta parzialmente)
57. **Prompt caching (documentazione)** — OpenAI — consultata ott 2026 — https://developers.openai.com/api/docs/guides/prompt-caching — docs — Primaria
58. **OpenAI Unrolls the Codex Agent Loop (resoconto di 'Unrolling the Codex agent loop', M. Bolin, 23 gen 2026)** — A. Alford — InfoQ — 3 feb 2026 — https://www.infoq.com/news/2026/02/codex-agent-loop — news — Secondaria (originale OpenAI non accessibile: https://openai.com/index/unrolling-the-codex-agent-loop/)
59. **Compaction (documentazione)** — OpenAI — consultata ott 2026 — https://developers.openai.com/api/docs/guides/compaction — docs — Primaria
60. **ACON: Optimizing Context Compression for Long-horizon LLM Agents** — M. Kang et al. — ott 2025 (ICML 2026) — https://arxiv.org/abs/2510.00615 — paper — Primaria
61. **Prompt caching (documentazione)** — OpenRouter — consultata ott 2026 — https://openrouter.ai/docs/features/prompt-caching — docs — Primaria
62. **Cognitive Architectures for Language Agents (CoALA)** — T. Sumers, S. Yao, K. Narasimhan, T. Griffiths — set 2023 (TMLR 2024) — https://arxiv.org/abs/2309.02427 — paper — Primaria
63. **Memory in the Age of AI Agents** — Y. Hu et al. — dic 2025 (v2 gen 2026) — https://arxiv.org/abs/2512.13564 — survey — Primaria
64. **Rethinking Memory in LLM based Agents: Representations, Operations, and Emerging Topics** — Y. Du et al. — mag 2025 (v3 dic 2025) — https://arxiv.org/abs/2505.00675 — survey — Primaria
65. **LangMem — Conceptual Guide** — LangChain — consultata ott 2026 — https://langchain-ai.github.io/langmem/concepts/conceptual_guide/ — docs — Primaria
66. **Claude Code — How Claude remembers your project (documentazione)** — Anthropic — consultata ott 2026 — https://code.claude.com/docs/en/memory — docs — Primaria
67. **Memory blocks (documentazione)** — Letta — consultata ott 2026 — https://docs.letta.com/guides/agents/memory-blocks — docs — Primaria
68. **Sleep-time Compute (blog)** — Letta — 21 apr 2025 — https://www.letta.com/blog/sleep-time-compute — blog vendor — Primaria (vendor)
69. **Introducing Context Repositories: Git-based Memory for Coding Agents** — Letta — 12 feb 2026 — https://www.letta.com/blog/context-repositories/ — blog vendor — Primaria (vendor)
70. **Generative Agents: Interactive Simulacra of Human Behavior** — J. S. Park et al. — apr 2023 (UIST 2023) — https://arxiv.org/abs/2304.03442 — paper — Primaria
71. **A-MEM: Agentic Memory for LLM Agents** — W. Xu et al. — feb 2025 (NeurIPS 2025) — https://arxiv.org/abs/2502.12110 — paper — Primaria
72. **Introducing The Token-Efficient Memory Algorithm** — Mem0 — 16 apr 2026 (agg. 28 set 2026) — https://mem0.ai/blog/mem0-the-token-efficient-memory-algorithm — blog vendor — Primaria (vendor)
73. **Graphiti (README)** — Zep — consultato ott 2026 — https://github.com/getzep/graphiti — repo — Primaria
74. **Hermes Agent — session_search_tool.py e memory_tool.py** — Nous Research — branch main, consultato ott 2026 — https://github.com/NousResearch/hermes-agent/tree/main/tools — codice — Primaria
75. **Hermes Agent — README, docs Skills, release notes** — Nous Research — consultato ott 2026 (v0.21.6, 8 ott 2026) — https://github.com/NousResearch/hermes-agent ; https://hermes-agent.nousresearch.com/docs/user-guide/features/skills — repo/docs — Primaria (README in parte non aggiornato)
76. **Mastra docs — Memory: working memory, semantic recall, observational memory** — Mastra — consultata ott 2026 — https://mastra.ai/docs/memory/overview (e /working-memory, /semantic-recall, /observational-memory) — docs — Primaria
77. **Memory tool (documentazione)** — Anthropic — Claude Platform docs — consultata ott 2026 — https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool — docs — Primaria
78. **Managing context on the Claude Developer Platform** — Anthropic — 29 set 2025 — https://claude.com/blog/context-management — blog vendor — Primaria (vendor)
79. **MemOS: A Memory OS for AI System** — Z. Li et al. — lug 2025 (v4 dic 2025) — https://arxiv.org/abs/2507.03724 — paper (preprint) — Primaria
80. **MIRIX: Multi-Agent Memory System for LLM-Based Agents** — Y. Wang, X. Chen — 10 lug 2025 — https://arxiv.org/abs/2507.07957 — paper (preprint) — Primaria
81. **Memory-R1: Enhancing LLM Agents to Manage and Utilize Memories via Reinforcement Learning** — S. Yan et al. — ago 2025 (v5 gen 2026) — https://arxiv.org/abs/2508.19828 — paper (preprint) — Primaria
82. **pgvector (README)** — A. Kane — consultato ott 2026 (v0.8.x) — https://github.com/pgvector/pgvector — repo — Primaria
83. **Introducing pg_textsearch: True BM25 Ranking and Hybrid Retrieval in Postgres** — Tiger Data — 23 ott 2025 — https://www.tigerdata.com/blog/introducing-pg_textsearch-true-bm25-ranking-hybrid-retrieval-postgres — blog vendor — Primaria (vendor)
84. **LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory** — D. Wu et al. — ott 2024 (ICLR 2025) — https://arxiv.org/abs/2410.10813 — paper — Primaria
85. **Letta docs (V1 SDK, Memory & dreaming) e repo letta, letta-code, agent-file** — Letta — consultata ott 2026 — https://docs.letta.com/ ; https://github.com/letta-ai/letta-code — docs/repo — Primaria
86. **MemoryBank: Enhancing Large Language Models with Long-Term Memory** — W. Zhong et al. — 17 mag 2023 — https://arxiv.org/abs/2305.10250 — paper — Primaria
87. **AgentPoison: Red-teaming LLM Agents via Poisoning Memory or Knowledge Bases** — Z. Chen, Z. Xiang, C. Xiao, D. Song, B. Li — 17 lug 2024 — https://arxiv.org/abs/2407.12784 — paper — Primaria
88. **Lies, Damn Lies, & Statistics: Is Mem0 Really SOTA in Agent Memory?** — D. Chalef, P. Rasmussen — Zep — 6 mag 2025 — https://www.getzep.com/blog/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/ — blog vendor — Opinione (con dati propri)
89. **getzep/zep-papers — Issue #5 (Mem0 vs Zep)** — Deshraj (Mem0), D. Chalef (Zep) — 8–19 mag 2025 — https://github.com/getzep/zep-papers/issues/5 — issue GitHub — Primaria (entrambe le parti)
90. **Benchmarking AI Agent Memory: Is a Filesystem All You Need?** — Letta — 12 ago 2025 — https://www.letta.com/blog/benchmarking-ai-agent-memory — blog vendor — Primaria (vendor) / Opinione
91. **Evaluating Very Long-Term Conversational Memory of LLM Agents (LoCoMo)** — A. Maharana et al. — 27 feb 2024 — https://arxiv.org/abs/2402.17753 — paper — Primaria
92. **Zep Research (benchmark)** — Zep — agg. 29 set 2026 — https://www.getzep.com/research/ — pagina vendor — Primaria (vendor)
93. **Beyond a Million Tokens: Benchmarking and Enhancing Long-Term Memory in LLMs (BEAM)** — M. Tavakoli et al. — ott 2025 (v2 feb 2026) — https://arxiv.org/abs/2510.27246 — paper — Primaria
94. **Evaluating Memory in LLM Agents via Incremental Multi-Turn Interactions (MemoryAgentBench)** — Y. Hu, Y. Wang, J. McAuley — lug 2025 (v4 giu 2026) — https://arxiv.org/abs/2507.05257 — paper — Primaria
95. **Introducing the Message Batches API** — Anthropic — 8 ott 2024 (GA 17 dic 2024) — https://www.anthropic.com/news/message-batches-api — blog vendor — Primaria
96. **Define tools (documentazione)** — Anthropic — Claude Platform docs — consultata ott 2026 — https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools — docs — Primaria
97. **MCP Specification 2026-07-28 — Server: Tools** — MCP maintainers — 28 lug 2026 — https://modelcontextprotocol.io/specification/2026-07-28/server/tools — specifica — Primaria
98. **RAG-MCP: Mitigating Prompt Bloat in LLM Tool Selection via Retrieval-Augmented Generation** — T. Gan, Q. Sun — mag 2025 — https://arxiv.org/abs/2505.03275 — paper (preprint) — Primaria
99. **Model Context Protocol — Specification (revisione 2026-07-28)** — MCP maintainers — 28 lug 2026 — https://modelcontextprotocol.io/specification/latest — specifica — Primaria
100. **MCP Specification 2025-03-26 — Key Changes** — MCP maintainers — 26 mar 2025 — https://modelcontextprotocol.io/specification/2025-03-26/changelog — specifica — Primaria
101. **Dynamic Model Routing and Cascading for Efficient LLM Inference: A Survey** — Y. Moslem, J. D. Kelleher (ADAPT, Trinity College Dublin) — 23 feb 2026 — https://arxiv.org/abs/2603.04445 — survey — Primaria
102. **GPT-5 System Card** — OpenAI — 7 ago 2025 — https://openai.com/index/gpt-5-system-card/ — system card — Primaria (letta tramite estratti)
103. **Auto Router / Model routing (documentazione)** — OpenRouter — consultata ott 2026 — https://openrouter.ai/docs/features/model-routing — docs — Primaria
104. **FrugalGPT: How to Use Large Language Models While Reducing Cost and Improving Performance** — L. Chen, M. Zaharia, J. Zou — mag 2023 — https://arxiv.org/abs/2305.05176 — paper — Primaria
105. **Hybrid LLM: Cost-Efficient and Quality-Aware Query Routing** — D. Ding et al. (Microsoft) — apr 2024 (ICLR 2024) — https://arxiv.org/abs/2404.14618 — paper — Primaria
106. **RouteLLM: Learning to Route LLMs with Preference Data** — I. Ong et al. — giu 2024 (v4 feb 2025) — https://arxiv.org/abs/2406.18665 — paper — Primaria
107. **RouterBench: A Benchmark for Multi-LLM Routing System** — Q. J. Hu et al. — mar 2024 — https://arxiv.org/abs/2403.12031 — paper — Primaria
108. **Arch-Router: Aligning LLM Routing with Human Preferences** — C. Tran, S. Paracha, A. Hafeez, S. Chen (Katanemo) — giu 2025 — https://arxiv.org/abs/2506.16655 — paper (preprint) — Primaria (risultati degli autori)
109. **Jev Documentation — TypeSafe Decision Model on OpenRouter** — OpenRouter — consultata ott 2026 — https://openrouter.ai/docs/guides/community/jev — docs — Primaria
110. **Evaluating and Benchmarking the System One Model Jev** — T. Deußer, L. Sparrenberg, R. Sifa — 29 set 2026 — https://arxiv.org/abs/2609.37647 — paper (preprint) — Primaria (letto solo l'abstract)
111. **jev-bench: Jev vs Claude on structured decisions** — stern9 (GitHub) — risultati 24 set 2026 — https://github.com/stern9/jev-bench — repo — Secondaria (72 esempi, singola run)
112. **MeanCache: User-Centric Semantic Caching for LLM Web Services** — W. Gill et al. — mar 2024 — https://arxiv.org/abs/2403.02694 — paper — Primaria (letto tramite estratti)
113. **From Similarity to Vulnerability: Key Collision Attack on LLM Semantic Caching** — autori vari — gen 2026 — https://arxiv.org/abs/2601.23088 — paper (preprint) — Primaria (letto tramite estratti)
114. **Jev — homepage prodotto** — TypeSafe AI — consultata ott 2026 — https://typesafe.ai — sito vendor — Primaria (claim del vendor non verificati)
115. **LLMLingua-2: Data Distillation for Efficient and Faithful Task-Agnostic Prompt Compression** — Z. Pan et al. (Microsoft) — mar 2024 (ACL Findings 2024) — https://arxiv.org/abs/2403.12968 — paper — Primaria
116. **Do NOT Think That Much for 2+3=? On the Overthinking of o1-Like LLMs** — X. Chen et al. (Tencent AI Lab, SJTU) — dic 2024 (ICML 2025) — https://arxiv.org/abs/2412.21187 — paper — Primaria
117. **Effort (documentazione)** — Anthropic — Claude Platform docs — consultata ott 2026 — https://platform.claude.com/docs/en/build-with-claude/effort — docs — Primaria
118. **Small Language Models are the Future of Agentic AI** — P. Belcak et al. (NVIDIA Research) — giu 2025 (v3 set 2026) — https://arxiv.org/abs/2506.02153 — position paper — Opinione argomentata
119. **Claude Code — Manage costs (documentazione)** — Anthropic — consultata ott 2026 (verificata tramite estratti) — https://code.claude.com/docs/en/costs — docs — Primaria
120. **Mastra docs — Agents, Supervisor agents, Processors, Workflows (suspend/resume), MCP, Storage** — Mastra — consultata ott 2026 — https://mastra.ai/docs (pagine /agents/overview, /agents/supervisor-agents, /agents/processors, /workflows/suspend-and-resume, /mcp/overview, /memory/storage) — docs — Primaria
121. **Announcing Mastra 1.0!** — Mastra — 20 gen 2026 — https://mastra.ai/blog/announcing-mastra-1 — blog vendor — Primaria (dati di adozione del vendor)
122. **mastra-ai/mastra (README) e @mastra/core su npm** — Mastra — consultato ott 2026 — https://github.com/mastra-ai/mastra — repo — Primaria
123. **The 9 Best AI Agent Frameworks in 2026** — B. Perera — AgentMail — 8 lug 2026 — https://www.agentmail.to/blog/best-ai-agent-frameworks-2026 — blog terzi — Opinione (test su task giocattolo, autore con interessi dichiarati)
124. **LangGraph docs — Overview, Persistence, Interrupts, Memory, Streaming; LangChain create_agent** — LangChain — consultata ott 2026 — https://docs.langchain.com/oss/python/langgraph/overview — docs — Primaria
125. **LangChain and LangGraph 1.0** — LangChain — 22 ott 2025 — https://www.langchain.com/blog/langchain-langgraph-1dot0 — blog vendor — Primaria
126. **Google ADK docs — ADK 2.0, Agents, Session/State, Memory, Context compaction/caching, MCP tools; adk-python repo** — Google — consultata ott 2026 — https://adk.dev/ ; https://github.com/google/adk-python — docs/repo — Primaria
127. **Why we built ADK 2.0** — Google Developers Blog (Agarwal, Blount, Guan) — 1 lug 2026 — https://developers.googleblog.com/why-we-built-adk-20/ — blog vendor — Primaria (benchmark illustrativo)
128. **Claude Agent SDK docs — Overview, Agent loop, Sessions, Session storage, Permissions, Subagents, Custom tools** — Anthropic — consultata ott 2026 — https://code.claude.com/docs/en/agent-sdk/overview (e /agent-loop, /sessions, /permissions, /subagents, /custom-tools) — docs — Primaria
129. **CrewAI docs (Agents, Memory, Flows, MCP) e repo** — CrewAI — consultata ott 2026 — https://docs.crewai.com/ ; https://github.com/crewAIInc/crewAI — docs/repo — Primaria
130. **Pydantic AI v2 (blog) e docs (Agent, Storage)** — Pydantic (D. Maan) — 23 giu 2026 — https://pydantic.dev/articles/pydantic-ai-v2 ; https://pydantic.dev/docs/ai/core-concepts/agent/ — blog/docs — Primaria
131. **AI SDK 6 (22 dic 2025), AI SDK 7 (25 giu 2026) e docs Memory/MCP** — Vercel — 2025–2026 — https://vercel.com/blog/ai-sdk-7 ; https://ai-sdk.dev/docs/agents/memory — blog/docs — Primaria
132. **OpenClaw — README, Introducing OpenClaw, docs (Agent workspace, Memory, Builtin memory engine, Heartbeat, Security)** — OpenClaw Foundation (P. Steinberger) — 29 gen 2026 / consultata ott 2026 — https://github.com/openclaw/openclaw ; https://docs.openclaw.ai/concepts/agent-workspace — repo/docs — Primaria (conteggi malware ClawHub: Secondaria)
133. **GHSA-g8p2-7wf7-98mq / CVE-2026-25253** — GitHub Advisory Database — 31 gen 2026 — https://github.com/advisories/GHSA-g8p2-7wf7-98mq — advisory — Primaria
