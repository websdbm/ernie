# Buone prassi operative per agenti AI in produzione (2023 → ottobre 2026)

**Ricerca bibliografica per la progettazione di "Ernie"**, agente personale persistente: TypeScript/Node con Mastra, Postgres+pgvector, Redis/BullMQ, router su OpenRouter, deploy Docker su VPS, client iOS SwiftUI con voce nativa Apple.

Data di redazione: 10 ottobre 2026. Gli ambiti trattati qui sono sette: sicurezza, skill e procedural memory, automazioni, osservabilità e costi, valutazione, voce, protocolli client-server. Agent loop, context engineering, architetture di memoria, tool design/MCP, routing dei modelli, ottimizzazione dei token e confronto tra framework sono coperti da un altro report e qui compaiono solo di passaggio.

**Come leggere le citazioni**
- Ogni affermazione rilevante rimanda tra parentesi quadre alla bibliografia numerata (§5).
- Affidabilità delle fonti:
  - **Primaria**: paper, spec, documentazione ufficiale, engineering blog del vendor sul proprio prodotto.
  - **Secondaria**: stampa, blog di terzi, riassunti.
  - **Opinione**: post di esperti senza dati, o mie sintesi, marcate come tali.
- I numeri sono riportati solo se compaiono nella fonte citata. Quando le fonti si contraddicono, le riporto entrambe.

---

## 1. Sommario esecutivo

<<SOMMARIO>>

---

## 2. Analisi per ambito

### 2.1 Sicurezza degli agenti

**Sintesi**

Nel 2025-2026 i tre principali vendor dicono in modo esplicito che la prompt injection non è risolta.
- Anthropic: "far from a solved problem" [15].
- OpenAI: "a frontier security challenge" destinata a evolvere per anni [22].
- Anthropic, sul layer modello: "will never be 100% effective" [17].

Le prove sperimentali vanno nella stessa direzione. Un lavoro firmato da ricercatori di OpenAI, Anthropic e Google DeepMind ha aggirato 12 difese pubblicate. Con attacchi adattivi il tasso di successo supera il 90% per la maggior parte di esse, e il red-teaming umano arriva al 100% [13][3].

Ne segue una prassi condivisa: dare per scontato che l'iniezione prima o poi riesca, e progettare in modo che il danno resti limitato.
- **Limiti deterministici sull'ambiente**: sandbox, egress, credenziali fuori dalla sandbox [16][17].
- **Vincoli architetturali sul flusso dei dati**: lethal trifecta e Rule of Two [1][4], design pattern dedicati [11][12].
- **Strumenti a privilegio minimo** con approvazione umana per le azioni irreversibili [7][21].
- **Difese probabilistiche** come strato aggiuntivo, non come confine: classificatori, spotlighting, training [14][15][20].

**Pattern e pratiche**

1. **Modello di minaccia: trifecta e Rule of Two.**
   - **Lethal trifecta** (Willison, giugno 2025): un agente diventa pericoloso quando combina accesso a dati privati, esposizione a contenuti non fidati e un canale di comunicazione verso l'esterno. Con tutti e tre, un'istruzione nascosta in una pagina o in un'email può far esfiltrare dati [1].
   - **"Agents Rule of Two"** di Meta (31 ottobre 2025) lo rende operativo. In una sessione l'agente non deve avere più di due di queste proprietà: [A] elabora input non fidati, [B] accede a sistemi sensibili o dati privati, [C] cambia stato o comunica all'esterno.
   - Se servono tutte e tre, niente autonomia: serve almeno una supervisione, per esempio human-in-the-loop, oppure una nuova sessione con contesto pulito [4].
   - Willison critica l'etichetta "lower risk" data a A+C, perché input non fidati più azioni con effetti possono comunque fare danni [3].

2. **Tassonomie OWASP.**
   - **Top 10 for LLM Applications 2025** (novembre 2024) [6]. Per un agente con tool contano soprattutto LLM01 Prompt Injection, LLM06 Excessive Agency e LLM10 Unbounded Consumption (consumo e costi fuori controllo).
   - **Top 10 for Agentic Applications 2026** (9 dicembre 2025) [5]:
     - ASI01 Agent Goal Hijack
     - ASI02 Tool Misuse
     - ASI03 Identity & Privilege Abuse
     - ASI04 Agentic Supply Chain
     - ASI05 Unexpected Code Execution
     - ASI06 Memory & Context Poisoning
     - ASI07 Insecure Inter-Agent Communication
     - ASI08 Cascading Failures
     - ASI09 Human-Agent Trust Exploitation
     - ASI10 Rogue Agents
   - I nomi ASI li ho letti in un riepilogo di terzi; la pagina OWASP rimanda al PDF.
   - L'**OWASP AI Agent Security Cheat Sheet** [7] è la checklist operativa più completa che ho trovato. Raccomanda:
     - autorizzazione applicata nel componente che esegue, fuori dal contesto dell'agente, con fail-closed per tool sconosciuti;
     - approvazione legata all'azione esatta, ai parametri, all'attore e a una scadenza, e consumata atomicamente perché non si possa riusare;
     - step-up authentication per pagamenti, cambi di privilegio e cancellazioni massive;
     - limiti su profondità delle catene, retry, token e costo, contro il "Denial of Wallet".

