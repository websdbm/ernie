import Foundation
import Testing
import UIKit
@testable import Ernie

@MainActor private final class UploadDriver: MediaUploadDriving {
    struct Sent { var id: String; var attempt: Int; var request: URLRequest; var body: Data }
    var completed: ((String, Int, Int, Data, NSError?) -> Void)?
    var backgroundCompletion: (() -> Void)?
    var sent: [Sent] = []
    var running: [String: Int] = [:]
    var cancelled = Set<String>()
    var holdRestore = false
    var restoreWaiter: CheckedContinuation<Void, Never>?
    func restore(allowed: [String: Int]) async -> Set<String> {
        if holdRestore { await withCheckedContinuation { restoreWaiter = $0 } }
        running = running.filter { allowed[$0.key] == $0.value }
        return Set(running.keys)
    }
    func send(id: String, attempt: Int, request: URLRequest, file: URL, earliest: Date?) {
        sent.append(Sent(id: id, attempt: attempt, request: request, body: try! Data(contentsOf: file)))
        running[id] = attempt
    }
    func cancel(ids: Set<String>) { cancelled.formUnion(ids); running = running.filter { !ids.contains($0.key) } }
    func finish(_ id: String, status: Int = 201) throws {
        let currentAttempt = running.removeValue(forKey: id)
        let attempt = try #require(currentAttempt)
        struct Response: Encodable { var item: SavedMedia }
        let media = SavedMedia(id: id, title: "Foto", description: "", category: "Foto", tags: [], width: 40, height: 60, source: "library", organization: "manual", version: 1, createdAt: "2026-10-18T10:00:00Z", updatedAt: "2026-10-18T10:00:00Z")
        completed?(id, attempt, status, try JSONEncoder().encode(Response(item: media)), nil)
    }
}

