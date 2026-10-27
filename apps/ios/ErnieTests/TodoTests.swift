import Foundation
import SwiftUI
import Testing
@testable import Ernie

private enum TodoFixtures {
    static let group = TodoItem(id: "00000000-0000-4000-8000-000000000001", title: "Famiglia", kind: .group)
    static let first = TodoSlot(id: "00000000-0000-4000-8000-000000000011", startAt: "2026-10-19T15:00:00+02:00", endAt: "2026-10-19T15:15:00+02:00", fixed: true, reminderMinutes: 30)
    static let second = TodoSlot(id: "00000000-0000-4000-8000-000000000012", startAt: "2026-10-19T18:00:00+02:00", endAt: "2026-10-19T18:15:00+02:00", fixed: true, reminderMinutes: 20)
    static var list: TodoList {
        TodoList(id: "00000000-0000-4000-8000-000000000099", name: "La giornata", mode: .scheduled, day: "2026-10-19", timezone: "Europe/Rome", revision: 2, items: [
            group,
            TodoItem(id: "00000000-0000-4000-8000-000000000002", parentId: group.id, title: "Accompagnare al catechismo", position: 1, slots: [first]),
            TodoItem(id: "00000000-0000-4000-8000-000000000003", parentId: group.id, title: "Riprendere dal catechismo", position: 2, slots: [second]),
            TodoItem(id: "00000000-0000-4000-8000-000000000004", title: "Lavorare a Stimo anche in due sessioni", position: 3, minimumMinutes: 60, splittable: true, slots: [
                TodoSlot(startAt: "2026-10-19T14:00:00+02:00", endAt: "2026-10-19T14:30:00+02:00"),
                TodoSlot(startAt: "2026-10-19T17:00:00+02:00", endAt: "2026-10-19T17:30:00+02:00")
            ]),
            TodoItem(title: "Attività ancora da collocare con un titolo che richiede più righe", position: 4),
            TodoItem(title: "Attività annullata", status: .cancelled, position: 5)
        ], updatedAt: "2026-10-19T09:00:00Z")
    }
}

