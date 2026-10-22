import SwiftUI
import Observation

struct SavedRecipe: Codable, Sendable, Identifiable, Equatable {
    var id: String
    var title: String
    var ingredients: [String]
    var steps: [String]
    var time: String?
    var servings: String?
    var source: String?
    var url: String?
    var notes: String?
    var tags: [String]
    var category: String?
    var version: Int
    var updatedAt: String
}

struct RecipePage: Codable, Sendable {
    struct Category: Codable, Sendable, Identifiable {
        var value: String
        var label: String
        var count: Int
        var id: String { value }
    }
    struct Tag: Codable, Sendable, Identifiable {
        var name: String
        var count: Int
        var id: String { name }
    }
    var recipes: [SavedRecipe]
    var total: Int
    var offset: Int
    var limit: Int
    var categories: [Category]
    var tags: [Tag]
}

struct RecipeQuery: Equatable, Sendable {
    var search = ""
    var category: String?
    var tag: String?
    var isFiltered: Bool { !search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || category != nil || tag != nil }
    func path(offset: Int = 0) -> String {
        var c = URLComponents()
        c.path = "/v1/recipes"
        c.queryItems = [URLQueryItem(name: "offset", value: String(max(0, offset))), URLQueryItem(name: "limit", value: "30")]
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        if !query.isEmpty { c.queryItems?.append(URLQueryItem(name: "q", value: query)) }
        if let category { c.queryItems?.append(URLQueryItem(name: "category", value: category)) }
        if let tag { c.queryItems?.append(URLQueryItem(name: "tag", value: tag)) }
        // I parser HTTP interpretano + come spazio: preserva un + scritto dall'utente.
        c.percentEncodedQuery = c.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return c.string ?? "/v1/recipes?offset=0&limit=30"
    }
}

