import Foundation

/// Coda delle condivisioni: il foglio «Ernie» (estensione di condivisione) scrive qui ciò che non può consegnare
/// subito, e tutti i file (immagini e PDF); l'app li processa al ritorno in primo piano.
/// Ogni elemento è una cartella `Library/ShareInbox/<id>/` nel gruppo app con un `item.json` scritto per ultimo:
/// una cartella copiata a metà, senza sidecar, non compare mai in `pending()`.
/// Compilato in app, widget ed estensione: non dipende né da UIKit né dalle credenziali.
enum ShareInbox {
    /// Gruppo app condiviso da app, widget ed estensione.
    static let appGroup = "group.com.websdbm.ernie"
    /// Metadati di ogni elemento (JSON).
    static let sidecarName = "item.json"

    /// Errori di scrittura nella coda.
    enum QueueError: Error, Sendable, Equatable {
        /// Il gruppo app non è disponibile (manca l'entitlement).
        case noContainer
        /// Un file atteso non è nella cartella dell'elemento.
        case missingFile(String)
    }

    /// Elemento in attesa. `folder` è la sua cartella: immagini e PDF stanno lì dentro.
    struct Item: Identifiable, Sendable, Equatable {
        enum Kind: Sendable, Equatable {
            /// Link web, con il titolo della pagina (se noto) e la nota dell'utente.
            case link(URL, title: String?, note: String?)
            /// Testo semplice, con nota facoltativa.
            case text(String, note: String?)
            /// Immagini già copiate nella cartella dell'elemento.
            case images([URL], note: String?)
            /// PDF già copiato nella cartella dell'elemento.
            case pdf(URL, note: String?)
        }

        /// Nome della cartella: identifica l'elemento.
        let id: String
        let kind: Kind
        let createdAt: Date
        let folder: URL
    }

    /// Contenuto di `item.json`. `kind` è «link», «text», «images» o «pdf».
    private struct Sidecar: Codable {
        var kind: String
        var url: String?
        var title: String?
        var text: String?
        var files: [String]?
        var note: String?
        var createdAt: Date
    }

    /// Radice della coda nel gruppo app; nil se il gruppo non è disponibile.
    static var rootURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
            .appendingPathComponent("Library/ShareInbox", isDirectory: true)
    }

    /// Crea la cartella di un nuovo elemento. Immagini e PDF vi vengono copiati prima di `enqueue`.
    static func makeFolder() throws -> URL {
        guard let root = rootURL else { throw QueueError.noContainer }
        let folder = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    /// Mette in coda un elemento. Link e testi ricevono una cartella nuova; immagini e PDF usano `folder`, che deve
    /// già contenere i file (verificati qui). Il sidecar è scritto per ultimo.
    @discardableResult
    static func enqueue(_ kind: Item.Kind, folder: URL? = nil, now: Date = .now) throws -> Item {
        let dir = try folder ?? makeFolder()
        let sidecar: Sidecar
        switch kind {
        case .link(let url, let title, let note):
            sidecar = Sidecar(kind: "link", url: url.absoluteString, title: title, text: nil, files: nil, note: note, createdAt: now)
        case .text(let text, let note):
            sidecar = Sidecar(kind: "text", url: nil, title: nil, text: text, files: nil, note: note, createdAt: now)
        case .images(let urls, let note):
            sidecar = Sidecar(kind: "images", url: nil, title: nil, text: nil, files: try fileNames(urls, in: dir), note: note, createdAt: now)
        case .pdf(let url, let note):
            sidecar = Sidecar(kind: "pdf", url: nil, title: nil, text: nil, files: try fileNames([url], in: dir), note: note, createdAt: now)
        }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(sidecar).write(to: dir.appendingPathComponent(sidecarName), options: .atomic)
        return Item(id: dir.lastPathComponent, kind: kind, createdAt: now, folder: dir)
    }

    /// Elementi in attesa, dal più vecchio. Le cartelle senza un `item.json` leggibile sono ignorate.
    static func pending() -> [Item] {
        guard let root = rootURL,
              let folders = try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { return [] }
        return folders.compactMap { item(in: $0) }.sorted { $0.createdAt < $1.createdAt }
    }

    /// Consegna avvenuta: toglie l'elemento dalla coda e cancella i suoi file.
    static func remove(_ item: Item) {
        discard(item.folder)
    }

    /// Cancella la cartella di un elemento, anche una copia non ancora messa in coda.
    static func discard(_ folder: URL) {
        try? FileManager.default.removeItem(at: folder)
    }

    // MARK: - privato

    /// Nomi dei file, che devono esistere nella cartella dell'elemento.
    private static func fileNames(_ urls: [URL], in folder: URL) throws -> [String] {
        try urls.map { url in
            let name = url.lastPathComponent
            guard FileManager.default.fileExists(atPath: folder.appendingPathComponent(name).path) else {
                throw QueueError.missingFile(name)
            }
            return name
        }
    }

    /// Legge un elemento dalla sua cartella; nil se il sidecar manca, è illeggibile o incompleto.
    private static func item(in folder: URL) -> Item? {
        guard let data = try? Data(contentsOf: folder.appendingPathComponent(sidecarName)) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let sidecar = try? decoder.decode(Sidecar.self, from: data) else { return nil }
        let kind: Item.Kind
        switch sidecar.kind {
        case "link":
            guard let raw = sidecar.url, let url = URL(string: raw) else { return nil }
            kind = .link(url, title: sidecar.title, note: sidecar.note)
        case "text":
            guard let text = sidecar.text else { return nil }
            kind = .text(text, note: sidecar.note)
        case "images":
            kind = .images((sidecar.files ?? []).map { folder.appendingPathComponent($0) }, note: sidecar.note)
        case "pdf":
            guard let name = sidecar.files?.first else { return nil }
            kind = .pdf(folder.appendingPathComponent(name), note: sidecar.note)
        default:
            return nil
        }
        return Item(id: folder.lastPathComponent, kind: kind, createdAt: sidecar.createdAt, folder: folder)
    }
}

/// Invio di link e testi a `POST /v1/brain/share`. Non passa dal client dell'app (`ApiClient`), così il foglio di
/// condivisione lo usa senza dipendere dalla sessione aperta nell'app.
enum ShareUpload {
    /// Risposta del server (201): titolo assegnato e percorso nel second brain.
    struct Saved: Decodable, Sendable, Equatable {
        let title: String
        let path: String
        let created: Bool
    }

    /// Invio non riuscito. `status` è 0 quando il server non ha risposto.
    struct Failure: Error, Sendable, Equatable {
        let status: Int
        let message: String
    }

    /// Invia un link (`url`, con `title` se noto) oppure un testo (`text`), con la nota facoltativa dell'utente.
    static func post(url: URL?, text: String?, title: String?, note: String?, serverURL: URL, apiKey: String) async throws -> Saved {
        struct Body: Encodable {
            var url: String?
            var text: String?
            var title: String?
            var note: String?
        }
        guard let endpoint = URL(string: "/v1/brain/share", relativeTo: serverURL) else {
            throw Failure(status: 0, message: "Indirizzo del server non valido.")
        }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONEncoder().encode(Body(url: url?.absoluteString, text: text, title: title, note: note))

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw Failure(status: 0, message: "Nessuna risposta dal server.")
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            struct Reply: Decodable { var message: String? }
            let reply = try? JSONDecoder().decode(Reply.self, from: data)
            throw Failure(status: status, message: reply?.message ?? "Il server ha risposto con errore (\(status)).")
        }
        return try JSONDecoder().decode(Saved.self, from: data)
    }
}
