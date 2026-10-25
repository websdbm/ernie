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

/// File cifrati del diario, letti e scritti fuori dal main (tutto Sendable). Il diario intero sta in `<scope>.sealed`,
/// la bozza in `<scope>.draft.sealed` (piccolo: la digitazione non ricifra più l'intero diario), le copie conservate
/// dal ripristino in `<scope>.previous-<uuid>.sealed`.
struct DiaryVault: Sendable {
    struct Envelope: Codable, Sendable { var version = 1; var keyID: String; var sealed: Data }
    struct Stored: Sendable { var main: Envelope?; var draft: Envelope? }
    /// Una scrittura: prima il diario intero (se c'è), poi la bozza. Chiave e contenuto catturati quando la scrittura
    /// è chiesta, così l'ultima scrittura prosegue anche dopo il blocco.
    struct Job: Sendable {
        var main: DiaryDocument?
        var draft: DiaryDraft
        let key: SymmetricKey
        let keyID: String
        var generation: UUID
        var change: Int
    }

    let scope: String
    let file: URL
    let draftFile: URL
    var directory: URL { file.deletingLastPathComponent() }

    init(scope: String, directory: URL) {
        self.scope = scope
        file = directory.appendingPathComponent(scope + ".sealed")
        draftFile = directory.appendingPathComponent(scope + ".draft.sealed")
    }

    func read() throws -> Stored {
        guard FileManager.default.fileExists(atPath: file.path) else { return Stored() }
        let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size <= 23_000_000 else { throw DiaryError.invalidArchive }
        let main = try JSONDecoder().decode(Envelope.self, from: Data(contentsOf: file))
        guard main.version == 1, UUID(uuidString: main.keyID) != nil else { throw DiaryError.invalidArchive }
        // La bozza è facoltativa: illeggibile o cifrata con un'altra chiave (prima di un ripristino) non conta.
        var draft: Envelope?
        if let data = try? Data(contentsOf: draftFile), data.count <= 1_500_000,
           let envelope = try? JSONDecoder().decode(Envelope.self, from: data), envelope.version == 1, envelope.keyID == main.keyID {
            draft = envelope
        }
        return Stored(main: main, draft: draft)
    }

    func open(_ stored: Stored, key: SymmetricKey) throws -> DiaryDocument {
        guard let main = stored.main else { return DiaryDocument() }
        var document = try DiaryCrypto.open(main.sealed, key: key, scope: scope)
        if let envelope = stored.draft, let draft = try? DiaryCrypto.openDraft(envelope.sealed, key: key, scope: scope) {
            // Il file della bozza vale più della bozza nel diario intero (si scrive dopo). Se la bozza è già diventata
            // una pagina (chiusura fra le due scritture), non si ripropone.
            let alreadySaved = !draft.text.isEmpty && document.entries.contains { $0.createdAt == draft.createdAt && $0.original == draft.text }
            document.draft = alreadySaved ? DiaryDraft() : draft
        }
        return document
    }

