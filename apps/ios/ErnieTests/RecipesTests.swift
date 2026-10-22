import Foundation
import SwiftUI
import Testing
@testable import Ernie

private enum RecipeFixtures {
    static let soup = SavedRecipe(id: "00000000-0000-4000-8000-000000000001", title: "Zuppa di ceci e rosmarino", ingredients: ["400 g di ceci cotti", "1 carota", "500 ml di brodo vegetale", "2 cucchiai di olio", "1 rametto di rosmarino"], steps: ["Taglia la carota e falla ammorbidire con l’olio.", "Aggiungi i ceci e il brodo. Cuoci per 20 minuti.", "Profuma con il rosmarino e servi calda."], time: "30 minuti", servings: "2 porzioni", source: "Quaderno di famiglia", url: "https://example.org/ricette/zuppa", notes: "Se serve, aggiungere poco brodo caldo durante la cottura.", tags: ["vegetariana", "veloce"], category: "Primi", version: 3, updatedAt: "2026-10-17T12:00:00.000Z")
    static var cake: SavedRecipe {
        var recipe = soup
        recipe.id = "00000000-0000-4000-8000-000000000002"
        recipe.title = "Torta di mele della domenica"
        recipe.category = "Dolci"
        recipe.tags = ["famiglia"]
        recipe.time = "50 minuti"
        recipe.servings = "6 porzioni"
        return recipe
    }
    static func page(_ recipes: [SavedRecipe], total: Int = 2, offset: Int = 0) -> RecipePage {
        RecipePage(recipes: recipes, total: total, offset: offset, limit: 30,
                   categories: [.init(value: "Primi", label: "Primi", count: 1), .init(value: "Dolci", label: "Dolci", count: 1)],
                   tags: [.init(name: "veloce", count: 1)])
    }
}

@MainActor private final class RecipeRequests {
    var queries: [(RecipeQuery, Int)] = []
    var pending: [CheckedContinuation<RecipePage, any Error>] = []
    func load(_ query: RecipeQuery, _ offset: Int) async throws -> RecipePage {
        queries.append((query, offset))
        return try await withCheckedThrowingContinuation { pending.append($0) }
    }
}

struct RecipeTests {
    @Test func decoderRaccoltaESchedeChatCompatibili() throws {
        let recipe = try JSONDecoder().decode(SavedRecipe.self, from: JSONEncoder().encode(RecipeFixtures.soup))
        #expect(recipe.ingredients.first == "400 g di ceci cotti")
        #expect(recipe.version == 3)
        #expect(recipe.tags == ["vegetariana", "veloce"])
        let old = #"{"title":"Zuppa","ingredients":["ceci"],"steps":["Cuoci"]}"#
        let unsaved = try JSONDecoder().decode(RecipeItem.self, from: Data(old.utf8))
        #expect(unsaved.recipeId == nil)
        #expect(unsaved.category == nil)
        #expect(unsaved.tags == nil)
        let saved = old.replacingOccurrences(of: #""title":"Zuppa""#, with: #""title":"Zuppa","recipeId":"00000000-0000-4000-8000-000000000001","category":"Primi","tags":["veloce"]"#)
        let item = try JSONDecoder().decode(RecipeItem.self, from: Data(saved.utf8))
        #expect(item.id == RecipeFixtures.soup.id)
        #expect(item.category == "Primi")
        #expect(item.tags == ["veloce"])
    }

    @Test func filtriCombinatiNellaQuerySenzaInterpretareCaratteriSpeciali() throws {
        var query = RecipeQuery(search: " ceci & limone + ", category: "non-classificate", tag: "senza latte / uova")
        #expect(query.path().contains("%2B"))
        let components = try #require(URLComponents(string: query.path(offset: 30)))
        let items = try #require(components.queryItems)
        #expect(items.first(where: { $0.name == "q" })?.value == "ceci & limone +")
        #expect(items.first(where: { $0.name == "category" })?.value == "non-classificate")
        #expect(items.first(where: { $0.name == "tag" })?.value == "senza latte / uova")
        #expect(items.first(where: { $0.name == "offset" })?.value == "30")
        #expect(items.first(where: { $0.name == "limit" })?.value == "30")
        query.category = nil
        #expect(!query.path().contains("category="))
        #expect(query.isFiltered)
        #expect(!RecipeQuery().isFiltered)
    }

    @Test func fontiSoloHTTPETagNormalizzatiConLimiteVisibile() {
        #expect(RecipePresentation.sourceURL("https://example.org/ricetta") != nil)
        #expect(RecipePresentation.sourceURL("http://example.org/ricetta") != nil)
        for raw in ["javascript:alert(1)", "file:///etc/passwd", "ernie://voice", "https://", "https://utente:password@example.org/"] {
            #expect(RecipePresentation.sourceURL(raw) == nil)
        }
        #expect(RecipePresentation.tags(" veloce, famiglia, Veloce, , vegetariana ") == ["veloce", "famiglia", "vegetariana"])
        #expect(RecipePresentation.tags((1...11).map { "tag\($0)" }.joined(separator: ",")).count == 11) // La UI impedisce il salvataggio, senza tagliare dati.
        #expect(RecipePresentation.error(ApiError(status: 409, code: "version_conflict", message: "")).contains("ricaricato"))
        #expect(RecipePresentation.error(ApiError(status: 404, code: "not_found", message: "")).contains("non è più"))
    }
}

@MainActor struct RecipeStoreTests {
    private func waitFor(_ condition: () -> Bool) async {
        for _ in 0..<1000 { if condition() { return }; await Task.yield() }
        #expect(condition())
    }

