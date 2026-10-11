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
