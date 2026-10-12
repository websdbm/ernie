import Testing
@testable import Ernie

/// Capoversi leggibili: i paragrafi lunghi vengono spezzati in gruppi di due o tre frasi, senza rompere abbreviazioni e numeri.
struct ReadabilityTests {
    @Test func spezzaLeFrasiRispettandoAbbreviazioniENumeri() {
        let s = Markdown.split("Costa 3.5 euro, es. al mercato. Il dott. Rossi dice che va bene. Davvero! Sì.")
        #expect(s == ["Costa 3.5 euro, es. al mercato.", "Il dott. Rossi dice che va bene.", "Davvero!", "Sì."])
    }

    @Test func paragrafoBreveRestaIntero() {
        let p = "Prima frase. Seconda frase. Terza frase."
        #expect(Markdown.readable(p) == [p])
    }

    @Test func paragrafoLungoDiventaCapoversiDiDueOTreFrasi() {
        let frasi = (1...8).map { "Questa è la frase numero \($0) di un testo volutamente lungo per la prova." }
        let parti = Markdown.readable(frasi.joined(separator: " "))
        #expect(parti.count == 3)
        #expect(parti.map { Markdown.split($0).count } == [3, 3, 2])
        #expect(parti.joined(separator: " ") == frasi.joined(separator: " "))
    }

    @Test func quattroFrasiNonLascianoUnaFraseSola() {
        let frasi = (1...4).map { "Frase numero \($0), abbastanza lunga da superare la soglia dei duecentoventi caratteri complessivi." }
        let parti = Markdown.readable(frasi.joined(separator: " "))
        #expect(parti.map { Markdown.split($0).count } == [2, 2])
    }
}
