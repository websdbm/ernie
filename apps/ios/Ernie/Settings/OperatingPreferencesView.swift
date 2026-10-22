import SwiftUI

struct OperatingPreference: Codable, Identifiable, Sendable {
    let id: String
    var text: String
    let kind: String
    var active: Bool
    let source: String
    let evidence: String
    let createdAt: String
    let updatedAt: String
}

struct OperatingPreferencesView: View {
    @Environment(AppModel.self) private var model
    @State private var preferences: [OperatingPreference] = []
    @State private var loading = true
    @State private var saving = false
    @State private var error: String?
    @State private var editing: OperatingPreference?
    @State private var showingEditor = false
    @State private var draft = ""
    @State private var enabled = true
    @State private var editorError: String?

    init(initialPreferences: [OperatingPreference]? = nil) {
        _preferences = State(initialValue: initialPreferences ?? [])
        _loading = State(initialValue: initialPreferences == nil)
    }

    var body: some View {
        List {
            Section {
                Text("Le tue preferenze su come organizzare le attività e rispondere. Puoi correggerle, disattivarle o eliminarle.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            if loading { ProgressView() }
            if !loading && preferences.isEmpty {
                ContentUnavailableView("Ancora nessuna preferenza", systemImage: "slider.horizontal.3", description: Text("Per esempio: «Quando una lista è ambigua, mostrami le alternative da toccare»."))
            }
            Section("Preferenze dichiarate") {
                ForEach(preferences.filter { $0.kind == "explicit" }) { row($0) }
            }
            if preferences.contains(where: { $0.kind == "inferred" }) {
                Section {
                    ForEach(preferences.filter { $0.kind == "inferred" }) { row($0) }
                } header: { Text("Da verificare") } footer: {
                    Text("Queste sono ipotesi: Ernie non le applica. Aprile e salvale solo se ti rappresentano.")
                }
            }
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
        }
        .navigationTitle("Come lavora Ernie")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            Button { editing = nil; draft = ""; enabled = true; editorError = nil; showingEditor = true } label: {
                Label("Aggiungi preferenza", systemImage: "plus")
            }.disabled(saving)
        }
        .task { await load() }
        .refreshable { await load() }
        .sheet(isPresented: $showingEditor) {
            NavigationStack {
                Form {
                    Section("Preferenza") {
                        TextField("Come vuoi che lavori Ernie?", text: $draft, axis: .vertical)
                            .lineLimit(3...8)
                        Toggle("Attiva", isOn: $enabled)
                        Text("\(draft.count)/400 caratteri").font(.caption).foregroundStyle(.secondary)
                    }
                    if let editing {
                        Section("Origine") {
                            Text(sourceLabel(editing))
                            Text(editing.evidence).font(.callout).foregroundStyle(.secondary)
                        }
                    }
                    Section {
                        Text("Queste preferenze riguardano stile e organizzazione. I permessi delle skill e le autorizzazioni si gestiscono separatamente nelle impostazioni di sicurezza.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    if let editorError { Text(editorError).foregroundStyle(.red) }
                }
                .navigationTitle(editing?.kind == "inferred" ? "Verifica preferenza" : "Preferenza")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Annulla") { showingEditor = false }.disabled(saving) }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Salva") { Task { await save() } }
                            .disabled(saving || draft.trimmingCharacters(in: .whitespacesAndNewlines).count < 3 || draft.count > 400)
                    }
                }
                .interactiveDismissDisabled(saving)
            }
        }
    }

    private func sourceLabel(_ p: OperatingPreference) -> String {
        let origin = p.source == "chat" ? "Dalla conversazione" : p.source == "settings" ? "Dalle impostazioni" : "Osservazione da verificare"
        let date = ISO8601DateFormatter().date(from: p.updatedAt) ?? {
            let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f.date(from: p.updatedAt)
        }()
        return origin + (date.map { " · " + $0.formatted(date: .abbreviated, time: .omitted) } ?? "")
    }

    private func row(_ p: OperatingPreference) -> some View {
        Button {
            editing = p; draft = p.text; enabled = p.kind == "inferred" ? true : p.active; editorError = nil; showingEditor = true
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                Text(p.text).foregroundStyle(.primary)
                Text(p.kind == "inferred" ? "Da verificare · non applicata" : p.active ? "Attiva" : "Disattivata")
                    .font(.caption.weight(.semibold)).foregroundStyle(p.active ? Color.accentColor : .secondary)
                Text(sourceLabel(p)).font(.caption).foregroundStyle(.secondary)
            }.padding(.vertical, 4)
        }
        .buttonStyle(.plain)
        .disabled(saving)
        .swipeActions {
            Button("Elimina", role: .destructive) { Task { await remove(p) } }
        }
    }

    private func load() async {
        guard let api = model.api else { loading = false; return }
        defer { loading = false }
        do { preferences = try await api.operatingPreferences(); error = nil }
        catch { self.error = AppModel.describe(error) }
    }

    private func save() async {
        guard let api = model.api else { return }
        saving = true; defer { saving = false }
        do {
            try await api.saveOperatingPreference(id: editing?.id, text: draft.trimmingCharacters(in: .whitespacesAndNewlines), active: enabled)
            showingEditor = false
            await load()
        } catch { editorError = AppModel.describe(error) }
    }

    private func remove(_ p: OperatingPreference) async {
        guard let api = model.api else { return }
        saving = true; defer { saving = false }
        do { try await api.deleteOperatingPreference(id: p.id); await load() }
        catch { self.error = AppModel.describe(error) }
    }
}
