import Foundation
import Testing
@testable import Ernie

/// Fine turno automatica e ciclo della conversazione continua (M8): regole pure, senza audio.
struct VoiceTests {
    private let t0 = Date(timeIntervalSince1970: 1_000_000)
    private func at(_ s: Double) -> Date { t0.addingTimeInterval(s) }

    @Test func nonChiudeSenzaParlato() {
        var d = TurnDetector(startedAt: t0)
        for i in 0..<50 { d.level(0.05, at: at(Double(i) * 0.1)) }
        #expect(d.verdict(at: at(5)) == .keepListening)
        #expect(d.heardSpeech == false)
    }

    @Test func silenzioProlungatoChiudeLAscolto() {
        var d = TurnDetector(startedAt: t0)
        #expect(d.verdict(at: at(11.9)) == .keepListening)
        #expect(d.verdict(at: at(12)) == .noSpeech)
    }

    @Test func pausaDopoIlParlatoConTrascrizioneFermaChiudeIlTurno() {
        var d = TurnDetector(startedAt: t0)
        d.level(0.6, at: at(0.5))
        d.transcript("metti il latte", at: at(0.8))
        d.level(0.7, at: at(1.0))
        d.transcript("metti il latte in lista", at: at(1.3))
        // Pausa breve dentro la frase: non chiude.
        #expect(d.verdict(at: at(1.5)) == .keepListening)
        // 0,7 s di silenzio dal livello (1,0) ma la trascrizione è cambiata a 1,3: aspetta la stabilità.
        #expect(d.verdict(at: at(1.65)) == .keepListening)
        // Silenzio ≥ 0,7 s dall'ultima parola trascritta (1,3) e trascrizione ferma da ≥ 0,4 s.
        #expect(d.verdict(at: at(2.05)) == .endOfTurn)
    }

    @Test func laTrascrizioneConta_comeParlatoAncheAVoceBassa() {
        var d = TurnDetector(startedAt: t0)
        d.transcript("ciao", at: at(1))
        #expect(d.heardSpeech)
        #expect(d.verdict(at: at(1.5)) == .keepListening)
        #expect(d.verdict(at: at(1.8)) == .endOfTurn)
    }

    @Test func rumoreSenzaParoleNonInviaNullaESiRiparte() {
        var d = TurnDetector(startedAt: t0)
        d.level(0.9, at: at(1))
        #expect(d.verdict(at: at(2)) == .keepListening)
        #expect(d.verdict(at: at(5.1)) == .keepListening)
        #expect(d.heardSpeech == false)
        // Il conto del silenzio riparte dal reset: non chiude subito.
        #expect(d.verdict(at: at(12.5)) == .keepListening)
        #expect(d.verdict(at: at(17.2)) == .noSpeech)
    }

    @Test func turnoTroppoLungoVieneInviatoComunque() {
        var d = TurnDetector(startedAt: t0)
        d.transcript("una frase lunghissima", at: at(59.9))
        d.level(0.8, at: at(59.95))
        #expect(d.verdict(at: at(60)) == .tooLong)
    }

    @Test func ilMicrofonoSiRiapreSoloATurnoChiusoEVoceFinita() {
        #expect(VoiceLoopPolicy.shouldResumeListening(continuous: true, waitingReply: true, agentState: .idle, speakerSpeaking: false))
        // Mentre Ernie parla, mai: la voce sintetica non deve diventare input.
        #expect(!VoiceLoopPolicy.shouldResumeListening(continuous: true, waitingReply: true, agentState: .speaking, speakerSpeaking: true))
        #expect(!VoiceLoopPolicy.shouldResumeListening(continuous: true, waitingReply: true, agentState: .idle, speakerSpeaking: true))
        #expect(!VoiceLoopPolicy.shouldResumeListening(continuous: true, waitingReply: true, agentState: .thinking, speakerSpeaking: false))
        #expect(!VoiceLoopPolicy.shouldResumeListening(continuous: false, waitingReply: true, agentState: .idle, speakerSpeaking: false))
        #expect(!VoiceLoopPolicy.shouldResumeListening(continuous: true, waitingReply: false, agentState: .idle, speakerSpeaking: false))
        #expect(!VoiceLoopPolicy.mayOpenMicrophone(speakerSpeaking: true))
    }

    @Test func impostazioniLocaliConValoriPredefiniti() throws {
        let decoded = try JSONDecoder().decode(LocalSettings.self, from: Data("{\"voiceOutput\":false}".utf8))
        #expect(decoded.voiceOutput == false)
        #expect(decoded.continuousVoice == false)
        var s = LocalSettings()
        s.continuousVoice = true
        let round = try JSONDecoder().decode(LocalSettings.self, from: JSONEncoder().encode(s))
        #expect(round.continuousVoice)
    }
}
