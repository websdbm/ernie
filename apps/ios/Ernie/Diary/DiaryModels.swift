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

    static let maxEntries = 2000
    static let maxSummaries = 500
    static let maxRevisions = 100
    static let maxText = 50_000

    /// Limiti del formato. Un limite superato ha il suo messaggio (prima diventava «copia non valida» o «spazio
    /// esaurito»); identificativi doppi o versione sconosciuta restano un archivio non valido.
    func validated() throws -> Self {
        guard version == 1, Set(entries.map(\.id)).count == entries.count else { throw DiaryError.invalidArchive }
        guard entries.count <= Self.maxEntries else { throw DiaryError.tooManyEntries }
        guard summaries.count <= Self.maxSummaries else { throw DiaryError.tooManySummaries }
        guard entries.allSatisfy({ $0.revisions.count <= Self.maxRevisions }) else { throw DiaryError.tooManyRevisions }
        guard draft.text.count <= Self.maxText, entries.allSatisfy({ $0.original.count <= Self.maxText }) else { throw DiaryError.textTooLong }
        guard entries.allSatisfy({ !$0.original.isEmpty }),
              (summaries + entries.flatMap(\.revisions)).allSatisfy({ $0.normalized.count <= 80_000 && $0.bullets.count <= 100 && $0.bullets.allSatisfy { $0.count <= 10_000 } })
        else { throw DiaryError.invalidArchive }
        return self
    }
}

enum DiaryError: LocalizedError {
    case locked, unavailable, keyInvalidated, invalidArchive, writeFailed, consentRequired, tooLarge, insecureServer
    case tooManyEntries, tooManySummaries, tooManyRevisions, textTooLong, vaultFull, weakPassword
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
        case .tooManyEntries: "Il diario ha raggiunto il massimo di 2.000 pagine. Esporta una copia cifrata ed elimina le pagine che non ti servono più."
        case .tooManySummaries: "Hai raggiunto il massimo di 500 riepiloghi salvati."
        case .tooManyRevisions: "Questa pagina ha già 100 elaborazioni AI: non se ne possono aggiungere altre."
        case .textTooLong: "Una pagina può contenere al massimo 50.000 caratteri. Conserva questa pagina e continua in una nuova."
        case .vaultFull: "Il diario ha raggiunto la dimensione massima (16 MB). Esporta una copia cifrata ed elimina qualche pagina."
        case .weakPassword: "La password della copia deve avere almeno 12 caratteri."
        }
    }
}

enum DiaryIdentity {
    static func scope(server: URL, userID: String) -> String {
        hex(SHA256.hash(data: Data((endpoint(server) + "\n" + userID).utf8)))
    }

    private static let rememberedKey = "diary.scopeByAccount"

    /// Scope del diario per le credenziali collegate. Con il profilo lo calcola e lo ricorda sul telefono; senza
    /// profilo (avvio senza rete) usa quello ricordato per le stesse credenziali, così il diario locale si apre anche
    /// offline. Nel registro ci sono solo impronte: né la chiave API né l'identificativo dell'utente.
    static func scope(for credentials: Credentials, userID: String?, defaults: UserDefaults = .standard) -> String? {
        var remembered = defaults.dictionary(forKey: rememberedKey) as? [String: String] ?? [:]
        let account = hex(SHA256.hash(data: Data(("ernie-diary-account-v1\n" + endpoint(credentials.serverURL) + "\n" + credentials.apiKey).utf8)))
        guard let userID, !userID.isEmpty else { return remembered[account] }
        let scope = scope(server: credentials.serverURL, userID: userID)
        if remembered[account] != scope {
            remembered[account] = scope
            defaults.set(remembered, forKey: rememberedKey)
        }
        return scope
    }

    private static func endpoint(_ server: URL) -> String {
        var endpoint = URLComponents(url: server, resolvingAgainstBaseURL: false) ?? URLComponents()
        endpoint.scheme = endpoint.scheme?.lowercased()
        endpoint.host = endpoint.host?.lowercased()
        endpoint.path = ""; endpoint.query = nil; endpoint.fragment = nil
        endpoint.user = nil; endpoint.password = nil
        if (endpoint.scheme == "https" && endpoint.port == 443) || (endpoint.scheme == "http" && endpoint.port == 80) { endpoint.port = nil }
        return endpoint.string ?? server.absoluteString
    }

    private static func hex(_ digest: SHA256.Digest) -> String { digest.map { String(format: "%02x", $0) }.joined() }
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
