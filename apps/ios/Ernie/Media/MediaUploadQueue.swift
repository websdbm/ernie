import CryptoKit
import Foundation
import Observation
import UIKit

/// Un trasferimento già consegnato alla coda. Annullare chi attende non annulla la foto.
@MainActor struct MediaUploadHandle {
    let id: String
    let value: @MainActor () async throws -> SavedMedia
    let cancel: @MainActor () -> Void
}

struct PendingMediaUpload: Codable, Identifiable, Sendable {
    enum State: String, Codable, Sendable { case preparing, waiting, uploading, failed, complete }
    var id: String
    var owner: String
    var hash: String
    var source: String
    var autoOrganize: Bool
    var createdAt = Date()
    var state: State = .preparing
    var attempts = 0
    var bodyReady = false
    var error: String?
    var result: SavedMedia?
    var location: MediaLocation? = nil
}

@MainActor protocol MediaUploadDriving: AnyObject {
    var completed: ((String, Int, Int, Data, NSError?) -> Void)? { get set }
    var backgroundCompletion: (() -> Void)? { get set }
    func restore(allowed: [String: Int]) async -> Set<String>
    func send(id: String, attempt: Int, request: URLRequest, file: URL, earliest: Date?)
    func cancel(ids: Set<String>)
}

/// Il processo di rete di iOS legge un file stabile, non il corpo di una dataTask in memoria.
@MainActor final class SystemMediaUploadDriver: NSObject, MediaUploadDriving {
    static let identifier = "com.websdbm.ernie.media-uploads.v1"
    var completed: ((String, Int, Int, Data, NSError?) -> Void)?
    var backgroundCompletion: (() -> Void)?
    private var received: [Int: Data] = [:]
    private let configuration: URLSessionConfiguration
    private lazy var session = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)

    init(configuration: URLSessionConfiguration? = nil) {
        let config = configuration ?? Self.backgroundConfiguration()
        self.configuration = config
        super.init()
    }
    static func backgroundConfiguration() -> URLSessionConfiguration {
        let config = URLSessionConfiguration.background(withIdentifier: identifier)
        config.isDiscretionary = false
        config.sessionSendsLaunchEvents = true
        config.waitsForConnectivity = true
        config.timeoutIntervalForRequest = 90
        config.timeoutIntervalForResource = 24 * 60 * 60
        config.httpMaximumConnectionsPerHost = 3
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.httpCookieStorage = nil
        return config
    }
    func restore(allowed: [String: Int]) async -> Set<String> {
        var active = Set<String>()
        for task in await session.allTasks {
            guard let (id, attempt) = Self.identity(task), allowed[id] == attempt,
                  task.state != .completed, active.insert(id).inserted else { task.cancel(); continue }
            if task.state == .suspended { task.resume() }
        }
        return active
    }
    func send(id: String, attempt: Int, request: URLRequest, file: URL, earliest: Date?) {
        let task = session.uploadTask(with: request, fromFile: file)
        task.taskDescription = "\(id):\(attempt)"
        task.earliestBeginDate = earliest
        task.countOfBytesClientExpectsToSend = Int64((try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        task.countOfBytesClientExpectsToReceive = 32_000
        task.resume()
    }
    func cancel(ids: Set<String>) {
        Task {
            for task in await session.allTasks {
                if let (id, _) = Self.identity(task), ids.contains(id) { task.cancel() }
            }
        }
    }
    private static func identity(_ task: URLSessionTask) -> (String, Int)? {
        let parts = (task.taskDescription ?? "").split(separator: ":")
        guard parts.count == 2, UUID(uuidString: String(parts[0])) != nil, let attempt = Int(parts[1]) else { return nil }
        return (String(parts[0]), attempt)
    }
}

extension SystemMediaUploadDriver: URLSessionDataDelegate {
    // La sessione consegna tutti gli eventi su OperationQueue.main. L'elaborazione sincrona
    // mantiene l'ordine dati → esito → completion handler di iOS, anche durante il rilancio.
    nonisolated func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        MainActor.assumeIsolated {
            guard (received[dataTask.taskIdentifier]?.count ?? 0) + data.count <= 256_000 else { dataTask.cancel(); return }
            received[dataTask.taskIdentifier, default: Data()].append(data)
        }
    }
    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        MainActor.assumeIsolated {
            let data = received.removeValue(forKey: task.taskIdentifier) ?? Data()
            guard let (id, attempt) = Self.identity(task) else { return }
            completed?(id, attempt, (task.response as? HTTPURLResponse)?.statusCode ?? 0, data, error as NSError?)
        }
    }
    nonisolated func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        MainActor.assumeIsolated {
            let completion = backgroundCompletion
            backgroundCompletion = nil
            completion?()
        }
    }
}