enum RecipePresentation {
    static let categories = ["Antipasti", "Primi", "Secondi", "Contorni", "Dolci", "Colazioni e merende", "Pane e lievitati", "Salse e conserve", "Bevande", "Altro"]
    static func sourceURL(_ raw: String?) -> URL? {
        guard let raw, let url = URL(string: raw), let scheme = url.scheme?.lowercased(),
              ["https", "http"].contains(scheme), let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil else { return nil }
        return url
    }
    static func tags(_ input: String) -> [String] {
        var seen = Set<String>()
        return input.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && seen.insert($0.lowercased()).inserted }
    }
    static func error(_ error: Error) -> String {
        if let api = error as? ApiError {
            if api.status == 404 { return "Questa ricetta non è più nella raccolta." }
            if api.status == 409 { return "La ricetta è cambiata nel frattempo. Ho ricaricato la versione aggiornata: controlla categoria e tag prima di salvare di nuovo." }
            if api.status == 403 { return "La skill Ricette non è disponibile per questo account." }
        }
        return "Non riesco a caricare le ricette. Controlla la connessione e riprova."
    }
    static func meta(_ recipe: SavedRecipe) -> String {
        [recipe.time, recipe.servings].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

extension ApiClient {
    func recipes(_ query: RecipeQuery, offset: Int = 0) async throws -> RecipePage {
        try await request("GET", query.path(offset: offset))
    }
    func recipe(_ id: String) async throws -> SavedRecipe {
        struct Response: Decodable { var recipe: SavedRecipe }
        let response: Response = try await request("GET", "/v1/recipes/\(id)")
        return response.recipe
    }
    func organizeRecipe(_ recipe: SavedRecipe, category: String?, tags: [String]) async throws -> SavedRecipe {
        struct Body: Encodable, Sendable {
            var category: String?
            var tags: [String]
            var version: Int
            enum CodingKeys: CodingKey { case category, tags, version }
            func encode(to encoder: any Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                if let category { try c.encode(category, forKey: .category) } else { try c.encodeNil(forKey: .category) }
                try c.encode(tags, forKey: .tags)
                try c.encode(version, forKey: .version)
            }
        }
        struct Response: Decodable { var recipe: SavedRecipe }
        let response: Response = try await request("PATCH", "/v1/recipes/\(recipe.id)", body: Body(category: category, tags: tags, version: recipe.version))
        return response.recipe
    }
    func deleteRecipe(_ id: String) async throws {
        try await requestNoContent("DELETE", "/v1/recipes/\(id)")
    }
}

/// La generazione protegge anche da trasporti che consegnano una risposta dopo l'annullamento.
@MainActor @Observable
final class RecipeLibraryStore {
    typealias Loader = @MainActor (RecipeQuery, Int) async throws -> RecipePage
    private(set) var recipes: [SavedRecipe] = []
    private(set) var categories: [RecipePage.Category] = []
    private(set) var tags: [RecipePage.Tag] = []
    private(set) var total = 0
    private(set) var loading = false
    private(set) var loaded = false
    private(set) var error: String?
    private(set) var hasMore = false
    private(set) var query = RecipeQuery()
    private var offset = 0
    private var generation = UUID()
    private var requestTask: Task<RecipePage, any Error>?

    func load(_ query: RecipeQuery, append: Bool = false, debounce: Bool = false, using loader: @escaping Loader) async {
        if append && (loading || !hasMore || query != self.query) { return }
        let token = UUID()
        generation = token
        requestTask?.cancel()
        requestTask = nil
        if query != self.query {
            recipes = []; total = 0; offset = 0; loaded = false; hasMore = false
        }
        self.query = query
        loading = true
        error = nil
        let pageOffset = append ? offset : 0
        do {
            if debounce { try await Task.sleep(for: .milliseconds(300)) }
            try Task.checkCancellation()
            let task = Task { try await loader(query, pageOffset) }
            requestTask = task
            let page = try await withTaskCancellationHandler(operation: { try await task.value }, onCancel: { task.cancel() })
            guard generation == token else { return }
            requestTask = nil
            if Task.isCancelled { loading = false; return }
            var seen = Set<String>()
            recipes = (append ? recipes + page.recipes : page.recipes).filter { seen.insert($0.id).inserted }
            categories = page.categories
            tags = page.tags
            total = page.total
            offset = page.offset + page.recipes.count
            hasMore = !page.recipes.isEmpty && offset < page.total
            loaded = true
            loading = false
        } catch {
            guard generation == token else { return }
            requestTask = nil
            loading = false
            if Task.isCancelled || error is CancellationError { return }
            self.error = RecipePresentation.error(error)
        }
    }
    func cancel() { generation = UUID(); requestTask?.cancel(); requestTask = nil; loading = false }
}

struct RecipeLibraryView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var store = RecipeLibraryStore()
    @State private var query = RecipeQuery()
    @State private var path: [String]

    init(recipeId: String? = nil) { _path = State(initialValue: recipeId.map { [$0] } ?? []) }

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    filters
                    RecipeLibraryContent(recipes: store.recipes, total: store.total, loaded: store.loaded,
                                         loading: store.loading, error: store.error, filtered: query.isFiltered,
                                         hasMore: store.hasMore, open: { path.append($0) },
                                         retry: { Task { await load() } }, more: { Task { await load(append: true) } })
                    Label("Per acquisire una ricetta, torna in chat e usa + per allegare una foto. Chiedi a Ernie di leggerla e, se vuoi conservarla, di salvarla.", systemImage: "camera")
                        .font(.footnote).foregroundStyle(Theme.inkSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(20).frame(maxWidth: 700, alignment: .leading).frame(maxWidth: .infinity)
            }
            .background(Theme.surface)
            .navigationTitle("Ricette")
            .searchable(text: $query.search, prompt: "Titolo o ingrediente")
            .scrollDismissesKeyboard(.interactively)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Fine") { dismiss() } } }
            .navigationDestination(for: String.self) { id in
                RecipeDetailView(id: id, refine: { recipe in
                    model.conversation?.composerSuggestion = "Affina la ricetta «\(recipe.title)»: "
                    dismiss()
                }, changed: { Task { await load() } })
            }
            .task(id: query) { await load(debounce: true) }
            .refreshable { await load() }
            .onDisappear { store.cancel() }
        }
        .tint(Theme.accentText)
    }

    private var filters: some View {
        VStack(alignment: .leading, spacing: 10) {
            ErnieFlow(spacing: 8) {
                Menu {
                    Button("Tutte le categorie") { query.category = nil }
                    ForEach(store.categories) { category in
                        Button("\(category.label) (\(category.count))") { query.category = category.value }
                    }
                } label: { Label("Categoria", systemImage: "line.3.horizontal.decrease") }
                .buttonStyle(.bordered)
                Menu {
                    Button("Tutti i tag") { query.tag = nil }
                    ForEach(store.tags) { tag in Button("\(tag.name) (\(tag.count))") { query.tag = tag.name } }
                } label: { Label("Tag", systemImage: "tag") }
                .buttonStyle(.bordered)
            }
            ErnieFlow(spacing: 8) {
                if let category = query.category {
                    Button { query.category = nil } label: {
                        Label(store.categories.first(where: { $0.value == category })?.label ?? (category == "non-classificate" ? "Da organizzare" : category), systemImage: "xmark.circle.fill")
                    }.accessibilityLabel("Rimuovi filtro categoria")
                }
                if let tag = query.tag {
                    Button { query.tag = nil } label: { Label(tag, systemImage: "xmark.circle.fill") }
                        .accessibilityLabel("Rimuovi filtro tag \(tag)")
                }
                if query.isFiltered { Button("Azzera filtri") { query = RecipeQuery() } }
            }
            .font(.subheadline).buttonStyle(.bordered)
        }
    }

    private func load(append: Bool = false, debounce: Bool = false) async {
        guard let api = model.api else { return }
        await store.load(query, append: append, debounce: debounce, using: { try await api.recipes($0, offset: $1) })
    }
}

