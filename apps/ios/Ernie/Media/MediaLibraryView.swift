import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct MediaLibraryView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var store = MediaLibraryStore()
    @State private var query = MediaQuery()
    @State private var path: [String] = []
    @State private var reload = 0
    @State private var showPhotos = false
    @State private var showCamera = false
    @State private var showFiles = false
    @State private var picked: [PhotosPickerItem] = []
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("media.autoOrganize") private var autoOrganize = true

    private var loadKey: String { "\(model.credentials?.apiKey ?? "")|\(query.path())|\(reload)|\(model.mediaUploads.revision)" }
    var body: some View {
        NavigationStack(path: $path) {
            GeometryReader { geometry in
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("La tua raccolta visiva").font(.title2.bold()).foregroundStyle(Theme.ink)
                            Text(store.total == 1 ? "1 immagine · dalla più recente" : "\(store.total) immagini · dalla più recente")
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                        filters
                        if let error = store.error {
                            ContentUnavailableView { Label("Raccolta non disponibile", systemImage: "wifi.exclamationmark") } description: { Text(error) } actions: { Button("Riprova") { reload += 1 } }
                        } else if store.loaded && store.items.isEmpty {
                            ContentUnavailableView {
                                Label(query.isFiltered ? "Nessuna immagine trovata" : "Le tue immagini, in un posto solo", systemImage: "photo.on.rectangle.angled")
                            } description: {
                                Text(query.isFiltered ? "Prova un altro titolo, una categoria o un tag." : "Aggiungi una foto con +. Qui ritrovi anche le nuove foto e scansioni allegate alla chat, con titolo, categorie e tag.")
                            } actions: {
                                if query.isFiltered { Button("Azzera filtri") { query = MediaQuery() } }
                                else { Button("Aggiungi immagini") { showPhotos = true }.disabled(model.mediaImports.progress != nil) }
                            }
                        } else {
                            MediaGallery(items: store.items, width: max(1, geometry.size.width - 32), api: model.api) { path.append($0.id) }
                        }
                        if store.loading { ProgressView("Carico le immagini…").frame(maxWidth: .infinity) }
                        if store.hasMore && !store.loading {
                            Button("Carica altre immagini") { Task { await load(append: true) } }.frame(maxWidth: .infinity)
                        }
                    }
                    .padding(16)
                }
                .refreshable { await load() }
                .background(Theme.ground)
            }
            .navigationTitle("Media")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query.search, prompt: "Cerca immagini, titoli e tag")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Fine") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button("Scegli foto", systemImage: "photo.on.rectangle") { showPhotos = true }
                        if UIImagePickerController.isSourceTypeAvailable(.camera) { Button("Scatta una foto", systemImage: "camera") { DeviceContextProvider.shared.refreshForPhoto(); showCamera = true } }
                        Button("Importa da File", systemImage: "folder") { showFiles = true }
                        Divider()
                        Toggle("Titoli e tag automatici", isOn: $autoOrganize)
                    } label: { Image(systemName: "plus") }
                        .disabled(model.mediaImports.progress != nil).accessibilityLabel("Aggiungi immagini")
                }
            }
            .safeAreaInset(edge: .bottom) { uploadStatus }
            .navigationDestination(for: String.self) { id in MediaDetailView(id: id) { reload += 1 } }
            .photosPicker(isPresented: $showPhotos, selection: $picked, maxSelectionCount: 10, matching: .images, preferredItemEncoding: .current)
            .onChange(of: picked) { _, values in
                guard !values.isEmpty else { return }
                picked = []
                importImages(count: values.count) { index in
                    guard let data = try await values[index].loadTransferable(type: Data.self) else { throw DocumentReader.ReadError.unreadable }
                    return try MediaImportPhoto(data: data)
                }
            }
            .fullScreenCover(isPresented: $showCamera) {
                CameraPicker(onFinish: { _ in showCamera = false }, onCapture: { photo in
                    showCamera = false
                    importImages(count: 1) { _ in photo }
                }).ignoresSafeArea()
            }
            .fileImporter(isPresented: $showFiles, allowedContentTypes: [.image], allowsMultipleSelection: true) { result in
                guard case .success(let urls) = result, !urls.isEmpty else { return }
                if urls.count > 10 { model.mediaImports.notice = "Scegli al massimo 10 immagini alla volta."; return }
                importImages(count: urls.count) { index in
                    let url = urls[index], scoped = urls[index].startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    return try MediaImportPhoto(data: Data(contentsOf: url))
                }
            }
            .task(id: loadKey) { await load(debounce: true) }
            .onDisappear { store.cancel() }
            .onChange(of: scenePhase) { _, phase in if phase == .active { reload += 1 } }
        }
    }

    private var filters: some View {
        VStack(alignment: .leading, spacing: 10) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    filter("Tutte", selected: query.category == nil) { query.category = nil }
                    ForEach(store.categories) { category in filter(category.value, selected: query.category == category.value) { query.category = query.category == category.value ? nil : category.value } }
                }
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 16) {
                Menu {
                    Button("Tutti gli anni") { query.year = nil }
                    ForEach(store.years) { year in Button(String(year.value)) { query.year = year.value } }
                } label: { Label(query.year.map(String.init) ?? "Anno", systemImage: "calendar") }
                Menu {
                    Button("Tutti i tag") { query.tag = nil }
                    ForEach(store.tags) { tag in Button("\(tag.value) (\(tag.count))") { query.tag = tag.value } }
                } label: { Label(query.tag ?? "Tag", systemImage: "tag") }
                if query.isFiltered { Button("Azzera") { query = MediaQuery() }.accessibilityLabel("Azzera filtri") }
                }
            }
            .font(.subheadline).foregroundStyle(Theme.accentText)
        }
    }
    private func filter(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) { Text(title).font(.subheadline.weight(selected ? .semibold : .regular)).padding(.horizontal, 13).padding(.vertical, 9).background(selected ? Theme.accent.opacity(0.18) : Theme.hairline.opacity(0.5), in: Capsule()) }
            .foregroundStyle(selected ? Theme.accentText : Theme.ink).buttonStyle(.plain)
            .accessibilityAddTraits(selected ? .isSelected : [])
    }
    private func load(append: Bool = false, debounce: Bool = false) async {
        guard let api = model.api else { return }
        await store.load(query, append: append, debounce: debounce, using: api.media)
    }
    @ViewBuilder private var uploadStatus: some View {
        let queue = model.mediaUploads
        let imports = model.mediaImports
        if imports.progress != nil || !queue.pending.isEmpty || !queue.failed.isEmpty || imports.notice != nil || queue.storageError != nil {
            VStack(alignment: .leading, spacing: 10) {
                if let progress = imports.progress {
                    HStack { ProgressView(); Text(progress); Spacer(); Button("Interrompi") { imports.stopPreparing() } }
                }
                if !queue.pending.isEmpty {
                    HStack(alignment: .top) {
                        ProgressView()
                        Text("\(queue.pending.count) foto in caricamento. Puoi uscire da questa schermata.")
                        Spacer(minLength: 0)
                    }
                }
                if !queue.failed.isEmpty {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("\(queue.failed.count) foto da ritentare").bold()
                            Text(queue.failed.first?.error ?? "Le foto restano sul telefono.")
                        }
                        Spacer(minLength: 0)
                        Button("Riprova") { queue.retryFailed() }
                    }
                }
                if let error = queue.storageError { Text(error).foregroundStyle(.red) }
                if let notice = imports.notice {
                    HStack { Text(notice); Spacer(); Button { imports.notice = nil } label: { Image(systemName: "xmark.circle.fill") }.accessibilityLabel("Chiudi avviso") }
                }
            }.font(.footnote).padding().background(.regularMaterial)
        }
    }
    private func importImages(count: Int, image: @escaping @MainActor (Int) async throws -> MediaImportPhoto) {
        guard let credentials = model.credentials else { return }
        model.mediaImports.startPhotos(count: count, credentials: credentials, autoOrganize: autoOrganize, photo: image)
    }

}

