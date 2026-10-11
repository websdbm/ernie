import AVFoundation
import Foundation
import Observation

/// Sintesi vocale incrementale per frasi con voce italiana; tiene traccia di quanto testo è stato pronunciato (barge-in).
@MainActor
@Observable
final class Speaker: NSObject, AVSpeechSynthesizerDelegate {
    private(set) var isSpeaking = false
    private(set) var voiceDescription = "—"
    var onSpeakingChanged: ((Bool) -> Void)?

    private let synthesizer = AVSpeechSynthesizer()
    private var voice: AVSpeechSynthesisVoice?
    private var buffer = ""
    private var spokenThrough = 0
    private var offsets: [ObjectIdentifier: Int] = [:]
    private var queued = 0
    private var fullTextLength = 0
    private var fedChars = 0

    override init() {
        super.init()
        synthesizer.delegate = self
        synthesizer.usesApplicationAudioSession = true
        selectVoice()
    }

    /// Voce italiana di qualità più alta disponibile (premium > enhanced > default).
    func selectVoice() {
        let italian = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("it") }
        let ranked = italian.sorted { a, b in
            if a.quality != b.quality { return a.quality.rawValue > b.quality.rawValue }
            return a.name < b.name
        }
        voice = ranked.first ?? AVSpeechSynthesisVoice(language: "it-IT")
        voiceDescription = voice.map { "\($0.name) (\(Self.qualityName($0.quality)))" } ?? "nessuna voce italiana"
    }

    static func qualityName(_ q: AVSpeechSynthesisVoiceQuality) -> String {
        switch q {
        case .premium: "premium"
        case .enhanced: "enhanced"
        default: "default"
        }
    }

    func beginTurn() {
        _ = stop()
        buffer = ""
        spokenThrough = 0
        fullTextLength = 0
        fedChars = 0
        offsets = [:]
    }

    /// Testo in streaming: le frasi complete partono subito.
    func feed(_ delta: String) {
        fedChars += delta.count
        buffer += delta
        for sentence in SentenceSplitter.popSentences(from: &buffer) { enqueue(sentence) }
    }

    /// Fine del testo: pronuncia il resto.
    func flush(fullText: String? = nil) {
        // Risposte senza streaming (skill deterministiche, comandi): arriva solo il testo completo.
        if fedChars == 0, let fullText, !fullText.isEmpty { buffer = fullText }
        let rest = buffer.trimmingCharacters(in: .whitespacesAndNewlines)
        buffer = ""
        if !rest.isEmpty { enqueue(rest) }
    }

    /// Ferma subito la voce; restituisce il numero di caratteri del testo effettivamente pronunciati.
    func stop() -> Int {
        buffer = ""
        if synthesizer.isSpeaking || queued > 0 {
            synthesizer.stopSpeaking(at: .immediate)
        }
        queued = 0
        setSpeaking(false)
        return spokenThrough
    }

    private func enqueue(_ sentence: String) {
        let plain = SentenceSplitter.plainForSpeech(sentence)
        guard !plain.isEmpty else { return }
        let utterance = AVSpeechUtterance(string: plain)
        utterance.voice = voice
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        utterance.prefersAssistiveTechnologySettings = false
        offsets[ObjectIdentifier(utterance)] = fullTextLength
        fullTextLength += sentence.count + 1
        queued += 1
        Log.speech.info("sintesi in coda: \(plain.count) caratteri, voce \(self.voice?.identifier ?? "-", privacy: .public)")
        synthesizer.speak(utterance)
    }

    private func setSpeaking(_ value: Bool) {
        guard isSpeaking != value else { return }
        isSpeaking = value
        Log.speech.info("sintesi \(value ? "avviata" : "terminata", privacy: .public), pronunciati \(self.spokenThrough) caratteri")
        onSpeakingChanged?(value)
    }

    // MARK: - AVSpeechSynthesizerDelegate (callback sul thread principale)

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        Task { @MainActor in self.setSpeaking(true) }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, willSpeakRangeOfSpeechString characterRange: NSRange, utterance: AVSpeechUtterance) {
        let key = ObjectIdentifier(utterance)
        let end = characterRange.location + characterRange.length
        Task { @MainActor in
            let base = self.offsets[key] ?? 0
            self.spokenThrough = max(self.spokenThrough, base + end)
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in
            self.queued = max(0, self.queued - 1)
            if self.queued == 0 { self.setSpeaking(false) }
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in
            self.queued = max(0, self.queued - 1)
            if self.queued == 0 { self.setSpeaking(false) }
        }
    }
}
