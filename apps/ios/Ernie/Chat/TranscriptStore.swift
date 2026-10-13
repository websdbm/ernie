import Foundation

/// Cronologia locale della conversazione: un file JSON per sessione in Application Support.
struct TranscriptStore {
    struct SessionFile: Codable, Sendable {
        var sessionId: String
        var lastSeq: Int
        var items: [ChatItem]
        var updatedAt: Date
    }

    private static let currentKey = "ernie.currentSessionId"
    private let directory: URL

    init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
        directory = base.appending(path: "Ernie/sessions", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    var currentSessionId: String? { UserDefaults.standard.string(forKey: Self.currentKey) }

    func setCurrent(_ sessionId: String) {
        UserDefaults.standard.set(sessionId, forKey: Self.currentKey)
    }

    func load(_ sessionId: String) -> SessionFile? {
        guard let data = try? Data(contentsOf: fileURL(sessionId)) else { return nil }
        return try? Self.decoder.decode(SessionFile.self, from: data)
    }

    func save(_ file: SessionFile) {
        guard let data = try? Self.encoder.encode(file) else { return }
        try? data.write(to: fileURL(file.sessionId), options: [.atomic, .completeFileProtection])
    }

    /// Conversazione salvata sul telefono, per lo storico del pannello laterale.
    struct SessionSummary: Identifiable, Sendable, Equatable {
        let id: String
        let title: String
        let updatedAt: Date
    }

    /// Conversazioni salvate con almeno un messaggio dell'utente, dalla più recente. Il titolo è la prima domanda.
    func list(limit: Int = 40) -> [SessionSummary] {
        let urls = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        let recent = urls
            .filter { $0.pathExtension == "json" }
            .map { ($0, (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) }
            .sorted { $0.1 > $1.1 }
            .prefix(limit * 2)
        var out: [SessionSummary] = []
        for (url, _) in recent {
            guard let data = try? Data(contentsOf: url), let file = try? Self.decoder.decode(SessionFile.self, from: data) else { continue }
            let first = file.items.lazy.compactMap { item -> String? in
                if case .message(let m) = item, m.role == .user { return m.text }
                return nil
            }.first
            guard let first else { continue }
            let title = first.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
            let shown = title.prefix(1).uppercased() + title.dropFirst().prefix(59)
            out.append(SessionSummary(id: file.sessionId, title: shown, updatedAt: file.updatedAt))
            if out.count >= limit { break }
        }
        return out
    }

    func delete(_ sessionId: String) {
        try? FileManager.default.removeItem(at: fileURL(sessionId))
    }

    func clearAll() {
        try? FileManager.default.removeItem(at: directory)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        UserDefaults.standard.removeObject(forKey: Self.currentKey)
    }

    private func fileURL(_ sessionId: String) -> URL {
        directory.appending(path: "\(sessionId).json")
    }

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }()
    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()
}
