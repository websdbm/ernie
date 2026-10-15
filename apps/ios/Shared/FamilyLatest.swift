import Foundation

/// Ultimo messaggio in famiglia (mandato o ricevuto), condiviso nel gruppo app per il widget «Messaggi» della
/// schermata di blocco. Lo scrivono l'estensione delle notifiche (appena arriva), l'app (quando lo mostra o lo
/// manda) e il widget stesso con il riepilogo del server; vince sempre il più recente.
struct FamilyLatest: Codable, Sendable, Equatable {
    var id: String
    /// «in» ricevuto, «out» mandato da me.
    var direction: String
    /// Il nome che do all'altra persona («papà», «Giorgio»).
    var label: String
    var text: String
    var image: Bool
    var at: Date
    /// Urgente non ancora confermato («super snooze»): nel widget in rosso.
    var urgent: Bool? = nil

    var incoming: Bool { direction == "in" }
    var isUrgent: Bool { urgent == true }

    static let widgetKind = "ErnieFamilyMessages"
    private static let fileName = "family-latest.json"

    private static var fileURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: ReminderSnapshot.appGroup)?
            .appendingPathComponent(fileName)
    }

    static func load() -> FamilyLatest? {
        guard let url = fileURL, let data = try? Data(contentsOf: url) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(FamilyLatest.self, from: data)
    }

    /// Salva se è più recente di quello già salvato (o è lo stesso messaggio); true se il file è cambiato.
    @discardableResult
    func saveIfNewer() -> Bool {
        if let current = Self.load(), current.id != id, current.at > at { return false }
        if Self.load() == self { return false }
        guard let url = Self.fileURL else { return false }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(self) else { return false }
        return (try? data.write(to: url, options: .atomic)) != nil
    }

    /// «📷 Foto» o «📷 testo» per le righe brevi.
    var preview: String {
        if image { return text.isEmpty ? "📷 Foto" : "📷 \(text)" }
        return text
    }

    /// Date ISO 8601 del server, con o senza millisecondi.
    static func date(_ iso: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }
}
