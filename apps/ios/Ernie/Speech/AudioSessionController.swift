import AVFoundation

/// Sessione audio per la conversazione vocale: registrazione e riproduzione insieme, altoparlante, Bluetooth.
/// La cancellazione d'eco e l'AGC si attivano su `AVAudioEngine.inputNode.setVoiceProcessingEnabled(true)` (A.13).
enum AudioSessionController {
    static func activateForVoice() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP, .allowBluetoothA2DP])
        try session.setActive(true)
    }

    static func deactivate() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

/// Buffer PCM da passare tra thread audio e attori: AVAudioPCMBuffer non è Sendable, qui non viene più mutato.
struct AudioChunk: @unchecked Sendable {
    let buffer: AVAudioPCMBuffer
}

/// Cattura dal microfono con AVAudioEngine; i buffer escono da un AsyncStream.
final class MicrophoneCapture {
    private let engine = AVAudioEngine()
    private(set) var format: AVAudioFormat?
    private(set) var voiceProcessing = false

    func start() throws -> AsyncStream<AudioChunk> {
        let input = engine.inputNode
        do {
            try input.setVoiceProcessingEnabled(true)
            voiceProcessing = true
        } catch {
            Log.speech.warning("voice processing non attivabile: \(error.localizedDescription, privacy: .public)")
        }
        let fmt = input.outputFormat(forBus: 0)
        format = fmt
        let (stream, continuation) = AsyncStream.makeStream(of: AudioChunk.self, bufferingPolicy: .bufferingNewest(64))
        input.installTap(onBus: 0, bufferSize: 2048, format: fmt) { buffer, _ in
            continuation.yield(AudioChunk(buffer: buffer))
        }
        engine.prepare()
        try engine.start()
        continuation.onTermination = { @Sendable _ in }
        return stream
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }
}
