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

    private var mine: [ReminderItem] { scheduled.filter { $0.forLabel == nil } }
    private var recurring: [ReminderItem] { mine.filter { $0.repeatInfo != nil && $0.place == nil } }
    private var oneOff: [ReminderItem] { mine.filter { $0.repeatInfo == nil && $0.place == nil } }
    /// Legati a un luogo («quando arrivo a casa»): scattano sul telefono entrando o uscendo dalla zona.
    private var placed: [ReminderItem] { mine.filter { $0.place != nil } }
    /// Messi da me a un familiare: a parte, perché suonano sul suo telefono e non sul mio.
    private var forOthers: [ReminderItem] { scheduled.filter { $0.forLabel != nil } }

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
                if !placed.isEmpty {
                    Section {
                        ForEach(placed) { row($0) }
                    } header: {
                        Text("In un luogo")
                    } footer: {
                        Text("Scattano quando arrivi (o esci) dal luogo, anche con l'app chiusa. I luoghi sono in Impostazioni › La tua scheda.")
                    }
                }
                if !forOthers.isEmpty {
                    Section {
                        ForEach(forOthers) { row($0) }
                    } header: {
                        Text("Per i familiari")
                    } footer: {
                        Text("Li hai messi tu: suonano sul loro telefono, non sul tuo.")
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
                    if let other = r.forLabel { ReminderForBadge(label: other) }
                    if let rep = r.repeatInfo {
                        Label(rep.label, systemImage: "repeat")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if let place = r.place, let line = RemindersCard.placeLine(place) {
                        Label(line.text, systemImage: line.symbol)
                            .font(.caption)
                            .foregroundStyle(line.warning ? Color.orange : .secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Tocca per modificare")
            if r.place == nil { ReminderChannelChips(item: r) }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button("Annulla", systemImage: "xmark.circle", role: .destructive) {
                Task { await model.reminders.cancel(r) }
            }
        }
    }
}
