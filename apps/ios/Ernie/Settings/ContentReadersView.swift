import Foundation
import Observation
import SwiftUI

/// Snapshot in memoria della schermata, sempre vincolato alle credenziali che lo hanno richiesto.
@MainActor @Observable final class ContentReadersStore {
    typealias Loader = @MainActor () async throws -> ContentReadersReport
    private var snapshot: ContentReadersReport?
    private var owner: Credentials?
    private var generation = UUID()
    private var requestTask: Task<ContentReadersReport, any Error>?
    private(set) var loading = false
    private(set) var error: String?

    func report(for credentials: Credentials?) -> ContentReadersReport? {
        guard credentials != nil, credentials == owner else { return nil }
        return snapshot
    }

    func clear() {
        generation = UUID(); requestTask?.cancel(); requestTask = nil
        snapshot = nil; owner = nil; loading = false; error = nil
    }

    func load(credentials: Credentials, using loader: @escaping Loader) async {
        clear()
        let token = generation
        owner = credentials; loading = true
        do {
            try Task.checkCancellation()
            let task = Task { try await loader() }
            requestTask = task
            let result = try await withTaskCancellationHandler(operation: { try await task.value }, onCancel: { task.cancel() })
            guard generation == token else { return }
            requestTask = nil; loading = false
            guard !Task.isCancelled else { return }
            snapshot = result
        } catch {
            guard generation == token else { return }
            requestTask = nil; loading = false
            guard !Task.isCancelled, !(error is CancellationError) else { return }
            self.error = ContentReaderPresentation.error(error)
        }
    }
}

enum ContentReaderPresentation {
    static func error(_ error: any Error) -> String {
        if let api = error as? ApiError {
            if api.status == 404 { return "Questo server non dispone ancora della diagnostica dei lettori. Sarà disponibile dopo il suo aggiornamento." }
            if api.status == 401 { return "La sessione non è più valida. Accedi di nuovo per vedere la diagnostica." }
            if api.status == 403 { return "La diagnostica non è disponibile per questo account." }
        }
        return "Non riesco ad aggiornare lo stato dei lettori. Controlla la connessione e riprova."
    }

    static func title(_ outcome: ContentReaderAttempt.Outcome) -> String {
        switch outcome {
        case .success: "Ultima lettura riuscita"
        case .unavailable: "Contenuto non disponibile"
        case .blocked: "Accesso bloccato"
        case .rateLimited: "Troppe richieste"
        case .credits: "Credito insufficiente"
        case .budget: "Limite di spesa raggiunto"
        case .error: "Lettura non riuscita"
        case .unknown: "Esito non riconosciuto"
        }
    }

    static func date(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }

    static func duration(_ milliseconds: Double) -> String? {
        guard milliseconds.isFinite, milliseconds >= 0 else { return nil }
        return (milliseconds / 1000).formatted(.number.precision(.fractionLength(1))) + " s"
    }
}

struct ContentReadersView: View {
    @Environment(AppModel.self) private var model
    @State private var store = ContentReadersStore()

    var body: some View {
        List {
            if model.credentials == nil {
                ContentUnavailableView("Accedi per vedere i lettori", systemImage: "person.crop.circle.badge.exclamationmark")
            } else if store.loading {
                ProgressView("Caricamento dei lettori…")
            } else if let error = store.error {
                Section {
                    ContentUnavailableView("Diagnostica non disponibile", systemImage: "wifi.exclamationmark", description: Text(error))
                    Button("Riprova") { Task { await load() } }
                }
            } else if let report = store.report(for: model.credentials) {
                let readers = unique(report.readers)
                readerSection("YouTube", readers: readers.filter { $0.id.hasPrefix("youtube_") })
                readerSection("Instagram", readers: readers.filter { $0.id == "instagram" })
                readerSection("Altri lettori", readers: readers.filter { !$0.id.hasPrefix("youtube_") && $0.id != "instagram" })
                if readers.isEmpty {
                    ContentUnavailableView("Nessun lettore disponibile", systemImage: "doc.text.magnifyingglass")
                }
                Section {
                    Text("Configurato indica che il lettore è predisposto. Il risultato dell’ultima lettura non garantisce che tutti i contenuti siano accessibili adesso.")
                    Text("Qui vedi solo lo stato del tuo account. Aggiornare questa schermata non avvia prove sui contenuti né analisi AI.")
                    if let date = ContentReaderPresentation.date(report.updatedAt) {
                        Text("Riepilogo aggiornato \(date.formatted(date: .abbreviated, time: .shortened))")
                    }
                }
                .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.ground).foregroundStyle(Theme.ink)
        .tint(Theme.accentText)
        .navigationTitle("Lettura dei contenuti")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }
                    .accessibilityLabel("Aggiorna lo stato dei lettori")
                    .disabled(store.loading || model.api == nil)
            }
        }
        .task(id: model.credentials) { await load() }
        .refreshable { await load() }
        .onDisappear { store.clear() }
    }

    @ViewBuilder private func readerSection(_ title: String, readers: [ContentReaderStatus]) -> some View {
        if !readers.isEmpty {
            Section(title) {
                ForEach(readers) { reader in ContentReaderRow(reader: reader) }
            }
        }
    }

    private func unique(_ readers: [ContentReaderStatus]) -> [ContentReaderStatus] {
        var seen = Set<String>()
        return readers.filter { seen.insert($0.id).inserted }
    }

    private func load() async {
        guard let api = model.api else { store.clear(); return }
        await store.load(credentials: api.credentials, using: api.contentReaders)
    }
}

private struct ContentReaderRow: View {
    let reader: ContentReaderStatus

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(reader.name).font(.headline)
            Label(reader.configured ? "Configurato" : "Non configurato", systemImage: reader.configured ? "gearshape" : "exclamationmark.circle")
                .font(.caption).foregroundStyle(.secondary)
            Text(reader.description).font(.footnote)
            if let attempt = reader.lastAttempt {
                Label(ContentReaderPresentation.title(attempt.outcome), systemImage: attempt.outcome == .success ? "checkmark.circle" : "exclamationmark.circle")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(attempt.outcome == .success ? Theme.accentText : Theme.ink)
                if !attempt.message.isEmpty { Text(attempt.message).font(.footnote) }
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    if let date = ContentReaderPresentation.date(attempt.at) {
                        Text(date.formatted(date: .abbreviated, time: .shortened))
                    }
                    if let duration = ContentReaderPresentation.duration(attempt.durationMs) { Text(duration) }
                }
                .font(.caption).foregroundStyle(.secondary)
            } else {
                Text(reader.configured ? "Non ancora verificato" : "Nessun tentativo registrato")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 5)
        .accessibilityElement(children: .combine)
    }
}
