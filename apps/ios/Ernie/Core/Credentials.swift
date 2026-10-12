import Foundation

/// Server e chiave API dell'utente: entrambi nel Keychain, mai nel bundle né nei log.
/// Server di Ernie usato dalla famiglia (staging3, dietro Caddy con certificato pubblico): proposto al primo avvio
/// e in «Cambia server». Si può sempre sostituire con un altro indirizzo.
enum DefaultServer {
    static let url = URL(string: "https://ernie.staging3.eklettica.it")!
}

struct Credentials: Sendable, Equatable {
    let serverURL: URL
    let apiKey: String

    private static let urlAccount = "serverURL"
    private static let keyAccount = "apiKey"

    static func load() -> Credentials? {
        guard let raw = Keychain.get(account: urlAccount), let url = URL(string: raw),
              let key = Keychain.get(account: keyAccount), !key.isEmpty else { return nil }
        return Credentials(serverURL: url, apiKey: key)
    }

    func save() throws {
        try Keychain.set(serverURL.absoluteString, account: Self.urlAccount)
        try Keychain.set(apiKey, account: Self.keyAccount)
    }

    static func clear() {
        Keychain.delete(account: urlAccount)
        Keychain.delete(account: keyAccount)
    }

    /// ws(s)://host/v1/ws derivato dall'URL http(s) del server.
    var webSocketURL: URL {
        var components = URLComponents(url: serverURL, resolvingAgainstBaseURL: false) ?? URLComponents()
        components.scheme = serverURL.scheme == "https" ? "wss" : "ws"
        components.path = "/v1/ws"
        components.query = nil
        return components.url ?? serverURL
    }
}
