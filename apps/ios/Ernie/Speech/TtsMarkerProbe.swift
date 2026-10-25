import AVFoundation
import Foundation

/// Spike S1 su dispositivo: marker emessi da `write()` e callback di parola da `speak()` con le voci italiane installate.
@MainActor
final class TtsMarkerProbe: NSObject, AVSpeechSynthesizerDelegate {
    struct Report: Sendable, Identifiable {
        var id: String { voice }
        var voice: String
        var quality: String
        var writeMarkers: [String: Int]
        var audioSeconds: Double
        var speakWordCallbacks: Int
        var speakMarkers: [String: Int]
        var firstCallbackSeconds: Double?
    }

    private let text = "Ciao, oggi alle diciotto ti ricordo la lista della spesa: latte, pane e uova."
    private var speakCounts: [String: Int] = [:]
    private var wordCallbacks = 0
    private var speakStarted: Date?
    private var firstCallback: Date?
    private var speakDone: CheckedContinuation<Void, Never>?

    nonisolated static func markName(_ m: AVSpeechSynthesisMarker.Mark) -> String {
        switch m {
        case .word: "word"
        case .sentence: "sentence"
        case .paragraph: "paragraph"
        case .phoneme: "phoneme"
        case .bookmark: "bookmark"
        @unknown default: "altro"
        }
    }

    func run() async -> [Report] {
        let voices = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("it") }
        var reports: [Report] = []
        for voice in voices {
            let (markers, seconds) = await probeWrite(voice)
            let (callbacks, speakMarkers, first) = await probeSpeak(voice)
            reports.append(Report(voice: voice.name, quality: Speaker.qualityName(voice.quality), writeMarkers: markers, audioSeconds: seconds, speakWordCallbacks: callbacks, speakMarkers: speakMarkers, firstCallbackSeconds: first))
        }
        return reports
    }

    private func probeWrite(_ voice: AVSpeechSynthesisVoice) async -> ([String: Int], Double) {
        let synthesizer = AVSpeechSynthesizer()
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = voice
        final class Box: @unchecked Sendable { var marks: [String: Int] = [:]; var frames = 0; var rate = 0.0; var done = false }
        let box = Box()
        return await withCheckedContinuation { (c: CheckedContinuation<([String: Int], Double), Never>) in
            // Le due chiamate arrivano sulla coda del sintetizzatore: @Sendable, altrimenti erediterebbero il MainActor.
            synthesizer.write(utterance, toBufferCallback: { @Sendable buffer in
                guard let pcm = buffer as? AVAudioPCMBuffer else { return }
                box.rate = pcm.format.sampleRate
                box.frames += Int(pcm.frameLength)
                if pcm.frameLength == 0, !box.done {
                    box.done = true
                    c.resume(returning: (box.marks, box.rate > 0 ? Double(box.frames) / box.rate : 0))
                }
            }, toMarkerCallback: { @Sendable markers in
                for m in markers { box.marks[Self.markName(m.mark), default: 0] += 1 }
            })
        }
    }

    private func probeSpeak(_ voice: AVSpeechSynthesisVoice) async -> (Int, [String: Int], Double?) {
        let synthesizer = AVSpeechSynthesizer()
        synthesizer.delegate = self
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = voice
        utterance.volume = 0
        speakCounts = [:]
        wordCallbacks = 0
        firstCallback = nil
        speakStarted = .now
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            speakDone = c
            synthesizer.speak(utterance)
        }
        let first = firstCallback.flatMap { f in speakStarted.map { f.timeIntervalSince($0) } }
        return (wordCallbacks, speakCounts, first)
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, willSpeakRangeOfSpeechString characterRange: NSRange, utterance: AVSpeechUtterance) {
        Task { @MainActor in
            self.wordCallbacks += 1
            if self.firstCallback == nil { self.firstCallback = .now }
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, willSpeak marker: AVSpeechSynthesisMarker, utterance: AVSpeechUtterance) {
        let name = Self.markName(marker.mark)
        Task { @MainActor in self.speakCounts[name, default: 0] += 1 }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in
            self.speakDone?.resume()
            self.speakDone = nil
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in
            self.speakDone?.resume()
            self.speakDone = nil
        }
    }
}
