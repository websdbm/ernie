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

    /// Ultimo messaggio in famiglia (server ≥ build 59).
    struct Family: Codable, Sendable, Equatable {
        var id: String
        var direction: String
        var label: String
        var text: String
        var image: Bool
        var at: Date
        var urgent: Bool?
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
    var family: Family?

    private static var fileURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: ReminderSnapshot.appGroup)?
            .appendingPathComponent(WidgetSummaryCache.fileName)
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

    /// Ultima copia salvata dell'account collegato (nil senza credenziali, con un altro account o se il widget non ha
    /// mai parlato con il server).
    static func cached() -> ErnieSummary? {
        guard let url = fileURL, let data = try? Data(contentsOf: url),
              let summary = WidgetSummaryCache.unwrap(data, for: Credentials.load()) else { return nil }
        return try? decoder().decode(ErnieSummary.self, from: summary)
    }

    /// Chiede il riepilogo al server; in caso di successo aggiorna la copia. Nil senza credenziali, senza rete o se
    /// nel frattempo l'utente è uscito dall'account (la risposta dell'account precedente non si scrive).
    static func fetch() async -> ErnieSummary? {
        guard let credentials = Credentials.load(),
              let url = URL(string: "/v1/widget", relativeTo: credentials.serverURL) else { return nil }
        var request = URLRequest(url: url, timeoutInterval: 10)
        request.setValue("Bearer \(credentials.apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let summary = try? decoder().decode(ErnieSummary.self, from: data) else { return nil }
        if let file = fileURL { WidgetSummaryCache.store(data, fetchedWith: credentials, current: Credentials.load, to: file) }
        return Credentials.load() == credentials ? summary : nil
    }

    static var signedIn: Bool { Credentials.load() != nil }
}
