import Foundation
import SwiftUI
import Testing
import UIKit
import Vision
@testable import Ernie

private let healthFixtureID = "11111111-1111-4111-8111-111111111111"
private func healthCapabilities(skill: Bool = true, allowed: Bool = true) -> String {
    """
    {"available":true,"skillEnabled":\(skill),"encryptionReady":true,"policyVersion":1,"policyText":"Consenso sintetico di prova","consent":{"revision":1,"aiAllowed":\(allowed),"policyVersion":1},"migration":{"state":"ready"}}
    """
}
private actor HealthFixtureTransport {
    var requests: [URLRequest] = []
    var skill: Bool
    var allowed: Bool
    var holdAsk = false
    var waiting: CheckedContinuation<Void, Never>?
    init(skill: Bool = true, allowed: Bool = true) { self.skill = skill; self.allowed = allowed }
    func hold() { holdAsk = true }
    func release() { waiting?.resume(); waiting = nil }
    func requested(_ suffix: String) -> Bool { requests.contains { $0.url?.path.hasSuffix(suffix) == true } }
    func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        requests.append(request)
        let path = request.url!.path
        var json = "{}"
        if path.hasSuffix("/capabilities") { json = healthCapabilities(skill: skill, allowed: allowed) }
        else if path.hasSuffix("/consent") { allowed = false; json = #"{"revision":2,"aiAllowed":false,"policyVersion":1}"# }
        else if path.hasSuffix("/sources"), request.httpMethod == "POST" {
            json = """
            {"source":{"id":"\(healthFixtureID)","title":"Nota sintetica","source":"text","pages":1,"createdAt":"2026-11-10T10:00:00Z","status":"pending","reportId":null}}
            """
        }
        else if path.hasSuffix("/sources") { json = #"{"sources":[]}"# }
        else if path.hasSuffix("/reports") { json = #"{"reports":[]}"# }
        else if path.hasSuffix("/analyze") {
            json = """
            {"reportId":"\(healthFixtureID)","values":1,"outOfRange":0}
            """
        } else if path.contains("/reports/") {
            json = """
            {"report":{"id":"\(healthFixtureID)","takenOn":null,"lab":null,"kind":"Referto","againstDate":null,"rows":[{"label":"Parametro sintetico","value":12,"flag":"n/d"}]}}
            """
        }
        else if path.hasSuffix("/ask") {
            if holdAsk { await withCheckedContinuation { waiting = $0 } }
            json = #"{"answer":"RISPOSTA SINTETICA PRIVATA","sources":[],"model":"fixture"}"#
        } else if path.hasSuffix("/parameters") { json = #"{"parameter":null}"# }
        else if path.hasSuffix("/export") { json = #"{"filename":"prova.json","mimeType":"application/json","dataBase64":"e30="}"# }
        return (Data(json.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}
@MainActor struct HealthVaultTests {
    private func client(_ fixture: HealthFixtureTransport) -> HealthVaultClient {
        HealthVaultClient(credentials: .init(serverURL: URL(string: "https://example.test")!, apiKey: "synthetic-health-test"), transport: { try await fixture.send($0) })
    }
    @Test func trasportoEffimeroNonConservaCacheCookieOCredenziali() {
        let config = HealthVaultClient.configuration()
        #expect(config.urlCache == nil); #expect(config.httpCookieStorage == nil)
        #expect(config.urlCredentialStorage == nil); #expect(config.httpShouldSetCookies == false)
        #expect(config.requestCachePolicy == .reloadIgnoringLocalCacheData)
    }
    @Test func terminiCliniciSoloNelBodyENessunEndpointGenerico() async throws {
        let fixture = HealthFixtureTransport()
        let actual = client(fixture)
        _ = try await actual.parameter("Parametro / privato?")
        let requests = await fixture.requests
        #expect(requests.count == 1)
        #expect(requests.first?.url?.path == "/v1/health/parameters")
        #expect(requests.first?.url?.query == nil)
        #expect(requests.first?.httpMethod == "POST")
        #expect(requests.first?.value(forHTTPHeaderField: "Cache-Control") == "no-store")
        let body = try #require(requests.first?.httpBody)
        let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: String])
        #expect(json["name"] == "Parametro / privato?")
    }
    @Test func identificatoriNonValidiBloccatiPrimaDellaRete() async {
        let fixture = HealthFixtureTransport()
        let actual = client(fixture)
        do { _ = try await actual.source("../media"); Issue.record("Accesso non valido accettato") } catch { #expect(error as? HealthVaultError == .invalidImport) }
        #expect(await fixture.requests.isEmpty)
    }
    @Test func erroriRemotiNonEspongonoTestiDelReferto() async {
        let client = HealthVaultClient(credentials: .init(serverURL: URL(string: "https://example.test")!, apiKey: "fixture"), transport: { request in
            (Data(#"{"error":"SEGRETO CLINICO"}"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 500, httpVersion: nil, headerFields: nil)!)
        })
        do { _ = try await client.capabilities(); Issue.record("Errore atteso") }
        catch { #expect(error as? HealthVaultError == .network); #expect(!(error as? HealthVaultError)!.message.contains("SEGRETO")) }
    }
    @Test func skillSpentaConsenteConsultazioneMaNonAI() async {
        let fixture = HealthFixtureTransport(skill: false), store = HealthVaultStore()
        store.activate(client: client(fixture)); await store.refresh()
        #expect(store.manualReady); #expect(!store.aiReady)
        #expect(await fixture.requested("/sources")); #expect(await fixture.requested("/reports"))
        store.question = "Domanda sintetica"; await store.ask()
        #expect(!(await fixture.requested("/ask")))
        await store.revokeConsent(); #expect(await fixture.requested("/consent"))
    }
    @Test func revocaScartaRispostaAIAncoraInCorso() async throws {
        let fixture = HealthFixtureTransport(), store = HealthVaultStore()
        store.activate(client: client(fixture)); await store.refresh(); await fixture.hold()
        store.question = "Domanda sintetica"
        let task = Task { await store.ask() }
        for _ in 0..<100 { if await fixture.requested("/ask") { break }; await Task.yield() }
        #expect(store.aiBusy)
        await store.revokeConsent(); #expect(!store.aiReady); #expect(!store.aiBusy)
        await fixture.release(); await task.value
        #expect(store.answer == nil); #expect(store.capabilities?.consent.aiAllowed == false)
    }
    @Test func chiusuraOSostituzioneAccountSvuotaRAMERisultatiTardivi() async {
        let fixture = HealthFixtureTransport(), store = HealthVaultStore()
        store.activate(client: client(fixture)); await store.refresh(); await fixture.hold()
        store.question = "Privata"; store.parameterName = "Privato"; store.selectedReports = [healthFixtureID]
        store.draft = .init(title: "Bozza", source: .text, pages: ["Contenuto privato"], attachments: [])
        let task = Task { await store.ask() }
        for _ in 0..<100 { if await fixture.requested("/ask") { break }; await Task.yield() }
        store.scrub(); await fixture.release(); await task.value
        #expect(store.question.isEmpty && store.parameterName.isEmpty && store.selectedReports.isEmpty)
        #expect(store.draft == nil && store.answer == nil && store.capabilities == nil)
        #expect(store.sources.isEmpty && store.reports.isEmpty && store.source == nil && store.report == nil && store.attachment == nil)
        let next = HealthFixtureTransport(skill: false)
        store.activate(client: client(next)); await store.refresh()
        #expect(!store.aiReady); #expect(store.answer == nil)
    }
    @Test func OCRCompletatoDopoChiusuraNonRipristinaBozza() async {
        let fixture = HealthFixtureTransport(), store = HealthVaultStore()
        store.activate(client: client(fixture)); await store.refresh()
        await store.prepare {
            store.scrub()
            #expect(Task.isCancelled)
            return .init(title: "Bozza", source: .text, pages: ["Privato"], attachments: [])
        }
        #expect(store.draft == nil)
    }
    @Test func esportazioneSoloEsplicitaConProtezioneECancellazione() async throws {
        let fixture = HealthFixtureTransport(), store = HealthVaultStore()
        store.activate(client: client(fixture)); await store.refresh()
        #expect(store.exportFile == nil); #expect(!(await fixture.requested("/export")))
        await store.export(sourceId: healthFixtureID)
        let file = try #require(store.exportFile)
        #expect(FileManager.default.fileExists(atPath: file.url.path))
        let attrs = try FileManager.default.attributesOfItem(atPath: file.url.path)
        #expect(HealthSharedFile.writeOptions.contains(.completeFileProtection))
        #if targetEnvironment(simulator)
        // Simulator host filesystem does not expose iOS Data Protection metadata.
        if let protection = attrs[.protectionKey] as? String { #expect(protection == FileProtectionType.complete.rawValue) }
        #else
        #expect(attrs[.protectionKey] as? String == FileProtectionType.complete.rawValue)
        #endif
        #expect(try file.url.deletingLastPathComponent().resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
        store.scrub(); #expect(!FileManager.default.fileExists(atPath: file.url.path)); #expect(store.exportFile == nil)
    }
    @Test func importazioneManualeNonAvviaAIENonPassaDaMediaODocumenti() async {
        let fixture = HealthFixtureTransport(skill: false), store = HealthVaultStore()
        store.activate(client: client(fixture)); await store.refresh()
        store.draft = .init(title: "Nota sintetica", source: .text, pages: ["Testo sintetico"], attachments: [])
        await store.upload()
        #expect(store.draft == nil); #expect(store.error == nil)
        let requests = await fixture.requests
        #expect(requests.contains { $0.httpMethod == "POST" && $0.url?.path == "/v1/health/sources" })
        #expect(requests.allSatisfy { $0.url?.path.hasPrefix("/v1/health/") == true })
        #expect(!requests.contains { $0.url?.path.contains("/analyze") == true })
    }
    @Test func analisiEsplicitaApreIlRefertoConDataSconosciuta() async {
        let fixture = HealthFixtureTransport(), store = HealthVaultStore()
        store.activate(client: client(fixture)); await store.refresh()
        await store.analyze(healthFixtureID)
        #expect(store.report?.id == healthFixtureID)
        #expect(store.report?.takenOn == nil)
        #expect(store.report?.rows.first?.label == "Parametro sintetico")
        #expect(store.error == nil)
    }
    @Test func selezioneVuotaUsaDefaultMentreFontiEspliciteEscludonoRefertiImpliciti() async throws {
        let fixture = HealthFixtureTransport(), actual = client(fixture)
        _ = try await actual.ask("Domanda", reportIds: [])
        _ = try await actual.ask("Domanda", reportIds: [], sourceIds: [healthFixtureID])
        let requests = await fixture.requests
        let firstBody = try #require(requests.first?.httpBody)
        let lastBody = try #require(requests.last?.httpBody)
        let first = try #require(JSONSerialization.jsonObject(with: firstBody) as? [String: Any])
        let last = try #require(JSONSerialization.jsonObject(with: lastBody) as? [String: Any])
        #expect(first["reportIds"] == nil && first["sourceIds"] == nil)
        #expect(last["reportIds"] as? [String] == [])
        #expect(last["sourceIds"] as? [String] == [healthFixtureID])
    }
    @Test func validazioneEscludeAllegatiArbitrariEDimensioniFuoriLimite() throws {
        var draft = HealthVaultDraft(title: "Sintetico", source: .text, pages: ["Testo"], attachments: [])
        try draft.validate()
        draft.attachments = [.init(id: healthFixtureID, name: "file", mimeType: "text/html", dataBase64: Data("x".utf8).base64EncodedString())]
        #expect(throws: HealthVaultError.invalidImport) { try draft.validate() }
        draft.attachments = []; draft.pages = [String(repeating: "x", count: 400_001)]
        #expect(throws: HealthVaultError.invalidImport) { try draft.validate() }
    }
    @Test func riconoscimentoAllegatoSanitarioDeviaPrimaDelCaricamentoGenerico() async throws {
        let recorder = HealthFixtureTransport()
        let api = ApiClient(credentials: .init(serverURL: URL(string: "https://example.test")!, apiKey: "fixture"), transport: { try await recorder.send($0) })
        let composer = DocumentComposer(); composer.configure(api: api)
        composer.start { _ in ImportedDocument(title: "Referto di prova", source: "text", pages: ["Emocromo sintetico senza dati reali."]) }
        for _ in 0..<200 { if composer.healthDraft != nil { break }; await Task.yield() }
        #expect(composer.healthDraft?.title == "Referto di prova")
        #expect(composer.ready == nil); #expect(await recorder.requests.isEmpty)
        _ = composer.takeHealthDraft(); #expect(composer.healthDraft == nil)
    }
    @Test func testiNonSanitariNonSonoMarcatiComeReferto() {
        #expect(!HealthImportGuard.recognizes(.init(title: "Ricetta", source: "text", pages: ["Ingredienti: farina e uova. Cuocere per venti minuti."])))
        #expect(HealthImportGuard.recognizes(.init(title: "Analisi cliniche", source: "pdf", pages: ["Documento sintetico"])))
    }
    @Test func informativaEspansaMantieneLimitiPrivacyLeggibili() throws {
        for size: DynamicTypeSize in [.large, .accessibility3] {
            let renderer = ImageRenderer(content: HealthPrivacyNotice(expanded: true).padding(20).frame(width: 375)
                .background(Theme.ground).environment(\.colorScheme, .light).environment(\.dynamicTypeSize, size))
            renderer.scale = 2
            let image = try #require(renderer.uiImage)
            let cg = try #require(image.cgImage)
            let request = VNRecognizeTextRequest(); request.recognitionLevel = .accurate; request.recognitionLanguages = ["it-IT", "en-US"]
            try VNImageRequestHandler(cgImage: cg, options: [:]).perform([request])
            let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ").lowercased()
            #expect(text.contains("backend")); #expect(text.contains("chat generale")); #expect(text.contains("esportazione"))
        }
    }
    @Test func privacyLeggibileInChiaroScuroBorgEAccessibilita() async throws {
        let store = HealthVaultStore(); store.activate(client: client(HealthFixtureTransport())); await store.refresh()
        store.draft = .init(title: "Documento sintetico di prova", source: .text, pages: ["Contenuto di prova"], attachments: [])
        for (name, scheme, costume, size): (String, ColorScheme, BearCostume, DynamicTypeSize) in [
            ("light", .light, .base, .large), ("dark", .dark, .base, .large), ("borg", .dark, .borg, .large), ("large", .light, .base, .accessibility3)
        ] {
            let content = HealthVaultView(store: store).chatAppearance(costume: costume)
                .environment(\.scenePhase, .active)
                .environment(\.colorScheme, scheme).environment(\.dynamicTypeSize, size)
            let host = UIHostingController(rootView: content)
            host.overrideUserInterfaceStyle = scheme == .dark ? .dark : .light
            let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let previousKey = scene.windows.first(where: \.isKeyWindow)
            let window = UIWindow(windowScene: scene)
            window.rootViewController = host
            window.frame = CGRect(x: 0, y: 0, width: 375, height: 844)
            host.view.frame = window.bounds
            window.makeKeyAndVisible(); host.view.setNeedsLayout(); host.view.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(100))
            func findScroll(_ view: UIView) -> UIScrollView? {
                if let scroll = view as? UIScrollView { return scroll }
                for child in view.subviews { if let scroll = findScroll(child) { return scroll } }
                return nil
            }
            let scroll = try #require(findScroll(host.view))
            let minimum = -scroll.adjustedContentInset.top
            let maximum = max(minimum, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
            var offsets = Array(stride(from: minimum, to: maximum, by: 650)); offsets.append(maximum)
            var shots: [UIImage] = [], text = ""
            for offset in offsets {
                scroll.setContentOffset(CGPoint(x: 0, y: offset), animated: false)
                host.view.layoutIfNeeded(); try await Task.sleep(for: .milliseconds(80))
                let format = UIGraphicsImageRendererFormat(); format.scale = 2
                let shot = UIGraphicsImageRenderer(size: window.bounds.size, format: format).image { _ in
                    host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
                }
                shots.append(shot)
                let cgImage = try #require(shot.cgImage)
                let request = VNRecognizeTextRequest(); request.recognitionLevel = .accurate; request.recognitionLanguages = ["it-IT", "en-US"]
                try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request])
                text += (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ").lowercased() + " "
            }
            window.isHidden = true; previousKey?.makeKey()
            let format = UIGraphicsImageRendererFormat(); format.scale = 1
            let image = UIGraphicsImageRenderer(size: CGSize(width: 375, height: 844 * shots.count), format: format).image { _ in
                for (index, shot) in shots.enumerated() { shot.draw(in: CGRect(x: 0, y: index * 844, width: 375, height: 844)) }
            }
            #expect(text.contains("archivio cifrato")); #expect(text.contains("salva")); #expect(text.contains("pagina"))
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("ernie-health-vault-\(name).png")
            try #require(image.pngData()).write(to: url)
            print("HEALTH_VAULT_SNAPSHOT: \(url.path)")
        }
    }
}
