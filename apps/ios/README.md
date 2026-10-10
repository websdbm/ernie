# Ernie iOS (milestone M7–M8, avatar M10)

Client nativo SwiftUI: interfaccia principale dell'agente. Il progetto Xcode verrà creato nella M7.

## Vincoli verificati (ottobre 2026; dettagli e fonti in `docs/research/02`, `04`, `03-revisione.md`)

- **Speech-to-text**: `SpeechAnalyzer` + `SpeechTranscriber` (iOS 26+, on-device, modelli scaricati dal sistema tramite `AssetInventory`; italiano incluso al lancio). Verificare a runtime `supportedLocales` e `installedLocales`. Fallback: `SFSpeechRecognizer` (limite di **1 minuto** per richiesta: rotazione delle richieste; quote giornaliere; possibile uso di rete).
- **Text-to-speech**: `AVSpeechSynthesizer`, sintesi incrementale per frasi, interrompibile. Per il lip-sync: callback di parola garantiti; marker fonemici (`AVSpeechSynthesisMarker.Mark.phoneme`) da verificare con le voci italiane (spike S1).
- **Audio**: `AVAudioSession` `.playAndRecord` **più `setVoiceProcessingEnabled(true)`** sull'input node: il solo modo `.voiceChat` non attiva cancellazione d'eco e AGC.
- **Background**: nessuna wake word per app terze né avvio del microfono dal background; `AudioRecordingIntent` richiede una Live Activity. La modalità continua è prevista con app in primo piano.
- **Latenza**: obiettivo udibile p50 < 1,5 s (800 ms come ambizione), strumentata per stadio.
- **Trasporto**: WebSocket con il protocollo v1/v1.1 di `packages/protocol` (eventi con id, sessionId, correlationId, seq, ts; cancel idempotente con `spokenThroughIndex`; snapshot + replay).
- **Sicurezza**: token nel Keychain; nessun segreto nel bundle; nessuna immagine markdown da URL esterni; step-up Face ID per azioni critiche; nessuna connessione verso URL ricevuti da deep link.
- **Avatar (M10)**: candidati RealityKit (primario) e three.js + TalkingHead in WKWebView; asset con 52 blendshape ARKit + 15 visemi Oculus; lip-sync on-device (parola + G2P italiano a regole, niente eSpeak NG). Unreal/MetaHuman embedded non percorribili (vedi ARCHITECTURE.md §13).
