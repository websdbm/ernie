import Foundation

/// Istantanea dei promemoria condivisa tra app e widget tramite il gruppo app (file JSON).
/// L'app la scrive quando i promemoria cambiano; il widget la legge per mostrare i prossimi sul blocco e in Home.
struct ReminderSnapshot: Codable, Sendable, Equatable {
    struct Item: Codable, Sendable, Equatable, Identifiable {
        var id: String
        var text: String
        var at: Date
        /// Messo da un familiare («papà»): assente per i promemoria propri.
        var from: String? = nil
    }

    var items: [Item]
    var updatedAt: Date

    static let appGroup = "group.com.websdbm.ernie"
    static let fileName = "reminders.json"

    static var fileURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)?.appendingPathComponent(fileName)
    }

    static func load(now: Date = .now) -> ReminderSnapshot {
        guard let url = fileURL, let data = try? Data(contentsOf: url) else { return ReminderSnapshot(items: [], updatedAt: .distantPast) }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        var snap = (try? decoder.decode(ReminderSnapshot.self, from: data)) ?? ReminderSnapshot(items: [], updatedAt: .distantPast)
        snap.items = snap.items.filter { $0.at > now.addingTimeInterval(-60) }.sorted { $0.at < $1.at }
        return snap
    }

    func save() {
        guard let url = Self.fileURL else { return }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        if let data = try? encoder.encode(self) { try? data.write(to: url, options: .atomic) }
    }

    var next: Item? { items.first }
}
