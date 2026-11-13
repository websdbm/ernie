import Foundation
import AuthenticationServices
import Security
import UIKit

struct RaindropStatus: Decodable, Sendable {
    struct Account: Decodable, Sendable { let id: Int; let name: String; let pro: Bool }
    let configured: Bool
    let oauthConfigured: Bool?
    let enabled: Bool
    let connected: Bool
    let account: Account?
    let connectedAt: String?
}
struct RaindropCollection: Decodable, Identifiable, Sendable {
    let id: Int
    let title: String
    let parentId: Int?
    let count: Int
}
struct RaindropBookmark: Decodable, Identifiable, Sendable {
    let id: Int
    let title: String
    let url: String
    let collectionId: Int
    let tags: [String]
    let excerpt: String
    let note: String
    let highlights: [String]
    let updatedAt: String?

    var safeURL: URL? {
        guard let value = URL(string: url), ["https", "http"].contains(value.scheme?.lowercased() ?? ""),
              value.host != nil, value.user == nil, value.password == nil else { return nil }
        return value
    }
}
struct RaindropPage: Decodable, Sendable { let items: [RaindropBookmark]; let nextPage: Int? }
extension ApiClient {
    func raindropOAuthStart(verifier: String) async throws -> RaindropOAuthStart {
        struct Body: Encodable, Sendable { let verifier: String }
        return try await request("POST", "/v1/raindrop/oauth/start", body: Body(verifier: verifier))
    }
    func raindropOAuthComplete(state: String, verifier: String, code: String) async throws -> RaindropStatus {
        struct Body: Encodable, Sendable { let state: String; let verifier: String; let code: String }
        return try await request("POST", "/v1/raindrop/oauth/complete", body: Body(state: state, verifier: verifier, code: code))
    }
    func raindropStatus() async throws -> RaindropStatus { try await request("GET", "/v1/raindrop") }
    func raindropConnect(token: String) async throws -> RaindropStatus {
        struct Body: Encodable, Sendable { let token: String }
        return try await request("PUT", "/v1/raindrop/connection", body: Body(token: token))
    }
    func raindropDisconnect() async throws -> RaindropStatus { try await request("DELETE", "/v1/raindrop/connection") }
    func raindropCollections() async throws -> [RaindropCollection] {
        struct Out: Decodable { let items: [RaindropCollection] }
        let out: Out = try await request("GET", "/v1/raindrop/collections")
        return out.items
    }
    func raindropSearch(query: String, collectionId: Int = 0, page: Int = 0) async throws -> RaindropPage {
        struct Body: Encodable, Sendable { let query: String; let collectionId: Int; let page: Int; let limit = 15 }
        return try await request("POST", "/v1/raindrop/search", body: Body(query: query, collectionId: collectionId, page: page))
    }
    func raindropBookmark(id: Int) async throws -> RaindropBookmark { try await request("GET", "/v1/raindrop/bookmarks/\(id)") }
}


struct RaindropOAuthStart: Decodable, Sendable {
    let authorizationURL: String
    let state: String

    var safeURL: URL? {
        guard let url = URL(string: authorizationURL), url.scheme == "https", url.host == "raindrop.io",
              url.path == "/oauth/authorize", url.user == nil, url.password == nil, url.port == nil,
              url.fragment == nil, state.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let items = parts.queryItems ?? []
        guard Set(items.map(\.name)) == Set(["client_id", "redirect_uri", "response_type", "state"]), items.count == 4,
              items.first(where: { $0.name == "state" })?.value == state,
              items.first(where: { $0.name == "response_type" })?.value == "code",
              items.first(where: { $0.name == "redirect_uri" })?.value == "ernie://raindrop-auth" else { return nil }
        return url
    }
    func code(from callback: URL) throws -> String {
        guard callback.scheme == "ernie", callback.host == "raindrop-auth", callback.path.isEmpty,
              callback.user == nil, callback.password == nil, callback.port == nil, callback.fragment == nil,
              let parts = URLComponents(url: callback, resolvingAgainstBaseURL: false) else { throw RaindropAuthorizationError.invalidCallback }
        let items = parts.queryItems ?? []
        guard items.filter({ $0.name == "state" }).count == 1,
              items.first(where: { $0.name == "state" })?.value == state,
              !items.contains(where: { $0.name == "error" }),
              items.filter({ $0.name == "code" }).count == 1,
              let code = items.first(where: { $0.name == "code" })?.value,
              !code.isEmpty, code.utf8.count <= 2048 else { throw RaindropAuthorizationError.invalidCallback }
        return code
    }
}
enum RaindropAuthorizationError: LocalizedError {
    case invalidCallback, unavailable
    var errorDescription: String? {
        switch self {
        case .invalidCallback: "Autorizzazione Raindrop non valida. Riprova Accedi con Raindrop."
        case .unavailable: "Impossibile aprire l’accesso a Raindrop. Riprova dall’app."
        }
    }
}
func makeRaindropVerifier() throws -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw RaindropAuthorizationError.unavailable }
    return bytes.map { String(format: "%02x", $0) }.joined()
}
@MainActor
final class RaindropWebAuthorization: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?
    private var continuation: CheckedContinuation<String, Error>?
    private var attempt = UUID()
    private weak var anchor: UIWindow?
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { anchor ?? ASPresentationAnchor() }
    private func finish(_ result: Result<String, Error>, attempt id: UUID) {
        guard attempt == id, let pending = continuation else { return }
        continuation = nil; session = nil
        pending.resume(with: result)
    }
    func cancel() {
        session?.cancel()
        finish(.failure(CancellationError()), attempt: attempt)
    }
    func authorize(_ start: RaindropOAuthStart) async throws -> String {
        try Task.checkCancellation()
        guard let url = start.safeURL, continuation == nil,
              let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
                .filter({ $0.activationState == .foregroundActive }).flatMap(\.windows).first(where: \.isKeyWindow) else {
            throw RaindropAuthorizationError.unavailable
        }
        let id = UUID(); attempt = id; anchor = window
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { pending in
                continuation = pending
                guard !Task.isCancelled else { finish(.failure(CancellationError()), attempt: id); return }
                let web = ASWebAuthenticationSession(url: url, callbackURLScheme: "ernie") { [weak self] callback, error in
                    Task { @MainActor in
                        guard let self else { return }
                        if let error { self.finish(.failure(error), attempt: id); return }
                        do {
                            guard let callback else { throw RaindropAuthorizationError.invalidCallback }
                            self.finish(.success(try start.code(from: callback)), attempt: id)
                        } catch { self.finish(.failure(error), attempt: id) }
                    }
                }
                session = web
                web.presentationContextProvider = self
                if !web.start() { finish(.failure(RaindropAuthorizationError.unavailable), attempt: id) }
            }
        } onCancel: { Task { @MainActor [weak self] in if self?.attempt == id { self?.cancel() } } }
    }
}
