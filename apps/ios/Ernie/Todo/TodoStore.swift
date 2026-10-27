import Foundation
import Observation

@MainActor @Observable
final class TodoStore {
    struct Transport {
        var lists: () async throws -> [TodoList]
        var list: (String) async throws -> TodoList
        var create: (TodoList) async throws -> TodoList
        var update: (TodoList) async throws -> TodoList
    }
    private(set) var lists: [String: TodoList] = [:]
    private(set) var unsavedDrafts: [String: TodoList] = [:]
    private(set) var busy: Set<String> = []
    private(set) var loading = false
    private(set) var loaded = false
    private(set) var lastError: String?
    var onChanged: (() async -> Void)?
    var onFeedback: ((ErnieSound) -> Void)?
    private var transport: Transport?
    private var generation = UUID()
    private var loadGeneration = UUID()
    private var writeTail: Task<Void, Never>?

    var orderedLists: [TodoList] {
        lists.values.sorted { $0.updatedAt == $1.updatedAt ? $0.id < $1.id : $0.updatedAt > $1.updatedAt }
    }
    func configure(api: ApiClient?) {
        configure(transport: api.map { api in
            Transport(lists: { try await api.todoLists() }, list: { try await api.todoList(id: $0) },
                      create: { try await api.todoCreate($0) }, update: { try await api.todoUpdate($0) })
        })
    }
    func configure(transport: Transport?) {
        generation = UUID(); loadGeneration = UUID()
        writeTail?.cancel(); writeTail = nil
        self.transport = transport
        lists = [:]; unsavedDrafts = [:]; busy = []; loading = false; loaded = false; lastError = nil
    }
    func apply(_ list: TodoList) {
        if let current = lists[list.id], current.revision > list.revision { return }
        lists[list.id] = list
    }
    func current(_ fallback: TodoList) -> TodoList { lists[fallback.id] ?? fallback }
    func clearError() { lastError = nil }
    func load() async {
        guard let transport else { return }
        let token = generation, request = UUID()
        loadGeneration = request; loading = true
        do {
            let result = try await transport.lists()
            guard generation == token, loadGeneration == request else { return }
            guard !Task.isCancelled else { loading = false; return }
            for list in result { apply(list) }
            loaded = true; loading = false
        } catch {
            guard generation == token, loadGeneration == request else { return }
            loading = false
            if !(error is CancellationError) { lastError = Self.describe(error) }
        }
    }
    func refresh(_ id: String) async {
        guard let transport else { return }
        let token = generation
        do {
            let list = try await transport.list(id)
            guard generation == token, !Task.isCancelled else { return }
            apply(list)
        } catch {
            guard generation == token, !Task.isCancelled else { return }
            lastError = Self.describe(error)
        }
    }
    /// Writes are serialized. Mutations derive their revision from the latest confirmed copy.
    func mutate(_ id: String, _ edit: @escaping @MainActor (inout TodoList) -> Void) async {
        _ = await enqueue(id: id, create: false) { [weak self] in
            guard var list = self?.lists[id] else { return nil }
            edit(&list)
            return list
        }
    }
    @discardableResult
    func save(_ draft: TodoList, create: Bool = false) async -> Bool {
        await enqueue(id: draft.id, create: create) { draft }
    }
    private func enqueue(id: String, create: Bool, draft: @escaping @MainActor () -> TodoList?) async -> Bool {
        guard let transport else { return false }
        let token = generation
        let previous = writeTail
        let task = Task { @MainActor [weak self] () -> Bool in
            await previous?.value
            guard let self, self.generation == token, !Task.isCancelled, let value = draft() else { return false }
            let before = self.lists[id]
            self.busy.insert(id)
            defer { if self.generation == token { self.busy.remove(id) } }
            do {
                let result = try await (create ? transport.create(value) : transport.update(value))
                guard self.generation == token, !Task.isCancelled else { return false }
                self.apply(result); self.unsavedDrafts[id] = nil; self.lastError = nil
                let completed = result.items.contains { item in
                    item.status == .done && before?.items.first(where: { $0.id == item.id })?.status != .done
                }
                self.onFeedback?(completed ? .check : .approve)
                await self.onChanged?()
                return self.generation == token
            } catch {
                guard self.generation == token, !Task.isCancelled else { return false }
                self.onFeedback?(.error)
                self.unsavedDrafts[id] = value
                if let api = error as? ApiError, api.status == 409 {
                    self.lastError = api.code == "revision_conflict"
                        ? "La lista è cambiata altrove. Le tue modifiche sono conservate: confrontale con la versione aggiornata prima di riprovare."
                        : api.message
                    if let latest = try? await transport.list(id), self.generation == token { self.apply(latest) }
                } else { self.lastError = Self.describe(error) }
                return false
            }
        }
        writeTail = Task { _ = await task.value }
        return await task.value
    }
    private static func describe(_ error: Error) -> String {
        if let api = error as? ApiError {
            if api.status == 403 { return "La skill Todo non è abilitata per questo account." }
            if api.status == 404 { return "Questa lista non è più disponibile." }
            if [400, 409, 422].contains(api.status) { return api.message }
        }
        return "Non riesco a salvare o caricare Todo. Le modifiche non inviate restano disponibili qui: riprova quando la connessione torna disponibile."
    }
}
