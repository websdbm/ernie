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
    /// Account seguito: accettando, il figlio (o il nonno) è seguito da chi invita (server ≥ 0030).
    var supervised: Bool? = nil
    /// Skill che avrà se seguito, scelte nell'invito (server ≥ 0032).
    var allowedSkills: [String]? = nil
}

/// Anteprima di un codice d'invito (prima di accettare): chi invita, come, e se l'account sarà seguito.
struct FamilyInvitePreview: Codable, Sendable, Equatable {
    struct Skill: Codable, Sendable, Equatable, Identifiable {
        var id: String
        var title: String
        var icon: String
    }
    var label: String
    var myLabel: String
    var relation: String
    var supervised: Bool
    /// Skill che potrà usare se l'account sarà seguito (server ≥ 0032).
    var skills: [Skill]? = nil
}

/// Per l'invito con account seguito: skill che si possono concedere e quelle proposte per parentela.
struct SkillProfiles: Codable, Sendable, Equatable {
    struct Skill: Codable, Sendable, Equatable, Identifiable {
        var id: String
        var title: String
        var icon: String
        var summary: String
    }
    var skills: [Skill]
    var defaults: [String: [String]]
}

/// Skill (o capacità come la ricerca sul web) che il genitore concede o nega al figlio.
struct GuardianSkill: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var title: String
    var icon: String
    var summary: String
    var allowed: Bool
}

/// Persona seguita (figlio, nonno, nonna) con l'account seguito.
struct SupervisedChild: Codable, Sendable, Equatable, Identifiable {
    var id: String { childId }
    var childId: String
    var label: String
    /// Cosa è per me: figlio, nonno, nonna (server ≥ 0032).
    var relation: String? = nil
    var since: String
    var lastReviewAt: String?
    var skills: [GuardianSkill]
}

/// Conversazione del figlio (registro per il genitore).
struct ChildSession: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var title: String
    var startedAt: String
    var lastAt: String
    var userMessages: Int
}

struct ChildMessage: Codable, Sendable, Equatable {
    var role: String
    var text: String
    var at: String
    var voice: Bool
    var tools: [String]
}

/// Vista del figlio: chi lo segue e quando ha consultato le conversazioni.
struct Supervision: Codable, Sendable, Equatable {
    struct Guardian: Codable, Sendable, Equatable {
        var label: String
        var since: String
        var lastReviewAt: String?
    }
    var supervised: Bool
    var guardians: [Guardian]
    var allowed: [String]?
}

struct FamilyOverview: Codable, Sendable, Equatable {
    var links: [FamilyLink]
    var invites: [FamilyInvite]
}

/// Nomi delle parentele nell'interfaccia (valori del server: figlio, genitore, nonno, nonna, nipote, partner, altro).
enum FamilyRelation: String, CaseIterable, Identifiable {
    case figlio, genitore, nonno, nonna, nipote, partner, altro
    var id: String { rawValue }
    var title: String {
        switch self {
        case .figlio: "Figlio/a"
        case .genitore: "Genitore"
        case .nonno: "Nonno"
        case .nonna: "Nonna"
        case .nipote: "Nipote"
        case .partner: "Partner"
        case .altro: "Altro"
        }
    }
    var symbol: String {
        switch self {
        case .figlio: "figure.and.child.holdinghands"
        case .genitore: "figure.2.and.child.holdinghands"
        case .nonno: "figure.stand"
        case .nonna: "figure.stand.dress"
        case .nipote: "figure.child"
        case .partner: "heart.fill"
        case .altro: "person.fill"
        }
    }
    /// Si può seguire l'account (skill scelte da chi invita, conversazioni leggibili): figlio, nonno, nonna.
    var supervisable: Bool { self == .figlio || self == .nonno || self == .nonna }
    /// Nome della supervisione: «controllo genitori» per un figlio, «account seguito» per i nonni.
    var supervisionTitle: String { self == .figlio ? "Controllo genitori" : "Account seguito" }
    /// Cosa può essere chi invita per chi accetta, quando non è ovvio (nil: lo decide il server).
    var inverseChoices: [FamilyRelation]? {
        switch self {
        case .nonno, .nonna: [.figlio, .nipote, .altro]
        case .nipote: [.nonno, .nonna, .altro]
        default: nil
        }
    }
    /// Scelta proposta fra `inverseChoices`: dal nome con cui chi invita si fa chiamare («nonna» → nonna).
    func defaultInverse(myLabel: String) -> FamilyRelation {
        let name = myLabel.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
        switch self {
        case .nonno, .nonna: return name.contains("nipote") ? .nipote : .figlio
        case .nipote:
            if name.contains("nonna") { return .nonna }
            if name.contains("nonno") { return .nonno }
            return .altro
        default: return .altro
        }
    }
    static func title(for raw: String) -> String { FamilyRelation(rawValue: raw)?.title ?? raw }
    static func symbol(for raw: String) -> String { FamilyRelation(rawValue: raw)?.symbol ?? "person.fill" }
    /// Pronome oggetto per le frasi «seguirlo/seguirla»: «la» solo per la nonna (figlio/a resta al maschile).
    var objectPronoun: String { self == .nonna ? "la" : "lo" }
    static func objectPronoun(for raw: String?) -> String {
        (raw.flatMap(FamilyRelation.init(rawValue:)) ?? .figlio).objectPronoun
    }
    static func supervisionTitle(for raw: String?) -> String {
        (raw.flatMap(FamilyRelation.init(rawValue:)) ?? .figlio).supervisionTitle
    }
}