    func write(_ job: Job) throws {
        let directory = self.directory
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                               attributes: [.protectionKey: FileProtectionType.complete])
        var directoryURL = directory
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try directoryURL.setResourceValues(values)
        if let main = job.main {
            let sealed = try DiaryCrypto.seal(main, key: job.key, scope: scope)
            try JSONEncoder().encode(Envelope(keyID: job.keyID, sealed: sealed)).write(to: file, options: [.atomic, .completeFileProtection])
        }
        let draft = try DiaryCrypto.sealDraft(job.draft, key: job.key, scope: scope)
        try JSONEncoder().encode(Envelope(keyID: job.keyID, sealed: draft)).write(to: draftFile, options: [.atomic, .completeFileProtection])
    }

    /// Copia del cifrato attuale prima che un ripristino lo sostituisca (la copia potrebbe essere più vecchia).
    func preserveCurrent() throws {
        guard FileManager.default.fileExists(atPath: file.path) else { return }
        let recovery = directory.appendingPathComponent(scope + ".previous-" + UUID().uuidString + ".sealed")
        try Data(contentsOf: file).write(to: recovery, options: [.atomic, .completeFileProtection])
    }

    /// Elimina tutti i file del diario (diario, bozza, copie conservate) e restituisce le chiavi che li aprivano.
    func removeAll() throws -> Set<String> {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        var keys = Set<String>()
        for name in names where name.hasPrefix(scope + ".") && name.hasSuffix(".sealed") {
            let url = directory.appendingPathComponent(name)
            if let data = try? Data(contentsOf: url), let envelope = try? JSONDecoder().decode(Envelope.self, from: data),
               UUID(uuidString: envelope.keyID) != nil {
                keys.insert(envelope.keyID)
            }
            try FileManager.default.removeItem(at: url)
        }
        return keys
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
    private(set) var document: DiaryDocument?
    private(set) var busy = false
    private(set) var unlocking = false
    private(set) var deleting = false
    private(set) var hasUnsavedChanges = false
    private(set) var lostUnsavedChanges = false
    private(set) var consent: Consent?
    private(set) var generation = UUID()
    /// Avviso di permesso di iOS aperto dalla dettatura: lo stato inattivo che provoca non blocca il diario (il
    /// passaggio in background sì). Prima la prima dettatura bloccava il diario appena compariva l'avviso.
    private(set) var permissionPrompt = false
    var error: String?
    @ObservationIgnored private var key: SymmetricKey?
    @ObservationIgnored private var keyID: String?
    @ObservationIgnored private var saving: Task<Void, Never>?
    @ObservationIgnored private var processing: Task<Void, Never>?
    // Scritture serializzate fuori dal main: una in volo, la successiva raccoglie le richieste arrivate nel frattempo.
    @ObservationIgnored private var writer: Task<Void, Never>?
    @ObservationIgnored private var queued: DiaryVault.Job?
    @ObservationIgnored private var changes = 0
    /// L'ultima scrittura del diario intero è fallita: la prossima lo riscrive, anche se cambia solo la bozza.
    @ObservationIgnored private var mainPending = false
    @ObservationIgnored private var writeErrorShown = false
    @ObservationIgnored private var requestingPermission = false
    @ObservationIgnored private let vault: DiaryVault
    @ObservationIgnored private let scope: String
    @ObservationIgnored private let keyAccess: (String) -> any DiaryKeyAccess
    var isUnlocked: Bool { document != nil && key != nil }
    /// L'ultimo sblocco è fallito perché la chiave non si apre più: l'unico caso in cui il ripristino sostituisce.
    private(set) var keyInvalidated = false
    var exists: Bool { FileManager.default.fileExists(atPath: vault.file.path) }

    init(scope: String, directory: URL? = nil, keyAccess: ((String) -> any DiaryKeyAccess)? = nil) {
        self.scope = scope
        self.vault = DiaryVault(scope: scope, directory: directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("PrivateDiary", isDirectory: true))
        self.keyAccess = keyAccess ?? { BiometricDiaryKey(scope: scope + "." + $0) }
    }
    /// Lettura e decifratura fuori dal main; il main riceve solo il documento pronto.
    func unlock() async {
        guard !unlocking, !isUnlocked, !deleting else { return }
        unlocking = true; error = nil
        let token = generation
        defer { unlocking = false }
        do {
            // Prima le scritture ancora in volo del blocco precedente, poi la lettura.
            await saved()
            guard token == generation, !Task.isCancelled else { return }
            let vault = self.vault
            let stored = try await Task.detached(priority: .userInitiated) { try vault.read() }.value
            let identifier = stored.main?.keyID ?? UUID().uuidString
            let key = try await keyAccess(identifier).unlock(existingVault: stored.main != nil)
            guard token == generation, !Task.isCancelled else { return }
            let document = try await Task.detached(priority: .userInitiated) { try vault.open(stored, key: key) }.value
            guard token == generation, !Task.isCancelled else { return }
            self.key = key; self.keyID = identifier
            self.document = document
            if stored.main == nil {
                // Diario nuovo: il file esiste prima di mostrare le pagine, così il prossimo sblocco usa questa chiave.
                markChanged(main: true)
                await saved()
                guard token == generation else { return }
                if mainPending { throw DiaryError.writeFailed }
            }
            keyInvalidated = false
        } catch {
            guard token == generation else { return }
            key = nil; keyID = nil; document = nil
            hasUnsavedChanges = false; mainPending = false; queued = nil
            keyInvalidated = (error as? DiaryError) == .keyInvalidated
            self.error = (error as? DiaryError)?.errorDescription ?? DiaryError.unavailable.errorDescription
        }
    }
    @discardableResult func updateDraft(_ text: String) -> Bool {
        guard isUnlocked else { return false }
        guard text.count <= DiaryDocument.maxText else {
            error = DiaryError.textTooLong.errorDescription
            return false
        }
        guard document?.draft.text != text else { return true }
        if document?.draft.text.isEmpty == true && !text.isEmpty {
            document?.draft.createdAt = .now
            document?.draft.timeZone = TimeZone.current.identifier
        }
        document?.draft.text = text
        if error == DiaryError.textTooLong.errorDescription { error = nil }
        changes += 1; hasUnsavedChanges = true
        saving?.cancel()
        saving = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(350)) } catch { return }
            guard let self else { return }
            self.saving = nil
            self.enqueue(main: false)
        }
        return true
    }
    /// Chiede subito la scrittura di quanto non è ancora salvato; `saved()` ne attende la fine.
    func flush() {
        saving?.cancel(); saving = nil
        guard document != nil, hasUnsavedChanges || mainPending else { return }
        enqueue(main: mainPending)
    }
    /// Attende che tutte le scritture chieste finora siano sul disco (o fallite).
    func saved() async {
        while let writer { await writer.value }
    }
    @discardableResult func saveEntry() -> UUID? {
        guard isUnlocked, var updated = document, !updated.draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        guard updated.entries.count < DiaryDocument.maxEntries else { error = DiaryError.tooManyEntries.errorDescription; return nil }
        let entry = DiaryEntry(createdAt: updated.draft.createdAt, timeZone: updated.draft.timeZone, original: updated.draft.text)
        updated.entries.insert(entry, at: 0)
        updated.draft = DiaryDraft()
        saving?.cancel(); saving = nil
        document = updated; error = nil
        markChanged(main: true)
        return entry.id
    }
    @discardableResult func appendIncoming(_ text: String) -> Bool {
        guard !text.isEmpty else { return true }
        guard var updated = document, text.count <= DiaryDocument.maxText else {
            error = "Il testo supera 50.000 caratteri e non è stato salvato. Mantieni aperto il diario per ridurlo."
            return false
        }
        let combined = [updated.draft.text, text].filter { !$0.isEmpty }.joined(separator: "\n")
        if combined.count <= DiaryDocument.maxText {
            if updated.draft.text.isEmpty { updated.draft = DiaryDraft() }
            updated.draft.text = combined
        } else {
            guard updated.entries.count < DiaryDocument.maxEntries else { error = DiaryError.tooManyEntries.errorDescription; return false }
            updated.entries.insert(DiaryEntry(createdAt: .now, timeZone: TimeZone.current.identifier, original: text), at: 0)
        }
        saving?.cancel(); saving = nil
        document = updated
        markChanged(main: true)
        return true
    }
    /// Elimina una pagina con le sue elaborazioni e i riepiloghi che la includono (contengono il suo testo).
    func deleteEntry(_ id: UUID) {
        guard isUnlocked, !busy, var updated = document, let index = updated.entries.firstIndex(where: { $0.id == id }) else { return }
        updated.entries.remove(at: index)
        updated.summaries.removeAll { $0.sourceIDs.contains(id) }
        if consent?.ids.contains(id) == true { consent = nil }
        document = updated
        markChanged(main: true)
    }
    /// Elimina dal telefono diario, bozza, copie conservate dal ripristino e le chiavi nel Keychain. Le copie cifrate
    /// esportate restano dove l'utente le ha salvate.
    func deleteDiary() async throws {
        guard !deleting else { return }
        deleting = true
        defer { deleting = false }
        let current = keyID
        // Nessuna ultima scrittura: si cancella tutto.
        saving?.cancel(); saving = nil
        queued = nil; hasUnsavedChanges = false; mainPending = false
        lock()
        await saved()
        let vault = self.vault
        var keys = try await Task.detached(priority: .userInitiated) { try vault.removeAll() }.value
        if let current { keys.insert(current) }
        for identifier in keys { try keyAccess(identifier).remove() }
        lostUnsavedChanges = false; keyInvalidated = false; error = nil
    }
    func lock() {
        saving?.cancel(); saving = nil
        // Ultima scrittura con la chiave di questa sessione: prosegue fuori dal main anche a diario bloccato; se
        // fallisce, la schermata bloccata lo segnala (lostUnsavedChanges).
        if document != nil, hasUnsavedChanges || mainPending { enqueue(main: mainPending) }
        hasUnsavedChanges = false; mainPending = false; writeErrorShown = false
        generation = UUID()
        processing?.cancel(); processing = nil
        consent = nil; busy = false
        requestingPermission = false; permissionPrompt = false
        document = nil; key = nil; keyID = nil
    }
    // MARK: avvisi di permesso della dettatura
    func beginPermissionRequest() {
        guard isUnlocked else { return }
        requestingPermission = true; permissionPrompt = true
    }
    /// Se l'app è già tornata attiva l'avviso è chiuso; altrimenti lo chiude `sceneBecameActive`.
    func endPermissionRequest(appActive: Bool) {
        requestingPermission = false
        if appActive { permissionPrompt = false }
    }
    func sceneBecameActive() {
        if !requestingPermission { permissionPrompt = false }
    }
    func prepareAI(ids: [UUID], operation: String) throws {
        guard let document, isUnlocked, !busy else { throw DiaryError.locked }
        let entries = ids.compactMap { id in document.entries.first { $0.id == id } }
        let count = entries.reduce(0) { $0 + $1.original.count }
        guard !entries.isEmpty, entries.count == ids.count, entries.count <= 31, Set(ids).count == ids.count,
              count <= 60_000, operation == "period" || (operation == "entry" && entries.count == 1) else { throw DiaryError.tooLarge }
        if operation == "entry", entries[0].revisions.count >= DiaryDocument.maxRevisions { throw DiaryError.tooManyRevisions }
        if operation == "period", document.summaries.count >= DiaryDocument.maxSummaries { throw DiaryError.tooManySummaries }
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
                let present = Set(updated.entries.map(\.id))
                // Pagine eliminate durante l'elaborazione: il risultato non si salva.
                guard consent.ids.allSatisfy(present.contains) else { self.busy = false; return }
                if consent.operation == "entry", let index = updated.entries.firstIndex(where: { $0.id == consent.ids[0] }) {
                    guard updated.entries[index].revisions.count < DiaryDocument.maxRevisions else { throw DiaryError.tooManyRevisions }
                    updated.entries[index].revisions.append(revision)
                } else {
                    guard updated.summaries.count < DiaryDocument.maxSummaries else { throw DiaryError.tooManySummaries }
                    updated.summaries.insert(revision, at: 0)
                }
                self.document = updated
                self.markChanged(main: true)
                self.busy = false
            } catch {
                guard let self, self.generation == token, self.isUnlocked else { return }
                self.busy = false
                // Provider errors or response bodies must never reach diagnostics/UI.
                if let limit = error as? DiaryError, limit.isLimit { self.error = limit.errorDescription }
                else { self.error = "Elaborazione non completata. L’originale è conservato; puoi autorizzare un nuovo tentativo." }
            }
        }
    }
    /// PBKDF2 (600.000 giri) e cifratura fuori dal main.
    func exportBackup(password: String) async throws -> Data {
        guard let document, isUnlocked else { throw DiaryError.locked }
        return try await Task.detached(priority: .userInitiated) { try DiaryCrypto.backup(document, password: password) }.value
    }
    /// Restore into a fresh key generation only AFTER the password authenticates
    /// the backup. A missing biometric key never causes silent journal deletion.
    func restoreBackup(_ data: Data, password: String) async throws {
        let restored = try await Task.detached(priority: .userInitiated) { try DiaryCrypto.restore(data, password: password) }.value
        // Diario già presente ma bloccato: prima si prova a sbloccarlo e si UNISCE la copia. Si sostituisce solo se
        // la sua chiave non si apre più (biometria cambiata); con Face ID annullato non si tocca niente. Prima un
        // annullamento portava a sostituire un diario integro con la copia, magari più vecchia (revisione 25 ott 2026).
        if !isUnlocked, exists {
            await unlock()
            if !isUnlocked, !keyInvalidated { throw DiaryError.locked }
        }
        let token = generation
        if isUnlocked, var current = document {
            let ids = Set(current.entries.map(\.id))
            current.entries += restored.entries.filter { !ids.contains($0.id) }
            let summaries = Set(current.summaries.map(\.id))
            current.summaries += restored.summaries.filter { !summaries.contains($0.id) }
            if current.draft.text.isEmpty { current.draft = restored.draft }
            guard current.entries.count <= DiaryDocument.maxEntries else { throw DiaryError.tooManyEntries }
            guard current.summaries.count <= DiaryDocument.maxSummaries else { throw DiaryError.tooManySummaries }
            saving?.cancel(); saving = nil
            document = current
            markChanged(main: true)
            await saved()
            if token == generation, mainPending { throw DiaryError.writeFailed }
        } else {
            let identifier = UUID().uuidString
            unlocking = true
            defer { unlocking = false }
            let recoveredKey = try await keyAccess(identifier).unlock(existingVault: false)
            guard token == generation, !Task.isCancelled else { throw DiaryError.locked }
            await saved()
            let vault = self.vault
            // Keep the old ciphertext available if this recovery copy is older.
            try await Task.detached(priority: .userInitiated) { try vault.preserveCurrent() }.value
            guard token == generation, !Task.isCancelled else { throw DiaryError.locked }
            self.key = recoveredKey; self.keyID = identifier
            document = restored
            markChanged(main: true)
            await saved()
            guard token == generation, !mainPending else {
                if token == generation { key = nil; keyID = nil; document = nil; hasUnsavedChanges = false; mainPending = false }
                throw DiaryError.writeFailed
            }
            keyInvalidated = false
        }
    }
    // MARK: scrittura
    private func markChanged(main: Bool) {
        changes += 1; hasUnsavedChanges = true
        enqueue(main: main)
    }
    private func enqueue(main: Bool) {
        guard let document, let key, let keyID else { return }
        let writeMain = main || mainPending
        if var job = queued, job.keyID == keyID {
            if writeMain { job.main = document }
            job.draft = document.draft; job.generation = generation; job.change = changes
            queued = job
        } else {
            queued = DiaryVault.Job(main: writeMain ? document : nil, draft: document.draft, key: key, keyID: keyID, generation: generation, change: changes)
        }
        if writer == nil { writer = Task { await self.drain() } }
    }
    private func drain() async {
        while let job = queued {
            queued = nil
            let vault = self.vault
            let failure = await Task.detached(priority: .userInitiated) { () -> DiaryError? in
                do { try vault.write(job); return nil }
                catch let error as DiaryError where error.isLimit { return error }
                catch { return .writeFailed }
            }.value
            let current = job.generation == generation
            if let failure {
                if current {
                    if job.main != nil { mainPending = true }
                    hasUnsavedChanges = true
                    error = failure.errorDescription; writeErrorShown = true
                } else { lostUnsavedChanges = true }
            } else if current {
                if job.main != nil { mainPending = false }
                if job.change == changes, queued == nil, saving == nil {
                    hasUnsavedChanges = false
                    if writeErrorShown { error = nil; writeErrorShown = false }
                }
            }
        }
        writer = nil
    }
}

extension DiaryError {
    /// Un limite del formato superato: il messaggio dice quale, invece di «spazio esaurito».
    var isLimit: Bool {
        switch self {
        case .tooManyEntries, .tooManySummaries, .tooManyRevisions, .textTooLong, .vaultFull: true
        default: false
        }
    }
}
