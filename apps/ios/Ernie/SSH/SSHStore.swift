import Foundation
import Observation

enum SSHMutation: Sendable {
    case key(rotate: Bool), revokeKey, server(SshServerInput), site(SshSiteInput)
    case trust(serverId: String, fingerprint: String)
    case connect(SshProviderCredentials), disconnect(SshProvider), importInventory(SshImportInput)
}

@MainActor @Observable
final class SSHStore {
    struct Transport {
        var snapshot: () async throws -> SshSnapshot = { throw URLError(.userAuthenticationRequired) }
        var mutate: (SSHMutation) async throws -> SshSnapshot = { _ in throw URLError(.userAuthenticationRequired) }
        var probe: (String) async throws -> String = { _ in throw URLError(.userAuthenticationRequired) }
        var diagnose: (SshDiagnosticInput) async throws -> String = { _ in throw URLError(.userAuthenticationRequired) }
        var instances: (SshProvider) async throws -> [SshProviderInstance] = { _ in throw URLError(.userAuthenticationRequired) }
        var preview: (SshImportInput) async throws -> SshImportPreview = { _ in throw URLError(.userAuthenticationRequired) }
        var plan: (SshPlanInput) async throws -> SshOperation = { _ in throw URLError(.userAuthenticationRequired) }
        var decision: (String, Bool) async throws -> SshOperation = { _, _ in throw URLError(.userAuthenticationRequired) }
        var operation: (String) async throws -> SshOperation = { _ in throw URLError(.userAuthenticationRequired) }
    }
    private(set) var snapshot: SshSnapshot?
    private(set) var loading = false
    private(set) var pendingCount = 0
    private(set) var error: String?
    private(set) var fingerprints: [String: String] = [:]
    private(set) var diagnosticOutput: String?
    private(set) var diagnosticInput: SshDiagnosticInput?
    private(set) var instances: [SshProvider: [SshProviderInstance]] = [:]
    private(set) var importPreview: SshImportPreview?
    private(set) var diagnosticLoading = false
    private(set) var instancesLoading: Set<SshProvider> = []
    private(set) var probing: Set<String> = []
    private(set) var previewLoading = false
    private(set) var attemptedDecisions: Set<String> = []
    private var uncertainDecisions: Set<String> = []
    private var transport: Transport?
    private var generation = UUID()
    private var loadToken = UUID()
    private var diagnosticToken = UUID()
    private var previewToken = UUID()
    private var providerTokens: [SshProvider: UUID] = [:]
    private var changeCounter = 0
    private var writeTail: Task<Void, Never>?
    var busy: Bool { pendingCount > 0 }

