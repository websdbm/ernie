import Foundation
import Observation

/// Stato delle liste della spesa mostrate nelle schede: una copia per lista, aggiornata dai blocchi in arrivo
/// e dalle azioni dell'utente (spunta, aggiungi, togli, archivia) via REST. Tutte le schede della stessa lista
/// leggono qui, così restano allineate.
@MainActor
@Observable
final class ShoppingStore {
    private(set) var lists: [String: ShoppingListBlock] = [:]
    private(set) var busy: Set<String> = []
    private(set) var lastError: String?
    private var api: ApiClient?

    func configure(api: ApiClient?) { self.api = api }

    func apply(_ block: ContentBlock) {
        if case .shoppingList(let list) = block { lists[list.listId] = list }
    }

    func current(_ fallback: ShoppingListBlock) -> ShoppingListBlock {
        lists[fallback.listId] ?? fallback
    }

    /// Rilegge la lista dal server (all'apertura di una scheda vecchia).
    func refresh(_ listId: String) async {
        guard let api else { return }
        if let block = try? await api.shoppingList(id: listId) { apply(block) }
    }

    func toggle(listId: String, item: ShoppingListItem) async {
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
        guard let api else { return }
        try? await api.shoppingDelete(listId: listId)
        lists[listId] = nil
    }

    private func perform(_ listId: String, _ action: (ApiClient) async throws -> ContentBlock) async {
        guard let api else { return }
        busy.insert(listId)
        defer { busy.remove(listId) }
        do {
            apply(try await action(api))
            lastError = nil
        } catch {
            lastError = AppModel.describe(error)
            await refresh(listId)
        }
    }
}
