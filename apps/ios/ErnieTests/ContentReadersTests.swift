import Foundation
import Testing
@testable import Ernie

@MainActor private final class DeferredContentReaders {
    var continuation: CheckedContinuation<ContentReadersReport, Never>?
    func load() async -> ContentReadersReport {
        await withCheckedContinuation { continuation = $0 }
    }
    func complete(_ report: ContentReadersReport) {
        continuation?.resume(returning: report); continuation = nil
    }
}

@MainActor struct ContentReadersTests {
    private let credentials = Credentials(serverURL: URL(string: "https://example.test")!, apiKey: "test-readers")
    private let fixture = #"{"readers":[{"id":"youtube_captions","name":"Sottotitoli YouTube","configured":true,"description":"Testo pubblico disponibile quando il video espone i sottotitoli.","lastAttempt":null},{"id":"youtube_video","name":"Analisi visiva YouTube","configured":true,"description":"Audio e immagini del video.","lastAttempt":{"at":"2026-10-27T12:00:00.123Z","outcome":"credits","message":"Il credito non è sufficiente.","durationMs":1250}},{"id":"instagram","name":"Instagram","configured":false,"description":"Lettura non collegata.","lastAttempt":null}],"updatedAt":"2026-10-27T12:05:00Z"}"#

    private func report(_ name: String = "lettore") -> ContentReadersReport {
        .init(readers: [.init(id: "youtube_captions", name: name, configured: true, description: "Testo pubblico", lastAttempt: nil)], updatedAt: "2026-10-27T12:00:00Z")
    }

    @Test func GETAutenticataLeggeSoloLoStatoSenzaCorpoONuoveProve() async throws {
        let data = Data(fixture.utf8)
        let api = ApiClient(credentials: credentials, transport: { request in
            #expect(request.httpMethod == "GET")
            #expect(request.url?.path == "/v1/content-readers")
            #expect(request.url?.query == nil)
            #expect(request.httpBody == nil)
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-readers")
            return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        })
        let report = try await api.contentReaders()
        #expect(report.readers.count == 3)
        #expect(report.readers[0].configured)
        #expect(report.readers[0].lastAttempt == nil) // Configurato non significa già provato.
        #expect(report.readers[1].lastAttempt?.outcome == .credits)
        #expect(report.readers[1].lastAttempt?.durationMs == 1250)
        #expect(report.readers[2].configured == false)
    }

    @Test func CampiNuoviEsitoSconosciutoETentativoAssenteRestanoLeggibili() throws {
        let json = #"{"readers":[{"id":"future_reader","name":"Nuovo lettore","configured":true,"description":"Disponibile in una versione futura.","capabilities":["new"],"lastAttempt":{"at":"2026-10-27T12:00:00Z","outcome":"future_status","message":"Esito aggiornato","durationMs":10}},{"id":"instagram","name":"Instagram","configured":false,"description":"Non collegato"}],"updatedAt":"2026-10-27T12:00:00Z","futureField":true}"#
        let report = try JSONDecoder().decode(ContentReadersReport.self, from: Data(json.utf8))
        #expect(report.readers[0].id == "future_reader")
        #expect(report.readers[0].lastAttempt?.outcome == .unknown)
        #expect(ContentReaderPresentation.title(.unknown) == "Esito non riconosciuto")
        #expect(report.readers[1].lastAttempt == nil)
        #expect(ContentReaderPresentation.date(report.updatedAt) != nil)
        #expect(ContentReaderPresentation.date("2026-10-27T12:00:00.123Z") != nil)
    }

    @Test func ServerPrecedente404HaUnMessaggioComprensibile() async {
        let api = ApiClient(credentials: credentials, transport: { request in
            (Data(#"{"error":"not_found","message":"Route not found"}"#.utf8),
             HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil)!)
        })
        let store = ContentReadersStore()
        await store.load(credentials: credentials, using: api.contentReaders)
        #expect(!store.loading)
        #expect(store.report(for: credentials) == nil)
        #expect(store.error == "Questo server non dispone ancora della diagnostica dei lettori. Sarà disponibile dopo il suo aggiornamento.")
    }

    @Test(arguments: [false, true]) func RispostaInRitardoNonSovrascriveUnRefreshONuovoAccount(cambioAccount: Bool) async {
        let store = ContentReadersStore()
        let pending = DeferredContentReaders()
        let old = report("vecchio"), latest = report("nuovo")
        let task = Task { await store.load(credentials: credentials, using: pending.load) }
        for _ in 0..<1000 {
            if pending.continuation != nil { break }
            await Task.yield()
        }
        #expect(pending.continuation != nil)
        let next = cambioAccount ? Credentials(serverURL: credentials.serverURL, apiKey: "new-account") : credentials
        await store.load(credentials: next, using: { latest })
        pending.complete(old)
        await task.value
        #expect(store.report(for: next) == latest)
        if cambioAccount { #expect(store.report(for: credentials) == nil) }
        store.clear()
        #expect(store.report(for: next) == nil)
        #expect(store.error == nil)
    }

    @Test func UscitaDallaSchermataNonRipristinaDatiAlRitornoDiUnaRichiesta() async {
        let store = ContentReadersStore()
        let pending = DeferredContentReaders()
        let snapshot = report()
        let task = Task { await store.load(credentials: credentials, using: pending.load) }
        for _ in 0..<1000 {
            if pending.continuation != nil { break }
            await Task.yield()
        }
        #expect(pending.continuation != nil)
        store.clear()
        pending.complete(snapshot)
        await task.value
        #expect(!store.loading)
        #expect(store.report(for: credentials) == nil)
    }
}
