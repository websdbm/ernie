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

/// Modello italiano di SpeechTranscriber (iOS 26): stato e scaricamento una sola volta, con avanzamento condiviso.
/// Il primo tocco sul microfono non deve restare muto mentre il sistema scarica il modello: `VoiceController`
/// lo chiede in anticipo (`prewarm`) e, se serve ancora, mostra l'avanzamento.
actor SpeechModel {
    static let shared = SpeechModel()

    enum State: Equatable, Sendable {
        case unavailable(String)
        case notInstalled
        case downloading(Double)
        case installed

        var label: String {
            switch self {
            case .unavailable(let why): "non disponibile (\(why))"
            case .notInstalled: "da scaricare"
            case .downloading(let p): "in scaricamento \(Int(p * 100))%"
            case .installed: "installato"
            }
        }
    }

    private(set) var state: State = .notInstalled
    private var install: Task<Void, Error>?

    private static func module() -> SpeechTranscriber {
        SpeechTranscriber(locale: SpeechInputFactory.locale, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [])
    }

    /// Stato letto dal sistema (non scarica nulla).
    func refresh() async -> State {
        guard SpeechTranscriber.isAvailable else {
            state = .unavailable("SpeechTranscriber assente su questo dispositivo")
            return state
        }
        guard await SpeechTranscriber.supportedLocale(equivalentTo: SpeechInputFactory.locale) != nil else {
            state = .unavailable("italiano non supportato")
            return state
        }
        if case .downloading = state, install != nil { return state }
        switch await AssetInventory.status(forModules: [Self.module()]) {
        case .installed: state = .installed
        case .downloading: state = .downloading(0)
        case .supported: state = .notInstalled
        case .unsupported: state = .unavailable("modello italiano non supportato")
        @unknown default: state = .notInstalled
        }
        return state
    }

    /// Scarica e installa il modello se manca; chiamate concorrenti condividono lo stesso scaricamento.
    func ensureInstalled() async throws {
        if case .installed = await refresh() { return }
        if case .unavailable(let why) = state {
            throw NSError(domain: "Ernie.Speech", code: 8, userInfo: [NSLocalizedDescriptionKey: why])
        }
        if let install { return try await install.value }
        let task = Task { try await self.download() }
        install = task
        defer { install = nil }
        try await task.value
    }

    private func download() async throws {
        let module = Self.module()
        _ = try? await AssetInventory.reserve(locale: SpeechInputFactory.locale)
        guard let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) else {
            state = .installed
            return
        }
        state = .downloading(0)
        Log.speech.info("scarico il modello di trascrizione italiano")
        let poll = Task { [weak self] in
            while !Task.isCancelled {
                await self?.setProgress(request.progress.fractionCompleted)
                try? await Task.sleep(for: .milliseconds(250))
            }
        }
        defer { poll.cancel() }
        do {
            try await request.downloadAndInstall()
            state = .installed
            Log.speech.info("modello di trascrizione italiano installato")
        } catch {
            state = .notInstalled
            Log.speech.error("scaricamento del modello fallito: \(error.localizedDescription, privacy: .public)")
            throw error
        }
    }

    private func setProgress(_ p: Double) {
        if case .downloading = state { state = .downloading(p) }
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
        // Di norma già installato da `prewarm`; altrimenti lo scaricamento avviene qui (senza avanzamento visibile).
        try await SpeechModel.shared.ensureInstalled()
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        self.analyzer = analyzer
        guard let targetFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            throw NSError(domain: "Ernie.Speech", code: 1, userInfo: [NSLocalizedDescriptionKey: "formato audio non disponibile"])
        }
        Log.speech.info("SpeechTranscriber: formato analizzatore \(Int(targetFormat.sampleRate)) Hz, \(targetFormat.channelCount) canali")
        let sameFormat = targetFormat.sampleRate == inputFormat.sampleRate && targetFormat.channelCount == inputFormat.channelCount && targetFormat.commonFormat == inputFormat.commonFormat
        let converter = sameFormat ? nil : AVAudioConverter(from: inputFormat, to: targetFormat)
        if !sameFormat, converter == nil {
            throw NSError(domain: "Ernie.Speech", code: 7, userInfo: [NSLocalizedDescriptionKey: "conversione audio non disponibile per il trascrittore"])
        }
        let (inputStream, builder) = AsyncStream.makeStream(of: AnalyzerInput.self, bufferingPolicy: .unbounded)
        inputBuilder = builder
        feeder = Task.detached { [converter] in
            for await chunk in audio {
                guard let converter else { builder.yield(AnalyzerInput(buffer: chunk.buffer)); continue }
                let ratio = targetFormat.sampleRate / max(inputFormat.sampleRate, 1)
                let capacity = max(AVAudioFrameCount(Double(chunk.buffer.frameLength) * ratio) + 16, 16)
                guard let out = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { continue }
                var consumed = false
                var error: NSError?
                let status = converter.convert(to: out, error: &error) { _, status in
                    if consumed { status.pointee = .noDataNow; return nil }
                    consumed = true
                    status.pointee = .haveData
                    return chunk.buffer
                }
                if status == .error || error != nil {
                    Log.speech.warning("conversione audio fallita: \(error?.localizedDescription ?? "-", privacy: .public)")
                    continue
                }
                if out.frameLength > 0 { builder.yield(AnalyzerInput(buffer: out)) }
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
