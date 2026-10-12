# 10 — Muffin (muffin-project/muffin-agent): analisi e valutazione per Ernie

Analisi del 12 ottobre 2026 su una copia del repository (ultimo merge 1 ottobre 2026, 1 062 file, 662 sorgenti TypeScript, 331 documenti markdown). Il codice è stato letto, non eseguito.

## 1. Stato reale del progetto

- **Cos'è**: un agente personale «one owner, one agent» di Giusto Piedimonte, progetto italiano (molti commenti e documenti in italiano). Runtime residente su Node 22, CLI e Telegram come superfici (Discord in lavorazione, fuori dal percorso supportato), SQLite (`better-sqlite3` + `sqlite-vec`), SDK Anthropic e OpenAI, MCP, sandbox di Anthropic, lettura PDF con `unpdf`.
- **Maturità**: «source-public / pre-alpha», pubblico dal 25 settembre 2026; l'autore stesso scrive di non usarlo per lavoro reale. Il repository è però molto più maturo di Open Dots: ADR numerati (oltre 70), requisiti DAY-1 con evidenze, eval di sicurezza, di memoria e di carattere, CI.
- **Licenza**: **AGPL-3.0**. Ernie non ha una licenza pubblicata e non è AGPL: si possono adottare le **idee**, non copiare il codice.
- **Tesi**: la continuità della persona nel tempo (storia, lavoro non finito, punto di vista, autorità) deve sopravvivere a cambi di modello, dispositivo e superficie. Memoria, tool e messaggistica sono «baseline»; la scommessa è la qualità della continuità.

## 2. Come funziona davvero

