import AVFoundation
import Foundation
import Speech

struct TranscriptUpdate: Sendable, Equatable {
    var text: String
    var isFinal: Bool
}

/// Motore di trascrizione: riceve i buffer del microfono, emette il testo (parziale e finale).
protocol SpeechInput: AnyObject, Sendable {
    var engineName: String { get }
    func start(audio: AsyncStream<AudioChunk>, inputFormat: AVAudioFormat) async throws -> AsyncStream<TranscriptUpdate>
    /// Chiude l'input e attende la finalizzazione.
    func stop() async
}

enum SpeechInputFactory {
    static let locale = Locale(identifier: "it_IT")

    /// SpeechTranscriber (iOS 26, on-device) quando l'italiano è supportato; altrimenti SFSpeechRecognizer.
    static func make() async -> any SpeechInput {
        if SpeechTranscriber.isAvailable, await SpeechTranscriber.supportedLocale(equivalentTo: locale) != nil {
            return ModernTranscriber()
        }
        return LegacyTranscriber()
    }

    static func describeAvailability() async -> String {
        guard SpeechTranscriber.isAvailable else { return "SpeechTranscriber non disponibile su questo dispositivo" }
        let supported = await SpeechTranscriber.supportedLocales.map(\.identifier)
        let installed = await SpeechTranscriber.installedLocales.map(\.identifier)
        let it = await SpeechTranscriber.supportedLocale(equivalentTo: locale)?.identifier ?? "no"
        return "supportati: \(supported.count) · italiano: \(it) · installati: \(installed.joined(separator: ", "))"
    }
}

/// iOS 26: SpeechAnalyzer + SpeechTranscriber, modelli scaricati dal sistema (AssetInventory), risultati volatili.
final class ModernTranscriber: SpeechInput, @unchecked Sendable {
    let engineName = "SpeechTranscriber (iOS 26, on-device)"
    private var analyzer: SpeechAnalyzer?
    private var inputBuilder: AsyncStream<AnalyzerInput>.Continuation?
    private var feeder: Task<Void, Never>?
    private var reader: Task<Void, Never>?

    func start(audio: AsyncStream<AudioChunk>, inputFormat: AVAudioFormat) async throws -> AsyncStream<TranscriptUpdate> {
        let transcriber = SpeechTranscriber(
            locale: SpeechInputFactory.locale,
            transcriptionOptions: [],
            reportingOptions: [.volatileResults],
            attributeOptions: []
        )
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            Log.speech.info("scarico il modello di trascrizione italiano")
            try await request.downloadAndInstall()
        }
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        self.analyzer = analyzer
        guard let targetFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            throw NSError(domain: "Ernie.Speech", code: 1, userInfo: [NSLocalizedDescriptionKey: "formato audio non disponibile"])
        }
        let converter = AVAudioConverter(from: inputFormat, to: targetFormat)
        let (inputStream, builder) = AsyncStream.makeStream(of: AnalyzerInput.self, bufferingPolicy: .unbounded)
        inputBuilder = builder
        feeder = Task.detached { [converter] in
            for await chunk in audio {
                guard let converter else { builder.yield(AnalyzerInput(buffer: chunk.buffer)); continue }
                let ratio = targetFormat.sampleRate / inputFormat.sampleRate
                let capacity = AVAudioFrameCount(Double(chunk.buffer.frameLength) * ratio) + 16
                guard let out = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { continue }
                var consumed = false
                var error: NSError?
                converter.convert(to: out, error: &error) { _, status in
                    if consumed { status.pointee = .noDataNow; return nil }
                    consumed = true
                    status.pointee = .haveData
                    return chunk.buffer
                }
                if error == nil, out.frameLength > 0 { builder.yield(AnalyzerInput(buffer: out)) }
            }
            builder.finish()
        }
        try await analyzer.start(inputSequence: inputStream)

        let (updates, publish) = AsyncStream.makeStream(of: TranscriptUpdate.self, bufferingPolicy: .unbounded)
        reader = Task.detached {
            var finalText = ""
            var volatile = ""
            do {
                for try await result in transcriber.results {
                    let text = String(result.text.characters)
                    if result.isFinal {
                        finalText = finalText.isEmpty ? text : "\(finalText) \(text)"
                        volatile = ""
                    } else {
                        volatile = text
                    }
                    let combined = [finalText, volatile].filter { !$0.isEmpty }.joined(separator: " ")
                    publish.yield(TranscriptUpdate(text: combined, isFinal: false))
                }
                publish.yield(TranscriptUpdate(text: finalText.isEmpty ? volatile : finalText, isFinal: true))
            } catch {
                Log.speech.warning("trascrizione interrotta: \(error.localizedDescription, privacy: .public)")
                publish.yield(TranscriptUpdate(text: finalText.isEmpty ? volatile : finalText, isFinal: true))
            }
            publish.finish()
        }
        return updates
    }

    func stop() async {
        inputBuilder?.finish()
        feeder?.cancel()
        try? await analyzer?.finalizeAndFinishThroughEndOfInput()
        _ = await reader?.value
    }
}

