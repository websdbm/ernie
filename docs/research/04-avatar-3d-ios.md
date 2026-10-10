# Avatar 3D animato per Ernie su iOS (SwiftUI): stato dell'arte 2023 → ottobre 2026

*Ricerca bibliografica per il progetto Ernie, redatta il 10 ottobre 2026. Copre l'avatar tridimensionale animato che fa da interfaccia all'agente in un'app iOS nativa SwiftUI. Vincoli dati: TTS on-device con `AVSpeechSynthesizer`, riconoscimento vocale on-device (SpeechAnalyzer/SFSpeechRecognizer), backend TypeScript che invia solo testo ed eventi strutturati via WebSocket. Il report non progetta la soluzione: raccoglie evidenze e confronta le opzioni.*

**Convenzioni.** I numeri tra parentesi quadre rimandano alla bibliografia (§6). Affidabilità: **Primaria** = documentazione ufficiale, specifiche, termini di licenza, codice/README del progetto, paper, sessioni WWDC o dichiarazioni di staff del vendor; **Secondaria** = stampa e resoconti di terzi; **Opinione** = forum, blog personali, materiale promozionale. I numeri sono riportati solo se presenti nella fonte. Le mie inferenze sono marcate come *deduzione*. Diverse pagine ufficiali Epic (licenza, EULA MetaHuman, FAQ) rispondevano 403 o 503 durante la ricerca: per quei punti cito fonti secondarie e lo segnalo.

---

## 1. Sommario esecutivo

1. **Unreal Engine non ha un percorso ufficiale per l'embedding in un'app iOS esistente.** "UE as a Library" è documentato solo per UE 4.27 con API Windows (HWND, WndProc), un'istanza per processo e nessun riavvio dopo lo shutdown [2]. Per iOS ho trovato solo una domanda senza risposta su un'opzione sperimentale "Build as a Framework", non verificabile [3]. Usare Unreal significa in pratica un'app "UE-first" oppure Pixel Streaming dal cloud [12].
2. **MetaHuman su mobile è ridotto.** Su iOS/Android Epic indica come LOD massimo il 3, texture fino a 2048, capelli a card e niente ray tracing. Al LOD 3 la testa ha 2.500 vertici, 283 joint e niente animated maps; le 669 blendshape esistono solo al LOD 0 [4]. Lo skinning GPU mobile è limitato a 75 bone per draw call [5]. Non ho trovato benchmark di FPS o di consumo su iPhone.
3. **L'animazione facciale da audio di MetaHuman non è supportata a runtime.** Lo staff Epic lo ha dichiarato a giugno 2025 [8]. Le note 5.8 descrivono la funzione su macOS/Linux come "Editor-only" [6]. Esistono plugin di terzi che dichiarano supporto iOS, non verificati [13].
4. **Unity as a Library (UaaL) è ufficiale su iOS ma vincolante.** Il rendering è solo a schermo intero, è ammessa una sola istanza, dopo l'unload restano occupati 80–180 MB e dopo il quit Unity non si ricarica nella stessa sessione [14].
5. **Rischio di licenza Unity per un'app non-gioco.** I termini Unity definiscono "Industry Customer" chiunque usi Unity per scopi "not solely for games or entertainment". Per questi clienti la distribuzione del runtime è soggetta a "applicable fees and Unity's express authorization" [16][17]. Il listino di queste fee non è pubblico e a ottobre 2026 gli utenti lamentano risposte mancanti [18].
6. **RealityKit è l'opzione nativa più integrata con SwiftUI.** Da iOS 18 offre `RealityView`, `BlendShapeWeightsComponent`, `SkeletalPosesComponent` e `IKComponent` [24][25], senza aggiungere un motore al binario (*deduzione*). I punti deboli sono la pipeline degli asset (Apple non dà indicazioni ufficiali per Blender [30]) e un problema aperto: le blendshape non si aggiornano visivamente mentre gira un'animazione scheletrica [29]. SceneKit è in soft deprecation dal 2025 [27].
7. **three.js in WKWebView con TalkingHead (MIT) è la pipeline open source più completa** per avatar conversazionali: visemi Oculus, blendshape ARKit, mood, gesti e lip-sync guidato dal testo [32]. Manca però un modulo per l'italiano.
8. **`AVSpeechSynthesizer` garantisce ufficialmente solo callback per parola** (`willSpeakRangeOfSpeechString`, da iOS 7) [40]. L'API espone anche marker fonemici (`AVSpeechSynthesisMarker.Mark.phoneme`, da iOS 16/17) e `write(_:toBufferCallback:toMarkerCallback:)` con offset in campioni [41]. **Non è documentato se le voci di sistema, italiane comprese, emettano marker fonemici**: va verificato con uno spike.
9. **Audio2Face-3D di NVIDIA, open source da settembre 2025, richiede GPU NVIDIA con CUDA/TensorRT su Windows o Linux** [47]. Non gira on-device su iOS ed è incompatibile con un backend che invia solo testo.
10. **OVRLipSync non ha supporto iOS ufficiale** e la sua licenza è legata all'hardware Meta [37].
11. **Ready Player Me non è più un'opzione:** acquisita da Netflix a dicembre 2025, ha messo offline i servizi dal 31 gennaio 2026 [38]. Soul Machines è in amministrazione controllata da febbraio 2026 [56].

**Rischi principali:** licenze (royalty Unreal del 5% oltre 1 M$ per le app runtime [10]; fee Unity Industry non pubblicate [17]); qualità MetaHuman su mobile; G2P italiano da sviluppare in proprio; disponibilità dei marker fonemici; bug blendshape+scheletro in RealityKit; peso del download (una build UE5 vuota "roughly 300 MB" secondo un tutorial della community [64], contro i ~12–20 MB di Unity vuoto [19] e i ~30 MB aggiunti da Godot [23]).

---

## 2. Analisi per ambito

### 2.1 Motori e runtime 3D su iOS

#### Sintesi

Le opzioni si dividono in tre famiglie:
- **motori completi** (Unreal, Unity, Godot): tooling di animazione ricco, ma integrazione con SwiftUI difficile o non ufficiale, binari pesanti e licenze da valutare;
- **runtime nativi Apple** (RealityKit, SceneKit in dismissione): integrazione perfetta e peso nullo, tooling degli asset più povero;
- **renderer leggeri** (Filament in C++, three.js in WKWebView): flessibili e permissivi, ma tutta la logica dell'avatar resta da scrivere o da adottare da progetti open source.

#### Evidenze

