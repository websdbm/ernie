import SwiftUI

struct ChatModelSelection: Codable, Sendable, Equatable {
    var provider: String
    var modelId: String
    var effort: String

    static func effortTitle(_ value: String) -> String {
        switch value {
        case "default": "Automatico"
        case "off": "Spento"
        case "minimal": "Minimo"
        case "low": "Basso"
        case "medium": "Medio"
        case "high": "Alto"
        case "xhigh": "Molto alto"
        case "max": "Massimo"
        default: value
        }
    }
}

struct ChatModelOption: Decodable, Identifiable, Sendable {
    var id: String
    var provider: String
    var name: String
    var efforts: [String]
    var contextTokens: Int
    var maxOutputTokens: Int
    var imageInput: Bool
    var sshEligible: Bool
    var price: Price
    struct Price: Decodable, Sendable { var inputPerM: Double; var outputPerM: Double }
    var key: String { "\(provider):\(id)" }
    var providerTitle: String { provider == "anthropic" ? "Anthropic" : "OpenRouter" }
}

struct ChatModelCatalog: Decodable, Sendable {
    var active: Bool
    var models: [ChatModelOption]
    var updatedAt: String?
    var unavailable: [String]
    var updateDate: Date? {
        guard let updatedAt else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions.insert(.withFractionalSeconds)
        return formatter.date(from: updatedAt) ?? ISO8601DateFormatter().date(from: updatedAt)
    }
}

extension Notification.Name {
    static let ernieSkillsChanged = Notification.Name("ernie.skills.changed")
}

/// Selection belongs to the conversation. The request snapshots it when queued.
struct MaximizeBar: View {
    let conversation: ConversationStore
    let palette: ChatPalette
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase
    @State private var catalog: ChatModelCatalog?
    @State private var presented = false
    @State private var error: String?
    @State private var loading = false
    @State private var query = ""

    init(conversation: ConversationStore, palette: ChatPalette, catalog: ChatModelCatalog? = nil, initiallyPresented: Bool = false) {
        self.conversation = conversation
        self.palette = palette
        _catalog = State(initialValue: catalog)
        _presented = State(initialValue: initiallyPresented)
    }

    private var selected: ChatModelOption? {
        guard let s = conversation.modelSelection else { return nil }
        return catalog?.models.first { $0.id == s.modelId && $0.provider == s.provider }
    }

    var body: some View {
        Group {
            if catalog?.active == true || conversation.modelSelection != nil {
                Button { presented = true } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "slider.horizontal.3")
                        Text(selected?.name ?? (conversation.modelSelection == nil ? "Automatico" : "Verifica modello"))
                            .lineLimit(1)
                        if let s = conversation.modelSelection {
                            Text(ChatModelSelection.effortTitle(s.effort)).foregroundStyle(palette.inkSecondary).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.up.chevron.down").font(.caption2)
                    }
                    .font(.subheadline).foregroundStyle(palette.ink)
                    .padding(.horizontal, 14).frame(minHeight: 44)
                    .background(palette.accent.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
                }
                .buttonStyle(.plain).accessibilityLabel("Maximize, modello della conversazione")
                .padding(.horizontal, 20).padding(.bottom, 6)
            }
        }
        .task(id: conversation.sessionId) { await reload() }
        .onReceive(NotificationCenter.default.publisher(for: .ernieSkillsChanged)) { _ in Task { await reload() } }
        .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await reload() } } }
        .sheet(isPresented: $presented) {
            NavigationStack {
                List {
                    Section {
                        Button { conversation.selectModel(nil); presented = false } label: {
                            Label("Automatico", systemImage: conversation.modelSelection == nil ? "checkmark.circle.fill" : "circle")
                        }
                        Text("Ernie sceglie il modello in base alla richiesta.").font(.footnote).foregroundStyle(.secondary)
                    }
                    if let s = conversation.modelSelection, let model = selected {
                        Section("Sforzo · \(model.name)") {
                            Picker("Ragionamento", selection: Binding(get: { s.effort }, set: { value in
                                conversation.selectModel(.init(provider: s.provider, modelId: s.modelId, effort: value))
                            })) {
                                ForEach(model.efforts, id: \.self) { Text(ChatModelSelection.effortTitle($0)).tag($0) }
                            }
                        }
                    }
                    if let error { Section { Text(error).foregroundStyle(.red) } }
                    if let catalog, !catalog.unavailable.isEmpty {
                        Section { Text("Catalogo temporaneamente non disponibile: \(catalog.unavailable.joined(separator: ", ")).").foregroundStyle(.secondary) }
                    }
                    ForEach(["anthropic", "openrouter"], id: \.self) { provider in
                        let models = (catalog?.models ?? []).filter { $0.provider == provider && (query.isEmpty || $0.name.localizedStandardContains(query)) }
                            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
                        if !models.isEmpty {
                            Section(provider == "anthropic" ? "Anthropic · API diretta" : "OpenRouter") {
                                ForEach(models, id: \.key) { model in
                                    Button {
                                        conversation.selectModel(.init(provider: model.provider, modelId: model.id, effort: "default"))
                                    } label: {
                                        HStack {
                                            VStack(alignment: .leading, spacing: 5) {
                                                Text(model.name).foregroundStyle(Color.primary)
                                                Text("$\(model.price.inputPerM.formatted(.number.precision(.fractionLength(0...3)))) ingresso · $\(model.price.outputPerM.formatted(.number.precision(.fractionLength(0...3)))) uscita / 1M token")
                                                    .font(.caption).foregroundStyle(Color.secondary)
                                            }
                                            Spacer()
                                            if selected?.key == model.key { Image(systemName: "checkmark").accessibilityLabel("Selezionato") }
                                        }.padding(.vertical, 4)
                                    }
                                }
                            }
                        }
                    }
                    Section {
                        Text("Le tariffe mostrate sono quelle base. La scelta vale per questa conversazione dal prossimo messaggio. Più sforzo può richiedere più tempo e costare di più; resta un limite di output. Le operazioni sui server richiedono Automatico, Opus 5.5 o Fable 5.2.")
                        if selected?.id.contains("fable-5") == true { Text("Fable prevede una conservazione dei dati di 30 giorni presso Anthropic.") }
                        Text("Cambiando servizio, i messaggi e il contesto pertinenti della conversazione saranno inviati al servizio scelto. I permessi delle altre skill restano validi.")
                        if let date = catalog?.updateDate { Text("Catalogo aggiornato: \(date.formatted(date: .abbreviated, time: .shortened))") }
                    }.font(.footnote).foregroundStyle(.secondary)
                }
                .navigationTitle("Maximize").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { Button { Task { await reload(refresh: true) } } label: { Image(systemName: "arrow.clockwise") }.disabled(loading).accessibilityLabel("Aggiorna catalogo") }
                    ToolbarItem(placement: .topBarTrailing) { Button("Fine") { presented = false } }
                }
                .overlay { if loading { ProgressView() } }
                .searchable(text: $query, prompt: "Cerca un modello")
            }.tint(palette.accentText)
        }
    }

    @MainActor private func reload(refresh: Bool = false) async {
        guard let api = app.api, !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let result: ChatModelCatalog = try await api.request("GET", refresh ? "/v1/models?refresh=1" : "/v1/models")
            catalog = result; error = nil
            if !result.active { conversation.selectModel(nil); presented = false }
        } catch { self.error = AppModel.describe(error) }
    }
}
