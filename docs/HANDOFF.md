# Handoff — stato condiviso del progetto

Su Ernie lavorano due agenti: Claude Code sul **Mac Studio** e un altro agente sul **Mac dell'ufficio**. Questo file è il
passaggio di consegne fra loro e va aggiornato **a fine di ogni sessione di lavoro**, nello stesso push delle
modifiche: cosa è cambiato, cosa è pubblicato e dove, cosa resta aperto. Le regole di rilascio sono in
[AGENTS.md](../AGENTS.md), le note di ogni build in [releases](releases/).

### Build 120 — Abitudini compilata e firmata, pubblicazione in attesa

10 novembre 2026. Due implementazioni Copilot su copie isolate integrate e verificate da Codex.
124 test backend in nove suite, 46 iOS in due suite; TypeScript/Biome e render chiaro/scuro accessibile passati.
Correzioni di revoca/pausa e avvio background, lease locale, coda protetta, visite tardive/alias e cancellazione,
limiti delle domande anche dopo clear, manutenzione isolata per account. AppDelegate e SwiftUI condividono
lo stesso AppModel; nessun opt-in implicito e nessun prompt di permesso al riavvio.

Numero/changelog 120 aggiornati; sorgenti GitHub **62f097c17f52fef696d98e4e685b56b655336544**.
Archivio pulito Xcode 27.2 ufficio, export Apple Xcode 27.0 Mac Studio: quattro bundle 120 firmati
e verificati, gruppo diario privato solo nell’app; 318 input iOS verificati. IPA/manifest sul Mac Studio
in `~/Library/Caches/ernie-builds/build-120-20261110-habits/`. Pubblicazione ancora da autorizzare: **server resta API fe3a60f,
worker 119, TestFlight 119**; migrazione 0054 e chiave Abitudini non applicate al server.
L’iPhone collegato è stato riletto alla 119 dopo l’aggiornamento dell’utente, non alterato dai test.
Restano pubblicazione API/worker, chiave dedicata e migrazione 0054 dopo backup, upload 120,
smoke runtime e prova hardware con visite reali; Apple Salute resta successiva.
Note e protocollo di verifica in [build 120](releases/build-120.md); limiti/costi Copilot nella
[ricerca 28](research/28-habits-implementation.md). Modifiche estranee a backup/configurazione/assets preservate.

### Abitudini e revisore Copilot — prima implementazione verificata, non pubblicata

10 novembre 2026. Copilot CLI aggiornato 0.0.335 → **1.0.108** e verificato con due revisioni reali
sul provider GitHub Copilot, Auto → GPT-6.1 Sol. Circa **8,32 crediti Copilot** complessivi; nessun
trasferimento di quota a Codex. Snapshot dei soli sorgenti, tool di lettura/scrittura/esecuzione e MCP
indisponibili, nessun dato privato o credenziale inviato. Riscontri riprodotti e corretti.

Prima implementazione Abitudini: skill per account spenta, consenso sul singolo dispositivo,
visite Core Location/coda cifrata, archivio backend cifrato e RLS (nuova **0054**, soltanto locale),
retention/pausa/cancellazione, luoghi confermati distinti dalle routine inferite, domande entro budget,
sezione nell'app e invito discreto in chat, contesto AI pertinente con consenso revocabile.
Ripresa offline entro lease di 24 ore usando soltanto impronte di identità account; niente chiavi API
nel registro locale. Default senza chiave backend: indisponibile, mai archiviazione in chiaro.

Revisione: invalidazione richieste al cambio account/pausa; consenso mai ereditato da un altro iPhone;
revoca localizzazione ferma anche gli invii; blocco locale persistente prima della cancellazione;
alias delle visite e retry dopo eliminazione; retention non può resuscitare dati scaduti; inferenza
ordinata e con fuso giornaliero stabile, pruning prima delle domande. Dettagli e limiti in
[ricerca 28](research/28-habits-implementation.md).

**106 test backend** in nove suite superati (21 Abitudini, PostgreSQL isolato/RLS e HTTP reali),
TypeScript/Biome/diff verdi. **9 test iOS** superati sul Mac dell'ufficio, Xcode 27.2 dopo accettazione
licenza da parte dell'utente: account/consenso/pausa concorrente, coda cifrata e contratto upload;
render chiaro/scuro a caratteri accessibili con verifica OCR e visiva. Nessun dato personale nei test.

Nessuna nuova build distribuita, nessuna migrazione/chiave/servizio modificato in produzione.
TestFlight resta **119**, API pubblicata resta **fe3a60f**. Prima del rilascio: verifica dispositivo reale
(Core Location/permessi/background/batteria), archivio riproducibile, chiave dedicata e backup,
via libera alla pubblicazione/migrazione. Apple Salute ancora non implementata.

### Correzione resolver promemoria — API pubblicata

10 novembre 2026. Diagnosi in sola lettura delle interazioni segnalate: il resolver ha riproposto
la stessa scelta di funzione tre volte. Il client inviava la sola etichetta del pulsante; mancava una
continuazione persistente della richiesta originale. Jev sceglieva la funzione corretta sotto soglia,
quindi il resolver ripeteva la domanda. Nessuna chiamata di creazione promemoria nello scambio esaminato.

Correzione backend: richiesta/scelta conservate in Redis per account e sessione, scadenza dieci minuti,
consumo atomico una volta; scelta ripresa senza un nuovo giro di chiarimenti. Un messaggio diverso o
un allegato scarta la domanda pendente; skill ricontrollata al momento della risposta. Comando esplicito
«Imposta un promemoria» al modello per testo/orario, senza elezione artificiale della funzione.
Questioner può dichiarare capability=null quando non c’è ambiguità; etichette brevi per promemoria a
argomento e indicazioni, mai descrizioni/esempi troncati. Compatibile con la build 119, nessuna migrazione.

**81 test in sei suite superati**, inclusi riconnessione e Redis reale (consumo concorrente, scadenza,
isolamento account/sessione); TypeScript e Biome verificati. Nessun modello reale o promemoria personale
modificato nei test. Pubblicazione API autorizzata ed eseguita da Git `fe3a60f`, immagine `a50890ae…`; worker e TestFlight
restano alla 119. Smoke sui moduli pubblicati con sessione/Redis reali e account sintetico: richiesta
originale conservata dopo riconnessione, scelta consumata una volta, comando esplicito senza resolver;
zero chiamate provider/creazioni promemoria, fixture rimosse. Salute HTTPS ancora cifrata e disponibile.
Backup `ernie-pre-resolver-20261110`; configurazione/worker/Postgres/Redis invariati.
Abitudini in implementazione come descritto sopra; Apple Salute successiva. Nessuna delle due attivata.

### Build 119 — Salute pubblicata e verificata

10 novembre 2026. Pubblicazione autorizzata dall'utente. **API e worker 119 attivi e sani**, immagine
f317e2d6…, sorgenti `203542a5753092c6a641e45a03f4ddb014484ef6` su GitHub. **0052/0053 applicate** dopo
backup aggiornato a writer fermi. Chiave Salute dedicata configurata, copia di recupero privata separata
anche fuori dal server; non pubblicare o trasferire la chiave nei sorgenti/log.

Inventario finale: nessun dato legacy da trasferire, 21 vault senza percorsi Salute correnti/storici.
CLI migrazione ready, zero record trasferiti e zero consensi attivati. Consultazione/importazione manuale
indipendente da AI; analisi richiede skill e consenso esplicito revocabile. Nessuna sync Obsidian o copia
nella chat principale. Backend capace di decifrare: non dichiarare E2EE. Diario separato.

**117 test backend, 48 iOS** e render chiaro/scuro/Borg/accessibility3 passati. Smoke HTTPS reale con
fixture sintetiche passato: isolamento, cifratura, export, consenso/revoca, cancellazione; fixture rimosse,
zero LLM/operazioni SSH/provider. Postgres/Redis e configurazioni precedenti invariati, solo nuova chiave
a .env. Recupero e limiti in [rilascio 119](releases/build-119.md) e [ricerca 27](research/27-health-vault-integration.md).

