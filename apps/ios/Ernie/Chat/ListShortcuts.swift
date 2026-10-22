import SwiftUI

/// Collegamenti agli stessi record usati dalle schede in chat, senza passare dal modello.
struct ListShortcutsSection: View {
    let shopping: [ShoppingListSummary]
    let todo: [TodoList]
    let onSelect: (PanelDestination) -> Void
    @State private var expanded = false

    private var shortcuts: [Shortcut] {
        let activities = todo.map { list in
            let remaining = list.tasks.filter { $0.status == .pending }.count
            return Shortcut(id: "todo:\(list.id)", title: list.name,
                subtitle: ["Attività", remaining == 0 ? "Niente da fare" : "\(remaining) da fare", TodoTime.dayLabel(list)].compactMap { $0 }.joined(separator: " · "),
                icon: list.mode == .scheduled ? "calendar" : "checklist", tint: .brain, destination: .todoList(list.id))
        }
        let purchases = shopping.map { list in
            Shortcut(id: "shopping:\(list.id)", title: list.name,
                subtitle: list.archived ? "Spesa · Archiviata" : "Spesa · \(list.open == 0 ? "Niente da prendere" : "\(list.open) da prendere")",
                icon: list.archived ? "archivebox" : "cart", tint: .shopping, destination: .shoppingList(list.id))
        }
        // Entrambi i tipi hanno accesso immediato anche quando ci sono molte giornate Todo.
        var result: [Shortcut] = []
        for index in 0..<max(activities.count, purchases.count) {
            if index < purchases.count { result.append(purchases[index]) }
            if index < activities.count { result.append(activities[index]) }
        }
        return result
    }

    var body: some View {
        let items = shortcuts
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text("LE TUE LISTE")
                    .font(.caption.weight(.semibold)).foregroundStyle(Theme.inkSecondary)
                    .padding(.horizontal, 12).padding(.bottom, 4)
                    .accessibilityAddTraits(.isHeader)
                ForEach(expanded ? items : Array(items.prefix(4))) { item in
                    Button { onSelect(item.destination) } label: {
                        HStack(alignment: .top, spacing: 12) {
                            Image(systemName: item.icon).font(.system(size: 20, weight: .semibold))
                                .foregroundStyle(item.tint.color).frame(width: 28).padding(.top, 2)
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(item.title).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                                Text(item.subtitle).font(.caption).foregroundStyle(Theme.inkSecondary)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                                .fixedSize(horizontal: false, vertical: true)
                            Image(systemName: "chevron.right").font(.caption.weight(.semibold))
                                .foregroundStyle(Theme.inkSecondary).padding(.top, 4).accessibilityHidden(true)
                        }.padding(.horizontal, 12).padding(.vertical, 10)
                            .frame(minHeight: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("list-shortcut-\(item.id)")
                    .accessibilityElement(children: .combine)
                    .accessibilityHint("Apri la lista")
                }
                if items.count > 4 {
                    Button(expanded ? "Mostra meno" : "Mostra tutte (\(items.count))") { expanded.toggle() }
                        .font(.subheadline.weight(.semibold)).foregroundStyle(Theme.accentText)
                        .padding(.horizontal, 12).frame(minHeight: 44)
                }
                Rectangle().fill(Theme.hairline).frame(height: 1).padding(.top, 8)
            }
        }
    }

    private struct Shortcut: Identifiable {
        let id: String
        let title: String
        let subtitle: String
        let icon: String
        let tint: SkillTint
        let destination: PanelDestination
    }
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
