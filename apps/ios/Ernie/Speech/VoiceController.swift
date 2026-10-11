import AVFoundation
import Foundation
import Observation

/// Voce a un tocco (decisione dell'utente, 11 ott 2026): tocca il microfono → ascolto (con barge-in se Ernie parla);
/// tocca ↑ → trascrizione finale → invio come voce; ✕ annulla. Ogni fase è visibile nella barra (`statusText`),
/// insieme al livello del microfono, così si capisce sempre cosa sta succedendo.
@MainActor
@Observable
final class VoiceController {
    enum Phase: Equatable {
        case idle
        /// Permesso, modello, sessione audio e motore in avvio.
        case preparing
        /// Prima volta: il sistema scarica il modello italiano (avanzamento 0…1).
        case downloadingModel(Double)
        case listening
        case finalizing
    }

    private(set) var phase: Phase = .idle
    private(set) var liveTranscript = ""
    /// Livello del microfono (0…1) aggiornato ~25 volte al secondo mentre ascolta.
    private(set) var inputLevel: Float = 0
    private(set) var engineName = "—"
    private(set) var lastError: String?
    private(set) var voiceProcessingActive = false
    private(set) var modelState: SpeechModel.State = .notInstalled

    var isListening: Bool { phase == .listening }
    var isActive: Bool { phase != .idle }

    /// Cosa sta succedendo, sempre: lo legge la barra di input.
    var statusText: String {
        switch phase {
        case .idle: ""
        case .preparing: "Preparo il microfono…"
        case .downloadingModel(let p): "Scarico il modello vocale italiano (solo la prima volta)… \(Int(p * 100))%"
        case .listening: liveTranscript.isEmpty ? "Ti ascolto. Parla, poi tocca ↑ per inviare." : liveTranscript
        case .finalizing: liveTranscript.isEmpty ? "Trascrivo…" : liveTranscript
        }
    }

    private let conversation: ConversationStore
    private let speaker: Speaker
    private var capture: MicrophoneCapture?
    private var engine: (any SpeechInput)?
    private var reader: Task<Void, Never>?
    private var starter: Task<Void, Never>?
    private var lastFinalText: String?
    private var heardSpeech = false

    init(conversation: ConversationStore, speaker: Speaker) {
        self.conversation = conversation
        self.speaker = speaker
    }

    /// Scarica il modello italiano in anticipo (all'avvio), così il primo tocco non aspetta.
    func prewarm() async {
        modelState = await SpeechModel.shared.refresh()
        if case .notInstalled = modelState {
            try? await SpeechModel.shared.ensureInstalled()
            modelState = await SpeechModel.shared.refresh()
        }
    }

    /// Il pulsante: avvia l'ascolto, oppure lo chiude e invia.
    func toggle() {
        switch phase {
        case .idle: startListening()
        case .listening: finishListening()
        case .preparing, .downloadingModel: cancelListening()
        case .finalizing: break
        }
    }

    func startListening() {
        guard phase == .idle else { return }
        lastError = nil
        liveTranscript = ""
        lastFinalText = nil
        heardSpeech = false
        inputLevel = 0
        if speaker.isSpeaking || conversation.isBusy { conversation.bargeIn() }
        phase = .preparing
        starter = Task { await startCapture() }
    }

    func finishListening() {
        guard phase == .listening else { return }
        phase = .finalizing
        conversation.currentTrace = LatencyTrace()
        conversation.currentTrace?.mark(.pttReleased)
        Task { await finishAndSend() }
    }

    func cancelListening() {
        starter?.cancel()
        phase = .idle
        liveTranscript = ""
        inputLevel = 0
        conversation.setListening(false)
        Task { await teardown() }
    }

    // MARK: - privato

