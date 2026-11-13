import Foundation

struct RaindropStatus: Decodable, Sendable {
    struct Account: Decodable, Sendable { let id: Int; let name: String; let pro: Bool }
    let configured: Bool
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
