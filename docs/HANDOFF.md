# Handoff — stato condiviso del progetto

Su Ernie lavorano due agenti: Claude Code sul **Mac Studio** e un altro agente sul **Mac dell'ufficio**. Questo file è il
passaggio di consegne fra loro e va aggiornato **a fine di ogni sessione di lavoro**, nello stesso push delle
modifiche: cosa è cambiato, cosa è pubblicato e dove, cosa resta aperto. Le regole di rilascio sono in
[AGENTS.md](../AGENTS.md), le note di ogni build in [releases](releases/).

Ultimo aggiornamento: **5 novembre 2026**, Codex — analisi di fattibilità **ChatArchive come skill Ernie**.
Letti integralmente i tre Markdown dello ZIP `ChatArchive_iOS_Codex.zip` (5 novembre, specifica v0.1);
nessun sorgente applicativo nell’archivio. Le istruzioni di implementazione allegate sono materiale da
valutare, non un’autorizzazione a sviluppare. Esaminati condivisione iOS, documenti, diario privato,
resolver, citazioni, voce, contabilità e risorse Brain nel checkout `b831fbf`; fonti ufficiali verificate.
**Requisiti precisati dall’utente:** soli testi, riconoscimento e aggiornamento incrementale delle chat,
raccolta simile a Ricette, domande sulle fonti della chat scelta, data di aggiornamento e partecipanti ai gruppi.
**Architettura proposta, non ancora approvata:** skill «Archivio chat» attivabile per account,
modulo nativo locale, accesso alla sezione e interrogazioni limitate alla conversazione selezionata.
Archivio SQLite/GRDB con FTS5; AI tramite endpoint dedicato con consenso, estratti selezionati e contabilità,
senza memoria automatica o tool operativi. Collegamenti al Brain espliciti, nessuna fusione implicita.
Da decidere con l’utente: archivio solo sul telefono oppure modalità backend per più dispositivi/automazioni.
Dettagli nella sezione «ChatArchive — fattibilità del 5 novembre» sotto. **Nessuna implementazione, prova
su chat reali, nuova build o pubblicazione backend**: aggiornamento solo documentale; test non eseguiti.

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

Ultimo rilascio iOS: **1 novembre 2026**, Codex — build **113 disponibile su TestFlight**, gruppo **Interni**.
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

### ChatArchive — fattibilità del 5 novembre

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
| App su TestFlight | build **113**, verificata il 1 nov: `VALID`, `IN_BETA_TESTING`, gruppo Interni; sorgenti iOS `650ff4c` |
| iPhone di Giorgio (ad hoc, account figlio) | build **105** (25 ott, verificata). UDID `00008110-001139321E6B801E`; installazione via Wi-Fi con `apps/ios/scripts/adhoc.sh` quando è nel Wi-Fi di casa e sbloccato. Al prossimo collegamento installare l'ultima build disponibile |
| Server staging3 (`/srv/staging3/projects/ernie`) | API **660de62** (1 nov, presentazione resolver); worker ancora **72a027e**. Recupero API `ernie-app:pre-resolver-presentation-20261101`; vedi nota presentazione resolver |
| Migrazioni | fino alla **0049**, applicate anche sul server |
| Protocollo | v1.**10** (`user.steer` / `assistant.steer`), pubblicato e provato dal vivo |

### Server

Si pubblica **da git**: copia di sicurezza della cartella, `git fetch` + `git reset --hard <commit pubblicato>`
(come root, con `safe.directory`), rimozione di eventuali `._*`, poi come utente staging3
`docker compose build api worker` e `up -d migrate api worker` (migrate applica le migrazioni nuove). Niente copie a
mano. `docker-compose.override.yml` e `.env` esistono solo sul server e non vanno toccati. Pubblicazione in produzione
e scritture sul database di produzione richiedono il via libera esplicito dell'utente. L'API non risponde su
`127.0.0.1:3000` dall'host: verificare da `https://ernie.staging3.eklettica.it/health`.

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