    private func startCapture() async {
        do {
            guard await AVAudioApplication.requestRecordPermission() else {
                throw NSError(domain: "Ernie.Speech", code: 4, userInfo: [
                    NSLocalizedDescriptionKey: "Permesso microfono negato: abilitalo in Impostazioni → Privacy e sicurezza → Microfono → Ernie.",
                ])
            }
            try Task.checkCancellation()
            await ensureModelWithProgress()
            try Task.checkCancellation()
            phase = .preparing
            try AudioSessionController.activateForVoice()
            let capture = MicrophoneCapture()
            capture.onLevel = { [weak self] level in
                Task { @MainActor [weak self] in self?.updateLevel(level) }
            }
            let audio = try await capture.start()
            guard let format = capture.format else { throw NSError(domain: "Ernie.Speech", code: 5) }
            self.capture = capture
            voiceProcessingActive = capture.voiceProcessing
            let engine = await SpeechInputFactory.make()
            self.engine = engine
            engineName = engine.engineName
            let updates = try await engine.start(audio: audio, inputFormat: format)
            try Task.checkCancellation()
            phase = .listening
            conversation.setListening(true)
            Log.speech.info("ascolto avviato con \(engine.engineName, privacy: .public)")
            reader = Task { [weak self] in
                for await update in updates {
                    guard let self else { return }
                    self.liveTranscript = update.text
                    if update.isFinal { self.lastFinalText = update.text }
                }
            }
        } catch is CancellationError {
            await teardown()
        } catch {
            Log.speech.error("avvio ascolto fallito: \(error.localizedDescription, privacy: .public)")
            fail(error.localizedDescription)
        }
    }

    /// Se il modello italiano manca, lo scarica mostrando l'avanzamento; se fallisce si prosegue col ripiego (SFSpeechRecognizer).
    private func ensureModelWithProgress() async {
        modelState = await SpeechModel.shared.refresh()
        guard case .notInstalled = modelState else { return }
        phase = .downloadingModel(0)
        let install = Task { try await SpeechModel.shared.ensureInstalled() }
        let poller = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                if case .downloading(let p) = await SpeechModel.shared.state { self?.phase = .downloadingModel(p) }
                try? await Task.sleep(for: .milliseconds(250))
            }
        }
        if case .failure(let error) = await install.result {
            Log.speech.warning("modello non scaricato, uso il ripiego: \(error.localizedDescription, privacy: .public)")
        }
        poller.cancel()
        modelState = await SpeechModel.shared.refresh()
    }

    private func updateLevel(_ level: Float) {
        guard phase == .listening else { return }
        inputLevel = level
        if level > 0.35 { heardSpeech = true }
    }

    private func fail(_ message: String) {
        lastError = message
        phase = .idle
        inputLevel = 0
        conversation.setListening(false)
        Task { await teardown() }
    }

    private func finishAndSend() async {
        guard let engine, let capture else {
            phase = .idle
            conversation.setListening(false)
            return
        }
        capture.stop()
        // La finalizzazione arriva dal lettore dei risultati; oltre 3 s si usa l'ultimo parziale.
        let stopTask = Task { await engine.stop() }
        let deadline = ContinuousClock.now + .seconds(3)
        while lastFinalText == nil, ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(50))
        }
        stopTask.cancel()
        let text = (lastFinalText ?? liveTranscript).trimmingCharacters(in: .whitespacesAndNewlines)
        conversation.currentTrace?.mark(.transcriptFinal)
        let heard = heardSpeech
        let name = engineName
        await teardown()
        phase = .idle
        inputLevel = 0
        conversation.setListening(false)
        liveTranscript = ""
        guard !text.isEmpty else {
            conversation.currentTrace = nil
            lastError = heard
                ? "Ho sentito la tua voce ma non ho trascritto nulla (\(name)). Riprova; se continua, apri Impostazioni → Diagnostica."
                : "Non ho sentito nulla dal microfono: parla più vicino al telefono e riprova."
            return
        }
        conversation.send(text, inputMode: "voice")
    }

    private func teardown() async {
        reader?.cancel()
        reader = nil
        capture?.stop()
        capture = nil
        engine = nil
        AudioSessionController.deactivate()
    }
}
