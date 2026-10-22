import SwiftUI

struct BrainResource: Codable, Sendable, Hashable, Identifiable {
    enum Kind: String, Codable, Sendable { case recipe, media }
    var kind: Kind
    var id: String
    var canonicalID: String? { UUID(uuidString: id)?.uuidString.lowercased() }
    var path: String? { canonicalID.map { "\(kind == .recipe ? "Ricette" : "Immagini")/\($0).md" } }
    var openLabel: String { kind == .recipe ? "Apri ricetta" : "Apri immagine" }
    var icon: String { kind == .recipe ? "fork.knife" : "photo" }
}

struct BrainRelatedNote: Codable, Sendable, Hashable, Identifiable {
    var path: String
    var title: String
    var type: String
    var resource: BrainResource? = nil
    var coords: [Double]? = nil
    var id: String { path }
}

/// Il titolo è un ripiego per i link storici. Elenchi, fonti e collegamenti nuovi usano il percorso.
enum BrainDestination: Hashable {
    case path(String), title(String)
    static func reference(_ value: String) -> Self { value.hasSuffix(".md") ? .path(value) : .title(value) }
    var queryItem: URLQueryItem {
        switch self {
        case .path(let value): URLQueryItem(name: "path", value: value)
        case .title(let value): URLQueryItem(name: "title", value: value)
        }
    }
    var requestPath: String {
        var components = URLComponents()
        components.queryItems = [queryItem]
        let query = (components.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B")
        return "/v1/brain/note?\(query)"
    }
    var displayName: String {
        switch self {
        case .title(let value): value
        case .path: "Scheda"
        }
    }
    init?(url: URL) {
        guard url.scheme == "ernie-brain", url.host == "note",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
        if let path = items.first(where: { $0.name == "path" })?.value, !path.isEmpty { self = .path(path) }
        else if let title = items.first(where: { $0.name == "title" })?.value, !title.isEmpty { self = .reference(title) }
        else { return nil }
    }
}

extension ApiClient {
    func brainNote(destination: BrainDestination) async throws -> BrainNoteResponse {
        try await request("GET", destination.requestPath)
    }
    func setBrainResourceLinks(_ resource: BrainResource, paths: [String]) async throws -> [String] {
        guard let id = resource.canonicalID, paths.count <= 20 else {
            throw ApiError(status: 0, code: "invalid_links", message: "Puoi collegare fino a 20 schede.")
        }
        struct Body: Encodable, Sendable { var paths: [String] }
        struct Out: Decodable { var paths: [String] }
        let result: Out = try await request("PATCH", "/v1/brain/resources/\(resource.kind.rawValue)/\(id)/links", body: Body(paths: paths))
        return result.paths
    }
}

enum BrainResourceLinkPolicy {
    static func selectable(_ note: BrainNoteSummary) -> Bool {
        !note.private && ["persona", "luogo", "argomento", "progetto"].contains(note.type) && note.resource == nil
    }
}

struct BrainResourceActions: View {
    let resource: BrainResource?
    let type: String
    var open: (BrainResource) -> Void
    var link: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(type == "ricetta" ? "La ricetta originale resta nella raccolta Ricette. Questa scheda si aggiorna da lì." : "L’immagine originale resta in Media. Questa scheda si aggiorna da lì.")
                .font(.footnote).foregroundStyle(Theme.inkSecondary).fixedSize(horizontal: false, vertical: true)
            if let resource, resource.canonicalID != nil {
                Button(resource.openLabel, systemImage: resource.icon) { open(resource) }
                    .buttonStyle(.borderedProminent).frame(minHeight: 44)
                Button("Collega schede", systemImage: "link") { link() }
                    .buttonStyle(.bordered).frame(minHeight: 44)
            }
        }.frame(maxWidth: .infinity, alignment: .leading).tint(Theme.accent)
    }
}

struct BrainRelatedNotes: View {
    let notes: [BrainRelatedNote]
    var previews: [String: UIImage] = [:]
    var openMedia: ((BrainResource) -> Void)? = nil
    var open: (String) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Divider()
            Text("Schede collegate").font(.headline).accessibilityAddTraits(.isHeader)
            ForEach(notes) { note in
                HStack(alignment: .center, spacing: 10) {
                    if let resource = note.resource, resource.kind == .media, let id = resource.canonicalID {
                        Button {
                            if let openMedia { openMedia(resource) } else { open(note.path) }
                        } label: {
                            BrainRelatedPhoto(id: id, preview: previews[id]).frame(width: 84, height: 72)
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                        }.buttonStyle(.plain).accessibilityLabel("Apri immagine: \(note.title)")
                    } else { Image(systemName: BrainType.icon(note.type)).frame(width: 24) }
                    Button { open(note.path) } label: {
                        HStack(alignment: .center, spacing: 8) {
                            Text(note.title).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.right").font(.caption)
                        }.frame(minHeight: 44)
                    }.buttonStyle(.plain).accessibilityLabel("Apri scheda: \(note.title)")
                }.foregroundStyle(Theme.accentText)
            }
        }
    }
}

