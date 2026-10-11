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
