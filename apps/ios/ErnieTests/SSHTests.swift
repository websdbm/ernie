import Foundation
import SwiftUI
import Testing
@testable import Ernie

private enum SSHFixtures {
    static let server = SshServer(id: "00000000-0000-4000-8000-000000000001", name: "Server di prova", host: "server.example.test", port: 22, username: "ernie", provider: .vultr, providerInstanceId: "provider-instance-test", fingerprint: "SHA256:public-test-fingerprint", revision: 1, lastCheckedAt: nil, lastStatus: nil)
    static let site = SshSite(id: "00000000-0000-4000-8000-000000000002", serverId: server.id, name: "Sito di prova", url: "https://example.test", path: "/var/www/html", container: "wordpress")
    static let operation = SshOperation(serverId: server.id, kind: .ssh, title: "Controllare e ripristinare un servizio dopo la diagnosi", reason: "Intervento circoscritto da esaminare prima dell’esecuzione.", command: "systemctl restart example.service", verificationCommand: "systemctl status example.service", backup: "Configurazione salvata prima della modifica; verificare la copia.", rollback: "Ripristinare la configurazione salvata e verificare il servizio.", siteId: nil, id: "00000000-0000-4000-8000-000000000003", serverName: server.name, host: server.host, status: .pending, createdAt: "2026-10-19T09:00:00Z", expiresAt: "2099-10-19T10:00:00Z", output: nil)
    static var snapshot: SshSnapshot {
        .init(configured: true, key: .init(publicKey: "ssh-ed25519 public-test-only", fingerprint: "SHA256:public-test", createdAt: "2026-10-19T09:00:00Z"), servers: [server], sites: [site], providers: [.init(provider: .vultr, connected: true, lastCheckedAt: nil)], operations: [operation])
    }
}

struct SSHTests {
    @Test func ricercaInventarioIgnoraMaiuscoleAccentiECombinaCampiConFiltroServer() {
        var first = SSHFixtures.server; first.name = "Produzione Città"; first.host = "web-one.example.test"
        var second = first; second.id = "server-two"; second.name = "Staging"; second.host = "web-two.example.test"
        let servers = [first, second]
        var site = SSHFixtures.site; site.name = "Caffè"; site.url = "https://caffe.example.test"; site.path = "/srv/www/wordpress"
        var other = site; other.id = "site-two"; other.serverId = second.id; other.name = "Archivio"; other.url = "https://archive.example.test"
        let sites = [site, other]
        #expect(SSHInventoryFilter.servers(servers, query: "  CITTA  web-ONE ").map(\.id) == [first.id])
        #expect(SSHInventoryFilter.servers(servers, query: "   ").map(\.id) == servers.map(\.id))
        #expect(SSHInventoryFilter.sites(sites, servers: servers, query: "CAFFE /srv/www", serverId: nil).map(\.id) == [site.id])
        #expect(SSHInventoryFilter.sites(sites, servers: servers, query: "web-TWO archive", serverId: second.id).map(\.id) == [other.id])
        #expect(SSHInventoryFilter.sites(sites, servers: servers, query: "caffe", serverId: second.id).isEmpty)
        #expect(SSHInventoryFilter.sites(sites, servers: servers, query: "", serverId: "missing").isEmpty)
        #expect(SSHInventoryFilter.sites(sites, servers: servers, query: "", serverId: nil).map(\.id) == sites.map(\.id))
    }
    @Test func decodingInventarioConservaMappingProviderEDatiWP() throws {
        let encoded = try JSONEncoder().encode(SSHFixtures.snapshot)
        let snapshot = try JSONDecoder().decode(SshSnapshot.self, from: encoded)
        #expect(snapshot == SSHFixtures.snapshot)
        #expect(snapshot.servers.first?.providerInstanceId == "provider-instance-test")
        #expect(snapshot.sites.first?.container == "wordpress")
        #expect(snapshot.sites.first?.serverId == snapshot.servers.first?.id)
    }
    @Test func credenzialiCodificateSoloNelRamoGiustoEDescrizioniRedatte() throws {
        let vultr = SshProviderCredentials.vultr(apiKey: "TEST-ONLY-API-KEY")
        let contabo = SshProviderCredentials.contabo(clientId: "test-client", clientSecret: "TEST-ONLY-SECRET", username: "user@example.test", password: "TEST-ONLY-PASSWORD")
        for value in [vultr, contabo] {
            let data = try JSONEncoder().encode(value)
            #expect(try JSONDecoder().decode(SshProviderCredentials.self, from: data) == value)
            #expect(!String(describing: value).contains("TEST-ONLY"))
            #expect(!String(reflecting: value).contains("TEST-ONLY"))
        }
        let object = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(vultr)) as? [String: Any])
        #expect(Set(object.keys) == Set(["provider", "apiKey"]))
        let snapshotObject = try #require(String(data: JSONEncoder().encode(SSHFixtures.snapshot), encoding: .utf8))
        #expect(!snapshotObject.contains("privateKey"))
        #expect(!snapshotObject.contains("apiKey"))
    }
    @Test func importSelettivoIncludeRelazioneEApplicaDefaultSenzaSegreti() throws {
        let raw = #"{"source":"https://hf.example.test/","servers":[{"sourceId":"s1","name":"Uno","host":"one.example.test","ssh_password":"NON-IMPORTARE"},{"sourceId":"s2","name":"Due","host":"two.example.test"}],"sites":[{"sourceId":"w1","serverSourceId":"s1","name":"WordPress","url":"https://example.test"}]}"#
        let input = try JSONDecoder().decode(SshImportInput.self, from: Data(raw.utf8))
        #expect(input.servers[0].port == 22 && input.servers[0].username == "root")
        #expect(input.sites[0].path == "" && input.sites[0].container == "")
        let selected = input.selecting(servers: [], sites: ["w1"])
        #expect(selected.servers.map(\.sourceId) == ["s1"])
        #expect(selected.sites.map(\.serverSourceId) == ["s1"])
        let encoded = try #require(String(data: JSONEncoder().encode(selected), encoding: .utf8))
        #expect(!encoded.contains("NON-IMPORTARE") && !encoded.contains("ssh_password"))
    }
    @Test func approvazioneSoloPendingPrimaDellaScadenza() throws {
        let expiry = try #require(SSHFormatting.date(SSHFixtures.operation.expiresAt))
        #expect(SSHFixtures.operation.canDecide(now: expiry.addingTimeInterval(-1)))
        #expect(!SSHFixtures.operation.canDecide(now: expiry))
        for status: SshOperation.Status in [.running, .succeeded, .failed, .uncertain, .rejected, .expired] {
            var operation = SSHFixtures.operation; operation.status = status
            #expect(!operation.canDecide(now: expiry.addingTimeInterval(-1)))
        }
    }
}

