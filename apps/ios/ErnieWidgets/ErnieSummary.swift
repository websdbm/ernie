import Foundation

/// Riepilogo del server per i widget dell'orso (`GET /v1/widget`): prossimi impegni, automazioni, ultima attività e
/// stato. Il widget lo chiede con le credenziali del Keychain condiviso e ne tiene una copia nel gruppo app, così
/// mostra l'ultimo stato noto anche senza rete.
struct ErnieSummary: Codable, Sendable, Equatable {
    struct Status: Codable, Sendable, Equatable {
        var paused: Bool
        var proactive: Bool
        var unread: Int
    }

    struct Reminder: Codable, Sendable, Equatable, Identifiable {
        var id: String
        var text: String
        var at: Date
        var eventAt: Date?
        var from: String?
    }

    struct Automation: Codable, Sendable, Equatable, Identifiable {
        var id: String
        var title: String
        /// «sentinella» o «automazione».
        var kind: String
        var nextAt: Date?
        var paused: Bool
    }

    struct Activity: Codable, Sendable, Equatable {
        var title: String
        var status: String
        var at: Date
        var quiet: Bool
    }

    struct Counts: Codable, Sendable, Equatable {
        var reminders: Int
        var automations: Int
    }

    var generatedAt: Date
    var status: Status
    var reminders: [Reminder]
    var automations: [Automation]
    var activity: Activity?
    var counts: Counts

    private static let fileName = "widget-summary.json"

    private static var fileURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: ReminderSnapshot.appGroup)?
            .appendingPathComponent(fileName)
    }

    /// Date ISO 8601 del server, con o senza millisecondi.
    private static func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let raw = try decoder.singleValueContainer().decode(String.self)
            let fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = fractional.date(from: raw) ?? ISO8601DateFormatter().date(from: raw) { return date }
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "data non valida: \(raw)"))
        }
        return d
    }

    /// Ultima copia salvata (nil se il widget non ha mai parlato con il server).
    static func cached() -> ErnieSummary? {
        guard let url = fileURL, let data = try? Data(contentsOf: url) else { return nil }
        return try? decoder().decode(ErnieSummary.self, from: data)
    }

    /// Chiede il riepilogo al server; in caso di successo aggiorna la copia. Nil senza credenziali o senza rete.
    static func fetch() async -> ErnieSummary? {
        guard let credentials = Credentials.load(),
              let url = URL(string: "/v1/widget", relativeTo: credentials.serverURL) else { return nil }
        var request = URLRequest(url: url, timeoutInterval: 10)
        request.setValue("Bearer \(credentials.apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let summary = try? decoder().decode(ErnieSummary.self, from: data) else { return nil }
        if let file = fileURL { try? data.write(to: file, options: .atomic) }
        return summary
    }

    static var signedIn: Bool { Credentials.load() != nil }
}

/// Carezze all'orso (tocco sul widget): l'ultimo momento e quante, per variare la reazione.
enum BearMood {
    /// UserDefaults è thread-safe; si crea a ogni uso per non tenere uno stato globale non Sendable.
    private static var defaults: UserDefaults? { UserDefaults(suiteName: ReminderSnapshot.appGroup) }
    private static let pettedKey = "widget.bear.pettedAt"
    private static let countKey = "widget.bear.pets"

    static func pet(now: Date = .now) {
        defaults?.set(now.timeIntervalSince1970, forKey: pettedKey)
        defaults?.set(pets + 1, forKey: countKey)
    }

    static var pettedAt: Date? {
        guard let t = defaults?.double(forKey: pettedKey), t > 0 else { return nil }
        return Date(timeIntervalSince1970: t)
    }

    static var pets: Int { defaults?.integer(forKey: countKey) ?? 0 }
}