/// Contenuto senza rete, condiviso con i render di verifica.
struct RecipeLibraryContent: View {
    let recipes: [SavedRecipe]
    let total: Int
    let loaded: Bool
    let loading: Bool
    let error: String?
    let filtered: Bool
    let hasMore: Bool
    var open: (String) -> Void = { _ in }
    var retry: () -> Void = {}
    var more: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if loaded {
                Text(total == 1 ? "1 ricetta" : "\(total) ricette")
                    .font(.subheadline.weight(.medium)).foregroundStyle(Theme.inkSecondary)
            }
            if let error {
                VStack(alignment: .leading, spacing: 8) {
                    Label(error, systemImage: "exclamationmark.circle").font(.callout)
                    Button("Riprova", action: retry).buttonStyle(.bordered)
                }.foregroundStyle(Theme.inkSecondary)
            } else if loaded && recipes.isEmpty && !loading {
                VStack(alignment: .leading, spacing: 8) {
                    Text(filtered ? "Nessuna ricetta trovata" : "La tua raccolta è ancora vuota")
                        .font(.headline).foregroundStyle(Theme.ink)
                    Text(filtered ? "Prova un altro ingrediente o rimuovi un filtro." : "Le ricette che chiedi a Ernie di salvare compariranno qui.")
                        .font(.callout).foregroundStyle(Theme.inkSecondary)
                }
            }
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(recipes) { recipe in
                    Button { open(recipe.id) } label: { RecipeLibraryRow(recipe: recipe) }
                        .buttonStyle(.plain)
                    Divider()
                }
            }
            if loading { ProgressView("Carico le ricette…").frame(maxWidth: .infinity) }
            if hasMore && !loading {
                Button("Carica altre", action: more).buttonStyle(.bordered).frame(maxWidth: .infinity)
            }
        }
    }
}

struct RecipeLibraryRow: View {
    let recipe: SavedRecipe
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "fork.knife").foregroundStyle(SkillTint.recipes.color)
                .frame(width: 26).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                Text(recipe.title).font(.headline).foregroundStyle(Theme.ink)
                    .fixedSize(horizontal: false, vertical: true)
                if !RecipePresentation.meta(recipe).isEmpty {
                    Text(RecipePresentation.meta(recipe)).font(.subheadline).foregroundStyle(Theme.inkSecondary)
                }
                Text(([recipe.category ?? "Da organizzare"] + recipe.tags).joined(separator: " · "))
                    .font(.caption).foregroundStyle(Theme.accentText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.inkSecondary).accessibilityHidden(true)
        }.padding(.vertical, 14).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
    }
}

