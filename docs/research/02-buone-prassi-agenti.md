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

Le prassi più solide che emergono dalle fonti:

1. **Partire dall'ipotesi che la prompt injection riesca.** Gli attacchi adattivi aggirano la maggior parte delle difese pubblicate. Il confine vero è deterministico: sandbox, egress controllato, credenziali fuori dalla sandbox [13][17][21].
2. **Rule of Two / lethal trifecta per ogni run.** Mai insieme input non fidato, dati privati e azioni esterne senza approvazione umana [1][4].
3. **Policy engine deny → ask → allow esterno all'LLM e fail-closed.** Approvazioni legate ad azione, parametri e scadenza, e monouso. Contro l'approval fatigue (93% di approvazioni) servono confini ambientali, non più prompt [7][17][23].
4. **Codice generato mai nel processo applicativo.** `node:vm` non è un meccanismo di sicurezza e `isolated-vm` ha avuto un escape nel 2026. Serve un container gVisor o una microVM, senza rete né segreti [28][29][17].
5. **Isolamento dei dati per utente** con RLS in modalità FORCE e validazione di ciò che si scrive in memoria (rischio ASI06) [33][5][7].
6. **Skill in formato agentskills.io con progressive disclosure**, ciclo proposta → test → approvazione → versione immutabile, e mai attivazione automatica di skill con codice [39][41][43].
7. **Validare le skill misurando guadagni e regressioni**, con e senza skill e su più modelli, con controllo di sicurezza alla scrittura e al recupero [40][47][49].
8. **Automazioni**: sessione nuova per ogni run, prompt autosufficiente, anti-ricorsione, budget per run, run record separati, payload dei trigger trattati come non fidati, jitter, nessun backfill [51][52][53].
9. **Job durevoli**: chiave di idempotenza deterministica; retry con backoff e jitter solo sugli errori transitori e in un solo livello; set dei falliti usato come dead-letter [56][59][60].
10. **Uso dei token registrato solo sugli span di inferenza** (`gen_ai.*`). Costo reale da OpenRouter (`usage.cost`), tenuto separato dal costo stimato [76][84][88].
11. **Nessuna affermazione di risparmio senza misure**: run ripetute, intervalli di confidenza, A/B appaiato contro il miglior modello singolo e un router casuale [87][91][113].
12. **Eval interne**: 20-50 task da fallimenti reali, grader deterministici prima dei giudici LLM, giudici LLM calibrati sugli umani, pass^k per l'affidabilità [93][105][108].
13. **Voce**: pipeline a cascata come default, turn detection semantica, AEC on-device con il voice processing Apple (`.voiceChat` da solo non basta), barge-in come cancellazione più troncamento a ciò che è stato pronunciato [118][126][128].
14. **iOS**: nessuna wake word né avvio del microfono in background. `AudioRecordingIntent` richiede una Live Activity. L'italiano su SpeechTranscriber va verificato a runtime [115][119][122].
15. **Protocollo client-server**: la run vive indipendentemente dalla connessione; log degli eventi con `seq` per il replay; al ritorno in primo piano snapshot più `observe`; cancellazione esplicita e idempotente; eventi interni separati da quelli visibili all'utente [66][67][69].

---

## 2. Analisi per ambito

### 2.1 Sicurezza degli agenti

**Sintesi**

Nel 2025-2026 i tre principali vendor dicono in modo esplicito che la prompt injection non è risolta.
- Anthropic: "far from a solved problem" [15].
- OpenAI: "a frontier security challenge" che evolverà nel tempo [22].
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

### 2.4 Osservabilità e cost tracking

**Sintesi**

