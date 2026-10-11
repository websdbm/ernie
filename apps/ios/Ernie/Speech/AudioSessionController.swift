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
        // L'elaborazione vocale (AEC/AGC) va attivata prima di leggere il formato e installare il tap;
        // su alcuni dispositivi non è disponibile: si prosegue senza.
        if !input.isVoiceProcessingEnabled {
            do {
                try input.setVoiceProcessingEnabled(true)
                voiceProcessing = true
            } catch {
                Log.speech.warning("voice processing non attivabile: \(error.localizedDescription, privacy: .public)")
            }
        } else {
            voiceProcessing = true
        }
        let fmt = input.outputFormat(forBus: 0)
        // Un formato vuoto (0 Hz o 0 canali) fa abortire installTap: meglio un errore gestito.
        guard fmt.sampleRate > 0, fmt.channelCount > 0 else {
            throw NSError(domain: "Ernie.Speech", code: 6, userInfo: [NSLocalizedDescriptionKey: "microfono non disponibile (formato audio vuoto)"])
        }
        format = fmt
        Log.speech.info("microfono: \(Int(fmt.sampleRate)) Hz, \(fmt.channelCount) canali, voice processing \(self.voiceProcessing)")
        let (stream, continuation) = AsyncStream.makeStream(of: AudioChunk.self, bufferingPolicy: .bufferingNewest(64))
        input.installTap(onBus: 0, bufferSize: 2048, format: nil) { buffer, _ in
            // Il buffer del tap vale solo durante la callback: ne serve una copia per consumarlo altrove.
            if let copy = buffer.deepCopy() { continuation.yield(AudioChunk(buffer: copy)) }
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            continuation.finish()
            throw error
        }
        continuation.onTermination = { @Sendable _ in }
        return stream
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }
}

extension AVAudioPCMBuffer {
    /// Copia indipendente (formato, lunghezza e campioni): il buffer originale del tap viene riutilizzato dal motore.
    func deepCopy() -> AVAudioPCMBuffer? {
        guard frameLength > 0, let copy = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameLength) else { return nil }
        copy.frameLength = frameLength
        let src = audioBufferList.pointee
        let dst = copy.mutableAudioBufferList.pointee
        let buffers = Int(src.mNumberBuffers)
        guard buffers == Int(dst.mNumberBuffers) else { return nil }
        let srcPtr = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: audioBufferList))
        let dstPtr = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
        for i in 0..<buffers {
            guard let s = srcPtr[i].mData, let d = dstPtr[i].mData else { return nil }
            let bytes = Int(min(srcPtr[i].mDataByteSize, dstPtr[i].mDataByteSize))
            memcpy(d, s, bytes)
            dstPtr[i].mDataByteSize = UInt32(bytes)
        }
        return copy
    }
}