struct TodoTests {
    @Test func replayDeiBlocchiTodoConservaUnaSchedaConLaRevisionePiuRecente() throws {
        let original = TodoFixtures.list
        var latest = original; latest.revision += 1; latest.items[1].status = .done
        let event = AgentEvent(payload: .assistantBlock(.init(blockId: "todo:1", block: .todoList(.init(list: latest)))), sessionId: "s", correlationId: "c", seq: 1)
        let decoded = try AgentEvent.decode(event.encoded())
        guard case .assistantBlock(let block) = decoded.payload else { Issue.record("Manca la scheda Todo"); return }
        #expect(block.block == .todoList(.init(list: latest)))
        var message = ChatMessage(id: "message", correlationId: "c", role: .assistant, text: "Aggiornata", blocks: [.todoList(.init(list: original)), block.block, .todoList(.init(list: original))], createdAt: .now)
        message.coalesceListSnapshots()
        #expect(message.blocks == [block.block])
    }
    @Test func modelloProtocolloConservaGerarchiaDipendenzeETutteLeSessioni() throws {
        var list = TodoFixtures.list
        list.items[2].dependsOn = [.init(taskId: list.items[1].id, lagMinutes: 0)]
        let block = TodoListBlock(list: list)
        let data = try JSONEncoder().encode(block)
        let decoded = try JSONDecoder().decode(TodoListBlock.self, from: data)
        #expect(decoded == block)
        #expect(decoded.kind == "todo_list")
        #expect(decoded.list.items[3].slots.count == 2)
        #expect(decoded.list.groupPath(for: decoded.list.items[2]) == "Famiglia")
        #expect(decoded.list.items[2].dependsOn.first?.taskId == list.items[1].id)
    }
    @Test func confiniFasciaSonoInclusiviAllInizioEdEsclusiviAllaFine() throws {
        let slot = TodoFixtures.first
        let start = try #require(slot.start), end = try #require(slot.end)
        #expect(TodoTime.phase(slot, now: start.addingTimeInterval(-1)) == .future)
        #expect(TodoTime.phase(slot, now: start) == .current)
        #expect(TodoTime.phase(slot, now: end.addingTimeInterval(-1)) == .current)
        #expect(TodoTime.phase(slot, now: end) == .past)
        var invalid = slot; invalid.endAt = invalid.startAt
        #expect(TodoTime.phase(invalid, now: start) == .invalid)
    }
    @Test func statoDiCompletamentoNonDipendeDalTempoENonBloccaIlRitiro() throws {
        var list = TodoFixtures.list
        let future = try #require(TodoTime.date("2026-10-19T08:00:00Z"))
        let past = try #require(TodoTime.date("2026-10-19T22:00:00Z"))
        #expect(TodoTime.status(list.items[1], slot: TodoFixtures.first, now: past) == "Orario passato · da aggiornare")
        #expect(list.items[1].status == .pending)
        list.items[1].status = .done
        #expect(TodoTime.status(list.items[1], slot: TodoFixtures.first, now: future) == "Completata")
        list.items[1].status = .pending
        list.items[2].dependsOn = [.init(taskId: list.items[1].id)]
        #expect(TodoTimelineEntry.entries(list).contains { $0.item.id == list.items[2].id && $0.slot.reminderMinutes == 20 })
    }
    @Test func fusoEGiornoStoricoNonDiventanoOggi() throws {
        let date = try #require(TodoTime.date("2026-10-18T23:30:00Z"))
        #expect(TodoTime.day(date, timezone: "Europe/Rome") == "2026-10-19")
        #expect(TodoTime.clock(date, timezone: "Europe/Rome") == "01:30")
        var list = TodoFixtures.list; list.day = "2026-01-12"
        let start = try #require(TodoTime.dayStart(list))
        #expect(TodoTime.day(start, timezone: list.timezone) == "2026-01-12")
        #expect(TodoTime.clock(start, timezone: list.timezone) == "00:00")
    }
    @Test func giornataPassataNelSuoFusoEArchiviataEGiornoBreve() throws {
        let list = TodoFixtures.list  // 19 ottobre 2026, Europe/Rome
        // 23:59 del 19 a Roma: ancora in corso; 00:00 del 20 a Roma (22:00Z): archiviata.
        #expect(!TodoTime.isArchived(list, now: try #require(TodoTime.date("2026-10-19T21:59:00Z"))))
        #expect(TodoTime.isArchived(list, now: try #require(TodoTime.date("2026-10-19T22:00:00Z"))))
        var undated = list; undated.day = nil
        #expect(!TodoTime.isArchived(undated, now: try #require(TodoTime.date("2027-01-01T00:00:00Z"))))
        let morning = try #require(TodoTime.date("2026-10-19T06:00:00Z"))
        #expect(TodoTime.shortDay(list, now: morning) == "oggi")
        #expect(TodoTime.shortDay(list, now: try #require(TodoTime.date("2026-10-18T06:00:00Z"))) == "domani")
        #expect(TodoTime.shortDay(list, now: try #require(TodoTime.date("2026-10-15T06:00:00Z"))) == "lun")
        #expect(TodoTime.shortDay(list, now: try #require(TodoTime.date("2026-10-01T06:00:00Z"))) == "19 ott")
        #expect(TodoTime.shortDay(undated, now: morning) == nil)
    }
    @Test func conversioneEsplicitaETaskEditingNonPerdonoIdentitaOAltreFasce() {
        let list = TodoFixtures.list
        let simple = list.clearingSchedule()
        #expect(simple.mode == .simple && simple.day == nil)
        #expect(simple.items.map(\.id) == list.items.map(\.id))
        #expect(simple.items.allSatisfy { $0.slots.isEmpty })
        var edited = list.items[3]
        edited.slots[0].reminderMinutes = 45
        edited.position = 1
        let result = TodoEditing.replacing(edited, in: list)
        let saved = result.items.first { $0.id == edited.id }
        #expect(saved?.slots[1] == list.items[3].slots[1])
        #expect(Set(result.items.map(\.id)) == Set(list.items.map(\.id)))
        #expect(result.items.map(\.position) == Array(0..<list.items.count))
        #expect(!TodoEditing.canParent(list.items[1], item: list.items[0], list: list))
    }
}