/// Ripiego: SFSpeechRecognizer con richieste ruotate ogni 55 s (limite documentato di un minuto per richiesta).
final class LegacyTranscriber: NSObject, SpeechInput, @unchecked Sendable {
    let engineName = "SFSpeechRecognizer (ripiego)"
    private let recognizer = SFSpeechRecognizer(locale: SpeechInputFactory.locale)
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var feeder: Task<Void, Never>?
    private var rotation: Task<Void, Never>?
    private var publish: AsyncStream<TranscriptUpdate>.Continuation?
    private let lock = NSLock()
    private var committed = ""
    private var current = ""
    private var stopping = false

    func start(audio: AsyncStream<AudioChunk>, inputFormat: AVAudioFormat) async throws -> AsyncStream<TranscriptUpdate> {
        guard let recognizer, recognizer.isAvailable else {
            throw NSError(domain: "Ernie.Speech", code: 2, userInfo: [NSLocalizedDescriptionKey: "riconoscimento vocale non disponibile"])
        }
        let status = await withCheckedContinuation { (c: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
            SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) }
        }
        guard status == .authorized else {
            throw NSError(domain: "Ernie.Speech", code: 3, userInfo: [NSLocalizedDescriptionKey: "permesso di riconoscimento vocale negato"])
        }
        let (updates, continuation) = AsyncStream.makeStream(of: TranscriptUpdate.self, bufferingPolicy: .unbounded)
        publish = continuation
        startRequest(recognizer)
        feeder = Task.detached { [weak self] in
            for await chunk in audio { self?.append(chunk.buffer) }
        }
        rotation = Task.detached { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(55))
                guard !Task.isCancelled, let self else { return }
                self.rotate(recognizer)
            }
        }
        return updates
    }

    func stop() async {
        let req = markStopping()
        feeder?.cancel()
        rotation?.cancel()
        req?.endAudio()
        // Il riconoscitore consegna il risultato finale entro poco; oltre 2 s si usa l'ultimo parziale.
        try? await Task.sleep(for: .seconds(2))
        finish()
    }

    private func markStopping() -> SFSpeechAudioBufferRecognitionRequest? {
        lock.lock()
        defer { lock.unlock() }
        stopping = true
        return request
    }

    private func startRequest(_ recognizer: SFSpeechRecognizer) {
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.taskHint = .dictation
        if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        lock.lock()
        request = req
        current = ""
        lock.unlock()
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self else { return }
            if let result {
                self.lock.lock()
                self.current = result.bestTranscription.formattedString
                let text = [self.committed, self.current].filter { !$0.isEmpty }.joined(separator: " ")
                let done = result.isFinal && self.stopping
                self.lock.unlock()
                self.publish?.yield(TranscriptUpdate(text: text, isFinal: false))
                if done { self.finish() }
            } else if let error {
                Log.speech.info("riconoscitore: \(error.localizedDescription, privacy: .public)")
                self.lock.lock()
                let shouldFinish = self.stopping
                self.lock.unlock()
                if shouldFinish { self.finish() }
            }
        }
    }

    private func rotate(_ recognizer: SFSpeechRecognizer) {
        lock.lock()
        committed = [committed, current].filter { !$0.isEmpty }.joined(separator: " ")
        let old = request
        lock.unlock()
        old?.endAudio()
        startRequest(recognizer)
    }

    private func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        let req = request
        lock.unlock()
        req?.append(buffer)
    }

    private func finish() {
        lock.lock()
        guard let p = publish else { lock.unlock(); return }
        publish = nil
        let text = [committed, current].filter { !$0.isEmpty }.joined(separator: " ")
        lock.unlock()
        task?.cancel()
        p.yield(TranscriptUpdate(text: text, isFinal: true))
        p.finish()
    }
}
