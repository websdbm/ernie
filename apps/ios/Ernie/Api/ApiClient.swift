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
    var intValue: Int? { if case .number(let n) = self { return Int(n) }; return nil }
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

/// Famiglia: una persona collegata (come la chiamo io e cosa è per me) e un invito in attesa.
struct FamilyLink: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var otherUserId: String
    var label: String
    var relation: String
    var createdAt: String
}

struct FamilyInvite: Codable, Sendable, Equatable, Identifiable {
    var id: String { code }
    var code: String
    var label: String
    var relation: String
    var myLabel: String
    var expiresAt: String
}

struct FamilyOverview: Codable, Sendable, Equatable {
    var links: [FamilyLink]
    var invites: [FamilyInvite]
}

/// Nomi delle parentele nell'interfaccia (valori del server: figlio, genitore, partner, altro).
enum FamilyRelation: String, CaseIterable, Identifiable {
    case figlio, genitore, partner, altro
    var id: String { rawValue }
    var title: String {
        switch self {
        case .figlio: "Figlio/a"
        case .genitore: "Genitore"
        case .partner: "Partner"
        case .altro: "Altro"
        }
    }
    var symbol: String {
        switch self {
        case .figlio: "figure.and.child.holdinghands"
        case .genitore: "figure.2.and.child.holdinghands"
        case .partner: "heart.fill"
        case .altro: "person.fill"
        }
    }
    static func title(for raw: String) -> String { FamilyRelation(rawValue: raw)?.title ?? raw }
    static func symbol(for raw: String) -> String { FamilyRelation(rawValue: raw)?.symbol ?? "person.fill" }
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
    /// Micro-descrizione per il pannello ✦ (una riga); assente sui server più vecchi.
    var summary: String?
    var description: String
    var kind: String
    var tools: [String]
    var examples: [String]
    /// Scelta nelle impostazioni: compare nel pannello ✦ della chat.
    var available: Bool
    /// Interruttore del pannello ✦: attiva adesso (vale solo se disponibile).
    var enabled: Bool
    /// Lavora davvero: disponibile e accesa.
    var active: Bool
}

/// Regola «Consenti sempre»: per questo tool Ernie non chiede più conferma (mai per invii verso l'esterno).
struct ToolRule: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var toolId: String
    var origin: String
    var createdAt: String
    var title: String
    var category: String?
}

struct DocumentRef: Codable, Sendable, Equatable {
    var id: String
    var title: String
    var pages: Int
    var chars: Int
    var source: String
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