@MainActor struct TodoCardTests {
    private func withConversation(_ body: (ConversationStore, TranscriptStore) throws -> Void) throws {
        let name = "ernie-todo-card-test-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: name))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        defer { defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: directory) }
        let transcript = TranscriptStore(directory: directory, defaults: defaults)
        let store = ConversationStore(credentials: .init(serverURL: URL(string: "https://example.test")!, apiKey: "test"),
                                      speaker: Speaker(), inbox: InboxStore(), settings: LocalSettings(), transcript: transcript)
        defer { store.disconnect() }
        try body(store, transcript)
    }
    private func messages(_ store: ConversationStore) -> [ChatMessage] {
        store.items.compactMap { if case .message(let m) = $0 { return m }; return nil }
    }
    private func send(_ payload: EventPayload, to store: ConversationStore, turn: String = "turn", seq: Int) throws {
        let event = AgentEvent(payload: payload, sessionId: store.sessionId, correlationId: turn, seq: seq)
        store.apply(try AgentEvent.decode(event.encoded()))
    }
    private func start(_ store: ConversationStore, turn: String = "turn", seq: Int = 0) throws {
        try send(.assistantStarted(.init(route: "agent", modelClass: "standard")), to: store, turn: turn, seq: seq)
    }
    private func block(_ list: TodoList) -> EventPayload { .assistantBlock(.init(blockId: Ids.new(), block: .todoList(.init(list: list)))) }

    @Test func letturaSalvataggioESincronizzazioneMostranoUnaScheda() throws {
        try withConversation { store, transcript in
            var received: [ContentBlock] = []
            store.onBlock = { received.append($0) }
            let before = TodoFixtures.list
            var after = before; after.revision += 1; after.items.append(.init(title: "Stendere", position: 6))
            try start(store)
            try send(block(before), to: store, seq: 1)
            try send(block(after), to: store, seq: 2)
            // La sincronizzazione dei promemoria usa un correlationId proprio, senza assistant.started.
            try send(block(after), to: store, turn: "sync", seq: 3)
            #expect(messages(store).count == 1)
            #expect(messages(store).first?.blocks == [.todoList(.init(list: after))])
            #expect(received.count == 3)
            let saved = try #require(transcript.load(store.sessionId))
            #expect(saved.items.count == 1)
        }
    }

    @Test func aggiornamentiPrimaEDopoIlRisultatoNonRegredisconoLaRevisione() throws {
        try withConversation { store, _ in
            let before = TodoFixtures.list
            var latest = before; latest.revision += 1; latest.items = []
            try start(store)
            try send(block(before), to: store, seq: 1)
            try send(block(latest), to: store, turn: "sync-first", seq: 2)
            try send(block(before), to: store, seq: 3)
            try send(block(latest), to: store, seq: 4)
            try send(block(before), to: store, turn: "late-sync", seq: 5)
            #expect(messages(store).count == 1)
            #expect(messages(store).first?.blocks == [.todoList(.init(list: latest))])
        }
    }

    @Test func sincronizzazioneSenzaRichiestaAggiornaLoStoreSenzaAprireUnFumetto() throws {
        try withConversation { store, _ in
            var received: [ContentBlock] = []
            store.onBlock = { received.append($0) }
            let list = TodoFixtures.list
            try send(block(list), to: store, turn: "background", seq: 1)
            #expect(messages(store).isEmpty)
            #expect(received == [.todoList(.init(list: list))])
        }
    }

    @Test func listeDistinteETurniRichiestiRestanoSeparati() throws {
        try withConversation { store, _ in
            let first = TodoFixtures.list
            var other = first; other.id = "00000000-0000-4000-8000-000000000098"
            try start(store)
            try send(block(first), to: store, seq: 1)
            try send(block(other), to: store, seq: 2)
            try start(store, turn: "second", seq: 3)
            try send(block(first), to: store, turn: "second", seq: 4)
            #expect(messages(store).map(\.blocks) == [[.todoList(.init(list: first)), .todoList(.init(list: other))], [.todoList(.init(list: first))]])
        }
    }

