import Foundation
import CryptoKit
import Observation

protocol DiaryTransforming: Sendable {
    func transform(entries: [DiaryEntry], operation: String) async throws -> DiaryAIResult
}

struct PrivateDiaryAI: DiaryTransforming {
    let credentials: Credentials
    func transform(entries: [DiaryEntry], operation: String) async throws -> DiaryAIResult {
        guard credentials.serverURL.scheme?.lowercased() == "https" else { throw DiaryError.insecureServer }
        struct Body: Encodable {
            let consent = true
            let operation: String
            let entries: [DiaryAIInput]
        }
        let body = Body(operation: operation, entries: entries.map {
            DiaryAIInput(id: $0.id.uuidString, createdAt: $0.createdAt.ISO8601Format(), timeZone: $0.timeZone, original: $0.original)
        })
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.timeoutIntervalForRequest = 90
        let session = URLSession(configuration: configuration, delegate: DiaryNoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let api = ApiClient(credentials: credentials, transport: { request in
            var request = request
            request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
            return try await session.data(for: request)
        })
        return try await api.request("POST", "/v1/private-diary/transform", body: body)
    }
}

private final class DiaryNoRedirect: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@MainActor @Observable final class DiaryStore {
    struct Consent: Identifiable {
        let id = UUID()
        let ids: [UUID]
        let digest: String
        let operation: String
        let characters: Int
    }
    private struct Envelope: Codable { var version = 1; var keyID: String; var sealed: Data }
    private(set) var document: DiaryDocument?
    private(set) var busy = false
    private(set) var unlocking = false
    private(set) var hasUnsavedChanges = false
    private(set) var lostUnsavedChanges = false
    private(set) var consent: Consent?
    private(set) var generation = UUID()
    var error: String?
    @ObservationIgnored private var key: SymmetricKey?
    @ObservationIgnored private var keyID: String?
    @ObservationIgnored private var saving: Task<Void, Never>?
    @ObservationIgnored private var processing: Task<Void, Never>?
    @ObservationIgnored private let file: URL
    @ObservationIgnored private let scope: String
    @ObservationIgnored private let keyAccess: (String) -> any DiaryKeyAccess
    var isUnlocked: Bool { document != nil && key != nil }
    var exists: Bool { FileManager.default.fileExists(atPath: file.path) }

