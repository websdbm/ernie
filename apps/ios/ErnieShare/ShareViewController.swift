import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Controller principale dell'estensione «Ernie» nel foglio di condivisione: legge ciò che l'utente condivide,
/// mostra `ShareView` e chiude la richiesta quando il contenuto è salvato o l'utente annulla.
@MainActor
final class ShareViewController: UIViewController {
    private let model = ShareModel(credentials: Credentials.load())

    override func viewDidLoad() {
        super.viewDidLoad()
        model.onFinish = { [weak self] in self?.complete() }
        model.onCancel = { [weak self] in self?.cancel() }
        installInterface()
        guard !model.needsSignIn else { return }
        Task { await self.loadContent() }
    }

    /// Ospita la vista SwiftUI; l'altezza del foglio segue il contenuto.
    private func installInterface() {
        let host = UIHostingController(rootView: ShareView(model: model))
        host.sizingOptions = .preferredContentSize
        host.view.backgroundColor = .clear
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        host.didMove(toParent: self)
    }

    /// Legge gli allegati del foglio e il titolo della pagina (se c'è).
    private func loadContent() async {
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        let title = items
            .compactMap { $0.attributedTitle?.string.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
        let providers = items.flatMap { $0.attachments ?? [] }
        model.didLoad(await read(providers, title: title))
    }

    /// Primo tipo riconosciuto vince, nell'ordine PDF, immagini, link, testo.
    private func read(_ providers: [NSItemProvider], title: String?) async -> ShareContent {
        if let pdf = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.pdf.identifier) }) {
            return await stagePDF(pdf)
        }
        let images = providers.filter { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }
        if !images.isEmpty {
            return await stageImages(Array(images.prefix(10)))
        }
        if let web = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.url.identifier) }),
           let url = await loadURL(web) {
            if url.isFileURL {
                return url.pathExtension.lowercased() == "pdf" ? await stageFile(url) : .unsupported
            }
            return .link(url, title: title)
        }
        if let plain = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) }),
           let text = await loadText(plain) {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? .unsupported : .text(trimmed)
        }
        return .unsupported
    }

    private func stagePDF(_ provider: NSItemProvider) async -> ShareContent {
        guard let folder = try? ShareInbox.makeFolder() else { return .unreadable }
        do {
            let name = try await copyFile(provider, typeIdentifier: UTType.pdf.identifier,
                                          baseName: "documento", fallbackExtension: "pdf", into: folder)
            return .pdf(folder: folder, name: name)
        } catch {
            ShareInbox.discard(folder)
            return .unreadable
        }
    }

    private func stageImages(_ providers: [NSItemProvider]) async -> ShareContent {
        guard let folder = try? ShareInbox.makeFolder() else { return .unreadable }
        var names: [String] = []
        for (index, provider) in providers.enumerated() {
            if let name = try? await copyFile(provider, typeIdentifier: UTType.image.identifier,
                                              baseName: "immagine-\(index + 1)", fallbackExtension: "jpg", into: folder) {
                names.append(name)
            }
        }
        guard !names.isEmpty else {
            ShareInbox.discard(folder)
            return .unreadable
        }
        return .images(folder: folder, names: names)
    }

    /// PDF condiviso come file dall'app Files: copiato nella cartella di coda, con accesso al file se serve.
    private func stageFile(_ source: URL) async -> ShareContent {
        guard let folder = try? ShareInbox.makeFolder() else { return .unreadable }
        let name = "documento.pdf"
        let target = folder.appendingPathComponent(name)
        do {
            try await Task.detached {
                let scoped = source.startAccessingSecurityScopedResource()
                defer { if scoped { source.stopAccessingSecurityScopedResource() } }
                try FileManager.default.copyItem(at: source, to: target)
            }.value
            return .pdf(folder: folder, name: name)
        } catch {
            ShareInbox.discard(folder)
            return .unreadable
        }
    }

    /// Copia la rappresentazione in file di `provider` nella cartella dell'elemento. Il file temporaneo di sistema
    /// esiste solo dentro il gestore, quindi la copia avviene lì. Restituisce il nome del file copiato.
    private func copyFile(_ provider: NSItemProvider, typeIdentifier: String, baseName: String,
                          fallbackExtension: String, into folder: URL) async throws -> String {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
            _ = provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { @Sendable (source: URL?, error: Error?) in
                guard let source else {
                    continuation.resume(throwing: error ?? ShareReadError.unreadable)
                    return
                }
                let ext = source.pathExtension.isEmpty ? fallbackExtension : source.pathExtension
                let name = "\(baseName).\(ext)"
                do {
                    try FileManager.default.copyItem(at: source, to: folder.appendingPathComponent(name))
                    continuation.resume(returning: name)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private func loadURL(_ provider: NSItemProvider) async -> URL? {
        await withCheckedContinuation { (continuation: CheckedContinuation<URL?, Never>) in
            provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { @Sendable (item: NSSecureCoding?, _: Error?) in
                let url: URL?
                switch item {
                case let value as URL: url = value
                case let text as String: url = URL(string: text)
                case let data as Data: url = URL(string: String(decoding: data, as: UTF8.self))
                default: url = nil
                }
                continuation.resume(returning: url)
            }
        }
    }

    private func loadText(_ provider: NSItemProvider) async -> String? {
        await withCheckedContinuation { (continuation: CheckedContinuation<String?, Never>) in
            provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { @Sendable (item: NSSecureCoding?, _: Error?) in
                let text: String?
                switch item {
                case let value as String: text = value
                case let value as NSAttributedString: text = value.string
                case let data as Data: text = String(data: data, encoding: .utf8)
                default: text = nil
                }
                continuation.resume(returning: text)
            }
        }
    }

    /// Salvataggio o annullamento conclusi: il foglio di sistema si chiude.
    private func complete() {
        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }

    private func cancel() {
        extensionContext?.cancelRequest(withError: CocoaError(.userCancelled))
    }
}

/// Lettura fallita senza un errore di sistema da riportare.
private enum ShareReadError: Error {
    case unreadable
}
