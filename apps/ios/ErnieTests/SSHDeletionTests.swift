import Foundation
import SwiftUI
import Testing
import UIKit
@testable import Ernie

private enum SSHDeletionFixtures {
    static let server = SshServer(id: "11111111-1111-4111-8111-111111111111", name: "Server esempio", host: "server.example.test", port: 22, username: "ernie", provider: .vultr, providerInstanceId: "example-instance", fingerprint: "SHA256:example", revision: 1, lastCheckedAt: nil, lastStatus: nil)
    static let site = SshSite(id: "22222222-2222-4222-8222-222222222222", serverId: server.id, name: "Sito esempio", url: "https://example.test", path: "/srv/wordpress", container: "")
    static let operation = SshOperation(serverId: server.id, kind: .wpCli, title: "Proposta di prova", reason: "Solo fixture", command: "wp core version", verificationCommand: "wp core version", backup: "Non applicabile alla fixture", rollback: "Non applicabile alla fixture", siteId: site.id, id: "33333333-3333-4333-8333-333333333333", serverName: server.name, host: server.host, status: .pending, createdAt: "2026-11-10T10:00:00Z", expiresAt: "2099-11-10T10:00:00Z", output: nil)
    static var snapshot: SshSnapshot {
        .init(configured: true, key: .init(publicKey: "ssh-ed25519 public-example", fingerprint: "SHA256:example", createdAt: "2026-11-10T10:00:00Z"), servers: [server], sites: [site], providers: [.init(provider: .vultr, connected: true, lastCheckedAt: nil)], operations: [operation])
    }
    static var precondition: SshDeletionPrecondition { .init(server: .init(id: server.id, revision: server.revision), sites: [site]) }
}

@MainActor private final class SSHDeletionTransport {
    var current = SSHDeletionFixtures.snapshot
    var removals: [SSHDeletionTarget] = []
    var preconditions: [SshDeletionPrecondition] = []
    var pending: [CheckedContinuation<SshSnapshot, any Error>] = []
    var operationReads: [CheckedContinuation<SshOperation, any Error>] = []
    var suspendedReads: [CheckedContinuation<SshSnapshot, any Error>] = []
    var suspendReads = false
    var reads = 0
    var probes = 0
    var diagnoses = 0
    var transport: SSHStore.Transport {
        var value = SSHStore.Transport()
        value.snapshot = {
            self.reads += 1
            if self.suspendReads { return try await withCheckedThrowingContinuation { self.suspendedReads.append($0) } }
            return self.current
        }
        value.remove = { target, expected in
            self.removals.append(target)
            self.preconditions.append(expected)
            return try await withCheckedThrowingContinuation { self.pending.append($0) }
        }
        value.operation = { _ in try await withCheckedThrowingContinuation { self.operationReads.append($0) } }
        value.probe = { _ in self.probes += 1; return "SHA256:read-example" }
        value.diagnose = { _ in self.diagnoses += 1; return "Output sintetico" }
        return value
    }
    func removedServer() -> SshSnapshot {
        var result = current
        result.servers.removeAll { $0.id == SSHDeletionFixtures.server.id }
        result.sites.removeAll { $0.serverId == SSHDeletionFixtures.server.id }
        result.operations.removeAll { $0.serverId == SSHDeletionFixtures.server.id }
        return result
    }
    func removedSite() -> SshSnapshot {
        var result = current
        result.sites.removeAll { $0.id == SSHDeletionFixtures.site.id }
        for index in result.operations.indices where result.operations[index].serverId == SSHDeletionFixtures.server.id && result.operations[index].status == .pending {
            result.operations[index].status = .rejected
        }
        return result
    }
}

@MainActor struct SSHDeletionTests {
    private func waitFor(_ condition: () -> Bool) async {
        for _ in 0..<1000 { if condition() { return }; await Task.yield() }
        #expect(condition())
    }
    private func loaded(_ transport: SSHDeletionTransport) async -> SSHStore {
        let store = SSHStore(); store.configure(transport: transport.transport); await store.load(); return store
    }

