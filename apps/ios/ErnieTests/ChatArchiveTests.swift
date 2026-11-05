import Foundation
import Testing
import SwiftUI
import UIKit
@testable import Ernie

private actor ArchiveHTTP {
    var requests: [URLRequest] = []
    func call(_ request: URLRequest) async throws -> (Data, URLResponse) {
        requests.append(request)
        let body: String
        if request.url?.path.hasSuffix("/ask") == true {
            body = #"{"answer":"Risposta con fonte","sources":[],"uncertainties":[],"coverage":{"firstMessageAt":null,"latestMessageAt":null,"lastImportedAt":"2026-11-05T10:00:00Z","indexedAt":"2026-11-05T10:00:00Z","revision":1,"matchedCount":0,"usedCount":0,"partial":false},"model":"test"}"#
        } else { body = #"{"messages":[],"total":0}"# }
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}

@MainActor struct ChatArchiveTests {
    @Test func whatsappRifiutaHostCamuffatiInviiAutomaticiECredenziali() {
        for raw in ["http://wa.me/393331234567", "https://wa.me.evil.test/393331234567", "https://user:secret@wa.me/393331234567", "https://wa.me:443/393331234567", "https://wa.me/393331234567?text=ciao", "https://whatsapp.com/not-a-channel/test", "https://chat.whatsapp.com/abc#x", "javascript:alert(1)"] {
            #expect(ChatArchiveWhatsApp.safeURL(raw) == nil)
        }
        #expect(ChatArchiveWhatsApp.safeURL("https://chat.whatsapp.com/Abcdef123") != nil)
        #expect(ChatArchiveWhatsApp.safeURL("https://www.whatsapp.com/channel/Abcdef123") != nil)
        #expect(ChatArchiveWhatsApp.safeURL("https://wa.me/393331234567") != nil)
        #expect(ChatArchiveWhatsApp.compose(phone: "nome del gruppo") == nil)
    }
    @Test func bozzaPrivataPreservaTestoENumeroInternazionale() throws {
        let message = "Caffè & acqua? +39\nDue righe 🐻"
        let link = try #require(ChatArchiveWhatsApp.compose(phone: "+393331234567", text: message))
        let components = try #require(URLComponents(url: link, resolvingAgainstBaseURL: false))
        #expect(components.host == "wa.me")
        #expect(components.path == "/393331234567")
        #expect(components.queryItems?.first?.value == message)
    }
    @Test func sceltaImportNonRinominaLaChatEsistenteENonUnisceAllaCieca() throws {
        let input = ChatArchiveImportInput(filename: "WhatsApp Chat.txt", dataBase64: "YWJj", timeZone: "Europe/Rome")
        #expect(input.archiveId == nil && input.createNew == nil)
        let existing = input.choosing(archiveId: "chat-1", newName: "Nome inferito", kind: "group")
        #expect(existing.archiveId == "chat-1" && existing.createNew == false)
        #expect(existing.name == nil && existing.kind == nil)
        let fresh = input.choosing(archiveId: nil, newName: "Nuova", kind: "group")
        #expect(fresh.createNew == true && fresh.name == "Nuova" && fresh.kind == "group")
        #expect(existing.dataBase64 == input.dataBase64)
    }
    @Test func aperturaLocaleRiconosceSoloIlComandoSenzaAllegati() {
        #expect(ChatArchiveLaunch.matches(" APRI ARCHIVIO CHAT "))
        #expect(ChatArchiveLaunch.matches("apri l’archivio chat"))
        #expect(!ChatArchiveLaunch.matches("apri archivio chat e invia a Marco"))
        #expect(!ChatArchiveLaunch.matches("apri archivio chat", hasAttachments: true))
        #expect(SlashInput("/archivio")?.command == .chatArchives)
    }
    @Test func codaCondivisioniLegataACredenzialiEServer() {
        let a = ShareInbox.ownerScope(serverURL: URL(string: "https://a.test")!, apiKey: "secret-a")
        #expect(a.count == 64 && !a.contains("secret"))
        #expect(a == ShareInbox.ownerScope(serverURL: URL(string: "https://a.test")!, apiKey: "secret-a"))
        #expect(a != ShareInbox.ownerScope(serverURL: URL(string: "https://a.test")!, apiKey: "secret-b"))
        #expect(a != ShareInbox.ownerScope(serverURL: URL(string: "https://b.test")!, apiKey: "secret-a"))
    }
    @Test func domandaEFontiRestanoNelPercorsoDellaChat() async throws {
        let http = ArchiveHTTP()
        let api = ApiClient(credentials: .init(serverURL: URL(string: "https://example.test")!, apiKey: "test-only"), transport: http.call)
        _ = try await api.askChatArchive("chat-a", input: .init(question: "Che cosa abbiamo deciso?", mode: "question", senderId: "person-a", history: [.init(question: "Prima", answer: "Risposta")]))
        _ = try await api.chatArchiveMessages("chat-a", query: "A+B & caffè", senderId: "person-a", aroundId: "message-a")
        let requests = await http.requests
        #expect(requests.count == 2)
        #expect(requests[0].url?.path == "/v1/chat-archives/chat-a/ask")
        let data = try #require(requests[0].httpBody)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(body["consent"] as? Bool == true)
        #expect(body["senderId"] as? String == "person-a")
        #expect((body["history"] as? [[String: String]])?.count == 1)
        let requestURL = try #require(requests[1].url)
        let url = try #require(URLComponents(url: requestURL, resolvingAgainstBaseURL: false))
        #expect(url.path == "/v1/chat-archives/chat-a/messages")
        #expect(url.queryItems?.first { $0.name == "q" }?.value == "A+B & caffè")
        #expect(url.queryItems?.first { $0.name == "aroundId" }?.value == "message-a")
        #expect(url.percentEncodedQuery?.contains("%2B") == true)
    }
    @Test func fileImportatoLimitatoESenzaInterpretazioneLocale() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appendingPathComponent("Chat.txt")
        let raw = Data("[05/11/26, 10:00:00] Persona: testo originale\n".utf8)
        try raw.write(to: file)
        let input = try await ChatArchiveImportInput.read(file)
        #expect(Data(base64Encoded: input.dataBase64) == raw)
        #expect(input.filename == "Chat.txt" && input.archiveId == nil && input.createNew == nil)
        let oversized = folder.appendingPathComponent("Grande.txt")
        try Data(repeating: 65, count: ChatArchiveImportInput.maxBytes + 1).write(to: oversized)
        await #expect(throws: ChatArchiveInputError.self) { _ = try await ChatArchiveImportInput.read(oversized) }
    }
    @Test func richiestaEsplicitaNonScriveIlTranscriptENonInvocaLaChatGenerale() throws {
        let name = "archive-main-" + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        defer { defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: directory) }
        let transcript = TranscriptStore(directory: directory, defaults: defaults)
        let store = ConversationStore(credentials: .init(serverURL: URL(string: "https://example.invalid")!, apiKey: "test-only"), speaker: Speaker(), inbox: InboxStore(), settings: LocalSettings(), transcript: transcript, deviceContext: { nil })
        store.send("Nella chat con Giorgio cosa abbiamo deciso? CANARY", inputMode: "text")
        #expect(store.chatArchiveReference?.text.contains("CANARY") == true)
        #expect(store.items.isEmpty && store.activeCorrelationId == nil)
        #expect(transcript.load(store.sessionId) == nil)
        #expect(ChatArchiveLaunch.request(from: "Invia un messaggio nella chat con Giorgio") == nil)
        #expect(ChatArchiveLaunch.request(from: "Quali sono i miei impegni di oggi?") == nil)
        #expect(ChatArchiveLaunch.request(from: "Nella chat con Giorgio cosa abbiamo deciso?", hasAttachments: true) == nil)
        store.disconnect()
        #expect(store.chatArchiveReference == nil && store.chatArchiveLaunchID == nil)
        store.send("apri archivio chat", inputMode: "voice")
        #expect(store.chatArchiveLaunchID == nil)
    }

    @Test func riferimentiEsplicitiArchivioCopronoFormulazioniNaturali() {
        for text in ["cerca nella chat Giorgio", "cosa abbiamo deciso nella conversazione con Marco?", "riassumi la chat Famiglia", "nella chat del gruppo scuola quali sono le date?", "scrivi un riassunto della chat con Giorgio"] {
            #expect(ChatArchiveLaunch.request(from: text) != nil)
        }
        for text in ["scrivi nella chat con Giorgio che arrivo", "manda un messaggio nella chat con Marco", "rispondi nella chat con Giorgio", "invia il riepilogo nella chat Famiglia"] {
            #expect(ChatArchiveLaunch.request(from: text) == nil)
        }
    }

    @Test func schedaCatalogoLeggibileNeiTemiEDimensioniAccessibili() throws {
        let archive = ChatArchive(id: "test", name: "Famiglia e scuola", summary: "Organizzazione dei rientri e delle attività sportive dei figli.", kind: "group", category: "Famiglia", tags: ["scuola", "sport"], messageCount: 1432, participantCount: 5, firstMessageAt: "2026-01-01T10:00:00Z", latestMessageAt: "2026-11-04T18:30:00Z", lastImportedAt: "2026-11-05T09:00:00Z", indexedAt: "2026-11-05T09:00:00Z", indexedRevision: 2, revision: 2, timeZone: "Europe/Rome")
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("chat-archive-snapshots", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        for (name, costume, scheme, width, size): (String, BearCostume, ColorScheme, CGFloat, DynamicTypeSize) in [
            ("light", .base, .light, 390, .large),
            ("dark", .base, .dark, 390, .large),
            ("borg", .borg, .dark, 390, .large),
            ("accessible", .base, .dark, 320, .accessibility2)
        ] {
            let palette = ChatPalette(costume: costume)
            let content = ChatArchiveCatalogRow(archive: archive).padding(16).frame(width: width).background(palette.ground)
                .environment(\.chatPalette, palette).environment(\.colorScheme, scheme).environment(\.dynamicTypeSize, size)
            let renderer = ImageRenderer(content: content); renderer.scale = 2
            let image = try #require(renderer.uiImage)
            #expect(image.size.width == width && image.size.height > 120 && image.size.height < 1400)
            let png = try #require(image.pngData())
            let path = folder.appendingPathComponent(name + ".png")
            try png.write(to: path)
            print("CHAT_ARCHIVE_SNAPSHOT: \(path.path)")
        }
    }

}