    @Test func rispostaVecchiaNonSostituisceLaNuovaRicerca() async {
        let store = RecipeLibraryStore()
        let requests = RecipeRequests()
        let first = Task { await store.load(RecipeQuery(search: "zuppa"), using: requests.load) }
        await waitFor { requests.pending.count == 1 }
        let second = Task { await store.load(RecipeQuery(search: "torta"), using: requests.load) }
        await waitFor { requests.pending.count == 2 }
        requests.pending[1].resume(returning: RecipeFixtures.page([RecipeFixtures.cake], total: 1))
        await second.value
        requests.pending[0].resume(returning: RecipeFixtures.page([RecipeFixtures.soup], total: 1))
        await first.value
        #expect(store.recipes.map(\.title) == [RecipeFixtures.cake.title])
        #expect(store.query.search == "torta")
        #expect(!store.loading)
    }

    @Test func annullamentoNonMostraErroriONuoviRisultati() async {
        let store = RecipeLibraryStore()
        let requests = RecipeRequests()
        let pending = Task { await store.load(RecipeQuery(), using: requests.load) }
        await waitFor { requests.pending.count == 1 }
        store.cancel()
        pending.cancel()
        requests.pending[0].resume(returning: RecipeFixtures.page([RecipeFixtures.soup]))
        await pending.value
        #expect(store.recipes.isEmpty)
        #expect(store.error == nil)
        #expect(!store.loading)
    }

    @Test func cambiareQueryAnnullaAncheIlTrasportoPrecedente() async {
        let store = RecipeLibraryStore()
        var started = false
        var cancelled = false
        let old = Task {
            await store.load(RecipeQuery(search: "zuppa"), using: { _, _ in
                started = true
                do { try await Task.sleep(for: .seconds(60)) }
                catch { cancelled = Task.isCancelled; throw error }
                return RecipeFixtures.page([RecipeFixtures.soup])
            })
        }
        await waitFor { started }
        await store.load(RecipeQuery(search: "torta"), using: { _, _ in RecipeFixtures.page([RecipeFixtures.cake], total: 1) })
        await old.value
        #expect(cancelled)
        #expect(store.recipes.map(\.id) == [RecipeFixtures.cake.id])
        #expect(store.error == nil)
    }

    @Test func paginazioneUsaOffsetRealeEvitaDuplicatiEDoppioInvio() async {
        let store = RecipeLibraryStore()
        let requests = RecipeRequests()
        await store.load(RecipeQuery(), using: { _, _ in RecipeFixtures.page([RecipeFixtures.soup], total: 3) })
        #expect(store.hasMore)
        let next = Task { await store.load(RecipeQuery(), append: true, using: requests.load) }
        await waitFor { requests.pending.count == 1 }
        await store.load(RecipeQuery(), append: true, using: requests.load)
        #expect(requests.pending.count == 1)
        #expect(requests.queries.first?.1 == 1)
        requests.pending[0].resume(returning: RecipeFixtures.page([RecipeFixtures.soup, RecipeFixtures.cake], total: 3, offset: 1))
        await next.value
        #expect(store.recipes.count == 2)
        #expect(store.total == 3)
        #expect(!store.hasMore)
    }

    @Test func errorePaginazioneConservaDatiEVuotoNonEUnErrore() async {
        let store = RecipeLibraryStore()
        await store.load(RecipeQuery(), using: { _, _ in RecipeFixtures.page([RecipeFixtures.soup]) })
        await store.load(RecipeQuery(), append: true, using: { _, _ in throw URLError(.notConnectedToInternet) })
        #expect(store.recipes.count == 1)
        #expect(store.error != nil)
        #expect(store.hasMore)
        await store.load(RecipeQuery(search: "nessuna"), using: { _, _ in RecipeFixtures.page([], total: 0) })
        #expect(store.recipes.isEmpty)
        #expect(store.error == nil)
        #expect(store.loaded)
        #expect(!store.hasMore)
    }

    @Test func paginaVuotaNonOffreCaricaAltreAllInfinito() async {
        let store = RecipeLibraryStore()
        await store.load(RecipeQuery(), using: { _, _ in RecipeFixtures.page([], total: 100) })
        #expect(!store.hasMore)
    }

    @Test func renderRaccoltaESchedaChiaroScuroETestoGrande() throws {
        for (name, width, size, scheme) in [("light", CGFloat(390), DynamicTypeSize.large, ColorScheme.light), ("dark", CGFloat(390), .large, .dark), ("small", CGFloat(320), .xxxLarge, .light)] {
            let list = VStack(alignment: .leading, spacing: 16) {
                Text("Ricette").font(.title.bold()).foregroundStyle(Theme.ink)
                Label("Titolo o ingrediente", systemImage: "magnifyingglass").foregroundStyle(Theme.inkSecondary)
                ErnieFlow(spacing: 8) { ErnieChip(text: "Categoria", systemImage: "line.3.horizontal.decrease"); ErnieChip(text: "Tag", systemImage: "tag") }
                RecipeLibraryContent(recipes: [RecipeFixtures.soup, RecipeFixtures.cake], total: 2, loaded: true, loading: false, error: nil, filtered: false, hasMore: false)
            }.padding(20).frame(width: width).background(Theme.surface)
                .environment(\.dynamicTypeSize, size).environment(\.colorScheme, scheme)
            try render(list, name: "library-\(name)")
            let detail = RecipeDetailContent(recipe: RecipeFixtures.soup).padding(20).frame(width: width).background(Theme.surface)
                .environment(\.dynamicTypeSize, size).environment(\.colorScheme, scheme)
            try render(detail, name: "detail-\(name)")
        }
    }
    private func render(_ view: some View, name: String) throws {
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        let data = try #require(renderer.uiImage?.pngData())
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("ernie-recipes-\(name).png")
        try data.write(to: url)
        print("RECIPE_SNAPSHOT: \(url.path)")
    }
}
