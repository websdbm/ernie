import Foundation
import LocalAuthentication
import PDFKit
import Testing
import UIKit
@testable import Ernie

private actor DeferredHTTP {
    var requests: [URLRequest] = []
    var pending: [CheckedContinuation<(Data, URLResponse), any Error>] = []
    var count: Int { pending.count }
    func call(_ request: URLRequest) async throws -> (Data, URLResponse) {
        requests.append(request)
        return try await withCheckedThrowingContinuation { pending.append($0) }
    }
    func complete(_ index: Int = 0, json: String, status: Int = 200) {
        pending[index].resume(returning: (Data(json.utf8), HTTPURLResponse(url: URL(string: "https://example.org")!, statusCode: status, httpVersion: nil, headerFields: nil)!))
    }
}

private final class UnavailableAuthentication: LAContext, @unchecked Sendable {
    override func canEvaluatePolicy(_ policy: LAPolicy, error: NSErrorPointer) -> Bool { false }
}

@MainActor struct LifecycleTests {
    private let credentials = Credentials(serverURL: URL(string: "https://example.org")!, apiKey: "test-only")
    private func waitForRequest(_ http: DeferredHTTP, count: Int = 1) async {
        for _ in 0..<1000 { if await http.count >= count { return }; await Task.yield() }
        #expect(await http.count >= count)
    }

    @Test func logoutRimuoveSoloIlTokenConLeCredenzialiCatturate() async {
        let http = DeferredHTTP()
        let api = ApiClient(credentials: credentials, transport: http.call)
        let task = Task { try await api.unregisterDevice(token: "012345abcdef") }
        await waitForRequest(http)
        let request = await http.requests.first
        #expect(request?.url?.path == "/v1/devices/012345abcdef")
        #expect(request?.httpMethod == "DELETE")
        #expect(request?.value(forHTTPHeaderField: "Authorization") == "Bearer test-only")
        await http.complete(json: "", status: 204)
        _ = try? await task.value
    }

    @Test func autenticazioneNonDisponibileNonAutorizza() async {
        #expect(await !StepUp.authenticate(reason: "Test", context: UnavailableAuthentication()))
    }

