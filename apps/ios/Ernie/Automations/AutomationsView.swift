import SwiftUI

/// Proiezione di sola lettura: ignora payload operativi, webhook e segreti della risposta.
struct AutomationItem: Decodable, Sendable, Identifiable, Equatable {
    struct Trigger: Decodable, Sendable, Equatable {
        let type: String
        let at: String?
    }
    let id: String
    let key: String
    let title: String
    let enabled: Bool
    let pausedReason: String?
    let trigger: Trigger

    var status: String {
        if pausedReason != nil { return "In pausa" }
        return enabled ? "Attiva" : "Disattivata"
    }
    private static func date(_ raw: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: raw) ?? ISO8601DateFormatter().date(from: raw)
    }
    var schedule: String {
        switch trigger.type {
        case "once":
            if let raw = trigger.at, let date = Self.date(raw) {
                return date.formatted(date: .abbreviated, time: .shortened)
            }
            return "Una tantum"
        case "cron": return "Ricorrente"
        case "event": return "Al verificarsi di un evento"
        case "webhook": return "Su richiesta esterna"
        case "place": return "All’arrivo o all’uscita da un luogo"
        default: return "Programmata"
        }
    }
}

struct AutomationsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var items: [AutomationItem] = []
    @State private var loading = true
    @State private var error: String?
    @State private var requestID = UUID()

    var body: some View {
        NavigationStack {
            List {
                ForEach(items) { item in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(item.title).font(.headline)
                        Label(item.status, systemImage: item.enabled && item.pausedReason == nil ? "checkmark.circle" : "pause.circle")
                            .font(.subheadline).foregroundStyle(.secondary)
                        Text(item.schedule).font(.footnote).foregroundStyle(.secondary)
                    }.padding(.vertical, 4)
                }
            }
            .overlay {
                if loading && items.isEmpty { ProgressView("Caricamento automazioni…") }
                else if let error, items.isEmpty {
                    ContentUnavailableView {
                        Label("Automazioni non disponibili", systemImage: "wifi.exclamationmark")
                    } description: { Text(error) } actions: {
                        Button("Riprova") { Task { await refresh() } }
                    }
                } else if items.isEmpty {
                    ContentUnavailableView("Nessuna automazione", systemImage: "gearshape.2", description: Text("Chiedi a Ernie cosa vuoi controllare o svolgere periodicamente."))
                }
            }
            .safeAreaInset(edge: .bottom) {
                if let error, !items.isEmpty {
                    Text(error).font(.footnote).foregroundStyle(.red).padding().background(.bar)
                }
            }
            .navigationTitle("Automazioni")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Fine") { dismiss() } } }
            .refreshable { await refresh() }
            .task(id: model.credentials) { items = []; await refresh() }
        }
        .accessibilityIdentifier("automations-screen")
    }

    private func refresh() async {
        let token = UUID(); requestID = token
        guard let api = model.api else { items = []; loading = false; return }
        let credentials = model.credentials
        loading = true
        defer { if requestID == token { loading = false } }
        do {
            let result = try await api.automations()
            guard !Task.isCancelled, requestID == token, model.credentials == credentials else { return }
            items = result.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
            error = nil
        } catch {
            guard !Task.isCancelled, requestID == token, model.credentials == credentials else { return }
            self.error = AppModel.describe(error)
        }
    }
}