**119 disponibile su TestFlight Interni**, stato Apple **VALID / IN_BETA_TESTING**, Build ID
`3ad9737e-c595-4a05-bbf1-cebffe82e90a`. Note italiane rilette e identiche al changelog (927 caratteri).
IPA e manifest Mac Studio in
`~/Library/Caches/ernie-builds/build-119-20261110-health/`. Non ricaricare un duplicato.
Backup operativo `ernie-pre-119-20261110`; non riattivare vecchi writer Salute automaticamente.
Abitudini e Apple Salute non attivate. Modifiche preesistenti fuori ambito preservate.

### Ultimo rilascio effettivamente pubblicato

**119**, 10 novembre 2026: API/worker, migrazioni 0052/0053 e TestFlight Interni verificati,
come descritto sopra. Sorgenti della build `203542a`; i successivi commit aggiornano la documentazione.

### Rilasci precedenti

**10 novembre 2026**, Codex — **API e worker 118 pubblicati e sani**, migrazione **0051**
applicata dopo backup e date esistenti invariate. Immagine `b7d5e6e8…`, sorgenti `a56ea55`; 17 moduli compilati
identici ai test. Smoke sintetico HTTPS/DB passato, zero LLM e operazioni su host gestiti; fixture rimosse.
Prova Firecrawl su due pagine pubbliche e cache passata. Postgres/Redis e configurazioni invariati.
**Build 118 disponibile su TestFlight**, gruppo **Interni**, **VALID / IN_BETA_TESTING**; Build ID
`21ea7472-c461-4a85-b530-673699a853d3`, stessa IPA firmata/verificata e hash invariato dopo upload.
Note italiane rilette e identiche al changelog, 1.529 caratteri. Pubblicazione autorizzata dall'utente.
Backup/recupero `ernie-pre-118-20261110`; ricevute e confini in [build 118](releases/build-118.md).

Rilascio precedente: **10 novembre 2026**, Codex — API **pubblicata e sana**, build **117 disponibile su TestFlight**,
gruppo **Interni**, **VALID / IN_BETA_TESTING**. Build ID `e2b157be-606b-46c2-b3fc-19a8fbbdb974`;
note italiane rilette e identiche al changelog (1.739 caratteri). Pubblicazione autorizzata esplicitamente dall’utente.

- Promemoria: Modifica solo nel menu; Sveglia/Email azionabili direttamente con icone senza label,
  colore e simbolo pieno/vuoto. Componente comune chat/raccolta, richiesta email mancante conservata,
  giorno non duplicato, aree 44 pt e VoiceOver. Verificati chiaro/scuro/Borg e caratteri grandi.
- Voce Drama **15% più veloce**, tramite `atempo=1.15` prima della normalizzazione già esistente; registro,
  prompt, modello e obiettivo di volume invariati. Modifica backend attiva anche per le build precedenti;
  nessuna doppia accelerazione iOS, ripiego locale invariato. Prova sul server: frequenza 169,91 → 170,02 Hz.
- Maximize: skill disponibile ma **spenta per account**; modello/provider/sforzo per conversazione,
  congelati nella coda. Cataloghi reali, permessi e controllo genitori, nessun fallback silenzioso.

Sorgenti finali **`6b5a9bb54f53b17c1ad28d849c563fa879d17ae5`** pubblicati e SHA remoto verificato prima
dell’archivio. 304 input iOS identici a Git, 303 ai test nativi; soltanto il changelog finale differisce,
validato separatamente. **125 test backend e 35 iOS superati**, TypeScript/Biome verdi; firme Apple Distribution
ed entitlement dei quattro bundle verificati, isolamento diario conservato. Nessuna prova su iPhone fisico.
Le prime compilazioni 117 (`6db4934` e `a17ddd1`) sono superate e non sono state caricate.

API dalla stessa revisione, immagine **`b4101522…`**, health HTTPS `ok`, container healthy, 14 moduli compilati
identici al codice testato. Solo API ricreata, worker/Postgres/Redis/configurazioni invariati; nessuna migrazione.
Smoke HTTPS sintetico: catalogo 292 modelli (quattro Anthropic), skill spenta, revoca/kill switch/guardian/scope
verificati, account e chiave temporanei eliminati; zero chiamate LLM. Account reali invariati.
Backup `ernie-pre-maximize-20261110`, recupero API `ernie-app:pre-maximize-20261110`.
[Manifest, verifiche e stato distribuzione](releases/build-117.md).

### Ricognizione delle richieste ancora aperte — 10 novembre, dopo la 117

L'utente ha autorizzato di **aggiornare la roadmap e chiudere i punti aperti**. Stato corrente e criteri di
chiusura in [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md), R1–R10. **Build 118 pubblicata e verificata**:
ricerca web, strumenti comuni, comandi SSH, accuratezza referti e budget automazioni implementati.
Dettagli in [ricerca 25](research/25-open-features-wave1.md), verifiche e ricevute in
[build 118](releases/build-118.md). La protezione e il consenso Salute sono ora pubblicati nella 119;
Abitudini e HealthKit restano da implementare e provare su dispositivo.
Sospensioni Instagram/rete VPS conservate. API **e worker** pubblicati prima del client, migrazione 0051
applicata e verificata. La 118 è ora disponibile al gruppo TestFlight Interni.
Verifiche: **191 test backend, 42 iOS**, TypeScript/Biome verdi; database temporaneo con RLS,
render chiaro/scuro/caratteri accessibili e revisione indipendente. Sorgenti 118
**`a56ea5533247fc7dea8e0de8ea334b356de2bb88`** su GitHub, verificati prima dell'archivio Mac Studio.
306 input iOS identici a Git e ai test; quattro firme Apple Distribution/entitlement verificati,
isolamento diario conservato. IPA SHA-256 `451e6049e1086d34b508ae4003bf56782df6e5d8e52b21a21591b13e99ced423`.
Nessuna nuova raccolta sensibile o prova su iPhone fisico. Upload 118 concluso e disponibilità TestFlight verificata.

Confrontati richieste, codice, specifiche e configurazione del backend in sola lettura. Nessuna nuova
funzione sviluppata o impostazione cambiata durante la ricognizione precedente all'autorizzazione.

- **Abitudini**: specifica definita, manca la skill con visite in background, archivio cifrato, apprendimento
  dei luoghi, domande attive e contesto pertinente. La posizione occasionale già esistente non equivale allo storico.
- **Salute**: archivio dedicato cifrato, consenso revocabile, consultazione/importazione manuale ed export
  esplicito pubblicati e verificati nella 119. Migrazione completata, nessun referto legacy trovato da trasferire.
  Restano HealthKit/sincronizzazione e verifica hardware su iPhone; backend capace di decifrare, non E2EE.
- **Analisi immagini**: catalogazione visiva/OCR e ricette presenti; manca il percorso generale Jev multimodale
  più domande/analisi dell'immagine della ricerca 24.
- **Ricerca online**: pubblicati passaggi pertinenti, letture parallele limitate, copertura, freschezza e cache
  per account. Verifiche simulate e prova Firecrawl su due pagine pubbliche verdi; nessuna misura generale di latenza.
- **Strumenti e prestazioni**: task paralleli/precisazioni e `time_windows` pubblicati. Per la 118 implementati
  gli strumenti comuni mancanti nella 117: `day_snapshot`, `resolve_target`,
  `change_preview/change_apply`, `read_sources`, `check_result`. Patch/verifica limitate ai Todo esistenti;
  budget e prove versionate non sostituiscono i permessi. Il miglioramento generale non è quantificato.
- **Configurazioni**: nell'account owner con inventario SSH e chiave attiva più recente risultano 5 server,
  staging3 incluso, e 38 siti. Vultr configurato (`connected=true`, ultima verifica registrata 23 ottobre);
  nessuna credenziale Contabo registrata. Nessuna nuova prova verso i provider o i server gestiti.
  `YOUTUBE_API_KEY` assente nel container API: codice Data API predisposto, configurazione ancora mancante.
- **Sospesi per scelta dell'utente**: Instagram e modifica di rete del VPS Contabo; non riaprirli automaticamente.
- **Importazione delle nove foto ricetta**: la precedente nota operativa riportava solo conversione HEIC.
  Non trovata qui una ricevuta di importazione; stato da verificare sui contenuti, senza dichiararlo completato.

La sezione storica «Aperto» più sotto non è tutta corrente: salvataggio chat fuori dal main risolto nella 115;
paginazione Vultr presente. Comandi iOS di rimozione server/siti pronti per la 118, con revisione/snapshot
confrontati atomicamente dal backend. API da pubblicare prima del client; nessun host remoto modificato.
Budget giornaliero automazioni corretto nel fuso della singola automazione, provato su PostgreSQL.

