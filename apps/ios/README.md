# Ernie iOS (M7–M8)

Client SwiftUI per iOS 26: **una sola schermata** in stile chat, con in alto l'avatar (l'orso in pixel art animato a fotogrammi da uno sprite sheet: idle, ascolto, pensiero, bocca sulle parole, emozioni) e un solo pulsante: microfono (un tocco avvia l'ascolto, ↑ invia, ✕ annulla; stato, livello del microfono e trascrizione in tempo reale nella barra), invio quando c'è testo, stop mentre Ernie parla. **Conversazione continua** (M8): con l'impostazione omonima, o tenendo premuto il microfono, il dialogo è a mani libere: la frase parte da sola quando fai una pausa, Ernie risponde e torna ad ascoltarti; mentre parla il microfono è spento (la sua voce non viene mai trascritta) e toccandolo lo interrompi; ✕ chiude. Le richieste di conferma dei tool e le notifiche delle automazioni compaiono come schede dentro la conversazione, con pulsanti che descrivono l’azione e «Annulla» (Face ID o codice per autorizzare). La voce si accende e spegne dal pulsante altoparlante in alto (spenta: solo risposte scritte); le skill *disponibili* si scelgono in Impostazioni → Skill e quelle *attive* si accendono e spengono dal pulsante ✦ accanto al microfono (pannello compatto con cerca, senza azzerare la conversazione); le impostazioni stanno dietro il menu in alto a destra.

## Requisiti

- Xcode 27 (SDK iOS 27), un simulatore o un iPhone con iOS 26.
- [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`) per rigenerare il progetto da `project.yml`; il progetto generato è comunque versionato.
- Backend raggiungibile: in simulatore `http://localhost:3000`; su iPhone serve **HTTPS** (App Transport Security blocca l'HTTP verso indirizzi non locali). Il modo più semplice senza VPS è Tailscale Serve sul Mac: `tailscale serve --bg 3000` espone l'API su `https://<nome-mac>.<tailnet>.ts.net/` con certificato valido, raggiungibile dal telefono con Tailscale attivo (anche su rete cellulare). In alternativa l'URL della VPS in HTTPS.

## Avvio

```bash
cd apps/ios
xcodegen generate                 # solo se hai modificato project.yml o aggiunto file
open Ernie.xcodeproj              # scegli un simulatore iPhone con iOS 26 e premi Run
```

Da riga di comando (simulatore avviato):

```bash
xcodebuild build -project Ernie.xcodeproj -scheme Ernie -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath build CODE_SIGNING_ALLOWED=NO
xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/Ernie.app && xcrun simctl launch booted com.websdbm.ernie
xcodebuild test  -project Ernie.xcodeproj -scheme Ernie -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath build CODE_SIGNING_ALLOWED=NO
```

Al primo avvio l'app chiede l'indirizzo del server e la chiave API (`pnpm admin:create-user` la stampa una sola volta). Entrambi finiscono nel Keychain.

## Su iPhone

1. In Xcode → target Ernie → Signing & Capabilities: imposta il tuo team (il bundle id predefinito è `com.websdbm.ernie`, modificabile in `project.yml`).
2. Le notifiche push richiedono la capability Push Notifications nel profilo e, lato server, `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY` (chiave `.p8`) in `.env`; senza, le notifiche restano in-app e l'app le legge all'apertura e a ogni evento `automation.run.updated`.
3. La trascrizione usa `SpeechTranscriber` (iOS 26, on-device) se l'italiano è supportato; il modello viene scaricato dal sistema al primo uso. Altrimenti usa `SFSpeechRecognizer` con rotazione delle richieste entro il limite di un minuto. In simulatore `SpeechTranscriber` non ha lingue: si usa il ripiego.

## Aggiornare e compilare sul Mac Studio

Il checkout è `/Volumes/SSD 2TB/Ernie`. Prima di aggiornare, controllare che
`git status --short` sia vuoto; se ci sono modifiche locali, conservarle e
riconciliarle prima del pull (non usare reset o clean).

```bash
cd "/Volumes/SSD 2TB/Ernie"
git pull --ff-only origin main
cd apps/ios
xcodebuild build -project Ernie.xcodeproj -scheme Ernie -configuration Release \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$HOME/Library/Caches/ernie-git-build" \
  CODE_SIGNING_ALLOWED=NO CURRENT_PROJECT_VERSION=103
```

Questo comando verifica la compilazione senza firmare né caricare una build.
Il repository contiene progetto Xcode, sorgenti condivisi, estensioni, test e
sprite; non occorre copiare file da un archivio di rilascio. Il client usa il
backend già distribuito: compilare l'app non richiede avviare il backend locale.

La build di riferimento è la 103 (stato effettivo in [`build-103.md`](../../docs/releases/build-103.md)). Per un nuovo caricamento scegliere un numero
libero maggiore di 103 e aggiungere prima la relativa voce in
`Ernie/Resources/Changelog.json`; passare lo stesso numero tramite
`CURRENT_PROJECT_VERSION` a `scripts/testflight.sh`. Chiavi App Store Connect,
certificati e profili di firma restano nella configurazione privata del Mac.

## TestFlight

**Regola di rilascio:** ogni aggiornamento di build deve avere i sorgenti
corrispondenti pubblicati e verificati su GitHub prima della distribuzione.
Compilare dal commit pubblicato e riportare numero di build e SHA nel riepilogo
del rilascio. La procedura completa, valida anche per Mac Studio e compilazioni
manuali, è in [`AGENTS.md`](../../AGENTS.md).

`scripts/testflight.sh` archivia la build Release e la carica su App Store Connect. Servono: una scheda dell'app su [App Store Connect](https://appstoreconnect.apple.com/apps) con bundle id `com.websdbm.ernie`; l'autenticazione tramite chiave API (`ASC_KEY_ID`, `ASC_ISSUER_ID`, file `.p8` in `~/.appstoreconnect/private_keys/`, ruolo App Manager) oppure l'account Apple configurato in Xcode (Impostazioni → Account); la capability Push Notifications (aggiunta automaticamente al profilo dalla firma automatica). Dopo il caricamento la build va elaborata (5–15 minuti) e poi assegnata a un gruppo di tester interni in TestFlight; sul telefono serve l'app TestFlight. Le build di release non contengono gli hook `ERNIE_DEBUG_*` e si collegano solo al server indicato al primo avvio (per una VPS usa HTTPS). Nota: lo script forza il PATH di sistema perché il passo di creazione dell'IPA usa `/usr/bin/rsync` (openrsync) e, con l'rsync di Homebrew nel PATH, fallisce con «Copy failed».

## Struttura

```
Ernie/App        ErnieApp, AppModel (stato radice), AppDelegate (APNs, notifiche)
Ernie/Protocol   porting del protocollo v1.1: eventi (Codable), deduplica e sequenze, client WebSocket con ripresa e riconnessione
Ernie/Api        REST: /v1/me, impostazioni, notifiche, approvazioni, dispositivi
Ernie/Chat       modelli, ConversationStore (eventi → stato, TTS incrementale, cronologia locale), ChatView, schede, barra di input, AvatarStage
Ernie/Speech     sessione audio (playAndRecord + voice processing), cattura, SpeechTranscriber/SFSpeechRecognizer, Speaker, VoiceController (conversazione continua, eventi audio), TurnDetector (fine turno automatica), probe S1
Ernie/Settings   onboarding, impostazioni (voce, interruttore di emergenza, diagnostica)
ErnieTests       test unitari (Swift Testing): protocollo, deduplica, frasi per il TTS, latenza, schede, fine turno e ciclo vocale
```

## Server

Al primo avvio l'app propone il server della famiglia (`https://ernie.staging3.eklettica.it`); si può indicare un altro indirizzo. Per cambiarlo in seguito senza perdere la chiave: Impostazioni → Account → «Cambia server».

## Avatar

L'orso è un renderer SwiftUI a fotogrammi (`AvatarStage.swift`, `BearAnimation.swift`).
Dodici versioni complete — classico, notte, occhiali scuri, aviatore, cuoco, detective,
tecnico, esploratore, astronauta, Halloween, Borg e Jedi — condividono venti espressioni e cinque sequenze:
pensiero, parlato, starnuto, sonno e cinque. Il fotogramma e il costume sono scelti
separatamente: un gesto non riporta mai al foglio del personaggio base.

Tieni premuta la capsula in alto per scegliere **Aspetto di Ernie**. La preferenza
locale può essere fissa oppure **Automatico**: cuoco per ricette/spesa, tecnico per
SSH, esploratore per luoghi/meteo, detective per ricerche. Dopo 45 secondi a riposo
il contesto si spegne; dalle 21 alle 7, ora del dispositivo, compare il berretto da
notte. Le espressioni `cool` scelgono uno dei due occhiali da sole durante il giorno.
L'ascolto e il parlato hanno precedenza su starnuto e sonno. Le animazioni si fermano
quando la scena non è attiva e rispettano Riduci movimento.

La zampa picchietta durante il lavoro, dà il cinque soltanto alla transizione di
un tool a successo e resta poi con il pollice alzato. Gli errori mostrano una X.
Il cinque dell'avatar richiede un turno osservato in streaming e realmente concluso,
mai un'approvazione pendente o una conversazione storica appena aperta.

Dalla build 89, i fogli in `Ernie/Resources/BearV3` usano il volto pixel art più
grintoso approvato, vicino all'icona originale: pelo scuro, ciuffo chiaro e occhiali
sottili. `ernie-bear-v3-atlases.json` definisce 360 fotogrammi, 12 zampe e 40
fotogrammi monocromatici per i widget. I fogli contengono una riga supplementare:
`frameMap` mantiene stabili gli indici delle espressioni e dei gesti.

App e widget condividono `Shared/BearAtlas.swift`: ritagli nativi senza thumbnail
interpolati, cache delle sole celle con limite di 64 elementi e 4 MiB. Il fallback
è una copia dell'icona originale. Nel blocco schermo la grafica monocromatica
diventa una maschera di luminanza con fondo trasparente. Il widget conserva le
normali cadenze di aggiornamento iOS, senza animazione continua sul lock screen.
I vecchi fogli V2 restano nei sorgenti ma sono esclusi dal bundle dell'app.
Dalla build 90 app e widget usano anche la stessa inquadratura circolare:
la base del busto resta fuori dal bordo e la scala non cambia fra i fotogrammi.
I margini superiori riprendono il colore del PNG. Nei widget stretti i pulsanti
mostrano icone con etichetta VoiceOver anziché testo troncato.
Specifiche, riferimento approvato, prompt e provenienza: `docs/assets/ernie-v3/`.
Il volto nella capsula è ingrandito del 15% (36,8 pt, anello 41,4 pt) e sporge
leggermente verso l'alto e a sinistra, senza aumentare l'altezza normale della barra.
Quando si sceglie «Avatar galleggiante», la capsula mostra soltanto nome e stato:
il volto ricompare lì scegliendo «Avatar nella capsula», senza duplicazioni.
L'avatar galleggiante conserva trascinamento, ridimensionamento e linguetta.

## Schede Todo nella chat (build 88)

Lettura e salvataggio della stessa lista aggiornano una sola scheda per risposta,
identificata dall’ID della lista e dalla revisione. I broadcast della sincronizzazione
promemoria aggiornano lo store e le schede già visibili, senza aprire un altro
messaggio. Liste distinte e risposte a richieste successive restano separate.
Il caricamento della cronologia riunisce anche gli snapshot duplicati precedenti
ed elimina soltanto i messaggi vuoti riconoscibili come aggiornamenti autonomi.

Gli a capo `<br>`, `<br/>` e `<br />` vengono normalizzati in visualizzazione e
nella lettura vocale; il testo originale resta nel transcript. Codice inline,
blocchi di codice e tag esplicitamente escapati rimangono letterali. Test di
regressione: `TodoCardTests`, `MarkdownBreakTests` e suite esistenti di chat/voce.

## Documenti e schemi

Con «+» si scansiona o si allega un PDF: sull'allegato il menu «Schema» sceglie il tipo (predefinito lo schema a frecce del quaderno: titoletti dei paragrafi e catene «soggetto → fatto → conseguenza»; oppure Auto, mappa mentale, flusso, linea del tempo). Riassunto e schema arrivano come schede; dalla scheda dello schema si chiede un altro tipo. Le domande sul testo («spiegami…») passano dal modello.

## Famiglia e promemoria a un familiare

Impostazioni → Famiglia: «Invita un familiare» crea un codice (6 caratteri, 48 ore) scegliendo chi è l'altro (figlio/a, genitore, partner, altro), come lo chiami e come ti chiamerà; l'altro lo inserisce in «Ho un codice d'invito» sul proprio telefono. Da quel momento «ricorda a Giorgio di chiamarmi alle 17» crea il promemoria nell'account di Giorgio: la sua app mostra la scheda «Promemoria da papà», programma la notifica locale e aggiorna il widget; chi l'ha messo lo vede «· per Giorgio» e può cambiarlo o annullarlo dalla scheda (matita → testo, giorno e ora).

## Diagnostica

Impostazioni → Diagnostica mostra la latenza udibile per stadio dei turni vocali (rilascio del pulsante → trascrizione finale → primo token → prima parola sintetizzata; obiettivo p50 < 1,5 s), il motore di trascrizione in uso, i turni chiusi automaticamente, la latenza dell'ultimo barge-in (obiettivo < 300 ms), l'ultimo evento audio di sistema (interruzione, cambio di route, reset) e il probe dello spike S1 (marker delle voci italiane, vedi `docs/research/08-spike-s1-marker-tts.md`).

## Vincoli verificati (ottobre 2026; dettagli e fonti in `docs/research/02`, `04`, `03-revisione.md`)

- **Speech-to-text**: `SpeechAnalyzer` + `SpeechTranscriber` (iOS 26+, on-device, modelli scaricati dal sistema tramite `AssetInventory`). Verificare a runtime `supportedLocales`/`installedLocales`. Fallback `SFSpeechRecognizer` (limite di **1 minuto** per richiesta: rotazione).
- **Text-to-speech**: Drama tramite `POST /v1/speech` autenticato sul server Ernie, MP3 per frase e riproduzione sequenziale con `AVAudioPlayer`. Impostazioni → Voce permette di scegliere Drama o iOS, con interpretazione calda, vivace o tranquilla. Le chiavi del provider restano sul server. La generazione pendente tiene chiuso il microfono; stop, cambio account e reset audio cancellano richieste e coda. Il ripiego `AVSpeechSynthesizer` interviene prima della riproduzione della singola frase se la sintesi remota fallisce; non ripete audio già iniziato. La bocca segue il livello audio remoto; il barge-in remoto conferma solo le frasi concluse (non sono disponibili marker di parola). Non è streaming audio a livello di token né clonazione di voce.

Dalla build 87, dopo l'inizio udibile di una frase viene preparata quella
immediatamente successiva: al massimo un download e una frase pronta, con
riproduzione sempre sequenziale. Se è pronta, parte senza una nuova attesa
HTTP. Se è ancora in preparazione, la stessa richiesta diventa attiva senza
essere ripetuta. Stop, cambio di credenziali/motore/stile e reset invalidano
anche questo anticipo. La prima frase mantiene la latenza del provider;
un'interruzione può lasciare una sola frase anticipata già richiesta al servizio.

- **Audio**: `AVAudioSession` `.playAndRecord` **più `setVoiceProcessingEnabled(true)`** sull'input node (AEC/AGC).
- **Background**: nessuna wake word né microfono dal background; conversazione continua (M8) in primo piano.
- **Sicurezza**: chiave nel Keychain; nessun segreto nel bundle; markdown solo inline (nessuna immagine remota); step-up Face ID per approvazioni e interruttore di emergenza; nessuna connessione verso URL ricevuti da deep link.
- **Avatar**: sprite pixel art nativi in SwiftUI, con macchina a stati idle / listening / thinking / speaking. Il precedente piano M10 basato su three.js/TalkingHead è superato.

### Volume della voce (build 69)

La riproduzione di Drama e del ripiego Apple usa una sessione `.playback`/`.spokenAudio`, con il normale
volume multimediale e la route scelta dall’utente. `.playAndRecord`/`.voiceChat` è riservata al microfono,
riattivata all’inizio di ogni ascolto. Il player non forza lo speaker quando sono collegate cuffie.
La precedente sessione `voiceChat`, usata anche dal player a microfono spento, può ridurre il livello
in assenza di Voice I/O (documentazione Apple). Non viene amplificato o ricodificato l’MP3.
Test di regressione con il player reale: ascolto → riproduzione → ascolto → riproduzione, con audio PCM
silenzioso; categoria/mode verificati. Intensità percepita e route Bluetooth richiedono verifica su iPhone.

### Second Brain: impaginazione (build 70)

Il lettore ha una gerarchia dedicata: titolo, metadati separati, sezioni e riquadri per le voci datate.
Le date nelle intestazioni (italiane o ISO, anche in titoli di fonti e pagine unite) vengono separate dal
contenuto. Ordine, aggiornamenti con la stessa data, sottosezioni e collegamenti restano conservati;
le date nel testo e nei blocchi di codice non diventano separatori. Il Markdown nell’editor non cambia.
L’elenco distingue titolo, data, luogo e anteprima; le pagine larghe limitano la colonna a 700 punti.
Verifiche: parser e anteprime renderizzate con persone, cronologia, chiaro/scuro e testo grande a 320 punti.


### Second Brain: riepilogo e posizioni (build 71)

Le schede persona e luogo con `overview` dal server mostrano prima i fatti deduplicati, le fonti e i luoghi
collegati. «Storico e fonti» parte chiuso: conserva il lettore precedente e tutto il corpo originale.
La deduplicazione è deterministica sul server; il client non riscrive il Markdown. Un server precedente,
oppure un riepilogo vuoto, mantiene il corpo visibile. Il generico metadato `place` è un «Luogo citato»,
non una residenza; quando ci sono luoghi espliciti non viene ripetuto in intestazione.
Le coordinate della scheda vengono decodificate anche senza riepilogo. Solo coppie finite di latitudine
[-90, 90] e longitudine [-180, 180] generano un link «Apri in Mappe»; senza indirizzo compare «Posizione
salvata». Un luogo collegato mantiene anche il link alla propria scheda. Nessun indirizzo viene ricavato
artificialmente dal GPS. Il luogo corrente precede quelli con GPS, poi indirizzo e semplici riferimenti,
con ordine stabile fra equivalenti. Mappe e scheda stanno sulla stessa riga quando entrano, altrimenti
si dispongono in verticale; le aree toccabili hanno almeno 44 punti. Test: compatibilità JSON, coordinate invalide, fonti e screenshot con dati fittizi
(Anna Rossi), chiaro/scuro, caratteri grandi a 320 punti, storico aperto e server senza `overview`.


### Raccolta ricette (build 72)

Il pannello mostra «Ricette» quando la skill `ricette` è attiva. La raccolta usa le ricette SQL esistenti
(`/v1/recipes`), senza duplicarle nel Second Brain. Ricerca per titolo/ingredienti, categoria e tag si
combinano; i conteggi dei menu sono quelli globali restituiti dal server. Le pagine da 30 elementi hanno
«Carica altre», refresh, stati vuoto/errore distinti e protezione da richieste annullate o risposte obsolete.
Ogni scheda viene letta per UUID e mostra quantità originali, passaggi numerati, tempo, porzioni, note,
fonte HTTP(S), categoria, tag e data di aggiornamento. «Organizza» aggiorna soltanto categoria e tag,
con versione ottimistica: un 409 ricarica i dati e richiede un nuovo salvataggio esplicito. Massimo 10 tag;
nessun troncamento silenzioso. L'eliminazione chiede conferma. «Affina con Ernie» prepara il testo nella
chat e chiude la raccolta, senza inviarlo automaticamente. Le card salvate (`recipeId`) aprono la scheda;
le proposte non salvate mantengono «Salva». Le foto si allegano dalla chat con +: l'acquisizione non
salva automaticamente e la raccolta non avvia chiamate al modello. Test: protocollo compatibile, query
codificate, ordine delle risposte, annullamento, paginazione, errori e render sintetici 390/320 chiaro/scuro.


### Revisione lifecycle e affidabilità (build 73)

Audit del client: autenticazione/Keychain, REST e WebSocket, recupero turni, voce e microfono,
import foto/PDF e condivisioni, Brain, ricette, spesa, promemoria, messaggi famiglia e notifiche.
Le risposte di un account o di un import precedente vengono invalidate con generazioni; logout
scollega gli store, chiude subito il microfono, cancella lavori/notifiche/sveglie e cache delle foto.
Il token APNs viene rimosso via `DELETE /v1/devices/:token`, best effort con le vecchie credenziali;
le operazioni APNs sono serializzate. Offline la rimozione remota non è garantita: la pulizia locale
è immediata e non aspetta la rete. Un accesso o una verifica profilo tardivi non riattivano l’account.

Le azioni critiche richiedono autentica conferma del dispositivo anche quando Face ID/codice non
sono disponibili (nessun consenso implicito). Stop resta valido per l’intero turno vocale;
background chiude la conversazione continua. WebSocket scartano risposte del socket o sessione
precedente prima di aggiornare il cursore. Spesa ignora riletture precedenti a un nuovo blocco e
serializza modifiche per lista. La ricerca Brain annulla la richiesta precedente e distingue 404
ed errore di rete. PDF OCR usa scala pixel 1 e lato massimo 2400, con cancellazione fra pagine.

`LifecycleTests` copre autenticazione indisponibile, risposte REST dopo logout, spesa fuori ordine,
import sostituiti/annullati, sessione WebSocket precedente, errori Brain e limiti/cancellazione OCR.
La suite comprende anche coda/cancellazione/fallback Drama, paginazione ricette e render Brain/ricette
390 punti chiaro/scuro e 320 con testo grande. Limiti simulatore: APNs reale, Face ID/codice,
AlarmKit in background, routing Bluetooth/interruzioni telefoniche e qualità del microfono richiedono
una verifica su iPhone fisico; la copertura automatica non equivale a tali prove hardware.


### Conferme leggibili (build 74)

La scheda di conferma mostra un riepilogo deterministico inviato dal server: titolo, effetto dell’azione,
pulsante specifico e dettagli espandibili. Per le ricette gli ingredienti mantengono le quantità e i passaggi
sono numerati; lo stesso titolo può aggiornare una ricetta esistente e viene dichiarato nel riepilogo.
Nessuna chiamata aggiuntiva al modello. Il motivo tecnico resta nell’audit: in chat compare una spiegazione
in italiano, anche per i messaggi storici. Il vecchio JSON completo viene riformattato; un’anteprima storica
troncata non viene presentata come completa e richiede di annullare e ripetere la richiesta.

«Salva sempre senza chiedere» esplicita che il consenso comprende tutti i salvataggi/aggiornamenti di ricette;
la possibilità di autorizzarlo continua a dipendere dal server. Restano la verifica del dispositivo, la
scadenza e l’approvazione monouso legata agli argomenti originali. Le schede scadute non mostrano i pulsanti
di approvazione; un consenso già dato resta visibile anche dopo la scadenza. Il layout dispone i pulsanti
in verticale quando lo spazio o la dimensione del testo lo richiedono.

### Scheda unica della spesa (build 75)

Gli snapshot della stessa lista nella stessa risposta vengono riconosciuti per `listId`: creazione,
aggiunte, spunte, rimozioni e riletture aggiornano una scheda unica, nella posizione originale. L'ultimo
snapshot sostituisce interamente il precedente, anche quando la lista viene svuotata. Liste con UUID
diversi restano separate, anche a parità di nome; richiamare una lista in un altro turno mantiene il
contesto della risposta precedente. Il caricamento della cronologia applica la stessa normalizzazione
alle conversazioni salvate dalle build vecchie, senza cambiare testo, identificativi o cursore degli eventi.

La cancellazione dal menu continua a riguardare la lista salvata e tutte le sue voci. La correzione evita
di presentare due schede della stessa lista come se fossero copie indipendenti. `ShoppingCardTests`
copre aggiornamento in diretta, snapshot vuoti, UUID distinti, turni separati e riapertura dello storico.

### Uscita vocale dopo il microfono (build 76)

La chiusura di `MicrophoneCapture` disabilita immediatamente il Voice Processing di AVAudioEngine,
termina lo stream, rimuove il tap e resetta il motore. Prima il solo `engine.stop()` lasciava abilitato
il processore vocale anche mentre il trascrittore tratteneva il capture: il ducking di Voice I/O può
attenuare anche l'audio della stessa app riprodotto con AVAudioPlayer. Il ciclo di vita è isolato sul
MainActor; un avvio annullato non riattiva la sessione microfono durante i tentativi sul formato audio.
Il playback continua a usare `.playback` / `.spokenAudio` e l'uscita scelta dall'utente.

In Impostazioni → Voce, `SpeechVolumeControl` incorpora il controllo pubblico `MPVolumeView`, mostra
la percentuale del volume di sistema e permette di regolarlo ascoltando l'esempio. Non forza il volume
massimo e non sostituisce l'uscita delle cuffie. I log della riproduzione includono route, categoria,
modalità e volume di sistema per distinguere un file debole da un'attenuazione del dispositivo.

Verifiche: regressione riprodotta sul vero AVAudioEngine del simulatore prima del fix e risolta dopo;
avvio annullato e due cicli microfono/player coperti. Suite completa: 97 test in 19 suite passati.
Una nuova risposta Drama tramite HTTPS reale misura −14,4 dBFS RMS, −13,5 LUFS e −1,8 dBFS true peak;
prompt e normalizzatore server restano invariati. La loudness effettiva dell'altoparlante o delle cuffie
richiede la conferma su iPhone fisico: lo stato del processore e i test del player non sono una misura
acustica del dispositivo.

### Raccolta Media (build 77)

Menu laterale → Media: galleria a colonne sfalsate, scheda modificabile, ricerca,
categorie, tag e anno di caricamento. Importazione da Foto, fotocamera e File;
anche le nuove immagini della chat vengono conservate, comprese quelle senza OCR.
Le proposte automatiche sono disattivabili dal menu +; le scansioni multipagina
evitano un'analisi AI per pagina. I retry riusano l'identificativo del caricamento
e il server riconosce i JPEG identici. Cache privata in memoria, svuotata al logout.
I vecchi allegati conservavano soltanto testo: non sono retroattivamente disponibili
come foto. Contratto, limiti e verifiche: `docs/research/15-media.md`.

### Caricamenti Media persistenti (build 78)

`MediaImportCoordinator` conserva l'intera selezione prima di avviare OCR e rete;
non viene annullato chiudendo Media. `MediaUploadQueue` persiste ogni foto e affida
un upload da file alla URLSession background di iOS. AppDelegate riaggancia gli
eventi anche dopo il rilancio; tornando in primo piano la coda riconcilia i task
prima di riprendere quelli mancanti. Riprova conserva clientId e contenuto, con
un massimo di tre tentativi automatici per foto. Lo stato e gli errori sono nella
raccolta. La chat avvia tutti gli upload prima di aspettare i risultati. Logout
e cambio account cancellano solo la coda locale relativa all'account precedente.
Dettagli e limiti del sistema operativo: `docs/research/15-media.md`.


### Ricette, immagini e luoghi nel Second Brain (build 79)

`ricetta` e `immagine` sono proiezioni gestite delle raccolte canoniche, identificate da
`resource:{kind:recipe|media,id:UUID}`. Non espongono modifica/eliminazione della nota (neppure
quando un server invia soltanto il tipo); «Apri ricetta/immagine» apre la raccolta originale.
I dettagli delle raccolte offrono il percorso inverso tramite `Ricette/<uuid-minuscolo>.md`
e `Immagini/<uuid-minuscolo>.md`. Elenco, tempo, mappa, note appena create e `related` navigano
per path; titoli e backlink storici restano compatibili. Il server continua a gestire corpo e
sincronizzazione: il client non crea copie o deduzioni geografiche.

La scheda risorsa permette di sostituire i soli collegamenti manuali (`note.resourceLinks`)
via PATCH `/v1/brain/resources/:kind/:id/links`: massimo20, note persona/luogo/argomento/progetto
non private, ricerca fino200 risultati. I collegamenti automatici non vengono modificati.
`related` usa path/title/type ed eventuali resource/coords; le immagini hanno miniature autenticate
tappabili, anche nelle schede dei luoghi. Le raccolte Ricette e Media restano disponibili.

GPS: Foto usa la rappresentazione corrente del file; PhotoPicker, File e condivisioni leggono
ImageIO prima di generare il JPEG ridotto. Solo latitude/longitude validate, data GPS UTC e
precisione eventualmente presenti passano come `location:{lat,lon,capturedAt?,accuracy?}`.
Gli altri metadati EXIF vengono rimossi. La coda persistente e i body URLSession conservano la
posizione; journal78 e risposte senza location restano compatibili. Non si usa la posizione
corrente per una foto importata. La fotocamera in-app richiede un fix dedicato solo con permesso
già concesso e opzione posizione attiva; fallback consentito entro30s dallo scatto e accuracy<=100m.
Senza EXIF/fix affidabile si salva senza coordinate. La scelta/creazione del luogo è compito del server,
nessuna ulteriore chiamata LLM sul client. Una nuova localizzazione della fotocamera e il GPS fornito
da Foto/iCloud vanno verificati anche su iPhone fisico: il simulatore copre decoder e pipeline sintetica.

Regressioni: omonimi con path distinti, routing legacy, proiezioni non editabili, selezione privata
esclusa, PATCH soli manuali/limite20, EXIF prima/dopo JPEG, fix vecchi/imprecisi rifiutati, GPS nel
journal e body dopo riavvio e route mock. Render sintetici 390 chiaro/scuro e320 testo grande.


### Conferme compatte (build 82)

Le richieste concluse (approvate, annullate o scadute) partono chiuse in una riga
espandibile con oggetto ed esito della conferma. Un tocco riapre riepilogo originale,
dettagli, motivo ed eventuale consenso permanente. L'approvazione non viene descritta
come esecuzione già riuscita. La chiusura avviene anche quando una richiesta pendente
riceve una decisione; la cronologia precedente mantiene tutti i dati.

Le richieste pendenti hanno una sola intestazione, spazi ridotti e riepilogo ricetta
più breve, conservando l'avviso di aggiornamento di una ricetta già presente.
Ingredienti e dettagli restano espandibili. Il consenso permanente è in «Opzioni
di conferma», insieme al suo ambito e alle istruzioni di revoca. Annulla, step-up
Face ID/codice, blocco delle anteprime incomplete e protezione dal doppio invio
restano nel percorso esistente. Font dinamici, pulsanti da almeno 44 punti,
impaginazione verticale quando le azioni non entrano e descrizioni VoiceOver.

### Consumi personali e amministrativi (build 87)

Nel pannello laterale «I miei consumi» apre i periodi giorno, settimana, mese e
anno, con calendario locale, andamento e dettagli per attività, modello e
fornitore. Importi in USD, costo comunicato dal servizio separato dalle stime,
copertura storica esplicita. Il grafico ha anche una tabella accessibile;
caratteri grandi usano un menu per il periodo e metriche su più righe.
La spesa e il grafico precedono le spiegazioni, raccolte in una sezione
espandibile. Gli importi mostrano tre decimali (un costo positivo inferiore
a 0,001 USD viene indicato come «<0,001 USD»); il registro conserva la
precisione originale. Il grafico usa poche etichette, barre separate e una
scala leggibile anche per importi piccoli. Toccando una barra si leggono
periodo, costo e numero di chiamate.

«Consumi installazioni» compare solo se `/v1/me` restituisce
`capabilities.usageAdmin=true`. Il ruolo `owner` non abilita questa funzione.
La vista mostra soltanto gli account con un'installazione iOS rilevata,
escludendo quelli contrassegnati esplicitamente come test. L'installazione
viene rilevata anche senza notifiche push; la revoca delle notifiche o il
logout non cancellano lo storico. Mostra il dettaglio del singolo account nello stesso
periodo e il saldo OpenRouter condiviso, separato dal totale registrato.
Più dispositivi dello stesso account condividono il conteggio.

`UsageStore` conserva i dati solo in memoria, scarta risposte superate e svuota
il report all'uscita. Cambio credenziali, logout o risposta 401/403 nascondono
anche il nome dell'account selezionato. Un saldo non disponibile non viene
mostrato come zero. Le API applicano nuovamente autenticazione, concessione
amministrativa e isolamento SQL; il controllo del menu non è un'autorizzazione.

Test: decoder del contratto, calendari/DST, formati italiani, richieste
concorrenti, cancellazione, cambio account, revoca e titolo della pagina.
Render nativi chiaro/scuro, 320 punti con testo grande; integrazione e
rilascio documentati in `docs/DEPLOY.md`.

### Zampa durante l’attesa (build 93)

`BearPawTapMotion` scandisce un ciclo di 1,65 secondi con polso fermo, tre
sollevamenti distinti e ritorni alla posa di contatto. `BearActivityArtwork`
usata dagli indicatori di elaborazione, strumenti e trascrizione legge le
quattro celle di `paws-tap`; successo ed errore mantengono il comportamento
precedente. Riduci movimento mostra la posa di riposo, il background sospende
la timeline e la ripresa ricomincia dall’appoggio. Verifica: tre test specifici
e dodici regressioni delle animazioni, più render nativi chiaro/scuro.

### Destinazioni del widget (build 94)

`Shared/AppLink.swift` definisce gli URL consentiti, senza parametri o comandi.
Nei widget medio/grande «Parla» e «Scrivi» hanno link separati; il riepilogo
del prossimo impegno porta ai promemoria. Nel widget grande tutta la sezione
impegni e tutta la sezione automazioni sono link, anche a contenuto vuoto.
Il widget dedicato ai promemoria apre la stessa raccolta in tutti i formati.
L’orso e lo sfondo conservano la destinazione configurata. Implementazione
con `Link` e `widgetURL` secondo la documentazione Apple:
https://developer.apple.com/documentation/widgetkit/creating-a-widget-extension

`ChatView` conserva la richiesta durante l’avvio e chiude un eventuale foglio
prima di presentare la destinazione, aprire la tastiera o avviare il microfono.
Le novità automatiche non devono coprire un’apertura richiesta dal widget.
La schermata Automazioni consulta `/v1/automations` con l’account attivo,
esclude le chiavi `promemoria_`, distingue stati attivi/in pausa/disattivati
e non esegue operazioni. Non decodifica o mostra segreti webhook.

## ErnieTRIX (build 101)

«Voglio giocare a ErnieTRIX», scritto o dettato, apre il gioco nativo sopra
la chat; è disponibile anche nel pannello laterale. Motore Swift locale,
rendering SpriteKit, texture di pelliccia in pixel art, pad con pressione
prolungata, pausa automatica e checkpoint per account sul dispositivo.
Non usa token durante la partita e non richiede modifiche backend.
Specifiche e verifiche: [ErnieTRIX](../../docs/ui/ernietrix.md).
Solo in Debug, `SIMCTL_CHILD_ERNIE_DEBUG_TRIX=1` apre una partita sintetica
per la verifica in simulatore senza autenticazione; con
`SIMCTL_CHILD_ERNIE_DEBUG_TRIX_COSTUME=borg` si verifica la variante verde.
Questi hook non sono compilati nella build Release.

La build 102 corregge il ciclo di avvio/pausa di ErnieTRIX: un `SKView` gestito
esplicitamente sostituisce `SpriteView`, che manteneva la pausa iniziale.
Il test di regressione parte in pausa e verifica rendering, gravità reale,
pausa/ripresa e riapertura del salvataggio.

## Diario personale

Skill privata con archivio locale cifrato, biometria e consenso AI per ogni selezione.
Accesso da Impostazioni → Area privata o «Apri diario». Contratto, backup e limiti
in [Diario personale](../../docs/research/19-private-diary.md).