3. **Iniezione indiretta tramite risultati dei tool.**
   - Il vettore è stato descritto da Greshake et al. nel 2023: istruzioni nascoste in dati che l'applicazione recupera [9].
   - EchoLeak (CVE-2025-32711, giugno 2025) ne è la versione zero-click su Microsoft 365 Copilot, partita da una semplice email [36].
   - Le contromisure architetturali più solide sono sei design pattern (Beurer-Kellner et al., giugno 2025) [12][3]: Action-Selector, Plan-Then-Execute, LLM Map-Reduce, Dual LLM, Code-Then-Execute, Context-Minimization. Il principio comune: dopo che l'agente ha letto input non fidato, quell'input non deve poter innescare azioni con conseguenze.
   - **CaMeL** (Google DeepMind) estrae i flussi di controllo e di dati dalla sola richiesta dell'utente, fidata, e applica policy di capability quando vengono chiamati i tool. Su AgentDojo risolve il 77% dei task con sicurezza dimostrabile, contro l'84% del sistema senza difese [11]. AgentDojo comprende 97 task e 629 casi di sicurezza [10].
   - Il **Dual LLM pattern** del 2023 [2] è l'antenato di CaMeL; lo stesso autore lo giudica fragile.

4. **Difese probabilistiche a strati.**
   - **Spotlighting** (delimiting, datamarking, encoding) segnala al modello da dove proviene un input. Negli esperimenti degli autori il tasso di successo degli attacchi scende da oltre il 50% a meno del 2% [14]. Il dato è di laboratorio.
   - **Google** (giugno 2025) [20] usa: classificatori di injection, "security thought reinforcement", sanitizzazione del markdown con redazione degli URL sospetti (blocca le immagini esterne, un canale classico di esfiltrazione), un framework di conferma per le azioni rischiose e notifiche all'utente.
   - **Microsoft** (SFI, aggiornato a marzo 2026) [21] elenca: Prompt Shields, spotlighting, plan drift detection, critic agents, analisi delle catene di tool, information flow control, privilegi minimi e di breve durata, human-in-the-loop come "ultima linea di difesa". Raccomanda di assumere che alcuni attacchi riusciranno.
   - **Anthropic** (novembre 2025) [15] combina RL sulle iniezioni, classificatori su tutto il contenuto non fidato e red teaming. Riporta un attack success rate dell'1% contro un attaccante adattivo con 100 tentativi per ambiente, e lo considera ancora un rischio significativo.

5. **Modelli di permesso (allow/ask/deny) e approvazioni.**
   - **Claude Code** valuta le regole in ordine deny → ask → allow, e la prima corrispondenza decide. Una regola Bash si applica al testo del comando, non al programma, quindi "non è un confine di sicurezza": va affiancata alla sandbox [23].
   - **Claude Agent SDK** formalizza l'intera catena: hooks → deny → ask → modalità → allow → callback `canUseTool`. Avvertenza: un tool già approvato da una regola o da una modalità non raggiunge mai il callback, quindi i controlli messi lì vengono saltati senza segnalazione [24].
   - **Mastra** (il framework di Ernie) prevede:
     - `requireApproval` per singolo tool, oppure `requireToolApproval` su tutta la richiesta;
     - un chunk `tool-call-approval` nello stream, con `approveToolCall`/`declineToolCall`;
     - lo stato della run sospesa salvato in storage; senza storage si ottiene "snapshot not found" [26].
   - **Approval fatigue.** Gli utenti approvano circa il 93% dei prompt di permesso, cioè l'approvazione per singola azione garantisce poca revisione reale [17][18]. Con la sandbox OS i prompt sono calati dell'84% nell'uso interno di Anthropic [16].

6. **Sandboxing del codice generato.**
   - **`node:vm`** "is not a security mechanism. Do not use it to run untrusted code" [28].
   - **`isolated-vm`** usa isolate V8 separati. Ad agosto 2026 ha avuto una falla di escape sandbox→host nel binding C++ (GHSA-864f-rcv7-6rh4, corretta in 6.2.0/7.0.1). La libreria risulta usata, direttamente o come opzione, anche da Mastra, n8n e Activepieces [29].
   - **Deno** nega I/O per default, con permessi granulari. La doc avverte che `--allow-run` e `--allow-ffi` equivalgono di fatto ad `--allow-all` e suggerisce di aggiungere una sandbox a livello OS o una microVM [30].
   - **gVisor** è un kernel applicativo in userspace che intercetta le syscall. Il prezzo è un overhead sulle syscall e una compatibilità incompleta [31].
   - **Firecracker** crea microVM KVM: boot sotto 125 ms, meno di 5 MiB di overhead, 5 dispositivi emulati, un "jailer" come seconda linea di difesa [32].
   - **Le scelte di Anthropic** (maggio 2026) [17]:
     - container gVisor effimeri per l'esecuzione di codice su claude.ai;
     - Seatbelt/bubblewrap per Claude Code;
     - VM per Cowork, con le credenziali nel keychain dell'host.
   - **Lezioni da quelle scelte** [16][17]:
     - Servono insieme l'isolamento del filesystem e quello della rete, perché senza il secondo si esfiltrano le chiavi SSH.
     - Un dominio in allowlist è una concessione di capability: l'API di Anthropic in allowlist è stata usata per caricare file su un account dell'attaccante.
     - Hypervisor e runtime maturi hanno retto; i difetti stavano nel proxy e nel codice custom.
   - **Hermes Agent** applica i controlli sui comandi pericolosi solo sul backend locale e li salta nei container, dove il confine è il container stesso. L'hardening Docker prevede capability droppate, `no-new-privileges`, limite di processi e tmpfs noexec [34].

