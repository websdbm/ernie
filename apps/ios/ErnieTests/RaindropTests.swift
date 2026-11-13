import Foundation
import Testing
@testable import Ernie

struct RaindropTests {
    let credentials = Credentials(serverURL: URL(string: "https://example.test")!, apiKey: "test-ernie-key")
    let status = #"{"configured":true,"enabled":true,"connected":true,"account":{"id":2,"name":"Synthetic","pro":false},"connectedAt":"2026-11-13T12:00:00Z"}"#
    @Test func tokenSoloNelCorpoAutenticatoNonNegliURL() async throws {
        let data = Data(status.utf8)
        let api = ApiClient(credentials: credentials, transport: { req in
            #expect(req.httpMethod == "PUT")
            #expect(req.url?.path == "/v1/raindrop/connection")
            #expect(req.url?.query == nil)
            #expect(req.value(forHTTPHeaderField: "Authorization") == "Bearer test-ernie-key")
            let body = try #require(try JSONSerialization.jsonObject(with: req.httpBody!) as? [String: String])
            #expect(body == ["token": "synthetic-token-only"])
            return (data, HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        })
        let result = try await api.raindropConnect(token: "synthetic-token-only")
        #expect(result.connected && result.enabled)
        #expect(result.account?.name == "Synthetic")
    }
    @Test func ricercaPaginataEScollegamentoUsanoSoloIlProprioAccount() async throws {
        let api = ApiClient(credentials: credentials, transport: { req in
            #expect(req.url?.path == "/v1/raindrop/search")
            #expect(req.httpMethod == "POST")
            let body = try #require(try JSONSerialization.jsonObject(with: req.httpBody!) as? [String: Any])
            #expect(body["query"] as? String == "#ai")
            #expect(body["collectionId"] as? Int == 42)
            #expect(body["page"] as? Int == 1)
            #expect(body["userId"] == nil)
            return (Data(#"{"items":[],"nextPage":null}"#.utf8), HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        })
        #expect(try await api.raindropSearch(query: "#ai", collectionId: 42, page: 1).items.isEmpty)
    }
    @Test func linkEsterniAccettanoSoloPagineWebSenzaCredenziali() {
        func item(_ url: String) -> RaindropBookmark {
            .init(id: 1, title: "Test", url: url, collectionId: -1, tags: [], excerpt: "", note: "", highlights: [], updatedAt: nil)
        }
        for url in ["javascript:alert(1)", "file:///private", "https://user:secret@example.test"] { #expect(item(url).safeURL == nil) }
        #expect(item("https://example.test/article").safeURL?.host == "example.test")
        #expect(ToolLabels.name("raindrop_save") == "Salvataggio in Raindrop")
    }
}