    @Test func anteprimaDistingueInventarioDaHostESoloSitoDaServer() async throws {
        let wire = SSHDeletionTransport(), store = await loaded(wire)
        let server = try #require(store.deletionRequest(for: .server(SSHDeletionFixtures.server.id)))
        let site = try #require(store.deletionRequest(for: .site(SSHDeletionFixtures.site.id)))
        #expect(server.linkedSites.map(\.id) == [SSHDeletionFixtures.site.id])
        #expect(server.consequences.contains("storico"))
        #expect(server.consequences.contains("non viene revocata"))
        #expect(site.consequences.contains("gli altri siti"))
        #expect(site.consequences.contains("invalidate"))
        #expect(server.remoteImpact.contains("non verranno modificati"))
        #expect(site.remoteImpact.contains("non verrà modificato"))
        #expect(wire.removals.isEmpty && wire.probes == 0 && wire.diagnoses == 0)
    }

    @Test func rimuoveUnaVoltaIlServerRipulisceCacheEScartaLetturaPrecedente() async throws {
        let wire = SSHDeletionTransport(), store = await loaded(wire)
        await store.probe(SSHDeletionFixtures.server.id)
        await store.diagnose(.init(serverId: SSHDeletionFixtures.server.id, check: .overview))
        let request = try #require(store.deletionRequest(for: .server(SSHDeletionFixtures.server.id)))
        wire.suspendReads = true
        let read = Task { await store.load() }
        await waitFor { wire.suspendedReads.count == 1 }
        #expect(!store.canDelete(request))
        wire.suspendedReads[0].resume(returning: wire.current)
        await read.value
        let deleting = Task { await store.delete(request) }
        await waitFor { wire.pending.count == 1 }
        #expect(store.busy && store.deleting == request.target)
        #expect(await store.delete(request) == false)
        #expect(wire.removals == [request.target])
        #expect(wire.preconditions == [request.precondition])
        let stale = Task { await store.load() }
        await waitFor { wire.suspendedReads.count == 2 }
        let removed = wire.removedServer()
        wire.pending[0].resume(returning: removed)
        #expect(await deleting.value)
        wire.suspendedReads[1].resume(returning: wire.current)
        await stale.value
        #expect(store.snapshot == removed)
        #expect(store.snapshot?.key == wire.current.key && store.snapshot?.providers == wire.current.providers)
        #expect(store.fingerprints.isEmpty && store.diagnosticOutput == nil && store.diagnosticInput == nil)
        #expect(!store.busy && store.deleting == nil)
        #expect(await store.delete(request) == false)
        #expect(wire.removals.count == 1)
    }

    @Test func sitoRimossoMantieneServerERispostaVecchiaNonRiattivaPiani() async throws {
        let wire = SSHDeletionTransport(), store = await loaded(wire)
        let request = try #require(store.deletionRequest(for: .site(SSHDeletionFixtures.site.id)))
        let oldOperation = Task { await store.refreshOperation(SSHDeletionFixtures.operation.id) }
        await waitFor { wire.operationReads.count == 1 }
        let deleting = Task { await store.delete(request) }
        await waitFor { wire.pending.count == 1 }
        let removed = wire.removedSite()
        wire.pending[0].resume(returning: removed)
        #expect(await deleting.value)
        wire.operationReads[0].resume(returning: SSHDeletionFixtures.operation)
        await oldOperation.value
        #expect(store.snapshot == removed)
        #expect(store.snapshot?.servers == wire.current.servers)
        #expect(store.snapshot?.operations.first?.status == .rejected)
        #expect(wire.probes == 0 && wire.diagnoses == 0)
    }