    /// Accende o spegne un'automazione; `true` è anche la ripresa da una pausa automatica (azzera il motivo).
    func setAutomation(id: String, enabled: Bool) async throws {
        struct Body: Encodable { var enabled: Bool }
        struct Out: Decodable { var id: String; var enabled: Bool }
        let _: Out = try await request("PATCH", "/v1/automations/\(id)", body: Body(enabled: enabled))
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

    /// `available`: compare nel pannello ✦ (impostazioni); `enabled`: attiva adesso (pannello ✦).
    func setSkill(id: String, enabled: Bool? = nil, available: Bool? = nil) async throws -> [SkillInfo] {
        struct Body: Encodable { var enabled: Bool?; var available: Bool? }
        struct Out: Decodable { var skills: [SkillInfo] }
        let out: Out = try await request("PATCH", "/v1/skills/\(id)", body: Body(enabled: enabled, available: available))
        return out.skills
    }

    /// Carica il testo estratto sul telefono (mai il file): il server restituisce l'id da allegare al messaggio.
    func createDocument(_ doc: ImportedDocument, language: String = "it") async throws -> DocumentRef {
        struct Body: Encodable { var title: String?; var source: String; var language: String; var pages: [String] }
        return try await request("POST", "/v1/documents", body: Body(title: doc.title, source: doc.source, language: language, pages: doc.pages))
    }

    // MARK: liste della spesa (scheda interattiva, v1.4)

    private struct BlockOut: Decodable { var block: ContentBlock }

    func shoppingList(id: String) async throws -> ContentBlock {
        let out: BlockOut = try await request("GET", "/v1/shopping/lists/\(id)")
        return out.block
    }

    func shoppingSetChecked(listId: String, itemId: String, checked: Bool) async throws -> ContentBlock {
        struct Body: Encodable { var checked: Bool }
        let out: BlockOut = try await request("PATCH", "/v1/shopping/lists/\(listId)/items/\(itemId)", body: Body(checked: checked))
        return out.block
    }

    func shoppingAddItem(listId: String, name: String, quantity: String? = nil) async throws -> ContentBlock {
        struct Body: Encodable { var name: String; var quantity: String? }
        let out: BlockOut = try await request("POST", "/v1/shopping/lists/\(listId)/items", body: Body(name: name, quantity: quantity))
        return out.block
    }

    func shoppingRemoveItem(listId: String, itemId: String) async throws -> ContentBlock {
        let out: BlockOut = try await request("DELETE", "/v1/shopping/lists/\(listId)/items/\(itemId)")
        return out.block
    }

    func shoppingClearBought(listId: String) async throws -> ContentBlock {
        let out: BlockOut = try await request("POST", "/v1/shopping/lists/\(listId)/clear-bought")
        return out.block
    }

    func shoppingSetStatus(listId: String, archived: Bool) async throws -> ContentBlock {
        struct Body: Encodable { var status: String }
        let out: BlockOut = try await request("PATCH", "/v1/shopping/lists/\(listId)", body: Body(status: archived ? "archived" : "active"))
        return out.block
    }

    func shoppingDelete(listId: String) async throws {
        try await requestNoContent("DELETE", "/v1/shopping/lists/\(listId)")
    }

    // MARK: promemoria

    func reminders() async throws -> [ReminderItem] {
        struct Out: Decodable { var reminders: [ReminderItem] }
        let out: Out = try await request("GET", "/v1/reminders")
        return out.reminders
    }

    func updateReminder(id: String, text: String?, at: Date?) async throws -> ReminderItem {
        struct Body: Encodable { var text: String?; var at: String? }
        struct Out: Decodable { var reminder: ReminderItem }
        let iso = at.map { ISO8601DateFormatter().string(from: $0) }
        let out: Out = try await request("PATCH", "/v1/reminders/\(id)", body: Body(text: text, at: iso))
        return out.reminder
    }

    /// Canali di un promemoria (v1.11): si invia solo il campo cambiato; il server risponde con lo stesso id.
    /// `needsEmail` è true quando l'email è accesa ma nella scheda anagrafica manca l'indirizzo.
    func updateReminderChannels(id: String, email: Bool?, alarm: Bool?) async throws -> (reminder: ReminderItem, needsEmail: Bool) {
        struct Channels: Encodable, Sendable { var email: Bool?; var alarm: Bool? }
        struct Body: Encodable, Sendable { var channels: Channels }
        struct Out: Decodable { var reminder: ReminderItem; var needsEmail: Bool? }
        let out: Out = try await request("PATCH", "/v1/reminders/\(id)", body: Body(channels: Channels(email: email, alarm: alarm)))
        return (out.reminder, out.needsEmail ?? false)
    }

    // MARK: Famiglia (M7e)

    func family() async throws -> FamilyOverview { try await request("GET", "/v1/family") }

    // MARK: regole «Consenti sempre» (v1.9)

    func toolRules() async throws -> [ToolRule] {
        struct Out: Decodable { var rules: [ToolRule] }
        let out: Out = try await request("GET", "/v1/tool-rules")
        return out.rules
    }

    func deleteToolRule(id: String) async throws {
        try await requestNoContent("DELETE", "/v1/tool-rules/\(id)")
    }

    func createFamilyInvite(label: String, relation: String, myLabel: String) async throws -> FamilyInvite {
        struct Body: Encodable { var label: String; var relation: String; var myLabel: String }
        struct Out: Decodable { var invite: FamilyInvite }
        let out: Out = try await request("POST", "/v1/family/invites", body: Body(label: label, relation: relation, myLabel: myLabel))
        return out.invite
    }

    func deleteFamilyInvite(code: String) async throws {
        try await requestNoContent("DELETE", "/v1/family/invites/\(code)")
    }

    func acceptFamilyInvite(code: String, label: String?) async throws -> FamilyLink {
        struct Body: Encodable { var code: String; var label: String? }
        struct Out: Decodable { var link: FamilyLink }
        let out: Out = try await request("POST", "/v1/family/accept", body: Body(code: code, label: label))
        return out.link
    }

    func unlinkFamily(otherUserId: String) async throws {
        try await requestNoContent("DELETE", "/v1/family/links/\(otherUserId)")
    }

    func deleteReminder(id: String) async throws {
        try await requestNoContent("DELETE", "/v1/reminders/\(id)")
    }

    func registerDevice(token: String, environment: String) async throws {
        struct Body: Encodable { var platform = "ios"; var token: String; var environment: String; var appVersion: String?; var locale: String? }
        struct Out: Decodable { var id: String }
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        let _: Out = try await request("POST", "/v1/devices", body: Body(token: token, environment: environment, appVersion: version, locale: Locale.current.identifier))
    }

    // MARK: - privato

    /// Richiesta che non restituisce un corpo (204): errore se lo stato non è 2xx.
    private func requestNoContent(_ method: String, _ path: String) async throws {
        guard let url = URL(string: path, relativeTo: credentials.serverURL) else { throw ApiError(status: 0, code: "bad_url", message: "URL non valido") }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(credentials.apiKey)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            struct Failure: Decodable { var error: String?; var message: String? }
            let f = try? JSONDecoder().decode(Failure.self, from: data)
            throw ApiError(status: status, code: f?.error ?? "http_\(status)", message: f?.message ?? "Errore del server (\(status))")
        }
    }

    func request<T: Decodable>(_ method: String, _ path: String, body: (some Encodable & Sendable)? = nil as String?) async throws -> T {
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
