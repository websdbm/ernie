import AVFoundation
import Foundation
import UIKit

/// Effetti originali brevi: zampa, soffio ruvido e accenti retro; nessun loop durante il pensiero.
enum ErnieSound: String, CaseIterable, Sendable {
    case send, done, ask, approve, cancel, check, error

    var title: String {
        switch self {
        case .send: "Invio · colpetto di zampa"
        case .done: "Fatto · brum soddisfatto"
        case .ask: "Conferma richiesta · richiamo curioso"
        case .approve: "Confermato · doppia zampata"
        case .cancel: "Annullato · zampa leggera"
        case .check: "Completato · piccolo premio"
        case .error: "Errore · brontolio"
        }
    }
    var asset: String { "ernie-ui-\(rawValue)" }
    func url(in bundle: Bundle = .main) -> URL? {
        bundle.url(forResource: asset, withExtension: "wav", subdirectory: "Sounds")
            ?? bundle.url(forResource: asset, withExtension: "wav")
    }
}

/// Nessun recupero ritardato: un effetto soppresso durante voce/background resta soppresso anche al replay.
struct SoundFeedbackGate {
    private var seen: [String] = []
    private var lastPlayed: TimeInterval?

    mutating func accept(key: String?, enabled: Bool, volume: Double, foreground: Bool,
                         voiceBusy: Bool, now: TimeInterval) -> Bool {
        if let key {
            guard !seen.contains(key) else { return false }
            seen.append(key)
            if seen.count > 256 { seen.removeFirst(seen.count - 256) }
        }
        guard enabled, volume.isFinite, volume > 0, foreground, !voiceBusy else { return false }
        if let lastPlayed, now - lastPlayed < 0.12 { return false }
        lastPlayed = now
        return true
    }
}

@MainActor
protocol SoundEffectOutput: AnyObject {
    func play(url: URL, volume: Float) -> Bool
    func stop()
}

/// Un solo player; non cambia mai la sessione mentre microfono o parlato ne hanno la precedenza.
@MainActor
final class ErnieSoundPlayer {
    static let shared = ErnieSoundPlayer()
    static let enabledKey = "ernie.sounds.enabled"
    static let volumeKey = "ernie.sounds.volume"
    static let defaultVolume = 0.55

    enum VoiceUse: Hashable { case microphone, speech }
    private var voiceUses: Set<VoiceUse> = []
    private var gate = SoundFeedbackGate()
    private var foreground = true
    private let defaults: UserDefaults
    private let output: any SoundEffectOutput
    private let applicationActive: () -> Bool
    private let clock: () -> TimeInterval

    init(defaults: UserDefaults = .standard, output: (any SoundEffectOutput)? = nil,
         applicationActive: @escaping () -> Bool = { UIApplication.shared.applicationState == .active },
         clock: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.defaults = defaults
        self.output = output ?? NativeSoundEffectOutput()
        self.applicationActive = applicationActive
        self.clock = clock
    }

    func play(_ sound: ErnieSound, key: String? = nil) {
        let enabled = defaults.object(forKey: Self.enabledKey) as? Bool ?? true
        let configured = defaults.object(forKey: Self.volumeKey) as? Double ?? Self.defaultVolume
        let volume = configured.isFinite ? min(1, max(0, configured)) : 0
        guard gate.accept(key: key, enabled: enabled, volume: volume,
                          foreground: foreground && applicationActive(), voiceBusy: !voiceUses.isEmpty,
                          now: clock()), let url = sound.url() else { return }
        _ = output.play(url: url, volume: Float(volume))
    }

    func setForeground(_ active: Bool) {
        foreground = active
        if !active { output.stop() }
    }
    func stop() { output.stop() }

    /// La riproduzione vocale arriva sempre dopo la chiusura della cattura, anche a mani libere.
    func beginVoice(_ use: VoiceUse) {
        if use == .speech { voiceUses.remove(.microphone) }
        voiceUses.insert(use)
        output.stop()
    }
    func endVoice(_ use: VoiceUse) { voiceUses.remove(use) }
    func endVoiceSession() { voiceUses.removeAll() }
}

@MainActor
private final class NativeSoundEffectOutput: SoundEffectOutput {
    private var player: AVAudioPlayer?
    private var cleanup: Task<Void, Never>?
    private var generation = UUID()

    func play(url: URL, volume: Float) -> Bool {
        stop()
        do {
            let next = try AVAudioPlayer(contentsOf: url)
            let session = AVAudioSession.sharedInstance()
            // Ambient rispetta il silenzioso e miscela con musica/podcast, senza ducking o cambio di route.
            try session.setCategory(.ambient, mode: .default, options: [.mixWithOthers])
            try session.setActive(true)
            next.volume = volume
            player = next
            guard next.prepareToPlay(), next.play() else { stop(); return false }
            let token = generation
            let duration = next.duration
            cleanup = Task { [weak self] in
                try? await Task.sleep(for: .seconds(duration + 0.05))
                guard !Task.isCancelled, let self, self.generation == token else { return }
                self.stop()
            }
            return true
        } catch {
            stop()
            return false
        }
    }

    func stop() {
        generation = UUID()
        cleanup?.cancel(); cleanup = nil
        let wasPlaying = player != nil
        player?.stop(); player = nil
        // Un callback vecchio non deve disattivare la sessione che nel frattempo usa la voce.
        if wasPlaying, AVAudioSession.sharedInstance().category == .ambient {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }
}
