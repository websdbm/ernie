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
    @Test func clearLocaleSenzaArgomentiOSkillNonDiventaUnaRichiesta() throws {
        let input = try #require(SlashInput(" /CLEAR \n"))
        #expect(input.command == .clear)
        #expect(input.requestText == nil && input.command?.destination == nil)
        #expect(input.validationError(skills: nil, hasAttachment: false) == nil)
        #expect(input.actionLabel == "Pulisci la schermata della chat")
        #expect(SlashInput("/cl")?.suggestions(skills: nil) == [.clear])
        #expect(input.validationError(skills: [], hasAttachment: true) != nil)
        #expect(SlashInput("/clear cancella tutto")?.validationError(skills: [], hasAttachment: false) != nil)
        #expect(SlashInput("/clear cancella tutto")?.requestText == nil)
    }

    private func withClearConversation(_ body: (ConversationStore, TranscriptStore) throws -> Void) throws {
        let name = "clear-chat-" + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        defer { defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: directory) }
        let transcript = TranscriptStore(directory: directory, defaults: defaults)
        let store = clearConversation(transcript)
        defer { store.disconnect() }
        try body(store, transcript)
    }

    private func clearConversation(_ transcript: TranscriptStore) -> ConversationStore {
        ConversationStore(credentials: Credentials(serverURL: URL(string: "https://example.invalid")!, apiKey: "test-only"),
            speaker: Speaker(), inbox: InboxStore(), settings: LocalSettings(), transcript: transcript,
            performanceQueue: PerformanceObservationQueue(send: { _ in }, pause: {}), deviceContext: { nil })
    }

    @Test func clearConservaContestoSessioneECodaEMostraSoloNuoviElementi() throws {
        try withClearConversation { store, transcript in
            store.send("Organizziamo la giornata", inputMode: "text") // Offline: nessuna connessione reale.
            let items = store.items, sid = store.sessionId, queued = store.queuedCount
            let savedBefore = try #require(transcript.load(sid))
            let correlation = store.activeCorrelationId
            store.clearVisibleHistory()
            #expect(store.visibleItems.isEmpty)
            #expect(store.items == items && store.sessionId == sid)
            #expect(store.queuedCount == queued && store.activeCorrelationId == correlation)
            let saved = try #require(transcript.load(sid))
            #expect(saved.items == savedBefore.items && saved.hiddenItemIds == Set(items.map(\.id)))
            #expect(saved.lastSeq == savedBefore.lastSeq)
            #expect(transcript.list().first?.title == "Organizziamo la giornata")
            store.clearVisibleHistory() // Ripetere il comando non modifica il contesto.
            #expect(store.items == items && store.visibleItems.isEmpty)
            store.send("E anche la cena", inputMode: "text")
            #expect(store.visibleItems.count == 1 && store.items.count == 2)
            #expect(transcript.load(sid)?.hiddenItemIds == saved.hiddenItemIds)
        }
    }

    @Test func clearResisteARiaperturaECambioChatSenzaContaminareNuoveSessioni() throws {
        try withClearConversation { store, transcript in
            store.send("Ricordati del contesto", inputMode: "text")
            let sid = store.sessionId
            store.clearVisibleHistory()
            let saved = try #require(transcript.load(sid))
            let reopened = clearConversation(transcript)
            defer { reopened.disconnect() }
            #expect(reopened.sessionId == sid && reopened.items == saved.items)
            #expect(reopened.visibleItems.isEmpty)
            #expect(reopened.queuedCount == store.queuedCount)
            reopened.startNewSession()
            #expect(reopened.sessionId != sid && reopened.items.isEmpty)
            reopened.send("Conversazione diversa", inputMode: "text")
            #expect(reopened.visibleItems == reopened.items)
            reopened.resume(sessionId: sid)
            #expect(reopened.items == saved.items && reopened.visibleItems.isEmpty)
        }
    }

    @Test func clearNonInterrompeIlTurnoONuoviElementiEConservaIlCursoreReplay() throws {
        try withClearConversation { store, transcript in
            store.send("Prima richiesta", inputMode: "text")
            let sid = store.sessionId
            let correlation = try #require(store.activeCorrelationId)
            let first = AgentEvent(payload: .assistantTextDelta(.init(delta: "Primo testo")),
                                   sessionId: sid, correlationId: correlation, seq: 7)
            store.apply(try AgentEvent.decode(first.encoded()))
            let before = store.items
            store.clearVisibleHistory()
            #expect(store.activeCorrelationId == correlation && store.isBusy)
            let update = AgentEvent(payload: .assistantTextDelta(.init(delta: " aggiornato")),
                                    sessionId: sid, correlationId: correlation, seq: 8)
            store.apply(try AgentEvent.decode(update.encoded()))
            #expect(store.items.map(\.id) == before.map(\.id) && store.visibleItems.isEmpty)
            // La persistenza ordinaria avviene a turno concluso, non a ogni delta in streaming.
            store.apply(.init(payload: .assistantCompleted(.init()), sessionId: sid, correlationId: correlation, seq: 9))
            let saved = try #require(transcript.load(sid))
            #expect(saved.lastSeq == 9) // Il cursore replay continua ad avanzare.
            guard case .message(let message) = try #require(saved.items.last) else { Issue.record("Risposta persa"); return }
            #expect(message.text == "Primo testo aggiornato")
            let next = AgentEvent(payload: .assistantTextDelta(.init(delta: "Nuova risposta")),
                                  sessionId: sid, correlationId: "next-turn", seq: 10)
            store.apply(try AgentEvent.decode(next.encoded()))
            store.apply(.init(payload: .assistantCompleted(.init()), sessionId: sid, correlationId: "next-turn", seq: 11))
            #expect(store.visibleItems.count == 1 && store.items.count == 3)
            #expect(store.sessionId == sid && transcript.load(sid)?.lastSeq == 11)
        }
    }

    @Test func cronologiePrecedentiSenzaCampoClearRimangonoVisibili() throws {
        try withClearConversation { store, transcript in
            let message = ChatMessage(id: "old", correlationId: "old-turn", role: .user, text: "Cronologia vecchia", createdAt: Date(timeIntervalSince1970: 1_000))
            transcript.save(.init(sessionId: "old-session", lastSeq: 4, items: [.message(message)], updatedAt: .now))
            store.resume(sessionId: "old-session")
            #expect(store.visibleItems == [.message(message)])
        }
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
            let content = SlashCommandMenu(commands: [.clear, .family, .help], onSelect: { _ in })
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
