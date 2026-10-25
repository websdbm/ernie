import CryptoKit
import Foundation

/// Copia del riepilogo dei widget (`GET /v1/widget`) legata all'account che l'ha chiesta. Prima la copia era il JSON
/// del server senza altro: dopo l'uscita dall'account (o con un altro account) il widget mostrava ancora i dati
/// precedenti, e una richiesta finita dopo il logout riscriveva il file appena cancellato.
enum WidgetSummaryCache {
    static let fileName = "widget-summary.json"

    private struct Stored: Codable {
        var account: String
        var summary: Data
    }

    /// Impronta dell'account (server e chiave): nel file non finisce la chiave.
    static func account(_ credentials: Credentials) -> String {
        let identity = credentials.serverURL.absoluteString + "\n" + credentials.apiKey
        return SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    static func wrap(_ summary: Data, for credentials: Credentials) -> Data? {
        try? JSONEncoder().encode(Stored(account: account(credentials), summary: summary))
    }

    /// Il JSON del riepilogo solo se la copia appartiene all'account collegato adesso; senza credenziali, niente.
    /// Le copie delle versioni precedenti (senza account) non valgono: il widget le ricarica alla prima richiesta.
    static func unwrap(_ data: Data, for credentials: Credentials?) -> Data? {
        guard let credentials, let stored = try? JSONDecoder().decode(Stored.self, from: data),
              stored.account == account(credentials) else { return nil }
        return stored.summary
    }

    /// Scrive la copia solo se l'account che ha fatto la richiesta è ancora quello collegato, prima e dopo la
    /// scrittura (`current` rilegge il Keychain): un'uscita a metà non lascia dati dell'account precedente.
    @discardableResult
    static func store(_ summary: Data, fetchedWith credentials: Credentials, current: () -> Credentials?, to url: URL) -> Bool {
        guard current() == credentials, let data = wrap(summary, for: credentials),
              (try? data.write(to: url, options: .atomic)) != nil else { return false }
        guard current() == credentials else {
            try? FileManager.default.removeItem(at: url)
            return false
        }
        return true
    }
}
