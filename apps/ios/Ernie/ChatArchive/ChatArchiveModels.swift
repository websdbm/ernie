import Foundation

struct ChatArchive: Codable, Sendable, Identifiable, Hashable {
    var id: String
    var name: String
    var summary: String? = nil
    var kind: String
    var category: String?
    var tags: [String]
    var messageCount: Int
    var participantCount: Int
    var firstMessageAt: String?
    var latestMessageAt: String?
    var lastImportedAt: String
    var indexedAt: String
    var indexedRevision: Int
    var revision: Int
    var timeZone: String
    var whatsappPhone: String?
    var whatsappUrl: String?
    var indexReady: Bool { indexedRevision == revision }
}
struct ChatArchiveParticipant: Codable, Sendable, Identifiable, Hashable {
    var id: String
    var name: String
    var messageCount: Int
    var firstMessageAt: String
    var lastMessageAt: String
}
struct ChatArchiveMessage: Codable, Sendable, Identifiable, Hashable {
    var id: String
    var senderId: String?
    var sender: String?
    var at: String
    var rawText: String
    var text: String
    var type: String
    var position: Int
}
struct ChatArchivePreview: Codable, Sendable {
    struct Candidate: Codable, Sendable, Identifiable {
        var archive: ChatArchive
        var duplicateCount: Int
        var newCount: Int
        var confidence: Double
        var id: String { archive.id }
    }
    var name: String
    var kind: String
    var parsedCount: Int
    var warningCount: Int
    var warnings: [String]
    var unparsedCount: Int
    var firstMessageAt: String?
    var latestMessageAt: String?
    var participants: [String]
    var candidates: [Candidate]
    var suggestedArchiveId: String?
}
struct ChatArchiveImportResult: Codable, Sendable {
    var archive: ChatArchive
    var parsedCount: Int
    var insertedCount: Int
    var duplicateCount: Int
    var warningCount: Int
    var warnings: [String]
    var unparsedCount: Int
}
struct ChatArchiveDetail: Codable, Sendable {
    var archive: ChatArchive
    var participants: [ChatArchiveParticipant]
}
struct ChatArchivePage: Codable, Sendable { var archives: [ChatArchive]; var total: Int }
struct ChatArchiveMessagePage: Codable, Sendable { var messages: [ChatArchiveMessage]; var total: Int }
struct ChatArchiveAnswer: Codable, Sendable {
    struct Coverage: Codable, Sendable {
        var firstMessageAt: String?
        var latestMessageAt: String?
        var lastImportedAt: String
        var indexedAt: String
        var revision: Int
        var matchedCount: Int
        var usedCount: Int
        var partial: Bool
    }
    var answer: String
    var sources: [ChatArchiveMessage]
    var uncertainties: [String]
    var coverage: Coverage
    var model: String
}
struct ChatArchiveImportInput: Encodable, Sendable {
    var filename: String
    var dataBase64: String
    var timeZone: String
    var archiveId: String?
    var createNew: Bool?
    var name: String?
    var kind: String?

