import Observation
import UIKit

/// Vive quanto l'account, non quanto il foglio Media. Prima conserva tutti i JPEG,
/// poi la coda esegue OCR e trasferimenti senza bloccare la selezione successiva.
@MainActor @Observable final class MediaImportCoordinator {
    private(set) var progress: String?
    var notice: String?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private let queue: MediaUploadQueue

    init(queue: MediaUploadQueue = .shared) { self.queue = queue }

    func start(count: Int, credentials: Credentials, autoOrganize: Bool,
               image: @escaping @MainActor (Int) async throws -> UIImage) {
        startPhotos(count: count, credentials: credentials, autoOrganize: autoOrganize) { index in
            MediaImportPhoto(image: try await image(index))
        }
    }

    func startPhotos(count: Int, credentials: Credentials, autoOrganize: Bool,
                     photo: @escaping @MainActor (Int) async throws -> MediaImportPhoto) {
        guard task == nil, count > 0, count <= 10 else { return }
        let token = UUID(); generation = token
        notice = nil; progress = "Preparo 1 di \(count) foto…"
        task = Task {
            // Se scade il tempo concesso, i JPEG già copiati sono al sicuro. Il resto
            // della preparazione riprende quando iOS risveglia l'app.
            let time = MediaPreparationTime(expired: {})
            defer { time.end() }
            var saved = 0, unreadable: [Int] = []
            for index in 0..<count {
                guard !Task.isCancelled, generation == token else { break }
                progress = "Preparo \(index + 1) di \(count) foto…"
                do {
                    let photo = try await photo(index)
                    try Task.checkCancellation()
                    guard generation == token else { break }
                    let jpeg = try MediaPresentation.prepare(photo.image)
                    try queue.stage(jpeg, source: "library", autoOrganize: autoOrganize, credentials: credentials, location: photo.location)
                    saved += 1
                } catch {
                    if Task.isCancelled || generation != token { break }
                    unreadable.append(index + 1)
                }
            }
            guard generation == token else { return }
            queue.preparePending()
            progress = nil; task = nil
            if !unreadable.isEmpty {
                notice = "\(saved) di \(count) foto acquisite. Non ho potuto leggere le foto \(unreadable.map(String.init).joined(separator: ", ")). Selezionale di nuovo."
            } else if saved < count {
                notice = "Preparazione interrotta: \(saved) di \(count) foto sono nella coda e verranno caricate."
            } else {
                notice = saved == 1 ? "Foto acquisita." : "Tutte le \(saved) foto sono state acquisite."
            }
        }
    }

    /// Interrompe solo la copia corrente: le foto già affidate alla coda restano.
    func stopPreparing() { task?.cancel() }
    func reset() {
        generation = UUID(); task?.cancel(); task = nil; progress = nil; notice = nil
    }
}