7. **Separazione dei dati tra utenti.**
   - **Postgres RLS** [33]:
     - con RLS attiva e nessuna policy applicabile, nessuna riga è visibile (default deny);
     - il proprietario della tabella la bypassa, a meno di `FORCE ROW LEVEL SECURITY`;
     - superuser e ruoli `BYPASSRLS` la bypassano sempre;
     - i vincoli di integrità referenziale possono creare canali coperti.
   - **OWASP** chiede di isolare la memoria tra utenti e sessioni e di validare i dati prima di memorizzarli [7]. Il rischio corrispondente è ASI06 Memory & Context Poisoning [5].
   - La **spec MCP** vieta di trattare il possesso di un handle di stato come autenticazione. Gli handle vanno legati lato server all'utente ricavato dal token verificato [25].

8. **Gestione dei segreti.**
   - **OWASP** [8]: store centralizzato, credenziali di breve durata, rotazione, niente segreti in `ENV`/`ARG` Docker o nelle immagini. Le variabili d'ambiente sono visibili ai processi e finiscono nei dump.
   - **Anthropic** [16] tiene le credenziali fuori dalla sandbox: un proxy verifica la richiesta e solo dopo vi allega il token reale.
   - **Hermes** [34] toglie le variabili sensibili ai processi figli sandboxati.
   - **MCP** vieta il token passthrough (token non emessi per quel server) e raccomanda scope minimi e incrementali [25].

9. **Audit log e rate limiting.**
   - **OWASP** [7] chiede log strutturati di decisioni, chiamate ai tool, esiti di autorizzazione, ID di approvazione e versioni delle policy, con i campi sensibili redatti. Aggiunge soglie di anomalia, come tool call al minuto o costo per sessione.
   - **Mastra `TokenCostControl`** [27] limita la spesa per run, thread, risorsa o utente su finestre temporali. Due avvertenze della doc: i limiti sono "approximate", perché le metriche vengono scritte in modo asincrono, e il controllo **fail-open** se manca l'ID di contesto o la query fallisce.

10. **Incidenti su agenti personali.**
    - **OpenClaw**, CVE-2026-25253 (CVSS 8.8): prima della versione 2026.1.29 il client leggeva `gatewayUrl` dalla query string e apriva automaticamente una WebSocket inviando il token [35]. È una lezione diretta per il protocollo client-server di Ernie (§2.7).
    - Sullo stesso ecosistema la stampa riporta decine di migliaia di istanze esposte su internet e skill malevole nel registry. Le cifre sono secondarie e discordanti, quindi non le riporto.

**Controversie e trade-off**
- **Guardrail probabilistici.** Le percentuali dei vendor (ASR 1% [15], spotlighting <2% [14]) contrastano con gli attacchi adattivi (>90% di bypass [13]). Willison considera un "95%" di attacchi bloccati un voto insufficiente in sicurezza applicativa [1]. Microsoft e Anthropic concordano che servono strati deterministici [17][21].
- **Human-in-the-loop o classificatore.**
  - La auto mode di Claude Code, con un classificatore al posto dell'utente, dichiara su traffico reale un FPR dello 0,4% (n=10.000) e un FNR del 17% su azioni "overeager" (n=52). Sull'esfiltrazione sintetica l'FNR è del 5,7% (n=1.000). Anthropic avverte che non sostituisce la revisione umana sulle infrastrutture critiche [18].
  - Uno stress test indipendente su scenari ambigui misura invece un FNR end-to-end dell'81%, anche perché il 36,8% delle azioni che cambiano stato passa per edit di file, che il classificatore non valuta [19].
  - I carichi di lavoro sono diversi: i due numeri non sono confrontabili, ma vanno letti insieme.
- **Livello di isolamento.**
  - Isolate V8 (isolated-vm): leggero, ma ha appena avuto un escape [29].
  - Container standard: condivide il kernel con l'host.
  - gVisor: più costoso sulle syscall [31].
  - MicroVM: il più forte, con più costi operativi [32].

**Implicazioni pratiche per Ernie**
- **Classificare ogni tool sulle tre gambe della trifecta**: legge dati privati, ingerisce contenuto non fidato (web, email, file, risultati MCP), cambia stato o comunica fuori. Un policy engine deterministico, esterno all'LLM, applica la Rule of Two per run. Se una run le combina tutte e tre, le azioni di tipo [C] passano in "ask" con approvazione sull'iPhone [4][7].
- **Policy engine deny → ask → allow, fail-closed** [7][23][24].
  - Ogni approvazione è firmata su (tool, hash degli argomenti, utente, scadenza), è monouso e viene registrata in una tabella di audit append-only.
  - Il client iOS mostra un'anteprima dell'azione.
  - I controlli non vanno messi in un callback che una regola allow può scavalcare [24].
- **Contenuto esterno sempre marcato come dato non fidato** (datamarking) e Plan-Then-Execute per le automazioni [12][14].
  - Il client iOS non deve mai renderizzare immagini markdown da URL esterni [20].
  - Proxy di egress con allowlist per dominio, trattata come elenco di capability [17].
- **Codice generato e script delle skill mai nel processo Node**, né con `vm` né con `isolated-vm` come unica barriera [28][29].
  - Vanno in un container dedicato, possibilmente con runtime gVisor (`runsc`).
  - Niente rete per default e nessun segreto montato.
  - Limiti di CPU, memoria e tempo [17][31][34].