Stato del rilascio precedente: **10 novembre 2026**, Codex — nuove schede promemoria approvate e implementate.
Essenziale in chat e nella raccolta, timeline con avviso/appuntamento espliciti; menu con annullamento
confermato, editor comune con interruttori dei canali, palette avatar e testo accessibile. **18 test nativi
verdi** in tre suite, rendering reale di 11 schede e due editor. Build **116 disponibile su TestFlight**,
gruppo **Interni**, **VALID / IN_BETA_TESTING**, Build ID `e9642d54-9cb7-4660-83fe-1a433c1a354d`.
Sorgenti `603cf6e8316db29b90f31c207b295ae8fce58fc2` pubblicati prima dell'archivio, 302 input iOS identici
a Git e ai test sul Mac Studio. Quattro firme Apple Distribution/entitlement verificati e note italiane
rilette (823 caratteri). Backend e promemoria reali invariati. [Verifiche e rilascio](releases/build-116.md).

Altre richieste e stato delle specifiche (non incluse nella 116):
- [Ricerca web, abitudini e salute](research/22-web-and-habits.md): Firecrawl funzionante, attuale taglio
  ai primi 3.000 caratteri da migliorare. Storico spostamenti nel backend personale cifrato e contesto
  pertinente consentito ai modelli esterni. Domande attive per dare significato a visite/luoghi/clienti,
  fatti osservati distinti da ipotesi. Skill **Abitudini** disattivabile: stop effettivo a raccolta, job e
  uso automatico. Revisione globale al massimo quotidiana, risposte utente consolidate nell'area interessata.
- Estensione della skill **Salute** con HealthKit e profilo personale; esiste già l'importazione referti,
  manca HealthKit. Scelto esplicitamente **consenso AI continuativo revocabile** per Salute. Migrare anche
  le copie/derivati esistenti alla cifratura prevista; note “private” non equivalgono a contenuto cifrato.
  Salute e Abitudini hanno interruttori indipendenti per account. Nessun accesso implicito al diario o agli
  archivi chat. Domande proattive in un'unica coda/budget, senza attribuire diagnosi da pattern indiretti.
- [Maximize](research/23-maximize.md): implementato per la 117, con Anthropic diretto e OpenRouter.
  Verificati dal vivo catalogo e due turni sintetici con strumento (Fable 5.2 e Sol 6.1); nessun dato personale.
  Il test del gateway precedente conferma Sonnet funzionante: SDK converte `disabled` in `between_tools`;
  ora la conversione è esplicita. Nessuna modifica del modello automatico configurato sugli account.
- [Analisi immagini](research/24-image-analysis.md): nuova skill proposta, Jev multimodale per domande
  strutturate e modello visivo per dettagli/risposte; riuso Media/ricette/Brain, niente analisi reali nuove.
  Il percorso allegati corrente passa a Jev solo i metadati; la catalogazione Media già usa un LLM visivo.

Nessuna nuova raccolta/permissione di posizione o Salute attivata, né nuove preferenze/modelli sugli account.
Abitudini/HealthKit/analisi immagini restano in specifica. Maximize è un incremento separato dalla UI promemoria.

Rilascio precedente: **9 novembre 2026**, Codex — ottimizzazione performance, compiti paralleli e uniformità UI.
**Build 115 disponibile su TestFlight**, gruppo **Interni**, Apple **VALID / IN_BETA_TESTING**;
**API pubblicata e sana**. Build ID `dcd20e25-2552-4815-9356-7c4b61c4824b`, note italiane verificate
identiche al changelog (1.179 caratteri).
Sorgenti GitHub `a2f50e5fbbfbb8430093a77c0e9becf2554386cc`, 300 input iOS verificati contro Git e test;
archivio/export riusciti sul Mac Studio, quattro firme Apple Distribution e isolamento diario verificati.
IPA pronta in `~/Library/Caches/ernie-builds/build-115-20261109-performance/export-profile-api/Ernie.ipa`.
Via libera esplicito per API/TestFlight ricevuto il 9 novembre. Upload riuscito senza errori; caricata la stessa IPA verificata.
Fino a tre sessioni nell’app, risolutore light per precisazioni/nuovi compiti, scelte nei dubbi e messaggi
in attesa conservati. Primo testo immediato, frammenti successivi raggruppati, preparazione contesto/agente
sovrapposta e salvataggi locali su coda dedicata. Scritture tool serializzate per account nel processo;
nuovo calcolo deterministico `time_windows`. Diario/Archivio chat restano separati.
Stile condiviso per pulsanti e schede in chat, ricette, Todo, promemoria, Brain e Archivio chat.
**111 test backend, 47 iOS**, TypeScript/Biome e quattro casi sintetici col modello reale verdi.
Misure iniziali: 14 turni iOS 114, primo contenuto mediano 3,48 s, p95 35,75 s: campione piccolo,
nessuna percentuale di accelerazione generale dichiarata. Piano strumenti e limiti in
[performance e concorrenza](research/21-performance-concurrency.md), stato artefatto e rilascio in
[build 115](releases/build-115.md). API dalla stessa revisione `a2f50e5`, immagine `d3d57a72…`,
health HTTPS `ok`, dodici moduli compilati verificati. Worker/Postgres/Redis e configurazioni invariati;
nessuna migrazione. Smoke HTTPS sintetico passato: precisazione/nuovo compito/domanda, autorizzazioni,
registro consumi e rimozione account di prova. Backup `ernie-pre-performance-20261109` e immagine omonima.
Modifiche preesistenti a documentazione, backup e asset non pertinenti conservate ed escluse dal commit.

Rilascio precedente: **5 novembre 2026**, Codex — implementazione della skill **Archivio chat**, autorizzata dall’utente.
Scelto il **backend** per testi e indice, isolati per account e conversazione; sostituisce l’ipotesi locale
nell’analisi sotto. Import TXT/ZIP solo testo, confronto incrementale conservativo, fonti originali e ricerca
per chat/mittente/periodo. Catalogo con titolo, descrizione modificabile, tipo, date e indice pronto.
Interrogazioni in agente dedicato senza memoria, strumenti o Brain; consenso AI esplicito, costi nel registro
ordinario. I riferimenti espliciti dalla chat principale aprono la sezione separata prima della persistenza:
scelta fra archivi quando ambiguo, solo metadati per individuare la chat. Nessun riversamento automatico nel Brain.
Unica esportazione al Brain: azione dell’utente, anteprima modificabile e conferma. Import e ricerca testuale
non usano LLM. Contesto delle risposte limitato e copertura parziale dichiarata, prove citate verificabili.
WhatsApp: numero internazionale per aprire una privata con bozza; link salvato per gruppi/canali, condivisione
manuale come alternativa. Nessun invio automatico e nessuna sincronizzazione diretta WhatsApp.
**56 test backend verdi (7 PostgreSQL reali), 23 iOS verdi; TypeScript e Biome verdi.**
Rendering nativo verificato in chiaro/scuro/Borg e caratteri accessibili. API **pubblicata e sana**, sorgenti
`5734a281ebf09e716ff453bcc68ff6f8754ccb03`, migrazione 50 sola, immagine `ae6ff1f3…`,
worker/DB/Redis invariati. Prova LLM reale e smoke HTTPS sintetici passati; fixture eliminate.
Build 114 **disponibile su TestFlight**, gruppo **Interni**, **VALID / IN_BETA_TESTING**; archivio/export,
firme dei quattro target e 297 input Git verificati sul Mac Studio. Build ID
`1bf03f8d-f095-43b5-bed4-9d97486cbf17`; note italiane rilette e conformi al changelog (899 caratteri). Dettagli e stato in
[build 114](releases/build-114.md). File preesistenti estranei conservati ed esclusi dal rilascio.

