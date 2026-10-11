import Foundation

/// Fine turno automatica per la conversazione continua (M8): niente modello di «turn detection» semantico per ora
/// (Smart Turn v3 richiederebbe la conversione in Core ML: rinviato), ma una regola robusta e verificabile:
/// l'utente ha parlato (livello sopra soglia), poi silenzio per almeno `silence` e trascrizione non vuota e ferma
/// da almeno `transcriptStable`. Le pause brevi dentro una frase restano sotto la soglia di silenzio; la stabilità
/// della trascrizione evita di tagliare mentre il riconoscitore sta ancora aggiornando le parole.
struct TurnDetector: Sendable, Equatable {
    struct Config: Sendable, Equatable {
        /// Livello (0…1, scala percettiva di `AudioLevel`) oltre il quale si considera parlato.
        var speechLevel: Float = 0.35
        /// Silenzio dopo il parlato che chiude il turno (ARCHITECTURE: 500–800 ms).
        var silence: TimeInterval = 0.7
        /// La trascrizione deve essere ferma da almeno questo tempo.
        var transcriptStable: TimeInterval = 0.4
        /// Senza parlato per questo tempo la conversazione continua si chiude da sola.
        var noSpeechTimeout: TimeInterval = 12
        /// Oltre questa durata il turno viene inviato comunque.
        var maxTurn: TimeInterval = 60
        /// Parlato sentito ma nessuna parola trascritta per questo tempo: era rumore, si riparte.
        var noiseReset: TimeInterval = 4
    }

    enum Verdict: Sendable, Equatable {
        case keepListening
        /// Pausa dopo il parlato con trascrizione ferma: inviare.
        case endOfTurn
        /// Nessuno ha parlato per troppo tempo: chiudere l'ascolto.
        case noSpeech
        /// Turno troppo lungo: inviare quello che c'è.
        case tooLong
    }

    let config: Config
    let startedAt: Date
    private(set) var heardSpeech = false
    private(set) var lastSpeechAt: Date?
    private(set) var transcript = ""
    private var transcriptChangedAt: Date
    /// Istante da cui si misura l'assenza di parlato (si sposta dopo un reset per rumore).
    private var quietSince: Date

    init(config: Config = Config(), startedAt: Date = .now) {
        self.config = config
        self.startedAt = startedAt
        transcriptChangedAt = startedAt
        quietSince = startedAt
    }

    mutating func level(_ value: Float, at now: Date) {
        guard value >= config.speechLevel else { return }
        heardSpeech = true
        lastSpeechAt = now
    }

    mutating func transcript(_ text: String, at now: Date) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed != transcript else { return }
        transcript = trimmed
        transcriptChangedAt = now
        // Il riconoscitore ha capito delle parole: è parlato anche se il livello non ha superato la soglia (voce bassa).
        if !trimmed.isEmpty {
            heardSpeech = true
            lastSpeechAt = now
        }
    }

    mutating func verdict(at now: Date) -> Verdict {
        if now.timeIntervalSince(startedAt) >= config.maxTurn, !transcript.isEmpty { return .tooLong }
        guard heardSpeech, let lastSpeechAt else {
            return now.timeIntervalSince(quietSince) >= config.noSpeechTimeout ? .noSpeech : .keepListening
        }
        let quiet = now.timeIntervalSince(lastSpeechAt)
        if transcript.isEmpty {
            if quiet >= config.noiseReset {
                heardSpeech = false
                self.lastSpeechAt = nil
                quietSince = now
            }
            return .keepListening
        }
        if quiet >= config.silence, now.timeIntervalSince(transcriptChangedAt) >= config.transcriptStable {
            return .endOfTurn
        }
        return .keepListening
    }
}

/// Regola del ciclo della conversazione continua: il microfono si riapre solo quando il turno è davvero chiuso
/// (nessuna risposta in corso, voce finita, nessuna scheda in attesa). Mentre Ernie parla il microfono è spento:
/// è questo «mute logico» che garantisce che la voce sintetica non venga mai trascritta come input.
enum VoiceLoopPolicy {
    static func shouldResumeListening(continuous: Bool, waitingReply: Bool, agentState: AgentState, speakerSpeaking: Bool) -> Bool {
        continuous && waitingReply && agentState == .idle && !speakerSpeaking
    }

    /// Il microfono non si avvia mai mentre la sintesi è in corso: prima si interrompe (barge-in).
    static func mayOpenMicrophone(speakerSpeaking: Bool) -> Bool { !speakerSpeaking }
}