**Unreal Engine 5.x**
- **Requisiti:** la documentazione per UE 5.8, la versione corrente, indica come target SDK "iOS/iPadOS/tvOS 17 or later". Con iOS 17 servono iPhone 11 o successivi. Epic raccomanda Xcode 26.1.1 con base SDK 26 e ricorda che dal 28 aprile 2026 App Store Connect accetta solo build fatte con Xcode 26 [1] (Primaria).
- **Embedding:** l'unica documentazione "UE as a Library" (4.27) usa `UELibrary_Init(HINSTANCE, HWND, …)` e `UELibrary_WndProc`, vieta più istanze ("running multiple UE4 instances … is not supported"), non permette di riavviare dopo lo shutdown e richiede `.uproject` e mappa da riga di comando [2] (Primaria). Su iOS l'unica traccia è un post del gennaio 2025 senza risposte di Epic [3] (Opinione).
- **Pixel Streaming** rende in cloud e trasmette via WebRTC; il reference elenca Safari mobile tra i browser testati, ma avverte che molte impostazioni sono cambiate con Pixel Streaming 2 [12] (Primaria). Per Ernie implicherebbe GPU server e streaming video, in contrasto con il vincolo on-device (*deduzione*).
- **Dimensione:** "even a blank project will end up being roughly 300 MB" (tutorial della community, piattaforma non specificata) [64] (Opinione). Non ho trovato un dato ufficiale per iOS.
- **Licenza:** gratis sotto 1 M$ di fatturato. Le applicazioni non-gioco concesse in licenza a utenti terzi e basate su codice UE a runtime pagano il 5% sui ricavi lordi oltre 1 M$ "lifetime". Le aziende non-gioco sopra 1 M$ che non distribuiscono runtime pagano invece seat a 1.850 $/anno [10] (Secondaria: annuncio Epic del 2024 riportato da VGC e CGPress; la pagina ufficiale rispondeva 403). Gli estratti dell'EULA datati maggio 2026 citano un'aliquota ridotta al 3,5% per i prodotti "Launch Everywhere with Epic" [11] (Secondaria).
- **MetaHuman su mobile:** i limiti sono quelli del punto 2 del sommario [4][5]. Servono inoltre `Compat.MAX_GPUSKIN_BONES=75`, il ridimensionamento delle texture 8K tramite `MaxLODSize` e `r.EarlyZPass=3` [5] (Primaria). La pagina dei requisiti non afferma esplicitamente che MetaHuman sia supportato su mobile [5]. MetaHuman 5.8 aggiunge LOD minimo/massimo per piattaforma e precisione FP16 per mobile nei dati DNA [6] (Primaria).

**Unity 6.x**
- **UaaL:** produce `UnityFramework.framework` ed espone la classe Objective-C `UnityFramework`. La comunicazione verso Unity passa da `sendMessageToGOWithName:functionName:message:` con un solo parametro stringa. I limiti sono quelli del punto 4 del sommario [14] (Primaria). Per inserire Unity in una parte di schermo SwiftUI esistono workaround della community che si appoggiano alla gerarchia interna delle view e a ritardi temporizzati [20] (Opinione).
- **Dimensione:** "an empty project might be around 20MB in the App Store" senza ottimizzazioni, "less than 12MB" con code stripping [19] (Primaria).
- **Frame rate:** di default su iOS Unity rende "at a fixed 30 fps to conserve battery power" [19] (Primaria).
- **Licenza:** il Runtime Fee per i giochi è stato cancellato il 12 settembre 2024 [15]. Personal è gratuito sotto 200 K$; Pro costa 2.310 $/anno per seat nel 2026; Industry è "required if you create applications outside of games or entertainment" quando le finanze superano 1 M$ [15] (Primaria). Per i rischi sulla distribuzione del runtime vedi il punto 5 del sommario [16][17][18].

**Godot**
- **Licenza:** MIT [21].
- **LibGodot:** introdotta con Godot 4.6 (gennaio 2026), supporta all'inizio "Linux, Windows, and macOS" [21] (Primaria).
- **SwiftGodotKit** (community, Miguel de Icaza) usa patch libgodot per Godot 4.7. Si integra con `GodotApp` e `GodotAppView` in SwiftUI, con un solo `GodotApp` per app. Il rendering realmente embedded richiede una build libgodot con display driver "embedded" [22] (Primaria, progetto non ufficiale Godot).
- **Esperienza riportata:** un blog del 2025 mostra la view Godot dentro un `VStack` SwiftUI, la comunicazione tramite segnali e un aumento del binario di circa 30 MB misurato con Emerge Tools [23] (Opinione).

**RealityKit e SceneKit**
- **RealityView** è disponibile da iOS 18. Carica i contenuti in modo asincrono, ha una closure `update` e permette logica per frame tramite `System` o `SceneEvents.Update` [24] (Primaria).
- **Componenti per personaggi (iOS 18):** `BlendShapeWeightsComponent`, `SkeletalPosesComponent` (pose per joint, scrivibili al massimo una volta per frame) e `IKComponent` (solver IK full-body) [24][25] (Primaria). Nella sessione WWDC24 10102 Apple li usa per seguire un bersaglio con il collo e per le blendshape, insieme a Timelines e `AnimationLibraryComponent` [25].
- **SceneKit:** "soft deprecation", "maintenance mode", sconsigliato per i nuovi progetti [27] (Primaria).
- **WWDC26:** Apple annuncia "high quality character rendering" con subsurface scattering e shader per capelli, senza dettagli; mostra `LevelOfDetailComponent` e suggerisce di reagire a `thermalStateDidChange` [28] (Primaria).
- **Problemi noti:** non ci sono linee guida Apple per Blender (un ingegnere Apple indica di esportare le Shape Keys nella sezione "Rigging"); alcuni utenti segnalano nomi di peso vuoti [30]; le blendshape non si aggiornano durante `playAnimation`, thread di luglio 2025 senza soluzione [29] (Opinione, con riproduzione pubblica).

**Filament**
- Licenza Apache-2.0, iOS 11+, Metal come backend preferito, API C++ [31] (Primaria).
- glTF 2.0 con morph animation e skin animation [31].
- Non ha un wrapper SwiftUI ufficiale. *Deduzione*: va scritto un `UIViewRepresentable` attorno a un `CAMetalLayer`.

**three.js in WKWebView**
- **TalkingHead** (MIT) usa three.js/WebGL con avatar GLB full-body, rig compatibile Mixamo e blendshape ARKit più visemi Oculus [32] (Primaria).
- **Bridge:** `WKScriptMessageHandler` per JS→Swift e `callAsyncJavaScript` (iOS 14+) per Swift→JS [63] (Primaria).
- **App Review:** il JavaScript va incluso nel bundle. La regola 2.5.2 vieta di scaricare codice che "introduces or changes features or functionality" [61] (Primaria).

#### Trade-off

Integrazione con SwiftUI e peso dell'app vanno in direzione opposta alla ricchezza del tooling. RealityKit e WKWebView si incastrano nella gerarchia SwiftUI. UaaL è a schermo intero per specifica. Unreal non è embeddabile su iOS in modo documentato. Godot sta in mezzo: parziale, MIT, ma basato su un progetto della community.

#### Implicazioni pratiche per Ernie
- Se l'avatar deve convivere con la chat SwiftUI nella stessa schermata, solo RealityKit, WKWebView e (in modo non ufficiale) Godot lo permettono senza hack [14][22][24].
- Adottare Unreal significa riscrivere la shell dell'app o passare al cloud rendering; va trattata come decisione di piattaforma, non come scelta di libreria [2][12].
- Prima di scegliere Unity serve una conferma scritta da Unity sulla classificazione "Industry" di un assistente consumer e sulle relative fee [16][17][18].
- Pianificare il frame rate (30 fps in idle) e la reazione allo stato termico fin dall'inizio [19][28][63].
- Con RealityKit, verificare subito su iOS 26 il bug blendshape più animazione scheletrica, con una scena minima [29].

### 2.2 Modelli di avatar

#### Sintesi

Conviene un avatar che esponga **le 52 blendshape ARKit e i 15 visemi Oculus**. È il formato che TalkingHead richiede e che Convai e i plugin MetaHuman di terzi accettano [32][54][13]. MetaHuman è il riferimento per il fotorealismo, ma su mobile perde proprio le blendshape [4]. Le piattaforme di avatar SaaS si sono dimostrate fragili: Ready Player Me ha chiuso [38].