**Lo standard di riferimento non è ancora stabile.**
- Le convenzioni semantiche OpenTelemetry per la GenAI sono tutte in stato **Development**.
- Da maggio 2026 sono state spostate in un repository dedicato (`open-telemetry/semantic-conventions-genai`, creato il 2026-05-05), che non ha ancora rilasci.
- L'ultimo rilascio del repo principale che le contiene è la v1.41.1 (2026-05-11) [76].
- **Il costo non fa parte della specifica.** Una proposta (`gen_ai.usage.cost.*`, PR #443, agosto 2026) è ancora aperta [77].

**Pratiche condivise**
- Registrare l'uso dei token **solo sugli span di inferenza**, mai sugli span dell'agente, per evitare doppi conteggi [76][83].
- Distinguere il **costo riportato dal provider o dal gateway**, che è autorevole, dal **costo stimato** da tabelle di prezzi, che è fragile con cache e reasoning token [78][84].
- Non dichiarare risparmi senza misure ripetute con intervalli di confidenza [87][91][92].

**Il mercato degli strumenti è cambiato nel 2026**
- Langfuse è stato acquisito da ClickHouse; il core resta MIT [78].
- Helicone è in "maintenance mode" dopo l'acquisizione da parte di Mintlify [80].
- Phoenix è sotto licenza Elastic 2.0 [81].

**Pattern e pratiche**

1. **Convenzioni OTel GenAI**, branch main del nuovo repo, soggette a cambiamenti [76].
   - **Span di inferenza**:
     - nome `{gen_ai.operation.name} {gen_ai.request.model}`;
     - obbligatori: `gen_ai.operation.name` e `gen_ai.provider.name` (che sostituisce il deprecato `gen_ai.system`);
     - raccomandati: `gen_ai.response.model`, `gen_ai.response.id`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_write.input_tokens` (prima `cache_creation`) e `gen_ai.usage.reasoning.output_tokens`.
   - **Regole di conteggio**:
     - `input_tokens` "SHOULD include all types of input tokens, including cached tokens";
     - cache e reasoning sono sottoinsiemi del totale;
     - va riportato il conteggio fatturato;
     - per Anthropic, `input_tokens` esclude la cache e va ricostruito sommando input, cache read e cache write [76][85].
   - **Span degli agenti**:
     - `invoke_agent`, `invoke_workflow`, `plan`, `execute_tool` (con `gen_ai.tool.call.id`);
     - i valori di `gen_ai.operation.name` includono `chat`, `embeddings`, `execute_tool`, `invoke_agent`, `retrieval` e altri.
   - **Contenuti** (`gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`): sono opt-in perché "likely to contain sensitive information".
   - **Valutazioni**: l'evento `gen_ai.evaluation.result` collega un punteggio di valutazione a uno span.
   - **Modifiche non ancora rilasciate**: l'istogramma `gen_ai.client.token.usage` viene sostituito da contatori per direzione, e gli attributi di cache spariscono da `invoke_agent` perché "misleading" [76].
   - **Regola di transizione** (v1.41.1): `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental` [76].

2. **Costo effettivo e costo stimato.**
   - **OpenRouter** [84]:
     - include sempre `usage` nelle risposte, con `cost` ("the total amount charged to your account"), `prompt_tokens_details.cached_tokens`/`cache_write_tokens` e `completion_tokens_details.reasoning_tokens`;
     - `GET /api/v1/generation?id=` restituisce `total_cost`, `cache_discount`, token nativi, `latency`, `generation_time`, `provider_name` e `provider_responses[]`, cioè i tentativi e i fallback di ogni provider;
     - la doc non dice dopo quanto tempo il record diventa disponibile.
   - **Langfuse** distingue il costo "ingested", che ha la precedenza, da quello "inferred" (tabella prezzi per uso), calcolato al momento dell'ingestione [78].
     - I suoi bucket sono **mutuamente esclusivi**: input senza cache. È la convenzione opposta a OTel, e Langfuse la converte quando riceve dati OTel.
     - Un'issue aperta riporta che un ricalcolo da conteggi parziali ha prodotto circa il 40% del costo reale, perché mancavano i token di cache [79]. La cifra è del segnalante.
   - **Mastra** usa questo ordine di precedenza: `costContext` passato dal chiamante, poi il costo riportato dal provider (solo se tutti gli step lo riportano), poi il registro prezzi interno, altrimenti nessun costo [83].
     - L'exporter OTel di Mastra segue le semconv **v1.38.0**, scrive l'uso solo sullo span `chat` e non esporta il costo.
     - Le metriche automatiche includono `mastra_model_input_cache_read_tokens` e `mastra_model_output_reasoning_tokens`.
   - **Campi di cache dei provider**:
     - Anthropic: `cache_creation_input_tokens`, `cache_read_input_tokens`, con TTL di 5 min o 1 h [85];
     - OpenAI: `cached_tokens` e `cache_write_tokens`, con il tasso di hit calcolato come cached diviso input totale [86].

3. **Piattaforme.**
   - **Langfuse self-hosted** richiede Postgres, **ClickHouse**, Redis/Valkey e un blob storage. L'ingestione OTel avviene via HTTP su `/api/public/otel`; gRPC non è supportato [78].
   - **OpenInference** (Phoenix) definisce attributi di costo (`llm.cost.total`, `llm.cost.prompt_details.cache_read`, …) che OTel non ha [81].
   - **Braintrust** accetta OTLP ma può rispondere HTTP 200 scartando alcuni span (`partialSuccess.rejectedSpans`) [82].
   - **Helicone** è un proxy: va considerato una dipendenza a rischio, vista la "maintenance mode" [80].
   - **Mastra** ha exporter verso Langfuse, Braintrust, Arize e OTel, e un `SensitiveDataFilter` [83].
   - **OpenRouter Broadcast** invia le tracce, con il costo, a Langfuse, Braintrust, un OTel Collector e altre destinazioni [84].

4. **Benchmark onesti su costi e latenza.**
   - "AI Agents That Matter" [87]:
     - accuratezza e costo vanno ottimizzati insieme, su una frontiera di Pareto;
     - vanno riportati sia i dollari sia i token, così il costo si ricalcola quando cambiano i prezzi;
     - le esecuzioni vanno ripetute (5 nel paper) con intervalli di confidenza.
     - Esempio: Warming (GPT-4) raggiunge il 93,2% a $2,45, contro LATS all'88,0% a $134,50.
   - HAL [88]:
     - 21.730 rollout; un reasoning effort più alto ha ridotto l'accuratezza nella maggior parte dei casi;
     - il 5 ottobre 2026 il leaderboard ha segnalato costi e token gonfiati **esattamente di 2×** per span annidati che contavano due volte la stessa risposta, e costi calcolati senza i benefici della cache.
   - Rumore delle valutazioni:
     - **Infrastruttura**: su Terminal-Bench 2.0 la configurazione con più risorse e quella con meno differiscono di 6 punti percentuali, quindi differenze sotto i 3 punti vanno prese con cautela [90].
     - **Casualità**: su 60.000 traiettorie SWE-bench, il pass@1 di una singola run varia di 2,2-6,0 punti, e miglioramenti di 2-3 punti "may reflect evaluation noise" [91].
     - Miller raccomanda errori standard, differenze appaiate tra modelli e power analysis [92].
   - Anthropic: aggiungere complessità "only when it demonstrably improves outcomes" [89].

**Controversie e trade-off**
- **Inclusivo o esclusivo**: OTel e OpenAI contano i token di cache dentro l'input; Anthropic e Langfuse li tengono separati [76][78][85]. Se si mescolano le convenzioni, il costo calcolato è sbagliato.
- **Standard o pragmatismo**: le semconv sono instabili e non coprono il costo [76][77]. OpenInference copre il costo ma è un'altra convenzione [81].
- **Piattaforma esterna o tabelle proprie**: Langfuse aggiunge ClickHouse allo stack [78]. Le metriche di Mastra su Postgres hanno una documentazione contraddittoria sul supporto [83].

**Implicazioni pratiche per Ernie**
- **Tabella `llm_calls` in Postgres come fonte di verità per i costi**, una riga per inferenza:
  - identificativi: `run_id`, `turn_id`, `automation_id?`, `user_id`, `generation_id`;
  - modello: modello richiesto e restituito, provider, decisione del router;
  - token: input totale, cache read e cache write, output e reasoning;
  - tempi: time to first token, latenza;
  - costo: `cost_reported` (da `usage.cost` di OpenRouter), `cost_estimated`, `cost_source`.

  In parallelo si emettono span OTel `chat {model}` con versione delle semconv fissata e variabile d'ambiente opt-in [76][84].
- **Riconciliazione asincrona** su `/api/v1/generation`, per ottenere `total_cost`, fallback e token nativi e tracciare lo scarto tra stima e costo reale [84].
- **Aggregare solo dagli span di inferenza.** È un test di regressione esplicito contro i doppi conteggi [76][88]. Per ogni turno si contano chiamate LLM, tool call e cache hit rate [86].
- **Contenuti dei messaggi** nelle tracce solo con redazione dei dati sensibili, perché contengono PII [76][83]. Non usare Helicone come dipendenza strutturale [80].
- **Ogni affermazione di risparmio** del router o del caching si accompagna a run ripetute, intervalli di confidenza, costo reale riportato e confronto con il miglior modello singolo [87][91][113].

### 2.5 Valutazione degli agenti

**Sintesi**

I benchmark pubblici misurano la combinazione di modello e harness, e sono sempre meno affidabili man mano che si saturano o vengono contaminati.
- Nel febbraio 2026 OpenAI ha smesso di riportare SWE-bench Verified per problemi di test e di contaminazione. La notizia è riportata da fonti secondarie [97].
- Su tau-bench, errori di annotazione e task sottospecificati limitano artificialmente le prestazioni [95].
- Difetti di setup possono sotto- o sovrastimare le prestazioni "by up to 100% in relative terms" [103].

Per un agente personale contano soprattutto le **eval interne**:
- distinzione tra eval di capability ed eval di regressione;
- 20-50 task presi da fallimenti reali;
- grader deterministici prima di quelli basati su LLM;
- giudici LLM calibrati su etichette umane;
- **pass^k** per misurare l'affidabilità [93][108][111].

Per il confronto tra router e modello fisso esistono metriche consolidate (PGR, APGR, CPT) [112]. Un benchmark indipendente del 2026 trova però che molti router si equivalgono e che quelli commerciali non battono in modo affidabile una baseline semplice [113].

**Benchmark di riferimento**

| Benchmark | Cosa misura | Note verificate |
|---|---|---|
| tau-bench [93] / tau2-bench [94] | Agente con tool e policy che parla con un utente simulato; successo = stato finale del DB uguale all'obiettivo | Introduce **pass^k**. gpt-4o è sotto il 50% dei task, pass^8 sotto il 25% nel retail. tau2 aggiunge la "dual-control" (anche l'utente usa tool). Il repo è passato a τ³ con voce full-duplex; i risultati prima e dopo la v1.0.1 non sono confrontabili. |
| SABER [95] | Analisi degli errori su tau-bench | Ogni deviazione in più su un'azione che modifica lo stato riduce le probabilità di successo fino al 92-96%. Le deviazioni sulle azioni che non modificano lo stato contano poco. |
| SWE-bench Verified [96] / Pro [98] | Patch su repository reali | Verified: 500 istanze validate da esseri umani. Pro: 1.865 problemi da 41 repository, anche proprietari, "contamination-resistant". |
| AgentBench [99] | 8 ambienti interattivi | I modelli open fino a 70B restano molto indietro. |
| GAIA [100] | 466 domande da assistente generalista | Umani 92% contro GPT-4 con plugin 15%. |
| BrowseComp [101] | 1.266 domande difficili da trovare ma facili da verificare | Deep Research 51,5%; gli umani hanno rinunciato dopo 2 ore sul 70,8%. |
| Terminal-Bench 2.0 [102] | 89 task in terminale con ambienti dedicati | Frontiera sotto il 65%; sensibile alle risorse dell'infrastruttura [90]. |

**Pattern e pratiche**

1. **Eval interne** (Anthropic, gennaio 2026) [108].
   - Vocabolario comune: task, trial, transcript, outcome, harness.
   - **Eval di capability** con pass rate inizialmente basso ed **eval di regressione** vicine al 100%. I task di capability "graduano" a regressione.
   - Si parte da 20-50 task presi da fallimenti reali.
   - Trial isolati: un modello ha sfruttato la git history lasciata da un trial precedente.
   - Si valuta l'esito, non il percorso. Il giudice ha un'opzione "Unknown".
   - I transcript vanno letti: un punteggio su CORE-Bench è passato dal 42% al 95% dopo aver corretto bug di grading.
   - Esempio di pass^k: con il 75% di successo per trial, la probabilità di superarne 3 su 3 è circa il 42%.

2. **Grader e criteri.**
   - **Anthropic** [109]:
     - criteri specifici e misurabili, che includono latenza e prezzo;
     - ordine di preferenza dei grader: codice, poi LLM, poi umano;
     - per il giudice LLM, un modello diverso da quello che ha generato la risposta.
   - **OpenAI** [110]:
     - dimensioni per agenti: instruction following, correttezza funzionale, scelta del tool, precisione dei dati negli argomenti, handoff;
     - "trace grading" valuta l'intera traccia.
   - **Il servizio OpenAI Evals è in deprecazione**: sola lettura dal 31 ottobre 2026, spegnimento il 30 novembre 2026. Non va usato come base [110].
   - **Husain e Shankar** (pratica, Opinione) [111]:
     - prima l'analisi degli errori su circa 100 tracce;
     - giudizi binari pass/fail invece di scale Likert;
     - un giudice LLM per ogni modalità di errore, validato su 100-200 esempi etichettati con TPR e TNR.

3. **LLM-as-judge e sue insidie.**
   - Zheng et al. (2023) [105]:
     - bias di posizione, verbosità e auto-preferenza;
     - consistenza di posizione di GPT-4 pari al 65,0%;
     - mitigazioni: scambiare le posizioni e contare solo le vittorie coerenti, giudizio con risposta di riferimento (errori in matematica da 14/20 a 3/20), few-shot.
   - Thakur et al. [106]: un alto accordo percentuale può convivere con punteggi molto diversi, fino a 5 punti di scarto rispetto agli umani.
   - EvalGen [107]: "criteria drift". Correggere gli output cambia i criteri stessi, quindi i giudici vanno riallineati alle etichette umane.

4. **Varianza e dimensione del campione.**
   - Servono più run e il pass^k [91].
   - Errori standard raggruppati per gruppi di domande e differenze appaiate [92].
   - La quota di task necessaria per riprodurre una decisione tra due sistemi varia molto: 25% su tau-bench, 90% su SWE-bench Verified [104].

5. **Router intelligente o modello fisso.**
   - RouteLLM [112]:
     - il costo è la quota di chiamate al modello forte;
     - PGR = (router − debole) / (forte − debole);
     - APGR = area della curva PGR;
     - CPT(x%) = quota minima di chiamate forti necessaria per recuperare x% del divario;
     - baseline con router casuale;
     - decontaminazione per similarità ≥0,95.
   - LLMRouterBench [113] (oltre 400.000 istanze, 33 modelli):
     - i metodi migliori arrivano a +4% di accuratezza rispetto al miglior modello singolo, oppure a −31,7% di costo a parità di accuratezza;
     - il router automatico di OpenRouter ottiene −24,7% rispetto al miglior modello singolo, con un pool di candidati non confrontabile;
     - raccomandazione: includere sempre il miglior modello singolo e un oracolo.
   - Mastra offre scorer "live" campionati su agenti e workflow (salvati in `mastra_scorers`) e `runEvals()` offline [114].

**Controversie e trade-off**
- **Benchmark pubblici o eval interne.** I primi servono a scegliere i modelli candidati, ma sono saturi o contaminati [97][103]. Le seconde misurano il caso d'uso reale, ma richiedono di curare un dataset [108][111].
- **Giudice LLM o grader deterministici.** Il giudice LLM scala ma ha bias documentati [105][106]. Grader basati su codice e stato finale, come in tau-bench, sono più robusti ma valgono solo per esiti verificabili [93][109].
- **Router.** La letteratura mostra risparmi possibili (oltre 2× in alcuni casi per RouteLLM [112]), ma la verifica indipendente ridimensiona molto i router generici [113].

**Implicazioni pratiche per Ernie**
- **Tre livelli di test.**
  - **Deterministici** (CI): router (caratteristiche dell'input → tier o modello atteso), policy engine (deny/ask/allow), parsing e validazione delle skill, idempotenza dei job.
  - **Scenari**: 20-50 task da fallimenti reali di Ernie, con tool simulati e fixture, valutati sullo **stato finale** e sugli argomenti dei tool come in tau-bench [93][108].
  - **Giudice LLM** solo per le dimensioni qualitative, di una famiglia di modelli diversa da quella che genera, calibrato su circa 100 esempi etichettati [109][111].
- **pass^k (k=3-5) come metrica di rilascio** per automazioni e azioni sensibili: per un agente persistente l'affidabilità ripetuta conta più del pass@1 [93][108].
- **A/B del router con disegno appaiato**: stessi task su router intelligente, miglior modello fisso, modello fisso economico e router casuale. Si riportano accuratezza, costo reale (OpenRouter) e latenza p50/p95 con intervalli di confidenza, e si decide sulla frontiera di Pareto [87][112][113].
- **Gate di regressione** a ogni cambio di modello, prompt, skill o versione del router. La suite va rieseguita quando OpenRouter aggiorna i modelli sottostanti [42][108].
- **Niente dipendenza da OpenAI Evals**, in dismissione [110]. Gli scorer di Mastra vanno bene per il monitoraggio in produzione campionato [114].

### 2.6 Agenti vocali

**Sintesi**

Esistono tre architetture.
- **Pipeline a cascata** STT → LLM → TTS.
- **Speech-to-speech** (S2S): OpenAI Realtime, Gemini Live.
- **Full-duplex con delega**: GPT-Live di OpenAI, disponibile dal 10 settembre 2026, ascolta mentre parla e delega ragionamento e tool a un backend separato [124].

**Posizioni dei vendor**
- **LiveKit**: "For most production agents, an STT-LLM-TTS pipeline is the right default", per tool calling maturo, trascrizioni in tempo reale e tracciabilità completa del testo [126].
- **OpenAI** consiglia la pipeline a catena quando serve memorizzare la trascrizione o applicare policy prima della sintesi vocale [124].
- **Sulla latenza le fonti si contraddicono**:
  - LiveKit classifica i modelli realtime come "Fastest" [126];
  - l'autore principale di Pipecat sostiene che oggi i modelli S2S di OpenAI e Google sono "slower than a well-tuned cascaded voice agent", e meno affidabili nel seguire istruzioni e chiamare tool [129].
  - Entrambe sono opinioni di vendor.
- **L'architettura a delega** (sessione vocale leggera più agente backend persistente) corrisponde direttamente al disegno di Ernie. OpenAI suggerisce perfino di chiudere la sessione vocale durante i lavori lunghi del backend e di riaprirla con il contesto salvato [124].

**Pratiche convergenti**
- turn detection semantica o basata su modello, invece del solo VAD;
- barge-in = cancellazione più troncamento della risposta al testo effettivamente pronunciato;
- cancellazione dell'eco sul dispositivo;
- sintesi incrementale per frasi;
- latenza misurata come p50/p95 dell'"audible response latency" [124][128][129].

**Pattern e pratiche**

1. **Turn-taking e VAD.**
   - **VAD classici**:
     - Silero elabora un chunk da oltre 30 ms in meno di 1 ms su un thread CPU;
     - WebRTC VAD ha aggressività 0-3 e frame da 10, 20 o 30 ms [131].
   - **Turn detection semantica**:
     - **OpenAI `semantic_vad`**: `eagerness` low/medium/high/auto; i default di `server_vad` sono soglia 0,5, prefix 300 ms, silenzio 500 ms [124].
     - **LiveKit audio turn detector**: 14 lingue, **italiano incluso** [126].
       - Il precedente modello testuale, ora deprecato, aveva per l'italiano la TNR più bassa tra le lingue supportate (85,10%).
     - **Pipecat Smart Turn v3**: circa 8M parametri, 23 lingue **italiano incluso**, input audio a 16 kHz fino a 8 s, "as little as 10ms on some CPUs" [128].
   - **Apple SpeechDetector** è un VAD che regola la trascrizione per risparmiare energia e funziona solo insieme a un transcriber. Il suo `Result` gestisce solo gli errori: deduco che **non fornisca un segnale di fine turno** [115].
   - **Gemini Live**: VAD automatico configurabile, con `silenceDurationMs` consigliato fra 500 e 800 ms [125].

2. **Barge-in e false interruzioni.**
   - **OpenAI**: con WebRTC il server tronca automaticamente l'audio non riprodotto. Con WebSocket è il client che deve fermare la riproduzione e inviare `conversation.item.truncate` [124].
   - **Gemini**: invia `serverContent.interrupted` e il client svuota la coda audio [125].
   - **Pipecat** mantiene nel contesto solo le parole effettivamente pronunciate, grazie alla sincronizzazione con la riproduzione. Contro i rumori usa strategie a numero minimo di parole e filtri per i backchannel [128].
   - **LiveKit**: `false_interruption_timeout` di 2,0 s con ripresa dal punto in cui si era fermato. Il modello "adaptive interruption" dichiara "86% precision and 100% recall" e scarta il 51% dei barge-in basati sul solo VAD; sono dati del blog del vendor [126][127].

3. **Eco e audio su iOS.**
   - "Echo cancellation has to run on the device (not in the cloud)" [129].
   - **Voice processing Apple**: cancellazione dell'eco, soppressione del rumore e controllo automatico del guadagno, tramite AUVoiceIO oppure `AVAudioEngine.inputNode.setVoiceProcessingEnabled(true)` [118].
   - **La modalità `.voiceChat` da sola non basta.** La documentazione dice che le app in modalità chat che non usano l'unità di voice processing ricevono un'elaborazione ridotta, senza echo cancellation né controllo del guadagno [118].
   - **`.measurement`** riduce al minimo l'elaborazione e usa il solo microfono primario [118].
   - **iOS 18.2** aggiunge `setPrefersEchoCancelledInput`, solo su alcuni iPhone del 2024 o successivi [118].
   - L'utente può scegliere la modalità microfono (Standard, Voice Isolation, Wide Spectrum) quando l'app usa il voice processing. L'app può aprire il selettore ma non ho trovato un setter [118].

4. **Latenza e sintesi incrementale.**
   - **Obiettivi dichiarati, in disaccordo tra loro**:
     - 800 ms voice-to-voice come "good target" (2024) [130];
     - 1.500 ms come "important target" (2026), con un round trip tipico di circa 1.200 ms scomposto per stadio: STT ed endpointing 300 ms, TTFB dell'LLM 650 ms, TTFB della TTS 120 ms [129];
     - Moshi, full-duplex, dichiara 160 ms teorici e 200 ms pratici [133].
   - **OpenAI** raccomanda di misurare mediana e 95° percentile della latenza udibile e di tracciare a parte il tempo del backend [124].
   - **Sintesi incrementale**: aggregazione per frase (circa 20 ms nella pipeline Pipecat) e timestamp per parola per mantenere il contesto uguale a ciò che l'utente ha sentito [128][129]. ElevenLabs bufferizza per numero di caratteri e usa `flush` a fine turno [132].
   - **Le chiamate ai tool aggiungono latenza.** Le mitigazioni sono un preambolo parlato e un watchdog [129].

5. **API Apple** (verificate sulla documentazione ufficiale tramite gli endpoint JSON, salvo diversa indicazione).

| API | Disponibilità | Limiti e note verificati |
|---|---|---|
| **SpeechAnalyzer / SpeechTranscriber** [115] | iOS, iPadOS, macOS, tvOS, visionOS 26.0; **non watchOS** | Trascrizione "entirely on device", ma i modelli vanno scaricati (AssetInventory). Il modello gira fuori dalla memoria dell'app e non ne aumenta le dimensioni. Risultati finalizzati per default; `.volatileResults` e `.fastResults` (preset `progressiveTranscription`); `finalize(through:)`. Requisiti hardware non elencati: controllare `isAvailable`/`supportedLocales`. Su Simulator `supportedLocales` è vuoto (forum, Secondaria [122]). |
| **Italiano su SpeechTranscriber** | **Non verificato** | Nessun elenco ufficiale Apple. Un elenco di terzi (42 locali) include it_IT e it_CH [123]. Va verificato a runtime con `supportedLocale(equivalentTo:)`. |
| **DictationTranscriber** [115] | iOS 26 (non tvOS) | Stessi modelli della dettatura di sistema; niente locali solo-rete; supporta `contextualStrings`. La dettatura on-device in italiano è elencata da Apple [121], quindi probabile ma non verificato per questa API. |
| **AssetInventory** [115] | iOS 26 | Modelli condivisi tra app e aggiornati automaticamente. Numero limitato di locali riservabili (`maximumReservedLocales`, variabile con lo spazio). Il sistema può cancellare l'iscrizione dell'app ad asset inutilizzati. |
| **iOS 27** [115] | giugno 2026 | Nuovi `CaptureInputSequenceProvider` (input dal microfono), `AssetInputSequenceProvider`, `AnalyzerInputConverter`. |
| **SFSpeechRecognizer** [116] | iOS 10+ | "Plan for a one-minute limit on audio duration". Lato server, limiti di riconoscimenti per giorno per dispositivo e throttling globale per app. On-device (`requiresOnDeviceRecognition`) solo se `supportsOnDeviceRecognition`, e "won't be as accurate". |
| **AVSpeechSynthesizer** [117] | iOS 7+ (buffer da iOS 13) | Coda di utterance; `write(_:toBufferCallback:)`; voci default/enhanced/premium; SSML. Le voci di Siri non sono disponibili via API. Personal Voice (iOS 17) solo in inglese USA, mandarino e spagnolo messicano, **non italiano** [121]. Quali voci italiane premium siano disponibili non è verificato. |
| **AVAudioSession** [118] | — | `.playAndRecord` con `audio` in UIBackgroundModes per continuare in background. `.voiceChat` applica `.allowBluetoothHFP` (`.allowBluetooth` è deprecato). Su iOS 27, nuove notifiche di ciclo di vita al posto delle interruzioni begin/end. |

6. **Limiti reali di esecuzione in background e del microfono su iOS** [119][120][122].
   - **Background mode `audio`**: per contenuto udibile. La App Review 2.5.4 limita i servizi in background agli "intended purposes"; la 2.5.14 richiede consenso esplicito e un'indicazione chiara durante la registrazione [120].
   - **Avviare la registrazione dal background**: un thread del 2019 riporta che DTS Apple lo esclude "in general". Non ho trovato una dichiarazione ufficiale attuale (Secondaria [122]).
   - **`AudioRecordingIntent`** (iOS 18) è il percorso documentato per avviare la registrazione da Siri, Shortcuts, Centro di Controllo o Action Button. Bisogna avviare una Live Activity e tenerla attiva per tutta la registrazione: "If you don't start a Live Activity, the audio recording stops" [119].
   - **Tasto laterale** per lanciare un assistente vocale: **solo in Giappone**, con un entitlement dedicato [119].
   - **Push to Talk** (iOS 16) può svegliare l'app per l'audio in arrivo, ma l'ingresso nel canale richiede l'app in primo piano [119].
   - **PushKit/VoIP**: ogni push va riportata come chiamata CallKit, quindi non è una scappatoia per il microfono [119].
   - **Wake word sempre attiva**: non ho trovato alcuna API pubblica per terze parti. È un'assenza di prove, non una prova di assenza.
   - Il **punto arancione** compare sempre quando il microfono è in uso [120].

7. **Riferimenti S2S, utili per una modalità futura.**
   - **OpenAI Realtime**: sessioni fino a 60 minuti; WebRTC raccomandato per i client; costo in token audio, con la conversazione reinviata a ogni risposta, per cui i turni successivi costano di più [124].
   - **GPT-Live**: $0,05/min [124].
   - **Gemini Live** [125]:
     - modello stabile `gemini-3.8-live`;
     - "70 supported languages", con l'italiano non confermato esplicitamente;
     - sessioni solo audio di 15 minuti senza compressione;
     - token di ripresa validi 2 ore;
     - token effimeri per le connessioni dal client.
   - Secondo l'autore di Pipecat un agente OpenAI Realtime costa "3 to 5 times" uno basato su GPT-4.1 (Opinione) [129].

8. **Ricerca sul full-duplex.**
   - Full-Duplex-Bench (v1, v1.5, v2) misura pause, backchannel, interruzioni e sovrapposizioni. I sistemi "get confused when people talk at the same time" [134].
   - "Talking Turns": i modelli audio interrompono troppo e fanno pochi backchannel [135].
   - I modelli full-duplex prendono la parola "when asked, not when needed" [136].
   - Una survey del 2026 descrive un "realization gap" tra architetture e comportamento reale [137].

**Controversie e trade-off**
- **Cascata o S2S**: la cascata dà controllo, trascrizioni, tool affidabili e costi minori; la S2S dà naturalezza e comprensione prosodica. Sulla latenza i vendor non sono d'accordo [126][129].
- **Obiettivo di latenza**: 800 ms [130] o 1.500 ms [129]. Dipende dalla rete e dalla collocazione dei modelli: "as low as 500 ms" con tutto co-locato su un unico cluster GPU [129].
- **Valori di default di Pipecat**: la doc indica `stop_secs` 0,2 s, la guida 0,8 s. Non sono riuscito a conciliarli [128][129].
- **STT on-device Apple o cloud**: Apple garantisce privacy, nessun costo e funzionamento offline, ma il supporto all'italiano di SpeechTranscriber va verificato a runtime e la sua accuratezza in italiano non è documentata [115][123].

**Implicazioni pratiche per Ernie**
- **Pipeline a cascata come default** [124][126]:
  - STT on-device (`SpeechTranscriber` con risultati volatili e veloci, con `DictationTranscriber` come ripiego se it-IT non è supportato, entrambi verificati a runtime);
  - testo verso il backend Mastra;
  - risposta in streaming e TTS per frase.
  - Si ottengono trascrizioni auditabili, controllo delle policy prima del parlato e tool affidabili.
- **Audio session**: `.playAndRecord` con **voice processing attivo** (`setVoiceProcessingEnabled(true)`), non solo `.voiceChat` [118]. Le interruzioni del sistema si gestiscono con le nuove notifiche di iOS 27, dove disponibili.
- **Fine turno**: VAD locale per l'inizio del parlato, più un modello semantico per la fine del turno (Smart Turn o simili, che supportano l'italiano), perché Apple non offre un segnale di fine turno. I parametri iniziali vengono dalle doc dei vendor (silenzio 500-800 ms) e vanno calibrati sulle misure reali [124][125][128].
- **Barge-in**: stop immediato della riproduzione sul client, poi `POST /runs/{id}/cancel` più l'indice dell'ultima frase pronunciata, così il backend tronca il messaggio nel contesto (approccio OpenAI e Pipecat) [124][128]. Tool call lunghe con preambolo parlato [129].
- **Strumentare la latenza udibile** (p50/p95), scomposta per stadio: STT finale, rete, router, TTFT, TTS. Obiettivo iniziale realistico sotto 1,5 s, con 800 ms come ambizione [124][129][130].
- **UX coerente con i limiti iOS**: sessione vocale avviata in primo piano oppure via `AudioRecordingIntent` con Live Activity (Siri, Shortcuts, App Shortcut sull'Action Button). Nessuna wake word. I risultati delle automazioni arrivano come notifica e non vengono "parlati" dal background [119][122]. Valutare S2S o GPT-Live solo per una futura modalità "conversazione", con delega al backend Ernie [124].

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

La checklist è derivata dalle fonti citate. Ogni voce è verificabile come sì o no.

**Modello di minaccia e permessi**
- [ ] Ogni tool è classificato su tre dimensioni: legge dati privati, ingerisce contenuto non fidato, cambia stato o comunica all'esterno. La Rule of Two è applicata per run da codice deterministico [1][4].
- [ ] Policy deny → ask → allow valutata fuori dall'LLM; i tool sconosciuti o non mappati sono negati per default [7][23][24].
- [ ] Le azioni irreversibili o costose sono in "ask": pagamenti, invio di messaggi, cancellazioni, modifiche di account. L'approvazione è legata a tool, hash degli argomenti, utente e scadenza, è monouso e viene registrata [7][26].
- [ ] Per le azioni critiche serve uno step-up: Face ID sul client iOS prima di confermare [7].
- [ ] Nessun controllo di sicurezza sta in un punto che una regola allow o una modalità può saltare [24].

**Contenuti non fidati**
- [ ] Risultati dei tool, pagine web, email, file e risposte MCP sono marcati come dati (delimitazione o datamarking) e non possono innescare azioni [C] senza passare dalla policy [12][14].
- [ ] Il client non renderizza immagini o link esterni generati dal modello senza sanitizzazione e redazione degli URL [20].
- [ ] Egress tramite proxy con allowlist per dominio. Ogni dominio in allowlist è trattato come una capability e documentato [16][17].
- [ ] I payload di webhook e trigger sono avvolti come dati non fidati e non valgono come consenso [52].

**Esecuzione di codice e skill**
- [ ] Nessun codice generato o di skill gira nel processo Node, né con `vm` né con `isolated-vm` da solo [28][29].
- [ ] La sandbox è un container dedicato (meglio con gVisor) o una microVM, con capability droppate, `no-new-privileges`, filesystem in sola lettura tranne la cartella di lavoro, rete negata per default, limiti di CPU, memoria, tempo e numero di processi [17][31][32][34].
- [ ] Nessun segreto entra nella sandbox: le credenziali vengono iniettate da un proxy esterno solo per le operazioni approvate [16][17].
- [ ] Le skill create dall'agente vanno in stato `proposed`. Quelle con script richiedono approvazione esplicita, una versione immutabile e un hash fissato [41][43][45].
- [ ] Le skill vengono scansionate alla scrittura e al recupero. Le skill di terzi passano da revisione e scanner [46][47].
- [ ] Le automazioni e le run programmate non possono creare o modificare skill e automazioni [51].

**Dati e memoria**
- [ ] RLS su tutte le tabelle con dati utente, con `FORCE ROW LEVEL SECURITY`. Il ruolo applicativo non è owner delle tabelle e non ha `BYPASSRLS` [33].
- [ ] Namespace per utente su chiavi Redis, code BullMQ, vettori pgvector e file [7].
- [ ] Le scritture in memoria a lungo termine sono validate, con provenienza registrata e revocabili [5][7].
- [ ] Gli handle di stato e gli ID di risorsa sono sempre verificati contro l'utente autenticato e non valgono come autenticazione [25].

**Segreti e identità**
- [ ] Segreti come file (Docker secrets) o letti a runtime da uno store, mai in `ENV`/`ARG` o nelle immagini; rotazione documentata [8].
- [ ] Token OAuth per integrazione con scope minimi; nessun token passthrough; i token non entrano mai nel contesto del modello [25].
- [ ] Il client iOS non apre connessioni verso URL presi da deep link o query string e non invia token a host non configurati. L'upgrade WebSocket richiede autenticazione e un controllo dell'Origin [35].

**Limiti, audit e risposta agli incidenti**
- [ ] Limiti rigidi per run e per utente su token, costo, profondità delle catene di tool, retry e durata. Il limite del router è indipendente da `TokenCostControl`, che è approssimato e fail-open [6][7][27].
- [ ] Rate limit sulle API pubbliche e sulle azioni dell'agente, con soglie di anomalia come tool call al minuto o costo per sessione [7].
- [ ] Audit log append-only: decisione di policy, ID dell'approvazione, versione delle policy, tool, argomenti redatti, esito [7].
- [ ] Interruttore d'emergenza ("kill switch") dal client per sospendere automazioni e run attive, e procedura di rotazione delle credenziali [17][46].
- [ ] Una suite di test di prompt injection (casi stile AgentDojo [10]) gira in CI sui tool che leggono contenuti esterni.

---

## 4. Lacune e domande aperte

**Lacune di verifica**, cioè cose che non sono riuscito a confermare su fonti primarie:

- **Apple** [115][117][122][123]:
  - non esiste un elenco ufficiale delle lingue di `SpeechTranscriber` (incluso l'italiano), né dei requisiti hardware;
  - non è documentato il comportamento di SpeechAnalyzer in background o con un input già elaborato dal voice processing;
  - non ho trovato alcuna API di fine turno;
  - non so quali voci italiane enhanced o premium siano disponibili su iOS 26/27;
  - per il divieto di avviare il microfono dal background esiste solo un thread di forum del 2019.
- **OWASP Agentic Top 10**: i nomi ASI01-ASI10 li ho letti in un riepilogo di terzi, perché la pagina OWASP rimanda al PDF [5].
- **OpenAI**: la pagina sulla prompt injection ha restituito 403 [22]. Le cifre sulla deprecazione di SWE-bench Verified vengono da fonti secondarie [97].
- **OpenTelemetry GenAI**: nessun rilascio del nuovo repository, quindi tutti i nomi possono cambiare. Gli attributi di costo sono solo una proposta [76][77].
- **Mastra**:
  - l'exporter OTel è fermo alle semconv v1.38.0;
  - la documentazione è contraddittoria sul supporto alle metriche con Postgres;
  - non ho verificato il formato SSE lato server di DurableAgent [66][83].
- **OpenRouter**: non è documentato dopo quanto tempo il record `/generation` diventa disponibile [84].
- **Hermes**: le soglie di creazione automatica delle skill citate da terzi (per esempio "5+ tool call") non sono confermate dalla doc ufficiale [43].
- **Turn detection in italiano**: per Smart Turn v3 e per il nuovo audio turn detector di LiveKit non ho trovato metriche di accuratezza specifiche [126][128].
- **Fonti in disaccordo**:
  - latenza della cascata contro la S2S [126][129];
  - obiettivo di latenza, 800 contro 1.500 ms [129][130];
  - `stop_secs` di Pipecat, 0,2 contro 0,8 s [128][129];
  - FNR della auto mode, 17% contro 81% [18][19].

**Domande aperte per la progettazione** (Opinione):

1. **La memoria persistente è input non fidato?** Un contenuto salvato in una sessione precedente, magari derivato da un'email, rientra nella gamba [A] della Rule of Two quando viene recuperato. Le fonti trattano il memory poisoning (ASI06) [5] e la misevolution delle skill [47], ma nessuna dà regole operative per classificare la provenienza dei ricordi in un agente personale.
2. **Injection vocale e audio**: nessuna delle fonti tratta istruzioni avversarie in audio ambientale o nei contenuti letti ad alta voce. È una lacuna per un agente vocale.
3. **Evidenze nel dominio personale**: quasi tutte le prove su skill create dall'agente [48][49] e su router [112][113] vengono da coding, task d'ufficio o benchmark accademici. Mancano studi su domini personali come calendario, email, promemoria e casa.
4. **Il giudice LLM per task soggettivi** (tono, pertinenza di un promemoria) resta poco affidabile [105][106]. Serve una strategia di etichettatura personale sostenibile per un solo utente.
5. **Backfill delle automazioni**: tutte le piattaforme lo escludono [51][53][61]. Per promemoria personali critici, come i farmaci, la politica giusta potrebbe essere diversa.
6. **AG-UI senza SDK Swift ufficiale**: conviene adottare il protocollo lato server e scrivere un client Swift minimale, oppure definire un protocollo proprio compatibile [63]?
7. **Turn detection semantica sul dispositivo**: è fattibile eseguire Smart Turn su iOS (CoreML o ONNX) con una latenza accettabile, o va fatta sul server? Non ho trovato fonti [128].

---

## 5. Bibliografia

**Formato delle voci**
- Ogni voce riporta: titolo, autori o organizzazione, data, URL, tipo, affidabilità.
- "n.d." indica una pagina senza data, consultata il 2026-10-10.
- Alcune voci raggruppano più pagine della stessa documentazione.

**Affidabilità**
- **Primaria**: paper, spec, documentazione ufficiale, engineering blog sul proprio prodotto.
- **Secondaria**: stampa, blog di terzi, riepiloghi, forum.
- **Opinione**: blog di esperti o di vendor senza dati verificabili.

### Sicurezza (§2.1)

1. *The lethal trifecta for AI agents: private data, untrusted content, and external communication*. S. Willison. 2025-06-16. https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/. Blog. Opinione (esperto; fonte originale del concetto).
2. *The Dual LLM pattern for building AI assistants that can resist prompt injection*. S. Willison. 2023-04-25 (agg. 2025-04-11). https://simonwillison.net/2023/Apr/25/dual-llm-pattern/. Blog. Opinione.
3. *New prompt injection papers: Agents Rule of Two and The Attacker Moves Second*. S. Willison. 2025-11-02. https://simonwillison.net/2025/Nov/2/new-prompt-injection-papers/. Blog. Secondaria.
4. *Agents Rule of Two: A Practical Approach to AI Agent Security*. Meta AI. 2025-10-31. https://ai.meta.com/blog/practical-ai-agent-security/. Vendor blog. Primaria.
5. *OWASP Top 10 for Agentic Applications for 2026*. OWASP GenAI Security Project. 2025-12-09. https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/. Docs. Primaria. Nomi ASI letti nel riepilogo https://docs.modulos.ai/frameworks/owasp-top-10-agentic/ (Secondaria).
6. *OWASP Top 10 for LLM Applications 2025*. OWASP Foundation. Novembre 2024. https://genai.owasp.org/llm-top-10/. Docs. Primaria.
7. *AI Agent Security Cheat Sheet*. OWASP Cheat Sheet Series. n.d. https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html. Docs. Primaria.
8. *Secrets Management Cheat Sheet*. OWASP Cheat Sheet Series. n.d. https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html. Docs. Primaria.
9. *Not what you've signed up for: Compromising Real-World LLM-Integrated Applications with Indirect Prompt Injection*. K. Greshake, S. Abdelnabi, S. Mishra, C. Endres, T. Holz, M. Fritz. 2023-02-23. https://arxiv.org/abs/2302.12173. Paper. Primaria.
10. *AgentDojo: A Dynamic Environment to Evaluate Prompt Injection Attacks and Defenses for LLM Agents*. E. Debenedetti et al. 2024-06-19. https://arxiv.org/abs/2406.13352. Paper. Primaria.
11. *Defeating Prompt Injections by Design* (CaMeL). E. Debenedetti, I. Shumailov et al. (Google DeepMind, ETH). 2025-03-24. https://arxiv.org/abs/2503.18813. Paper. Primaria.
12. *Design Patterns for Securing LLM Agents against Prompt Injections*. L. Beurer-Kellner et al. 2025-06-10. https://arxiv.org/abs/2506.08837. Paper. Primaria. Elenco dei pattern letto anche in https://simonwillison.net/2025/Jun/13/prompt-injection-design-patterns/.
13. *The Attacker Moves Second: Stronger Adaptive Attacks Bypass Defenses against LLM Jailbreaks and Prompt Injections*. M. Nasr, N. Carlini et al. 2025-10-10. https://arxiv.org/abs/2510.09023. Paper. Primaria (risultati letti tramite [3]).
14. *Defending Against Indirect Prompt Injection Attacks With Spotlighting*. K. Hines et al. (Microsoft). 2024-03. https://arxiv.org/abs/2403.14720. Paper. Primaria.
15. *Mitigating the risk of prompt injections in browser use*. Anthropic. 2025-11-24. https://www.anthropic.com/research/prompt-injection-defenses. Engineering/research blog. Primaria.
16. *Making Claude Code more secure and autonomous with sandboxing*. Anthropic. 2025-10-20. https://www.anthropic.com/engineering/claude-code-sandboxing. Engineering blog. Primaria.
17. *How we contain Claude*. Anthropic. 2026-05-25. https://www.anthropic.com/engineering/how-we-contain-claude. Engineering blog. Primaria.
18. *Claude Code auto mode*. J. Hughes (Anthropic). 2026-03-25. https://www.anthropic.com/engineering/claude-code-auto-mode. Engineering blog. Primaria.
19. *Measuring the Permission Gate: A Stress-Test Evaluation of Claude Code's Auto Mode*. Z. Ji, Z. Li, W. Jiang, Y. Gao, S. Wang. 2026-04-04. https://arxiv.org/abs/2604.04978. Paper. Primaria.
20. *Mitigating prompt injection attacks with a layered defense strategy*. Google GenAI Security Team. 2025-06-13. https://blog.google/security/mitigating-prompt-injection-attacks/. Vendor blog. Primaria.
21. *Defend against indirect prompt injection attacks* (Secure Future Initiative). Microsoft Learn. 2026-03-19. https://learn.microsoft.com/en-us/security/zero-trust/sfi/defend-indirect-prompt-injection. Docs. Primaria.
22. *Understanding prompt injections: a frontier security challenge*. OpenAI. 2025-11-07. https://openai.com/index/prompt-injections/. Vendor blog. Primaria, ma accesso diretto negato (403): contenuto ricostruito da copertura secondaria.
23. *Configure permissions* (Claude Code). Anthropic. n.d. https://code.claude.com/docs/en/permissions. Docs. Primaria.
24. *Configure permissions* (Claude Agent SDK). Anthropic. n.d. https://code.claude.com/docs/en/agent-sdk/permissions. Docs. Primaria.
25. *Security Best Practices* (MCP specification, draft). Model Context Protocol. n.d. https://modelcontextprotocol.io/specification/draft/basic/security_best_practices. Spec. Primaria.
26. *Human-in-the-loop / Agent approval*. Mastra. n.d. https://mastra.ai/docs/agents/human-in-the-loop. Docs. Primaria.
27. *Guardrails* e *TokenCostControl* reference. Mastra. n.d. https://mastra.ai/docs/agents/guardrails ; https://mastra.ai/reference/processors/token-cost-control. Docs. Primaria.
28. *VM (executing JavaScript)*. Node.js. n.d. https://nodejs.org/api/vm.html. Docs. Primaria.
29. *Critical flaw patched in popular JavaScript sandbox used in AI projects* (isolated-vm, GHSA-864f-rcv7-6rh4). L. Constantin, CSO Online. 2026-08-20. https://www.csoonline.com/article/4212151/critical-flaw-patched-in-popular-javascript-sandbox-used-in-ai-projects.html. Stampa. Secondaria.
30. *Security and permissions*. Deno. n.d. https://docs.deno.com/runtime/fundamentals/security/. Docs. Primaria.
31. *gVisor documentation*. gVisor authors (Google). n.d. https://gvisor.dev/docs/. Docs. Primaria.
32. *Firecracker*. AWS / Firecracker project. n.d. https://firecracker-microvm.github.io/. Sito/docs. Primaria.
33. *Row Security Policies* (PostgreSQL 18). PostgreSQL Global Development Group. n.d. https://www.postgresql.org/docs/current/ddl-rowsecurity.html. Docs. Primaria.
34. *Security* (Hermes Agent). Nous Research. n.d. https://hermes-agent.nousresearch.com/docs/user-guide/security. Docs. Primaria.
35. *CVE-2026-25253* (OpenClaw). NIST NVD. 2026-02-01. https://nvd.nist.gov/vuln/detail/CVE-2026-25253. Database CVE. Primaria.
36. *Zero-Click AI Vulnerability Exposes Microsoft 365 Copilot Data Without User Interaction* (EchoLeak, CVE-2025-32711). The Hacker News. Giugno 2025. https://thehackernews.com/2025/06/zero-click-ai-vulnerability-exposes.html. Stampa. Secondaria.

### Skill e procedural memory (§2.2)

37. *Voyager: An Open-Ended Embodied Agent with Large Language Models*. G. Wang, Y. Xie, Y. Jiang, A. Mandlekar, C. Xiao, Y. Zhu, L. Fan, A. Anandkumar. 2023-05-25. https://arxiv.org/abs/2305.16291. Paper. Primaria.
38. *Equipping agents for the real world with Agent Skills*. Anthropic. 2025-10-16 (agg. 2025-12-18). https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills. Engineering blog. Primaria.
39. *Agent Skills — Overview* e *Specification*. agentskills.io (standard aperto, originato da Anthropic). n.d. https://agentskills.io/home ; https://agentskills.io/specification. Spec. Primaria.
40. *Skill authoring best practices*. Anthropic (Claude Platform docs). n.d. https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices. Docs. Primaria.
41. *Using Skills with the API* (versioning). Anthropic (Claude Platform docs). n.d. https://platform.claude.com/docs/en/build-with-claude/skills-guide. Docs. Primaria.
42. *Improving skill-creator: Test, measure, and refine Agent Skills*. Anthropic (claude.com blog). 2026-03-03. https://claude.com/blog/improving-skill-creator-test-measure-and-refine-agent-skills. Vendor blog. Primaria (letta in parte; i dettagli delle modalità vengono da riepiloghi).
43. *Skills System*. Nous Research (Hermes Agent). n.d. https://hermes-agent.nousresearch.com/docs/user-guide/features/skills. Docs. Primaria.
44. *Workspace skills / Agent skills*. Mastra. n.d. https://mastra.ai/docs/workspace/skills. Docs. Primaria (letta tramite indice ed estratti della doc).
45. *Agent Skills in the Wild: An Empirical Study of Security Vulnerabilities at Scale*. Y. Liu, W. Wang, R. Feng, Y. Zhang, G. Xu, G. Deng, Y. Li, L. Zhang. 2026-01-15. https://arxiv.org/abs/2601.10338. Paper. Primaria.
46. *ToxicSkills: malicious AI agent skills on ClawHub*. Snyk. 2026-02-05. https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub/. Vendor blog (ricerca). Primaria per i propri dati.
47. *Practice Makes Unsafe: Skill Misevolution in Self-Improving LLM Agents*. X. Mao, L. Zhao, X. Zheng, C. Wang. 2026-08-13 (v2 2026-10-07). https://arxiv.org/abs/2608.12851. Paper (preprint). Primaria.
48. *Managing Procedural Memory in LLM Agents: Control, Adaptation, and Evaluation*. J. Belikova et al. 2026-06-22. https://arxiv.org/abs/2606.23127. Paper (preprint). Primaria.
49. *The Regression Tax: Decomposing Why Skills Help and Hurt LLM Agents*. D. Tank, B. Nama. 2026-07-24. https://arxiv.org/abs/2607.22520. Paper (preprint). Primaria.
50. *Darwin Gödel Machine: Open-Ended Evolution of Self-Improving Agents*. J. Zhang, S. Hu, C. Lu, R. Lange, J. Clune. 2025-05-29 (v3 2026-03-12). https://arxiv.org/abs/2505.22954. Paper. Primaria.

### Automazioni e scheduling (§2.3)

51. *Scheduled Tasks (Cron)*. Nous Research (Hermes Agent). n.d. https://hermes-agent.nousresearch.com/docs/user-guide/features/cron. Docs. Primaria.
52. *Automate work with routines* (research preview). Anthropic (Claude Code docs). n.d. https://code.claude.com/docs/en/routines. Docs. Primaria.
53. *Scheduled deployments* (Managed Agents, beta). Anthropic (Claude Platform docs). n.d.; funzione lanciata il 2026-06-09. https://platform.claude.com/docs/en/managed-agents/scheduled-deployments. Docs. Primaria.
54. *Scheduled tasks in ChatGPT*. OpenAI Help Center. n.d. https://help.openai.com/en/articles/10291617. Docs. Primaria (letta tramite estratti di ricerca).
55. *Gemini scheduled actions rolling out*. 9to5Google. 2025-06-27. https://9to5google.com/2025/06/27/gemini-scheduled-actions-rollout/. Stampa. Secondaria.
56. *Job Schedulers*; *Retrying failing jobs*; *Deduplication*; *Idempotent jobs*. BullMQ. n.d. https://docs.bullmq.io/guide/job-schedulers ; https://docs.bullmq.io/guide/retrying-failing-jobs ; https://docs.bullmq.io/guide/jobs/deduplication ; https://docs.bullmq.io/patterns/idempotent-jobs. Docs. Primaria.
57. *Retry Policies*. Temporal. n.d. https://docs.temporal.io/encyclopedia/retry-policies. Docs. Primaria.
58. *Handling idempotency*; *Flow control*; *Durable agents*; *How to Build a Durable AI Agent with Inngest*. Inngest. n.d. https://www.inngest.com/docs/guides/handling-idempotency ; https://www.inngest.com/docs/guides/flow-control ; https://www.inngest.com/blog/ai-agents-inngest-durable-steps. Docs/blog. Primaria (letta tramite estratti).
59. *Timeouts, retries, and backoff with jitter*. M. Brooker (AWS). Amazon Builders' Library, ripubblicato su AWS Builder Center 2026-06-12. https://builder.aws.com/content/3EumjoZascWd1oZiEgL8ORlv3qE/timeouts-retries-and-backoff-with-jitter. Engineering article. Primaria.
60. *Idempotent requests*. Stripe API docs. n.d. https://docs.stripe.com/api/idempotent_requests. Docs. Primaria.
61. *Scheduled workflows* (docs) e *Introducing Schedules for Mastra Agents and Workflows* (P. Scanlon). Mastra. n.d.; blog 2026-07-08. https://mastra.ai/docs/workflows/scheduled-workflows ; https://mastra.ai/blog/introducing-schedules-for-agents-and-workflows. Docs/vendor blog. Primaria.
62. *Pushing background updates to your App*. Apple Developer Documentation. n.d. https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app. Docs. Primaria.

### Protocolli client-server (§2.7)

63. *AG-UI* docs (Events, Interrupts, Serialization, HttpAgent, Introduction) e `@ag-ui/core` 1.0 (CHANGELOG). AG-UI Protocol / CopilotKit. Docs n.d.; 1.0.0 del 2026-09-17. https://docs.ag-ui.com/concepts/events ; https://docs.ag-ui.com/concepts/interrupts ; https://github.com/ag-ui-protocol/ag-ui. Spec/docs/repo. Primaria.
64. *Stream Protocols*; *Chatbot Resume Streams*; *Chatbot Message Persistence*. Vercel AI SDK (ai@7). n.d. https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol ; https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams ; https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence. Docs. Primaria.
65. *resumable-stream* (v2.2.13). Vercel. 2026-09-16. https://github.com/vercel/resumable-stream. Repo. Primaria.
66. *Streaming* (ChunkType), *DurableAgent* reference, *PubSub*; *Introducing Durable Agents* (P. Scanlon). Mastra. Docs n.d.; blog 2026-06-26. https://mastra.ai/reference/streaming/ChunkType ; https://mastra.ai/reference/agents/durable-agent ; https://mastra.ai/docs/server/pubsub ; https://mastra.ai/blog/introducing-durable-agents. Docs/vendor blog. Primaria.
67. *Responses streaming events*; *Background mode*; *WebSocket mode*. OpenAI. n.d. https://developers.openai.com/api/reference/resources/responses/streaming-events ; https://developers.openai.com/api/docs/guides/background ; https://developers.openai.com/api/docs/guides/websocket-mode. Docs. Primaria.
68. *Realtime client/server events*; *Realtime conversations*; *Voice WebRTC*. OpenAI. n.d. https://developers.openai.com/api/reference/resources/realtime/client-events ; https://developers.openai.com/api/docs/guides/realtime-conversations ; https://developers.openai.com/api/docs/guides/voice-webrtc. Docs. Primaria.
69. *Agent2Agent (A2A) Protocol Specification v1.0* (2026-03-12) e *Linux Foundation Launches the Agent2Agent Protocol Project* (2025-06-23). A2A Project / Linux Foundation. https://a2a-protocol.org/latest/specification/ ; https://github.com/a2aproject/A2A/releases ; https://linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents. Spec/comunicato. Primaria.
70. *HTML Living Standard — Server-sent events*. WHATWG. Aggiornato al 2026-10-09. https://html.spec.whatwg.org/multipage/server-sent-events.html. Spec. Primaria.
71. *TN3151: Choosing the right networking API*; *URLSessionWebSocketTask*. Apple. n.d. https://developer.apple.com/documentation/technotes/tn3151-choosing-the-right-networking-api ; https://developer.apple.com/documentation/foundation/urlsessionwebsockettask. Docs. Primaria.
72. *CloudEvents Specification v1.0.2* e *Correlation extension* (2025-07-10). CNCF CloudEvents. 2022-02-06 / 2025. https://github.com/cloudevents/spec/blob/main/cloudevents/spec.md ; https://github.com/cloudevents/spec/blob/main/cloudevents/extensions/correlation.md. Spec. Primaria.
73. *The Idempotency-Key HTTP Header Field* (draft-ietf-httpapi-idempotency-key-header-07). IETF HTTPAPI WG. 2025-10-15, scaduta il 2026-04-18. https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/. Internet-Draft. Primaria (bozza scaduta, non RFC).
74. *MCP Transports* (2025-11-25) e *Streamable HTTP* + changelog (2026-07-28). Model Context Protocol. https://modelcontextprotocol.io/specification/2025-11-25/basic/transports ; https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http. Spec. Primaria.
75. *Join Run Stream* (LangSmith Agent Server API). LangChain. n.d. https://docs.langchain.com/langsmith/agent-server-api/thread-runs/join-run-stream. API ref. Primaria.

### Osservabilità e costi (§2.4)

76. *GenAI semantic conventions* (repo `semantic-conventions-genai`, branch main; core semconv v1.41.1 del 2026-05-11). OpenTelemetry. Repo creato il 2026-05-05. https://github.com/open-telemetry/semantic-conventions-genai ; https://github.com/open-telemetry/semantic-conventions/tree/v1.41.1/docs/gen-ai. Spec (Development). Primaria.
77. *PR #443 "Add per-operation cost conventions (gen_ai.usage.cost.*)"* e issue #287, #484, #299. OpenTelemetry community. 2025-05-30 → 2026-10. https://github.com/open-telemetry/semantic-conventions-genai/pull/443. Proposta. Primaria (non normativa).
78. *Token & Cost Tracking*; *OpenTelemetry*; *Self-hosting* (Langfuse) e *ClickHouse welcomes Langfuse* (2026-01-16). Langfuse / ClickHouse. https://langfuse.com/docs/observability/features/token-and-cost-tracking ; https://langfuse.com/docs/opentelemetry/get-started ; https://langfuse.com/self-hosting ; https://clickhouse.com/blog/clickhouse-acquires-langfuse-open-source-llm-observability. Docs/vendor blog. Primaria.
79. *Issue #13807* (llm.cost.total ignorato). Langfuse GitHub. 2026-05-23. https://github.com/langfuse/langfuse/issues/13807. Issue. Primaria (dichiarazione del segnalante).
80. *Helicone is joining Mintlify* (2026-03-03) e *Quick start*. Helicone. https://www.helicone.ai/blog/joining-mintlify ; https://docs.helicone.ai/getting-started/quick-start. Vendor blog/docs. Primaria.
81. *OpenInference semantic conventions*; *Phoenix* (licenza ELv2). Arize AI. n.d. https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md ; https://github.com/Arize-ai/phoenix. Spec/repo. Primaria.
82. *Traces*. Braintrust. n.d. https://www.braintrust.dev/docs/guides/traces. Docs. Primaria.
83. *Observability* (tracing, OTel exporter, automatic metrics) e sorgente `tracing.ts`. Mastra. n.d. https://mastra.ai/docs/observability/overview ; https://mastra.ai/docs/observability/tracing/exporters/otel ; https://mastra.ai/reference/observability/metrics/automatic-metrics ; https://github.com/mastra-ai/mastra/blob/main/packages/core/src/observability/types/tracing.ts. Docs/codice. Primaria.
84. *Usage Accounting*; *Get a generation*; *Prompt caching*; *Broadcast*. OpenRouter. n.d. https://openrouter.ai/docs/use-cases/usage-accounting ; https://openrouter.ai/docs/api-reference/get-a-generation ; https://openrouter.ai/docs/guides/best-practices/prompt-caching ; https://openrouter.ai/docs/guides/features/broadcast. Docs. Primaria.
85. *Prompt caching*. Anthropic (Claude Platform docs). n.d. https://platform.claude.com/docs/en/build-with-claude/prompt-caching. Docs. Primaria.
86. *Prompt caching*. OpenAI. n.d. https://developers.openai.com/api/docs/guides/prompt-caching. Docs. Primaria.
87. *AI Agents That Matter*. S. Kapoor, B. Stroebl, Z. Siegel, N. Nadgir, A. Narayanan. 2024-07-01. https://arxiv.org/abs/2407.01502. Paper. Primaria.
88. *Holistic Agent Leaderboard (HAL)* (paper 2025-10-13) e pagina SWE-bench Verified Mini con known issue del 2026-10-05. S. Kapoor et al. / Princeton. https://arxiv.org/abs/2510.11977 ; https://hal.cs.princeton.edu/swebench_verified_mini. Paper/leaderboard. Primaria.
89. *Building effective agents*. E. Schluntz, B. Zhang (Anthropic). 2024-12-19. https://www.anthropic.com/engineering/building-effective-agents. Engineering blog. Primaria.
90. *Quantifying infrastructure noise in agentic coding evals*. G. Segato (Anthropic). 2026-02-05. https://www.anthropic.com/engineering/infrastructure-noise. Engineering blog. Primaria.
91. *On Randomness in Agentic Evals*. B. Bjarnason, A. Silva, M. Monperrus. 2026-02-06. https://arxiv.org/abs/2602.07150. Paper. Primaria.
92. *Adding Error Bars to Evals: A Statistical Approach to Language Model Evaluations*. E. Miller (Anthropic). 2024-11-01. https://arxiv.org/abs/2411.00640. Paper. Primaria.

### Valutazione (§2.5)

93. *τ-bench: A Benchmark for Tool-Agent-User Interaction in Real-World Domains*. S. Yao, N. Shinn, P. Razavi, K. Narasimhan (Sierra). 2024-06-17. https://arxiv.org/abs/2406.12045. Paper. Primaria.
94. *τ²-Bench: Evaluating Conversational Agents in a Dual-Control Environment* (2025-06-09) e repo (τ³, v1.0.1 del 2026-07-22). V. Barres et al. (Sierra). https://arxiv.org/abs/2506.07982 ; https://github.com/sierra-research/tau2-bench. Paper/repo. Primaria.
95. *SABER* (analisi di τ-bench, "τ-Bench Verified"). A. Cuadron et al. 2025-11-26. https://arxiv.org/abs/2512.07850. Paper. Primaria.
96. *SWE-bench Verified*. SWE-bench team / OpenAI. 2024-08-13 (annuncio OpenAI letto tramite estratti). https://www.swebench.com/verified.html ; https://openai.com/index/introducing-swe-bench-verified/. Benchmark/vendor blog. Primaria.
97. *OpenAI stops reporting SWE-bench Verified* (copertura). Gigazine. 2026-04-29. https://gigazine.net/gsc_news/en/20260429-swe-bench-verified/. Stampa. Secondaria.
98. *SWE-Bench Pro*. X. Deng et al. 2025-09-21. https://arxiv.org/abs/2509.16941. Paper. Primaria.
99. *AgentBench: Evaluating LLMs as Agents*. X. Liu et al. 2023-08-07. https://arxiv.org/abs/2308.03688. Paper. Primaria.
100. *GAIA: a benchmark for General AI Assistants*. G. Mialon, C. Fourrier, C. Swift, T. Wolf, Y. LeCun, T. Scialom. 2023-11-21. https://arxiv.org/abs/2311.12983. Paper. Primaria.
101. *BrowseComp: A Simple Yet Challenging Benchmark for Browsing Agents*. J. Wei et al. (OpenAI). 2025-04-16. https://arxiv.org/abs/2504.12516. Paper. Primaria.
102. *Terminal-Bench 2.0*. M. Merrill, A. Shaw, N. Carlini et al. 2026-01-17. https://arxiv.org/abs/2601.11868. Paper. Primaria.
103. *Establishing Best Practices for Building Rigorous Agentic Benchmarks* (Agentic Benchmark Checklist). Y. Zhu et al. 2025-07-03. https://arxiv.org/abs/2507.02825. Paper. Primaria.
104. *How Many Tasks Are Enough for Agent Benchmark Decisions?* W.-J. Huang. 2026-07-14. https://arxiv.org/abs/2607.12338. Workshop paper. Primaria.
105. *Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena*. L. Zheng et al. 2023-06-09. https://arxiv.org/abs/2306.05685. Paper. Primaria.
106. *Judging the Judges: Evaluating Alignment and Vulnerabilities in LLMs-as-Judges*. A. S. Thakur et al. 2024-06-18. https://arxiv.org/abs/2406.12624. Paper. Primaria.
107. *Who Validates the Validators? Aligning LLM-Assisted Evaluation of LLM Outputs with Human Preferences* (EvalGen). S. Shankar et al. 2024-04-18. https://arxiv.org/abs/2404.12272. Paper. Primaria.
108. *Demystifying evals for AI agents*. M. Grace, J. Hadfield, R. Olivares, J. De Jonghe (Anthropic). 2026-01-09. https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents. Engineering blog. Primaria.
109. *Define success criteria* / *Develop tests*. Anthropic (Claude Platform docs). n.d. https://platform.claude.com/docs/en/test-and-evaluate/develop-tests. Docs. Primaria.
110. *Evaluation best practices*; *Trace grading*; *Deprecations* (Evals platform, annuncio 2026-06-03). OpenAI. https://developers.openai.com/api/docs/guides/evaluation-best-practices ; https://developers.openai.com/api/docs/guides/trace-grading ; https://developers.openai.com/api/docs/deprecations. Docs. Primaria.
111. *AI Evals: Everything You Need to Know* (FAQ). H. Husain, S. Shankar. 2026-09-18. https://hamel.dev/blog/posts/evals-faq/. Blog di praticanti. Opinione.
112. *RouteLLM: Learning to Route LLMs with Preference Data*. I. Ong et al. (LMSYS). 2024-06-26 (v4 2025-02-23). https://arxiv.org/abs/2406.18665. Paper. Primaria.
113. *LLMRouterBench*. Li et al. 2026-01-12. https://arxiv.org/abs/2601.07206. Paper. Primaria.
114. *Evals overview* (`@mastra/evals`, scorers). Mastra. n.d. https://mastra.ai/docs/evals/overview. Docs. Primaria.

### Agenti vocali (§2.6)

115. *Bring advanced speech-to-text to your app with SpeechAnalyzer* (WWDC25, sessione 277) e documentazione del framework Speech: SpeechAnalyzer, SpeechTranscriber, DictationTranscriber, SpeechDetector, AssetInventory, *Speech updates* (giugno 2026). Apple. 2025-06 / n.d. https://developer.apple.com/videos/play/wwdc2025/277/ ; https://developer.apple.com/documentation/speech/speechtranscriber ; https://developer.apple.com/documentation/speech/assetinventory ; https://developer.apple.com/documentation/updates/speech. Sessione/docs. Primaria.
116. *SFSpeechRecognizer* e *Advances in Speech Recognition* (WWDC19, 256). Apple. n.d. / 2019-06. https://developer.apple.com/documentation/speech/sfspeechrecognizer ; https://developer.apple.com/videos/play/wwdc2019/256/. Docs/sessione. Primaria.
117. *AVSpeechSynthesizer*; *Extend Speech Synthesis with personal and custom voices* (WWDC23, 10033); *Create a seamless speech experience in your apps* (WWDC20, 10022). Apple. https://developer.apple.com/documentation/avfaudio/avspeechsynthesizer ; https://developer.apple.com/videos/play/wwdc2023/10033/ ; https://developer.apple.com/videos/play/wwdc2020/10022/. Docs/sessioni. Primaria.
118. *AVAudioSession* (modi `voiceChat`, `measurement`; opzioni; `setPrefersEchoCancelledInput`; *Handling audio interruptions*) e *What's new in voice processing* (WWDC23, 10235). Apple. n.d. / 2023-06. https://developer.apple.com/documentation/avfaudio/avaudiosession/mode-swift.struct/voicechat ; https://developer.apple.com/documentation/avfaudio/handling-audio-interruptions ; https://developer.apple.com/videos/play/wwdc2023/10235/. Docs/sessione. Primaria.
119. *Configuring background execution modes*; *AudioRecordingIntent*; *Push to Talk*; *PushKit*; *Launching your voice-based conversational app from the side button of iPhone*. Apple. n.d. https://developer.apple.com/documentation/xcode/configuring-background-execution-modes ; https://developer.apple.com/documentation/appintents/audiorecordingintent ; https://developer.apple.com/documentation/pushtotalk ; https://developer.apple.com/documentation/appintents/launching-your-voice-based-conversational-app-from-the-side-button-of-iphone. Docs. Primaria.
120. *App Review Guidelines* (2026-06-08) e *About the orange and green indicators* (HT211876). Apple. https://developer.apple.com/app-store/review/guidelines/ ; https://support.apple.com/HT211876. Policy/supporto. Primaria.
121. *iOS Feature Availability*. Apple. Corrente. https://www.apple.com/ios/feature-availability/. Pagina Apple. Primaria.
122. Apple Developer Forums, thread 120038 (registrazione in background, 2019) e 807739 (dispositivi SpeechTranscriber, 2025-11). https://developer.apple.com/forums/thread/120038 ; https://developer.apple.com/forums/thread/807739. Forum. Secondaria.
123. *iOS 26: SpeechAnalyzer Guide*. A. Gubarenko. 2025-07-28 (agg. 2025-09-15). https://antongubarenko.substack.com/p/ios-26-speechanalyzer-guide. Blog. Secondaria.
124. *Voice agents*; *Getting started with GPT-Live*; *Voice activity detection*; *Realtime conversations*; *Cost optimization (voice)*; *API changelog*. OpenAI. n.d. (changelog 2025-08 → 2026-09). https://developers.openai.com/api/docs/guides/voice-agents ; https://developers.openai.com/api/docs/guides/live ; https://developers.openai.com/api/docs/guides/realtime-vad ; https://developers.openai.com/api/docs/guides/voice-latency-cost ; https://developers.openai.com/api/docs/changelog. Docs. Primaria.
125. *Live API* (overview, capabilities guide, session management, ephemeral tokens, modello Gemini 3.8 Live). Google AI for Developers. Agg. 2026-09/10. https://ai.google.dev/gemini-api/docs/live ; https://ai.google.dev/gemini-api/docs/live-guide ; https://ai.google.dev/gemini-api/docs/live-session. Docs. Primaria.
126. *LiveKit Agents* docs (Turns, Turn detector, Turn-taking tuning, Pipeline types, Realtime models) e `client-sdk-swift`. LiveKit. n.d. https://docs.livekit.io/agents/build/turns/ ; https://docs.livekit.io/agents/build/turns/turn-detector/ ; https://docs.livekit.io/agents/models/pipelines ; https://github.com/livekit/client-sdk-swift. Docs/repo. Primaria (documentazione del vendor).
127. *Solving unwanted interruptions with Adaptive Interruption Handling*. LiveKit. 2026-03-19. https://livekit.com/blog/adaptive-interruption-handling. Vendor blog. Opinione.
128. *Speech Input & Turn Detection*; *Interruptions* (Pipecat docs) e repo *smart-turn* (v3.x). Pipecat / Daily. n.d. https://docs.pipecat.ai/pipecat/learn/speech-input ; https://docs.pipecat.ai/pipecat/fundamentals/interruptions ; https://github.com/pipecat-ai/smart-turn. Docs/repo. Primaria.
129. *Voice AI & Voice Agents: An Illustrated Primer*. K. Hultman Kramer. Aggiornamento giugno 2026. https://voiceaiandvoiceagents.com/. Guida di un autore legato a un vendor. Opinione.
130. *OpenAI Realtime API: The Missing Manual*. K. Hultman Kramer / Latent Space. 2024-11-21. https://latent.space/p/realtime-api. Blog. Opinione.
131. *Silero VAD* e *py-webrtcvad*. snakers4 / J. Wiseman. Correnti. https://github.com/snakers4/silero-vad ; https://github.com/wiseman/py-webrtcvad. Repo. Primaria.
132. *WebSockets* (TTS input streaming). ElevenLabs. n.d. https://elevenlabs.io/docs/developers/websockets. Docs. Primaria.
133. *Moshi: a speech-text foundation model for real-time dialogue*. A. Défossez et al. (Kyutai). 2024-09-17. https://arxiv.org/abs/2410.00037. Paper. Primaria.
134. *Full-Duplex-Bench* (v1 2025-03-06), *v1.5* (2025-07-30), *v2* (2025-10-09). G.-T. Lin et al. https://arxiv.org/abs/2503.04721 ; https://arxiv.org/abs/2507.23159 ; https://arxiv.org/abs/2510.07838. Paper. Primaria.
135. *Talking Turns: Benchmarking Audio Foundation Models on Turn-Taking Dynamics*. S. Arora et al. 2025-03-03. https://arxiv.org/abs/2503.01174. Paper. Primaria.
136. *Full-Duplex Speech Models Take the Floor When Asked, Not When Needed*. Peng et al. 2026-09-17. https://arxiv.org/abs/2609.19596. Paper (preprint). Primaria.
137. *A Survey of Full-Duplex Spoken Dialogue Systems*. Lu et al. 2026-06-17. https://arxiv.org/abs/2606.19453. Survey (preprint). Primaria.
