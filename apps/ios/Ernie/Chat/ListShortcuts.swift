import SwiftUI

/// Collegamenti agli stessi record usati dalle schede in chat, senza passare dal modello. Spesa e attività in due
/// gruppi distinti, una riga per lista (27 ott 2026: le righe su tre righe occupavano mezzo pannello); liste della
/// spesa archiviate e giornate passate restano fuori, raggiungibili dalle rispettive pagine.
struct ListShortcutsSection: View {
    let shopping: [ShoppingListSummary]
    let todo: [TodoList]
    let onSelect: (PanelDestination) -> Void
    var now: Date = Date()
    @State private var expandedShopping = false
    @State private var expandedTodo = false

    private static let visible = 3

    private var purchases: [Shortcut] {
        shopping.filter { !$0.archived }.map { list in
            Shortcut(id: "shopping:\(list.id)", title: list.name,
                detail: list.open == 0 ? nil : "\(list.open)",
                accessibility: list.open == 0 ? "niente da prendere" : "\(list.open) da prendere",
                icon: "cart", tint: .shopping, destination: .shoppingList(list.id))
        }
    }

    private var activities: [Shortcut] {
        todo.filter { !TodoTime.isArchived($0, now: now) }.map { list in
            let remaining = list.tasks.filter { $0.status == .pending }.count
            let day = TodoTime.shortDay(list, now: now)
            return Shortcut(id: "todo:\(list.id)", title: list.name,
                detail: [remaining == 0 ? nil : "\(remaining)", day].compactMap { $0 }.joined(separator: " · ").nilIfEmpty,
                accessibility: [remaining == 0 ? "niente da fare" : "\(remaining) da fare", day].compactMap { $0 }.joined(separator: ", "),
                icon: list.mode == .scheduled ? "calendar" : "checklist", tint: .brain, destination: .todoList(list.id))
        }
    }

    var body: some View {
        let shoppingItems = purchases
        let todoItems = activities
        if !shoppingItems.isEmpty || !todoItems.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                if !shoppingItems.isEmpty {
                    group("SPESA", items: shoppingItems, expanded: $expandedShopping)
                }
                if !todoItems.isEmpty {
                    group("ATTIVITÀ", items: todoItems, expanded: $expandedTodo)
                        .padding(.top, shoppingItems.isEmpty ? 0 : 8)
                }
                Rectangle().fill(Theme.hairline).frame(height: 1).padding(.top, 8)
            }
        }
    }

    private func group(_ title: String, items: [Shortcut], expanded: Binding<Bool>) -> some View {
        VStack(alignment: .leading, spacing: 2) {
        Text(title)
            .font(.caption.weight(.semibold)).foregroundStyle(Theme.inkSecondary)
            .padding(.horizontal, 12).padding(.bottom, 2)
            .accessibilityAddTraits(.isHeader)
        ForEach(expanded.wrappedValue ? items : Array(items.prefix(Self.visible))) { item in
            Button { onSelect(item.destination) } label: {
                HStack(spacing: 12) {
                    Image(systemName: item.icon).font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(item.tint.color).frame(width: 26)
                        .accessibilityHidden(true)
                    Text(item.title).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                        .lineLimit(1).truncationMode(.tail)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let detail = item.detail {
                        Text(detail).font(.caption.monospacedDigit()).foregroundStyle(Theme.inkSecondary)
                            .lineLimit(1).layoutPriority(1)
                    }
                }.padding(.horizontal, 12).frame(minHeight: 40).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("list-shortcut-\(item.id)")
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(item.title), \(item.accessibility)")
            .accessibilityAddTraits(.isButton)
            .accessibilityHint("Apri la lista")
        }
        if items.count > Self.visible {
            Button(expanded.wrappedValue ? "Mostra meno" : "Mostra tutte (\(items.count))") { expanded.wrappedValue.toggle() }
                .font(.footnote.weight(.semibold)).foregroundStyle(Theme.accentText)
                .padding(.horizontal, 12).frame(minHeight: 36)
        }
        }
    }

    private struct Shortcut: Identifiable {
        let id: String
        let title: String
        let detail: String?
        let accessibility: String
        let icon: String
        let tint: SkillTint
        let destination: PanelDestination
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

struct ShoppingListDetailView: View {
    let listId: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var loading = true

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    if model.shopping.isDeleted(listId) {
                        ContentUnavailableView("Lista eliminata", systemImage: "trash", description: Text("Questa lista non è più disponibile."))
                    } else if let list = model.shopping.lists[listId] {
                        ShoppingListCard(block: list, conversation: model.conversation, refreshOnAppear: false)
                    } else if loading {
                        ProgressView("Carico la lista…").padding()
                    } else {
                        ContentUnavailableView("Lista non disponibile", systemImage: "wifi.exclamationmark",
                            description: Text("Non riesco a recuperare la lista. Riprova quando la connessione torna disponibile."))
                        Button("Riprova") { Task { await refresh() } }.buttonStyle(.bordered)
                    }
                    if let error = model.shopping.lastError, !model.shopping.isDeleted(listId) {
                        Text(error).font(.footnote).foregroundStyle(Theme.inkSecondary)
                    }
                }.padding(16).frame(maxWidth: 700).frame(maxWidth: .infinity)
            }
            .background(Theme.ground).navigationTitle("Lista della spesa")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Fine") { dismiss() } } }
            .task(id: listId) { await refresh() }
            .refreshable { await refresh() }
        }
    }

    private func refresh() async {
        loading = true
        await model.shopping.refresh(listId)
        loading = false
    }
}