#### Evidenze
- **ARKit:** `ARFaceAnchor.BlendShapeLocation` definisce 52 coefficienti: 7 per occhio, 27 per bocca e mascella, 10 per sopracciglia/guance/naso, 1 per la lingua [35] (Primaria).
- **Visemi Oculus:** sil, PP, FF, TH, DD, kk, CH, SS, nn, RR, aa, E, ih, oh, ou [36] (Primaria).
- **VRM 1.0** prevede preset `aa`, `ih`, `ou`, `ee`, `oh` per il lip-sync; `happy`, `angry`, `sad`, `relaxed`, `surprised` per le emozioni; `blink*`, `look*` e `neutral` [34] (Primaria).
- **Fonti di avatar compatibili** elencate da TalkingHead: Avaturn T2, VRoid (convertito via Blender), MPFB (CC0), Microsoft Rocketbox (MIT, da re-riggare), Avatar SDK. Per creare le shape Oculus/ARKit l'autore consiglia l'add-on Faceit (a pagamento) [32] (Primaria).
- **Avaturn:** gli avatar T1 hanno "static faces"; i T2 supportano blendshape ARKit e visemi [39] (Primaria). Per l'uso commerciale TalkingHead segnala che occorre avvisare l'azienda [32]. Non ho verificato prezzi ufficiali.
- **MetaHuman:** 669 blendshape solo al LOD 0, poi rig a joint con conteggi decrescenti [4]. Da UE 5.6 la licenza consente l'uso in altri motori come "non-engine products". Sopra 1 M$ servono seat se si rende fuori da UE ed è vietato usarli per addestrare modelli di AI [9] (Secondaria; la pagina EULA dava 403).
- **Ready Player Me:** acquisizione Netflix annunciata il 19 dicembre 2025, servizi di creazione offline dal 31 gennaio 2026 [38] (Secondaria). Il 10 ottobre 2026 il dominio `readyplayer.me` non risolveva al DNS (osservazione diretta).
- **Memoji/Animoji:** non esiste un'API pubblica. È un'osservazione di contesto, non approfondita.

#### Trade-off

Fotorealismo e animabilità su mobile tirano in direzioni diverse. Gli avatar stilizzati con set di shape standard sono portabili tra RealityKit, three.js, Unity e Godot. MetaHuman lega di fatto la pipeline a Unreal, a meno di export non documentati.

#### Implicazioni pratiche per Ernie
- Prendere come contratto dell'asset le 52 shape ARKit e i 15 visemi Oculus: rende il personaggio indipendente dal runtime [32][35][36].
- Possedere l'asset sorgente (Blender) invece di dipendere da un servizio di generazione online [38].
- Usare VRM come formato di riferimento per uno stile anime o toon: i preset di emozione mappano bene gli eventi del backend [34].
- Prima di mettere MetaHuman in roadmap, prototipare l'export verso un runtime iOS non-Unreal. La licenza lo consente secondo [9], ma la fattibilità tecnica non è verificata.

### 2.3 Lip-sync guidato dal parlato con TTS Apple on-device

#### Sintesi

Con `AVSpeechSynthesizer` ci sono due modalità di lavoro:
- **`speak()`:** il sistema riproduce l'audio. Si ricevono eventi temporizzati (per parola sicuramente, per marker forse) ma non si ha accesso al segnale.
- **`write()`:** si ricevono buffer PCM e marker con `byteSampleOffset` e si gestisce la riproduzione in proprio (ad esempio con `AVAudioEngine`). Questo abilita sincronizzazione al campione, analisi di ampiezza o MFCC e visemi da audio, al prezzo di più codice.

#### Evidenze
- **Callback per parola:** `speechSynthesizer(_:willSpeakRangeOfSpeechString:utterance:)` (iOS 7+) viene chiamato "once for each unit of speech … generally a word" [40] (Primaria).
- **Marker:** `speechSynthesizer(_:willSpeak:utterance:)` (iOS 17+) notifica i marker [40]. `AVSpeechSynthesisMarker.Mark` include `.phoneme` (iOS 16+), con proprietà `phoneme` e `bookmarkName` (iOS 17+) e `byteSampleOffset` (iOS 16+) [41] (Primaria).
- **Buffer e marker insieme:** `write(_:toBufferCallback:toMarkerCallback:)` (iOS 16+) fornisce entrambi [41] (Primaria).
- **Marker e voci di sistema:** nessuna fonte Apple dice quali marker emettano le voci di sistema. WWDC23 parla solo di marker "indicating where words occur" restituiti dalle estensioni provider [43] (Primaria).
- **Voci provider:** sono Audio Unit (`AVSpeechSynthesisProviderAudioUnit`) che forniscono marker tramite `speechSynthesisOutputMetadataBlock`, e "Network access isn't allowed" [42] (Primaria). Su iOS 18 i marker word di una voce provider arrivavano tutti all'inizio, mentre con le voci Apple la sincronizzazione era corretta; la correzione è segnalata nella beta di iOS 18.6 [44] (Opinione, con risposta di un ingegnere Apple).
- **SSML e IPA:** `AVSpeechUtterance(ssmlRepresentation:)` (iOS 16+) ignora `rate` e `pitchMultiplier` [42]. `AVSpeechSynthesisIPANotationAttribute` controlla la pronuncia [42] (Primaria). Non è verificato se i tag SSML `<mark>` producano marker bookmark con le voci di sistema.
- **Affidabilità di `write()`:** sulle beta di iOS 17 l'audio da `write()` riprodotto con `AVAudioEngine` risultava "choppy", e il workaround converteva i buffer in Float32 non interleaved [44] (Opinione).
- **Soglie di sincronizzazione:** ITU-R BT.1359 indica come soglia di percezione circa +45 ms (audio in anticipo) / −125 ms (audio in ritardo) e come soglia di accettabilità circa +90 / −185 ms [53] (Secondaria; non ho consultato il testo ITU).
- **Testo → visemi (TalkingHead):** moduli per lingua con `wordsToVisemes` scalati sui timestamp di parola del TTS. Per il finlandese la conversione diretta grafema→fonema→visema raggiunge ">99.9%" rispetto al dizionario in circa 4k di implementazione; per l'inglese le regole arrivano a circa l'80% in circa 12k; CMUdict pesa circa 5 MB [32] (Primaria). Non esiste un modulo italiano [32].
- **G2P italiano:** kokorog2p (Apache-2.0, Python) offre regole per l'italiano e dichiara che l'ortografia regolare rende la conversione a regole "quite accurate" [50] (Primaria, auto-dichiarato). eSpeak NG è GPL-3.0 [51]. Incorporare codice GPL in un'app App Store è problematico: è il precedente di VLC, rimossa nel 2011 [52] (Secondaria). *Deduzione*: eseguire il G2P sul backend evita la distribuzione nell'app, ma richiede comunque una valutazione legale.
- **Da audio a visemi:**
  - Rhubarb (MIT, v1.14.0 di aprile 2025) lavora offline su file; il riconoscitore PocketSphinx è "English only", quello fonetico è indipendente dalla lingua ma "less precise" [45] (Primaria).
  - uLipSync (MIT) usa MFCC confrontati con profili calibrabili, funziona a runtime o in pre-bake, ed è solo per Unity [46].
  - HeadAudio (MIT) usa MFCC e prototipi gaussiani: modello di circa 14 kB, latenza stimata di circa 50 ms, addestrato su voci inglesi, dichiaratamente meno accurato dell'approccio da testo [33] (Primaria).
  - OVRLipSync non ha percorso iOS ufficiale [37].
  - Audio2Face-3D richiede CUDA/TensorRT su Windows o Linux [47]. Il paper riporta 3.269 FPS su RTX 4090 e circa 0,52 s di audio in ingresso per stimare una posa con la rete di regressione [48] (Primaria).
  - I modelli accademici (EmoTalk, CodeTalker, UniTalker) sono pensati per GPU da server [49].
