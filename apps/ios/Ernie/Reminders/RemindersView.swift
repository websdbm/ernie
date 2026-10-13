import SwiftUI

/// Tutti i promemoria in programma: ricorrenti e una tantum, con canali, modifica e annullamento.
/// Si apre dal menu ⋯ della chat; i dati sono quelli dello store, gli stessi della scheda in chat.
struct RemindersView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var editing: ReminderItem?

    private var scheduled: [ReminderItem] {
        model.reminders.items
            .filter { $0.status == "scheduled" }
            .sorted { (ReminderStore.date($0.at) ?? .distantFuture) < (ReminderStore.date($1.at) ?? .distantFuture) }
    }

    private var recurring: [ReminderItem] { scheduled.filter { $0.repeatInfo != nil } }
    private var oneOff: [ReminderItem] { scheduled.filter { $0.repeatInfo == nil } }

    var body: some View {
        NavigationStack {
            List {
                if !recurring.isEmpty {
                    Section("Ricorrenti") {
                        ForEach(recurring) { row($0) }
                    }
                }
                if !oneOff.isEmpty {
                    Section("In programma") {
                        ForEach(oneOff) { row($0) }
                    }
                }
            }
            .overlay {
                if scheduled.isEmpty {
                    ContentUnavailableView {
                        Label("Nessun promemoria in programma", systemImage: "bell.slash")
                    } description: {
                        Text("Di' a Ernie per esempio «ricordami ogni venerdì alle 9 di andare in palestra».")
                    }
                }
            }
            .safeAreaInset(edge: .bottom) {
                if let err = model.reminders.lastError {
                    Text(err)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .frame(maxWidth: .infinity)
                        .padding(10)
                        .background(.bar)
                }
            }
            .navigationTitle("Promemoria")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Fine") { dismiss() }
                }
            }
            .refreshable { await model.reminders.refresh() }
            .task { await model.reminders.refresh() }
            .sheet(item: $editing) { r in
                NavigationStack {
                    ReminderEditForm(item: r) { editing = nil }
                        .padding()
                        .navigationTitle("Modifica")
                        .navigationBarTitleDisplayMode(.inline)
                }
                .presentationDetents([.medium, .large])
            }
        }
    }

    private func row(_ r: ReminderItem) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { editing = r } label: {
                VStack(alignment: .leading, spacing: 3) {
                    Text(r.text)
                        .font(.body)
                        .foregroundStyle(.primary)
                    Text(RemindersCard.when(r) + RemindersCard.who(r))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let rep = r.repeatInfo {
                        Label(rep.label, systemImage: "repeat")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Tocca per modificare")
            ReminderChannelChips(item: r)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button("Annulla", systemImage: "xmark.circle", role: .destructive) {
                Task { await model.reminders.cancel(r) }
            }
        }
    }
}