/// Tempo limitato per copiare/OCR le foto selezionate. Il trasferimento vero usa URLSession background.
@MainActor final class MediaPreparationTime {
    private var identifier: UIBackgroundTaskIdentifier = .invalid
    init(expired: @escaping @MainActor () -> Void) {
        identifier = UIApplication.shared.beginBackgroundTask(withName: "Preparo le foto") { [weak self] in
            MainActor.assumeIsolated { expired(); self?.end() }
        }
    }
    func end() {
        guard identifier != .invalid else { return }
        UIApplication.shared.endBackgroundTask(identifier); identifier = .invalid
    }
}

/// Foto e stato sopravvivono alla vista e al processo. I segreti restano nel Keychain.
@MainActor @Observable final class MediaUploadQueue {
    static let shared = MediaUploadQueue()
    private(set) var entries: [PendingMediaUpload] = []
    private(set) var revision = 0
    private(set) var storageError: String?
    private let root: URL
    @ObservationIgnored private let driver: any MediaUploadDriving
    @ObservationIgnored private var credentials: Credentials?
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var active = Set<String>()
    @ObservationIgnored private var restoring = false
    @ObservationIgnored private var didRestore = false
    @ObservationIgnored private var preparation: Task<Void, Never>?
    @ObservationIgnored private var preparationGeneration = UUID()
    @ObservationIgnored private var waiters: [String: [UUID: CheckedContinuation<SavedMedia, any Error>]] = [:]

