// Spike S1 (proxy macOS): quali marker produce AVSpeechSynthesizer.write(_:toBufferCallback:toMarkerCallback:)
// con le voci italiane installate (word / sentence / phoneme). Lo stesso probe gira nell'app iOS
// (Impostazioni → Diagnostica) per il risultato su dispositivo.
//   swift tests/spikes/tts-markers.swift
import AVFoundation
import Foundation

let text = "Ciao Alessandro, oggi alle diciotto ti ricordo la lista della spesa: latte, pane e uova."
let voices = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("it") }
if voices.isEmpty { print("Nessuna voce italiana installata"); exit(1) }
let qualityName: [AVSpeechSynthesisVoiceQuality: String] = [.default: "default", .enhanced: "enhanced", .premium: "premium"]
let synthesizer = AVSpeechSynthesizer()
var index = 0

func probe(_ voice: AVSpeechSynthesisVoice) {
    let utterance = AVSpeechUtterance(string: text)
    utterance.voice = voice
    var marks: [String: Int] = [:]
    var phonemes: [String] = []
    var words: [(String, Int)] = []
    var bytes = 0
    var sampleRate: Double = 0
    var finished = false
    let t0 = Date()
    synthesizer.write(utterance, toBufferCallback: { buffer in
        guard let pcm = buffer as? AVAudioPCMBuffer else { return }
        sampleRate = pcm.format.sampleRate
        bytes += Int(pcm.frameLength) * Int(pcm.format.streamDescription.pointee.mBytesPerFrame)
        if pcm.frameLength == 0 {
            if finished { return }
            finished = true
            let seconds = sampleRate > 0 ? Double(bytes) / (sampleRate * Double(pcm.format.streamDescription.pointee.mBytesPerFrame)) : 0
            let wordList = words.prefix(6).map { "\($0.0)@\($0.1)" }.joined(separator: " ")
            print("voce=\(voice.identifier) qualita=\(qualityName[voice.quality] ?? "?") marker=\(marks) audio=\(String(format: "%.1f", seconds))s sr=\(Int(sampleRate)) sintesi=\(String(format: "%.2f", Date().timeIntervalSince(t0)))s")
            print("  parole: \(wordList)")
            if !phonemes.isEmpty { print("  fonemi: \(phonemes.prefix(20).joined(separator: " "))") }
            index += 1
            if index < voices.count { probe(voices[index]) } else { probeSpeak() }
        }
    }, toMarkerCallback: { markers in
        for m in markers {
            let name: String
            switch m.mark {
            case .word: name = "word"; words.append(((text as NSString).substring(with: m.textRange), m.byteSampleOffset))
            case .sentence: name = "sentence"
            case .paragraph: name = "paragraph"
            case .phoneme: name = "phoneme"; phonemes.append(m.phoneme)
            case .bookmark: name = "bookmark"
            @unknown default: name = "altro"
            }
            marks[name, default: 0] += 1
        }
    })
}
// Parte B: speak() con delegato — callback di parola in tempo reale (willSpeakRangeOfSpeechString) e marker (willSpeakMarker).
final class Delegate: NSObject, AVSpeechSynthesizerDelegate {
    var ranges = 0
    var markers: [String: Int] = [:]
    var firstRangeAt: Date?
    let started = Date()
    func speechSynthesizer(_ s: AVSpeechSynthesizer, willSpeakRangeOfSpeechString characterRange: NSRange, utterance: AVSpeechUtterance) {
        ranges += 1
        if firstRangeAt == nil { firstRangeAt = Date() }
    }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, willSpeak marker: AVSpeechSynthesisMarker, utterance: AVSpeechUtterance) {
        let name: String
        switch marker.mark {
        case .word: name = "word"
        case .sentence: name = "sentence"
        case .paragraph: name = "paragraph"
        case .phoneme: name = "phoneme"
        case .bookmark: name = "bookmark"
        @unknown default: name = "altro"
        }
        markers[name, default: 0] += 1
    }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let first = firstRangeAt.map { String(format: "%.2f", $0.timeIntervalSince(started)) } ?? "-"
        print("speak(): voce=\(utterance.voice?.identifier ?? "?") callbackParola=\(ranges) primoCallback=\(first)s markerDelegato=\(markers)")
        exit(0)
    }
}
let speakDelegate = Delegate()
let speakSynth = AVSpeechSynthesizer()
func probeSpeak() {
    let u = AVSpeechUtterance(string: text)
    u.voice = voices.first { $0.identifier.contains("compact") } ?? voices[0]
    u.volume = 0
    speakSynth.delegate = speakDelegate
    speakSynth.speak(u)
}
print("Voci italiane: \(voices.count)")
probe(voices[0])
RunLoop.main.run(until: Date().addingTimeInterval(240))
print("timeout")
exit(2)