struct RecipeDetailContent: View {
    let recipe: SavedRecipe
    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            VStack(alignment: .leading, spacing: 10) {
                Text(recipe.title).font(.title2.bold()).fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
                if !RecipePresentation.meta(recipe).isEmpty { Text(RecipePresentation.meta(recipe)).font(.subheadline).foregroundStyle(Theme.inkSecondary).fixedSize(horizontal: false, vertical: true) }
                ErnieFlow(spacing: 6) {
                    ErnieChip(text: recipe.category ?? "Da organizzare", systemImage: "folder")
                    ForEach(recipe.tags, id: \.self) { ErnieChip(text: $0, systemImage: "tag") }
                }
            }
            section("Ingredienti") {
                if recipe.ingredients.isEmpty { Text("Ingredienti non indicati nella ricetta salvata.").foregroundStyle(Theme.inkSecondary) }
                ForEach(Array(recipe.ingredients.enumerated()), id: \.offset) { _, ingredient in
                    HStack(alignment: .top, spacing: 10) {
                        Text("•").accessibilityHidden(true)
                        Text(ingredient).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            section("Preparazione") {
                if recipe.steps.isEmpty { Text("Passaggi non indicati nella ricetta salvata.").foregroundStyle(Theme.inkSecondary) }
                ForEach(Array(recipe.steps.enumerated()), id: \.offset) { index, step in
                    HStack(alignment: .top, spacing: 12) {
                        Text("\(index + 1).").font(.body.weight(.semibold)).foregroundStyle(Theme.accentText)
                        Text(step).fixedSize(horizontal: false, vertical: true)
                    }.padding(.bottom, 4)
                }
            }
            if let notes = recipe.notes, !notes.isEmpty { section("Note") { Text(notes).fixedSize(horizontal: false, vertical: true) } }
            if let url = RecipePresentation.sourceURL(recipe.url) {
                Link(destination: url) { Label(recipe.source ?? "Fonte della ricetta", systemImage: "safari") }
                    .font(.callout).fixedSize(horizontal: false, vertical: true).frame(minHeight: 44, alignment: .leading)
            } else if let source = recipe.source, !source.isEmpty {
                Text("Fonte: \(source)").font(.footnote).foregroundStyle(Theme.inkSecondary)
            }
            Text("Aggiornata il \(BrainFormat.when(created: recipe.updatedAt, from: nil, to: nil))")
                .font(.caption).foregroundStyle(Theme.inkSecondary)
        }
        .foregroundStyle(Theme.ink).textSelection(.enabled).tint(Theme.accentText)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.headline).accessibilityAddTraits(.isHeader)
            content()
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct RecipeDetailView: View {
    let id: String
    var refine: (SavedRecipe) -> Void
    var changed: () -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var recipe: SavedRecipe?
    @State private var error: String?
    @State private var showBrain = false
    @State private var editing = false
    @State private var confirmDelete = false
    @State private var deleting = false
    @State private var fetchToken = UUID()
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if let recipe {
                    RecipeDetailContent(recipe: recipe)
                    Button("Apri nel Second Brain", systemImage: "brain.head.profile") { showBrain = true }
                        .buttonStyle(.bordered).frame(minHeight: 44)
                    Button("Affina con Ernie", systemImage: "slider.horizontal.3") { refine(recipe) }
                        .buttonStyle(.bordered)
                } else if error == nil { ProgressView("Carico la ricetta…").frame(maxWidth: .infinity) }
                if let error {
                    Text(error).font(.callout).foregroundStyle(Theme.inkSecondary)
                    Button("Ricarica") { Task { await load() } }.buttonStyle(.bordered)
                }
            }.padding(20).frame(maxWidth: 700, alignment: .leading).frame(maxWidth: .infinity)
        }
        .background(Theme.surface)
        .navigationTitle("Ricetta").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if recipe != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Organizza", systemImage: "folder") { editing = true }
                        Button("Elimina dalla raccolta", systemImage: "trash", role: .destructive) { confirmDelete = true }
                    } label: { Image(systemName: "ellipsis.circle") }.accessibilityLabel("Azioni sulla ricetta").disabled(deleting)
                }
            }
        }
        .task(id: id) { await load() }
        .refreshable { await load() }
        .sheet(isPresented: $showBrain) {
            if let path = BrainResource(kind: .recipe, id: id).path { SecondBrainView(initialPath: path) }
        }
        .sheet(isPresented: $editing) {
            if let recipe { RecipeOrganizeSheet(recipe: recipe) { updated in fetchToken = UUID(); self.recipe = updated; changed() } }
        }
        .confirmationDialog("Eliminare questa ricetta dalla raccolta?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Elimina ricetta", role: .destructive) { Task { await delete() } }
            Button("Annulla", role: .cancel) {}
        } message: { Text("La ricetta non comparirà più nella raccolta.") }
    }
    private func load() async {
        guard let api = model.api else { return }
        let token = UUID()
        fetchToken = token
        do {
            let fetched = try await api.recipe(id)
            guard !Task.isCancelled, fetchToken == token else { return }
            recipe = fetched; error = nil
        } catch {
            guard !Task.isCancelled, fetchToken == token else { return }
            self.error = RecipePresentation.error(error)
            if (error as? ApiError)?.status == 404 { recipe = nil }
        }
    }
    private func delete() async {
        guard let api = model.api else { return }
        deleting = true
        fetchToken = UUID()
        defer { deleting = false }
        do { try await api.deleteRecipe(id); changed(); dismiss() }
        catch { self.error = "Non è stato possibile eliminare la ricetta. Riprova." }
    }
}