- **Approccio ad ampiezza:** Live2D usa l'RMS del WAV per guidare `ParamMouthOpenY` [60] (Primaria). È robusto ma dà solo apertura e chiusura.

#### Trade-off

L'approccio "callback di parola + G2P italiano a regole" funziona con `speak()` e non dipende da API incerte. Però non conosce la durata della parola finché non arriva la successiva, quindi richiede una stima da numero di fonemi e velocità (*deduzione*). L'approccio con `write()` dà tempi esatti e audio analizzabile, ma sposta su Ernie la riproduzione, le interruzioni e i bug di formato.

#### Implicazioni pratiche per Ernie
- **Spike di 1–2 giorni (stima mia, non da fonti):** registrare tutti i marker emessi da `speak()` e `write()` con le voci italiane installate (compact, enhanced, premium) su iOS 26.
- Prevedere comunque un G2P italiano a regole (c/g contestuali, geminate, accento) con fallback, sapendo che non ho trovato benchmark di accuratezza per l'italiano [50].
- Non incorporare eSpeak NG nell'app [51][52].
- Fissare un budget di sincronizzazione entro la finestra di percezione (audio non più di circa 45 ms in anticipo sulle labbra) [53].
- Tenere l'ampiezza come livello secondario, con `write()`, per modulare la mascella sopra i visemi [60].

### 2.4 Espressività e stato emotivo

#### Sintesi

Le piattaforme commerciali convergono su uno schema comune:
- **segnali di emozione** dal servizio conversazionale (Convai, Inworld) mappati su blendshape o parametri dell'Animator [54][55];
- **gesti** come eventi o azioni strutturate, non come tag inline nel testo [54][55];
- **idle, sguardo e ammiccamento** procedurali sul client [32][25].

#### Evidenze
- **Convai:** il personaggio riceve "audio, transcript, emotion signals, and action commands"; il modulo emozioni mappa i segnali su blendshape o parametri dell'Animator; il lip-sync supporta mappe ARKit, MetaHuman e CC4; l'SDK Unity supporta iOS [54] (Primaria; il servizio è cloud).
- **Inworld:** gli eventi di emozione e gesto arrivano dal server e il client implementa gli handler che riproducono le clip [55] (Primaria, estratto: la documentazione richiede login).
- **TalkingHead:** `setMood` (neutral, happy, angry, sad, fear, disgust, love, sleep), `playGesture` (handup, index, ok, thumbup, thumbdown, side, shrug), emoji convertite in espressioni e callback temporizzati (`markers`/`mtimes`) [32] (Primaria).
- **RealityKit:** IK e pose scheletriche per seguire un punto con lo sguardo o la testa, blendshape per le espressioni [25] (Primaria).
- **NVIDIA ACE/Tokkio:** pipeline cloud con LLM/RAG separato dall'avatar via REST e componenti NIM (ASR, TTS, Audio2Face) [57] (Primaria, 2025). È un modello architetturale, non una soluzione on-device.
- **Soul Machines:** il fornitore storico di "digital people" con tag comportamentali è in amministrazione controllata dal 5 febbraio 2026, con debiti per oltre 19,5 milioni di dollari (testata neozelandese, valuta presumibilmente NZD) [56] (Secondaria).
- **Duolingo** guida le bocche dei personaggi con una state machine Rive alimentata da tempi di fonemi e parole, con "20+" forme di bocca per personaggio, e sceglie Rive "as an alternative to a game engine" [58] (Primaria, 2022: fuori finestra, citato come precedente).
- **Live2D** è un'alternativa 2.5D: SDK nativo C++ con Metal su iOS; individui e piccole imprese esenti dalla licenza di pubblicazione; le "Expandable Applications" richiedono un contratto speciale [60] (Primaria).

#### Implicazioni pratiche per Ernie
- Definire nel protocollo WebSocket eventi tipizzati `emotion {name, intensity}`, `gesture {name}` e `gaze {target}`, ancorati a offset di carattere nel testo, così il client li attiva sul callback della parola corrispondente (*deduzione*, coerente con [40][32]).
- Usare un vocabolario chiuso e piccolo, ad esempio i preset VRM [34] o i mood di TalkingHead [32], invece di testo libero dall'LLM.
- Gestire idle, ammiccamento e micro-movimenti di sguardo sul client, indipendenti dalla rete.
- Valutare Rive o Live2D se l'obiettivo è carattere ed espressività più che volume 3D [58][59][60].

### 2.5 Architettura di integrazione

#### Sintesi

Ernie ha già un motore di stato conversazionale (listening, thinking, speaking, idle) che vive nell'app nativa perché lì stanno ASR e TTS. L'avatar deve esserne un **consumatore**: riceve stato, eventi di parola o visema ed emozioni, e non possiede la logica. Il costo di un ponte host↔motore cresce passando da RealityKit (nessun ponte) a WKWebView (messaggi JS), Godot (segnali), Unity (stringhe via `UnitySendMessage`) e Unreal (plugin nativo in Objective-C++; *deduzione*).

#### Evidenze
- **Ponti per runtime:** UaaL passa un singolo parametro stringa per messaggio [14]; SwiftGodotKit usa segnali e singleton `@Godot` [22][23]; WKWebView usa `postMessage` verso `WKScriptMessageHandler` e `callAsyncJavaScript` [63] (Primarie/Opinione come indicato).
- **Barge-in:** `stopSpeaking(at:)` con `AVSpeechBoundary.immediate` o `.word` cancella il parlato e svuota la coda [40]. Per ascoltare durante il parlato serve la cancellazione d'eco: `setVoiceProcessingEnabled(_:)` sull'I/O node di `AVAudioEngine` (iOS 13+) [63]. `SpeechAnalyzer` (iOS 26+) riceve l'audio come `AsyncSequence` [63] (Primaria). Con `usesApplicationAudioSession = false` il sistema crea una sessione audio separata per il parlato [40] (Primaria).
- **Peso del download:**
  - limiti di build: 4 GB non compressi, 500 MB di eseguibile (`__TEXT`); asset grandi delegabili a Background Assets [62] (Primaria);
  - limite su rete cellulare: 200 MB, che da iOS 13 l'utente può superare [19] (Primaria);
  - footprint dei motori: Unity vuoto 12–20 MB [19]; Godot circa +30 MB [23]; UE5 vuoto circa 300 MB [64].
- **App Review:** 2.5.2 (niente codice scaricato), 4.2 (funzionalità minima), 5.1.1 (consenso esplicito per condividere dati con "third-party AI") [61] (Primaria).
- **Accessibilità:** con Reduce Motion attivo, `accessibilityReduceMotion` indica di evitare "large animations, especially those that simulate the third dimension" [63] (Primaria).
- **Termica:** `ProcessInfo.ThermalState` (nominal, fair, serious, critical) e la notifica di cambiamento [63]. Apple suggerisce LOD più aggressivi e ombre ridotte negli stati serious e critical [28] (Primaria).

