import AVFoundation
import Foundation
import Observation

enum SpeechEngine: String, Codable, CaseIterable, Sendable {
    case drama, ios
    var title: String { self == .drama ? "Ernie · Drama" : "Voce di iOS" }
}

enum SpeechStyle: String, Codable, CaseIterable, Sendable {
    case warm, playful, calm
    var title: String {
        switch self { case .warm: "Calda"; case .playful: "Vivace"; case .calm: "Tranquilla" }
    }
}

/// Una risposta MP3 per frase. La cancellazione del Task cancella anche URLSession.
enum SpeechAPI {
    static func audio(text: String, style: SpeechStyle, credentials: Credentials) async throws -> Data {
        var request = URLRequest(url: credentials.serverURL.appendingPathComponent("v1/speech"))
        request.httpMethod = "POST"
        request.timeoutInterval = 55
        request.setValue("Bearer \(credentials.apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["text": text, "style": style.rawValue])
        let (data, response) = try await URLSession.shared.data(for: request)
        try Task.checkCancellation()
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode),
              response.mimeType == "audio/mpeg", !data.isEmpty else { throw URLError(.badServerResponse) }
        return data
    }
}

/// Interfaccia iniettabile: i test verificano ordine, annullamento e ripiego senza parlare davvero.
@MainActor
protocol SpeechOutput: AnyObject {
    var localVoiceDescription: String { get }
    func play(_ data: Data, started: @escaping () -> Void, mouth: @escaping (Bool) -> Void,
              finished: @escaping (Bool) -> Void) throws
    func speak(_ text: String, started: @escaping () -> Void, progress: @escaping (Int) -> Void,
               finished: @escaping (Bool) -> Void)
    func stop()
}

/// Sintesi per frasi. `isSpeaking` comprende la generazione: il microfono resta chiuso anche mentre arriva l'MP3.
@MainActor
@Observable
final class Speaker {
    typealias Transport = @MainActor (String, SpeechStyle, Credentials) async throws -> Data
    private(set) var isSpeaking = false
    private(set) var isPreparingAudio = false
    private(set) var voiceDescription = "Ernie · Drama"
    private(set) var mouthOpen = false
    private(set) var lastStopLatencyMs: Int?
    var onSpeakingChanged: ((Bool) -> Void)?
    var onAudibleStarted: (() -> Void)?
    var onPlaybackFailed: (() -> Void)?

    private let output: any SpeechOutput
    private let transport: Transport
    private var credentials: Credentials?
    private var engine: SpeechEngine = .drama
    private var style: SpeechStyle = .warm
    private var generation = UUID()
    /// Un download alla volta e al massimo una frase pronta oltre quella in riproduzione.
    private var request: Task<Void, Never>?
    private var preparingSegmentID: UUID?
    private var prepared: PreparedSegment?
    private var buffer = ""
    private var spokenThrough = 0
    private var consumedCharacters = 0
    private var fedChars = 0
    private var queue: [Segment] = []
    private var active: Segment?
    private var playbackBegan = false
    private struct Segment {
        let id = UUID()
        let text: String
        let start: Int
        let end: Int
    }
    private enum PreparedAudio { case remote(Data), local }
    private struct PreparedSegment {
        let id: UUID
        let audio: PreparedAudio
    }

    init(output: (any SpeechOutput)? = nil, transport: @escaping Transport = SpeechAPI.audio) {
        self.output = output ?? NativeSpeechOutput()
        self.transport = transport
    }

    func configure(credentials: Credentials?, engine: SpeechEngine, style: SpeechStyle) {
        if self.credentials != credentials || self.engine != engine || self.style != style { _ = stop() }
        self.credentials = credentials
        self.engine = engine
        self.style = style
        selectVoice()
    }

    func selectVoice() {
        voiceDescription = engine == .drama ? "Ernie · Drama · \(style.title.lowercased())" : output.localVoiceDescription
    }

    static func qualityName(_ q: AVSpeechSynthesisVoiceQuality) -> String {
        switch q { case .premium: "premium"; case .enhanced: "enhanced"; default: "default" }
    }

    func beginTurn() {
        _ = stop()
        spokenThrough = 0
        consumedCharacters = 0
        fedChars = 0
    }

    func feed(_ delta: String) {
        fedChars += delta.count
        buffer += delta
        enqueue(SentenceSplitter.popSpeechChunks(from: &buffer))
    }

    func flush(fullText: String? = nil) {
        if fedChars == 0, let fullText, !fullText.isEmpty { buffer = fullText }
        enqueue(SentenceSplitter.popSpeechChunks(from: &buffer, flush: true))
    }