    @Test func cronologiaEliminaSoloLeCopieDiSincronizzazione() throws {
        try withConversation { _, transcript in
            let before = TodoFixtures.list
            var after = before; after.revision += 1; after.items.append(.init(title: "Stendere", position: 6))
            let original = ChatMessage(id: "answer", correlationId: "turn", role: .assistant, text: "Ho aggiunto Stendere.<br>",
                                       blocks: [.todoList(.init(list: before)), .todoList(.init(list: after))], route: "agent", createdAt: .now)
            let sync = ChatMessage(id: "sync", correlationId: "sync", role: .assistant, text: "", blocks: [.todoList(.init(list: after))], createdAt: .now)
            let explicit = ChatMessage(id: "requested", correlationId: "second", role: .assistant, text: "", blocks: [.todoList(.init(list: after))], route: "agent", createdAt: .now)
            transcript.save(.init(sessionId: "past", lastSeq: 88, items: [.message(original), .message(sync), .message(explicit)], updatedAt: .now))
            let loaded = try #require(transcript.load("past"))
            #expect(loaded.items.count == 2)
            guard case .message(let fixed) = loaded.items.first else { Issue.record("Manca la risposta"); return }
            #expect(fixed.id == original.id && fixed.text == original.text)
            #expect(fixed.blocks == [.todoList(.init(list: after))])
            #expect(loaded.lastSeq == 88)
            transcript.save(loaded)
            #expect(transcript.load("past")?.items == loaded.items)
        }
    }

    @Test func cronologiaConservaRisposteRichiesteAncheSenzaMetadati() {
        let question = ChatMessage(id: "question", correlationId: "turn", role: .user, text: "Mostra la lista", createdAt: .now)
        let answer = ChatMessage(id: "answer", correlationId: "turn", role: .assistant, text: "", blocks: [.todoList(.init(list: TodoFixtures.list))], createdAt: .now)
        let items: [ChatItem] = [.message(question), .message(answer)]
        #expect(items.normalizingListSnapshots() == items)
    }

    @Test func cronologiaAggiornaLaSchedaMaNonEliminaTestiEAltriBlocchi() {
        let old = TodoFixtures.list
        var latest = old; latest.revision += 1; latest.items = []
        let untouched = ContentBlock.unknown(kind: "other")
        let answer = ChatMessage(id: "answer", correlationId: "turn", role: .assistant, text: "La tua lista.", blocks: [.todoList(.init(list: old)), untouched], createdAt: .now)
        let update = ChatMessage(id: "update", correlationId: "sync", role: .assistant, text: "", blocks: [.todoList(.init(list: latest))], createdAt: .now)
        let late = ChatMessage(id: "late", correlationId: "late", role: .assistant, text: "", blocks: [.todoList(.init(list: old))], createdAt: .now)
        let items: [ChatItem] = [.message(answer), .message(update), .message(late)]
        let normalized = items.normalizingListSnapshots()
        #expect(normalized.count == 1)
        guard case .message(let result) = normalized.first else { Issue.record("Manca la risposta"); return }
        #expect(result.text == answer.text && result.id == answer.id)
        #expect(result.blocks == [.todoList(.init(list: latest)), untouched])
    }
}

@MainActor private final class TodoRequests {
    var fetches: [CheckedContinuation<[TodoList], any Error>] = []
    var writes: [TodoList] = []
    var pendingWrites: [CheckedContinuation<TodoList, any Error>] = []
    var current = TodoFixtures.list
    func all() async throws -> [TodoList] { try await withCheckedThrowingContinuation { fetches.append($0) } }
    func update(_ draft: TodoList) async throws -> TodoList {
        writes.append(draft)
        return try await withCheckedThrowingContinuation { pendingWrites.append($0) }
    }
    var transport: TodoStore.Transport {
        .init(lists: all, list: { _ in self.current }, create: update, update: update)
    }
}

