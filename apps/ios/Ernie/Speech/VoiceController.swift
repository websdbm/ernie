import AVFoundation
import Foundation
import Observation

/// Push-to-talk: premi → ascolto (con barge-in se Ernie parla); rilascia → trascrizione finale → invio come voce.
@MainActor
@Observable
final class VoiceController {
    private(set) var isListening = false
    private(set) var isFinalizing = false
    private(set) var liveTranscript = ""
    private(set) var engineName = "—"
    private(set) var lastError: String?
    private(set) var voiceProcessingActive = false

    private let conversation: ConversationStore
    private let speaker: Speaker
    private var capture: MicrophoneCapture?
    private var engine: (any SpeechInput)?
    private var reader: Task<Void, Never>?
    private var lastFinalText: String?

    init(conversation: ConversationStore, speaker: Speaker) {
        self.conversation = conversation
        self.speaker = speaker
    }

    func beginPushToTalk() {
        guard !isListening, !isFinalizing else { return }
        lastError = nil
        if speaker.isSpeaking || conversation.isBusy { conversation.bargeIn() }
        isListening = true
        liveTranscript = ""
        lastFinalText = nil
        conversation.setListening(true)
        Task { await startCapture() }
    }

    func endPushToTalk() {
        guard isListening else { return }
        isListening = false
        isFinalizing = true
        conversation.currentTrace = LatencyTrace()
        conversation.currentTrace?.mark(.pttReleased)
        Task { await finishAndSend() }
    }

    func cancelPushToTalk() {
        isListening = false
        isFinalizing = false
        Task { await teardown() }
        conversation.setListening(false)
    }

    // MARK: - privato

    private func startCapture() async {
        do {
            guard await AVAudioApplication.requestRecordPermission() else {
                throw NSError(domain: "Ernie.Speech", code: 4, userInfo: [NSLocalizedDescriptionKey: "permesso microfono negato"])
            }
            try AudioSessionController.activateForVoice()
            let capture = MicrophoneCapture()
            let audio = try capture.start()
            guard let format = capture.format else { throw NSError(domain: "Ernie.Speech", code: 5) }
            self.capture = capture
            voiceProcessingActive = capture.voiceProcessing
            let engine = await SpeechInputFactory.make()
            self.engine = engine
            engineName = engine.engineName
            let updates = try await engine.start(audio: audio, inputFormat: format)
            reader = Task { [weak self] in
                for await update in updates {
                    guard let self else { return }
                    self.liveTranscript = update.text
                    if update.isFinal { self.lastFinalText = update.text }
                }
            }
            // L'utente ha già rilasciato il pulsante durante l'avvio: chiudi subito.
            if !isListening, isFinalizing { await finishAndSend() }
        } catch {
            lastError = error.localizedDescription
            Log.speech.error("avvio ascolto fallito: \(error.localizedDescription, privacy: .public)")
            isListening = false
            isFinalizing = false
            conversation.setListening(false)
            await teardown()
        }
    }

    private func finishAndSend() async {
        guard let engine else {
            // L'avvio non è ancora completato: `startCapture` richiamerà questo metodo.
            if capture == nil { return }
            isFinalizing = false
            conversation.setListening(false)
            return
        }
        capture?.stop()
        // La finalizzazione arriva dal lettore dei risultati; oltre 3 s si usa l'ultimo parziale.
        let stopTask = Task { await engine.stop() }
        let deadline = ContinuousClock.now + .seconds(3)
        while lastFinalText == nil, ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(50))
        }
        stopTask.cancel()
        let text = lastFinalText ?? liveTranscript
        conversation.currentTrace?.mark(.transcriptFinal)
        await teardown()
        isFinalizing = false
        conversation.setListening(false)
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        liveTranscript = ""
        if trimmed.isEmpty {
            conversation.currentTrace = nil
            return
        }
        conversation.send(trimmed, inputMode: "voice")
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