    init(root: URL? = nil, driver: (any MediaUploadDriving)? = nil) {
        self.root = root ?? URL.applicationSupportDirectory.appendingPathComponent("MediaUploads", isDirectory: true)
        self.driver = driver ?? SystemMediaUploadDriver()
        let files = (try? FileManager.default.contentsOfDirectory(at: self.root, includingPropertiesForKeys: nil)) ?? []
        entries = files.filter { $0.pathExtension == "entry" }.compactMap { file in
            guard UUID(uuidString: file.deletingPathExtension().lastPathComponent) != nil,
                  let data = try? Data(contentsOf: file), data.count < 100_000,
                  let entry = try? JSONDecoder().decode(PendingMediaUpload.self, from: data),
                  entry.id == file.deletingPathExtension().lastPathComponent else { return nil }
            return entry
        }.sorted { $0.createdAt < $1.createdAt }
        self.driver.completed = { [weak self] id, attempt, status, data, error in
            self?.finished(id: id, attempt: attempt, status: status, data: data, error: error)
        }
    }
    var pending: [PendingMediaUpload] { visible.filter { [.preparing, .waiting, .uploading].contains($0.state) } }
    var failed: [PendingMediaUpload] { visible.filter { $0.state == .failed } }
    private var visible: [PendingMediaUpload] {
        guard let credentials else { return [] }
        let owner = Self.owner(credentials)
        return entries.filter { $0.owner == owner }
    }
    static func owner(_ credentials: Credentials) -> String {
        SHA256.hash(data: Data("\(credentials.serverURL.absoluteString)|\(credentials.apiKey)".utf8)).map { String(format: "%02x", $0) }.joined()
    }
    func configure(_ credentials: Credentials?) {
        if self.credentials == credentials, credentials != nil { Task { await resume() }; return }
        generation = UUID(); self.credentials = credentials; didRestore = false
        preparationGeneration = UUID(); preparation?.cancel(); preparation = nil
        if let credentials {
            cancel(ids: Set(entries.filter { $0.owner != Self.owner(credentials) }.map(\.id)))
            // Le ricevute non contengono foto; bastano sette giorni per recuperare un completamento.
            cancel(ids: Set(entries.filter { $0.state == .complete && $0.createdAt < Date().addingTimeInterval(-7 * 86400) }.map(\.id)))
            Task { await resume() }
        } else {
            preparationGeneration = UUID(); preparation?.cancel(); preparation = nil
            cancel(ids: Set(entries.map(\.id)))
        }
    }
    func handleBackgroundEvents(_ identifier: String, completion: @escaping () -> Void) {
        guard identifier == SystemMediaUploadDriver.identifier else { completion(); return }
        driver.backgroundCompletion = completion
        if credentials == nil, let saved = Credentials.load() { credentials = saved }
        Task { await resume() }
    }
    func resume() async {
        guard let credentials, !restoring else { return }
        // In questo processo i task avviati sono già noti. Un task assente da
        // allTasks può avere la risposta ancora nella coda dei delegate: aspettala,
        // senza reinviare la foto a ogni ritorno in primo piano.
        if didRestore {
            for entry in pending where entry.bodyReady && !active.contains(entry.id) { send(entry.id) }
            preparePending(); return
        }
        restoring = true
        let token = generation
        let allowed = Dictionary(uniqueKeysWithValues: entries.filter { $0.owner == Self.owner(credentials) && $0.state == .uploading }.map { ($0.id, $0.attempts) })
        let restored = await driver.restore(allowed: allowed)
        restoring = false
        guard token == generation else { await resume(); return }
        didRestore = true
        active = restored.filter { id in entries.contains { $0.id == id && $0.state == .uploading } }
        for entry in pending where entry.bodyReady && !active.contains(entry.id) { send(entry.id) }
        preparePending()
    }