struct RecipeOrganizeSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var recipe: SavedRecipe
    @State private var category: String
    @State private var tags: String
    @State private var saving = false
    @State private var error: String?
    @State private var reloadRequired = false
    var saved: (SavedRecipe) -> Void
    init(recipe: SavedRecipe, saved: @escaping (SavedRecipe) -> Void) {
        _recipe = State(initialValue: recipe)
        _category = State(initialValue: recipe.category ?? "")
        _tags = State(initialValue: recipe.tags.joined(separator: ", "))
        self.saved = saved
    }
    var body: some View {
        NavigationStack {
            Form {
                Section("Categoria") {
                    Picker("Categoria", selection: $category) {
                        Text("Da organizzare").tag("")
                        ForEach(RecipePresentation.categories, id: \.self) { Text($0).tag($0) }
                    }
                }
                Section {
                    TextField("veloce, vegetariana, famiglia", text: $tags, axis: .vertical)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    Text("\(RecipePresentation.tags(tags).count) di 10 tag").font(.caption)
                } header: { Text("Tag") } footer: { Text("Separa i tag con una virgola. Puoi inserirne al massimo 10.") }
                if let error { Section { Text(error).foregroundStyle(.red); if reloadRequired { Button("Ricarica versione aggiornata") { Task { await reload() } } } } }
            }
            .navigationTitle("Organizza ricetta").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Annulla") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Salva") { Task { await save() } }
                        .disabled(saving || reloadRequired || RecipePresentation.tags(tags).count > 10)
                }
            }
            .interactiveDismissDisabled(saving)
        }
    }
    private func save() async {
        guard let api = model.api else { return }
        saving = true
        defer { saving = false }
        do {
            let updated = try await api.organizeRecipe(recipe, category: category.isEmpty ? nil : category, tags: RecipePresentation.tags(tags))
            saved(updated); dismiss()
        } catch {
            if (error as? ApiError)?.status == 409 {
                reloadRequired = true
                self.error = RecipePresentation.error(error)
                await reload()
            } else { self.error = "Non è stato possibile salvare categoria e tag. Riprova." }
        }
    }
    private func reload() async {
        guard let api = model.api else { return }
        do {
            let current = try await api.recipe(recipe.id)
            recipe = current; category = current.category ?? ""; tags = current.tags.joined(separator: ", ")
            reloadRequired = false
            saved(current)
            error = "La ricetta è cambiata. Ho ricaricato categoria e tag aggiornati: controllali prima di salvare di nuovo."
        } catch {
            reloadRequired = true
            self.error = "La ricetta è cambiata, ma non riesco a ricaricarla. Riprova: le tue modifiche non sono state salvate."
        }
    }
}
