import Foundation
import Testing
@testable import Ernie

struct OrderingTests {
    @Test func dedupeRicordaGliIdFinoAllaCapacita() {
        let d = EventDeduper(capacity: 3)
        #expect(!d.isDuplicate("a"))
        #expect(d.isDuplicate("a"))
        #expect(!d.isDuplicate("b"))
        #expect(!d.isDuplicate("c"))
        #expect(!d.isDuplicate("d"))   // espelle "a"
        #expect(!d.isDuplicate("a"))
        #expect(d.count == 3)
    }

    @Test func trackerSegnalaDuplicatiEBuchi() {
        var t = SequenceTracker()
        #expect(t.check(0) == .ok)
        #expect(t.check(1) == .ok)
        #expect(t.check(1) == .duplicate(seq: 1))
        #expect(t.check(4) == .gap(expected: 2, received: 4))
        #expect(t.check(5) == .ok)
    }

    @Test func sorgenteMonotona() {
        var s = SequenceSource()
        #expect(s.next() == 0)
        #expect(s.next() == 1)
        #expect(s.peek == 2)
    }
}

struct RequestRecoveryTests {
    @Test func ripresaConservaIdentitaAllegatiEPosizione() throws {
        let payload = UserMessagePayload(text: "Memorizza questa posizione", inputMode: "voice", locale: "it-IT",
            attachments: [DocumentAttachment(id: "documento")],
            device: DeviceContextPayload(timezone: "Europe/Rome", location: .init(latitude: 45, longitude: 12, at: "2026-10-17T12:00:00Z")))
        let message = ChatMessage(id: "messaggio", correlationId: "richiesta", role: .user, text: payload.text,
            createdAt: .now, requestPayload: payload, awaitingResponse: true)
        let saved = try JSONEncoder().encode(message)
        let loaded = try JSONDecoder().decode(ChatMessage.self, from: saved)
        var request = try #require(ChatRequestRecovery.from(loaded))
        let attempts = (0..<4).map { _ in request.nextAttempt() }
        #expect(attempts == [true, true, true, false])
        #expect(request.payload == payload)
        #expect(request.correlationId == "richiesta")
        #expect(request.messageId == "messaggio")
        #expect(request.payload.text != "Riprova")
    }

    @Test func nonRipeteRichiesteOltreLaFinestraDiDeduplica() {
        let payload = UserMessagePayload(text: "Salva", inputMode: "text")
        let old = ChatMessage(id: "m", correlationId: "c", role: .user, text: "Salva",
            createdAt: Date.now.addingTimeInterval(-24 * 3600), requestPayload: payload, awaitingResponse: true)
        #expect(ChatRequestRecovery.from(old) == nil)
    }

    @Test func attivitaStoricheHannoEtichetteItaliane() {
        #expect(ToolLabels.name("brain_merge") == "Unione delle schede")
        #expect(ToolLabels.name("present_choices", displayName: "present_choices") == "Proposta delle opzioni")
        #expect(ToolLabels.name("futuro_tool") == "Operazione di Ernie")
        #expect(ToolLabels.name("nuovo", displayName: "Lettura del calendario") == "Lettura del calendario")
        let pending = NotificationCard.describe(toolId: "reminder_create", args: .object(["title": .string("Chiama Anna")]))
        #expect(pending.contains("Creazione del promemoria"))
        #expect(pending.contains("Chiama Anna"))
    }
}