/// Parola imparata da Ernie (lessico, 16 ott 2026): attiva o ancora in osservazione.
struct LexiconWord: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var term: String
    var meaning: String
    var example: String
    var active: Bool
    var seenCount: Int
    var lastSeenAt: String
}

/// «Come parla Ernie»: stili con l'anteprima, stile scelto, apprendimento delle parole.
struct StyleSettings: Codable, Sendable, Equatable {
    struct Option: Codable, Sendable, Equatable, Identifiable {
        var id: String
        var title: String
        var description: String
        var example: String
    }
    var styles: [Option]
    var current: String
    var learnLexicon: Bool
    var lexiconLockedByParent: Bool
    var words: [LexiconWord]
}

/// Come Ernie parla a un figlio seguito: lo stile lo sceglie lui, il genitore vede e può spegnere l'apprendimento.
struct ChildStyle: Codable, Sendable, Equatable {
    struct Style: Codable, Sendable, Equatable { var id: String; var title: String; var description: String }
    var style: Style
    var learnLexicon: Bool
    var lexiconOff: Bool
    var words: [LexiconWord]
}

struct Profile: Codable, Sendable, Equatable {
    var userId: String
    var displayName: String
    var companionName: String
    var role: String
    var settings: [String: JSONValue]
    var server: ServerInfo?
    /// Concessioni server: il ruolo owner da solo non abilita i dati delle altre installazioni.
    var capabilities: Capabilities? = nil

    struct ServerInfo: Codable, Sendable, Equatable { var version: String }
    struct Capabilities: Codable, Sendable, Equatable { var usageAdmin: Bool }

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
    /// Account seguito: non concessa da chi lo segue, non si può accendere.
    var locked: Bool? = nil
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
    typealias Transport = @Sendable (URLRequest) async throws -> (Data, URLResponse)
    private let transport: Transport
    let usesBackgroundMedia: Bool

    init(credentials: Credentials, transport: Transport? = nil) {
        self.credentials = credentials
        self.usesBackgroundMedia = transport == nil
        self.transport = transport ?? { try await URLSession.shared.data(for: $0) }
    }

    func me() async throws -> Profile { try await request("GET", "/v1/me") }

    func updateSettings(_ patch: [String: JSONValue]) async throws -> [String: JSONValue] {
        struct Out: Decodable { var settings: [String: JSONValue] }
        let out: Out = try await request("PATCH", "/v1/me/settings", body: patch)
        return out.settings
    }