    @Test func cambioAccountInvalidaConfermeERisposteDellaRimozione() async throws {
        let wire = SSHDeletionTransport(), store = await loaded(wire)
        let request = try #require(store.deletionRequest(for: .server(SSHDeletionFixtures.server.id)))
        let deleting = Task { await store.delete(request) }
        await waitFor { wire.pending.count == 1 }
        let second = SSHDeletionTransport()
        second.current.servers[0].name = "Altro account"
        store.configure(transport: second.transport); await store.load()
        wire.pending[0].resume(returning: wire.removedServer())
        #expect(await deleting.value == false)
        #expect(store.snapshot == second.current && store.error == nil && !store.busy)
        #expect(!store.canDelete(request))
        #expect(await store.delete(request) == false)
        #expect(second.removals.isEmpty)
    }

    @Test func modificheAiSitiEInterventoInCorsoRichiedonoNuovaConferma() async throws {
        let wire = SSHDeletionTransport(), store = await loaded(wire)
        let request = try #require(store.deletionRequest(for: .server(SSHDeletionFixtures.server.id)))
        wire.current.sites.append(.init(id: "44444444-4444-4444-8444-444444444444", serverId: SSHDeletionFixtures.server.id, name: "Nuovo sito", url: "https://new.example.test", path: "", container: ""))
        await store.load()
        #expect(store.deletionProblem(request)?.contains("siti collegati sono cambiati") == true)
        #expect(await store.delete(request) == false)
        let fresh = try #require(store.deletionRequest(for: .site(SSHDeletionFixtures.site.id)))
        wire.current.operations[0].status = .running; await store.load()
        #expect(store.deletionProblem(fresh)?.contains("intervento è in corso") == true)
        #expect(await store.delete(fresh) == false)
        #expect(wire.removals.isEmpty)
    }

    @Test func timeoutORevocaNonCancellanoSnapshotENonRitentanoAutomaticamente() async throws {
        let failures: [any Error] = [URLError(.timedOut), ApiError(status: 403, code: "scope_required", message: "PRIVATE-DO-NOT-ECHO"), ApiError(status: 409, code: "operation_running", message: "PRIVATE-DO-NOT-ECHO"), ApiError(status: 409, code: "inventory_changed", message: "PRIVATE-DO-NOT-ECHO")]
        for failure in failures {
            let wire = SSHDeletionTransport(), store = await loaded(wire)
            let request = try #require(store.deletionRequest(for: .server(SSHDeletionFixtures.server.id)))
            let deleting = Task { await store.delete(request) }
            await waitFor { wire.pending.count == 1 }
            wire.pending[0].resume(throwing: failure)
            #expect(await deleting.value == false)
            #expect(store.snapshot == wire.current && !store.busy && store.deleting == nil)
            #expect(store.error != nil && store.error?.contains("PRIVATE") == false)
            #expect(await store.delete(request) == false)
            #expect(wire.removals.count == 1)
        }
    }

    @Test func snapshotCheContieneAncoraIlBersaglioNonConfermaLaRimozione() async throws {
        let wire = SSHDeletionTransport(), store = await loaded(wire)
        let request = try #require(store.deletionRequest(for: .site(SSHDeletionFixtures.site.id)))
        let deleting = Task { await store.delete(request) }
        await waitFor { wire.pending.count == 1 }
        wire.pending[0].resume(returning: wire.current)
        #expect(await deleting.value == false)
        #expect(store.error?.contains("non è confermata") == true)
        #expect(store.snapshot == wire.current)
    }

