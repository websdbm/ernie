import Foundation
import CryptoKit
import Testing
import SwiftUI
@testable import Ernie

struct DiaryCryptoTests {
    private var document: DiaryDocument {
        DiaryDocument(entries: [DiaryEntry(createdAt: Date(timeIntervalSince1970: 1_700_000_000), timeZone: "Europe/Rome", original: "CANARY originale privato 🌿")], draft: DiaryDraft(text: "CANARY bozza"))
    }
    @Test func authenticatedEncryptionIsRandomAndAccountBound() throws {
        let document = self.document
        let key = SymmetricKey(size: .bits256)
        let first = try DiaryCrypto.seal(document, key: key, scope: "alice")
        let second = try DiaryCrypto.seal(document, key: key, scope: "alice")
        #expect(first != second)
        #expect(try DiaryCrypto.open(first, key: key, scope: "alice") == document)
        #expect(throws: DiaryError.self) { try DiaryCrypto.open(first, key: key, scope: "bob") }
        #expect(throws: DiaryError.self) { try DiaryCrypto.open(first, key: SymmetricKey(size: .bits256), scope: "alice") }
        var altered = first; altered[altered.count / 2] ^= 1
        #expect(throws: DiaryError.self) { try DiaryCrypto.open(altered, key: key, scope: "alice") }
        #expect(!first.contains(Data("CANARY".utf8)))
    }
    @Test func portableBackupRejectsWrongPasswordTamperingAndUnsafeParameters() throws {
        let doc = document
        let pass = "test-only-long-password"
        let data = try DiaryCrypto.backup(doc, password: pass)
        #expect(try DiaryCrypto.restore(data, password: pass) == doc)
        #expect(throws: DiaryError.self) { try DiaryCrypto.restore(data, password: "wrong") }
        #expect(throws: DiaryError.self) { try DiaryCrypto.backup(doc, password: "short") }
        var envelope = try JSONDecoder().decode(DiaryCrypto.Backup.self, from: data)
        envelope.rounds = Int.max
        #expect(throws: DiaryError.self) { try DiaryCrypto.restore(JSONEncoder().encode(envelope), password: pass) }
        envelope.rounds = 600_000; envelope.sealed[20] ^= 1
        #expect(throws: DiaryError.self) { try DiaryCrypto.restore(JSONEncoder().encode(envelope), password: pass) }
        #expect(!data.contains(Data("CANARY".utf8)))
    }
    @Test func accountScopeIgnoresEquivalentURLSpellings() {
        let a = DiaryIdentity.scope(server: URL(string: "https://example.com")!, userID: "alice")
        #expect(a == DiaryIdentity.scope(server: URL(string: "https://EXAMPLE.com:443/")!, userID: "alice"))
        #expect(a != DiaryIdentity.scope(server: URL(string: "https://example.com")!, userID: "bob"))
    }
    @Test func consentDigestIsStableAndContentSensitive() {
        let entries = document.entries
        let digest = DiaryIdentity.digest(entries)
        for _ in 0..<100 { #expect(DiaryIdentity.digest(entries) == digest) }
        var changed = entries; changed[0].original += " cambiato"
        #expect(DiaryIdentity.digest(changed) != digest)
    }
    @Test(arguments: ["Apri diario", "Ernie, apri il mio diario personale", "Apri diario, scrivi: testo privato", "Scrivi nel mio diario: testo privato", "Diario personale: testo privato"])
    func recognizesPrivateCommands(text: String) { #expect(DiaryLaunch.parse(text) != nil) }
    /// Il testo privato che nomina il diario operativo resta nel diario, non va in chat (revisione del 25 ott 2026).
    @Test func keepsPrivateTextThatMentionsTheOperationalDiary() {
        let text = "Scrivi nel diario: oggi ho riletto il diario operativo del progetto e mi sono sentito inutile"
        #expect(DiaryLaunch.parse(text)?.draft == "oggi ho riletto il diario operativo del progetto e mi sono sentito inutile")
        #expect(DiaryLaunch.parse("Apri diario, scrivi: il diario delle attività mi stanca")?.draft == "il diario delle attività mi stanca")
    }
    @Test(arguments: ["Non aprire il diario", "Come funziona il diario?", "Apri diariologia", "Mostra il diario delle attività di ieri", "Apri il diario operativo", "Scrivi nel diario delle attività: riunione alle 9"])
    func doesNotTreatUnrelatedRequestsAsJournal(text: String) {
        #expect(DiaryLaunch.parse(text) == nil)
    }
}

@MainActor private final class TestDiaryKeys: DiaryKeyAccess {
    var key = SymmetricKey(size: .bits256)
    var allowed = true
    var gate: CheckedContinuation<Void, Never>?
    var suspended = false
    /// La chiave del diario esistente non si apre più (biometria cambiata); una chiave nuova invece sì.
    var invalidated = false
    func unlock(existingVault: Bool) async throws -> SymmetricKey {
        if suspended { await withCheckedContinuation { gate = $0 } }
        guard allowed else { throw DiaryError.unavailable }
        if invalidated, existingVault { throw DiaryError.keyInvalidated }
        if invalidated { key = SymmetricKey(size: .bits256) }
        return key
    }
}
private actor TestDiaryAI: DiaryTransforming {
    var calls = 0
    var inputs: [DiaryEntry] = []
    let delayed: Bool
    var continuation: CheckedContinuation<Void, Never>?
    init(delayed: Bool = false) { self.delayed = delayed }
    func transform(entries: [DiaryEntry], operation: String) async throws -> DiaryAIResult {
        calls += 1; inputs = entries
        if delayed { await withCheckedContinuation { continuation = $0 } }
        return DiaryAIResult(normalized: "CANARY riordinato", bullets: ["CANARY sintesi"], model: "test/model")
    }
    func finish() { continuation?.resume(); continuation = nil }
}

@Suite(.serialized) @MainActor struct DiaryStoreTests {
    private func fixture() -> (DiaryStore, TestDiaryKeys, URL) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("diary-test-" + UUID().uuidString)
        let keys = TestDiaryKeys()
        return (DiaryStore(scope: "alice", directory: directory, keyAccess: { _ in keys }), keys, directory)
    }
    private func settled(_ check: () async -> Bool) async throws {
        for _ in 0..<100 { if await check() { return }; try await Task.sleep(for: .milliseconds(10)) }
        Issue.record("Operation did not settle")
    }
    @Test func localVaultNeverStoresPlaintextAndLockRequiresNewAuthentication() async throws {
        let (store, keys, directory) = fixture()
        defer { try? FileManager.default.removeItem(at: directory) }
        store.updateDraft("must not be accepted")
        #expect(!store.exists && store.document == nil)
        await store.unlock()
        store.updateDraft("CANARY raw text\nwith spacing  ")
        let id = try #require(store.saveEntry())
        store.updateDraft("CANARY draft")
        store.lock()
        #expect(store.document == nil && !store.isUnlocked && store.consent == nil)
        let path = directory.appendingPathComponent("alice.sealed")
        let data = try Data(contentsOf: path)
        #expect(!data.contains(Data("CANARY".utf8)))
        #expect(try directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
        #if !targetEnvironment(simulator)
        #expect(try FileManager.default.attributesOfItem(atPath: path.path)[.protectionKey] as? String == FileProtectionType.complete.rawValue)
        #endif // The simulator does not implement iPhone Data Protection attributes.
        keys.allowed = false
        await store.unlock()
        #expect(!store.isUnlocked && store.document == nil)
        #expect(try Data(contentsOf: path) == data)
        keys.allowed = true
        await store.unlock()
        #expect(store.document?.entries.first?.id == id)
        #expect(store.document?.entries.first?.original == "CANARY raw text\nwith spacing  ")
        #expect(store.document?.draft.text == "CANARY draft")
        store.lock()
    }
    @Test func explicitConsentIsOneShotAndOnlySelectedOriginalIsSent() async throws {
        let (store, _, directory) = fixture()
        defer { store.lock(); try? FileManager.default.removeItem(at: directory) }
        await store.unlock()
        store.updateDraft("first private page")
        let id = try #require(store.saveEntry())
        store.updateDraft("another private page")
        _ = store.saveEntry()
        let client = TestDiaryAI()
        #expect(throws: DiaryError.self) { try store.authorize(UUID(), client: client) }
        #expect(await client.calls == 0)
        try store.prepareAI(ids: [id], operation: "entry")
        let consent = try #require(store.consent)
        #expect(await client.calls == 0)
        try store.authorize(consent.id, client: client)
        #expect(throws: DiaryError.self) { try store.authorize(consent.id, client: client) }
        try await settled { !store.busy }
        #expect(await client.calls == 1)
        #expect(await client.inputs.map(\.id) == [id])
        let entry = try #require(store.document?.entries.first { $0.id == id })
        #expect(entry.original == "first private page")
        #expect(entry.revisions.count == 1)
        #expect(entry.revisions[0].normalized == "CANARY riordinato")
        let bytes = try Data(contentsOf: directory.appendingPathComponent("alice.sealed"))
        #expect(!bytes.contains(Data("CANARY".utf8)))
        try store.prepareAI(ids: [id], operation: "entry")
        store.cancelConsent()
        #expect(throws: DiaryError.self) { try store.authorize(consent.id, client: client) }
    }
    @Test func lockingDiscardsLateAIAndInvalidatesPendingUnlock() async throws {
        let (store, keys, directory) = fixture()
        defer { store.lock(); try? FileManager.default.removeItem(at: directory) }
        await store.unlock(); store.updateDraft("raw")
        let id = try #require(store.saveEntry())
        let client = TestDiaryAI(delayed: true)
        try store.prepareAI(ids: [id], operation: "entry")
        try store.authorize(try #require(store.consent?.id), client: client)
        try await settled { await client.calls == 1 }
        store.lock(); await client.finish()
        try await Task.sleep(for: .milliseconds(40))
        #expect(store.document == nil)
        await store.unlock()
        #expect(store.document?.entries.first?.revisions.isEmpty == true)
        store.lock()
        keys.suspended = true
        let unlocking = Task { await store.unlock() }
        try await settled { keys.gate != nil }
        store.lock(); keys.gate?.resume(); keys.gate = nil
        await unlocking.value
        #expect(!store.isUnlocked)
    }
    @Test func backupRecoveryPreservesOldCiphertextAndMergesWithoutOverwritingOriginals() async throws {
        let (store, _, directory) = fixture()
        defer { store.lock(); try? FileManager.default.removeItem(at: directory) }
        await store.unlock(); store.updateDraft("original")
        let id = try #require(store.saveEntry())
        let backup = try store.exportBackup(password: "recovery-password-test")
        store.updateDraft("second"); _ = store.saveEntry()
        try await store.restoreBackup(backup, password: "recovery-password-test")
        #expect(store.document?.entries.count == 2)
        // Diario bloccato ma con la chiave valida: si sblocca e si UNISCE, niente sostituzione (revisione 25 ott 2026).
        store.lock()
        try await store.restoreBackup(backup, password: "recovery-password-test")
        #expect(store.document?.entries.count == 2)
        #expect(try !FileManager.default.contentsOfDirectory(atPath: directory.path).contains { $0.contains(".previous-") })
    }
    @Test func lockedRestoreReplacesOnlyWhenTheKeyIsInvalidated() async throws {
        let (store, keys, directory) = fixture()
        defer { store.lock(); try? FileManager.default.removeItem(at: directory) }
        await store.unlock(); store.updateDraft("original")
        let id = try #require(store.saveEntry())
        let backup = try store.exportBackup(password: "recovery-password-test")
        store.updateDraft("second"); _ = store.saveEntry()
        store.lock()
        // Face ID annullato: nessuna sostituzione.
        keys.allowed = false
        await #expect(throws: DiaryError.self) { try await store.restoreBackup(backup, password: "recovery-password-test") }
        #expect(try !FileManager.default.contentsOfDirectory(atPath: directory.path).contains { $0.contains(".previous-") })
        // Chiave sparita (biometria cambiata): si sostituisce con la copia e si conserva il vecchio cifrato.
        keys.allowed = true; keys.invalidated = true
        try await store.restoreBackup(backup, password: "recovery-password-test")
        #expect(store.document?.entries.count == 1)
        #expect(store.document?.entries.first?.id == id)
        #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path).contains { $0.contains(".previous-") })
    }
    @Test func incomingOverflowPreservesBothTextsAndFailedSaveIsVisible() async throws {
        let (store, _, directory) = fixture()
        defer { store.lock(); try? FileManager.default.removeItem(at: directory) }
        await store.unlock()
        let original = String(repeating: "a", count: 49_999)
        store.updateDraft(original)
        #expect(store.appendIncoming("new private text"))
        #expect(store.document?.draft.text == original)
        #expect(store.document?.entries.first?.original == "new private text")
        #expect(!store.appendIncoming(String(repeating: "b", count: 50_001)))
        #expect(store.document?.entries.count == 1)
        try FileManager.default.removeItem(at: directory)
        try Data("block-directory".utf8).write(to: directory)
        store.updateDraft("cannot save")
        store.flush()
        #expect(store.hasUnsavedChanges && store.error != nil)
        store.lock()
        #expect(store.document == nil && store.lostUnsavedChanges)
    }
    @Test func privateCommandNeverCreatesTranscriptOrOutgoingChatTurn() throws {
        let name = "diary-chat-" + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        defer { defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: directory) }
        let credentials = Credentials(serverURL: URL(string: "https://example.invalid")!, apiKey: "test-only")
        let store = ConversationStore(credentials: credentials, speaker: Speaker(), inbox: InboxStore(), settings: LocalSettings(),
                                      transcript: TranscriptStore(directory: directory, defaults: defaults), deviceContext: { nil })
        store.send("Apri diario, scrivi: CANARY confidenza", inputMode: "text")
        #expect(store.diaryLaunch?.draft == "CANARY confidenza")
        #expect(store.items.isEmpty && store.activeCorrelationId == nil)
        store.send("Scrivi nel diario: CANARY voce", inputMode: "voice")
        #expect(store.items.isEmpty && store.activeCorrelationId == nil)
        store.disconnect()
    }
}

@Suite(.serialized) @MainActor struct DiaryViewTests {
    @Test func savedEntryShowsConsentPromptWithoutSendingText() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("diary-view-" + UUID().uuidString)
        let keys = TestDiaryKeys()
        let store = DiaryStore(scope: "view", directory: directory, keyAccess: { _ in keys })
        defer { store.lock(); try? FileManager.default.removeItem(at: directory) }
        await store.unlock(); store.updateDraft("Pagina di prova: oggi ho dedicato tempo a un’idea.\nVorrei riprenderla domani.")
        let id = try #require(store.saveEntry())
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let credentials = Credentials(serverURL: URL(string: "https://example.invalid")!, apiKey: "test-only")
        let host = UIHostingController(rootView: NavigationStack { DiaryEntryView(store: store, entryID: id, api: ApiClient(credentials: credentials)) })
        let window = UIWindow(windowScene: scene); window.rootViewController = host; window.makeKeyAndVisible()
        defer { window.isHidden = true; previous?.makeKeyAndVisible() }
        try await Task.sleep(for: .milliseconds(300))
        let image = UIGraphicsImageRenderer(bounds: host.view.bounds).image { _ in host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true) }
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("diary-entry.png")
        try #require(image.pngData()).write(to: path)
        print("DIARY_PREVIEW \(path.path)")
        try store.prepareAI(ids: [id], operation: "entry")
        try await Task.sleep(for: .milliseconds(500))
        func findAlert(_ controller: UIViewController) -> UIAlertController? {
            if let alert = controller as? UIAlertController { return alert }
            if let presented = controller.presentedViewController, let alert = findAlert(presented) { return alert }
            return controller.children.compactMap(findAlert).first
        }
        let alert = try #require(findAlert(host))
        #expect(alert.title == "Autorizzi l’elaborazione AI?")
        #expect(alert.actions.contains { $0.title == "Invia questa selezione" })
        #expect(!store.busy && store.document?.entries.first?.revisions.isEmpty == true)
        store.cancelConsent()
    }
    @Test func lockedEntranceRendersWithoutOpeningAJournal() async throws {
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        for dark in [false, true] {
            let credentials = Credentials(serverURL: URL(string: "https://example.invalid")!, apiKey: "test-only")
            let host = UIHostingController(rootView: PrivateDiaryView(scope: "ui-test-" + UUID().uuidString, api: ApiClient(credentials: credentials)).preferredColorScheme(dark ? .dark : .light))
            let window = UIWindow(windowScene: scene)
            window.rootViewController = host; window.makeKeyAndVisible()
            defer { window.isHidden = true; previous?.makeKeyAndVisible() }
            try await Task.sleep(for: .milliseconds(350))
            host.view.layoutIfNeeded()
            let image = UIGraphicsImageRenderer(bounds: host.view.bounds).image { _ in host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true) }
            let path = FileManager.default.temporaryDirectory.appendingPathComponent("diary-gate-\(dark ? "dark" : "light").png")
            try #require(image.pngData()).write(to: path)
            #expect(image.size.width > 300 && image.size.height > 500)
            print("DIARY_PREVIEW \(path.path)")
        }
    }
}