    /// Salva subito ogni JPEG. OCR e upload avvengono successivamente e indipendentemente dalle altre foto.
    @discardableResult func stage(_ jpeg: Data, id: String = UUID().uuidString, source: String, autoOrganize: Bool, credentials: Credentials, location: MediaLocation? = nil) throws -> String {
        try require(credentials)
        let entry = try create(jpeg: jpeg, id: id, source: source, autoOrganize: autoOrganize, credentials: credentials, location: location)
        return entry.id
    }
    /// Documento già letto: il payload è pronto, quindi tutte le pagine possono partire insieme.
    func enqueue(_ upload: MediaUpload, credentials: Credentials) throws -> MediaUploadHandle {
        try require(credentials)
        var entry = try create(jpeg: upload.data, id: upload.clientId, source: upload.source, autoOrganize: upload.autoOrganize, credentials: credentials, location: upload.location)
        if entry.state != .complete && !entry.bodyReady {
            try writeBody(upload)
            entry.bodyReady = true; entry.state = .waiting; try save(entry)
        }
        send(entry.id)
        return handle(entry.id)
    }
    func handle(_ id: String) -> MediaUploadHandle {
        MediaUploadHandle(id: id, value: { [self] in try await result(id) }, cancel: { [self] in cancel(ids: [id]) })
    }
    func preparePending() {
        guard preparation == nil, credentials != nil, pending.contains(where: { !$0.bodyReady }) else { return }
        let token = UUID(); preparationGeneration = token
        preparation = Task { [weak self] in
            guard let self else { return }
            let time = MediaPreparationTime { [weak self] in self?.preparation?.cancel() }
            defer { time.end(); if self.preparationGeneration == token { self.preparation = nil } }
            while let entry = self.pending.first(where: { !$0.bodyReady }) {
                guard !Task.isCancelled, self.preparationGeneration == token else { return }
                do {
                    let data = try Data(contentsOf: self.file(entry.id, "jpg"))
                    guard let image = UIImage(data: data) else { throw DocumentReader.ReadError.unreadable }
                    let doc = try? await DocumentReader.read(images: [image], source: entry.source, progress: { _, _ in })
                    try Task.checkCancellation()
                    guard self.preparationGeneration == token, self.entries.contains(where: { $0.id == entry.id && !$0.bodyReady && $0.state == .preparing }) else { continue }
                    try self.writeBody(MediaUpload(clientId: entry.id, data: data, source: entry.source, ocrText: doc?.pages.joined(separator: "\n") ?? "", autoOrganize: entry.autoOrganize, location: entry.location))
                    var ready = entry; ready.bodyReady = true; ready.state = .waiting
                    try self.save(ready); self.send(entry.id)
                } catch {
                    if Task.isCancelled { return }
                    self.fail(entry.id, message: "Non riesco a preparare questa foto. Riprova dalla raccolta.")
                }
            }
        }
    }
    func retryFailed() {
        for var entry in failed {
            entry.attempts = 0; entry.error = nil; entry.state = entry.bodyReady ? .waiting : .preparing
            do { try save(entry); if entry.bodyReady { send(entry.id) } } catch { storageError = "Spazio insufficiente per salvare la coda delle foto." }
        }
        preparePending()
    }
    func cancel(ids: Set<String>) {
        guard !ids.isEmpty else { return }
        driver.cancel(ids: ids); active.subtract(ids)
        for id in ids {
            for ext in ["jpg", "body", "entry"] { try? FileManager.default.removeItem(at: file(id, ext)) }
            resolve(id, .failure(CancellationError()))
        }
        entries.removeAll { ids.contains($0.id) }; revision += 1
    }
    func result(_ id: String) async throws -> SavedMedia {
        try Task.checkCancellation()
        guard let entry = visible.first(where: { $0.id == id }) else { throw CancellationError() }
        if let result = entry.result { return result }
        if entry.state == .failed { throw ApiError(status: 0, code: "media_upload", message: entry.error ?? "Foto non caricata") }
        let token = UUID()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { waiters[id, default: [:]][token] = $0 }
        } onCancel: {
            Task { @MainActor [weak self] in self?.waiters[id]?.removeValue(forKey: token)?.resume(throwing: CancellationError()) }
        }
    }

    private func require(_ credentials: Credentials) throws {
        guard self.credentials == credentials else { throw CancellationError() }
    }
    private func create(jpeg: Data, id: String, source: String, autoOrganize: Bool, credentials: Credentials, location: MediaLocation?) throws -> PendingMediaUpload {
        guard UUID(uuidString: id) != nil, !jpeg.isEmpty, jpeg.count <= 3_000_000 else { throw DocumentReader.ReadError.unreadable }
        let hash = SHA256.hash(data: jpeg).map { String(format: "%02x", $0) }.joined()
        if let old = entries.first(where: { $0.id == id }) {
            guard old.owner == Self.owner(credentials), old.hash == hash else { throw CancellationError() }
            return old
        }
        let entry = PendingMediaUpload(id: id, owner: Self.owner(credentials), hash: hash, source: source, autoOrganize: autoOrganize, location: location?.isValid == true ? location : nil)
        try ensureDirectory()
        try jpeg.write(to: file(id, "jpg"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        do { try save(entry) } catch { try? FileManager.default.removeItem(at: file(id, "jpg")); throw error }
        return entry
    }
    private func ensureDirectory() throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var directory = root, values = URLResourceValues(); values.isExcludedFromBackup = true
        try directory.setResourceValues(values)
    }
    private func file(_ id: String, _ ext: String) -> URL { root.appendingPathComponent(id).appendingPathExtension(ext) }
    private func save(_ entry: PendingMediaUpload) throws {
        try ensureDirectory()
        try JSONEncoder().encode(entry).write(to: file(entry.id, "entry"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        if let index = entries.firstIndex(where: { $0.id == entry.id }) { entries[index] = entry } else { entries.append(entry) }
        revision += 1
    }
    private func writeBody(_ upload: MediaUpload) throws {
        struct Body: Encodable { var clientId: String; var data: String; var source: String; var ocrText: String; var autoOrganize: Bool; var location: MediaLocation? }
        let body = Body(clientId: upload.clientId, data: upload.data.base64EncodedString(), source: upload.source, ocrText: String(upload.ocrText.prefix(60_000)), autoOrganize: upload.autoOrganize, location: upload.location?.isValid == true ? upload.location : nil)
        try JSONEncoder().encode(body).write(to: file(upload.clientId, "body"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    private func send(_ id: String) {
        guard !restoring, let credentials, var entry = entries.first(where: { $0.id == id }), entry.owner == Self.owner(credentials), entry.bodyReady,
              entry.state != .complete, entry.state != .failed, !active.contains(id) else { return }
        guard entry.attempts < 3 else { fail(id, message: "Il caricamento non è riuscito dopo più tentativi. La foto è sul telefono: tocca Riprova."); return }
        guard let url = URL(string: "/v1/media", relativeTo: credentials.serverURL), FileManager.default.fileExists(atPath: file(id, "body").path) else { fail(id, message: "Il file da caricare non è disponibile."); return }
        entry.state = .uploading; entry.attempts += 1
        do { try save(entry) } catch { storageError = "Non riesco a salvare lo stato del caricamento."; return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(credentials.apiKey)", forHTTPHeaderField: "Authorization")
        active.insert(id)
        var earliest = entry.attempts > 1 ? Date().addingTimeInterval(Double(entry.attempts * 2)) : nil
        #if DEBUG
        if let delay = ProcessInfo.processInfo.environment["ERNIE_DEBUG_MEDIA_DELAY"].flatMap(Double.init), delay > 0 { earliest = Date().addingTimeInterval(min(60, delay)) }
        #endif
        driver.send(id: id, attempt: entry.attempts, request: request, file: file(id, "body"), earliest: earliest)
    }
    private func finished(id: String, attempt: Int, status: Int, data: Data, error: NSError?) {
        guard var entry = visible.first(where: { $0.id == id }), entry.attempts == attempt, entry.state == .uploading else { return }
        active.remove(id)
        struct Response: Decodable { var item: SavedMedia }
        if error == nil, (200..<300).contains(status), let response = try? JSONDecoder().decode(Response.self, from: data) {
            entry.state = .complete; entry.result = response.item; entry.error = nil
            do {
                try save(entry)
                for ext in ["jpg", "body"] { try? FileManager.default.removeItem(at: file(id, ext)) }
                resolve(id, .success(response.item))
            } catch { fail(id, message: "La foto potrebbe essere già salvata. Tocca Riprova per verificarla senza duplicarla.") }
            return
        }
        let retryableCodes = [NSURLErrorTimedOut, NSURLErrorNotConnectedToInternet, NSURLErrorNetworkConnectionLost, NSURLErrorCannotConnectToHost, NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed, NSURLErrorCancelled, NSURLErrorBackgroundSessionWasDisconnected]
        let transient = error.map { $0.domain == NSURLErrorDomain && retryableCodes.contains($0.code) } ?? ([408, 429, 500, 502, 503, 504].contains(status) || (200..<300).contains(status))
        if transient, entry.attempts < 3 { send(id); return }
        let message: String
        if [401, 403].contains(status) { message = "Accedi di nuovo per caricare questa foto." }
        else if status == 413 { message = "Spazio della raccolta esaurito o foto troppo grande. Libera spazio e riprova." }
        else { message = "Foto non caricata. È ancora sul telefono: controlla la connessione e tocca Riprova." }
        fail(id, message: message)
    }
    private func fail(_ id: String, message: String) {
        guard var entry = entries.first(where: { $0.id == id }) else { return }
        active.remove(id); entry.state = .failed; entry.error = message
        do { try save(entry) } catch { storageError = message }
        resolve(id, .failure(ApiError(status: 0, code: "media_upload", message: message)))
    }
    private func resolve(_ id: String, _ result: Result<SavedMedia, any Error>) {
        let pending = waiters.removeValue(forKey: id) ?? [:]
        for waiter in pending.values { waiter.resume(with: result) }
    }
}