Ultima correzione backend: **1 novembre 2026**, Codex — correzione presentazione del resolver **pubblicata su staging3**.
La riga «Ho inteso» mostrava la descrizione della capacità scelta, copiando esempi dal catalogo (caldaia/Lego).
Il controllo ordinario `request` ora resta interno: niente riga né pulsante «Correggi». Le vere domande
irrisolte restano schede esplicite con pulsanti; i titoli delle capacità integrate sostituiscono le descrizioni.
La capacità è separata dalle interpretazioni semantiche, anche quando due domande hanno lo stesso «about».
Instradamento, soglie, permessi e audit delle risposte restano attivi; nessuna modifica ai luoghi o alle chat salvate.
**96 test verdi** in cinque suite, due regressioni rosse sul codice precedente, TypeScript e Biome verdi.
API sorgenti **`660de62f39e440353fa7b11a805b2dd57653128c`**, immagine
`sha256:c78b004565e0c5d2884718edcc104438cfa8d27b4e1970066d71e07ff95debbe`, health pubblico `ok`, container `healthy`.
Tre moduli compilati identici al codice testato e prova nel container senza LLM/account: capacità conservata,
significati separati e nessun blocco visibile per `request`. Ricreata soltanto l’API; worker/DB/Redis invariati.
Backup `/srv/staging3/backups/ernie-pre-resolver-presentation-20261101/checkout` e immagine
`ernie-app:pre-resolver-presentation-20261101`; configurazioni intatte, nessuna migrazione.
Solo backend: nessuna nuova build iOS, resta la 113. Stato in [presentazione resolver](releases/backend-2026-11-01-resolver-presentation.md).

Rilascio iOS precedente: **1 novembre 2026**, Codex — build **113 disponibile su TestFlight**, gruppo **Interni**.
Apple: **VALID**, **IN_BETA_TESTING**; Build ID `18e62402-c242-4585-80d9-73a80d916084`, note italiane rilette (232 caratteri).
Correzione esplicita dell’utente: `/clear` lascia l’area della chat vuota, senza testi, conferme o pulsanti
per tornare ai contenuti nascosti. Rimossi metodo di ripristino e invito nell’aiuto. Contesto, sessione,
richieste e persistenza della pulizia restano invariati. Nessun deploy backend o cancellazione lato server.
**26 test verdi in cinque suite**, compreso il controllo nativo di tutti i pixel: solo sfondo uniforme
in chiaro, Borg e con caratteri grandi. Sorgenti **`650ff4c0ae7c9837c603ca08caec93887c9f1c6f`** pubblicati
prima dell’archivio sul Mac Studio; **290 file iOS** identici al codice testato e all’export Git pulito.
Archivio/export riusciti, IPA Apple Distribution verificata su app e tre estensioni; caricata la stessa IPA
(81.139.035 byte), firma e isolamento diario conformi. Nessuna installazione diretta su iPhone.
Dettagli e stato effettivo: [build 113](releases/build-113.md).

Rilascio iOS precedente: **1 novembre 2026**, Codex — build **112 disponibile su TestFlight**, gruppo **Interni**.
Apple: **VALID**, **IN_BETA_TESTING**; Build ID `6f729ecb-4a51-424f-aa01-0fb3ae7eefde`, note italiane rilette (674 caratteri).
Comando locale `/clear`: nasconde messaggi e schede esistenti, mantenendo sessione, contesto, coda, richieste
attive e cursore replay. La visualizzazione viene ricordata per conversazione sul telefono;
«Mostra la cronologia» la ripristina. Il comando non viene inviato al server e non usa AI/token.
**26 test iOS verdi in cinque suite**, anteprime native chiaro/Borg/caratteri grandi ispezionate.
Sorgenti **`c90cacd9d7e0d6236754bc8829513005a67c6fef`**, SHA GitHub verificato prima dell’archivio sul Mac Studio;
**290 file iOS** identici al codice testato e all’export Git pulito. Archivio/export riusciti, IPA Apple Distribution
verificata su app e tre estensioni; caricata la stessa IPA (81.143.540 byte), firma e isolamento diario conformi.
Nessun deploy backend, migrazione o installazione diretta su iPhone. Stato e manifest in [build 112](releases/build-112.md).

Rilascio backend più recente: **1 novembre 2026**, Codex — risolutore comune **pubblicato su staging3**.
Preferenza esplicita: più sensibilità nel riconoscimento, accettando qualche falso positivo di analisi/domanda.
Tutte le capacità attive sono visibili a Jev; segnale operativo da 0,30, risoluzione almeno da 0,80.
Domanda sulla capacità obbligatoria nello schema LLM e opzioni vincolate agli ID attivi; risposta Jev in batch.
Dubbi residui: pulsanti nativi e stop prima dell’esecuzione; richiesta/domanda conservate prima della presentazione.
Esito «solo consiglio»: blocco effettivo di scritture ed effetti esterni, non soltanto istruzioni al modello.
**105 test verdi**, TypeScript verde, regressione rossa sul codice precedente; prova reale 5/5 richieste,
0/4 falsi positivi nel piccolo corpus e LLM→Jev positivo con schema obbligatorio. Non è una garanzia statistica.

API sorgenti **`115f8718fcbaa6dfbf10a5514ae06983bb6b9afc`**, immagine
`sha256:ea1ce1c27fbba5de5fec9a73e9d018982d662920dc8f242c98898bc9a9c8d377`.
Health pubblico `ok`, container `healthy`, nove hash di moduli/SQL identici al codice locale testato.
Applicata soltanto la migrazione **0049**, che amplia il tipo di audit; prima provata su tabella TEMP e rollback.
Ricreata la sola API; worker, Postgres e Redis non riavviati. Nessuna modifica a liste o azioni utente nei test.
Nessuna nuova build iOS: resta la 111. Backup checkout/DDL e immagine `ernie-app:pre-request-resolver-20261101`
in `/srv/staging3/backups/ernie-pre-request-resolver-20261101/`. Dettagli in
[risolutore richieste](releases/backend-2026-11-01-request-resolver.md).

**Deploy rootless:** la maschera 077 è solo per il backup. Ripristinare `umask 022` prima del checkout Git,
o eseguire il checkout come staging3: i sorgenti devono restare leggibili al builder. Un primo tentativo
aveva creato file root 0600 e falliva per esportazioni mancanti; corretti i soli 18 file tracciati coinvolti
con proprietario staging3 e permessi Git, poi compilazione riuscita. API precedente sempre sana fino al cambio.

Rilascio precedente: **1 novembre 2026**, Codex — correzione backend Todo **pubblicata su staging3**.
Indagine in sola lettura: richiesta di «programmino veloce» instradata su `ricordami`, senza candidata
né categoria Todo; il modello aveva scritto soltanto testo anche dopo «Ok», senza salvare una lista.
Correzione: esempi Todo, categoria visibile a Jev, richiamo semantico quando manca una procedura guidata,
salvataggio della proposta confermata quando i dettagli sono sufficienti, senza nuovi avvisi impliciti.
**84 test verdi**, regressione rossa sul codice precedente, TypeScript e Biome verdi.
Prova con il modello heavy configurato e archivio solo in memoria: chiarimento iniziale sulle durate,
poi `get_time`/`todo_lists`/`todo_save` dopo «Ok», scheda scheduled con quattro attività e zero avvisi.
Nessuna modifica alle liste reali né nuova build iOS: resta la **111** su TestFlight.

API da Git **`19927308891c56408605b146cb07f3f9cd78c34a`**, immagine
`sha256:51c18a1a7fb75e97d799fb60be77919d422bbc1200da599cf1758a08b221d741`.
Health pubblico `ok`, container `healthy`; tre moduli JS compilati identici ai file locali testati.
Worker immagine/avvio invariati; DB, Redis, configurazioni e migrazioni non toccati.
Backup: `/srv/staging3/backups/ernie-pre-todo-planning-20261101/checkout`, immagine
`ernie-app:pre-todo-planning-20261101`. Il campo versione del health resta quello preesistente della 106:
identificare il deploy da SHA Git e immagine. Dettagli: [Todo del 1 novembre](releases/backend-2026-11-01-todo-planning.md).
Il wrapper `docker-staging3` cambia directory quando eseguito da root: usare Compose con
`--project-directory` e percorsi assoluti a `docker-compose.yml` e override, senza modificare `.env`.

Rilascio iOS precedente: **29 ottobre 2026**, Codex sul Mac dell’ufficio — build **111 disponibile su
TestFlight**, gruppo **Interni**. Apple: **VALID**, **IN_BETA_TESTING**; note italiane rilette (765 caratteri).
`/promemoria` apre l’elenco; con testo invia una richiesta di creazione/modifica/annullamento.
`/ricordami` prepara una bozza e con testo invia al normale flusso di conversazione. Suggerimenti con esempi,
icona e accessibilità distinguono navigazione e richiesta. Nessuna chiamata diretta a tool: permessi,
chiarimenti e recupero del turno restano quelli esistenti. Le richieste possono usare AI e token.
Skill «Ricordami» controllata per account, URL e note conservati. **19 test iOS verdi in tre suite**.

