import Foundation
import CryptoKit

struct DiaryEntry: Codable, Sendable, Identifiable, Equatable {
    var id: UUID = UUID()
    var createdAt: Date
    var timeZone: String
    /// Sealed once saved. AI never replaces the original.
    var original: String
    var revisions: [DiaryRevision] = []
    var title: String { String(original.split(whereSeparator: \.isNewline).first.map(String.init)?.prefix(90) ?? "Pagina senza titolo") }
}

struct DiaryRevision: Codable, Sendable, Identifiable, Equatable {
    var id: UUID = UUID()
    var createdAt: Date = .now
    var normalized: String
    var bullets: [String]
    var model: String
    var sourceIDs: [UUID]
    var sourceDigest: String
}

struct DiaryDraft: Codable, Sendable, Equatable {
    var createdAt: Date = .now
    var timeZone: String = TimeZone.current.identifier
    var text: String = ""
}

struct DiaryDocument: Codable, Sendable, Equatable {
    var version = 1
    var entries: [DiaryEntry] = []
    var summaries: [DiaryRevision] = []
    var draft: DiaryDraft = DiaryDraft()

    func validated() throws -> Self {
        guard version == 1, entries.count <= 2000, summaries.count <= 500,
              Set(entries.map(\.id)).count == entries.count, draft.text.count <= 50_000,
              entries.allSatisfy({ !$0.original.isEmpty && $0.original.count <= 50_000 && $0.revisions.count <= 100 }),
              (summaries + entries.flatMap(\.revisions)).allSatisfy({ $0.normalized.count <= 80_000 && $0.bullets.count <= 100 && $0.bullets.allSatisfy { $0.count <= 10_000 } })
        else { throw DiaryError.invalidArchive }
        return self
    }
}

enum DiaryError: LocalizedError {
    case locked, unavailable, keyInvalidated, invalidArchive, writeFailed, consentRequired, tooLarge, insecureServer
    var errorDescription: String? {
        switch self {
        case .locked: "Sblocca il diario per continuare."
        case .unavailable: "Sblocco non riuscito. Servono Face ID o Touch ID configurati."
        case .keyInvalidated: "La chiave del diario non è più valida (Face ID o Touch ID cambiati). Ripristina una copia cifrata."
        case .invalidArchive: "Copia non valida, password errata o dati alterati. Il diario attuale non è stato sostituito."
        case .writeFailed: "Non riesco a salvare il diario. Controlla lo spazio disponibile prima di continuare."
        case .consentRequired: "L’invio all’AI richiede la tua conferma per questa selezione."
        case .tooLarge: "Seleziona al massimo 31 pagine e 60.000 caratteri."
        case .insecureServer: "Il diario richiede una connessione HTTPS al server."
        }
    }
}

enum DiaryIdentity {
    static func scope(server: URL, userID: String) -> String {
        var endpoint = URLComponents(url: server, resolvingAgainstBaseURL: false) ?? URLComponents()
        endpoint.scheme = endpoint.scheme?.lowercased()
        endpoint.host = endpoint.host?.lowercased()
        endpoint.path = ""; endpoint.query = nil; endpoint.fragment = nil
        endpoint.user = nil; endpoint.password = nil
        if (endpoint.scheme == "https" && endpoint.port == 443) || (endpoint.scheme == "http" && endpoint.port == 80) { endpoint.port = nil }
        return SHA256.hash(data: Data(((endpoint.string ?? server.absoluteString) + "\n" + userID).utf8)).map { String(format: "%02x", $0) }.joined()
    }
    static func digest(_ entries: [DiaryEntry]) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let data = (try? encoder.encode(entries.map { DiaryAIInput(id: $0.id.uuidString, createdAt: $0.createdAt.ISO8601Format(), timeZone: $0.timeZone, original: $0.original) })) ?? Data()
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

struct DiaryLaunch: Identifiable, Equatable {
    let id = UUID()
    var draft: String
    /// Intercept locally BEFORE chat persistence or network dispatch. Even a
    /// disabled/unconfigured diary opens its locked gate rather than leaking text.
    static func parse(_ input: String) -> DiaryLaunch? {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        // «Diario delle attività / operativo» è un'altra funzione: si esclude solo subito dopo la parola diario del
        // comando. Prima l'esclusione guardava tutto il testo e «scrivi nel diario: … il diario operativo …» finiva
        // in chat e al server (revisione del 25 ott 2026).
        let notOperational = #"(?!\s+(?:delle\s+)?attivit[aà]\b|\s+operativo\b)"#
        let pattern = #"(?is)^(?:ernie[,\s]+)?(?:(?:apri|mostra|avvia)\s+(?:il\s+|mio\s+|il\s+mio\s+)?diario\b"# + notOperational
            + #"(?:\s+personale)?(?:[,.!\s]+(?:scrivi|scriviamo))?|(?:scrivi|annota|aggiungi)\s+(?:nel|sul|al)\s+(?:mio\s+)?diario\b"#
            + notOperational + #"(?:\s+personale)?|diario\s+personale)\s*[:,.!]?\s*(.*)$"#
        guard let re = try? NSRegularExpression(pattern: pattern),
              let match = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let range = Range(match.range(at: 1), in: text) else { return nil }
        return DiaryLaunch(draft: String(text[range]))
    }
}

struct DiaryAIInput: Codable, Sendable {
    var id: String
    var createdAt: String
    var timeZone: String
    var original: String
}
struct DiaryAIResult: Codable, Sendable {
    var normalized: String
    var bullets: [String]
    var model: String
}
struct DiaryCapabilities: Codable, Sendable {
    var available: Bool
    var enabled: Bool
    var model: String
}
