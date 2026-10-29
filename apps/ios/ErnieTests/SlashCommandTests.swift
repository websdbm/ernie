import Foundation
import SwiftUI
import Testing
import UIKit
@testable import Ernie

@MainActor struct SlashCommandTests {
    private func skill(_ id: String, active: Bool) -> SkillInfo {
        .init(id: id, title: id, summary: nil, description: "", kind: "builtin", tools: [], examples: [],
              available: active, enabled: active, active: active)
    }
    @Test func soloSlashAllInizioEDelimitazioneDelComando() throws {
        #expect(SlashInput("https://example.test/a/b") == nil)
        #expect(SlashInput("Spiega /messaggio") == nil)
        #expect(SlashInput("  /MSG ciao\nseconda riga  ")?.command == .message)
        #expect(SlashInput("  /MSG ciao\nseconda riga  ")?.arguments == "ciao\nseconda riga")
        #expect(SlashInput("/attività")?.command == .todo)
        #expect(SlashInput("/messaggiotest")?.command == nil)
        #expect(SlashInput("/usr/bin")?.command == nil)
        #expect(SlashInput("/diario testo privato")?.validationError(skills: [], hasAttachment: false) != nil)
        #expect(SlashInput("/ testo da conservare")?.validationError(skills: [], hasAttachment: false) != nil)
    }
    @Test func suggerimentiFiltratiESkillSpenteNonSiAttivano() throws {
        let all = try #require(SlashInput("/"))
        #expect(all.suggestions(skills: nil).contains(.message))
        #expect(!all.suggestions(skills: nil).contains(.ssh))
        #expect(!all.suggestions(skills: [skill("ssh", active: false)]).contains(.ssh))
        #expect(all.suggestions(skills: [skill("ssh", active: true)]).contains(.ssh))
        #expect(SlashInput("/mes")?.suggestions(skills: []) == [.message])
        #expect(SlashInput("/mem")?.suggestions(skills: [skill("second_brain", active: true)]) == [.brain])
        #expect(SlashInput("/ssh")?.validationError(skills: [], hasAttachment: false) != nil)
        #expect(SlashInput("/ssh")?.validationError(skills: [skill("ssh", active: true)], hasAttachment: false) == nil)
    }
    @Test func testoMessaggioConservatoAllegatiENavigazioneNonVengonoInviati() throws {
        let input = try #require(SlashInput("/messaggio Ciao! /questo resta testo"))
        #expect(input.arguments == "Ciao! /questo resta testo")
        #expect(input.validationError(skills: [], hasAttachment: false) == nil)
        #expect(input.validationError(skills: [], hasAttachment: true) != nil)
        #expect(SlashInput("/impostazioni testo")?.validationError(skills: [], hasAttachment: false) != nil)
        #expect(SlashInput("/messaggio " + String(repeating: "x", count: 2001))?.validationError(skills: [], hasAttachment: false) != nil)
        #expect(SlashCommand.usage.destination == .usage)
        #expect(SlashCommand.message.destination == nil) // Prepara il compositore; non invia.
    }
    @Test func promemoriaDistingueElencoCreazioneEGestioneConContenutiIntegri() throws {
        let active = [skill("ricordami", active: true)]
        let list = try #require(SlashInput("/promemoria"))
        #expect(list.command?.destination == .reminders)
        #expect(list.requestText == nil)
        // L'elenco resta consultabile anche con la skill di creazione spenta.
        #expect(list.validationError(skills: [], hasAttachment: false) == nil)
        let create = try #require(SlashInput("/ricordami domani alle 18 ritira il pacco"))
        #expect(create.requestText == "Ricordami domani alle 18 ritira il pacco")
        #expect(create.validationError(skills: active, hasAttachment: false) == nil)
        #expect(create.actionLabel == "Invia la richiesta a Ernie")
        #expect(SlashInput("/ricordami")?.requestText == nil) // Completa la bozza; non inviare una richiesta vuota.
        for body in ["domani alle 18 ritira il pacco", "sposta il dentista a venerdì alle 10", "annulla il dentista", "il workshop lunedì alle 9\nURL https://example.test/meeting/a?b=1\nNote: porta gli appunti", "compra il pane alle 18 e passa in casa nuova alle 19"] {
            let request = try #require(SlashInput("/REMINDER " + body))
            #expect(request.requestText == "Promemoria: " + body)
            #expect(request.validationError(skills: active, hasAttachment: false) == nil)
        }
    }
    @Test func richiesteNonAggiranoSkillAllegatiOLimiti() throws {
        let active = [skill("ricordami", active: true)]
        for command in ["/promemoria", "/ricordami"] {
            let input = try #require(SlashInput(command + " chiama il dentista"))
            #expect(input.validationError(skills: nil, hasAttachment: false) != nil)
            #expect(input.validationError(skills: [skill("ricordami", active: false)], hasAttachment: false) != nil)
            #expect(input.validationError(skills: active, hasAttachment: true) != nil)
            #expect(SlashInput(command + " " + String(repeating: "x", count: 8001))?.validationError(skills: active, hasAttachment: false) != nil)
        }
        #expect(!SlashInput("/")!.suggestions(skills: []).contains(.createReminder))
        #expect(SlashInput("/ricord")!.suggestions(skills: active) == [.createReminder])
        #expect(SlashInput("/diario testo riservato")?.requestText == nil)
        #expect(SlashInput("/impostazioni cambia utente")?.requestText == nil)
    }
    @Test func richiestaPassaNellaConversazioneRecuperabileSenzaCreareLocalmenteImpegni() throws {
        let name = "slash-request-" + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        defer { defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: directory) }
        let store = ConversationStore(credentials: Credentials(serverURL: URL(string: "https://example.invalid")!, apiKey: "test-only"),
            speaker: Speaker(), inbox: InboxStore(), settings: LocalSettings(),
            transcript: TranscriptStore(directory: directory, defaults: defaults),
            performanceQueue: PerformanceObservationQueue(send: { _ in }, pause: {}), deviceContext: { nil })
        defer { store.disconnect() }
        let request = try #require(SlashInput("/ricordami domani alle 18 workshop https://example.test/meeting")?.requestText)
        store.send(request, inputMode: "text") // Nessuna connessione: resta nel recupero esistente.
        #expect(store.items.count == 1)
        guard case .message(let message) = try #require(store.items.first) else { Issue.record("Manca la richiesta utente"); return }
        #expect(message.role == .user)
        #expect(message.text == request && message.requestPayload?.text == request)
        #expect(message.requestPayload?.inputMode == "text")
        #expect(store.activeCorrelationId != nil && store.diaryLaunch == nil)
    }
    @Test func menuRenderizzatoInEntrambeLeSkinECaratteriGrandi() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("ernie-slash-110")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        for (name, costume, scheme, width, size) in [
            ("borg", BearCostume.borg, ColorScheme.dark, CGFloat(390), DynamicTypeSize.large),
            ("light", .base, .light, 390, .large),
            ("accessible", .base, .dark, 320, .accessibility2)
        ] {
            let palette = ChatPalette(costume: costume)
            let content = SlashCommandMenu(commands: [.message, .family, .help], onSelect: { _ in })
                .padding(12).frame(width: width).background(palette.ground)
                .environment(\.chatPalette, palette).environment(\.colorScheme, scheme).environment(\.dynamicTypeSize, size)
            let renderer = ImageRenderer(content: content); renderer.scale = 2
            let image = try #require(renderer.uiImage)
            #expect(image.size.width == width)
            #expect(image.size.height < 300)
            let path = folder.appendingPathComponent(name + ".png")
            try #require(image.pngData()).write(to: path)
            print("SLASH_SNAPSHOT: \(path.path)")
        }
    }
}
