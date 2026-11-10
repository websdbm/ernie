import Foundation
import Observation

@MainActor @Observable final class HealthVaultStore {
    private var client: HealthVaultClient?
    private var generation = UUID()
    private var aiJob: Task<Void, Never>?
    private var importJob: Task<HealthVaultDraft, Error>?
    private var aiEpoch = UUID()
    private var locallyRevoked = false
    private(set) var capabilities: HealthCapabilities?
    private(set) var sources: [HealthSourceSummary] = []
    private(set) var reports: [HealthReportSummary] = []
    private(set) var source: HealthSourceDetail?
    private(set) var report: HealthReportDetail?
    private(set) var parameter: HealthParameterDetail?
    private(set) var attachment: HealthAttachment?
    private(set) var answer: HealthAnswer?
    private(set) var busy = false
    private(set) var aiBusy = false
    private(set) var revoking = false
    private(set) var error: String?
    var draft: HealthVaultDraft?
    var question = ""
    var parameterName = ""
    var selectedReports: Set<String> = []
    var selectedSources: Set<String> = []
    private(set) var exportFile: HealthSharedFile?
    var manualReady: Bool { capabilities?.manualReady == true }
    var aiReady: Bool { capabilities?.aiReady == true && !locallyRevoked && !revoking }

    func activate(client: HealthVaultClient?, draft: HealthVaultDraft? = nil) {
        scrub(); self.client = client; self.draft = draft
    }
    func scrub() {
        generation = UUID(); cancelAI(); importJob?.cancel(); importJob = nil; client?.close(); client = nil
        capabilities = nil; sources = []; reports = []; source = nil; report = nil; parameter = nil; attachment = nil
        draft = nil; question = ""; parameterName = ""; selectedReports = []; selectedSources = []; error = nil
        busy = false; revoking = false; locallyRevoked = false; clearExport()
    }
    private func cancelAI() { aiEpoch = UUID(); aiJob?.cancel(); aiJob = nil; aiBusy = false; answer = nil }
    func clearDetail() { source = nil; report = nil; parameter = nil; attachment = nil }
    func clearAttachment() { attachment = nil }
    func clearError() { error = nil }
    func reportImportError(_ failure: Error) { error = (failure as? HealthVaultError)?.message ?? "Non riesco a leggere questo documento. Riprova dalla sezione Salute." }
    func refresh() async {
        await perform { client in
            let caps = try await client.capabilities()
            guard self.client === client else { return }
            if self.capabilities?.consent.revision != caps.consent.revision { self.cancelAI() }
            self.capabilities = caps
            if caps.manualReady {
                async let sources = client.sources()
                async let reports = client.reports()
                let values = try await (sources, reports)
                guard self.client === client else { return }
                self.sources = values.0; self.reports = values.1
            }
        }
    }
    func grantConsent() async {
        guard let caps = capabilities, caps.manualReady, caps.skillEnabled, caps.available, caps.policyVersion == 1 else { error = HealthVaultError.consent.message; return }
        let epoch = aiEpoch
        await perform { client in
            let consent = try await client.consent(allowed: true, revision: caps.consent.revision, policyVersion: caps.policyVersion)
            guard self.client === client, self.aiEpoch == epoch else { return }
            self.capabilities?.consent = consent; self.locallyRevoked = false
        }
    }
    /// Non passa per il mutex delle altre azioni: la revoca resta disponibile durante l'AI.
    func revokeConsent() async {
        guard let client, !revoking else { return }
        let token = generation
        locallyRevoked = true; cancelAI(); revoking = true; error = nil
        defer { if generation == token { revoking = false } }
        do {
            let consent = try await client.consent(allowed: false)
            guard generation == token else { return }
            capabilities?.consent = consent
        } catch { if generation == token { self.error = "Revoca non confermata dal server. L’AI è bloccata su questo dispositivo: riprova la revoca." } }
    }
    func prepare(_ read: @escaping @MainActor () async throws -> HealthVaultDraft) async {
        guard manualReady, !busy else { return }
        let token = generation; busy = true; error = nil
        let job = Task { try await read() }; importJob = job
        defer { if generation == token { busy = false; importJob = nil } }
        do {
            let result = try await job.value
            guard generation == token, !Task.isCancelled else { return }
            try result.validate(); draft = result
        } catch { if generation == token && !Task.isCancelled { reportImportError(error) } }
    }
    func upload() async {
        guard manualReady, let draft else { return }
        await perform { client in
            _ = try await client.upload(draft)
            guard self.client === client else { return }
            self.draft = nil
            let sources = try await client.sources()
            guard self.client === client else { return }; self.sources = sources
        }
    }
    func openSource(_ id: String) async {
        guard manualReady else { return }; clearDetail()
        await perform { client in let result = try await client.source(id); if self.client === client { self.source = result } }
    }
    func openReport(_ id: String) async {
        guard manualReady else { return }; clearDetail()
        await perform { client in let result = try await client.report(id); if self.client === client { self.report = result } }
    }
    func openAttachment(_ id: String, sourceId: String) async {
        guard manualReady else { return }
        await perform { client in
            let result = try await client.attachment(source: sourceId, id: id)
            guard ["application/pdf", "image/jpeg", "image/png", "image/heic", "image/heif"].contains(result.mimeType),
                  let bytes = Data(base64Encoded: result.dataBase64), bytes.count <= HealthVaultDraft.maxPDFBytes else { throw HealthVaultError.invalidResponse }
            if self.client === client { self.attachment = result }
        }
    }
    func findParameter() async {
        guard manualReady else { return }
        let name = parameterName
        await perform { client in
            let result = try await client.parameter(name)
            guard self.client === client else { return }; self.parameter = result
            if result == nil { self.error = "Nessun valore trovato per questo parametro." }
        }
    }
    func remove(_ id: String) async {
        guard manualReady else { return }
        cancelAI()
        await perform { client in
            try await client.remove(id)
            guard self.client === client else { return }
            self.clearDetail(); self.sources.removeAll { $0.id == id }; self.selectedSources.remove(id); self.answer = nil
            let reports = try await client.reports()
            guard self.client === client else { return }; self.reports = reports
            self.selectedReports.formIntersection(reports.map(\.id))
        }
    }
    func analyze(_ id: String) async {
        await runAI { client in
            let result = try await client.analyze(id)
            return .analysis(result)
        }
    }
    func ask() async {
        let question = question, ids = Array(selectedReports), sources = Array(selectedSources)
        await runAI { client in .answer(try await client.ask(question, reportIds: ids, sourceIds: sources)) }
    }
    private enum AIResult { case answer(HealthAnswer), analysis(HealthAnalysisResult) }
    private func runAI(_ operation: @escaping @Sendable (HealthVaultClient) async throws -> AIResult) async {
        guard aiReady, !aiBusy, !busy, let client else { error = HealthVaultError.consent.message; return }
        let token = generation, epoch = aiEpoch, revision = capabilities?.consent.revision
        aiBusy = true; error = nil; answer = nil
        aiJob = Task {
            defer { if self.generation == token && self.aiEpoch == epoch { self.aiBusy = false; self.aiJob = nil } }
            do {
                try Task.checkCancellation()
                let result = try await operation(client)
                guard !Task.isCancelled, self.generation == token, self.aiEpoch == epoch,
                      self.aiReady, self.capabilities?.consent.revision == revision else { return }
                switch result {
                case .answer(let answer): self.answer = answer
                case .analysis(let analysis):
                    await self.refresh()
                    guard !Task.isCancelled, self.generation == token, self.aiEpoch == epoch, self.aiReady else { return }
                    let detail = try await client.report(analysis.reportId)
                    guard !Task.isCancelled, self.generation == token, self.aiEpoch == epoch, self.aiReady else { return }
                    self.source = nil; self.report = detail
                }
            } catch {
                if !Task.isCancelled && self.generation == token && self.aiEpoch == epoch { self.error = (error as? HealthVaultError)?.message ?? HealthVaultError.network.message }
            }
        }
        await aiJob?.value
    }
    func export(sourceId: String? = nil, reportId: String? = nil) async {
        guard manualReady else { return }
        clearExport()
        await perform { client in
            let payload = try await client.export(sourceId: sourceId, reportId: reportId)
            guard self.client === client else { return }
            self.exportFile = try HealthSharedFile(payload: payload)
        }
    }
    func clearExport() { exportFile?.remove(); exportFile = nil }
    private func perform(_ operation: (HealthVaultClient) async throws -> Void) async {
        guard !busy, let client else { return }
        let token = generation; busy = true; error = nil
        defer { if generation == token { busy = false } }
        do { try Task.checkCancellation(); try await operation(client) }
        catch { if generation == token && !Task.isCancelled { self.error = (error as? HealthVaultError)?.message ?? HealthVaultError.network.message } }
    }
}

