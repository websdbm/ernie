import Foundation

struct ApiError: Error, Sendable, Equatable {
    let status: Int
    let code: String
    let message: String
}

/// Valore JSON generico per `settings` e `payload` delle notifiche.
enum JSONValue: Codable, Sendable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case null
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: any Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null } else if let b = try? c.decode(Bool.self) { self = .bool(b) } else if let n = try? c.decode(Double.self) { self = .number(n) } else if let s = try? c.decode(String.self) { self = .string(s) } else if let a = try? c.decode([JSONValue].self) { self = .array(a) } else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .null: try c.encodeNil()
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }
    var stringValue: String? { if case .string(let s) = self { return s }; return nil }
    var boolValue: Bool? { if case .bool(let b) = self { return b }; return nil }
    var arrayValue: [JSONValue]? { if case .array(let a) = self { return a }; return nil }

    /// Rappresentazione compatta e leggibile (per anteprime degli argomenti).
    var compact: String {
        switch self {
        case .string(let s): s
        case .number(let n): n == n.rounded() ? String(Int(n)) : String(n)
        case .bool(let b): b ? "sì" : "no"
        case .null: "—"
        case .array(let a): a.map(\.compact).joined(separator: ", ")
        case .object(let o): o.keys.sorted().map { "\($0): \(o[$0]?.compact ?? "")" }.joined(separator: " · ")
        }
    }
}

struct Profile: Codable, Sendable, Equatable {
    var userId: String
    var displayName: String
    var companionName: String
    var role: String
    var settings: [String: JSONValue]
    var server: ServerInfo?

    struct ServerInfo: Codable, Sendable, Equatable { var version: String }

    var killSwitch: Bool { settings["killSwitch"]?.boolValue ?? false }

    func with(settings: [String: JSONValue]) -> Profile {
        var p = self
        p.settings = settings
        return p
    }
}

struct NotificationItem: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var kind: String
    var title: String
    var body: String
    var payload: JSONValue?
    var readAt: String?
    var createdAt: String
}

struct SkillInfo: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var title: String
    var description: String
    var kind: String
    var tools: [String]
    var examples: [String]
    var enabled: Bool
}

struct ApprovalResult: Codable, Sendable, Equatable {
    var outcome: String
    var executed: Bool
    var result: JSONValue?
}

/// REST del backend con la chiave API dell'utente (stessa autenticazione del WebSocket).
struct ApiClient: Sendable {
    let credentials: Credentials
    private let session = URLSession.shared

    init(credentials: Credentials) { self.credentials = credentials }

    func me() async throws -> Profile { try await request("GET", "/v1/me") }

    func updateSettings(_ patch: [String: JSONValue]) async throws -> [String: JSONValue] {
        struct Out: Decodable { var settings: [String: JSONValue] }
        let out: Out = try await request("PATCH", "/v1/me/settings", body: patch)
        return out.settings
    }

    func notifications(unreadOnly: Bool, limit: Int = 50) async throws -> [NotificationItem] {
        struct Out: Decodable { var notifications: [NotificationItem] }
        let out: Out = try await request("GET", "/v1/notifications?unread=\(unreadOnly)&limit=\(limit)")
        return out.notifications
    }

    func markRead(ids: [String]) async throws {
        struct Body: Encodable { var ids: [String] }
        struct Out: Decodable { var marked: Int }
        let _: Out = try await request("POST", "/v1/notifications/read", body: Body(ids: ids))
    }

    func approve(approvalId: String, decision: String) async throws -> ApprovalResult {
        struct Body: Encodable { var decision: String }
        return try await request("POST", "/v1/approvals/\(approvalId)", body: Body(decision: decision))
    }

    func skills() async throws -> [SkillInfo] {
        struct Out: Decodable { var skills: [SkillInfo] }
        let out: Out = try await request("GET", "/v1/skills")
        return out.skills
    }

    func setSkill(id: String, enabled: Bool) async throws -> [SkillInfo] {
        struct Body: Encodable { var enabled: Bool }
        struct Out: Decodable { var skills: [SkillInfo] }
        let out: Out = try await request("PATCH", "/v1/skills/\(id)", body: Body(enabled: enabled))
        return out.skills
    }

    func registerDevice(token: String, environment: String) async throws {
        struct Body: Encodable { var platform = "ios"; var token: String; var environment: String; var appVersion: String?; var locale: String? }
        struct Out: Decodable { var id: String }
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        let _: Out = try await request("POST", "/v1/devices", body: Body(token: token, environment: environment, appVersion: version, locale: Locale.current.identifier))
    }

    // MARK: - privato

    private func request<T: Decodable>(_ method: String, _ path: String, body: (some Encodable & Sendable)? = nil as String?) async throws -> T {
        guard let url = URL(string: path, relativeTo: credentials.serverURL) else { throw ApiError(status: 0, code: "bad_url", message: "URL non valido") }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(credentials.apiKey)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(body)
        }
        let (data, response) = try await session.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let f = try? JSONDecoder().decode(ApiFailure.self, from: data)
            throw ApiError(status: status, code: f?.error ?? "http_\(status)", message: f?.message ?? "Errore del server (\(status))")
        }
        if data.isEmpty, let empty = EmptyResponse() as? T { return empty }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

struct EmptyResponse: Decodable, Sendable {}

private struct ApiFailure: Decodable { var error: String?; var message: String? }