    @Test func logoutNonReinserisceNotificheDelVecchioAccount() async {
        let http = DeferredHTTP()
        let store = InboxStore()
        store.configure(api: ApiClient(credentials: credentials, transport: http.call))
        var cards: [NotificationCard] = []
        store.onCards = { cards += $0 }
        let task = Task { await store.refresh() }
        await waitForRequest(http)
        store.reset()
        store.configure(api: ApiClient(credentials: credentials))
        store.onCards = { cards += $0 }
        await http.complete(json: #"{"notifications":[{"id":"old","kind":"test","title":"Privato","body":"Account precedente","createdAt":"2026-10-17T12:00:00Z"}]}"#)
        await task.value
        #expect(cards.isEmpty)
        #expect(store.lastError == nil)
        #expect(await http.count == 1) // Nessuna marcatura di lettura dopo l’uscita.
    }

    @Test(arguments: [200, 503]) func rispostaSpesaVecchiaNonSovrascriveIlBloccoPiuRecente(status: Int) async {
        let http = DeferredHTTP()
        let store = ShoppingStore()
        store.configure(api: ApiClient(credentials: credentials, transport: http.call))
        let task = Task { await store.refresh("list") }
        await waitForRequest(http)
        store.apply(.shoppingList(.init(listId: "list", name: "Nuova", status: "active", items: [])))
        await http.complete(json: #"{"block":{"kind":"shopping_list","listId":"list","name":"Vecchia","status":"active","items":[]}}"#, status: status)
        await task.value
        #expect(store.lists["list"]?.name == "Nuova")
        #expect(store.lastError == nil)
        store.configure(api: nil)
        #expect(store.lists.isEmpty)
    }

    @Test func catalogoSpesaCaricaAncheListeMaiAperteEArchivi() async {
        let http = DeferredHTTP()
        let store = ShoppingStore()
        store.configure(api: ApiClient(credentials: credentials, transport: http.call))
        let task = Task { await store.load() }
        await waitForRequest(http)
        let request = await http.requests.first
        #expect(request?.url?.path == "/v1/shopping/lists")
        #expect(request?.url?.query == "archived=1")
        await http.complete(json: #"{"lists":[{"id":"new","name":"Cena","status":"active","open":3,"bought":1},{"id":"old","name":"Vacanze","status":"archived","open":0,"bought":4}]}"#)
        await task.value
        #expect(store.summaries.map(\.id) == ["new", "old"])
        #expect(store.summaries.first?.open == 3)
        #expect(store.summaries.last?.archived == true)
        #expect(store.lists.isEmpty) // L'indice non fabbrica schede senza le loro voci.
    }

    @Test func catalogoInRitardoConservaCreazioniERinomineDallaChat() async {
        let http = DeferredHTTP()
        let store = ShoppingStore()
        store.configure(api: ApiClient(credentials: credentials, transport: http.call))
        store.apply(.shoppingList(.init(listId: "list", name: "Prima", status: "active", items: [])))
        let task = Task { await store.load() }
        await waitForRequest(http)
        store.apply(.shoppingList(.init(listId: "list", name: "Dopo", status: "active", items: [
            .init(id: "item", name: "Farina", checked: false)
        ])))
        store.apply(.shoppingList(.init(listId: "created", name: "Nuova", status: "active", items: [])))
        await http.complete(json: #"{"lists":[{"id":"list","name":"Prima","status":"active","open":0,"bought":0}]}"#)
        await task.value
        #expect(store.summaries.first?.name == "Dopo")
        #expect(store.summaries.first?.open == 1)
        #expect(store.summaries.map(\.id) == ["list", "created"])
    }

    @Test func catalogoRimuoveListeEliminateENonLeFaRiComparireDaUnDettaglioInRitardo() async {
        let http = DeferredHTTP()
        let store = ShoppingStore()
        store.configure(api: ApiClient(credentials: credentials, transport: http.call))
        store.apply(.shoppingList(.init(listId: "list", name: "Cena", status: "active", items: [])))
        let detail = Task { await store.refresh("list") }
        await waitForRequest(http)
        let catalog = Task { await store.load() }
        await waitForRequest(http, count: 2)
        await http.complete(1, json: #"{"lists":[]}"#)
        await catalog.value
        await http.complete(0, json: #"{"block":{"kind":"shopping_list","listId":"list","name":"Cena","status":"active","items":[]}}"#)
        await detail.value
        #expect(store.summaries.isEmpty)
        #expect(store.lists.isEmpty)
        #expect(store.isDeleted("list"))
    }

    @Test func catalogoSpesaNonPassaDaUnAccountAllAltro() async {
        let http = DeferredHTTP()
        let store = ShoppingStore()
        store.configure(api: ApiClient(credentials: credentials, transport: http.call))
        let task = Task { await store.load() }
        await waitForRequest(http)
        store.configure(api: ApiClient(credentials: credentials))
        await http.complete(json: #"{"lists":[{"id":"private","name":"Privata","status":"active","open":1,"bought":0}]}"#)
        await task.value
        #expect(store.summaries.isEmpty)
        #expect(store.catalogError == nil)
    }

    @Test func catalogoOfflineConservaLeListeEUnSuccessoRimuoveLErrore() async {
        let http = DeferredHTTP()
        let store = ShoppingStore()
        store.configure(api: ApiClient(credentials: credentials, transport: http.call))
        store.apply(.shoppingList(.init(listId: "list", name: "Cena", status: "active", items: [])))
        let failed = Task { await store.load() }
        await waitForRequest(http)
        await http.complete(json: #"{"error":"unavailable","message":"Rete non disponibile"}"#, status: 503)
        await failed.value
        #expect(store.summaries.count == 1)
        #expect(store.catalogError != nil)
        let retry = Task { await store.load() }
        await waitForRequest(http, count: 2)
        await http.complete(1, json: #"{"lists":[{"id":"list","name":"Cena","status":"active","open":2,"bought":0}]}"#)
        await retry.value
        #expect(store.summaries.first?.open == 2)
        #expect(store.catalogError == nil)
    }

    @Test func logoutNonRipristinaPromemoriaDaRichiestaInVolo() async {
        let http = DeferredHTTP()
        let store = ReminderStore()
        store.configure(api: ApiClient(credentials: credentials, transport: http.call))
        let task = Task { await store.refresh() }
        await waitForRequest(http)
        store.configure(api: nil)
        await http.complete(json: #"{"reminders":[{"id":"old","text":"Privato","status":"scheduled","at":"2099-01-01T10:00:00Z"}]}"#)
        await task.value
        #expect(store.items.isEmpty)
        #expect(store.lastError == nil)
        #expect(store.replaced.isEmpty)
    }

    @Test func importAnnullatoNonSovrascriveIlNuovoAllegato() async {
        let http = DeferredHTTP()
        let composer = DocumentComposer()
        composer.configure(api: ApiClient(credentials: credentials, transport: http.call))
        composer.start { _ in ImportedDocument(title: "Primo", source: "photo", pages: ["Testo precedente"]) }
        await waitForRequest(http)
        composer.clear()
        composer.start { _ in ImportedDocument(title: "Secondo", source: "photo", pages: ["Testo corrente"]) }
        await waitForRequest(http, count: 2)
        await http.complete(0, json: #"{"error":"failed","message":"Errore vecchio"}"#, status: 500)
        for _ in 0..<20 { await Task.yield() }
        #expect(composer.phase == .uploading)
        composer.clear()
        await http.complete(1, json: #"{"error":"failed","message":"Annullato"}"#, status: 500)
        for _ in 0..<20 { await Task.yield() }
        #expect(composer.phase == .idle)
    }

    @Test func vecchiaSessioneNonAvanzaIlCursoreWebSocket() async throws {
        let id = Ids.new()
        let client = ProtocolClient(credentials: credentials, sessionId: id)
        let old = AgentEvent(payload: .sessionPong(.init(serverTime: "2026-10-17T12:00:00Z")), sessionId: Ids.new(), correlationId: Ids.new(), seq: 999)
        await client.handleIncoming(try old.encoded())
        #expect(await client.lastSeq == -1)
        let current = AgentEvent(payload: .sessionPong(.init(serverTime: "2026-10-17T12:00:00Z")), sessionId: id, correlationId: Ids.new(), seq: 2)
        await client.handleIncoming(try current.encoded())
        #expect(await client.lastSeq == 2)
    }

    @Test func pdfOCRUsaPixelLimitatiAncheSuSchermoRetina() throws {
        func page(_ size: CGSize) throws -> PDFPage {
            let data = UIGraphicsPDFRenderer(bounds: CGRect(origin: .zero, size: size)).pdfData { $0.beginPage() }
            return try #require(PDFDocument(data: data)?.page(at: 0))
        }
        let regular = try #require(DocumentReader.render(page: page(CGSize(width: 600, height: 400))))
        #expect(regular.width == 1250)
        #expect(abs(regular.height - 833) <= 1)
        let huge = try #require(DocumentReader.render(page: page(CGSize(width: 10000, height: 20000))))
        #expect(max(huge.width, huge.height) <= 2400)
        #expect(DocumentReader.render(page: try page(CGSize(width: 600, height: 400)), dpi: .infinity) == nil)
    }

    @Test func erroreReteNonDichiaraLaNotaInesistente() {
        #expect(BrainLoadingError.message(URLError(.timedOut), title: "Anna").contains("caricare"))
        #expect(BrainLoadingError.message(ApiError(status: 404, code: "not_found", message: ""), title: "Anna").contains("non esiste"))
    }

    @Test func OCRAnnullatoSiFermaPrimaDellaPrimaPagina() async {
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await DocumentReader.read(images: [UIImage()], source: "photo") { _, _ in }
        }
        task.cancel()
        do { _ = try await task.value; Issue.record("Lettura annullata non deve riuscire") }
        catch { #expect(error is CancellationError) }
    }
}
