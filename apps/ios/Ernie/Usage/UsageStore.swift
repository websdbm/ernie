import Foundation
import Observation

/// Dati esclusivamente in memoria della schermata, mai condivisi fra sessioni o account.
@MainActor @Observable final class UsageStore {
    typealias Loader = @MainActor (UsageQuery) async throws -> UsageReport
    private(set) var report: UsageReport?
    private(set) var query: UsageQuery?
    private(set) var loading = false
    private(set) var error: String?
    private(set) var accessDenied = false
    private var owner: Credentials?
    private var generation = UUID()
    private var requestTask: Task<UsageReport, any Error>?

    func report(for credentials: Credentials?, query: UsageQuery) -> UsageReport? {
        guard credentials != nil, credentials == owner, query == self.query else { return nil }
        return report
    }
    func clear() {
        generation = UUID(); requestTask?.cancel(); requestTask = nil
        report = nil; query = nil; owner = nil; loading = false; error = nil; accessDenied = false
    }
    func load(_ query: UsageQuery, credentials: Credentials, using loader: @escaping Loader) async {
        clear()
        let token = generation
        owner = credentials; self.query = query; loading = true
        do {
            try Task.checkCancellation()
            let task = Task { try await loader(query) }
            requestTask = task
            let result = try await withTaskCancellationHandler(operation: { try await task.value }, onCancel: { task.cancel() })
            guard generation == token else { return }
            requestTask = nil; loading = false
            guard !Task.isCancelled else { return }
            report = result
        } catch {
            guard generation == token else { return }
            requestTask = nil; loading = false
            guard !Task.isCancelled, !(error is CancellationError) else { return }
            report = nil
            accessDenied = (error as? ApiError).map { [401, 403].contains($0.status) } ?? false
            self.error = UsagePresentation.error(error)
        }
    }
}