    @Test func conflittoDaAltroDispositivoRichiedeInventarioENuovaConferma() async throws {
        let wire = SSHDeletionTransport(), store = await loaded(wire)
        let original = try #require(store.deletionRequest(for: .server(SSHDeletionFixtures.server.id)))
        let first = Task { await store.delete(original) }
        await waitFor { wire.pending.count == 1 }
        wire.pending[0].resume(throwing: ApiError(status: 409, code: "inventory_changed", message: "PRIVATE"))
        #expect(await first.value == false)
        #expect(store.error?.contains("nuova conferma") == true)
        #expect(!store.canDelete(original))
        wire.current.sites.append(.init(id: "55555555-5555-4555-8555-555555555555", serverId: SSHDeletionFixtures.server.id, name: "Aggiunto altrove", url: "https://new.example.test", path: "", container: ""))
        await store.load()
        let refreshed = try #require(store.deletionRequest(for: original.target))
        #expect(refreshed.id != original.id && refreshed.linkedSites.count == 2)
        #expect(!store.canDelete(original) && store.canDelete(refreshed))
        let second = Task { await store.delete(refreshed) }
        await waitFor { wire.pending.count == 2 }
        #expect(wire.preconditions.last == refreshed.precondition)
        wire.pending[1].resume(returning: wire.removedServer())
        #expect(await second.value)
    }

    @Test func riferimentiNonUUIDVengonoRifiutatiPrimaDiQualsiasiRichiesta() async {
        let api = ApiClient(credentials: .init(serverURL: URL(string: "https://example.test")!, apiKey: "synthetic"), transport: { _ in
            Issue.record("Trasporto invocato per un identificativo non valido")
            throw URLError(.badURL)
        })
        do {
            _ = try await api.sshRemove(.server("../providers/vultr"), expected: SSHDeletionFixtures.precondition)
            Issue.record("Identificativo non valido accettato")
        } catch { #expect((error as? ApiError)?.code == "invalid_id") }
    }

    @Test func deleteUsaRotteInventarioAutenticateEConfermaCongelata() async throws {
        for target in [SSHDeletionTarget.server(SSHDeletionFixtures.server.id), .site(SSHDeletionFixtures.site.id)] {
            let body = try JSONEncoder().encode(SSHDeletionFixtures.snapshot)
            let api = ApiClient(credentials: .init(serverURL: URL(string: "https://example.test")!, apiKey: "synthetic"), transport: { request in
                #expect(request.httpMethod == "DELETE")
                #expect(request.url?.path == "/v1/ssh/\(target.collection)/\(target.value)")
                #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic")
                struct Body: Decodable { let expected: SshDeletionPrecondition }
                let sent = try JSONDecoder().decode(Body.self, from: #require(request.httpBody))
                #expect(sent.expected == SSHDeletionFixtures.precondition)
                return (body, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
            })
            #expect(try await api.sshRemove(target, expected: SSHDeletionFixtures.precondition) == SSHDeletionFixtures.snapshot)
        }
    }

    @Test func confermaLeggibileChiaroScuroBorgECaratteriGrandi() async throws {
        let wire = SSHDeletionTransport(), store = await loaded(wire)
        let request = try #require(store.deletionRequest(for: .server(SSHDeletionFixtures.server.id)))
        for (name, costume, scheme, size): (String, BearCostume, ColorScheme, DynamicTypeSize) in [
            ("light", .base, .light, .large), ("dark", .base, .dark, .large),
            ("borg", .borg, .dark, .large), ("large", .base, .light, .accessibility3)
        ] {
            let palette = ChatPalette(costume: costume)
            let content = SSHDeletionContent(request: request, working: false, canDelete: true, remove: {}, refresh: {})
                .padding(16).frame(width: 320).background(palette.ground)
                .environment(\.chatPalette, palette).environment(\.colorScheme, scheme).environment(\.dynamicTypeSize, size)
            let renderer = ImageRenderer(content: content); renderer.scale = 1
            let image = try #require(renderer.uiImage)
            #expect(image.size.width == 320 && image.size.height > 300)
            let path = FileManager.default.temporaryDirectory.appendingPathComponent("ernie-ssh-delete-\(name).png")
            try #require(image.pngData()).write(to: path)
            print("SSH_DELETE_SNAPSHOT: \(path.path)")
        }
    }
}
