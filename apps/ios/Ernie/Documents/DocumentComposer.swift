import Foundation
import Observation
import UIKit

/// Allegato in preparazione nella barra: lettura sul telefono (OCR) con avanzamento, caricamento del testo, pronto da inviare.
@MainActor
@Observable
final class DocumentComposer {
    enum Phase: Equatable {
        case idle
        case reading(page: Int, of: Int)
        case uploading
        case ready(DocumentRef)
        case failed(String)
    }

    private(set) var phase: Phase = .idle
    private var api: ApiClient?
    private var job: Task<Void, Never>?

    var isActive: Bool { phase != .idle }
    var ready: DocumentRef? { if case .ready(let ref) = phase { return ref } else { return nil } }

    var statusText: String {
        switch phase {
        case .idle: ""
        case .reading(let page, let of): of > 1 ? "Leggo pagina \(page) di \(of)…" : "Leggo il documento…"
        case .uploading: "Carico il testo…"
        case .ready(let ref): "\(ref.title) · \(ref.pages) \(ref.pages == 1 ? "pagina" : "pagine")"
        case .failed(let why): "Documento non letto: \(why)"
        }
    }

    func configure(api: ApiClient?) { self.api = api }

    func clear() {
        job?.cancel()
        job = nil
        phase = .idle
    }

    func importPDF(_ url: URL) {
        start { progress in
            let ext = url.pathExtension.lowercased()
            if ext == "txt" || ext == "md" { return try DocumentReader.read(text: url) }
            return try await DocumentReader.read(pdf: url, progress: progress)
        }
    }

    func importImages(_ images: [UIImage], source: String) {
        start { progress in try await DocumentReader.read(images: images, source: source, progress: progress) }
    }

    private func start(_ read: @escaping @Sendable (@escaping @Sendable (Int, Int) -> Void) async throws -> ImportedDocument) {
        job?.cancel()
        phase = .reading(page: 1, of: 1)
        // La classe è isolata al MainActor (quindi Sendable): la chiusura di avanzamento salta sul main actor.
        let progress: @Sendable (Int, Int) -> Void = { page, of in
            Task { @MainActor in self.advance(page: page, of: of) }
        }
        job = Task {
            do {
                let doc = try await read(progress)
                try Task.checkCancellation()
                guard let api else { return }
                phase = .uploading
                let ref = try await api.createDocument(doc)
                try Task.checkCancellation()
                phase = .ready(ref)
                Log.chat.info("documento caricato: \(ref.pages) pagine, \(ref.chars) caratteri")
            } catch is CancellationError {
            } catch {
                phase = .failed(AppModel.describe(error))
                Log.chat.error("lettura documento fallita: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    private func advance(page: Int, of total: Int) {
        if case .reading = phase { phase = .reading(page: page, of: total) }
    }

}
