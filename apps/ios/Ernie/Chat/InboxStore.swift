import Foundation
import LocalAuthentication
import Observation

/// Notifiche del server (automazioni): lette all'apertura e a ogni `automation.run.updated` o push.
@MainActor
@Observable
final class InboxStore {
    private var api: ApiClient?
    private var generation = UUID()
    private var refreshTask: Task<Void, Never>?
    private(set) var lastError: String?
    /// Nuove schede da inserire nella conversazione.
    var onCards: (([NotificationCard]) -> Void)?

    func configure(api: ApiClient) { reset(); self.api = api }

    func reset() {
        generation = UUID()
        api = nil
        lastError = nil
        onCards = nil
        refreshTask?.cancel()
    }

    func scheduleRefresh() {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            await self?.refresh()
        }
    }

    func refresh() async {
        guard let api else { return }
        let token = generation
        do {
            let unread = try await api.notifications(unreadOnly: true)
            guard generation == token, !Task.isCancelled else { return }
            lastError = nil
            guard !unread.isEmpty else { return }
            onCards?(unread.map(NotificationCard.init))
            try await api.markRead(ids: unread.map(\.id))
        } catch {
            guard generation == token, !Task.isCancelled else { return }
            lastError = AppModel.describe(error)
        }
    }

    func resumeAutomation(id: String) async throws {
        guard let api else { throw ApiError(status: 0, code: "no_api", message: "Non connesso") }
        try await api.setAutomation(id: id, enabled: true)
    }

    /// Decisione su un'azione sospesa: l'approvazione richiede lo sblocco del dispositivo (Face ID o codice).
    func decide(approvalId: String, approve: Bool) async throws -> ApprovalResult {
        guard let api else { throw ApiError(status: 0, code: "no_api", message: "Non connesso") }
        let token = generation
        if approve {
            guard await StepUp.authenticate(reason: "Conferma l'azione proposta da Ernie") else {
                throw ApiError(status: 0, code: "step_up_failed", message: "Autenticazione non riuscita")
            }
        }
        guard generation == token, !Task.isCancelled else { throw CancellationError() }
        return try await api.approve(approvalId: approvalId, decision: approve ? "approve" : "deny")
    }
}

/// Step-up con Face ID / Touch ID / codice per le azioni critiche (B.7).
enum StepUp {
    static func authenticate(reason: String, context: LAContext = LAContext()) async -> Bool {
        #if DEBUG
        // Solo per i test automatici in simulatore (SIMCTL_CHILD_ERNIE_DEBUG_SKIP_STEPUP=1): mai nelle build di release.
        if ProcessInfo.processInfo.environment["ERNIE_DEBUG_SKIP_STEPUP"] == "1" { return true }
        #endif
        context.localizedCancelTitle = "Annulla"
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            // Senza codice né biometria non è possibile autorizzare un’azione critica.
            Log.chat.warning("step-up non disponibile: \(error?.localizedDescription ?? "-", privacy: .public)")
            return false
        }
        do {
            return try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
        } catch {
            return false
        }
    }
}
