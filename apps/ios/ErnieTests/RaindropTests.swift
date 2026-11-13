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
    @Test func accessoAutomaticoAccettaSoloRaindropERitornoConStateCorretto() throws {
        let state = String(repeating: "a", count: 43)
        let start = RaindropOAuthStart(authorizationURL: "https://raindrop.io/oauth/authorize?client_id=test&response_type=code&redirect_uri=ernie%3A%2F%2Fraindrop-auth&state=\(state)", state: state)
        #expect(start.safeURL != nil)
        #expect(try start.code(from: URL(string: "ernie://raindrop-auth?code=synthetic-code&state=\(state)")!) == "synthetic-code")
        for value in [
            "ernie://raindrop-auth?code=x&state=wrong",
            "ernie://raindrop-auth?code=x&state=\(state)&state=\(state)",
            "ernie://raindrop-auth?code=x&code=y&state=\(state)",
            "ernie://other?code=x&state=\(state)",
            "https://raindrop-auth?code=x&state=\(state)",
            "ernie://raindrop-auth?error=access_denied&state=\(state)",
            "ernie://raindrop-auth?code=x&state=\(state)#fragment"
        ] { #expect(throws: RaindropAuthorizationError.self) { try start.code(from: URL(string: value)!) } }
        for value in [
            start.authorizationURL.replacingOccurrences(of: "raindrop.io", with: "evil.test"),
            start.authorizationURL.replacingOccurrences(of: "https:", with: "http:"),
            start.authorizationURL + "&state=duplicate",
            start.authorizationURL + "&redirect_uri=https://evil.test",
            start.authorizationURL + "&client_secret=secret"
        ] { #expect(RaindropOAuthStart(authorizationURL: value, state: state).safeURL == nil) }
    }
    @Test func provaLocaleCasualeENonRiutilizzata() throws {
        let a = try makeRaindropVerifier(), b = try makeRaindropVerifier()
        #expect(a != b)
        #expect(a.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil)
    }
    @Test func oauthUsaCorpiAutenticatiSenzaSegretiNegliURL() async throws {
        let state = String(repeating: "a", count: 43), verifier = String(repeating: "b", count: 64)
        let data = Data(status.utf8)
        let api = ApiClient(credentials: credentials, transport: { req in
            #expect(req.httpMethod == "POST")
            #expect(req.url?.query == nil)
            #expect(req.value(forHTTPHeaderField: "Authorization") == "Bearer test-ernie-key")
            let body = try #require(try JSONSerialization.jsonObject(with: req.httpBody!) as? [String: String])
            if req.url?.path == "/v1/raindrop/oauth/start" {
                #expect(body == ["verifier": verifier])
                return (Data("{\"authorizationURL\":\"https://raindrop.io/oauth/authorize\",\"state\":\"\(state)\"}".utf8), HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
            }
            #expect(req.url?.path == "/v1/raindrop/oauth/complete")
            #expect(body == ["state": state, "verifier": verifier, "code": "synthetic-code"])
            return (data, HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        })
        #expect(try await api.raindropOAuthStart(verifier: verifier).state == state)
        #expect(try await api.raindropOAuthComplete(state: state, verifier: verifier, code: "synthetic-code").connected)
    }
}
