import AVFoundation
import Foundation
import Testing
@testable import Ernie

struct SpeechTests {
    @Test func spezzaLeFrasiCompleteELasciaIlResto() {
        var buffer = "Ecco tre ricette per la settimana. La prima è la zuppa di legumi! Poi"
        let sentences = SentenceSplitter.popSentences(from: &buffer)
        #expect(sentences == ["Ecco tre ricette per la settimana.", "La prima è la zuppa di legumi!"])
        #expect(buffer == " Poi")
    }

    @Test func nonSpezzaSuNumeriPuntati() {
        var buffer = "1. Zuppa di legumi, circa trenta minuti. 2."
        let sentences = SentenceSplitter.popSentences(from: &buffer)
        #expect(sentences == ["1. Zuppa di legumi, circa trenta minuti."])
        #expect(buffer == " 2.")
    }

    @Test func rimuoveIlMarkdownPrimaDiParlare() {
        #expect(SentenceSplitter.plainForSpeech("**Pollo** al [limone](https://x.it) con `aglio`") == "Pollo al limone con aglio")
        #expect(SentenceSplitter.plainForSpeech("- latte") == "latte")
        #expect(SentenceSplitter.plainForSpeech("🛒 In lista ci sono 3 voci 👍") == "In lista ci sono 3 voci")
        #expect(SentenceSplitter.plainForSpeech("In lista:\n- latte\n- 2 uova\n1. pane") == "In lista:\nlatte\n2 uova\npane")
    }

    @Test func blocchiMarkdown() {
        let blocks = Markdown.blocks("In lista ci sono 3 voci:\n- latte\n- pane\n\n## Ricette\n1. Zuppa\n2. Pollo\n> nota")
        #expect(blocks == [
            .paragraph("In lista ci sono 3 voci:"),
            .bullets(["latte", "pane"]),
            .heading("Ricette"),
            .numbered(start: 1, ["Zuppa", "Pollo"]),
            .quote("nota"),
        ])
    }

    @Test func livelloMicrofonoInScalaPercettiva() {
        #expect(AudioLevel.normalized(rms: 0) == 0)
        #expect(AudioLevel.normalized(rms: 1) == 1)
        // −20 dBFS (parlato vicino) → 0,6; −50 dBFS (silenzio) → 0.
        #expect(abs(AudioLevel.normalized(rms: 0.1) - 0.6) < 0.001)
        #expect(AudioLevel.normalized(rms: 0.001) < 0.11)
        let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4)!
        buffer.frameLength = 4
        for i in 0..<4 { buffer.floatChannelData![0][i] = 0.5 }
        #expect(abs(AudioLevel.rms(of: buffer) - 0.5) < 0.0001)
    }

    @Test func elencoNumeratoInterrottoNonRiparteDaUno() {
        let blocks = Markdown.blocks("1. Apple\nhttps://a.it\n2. Reddit\nhttps://b.it\n3. Blog")
        #expect(blocks == [
            .numbered(start: 1, ["Apple"]),
            .paragraph("https://a.it"),
            .numbered(start: 2, ["Reddit"]),
            .paragraph("https://b.it"),
            .numbered(start: 3, ["Blog"]),
        ])
    }

    @Test func latenzaPerStadio() {
        var t = LatencyTrace(startedAt: Date(timeIntervalSince1970: 0))
        t.mark(.pttReleased, at: Date(timeIntervalSince1970: 10))
        t.mark(.transcriptFinal, at: Date(timeIntervalSince1970: 10.4))
        t.mark(.messageSent, at: Date(timeIntervalSince1970: 10.45))
        t.mark(.firstToken, at: Date(timeIntervalSince1970: 11.2))
        t.mark(.firstSpeech, at: Date(timeIntervalSince1970: 11.6))
        t.mark(.firstSpeech, at: Date(timeIntervalSince1970: 20))   // il primo vince
        #expect(abs((t.audibleLatency ?? 0) - 1.6) < 0.001)
        #expect(abs((t.sttFinalization ?? 0) - 0.4) < 0.001)
        #expect(LatencyTrace.percentile([3, 1, 2], 0.5) == 2)
        #expect(LatencyTrace.percentile([], 0.5) == nil)
    }

    @Test func schedaNotificaRiassumeLeAzioniSospese() throws {
        let json = """
        {"id":"n1","kind":"automation.approval","title":"Ricette","body":"Tre ricette","createdAt":"2026-10-11T09:21:20.000Z","payload":{"runId":"r","pendingActions":[{"approvalId":"a1","toolId":"shopping_list_add","args":{"items":[{"name":"limoni","quantity":"3"},{"name":"aglio"}]},"reason":"run contaminata","expiresAt":"x"}]}}
        """
        let item = try JSONDecoder().decode(NotificationItem.self, from: Data(json.utf8))
        let card = NotificationCard(item)
        #expect(card.needsApproval)
        #expect(card.pendingActions.first?.summary == "Aggiungi alla lista: limoni (3), aglio")
    }
}
