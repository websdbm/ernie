import Foundation
import Testing
@testable import Ernie

struct WidgetLinkTests {
    @Test func destinazioniDistinteConContrattoCondiviso() throws {
        #expect(Set(AppLink.allCases.map(\.url)).count == 5)
        for link in AppLink.allCases { #expect(AppLink(url: link.url) == link) }
        #expect(AppLink(url: URL(string: "ernie://reminders")!) == .reminders)
        #expect(AppLink(url: URL(string: "ernie://automations")!) == .automations)
        #expect(AppLink(url: URL(string: "ernie://voice")!) == .voice)
        #expect(AppLink(url: URL(string: "ernie://chat")!) == .chat)
        for raw in ["https://chat", "ernie://unknown", "ernie://voice/execute", "ernie://chat?send=hello", "ernie://user@voice", "ernie://voice#action", "ernie://chat:80"] {
            #expect(AppLink(url: URL(string: raw)!) == nil)
        }
    }

    @Test func APIAutomazioniLeggeSoloAccountCorrenteESeparaPromemoria() async throws {
        let json = #"{"automations":[{"id":"a","key":"monitor","title":"Prezzi voli","enabled":true,"pausedReason":null,"trigger":{"type":"cron","pattern":"0 9 * * *"},"webhook":{"secret":"not-decoded"}},{"id":"b","key":"promemoria_1","title":"Dentista","enabled":true,"pausedReason":null,"trigger":{"type":"once","at":"2026-10-22T10:00:00Z"}},{"id":"c","key":"paused","title":"Controllo","enabled":false,"pausedReason":"provider_error","trigger":{"type":"event"}},{"id":"d","key":"off","title":"Spenta","enabled":false,"pausedReason":null,"trigger":{"type":"webhook"}}]}"#
        let api = ApiClient(credentials: .init(serverURL: URL(string: "https://example.test")!, apiKey: "widget-test"), transport: { request in
            #expect(request.httpMethod == "GET")
            #expect(request.url?.path == "/v1/automations")
            #expect(request.url?.query == nil)
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer widget-test")
            return (Data(json.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        })
        let items = try await api.automations()
        #expect(items.map(\.id) == ["a", "c", "d"])
        #expect(items.map(\.status) == ["Attiva", "In pausa", "Disattivata"])
        #expect(items.map(\.schedule) == ["Ricorrente", "Al verificarsi di un evento", "Su richiesta esterna"])
    }

    @Test func erroreAutenticazioneNonDiventaElencoVuoto() async throws {
        let api = ApiClient(credentials: .init(serverURL: URL(string: "https://example.test")!, apiKey: "test"), transport: { request in
            (Data(#"{"error":"unauthorized","message":"Accesso richiesto"}"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil, headerFields: nil)!)
        })
        do { _ = try await api.automations(); Issue.record("Atteso errore 401") }
        catch let error as ApiError { #expect(error.status == 401) }
    }
}
