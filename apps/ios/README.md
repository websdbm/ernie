# Ernie iOS (milestone M7–M8)

Client nativo SwiftUI: interfaccia principale dell'agente. Il progetto Xcode verrà creato nella M7.

## Vincoli verificati (ottobre 2026)

- **Speech-to-text**: `SpeechAnalyzer` + `SpeechTranscriber` (iOS 26+, on-device, modelli scaricati dal sistema tramite `AssetInventory`). Italiano incluso nelle lingue di lancio. Verificare a runtime `SpeechTranscriber.supportedLocales` e `installedLocales`. Fallback: `SFSpeechRecognizer` (iOS 10+, limiti di durata e possibile uso di rete).
- **Text-to-speech**: `AVSpeechSynthesizer`, sintesi incrementale per frasi (coda di `AVSpeechUtterance`), interrompibile.
- **Audio**: `AVAudioSession` categoria `.playAndRecord`, modo `.voiceChat` (cancellazione d'eco di sistema) per la modalità continua.
- **Background**: nessuna garanzia di ascolto continuo illimitato in background; la modalità continua è prevista solo con app in primo piano.
- **Trasporto**: WebSocket con il protocollo versionato in `packages/protocol` (eventi con id, sessionId, correlationId, seq, ts).
- **Sicurezza**: token nel Keychain; nessun segreto nel bundle.

Dettagli in `ARCHITECTURE.md` (sezione iOS) e in `docs/research/`.