#### Implicazioni pratiche per Ernie
- La fonte di verità degli stati resta nel layer Swift. L'avatar riceve un flusso unidirezionale di eventi (stato, viseme o parola, emozione) e invia solo eventi di disponibilità o errore.
- Su barge-in: fermare il TTS, svuotare la coda dei visemi, chiudere la bocca entro un frame e passare l'avatar in "listening".
- Prevedere una modalità "avatar statico o ridotto" legata a Reduce Motion, allo stato termico e alla Modalità a basso consumo.
- Tenere il primo download sotto 200 MB. Un motore pesante, o un MetaHuman con texture a 2048, va valutato contro questo limite e contro Background Assets [19][62].
- Aggiornare informativa e consenso se il testo dell'utente arriva a LLM di terzi [61].

### 2.6 Confronto e raccomandazioni condizionate

Nessuna fonte consultata dichiara tempi di sviluppo per questi stack: **non riporto stime di tempo**. Come unico indicatore oggettivo di sforzo, TalkingHead dichiara la dimensione dei moduli di lip-sync (circa 4k per il finlandese, circa 12k per l'inglese) [32]. I costi sono presi solo da pagine ufficiali o, dove indicato, secondarie.

**(a) MVP rapido e leggero.**
- **Stack candidati:**
  - (a1) RealityKit in `RealityView` con avatar stilizzato USDZ (ARKit + visemi), visemi da callback di parola e G2P italiano a regole;
  - (a2) WKWebView con three.js e TalkingHead, alimentati dagli eventi nativi di `AVSpeechSynthesizer`;
  - (a3) 2D con Rive (state machine di bocche) sul modello Duolingo.
- **Rischi:** bug blendshape+scheletro e pipeline USDZ (a1) [29][30]; consumo di WKWebView non misurato e modulo italiano da scrivere (a2) [32]; minor "presenza" 3D (a3).
- **Costi di licenza:** zero per RealityKit e TalkingHead/three.js (MIT) [32]; Rive richiede un piano a pagamento per esportare senza splash, Cadet a 9 $ per seat al mese, runtime iOS MIT [59] (Primaria).

**(b) Qualità fotorealistica stile MetaHuman.**
- **Stack:** Unreal 5.8 con app "UE-first" o Pixel Streaming.
- **Rischi alti:**
  - nessun embedding iOS documentato [2][3];
  - MetaHuman limitato a LOD 3 su mobile [4];
  - lip-sync da audio non supportato a runtime da Epic [6][8];
  - nessun benchmark su iPhone;
  - peso dell'app [64];
  - Pixel Streaming richiede GPU server e contraddice il vincolo on-device [12].
- **Costi:** royalty del 5% oltre 1 M$ "lifetime" per app runtime distribuite a terzi [10] (Secondaria); seat MetaHuman sopra 1 M$ se reso fuori da UE [9] (Secondaria).

**(c) Compromesso stilizzato.**
- **Stack candidati:** personaggio custom o VRM con 52 ARKit + 15 visemi su RealityKit (nativo), oppure Unity UaaL (Animator, uLipSync), oppure Godot via SwiftGodotKit.
- **Rischi:**
  - Unity: schermo intero, 80–180 MB trattenuti, licenza Industry incerta [14][17][18];
  - Godot: progetto della community, libgodot su iOS non ufficiale [21][22];
  - Live2D come variante 2.5D: valutare la clausola "Expandable Applications" [60].
- **Costi:** Unity Pro 2.310 $/anno per seat sopra 200 K$, Industry obbligatorio sopra 1 M$ per app non-gioco [15]; Godot MIT [21].

---

## 3. Tabella comparativa motori e runtime

| Runtime | Integrazione SwiftUI | Dimensione app | Licenza / costo | Qualità avatar | Lip-sync disponibile | Maturità iOS | Rischio |
|---|---|---|---|---|---|---|---|
| **Unreal 5.8** | Nessun embedding iOS documentato (Library solo Windows/4.27) [2][3] | Build vuota ~300 MB, piattaforma non specificata [64] | Gratis < 1 M$; 5% oltre 1 M$ lifetime per app runtime [10] (Sec.) | MetaHuman, ma su mobile LOD 3, texture 2048, capelli a card [4] | Audio→faccia MetaHuman non supportato a runtime [8]; plugin di terzi [13] | Alta come motore di giochi; requisiti iOS 17+ [1] | **Alto** |
| **Unity 6 (UaaL)** | UIKit; solo schermo intero, un'istanza [14]; workaround non ufficiali per SwiftUI [20] | Vuoto 12–20 MB [19]; 80–180 MB di RAM trattenuti dopo l'unload [14] | Personal < 200 K$; Pro 2.310 $/anno; Industry > 1 M$ non-gioco; fee runtime Industry non pubbliche [15][17] | Buona (rig standard, Animator) | uLipSync (MIT) [46]; Convai (cloud) [54] | Alta (UaaL dal 2019.3) [14] | **Medio-alto** (licenza, UX) |
| **Godot (SwiftGodotKit)** | `GodotAppView` in SwiftUI, anche parziale [22][23] | Circa +30 MB [23] (Op.) | MIT [21] | Media (non verificata per volti) | Da implementare | Bassa-media: libgodot su iOS non ufficiale [21][22] | **Medio** |
| **RealityKit** | Nativa (`RealityView`, iOS 18+) [24] | Nessun motore aggiuntivo (*deduzione*) | Incluso nell'SDK Apple | Buona per stilizzati; rendering personaggi in evoluzione (WWDC26) [28] | Da implementare (blendshape + pose) [24][25] | Media: API recenti, pipeline asset debole [29][30] | **Medio-basso** |
| **SceneKit** | `UIViewRepresentable`/`SceneView` | Nessuna | Incluso | Media | Da implementare | In soft deprecation [27] | **Medio** (futuro) |
| **Filament** | `UIViewRepresentable` + `CAMetalLayer` (*deduzione*) | Non misurata | Apache-2.0 [31] | Buona (PBR; glTF morph e skin) [31] | Da implementare | Media (iOS 11+, Metal) [31] | **Medio** (lavoro C++) |
| **three.js / WKWebView (+TalkingHead)** | `UIViewRepresentable` + WKWebView; bridge JS [63] | Pochi MB di JS e asset (*deduzione*) | MIT [32][34] | Buona per stilizzati GLB (ARKit + visemi) [32] | Sì, da testo (niente italiano) o da audio (HeadAudio) [32][33] | Media (pipeline matura sul web) | **Medio-basso** (prestazioni da misurare) |

## 4. Opzioni di lip-sync con TTS Apple on-device

| Opzione | Ingresso | Disponibilità con voci di sistema | Latenza / sincronia | Qualità | Licenza | Offline |
|---|---|---|---|---|---|---|
| Callback di parola (`willSpeakRangeOfSpeechString`) + G2P italiano a regole | Testo + inizio parola | Sì (API documentata, iOS 7+) [40] | Evento all'inizio di ogni parola; durata da stimare (*deduz.*) | Media | Codice proprio; kokorog2p Apache-2.0 come riferimento [50] | Sì |
| Marker fonemici (`willSpeak` marker / `toMarkerCallback`) | Fonemi dal sintetizzatore | **Non verificata** (API iOS 16/17) [41] | Potenzialmente al campione (`byteSampleOffset`) [41] | Potenzialmente alta | Apple | Sì |
| `write()` + riproduzione propria + marker parola | Buffer PCM + marker | API iOS 16+ [41]; problemi di formato segnalati su iOS 17 beta [44] | Esatta (offset in campioni) | Alta sul timing | Apple | Sì |
| Ampiezza RMS (mascella/apertura) | Audio (richiede `write()`) | Sì via `write()` | Di blocco audio | Bassa | Codice proprio (approccio Live2D) [60] | Sì |
| Classificatore MFCC audio→visema (stile HeadAudio/uLipSync) | Audio (richiede `write()`) | Sì via `write()` | Circa 50 ms (HeadAudio, stima) [33] | Media; modelli inglesi [33][46] | MIT (da portare in Swift) | Sì |
| Rhubarb Lip Sync | File audio completo | Indiretta (file da `write()`) | Offline, non streaming [45] | Buona in inglese; fonetico "less precise" [45] | MIT [45] | Sì |
| TalkingHead `wordsToVisemes` (testo) | Testo + timestamp parola | Sì, tramite bridge degli eventi nativi | Come callback di parola | Fi >99,9% / En ~80% vs dizionario; italiano assente [32] | MIT | Sì |
| OVRLipSync | Audio | Nessun supporto iOS ufficiale [37] | — | — | Licenza SDK Meta [37] | — |
| NVIDIA Audio2Face-3D | Audio | No: richiede CUDA/TensorRT su Windows/Linux [47] | Real-time su GPU server [48] | Alta (output ARKit) [48] | SDK MIT; modelli con licenza NVIDIA [47] | No (server) |
| MetaHuman Animator da audio | Audio (Unreal) | Non supportato a runtime [8]; "Editor-only" su macOS [6] | — | Alta in editor | EULA UE | — |
| G2P lato backend (TypeScript) + timing lato client | Testo → sequenza fonemi | Indipendente dalla voce | Come callback di parola | Media-alta | GPL non distribuita all'utente (*valutazione legale*) [51] | No (serve rete per il G2P) |

## 5. Lacune e domande aperte

1. **Marker fonemici e bookmark con le voci italiane di sistema:** l'API esiste [41] ma nessuna fonte dice se le voci Apple li emettano, né se i `<mark>` SSML diventino bookmark [42][43]. Serve uno spike su dispositivo.
2. **Affidabilità di `write()` su iOS 18/26** e con Personal Voice: ho trovato solo segnalazioni sulle beta di iOS 17 [44].
3. **MetaHuman su iPhone:** nessun benchmark di FPS, memoria o temperatura; la pagina dei requisiti non dichiara esplicitamente il supporto mobile [5].
4. **Unreal su iOS come framework:** l'opzione "Build as a Framework" citata in un forum [3] non è confermata da documentazione Epic.
5. **Licenze Epic:** pagina di licenza, FAQ ed EULA MetaHuman irraggiungibili (403/503). Royalty, seat e uso di MetaHuman fuori da UE sono presi da fonti secondarie [9][10][11]; un blog del 2026 contraddice l'uso fuori da UE senza citare fonti (non incluso in bibliografia).
6. **Unity Industry:** importo e meccanismo delle fee di distribuzione per app consumer non-gioco non pubblicati [17][18]; non è chiaro se un "Industry Customer" sotto 1 M$ possa usare Personal [16].
7. **RealityKit:** lo stato del bug blendshape+animazione scheletrica su iOS 26 è sconosciuto [29]; mancano linee guida ufficiali per esportare da Blender [30].
8. **WKWebView/WebGL:** nessuna misura di batteria o temperatura per un avatar three.js su iPhone.
9. **G2P italiano:** nessun benchmark di accuratezza per regole o lessici italiani [50].
10. **Export MetaHuman verso runtime non-Unreal su mobile** (glTF/USDZ con rig facciale): fattibilità tecnica non verificata.
11. **Avaturn e altri generatori:** prezzi e termini commerciali ufficiali non verificati [39].
12. **Dimensioni reali dei binari** con le toolchain 2026: servono build di prova con App Thinning Size Report. I dati attuali sono parziali o di community [19][23][64].
13. **Live2D:** non è chiaro se un assistente AI con avatar ricada nelle "Expandable Applications" [60].
14. **Inworld e Soul Machines:** documentazione dietro login o azienda in amministrazione controllata; dettagli sui tag non verificati [55][56].

---

## 6. Bibliografia

Tutte le URL sono state consultate il 10 ottobre 2026 salvo diversa indicazione. "n.d." = data non indicata sulla pagina.

1. **iOS, iPadOS, and tvOS Development Requirements for Unreal Engine (UE 5.8)** — Epic Games, n.d. (2026). https://dev.epicgames.com/documentation/unreal-engine/ios-ipados-and-tvos-development-requirements-for-unreal-engine — Documentazione — Primaria.
2. **Building Unreal Engine as a Library (UE 4.27)** — Epic Games, n.d. https://dev.epicgames.com/documentation/en-us/unreal-engine/building-unreal-engine-as-a-library?application_version=4.27 — Documentazione — Primaria.
3. **Importing Unreal Engine as a library into IOS app project** — Epic Developer Community Forums, 22/01/2025. https://forums.unrealengine.com/t/importing-unreal-engine-as-a-library-into-ios-app-project/2296255 — Forum — Opinione.
4. **Platform Support and LOD Specifications for MetaHumans** — Epic Games, n.d. https://dev.epicgames.com/documentation/metahuman/platform-support-and-lod-specifications-for-metahumans — Documentazione — Primaria.
5. **Requirements and Configuration Settings for MetaHumans in Unreal Engine** — Epic Games, n.d. https://dev.epicgames.com/documentation/metahuman/requirements-and-configuration-settings-for-metahumans-in-unreal-engine — Documentazione — Primaria.
6. **MetaHuman 5.8 Release Notes** — Epic Games, 2026. https://dev.epicgames.com/documentation/metahuman/metahuman-5-8-release-notes-in-unreal-engine — Note di rilascio — Primaria.
7. **MetaHuman 5.7 Released!** — Epic Games (J. Pullan), 12/11/2025. https://forums.unrealengine.com/t/metahuman-5-7-released/2672724 — Annuncio ufficiale — Primaria.
8. **MH Animator - runtime lipsync from audio** (risposta dello staff Epic M. Streatfield) — Epic Developer Community Forums, 18–20/06/2025. https://forums.unrealengine.com/t/mh-animator-runtime-lipsync-from-audio/2611561 — Forum, dichiarazione staff — Primaria.
9. **You can now sell MetaHumans, or use them in Unity or Godot** — J. Thacker, CG Channel, 04/06/2025. https://www.cgchannel.com/2025/06/you-can-now-sell-metahumans-or-use-them-in-unity-or-godot/ — Stampa di settore — Secondaria.
10. **Epic confirms its new Unreal Engine pricing…** — VGC, 13/03/2024. https://videogameschronicle.com/news/epic-confirms-its-new-unreal-engine-pricing-keeps-its-promise-not-to-change-it-for-game-developers — e **Unreal Engine updates pricing for non-game industries** — CGPress, 13/03/2024. https://cgpress.org/archives/unreal-engine-updates-pricing-for-non-game-industries.html — Stampa — Secondaria.
11. **Unreal Engine EULA — estratti (royalty 5%, Launch Everywhere 3,5%)** — ConductAtlas, documento datato 05/05/2026. https://conductatlas.com/platform/unreal-engine/unreal-engine-eula/ — Archivio di terzi — Secondaria.
12. **Unreal Engine Pixel Streaming Reference** — Epic Games, n.d. https://dev.epicgames.com/documentation/unreal-engine/unreal-engine-pixel-streaming-reference — Documentazione — Primaria.
13. **Runtime MetaHuman Lip Sync** — Georgy Dev, n.d. (2026). https://solutions.georgy.dev/runtime-metahuman-lip-sync — Pagina prodotto di terzi — Opinione.
14. **Unity as a Library** e **Integrating Unity into native iOS applications** (Manuale 6.2) — Unity Technologies, n.d. https://docs.unity3d.com/6000.2/Documentation/Manual/UnityasaLibrary.html ; https://docs.unity3d.com/6000.2/Documentation/Manual/UnityasaLibrary-iOS.html — Documentazione — Primaria.
15. **Changes to Unity subscription plans and pricing** e **Plans & Pricing** — Unity Technologies, 2024–2026. https://unity.com/pricing-updates ; https://unity.com/products — Pagine ufficiali — Primaria.
16. **Unity Editor Software Terms** (agg. 30/06/2026) e **Terms of Service FAQ** (agg. 13/08/2025) — Unity Technologies. https://unity.com/legal/editor-terms-of-service/software ; https://unity.com/legal/editor-terms-of-service/software/faq — Termini legali — Primaria.
17. **Unity Industry Terms of Service** — Unity Technologies, agg. 03/08/2026. https://unity.com/legal/industry-terms-of-service — Termini legali — Primaria.
18. **Questions about Unity Industry Runtime Fee** — Unity Discussions, 29/11/2025–25/08/2026. https://discussions.unity.com/t/questions-about-unity-industry-runtime-fee/1697714 — Forum — Opinione.
19. **Optimizing the size of the built iOS Player** (Manuale 6.6) e **Application.targetFrameRate** — Unity Technologies, n.d. https://docs.unity3d.com/Manual/iphone-playerSizeOptimization.html ; https://docs.unity3d.com/ScriptReference/Application-targetFrameRate.html — Documentazione — Primaria.
20. **unity-swiftui-example, PR #14 (embedding parziale in SwiftUI)** — D. Peicho e contributori, n.d. https://github.com/DavidPeicho/unity-swiftui-example/pull/14 — Codice della community — Opinione.
21. **Godot 4.6 Release** (gennaio 2026) e **Exporting for iOS** (docs 4.7) — Godot Foundation. https://godotengine.org/releases/4.6/ ; https://docs.godotengine.org/en/stable/tutorials/export/exporting_for_ios.html — Note di rilascio e documentazione — Primaria. Licenza MIT: https://github.com/godotengine/godot.
22. **SwiftGodotKit — Embed Godot into Swift apps** (README) — M. de Icaza e contributori, 2026. https://github.com/migueldeicaza/SwiftGodotKit — Codice (non ufficiale Godot) — Primaria.
23. **Embedding Godot games in iOS apps is easy now** — C. Selig, 31/05/2025. https://christianselig.com/2025/05/godot-ios-interop/ — Blog — Opinione.
24. **RealityKit: RealityView, RealityViewCameraContent, BlendShapeWeightsComponent, BlendShapeWeightsMapping, SkeletalPosesComponent, IKComponent** — Apple, n.d. https://developer.apple.com/documentation/realitykit/realityview (e pagine sorelle `/blendshapeweightscomponent`, `/skeletalposescomponent`, `/ikcomponent`) — Documentazione — Primaria.
25. **Compose interactive 3D content in Reality Composer Pro** (WWDC24, sessione 10102) — Apple, 06/2024. https://developer.apple.com/videos/play/wwdc2024/10102/ — Sessione tecnica — Primaria.
26. **Discover RealityKit APIs for iOS, macOS and visionOS** (WWDC24, sessione 10103) — Apple, 06/2024. https://developer.apple.com/videos/play/wwdc2024/10103/ — Sessione tecnica — Primaria.
27. **Bring your SceneKit project to RealityKit** (WWDC25, sessione 288) e articolo **Bringing your SceneKit projects to RealityKit** — Apple, 06/2025. https://developer.apple.com/videos/play/wwdc2025/288/ ; https://developer.apple.com/documentation/realitykit/bringing-your-scenekit-projects-to-realitykit — Primaria.
28. **Explore advances in RealityKit** (WWDC26, sessione 279) — Apple, 06/2026. https://developer.apple.com/wwdc26/279/ — Sessione tecnica — Primaria.
29. **BlendShapes don't animate while playing animation in RealityKit** — Apple Developer Forums, 07/2025. https://developer.apple.com/forums/thread/793431 — Forum — Opinione.
30. **USDZ with Blend Shapes Workflow Recommendations** (risposta accettata di un ingegnere Apple) — Apple Developer Forums, 10/2024–01/2025. https://developer.apple.com/forums/thread/766484 — Forum — Primaria (risposta Apple) / Opinione (resto).
31. **Filament** (README) — Google, 2026. https://github.com/google/filament — Codice e documentazione — Primaria.
32. **TalkingHead (3D)** (README, licenza MIT) — met4citizen, agg. 25/09/2026. https://github.com/met4citizen/TalkingHead — Codice — Primaria.
33. **HeadAudio** (README, MIT) — met4citizen, 2025–2026. https://github.com/met4citizen/HeadAudio — Codice — Primaria.
34. **three-vrm** (MIT) e **VRM 1.0 — Expressions** (specifica VRMC_vrm-1.0) — pixiv / VRM Consortium. https://github.com/pixiv/three-vrm ; https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm-1.0/expressions.md — Codice e specifica — Primaria.
35. **ARFaceAnchor.BlendShapeLocation** — Apple, n.d. https://developer.apple.com/documentation/arkit/arfaceanchor/blendshapelocation — Documentazione — Primaria.
36. **Oculus Lipsync Viseme Reference** — Meta, n.d. https://developers.meta.com/horizon/documentation/unity/audio-ovrlipsync-viseme-reference/ — Documentazione — Primaria.
37. **Why does the Oculus Lipsync for Unity plugin not support the iOS App Store?** — Meta Community Forums (archivio), n.d. https://communityforums.atmeta.com/discussions/dev-dashboard/why-does-the-oculus-lipsync-for-unity-plugin-not-support-the-ios-app-store%EF%BC%9F/1099014 — Forum — Opinione.
38. **Netflix acquires gaming avatar maker Ready Player Me** — S. Perez, TechCrunch, 19/12/2025. https://techcrunch.com/2025/12/19/netflix-acquires-gaming-avatar-maker-ready-player-me/ — e **Netflix Acquires XR Avatar Startup Ready Player Me** — S. Hayden, Road to VR, 22/12/2025. https://roadtovr.com/netflix-acquires-xr-avatar-startup-ready-player-me/ — Stampa — Secondaria.
39. **Avaturn Developer Docs — Bodies (T1/T2)** — Avaturn, n.d. https://docs.avaturn.me/docs/integration/bodies/ — Documentazione — Primaria.
40. **AVSpeechSynthesizer**; **AVSpeechSynthesizerDelegate** (`speechSynthesizer(_:willSpeakRangeOfSpeechString:utterance:)`, `speechSynthesizer(_:willSpeak:utterance:)`); **stopSpeaking(at:)**; **usesApplicationAudioSession** — Apple, n.d. https://developer.apple.com/documentation/avfaudio/avspeechsynthesizer ; https://developer.apple.com/documentation/avfaudio/avspeechsynthesizerdelegate — Documentazione — Primaria.
41. **AVSpeechSynthesisMarker** (`Mark.phoneme`, `phoneme`, `bookmarkName`, `byteSampleOffset`) e **write(_:toBufferCallback:toMarkerCallback:)** — Apple, n.d. https://developer.apple.com/documentation/avfaudio/avspeechsynthesismarker ; https://developer.apple.com/documentation/avfaudio/avspeechsynthesizer/write(_:tobuffercallback:tomarkercallback:) — Documentazione — Primaria.
42. **AVSpeechUtterance init(ssmlRepresentation:)**, **AVSpeechSynthesisIPANotationAttribute**, **AVSpeechSynthesisProviderAudioUnit** — Apple, n.d. https://developer.apple.com/documentation/avfaudio/avspeechutterance ; https://developer.apple.com/documentation/avfaudio/avspeechsynthesisprovideraudiounit — Documentazione — Primaria.
43. **Extend Speech Synthesis with personal and custom voices** (WWDC23, sessione 10033) — Apple, 06/2023. https://developer.apple.com/videos/play/wwdc2023/10033/ — Sessione tecnica — Primaria.
44. **AVSpeechSynthesisMarker - iOS 18 - Sync lost** (11/2024–06/2025, con risposta Apple) e **write() audio choppy on iOS 17** (06/2023) — Apple Developer Forums. https://developer.apple.com/forums/thread/769342 ; https://developer.apple.com/forums/thread/731624 — Forum — Opinione.
45. **Rhubarb Lip Sync** (README, LICENSE MIT, v1.14.0 del 03/04/2025) — D. S. Wolf. https://github.com/DanielSWolf/rhubarb-lip-sync — Codice — Primaria.
46. **uLipSync** (README, MIT) — hecomi, agg. 01/2026. https://github.com/hecomi/uLipSync — Codice — Primaria.
47. **Audio2X SDK (Audio2Face-3D SDK)** (README, MIT) — NVIDIA, 2025. https://github.com/NVIDIA/Audio2Face-3D-SDK — Codice — Primaria.
48. **Audio2Face-3D: Audio-driven Realistic Facial Animation For Digital Avatars** — C. Chung et al. (NVIDIA), arXiv 2508.16401, 22/08/2025. https://arxiv.org/abs/2508.16401 — Paper (preprint) — Primaria.
49. **Letteratura sulla facial animation 3D guidata dal parlato:** Peng et al., *EmoTalk* (ICCV 2023), https://arxiv.org/abs/2303.11089 ; Xing et al., *CodeTalker* (CVPR 2023), https://arxiv.org/abs/2301.02379 ; Fan et al., *UniTalker* (ECCV 2024), https://arxiv.org/abs/2408.00762 — Paper — Primaria.
50. **kokorog2p — Italian G2P** (Apache-2.0) — buchwandler, v0.9.15. https://kokorog2p.readthedocs.io/en/latest/api/italian.html ; https://github.com/buchwandler/kokorog2p — Codice e documentazione — Primaria (accuratezza auto-dichiarata).
51. **eSpeak NG** (GPL-3.0) — eSpeak NG contributors, agg. 09/2026. https://github.com/espeak-ng/espeak-ng — Codice — Primaria.
52. **The GPL, the App Store, and you** — Engadget, 09/01/2011. https://www.engadget.com/2011-01-09-the-gpl-the-app-store-and-you.html — Stampa (precedente storico) — Secondaria.
53. **Audio-to-video synchronization** (soglie ITU-R BT.1359) — Wikipedia, consultata 10/2026. https://en.wikipedia.org/wiki/Audio-to-video_synchronization — e NTIA/ITS, report 11-474, https://its.ntia.gov/publications/download/11-474.pdf — Secondaria.
54. **What is the Convai Unity SDK** — Convai, n.d. (2026). https://docs.convai.com/api-docs/plugins-and-integrations/convai-unity-sdk/overview/what-is-the-convai-unity-sdk — Documentazione — Primaria.
55. **Inworld — Emotion / InworldAnimation (Unity)** — Inworld AI, n.d. https://docs.inworld.ai/docs/runtime-character-attributes/emotion/ — Documentazione (estratto; accesso con login) — Primaria.
56. **Soul Machines in receivership** e **Soul Machines owes $19.5m in receivership** — NBR, 02/2026 e 04/2026. https://www.nbr.co.nz/tech/soul-machines-in-receivership ; https://www.nbr.co.nz/tech/soul-machines-owes-19-5m-in-receivership — Stampa — Secondaria.
57. **NVIDIA ACE — documentazione e blueprint "Digital Humans for Customer Service" (Tokkio)** — NVIDIA, 03–04/2025. https://docs.nvidia.com/ace/overview/2025.04.28/index.html ; https://build.nvidia.com/nvidia/digital-humans-for-customer-service/blueprintcard — Documentazione — Primaria.
58. **World character visemes** — J. Vahidsafa, K. Lenzo (Duolingo), 10/11/2022. https://blog.duolingo.com/world-character-visemes — Blog tecnico aziendale — Primaria (fuori finestra 2023+, citato come precedente).
59. **Rive — Pricing** e **rive-ios** (MIT) — Rive, n.d. (2026). https://rive.app/pricing ; https://github.com/rive-app/rive-ios — Pagina ufficiale e codice — Primaria.
60. **Live2D Cubism SDK — License** e **Lip-sync Based on Volume of Wav Files (Native)** — Live2D Inc., n.d. https://www.live2d.com/en/sdk/license/ ; https://docs.live2d.com/en/cubism-sdk-tutorials/native-lipsync-from-wav-native/ — Licenza e documentazione — Primaria.
61. **App Store Review Guidelines** — Apple, agg. 08/06/2026. https://developer.apple.com/app-store/review/guidelines/ — Linee guida — Primaria.
62. **Maximum build file sizes** — Apple, App Store Connect Help, n.d. https://developer.apple.com/help/app-store-connect/reference/maximum-build-file-sizes/ — Documentazione — Primaria.
63. **API Apple varie:** `SpeechAnalyzer` (iOS 26), `AVAudioIONode.setVoiceProcessingEnabled(_:)`, `WKScriptMessageHandler`, `WKWebView.callAsyncJavaScript`, `EnvironmentValues.accessibilityReduceMotion`, `ProcessInfo.ThermalState` — Apple, n.d. https://developer.apple.com/documentation/speech/speechanalyzer ; https://developer.apple.com/documentation/avfaudio/avaudioionode/setvoiceprocessingenabled(_:) ; https://developer.apple.com/documentation/webkit/wkscriptmessagehandler ; https://developer.apple.com/documentation/swiftui/environmentvalues/accessibilityreducemotion ; https://developer.apple.com/documentation/foundation/processinfo/thermalstate-swift.enum — Documentazione — Primaria.
64. **Community Tutorial: How to Reduce Package Size in Unreal Engine 5** — CobraCode, Epic Developer Community Forums, 26/07/2024. https://forums.unrealengine.com/t/1950640 — Forum/tutorial — Opinione.