    /// Invalida anche risposte HTTP e callback che arrivano dopo lo stop o dopo un nuovo turno.
    func stop() -> Int {
        let started = ContinuousClock.now
        generation = UUID()
        request?.cancel()
        request = nil
        preparingSegmentID = nil
        prepared = nil
        buffer = ""
        queue.removeAll()
        active = nil
        output.stop()
        playbackBegan = false
        isPreparingAudio = false
        mouthOpen = false
        lastStopLatencyMs = Int((ContinuousClock.now - started) / .milliseconds(1))
        setSpeaking(false)
        return spokenThrough
    }

    func rebuild() {
        _ = stop()
        (output as? NativeSpeechOutput)?.rebuild()
        selectVoice()
    }

    private func enqueue(_ chunks: [String]) {
        for raw in chunks {
            let start = consumedCharacters
            consumedCharacters += raw.count
            let plain = SentenceSplitter.plainForSpeech(raw)
            guard !plain.isEmpty, plain.utf16.count <= 2000 else { continue }
            queue.append(Segment(text: plain, start: start, end: consumedCharacters))
        }
        if !queue.isEmpty { setSpeaking(true) }
        startNext()
        prefetchNext()
    }

    private func startNext() {
        guard active == nil else { return }
        guard !queue.isEmpty else { setSpeaking(false); return }
        let segment = queue.removeFirst()
        active = segment
        playbackBegan = false
        let token = generation
        isPreparingAudio = true
        guard engine == .drama, let credentials else { startLocal(segment, token: token); return }
        if let ready = prepared, ready.id == segment.id {
            prepared = nil
            playPrepared(ready.audio, segment: segment, token: token)
        } else if preparingSegmentID != segment.id {
            prepare(segment, token: token, credentials: credentials)
        }
        // Se il preload è ancora in corso, diventa la richiesta della frase attiva senza duplicarla.
    }

    private func prefetchNext() {
        guard active != nil, playbackBegan, request == nil, prepared == nil,
              engine == .drama, let credentials, let next = queue.first else { return }
        prepare(next, token: generation, credentials: credentials)
    }

    private func prepare(_ segment: Segment, token: UUID, credentials: Credentials) {
        guard request == nil else { return }
        preparingSegmentID = segment.id
        let style = style
        request = Task { [weak self] in
            guard let self, !Task.isCancelled, self.generation == token,
                  self.preparingSegmentID == segment.id else { return }
            let result: PreparedAudio
            do {
                let data = try await self.transport(segment.text, style, credentials)
                result = .remote(data)
            } catch {
                result = .local
            }
            guard !Task.isCancelled, self.generation == token, self.preparingSegmentID == segment.id else { return }
            self.request = nil
            self.preparingSegmentID = nil
            if self.active?.id == segment.id {
                self.playPrepared(result, segment: segment, token: token)
            } else if self.queue.first?.id == segment.id {
                self.prepared = PreparedSegment(id: segment.id, audio: result)
            }
        }
    }

    private func playPrepared(_ audio: PreparedAudio, segment: Segment, token: UUID) {
        guard isCurrent(segment, token) else { return }
        switch audio {
        case .local:
            startLocal(segment, token: token)
        case .remote(let data):
            do {
                try output.play(data, started: { [weak self] in
                    guard let self, self.isCurrent(segment, token) else { return }
                    self.selectVoice()
                    self.didStart(segment, token: token)
                }, mouth: { [weak self] open in
                    guard let self, self.isCurrent(segment, token) else { return }
                    self.mouthOpen = open
                }, finished: { [weak self] success in
                    self?.finish(segment, token: token, success: success)
                })
            } catch {
                guard isCurrent(segment, token) else { return }
                // Il ripiego resta per frase e solo prima di audio udibile: mai ripetere parole ascoltate.
                if !playbackBegan { startLocal(segment, token: token) }
                else { finish(segment, token: token, success: false) }
            }
        }
    }

    private func isCurrent(_ segment: Segment, _ token: UUID) -> Bool {
        generation == token && active?.id == segment.id
    }

    private func didStart(_ segment: Segment, token: UUID) {
        guard isCurrent(segment, token) else { return }
        playbackBegan = true
        isPreparingAudio = false
        onAudibleStarted?()
        prefetchNext()
    }

    private func startLocal(_ segment: Segment, token: UUID) {
        guard isCurrent(segment, token) else { return }
        if engine == .drama { voiceDescription = "Voce di iOS (ripiego)" }
        output.speak(segment.text, started: { [weak self] in
            self?.didStart(segment, token: token)
        }, progress: { [weak self] utf16Offset in
            guard let self, self.isCurrent(segment, token) else { return }
            let end = String.Index(utf16Offset: min(utf16Offset, segment.text.utf16.count), in: segment.text)
            self.spokenThrough = max(self.spokenThrough, min(segment.end, segment.start + segment.text[..<end].count))
            self.mouthOpen.toggle()
        }, finished: { [weak self] success in
            self?.finish(segment, token: token, success: success)
        })
    }