    func configure(api: ApiClient?) {
        configure(transport: api.map { api in
            var t = Transport()
            t.snapshot = { try await api.sshSnapshot() }
            t.mutate = { mutation in
                switch mutation {
                case .key(let rotate): try await api.sshKey(rotate: rotate)
                case .revokeKey: try await api.sshRevokeKey()
                case .server(let input): try await api.sshSaveServer(input)
                case .site(let input): try await api.sshSaveSite(input)
                case .trust(let id, let fingerprint): try await api.sshTrust(id, fingerprint: fingerprint)
                case .connect(let input): try await api.sshConnectProvider(input)
                case .disconnect(let provider): try await api.sshDisconnectProvider(provider)
                case .importInventory(let input): try await api.sshImportApply(input)
                }
            }
            t.probe = { try await api.sshProbe($0) }
            t.diagnose = { try await api.sshDiagnose($0) }
            t.instances = { try await api.sshProviderInstances($0) }
            t.preview = { try await api.sshImportPreview($0) }
            t.plan = { try await api.sshPlan($0) }
            t.decision = { id, approved in try await (approved ? api.sshApprove(id) : api.sshReject(id)) }
            t.operation = { try await api.sshOperation($0) }
            return t
        })
    }
    func configure(transport: Transport?) {
        generation = UUID(); loadToken = UUID(); diagnosticToken = UUID(); previewToken = UUID()
        writeTail?.cancel(); writeTail = nil
        self.transport = transport
        snapshot = nil; loading = false; pendingCount = 0; error = nil; changeCounter = 0
        fingerprints = [:]; diagnosticOutput = nil; diagnosticInput = nil; instances = [:]; importPreview = nil
        diagnosticLoading = false; instancesLoading = []; probing = []; previewLoading = false
        attemptedDecisions = []; uncertainDecisions = []
        providerTokens = [:]
    }
    func clearError() { error = nil }
    func clearImportPreview() { previewToken = UUID(); importPreview = nil; previewLoading = false }
    func reportImportError() { error = "Non riesco a leggere il file. Usa un export JSON dell’inventario, senza chiavi o password." }
    func load() async {
        guard let transport else { return }
        let session = generation, request = UUID(), revision = changeCounter
        loadToken = request; loading = true
        do {
            let result = try await transport.snapshot()
            guard generation == session, loadToken == request else { return }
            loading = false
            guard !Task.isCancelled, revision == changeCounter else { return }
            accept(result); error = nil
        } catch {
            guard generation == session, loadToken == request else { return }
            loading = false
            if !(error is CancellationError) { self.error = Self.describe(error) }
        }
    }
    @discardableResult func mutate(_ mutation: SSHMutation) async -> Bool {
        guard let transport else { return false }
        switch mutation {
        case .connect(let credentials):
            providerTokens[credentials.provider] = UUID(); instances[credentials.provider] = nil
        case .disconnect(let provider):
            providerTokens[provider] = UUID(); instances[provider] = nil
        default: break
        }
        return await serialize({ try await transport.mutate(mutation) }) { [weak self] result in
            self?.accept(result)
            if case .disconnect(let provider) = mutation { self?.instances[provider] = nil }
            if case .server(let input) = mutation, let id = input.id { self?.fingerprints[id] = nil }
            if case .trust(let id, _) = mutation { self?.fingerprints[id] = nil }
            if case .key = mutation { self?.fingerprints = [:] }
            if case .revokeKey = mutation { self?.fingerprints = [:] }
            if case .importInventory = mutation { self?.importPreview = nil }
        }
    }
    func probe(_ serverId: String) async {
        guard let transport, !probing.contains(serverId) else { return }
        let session = generation
        let revision = snapshot?.servers.first { $0.id == serverId }?.revision
        probing.insert(serverId); fingerprints[serverId] = nil
        defer { if generation == session { probing.remove(serverId) } }
        do {
            let value = try await transport.probe(serverId)
            guard generation == session, !Task.isCancelled,
                  snapshot?.servers.first(where: { $0.id == serverId })?.revision == revision else { return }
            fingerprints[serverId] = value; error = nil
        } catch { if generation == session, !Task.isCancelled { self.error = Self.describe(error) } }
    }
    func diagnose(_ input: SshDiagnosticInput) async {
        guard let transport else { return }
        let session = generation, request = UUID()
        diagnosticToken = request; diagnosticLoading = true; diagnosticOutput = nil; diagnosticInput = input
        do {
            let output = try await transport.diagnose(input)
            guard generation == session, diagnosticToken == request else { return }
            diagnosticLoading = false
            guard !Task.isCancelled else { return }
            diagnosticOutput = output; error = nil
        } catch {
            guard generation == session, diagnosticToken == request else { return }
            diagnosticLoading = false
            if !(error is CancellationError) { self.error = Self.describe(error) }
        }
    }
    func loadInstances(_ provider: SshProvider) async {
        guard let transport, !instancesLoading.contains(provider) else { return }
        let session = generation
        let request = UUID()
        providerTokens[provider] = request
        instancesLoading.insert(provider)
        defer { if generation == session { instancesLoading.remove(provider) } }
        do {
            let result = try await transport.instances(provider)
            guard generation == session, providerTokens[provider] == request, !Task.isCancelled else { return }
            instances[provider] = result; error = nil
        } catch { if generation == session, !Task.isCancelled { self.error = Self.describe(error) } }
    }
    func preview(_ input: SshImportInput) async {
        guard let transport else { return }
        let session = generation, request = UUID()
        previewToken = request; previewLoading = true; importPreview = nil
        do {
            let result = try await transport.preview(input)
            guard generation == session, previewToken == request else { return }
            previewLoading = false
            guard !Task.isCancelled else { return }
            importPreview = result; error = nil
        } catch {
            guard generation == session, previewToken == request else { return }
            previewLoading = false
            if !(error is CancellationError) { self.error = Self.describe(error) }
        }
    }
    @discardableResult func plan(_ input: SshPlanInput) async -> Bool {
        guard let transport else { return false }
        return await serialize({ try await transport.plan(input) }) { [weak self] in self?.acceptOperation($0) }
    }
    func canDecide(_ operation: SshOperation, now: Date = .now) -> Bool {
        operation.canDecide(now: now) && !attemptedDecisions.contains(operation.id)
    }
    /// No automatic retry: a timeout cannot establish whether the remote command ran.
    func decide(_ operation: SshOperation, approve: Bool) async {
        guard let transport, canDecide(operation) else { return }
        attemptedDecisions.insert(operation.id)
        let session = generation
        let succeeded = await serialize({ try await transport.decision(operation.id, approve) }) { [weak self] in self?.acceptOperation($0) }
        guard generation == session else { return }
        if !succeeded {
            uncertainDecisions.insert(operation.id)
            var uncertain = operation; uncertain.status = .uncertain
            uncertain.output = SSHFormatting.uncertain
            acceptOperation(uncertain)
            error = SSHFormatting.uncertain
        }
    }
    func refreshOperation(_ id: String) async {
        guard let transport else { return }
        let session = generation
        do {
            let result = try await transport.operation(id)
            guard generation == session, !Task.isCancelled else { return }
            acceptOperation(result)
            if result.status != .pending && result.status != .uncertain { error = nil }
        } catch { if generation == session, !Task.isCancelled { self.error = Self.describe(error) } }
    }
    private func accept(_ incoming: SshSnapshot) {
        var copy = incoming
        for index in copy.operations.indices {
            if uncertainDecisions.contains(copy.operations[index].id), copy.operations[index].status == .pending {
                copy.operations[index].status = .uncertain
                copy.operations[index].output = SSHFormatting.uncertain
            }
        }
        snapshot = copy
    }
    private func acceptOperation(_ operation: SshOperation) {
        var operation = operation
        if uncertainDecisions.contains(operation.id), operation.status == .pending {
            operation.status = .uncertain; operation.output = SSHFormatting.uncertain
        }
        if snapshot == nil { snapshot = .empty }
        if let index = snapshot?.operations.firstIndex(where: { $0.id == operation.id }) { snapshot?.operations[index] = operation }
        else { snapshot?.operations.insert(operation, at: 0) }
    }
    private func serialize<Result: Sendable>(_ action: @escaping @MainActor () async throws -> Result,
                                            commit: @escaping @MainActor (Result) -> Void) async -> Bool {
        let session = generation, previous = writeTail
        pendingCount += 1; changeCounter += 1
        let task = Task { @MainActor [weak self] () -> Bool in
            await previous?.value
            guard let self else { return false }
            defer { if self.generation == session { self.pendingCount -= 1 } }
            guard self.generation == session, !Task.isCancelled else { return false }
            do {
                let result = try await action()
                guard self.generation == session, !Task.isCancelled else { return false }
                self.changeCounter += 1; commit(result); self.error = nil
                return true
            } catch {
                guard self.generation == session, !Task.isCancelled else { return false }
                self.error = Self.describe(error)
                return false
            }
        }
        writeTail = Task { _ = await task.value }
        return await task.value
    }
    private static func describe(_ error: Error) -> String {
        // Provider errors must never echo the submitted credential fields.
        if let api = error as? ApiError {
            switch api.status {
            case 401: return "Accesso non riuscito. Controlla le credenziali e i permessi del tuo account."
            case 403: return "Azione non consentita. Verifica che la skill SSH sia attiva e che l’account abbia i permessi necessari."
            case 409: return "Lo stato è cambiato. Ricarica e controlla i dati prima di proporre un nuovo intervento."
            case 400, 422: return "Dati non validi. Controlla i campi e riprova."
            case 429: return "Il servizio ha ricevuto troppe richieste. Attendi prima di una nuova verifica."
            default: break
            }
        }
        return "La richiesta non è stata completata. Controlla la connessione e verifica lo stato prima di ripetere operazioni con effetti."
    }
}
