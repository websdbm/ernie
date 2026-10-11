# Ernie iOS (M7)

Client SwiftUI per iOS 26: **una sola schermata** in stile chat, con lo spazio in alto riservato all'avatar tridimensionale (M10) e un solo pulsante: microfono (un tocco avvia l'ascolto, ↑ invia, ✕ annulla; stato, livello del microfono e trascrizione in tempo reale nella barra), invio quando c'è testo, stop mentre Ernie parla. Le richieste di conferma dei tool e le notifiche delle automazioni compaiono come schede dentro la conversazione, con Approva / Rifiuta (Face ID o codice). Le impostazioni stanno dietro il menu in alto a destra.

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

## TestFlight

`scripts/testflight.sh` archivia la build Release e la carica su App Store Connect. Servono: una scheda dell'app su [App Store Connect](https://appstoreconnect.apple.com/apps) con bundle id `com.websdbm.ernie`; l'autenticazione tramite chiave API (`ASC_KEY_ID`, `ASC_ISSUER_ID`, file `.p8` in `~/.appstoreconnect/private_keys/`, ruolo App Manager) oppure l'account Apple configurato in Xcode (Impostazioni → Account); la capability Push Notifications (aggiunta automaticamente al profilo dalla firma automatica). Dopo il caricamento la build va elaborata (5–15 minuti) e poi assegnata a un gruppo di tester interni in TestFlight; sul telefono serve l'app TestFlight. Le build di release non contengono gli hook `ERNIE_DEBUG_*` e si collegano solo al server indicato al primo avvio (per una VPS usa HTTPS). Nota: lo script forza il PATH di sistema perché il passo di creazione dell'IPA usa `/usr/bin/rsync` (openrsync) e, con l'rsync di Homebrew nel PATH, fallisce con «Copy failed».

## Struttura

```
Ernie/App        ErnieApp, AppModel (stato radice), AppDelegate (APNs, notifiche)
Ernie/Protocol   porting del protocollo v1.1: eventi (Codable), deduplica e sequenze, client WebSocket con ripresa e riconnessione
Ernie/Api        REST: /v1/me, impostazioni, notifiche, approvazioni, dispositivi
Ernie/Chat       modelli, ConversationStore (eventi → stato, TTS incrementale, cronologia locale), ChatView, schede, barra di input, AvatarStage
Ernie/Speech     sessione audio (playAndRecord + voice processing), cattura, SpeechTranscriber/SFSpeechRecognizer, Speaker, VoiceController, probe S1
Ernie/Settings   onboarding, impostazioni (voce, interruttore di emergenza, diagnostica)
ErnieTests       test unitari (Swift Testing): protocollo, deduplica, frasi per il TTS, latenza, schede
```

## Diagnostica

Impostazioni → Diagnostica mostra la latenza udibile per stadio dei turni vocali (rilascio del pulsante → trascrizione finale → primo token → prima parola sintetizzata; obiettivo p50 < 1,5 s), il motore di trascrizione in uso e il probe dello spike S1 (marker delle voci italiane, vedi `docs/research/08-spike-s1-marker-tts.md`).

## Vincoli verificati (ottobre 2026; dettagli e fonti in `docs/research/02`, `04`, `03-revisione.md`)

- **Speech-to-text**: `SpeechAnalyzer` + `SpeechTranscriber` (iOS 26+, on-device, modelli scaricati dal sistema tramite `AssetInventory`). Verificare a runtime `supportedLocales`/`installedLocales`. Fallback `SFSpeechRecognizer` (limite di **1 minuto** per richiesta: rotazione).
- **Text-to-speech**: `AVSpeechSynthesizer`, sintesi incrementale per frasi, interrompibile. Spike S1: con le voci italiane `write()` non produce marker; `speak()` consegna i callback di parola (niente fonemi).
- **Audio**: `AVAudioSession` `.playAndRecord` **più `setVoiceProcessingEnabled(true)`** sull'input node (AEC/AGC).
- **Background**: nessuna wake word né microfono dal background; conversazione continua (M8) in primo piano.
- **Sicurezza**: chiave nel Keychain; nessun segreto nel bundle; markdown solo inline (nessuna immagine remota); step-up Face ID per approvazioni e interruttore di emergenza; nessuna connessione verso URL ricevuti da deep link.
- **Avatar (M10)**: three.js + TalkingHead in `WKWebView` al posto di `AvatarStage`, stessa macchina a stati (idle / listening / thinking / speaking) ed eventi `avatar.*`.