/// Unica eccezione alla conservazione in RAM: esportazione richiesta esplicitamente.
struct HealthSharedFile: Identifiable {
    let id = UUID()
    let url: URL
    static let writeOptions: Data.WritingOptions = [.atomic, .completeFileProtection]
    init(payload: HealthExportPayload) throws {
        guard let data = Data(base64Encoded: payload.dataBase64), !data.isEmpty,
              data.count <= 32 * 1024 * 1024 else { throw HealthVaultError.invalidResponse }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ernie-health-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
            attributes: [.protectionKey: FileProtectionType.complete])
        let filename = URL(fileURLWithPath: payload.filename).lastPathComponent
        url = directory.appendingPathComponent(filename.isEmpty || filename == "." || filename == ".." ? "Salute.json" : filename)
        do {
            try data.write(to: url, options: Self.writeOptions)
            #if !targetEnvironment(simulator)
            let protection = try FileManager.default.attributesOfItem(atPath: url.path)[.protectionKey] as? String
            guard protection == FileProtectionType.complete.rawValue else { throw HealthVaultError.unavailable }
            #endif
            var protectedURL = directory; var values = URLResourceValues(); values.isExcludedFromBackup = true
            try protectedURL.setResourceValues(values)
        } catch { try? FileManager.default.removeItem(at: directory); throw HealthVaultError.unavailable }
    }
    func remove() { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
}