    func automations() async throws -> [AutomationItem] {
        struct Out: Decodable { var automations: [AutomationItem] }
        let out: Out = try await request("GET", "/v1/automations")
        return out.automations.filter { !$0.key.hasPrefix("promemoria_") }
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

    func shoppingLists() async throws -> [ShoppingListSummary] {
        struct Entry: Decodable { var id: String; var name: String; var status: String; var open: Int; var bought: Int }
        struct Out: Decodable { var lists: [Entry] }
        let out: Out = try await request("GET", "/v1/shopping/lists?archived=1")
        return out.lists.map { .init(id: $0.id, name: $0.name, open: $0.open, bought: $0.bought, archived: $0.status == "archived") }
    }

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

    /// `allowedSkills`: skill di chi verrà seguito (solo con `supervised`; nil = quelle proposte dal server).
    func createFamilyInvite(label: String, relation: String, myLabel: String, supervised: Bool = false, allowedSkills: [String]? = nil) async throws -> FamilyInvite {
        struct Body: Encodable { var label: String; var relation: String; var myLabel: String; var supervised: Bool; var allowedSkills: [String]? }
        struct Out: Decodable { var invite: FamilyInvite }
        let body = Body(label: label, relation: relation, myLabel: myLabel, supervised: supervised, allowedSkills: supervised ? allowedSkills : nil)
        let out: Out = try await request("POST", "/v1/family/invites", body: body)
        return out.invite
    }

    func skillProfiles() async throws -> SkillProfiles {
        try await request("GET", "/v1/family/skill-profiles")
    }

    func previewFamilyInvite(code: String) async throws -> FamilyInvitePreview {
        struct Out: Decodable { var invite: FamilyInvitePreview }
        let safe = code.trimmingCharacters(in: .whitespacesAndNewlines).addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? code
        let out: Out = try await request("GET", "/v1/family/invites/\(safe)/preview")
        return out.invite
    }

    // MARK: controllo genitori

    func styleSettings() async throws -> StyleSettings { try await request("GET", "/v1/me/style") }

    func deleteLexiconWord(id: String) async throws {
        try await requestNoContent("DELETE", "/v1/me/lexicon/\(id)")
    }

    func childStyle(childId: String) async throws -> ChildStyle {
        try await request("GET", "/v1/family/children/\(childId)/style")
    }

    func setChildLexicon(childId: String, off: Bool) async throws -> ChildStyle {
        struct Body: Encodable, Sendable { var off: Bool }
        return try await request("PUT", "/v1/family/children/\(childId)/lexicon", body: Body(off: off))
    }

    func supervisedChildren() async throws -> [SupervisedChild] {
        struct Out: Decodable { var children: [SupervisedChild] }
        let out: Out = try await request("GET", "/v1/family/children")
        return out.children
    }

    func setChildSkills(childId: String, allowed: [String]) async throws -> [GuardianSkill] {
        struct Body: Encodable { var allowed: [String] }
        struct Out: Decodable { var skills: [GuardianSkill] }
        let out: Out = try await request("PUT", "/v1/family/children/\(childId)/skills", body: Body(allowed: allowed))
        return out.skills
    }

    func releaseChild(childId: String) async throws {
        try await requestNoContent("DELETE", "/v1/family/children/\(childId)")
    }

    func childSessions(childId: String) async throws -> [ChildSession] {
        struct Out: Decodable { var sessions: [ChildSession] }
        let out: Out = try await request("GET", "/v1/family/children/\(childId)/sessions")
        return out.sessions
    }

    func childSession(childId: String, sessionId: String) async throws -> [ChildMessage] {
        struct Out: Decodable { var messages: [ChildMessage] }
        let out: Out = try await request("GET", "/v1/family/children/\(childId)/sessions/\(sessionId)")
        return out.messages
    }

    func supervision() async throws -> Supervision {
        try await request("GET", "/v1/family/supervision")
    }

    func deleteFamilyInvite(code: String) async throws {
        try await requestNoContent("DELETE", "/v1/family/invites/\(code)")
    }

    /// `relation`: cosa è per me chi invita, se l'inversa proposta dal server non va bene.
    func acceptFamilyInvite(code: String, label: String?, relation: String? = nil) async throws -> FamilyLink {
        struct Body: Encodable { var code: String; var label: String?; var relation: String? }
        struct Out: Decodable { var link: FamilyLink }
        let out: Out = try await request("POST", "/v1/family/accept", body: Body(code: code, label: label, relation: relation))
        return out.link
    }

    func unlinkFamily(otherUserId: String) async throws {
        try await requestNoContent("DELETE", "/v1/family/links/\(otherUserId)")
    }

    func deleteReminder(id: String) async throws {
        try await requestNoContent("DELETE", "/v1/reminders/\(id)")
    }

    func unregisterDevice(token: String) async throws {
        let allowed = CharacterSet.alphanumerics
        guard !token.isEmpty, token.unicodeScalars.allSatisfy(allowed.contains) else { return }
        try await requestNoContent("DELETE", "/v1/devices/\(token)")
    }

    func registerDevice(token: String, environment: String) async throws {
        struct Body: Encodable { var platform = "ios"; var token: String; var environment: String; var appVersion: String?; var locale: String? }
        struct Out: Decodable { var id: String }
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        let _: Out = try await request("POST", "/v1/devices", body: Body(token: token, environment: environment, appVersion: version, locale: Locale.current.identifier))
    }

    // MARK: - privato

    func mediaImageData(_ id: String, thumbnail: Bool) async throws -> Data {
        guard let url = URL(string: "/v1/media/\(id)/image?size=\(thumbnail ? "thumbnail" : "full")", relativeTo: credentials.serverURL) else { throw URLError(.badURL) }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        req.setValue("Bearer \(credentials.apiKey)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await transport(req)
        try Task.checkCancellation()
        guard let response = response as? HTTPURLResponse, response.statusCode == 200 else {
            throw ApiError(status: (response as? HTTPURLResponse)?.statusCode ?? 0, code: "image", message: "Immagine non disponibile")
        }
        guard response.mimeType == "image/jpeg", data.count <= 3_000_000 else { throw URLError(.cannotDecodeContentData) }
        return data
    }

    /// Richiesta che non restituisce un corpo (204): errore se lo stato non è 2xx.
    func requestNoContent(_ method: String, _ path: String) async throws {
        guard let url = URL(string: path, relativeTo: credentials.serverURL) else { throw ApiError(status: 0, code: "bad_url", message: "URL non valido") }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(credentials.apiKey)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await transport(req)
        try Task.checkCancellation()
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
        let (data, response) = try await transport(req)
        try Task.checkCancellation()
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

extension ApiClient {
    func todoLists() async throws -> [TodoList] {
        struct Response: Decodable { var lists: [TodoList] }
        let response: Response = try await request("GET", "/v1/todo/lists")
        return response.lists
    }
    func todoList(id: String) async throws -> TodoList {
        struct Response: Decodable { var list: TodoList }
        let response: Response = try await request("GET", "/v1/todo/lists/\(id)")
        return response.list
    }
    func todoCreate(_ list: TodoList) async throws -> TodoList {
        struct Response: Decodable { var list: TodoList }
        let response: Response = try await request("POST", "/v1/todo/lists", body: TodoWriteBody(list: list, creating: true))
        return response.list
    }
    func todoUpdate(_ list: TodoList) async throws -> TodoList {
        struct Response: Decodable { var list: TodoList }
        let response: Response = try await request("PUT", "/v1/todo/lists/\(list.id)", body: TodoWriteBody(list: list, creating: false))
        return response.list
    }
}

private struct TodoWriteBody: Encodable, Sendable {
    let list: TodoList
    let creating: Bool
    enum CodingKeys: CodingKey { case id, name, mode, day, timezone, revision, items }
    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        if creating { try c.encode(list.id, forKey: .id) }
        else { try c.encode(list.revision, forKey: .revision) }
        try c.encode(list.name, forKey: .name)
        try c.encode(list.mode, forKey: .mode)
        if let day = list.day { try c.encode(day, forKey: .day) }
        else { try c.encodeNil(forKey: .day) }
        try c.encode(list.timezone, forKey: .timezone)
        try c.encode(list.items, forKey: .items)
    }
}