Sorgenti **`7c7acb4e3fb6e212e203fccb5bde9bb90db93dcf`**, pubblicati su GitHub prima della compilazione
sul Mac Studio da export Git pulito: **290 file iOS** identici ai sorgenti e al manifest SHA-256.
Archivio Release ed export riusciti; IPA Apple Distribution verificata su app e tre estensioni alla 111,
permessi conformi e diario privato solo nell’app principale. Caricata la stessa IPA verificata,
81.133.239 byte, Build ID `b1d80a6e-45ab-4af8-97b3-de4bdd272483`.
Xcode dell’ufficio richiede la nuova licenza; test, archivio ed export eseguiti sul Mac Studio.
Nessuna chiave copiata, nessun cambiamento al Portachiavi, nessun invio o promemoria reale nei test.
Nessuna installazione diretta su iPhone, nessuna nuova prova con LLM reale.

**Backend al rilascio della 111**: nessun deploy; allora API staging3 a `f961ab0`, worker `72a027e`.
Dettagli: [build 111](releases/build-111.md); comandi iniziali in [build 110](releases/build-110.md).
Documentazione/backup modificati preesistenti e asset non tracciati restano esclusi.

### Resolver generale delle richieste — prima versione del 1 novembre

La discussione è diventata un incremento backend pubblicato: preflight comune per le richieste
potenzialmente operative, domande del modello leggero, risposta Jev, scelta fra capacità attive e domanda
alla persona quando necessaria. La preferenza dell’utente riguarda la sensibilità di rilevazione, non
l’autorizzazione alle azioni. Registrazione e metering comprendono anche la chiamata Jev interna.
Chat certa e comandi deterministici conservano i percorsi esistenti; allegati/video vengono letti prima
senza imporre una funzione dal solo nome/link. Restano i permessi per account e il modello heavy per SSH.

Da estendere dopo questa prima versione: contratto generale che verifichi gli artefatti prodotti da tutte
le skill, stato esplicito/versionato delle proposte fra dispositivi e corpus più ampio con casi misti.
La cronologia della domanda viene conservata; non è un nuovo sistema di approvazione né un tool universale
che esegue operazioni. Nessun modello può inventare fatti, preferenze o consenso per risolvere un dubbio.

### ChatArchive — fattibilità del 5 novembre (decisione backend e implementazione sopra)

**Materiale letto:** tre file Markdown nello ZIP personale `~/Desktop/ChatArchive_iOS_Codex.zip`:
`SPECIFICA_PROGETTO.md`, `PROMPT_CODEX.md`, `AGENTS.md`. ZIP SHA-256
`cb2694fab0735a5fef15e7f8037182201fe1b257bb2a3c215cba4bc9e65f44d2`.
Non contiene un’app, parser o test da migrare: contiene una specifica da adattare. I suoi comandi per creare
un progetto separato non sono stati eseguiti. Analisi SINGLE, sola lettura del prodotto; solo questo handoff
viene aggiornato secondo la regola del repository. Stato runtime/TestFlight non ricontrollato in questa analisi.

**Precisazioni dell’utente dopo l’analisi (5 novembre):**
- Importare solo messaggi di testo da TXT o dal testo contenuto nello ZIP; non acquisire, indicizzare o inviare
  immagini, video, vocali e altri allegati. Conservare nel testo eventuali segnaposto con «allegato non importato».
- Riconoscere nuova conversazione o aggiornamento di una già importata. Confrontare nome/alias, mittenti e
  sovrapposizione di sequenze; il nome non è un identificatore. Collegamento automatico solo con evidenza forte;
  incertezza: scelta chiusa fra candidate e «Nuova chat», con destinazione manuale sempre disponibile.
- Import incrementale: preservare originali e ripetizioni reali, mostrare messaggi nuovi/già presenti/anomalie;
  export identico non aggiunge dati né richiede nuove elaborazioni. Non cancellare messaggi assenti dal nuovo export.
- Libreria dedicata simile a Ricette: ricerca, categorie/tag facoltativi, chat dirette/gruppi, partecipanti,
  intervallo effettivamente disponibile, ultimo import e stato dell’archivio. Aprendo una scheda si seleziona
  esplicitamente il corpus interrogabile; le domande successive e quelle vocali conservano tale ambito.
- RAG per archivio: recupero messaggi per contenuto/data/mittente, contesto vicino e generazione con fonti
  cliccabili. Ricerca testuale con contesto è già una forma di retrieval per AI; indice vettoriale non obbligatorio.
  Eventuali embeddings si aggiungono con limiti/costi e regole di invio espliciti, non come effetto del solo import.
- Tre date/stati separati: (1) ultimo import effettuato, anche se identico; (2) data dell’ultimo messaggio disponibile;
  (3) revisione/data dell’indice realmente pronto. Quest’ultima non va confusa con la data di una sintesi salvata.
  Il sistema espone «Pronto», «Aggiornamento in corso» o errore e non dichiara aggiornato un indice incompleto.
  Durante ricostruzione servire soltanto una revisione coerente, con limite della copertura esplicito.
- Aggiornare l’indice solo per dati nuovi/modificati e invalidare le sintesi interessate; non rielaborare tutta
  la chat a ogni domanda. Un nuovo messaggio può correggere una decisione lontana: recuperare anche le fonti
  precedenti rilevanti. AI su richiesta, eventuale sintesi automatica resta opt-in separato.
- Nei gruppi estrarre i mittenti presenti, conteggi, prima/ultima presenza e alias; mantenere provenienza.
  «Partecipanti osservati nell’archivio» non equivale alla lista attuale dei membri del gruppo.
  Nomi modificati o omonimi non si fondono sulla sola etichetta. Collegamento a Contatti/Famiglia/Brain solo
  se identificabile o confermato dalla persona; nessuna equivalenza globale fra «Marco» in due gruppi.
- Query tipiche: «Che cosa ha scritto Marco sulla gita?», «L’orario è stato confermato?», «Cosa è cambiato
  nell’ultimo aggiornamento?». Risposta con data/mittente/estratto e distinzione proposta/conferma/modifica.
- Requisiti registrati, sviluppo non ancora richiesto. Resta da scegliere archivio sul telefono oppure backend;
  la parola RAG non risolve da sola tale decisione. Nessuna implementazione, build, test o deploy in questa precisazione.

**Esito:** tecnicamente fattibile e conveniente come modulo/skill con schermata propria. Riusare involucro
Ernie (account, palette, condivisione, comandi, AI, voce e spese), mantenendo parser/storage/retrieval indipendenti
da SwiftUI e backend per consentire in futuro anche un’app separata. Resta una funzione sostanziale, non basta
una skill in Markdown. Il target della nuova funzione seguirebbe quello di Ernie (iOS 26 nel checkout), anziché
creare un secondo target minimo iOS 17 come nella specifica originale.

**Verificato nel codice:**
- `ErnieShare/ShareViewController.swift`: PDF/immagini/link/testo; un URL file non PDF è rifiutato. ZIP non gestito.
- `Shared/ShareInbox.swift`: coda App Group già disponibile; l’estensione deve solo ricevere un nuovo job archivio.
- `ErnieShare/ShareModel.swift`: il testo condiviso è oggi spedito al Brain. Gli export vanno intercettati prima
  di quel percorso; tipi file e testo/file generico vanno verificati su WhatsApp reale, con fallback da File.
- `Documents/DocumentReader.swift`: TXT diviso in pseudo-pagine, normalizzato e classificato come PDF;
  `packages/documents/src/repository.ts` lo persiste sul backend. Non è un archivio raw di messaggi locale.
- `apps/api/src/private-diary.ts` e route: precedente utile per elaborazione separata con consenso,
  senza strumenti né memoria del turno; non riusare l’endpoint del diario o le sue chiavi per le chat.
- `Chat/ConversationStore.swift`: precedente di apertura locale prima di persistere/inviare il testo (diario).
  Il normale flusso WS aggiunge contesti generali e avvia `memories.afterTurn`: non è il percorso adatto agli export.
- `packages/documents/src/citations.ts`: pattern riusabile, ma oggi verifica pagine recuperate; per le chat
  servono archivio/import/ID messaggio. Esistenza di un ID non dimostra che la frase AI sia supportata.
