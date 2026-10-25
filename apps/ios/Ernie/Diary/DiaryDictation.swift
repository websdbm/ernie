import AVFoundation
import Foundation
import Observation
import Speech

/// Dedicated on-device-only path: never falls back to a network recognizer,
/// never joins VoiceController's chat, transcript history or diagnostics.
@MainActor @Observable final class DiaryDictation {
    private(set) var recording = false
    var error: String?
    @ObservationIgnored private var capture: MicrophoneCapture?
    @ObservationIgnored private var request: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var recognition: SFSpeechRecognitionTask?
    @ObservationIgnored private var feeder: Task<Void, Never>?
    @ObservationIgnored private var starter: Task<Void, Never>?
    @ObservationIgnored private var token = UUID()
    @ObservationIgnored private var recognizer: SFSpeechRecognizer?
    func start(store: DiaryStore) {
        stop(); error = nil
        guard store.isUnlocked else { return }
        let token = self.token
        let generation = store.generation
        let prefix = store.document?.draft.text ?? ""
        recording = true
        starter = Task { [weak self, weak store] in
            guard let self, let store else { return }
            let permission = await withCheckedContinuation { continuation in
                // Il gestore arriva su una coda di sistema e l'SDK non lo dichiara Sendable: senza @Sendable Swift lo
                // isolerebbe al MainActor e l'app si chiuderebbe al controllo d'isolamento (revisione 25 ott 2026).
                SFSpeechRecognizer.requestAuthorization { @Sendable status in continuation.resume(returning: status == .authorized) }
            }
            guard permission, await AVAudioApplication.requestRecordPermission() else {
                self.error = "Consenti microfono e riconoscimento vocale nelle impostazioni di iOS."; self.stop(); return
            }
            guard self.token == token, store.isUnlocked, store.generation == generation, !Task.isCancelled else { return }
            guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "it_IT")),
                  recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else {
                self.error = "Dettatura locale non disponibile. Puoi scrivere; il diario non usa un servizio di trascrizione remoto."; self.stop(); return
            }
            do {
                try AudioSessionController.activateForVoice()
                let capture = MicrophoneCapture()
                self.capture = capture
                let stream = try await capture.start()
                guard self.token == token, store.isUnlocked, store.generation == generation, !Task.isCancelled else { self.stop(); return }
                let request = SFSpeechAudioBufferRecognitionRequest()
                request.requiresOnDeviceRecognition = true
                request.shouldReportPartialResults = true
                self.request = request; self.recognizer = recognizer
                self.recognition = recognizer.recognitionTask(with: request) { [weak self, weak store] result, failure in
                    let text = result?.bestTranscription.formattedString
                    let finished = result?.isFinal == true || failure != nil
                    Task { @MainActor [weak self, weak store] in
                        guard let self, let store, self.token == token, store.isUnlocked, store.generation == generation else { return }
                        if let text { store.updateDraft([prefix, text].filter { !$0.isEmpty }.joined(separator: "\n")) }
                        if finished { self.stop(); store.flush() }
                    }
                }
                self.feeder = Task {
                    for await chunk in stream {
                        guard !Task.isCancelled else { return }
                        request.append(chunk.buffer)
                    }
                }
            } catch { self.error = "Microfono non disponibile. La bozza è conservata."; self.stop() }
        }
    }
    func stop() {
        token = UUID(); recording = false
        starter?.cancel(); starter = nil
        feeder?.cancel(); feeder = nil
        capture?.stop(); capture = nil
        request?.endAudio(); request = nil
        recognition?.cancel(); recognition = nil; recognizer = nil
        AudioSessionController.deactivate()
    }
}
