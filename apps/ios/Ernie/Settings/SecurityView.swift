import SwiftUI

/// Impostazioni → Conferme: regole «Consenti sempre» (M9). Ogni regola dice al server di non chiedere
/// conferma per quel tool; si revoca scorrendo a sinistra. Gli invii verso l'esterno non sono mai ammessi.
struct SecurityView: View {
    @Environment(AppModel.self) private var model
    @State private var rules: [ToolRule] = []
    @State private var loading = true
    @State private var error: String?

    var body: some View {
        List {
            Section {
                if rules.isEmpty, !loading {
                    Text("Nessuna azione consentita sempre: Ernie chiede conferma ogni volta che serve.")
                        .foregroundStyle(.secondary)
                }
                ForEach(rules) { r in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(r.title).font(.body)
                        Text("\(r.toolId) · dal \(Self.day(r.createdAt))")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                .onDelete { offsets in Task { await revoke(offsets) } }
            } header: {
                Text("Consentite sempre")
            } footer: {
                Text("Scorri a sinistra per revocare: dalla prossima volta Ernie chiederà di nuovo. Le nuove regole nascono dal pulsante «Consenti sempre» nelle schede di conferma.")
            }
            if let error { Section { Text(error).font(.footnote).foregroundStyle(.red) } }
        }
        .navigationTitle("Azioni consentite")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        guard let api = model.api else { return }
        do {
            rules = try await api.toolRules()
            error = nil
        } catch {
            self.error = AppModel.describe(error)
        }
        loading = false
    }

    private func revoke(_ offsets: IndexSet) async {
        guard let api = model.api else { return }
        for i in offsets {
            do { try await api.deleteToolRule(id: rules[i].id) } catch { self.error = AppModel.describe(error) }
        }
        await load()
    }

    static func day(_ iso: String) -> String {
        guard let d = ReminderStore.date(iso) else { return iso }
        return d.formatted(date: .abbreviated, time: .omitted)
    }
}