    static let maxBytes = 8 * 1024 * 1024
    static func read(_ url: URL) async throws -> Self {
        try await Task.detached(priority: .userInitiated) {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard ["txt", "zip"].contains(url.pathExtension.lowercased()) else { throw ChatArchiveInputError.unsupported }
            let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
            guard values.isRegularFile == true, let size = values.fileSize, size > 0, size <= maxBytes else { throw ChatArchiveInputError.tooLarge }
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            let data = try handle.read(upToCount: maxBytes + 1) ?? Data()
            guard !data.isEmpty, data.count <= maxBytes else { throw ChatArchiveInputError.tooLarge }
            return Self(filename: url.lastPathComponent, dataBase64: data.base64EncodedString(), timeZone: TimeZone.current.identifier)
        }.value
    }
    func choosing(archiveId: String?, newName: String, kind: String) -> Self {
        var copy = self
        copy.archiveId = archiveId; copy.createNew = archiveId == nil
        copy.name = archiveId == nil ? newName : nil; copy.kind = archiveId == nil ? kind : nil
        return copy
    }
}
struct ChatArchiveAskInput: Encodable, Sendable {
    struct History: Encodable, Sendable { var question: String; var answer: String }
    var question: String
    var consent = true
    var mode = "question"
    var from: String?
    var to: String?
    var senderId: String?
    var history: [History] = []
}
struct ChatArchiveUpdate: Encodable, Sendable {
    var name: String
    var summary: String? = nil
    var kind: String
    var category: String?
    var tags: [String]
    var whatsappPhone: String?
    var whatsappUrl: String?
    enum CodingKeys: CodingKey { case name, summary, kind, category, tags, whatsappPhone, whatsappUrl }
    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        if let summary { try c.encode(summary, forKey: .summary) } else { try c.encodeNil(forKey: .summary) }
        try c.encode(name, forKey: .name); try c.encode(kind, forKey: .kind); try c.encode(tags, forKey: .tags)
        if let category { try c.encode(category, forKey: .category) } else { try c.encodeNil(forKey: .category) }
        if let whatsappPhone { try c.encode(whatsappPhone, forKey: .whatsappPhone) } else { try c.encodeNil(forKey: .whatsappPhone) }
        if let whatsappUrl { try c.encode(whatsappUrl, forKey: .whatsappUrl) } else { try c.encodeNil(forKey: .whatsappUrl) }
    }
}
enum ChatArchiveInputError: LocalizedError {
    case tooLarge, unsupported, invalidLink
    var errorDescription: String? {
        switch self {
        case .tooLarge: "Scegli un’esportazione di testo fino a 8 MB."
        case .unsupported: "Importa un file TXT o ZIP esportato da WhatsApp."
        case .invalidLink: "Usa un numero internazionale o un link HTTPS ufficiale di WhatsApp."
        }
    }
}
enum ChatArchivePresentation {
    static func date(_ raw: String?) -> String {
        guard let raw else { return "Non disponibile" }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = iso.date(from: raw) ?? ISO8601DateFormatter().date(from: raw) else { return raw }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
    static func error(_ error: Error) -> String {
        if let api = error as? ApiError {
            if api.status == 403 { return "Attiva Archivio chat in Impostazioni → Skill per questo account." }
            if api.status == 404 { return "Questa chat non è più disponibile." }
            if api.status == 413 { return ChatArchiveInputError.tooLarge.localizedDescription }
            return api.message
        }
        if let error = error as? ChatArchiveInputError { return error.localizedDescription }
        return "Non riesco a completare l’operazione. Controlla la connessione e riprova."
    }
    static func path(_ base: String, query: [(String, String?)]) -> String {
        var c = URLComponents(); c.path = base
        c.queryItems = query.compactMap { key, value in value.flatMap { $0.isEmpty ? nil : URLQueryItem(name: key, value: $0) } }
        c.percentEncodedQuery = c.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return c.string ?? base
    }
}
enum ChatArchiveWhatsApp {
    static func phone(_ raw: String) -> String? {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.range(of: #"^\+?[1-9][0-9]{6,14}$"#, options: .regularExpression) != nil else { return nil }
        return value.hasPrefix("+") ? String(value.dropFirst()) : value
    }
    static func safeURL(_ raw: String?) -> URL? {
        guard let raw, let c = URLComponents(string: raw), c.scheme?.lowercased() == "https",
              c.user == nil, c.password == nil, c.port == nil, c.query == nil, c.fragment == nil else { return nil }
        let path = c.path.split(separator: "/").map(String.init)
        let host = c.host?.lowercased()
        if host == "wa.me", path.count == 1, phone(path[0]) == path[0] { return c.url }
        if host == "chat.whatsapp.com", path.count == 1, validToken(path[0]) { return c.url }
        if host == "www.whatsapp.com" || host == "whatsapp.com", path.count == 2, path[0] == "channel", validToken(path[1]) { return c.url }
        return nil
    }
    private static func validToken(_ value: String) -> Bool { value.range(of: #"^[A-Za-z0-9_-]{6,128}$"#, options: .regularExpression) != nil }
    static func compose(phone raw: String?, text: String = "") -> URL? {
        guard let raw, let number = phone(raw) else { return nil }
        var c = URLComponents(); c.scheme = "https"; c.host = "wa.me"; c.path = "/" + number
        if !text.isEmpty { c.queryItems = [URLQueryItem(name: "text", value: text)] }
        return c.url
    }
}
struct ChatArchiveReferenceRequest: Identifiable {
    let id = UUID()
    let text: String
}
struct ChatArchiveResolution: Decodable, Sendable {
    var archives: [ChatArchive]
    var total: Int
    var selectedArchiveId: String?
    var question: String
}
enum ChatArchiveLaunch {
    /// Riferimento esplicito: non intercetta richieste di invio di messaggi ai familiari.
    static func request(from text: String, hasAttachments: Bool = false) -> ChatArchiveReferenceRequest? {
        guard !hasAttachments, !matches(text) else { return nil }
        let normalized = text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "it_IT"))
        let explicitArchive = normalized.contains("archivio chat") || normalized.contains("chat archiviata") || normalized.contains("conversazione archiviata") || normalized.contains("chat whatsapp")
        let scopedChat = normalized.range(of: #"\b(nella|dalla|sulla|della) (chat|conversazione)\b"#, options: .regularExpression) != nil
        let asksChat = normalized.range(of: #"\b(riassumi|analizza|cerca|consulta|leggi|interroga|riepiloga)\b.*\b(chat|conversazione)\b"#, options: .regularExpression) != nil
        let sends = normalized.range(of: #"^\s*(invia|manda|rispondi|inoltra)\b"#, options: .regularExpression) != nil
            || (normalized.range(of: #"^\s*scrivi\b"#, options: .regularExpression) != nil
                && normalized.range(of: #"\b(riassunto|riepilogo|sunto|brief|analisi)\b"#, options: .regularExpression) == nil)
        guard !sends, explicitArchive || scopedChat || asksChat else { return nil }
        return .init(text: text)
    }

    static func matches(_ text: String, hasAttachments: Bool = false) -> Bool {
        guard !hasAttachments else { return false }
        return ["apri archivio chat", "apri l’archivio chat", "apri l'archivio chat", "mostra archivio chat", "apri le chat archiviate"]
            .contains(text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
    }
}

extension ApiClient {
    func resolveChatArchive(_ text: String) async throws -> ChatArchiveResolution {
        struct Input: Encodable, Sendable { let request: String }
        return try await request("POST", "/v1/chat-archives/resolve", body: Input(request: text))
    }

    func chatArchives(query: String = "", offset: Int = 0) async throws -> ChatArchivePage {
        try await request("GET", ChatArchivePresentation.path("/v1/chat-archives", query: [("q", query), ("offset", String(offset)), ("limit", "30")]))
    }
    func chatArchive(_ id: String) async throws -> ChatArchiveDetail { try await request("GET", "/v1/chat-archives/\(id)") }
    func previewChatArchive(_ input: ChatArchiveImportInput) async throws -> ChatArchivePreview { try await request("POST", "/v1/chat-archives/imports/preview", body: input) }
    func importChatArchive(_ input: ChatArchiveImportInput) async throws -> ChatArchiveImportResult { try await request("POST", "/v1/chat-archives/imports", body: input) }
    func updateChatArchive(_ id: String, input: ChatArchiveUpdate) async throws -> ChatArchive {
        struct Response: Decodable { var archive: ChatArchive }
        let r: Response = try await request("PATCH", "/v1/chat-archives/\(id)", body: input); return r.archive
    }
    func deleteChatArchive(_ id: String) async throws { try await requestNoContent("DELETE", "/v1/chat-archives/\(id)") }
    func chatArchiveMessages(_ id: String, query: String = "", senderId: String? = nil, from: String? = nil, to: String? = nil, offset: Int = 0, limit: Int = 50, aroundId: String? = nil) async throws -> ChatArchiveMessagePage {
        try await request("GET", ChatArchivePresentation.path("/v1/chat-archives/\(id)/messages", query: [("q", query), ("senderId", senderId), ("from", from), ("to", to), ("offset", String(offset)), ("limit", String(limit)), ("aroundId", aroundId)]))
    }
    func askChatArchive(_ id: String, input: ChatArchiveAskInput) async throws -> ChatArchiveAnswer { try await request("POST", "/v1/chat-archives/\(id)/ask", body: input) }
}