@MainActor struct TodoStoreTests {
    private func waitFor(_ condition: () -> Bool) async {
        for _ in 0..<1000 { if condition() { return }; await Task.yield() }
        #expect(condition())
    }
    @Test func logoutScartaRisposteTardiveEDatiPrivati() async {
        let store = TodoStore(), requests = TodoRequests()
        store.configure(transport: requests.transport)
        let pending = Task { await store.load() }
        await waitFor { requests.fetches.count == 1 }
        store.configure(api: nil)
        requests.fetches[0].resume(returning: [TodoFixtures.list])
        await pending.value
        #expect(store.lists.isEmpty && store.unsavedDrafts.isEmpty && !store.loading)
    }
    @Test func unaLetturaVecchiaNonSovrascriveUnBloccoChatPiuRecente() async {
        let store = TodoStore(), requests = TodoRequests()
        store.configure(transport: requests.transport)
        let pending = Task { await store.load() }
        await waitFor { requests.fetches.count == 1 }
        var newer = TodoFixtures.list; newer.revision = 3; newer.name = "Aggiornata dalla chat"
        store.apply(newer)
        requests.fetches[0].resume(returning: [TodoFixtures.list])
        await pending.value
        #expect(store.lists[newer.id]?.name == newer.name)
    }
    @Test func scrittureSerialiUsanoRevisioneConfermataESincronizzanoReminder() async {
        let store = TodoStore(), requests = TodoRequests()
        store.configure(transport: requests.transport); store.apply(TodoFixtures.list)
        var syncs = 0; store.onChanged = { syncs += 1 }
        let id = TodoFixtures.list.id
        let first = Task { await store.mutate(id) { $0.items[1].status = .done } }
        await waitFor { requests.writes.count == 1 }
        let second = Task { await store.mutate(id) { $0.items[2].status = .done } }
        for _ in 0..<10 { await Task.yield() }
        #expect(requests.writes.count == 1)
        var confirmed = requests.writes[0]; confirmed.revision = 3
        requests.pendingWrites[0].resume(returning: confirmed)
        await first.value
        await waitFor { requests.writes.count == 2 }
        #expect(requests.writes[1].revision == 3)
        #expect(requests.writes[1].items[1].status == .done)
        confirmed = requests.writes[1]; confirmed.revision = 4
        requests.pendingWrites[1].resume(returning: confirmed)
        await second.value
        #expect(syncs == 2)
        #expect(store.lists[id]?.items[2].status == .done)
    }
    @Test func conflittoConservaBozzaERicaricaSenzaSovrascrivere() async {
        let store = TodoStore(), requests = TodoRequests()
        store.configure(transport: requests.transport); store.apply(TodoFixtures.list)
        var remote = TodoFixtures.list; remote.revision = 4; remote.items[1].title = "Titolo remoto"
        requests.current = remote
        var draft = TodoFixtures.list; draft.items[1].title = "Mia modifica"
        let pending = Task { await store.save(draft) }
        await waitFor { requests.writes.count == 1 }
        requests.pendingWrites[0].resume(throwing: ApiError(status: 409, code: "revision_conflict", message: ""))
        #expect(await pending.value == false)
        #expect(store.unsavedDrafts[draft.id]?.items[1].title == "Mia modifica")
        #expect(store.lists[draft.id]?.items[1].title == "Titolo remoto")
        #expect(store.lastError?.contains("conservate") == true)
    }
    @Test func logoutDuranteScritturaNonRipristinaListaONotifiche() async {
        let store = TodoStore(), requests = TodoRequests()
        store.configure(transport: requests.transport); store.apply(TodoFixtures.list)
        var syncs = 0; store.onChanged = { syncs += 1 }
        let pending = Task { await store.save(TodoFixtures.list) }
        await waitFor { requests.writes.count == 1 }
        store.configure(api: nil)
        requests.pendingWrites[0].resume(returning: TodoFixtures.list)
        #expect(await pending.value == false)
        #expect(store.lists.isEmpty && syncs == 0)
    }
    @Test func timelineInterpolaTempoRealeETutteLeFasce() throws {
        let start = try #require(TodoFixtures.first.start)
        let end = start.addingTimeInterval(3600)
        let points = [(start, CGPoint(x: 40, y: 20)), (end, CGPoint(x: 40, y: 120))]
        #expect(TodoTimeline.markerY(now: start.addingTimeInterval(1800), points: points) == 70)
        #expect(TodoTimeline.markerY(now: start.addingTimeInterval(-1), points: points) == 20)
        #expect(TodoTimeline.markerY(now: end.addingTimeInterval(1), points: points) == 120)
        #expect(TodoTimelineEntry.entries(TodoFixtures.list).count == 4)
    }
    @Test func renderTimelineEGruppi320E390ChiaroScuroETestoGrande() throws {
        let now = try #require(TodoTime.date("2026-10-19T15:05:00+02:00"))
        for width in [CGFloat(320), CGFloat(390)] {
            for dark in [false, true] {
                for large in [false, true] {
                    let content = VStack(alignment: .leading, spacing: 20) {
                        Text(TodoFixtures.list.name).font(.title)
                        TodoTimeline(list: TodoFixtures.list, now: now, toggle: { _ in }, edit: { _ in })
                        TodoHierarchy(list: TodoFixtures.list, now: now, edit: { _ in }, toggle: { _ in })
                    }.padding(16).frame(width: width).background(Theme.ground)
                        .environment(\.colorScheme, dark ? .dark : .light)
                        .environment(\.dynamicTypeSize, large ? .accessibility2 : .large)
                    let renderer = ImageRenderer(content: content)
                    renderer.scale = 1
                    let image = try #require(renderer.uiImage)
                    #expect(image.size.width == width)
                    #expect(image.size.height > 300)
                    let data = try #require(image.pngData())
                    let path = FileManager.default.temporaryDirectory.appendingPathComponent("ernie-todo-\(Int(width))-\(dark ? "dark" : "light")-\(large ? "large" : "normal").png")
                    try data.write(to: path)
                    print("TODO_SNAPSHOT: \(path.path)")
                }
            }
        }
    }
}