- **Dati e segreti.**
  - RLS su `user_id` con `FORCE`; ruolo applicativo senza `BYPASSRLS` e diverso dall'owner delle tabelle [33].
  - Chiavi Redis e BullMQ con namespace per utente.
  - Segreti come file (Docker secrets) e non come variabili d'ambiente [8].
  - Token OAuth per integrazione con scope minimi, mai inseriti nel contesto del modello [25].
- **Budget di costo per utente e per run come limite rigido.** Se si usa `TokenCostControl` di Mastra, va affiancato da un limite nel router, perché il controllo è approssimato e fail-open [27].

### 2.2 Skill auto-apprese e procedural memory

**Sintesi**

L'idea di una "skill library" di procedure riusabili viene da Voyager (2023). Voyager accumulava programmi eseguibili verificati tramite feedback dell'ambiente, errori di esecuzione e auto-verifica, e otteneva 3,3× oggetti unici e progressi nel tech tree fino a 15,3× più rapidi rispetto allo stato dell'arte precedente [37].

Nel 2025-2026 l'idea si è consolidata in un formato aperto.
- Anthropic ha introdotto le **Agent Skills** (16 ottobre 2025) e le ha pubblicate come standard aperto il 18 dicembre 2025 [38].
- Lo standard **agentskills.io** è oggi supportato da molti client [39]: Claude/Claude Code, ChatGPT e Codex, Gemini CLI, GitHub Copilot, VS Code, Cursor, Hermes Agent, OpenClaw, Letta, Goose e altri.
- **Mastra** supporta lo standard in modo nativo dalle workspace skills (`@mastra/core` 1.1.0), con i tool `skill`, `skill_read` e `skill_search` [44].

Il fronte nuovo sono le **skill create dall'agente stesso**. Hermes lo fa già [43], e Anthropic dichiara di volerlo permettere [38]. Le prove disponibili ne mostrano i benefici [48], ma anche le regressioni [49] e i rischi di sicurezza: skill vulnerabili o malevole nei marketplace [45][46], e procedure non sicure che restano nella libreria e ritornano in sessioni successive [47].

**Pattern e pratiche**

1. **Formato SKILL.md** [39][40].
   - Una cartella con `SKILL.md`: frontmatter YAML con `name` (max 64 caratteri, minuscole, cifre e trattini, uguale al nome della cartella) e `description` (max 1024 caratteri, cosa fa e quando usarla).
   - Campi opzionali: `license`, `compatibility`, `metadata`, `allowed-tools` (sperimentale).
   - Cartelle opzionali: `scripts/`, `references/`, `assets/`.
   - Si valida con `skills-ref validate`.
   - Anthropic aggiunge: `name` non può contenere "anthropic" o "claude"; descrizione in terza persona; riferimenti a un solo livello di profondità [40].

2. **Progressive disclosure** su tre livelli [38][39]:
   - **metadati**, circa 100 token per skill, caricati all'avvio;
   - **corpo del SKILL.md**, raccomandato sotto i 5.000 token e le 500 righe, caricato all'attivazione;
   - **risorse**, lette o eseguite solo se servono.

   Gli script vengono eseguiti senza caricare il loro sorgente nel contesto: nel contesto entra solo l'output [40]. In Hermes il livello 1 (elenco di nomi e descrizioni) occupa circa 3k token [43].

3. **Creazione automatica (Hermes)** [43].
   - L'agente usa il tool `skill_manage` (create/patch/edit/delete). È sollecitato a salvare i workflow non banali, gli approcci che hanno funzionato dopo un errore e le correzioni dell'utente. Una revisione in background a fine sessione può proporre modifiche.
   - Un **write-approval gate** (`skills.write_approval`) mette le modifiche in staging in `~/.hermes/pending/skills/`, con i comandi `/skills diff|approve|reject`. Il default è `false`, cioè l'agente scrive liberamente.
   - Le installazioni dall'hub passano da uno scanner (esfiltrazione, injection, comandi distruttivi, supply chain) con livelli di fiducia. Le skill di progetto vengono caricate solo dopo aver dato fiducia al progetto.
   - Fonti terze parlano di una soglia fissa (per esempio "5+ tool call") per la creazione automatica; nella doc ufficiale non l'ho trovata.

4. **Validazione evaluation-driven** [40][42].
   - Anthropic raccomanda di scrivere le valutazioni prima delle istruzioni: misurare il modello senza la skill, costruire almeno tre scenari, scrivere il minimo indispensabile, iterare confrontando con la baseline, provare con tutti i modelli previsti [40].
   - Lo **skill-creator** aggiornato (marzo 2026) introduce eval, benchmark su pass rate, tempo e token tra versioni, ed esecuzioni parallele in contesti isolati. Distingue skill di "capability uplift", che i modelli futuri potrebbero rendere superflue, da skill di "encoded preference" [42].

5. **Misurare anche le regressioni.**
   - "The Regression Tax" (luglio 2026, circa 6.000 run): le skill migliori vincono soprattutto perché regrediscono meno, non perché guadagnano di più [49].
   - Individua tre cause di regressione:
     - la sola descrizione in contesto cambia il comportamento anche se la skill non viene invocata ("description osmosis");
     - la procedura scavalca l'interpretazione degli input;
     - la procedura sopprime le verifiche che l'agente avrebbe fatto.
   - Il benchmark AFTER (382 task enterprise) trova che un solo ciclo di raffinamento migliora di 3,7-6,7 punti. Le skill ricavate da tracce di più modelli raggiungono il 73,1% di accuratezza cross-model, meglio di qualsiasi fonte a modello singolo [48].