    init(scope: String, directory: URL? = nil, keyAccess: ((String) -> any DiaryKeyAccess)? = nil) {
        self.scope = scope
        self.file = (directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("PrivateDiary", isDirectory: true)).appendingPathComponent(scope + ".sealed")
        self.keyAccess = keyAccess ?? { BiometricDiaryKey(scope: scope + "." + $0) }
    }
    func unlock() async {
        guard !unlocking, !isUnlocked else { return }
        unlocking = true; error = nil
        let token = generation
        defer { unlocking = false }
        do {
            let envelope: Envelope?
            if exists {
                let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard size <= 23_000_000 else { throw DiaryError.invalidArchive }
                envelope = try JSONDecoder().decode(Envelope.self, from: Data(contentsOf: file))
                guard envelope?.version == 1, UUID(uuidString: envelope?.keyID ?? "") != nil else { throw DiaryError.invalidArchive }
            } else { envelope = nil }
            let identifier = envelope?.keyID ?? UUID().uuidString
            let key = try await keyAccess(identifier).unlock(existingVault: envelope != nil)
            guard token == generation, !Task.isCancelled else { return }
            let document = try envelope.map { try DiaryCrypto.open($0.sealed, key: key, scope: scope) } ?? DiaryDocument()
            self.key = key; self.keyID = identifier
            try persist(document)
            self.document = document
        } catch {
            key = nil; document = nil
            self.error = (error as? DiaryError)?.errorDescription ?? DiaryError.unavailable.errorDescription
        }
    }
    func updateDraft(_ text: String) {
        guard isUnlocked, text.count <= 50_000 else { return }
        if document?.draft.text.isEmpty == true && !text.isEmpty {
            document?.draft.createdAt = .now
            document?.draft.timeZone = TimeZone.current.identifier
        }
        document?.draft.text = text
        hasUnsavedChanges = true
        saving?.cancel()
        saving = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(350)) } catch { return }
            self?.flush()
        }
    }
    func flush() {
        saving?.cancel(); saving = nil
        guard let document, key != nil else { return }
        do { try persist(document); hasUnsavedChanges = false } catch { self.error = DiaryError.writeFailed.errorDescription }
    }
    @discardableResult func saveEntry() -> UUID? {
        guard var updated = document, !updated.draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        let entry = DiaryEntry(createdAt: updated.draft.createdAt, timeZone: updated.draft.timeZone, original: updated.draft.text)
        updated.entries.insert(entry, at: 0)
        updated.draft = DiaryDraft()
        do { try persist(updated); document = updated; hasUnsavedChanges = false; error = nil; return entry.id }
        catch { self.error = DiaryError.writeFailed.errorDescription; return nil }
    }
    @discardableResult func appendIncoming(_ text: String) -> Bool {
        guard !text.isEmpty else { return true }
        guard var updated = document, text.count <= 50_000 else {
            error = "Il testo supera 50.000 caratteri e non è stato salvato. Mantieni aperto il diario per ridurlo."
            return false
        }
        let combined = [updated.draft.text, text].filter { !$0.isEmpty }.joined(separator: "\n")
        if combined.count <= 50_000 {
            if updated.draft.text.isEmpty { updated.draft = DiaryDraft() }
            updated.draft.text = combined
        } else {
            updated.entries.insert(DiaryEntry(createdAt: .now, timeZone: TimeZone.current.identifier, original: text), at: 0)
        }
        do { try persist(updated); document = updated; hasUnsavedChanges = false; return true }
        catch { self.error = DiaryError.writeFailed.errorDescription; return false }
    }
    func lock() {
        flush()
        if hasUnsavedChanges { lostUnsavedChanges = true }
        hasUnsavedChanges = false
        generation = UUID()
        processing?.cancel(); processing = nil
        consent = nil; busy = false
        document = nil; key = nil; keyID = nil
    }
    func prepareAI(ids: [UUID], operation: String) throws {
        guard let document, isUnlocked, !busy else { throw DiaryError.locked }
        let entries = ids.compactMap { id in document.entries.first { $0.id == id } }
        let count = entries.reduce(0) { $0 + $1.original.count }
        guard !entries.isEmpty, entries.count == ids.count, entries.count <= 31, Set(ids).count == ids.count,
              count <= 60_000, operation == "period" || (operation == "entry" && entries.count == 1) else { throw DiaryError.tooLarge }
        consent = Consent(ids: ids, digest: DiaryIdentity.digest(entries), operation: operation, characters: count)
    }
    func cancelConsent() { consent = nil }
    func authorize(_ id: UUID, client: any DiaryTransforming) throws {
        guard let consent, consent.id == id, let document, isUnlocked, !busy else { throw DiaryError.consentRequired }
        let entries = consent.ids.compactMap { id in document.entries.first { $0.id == id } }
        guard DiaryIdentity.digest(entries) == consent.digest else { throw DiaryError.consentRequired }
        let token = generation
        self.consent = nil; busy = true; error = nil
        processing = Task { [weak self] in
            do {
                let response = try await client.transform(entries: entries, operation: consent.operation)
                try Task.checkCancellation()
                guard let self, self.generation == token, self.isUnlocked, var updated = self.document else { return }
                let revision = DiaryRevision(normalized: response.normalized, bullets: response.bullets, model: response.model,
                                             sourceIDs: consent.ids, sourceDigest: consent.digest)
                if consent.operation == "entry", let index = updated.entries.firstIndex(where: { $0.id == consent.ids[0] }) {
                    updated.entries[index].revisions.append(revision)
                } else { updated.summaries.insert(revision, at: 0) }
                try self.persist(updated)
                self.document = updated; self.busy = false
            } catch {
                guard let self, self.generation == token, self.isUnlocked else { return }
                self.busy = false
                // Provider errors or response bodies must never reach diagnostics/UI.
                self.error = "Elaborazione non completata. L’originale è conservato; puoi autorizzare un nuovo tentativo."
            }
        }
    }
    func exportBackup(password: String) throws -> Data {
        guard let document, isUnlocked else { throw DiaryError.locked }
        return try DiaryCrypto.backup(document, password: password)
    }
    /// Restore into a fresh key generation only AFTER the password authenticates
    /// the backup. A missing biometric key never causes silent journal deletion.
    func restoreBackup(_ data: Data, password: String) async throws {
        let restored = try DiaryCrypto.restore(data, password: password)
        let token = generation
        if isUnlocked, var current = document {
            let ids = Set(current.entries.map(\.id))
            current.entries += restored.entries.filter { !ids.contains($0.id) }
            let summaries = Set(current.summaries.map(\.id))
            current.summaries += restored.summaries.filter { !summaries.contains($0.id) }
            if current.draft.text.isEmpty { current.draft = restored.draft }
            try persist(current); document = current
        } else {
            let identifier = UUID().uuidString
            unlocking = true
            defer { unlocking = false }
            let recoveredKey = try await keyAccess(identifier).unlock(existingVault: false)
            guard token == generation, !Task.isCancelled else { throw DiaryError.locked }
            self.key = recoveredKey; self.keyID = identifier
            do {
                // Keep the old ciphertext available if this recovery copy is older.
                if exists {
                    let recovery = file.deletingLastPathComponent().appendingPathComponent(scope + ".previous-" + UUID().uuidString + ".sealed")
                    try Data(contentsOf: file).write(to: recovery, options: [.atomic, .completeFileProtection])
                }
                try persist(restored); document = restored
            }
            catch { self.key = nil; self.keyID = nil; throw error }
        }
    }
    private func persist(_ document: DiaryDocument) throws {
        guard let key, let keyID else { throw DiaryError.locked }
        let encrypted = try DiaryCrypto.seal(document, key: key, scope: scope)
        let data = try JSONEncoder().encode(Envelope(keyID: keyID, sealed: encrypted))
        let directory = file.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                               attributes: [.protectionKey: FileProtectionType.complete])
        var directoryURL = directory
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try directoryURL.setResourceValues(values)
        try data.write(to: file, options: [.atomic, .completeFileProtection])
    }
}