- `Brain/BrainResources.swift` e `packages/brain/src/resources.ts`: riferimenti tipizzati solo a ricette/media;
  aggiungere una destinazione archivio richiede lavoro, non basta salvare un link.
- Voce iOS/Drama e registro token/costi già esistenti. Per lettura locale gratuita usare AVSpeechSynthesizer;
  pausa/velocità e player della sezione da completare senza interferire con la risposta vocale della chat.

**Architettura proposta:** archivio locale separato per account e conversationID, con originali/import,
message/occurrence, indice FTS e conoscenza derivata dotata di fonti/stato/versione. Import, ricerca, selezione
fonti e deduplica deterministici fuori dal main; LLM per interpretazione della domanda, sintesi e proposte.
Jev può aiutare a scegliere l’archivio se ambiguo; non decide che due messaggi sono uguali né conferma fatti.
Chiavi modello restano sul backend; estratti passano transitoriamente al backend/provider dopo consenso:
locale non significa AI sul dispositivo. Nuovo endpoint senza contenuti nei log/sessioni/memorie, con
limiti, timeout, revoca/annullamento e metering di soli metadati. Risposta mostrata e salvata nella sezione.
I testi importati sono dati non fidati; analizzatore senza strumenti di scrittura/invio. Todo/promemoria
si creano soltanto da una distinta azione esplicita dell’utente, con i controlli ordinari di Ernie.

**Compromesso da scegliere:** locale preserva offline e invio selettivo, ma il server non può leggere un DB
che risiede sul telefono. Nel primo incremento apertura dalla chat/comando `/archivio`, poi analisi nel modulo
nativo mentre l’app può accedere ai dati. Il dialogo generico con recupero locale automatico richiederebbe
un nuovo ponte client/server per richieste di fonti, non già disponibile. Backend PostgreSQL con RLS e filtro
archivio consentirebbe più dispositivi e analisi autonome; cambierebbe la premessa locale della specifica
e richiederebbe una scelta esplicita. Non costruire subito due archivi master con sincronizzazione.

**Second Brain:** prevedere una voce Archivi nella UI e collegamenti scelti a persone/progetti; i messaggi
restano nel modulo. Per la modalità locale, anche l’indice può restare locale; metadati sul server sono
un’opzione da autorizzare, non necessari al primo import. Solo singoli fatti/sintesi scelti possono essere
pubblicati nel Brain generale; diventano dati sul backend e vanno mostrati come tali. Conservare provenienza,
limiti temporali e stato, senza promuovere la parola di un partecipante a fatto certo sull’utente.
Nessuna inclusione automatica negli snapshot o nel consolidamento heartbeat; rimozione dei collegamenti
quando si cancella un archivio, e semantica distinta per eventuali note già pubblicate volontariamente.

**Sviluppo ordinato, non avviato:**
1. Import TXT/ZIP da File, preview e destinazione, parser, transazioni SQLite, deduplica sequenziale e report.
   Reimport identico 0 nuovi, 100+15=115, ripetizioni vere conservate e chat omonime separate. ZIP con limiti
   di espansione/numero file/percorso, righe non lette conservate e segnalate, raw originale intatto.
2. Sezione con ricerca e filtri temporali offline, fonti apribili e Share Extension con job dedicato.
   Coda temporanea, DB/WAL/SHM e backup devono rispettare protezione dati e proprietà dell’account anche
   dopo logout/cambio account; test su dispositivo del formato realmente passato da WhatsApp.
3. Endpoint AI isolato, consenso, domande rapide, output con fonti validate, copertura e revisioni.
   Identificativi validi non bastano: distinguere proposta/conferma/superamento con testo e ordine delle fonti.
   Sintesi per blocchi entro budget; se il periodo non è coperto integralmente dichiarare la parzialità.
   Cache per archivio/intervallo/versione import, elaborazione del delta con recupero anche delle decisioni
   precedenti interessate. AI su richiesta; eventuale aggiornamento post-import solo come opt-in con costi chiari.
4. Voce, collegamenti Brain e creazione esplicita di Todo/reminder; cancellazione di messaggi, indici,
   derivati e temporanei. Per cancellazione fisica e copie di backup definire una policy, senza promettere
   cancellazione retroattiva da tutti i provider. Valutare esportazione/ripristino protetto per evitare
   che «locale» diventi perdita dei dati cambiando telefono. Face ID opzionale, distinto dalla cifratura DB.

**Limiti:** nessun export WhatsApp reale fornito, nessuna fixture, benchmark o prova iPhone eseguita;
parser e deduplica non ancora dimostrati. Senza ID immutabili il matching può essere ambiguo: revisione manuale,
nessuna promessa di sincronizzazione perfetta e nessuna cancellazione per assenza nel nuovo export.
Nessuna stima numerica di tempi/costi API senza misurare volume, formato e modello sul caso reale.
L’integrazione risparmia infrastruttura e interfacce comuni; il nucleo archivio rimane da sviluppare.

**Fonti primarie consultate il 5 novembre:**
- WhatsApp export iOS: https://faq.whatsapp.com/1180414079177245/?cms_platform=iphone&locale=en_US
  (export manuale ZIP, messaggi view-once esclusi, export distinto dal backup; nessun limite numerico assunto).
- Apple Share Extension: https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/Share.html
  (contenuti passati tramite extensionContext e fine del lavoro prima della possibile terminazione).
- GRDB Full Text Search: https://github.com/groue/GRDB.swift/blob/master/Documentation/FullTextSearch.md
  (SQLite/FTS5 disponibile come opzione; verificare configurazione/build effettiva nell’implementazione).

### Firma e distribuzione senza sbloccare il Mac Studio

**Risolto il blocco per la 107.** La firma Development dell’ufficio ora rifiuta la chiave, ma l’export API
usa la firma gestita da Apple, come nella 106. Compilare senza firma; su una copia dell’archivio usare
`apps/ios/scripts/prepare-cloud-signing.py --profiles-from <archivio precedente valido>` per conservare
profili e permessi. Il prefisso può differire dal Team ID (notifiche legacy): lo script lo risolve per target.
Esportare prima su disco, verificare firma/entitlement e isolamento del diario nell’IPA, poi caricarla con
altool e API Apple. Lo script non produce da solo un pacchetto installabile; non caricare gli intermedi.
Nessuna chiave privata di firma trasferita e nessuna protezione del Portachiavi cambiata. Credenziale API
temporanea rimossa. Interni riceve automaticamente tutte le build: attendere lo stato effettivo, senza
forzare un’associazione manuale via API (rifiutata per questo gruppo).

**Per la 107:** 88 test verdi in 11 suite; sette WAV riproducibili; IPA verificata su app e tre estensioni alla 107.
Evidenze e manifest: `~/Library/Caches/ernie-builds/build-107-20261027-sounds/` sul Mac dell’ufficio.
Restano da provare i suoni sul dispositivo fisico (altoparlante/cuffie e silenzioso). Nessuna installazione
diretta sui telefoni in questa sessione. La precedente 106 resta documentata in [build 106](releases/build-106.md).

### Analisi Cindy — 27 ottobre, nessuna implementazione

Analisi statica del repository `makecindy/cindy`, snapshot
`7be4c57d7bdbed3e115685a5fb1aba61772497c7`: README, memoria, apprendimento notturno, scheduler,
scoperta plugin, componenti delle risposte e setup. Il backend cloud non è incluso in quel repository.
Idee proposte: strumenti scoperti su richiesta; registro degli apprendimenti con fonti/ambito/annullamento;
procedure candidate prima di renderle riutilizzabili; piccole schede per chiarire orari e conflitti;
collegamento di servizi con ripresa dell'intento originale; stato delle operazioni più uniforme.
Ernie ha già snapshot selettivi, preferenze esplicite/inferite, controlli prima del modello, deduplica delle
automazioni, schede native e revisione Brain limitata a 24 ore: estendere queste basi, senza ricostruirle.
Conservare il limite giornaliero, il consolidamento locale dopo un'aggiunta e l'esclusione del diario privato.
Priorità suggerita: chiarimenti interattivi, strumenti su richiesta (misurando token e latenza), poi registro
apprendimenti e procedure versionate. Nodo Mac e multiagenti in seconda fase. Prestazioni/integrazioni Cindy
non provate: nessuna installazione, esecuzione del progetto o modifica applicativa. Nessuna nuova build/deploy.

