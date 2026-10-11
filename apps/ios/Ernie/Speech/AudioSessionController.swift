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

    /// Route corrente in breve («MicrophoneBuiltIn → Speaker»), per gli eventi audio in Diagnostica.
    static func routeSummary() -> String {
        let s = AVAudioSession.sharedInstance()
        let ins = s.currentRoute.inputs.map(\.portType.rawValue).joined(separator: "+")
        let outs = s.currentRoute.outputs.map(\.portType.rawValue).joined(separator: "+")
        return "\(ins.isEmpty ? "nessun ingresso" : ins) → \(outs.isEmpty ? "nessuna uscita" : outs)"
    }

    /// Stato della sessione per il log e i messaggi d'errore: frequenza, ingressi, route, altre app in riproduzione.
    static func describe() -> String {
        let s = AVAudioSession.sharedInstance()
        let ins = s.currentRoute.inputs.map(\.portType.rawValue).joined(separator: "+")
        let outs = s.currentRoute.outputs.map(\.portType.rawValue).joined(separator: "+")
        return "sessione \(Int(s.sampleRate)) Hz, canali in ingresso \(s.inputNumberOfChannels), ingresso disponibile \(s.isInputAvailable ? "sì" : "no"), "
            + "route \(ins.isEmpty ? "nessuno" : ins) → \(outs.isEmpty ? "nessuno" : outs), altre app audio \(s.isOtherAudioPlaying ? "sì" : "no"), "
            + "categoria \(s.category.rawValue), modo \(s.mode.rawValue)"
    }
}

/// Buffer PCM da passare tra thread audio e attori: AVAudioPCMBuffer non è Sendable, qui non viene più mutato.
struct AudioChunk: @unchecked Sendable {
    let buffer: AVAudioPCMBuffer
}

/// Cattura dal microfono con AVAudioEngine; i buffer escono da un AsyncStream.
///
/// Su iPhone (iOS 18+, visto su iOS 27.0.1) `inputNode.outputFormat(forBus: 0)` può risultare vuoto (0 Hz, 0 canali)
/// subito dopo l'attivazione della sessione, in particolare con l'elaborazione vocale attiva o con un'altra app in
/// riproduzione: `installTap` con quel formato solleva un'eccezione e chiude l'app (crash log della build 8).
/// Qui il formato viene atteso con qualche tentativo, la sessione riattivata, e in ultima istanza si rinuncia
/// all'elaborazione vocale; se resta vuoto si segnala un errore con la diagnostica della sessione.
final class MicrophoneCapture {
    private let engine = AVAudioEngine()
    private(set) var format: AVAudioFormat?
    private(set) var voiceProcessing = false
    /// Ultima diagnostica della sessione raccolta durante l'avvio (vuota se tutto è andato bene al primo colpo).
    private(set) var diagnostics = ""
    /// Livello d'ingresso (0…1, scala percettiva) per ogni buffer del tap (~40 ms): da impostare prima di `start()`.
    var onLevel: (@Sendable (Float) -> Void)?

    func start() async throws -> AsyncStream<AudioChunk> {
        let input = engine.inputNode
        // L'elaborazione vocale (AEC/AGC) va attivata prima di leggere il formato e installare il tap;
        // su alcuni dispositivi non è disponibile: si prosegue senza.
        setVoiceProcessing(true, on: input)
        var fmt = await waitForFormat(of: input)
        if fmt == nil, voiceProcessing {
            Log.speech.warning("formato vuoto con elaborazione vocale: riprovo senza (niente cancellazione d'eco)")
            setVoiceProcessing(false, on: input)
            fmt = await waitForFormat(of: input)
        }
        guard let fmt else {
            throw NSError(domain: "Ernie.Speech", code: 6, userInfo: [
                NSLocalizedDescriptionKey: "microfono non disponibile (formato audio vuoto; \(diagnostics))",
            ])
        }
        format = fmt
        Log.speech.info("microfono: \(Int(fmt.sampleRate)) Hz, \(fmt.channelCount) canali, voice processing \(self.voiceProcessing)")
        // 512 buffer ≈ 20 s a 48 kHz: l'audio detto mentre il trascrittore si avvia non va perso.
        let (stream, continuation) = AsyncStream.makeStream(of: AudioChunk.self, bufferingPolicy: .bufferingNewest(512))
        let level = onLevel
        // `format: nil` = formato d'uscita del nodo, lo stesso appena verificato.
        input.installTap(onBus: 0, bufferSize: 2048, format: nil) { buffer, _ in
            level?(AudioLevel.normalized(rms: AudioLevel.rms(of: buffer)))
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

    private func setVoiceProcessing(_ enabled: Bool, on input: AVAudioInputNode) {
        guard input.isVoiceProcessingEnabled != enabled else { voiceProcessing = enabled; return }
        do {
            try input.setVoiceProcessingEnabled(enabled)
            voiceProcessing = enabled
        } catch {
            voiceProcessing = input.isVoiceProcessingEnabled
            Log.speech.warning("voice processing \(enabled ? "non attivabile" : "non disattivabile"): \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Formato d'uscita del nodo d'ingresso quando è valido; altrimenti qualche tentativo a breve distanza,
    /// con riattivazione della sessione a metà strada. Solo il formato d'uscita conta: è quello usato dal tap.
    private func waitForFormat(of input: AVAudioInputNode) async -> AVAudioFormat? {
        for attempt in 1...4 {
            let out = input.outputFormat(forBus: 0)
            if out.sampleRate > 0, out.channelCount > 0 { return out }
            let hw = input.inputFormat(forBus: 0)
            diagnostics = "\(AudioSessionController.describe()); nodo in \(Int(hw.sampleRate)) Hz/\(hw.channelCount) ch, out \(Int(out.sampleRate)) Hz/\(out.channelCount) ch, VP \(voiceProcessing ? "on" : "off")"
            Log.speech.warning("formato microfono vuoto (tentativo \(attempt)): \(self.diagnostics, privacy: .public)")
            if attempt == 2 {
                // Riattivare la sessione fa ricostruire la route d'ingresso.
                AudioSessionController.deactivate()
                try? AudioSessionController.activateForVoice()
            }
            try? await Task.sleep(for: .milliseconds(150))
        }
        let out = input.outputFormat(forBus: 0)
        return out.sampleRate > 0 && out.channelCount > 0 ? out : nil
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

/// Livello del microfono per il riscontro visivo (barre) e per capire se l'utente stava parlando.
enum AudioLevel {
    /// RMS dei campioni float del primo canale (0 se il formato non è float o il buffer è vuoto).
    static func rms(of buffer: AVAudioPCMBuffer) -> Float {
        guard let data = buffer.floatChannelData, buffer.frameLength > 0 else { return 0 }
        let n = Int(buffer.frameLength)
        let ch = data[0]
        var sum: Float = 0
        for i in 0..<n { sum += ch[i] * ch[i] }
        return (sum / Float(n)).squareRoot()
    }

    /// Scala percettiva: −50 dBFS → 0, 0 dBFS → 1. Il parlato vicino al telefono sta tipicamente tra 0,4 e 0,8.
    static func normalized(rms: Float) -> Float {
        guard rms > 0 else { return 0 }
        let db = 20 * log10(rms)
        return min(1, max(0, (db + 50) / 50))
    }
}
