import Foundation
import Observation

/// Stato delle liste della spesa mostrate nelle schede: una copia per lista, aggiornata dai blocchi in arrivo
/// e dalle azioni dell'utente (spunta, aggiungi, togli, archivia) via REST. Tutte le schede della stessa lista
/// leggono qui, così restano allineate.
@MainActor
@Observable
final class ShoppingStore {
    private(set) var lists: [String: ShoppingListBlock] = [:]
    /// Indice completo dell'account, anche delle liste mai aperte in questa conversazione.
    private(set) var summaries: [ShoppingListSummary] = []
    private(set) var catalogError: String?
    /// Liste eliminate (dal menu della scheda o scomparse dal server): le schede in chat lo mostrano.
    private(set) var deleted: Set<String> = []
    private(set) var busy: Set<String> = []
    private(set) var lastError: String?
    private var api: ApiClient?
    private var generation = UUID()
    private var catalogRequest = UUID()
    private var revisions: [String: Int] = [:]

    func configure(api: ApiClient?) {
        generation = UUID()
        catalogRequest = UUID()
        self.api = api
        lists = [:]; summaries = []; deleted = []; busy = []; revisions = [:]; lastError = nil; catalogError = nil
    }

    func apply(_ block: ContentBlock) {
        if case .shoppingList(let list) = block {
            revisions[list.listId, default: 0] += 1
            lists[list.listId] = list
            deleted.remove(list.listId)
            let summary = ShoppingListSummary(id: list.listId, name: list.name,
                open: list.items.filter { !$0.checked }.count, bought: list.items.filter(\.checked).count,
                archived: list.status == "archived")
            if let index = summaries.firstIndex(where: { $0.id == list.listId }) { summaries[index] = summary }
            else { summaries.insert(summary, at: 0) }
        }
    }

    /// Il catalogo non deve sovrascrivere modifiche arrivate in chat o durante una richiesta REST.
    func load() async {
        guard let api else { return }
        let token = generation, request = UUID(), before = revisions
        catalogRequest = request
        do {
            let result = try await api.shoppingLists()
            guard generation == token, catalogRequest == request, !Task.isCancelled else { return }
            let current = Dictionary(uniqueKeysWithValues: summaries.map { ($0.id, $0) })
            let remoteIds = Set(result.map(\.id))
            var merged: [ShoppingListSummary] = []
            for summary in result {
                guard !deleted.contains(summary.id) else { continue }
                if revisions[summary.id, default: 0] != before[summary.id, default: 0] || busy.contains(summary.id) {
                    if let latest = current[summary.id] { merged.append(latest) }
                } else { merged.append(summary) }
            }
            for summary in summaries where !remoteIds.contains(summary.id) {
                if revisions[summary.id, default: 0] != before[summary.id, default: 0] || busy.contains(summary.id) {
                    merged.append(summary)
                } else {
                    deleted.insert(summary.id)
                    lists[summary.id] = nil
                    revisions[summary.id, default: 0] += 1
                }
            }
            summaries = merged
            catalogError = nil
        } catch {
            // In assenza di rete restano disponibili i collegamenti già conosciuti.
            guard generation == token, catalogRequest == request, !Task.isCancelled else { return }
            catalogError = "Non riesco ad aggiornare le liste della spesa."
        }
    }

    func isDeleted(_ listId: String) -> Bool { deleted.contains(listId) }

    func current(_ fallback: ShoppingListBlock) -> ShoppingListBlock {
        lists[fallback.listId] ?? fallback
    }

    /// Rilegge la lista dal server (all'apertura di una scheda vecchia).
    func refresh(_ listId: String) async {
        guard let api, !deleted.contains(listId), !busy.contains(listId) else { return }
        let token = generation
        let revision = revisions[listId, default: 0]
        do {
            let block = try await api.shoppingList(id: listId)
            guard generation == token, revisions[listId, default: 0] == revision, !busy.contains(listId), !Task.isCancelled else { return }
            apply(block)
            lastError = nil
        } catch let error as ApiError where error.status == 404 {
            guard generation == token, revisions[listId, default: 0] == revision, !busy.contains(listId), !Task.isCancelled else { return }
            // Eliminata altrove (o da un'altra scheda): la scheda in chat lo dice invece di restare viva.
            deleted.insert(listId)
            lists[listId] = nil
            summaries.removeAll { $0.id == listId }
            revisions[listId, default: 0] += 1
            lastError = nil
        } catch {
            guard generation == token, revisions[listId, default: 0] == revision, !busy.contains(listId), !Task.isCancelled else { return }
            lastError = AppModel.describe(error)
        }
    }

    func toggle(listId: String, item: ShoppingListItem) async {
        guard api != nil, !busy.contains(listId) else { return }
        // Aggiornamento ottimistico: la spunta risponde subito, il server conferma.
        if var list = lists[listId], let i = list.items.firstIndex(where: { $0.id == item.id }) {
            list.items[i].checked.toggle()
            lists[listId] = list
        }
        await perform(listId) { api in try await api.shoppingSetChecked(listId: listId, itemId: item.id, checked: !item.checked) }
    }

    func add(listId: String, name: String, quantity: String? = nil) async {
        let clean = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        await perform(listId) { api in try await api.shoppingAddItem(listId: listId, name: clean, quantity: quantity) }
    }

    func remove(listId: String, item: ShoppingListItem) async {
        await perform(listId) { api in try await api.shoppingRemoveItem(listId: listId, itemId: item.id) }
    }

    func clearBought(listId: String) async {
        await perform(listId) { api in try await api.shoppingClearBought(listId: listId) }
    }

    func setArchived(listId: String, _ archived: Bool) async {
        await perform(listId) { api in try await api.shoppingSetStatus(listId: listId, archived: archived) }
    }

    func delete(listId: String) async {
        guard let api, !busy.contains(listId) else { return }
        let token = generation
        revisions[listId, default: 0] += 1
        busy.insert(listId)
        defer { if generation == token { busy.remove(listId) } }
        do {
            try await api.shoppingDelete(listId: listId)
            guard generation == token, !Task.isCancelled else { return }
            deleted.insert(listId)
            lists[listId] = nil
            summaries.removeAll { $0.id == listId }
            lastError = nil
        } catch {
            guard generation == token, !Task.isCancelled else { return }
            lastError = AppModel.describe(error)
        }
    }

    private func perform(_ listId: String, _ action: (ApiClient) async throws -> ContentBlock) async {
        guard let api, !busy.contains(listId) else { return }
        let token = generation
        revisions[listId, default: 0] += 1
        busy.insert(listId)
        defer { if generation == token { busy.remove(listId) } }
        do {
            let block = try await action(api)
            guard generation == token, !Task.isCancelled else { return }
            apply(block)
            lastError = nil
        } catch {
            guard generation == token, !Task.isCancelled else { return }
            lastError = AppModel.describe(error)
            busy.remove(listId)
            await refresh(listId)
        }
    }
}
