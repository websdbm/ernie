import SwiftUI

/// Sceglie e interroga un archivio separato: la richiesta non passa dal transcript della chat principale.
struct ChatArchiveReferenceView: View {
    let request: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.chatPalette) private var palette
    @State private var archives: [ChatArchive] = []
    @State private var total = 0
    @State private var browsingAll = false
    @State private var search = ""
    @State private var question = ""
    @State private var loading = false
    @State private var error: String?
    @State private var path: [String] = []
    @State private var generation = UUID()
    @State private var skills = false
    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    Text("Su quale chat vuoi chiedere a Ernie?").font(.headline)
                    Text(request).font(.subheadline).foregroundStyle(.secondary)
                    Text("Domanda e fonti restano in Archivio chat, separate dalla memoria generale.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red); Button("Riprova") { Task { await load() } }; Button("Gestisci skill") { skills = true } }
                }
                ForEach(archives) { archive in
                    NavigationLink(value: archive.id) {
                        ChatArchiveCatalogRow(archive: archive)
                    }
                }
                if loading { ProgressView().frame(maxWidth: .infinity) }
                else if archives.isEmpty && error == nil { Text("Nessuna chat corrispondente. Cerca un altro nome o importa la conversazione da Archivio chat.").foregroundStyle(.secondary) }
                if !loading && (archives.count < total || !browsingAll) { Button(browsingAll ? "Carica altre chat" : "Mostra tutte le chat") { Task { await load(more: true) } } }
            }
            .navigationTitle("Scegli la chat")
            .searchable(text: $search, prompt: "Nome, descrizione, categoria o tag")
            .navigationDestination(for: String.self) { id in ChatArchiveDetailView(id: id, initialQuestion: question.isEmpty ? request : question) }
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Fine") { dismiss() } } }
            .sheet(isPresented: $skills, onDismiss: { Task { await load() } }) { SkillsSheet() }
            .task(id: search) {
                if !search.isEmpty { try? await Task.sleep(for: .milliseconds(300)) }
                guard !Task.isCancelled else { return }; await load()
            }
            .onChange(of: model.credentials) { generation = UUID(); archives = []; path = []; dismiss() }
        }.tint(palette.accentText)
    }
    private func load(more: Bool = false) async {
        guard let api = model.api else { return }
        let token = UUID(); generation = token; loading = true; error = nil
        do {
            if search.isEmpty && !more && !browsingAll {
                let result = try await api.resolveChatArchive(request)
                guard generation == token, model.credentials == api.credentials, !Task.isCancelled else { return }
                archives = result.archives; total = result.total; question = result.question
                if let selected = result.selectedArchiveId, result.archives.count == 1, result.archives[0].id == selected, path.isEmpty { path = [selected] }
            } else {
                let append = more && browsingAll
                let page = try await api.chatArchives(query: search, offset: append ? archives.count : 0)
                guard generation == token, model.credentials == api.credentials, !Task.isCancelled else { return }
                if append { archives += page.archives.filter { incoming in !archives.contains { $0.id == incoming.id } } } else { archives = page.archives }
                total = page.total; browsingAll = true
            }
        } catch { if generation == token, model.credentials == api.credentials, !Task.isCancelled { self.error = ChatArchivePresentation.error(error) } }
        if generation == token { loading = false }
    }
}

/// Mantiene la catena della chat principale breve e l’archivio in fogli dedicati.
struct ChatArchivePresentationModifier: ViewModifier {
    @Environment(AppModel.self) private var model
    @Binding var library: Bool
    @Binding var reference: ChatArchiveReferenceRequest?
    @Binding var panelOpen: Bool
    @Binding var composing: Bool
    let onDismiss: () -> Void
    func body(content: Content) -> some View {
        content
            .sheet(item: $reference, onDismiss: onDismiss) { ChatArchiveReferenceView(request: $0.text) }
            .sheet(isPresented: $library, onDismiss: onDismiss) { ChatArchiveLibraryView() }
            .onChange(of: model.conversation?.chatArchiveReference?.id) { _, request in
                if request != nil { panelOpen = false; composing = false; model.voice?.cancelListening(); reference = model.conversation?.chatArchiveReference }
            }
            .onChange(of: model.conversation?.chatArchiveLaunchID) { _, request in
                if request != nil { panelOpen = false; composing = false; model.voice?.cancelListening(); library = true }
            }
            .onChange(of: model.pendingChatArchiveImport?.id, initial: true) { _, request in
                if request != nil { panelOpen = false; composing = false; library = true }
            }
    }
}