@MainActor private final class SSHRequests {
    var reads: [CheckedContinuation<SshSnapshot, any Error>] = []
    var mutations: [SSHMutation] = []
    var pendingWrites: [CheckedContinuation<SshSnapshot, any Error>] = []
    var decisionCount = 0
    var pendingDecisions: [CheckedContinuation<SshOperation, any Error>] = []
    var current = SSHFixtures.snapshot
    func read() async throws -> SshSnapshot { try await withCheckedThrowingContinuation { reads.append($0) } }
    func mutate(_ value: SSHMutation) async throws -> SshSnapshot {
        mutations.append(value)
        return try await withCheckedThrowingContinuation { pendingWrites.append($0) }
    }
    func decide(_ id: String, _ approve: Bool) async throws -> SshOperation {
        decisionCount += 1
        return try await withCheckedThrowingContinuation { pendingDecisions.append($0) }
    }
    var transport: SSHStore.Transport {
        var transport = SSHStore.Transport()
        transport.snapshot = read; transport.mutate = mutate; transport.decision = decide
        transport.operation = { _ in self.current.operations[0] }
        return transport
    }
}

@MainActor struct SSHStoreTests {
    private func waitFor(_ condition: () -> Bool) async {
        for _ in 0..<1000 { if condition() { return }; await Task.yield() }
        #expect(condition())
    }
    private func loaded(_ store: SSHStore, _ requests: SSHRequests) async {
        let task = Task { await store.load() }
        await waitFor { !requests.reads.isEmpty }
        requests.reads.last?.resume(returning: requests.current)
        await task.value
    }
    @Test func logoutEliminaInventarioERisposteTardive() async {
        let store = SSHStore(), requests = SSHRequests()
        store.configure(transport: requests.transport)
        let task = Task { await store.load() }
        await waitFor { requests.reads.count == 1 }
        store.configure(api: nil)
        requests.reads[0].resume(returning: SSHFixtures.snapshot)
        await task.value
        #expect(store.snapshot == nil && !store.loading && store.error == nil)
        #expect(store.fingerprints.isEmpty && store.instances.isEmpty && store.diagnosticOutput == nil)
    }
    @Test func mutazioniSerializzateELettureVecchieScartate() async {
        let store = SSHStore(), requests = SSHRequests()
        store.configure(transport: requests.transport)
        let reading = Task { await store.load() }
        await waitFor { requests.reads.count == 1 }
        let first = Task { await store.mutate(.key(rotate: false)) }
        await waitFor { requests.mutations.count == 1 }
        let second = Task { await store.mutate(.server(SSHFixtures.server.input)) }
        for _ in 0..<20 { await Task.yield() }
        #expect(requests.mutations.count == 1)
        requests.pendingWrites[0].resume(returning: SSHFixtures.snapshot)
        #expect(await first.value)
        await waitFor { requests.mutations.count == 2 }
        var updated = SSHFixtures.snapshot; updated.servers[0].name = "Nuovo nome"; updated.servers[0].revision = 2
        requests.pendingWrites[1].resume(returning: updated)
        #expect(await second.value)
        requests.reads[0].resume(returning: SSHFixtures.snapshot)
        await reading.value
        #expect(store.snapshot?.servers[0].name == "Nuovo nome")
        #expect(!store.busy)
    }
    @Test func timeoutApprovazioneNonRipeteRichiestaENonRiabilitaPulsante() async {
        let store = SSHStore(), requests = SSHRequests()
        store.configure(transport: requests.transport)
        await loaded(store, requests)
        let task = Task { await store.decide(SSHFixtures.operation, approve: true) }
        await waitFor { requests.decisionCount == 1 }
        await store.decide(SSHFixtures.operation, approve: true)
        #expect(requests.decisionCount == 1)
        requests.pendingDecisions[0].resume(throwing: URLError(.timedOut))
        await task.value
        #expect(store.snapshot?.operations[0].status == .uncertain)
        #expect(store.error == SSHFormatting.uncertain)
        await store.refreshOperation(SSHFixtures.operation.id)
        #expect(store.snapshot?.operations[0].status == .uncertain)
        #expect(!store.canDecide(SSHFixtures.operation))
        await store.decide(SSHFixtures.operation, approve: true)
        #expect(requests.decisionCount == 1)
    }
    @Test func logoutDuranteApprovazioneNonRiportaEsitiPrivati() async {
        let store = SSHStore(), requests = SSHRequests()
        store.configure(transport: requests.transport)
        await loaded(store, requests)
        let task = Task { await store.decide(SSHFixtures.operation, approve: true) }
        await waitFor { requests.decisionCount == 1 }
        store.configure(api: nil)
        var completed = SSHFixtures.operation; completed.status = .succeeded; completed.output = "Esito privato"
        requests.pendingDecisions[0].resume(returning: completed)
        await task.value
        #expect(store.snapshot == nil && store.error == nil && store.attemptedDecisions.isEmpty)
    }
    @Test func erroreProviderNonMostraSegretiEdImprontaNonDiventaFidata() async {
        let store = SSHStore()
        var transport = SSHStore.Transport()
        transport.snapshot = { SSHFixtures.snapshot }
        transport.probe = { _ in "SHA256:new-public-host-fingerprint" }
        transport.mutate = { _ in throw ApiError(status: 401, code: "auth", message: "TEST-SECRET-DO-NOT-ECHO") }
        store.configure(transport: transport)
        await store.load()
        await store.probe(SSHFixtures.server.id)
        #expect(store.fingerprints[SSHFixtures.server.id] == "SHA256:new-public-host-fingerprint")
        #expect(store.snapshot?.servers[0].fingerprint == SSHFixtures.server.fingerprint)
        #expect(await store.mutate(.connect(.vultr(apiKey: "TEST-SECRET-DO-NOT-ECHO"))) == false)
        #expect(store.error?.contains("TEST-SECRET") == false)
    }
    @Test func renderPropostaEdEsitoIncerto320390ChiaroScuro() throws {
        for width in [CGFloat(320), CGFloat(390)] {
            for dark in [false, true] {
                for large in [false, true] {
                    var uncertain = SSHFixtures.operation; uncertain.status = .uncertain; uncertain.output = SSHFormatting.uncertain
                    let content = VStack(alignment: .leading, spacing: 16) {
                        Text("Operazioni SSH").font(.title2.bold())
                        SSHOperationView(operation: SSHFixtures.operation, canDecide: true, busy: false, approve: {}, reject: {}, refresh: {})
                        SSHOperationView(operation: uncertain, canDecide: false, busy: false, approve: {}, reject: {}, refresh: {})
                        SSHProviderCard(provider: .contabo, connected: false, checkedAt: nil, connect: {})
                    }.padding(16).frame(width: width).background(Theme.ground)
                        .environment(\.colorScheme, dark ? .dark : .light)
                        .environment(\.dynamicTypeSize, large ? .accessibility2 : .large)
                    let renderer = ImageRenderer(content: content); renderer.scale = 1
                    let image = try #require(renderer.uiImage)
                    #expect(image.size.width == width && image.size.height > 500)
                    let data = try #require(image.pngData())
                    let path = FileManager.default.temporaryDirectory.appendingPathComponent("ernie-ssh-\(Int(width))-\(dark ? "dark" : "light")-\(large ? "large" : "normal").png")
                    try data.write(to: path)
                    print("SSH_SNAPSHOT: \(path.path)")
                }
            }
        }
    }
}