**Cinque piani semantici** (ARCHITECTURE.md): *Evidence* (cosa è entrato o è successo, con fonte, autore e provenienza), *Beliefs* (cosa Muffin crede, ricostruibile e contraddicibile senza riscrivere le evidenze; un solo «scrittore» semantico), *Work* (turni, attese, todo, occorrenze pianificate: un turno è un'unità di lavoro durevole, non uno stack frame), *Effects* (intenzione scritta prima, esito dopo; dopo un crash «non iniziato», «completato» e «forse completato» restano distinti), *Authority* (un kernel di policy deterministico su fatti tipizzati: principal, capability, risorsa, taint, rischio, budget; il modello interpreta e propone, non si concede autorità).

**Sicurezza**: taint a livelli 0–3 (owner, confermato, terzi, web/tool); il contenuto non dell'owner è recintato con un nonce («marcare, non impedire»); i segreti viaggiano come riferimenti `secret://` risolti solo nel punto autorizzato e non entrano mai nel contesto del modello, nei log o in argv; file sigillati (`rot/`: policy, budget, allowlist di egress) che l'agente non può alzare da solo; egress del provider trattato come confine; registro di undo (copia prima di scrivere); eval di sicurezza con «scene» di prompt injection (lettura di un file ostile → tentativo di scrittura/egress) misurate dalle tracce reali delle decisioni del kernel.

**Memoria**: episodi, entità, identità e fatti con `trust_tier`, `speaker`, `valid_from` mai indovinato, `superseded_by`; recall ibrido (FTS + vettori, fusione RRF) più un solo salto sul grafo; ogni risultato porta provenienza e peso; un giudice delle contraddizioni «prima il ragionamento, poi il verdetto; in dubbio tengo entrambi e segnalo»; invarianti SQL notturne; un rilevatore di assenza (chi «è sparito» rispetto al proprio ritmo, con una coda Lomax invece della regola «media × 3»); `memory why` spiega da quale episodio viene un fatto.

**Lavoro e proattività**: todo con stati che sopravvivono al turno e vengono riletti in ogni contesto; attese persistite con scadenza obbligatoria (mai `sleep` nel processo); un *gate* della proattività: Muffin può parlare per primo solo per un insieme chiuso di segnali concreti (`commitment_due`, `deadline_near`, `fact_actionable`, `gone_quiet`), mai in ore di quiete, sotto budget, solo su evidenze dell'owner; un lock di invio in SQLite per non mandare due volte.

**Contesto e costi**: compattazione dei risultati dei tool (si tiene la chiamata, si sostituisce il payload con un segnaposto che dice come rileggerlo; mai la memoria richiamata, mai gli errori); rilevatore di ripetizioni nel prompt («eco»); tre tetti di spesa (mese, giorno per tenant, per job).

**Documenti**: i file sono la fonte, l'indice è derivato e ricostruibile; un documento entra intero e arriva al modello come **indice più lettura per intervalli** (`document_read`), mai come riassunto che lo sostituisce; i documenti sono indicizzati per il recall e **mai** estratti come fatti sull'owner.

**Ipotesi cognitive** (COGNITIVE-DESIGN.md), con stato di evidenza e criteri di abbandono: apprendere dall'errore di previsione (non testata), il silenzio come segnale (esperimento), importanza ≠ frequenza, dimenticare può aiutare, il tempismo fa parte dell'intelligenza, capire non dà autorità (impegno). L'autore rifiuta esplicitamente il «battito proattivo a cadenza» e il «sogno come architettura».

## 3. Confronto con Ernie

| Area | Ernie oggi | Muffin | Giudizio |
|---|---|---|---|
| Utenti | multi-utente con RLS (famiglia), app iOS nativa | un owner, CLI e Telegram | Ernie più avanti sulla superficie e sulla famiglia |
| Router e costi | Jev + comandi e skill deterministiche prima del modello; budget giornaliero | nessun router; tetti mese/giorno/job; compattazione del contesto | prefisso nostro troppo grande (20–40k token per turno): da compattare |
| Policy | deny→ask→allow + taint di sessione + approvazioni differite | kernel tipizzato, file sigillati, effetti per classe, undo | idee da prendere: registro effetti, scene di attacco |
| Memoria | FTS + HNSW con RRF, dedup e supersessione, consolidamento asincrono | fatti con tier/speaker/valid_from, giudice delle contraddizioni, «why», assenza | giudice e «perché lo sai» migliorano la fiducia |
| Lavoro | automazioni cron/once/webhook/event, promemoria, run con budget | todo e attese durevoli dentro il turno, intenzione→esito | da prendere per i compiti a più passi (M9) |
| Documenti | OCR sul telefono, prodotti da studio, schemi nativi, `document_get` a intervalli | vault con indice, lettura a intervalli, mai fatti dai documenti | allineati; da esplicitare la regola «mai fatti dai documenti» |
| Proattività | promemoria; heartbeat delle automazioni | gate con insieme chiuso, ore di quiete, budget, tier ≤ 1 | da adottare prima di qualunque messaggio «spontaneo» |
| Segreti | chiavi in `.env`, mai nel contesto | riferimenti `secret://` e resolver privilegiato | regola da scrivere in ARCHITECTURE §15 |

## 4. Cosa conviene fare

Idee da adottare, in ordine di valore per costo (codice nostro, nessuna copia AGPL):

- **A1 — Compattazione dei risultati dei tool nel contesto.** Tenere la chiamata, sostituire i payload vecchi con un segnaposto che nomina tool e argomenti; non toccare la memoria richiamata né gli errori. È l'intervento più misurato in letteratura (−48 % di picco) e il nostro problema più costoso oggi (19–40k token in ingresso per turno con tool). Costo: medio (agent-core, memoria di sessione Mastra).
- **A2 — «Cosa hai fatto oggi».** Abbiamo già `tool_calls` con verdetto e taint: una skill deterministica (e una scheda) che riassume per giornata le azioni per classe di effetto (letture, scritture, verso l'esterno) senza modello. Costo: basso.
- **A3 — Gate della proattività.** Prima di ogni messaggio spontaneo (futuri «scadenza vicina», «promemoria dell'altro», «ti sei dimenticato di…»): insieme chiuso di segnali, ore di quiete, tetto giornaliero, solo evidenze dell'utente, un invio alla volta. Costo: basso; va in M9 insieme all'auto-pausa delle automazioni.
- **A4 — «Perché lo sai?»** Tool `memory_why` e risposta deterministica che mostra episodio d'origine, data, catena di supersessione di un ricordo. Costo: medio.
- **A5 — Scene di attacco come test.** Documento o pagina con istruzioni nascoste → il modello (scriptato nel test) prova `web_fetch`/scrittura/promemoria → la policy deve negare o chiedere; si verifica dai record di `tool_calls`, non dal testo. Costo: medio; valore alto, perché il taint c'è ma non è mai stato provato da capo a fondo.
- **B1 — Giudice delle contraddizioni** nel consolidamento della memoria: ragionamento prima del verdetto, in dubbio tenere entrambi e segnalare, mai ritirare in silenzio. Costo: medio.
- **B2 — Lavoro durevole**: todo con stati e attese con scadenza per i compiti a più passi delle automazioni guidate. Costo: alto; da valutare quando serviranno compiti lunghi.
- **B3 — Intenzione prima dell'effetto**: riga di intento prima delle azioni con effetto esterno o scrittura, esito dopo, flag «rieseguibile» per tool; dopo un crash niente ripetizioni automatiche. Costo: medio.
- **B4 — Regola esplicita**: i documenti letti non diventano fatti sull'utente (oggi è così di fatto, va scritto e protetto da un test).

Da **non** adottare ora: file sigillati e Root of Trust (per un server di famiglia basta RLS + policy), topologia Home/Node, rilevatore di assenza (ipotesi ancora in esperimento; per la famiglia potrebbe risultare invadente), apprendimento dall'errore di previsione (non testato nemmeno da loro), SQLite (siamo su Postgres multi-utente), Telegram come superficie (l'app iOS resta il centro; se servirà un secondo canale per Giorgio, si valuta).

## 5. Conclusione

Muffin è il progetto più vicino a Ernie per intenzione (continuità personale, autorità esplicita, memoria con provenienza) e il più rigoroso fra quelli visti: la sua forza è la disciplina (ADR, evidenze, kill criteria), non una tecnica unica. Le quattro idee A1–A3 e A5 valgono la pena subito perché toccano i nostri punti deboli misurati: costo del contesto, sorveglianza delle azioni, messaggi spontanei che arriveranno con la famiglia, e sicurezza del taint mai verificata da capo a fondo. Il resto entra nel piano quando serviranno compiti lunghi.