6. **Versionamento.**
   - L'API Skills di Anthropic usa versioni immutabili (`skver_…`). Ogni versione è uno snapshot completo, non un delta. `"latest"` punta all'ultima versione, oppure si può fissare una versione specifica [41].

7. **Rischi di sicurezza.**
   - Il 26,1% di 31.132 skill pubbliche presenta almeno un pattern vulnerabile, guidato da esfiltrazione (13,3%) e privilege escalation (11,8%). Il 5,2% ha pattern ad alta severità. Le skill con script hanno 2,12× più probabilità di essere vulnerabili. Gli autori chiedono permessi basati su capability e vetting obbligatorio [45].
   - Snyk ha analizzato 3.984 skill: il 13,4% ha problemi critici, il 36,82% almeno un problema, 76 payload malevoli sono confermati [46]. Il titolo di una ricerca web attribuiva il 36% alla sola prompt injection; la fonte primaria lo smentisce.
   - **Skill misevolution** (agosto-ottobre 2026) [47]:
     - in 21 combinazioni di agente e metodo di evoluzione, tutte hanno scritto skill non sicure;
     - in 15 casi il danno si è trasferito alla sessione successiva;
     - "SafeEvolve" controlla le skill alla scrittura e al recupero, e porta il recupero di skill non sicure dal 35,3% all'8,7%, con un'utilità che varia di non più di 0,4 punti.
   - Anthropic consiglia di usare solo skill da fonti fidate e di controllarne script, dipendenze e connessioni di rete [38].

8. **Agenti che modificano se stessi.**
   - La Darwin Gödel Machine modifica il proprio codice: su SWE-bench passa dal 20,0% al 50,0%. Gli esperimenti sono stati condotti in sandbox e con supervisione umana [50]. È la misura minima per qualsiasi agente che riscrive le proprie procedure.

**Controversie e trade-off**
- **Autonomia o controllo.** Hermes ha la scrittura libera come default [43]. La ricerca sulla misevolution mostra che anche le skill "utili" possono veicolare danni [47].
- **Guadagno medio o regressioni.** Le metriche aggregate nascondono le regressioni [49]. Il valore delle skill di "uplift" può calare quando cambia il modello [42].
- **`allowed-tools`** è sperimentale e dichiarato dalla skill stessa [39]. Va trattato come una richiesta di permesso, non come un'autorizzazione.