    private func finish(_ segment: Segment, token: UUID, success: Bool) {
        guard isCurrent(segment, token) else { return }
        // Drama non offre marker di parola: non dichiariamo pronunciata una frase interrotta.
        if success { spokenThrough = max(spokenThrough, segment.end) }
        mouthOpen = false
        isPreparingAudio = false
        active = nil
        // Se una frase si interrompe per errore, fermiamo la coda per non dichiarare un prefisso mai pronunciato.
        if !success { onPlaybackFailed?(); _ = stop(); return }
        startNext()
    }

    private func setSpeaking(_ value: Bool) {
        guard isSpeaking != value else { return }
        isSpeaking = value
        if !value { mouthOpen = false }
        onSpeakingChanged?(value)
    }
}

@MainActor
private final class NativeSpeechOutput: NSObject, SpeechOutput, AVSpeechSynthesizerDelegate, AVAudioPlayerDelegate {
    private var synthesizer = AVSpeechSynthesizer()
    private var player: AVAudioPlayer?
    private var utterance: AVSpeechUtterance?
    private var meter: Task<Void, Never>?
    private var started: (() -> Void)?
    private var progress: ((Int) -> Void)?
    private var finished: ((Bool) -> Void)?
    private var voice: AVSpeechSynthesisVoice? {
        AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("it") }
            .sorted { $0.quality == $1.quality ? $0.name < $1.name : $0.quality.rawValue > $1.quality.rawValue }.first
            ?? AVSpeechSynthesisVoice(language: "it-IT")
    }
    var localVoiceDescription: String {
        voice.map { "\($0.name) (\(Speaker.qualityName($0.quality)))" } ?? "nessuna voce italiana"
    }

    override init() { super.init(); rebuild() }
    func rebuild() {
        stop()
        synthesizer.delegate = nil
        synthesizer = AVSpeechSynthesizer()
        synthesizer.delegate = self
        synthesizer.usesApplicationAudioSession = true
    }
    func play(_ data: Data, started: @escaping () -> Void, mouth: @escaping (Bool) -> Void,
              finished: @escaping (Bool) -> Void) throws {
        stop()
        try AudioSessionController.activateForSpeechPlayback()
        let player = try AVAudioPlayer(data: data)
        self.player = player
        self.finished = finished
        player.delegate = self
        player.isMeteringEnabled = true
        guard player.prepareToPlay(), player.play() else { stop(); throw URLError(.cannotDecodeContentData) }
        started()
        meter = Task { [weak self, weak player] in
            while !Task.isCancelled {
                guard let self, let player, self.player === player else { return }
                player.updateMeters()
                mouth(player.isPlaying && player.averagePower(forChannel: 0) > -38)
                try? await Task.sleep(for: .milliseconds(80))
            }
        }
    }
    func speak(_ text: String, started: @escaping () -> Void, progress: @escaping (Int) -> Void,
               finished: @escaping (Bool) -> Void) {
        stop()
        try? AudioSessionController.activateForSpeechPlayback()
        self.started = started; self.progress = progress; self.finished = finished
        let utterance = AVSpeechUtterance(string: text)
        self.utterance = utterance
        utterance.voice = voice
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        utterance.prefersAssistiveTechnologySettings = false
        synthesizer.speak(utterance)
    }
    func stop() {
        meter?.cancel(); meter = nil
        player?.delegate = nil; player?.stop(); player = nil
        utterance = nil
        started = nil; progress = nil; finished = nil
        synthesizer.stopSpeaking(at: .immediate)
    }
    private func complete(_ success: Bool) {
        let callback = finished
        stop()
        callback?(success)
    }
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        let key = ObjectIdentifier(player)
        Task { @MainActor in
            guard self.player.map(ObjectIdentifier.init) == key else { return }
            self.complete(flag)
        }
    }
    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: (any Error)?) {
        let key = ObjectIdentifier(player)
        Task { @MainActor in
            guard self.player.map(ObjectIdentifier.init) == key else { return }
            self.complete(false)
        }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        let key = ObjectIdentifier(utterance)
        Task { @MainActor in
            guard self.utterance.map(ObjectIdentifier.init) == key else { return }
            self.started?()
        }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, willSpeakRangeOfSpeechString range: NSRange, utterance: AVSpeechUtterance) {
        let key = ObjectIdentifier(utterance)
        Task { @MainActor in
            guard self.utterance.map(ObjectIdentifier.init) == key else { return }
            self.progress?(range.location)
        }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let key = ObjectIdentifier(utterance)
        Task { @MainActor in
            guard self.utterance.map(ObjectIdentifier.init) == key else { return }
            self.complete(true)
        }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        let key = ObjectIdentifier(utterance)
        Task { @MainActor in
            guard self.utterance.map(ObjectIdentifier.init) == key else { return }
            self.complete(false)
        }
    }
}
