import Foundation
import Observation

/// Contenuto condiviso, già letto. Immagini e PDF sono copiati nella cartella di coda `folder`, nel gruppo app.
enum ShareContent: Equatable {
    case link(URL, title: String?)
    case text(String)
    case images(folder: URL, names: [String])
    case pdf(folder: URL, name: String)
    /// Tipo di contenuto che Ernie non sa salvare.
    case unsupported
    /// Il contenuto c'è ma non si riesce a leggerlo.
    case unreadable
}

/// Stato del foglio di condivisione: contenuto letto, nota dell'utente e fase del salvataggio.
@MainActor
@Observable
final class ShareModel {
    /// Fase del salvataggio. Il messaggio finale resta visibile un momento prima che il foglio si chiuda.
    enum Phase: Equatable {
        case loading
        case ready
        case sending
        /// Salvato nel second brain con questo titolo.
        case saved(String)
        /// Messo in coda: Ernie lo consegna alla prossima apertura.
        case info(String)
        case error(String)
    }

    private(set) var phase: Phase = .loading
    private(set) var content: ShareContent?
    /// Nota che l'utente può scrivere nel foglio (facoltativa).
    var note = ""
    /// Nessuna credenziale salvata: il foglio chiede di aprire Ernie e accedere.
    let needsSignIn: Bool
    /// Chiamato quando il foglio può chiudersi dopo un salvataggio riuscito o messo in coda.
    var onFinish: (() -> Void)?
    /// Chiamato quando l'utente annulla.
    var onCancel: (() -> Void)?

    private let credentials: Credentials?

    init(credentials: Credentials?) {
        self.credentials = credentials
        self.needsSignIn = credentials == nil
    }

    /// Salvataggio in corso o concluso: niente più modifiche, niente annulla.
    var isFinishing: Bool {
        switch phase {
        case .sending, .saved, .info: true
        case .loading, .ready, .error: false
        }
    }

    /// Si può salvare: c'è un contenuto leggibile e il salvataggio non è iniziato.
    var canSave: Bool { content != nil && !isFinishing }

    /// Esito della lettura: il contenuto è pronto da salvare, oppure spiega perché non si può.
    func didLoad(_ result: ShareContent) {
        switch result {
        case .unsupported:
            phase = .error("Questo tipo di contenuto non è supportato.")
        case .unreadable:
            phase = .error("Non riesco a leggere ciò che hai condiviso.")
        case .link, .text, .images, .pdf:
            content = result
            phase = .ready
        }
    }

    /// Salva il contenuto. Link e testi vanno al server (e in coda se il server non risponde); immagini e PDF vanno in coda.
    func save() {
        guard canSave, let content else { return }
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        let comment = trimmed.isEmpty ? nil : trimmed
        switch content {
        case .link(let url, let title):
            send(url: url, text: nil, title: title, note: comment, fallback: .link(url, title: title, note: comment))
        case .text(let text):
            send(url: nil, text: text, title: nil, note: comment, fallback: .text(text, note: comment))
        case .images(let folder, let names):
            queue(.images(names.map { folder.appendingPathComponent($0) }, note: comment), folder: folder)
        case .pdf(let folder, let name):
            queue(.pdf(folder.appendingPathComponent(name), note: comment), folder: folder)
        case .unsupported, .unreadable:
            break
        }
    }

    /// Annulla: scarta i file copiati e chiude il foglio senza salvare nulla.
    func cancel() {
        if let folder = stagedFolder { ShareInbox.discard(folder) }
        onCancel?()
    }

    /// Cartella con i file copiati (immagini o PDF), se ce ne sono.
    private var stagedFolder: URL? {
        switch content {
        case .images(let folder, _), .pdf(let folder, _): folder
        case .link, .text, .unsupported, .unreadable, nil: nil
        }
    }

    private func send(url: URL?, text: String?, title: String?, note: String?, fallback: ShareInbox.Item.Kind) {
        guard let credentials else { return }
        phase = .sending
        Task {
            do {
                let saved = try await ShareUpload.post(url: url, text: text, title: title, note: note,
                                                       serverURL: credentials.serverURL, apiKey: credentials.apiKey)
                self.phase = .saved(saved.title)
                self.finishSoon(after: 1.5)
            } catch {
                // Server non raggiungibile: la condivisione resta in coda e l'app la consegna alla prossima apertura.
                do {
                    try ShareInbox.enqueue(fallback)
                    self.phase = .info("Non riesco a raggiungere Ernie. Lo salvo appena apri Ernie.")
                    self.finishSoon(after: 2.5)
                } catch {
                    self.phase = .error("Non riesco a salvare la condivisione. Riprova.")
                }
            }
        }
    }

    private func queue(_ kind: ShareInbox.Item.Kind, folder: URL) {
        do {
            try ShareInbox.enqueue(kind, folder: folder)
            phase = .info("Lo trovi in Ernie: apri l'app per metterlo nel second brain.")
            finishSoon(after: 2.5)
        } catch {
            phase = .error("Non riesco a salvare la condivisione. Riprova.")
        }
    }

    /// Chiude il foglio dopo un momento, così il messaggio resta leggibile.
    private func finishSoon(after seconds: Double) {
        Task {
            try? await Task.sleep(for: .seconds(seconds))
            self.onFinish?()
        }
    }
}