**Implicazioni pratiche per Ernie**
- Adottare il formato agentskills.io, compatibile con le workspace skills di Mastra [39][44]. Ogni skill passa per gli stati `draft → proposed → tested → approved → active → deprecated`, con versioni immutabili identificate da un hash del contenuto [41]. Il router richiama sempre una versione fissata.
- **Trigger di proposta** come in Hermes (correzione dell'utente, recupero da errore, task lungo), ma la scrittura arriva solo a `proposed` [43]. L'approvazione avviene dall'iPhone con il diff. Nessuna skill con script va in `active` senza approvazione esplicita.
- **Test isolato prima dell'approvazione**: suite di eval con e senza la skill, eseguita in sandbox. Si contano separatamente guadagni e regressioni su un golden set personale, e la suite si ripete a ogni cambio di modello nel router [40][42][49].
- **Due classi di rischio**:
  - instruction-only: revisione leggera;
  - con codice: sandbox obbligatoria, niente rete e niente segreti salvo permessi dichiarati e approvati [45].
- **Scansione alla scrittura e al recupero** (approccio SafeEvolve) [47]. Una skill importata da terzi entra solo dopo revisione e con l'hash fissato [38][46].

### 2.3 Automazioni e scheduling

**Sintesi**

Ogni piattaforma di riferimento ha ormai esecuzioni programmate di agenti: Hermes cron [51], Claude Code routines [52], Claude Managed Agents scheduled deployments [53], ChatGPT Tasks [54], Gemini scheduled actions [55]. Le scelte di progetto convergono:
- ogni run parte in una **sessione nuova e isolata** con un prompt autosufficiente;
- uno **storico delle run** separato dalle conversazioni;
- **anti-ricorsione**: una run programmata non può creare altre automazioni;
- **budget per run**;
- **jitter** sugli orari;
- **nessun backfill** quando si riprende un'automazione in pausa;
- i payload che arrivano dai trigger esterni sono trattati come dati non fidati.

Sul piano infrastrutturale valgono le regole classiche dei job durevoli: idempotenza, retry con backoff esponenziale e jitter solo per gli errori transitori, una coda dei falliti come dead-letter, e una garanzia "exactly-once" che non esiste senza effetti collaterali idempotenti [56][57][59][60].

**Pattern ed evidenze**

1. **Hermes Agent** [51].
   - **Formati e ciclo**: ritardo singolo, intervallo, cron, ISO. Il gateway controlla ogni 60 s e lancia ogni job in una sessione nuova.
   - **Anti-ricorsione**: le sessioni lanciate da cron non possono gestire altri cron, salvo `cron.allow_agent_scheduling`. Un file lock evita le doppie esecuzioni.
   - **Modalità `no_agent`**: esegue uno script senza alcuna chiamata LLM, utile per i watchdog.
   - **Retry**: per i guasti di rete transitori prima della chiamata al modello, dopo 5, 15 e 30 minuti.
   - **Alert**: deduplicati per firma, con un promemoria dopo un cooldown (default 6 h) e un avviso dopo 3 fallimenti consecutivi.
   - **Storico**: in `executions.db`, con stati claimed/running/completed/failed/unknown. I fallimenti di consegna sono registrati separatamente da quelli di esecuzione, e il marker `[SILENT]` sopprime la consegna.

2. **Claude Code routines** (research preview) [52].
   - Trigger: schedule (intervallo minimo 1 h, oppure one-off), API (POST con bearer token per singola routine) e GitHub.
   - Le run sono autonome, senza prompt di permesso. La doc chiede quindi di restringere connettori, rete e repository: tutti i connettori sono inclusi per default, ed è compito dell'utente rimuovere quelli che non servono.
   - Il testo inviato via API arriva avvolto in `<routine-fire-payload>`, etichettato come non fidato. Il prompt salvato "non può valere come approvazione o consenso".
   - Uno stato verde significa solo che non ci sono stati errori infrastrutturali, non che il compito sia riuscito.
   - Limiti orari: 100 run programmate all'ora per account, 30 all'ora per routine tra "Run now" e API. Gli eventi GitHub oltre la soglia vengono scartati.
   - Le run programmate esattamente allo scoccare dell'ora possono partire con minuti di ritardo.

3. **Claude Managed Agents** (beta) [53].
   - Cron POSIX più timezone IANA, granularità al minuto.
   - Jitter fino al 15% dell'intervallo, con un minimo di 5 s e un massimo di 9 min.
   - Massimo 1.000 deployment per organizzazione.
   - **Budget per run** (`max_list_cost`): copiato su ogni sessione, non cumulativo.
   - Ogni tentativo genera un **deployment run record** con il tipo di errore (per esempio `session_rate_limited_error`, che non viene ritentato). Gli errori non recuperabili mettono il deployment in pausa automatica.
   - La ripresa avviene senza backfill. I webhook coprono il ciclo di vita.
   - **Ora legale**: gli orari inesistenti non vengono eseguiti, quelli doppi vengono eseguiti due volte. La doc consiglia di evitare la fascia 1-3 o di usare UTC.

4. **Prodotti consumer** [54][55].
   - **ChatGPT Tasks**: limite di task attivi per piano, trigger su evento (Gmail, Slack, GitHub), non disponibili nelle chat vocali.
   - **Gemini**: fino a 10 azioni attive, eseguite "entro un'ora" dall'orario scelto.
   - Questi dettagli vengono da estratti di pagine d'aiuto e dalla stampa.

5. **Mastra** [61].
   - Il campo `schedule` su `createWorkflow` usa uno scheduler integrato a polling, adatto a un processo di lunga durata come un container su VPS, e richiede `mastra.startWorkers()`.
   - L'engine "evented" richiede un adapter con aggiornamenti concorrenti atomici, come `@mastra/pg`.
   - Ogni esecuzione scrive righe di trigger con ID della run, orario previsto e orario effettivo.
   - Nessun backfill alla ripresa, e nessun supporto serverless.
   - Le schedule degli agenti (core ≥1.50.0) possono essere threaded o threadless.

6. **BullMQ**, già nello stack di Ernie [56].
   - `upsertJobScheduler` è idempotente sull'ID.
   - Per ogni scheduler esiste un solo job "delayed" alla volta, e il successivo viene generato solo quando il corrente parte: con la coda satura le esecuzioni si diradano.
   - `attempts` con backoff fisso o esponenziale e jitter; un backoff custom che restituisce -1 manda il job direttamente tra i falliti.
   - Esauriti i tentativi, il job finisce nel set dei falliti, che fa da dead-letter.
   - Deduplicazione in tre modalità: simple, throttle (ttl), debounce.
   - Pattern "idempotent jobs": job atomici e piccoli, scomposti in flows.

7. **Temporal e Inngest** [57][58].
   - **Temporal**, retry di default sulle activity: intervallo iniziale 1 s, coefficiente 2, massimo 100 s, tentativi illimitati. Le activity devono essere idempotenti; i workflow non vengono ritentati per default.
   - **Inngest**: step memoizzati, che non rieseguono le chiamate LLM già completate dopo un crash; ID dell'evento come chiave di idempotenza per 24 h; differenze tra concurrency, throttle (ritarda), rate limit (scarta) e debounce.

8. **Retry e idempotenza in generale** [59][60].
   - I retry su più livelli si moltiplicano: 3 retry su 5 livelli danno un carico 243× sul database. Conviene ritentare in un solo punto, con backoff esponenziale e jitter, solo sulle operazioni idempotenti, e con un token bucket.
   - Stripe: chiave di idempotenza (UUID v4) che restituisce la risposta salvata, con conservazione di almeno 24 h ed errore se i parametri non coincidono.

9. **Notifiche iOS** [62].
   - Le push in background hanno bassa priorità e consegna non garantita; Apple consiglia "non più di due o tre all'ora".
   - L'app ha 30 s di esecuzione.
   - I risultati delle automazioni vanno quindi letti dal server quando l'app torna in primo piano, con push visibili per gli esiti importanti.

**Controversie e trade-off**
- **BullMQ con Postgres, oppure durable execution (Temporal, Inngest).** La durable execution evita di rieseguire le chiamate LLM già completate [58], ma aggiunge un sistema da gestire. Mastra stesso indica Temporal per i processi lunghi e distribuiti [61].
- **Autonomia delle run programmate.** Le routine girano senza permessi [52]. Per un agente personale con accesso a email e pagamenti significa scegliere tra negare le azioni "ask" durante le run e accodarle in attesa di approvazione.
- **Backfill.** Tutte le piattaforme analizzate lo escludono [51][53][61]; per alcuni promemoria personali potrebbe invece servire.

**Implicazioni pratiche per Ernie**
- **Due tabelle Postgres.**
  - `automations`: trigger (cron+tz, one-shot, webhook, evento), prompt autosufficiente, **allowlist dei tool**, budget per run (costo, token, durata), policy di notifica.
  - `automation_runs`: stati `scheduled/claimed/running/succeeded/failed/skipped/budget_exceeded/awaiting_approval`, separati dalle conversazioni, con un esito strutturato prodotto dall'agente e distinto dal successo infrastrutturale [52][53].
- **Scheduling su BullMQ.**
  - `upsertJobScheduler` per ogni automazione, e jobId deterministico `automation_id:scheduled_at` come chiave di idempotenza [56][60].
  - Retry con backoff esponenziale e jitter solo per gli errori transitori (rete, 429, 5xx del provider) e in un solo livello. Il set dei falliti fa da dead-letter, con un alert deduplicato [51][59].
- **Anti-ricorsione e payload**: le run programmate non creano né modificano automazioni [51]. I payload di webhook ed eventi sono avvolti come dati non fidati [52].
- **Azioni sensibili durante una run**: si accodano come `awaiting_approval` con notifica visibile, invece di essere eseguite [7][52].
- **Calendario**: timezone IANA, niente cron nella fascia 1-3 locale, jitter, nessun backfill per default [53][59]. Lo storico delle run si legge dall'app all'apertura, senza affidarsi alle push silenziose [62].

<<SEZIONE_OSSERVABILITA>>

<<SEZIONE_VALUTAZIONE>>

<<SEZIONE_VOCE>>

### 2.7 Protocolli client-server per agenti

**Sintesi**

Nel 2025-2026 sono emerse due famiglie di soluzioni per riprendere uno stream interrotto:
- **replay da cursore**: la run continua sul server e il client si ricollega da un punto preciso.
  - OpenAI Responses: `sequence_number` e `starting_after` [67].
  - LangGraph: SSE `id` e `Last-Event-ID` [75].
  - Mastra DurableAgent: `offset` [66].
  - Vercel: `resumable-stream` su Redis [64][65].
- **snapshot più nuova sottoscrizione**, senza garanzia di replay.
  - A2A: il primo evento di `SubscribeToTask` è uno snapshot del Task [69].
  - AG-UI: `MESSAGES_SNAPSHOT`/`STATE_SNAPSHOT` [63].
  - MCP 2026-07-28: ha eliminato la ripresa via `Last-Event-ID`, e la richiesta va rifatta [74].

In quasi tutte le soluzioni la vita della run è **separata dalla connessione HTTP**, e la disconnessione non equivale alla cancellazione [64][67][75]. Fa eccezione MCP 2026, dove chiudere lo stream significa cancellare la richiesta [74].

Gli **involucri degli eventi** non sono uniformi.
- AG-UI 1.0 (settembre 2026) non ha ID né numero di sequenza in `BaseEvent` [63].
- CloudEvents impone `id`+`source` univoci e ha un'estensione di correlation/causation [72].
- La bozza IETF Idempotency-Key è scaduta senza diventare RFC [73].

**Pattern e dettagli verificati**

1. **AG-UI** (CopilotKit; `@ag-ui/core` 1.0.0 del 17 settembre 2026) [63].
   - **Eventi**:
     - ciclo della run: `RUN_STARTED/FINISHED/ERROR`;
     - testo: `TEXT_MESSAGE_START/CONTENT/END`;
     - tool: `TOOL_CALL_START/ARGS/END/RESULT`;
     - stato: `STATE_SNAPSHOT`, `STATE_DELTA` (JSON Patch);
     - altri: `MESSAGES_SNAPSHOT`, `REASONING_*`, `CUSTOM`.
   - **Human-in-the-loop**: `RUN_FINISHED` con `outcome: interrupt`, poi una nuova run sullo stesso `threadId` con `resume[]`.
   - **Trasporto**: SSE via POST, cancellazione con `abortRun()`.
   - **Integrazioni**: Mastra è tra quelle supportate.
   - **Swift**: non esiste un SDK ufficiale; la PR che lo aggiunge è ancora aperta.

2. **Vercel AI SDK UI Message Stream** (ai@7) [64][65].
   - **Formato**: SSE con l'header `x-vercel-ai-ui-message-stream: v1`.
   - **Parti**: `start`, `text-start/delta/end`, `reasoning-*`, `tool-input-*`, `tool-approval-request`, `tool-output-available`, `data-*` (le parti "transient" non vengono salvate), `finish`, `abort`.
   - **Ripresa**: i resumable stream usano Redis, e il client tratta il riavvio come un replay completo.
   - **Stop**: `stop()` è una disconnessione. Per cancellare serve un endpoint dedicato.
   - **Persistenza**: si salvano gli `UIMessage` con ID generati dal server.

3. **Mastra streaming** [66].
   - Ogni chunk ha `type`, `runId`, `from` e `payload`: `text-delta`, `tool-call`, `tool-result`, `step-start/finish`, `finish`, `abort`, più gli eventi dei workflow e dei background task.
   - Esiste una compatibilità AI SDK (v5 per default) tramite `@mastra/ai-sdk`.
   - **DurableAgent**:
     - `observe(runId, {offset})` riprende lo stream; l'offset è inclusivo e parte da zero.
     - La cache di default è in memoria e vale solo dentro un processo; tra processi servono `RedisServerCache` e `RedisStreamsPubSub`.
     - Per un abort che fermi davvero la run serve `@mastra/core` ≥1.62.0.

4. **OpenAI** [67][68].
   - **Responses**:
     - ogni evento ha `sequence_number`;
     - background mode con ripresa via `?stream=true&starting_after=N`;
     - `/cancel` idempotente;
     - WebSocket mode con connessioni fino a 60 minuti.
   - **Realtime**:
     - `event_id` generato dal client, e gli errori riportano l'`event_id` dell'evento che li ha causati;
     - `response.cancel` e `conversation.item.truncate` per l'audio non ascoltato;
     - per i client mobili OpenAI raccomanda WebRTC, e WebSocket da server a server.

5. **A2A** (v1.0, 12 marzo 2026; Linux Foundation da giugno 2025) [69].
   - Binding JSON-RPC, gRPC e REST, con streaming SSE.
   - La spec dichiara che gli eventi "MUST NOT be reordered", ma non sono un canale di consegna affidabile.
   - Deduplicazione via `messageId` (MAY); le push notification vanno elaborate in modo idempotente.
   - A2A serve tra agenti ed è complementare a MCP. Per il client di Ernie non è necessario.

6. **SSE e iOS** [70][71].
   - **SSE**:
     - `id:` imposta l'ultimo ID evento, e alla riconnessione il browser invia l'header `Last-Event-ID`;
     - `retry:` imposta il tempo di riconnessione;
     - una risposta HTTP 204 ferma i tentativi;
     - un commento ogni 15 s circa tiene viva la connessione attraverso i proxy;
     - con nginx va inviato `X-Accel-Buffering: no` [74].
   - **iOS**:
     - Apple sospende l'app "poco dopo" il passaggio in background, e il sistema può reclamare i socket;
     - per il nuovo codice WebSocket raccomanda il framework Network;
     - `URLSession` supporta HTTP/2 e HTTP/3.
     - Foundation non ha una classe EventSource; lo deduco, non l'ho verificato.

7. **Involucro e idempotenza** [72][73].
   - **CloudEvents**: `id`, `source`, `type`, `time`; i duplicati si riconoscono da `source`+`id`; estensioni `sequence` e `correlationid`/`causationid`.
   - **Idempotency-Key (bozza -07)**:
     - 409 se la richiesta originale è ancora in elaborazione;
     - 422 se la chiave viene riusata con un payload diverso.

**Controversie e trade-off**
- **SSE o WebSocket.** SSE è semplice, attraversa bene i proxy e ha una semantica di ripresa standard [70]. WebSocket è bidirezionale e serve per l'audio, ma su iOS va gestito con attenzione alla sospensione [71]. OpenAI separa i due casi: WebRTC per i client mobili, WebSocket da server a server [68].
- **Replay o snapshot.** Il replay da cursore richiede di conservare il log degli eventi; lo snapshot è più robusto ma può perdere eventi intermedi [69][74].
- **Disconnessione e cancellazione** hanno semantiche opposte nei diversi protocolli [64][67][74][75].
- **Adottare AG-UI.** Vantaggi: è uno standard e Mastra lo supporta. Limiti: niente SDK Swift ufficiale e nessun ID evento [63].

**Implicazioni pratiche per Ernie** (sintesi mia, Opinione basata sulle fonti)
- **Involucro unico per gli eventi**:
  - `{id (ULID), seq (monotono per run), type, threadId, runId, correlationId (turno), causationId, ts, visibility: user|internal, persist: bool, payload}`;
  - il client deduplica su `(runId, seq)` [72];
  - i nomi dei tipi seguono AG-UI per restare compatibili [63], aggiungendo gli ID che lo standard non prevede.
- **Trasporti**:
  - agente → client: SSE su HTTP/2/3;
  - client → agente: comandi via POST con `Idempotency-Key` o `messageId` generati dal client;
  - WebSocket o WebRTC solo per l'audio in tempo reale;
  - keepalive ogni 15 s e `X-Accel-Buffering: no` [70][73][74].
- **Ripresa al ritorno in primo piano**: prima uno snapshot (messaggi e run attive), poi `observe` dall'ultimo `seq` [66][69].
  - Log degli eventi in Redis Streams con TTL; gli eventi persistenti finiscono in Postgres.
- **Cancellazione esplicita**: endpoint `POST /runs/{id}/cancel` idempotente; la disconnessione non cancella mai la run [64][67]. Il barge-in vocale lo usa insieme al troncamento del testo non pronunciato [68].
- **Eventi interni separati**: ragionamento, decisioni del router, costi e payload grezzi dei tool vanno al tracing e non al client. La visibilità si filtra lato server, mai lato client [63][64].
- **Connessione e autenticazione** [35]:
  - il client non apre connessioni verso URL presi da deep link o query string, e non invia token a host non configurati;
  - l'upgrade WebSocket richiede autenticazione e un controllo dell'Origin.

---

## 3. Checklist di sicurezza minima per un agente personale con tool ed esecuzione di skill

<<CHECKLIST>>

---

## 4. Lacune e domande aperte

<<LACUNE>>

---

## 5. Bibliografia

<<BIBLIOGRAFIA>>