struct MediaGallery: View {
    let items: [SavedMedia]
    let width: CGFloat
    var api: ApiClient?
    var previews: [String: UIImage] = [:]
    var onSelect: (SavedMedia) -> Void = { _ in }
    @Environment(\.dynamicTypeSize) private var textSize
    var body: some View {
        let count = textSize >= .xxLarge || width < 300 ? 1 : (width >= 650 ? 3 : 2)
        let columnWidth = (width - CGFloat(count - 1) * 16) / CGFloat(count)
        let columns = MediaPresentation.columns(items, count: count, width: columnWidth)
        HStack(alignment: .top, spacing: 16) {
            ForEach(columns.indices, id: \.self) { index in
                LazyVStack(spacing: 26) {
                    ForEach(columns[index]) { item in
                        Button { onSelect(item) } label: { MediaTile(item: item, api: api, preview: previews[item.id]) }
                            .buttonStyle(.plain)
                    }
                }
                .frame(width: columnWidth)
            }
        }
    }
}

struct MediaTile: View {
    let item: SavedMedia
    var api: ApiClient?
    var preview: UIImage?
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            MediaPhoto(item: item, api: api, preview: preview)
                .clipShape(RoundedRectangle(cornerRadius: 12))
            Text(item.title).font(.body.weight(.semibold)).foregroundStyle(Theme.ink).lineLimit(3).multilineTextAlignment(.leading)
            MediaTagLayout(spacing: 5) {
                MediaTag(text: item.category)
                MediaTag(text: item.year)
                ForEach(Array(item.tags.prefix(2)), id: \.self) { MediaTag(text: $0) }
                if item.tags.count > 2 { MediaTag(text: "+\(item.tags.count - 2)") }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

struct MediaPhoto: View {
    let item: SavedMedia
    var api: ApiClient?
    var thumbnail = true
    var preview: UIImage?
    @State private var image: UIImage?
    @State private var failed = false
    @State private var retry = 0
    var body: some View {
        ZStack {
            Theme.hairline.opacity(0.35)
            if let image = preview ?? image {
                Image(uiImage: image).resizable().scaledToFit()
            } else if failed {
                VStack(spacing: 8) {
                    Image(systemName: "photo.badge.exclamationmark")
                    if thumbnail { Text("Apri per ricaricare").font(.caption) }
                    else { Button("Ricarica foto") { retry += 1 }.font(.caption) }
                }.foregroundStyle(.secondary)
            } else { ProgressView() }
        }
        .aspectRatio(item.displayAspectRatio, contentMode: .fit)
        .accessibilityLabel(item.title)
        .task(id: "\(api?.credentials.apiKey ?? "")|\(item.id)|\(thumbnail)|\(retry)") {
            image = nil; failed = false
            guard preview == nil, let api else { return }
            do { image = try await MediaImageCache.image(item.id, thumbnail: thumbnail, api: api) }
            catch { if !Task.isCancelled { failed = true } }
        }
    }
}

struct MediaTag: View {
    let text: String
    var body: some View {
        Text(text).font(.caption).foregroundStyle(Theme.ink.opacity(0.8)).lineLimit(1)
            .padding(.horizontal, 7).padding(.vertical, 5)
            .overlay(RoundedRectangle(cornerRadius: 5).stroke(Theme.hairline, lineWidth: 1))
    }
}
struct MediaTagLayout: Layout {
    var spacing: CGFloat = 6
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(width: proposal.width ?? 300, subviews: subviews).size
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let layout = arrange(width: bounds.width, subviews: subviews)
        for (i, point) in layout.positions.enumerated() {
            subviews[i].place(at: CGPoint(x: bounds.minX + point.x, y: bounds.minY + point.y), proposal: ProposedViewSize(width: min(bounds.width, subviews[i].sizeThatFits(.unspecified).width), height: nil))
        }
    }
    private func arrange(width: CGFloat, subviews: Subviews) -> (size: CGSize, positions: [CGPoint]) {
        var x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0
        var positions: [CGPoint] = []
        for view in subviews {
            let size = view.sizeThatFits(ProposedViewSize(width: min(width, view.sizeThatFits(.unspecified).width), height: nil))
            if x > 0, x + size.width > width { x = 0; y += row + spacing; row = 0 }
            positions.append(CGPoint(x: x, y: y)); x += size.width + spacing; row = max(row, size.height)
        }
        return (CGSize(width: width, height: y + row), positions)
    }
}