### Analisi Agent-Reach — 27 ottobre, nessuna integrazione

Analisi statica di `Panniantong/Agent-Reach`, snapshot `14c213405669414492bda0f8d52cc6531d062c45`
(v1.6.0, MIT). Interessanti: contratto JSON comune con fonte/backend/tentativi, fallback classificati,
pausa dei backend guasti e diagnostica per canale; ricerca YouTube e sottotitoli come percorso economico.
Il canale YouTube usa yt-dlp per metadati/search/subtitle; l'ASR scarica audio, usa ffmpeg e richiede Groq
oppure OpenAI diretto, senza supporto OpenRouter nel codice esaminato. Non è una soluzione a costo zero
universale né evita la gestione media sul server quando serve ASR.
Instagram è sperimentale, con browser/login: azioni search utenti, profile e posts recenti, nessuna azione
specifica Reel-URL → trascrizione. Non risolve da solo le scritte nei fotogrammi.
Ernie ha già metadati e analisi visiva YouTube via OpenRouter/Google AI Studio senza download locale:
valutare sottotitoli come alternativa per riassunti, conservando visione per ricette con dati sullo schermo.
Riuso selettivo da provare sul VPS con limiti di durata/costo e isolamento degli account; browser/cookie non
vanno condivisi fra utenti Ernie. Nessuna installazione, accesso account, servizio aggiunto, build o deploy.

### Implementazione selettiva Agent-Reach — 27 ottobre, build 108

Autorizzata dall’utente dopo l’analisi. Contratto di provenienza YouTube; tentativo di sottotitoli pubblici
solo per riassunti espliciti, fallback visivo e pausa per account; diagnostica GET `/v1/content-readers`
con esiti Redis a scadenza 24h, schermata iOS in Diagnostica. Ricette e immagini conservano il video.
Nessun nuovo provider, cookie, audio scaricato o integrazione Instagram. 101 test backend e TypeScript verdi;
23 test iOS verdi in tre suite; API pubblicata, 108 disponibile su TestFlight/Interni. I tre link pubblici provati non hanno dato sottotitoli utilizzabili:
il risparmio reale resta da misurare. Dettagli e limiti in [build 108](releases/build-108.md).

### Schede messaggi in famiglia — 27 ottobre, build 109

Destinatario, urgenza, ora, testo e conferma riuniti nella stessa superficie. Palette dell’orso e testo grande,
nessun bordo rosso spesso; stati distinti fra invio e lettura confermata. Azioni ricevuti da 44 pt, verticali
con Dynamic Type accessibile. Stesse API e schermata di conferma; il risultato del tool richiede al modello
un riscontro breve senza presumere audio/consegna. 27 test iOS e 10 backend verdi; nessun invio reale di prova.
API pubblicata e 109 disponibile in TestFlight/Interni: [build 109](releases/build-109.md).

### Comandi rapidi — 28 ottobre, build 110

Menu locale con `/`, filtro durante la digitazione, `/messaggio` e testo facoltativo per preparare il
compositore Famiglia. Altri comandi aprono sezioni; `/aiuto` li elenca. Skill attive controllate per account;
errori locali senza perdere bozza o allegati; nessun invio automatico e nessun modello coinvolto.
Intervento solo iOS; backend invariato. 110 disponibile su TestFlight/Interni. Dettagli e verifiche: [build 110](releases/build-110.md).

### Richieste rapide sui promemoria — 29 ottobre, build 111

`/ricordami` con cosa/quando e `/promemoria` con testo usano il flusso di conversazione esistente per
creare, modificare o annullare impegni; senza testo `/promemoria` conserva l’elenco locale.
Esempi nel menu, skill per account, testo/URL/note integri; navigazione locale distinta dalle richieste
che possono usare token. 19 test iOS verdi; 111 verificata su TestFlight/Interni: [build 111](releases/build-111.md).

## Prima di iniziare

1. `git fetch && git status`: lavora sempre sopra `origin/main` aggiornato, senza force push. Le modifiche locali
   estranee non si scartano e non si includono alla cieca.
2. Leggi questo file e l'ultima nota in `docs/releases/`.
3. Prima di compilare o installare l'app confronta: numero dell'ultima build su TestFlight, `Changelog.json` locale e
   build installata sul telefono (`xcrun devicectl device info apps --device <udid> --bundle-id com.websdbm.ernie`).
   Non installare mai una build più vecchia di quella presente.
4. Gli agenti in worktree lavorano in `.claude/worktrees`: la cartella è esclusa da Biome e non va nei commit.

## Stato attuale

| Cosa | Stato |
|---|---|
| App su TestFlight | build **119**, verificata il 10 nov: `VALID`, `IN_BETA_TESTING`, gruppo Interni; sorgenti iOS `203542a` |
| iPhone di Giorgio (ad hoc, account figlio) | build **105** (25 ott, verificata). UDID `00008110-001139321E6B801E`; installazione via Wi-Fi con `apps/ios/scripts/adhoc.sh` quando è nel Wi-Fi di casa e sbloccato. Al prossimo collegamento installare l'ultima build disponibile |
| Server staging3 (`/srv/staging3/projects/ernie`) | API **fe3a60f**, immagine `a50890ae…`; worker **203542a**, immagine `f317e2d6…` (10 nov). API healthy, worker pronto. Recupero API `ernie-app:pre-resolver-20261110`; nessun rollback a writer Salute precedenti alla 119 |
| Migrazioni | fino alla **0053**, applicate e verificate; migrazione Salute completata con zero referti preesistenti da trasferire, nessun consenso attivato |
| Protocollo | v1.**10** (`user.steer` / `assistant.steer`), pubblicato e provato dal vivo |

### Server

Si pubblica **da git**: copia di sicurezza della cartella, `git fetch` + `git reset --hard <commit pubblicato>`
(come root, con `safe.directory`), rimozione di eventuali `._*`, poi come utente staging3
`docker compose build api worker` e `up -d migrate api worker` (migrate applica le migrazioni nuove). Niente copie a
mano. `docker-compose.override.yml` e `.env` esistono solo sul server e non vanno toccati. Pubblicazione in produzione
e scritture sul database di produzione richiedono il via libera esplicito dell'utente. L'API non risponde su
`127.0.0.1:3000` dall'host: verificare da `https://ernie.staging3.eklettica.it/health`.

Usare `umask 022` durante il checkout Git: Docker rootless deve poter leggere i sorgenti. La directory
dei backup resta invece privata. Non estendere permessi a `.env` o override; verificare separatamente i loro
hash. In script passati a SSH via stdin, eseguire `compose run ... < /dev/null` perché il comando interattivo
non consumi il resto dello script. Controllare migrazione, attivazione e runtime come passi distinti.

Copie di sicurezza del 25 ott: `/srv/staging3/backups/ernie-pre-git-sync-20261025/`, immagine `ernie-app:pre-104`.

## Diagnostica dell'app

- **Rapporti di iOS (MetricKit)**: dalla build 63 l'app manda crash, blocchi e chiusure al primo avvio successivo
  (`POST /v1/diagnostics` → tabella `client_diagnostics`). Lettura:
  `SELECT user_id, app_version, kind, period_end, payload FROM client_diagnostics ORDER BY period_end DESC;`
  Per tradurre `Ernie+offset`: `atos -o <archivio>.xcarchive/dSYMs/Ernie.app.dSYM/Contents/Resources/DWARF/Ernie -arch arm64 -l 0x100000000 0x1<offset in esadecimale>` con l'archivio della stessa build.
- **Crash dal telefono collegato**: `xcrun devicectl device info files --device <udid> --domain-type systemCrashLogs`
  e `xcrun devicectl device copy from … --source Retired/<file>.ips`.
- **API in locale con il modello vero**, senza toccare la produzione: Postgres temporaneo
  (`initdb -E UTF8 --locale=C`) e Redis, migrazioni, poi
  `node --import tsx --conditions=development apps/api/src/cli/init-storage.ts` (tabelle di Mastra) e
  `apps/api/src/index.ts` con le chiavi del `.env` locale e `DATABASE_URL` sul ruolo `ernie_app` (il superutente
  scavalca la RLS e falsa i test).

## Fatto il 25 ottobre (build 104 e 105)

