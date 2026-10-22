import SwiftUI

struct MediaDetailView: View {
    let id: String
    var onChanged: () -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var item: SavedMedia?
    @State private var error: String?
    @State private var showBrain = false
    @State private var editing = false
    @State private var confirmDelete = false
    @State private var deleting = false
    @State private var reload = 0
    var body: some View {
        ScrollView {
            if let item {
                VStack(alignment: .leading, spacing: 22) {
                    MediaPhoto(item: item, api: model.api, thumbnail: false).clipShape(RoundedRectangle(cornerRadius: 18))
                    Button("Apri nel Second Brain", systemImage: "brain.head.profile") { showBrain = true }
                        .buttonStyle(.bordered).frame(minHeight: 44)
                    Text(item.title).font(.title.bold()).foregroundStyle(Theme.ink)
                    MediaTagLayout { MediaTag(text: item.category); MediaTag(text: item.year); ForEach(item.tags, id: \.self) { MediaTag(text: $0) } }
                    if let location = item.location, location.isValid,
                       let url = BrainLocation.mapsURL(coords: [location.lat, location.lon], title: item.title) {
                        Link(destination: url) { Label("Posizione dello scatto", systemImage: "map") }.frame(minHeight: 44)
                    }
                    if !item.description.isEmpty { Text(item.description).font(.body).textSelection(.enabled) }
                    LabeledContent("Caricata", value: date(item.createdAt)).font(.footnote).foregroundStyle(.secondary)
                    if item.organization == "automatic" { Label("Titolo e tag proposti da Ernie · modificabili", systemImage: "sparkles").font(.footnote).foregroundStyle(.secondary) }
                    if ["failed", "pending"].contains(item.organization) {
                        Text("La foto è salvata nella raccolta. Puoi completare titolo e tag con Modifica.").font(.footnote).foregroundStyle(.secondary)
                    }
                    if let error { Text(error).font(.footnote).foregroundStyle(.red) }
                }.padding(20)
            } else if let error {
                ContentUnavailableView { Label("Immagine non disponibile", systemImage: "photo.badge.exclamationmark") } description: { Text(error) } actions: { Button("Riprova") { reload += 1 } }
            } else { ProgressView("Apro l’immagine…").padding(40) }
        }
        .background(Theme.ground)
        .navigationTitle("Scheda immagine").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if item != nil {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button("Modifica", systemImage: "pencil") { editing = true }
                        Button("Elimina dalla raccolta", systemImage: "trash", role: .destructive) { confirmDelete = true }
                    } label: { Image(systemName: "ellipsis.circle") }.disabled(deleting)
                }
            }
        }
        .sheet(isPresented: $showBrain) {
            if let path = BrainResource(kind: .media, id: id).path { SecondBrainView(initialPath: path) }
        }
        .sheet(isPresented: $editing) {
            if let item { MediaEditor(item: item) { saved in self.item = saved; onChanged() } }
        }
        .confirmationDialog("Eliminare questa immagine?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Elimina immagine", role: .destructive) { Task { await remove() } }
        } message: { Text("La foto e la sua scheda saranno rimosse da Media. Note e ricette già create restano disponibili.") }
        .task(id: "\(model.credentials?.apiKey ?? "")|\(reload)") {
            item = nil; error = nil
            guard let api = model.api else { return }
            do {
                let found = try await api.mediaItem(id)
                guard !Task.isCancelled, model.credentials == api.credentials else { return }
                item = found
            } catch { if !Task.isCancelled, model.credentials == api.credentials { self.error = MediaPresentation.error(error) } }
        }
    }
    private func date(_ raw: String) -> String {
        let parser = ISO8601DateFormatter(); parser.formatOptions.insert(.withFractionalSeconds)
        guard let date = parser.date(from: raw) ?? ISO8601DateFormatter().date(from: raw) else { return String(raw.prefix(10)) }
        return date.formatted(.dateTime.day().month(.wide).year().locale(Locale(identifier: "it_IT")))
    }
    private func remove() async {
        guard let api = model.api else { return }
        deleting = true; error = nil
        do {
            try await api.deleteMedia(id)
            guard model.credentials == api.credentials else { return }
            MediaImageCache.clear(); onChanged(); dismiss()
        } catch { if model.credentials == api.credentials { self.error = MediaPresentation.error(error) } }
        deleting = false
    }
}

struct MediaEditor: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State var item: SavedMedia
    var onSaved: (SavedMedia) -> Void
    @State private var tags = ""
    @State private var saving = false
    @State private var error: String?
    private var valid: Bool {
        let names = MediaPresentation.tags(tags)
        return !item.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && item.title.count <= 160 && !item.category.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && item.category.count <= 40 && item.description.count <= 2000 && names.count <= 10 && names.allSatisfy { $0.count <= 30 }
    }
    var body: some View {
        NavigationStack {
            Form {
                Section("Titolo") { TextField("Un titolo per ritrovarla", text: $item.title, axis: .vertical) }
                Section("Descrizione") { TextField("Che cosa vuoi ricordare?", text: $item.description, axis: .vertical).lineLimit(3...8) }
                Section("Organizzazione") {
                    TextField("Categoria", text: $item.category)
                    Menu("Scegli una categoria") { ForEach(MediaPresentation.categories, id: \.self) { category in Button(category) { item.category = category } } }
                    TextField("Tag separati da virgole", text: $tags, axis: .vertical).textInputAutocapitalization(.never)
                    Text("Fino a 10 tag, ciascuno di massimo 30 caratteri.").font(.footnote).foregroundStyle(.secondary)
                }
                if let error { Section { Text(error).foregroundStyle(.red) } }
            }
            .navigationTitle("Modifica immagine").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Annulla") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) { Button(saving ? "Salvo…" : "Salva") { Task { await save() } }.disabled(saving || !valid) }
            }
            .onAppear { tags = item.tags.joined(separator: ", ") }
            .interactiveDismissDisabled(saving)
        }
    }
    private func save() async {
        guard let api = model.api else { return }
        saving = true; error = nil
        item.title = item.title.trimmingCharacters(in: .whitespacesAndNewlines)
        item.category = item.category.trimmingCharacters(in: .whitespacesAndNewlines)
        item.tags = MediaPresentation.tags(tags)
        do {
            let saved = try await api.updateMedia(item)
            guard model.credentials == api.credentials else { return }
            onSaved(saved); dismiss()
        } catch { if model.credentials == api.credentials { self.error = MediaPresentation.error(error) } }
        saving = false
    }
}
