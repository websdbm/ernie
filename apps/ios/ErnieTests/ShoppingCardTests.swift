import Foundation
import Testing
@testable import Ernie

@MainActor struct ShoppingCardTests {
    private let credentials = Credentials(serverURL: URL(string: "https://example.test")!, apiKey: "test")

    private func withConversation(_ body: (ConversationStore, TranscriptStore) throws -> Void) throws {
        let name = "ernie-shopping-test-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: name))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        defer { defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: directory) }
        let transcript = TranscriptStore(directory: directory, defaults: defaults)
        let conversation = ConversationStore(credentials: credentials, speaker: Speaker(), inbox: InboxStore(),
                                             settings: LocalSettings(), transcript: transcript)
        defer { conversation.disconnect() }
        try body(conversation, transcript)
    }

    private func list(_ id: String = "list", count: Int = 0) -> ContentBlock {
        .shoppingList(.init(listId: id, name: "Spesa ricetta", status: "active", items: (0..<count).map {
            .init(id: "\(id)-\($0)", name: "Ingrediente \($0)", quantity: "100 g", checked: false)
        }))
    }

    private func apply(_ block: ContentBlock, to store: ConversationStore, turn: String = "turn", seq: Int) throws {
        // Ogni tool invia un blockId diverso, anche quando aggiorna la stessa lista.
        let event = AgentEvent(payload: .assistantBlock(.init(blockId: Ids.new(), block: block)),
                               sessionId: store.sessionId, correlationId: turn, seq: seq)
        store.apply(try AgentEvent.decode(event.encoded()))
    }

    private func messages(_ store: ConversationStore) -> [ChatMessage] {
        store.items.compactMap { if case .message(let m) = $0 { return m }; return nil }
    }

    @Test func creazioneEAggiuntaMostranoUnaSolaSchedaConTuttiGliIngredienti() throws {
        try withConversation { store, _ in
            var received: [ContentBlock] = []
            store.onBlock = { received.append($0) }
            try apply(list(), to: store, seq: 1)
            try apply(list(count: 12), to: store, seq: 2)
            try apply(list(count: 12), to: store, seq: 3) // rilettura/replay identico
            #expect(messages(store).count == 1)
            #expect(messages(store).first?.blocks == [list(count: 12)])
            #expect(received.count == 3) // lo store condiviso riceve sempre gli aggiornamenti
        }
    }

    @Test func spunteRimozioniERinominaSostituisconoLoSnapshot() throws {
        try withConversation { store, _ in
            try apply(list(count: 12), to: store, seq: 1)
            let changed = ContentBlock.shoppingList(.init(listId: "list", name: "Cena", status: "archived", items: [
                .init(id: "list-0", name: "Ingrediente 0", quantity: "200 g", checked: true)
            ]))
            try apply(changed, to: store, seq: 2)
            #expect(messages(store).first?.blocks == [changed])
            try apply(list(), to: store, seq: 3)
            #expect(messages(store).first?.blocks == [list()]) // una lista svuotata non recupera vecchie voci
        }
    }

    @Test func listeDiverseAncheConLoStessoNomeRestanoSeparateENelloStessoOrdine() throws {
        try withConversation { store, _ in
            try apply(list("first"), to: store, seq: 1)
            try apply(list("second", count: 2), to: store, seq: 2)
            try apply(list("first", count: 12), to: store, seq: 3)
            #expect(messages(store).first?.blocks == [list("first", count: 12), list("second", count: 2)])
        }
    }

    @Test func richiamareUnaListaInUnAltroTurnoConservaLaRispostaPrecedente() throws {
        try withConversation { store, _ in
            try apply(list(), to: store, turn: "first", seq: 1)
            try apply(list(count: 12), to: store, turn: "first", seq: 2)
            try apply(list(count: 12), to: store, turn: "second", seq: 3)
            #expect(messages(store).count == 2)
            #expect(messages(store).map(\.blocks) == [[list(count: 12)], [list(count: 12)]])
        }
    }

    @Test func cronologiaPrecedenteSiRiapreSenzaDuplicatiESenzaPerdereAltriBlocchi() throws {
        try withConversation { store, transcript in
            let separator = ContentBlock.unknown(kind: "future_card")
            let old = ChatMessage(id: "message", correlationId: "turn", role: .assistant, text: "Ho preparato la spesa.",
                                  blocks: [list(), separator, list("second", count: 2), list(count: 12)], createdAt: .now)
            let file = TranscriptStore.SessionFile(sessionId: "past", lastSeq: 744, items: [.message(old)], updatedAt: .now)
            transcript.save(file)
            let loaded = try #require(transcript.load("past"))
            guard case .message(let normalized) = loaded.items.first else { Issue.record("Messaggio mancante"); return }
            #expect(normalized.blocks == [list(count: 12), separator, list("second", count: 2)])
            #expect(normalized.id == old.id)
            #expect(normalized.text == old.text)
            #expect(loaded.lastSeq == 744)
            transcript.save(loaded)
            #expect(transcript.load("past")?.items == loaded.items)
            store.resume(sessionId: "past")
            #expect(messages(store).first?.blocks == normalized.blocks)
            let reopened = ConversationStore(credentials: credentials, speaker: Speaker(), inbox: InboxStore(),
                                               settings: LocalSettings(), transcript: transcript)
            defer { reopened.disconnect() }
            #expect(messages(reopened).first?.blocks == normalized.blocks)
        }
    }
}