@MainActor struct MediaUploadQueueTests {
    private let credentials = Credentials(serverURL: URL(string: "https://example.test")!, apiKey: "test-background-only")
    private func root() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true) }
    private func upload() -> MediaUpload { MediaUpload(data: Data([0xff, 0xd8, 0xff, 0xd9]), source: "library", autoOrganize: false) }
    private func waitFor(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(10)
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        #expect(condition())
    }

    @Test func posizioneRestaNelJournalENelPayloadDopoRiavvio() async throws {
        let root = root(), driver = UploadDriver(), queue = MediaUploadQueue(root: root, driver: driver)
        defer { queue.configure(nil); try? FileManager.default.removeItem(at: root) }
        queue.configure(credentials); await queue.resume()
        var value = upload()
        value.location = MediaLocation(lat: 45.5, lon: 12.25, capturedAt: "2020-03-02T10:15:30Z", accuracy: 8)
        let handle = try queue.enqueue(value, credentials: credentials)
        try await waitFor { driver.sent.count == 1 }
        let manifest = try Data(contentsOf: root.appendingPathComponent(handle.id + ".entry"))
        let pending = try JSONDecoder().decode(PendingMediaUpload.self, from: manifest)
        #expect(pending.location == value.location)
        struct Body: Decodable { var location: MediaLocation? }
        #expect(try JSONDecoder().decode(Body.self, from: driver.sent[0].body).location == value.location)
        let freshDriver = UploadDriver(), restored = MediaUploadQueue(root: root, driver: freshDriver)
        restored.configure(credentials); await restored.resume()
        #expect(freshDriver.sent.count == 1)
        #expect(freshDriver.sent.first?.body == driver.sent.first?.body)
        #expect(restored.entries.first?.location == value.location)
        var legacy = try #require(JSONSerialization.jsonObject(with: manifest) as? [String: Any])
        legacy.removeValue(forKey: "location")
        let old = try JSONDecoder().decode(PendingMediaUpload.self, from: JSONSerialization.data(withJSONObject: legacy))
        #expect(old.location == nil)
        try freshDriver.finish(handle.id)
        restored.configure(nil)
    }

    @Test func posizioneImprecisaNonBloccaUploadENonFinisceNelPayload() async throws {
        let root = root(), driver = UploadDriver(), queue = MediaUploadQueue(root: root, driver: driver)
        defer { queue.configure(nil); try? FileManager.default.removeItem(at: root) }
        queue.configure(credentials); await queue.resume()
        var value = upload()
        value.location = MediaLocation(lat: 45.5, lon: 12.25, accuracy: 200)
        let handle = try queue.enqueue(value, credentials: credentials)
        try await waitFor { driver.sent.count == 1 }
        let pending = try JSONDecoder().decode(PendingMediaUpload.self, from: Data(contentsOf: root.appendingPathComponent(handle.id + ".entry")))
        #expect(pending.location == nil)
        struct Body: Decodable { var data: String; var location: MediaLocation? }
        let body = try JSONDecoder().decode(Body.self, from: driver.sent[0].body)
        #expect(body.location == nil)
        #expect(Data(base64Encoded: body.data) == value.data)
        try driver.finish(handle.id)
        #expect(try await handle.value().id == handle.id)
    }

    @Test func quattroPartonoSenzaAspettareLaPrimaEUnErroreNonFermaLeAltre() async throws {
        let root = root(), driver = UploadDriver(), queue = MediaUploadQueue(root: root, driver: driver)
        defer { queue.configure(nil); try? FileManager.default.removeItem(at: root) }
        queue.configure(credentials); await queue.resume()
        let handles = try (0..<4).map { _ in try queue.enqueue(upload(), credentials: credentials) }
        try await waitFor { driver.sent.count == 4 }
        #expect(Set(driver.sent.map(\.id)).count == 4)
        try driver.finish(handles[0].id, status: 503)
        #expect(driver.sent.count == 5)
        #expect(driver.sent[0].body == driver.sent[4].body)
        for handle in handles.dropFirst() { try driver.finish(handle.id) }
        try driver.finish(handles[0].id)
        for handle in handles { #expect(try await handle.value().id == handle.id) }
        #expect(queue.pending.isEmpty); #expect(queue.failed.isEmpty)
        #expect(queue.entries.filter { $0.state == .complete }.count == 4)
    }

    @Test func ripartenzaRecuperaTaskOSENonDuplicaQuelliAncoraAttivi() async throws {
        let root = root(), driver = UploadDriver(), first = MediaUploadQueue(root: root, driver: driver)
        defer { first.configure(nil); try? FileManager.default.removeItem(at: root) }
        first.configure(credentials); await first.resume()
        let handle = try first.enqueue(upload(), credentials: credentials)
        try await waitFor { driver.sent.count == 1 }
        let restoredDriver = UploadDriver(); restoredDriver.running = driver.running
        let restored = MediaUploadQueue(root: root, driver: restoredDriver)
        restored.configure(credentials); await restored.resume()
        #expect(restoredDriver.sent.isEmpty)
        try restoredDriver.finish(handle.id)
        #expect(try await restored.result(handle.id).id == handle.id)
        let receipt = MediaUploadQueue(root: root, driver: UploadDriver())
        receipt.configure(credentials); await receipt.resume()
        #expect(try await receipt.result(handle.id).id == handle.id)
        #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent(handle.id + ".body").path))
        let manifest = try Data(contentsOf: root.appendingPathComponent(handle.id + ".entry"))
        #expect(!String(decoding: manifest, as: UTF8.self).contains(credentials.apiKey))
        restored.configure(nil); receipt.configure(nil)
    }

    @Test func taskPersoRiparteDalFileConStessoIDENonRestaBloccato() async throws {
        let root = root(), driver = UploadDriver(), queue = MediaUploadQueue(root: root, driver: driver)
        defer { queue.configure(nil); try? FileManager.default.removeItem(at: root) }
        queue.configure(credentials); await queue.resume()
        let handle = try queue.enqueue(upload(), credentials: credentials)
        try await waitFor { driver.sent.count == 1 }
        // Nessun task elencato: potrebbe esserci un callback ancora da consegnare.
        // Nel processo vivo si aspetta l'esito senza consumare un altro tentativo.
        driver.running = [:]
        await queue.resume()
        #expect(driver.sent.count == 1)
        // Dopo una chiusura forzata riparte un processo nuovo: qui il task manca
        // davvero e viene ricreato dal file con lo stesso identificativo.
        let freshDriver = UploadDriver()
        let recovered = MediaUploadQueue(root: root, driver: freshDriver)
        recovered.configure(credentials); await recovered.resume()
        #expect(freshDriver.sent.count == 1)
        #expect(driver.sent[0].id == freshDriver.sent[0].id)
        #expect(driver.sent[0].body == freshDriver.sent[0].body)
        #expect(freshDriver.sent[0].attempt == 2)
        try freshDriver.finish(handle.id)
        recovered.configure(nil)
    }

    @Test func nuovaFotoDuranteRipristinoNonVieneCancellataDalVecchioSnapshot() async throws {
        let root = root(), driver = UploadDriver(), queue = MediaUploadQueue(root: root, driver: driver)
        defer { queue.configure(nil); try? FileManager.default.removeItem(at: root) }
        driver.holdRestore = true
        queue.configure(credentials)
        try await waitFor { driver.restoreWaiter != nil }
        let handle = try queue.enqueue(upload(), credentials: credentials)
        #expect(driver.sent.isEmpty)
        driver.holdRestore = false; driver.restoreWaiter?.resume(); driver.restoreWaiter = nil
        try await waitFor { driver.sent.count == 1 }
        #expect(driver.running[handle.id] == 1)
        try driver.finish(handle.id)
    }

    @Test func treTentativiPoiErrorePersistitoERiprovaConStessoContenuto() async throws {
        let root = root(), driver = UploadDriver(), queue = MediaUploadQueue(root: root, driver: driver)
        defer { queue.configure(nil); try? FileManager.default.removeItem(at: root) }
        queue.configure(credentials); await queue.resume()
        let handle = try queue.enqueue(upload(), credentials: credentials)
        try await waitFor { driver.sent.count == 1 }
        for _ in 0..<3 { try driver.finish(handle.id, status: 503) }
        #expect(driver.sent.count == 3); #expect(queue.failed.count == 1)
        await queue.resume(); #expect(driver.sent.count == 3)
        queue.retryFailed(); #expect(driver.sent.count == 4)
        #expect(driver.sent.allSatisfy { $0.body == driver.sent[0].body })
        try driver.finish(handle.id)
        #expect(try await handle.value().id == handle.id)
    }

    @Test func chiudereChiAttendeNonAnnullaLaFotoLogoutInvecePulisceTutto() async throws {
        let root = root(), driver = UploadDriver(), queue = MediaUploadQueue(root: root, driver: driver)
        defer { queue.configure(nil); try? FileManager.default.removeItem(at: root) }
        queue.configure(credentials); await queue.resume()
        let handle = try queue.enqueue(upload(), credentials: credentials)
        let waiter = Task { try await handle.value() }
        await Task.yield(); waiter.cancel()
        do { _ = try await waiter.value; Issue.record("L'attesa doveva essere annullata") } catch { #expect(error is CancellationError) }
        #expect(!driver.cancelled.contains(handle.id))
        queue.configure(nil)
        #expect(driver.cancelled.contains(handle.id)); #expect(queue.entries.isEmpty)
        #expect((try FileManager.default.contentsOfDirectory(atPath: root.path)).isEmpty)
        driver.completed?(handle.id, 1, 500, Data(), nil)
        #expect(queue.entries.isEmpty); #expect(driver.sent.count <= 1)
    }

    @Test func selezioneConUnaFotoIlleggibileConservaTutteLeAltre() async throws {
        let root = root(), driver = UploadDriver(), queue = MediaUploadQueue(root: root, driver: driver)
        let importer = MediaImportCoordinator(queue: queue)
        defer { importer.reset(); queue.configure(nil); try? FileManager.default.removeItem(at: root) }
        queue.configure(credentials); await queue.resume()
        let format = UIGraphicsImageRendererFormat.default(); format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: 40, height: 60), format: format).image { c in
            UIColor.orange.setFill(); c.fill(CGRect(x: 0, y: 0, width: 40, height: 60))
        }
        importer.start(count: 4, credentials: credentials, autoOrganize: false) { index in
            if index == 1 { throw DocumentReader.ReadError.unreadable }
            return image
        }
        try await waitFor { importer.progress == nil }
        #expect(queue.entries.count == 3)
        #expect(importer.notice?.contains("3 di 4") == true)
        #expect(importer.notice?.contains("foto 2") == true)
        try await waitFor { driver.sent.count == 3 }
        for id in Array(driver.running.keys) { try driver.finish(id) }
        #expect(queue.entries.allSatisfy { $0.state == .complete })
    }
}
