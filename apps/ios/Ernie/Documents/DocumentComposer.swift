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
        case mediaReady
        case failed(String)
    }

    /// Auto riconosce il contenuto; le altre opzioni richiedono esplicitamente uno schema.
    enum SchemaChoice: String, CaseIterable, Identifiable {
        case auto, outline, mindmap, flow, timeline
        var id: String { rawValue }
        var title: String {
            switch self {
            case .outline: "Schema a frecce"
            case .auto: "Riconosci contenuto"
            case .mindmap: "Mappa mentale"
            case .flow: "Flusso"
            case .timeline: "Linea del tempo"
            }
        }
        var symbol: String {
            switch self {
            case .outline: "list.bullet.indent"
            case .auto: "sparkle"
            case .mindmap: "point.3.connected.trianglepath.dotted"
            case .flow: "arrow.triangle.branch"
            case .timeline: "calendar.day.timeline.left"
            }
        }
        /// Parole che il server riconosce nel messaggio.
        var phrase: String? {
            switch self {
            case .outline: "schema a frecce"
            case .auto: nil
            case .mindmap: "mappa mentale"
            case .flow: "flusso"
            case .timeline: "linea del tempo"
            }
        }
    }

    /// Predefinito: riconosci il contenuto; studio solo quando viene scelto o richiesto.
    var schemaChoice: SchemaChoice = .auto
    private(set) var phase: Phase = .idle
    private(set) var mediaSavedCount = 0
    private var api: ApiClient?
    private var job: Task<Void, Never>?
    private var generation = UUID()
    private var mediaTransfers: [MediaUploadHandle] = []

    var isActive: Bool { phase != .idle }
    var ready: DocumentRef? { if case .ready(let ref) = phase { return ref } else { return nil } }

    var statusText: String {
        switch phase {
        case .idle: ""
        case .reading(let page, let of): of > 1 ? "Leggo pagina \(page) di \(of)…" : "Leggo il documento…"
        case .uploading: "Salvo l’allegato…"
        case .ready(let ref): "\(ref.title) · \(ref.pages) \(ref.pages == 1 ? "pagina" : "pagine")"
        case .mediaReady: "\(mediaSavedCount) \(mediaSavedCount == 1 ? "foto salvata" : "foto salvate") in Media · nessun testo da allegare"
        case .failed(let why): "Documento non letto: \(why)"
        }
    }

    func configure(api: ApiClient?) { clear(); self.api = api }

    func clear() {
        generation = UUID()
        job?.cancel()
        job = nil
        for transfer in mediaTransfers { transfer.cancel() }
        mediaTransfers = []
        phase = .idle
        mediaSavedCount = 0
        schemaChoice = .auto
    }

    /// Conserva la richiesta scritta; una scelta di studio vale solo quando non c'è testo.
    func messageText(draft: String) -> String {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { return text }
        guard let phrase = schemaChoice.phrase else { return "Leggi questo allegato." }
        return "Riassumi questo documento per studiarlo e fammi uno schema: \(phrase)."
    }

    func importPDF(_ url: URL) {
        start { progress in
            let ext = url.pathExtension.lowercased()
            if ext == "txt" || ext == "md" { return try DocumentReader.read(text: url) }
            return try await DocumentReader.read(pdf: url, progress: progress)
        }
    }

    func importImages(_ images: [UIImage], source: String) {
        importImages(count: images.count, source: source) { images[$0] }
    }

    /// Il caricamento dal selettore Foto appartiene al composer, non alla task della vista.
    func importImages(count: Int, source: String, image: @escaping @MainActor (Int) async throws -> UIImage) {
        importPhotos(count: count, source: source) { index in MediaImportPhoto(image: try await image(index)) }
    }

    func importPhotos(count: Int, source: String, photo: @escaping @MainActor (Int) async throws -> MediaImportPhoto) {
        clear()
        guard let api else { phase = .failed("Accedi prima di aggiungere una foto."); return }
        guard count > 0, count <= DocumentReader.maxPages else { phase = .failed("Scegli un numero valido di immagini."); return }
        let token = generation
        phase = .reading(page: 1, of: count)
        job = Task {
            let time = MediaPreparationTime(expired: {})
            defer { time.end() }
            var uploads: [MediaUpload] = []
            var images: [UIImage] = []
            var failures = 0
            do {
                // Copia tutte le foto prima di attendere OCR o rete. Un JPEG non leggibile
                // non impedisce di conservare le altre pagine della selezione.
                for index in 0..<count {
                    try Task.checkCancellation()
                    do {
                        let photo = try await photo(index)
                        try Task.checkCancellation()
                        guard generation == token else { return }
                        let automatic = source != "scan" && (UserDefaults.standard.object(forKey: "media.autoOrganize") as? Bool ?? true)
                        let upload = MediaUpload(data: try MediaPresentation.prepare(photo.image), source: source == "scan" ? "scan" : "photo", autoOrganize: automatic, location: photo.location)
                        if api.usesBackgroundMedia {
                            let id = try MediaUploadQueue.shared.stage(upload.data, id: upload.clientId, source: upload.source, autoOrganize: automatic, credentials: api.credentials, location: upload.location)
                            mediaTransfers.append(MediaUploadQueue.shared.handle(id))
                        }
                        uploads.append(upload); images.append(photo.image)
                    } catch { failures += 1 }
                }
                var doc: ImportedDocument?
                do {
                    doc = try await DocumentReader.read(images: images, source: source) { page, total in
                        Task { @MainActor in if self.generation == token { self.advance(page: page, of: total) } }
                    }
                } catch DocumentReader.ReadError.empty { /* Anche una foto senza testo appartiene alla raccolta. */ }
                catch { if Task.isCancelled { throw error }; failures += 1 }
                try Task.checkCancellation()
                guard generation == token else { return }
                phase = .uploading
                var transfers: [MediaUploadHandle] = []
                for (index, var upload) in uploads.enumerated() {
                    upload.ocrText = doc?.pages[index] ?? ""
                    do {
                        let transfer = try api.beginMediaUpload(upload)
                        transfers.append(transfer)
                        if !api.usesBackgroundMedia { mediaTransfers.append(transfer) }
                    } catch { failures += 1 }
                }
                // Tutti i trasferimenti sono già in URLSession. Attenderne uno non
                // blocca più l'avvio delle foto successive, neppure in background.
                time.end()
                if api.usesBackgroundMedia { MediaUploadQueue.shared.preparePending() }
                for transfer in transfers {
                    do {
                        _ = try await transfer.value()
                        guard generation == token, !Task.isCancelled else { return }
                        mediaSavedCount += 1
                    }
                    catch { if Task.isCancelled { throw error }; failures += 1 }
                    guard generation == token, !Task.isCancelled else { return }
                }
                if failures > 0 {
                    phase = .failed("\(mediaSavedCount) di \(count) foto salvate. Controlla in Media i caricamenti da ritentare.")
                } else if let doc {
                    let ref = try await api.createDocument(doc)
                    guard generation == token, !Task.isCancelled else { return }
                    phase = .ready(ref)
                } else { phase = .mediaReady }
            } catch {
                guard generation == token, !Task.isCancelled else { return }
                if api.usesBackgroundMedia { MediaUploadQueue.shared.preparePending() }
                let saved = mediaSavedCount > 0 ? "\(mediaSavedCount) immagini sono già in Media. " : ""
                phase = .failed(saved + MediaPresentation.error(error))
            }
        }
    }

    func start(_ read: @escaping @Sendable (@escaping @Sendable (Int, Int) -> Void) async throws -> ImportedDocument) {
        clear()
        guard let api else { phase = .failed("Accedi prima di allegare un documento."); return }
        let token = generation
        phase = .reading(page: 1, of: 1)
        // La classe è isolata al MainActor (quindi Sendable): la chiusura di avanzamento salta sul main actor.
        let progress: @Sendable (Int, Int) -> Void = { page, of in
            Task { @MainActor in
                guard self.generation == token else { return }
                self.advance(page: page, of: of)
            }
        }
        job = Task {
            do {
                let doc = try await read(progress)
                try Task.checkCancellation()
                guard generation == token else { return }
                phase = .uploading
                let ref = try await api.createDocument(doc)
                try Task.checkCancellation()
                guard generation == token else { return }
                phase = .ready(ref)
                Log.chat.info("documento caricato: \(ref.pages) pagine, \(ref.chars) caratteri")
            } catch is CancellationError {
            } catch {
                guard generation == token, !Task.isCancelled else { return }
                phase = .failed(AppModel.describe(error))
                Log.chat.error("lettura documento fallita: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    private func advance(page: Int, of total: Int) {
        if case .reading = phase { phase = .reading(page: page, of: total) }
    }

}