@MainActor struct TodoChatTimelineTests {
    private let now = TodoTime.date("2026-10-19T15:05:00+02:00")!
    private func render(_ list: TodoList, width: CGFloat = 390, dark: Bool = false,
                        large: Bool = false, costume: BearCostume = .base) throws -> UIImage {
        let content = TodoCardContent(list: list, now: now, open: {})
            .frame(width: width).chatAppearance(costume: costume)
            .environment(\.colorScheme, dark ? .dark : .light)
            .environment(\.dynamicTypeSize, large ? .accessibility2 : .large)
        let renderer = ImageRenderer(content: content)
        renderer.scale = 1
        return try #require(renderer.uiImage)
    }

    @Test func schedaOrariaMostraGliOrariAncheSenzaAvvisi() throws {
        var list = TodoFixtures.list
        for index in list.items.indices {
            for slot in list.items[index].slots.indices { list.items[index].slots[slot].reminderMinutes = nil }
        }
        let original = try render(list).pngData()
        var shifted = list
        shifted.items[1].slots[0].startAt = "2026-10-19T16:00:00+02:00"
        shifted.items[1].slots[0].endAt = "2026-10-19T16:15:00+02:00"
        #expect(try render(shifted).pngData() != original, "La scheda deve rendere visibili gli orari, non solo i titoli")
        #expect(try render(list.clearingSchedule()).pngData() != original, "Lista semplice e timeline non devono essere identiche")
    }

    @Test func schedaMostraAncheLeFasceOltreLaQuarta() throws {
        var list = TodoFixtures.list
        let original = try render(list).pngData()
        list.items.append(TodoItem(title: "Ultimo ritiro", position: 6, slots: [
            TodoSlot(startAt: "2026-10-19T20:30:00+02:00", endAt: "2026-10-19T20:45:00+02:00", reminderMinutes: nil)
        ]))
        // Equalize the counter: changing a late slot must still change the card.
        let withLate = try render(list).pngData()
        list.items[list.items.count - 1].slots[0].startAt = "2026-10-19T21:30:00+02:00"
        list.items[list.items.count - 1].slots[0].endAt = "2026-10-19T21:45:00+02:00"
        #expect(try render(list).pngData() != withLate)
        #expect(withLate != original)
    }

    @Test func renderSchedaTimelineChiaroScuroBorgETestoGrande() throws {
        for width in [CGFloat(320), CGFloat(390)] {
            for dark in [false, true] {
                for large in [false, true] {
                    for costume in [BearCostume.base, .borg] {
                        let image = try render(TodoFixtures.list, width: width, dark: dark, large: large, costume: costume)
                        #expect(image.size.width == width)
                        let file = FileManager.default.temporaryDirectory.appendingPathComponent("todo-chat-\(Int(width))-\(dark)-\(large)-\(costume.rawValue).png")
                        try #require(image.pngData()).write(to: file)
                        print("TODO_CHAT_SNAPSHOT: \(file.path)")
                    }
                }
            }
        }
    }
}