struct BrainOriginalResourceView: View {
    let resource: BrainResource
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        if let id = resource.canonicalID {
            switch resource.kind {
            case .recipe: RecipeLibraryView(recipeId: id)
            case .media:
                NavigationStack {
                    MediaDetailView(id: id, onChanged: {})
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Fine") { dismiss() } } }
                }
            }
        }
    }
}

struct BrainResourceLinksSheet: View {
    let resource: BrainResource
    var onSaved: () -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var selected: [String]
    @State private var notes: [BrainNoteSummary] = []
    @State private var knownTitles: [String: String] = [:]
    @State private var query = ""
    @State private var loading = true
    @State private var saving = false
    @State private var error: String?
    init(resource: BrainResource, initial: [String], onSaved: @escaping () -> Void) {
        self.resource = resource; self.onSaved = onSaved
        var seen = Set<String>()
        _selected = State(initialValue: initial.filter { seen.insert($0).inserted })
    }
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Scegli persone, luoghi, argomenti o progetti già presenti. I collegamenti automatici restano invariati.")
                        .font(.footnote).foregroundStyle(.secondary)
                    Text("\(selected.count) di 20 collegamenti").font(.subheadline)
                }
                if !selected.isEmpty {
                    Section("Scelti da te") {
                        ForEach(selected, id: \.self) { path in
                            HStack {
                                Text(knownTitles[path] ?? URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent)
                                Spacer()
                                Button("Rimuovi", systemImage: "minus.circle") { selected.removeAll { $0 == path } }
                                    .labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44)
                                    .accessibilityLabel("Rimuovi collegamento a \(knownTitles[path] ?? "scheda")")
                            }
                        }
                    }
                }
                Section {
                    if loading { ProgressView("Cerco le schede…") }
                    else if notes.isEmpty && error == nil { Text("Nessuna scheda trovata. Prova un altro nome.").foregroundStyle(.secondary) }
                    ForEach(notes) { note in
                        let checked = selected.contains(note.path)
                        Button {
                            if checked { selected.removeAll { $0 == note.path } }
                            else if selected.count < 20 { selected.append(note.path) }
                        } label: {
                            HStack {
                                Image(systemName: BrainType.icon(note.type))
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(note.title)
                                    Text(note.path).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Image(systemName: checked ? "checkmark.circle.fill" : "circle")
                            }.frame(minHeight: 44).contentShape(Rectangle())
                        }.buttonStyle(.plain).disabled(!checked && selected.count >= 20)
                            .accessibilityValue(checked ? "Selezionata" : "Non selezionata")
                    }
                } header: { Text("Schede disponibili") } footer: { Text("Fino a 200 risultati per ricerca. Le schede private non sono selezionabili.") }
                if let error { Section { Text(error).foregroundStyle(.red) } }
            }
            .disabled(saving)
            .searchable(text: $query, prompt: "Cerca una persona, un luogo o un tema")
            .navigationTitle("Collegamenti").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Annulla") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Salvo…" : "Salva") { Task { await save() } }.disabled(saving || selected.count > 20)
                }
            }
            .interactiveDismissDisabled(saving)
            .task(id: query) { await load() }
        }
    }
    private func load() async {
        guard let api = model.api else { loading = false; return }
        loading = true
        do {
            try await Task.sleep(for: .milliseconds(250))
            let found = try await api.brainNotes(query: query, type: nil, limit: 200)
            guard !Task.isCancelled, model.credentials == api.credentials else { return }
            notes = found.filter(BrainResourceLinkPolicy.selectable)
            for note in notes { knownTitles[note.path] = note.title }
            loading = false; error = nil
        } catch {
            guard !Task.isCancelled, model.credentials == api.credentials else { return }
            loading = false; self.error = AppModel.describe(error)
        }
    }
    private func save() async {
        guard let api = model.api else { return }
        saving = true; error = nil
        defer { saving = false }
        do {
            _ = try await api.setBrainResourceLinks(resource, paths: selected)
            guard !Task.isCancelled, model.credentials == api.credentials else { return }
            onSaved(); dismiss()
        } catch { if model.credentials == api.credentials { self.error = AppModel.describe(error) } }
    }
}

private struct BrainRelatedPhoto: View {
    let id: String
    var preview: UIImage? = nil
    @Environment(AppModel.self) private var model
    @State private var image: UIImage?
    var body: some View {
        ZStack {
            Theme.surfaceMuted
            if let image = preview ?? image { Image(uiImage: image).resizable().scaledToFill() }
            else { Image(systemName: "photo").foregroundStyle(Theme.inkSecondary) }
        }.clipped()
        .task(id: id) {
            guard preview == nil, let api = model.api else { return }
            let result = try? await MediaImageCache.image(id, api: api)
            guard !Task.isCancelled, model.credentials == api.credentials else { return }
            image = result
        }
    }
}