Revisione generale delle build 64–103 da sei revisori in parallelo, poi correzioni. Dettagli in
[build-104](releases/build-104.md) e [build-105](releases/build-105.md).

- **Crash**: conferma di lettura degli urgenti (AppDelegate), dettatura del diario, prova vocale in Diagnostica.
- **Diario**: testo privato che finiva in chat; ripristino che sostituiva un diario integro; apertura senza rete;
  eliminazione di pagina e diario; Writing Tools spenti; lettura, decifratura e scritture fuori dal main.
- **Prestazioni iOS**: storico del pannello con indice letto in background, foto ridotte con `CGImageSource` fuori dal
  main, rapporti MetricKit passati serializzati in background, copia dei widget legata all'account,
  `LegacyTranscriber` sotto lock.
- **Server**: YouTube (tempo oltre 40 caratteri; rifiuto con durata sconosciuta o video non pubblico), Todo e cambio
  dell'ora, segreti nell'output SSH, scope chat su speech/usage/performance, diario 503, replay WebSocket, luoghi
  delle foto con titolo neutro e rimossi quando orfani, coda delle risorse Brain senza transazione lunga e con
  tentativi (0047), un solo livello di retry verso i modelli (`maxRetries: 0`), coda `turn-memory` a scadenza,
  budget del gateway nel giorno di Roma, sintesi vocale non addebitata se non parte, PATCH delle preferenze,
  prestazioni, recupero dei promemoria Todo con attesa (0048), conferma di `reminder_create` leggibile, JPEG con più
  SOF, costo della revisione Brain registrato anche in errore.
- **SSH**: rete Tailscale `100.64.0.0/10` solo al titolare, blocklist completata, timeout DNS, limite di frequenza su
  sonde e diagnosi, porte 22 e 1024–65535; revoca, scollegamento e rifiuto anche a skill spenta; rotte di
  cancellazione `DELETE /v1/ssh/servers/:id` e `/v1/ssh/sites/:id`; esito non perso vicino alla scadenza;
  `--allow-root`; istanze del provider lette fuori dal lock; piani invalidati solo quando cambia il permesso SSH.
- **Funzioni nuove (105)**: precisazione scritta o detta mentre Ernie risponde, che entra nel turno al passo
  successivo senza fermarlo (`prepareStep` di Mastra, `packages/agent-core/src/turn.ts`; `onUserSteer` in
  `apps/api/src/ws/connection.ts`); se il turno non ha più passi il server risponde `late` e l'app la manda come
  messaggio nuovo a turno finito. Tocco lungo sui propri messaggi: «Rimanda», «Modifica e rimanda», «Copia».

### Decisioni dell'utente (25 ott)

- **SSH**: la skill resta disponibile a tutti, ma ognuno la usa **solo con i propri accessi**: server, chiavi e
  provider sono per utente (RLS) e nessuno vede quelli degli altri. La rete Tailscale di casa è solo del titolare.
- **Documenti scansionati**: fanno parte del Second Brain come le altre note (non riservati). L'unica parte riservata è
  il **diario personale**, che è una skill separata e cifrata sul telefono.
- Precisazioni durante la risposta: «entra senza fermare».

## Aperto

1. *Salvataggio della chat sul main*: `ConversationStore.persist` → `TranscriptStore.save` codifica e scrive l'intera
   conversazione sul main a ogni aggiornamento. Spostarlo in una coda serializzata richiede di adeguare i test che
   rileggono subito il file. Guardare i rapporti MetricKit della 105: se i blocchi da watchdog (0x8BADF00D) restano,
   è il primo candidato.
2. *Todo, doppio aggiornamento*: ogni salvataggio dalla chat produce la scheda del tool e un evento da
   `todo-reminders` `onChanged` (che serve agli altri dispositivi), quindi sul telefono `TodoStore.apply` e
   `reminders.refresh` girano due volte. Correzione: escludere la connessione d'origine o deduplicare per lista e
   revisione nell'app.
3. *Todo con Redis giù*: il salvataggio risponde errore anche se la lista è salvata; voluto e coperto da test
   (riprovare lo stesso salvataggio riallinea); valutare se dire «salvata, promemoria in sospeso».
4. *Foto*: i luoghi creati prima della 105 hanno ancora il titolo con le coordinate (esclusi dal revisore e rimossi
   quando orfani); rinominarli richiede una migrazione del vault.
5. *SSH*: l'app non ha ancora i pulsanti per le nuove rotte di cancellazione di server e siti; un server salvato su una
   porta sotto 1024 diversa dalla 22 va spostato; limite di frequenza in memoria per istanza; paginazione Vultr;
   sonde HTTP di `site-probe.ts` non riviste.
6. *Spese delle automazioni*: il tetto in `packages/automations/src/repository.ts` usa ancora il giorno UTC.
7. *Diario dopo l'uscita dall'account*: file e chiave restano (si eliminano da «Elimina diario…»); decidere se
   l'uscita debba chiederlo. Tastiere di terze parti sui campi del diario si possono escludere solo per tutta l'app.
8. *WebSocket*: nessun tetto alle connessioni sospese per utente (`ws/plugin.ts`).
9. *Test iOS*: `avvioRealeMicrofonoRiceveBufferEFermaSenzaCrash` aspetta il permesso del microfono su un simulatore
   nuovo (escluderlo con `-skip-testing`); `TerminalChatTests.focusProgrammaticoECambioSkinNellaBarraCompleta` a volte
   fallisce nella suite completa e da solo passa. Sul Mac Studio usare il simulatore «Ernie prova»: «iPhone 17» è
   usato da un'altra sessione.

10. *YouTube dal server*: la pagina del video arriva spesso col controllo anti-bot (IP di Contabo), senza durata.
   Gli Short si analizzano comunque (massimo 3 minuti), i video normali solo quando la pagina è leggibile; altrimenti
   rifiuto «non riesco a leggere la durata». Soluzione stabile: YouTube Data API v3 (`videos.list`
   `contentDetails,status`) con una chiave dedicata, da decidere con l'utente.

## Decisioni in sospeso per l'utente

- YouTube Data API per la durata dei video normali (voce 10 di «Aperto»).
- DNS di riserva sul server (Cloudflare/Quad9 accanto a quelli di Contabo): il 16 ott un guasto DNS di pochi secondi ha
  fatto fallire un turno.

## Registro delle sessioni

- **27 ott 2026 (mattina) — Mac Studio (Claude Code)**: pannello laterale con Spesa e Attività separate e righe
  compatte, giornate passate archiviate (`TodoTime.isArchived`, solo nell'app), unite alla build 106 preparata dal
  Mac dell'ufficio. Server pubblicato a `72a027e` (correzione spesa + parte server degli appuntamenti del 26 ott).
  106 non ancora su TestFlight.
- **27 ott 2026 — Mac Studio (Claude Code)**: spesa, «Aggiungi alla lista di cose da comprare una confezione di porridge»
  aggiungeva la voce «alla» alla Spesa dopo una domanda inutile; corretto il parser (`5abd040`, solo server, da
  pubblicare con il via libera dell'utente). YouTube Data API facoltativa (`46c36a2`, `YOUTUBE_API_KEY`): chiave da
  creare nella console Google (serve che l'utente confermi la password dell'account) e da mettere nel `.env` del server.
- **25 ott 2026 (sera) — Mac Studio (Claude Code + tre agenti in worktree)**: precisazioni durante la risposta e
  messaggi riusabili (protocollo v1.10), provati con il modello vero su API locale (precisazione entrata dopo
  `web_search`, risposta adeguata); chiusura delle voci aperte su SSH, backend, prestazioni e diario dell'app; 944 test
  del server verdi con integrazione su Postgres e Redis reali; build 105 preparata.
- **25 ott 2026 — Mac Studio (Claude Code)**: revisione generale delle build 64–103, build 104, server riallineato a
  git, questo file e la regola dell'handoff in AGENTS.md.
- **16–24 ott 2026 — Mac dell'ufficio**: build 64–103 (widget con scorciatoie, Automazioni, ErnieTRIX, indice del
  Second Brain, Todo con timeline, SSH, media e ricette, consumi, diario personale cifrato). Dettagli nelle note di
  `docs/releases/`.
- **16 ott 2026 — Mac Studio**: stile e lessico, discesa da heavy, memoria (schema dell'estrazione), backup notturno,
  diagnostica MetricKit (build 62–63).
