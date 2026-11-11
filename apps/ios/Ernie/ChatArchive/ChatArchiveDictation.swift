import AVFoundation
import Foundation
import Observation
import Speech

/// La dettatura resta nella domanda della chat selezionata, senza inviare testo alla conversazione generale.
@MainActor @Observable final class ChatArchiveDictation {
    private(set) var recording = false
    private(set) var requestingPermission = false
    var error: String?
    @ObservationIgnored private var capture: MicrophoneCapture?
    @ObservationIgnored private var request: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var recognition: SFSpeechRecognitionTask?
    @ObservationIgnored private var feeder: Task<Void, Never>?
    @ObservationIgnored private var starter: Task<Void, Never>?
    @ObservationIgnored private var token = UUID()
    @ObservationIgnored private var recognizer: SFSpeechRecognizer?
    func start(prefix: String, update: @escaping @MainActor (String) -> Void) {
        stop(); error = nil
        let generation = token
        recording = true; requestingPermission = true
        starter = Task { [weak self] in
            guard let self else { return }
            let authorized = await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { @Sendable status in continuation.resume(returning: status == .authorized) }
            }
            let microphone = authorized ? await AVAudioApplication.requestRecordPermission() : false
            guard self.token == generation, !Task.isCancelled else { return }
            requestingPermission = false
            guard authorized, microphone else { error = "Consenti microfono e riconoscimento vocale nelle impostazioni iOS."; stop(); return }
            guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "it_IT")), recognizer.isAvailable,
                  recognizer.supportsOnDeviceRecognition else { error = "Dettatura locale non disponibile. Puoi usare il microfono della tastiera."; stop(); return }
            do {
                try await AudioSessionController.activateForVoice()
                let capture = MicrophoneCapture(); self.capture = capture
                let audio = try await capture.start()
                guard self.token == generation, !Task.isCancelled else { self.stop(); return }
                let request = SFSpeechAudioBufferRecognitionRequest()
                request.requiresOnDeviceRecognition = true; request.shouldReportPartialResults = true
                self.request = request; self.recognizer = recognizer
                self.recognition = recognizer.recognitionTask(with: request) { [weak self] result, failure in
                    let text = result?.bestTranscription.formattedString
                    let finished = result?.isFinal == true || failure != nil
                    Task { @MainActor [weak self] in
                        guard let self, self.token == generation else { return }
                        if let text { update(String([prefix, text].filter { !$0.isEmpty }.joined(separator: " ").prefix(4000))) }
                        if finished { self.stop() }
                    }
                }
                feeder = Task { [weak self] in
                    for await chunk in audio {
                        guard let self, self.token == generation, !Task.isCancelled else { return }
                        request.append(chunk.buffer)
                    }
                }
            } catch { self.error = "Microfono non disponibile. La domanda resta nel campo."; self.stop() }
        }
    }
    func stop() {
        token = UUID(); recording = false; requestingPermission = false
        starter?.cancel(); starter = nil; feeder?.cancel(); feeder = nil
        capture?.stop(); capture = nil; request?.endAudio(); request = nil
        recognition?.cancel(); recognition = nil; recognizer = nil
        AudioSessionController.deactivate()
    }
}
