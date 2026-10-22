import Foundation
import SwiftUI
import Testing
import UIKit
@testable import Ernie

private func mediaFixture(_ id: String = "one", width: Int = 400, height: Int = 600) -> SavedMedia {
    SavedMedia(id: id, title: "Un’idea da ricordare", description: "Immagine di prova per la raccolta", category: "Ispirazioni", tags: ["colori", "idee", "progetti"], width: width, height: height, source: "library", organization: "automatic", version: 2, createdAt: "2026-10-18T10:00:00Z", updatedAt: "2026-10-18T10:00:00Z")
}
private actor MediaRetryHTTP {
    var requests: [URLRequest] = []
    func call(_ request: URLRequest) async throws -> (Data, URLResponse) {
        requests.append(request)
        if requests.count == 1 { throw URLError(.timedOut) }
        struct Response: Encodable { var item: SavedMedia }
        return (try JSONEncoder().encode(Response(item: mediaFixture())), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}
private actor MediaImportHTTP {
    var requests: [URLRequest] = []
    func call(_ request: URLRequest) async throws -> (Data, URLResponse) {
        requests.append(request)
        let data: Data
        if request.url?.path == "/v1/documents" {
            data = Data(#"{"id":"doc-test","title":"Testo della foto","pages":1,"chars":50,"source":"scan"}"#.utf8)
        } else {
            struct Response: Encodable { var item: SavedMedia }
            data = try JSONEncoder().encode(Response(item: mediaFixture()))
        }
        return (data, HTTPURLResponse(url: request.url!, statusCode: 201, httpVersion: nil, headerFields: nil)!)
    }
}
private actor MediaBatchHTTP {
    var requests: [URLRequest] = []
    var waiting: [CheckedContinuation<(Data, URLResponse), any Error>] = []
    func call(_ request: URLRequest) async throws -> (Data, URLResponse) {
        requests.append(request)
        return try await withCheckedThrowingContinuation { continuation in
            waiting.append(continuation)
            if waiting.count == 4 { finish() }
        }
    }
    func finish() {
        struct Response: Encodable { var item: SavedMedia }
        let data = try! JSONEncoder().encode(Response(item: mediaFixture()))
        let response = HTTPURLResponse(url: URL(string: "https://example.test/v1/media")!, statusCode: 201, httpVersion: nil, headerFields: nil)!
        for continuation in waiting { continuation.resume(returning: (data, response)) }
        waiting = []
    }
}
@MainActor private final class MediaPages {
    var pending: [CheckedContinuation<MediaPage, any Error>] = []
    func load(_ query: MediaQuery, _ offset: Int) async throws -> MediaPage { try await withCheckedThrowingContinuation { pending.append($0) } }
}
@MainActor struct MediaTests {
    private let credentials = Credentials(serverURL: URL(string: "https://example.test")!, apiKey: "media-test-only")
    private func page(_ items: [SavedMedia], total: Int? = nil, offset: Int = 0) -> MediaPage {
        MediaPage(items: items, total: total ?? items.count, offset: offset, limit: 30, categories: [], tags: [], years: [])
    }
    private func waitFor(_ condition: () -> Bool) async {
        for _ in 0..<1000 { if condition() { return }; await Task.yield() }
        #expect(condition())
    }
    @Test func retryRiusaLoStessoIdentificativoEContenuto() async throws {
        let http = MediaRetryHTTP()
        let api = ApiClient(credentials: credentials, transport: http.call)
        let upload = MediaUpload(clientId: "stable-id", data: Data([1, 2, 3]), source: "library")
        let result = try await api.uploadMedia(upload)
        #expect(result.id == "one")
        let requests = await http.requests
        #expect(requests.count == 2)
        let firstData = try #require(requests[0].httpBody), nextData = try #require(requests[1].httpBody)
        let first = try #require(try JSONSerialization.jsonObject(with: firstData) as? NSDictionary)
        let next = try #require(try JSONSerialization.jsonObject(with: nextData) as? NSDictionary)
        #expect(first == next)
        #expect(requests[0].value(forHTTPHeaderField: "Authorization") == "Bearer media-test-only")
    }
    @Test func ricercaCodificaPiuFiltriEAnnoDiCaricamento() throws {
        let q = MediaQuery(search: "A+B & caffè", category: "Casa", tag: "100%", year: 2026)
        let url = try #require(URLComponents(string: q.path(offset: 30)))
        #expect(url.queryItems?.first { $0.name == "q" }?.value == "A+B & caffè")
        #expect(url.queryItems?.first { $0.name == "year" }?.value == "2026")
        #expect(url.percentEncodedQuery?.contains("%2B") == true)
        var item = mediaFixture(); item.createdAt = "2025-12-31T23:30:00.000Z"
        #expect(item.year == "2026")
        #expect(MediaPresentation.tags(" Casa, CASA, verde ") == ["casa", "verde"])
    }
    @Test func ricercaVecchiaNonSostituisceQuellaNuova() async {
        let pages = MediaPages(), store = MediaLibraryStore()
        let a = Task { await store.load(MediaQuery(search: "prima"), using: pages.load) }
        await waitFor { pages.pending.count == 1 }
        let b = Task { await store.load(MediaQuery(search: "seconda"), using: pages.load) }
        await waitFor { pages.pending.count == 2 }
        pages.pending[1].resume(returning: page([mediaFixture("seconda")]))
        await b.value
        pages.pending[0].resume(returning: page([mediaFixture("prima")]))
        await a.value
        #expect(store.items.map(\.id) == ["seconda"])
    }
    @Test func paginazioneNonReplicaLeSchedeECancelIgnoraRisposteTardive() async {
        let store = MediaLibraryStore()
        await store.load(MediaQuery()) { _, _ in page([mediaFixture("a"), mediaFixture("b")], total: 3) }
        #expect(store.hasMore)
        await store.load(MediaQuery(), append: true) { _, offset in
            #expect(offset == 2)
            return page([mediaFixture("b"), mediaFixture("c")], total: 3, offset: 2)
        }
        #expect(store.items.map(\.id) == ["a", "b", "c"]); #expect(!store.hasMore)
        let pages = MediaPages()
        let delayed = Task { await store.load(MediaQuery(search: "altra"), using: pages.load) }
        await waitFor { !pages.pending.isEmpty }
        store.cancel(); pages.pending[0].resume(returning: page([mediaFixture("vecchia")]))
        await delayed.value
        #expect(store.items.isEmpty)
    }
    @Test func colonneConservanoOrdineAssegnazioneEDimensioniOriginali() {
        let items = (0..<6).map { mediaFixture(String($0), width: 400, height: $0.isMultiple(of: 2) ? 600 : 250) }
        let columns = MediaPresentation.columns(items, count: 2, width: 170)
        #expect(columns.flatMap { $0 }.count == 6)
        #expect(Set(columns.flatMap { $0.map(\.id) }).count == 6)
        let extended = MediaPresentation.columns(items + [mediaFixture("next")], count: 2, width: 170)
        for i in columns.indices { #expect(Array(extended[i].prefix(columns[i].count)) == columns[i]) }
        #expect(items[0].aspectRatio == CGFloat(400) / 600)
        #expect(mediaFixture(width: 1, height: 3200).displayAspectRatio == 0.25)
    }
    @Test func fotoRidottaMantieneRapportoEJPEGValido() throws {
        let image = fixtureImage(width: 1000, height: 3000, color: .systemGreen)
        let prepared = try MediaPresentation.prepare(image)
        let jpeg = try #require(UIImage(data: prepared)?.cgImage)
        #expect(jpeg.width == 800); #expect(jpeg.height == 2400)
        #expect(prepared.count < 3_000_000)
    }
    @Test func cacheSeparaAccountENonRileggeIlDisco() async throws {
        MediaImageCache.clear()
        let first = try #require(fixtureImage(width: 40, height: 60, color: .blue).jpegData(compressionQuality: 0.8))
        let second = try #require(fixtureImage(width: 60, height: 40, color: .orange).jpegData(compressionQuality: 0.8))
        let a = ApiClient(credentials: credentials) { request in
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer media-test-only")
            return (first, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/jpeg"])!)
        }
        let b = ApiClient(credentials: Credentials(serverURL: credentials.serverURL, apiKey: "second-account")) { request in
            return (second, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/jpeg"])!)
        }
        #expect(try await MediaImageCache.image("same-id", api: a).size == CGSize(width: 40, height: 60))
        #expect(try await MediaImageCache.image("same-id", api: b).size == CGSize(width: 60, height: 40))
        MediaImageCache.clear()
    }
    @Test func fotoSenzaTestoRestaInMediaSenzaInventareUnDocumento() async throws {
        let http = MediaImportHTTP(), composer = DocumentComposer()
        composer.configure(api: ApiClient(credentials: credentials, transport: http.call))
        let format = UIGraphicsImageRendererFormat.default(); format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: 400, height: 400), format: format).image { context in
            UIColor.white.setFill(); context.fill(CGRect(x: 0, y: 0, width: 400, height: 400))
        }
        composer.importImages([image], source: "photo")
        let deadline = ContinuousClock.now + .seconds(10)
        while composer.phase != .mediaReady, ContinuousClock.now < deadline {
            if case .failed = composer.phase { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(composer.phase == .mediaReady)
        #expect(composer.mediaSavedCount == 1)
        #expect(composer.ready == nil)
        #expect(await http.requests.map { $0.url?.path } == ["/v1/media"])
        composer.clear()
        #expect(composer.mediaSavedCount == 0)
    }
    @Test func scansioneConTestoSalvaFotoETestoSenzaAnalisiPerPagina() async throws {
        let http = MediaImportHTTP(), composer = DocumentComposer()
        composer.configure(api: ApiClient(credentials: credentials, transport: http.call))
        let format = UIGraphicsImageRendererFormat.default(); format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: 900, height: 500), format: format).image { context in
            UIColor.white.setFill(); context.fill(CGRect(x: 0, y: 0, width: 900, height: 500))
            ("Ricetta della torta\nIngredienti: farina e latte\nMescola e cuoci in forno" as NSString).draw(in: CGRect(x: 40, y: 50, width: 820, height: 400), withAttributes: [.font: UIFont.systemFont(ofSize: 44), .foregroundColor: UIColor.black])
        }
        composer.importImages([image], source: "scan")
        let deadline = ContinuousClock.now + .seconds(10)
        while composer.ready == nil, ContinuousClock.now < deadline {
            if case .failed = composer.phase { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(composer.ready?.id == "doc-test")
        #expect(composer.mediaSavedCount == 1)
        let requests = await http.requests
        #expect(requests.map { $0.url?.path } == ["/v1/media", "/v1/documents"])
        let data = try #require(requests.first?.httpBody)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(body["autoOrganize"] as? Bool == false)
        #expect((body["ocrText"] as? String)?.contains("farina") == true)
        composer.clear()
    }
    @Test func chatAvviaTutteLeQuattroFotoPrimaDiAspettareUnEsito() async throws {
        let http = MediaBatchHTTP(), composer = DocumentComposer()
        composer.configure(api: ApiClient(credentials: credentials, transport: http.call))
        let image = fixtureImage(width: 40, height: 60, color: .orange)
        composer.importImages([image, image, image, image], source: "photo")
        let deadline = ContinuousClock.now + .seconds(10)
        while composer.phase != .mediaReady, ContinuousClock.now < deadline {
            if case .failed = composer.phase { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(composer.phase == .mediaReady)
        #expect(composer.mediaSavedCount == 4)
        #expect(await http.requests.count == 4)
        composer.clear(); await http.finish()
    }
    @Test func chatNonScartaSilenziosamenteUnaFotoNonLetta() async throws {
        let http = MediaImportHTTP(), composer = DocumentComposer()
        composer.configure(api: ApiClient(credentials: credentials, transport: http.call))
        let image = fixtureImage(width: 40, height: 60, color: .orange)
        composer.importImages(count: 4, source: "photo") { index in
            if index == 1 { throw DocumentReader.ReadError.unreadable }
            return image
        }
        let deadline = ContinuousClock.now + .seconds(10)
        while ContinuousClock.now < deadline {
            if case .failed = composer.phase { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(composer.mediaSavedCount == 3)
        #expect(composer.statusText.contains("3 di 4"))
        #expect(await http.requests.count == 3)
        composer.clear()
    }
    @Test func renderGalleriaChiaroScuroETestoGrande() throws {
        var items = (0..<6).map { mediaFixture(String($0), width: 400, height: [500, 300, 650, 400, 550, 300][$0]) }
        let titles = ["Luce e colori", "Idee per la casa", "Appunti di un viaggio", "La ricetta da provare", "Una passeggiata nel verde", "Un progetto da ricordare"]
        let colors: [UIColor] = [.systemTeal, .systemOrange, .systemIndigo, .systemPink, .systemGreen, .systemBrown]
        var previews: [String: UIImage] = [:]
        for i in items.indices {
            items[i].title = titles[i]
            previews[items[i].id] = fixtureImage(width: items[i].width, height: items[i].height, color: colors[i])
        }
        for (name, width, scheme, size) in [("light", CGFloat(390), ColorScheme.light, DynamicTypeSize.large), ("dark", CGFloat(390), .dark, .large), ("large", CGFloat(320), .light, .xxxLarge)] {
            let content = VStack(alignment: .leading, spacing: 20) {
                Text("La tua raccolta visiva").font(.title2.bold()).foregroundStyle(Theme.ink)
                MediaGallery(items: items, width: width - 32, previews: previews)
            }.padding(16).frame(width: width).background(Theme.ground).environment(\.colorScheme, scheme).environment(\.dynamicTypeSize, size)
            let renderer = ImageRenderer(content: content); renderer.scale = 2
            let image = try #require(renderer.uiImage)
            #expect(image.size.width == width)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("ernie-media-\(name).png")
            try #require(image.pngData()).write(to: url)
            print("MEDIA_SNAPSHOT: \(url.path)")
        }
    }
    private func fixtureImage(width: Int, height: Int, color: UIColor) -> UIImage {
        let size = CGSize(width: width, height: height)
        let format = UIGraphicsImageRendererFormat.default(); format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            color.withAlphaComponent(0.8).setFill(); ctx.fill(CGRect(origin: .zero, size: size))
            UIColor.white.withAlphaComponent(0.5).setFill()
            UIBezierPath(ovalIn: CGRect(x: CGFloat(width) * 0.15, y: CGFloat(height) * 0.15, width: CGFloat(width) * 0.6, height: CGFloat(width) * 0.6)).fill()
        }
    }
}
