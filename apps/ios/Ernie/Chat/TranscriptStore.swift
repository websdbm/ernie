import Foundation

/// Cronologia locale della conversazione: un file JSON per sessione in Application Support, più un piccolo indice
/// (`<sessione>.summary`) con titolo e data per lo storico del pannello laterale.
struct TranscriptStore {
    struct SessionFile: Codable, Sendable {
        var sessionId: String
        var lastSeq: Int
        var items: [ChatItem]
        var updatedAt: Date
    }

    private static let currentKey = "ernie.currentSessionId"
    private let directory: URL
    private let defaults: UserDefaults

    init(directory: URL? = nil, defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
        self.directory = directory ?? base.appending(path: "Ernie/sessions", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true)
    }

    var currentSessionId: String? { defaults.string(forKey: Self.currentKey) }

    func setCurrent(_ sessionId: String) {
        defaults.set(sessionId, forKey: Self.currentKey)
    }

    func load(_ sessionId: String) -> SessionFile? {
        guard let data = try? Data(contentsOf: fileURL(sessionId)),
              var file = try? Self.decoder.decode(SessionFile.self, from: data) else { return nil }
        // Ripara anche le schede duplicate salvate dalle versioni precedenti, all'avvio e nella cronologia.
        file.items = file.items.normalizingListSnapshots()
        return file
    }

    func save(_ file: SessionFile) {
        guard let data = try? Self.encoder.encode(file) else { return }
        try? data.write(to: fileURL(file.sessionId), options: [.atomic, .completeFileProtection])
        // L'indice si scrive dopo la conversazione: se manca o è più vecchio, `list` lo ricostruisce.
        writeSummary(Self.summary(of: file), for: file.sessionId)
    }

    /// Conversazione salvata sul telefono, per lo storico del pannello laterale.
    struct SessionSummary: Identifiable, Sendable, Equatable {
        let id: String
        let title: String
        let updatedAt: Date
    }

    /// Voce dell'indice: titolo nil finché la conversazione non ha una domanda dell'utente.
    private struct IndexEntry: Codable {
        var sessionId: String
        var title: String?
        var updatedAt: Date
    }

    /// Conversazioni salvate con almeno un messaggio dell'utente, dalla più recente. Il titolo è la prima domanda.
    /// Legge solo l'indice di ogni conversazione; una conversazione intera si decodifica una volta sola, se è stata
    /// salvata prima dell'indice (blocchi da watchdog delle build 97–98: fino a 80 conversazioni decodificate sul
    /// main a ogni apertura del pannello).
    func list(limit: Int = 40) -> [SessionSummary] {
        let urls = (try? FileManager.default.contentsOfDirectory(at: self.directory, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        let recent = urls
            .filter { $0.pathExtension == "json" }
            .map { ($0, Self.modified($0)) }
            .sorted { $0.1 > $1.1 }
            .prefix(limit * 2)
        var out: [SessionSummary] = []
        for (url, modified) in recent {
            let sessionId = url.deletingPathExtension().lastPathComponent
            let entry: IndexEntry
            if let indexed = readSummary(for: sessionId, notOlderThan: modified) {
                entry = indexed
            } else {
                guard let data = try? Data(contentsOf: url), let file = try? Self.decoder.decode(SessionFile.self, from: data) else { continue }
                entry = Self.summary(of: file)
                writeSummary(entry, for: file.sessionId)
            }
            guard let title = entry.title else { continue }
            out.append(SessionSummary(id: entry.sessionId, title: title, updatedAt: entry.updatedAt))
            if out.count >= limit { break }
        }
        return out
    }

    /// Come `list`, fuori dal main thread: lo usa il pannello laterale a ogni apertura.
    func listInBackground(limit: Int = 40) async -> [SessionSummary] {
        // Solo la cartella attraversa il confine: l'elenco non usa le preferenze.
        let directory = self.directory
        return await Task.detached(priority: .userInitiated) { TranscriptStore(directory: directory).list(limit: limit) }.value
    }

    func delete(_ sessionId: String) {
        try? FileManager.default.removeItem(at: fileURL(sessionId))
        try? FileManager.default.removeItem(at: summaryURL(sessionId))
    }

    func clearAll() {
        try? FileManager.default.removeItem(at: directory)
        try? FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true)
        defaults.removeObject(forKey: Self.currentKey)
    }

    private static func summary(of file: SessionFile) -> IndexEntry {
        let first = file.items.lazy.compactMap { item -> String? in
            if case .message(let m) = item, m.role == .user { return m.text }
            return nil
        }.first
        let title = first.map { text -> String in
            let line = text.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
            return line.prefix(1).uppercased() + line.dropFirst().prefix(59)
        }
        return IndexEntry(sessionId: file.sessionId, title: title, updatedAt: file.updatedAt)
    }

    /// L'indice vale solo se non è più vecchio della conversazione (riscritta, per esempio, da una versione precedente).
    private func readSummary(for sessionId: String, notOlderThan modified: Date) -> IndexEntry? {
        let url = summaryURL(sessionId)
        guard Self.modified(url) >= modified, let data = try? Data(contentsOf: url),
              let entry = try? Self.decoder.decode(IndexEntry.self, from: data), entry.sessionId == sessionId else { return nil }
        return entry
    }

    private func writeSummary(_ entry: IndexEntry, for sessionId: String) {
        guard let data = try? Self.encoder.encode(entry) else { return }
        try? data.write(to: summaryURL(sessionId), options: [.atomic, .completeFileProtection])
    }

    private static func modified(_ url: URL) -> Date {
        (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
    }

    private func fileURL(_ sessionId: String) -> URL {
        directory.appending(path: "\(sessionId).json")
    }

    private func summaryURL(_ sessionId: String) -> URL {
        directory.appending(path: "\(sessionId).summary")
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
